/**
 * What is checked of a Parquet file before hyparquet is given any of it. No vscode import.
 *
 * hyparquet trusts the file: a list is made as long as it claims to be, a number of children
 * below zero makes it loop for good, a run of repeated values is written out however long, and a
 * mistake in one column can leave the read of another without anyone to wait for it. A damaged
 * file must cost neither minutes nor gigabytes, so the description of the data is checked here
 * first, as bytes (`checkThrift()`) and as what they say (`checkFooter()`), and then every page of
 * a column on its way to the reader (`checkChunk()`): its header, its sizes, and the counts that
 * the decoder would otherwise take on trust. hyparquet only ever sees bytes that have passed.
 *
 * The page checks follow hyparquet 1.31.1 step by step, since they have to read exactly what it
 * will read (`readColumn()`, `readDataPage()`, `readDataPageV2()`, `readRleBitPackedHybrid()`,
 * `deltaByteArray()` there). They need another look when that version is raised.
 */
import type { FileMetaData, SchemaElement } from 'hyparquet';

/** A reason given in words of our own, shown as it is. Anything else that is thrown is reported as damage. */
export class Refusal extends Error {}

/** No table nests deeper; a schema that does is a damaged one, and would be walked by recursion. */
const MAX_DEPTH = 64;
/**
 * The description of the data at the end of a file takes kilobytes, and megabytes for thousands of
 * columns in hundreds of row groups. hyparquet makes an object of every field of it, so one past
 * this would cost gigabytes whether it is damaged or not.
 */
export const MAX_FOOTER = 16 * 1024 * 1024;
/** Structures of Thrift inside one another: seven deep in a Parquet file. Deeper is damage, and is walked by recursion. */
const MAX_NESTING = 32;
/** A page header is a few dozen bytes, or as long as the largest value of its page when it carries statistics. */
const MAX_HEADER = 16 * 1024 * 1024;
/** A page is meant to hold about a megabyte. One past these limits is not read. */
export const MAX_PAGE_BYTES = 256 * 1024 * 1024;
export const MAX_PAGE_VALUES = 1 << 24;
/** The values of one column in one row group, where they are all decoded at once (a nested column). */
const MAX_CHUNK_VALUES = 1 << 26;
/** A run may pass the end of its page by this much, which writers that round up do, without being taken for damage. */
const SLACK = 1 << 16;

/** A column that holds values: an element of the schema without children. */
export interface Leaf {
  /** The names from the top-level column down to this one. */
  path: string[];
  /** Index of the top-level column it belongs to. */
  top: number;
  element: SchemaElement;
  /** The highest repetition and definition level of its values, as hyparquet counts them. */
  maxRepetition: number;
  maxDefinition: number;
  /** A top-level column that is not repeated: its pages are read only up to the rows that are asked for. */
  flat: boolean;
}

/** The part of the file that holds one column of one row group. */
export interface Chunk {
  leaf: Leaf;
  codec: string;
  start: number;
  length: number;
}

export interface Footer {
  leaves: Leaf[];
  /** The chunks of every row group, in the order of the file. */
  groups: Chunk[][];
  /** The rows of every row group, and of all of them. */
  groupRows: number[];
  rows: number;
}

const key = (path: string[]) => path.join('\u0000');

function natural(value: unknown, what: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${what} is ${String(value)}`);
  }
  return number;
}

/**
 * Checks the description of the data at the end of the file, and gives back what the page checks
 * need of it. After this, nothing hyparquet does with the schema or the list of chunks can loop
 * or throw while columns are being read.
 */
export function checkFooter(metadata: FileMetaData, fileLength: number): Footer {
  const { schema } = metadata;
  if (!Array.isArray(schema) || !schema.length) {
    throw new Error('the schema is missing');
  }
  const leaves: Leaf[] = [];
  let top = -1;
  // Every element says how many of the following ones are its children; the counts must add up to the list.
  const walk = (index: number, path: string[], repetition: number, definition: number): number => {
    const element = schema[index];
    if (!element || typeof element.name !== 'string') {
      throw new Error('the schema names more columns than it has');
    }
    const children = element.num_children ?? 0;
    if (!Number.isInteger(children) || children < 0 || path.length > MAX_DEPTH) {
      throw new Error(`the column ${element.name || index} has ${children} children`);
    }
    if (index && !children) {
      leaves.push({ path, top, element, maxRepetition: repetition, maxDefinition: definition, flat: path.length === 1 && element.repetition_type !== 'REPEATED' });
    }
    let next = index + 1;
    for (let child = 0; child < children; child++) {
      const { name, repetition_type: type } = schema[next] ?? {};
      if (!index) {
        top++;
      }
      next = walk(next, [...path, name], repetition + (type === 'REPEATED' ? 1 : 0), definition + (type !== 'REQUIRED' ? 1 : 0));
    }
    return next;
  };
  if (walk(0, [], schema[0].repetition_type === 'REPEATED' ? 1 : 0, 0) !== schema.length) {
    throw new Error('the schema has columns that belong to none');
  }
  // hyparquet looks a column up by its names, and takes the first that fits.
  const byPath = new Map<string, Leaf>();
  for (const leaf of leaves) {
    if (!byPath.has(key(leaf.path))) {
      byPath.set(key(leaf.path), leaf);
    }
  }

  if (!Array.isArray(metadata.row_groups)) {
    throw new Error('the row groups are missing');
  }
  const groupRows: number[] = [];
  let rows = 0;
  const groups = metadata.row_groups.map((group, g) => {
    groupRows.push(natural(group.num_rows, `the number of rows of row group ${g + 1}`));
    rows = natural(rows + groupRows[g], 'the number of rows');
    if (!Array.isArray(group.columns)) {
      throw new Error(`row group ${g + 1} has no columns`);
    }
    return group.columns.map((column): Chunk => {
      const meta = column.meta_data;
      if (!meta || column.file_path) {
        throw new Error(`row group ${g + 1} keeps a column in another file`);
      }
      const leaf = Array.isArray(meta.path_in_schema) ? byPath.get(key(meta.path_in_schema)) : undefined;
      if (!leaf) {
        throw new Error(`row group ${g + 1} has a column that the schema does not: ${String(meta.path_in_schema)}`);
      }
      if (meta.type !== leaf.element.type) {
        throw new Error(`the column ${leaf.path.join('.')} is ${leaf.element.type} in the schema and ${meta.type} in row group ${g + 1}`);
      }
      const where = `of the column ${leaf.path.join('.')} in row group ${g + 1}`;
      natural(meta.num_values, `the number of values ${where}`);
      // The same place hyparquet takes: the dictionary comes first, when there is one.
      const start = natural(meta.dictionary_page_offset || meta.data_page_offset, `the place ${where}`);
      const length = natural(meta.total_compressed_size, `the size ${where}`);
      if (start + length > fileLength) {
        throw new Refusal('the file ended before the data it describes.');
      }
      return { leaf, codec: meta.codec, start, length };
    });
  });
  return { leaves, groups, groupRows, rows };
}

// ---- Pages ----------------------------------------------------------------

/** Reads forward through bytes, and throws when they end. */
class Reader {
  offset = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly end = bytes.length,
  ) {}

  byte(): number {
    if (this.offset >= this.end) {
      throw new Error('a page ends in the middle of a value');
    }
    return this.bytes[this.offset++];
  }

  skip(length: number): void {
    if (length < 0 || this.offset + length > this.end) {
      throw new Error('a page ends in the middle of a value');
    }
    this.offset += length;
  }

  /** A number of seven bits to the byte, added up the way hyparquet does: in 32 bits, whatever the length. */
  varint(): number {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.byte();
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) {
        return result;
      }
    }
  }

  zigzag(): number {
    const value = this.varint();
    return (value >>> 1) ^ -(value & 1);
  }

  uint32(): number {
    this.skip(4);
    const { bytes, offset } = this;
    return (bytes[offset - 4] | (bytes[offset - 3] << 8) | (bytes[offset - 2] << 16) | (bytes[offset - 1] << 24)) >>> 0;
  }
}

/** A structure of Thrift's compact protocol: its numbers and truth values by field, and its structures in turn. */
interface Fields {
  [field: number]: number | boolean | Fields | undefined;
}

/**
 * Reads one structure to its end and skips what the checks have no use for (texts, lists), so
 * that nothing is built from a count the file claims. It throws where the bytes end before the
 * structure does: hyparquet's own reader stops there without a word, and reads a list of
 * structures that isn't there as a list of empty ones, as long as the file says. Fields are
 * numbered as in parquet.thrift.
 */
function thrift(reader: Reader, depth = 0): Fields {
  if (depth > MAX_NESTING) {
    throw new Error('structures nested deeper than any Parquet file has them');
  }
  const fields: Fields = {};
  let field = 0;
  for (;;) {
    const head = reader.byte();
    const type = head & 15;
    if (!type) {
      return fields;
    }
    field = head >> 4 ? field + (head >> 4) : reader.zigzag();
    fields[field] = element(reader, type, depth);
  }
}

function element(reader: Reader, type: number, depth: number): number | boolean | Fields | undefined {
  switch (type) {
    case 1:
      return true;
    case 2:
      return false;
    case 3:
      return reader.byte();
    case 4:
    case 5:
      return reader.zigzag();
    case 6:
      // 64 bits, of which a page header has none that matter here.
      reader.varint();
      return undefined;
    case 7:
      reader.skip(8);
      return undefined;
    case 8:
      reader.skip(reader.varint());
      return undefined;
    case 9: {
      const head = reader.byte();
      const size = head >> 4 === 15 ? reader.varint() : head >> 4;
      // Every element takes a byte at least, so a list can't be longer than what is left.
      if (size < 0 || size > reader.end - reader.offset) {
        throw new Error(`a list of ${size} entries in ${reader.end - reader.offset} bytes`);
      }
      const kind = head & 15;
      for (let i = 0; i < size; i++) {
        // In a list, truth values are bytes.
        element(reader, kind === 1 || kind === 2 ? 3 : kind, depth + 1);
      }
      return undefined;
    }
    case 12:
      return thrift(reader, depth + 1);
    default:
      throw new Error(`a field of an unknown kind (${type})`);
  }
}

/** Walks the description of the data, as the bytes between the last page and the length at the end of the file, before hyparquet reads it. */
export function checkThrift(footer: Uint8Array): void {
  thrift(new Reader(footer));
}

const whole = (value: unknown, what: string, most = 0x7fffffff): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > most) {
    throw new Error(`${what} is ${String(value)}`);
  }
  return value;
};

/** Bits needed for a level, as hyparquet works them out. */
const bitsFor = (level: number) => 32 - Math.clz32(level);

/**
 * Walks runs of the hybrid of run lengths and packed bits, as `readRleBitPackedHybrid()` of
 * hyparquet does for `count` values, and gives the place after them. A run of repeated values
 * that is longer than what is still to come is the one thing the decoder would write out blindly.
 * With `level`, the values equal to it are counted.
 */
function runs(reader: Reader, width: number, count: number, slack: number, length?: number, level?: number): number {
  if (length === undefined) {
    length = reader.uint32();
  }
  const start = reader.offset;
  const mask = (1 << width) - 1;
  let matches = 0;
  let seen = 0;
  // The decoder goes on until its array is full, and a run that passed the end has made the array longer.
  for (let size = count; seen < size; ) {
    const header = reader.varint();
    if (header & 1) {
      const packed = (header >> 1) << 3;
      // Without bits to read, the decoder counts the run down and nothing else; below zero it would never arrive.
      if (packed < 0 || (!width && packed > count + SLACK)) {
        throw new Error(`a packed run of ${packed} values in a page of ${count}`);
      }
      const from = reader.offset;
      // The first byte is read even by a run that needs none, unless there is none left to read.
      if (width || reader.offset < reader.end) {
        reader.skip(Math.max(1, Math.ceil((packed * width) / 8)));
      }
      if (level !== undefined) {
        const { bytes } = reader;
        for (let i = 0, most = Math.min(packed, size - seen); i < most; i++) {
          const bit = i * width;
          const at = from + (bit >> 3);
          if ((((bytes[at] | ((bytes[at + 1] ?? 0) << 8)) >> (bit & 7)) & mask) === level) {
            matches++;
          }
        }
      }
      seen = Math.min(size, seen + packed);
    } else {
      const repeated = header >>> 1;
      let value = 0;
      for (let i = 0; i < (width + 7) >> 3; i++) {
        value |= reader.byte() << (i << 3);
      }
      if (repeated > size - seen + slack) {
        throw new Error(`a run of ${repeated} values in a page of ${count}`);
      }
      if (value === level) {
        matches += repeated;
      }
      seen += repeated;
      size = Math.max(size, seen);
    }
  }
  reader.offset = start;
  reader.skip(length);
  return matches;
}

/** The numbers of a delta-packed block of integers, read as `deltaBinaryUnpack()` of hyparquet reads them. */
function deltas(reader: Reader, count: number, values: Int32Array | undefined): void {
  const blockSize = reader.varint();
  const miniblocks = reader.varint();
  reader.varint();
  // Writers use blocks of 128 or 256 values in 4 or 8 parts. The decoder makes an array of the parts before it reads one.
  if (blockSize <= 0 || blockSize > 1 << 16 || miniblocks <= 0 || miniblocks > 1 << 10 || blockSize % miniblocks) {
    throw new Error(`delta blocks of ${blockSize} values in ${miniblocks} parts`);
  }
  if (!values) {
    return;
  }
  // The decoder passes over a part by whole bytes only when the part is made of whole bytes, as the format demands.
  if ((blockSize / miniblocks) % 8) {
    throw new Error(`delta blocks of ${blockSize} values in ${miniblocks} parts`);
  }
  const zigzag = (): bigint => {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = reader.byte();
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) {
        return (result >> 1n) ^ -(result & 1n);
      }
    }
  };
  let value = zigzag();
  let index = 0;
  values[index++] = Number(value);
  const perMiniblock = blockSize / miniblocks;
  while (index < count) {
    const minDelta = zigzag();
    const widths = reader.offset;
    reader.skip(miniblocks);
    for (let i = 0; i < miniblocks && index < count; i++) {
      const width = reader.bytes[widths + i];
      let left = perMiniblock;
      if (width) {
        // Bit by bit from the lowest of each byte.
        let bit = 0;
        for (; left && index < count; left--) {
          let bits = 0n;
          for (let got = 0; got < width; ) {
            const take = Math.min(8 - (bit & 7), width - got);
            if (reader.offset + (bit >> 3) >= reader.end) {
              throw new Error('a page ends in the middle of a value');
            }
            bits |= BigInt((reader.bytes[reader.offset + (bit >> 3)] >> (bit & 7)) & ((1 << take) - 1)) << BigInt(got);
            got += take;
            bit += take;
          }
          value += minDelta + bits;
          values[index++] = Number(value);
        }
        // A part that was not needed to its end is still there to be passed over.
        reader.skip(Math.ceil((bit + left * width) / 8));
      } else {
        for (; left && index < count; left--) {
          value += minDelta;
          values[index++] = Number(value);
        }
      }
    }
  }
}

/** Texts stored as what they share with the one before and what they add: every text is built anew, so their sizes are checked. */
function deltaTexts(reader: Reader, count: number): void {
  if (!count) {
    return;
  }
  const prefixes = new Int32Array(count);
  deltas(reader, count, prefixes);
  const suffixes = new Int32Array(count);
  deltas(reader, count, suffixes);
  let previous = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (prefixes[i] < 0 || suffixes[i] < 0 || prefixes[i] > previous) {
      throw new Error(`a text that takes ${prefixes[i]} bytes from one of ${previous}`);
    }
    reader.skip(suffixes[i]);
    previous = prefixes[i] + suffixes[i];
    total += previous;
    if (total > MAX_PAGE_BYTES) {
      throw new Error('a page of texts that add up to more than Previewix reads');
    }
  }
}

// The encodings of parquet.thrift.
const PLAIN_DICTIONARY = 2;
const RLE = 3;
const DELTA_BINARY_PACKED = 5;
const DELTA_LENGTH_BYTE_ARRAY = 6;
const DELTA_BYTE_ARRAY = 7;
const RLE_DICTIONARY = 8;
const BYTE_STREAM_SPLIT = 9;

const WIDTHS: Record<string, number> = { INT32: 4, FLOAT: 4, INT64: 8, DOUBLE: 8 };

/** The values of a data page, after its levels: the encodings whose decoders take a count or a size from the data. */
function checkValues(reader: Reader, leaf: Leaf, encoding: number, values: number, version: 1 | 2): void {
  const boolean = leaf.element.type === 'BOOLEAN';
  if (encoding === PLAIN_DICTIONARY || encoding === RLE_DICTIONARY || (encoding === RLE && version === 1)) {
    // An index into the dictionary, behind the number of bits it takes. Truth values have no dictionary and take one bit.
    const width = boolean && version === 1 ? 1 : reader.byte();
    if (width > 32) {
      throw new Error(`dictionary indexes of ${width} bits`);
    }
    // In a page of version 1, hyparquet reads nothing for a width of zero.
    if (width || version === 2) {
      runs(reader, width, values, SLACK, boolean && version === 1 ? undefined : reader.end - reader.offset);
    }
  } else if (encoding === RLE) {
    runs(reader, 1, values, SLACK);
  } else if (encoding === DELTA_BINARY_PACKED || encoding === DELTA_LENGTH_BYTE_ARRAY) {
    if (values) {
      deltas(reader, values, undefined);
    }
  } else if (encoding === DELTA_BYTE_ARRAY) {
    deltaTexts(reader, values);
  } else if (encoding === BYTE_STREAM_SPLIT) {
    // The decoder makes room for every value before it reads one.
    const width = WIDTHS[leaf.element.type ?? ''] ?? leaf.element.type_length ?? 0;
    if (values * width > reader.end - reader.offset) {
      throw new Error(`${values} values of ${width} bytes in a page of ${reader.end - reader.offset}`);
    }
  }
}

/** Unpacks a page, or says why not. The result has the size the page header promised. */
export type Inflate = (codec: string, packed: Uint8Array, size: number) => Uint8Array;

/**
 * Checks the pages of one column of one row group: `bytes` is its part of the file, and `rows`
 * is how many rows of the group will be read. Gives the number of bytes that were checked, which
 * is all that hyparquet may be shown; throws with the reason when a page can't be trusted.
 */
export function checkChunk(bytes: Uint8Array, { leaf, codec }: Chunk, rows: number, inflate: Inflate): number {
  const reader = new Reader(bytes);
  const repetition = leaf.maxRepetition ? bitsFor(leaf.maxRepetition) : 0;
  const definition = leaf.maxDefinition ? bitsFor(leaf.maxDefinition) : 0;
  let seen = 0;
  // The loop of `readColumn()`: a flat column stops at the rows it was asked for, any other at the end of its bytes.
  while (reader.offset < bytes.length - 1 && !(leaf.flat && seen >= rows)) {
    const head = new Reader(bytes, Math.min(bytes.length, reader.offset + MAX_HEADER));
    head.offset = reader.offset;
    const header = thrift(head);
    reader.offset = head.offset;
    const type = whole(header[1], 'the kind of a page');
    const size = whole(header[2], 'the size of a page', MAX_PAGE_BYTES);
    const packedSize = whole(header[3], 'the packed size of a page', bytes.length - reader.offset);
    const packed = bytes.subarray(reader.offset, reader.offset + packedSize);
    reader.skip(packedSize);

    if (type === 2) {
      // A dictionary: plain values, which the decoder reads until they or their bytes run out.
      whole((header[7] as Fields | undefined)?.[1], 'the number of values of a dictionary', MAX_PAGE_VALUES);
    } else if (type === 0) {
      const page = header[5] as Fields | undefined;
      const values = whole(page?.[1], 'the number of values of a page', MAX_PAGE_VALUES);
      const data = new Reader(inflate(codec, packed, size));
      if (repetition) {
        runs(data, repetition, values, 0);
      }
      const present = definition ? runs(data, definition, values, 0, undefined, leaf.maxDefinition) : values;
      checkValues(data, leaf, whole(page?.[2], 'the encoding of a page'), present, 1);
      seen += values;
    } else if (type === 3) {
      const page = header[8] as Fields | undefined;
      const values = whole(page?.[1], 'the number of values of a page', MAX_PAGE_VALUES);
      const nulls = whole(page?.[2], 'the number of nulls of a page', values);
      const definitionLength = whole(page?.[5], 'the size of the levels of a page', packedSize);
      const repetitionLength = whole(page?.[6], 'the size of the levels of a page', packedSize - definitionLength);
      // The levels lie in front of the values and are never packed.
      const levels = new Reader(packed);
      if (repetition) {
        runs(levels, repetition, values, 0, repetitionLength);
      }
      levels.offset = repetitionLength;
      if (definition) {
        runs(levels, definition, values, 0, definitionLength);
      }
      const rest = packed.subarray(levels.offset);
      const data = page?.[7] === false ? rest : inflate(codec, rest, whole(size - definitionLength - repetitionLength, 'the size of a page'));
      checkValues(new Reader(data), leaf, whole(page?.[4], 'the encoding of a page'), values - nulls, 2);
      seen += values;
    } else {
      throw new Error(`a page of a kind Previewix does not read (${type})`);
    }
    if (seen > MAX_CHUNK_VALUES) {
      throw new Error(`more than ${MAX_CHUNK_VALUES.toLocaleString('en-US')} values in one row group`);
    }
  }
  // A flat column was checked as far as it will be read; of another, the last byte goes along.
  return leaf.flat && seen >= rows ? reader.offset : bytes.length;
}
