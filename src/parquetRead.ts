/**
 * Reading of Parquet files with hyparquet into a flat table of display-ready text.
 * No vscode import, so it can be exercised outside VS Code.
 *
 * hyparquet is never given the file itself: what it reads has passed the checks of parquetGuard.ts.
 *
 * Bundled as a file of its own, this module is also a worker thread entry: started with
 * `workerData.previewixParquet`, it reads the file named or passed along and posts the result.
 */
import * as fs from 'fs';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import * as zlib from 'zlib';
import { parquetMetadataAsync, parquetRead, parquetSchema } from 'hyparquet';
import type { AsyncBuffer, Compressors, FileMetaData, SchemaElement, SchemaTree } from 'hyparquet';
import { FlatBuilder } from './csv';
import { checkChunk, checkFooter, checkThrift, MAX_FOOTER, Refusal, type Chunk, type Inflate } from './parquetGuard';

/**
 * A Parquet file is compressed and has no upper size, so the table is cut instead of the file:
 * the first rows up to whichever of these limits is reached first.
 */
export const MAX_ROWS = 1_000_000;
export const MAX_CELLS = 10_000_000;
export const MAX_CHARS = 128 * 1024 * 1024;

/** Bytes shown of a binary value. */
const MAX_HEX = 64;

export interface ParquetSource {
  /** A file on disk, of which only the footer and the row groups shown are read. */
  path?: string;
  /** The whole file, for the file systems that aren't on disk. */
  bytes?: Uint8Array;
}

export interface ParquetTable {
  names: string[];
  /** The type of every column: short for the header, and written out for the tooltip. */
  types: string[];
  details: string[];
  /** 1 for the columns whose cells are numbers. */
  numeric: Uint8Array;
  /** The cells as UTF-8, with the two indexes of a `FlatTable`. Rows end at their last value. */
  text: Uint8Array;
  ends: Uint32Array;
  rowEnds: Uint32Array;
  /** Rows in the table, and rows in the file. */
  rows: number;
  totalRows: number;
  rowGroups: number;
  codecs: string[];
  createdBy: string;
  /** The columns that could not be read, in words; empty when all of them were. */
  warning: string;
}

/**
 * Reads a file into a table, or throws with the reason: a `Refusal` in words of our own, and for
 * anything else, which comes from the depths of the reader, the sentence for damage.
 */
export async function readParquet(source: ParquetSource): Promise<ParquetTable> {
  const file = source.path !== undefined ? await fileSource(source.path) : memorySource(source.bytes ?? new Uint8Array(0));
  try {
    return await read(file);
  } catch (e) {
    throw e instanceof Refusal ? e : new Error(`the file is damaged, or written in a way Previewix does not read (${e instanceof Error ? e.message : e}).`);
  } finally {
    await file.close();
  }
}

async function read(source: Source): Promise<ParquetTable> {
  const whole = wholeFile(source);
  let metadata: FileMetaData;
  await checkEnd(source);
  try {
    // Without the marking of geometry columns, which walks the schema before anyone has checked it.
    metadata = await parquetMetadataAsync(whole, { geoparquet: false });
  } catch (e) {
    const reason = await notParquet(source);
    if (reason) {
      throw new Refusal(reason);
    }
    throw e;
  }
  const footer = checkFooter(metadata, source.length);
  if (metadata.key_value_metadata?.some(({ key }) => key === 'geo')) {
    // A GeoParquet file: read once more, now that the marking is safe.
    metadata = await parquetMetadataAsync(whole);
  }
  const columns = parquetSchema(metadata).children;
  const codecs = [...new Set(footer.groups.flatMap((group) => group.map((chunk) => chunk.codec ?? 'UNCOMPRESSED')))];
  if (codecs.includes('LZO')) {
    throw new Refusal('the file is compressed with LZO, which Previewix does not read.');
  }

  const totalRows = footer.rows;
  const limit = Math.min(totalRows, MAX_ROWS, columns.length ? Math.floor(MAX_CELLS / columns.length) : 0);
  const formats = columns.map(columnFormat);
  const builder = new FlatBuilder();
  let rows = 0;
  const append = (batch: unknown[][]) => {
    for (const row of batch) {
      if (builder.chars > MAX_CHARS) {
        return;
      }
      // Rows end at their last value, as they do in the other tables.
      let last = row.length - 1;
      while (last >= 0 && (row[last] === null || row[last] === undefined)) {
        last--;
      }
      for (let c = 0; c <= last; c++) {
        const value = row[c];
        builder.cell(value === null || value === undefined ? '' : formats[c](value));
      }
      builder.endRow();
      rows++;
    }
  };

  // One row group at a time, so that the decoded values of only one are in memory.
  const options = { metadata: withoutConversions(metadata), compressors, utf8: false, parsers };
  const names = columns.map((column) => column.element.name);
  const failed = new Map<string, string>();
  let start = 0;
  for (let g = 0; g < footer.groups.length; g++) {
    const end = Math.min(start + footer.groupRows[g], limit);
    if (start >= limit || builder.chars > MAX_CHARS) {
      break;
    }
    if (end > start) {
      // hyparquet reads from what the page checks let through, never from the file itself.
      const { file, refused } = await checkedColumns(source, footer.groups[g], end - start);
      const range: ReadOptions = { ...options, file, rowStart: start, rowEnd: end };
      const sound = names.map((_, c) => c).filter((c) => !refused.has(c));
      for (const [c, reason] of refused) {
        failed.set(names[c], failed.get(names[c]) ?? reason);
      }
      try {
        if (refused.size) {
          throw new Error(refused.values().next().value);
        }
        let batch: unknown[][] = [];
        await parquetRead({ ...range, onComplete: (read) => (batch = read) });
        append(batch);
      } catch (e) {
        append(await columnsApart(range, names, sound, end - start, failed, e));
      }
    }
    start += footer.groupRows[g];
  }

  const table = builder.finish();
  return {
    names,
    types: columns.map((column) => typeName(column, false)),
    details: columns.map((column) => `${typeName(column, true)}${column.element.repetition_type === 'REQUIRED' ? ', required' : ''}`),
    numeric: Uint8Array.from(columns, (column) => (isNumeric(column) ? 1 : 0)),
    text: new TextEncoder().encode(table.text),
    ends: table.ends,
    rowEnds: table.rowEnds,
    rows,
    totalRows,
    rowGroups: footer.groups.length,
    codecs,
    createdBy: metadata.created_by ?? '',
    warning: failed.size
      ? `${failed.size === 1 ? 'A column' : `${failed.size} columns`} could not be read and ${failed.size === 1 ? 'is' : 'are'} left empty: ${[...failed]
          .slice(0, 5)
          .map(([name, reason]) => `${name || '(no name)'} (${reason})`)
          .join(', ')}${failed.size > 5 ? ' and others' : ''}.`
      : '',
  };
}

type ReadOptions = Omit<Parameters<typeof parquetRead>[0], 'rowFormat' | 'onComplete'>;

/**
 * Checks the bytes of the description of the data, which lies at the end of the file in front of
 * its own length and the four letters, before hyparquet makes objects of them. A file without that
 * end is left to hyparquet and to `notParquet()`, which say what it is.
 */
async function checkEnd(source: Source): Promise<void> {
  if (source.length < 12) {
    return;
  }
  const end = await source.read(source.length - 8, source.length);
  const size = little(end, 0, 4);
  if (Buffer.from(end.subarray(4)).toString('latin1') !== 'PAR1' || size > source.length - 8) {
    return;
  }
  if (size > MAX_FOOTER) {
    throw new Error(`the description of the data takes ${Math.round(size / 1024 / 1024)} MB, and Previewix reads up to ${MAX_FOOTER / 1024 / 1024} MB of it`);
  }
  checkThrift(await source.read(source.length - 8 - size, source.length - 8));
}

/**
 * Reads the columns of one row group from the file and checks their pages (`checkChunk()`). What
 * comes back stands in for the file while hyparquet reads the group: it holds the checked bytes
 * and zeros everywhere else, so a page that nobody looked at can't be decoded. `refused` has the
 * top-level columns that failed the check, by index, with the reason.
 */
async function checkedColumns(source: Source, chunks: Chunk[], rows: number): Promise<{ file: AsyncBuffer; refused: Map<number, string> }> {
  const checked: { start: number; bytes: Uint8Array }[] = [];
  const refused = new Map<number, string>();
  for (const chunk of chunks) {
    if (refused.has(chunk.leaf.top)) {
      continue;
    }
    const bytes = await source.read(chunk.start, chunk.start + chunk.length);
    try {
      checked.push({ start: chunk.start, bytes: bytes.subarray(0, checkChunk(bytes, chunk, rows, inflate)) });
    } catch (e) {
      if (e instanceof Refusal) {
        throw e;
      }
      refused.set(chunk.leaf.top, e instanceof Error ? e.message : String(e));
    }
  }
  const file: AsyncBuffer = {
    byteLength: source.length,
    // Never throws: hyparquet asks for the bytes of one column while the read of another is under way.
    slice(start, end = source.length) {
      const out = new Uint8Array(Math.max(0, end - start));
      for (const part of checked) {
        const from = Math.max(start, part.start);
        const to = Math.min(end, part.start + part.bytes.length);
        if (from < to) {
          out.set(part.bytes.subarray(from - part.start, to - part.start), from - start);
        }
      }
      return out.buffer;
    },
  };
  return { file, refused };
}

/**
 * Reads a row group one column at a time, after reading it at once has failed or when some of
 * its columns did not pass the check. hyparquet doesn't know every encoding, and one column it
 * can't read shouldn't cost the rest: it is left empty and named.
 */
async function columnsApart(range: ReadOptions, names: string[], sound: number[], count: number, failed: Map<string, string>, first: unknown): Promise<unknown[][]> {
  const rows = Array.from({ length: count }, () => new Array<unknown>(names.length));
  let read = 0;
  for (const c of sound) {
    try {
      await parquetRead({
        ...range,
        columns: [names[c]],
        rowFormat: 'array',
        onComplete: (column: unknown[][]) => {
          for (let r = 0; r < Math.min(count, column.length); r++) {
            rows[r][c] = column[r][0];
          }
        },
      });
      read++;
    } catch (e) {
      // A reason of our own stands for the file, not for a column: without Zstandard, no column of it can be read.
      if (e instanceof Refusal) {
        throw e;
      }
      failed.set(names[c], failed.get(names[c]) ?? (e instanceof Error ? e.message : String(e)));
    }
  }
  // Nothing could be read: the trouble is with the file, not with a column.
  if (!read) {
    throw first;
  }
  return rows;
}

/** Says what is wrong with a file whose footer could not be read, when its first and last bytes tell. */
async function notParquet(source: Source): Promise<string> {
  if (source.length < 4) {
    return source.length ? 'this is not a Parquet file.' : 'the file is empty.';
  }
  const tail = Buffer.from(await source.read(source.length - 4, source.length)).toString('latin1');
  if (tail === 'PARE') {
    return 'the file is encrypted.';
  }
  if (tail !== 'PAR1') {
    const head = Buffer.from(await source.read(0, 4)).toString('latin1');
    return head === 'PAR1' ? 'the file is cut off: its end, where Parquet keeps the description of the data, is missing.' : 'this is not a Parquet file.';
  }
  return '';
}

// ---- Files ----------------------------------------------------------------

/** Where the bytes come from. A part that was asked for is not written to, so it may be a view of something larger. */
interface Source {
  length: number;
  read(start: number, end: number): Promise<Uint8Array>;
  close(): Promise<void> | void;
}

/** A file on disk. Its reads don't hold up the thread, so a slow disk is told apart from a reader that hangs. */
async function fileSource(path: string): Promise<Source> {
  const handle = await fs.promises.open(path, 'r');
  const { size } = await handle.stat();
  return {
    length: size,
    async read(start, end) {
      const out = new Uint8Array(Math.max(0, end - start));
      for (let done = 0; done < out.length; ) {
        const { bytesRead } = await handle.read(out, done, out.length - done, start + done);
        if (!bytesRead) {
          throw new Refusal('the file ended before the data it describes.');
        }
        done += bytesRead;
      }
      return out;
    },
    close: () => handle.close(),
  };
}

function memorySource(bytes: Uint8Array): Source {
  return { length: bytes.byteLength, read: async (start, end) => bytes.subarray(start, end), close: () => undefined };
}

/** The file as hyparquet takes one, for the description of the data at its end. */
function wholeFile(source: Source): AsyncBuffer {
  return {
    byteLength: source.length,
    async slice(start, end = source.length) {
      const part = await source.read(start, end);
      // An array of its own: a `Buffer` of Node.js is a window on memory it shares with others.
      return (part.byteOffset || part.byteLength !== part.buffer.byteLength ? new Uint8Array(part) : part).buffer as ArrayBuffer;
    },
  };
}

// ---- Compression ----------------------------------------------------------

/**
 * gzip, Brotli and Zstandard come from the zlib of the runtime, which costs nothing in size; Snappy
 * and LZ4 are small enough to be written out below. Every one of them stops at the size that the
 * page declares.
 */
const compressors: Compressors = {
  SNAPPY: snappy,
  GZIP: (input, length) => fresh(zlib.unzipSync(input, { maxOutputLength: Math.max(length, 1) })),
  BROTLI: (input, length) => fresh(zlib.brotliDecompressSync(input, { maxOutputLength: Math.max(length, 1) })),
  ZSTD: (input, length) => {
    // Node.js has Zstandard since 22.15, which is VS Code 1.101.
    const inflate = (zlib as unknown as { zstdDecompressSync?: (input: Uint8Array, options: object) => Buffer }).zstdDecompressSync;
    if (!inflate) {
      throw new Refusal('the file is compressed with Zstandard, which needs VS Code 1.101 or later.');
    }
    return fresh(inflate(input, { maxOutputLength: Math.max(length, 1) }));
  },
  LZ4: lz4Hadoop,
  LZ4_RAW: (input, length) => {
    const output = new Uint8Array(length);
    if (lz4Block(input, 0, input.length, output, 0) !== length) {
      throw new Error('the LZ4 data is damaged.');
    }
    return output;
  },
};

/** Unpacks a page for the checks, with the codecs above, and holds it to the size it claims as hyparquet does. */
const inflate: Inflate = (codec, packed, size) => {
  let page: Uint8Array;
  if (codec === 'UNCOMPRESSED') {
    page = packed;
  } else {
    const unpack = compressors[codec as keyof Compressors];
    if (!unpack) {
      throw new Error(`pages packed with ${codec}`);
    }
    page = unpack(packed, size);
  }
  if (page.length !== size) {
    throw new Error(`a page of ${page.length} bytes that says it has ${size}`);
  }
  return page;
};

/** Small results of zlib are views into a shared pool; the reader expects an array of its own. */
function fresh(buffer: Buffer): Uint8Array {
  return buffer.byteOffset === 0 && buffer.buffer.byteLength === buffer.byteLength ? buffer : new Uint8Array(buffer);
}

/** A number of `bytes` bytes, the lowest first. */
function little(input: Uint8Array, at: number, bytes: number): number {
  let value = 0;
  for (let i = 0; i < bytes; i++) {
    value += input[at + i] * 2 ** (8 * i);
  }
  return value;
}

const SNAPPY_DAMAGED = 'the Snappy data is damaged.';

/**
 * Decodes a page packed with Snappy. hyparquet has a decoder of its own, which is not used: on
 * damaged data it can take a length for a number below zero, step back in its input and go round
 * for seconds, or for good. This one checks every length against what is left before it copies.
 */
export function snappy(input: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  const end = input.length;
  // In front, the size of the result, seven bits to the byte.
  let ip = 0;
  let size = 0;
  for (let shift = 0, more = true; more; shift += 7) {
    if (ip >= end || shift > 28) {
      throw new Error(SNAPPY_DAMAGED);
    }
    size += (input[ip] & 0x7f) * 2 ** shift;
    more = input[ip++] >= 0x80;
  }
  if (size !== length) {
    throw new Error(SNAPPY_DAMAGED);
  }
  let op = 0;
  while (ip < end) {
    const tag = input[ip++];
    const kind = tag & 3;
    let count = (tag >>> 2) + 1;
    if (!kind) {
      // Bytes as they are. More than sixty of them have their number, less one, in the bytes that follow the tag.
      if (count > 60) {
        const bytes = count - 60;
        if (ip + bytes > end) {
          throw new Error(SNAPPY_DAMAGED);
        }
        count = little(input, ip, bytes) + 1;
        ip += bytes;
      }
      if (ip + count > end || op + count > length) {
        throw new Error(SNAPPY_DAMAGED);
      }
      // Most runs are a few bytes, for which a view of the input costs more than it saves.
      if (count < 32) {
        for (const stop = ip + count; ip < stop; ) {
          output[op++] = input[ip++];
        }
      } else {
        output.set(input.subarray(ip, ip + count), op);
        ip += count;
        op += count;
      }
      continue;
    }
    // A copy of what was written `offset` bytes back, with the distance in one, two or four bytes.
    let offset: number;
    if (kind === 1) {
      count = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | input[ip++];
    } else if (kind === 2) {
      offset = input[ip] | (input[ip + 1] << 8);
      ip += 2;
    } else {
      offset = little(input, ip, 4);
      ip += 4;
    }
    // Past the end of the input the distance is not a number, which is not a distance either.
    if (!(offset > 0 && offset <= op) || ip > end || op + count > length) {
      throw new Error(SNAPPY_DAMAGED);
    }
    // Byte by byte: the copy may overlap what it writes, which is how a pattern is repeated.
    for (let source = op - offset, stop = op + count; op < stop; ) {
      output[op++] = output[source++];
    }
  }
  if (op !== length) {
    throw new Error(SNAPPY_DAMAGED);
  }
  return output;
}

/** Decodes one LZ4 block into `output` from `at` on, and returns where it ended. */
export function lz4Block(input: Uint8Array, from: number, to: number, output: Uint8Array, at: number): number {
  let ip = from;
  let op = at;
  while (ip < to) {
    const token = input[ip++];
    let literals = token >> 4;
    if (literals === 15) {
      let more = 255;
      while (more === 255 && ip < to) {
        more = input[ip++];
        literals += more;
      }
    }
    if (ip + literals > to || op + literals > output.length) {
      throw new Error('the LZ4 data is damaged.');
    }
    output.set(input.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;
    // The last sequence of a block is literals only.
    if (ip >= to) {
      break;
    }
    const offset = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    let length = (token & 15) + 4;
    if ((token & 15) === 15) {
      let more = 255;
      while (more === 255 && ip < to) {
        more = input[ip++];
        length += more;
      }
    }
    if (!offset || offset > op - at || op + length > output.length) {
      throw new Error('the LZ4 data is damaged.');
    }
    // Byte by byte: the copy may overlap what it writes, which is how LZ4 repeats a pattern.
    for (let source = op - offset, end = op + length; op < end; ) {
      output[op++] = output[source++];
    }
  }
  return op;
}

/**
 * The codec called LZ4 is the framing of Hadoop: blocks, each after its decoded and its encoded
 * length. Some writers put a bare block there instead, which is tried when the framing doesn't fit.
 */
export function lz4Hadoop(input: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let ip = 0;
  let op = 0;
  let framed = true;
  try {
    while (framed && ip < input.length) {
      if (ip + 8 > input.length) {
        framed = false;
        break;
      }
      const size = view.getUint32(ip);
      const packed = view.getUint32(ip + 4);
      ip += 8;
      if (packed > input.length - ip || size > length - op || lz4Block(input, ip, ip + packed, output, op) !== op + size) {
        framed = false;
        break;
      }
      ip += packed;
      op += size;
    }
  } catch {
    framed = false;
  }
  if (framed && op === length) {
    return output;
  }
  if (lz4Block(input, 0, input.length, output.fill(0), 0) !== length) {
    throw new Error('the LZ4 data is damaged.');
  }
  return output;
}

// ---- Types ----------------------------------------------------------------

const UNITS = { MILLIS: 'ms', MICROS: 'us', NANOS: 'ns' } as const;

function isDecimal(element: SchemaElement): boolean {
  return element.converted_type === 'DECIMAL' || element.logical_type?.type === 'DECIMAL';
}

function logical(element: SchemaElement): string {
  return element.logical_type?.type ?? '';
}

/**
 * hyparquet turns a decimal into a float, which loses digits, and refuses intervals and BSON.
 * Without their annotation such columns arrive as stored, and are written out here.
 */
function withoutConversions(metadata: FileMetaData): FileMetaData {
  return {
    ...metadata,
    schema: metadata.schema.map((element, index) => {
      const top = index > 0 && isTopLevel(metadata.schema, index);
      const refused = element.converted_type === 'INTERVAL' || element.converted_type === 'BSON' || ['INTERVAL', 'BSON'].includes(logical(element));
      return refused || (top && isDecimal(element)) ? { ...element, converted_type: undefined, logical_type: undefined } : element;
    }),
  };
}

/** True for the elements right under the root: the columns of the table. */
function isTopLevel(schema: SchemaElement[], index: number): boolean {
  let at = 1;
  while (at < index) {
    at += size(schema, at);
  }
  return at === index;
}

function size(schema: SchemaElement[], index: number): number {
  let count = 1;
  for (let child = 0; child < (schema[index].num_children ?? 0); child++) {
    count += size(schema, index + count);
  }
  return count;
}

function leafName(element: SchemaElement): string {
  const type = element.logical_type;
  const converted = element.converted_type ?? '';
  if (isDecimal(element)) {
    const precision = (type?.type === 'DECIMAL' ? type.precision : undefined) ?? element.precision ?? 0;
    const scale = (type?.type === 'DECIMAL' ? type.scale : undefined) ?? element.scale ?? 0;
    return `decimal(${precision}, ${scale})`;
  }
  if (type?.type === 'INTEGER') {
    return `${type.isSigned ? 'int' : 'uint'}${type.bitWidth}`;
  }
  if (/^U?INT_\d+$/.test(converted)) {
    return converted.toLowerCase().replace('_', '');
  }
  if (type?.type === 'TIMESTAMP') {
    return `timestamp[${UNITS[type.unit]}${type.isAdjustedToUTC ? ', UTC' : ''}]`;
  }
  if (converted === 'TIMESTAMP_MILLIS' || converted === 'TIMESTAMP_MICROS') {
    return `timestamp[${converted.endsWith('MILLIS') ? 'ms' : 'us'}, UTC]`;
  }
  if (type?.type === 'TIME') {
    return `time[${UNITS[type.unit]}]`;
  }
  if (converted === 'TIME_MILLIS' || converted === 'TIME_MICROS') {
    return `time[${converted.endsWith('MILLIS') ? 'ms' : 'us'}]`;
  }
  if (type?.type === 'STRING' || converted === 'UTF8') {
    return 'string';
  }
  const named = type?.type ?? converted;
  if (named) {
    return named.toLowerCase();
  }
  switch (element.type) {
    case 'BOOLEAN':
      return 'boolean';
    case 'INT32':
      return 'int32';
    case 'INT64':
      return 'int64';
    case 'INT96':
      return 'timestamp[ns]';
    case 'FLOAT':
      return 'float';
    case 'DOUBLE':
      return 'double';
    case 'FIXED_LEN_BYTE_ARRAY':
      return `binary[${element.type_length ?? 0}]`;
    default:
      return 'binary';
  }
}

/** The type of a column as people write it: `list<string>`, `struct<a: int32, b: double>`. */
function typeName(node: SchemaTree, full: boolean, repeated = node.element.repetition_type === 'REPEATED'): string {
  const { element, children } = node;
  let name: string;
  if (!children.length) {
    name = leafName(element);
  } else {
    const kind = logical(element) || element.converted_type || '';
    // A list is a group around a repeated group around the element; a map, around a repeated pair.
    const inner = children.length === 1 && children[0].element.repetition_type === 'REPEATED' ? children[0] : undefined;
    if (kind === 'LIST' && inner) {
      // Old writers leave the middle group out, and the repeated field is the element itself.
      name = full ? `list<${inner.children.length === 1 ? typeName(inner.children[0], true) : typeName(inner, true, false)}>` : 'list';
    } else if ((kind === 'MAP' || kind === 'MAP_KEY_VALUE') && inner && inner.children.length === 2) {
      name = full ? `map<${typeName(inner.children[0], true)}, ${typeName(inner.children[1], true)}>` : 'map';
    } else if (kind === 'VARIANT') {
      name = 'variant';
    } else {
      name = full ? `struct<${children.map((child) => `${child.element.name}: ${typeName(child, true)}`).join(', ')}>` : 'struct';
    }
  }
  // A repeated field outside a list annotation is the oldest way to write a list.
  return repeated ? (full ? `list<${name}>` : 'list') : name;
}

function isNumeric(node: SchemaTree): boolean {
  const { element } = node;
  if (node.children.length || element.repetition_type === 'REPEATED') {
    return false;
  }
  if (isDecimal(element) || logical(element) === 'INTEGER' || logical(element) === 'FLOAT16' || /^U?INT_\d+$/.test(element.converted_type ?? '')) {
    return true;
  }
  return !element.logical_type && !element.converted_type && ['INT32', 'INT64', 'FLOAT', 'DOUBLE'].includes(element.type ?? '');
}

// ---- Values ---------------------------------------------------------------

const pad = (value: number | bigint, width: number) => String(value).padStart(width, '0');

/** The part of a second after the point: three, six or nine digits, whichever the value needs, or nothing. */
function fractionText(fraction: bigint, perSecond: bigint): string {
  return fraction ? `.${pad(fraction, String(perSecond).length - 1).replace(/(000){1,2}$/, '')}` : '';
}

/** A point in time as `2024-02-29 12:34:56.789`, in UTC and without a zone, as the file stores it. */
function timestampText(value: bigint | number, perSecond: bigint): string {
  const total = BigInt(value);
  let seconds = total / perSecond;
  let fraction = total % perSecond;
  if (fraction < 0n) {
    fraction += perSecond;
    seconds -= 1n;
  }
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  // Years outside 0000 to 9999 come with a sign and six digits.
  const iso = date.toISOString();
  const text = `${iso.slice(0, iso.indexOf('T'))} ${iso.slice(iso.indexOf('T') + 1, iso.indexOf('T') + 9)}`;
  return text + fractionText(fraction, perSecond);
}

function dateText(days: number): string {
  const date = new Date(days * 86_400_000);
  if (Number.isNaN(date.getTime())) {
    return String(days);
  }
  const iso = date.toISOString();
  return iso.slice(0, iso.indexOf('T'));
}

function timeText(value: bigint | number, perSecond: bigint): string {
  const total = BigInt(value);
  const seconds = total / perSecond;
  const fraction = total % perSecond;
  const text = `${pad(seconds / 3600n, 2)}:${pad((seconds / 60n) % 60n, 2)}:${pad(seconds % 60n, 2)}`;
  return text + fractionText(fraction, perSecond);
}

/** hyparquet hands every date and time to these, at any depth, so nested values are written the same way. */
const parsers = {
  timestampFromMilliseconds: (millis: bigint) => timestampText(millis, 1000n),
  timestampFromMicroseconds: (micros: bigint) => timestampText(micros, 1_000_000n),
  timestampFromNanoseconds: (nanos: bigint) => timestampText(nanos, 1_000_000_000n),
  dateFromDays: dateText,
  // JSON stays the text it is; parsing and writing it again would only reformat it.
  jsonFromBytes: (bytes: Uint8Array) => bytes && utf8.decode(bytes),
};

const utf8 = new TextDecoder();
const strict = new TextDecoder('utf-8', { fatal: true });

function hex(bytes: Uint8Array): string {
  const shown = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, MAX_HEX)).toString('hex');
  return bytes.length > MAX_HEX ? `${shown}… (${bytes.length.toLocaleString('en-US')} bytes)` : shown;
}

/** The text that the bytes are, or nothing when they aren't text. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    const text = strict.decode(bytes);
    // Control characters other than tab and line breaks are not something a text holds.
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Bytes as text when they are text, which they are in the files of writers that don't say so; in hex otherwise. */
function bytesText(bytes: Uint8Array): string {
  return textOf(bytes) ?? hex(bytes);
}

/** A big-endian two's complement number of any length. */
function bigFromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return bytes.length && bytes[0] & 0x80 ? value - (1n << BigInt(bytes.length * 8)) : value;
}

function decimalText(value: unknown, scale: number): string {
  const unscaled = value instanceof Uint8Array ? bigFromBytes(value) : BigInt(value as number | bigint);
  if (scale <= 0) {
    return String(unscaled * 10n ** BigInt(-scale));
  }
  const negative = unscaled < 0n;
  const digits = String(negative ? -unscaled : unscaled).padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** The shortest number that reads back as the same 32-bit float: 0.1, not 0.10000000149011612. */
function floatText(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  for (let precision = 6; precision < 9; precision++) {
    const short = Number(value.toPrecision(precision));
    if (Math.fround(short) === value) {
      return String(short);
    }
  }
  return String(Number(value.toPrecision(9)));
}

/** Compact JSON of a nested value. Numbers that JSON can't hold exactly are written as they are. */
function json(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : `"${value}"`;
    case 'bigint':
    case 'boolean':
      return String(value);
  }
  if (value instanceof Uint8Array) {
    return JSON.stringify(bytesText(value));
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return `[${Array.from(value as ArrayLike<unknown>, json).join(',')}]`;
  }
  return `{${Object.entries(value as object)
    .map(([key, item]) => `${JSON.stringify(key)}:${json(item)}`)
    .join(',')}}`;
}

function plainText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
  }
  return value instanceof Uint8Array ? bytesText(value) : json(value);
}

/** How the values of a column become text. */
function columnFormat(node: SchemaTree): (value: unknown) => string {
  const { element } = node;
  if (node.children.length || element.repetition_type === 'REPEATED') {
    return json;
  }
  if (isDecimal(element)) {
    const type = element.logical_type;
    const scale = (type?.type === 'DECIMAL' ? type.scale : undefined) ?? element.scale ?? 0;
    return (value) => decimalText(value, scale);
  }
  const type = element.logical_type;
  if (type?.type === 'TIME' || element.converted_type === 'TIME_MILLIS' || element.converted_type === 'TIME_MICROS') {
    const unit = type?.type === 'TIME' ? type.unit : element.converted_type === 'TIME_MILLIS' ? 'MILLIS' : 'MICROS';
    const perSecond = unit === 'MILLIS' ? 1000n : unit === 'MICROS' ? 1_000_000n : 1_000_000_000n;
    return (value) => (typeof value === 'number' || typeof value === 'bigint' ? timeText(value, perSecond) : plainText(value));
  }
  if (element.type === 'FLOAT' && !type) {
    return (value) => (typeof value === 'number' ? floatText(value) : plainText(value));
  }
  if (element.type === 'BYTE_ARRAY' || element.type === 'FIXED_LEN_BYTE_ARRAY') {
    if (logical(element) === 'ENUM' || element.converted_type === 'ENUM') {
      return (value) => (value instanceof Uint8Array ? utf8.decode(value) : plainText(value));
    }
    // A column is text or it isn't: once a value turned out not to be, the rest is shown in hex too.
    let binary = element.type === 'FIXED_LEN_BYTE_ARRAY';
    return (value) => {
      if (!(value instanceof Uint8Array)) {
        return plainText(value);
      }
      if (!binary) {
        const text = textOf(value);
        if (text !== undefined) {
          return text;
        }
        binary = true;
      }
      return hex(value);
    };
  }
  return plainText;
}

if (!isMainThread && workerData?.previewixParquet) {
  // A sign of life every second for as long as the thread gets to run. A reader that is caught in
  // a loop sends none, which is how the provider knows to give up on it.
  const alive = setInterval(() => parentPort?.postMessage({ alive: true }), 1000);
  // The answer is the one of `readParquet()`. A promise inside hyparquet that fails with nobody waiting must not end the thread before it is sent.
  process.on('unhandledRejection', () => undefined);
  readParquet(workerData.previewixParquet as ParquetSource)
    .then(
      (table) => parentPort?.postMessage({ table }, [table.text.buffer, table.ends.buffer, table.rowEnds.buffer] as ArrayBuffer[]),
      (e) => parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) }),
    )
    .finally(() => clearInterval(alive));
}
