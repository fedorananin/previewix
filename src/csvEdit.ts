/**
 * Edits of a delimited text file, and writing them back so that everything that was not edited
 * keeps its exact bytes. No vscode import, so it can be exercised outside VS Code; also a worker
 * thread entry (dist/csvEdit.js), because writing a large file means parsing it twice.
 */
import { createHash } from 'crypto';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { decodeWithEncoding, detectDelimiter, parseCsvFlat, parseCsvSpans, type FlatTable, type SpanTable } from './csv';
import { textDecoder } from './textDecoding';

/** Rows as they travel between the page and the extension: a `FlatTable` with its text as UTF-8. */
export interface WireTable {
  text: Uint8Array;
  ends: Uint32Array;
  rowEnds: Uint32Array;
}

/**
 * One step of an edit. Rows are numbered as they stand in the table at that moment, in rising order.
 * - `set` gives existing rows new cells. Without `at` the cells of `table` are all the cells of the row. With
 *   `at` they stand for cells the row has from that column on: for as many as there are, or, with `widths`,
 *   for that many per row, which is how a column goes in (0 cells make way for one) or out (one for none).
 *   `map` is for the pages alone: for a `set` that moves columns, the old column of every new one.
 * - `insert` adds the rows of `table`; `rows` are the numbers they have afterwards.
 * - `delete` takes rows out.
 * The page works out the inverse of every step when it applies it, so a step never has to be undone from scratch.
 */
export interface Op {
  type: 'set' | 'insert' | 'delete';
  rows: Uint32Array;
  table?: WireTable;
  at?: number;
  widths?: Uint32Array;
  map?: number[];
}

/** The text can't be written in the file's encoding. `chars` are the first characters it has no place for. */
export class Unencodable extends Error {
  constructor(
    readonly encoding: string,
    readonly chars: string[],
  ) {
    super(`The file is ${encoding}, which cannot hold ${chars.length ? chars.map((char) => `“${char}”`).join(', ') : 'this text'}.`);
  }
}

/** The encodings a file can be converted to when its own can't hold an edit. */
export type Conversion = 'UTF-8' | 'UTF-8 with BOM';

export interface RenderOptions {
  delimiter: string;
  /** The line break for new rows of a file that has none to copy. */
  eol?: string;
  /** Writes the whole file in another encoding instead of its own. */
  convert?: Conversion;
  /** Reads the result back and compares it with the edited table before it is returned. */
  verify?: boolean;
}

// ---- Messages --------------------------------------------------------------

/** Typed arrays arrive as such from a webview; older transports hand over a plain object or an array instead. */
function typed<T extends Uint8Array | Uint32Array>(value: unknown, Type: { new (items: number[]): T; new (buffer: ArrayBufferLike, offset: number, length: number): T; BYTES_PER_ELEMENT: number }): T {
  if (value instanceof Type) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Type(value.buffer, value.byteOffset, value.byteLength / Type.BYTES_PER_ELEMENT);
  }
  if (value instanceof ArrayBuffer) {
    return new Type(value, 0, value.byteLength / Type.BYTES_PER_ELEMENT);
  }
  if (Array.isArray(value)) {
    return new Type(value as number[]);
  }
  if (value && typeof value === 'object') {
    const inner = (value as { data?: unknown }).data;
    return new Type(Array.isArray(inner) ? (inner as number[]) : (Object.values(value) as number[]));
  }
  throw new Error('The edit is not in a form that can be read.');
}

/** Checks the steps of an edit that came from a page, and puts their arrays into shape. Throws on anything that isn't one. */
export function readOps(raw: unknown): Op[] {
  if (!Array.isArray(raw)) {
    throw new Error('The edit is not a list of steps.');
  }
  return raw.map((item: { type?: unknown; rows?: unknown; table?: { text?: unknown; ends?: unknown; rowEnds?: unknown }; at?: unknown; widths?: unknown; map?: unknown }) => {
    const type = item?.type;
    if (type !== 'set' && type !== 'insert' && type !== 'delete') {
      throw new Error('The edit has a step of an unknown kind.');
    }
    const rows = typed(item.rows, Uint32Array);
    for (let k = 1; k < rows.length; k++) {
      if (rows[k] <= rows[k - 1]) {
        throw new Error('The rows of the edit are not in order.');
      }
    }
    const op: Op = { type, rows };
    if (type !== 'delete') {
      const table = { text: typed(item.table?.text, Uint8Array), ends: typed(item.table?.ends, Uint32Array), rowEnds: typed(item.table?.rowEnds, Uint32Array) };
      const cells = table.rowEnds.length ? table.rowEnds[table.rowEnds.length - 1] : 0;
      if (table.rowEnds.length !== rows.length || cells !== table.ends.length) {
        throw new Error('The rows of the edit do not match their cells.');
      }
      op.table = table;
    }
    if (type === 'set' && typeof item.at === 'number') {
      if (!Number.isInteger(item.at) || item.at < 0) {
        throw new Error('The edit names a column that is not there.');
      }
      op.at = item.at;
      if (item.widths !== undefined && item.widths !== null) {
        op.widths = typed(item.widths, Uint32Array);
        if (op.widths.length !== rows.length) {
          throw new Error('The rows of the edit do not match their cells.');
        }
      }
    }
    if (Array.isArray(item.map)) {
      op.map = item.map.map(Number);
    }
    return op;
  });
}

function unwire(table: WireTable): FlatTable {
  return { text: new TextDecoder().decode(table.text), ends: table.ends, rowEnds: table.rowEnds };
}

// ---- The edited table ------------------------------------------------------

/** A cell of an edited row: a cell of the file (by its number), a new text, or a new text that is written in quotes whether it needs them or not. */
type Ref = number | string | { quoted: string };

/** A row that isn't a row of the file as it stands. `base` is the row of the file it came from, or -1 for a new one. */
interface EditedRow {
  base: number;
  refs: Ref[];
}

/**
 * The table after the edits, as references into the file: a row is the number of an untouched
 * row, or a list of cells of which each is still a cell of the file or a new text. Which bytes can
 * be copied is decided here, cell by cell: a cell that is given the text it already has stays a
 * cell of the file.
 */
class Model {
  rows: (number | EditedRow)[];
  /** Where the raw text of every cell of the file begins. */
  private readonly rawStarts: Uint32Array;
  /** Every field of the file is in quotes, so new ones are written that way too. */
  private readonly allQuoted: boolean;

  /**
   * `pinned` says that the last field of the file can't be copied to any place but the very end:
   * it is a quoted field that is never closed, or it ends with half a UTF-16 character.
   */
  constructor(
    private readonly source: string,
    private readonly spans: SpanTable,
    private readonly delimiter: string,
    private readonly pinned: boolean,
  ) {
    const { rowEnds, rawEnds, lineEnds } = spans;
    this.rows = new Array<number>(rowEnds.length);
    this.rawStarts = new Uint32Array(rawEnds.length);
    let quoted = rawEnds.length > 0;
    for (let r = 0, i = 0; r < rowEnds.length; r++) {
      this.rows[r] = r;
      for (let first = true; i < rowEnds[r]; i++, first = false) {
        this.rawStarts[i] = first ? (r ? lineEnds[r - 1] : 0) : rawEnds[i - 1] + 1;
        quoted &&= source[this.rawStarts[i]] === '"';
      }
    }
    this.allQuoted = quoted;
  }

  private cell(i: number): string {
    return this.spans.text.slice(i ? this.spans.ends[i - 1] : 0, this.spans.ends[i]);
  }

  private textOf(ref: Ref): string {
    return typeof ref === 'number' ? this.cell(ref) : typeof ref === 'string' ? ref : ref.quoted;
  }

  private refsOf(row: number | EditedRow): Ref[] {
    if (typeof row !== 'number') {
      return row.refs;
    }
    const refs: number[] = [];
    for (let i = row ? this.spans.rowEnds[row - 1] : 0; i < this.spans.rowEnds[row]; i++) {
      refs.push(i);
    }
    return refs;
  }

  private wasQuoted(ref: Ref | undefined): boolean {
    return typeof ref === 'object' || (typeof ref === 'number' && this.source[this.rawStarts[ref]] === '"');
  }

  /**
   * A new text in the place of `before`, or a new cell without one. It is written in quotes when it
   * needs them, and also where that is the way of the file: when the field it replaces was quoted
   * without need, or when every field of the file is quoted.
   */
  private fresh(text: string, before: Ref | undefined): Ref {
    const styled = typeof before === 'object' || (typeof before === 'number' && this.wasQuoted(before) && field(this.cell(before), this.delimiter) === this.cell(before));
    return styled || this.allQuoted ? { quoted: text } : text;
  }

  apply(op: Op): void {
    const { rows } = op;
    if (op.type === 'delete') {
      let k = 0;
      this.rows = this.rows.filter((_, r) => !(k < rows.length && rows[k] === r && ++k));
      if (k !== rows.length) {
        throw new Error('The edit deletes a row that is not there.');
      }
      return;
    }
    const table = unwire(op.table as WireTable);
    const cells = (k: number): string[] => {
      const out: string[] = [];
      for (let i = k ? table.rowEnds[k - 1] : 0; i < table.rowEnds[k]; i++) {
        out.push(table.text.slice(i ? table.ends[i - 1] : 0, table.ends[i]));
      }
      return out;
    };
    if (op.type === 'insert') {
      const out = new Array<number | EditedRow>(this.rows.length + rows.length);
      let k = 0;
      let from = 0;
      for (let r = 0; r < out.length; r++) {
        out[r] = k < rows.length && rows[k] === r ? { base: -1, refs: cells(k++).map((text) => this.fresh(text, undefined)) } : this.rows[from++];
      }
      if (k !== rows.length) {
        throw new Error('The edit adds a row beyond the end of the table.');
      }
      this.rows = out;
      return;
    }
    for (let k = 0; k < rows.length; k++) {
      const row = this.rows[rows[k]];
      if (row === undefined) {
        throw new Error('The edit changes a row that is not there.');
      }
      const old = this.refsOf(row);
      const base = typeof row === 'number' ? row : row.base;
      const values = cells(k);
      const at = op.at ?? 0;
      /** How many cells of the row make way: all of them, as many as come, or the number the step names. */
      const width = op.at === undefined ? old.length : op.widths ? op.widths[k] : values.length;
      if (at + width > old.length) {
        throw new Error('The edit changes a cell that is not there.');
      }
      // Cells that come one for one are the old cells with new texts, and a cell that keeps its text keeps
      // its bytes. Where columns go in or out, what comes is new, and the cells around it are not touched.
      const next = values.map((text, c): Ref => {
        const before = op.widths ? undefined : old[at + c];
        return before !== undefined && this.textOf(before) === text ? before : this.fresh(text, before);
      });
      const refs = [...old.slice(0, at), ...next, ...old.slice(at + width)];
      this.rows[rows[k]] = this.untouched(base, refs) ? base : { base, refs };
    }
  }

  /** True when the cells are exactly those of the row of the file, which is then written as the line it is. */
  private untouched(base: number, refs: Ref[]): boolean {
    if (base < 0) {
      return false;
    }
    const first = base ? this.spans.rowEnds[base - 1] : 0;
    return refs.length === this.spans.rowEnds[base] - first && refs.every((ref, c) => ref === first + c);
  }

  /** The table as the page shows it, which is what a written file has to read back as. */
  table(): FlatTable {
    const { text, ends, rowEnds } = this.spans;
    let cells = 0;
    for (const row of this.rows) {
      cells += typeof row === 'number' ? rowEnds[row] - (row ? rowEnds[row - 1] : 0) : row.refs.length;
    }
    const outEnds = new Uint32Array(cells);
    const outRowEnds = new Uint32Array(this.rows.length);
    const parts: string[] = [];
    let length = 0;
    let o = 0;
    for (let q = 0; q < this.rows.length; ) {
      const row = this.rows[q];
      if (typeof row !== 'number') {
        for (const ref of row.refs) {
          const value = this.textOf(ref);
          parts.push(value);
          length += value.length;
          outEnds[o++] = length;
        }
        outRowEnds[q++] = o;
        continue;
      }
      // Untouched rows that follow each other in the file are taken over in one piece.
      let last = row;
      for (let next = q + 1; next < this.rows.length && this.rows[next] === last + 1; next++) {
        last++;
      }
      const ca = row ? rowEnds[row - 1] : 0;
      const cb = rowEnds[last];
      const ta = ca ? ends[ca - 1] : 0;
      const tb = cb ? ends[cb - 1] : 0;
      parts.push(text.slice(ta, tb));
      const shift = length - ta;
      for (let i = ca; i < cb; i++) {
        outEnds[o++] = ends[i] + shift;
      }
      for (let r = row; r <= last; r++) {
        outRowEnds[q++] = rowEnds[r] + o - cb;
      }
      length += tb - ta;
    }
    return { text: parts.join(''), ends: outEnds, rowEnds: outRowEnds };
  }

  /**
   * The file after the edits, as pieces: ranges of the text it was read from, which are copied
   * byte for byte, and new text in between.
   */
  pieces(delimiter: string, fallbackEol: string): Pieces {
    const { rowEnds, rawEnds, lineEnds } = this.spans;
    const out = new Pieces();
    const baseRows = rowEnds.length;
    const lastCell = rawEnds.length - 1;
    /** Where the line break of a row of the file begins; it ends at `lineEnds`. */
    const contentEnd = (r: number) => rawEnds[rowEnds[r] - 1];
    // A file that ends without a line break goes on ending without one. An empty file gets one.
    const finalBreak = !baseRows || lineEnds[baseRows - 1] > contentEnd(baseRows - 1);
    const eol = this.commonBreak() || fallbackEol;
    /** The line break written last was a lone carriage return, which would join a line feed right behind it. */
    let afterReturn = false;

    for (let q = 0; q < this.rows.length; q++) {
      const row = this.rows[q];
      const base = typeof row === 'number' ? row : row.base;
      /** Whether anything follows this row: another row, or the line break at the end of the file. */
      const followed = q < this.rows.length - 1 || finalBreak;
      const ownBreak = base >= 0 && lineEnds[base] > contentEnd(base);
      // A row written as nothing vanishes at the very end of a file, and between a lone carriage return
      // and a line feed it would make one line break of the two. A row of one empty cell is written as "" there.
      const bare = !followed || (afterReturn && (ownBreak ? this.source[contentEnd(base)] : eol) === '\n');
      // A quoted field that is never closed swallows whatever comes after it, so it is copied only where nothing does.
      const open = (ref: Ref) => this.pinned && ref === lastCell;
      if (typeof row === 'number' && !(followed && open(rowEnds[row] - 1))) {
        const start = row ? lineEnds[row - 1] : 0;
        out.range(start, contentEnd(row));
        if (contentEnd(row) === start && bare) {
          out.text('""');
        }
      } else {
        const refs = this.refsOf(row);
        let empty = true;
        refs.forEach((ref, c) => {
          if (c) {
            out.text(delimiter);
          }
          if (typeof ref === 'number' && !(open(ref) && (followed || c < refs.length - 1))) {
            out.range(this.rawStarts[ref], rawEnds[ref]);
            empty &&= this.rawStarts[ref] === rawEnds[ref];
          } else {
            const value = this.textOf(ref);
            const written = this.wasQuoted(ref) ? quote(value) : field(value, delimiter);
            out.text(written);
            empty &&= written === '';
          }
        });
        if (refs.length < 2 && empty && bare) {
          out.text('""');
        }
      }
      if (followed) {
        // Rows of the file keep the line break they have, also when the file mixes several kinds.
        if (ownBreak) {
          out.range(contentEnd(base), lineEnds[base]);
          afterReturn = lineEnds[base] - contentEnd(base) === 1 && this.source[contentEnd(base)] === '\r';
        } else {
          out.text(eol);
          afterReturn = eol === '\r';
        }
      }
    }
    return out;
  }

  /** The line break most rows of the file end with, or an empty string when it has none. */
  private commonBreak(): string {
    const { rowEnds, rawEnds, lineEnds } = this.spans;
    const counts = { '\r\n': 0, '\n': 0, '\r': 0 };
    for (let r = 0; r < rowEnds.length; r++) {
      const at = rawEnds[rowEnds[r] - 1];
      if (lineEnds[r] > at) {
        counts[lineEnds[r] - at === 2 ? '\r\n' : this.source[at] === '\n' ? '\n' : '\r']++;
      }
    }
    const [best, count] = Object.entries(counts).reduce((a, b) => (b[1] > a[1] ? b : a));
    return count ? best : '';
  }
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** A new field, quoted only when it has to be: when it holds the delimiter, a quote or a line break. */
function field(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? quote(value) : value;
}

/** Collects the pieces of a file. Ranges that touch become one, and so do texts. */
class Pieces {
  readonly list: (string | [number, number])[] = [];
  private pending: string[] = [];

  range(from: number, to: number): void {
    if (to <= from) {
      return;
    }
    this.flush();
    const last = this.list[this.list.length - 1];
    if (Array.isArray(last) && last[1] === from) {
      last[1] = to;
    } else {
      this.list.push([from, to]);
    }
  }

  text(value: string): void {
    if (value) {
      this.pending.push(value);
    }
  }

  flush(): this {
    if (this.pending.length) {
      this.list.push(this.pending.join(''));
      this.pending = [];
    }
    return this;
  }
}

// ---- Bytes -----------------------------------------------------------------

/** Windows-1252 as `TextDecoder` reads it, turned around, so that what is written reads back the same. */
let latin: Map<number, number> | undefined;
function latinMap(): Map<number, number> {
  if (!latin) {
    latin = new Map();
    const chars = textDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i));
    for (let i = 0; i < 256; i++) {
      latin.set(chars.charCodeAt(i), i);
    }
  }
  return latin;
}

/** Writes new text in the encoding of the file. Characters it has no place for are collected in `missing` instead of being written as something else. */
function encode(value: string, encoding: string, missing: Set<string>): Buffer {
  if (encoding === 'UTF-16 LE' || encoding === 'UTF-16 BE') {
    const bytes = Buffer.from(value, 'utf16le');
    return encoding === 'UTF-16 BE' ? bytes.swap16() : bytes;
  }
  if (encoding === 'Windows-1252') {
    const map = latinMap();
    const bytes = Buffer.alloc(value.length);
    for (let i = 0; i < value.length; i++) {
      const byte = map.get(value.charCodeAt(i));
      if (byte === undefined) {
        if (missing.size < 8) {
          missing.add(String.fromCodePoint(value.codePointAt(i) as number));
        }
        // The second half of a pair belongs to the character just named.
        i += value.charCodeAt(i) >= 0xd800 && value.charCodeAt(i) < 0xdc00 ? 1 : 0;
      } else {
        bytes[i] = byte;
      }
    }
    return bytes;
  }
  // Half a surrogate pair has no UTF-8 form; Buffer would write a replacement character in its place.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) {
    missing.add('�');
  }
  return Buffer.from(value, 'utf8');
}

/**
 * Returns the function that turns an offset in the decoded text into an offset in the bytes.
 * UTF-8 is walked with a cursor, since the pieces come in rising order.
 */
function byteOffsets(bytes: Uint8Array, text: string, encoding: string): (index: number) => number {
  if (encoding === 'Windows-1252') {
    return (index) => index;
  }
  if (encoding === 'UTF-16 LE' || encoding === 'UTF-16 BE') {
    // A file of an odd length ends with half a character, which the last offset has to cover.
    return (index) => Math.min(2 + index * 2, bytes.length - (index < text.length ? bytes.length % 2 : 0));
  }
  const mark = encoding === 'UTF-8 with BOM' ? 3 : 0;
  if (bytes.length - mark === text.length) {
    return (index) => mark + index;
  }
  let char = 0;
  let byte = mark;
  return (index) => {
    if (index < char) {
      char = 0;
      byte = mark;
    }
    for (; char < index; char++) {
      const code = text.charCodeAt(char);
      if (code < 0x80) {
        byte++;
      } else if (code < 0x800) {
        byte += 2;
      } else if (code >= 0xd800 && code < 0xdc00) {
        byte += 4;
        char++;
      } else {
        byte += 3;
      }
    }
    return byte;
  };
}

function modelOf(bytes: Uint8Array, text: string, encoding: string, delimiter: string): Model {
  const spans = parseCsvSpans(text, delimiter);
  return new Model(text, spans, delimiter, spans.unclosed || (encoding.startsWith('UTF-16') && bytes.length % 2 === 1));
}

function sameTable(a: FlatTable, b: FlatTable): boolean {
  const same = (x: Uint32Array, y: Uint32Array) => x.length === y.length && Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.byteLength), Buffer.from(y.buffer, y.byteOffset, y.byteLength)) === 0;
  return a.text === b.text && same(a.ends, b.ends) && same(a.rowEnds, b.rowEnds);
}

/** A file as `render` wrote it, and, when it was read back, the encoding and the delimiter a reader will find in it. */
export interface Rendered {
  bytes: Uint8Array;
  encoding?: string;
  detected?: string;
}

/**
 * The file `bytes` with the edits `ops` applied, in the encoding, with the delimiter, quoting and
 * line breaks it has: every field that was not changed is copied as the bytes it is. Throws
 * `Unencodable` when a new text doesn't fit the encoding, and never returns bytes that would not
 * read back as the edited table when `verify` is set.
 */
export function render(bytes: Uint8Array, ops: Op[], options: RenderOptions): Rendered {
  const { text, encoding } = decodeWithEncoding(bytes);
  const model = modelOf(bytes, text, encoding, options.delimiter);
  for (const op of ops) {
    model.apply(op);
  }
  const pieces = model.pieces(options.delimiter, options.eol ?? '\n').flush().list;
  const missing = new Set<string>();
  const chunks: Buffer[] = [];
  if (options.convert) {
    if (options.convert === 'UTF-8 with BOM') {
      chunks.push(Buffer.from([0xef, 0xbb, 0xbf]));
    }
    chunks.push(encode(pieces.map((piece) => (typeof piece === 'string' ? piece : text.slice(piece[0], piece[1]))).join(''), 'UTF-8', missing));
  } else {
    const at = byteOffsets(bytes, text, encoding);
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The byte order mark, which the decoder left out of the text.
    chunks.push(source.subarray(0, at(0)));
    for (const piece of pieces) {
      chunks.push(typeof piece === 'string' ? encode(piece, encoding, missing) : source.subarray(at(piece[0]), at(piece[1])));
    }
  }
  if (missing.size) {
    throw new Unencodable(encoding, [...missing]);
  }
  const out = Buffer.concat(chunks);
  if (!options.verify) {
    return { bytes: out };
  }
  const read = decodeWithEncoding(out);
  if (!sameTable(parseCsvFlat(read.text, options.delimiter), model.table())) {
    // Bytes that were not valid UTF-8 before can become so by an edit, and the file would then be read as UTF-8.
    if (!options.convert && read.encoding !== encoding) {
      throw new Unencodable(encoding, []);
    }
    throw new Error('The edited table could not be written so that it reads back the same. Nothing was written.');
  }
  return { bytes: out, encoding: read.encoding, detected: detectDelimiter(read.text) };
}

/**
 * The table a file holds after the edits, which is what a page is given. Without a `delimiter`
 * the one the file seems to use is taken, and `detected` is set.
 */
export function editedTable(bytes: Uint8Array, ops: Op[], delimiter: string): { table: FlatTable; encoding: string; delimiter: string; detected: boolean } {
  const { text, encoding } = decodeWithEncoding(bytes);
  const used = delimiter || detectDelimiter(text);
  const about = { encoding, delimiter: used, detected: !delimiter };
  if (!ops.length) {
    return { table: parseCsvFlat(text, used), ...about };
  }
  const model = modelOf(bytes, text, encoding, used);
  for (const op of ops) {
    model.apply(op);
  }
  return { table: model.table(), ...about };
}

/** The number of rows after the steps of an edit, for a table of `rows` rows. Throws when a step names a row that isn't there. */
export function rowsAfter(ops: Op[], rows: number): number {
  for (const op of ops) {
    const last = op.rows.length ? op.rows[op.rows.length - 1] : -1;
    rows += op.type === 'insert' ? op.rows.length : 0;
    if (last >= rows) {
      throw new Error('The edit names a row that is not there.');
    }
    rows -= op.type === 'delete' ? op.rows.length : 0;
  }
  return rows;
}

/** What tells one content of a file from another. */
export function fingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---- Backups ---------------------------------------------------------------

const BACKUP = 'Previewix table backup 1\n';

/**
 * A backup of unsaved edits: the file they were made to, and the edits themselves. The file comes
 * along because the one on disk may be another by the time the backup is needed. Behind a line
 * that names the format and a line of JSON with the sizes lie the file and the arrays of every step.
 */
export function packBackup(delimiter: string, bytes: Uint8Array, ops: Op[]): Uint8Array {
  const parts: Uint8Array[] = [bytes];
  const steps = ops.map((op) => {
    const arrays = { rows: op.rows, text: op.table?.text, ends: op.table?.ends, rowEnds: op.table?.rowEnds, widths: op.widths };
    const sizes: Record<string, number> = {};
    for (const [name, array] of Object.entries(arrays)) {
      if (array) {
        parts.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        sizes[name] = array.byteLength;
      }
    }
    return { type: op.type, at: op.at, map: op.map, sizes };
  });
  return Buffer.concat([Buffer.from(`${BACKUP}${JSON.stringify({ delimiter, size: bytes.length, steps })}\n`, 'utf8'), ...parts]);
}

export function unpackBackup(data: Uint8Array): { delimiter: string; bytes: Uint8Array; ops: Op[] } | undefined {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const end = buffer.indexOf(10, BACKUP.length);
  if (end < 0 || buffer.subarray(0, BACKUP.length).toString('utf8') !== BACKUP) {
    return undefined;
  }
  try {
    const head = JSON.parse(buffer.subarray(BACKUP.length, end).toString('utf8')) as { delimiter: string; size: number; steps: { type: Op['type']; at?: number; map?: number[]; sizes: Record<string, number> }[] };
    let at = end + 1;
    // Copies, so that the arrays of numbers start where such arrays may start.
    const take = (size: number) => {
      if (!Number.isInteger(size) || size < 0 || at + size > buffer.length) {
        throw new Error('cut');
      }
      const piece = new Uint8Array(buffer.subarray(at, at + size));
      at += size;
      return piece;
    };
    const bytes = take(head.size);
    const ops = head.steps.map((step) => {
      // In the order they were written.
      const arrays: Record<string, Uint8Array> = {};
      for (const [name, size] of Object.entries(step.sizes)) {
        arrays[name] = take(size);
      }
      const numbers = (name: string) => (arrays[name] ? new Uint32Array(arrays[name].buffer) : undefined);
      return { type: step.type, at: step.at, map: step.map, rows: numbers('rows'), widths: numbers('widths'), table: arrays.text ? { text: arrays.text, ends: numbers('ends'), rowEnds: numbers('rowEnds') } : undefined };
    });
    // The same checks as for an edit that comes from a page.
    return { delimiter: String(head.delimiter ?? ''), bytes, ops: readOps(ops) };
  } catch {
    return undefined;
  }
}

// ---- Worker ----------------------------------------------------------------

/** What `render` is given when it runs in a worker thread, and what comes back. */
export interface RenderJob {
  bytes: Uint8Array;
  ops: Op[];
  options: RenderOptions;
}

export interface RenderResult extends Partial<Rendered> {
  unencodable?: { encoding: string; chars: string[] };
}

export function runRender(job: RenderJob): RenderResult {
  try {
    return render(job.bytes, job.ops, job.options);
  } catch (e) {
    if (e instanceof Unencodable) {
      return { unencodable: { encoding: e.encoding, chars: e.chars } };
    }
    throw e;
  }
}

const job = isMainThread ? undefined : (workerData as { previewixCsv?: RenderJob } | null)?.previewixCsv;
if (job) {
  try {
    parentPort?.postMessage(runRender(job));
  } catch (e) {
    parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
}
