/** Reading and writing of delimited text (CSV, TSV). No vscode import, so it can be exercised outside VS Code. */

import { textDecoder } from './textDecoding';

const DELIMITERS = [',', ';', '\t', '|'];

/** Decodes a file: UTF-16 when it has that byte order mark, UTF-8 otherwise. The mark itself is dropped. */
export function decodeText(bytes: Uint8Array): string {
  return decodeWithEncoding(bytes).text;
}

/**
 * Decodes a file and names the encoding that was used. Bytes that aren't valid UTF-8 are read as
 * Windows-1252, which is what spreadsheet programs write when they don't write UTF-8.
 */
export function decodeWithEncoding(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16 LE' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16 BE' };
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: bom ? 'UTF-8 with BOM' : 'UTF-8' };
  } catch {
    return { text: textDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' };
  }
}

/**
 * Picks the delimiter that splits the first lines into the same number of fields, more than one.
 * Among several such delimiters the one giving the most fields wins.
 */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const rows = parseCsv(sample, delimiter, 20);
    // The last sampled row may be cut off in the middle.
    const counts = (rows.length > 1 && sample.length < text.length ? rows.slice(0, -1) : rows).map((row) => row.length);
    const fields = counts[0] ?? 0;
    const score = fields > 1 && counts.every((count) => count === fields) ? fields + 1000 : fields > 1 ? Math.min(...counts) : 0;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Parses delimited text into rows of fields. Quoted fields may hold the delimiter, line breaks
 * and doubled quotes. A trailing line break doesn't produce an empty last row.
 */
export function parseCsv(text: string, delimiter = ',', maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  scanCsv(
    text,
    delimiter,
    maxRows,
    (field) => row.push(field),
    () => {
      rows.push(row);
      row = [];
    },
  );
  return rows;
}

/**
 * A table as one string and two indexes, which is how a large one is kept and handed to a webview:
 * millions of separate strings would cost several times the memory and the transfer time.
 * Cell `i` is `text.slice(ends[i - 1] ?? 0, ends[i])`, and row `r` holds the cells from
 * `rowEnds[r - 1] ?? 0` up to `rowEnds[r]`, so rows may differ in length.
 */
export interface FlatTable {
  text: string;
  ends: Uint32Array;
  rowEnds: Uint32Array;
}

/** Collects cells and rows into a `FlatTable`. */
export class FlatBuilder {
  private chunks: string[] = [];
  private parts: string[] = [];
  private length = 0;
  private ends: Uint32Array = new Uint32Array(1024);
  private cells = 0;
  private rowEnds: Uint32Array = new Uint32Array(256);
  private rows = 0;

  /** Length of the text collected so far. */
  get chars(): number {
    return this.length;
  }

  cell(value: string): void {
    if (value !== '') {
      this.parts.push(value);
      this.length += value.length;
      // Joined in portions, so that the list of pieces never grows to millions of entries.
      if (this.parts.length === 8192) {
        this.chunks.push(this.parts.join(''));
        this.parts = [];
      }
    }
    if (this.cells === this.ends.length) {
      this.ends = grow(this.ends);
    }
    this.ends[this.cells++] = this.length;
  }

  endRow(): void {
    if (this.rows === this.rowEnds.length) {
      this.rowEnds = grow(this.rowEnds);
    }
    this.rowEnds[this.rows++] = this.cells;
  }

  finish(): FlatTable {
    this.chunks.push(this.parts.join(''));
    return { text: this.chunks.join(''), ends: this.ends.slice(0, this.cells), rowEnds: this.rowEnds.slice(0, this.rows) };
  }
}

function grow(array: Uint32Array): Uint32Array {
  const bigger = new Uint32Array(array.length * 2);
  bigger.set(array);
  return bigger;
}

/** `parseCsv` with a `FlatTable` as the result. */
export function parseCsvFlat(text: string, delimiter = ','): FlatTable {
  const builder = new FlatBuilder();
  scanCsv(
    text,
    delimiter,
    Infinity,
    (field) => builder.cell(field),
    () => builder.endRow(),
  );
  return builder.finish();
}

/**
 * A table together with the place of every field in the text it was parsed from. The raw text of
 * a field (quotes and all) starts behind the delimiter of the field before it, or where the line
 * before it ends, and runs to `rawEnds`; a row's line break lies between the end of its last
 * field and `lineEnds`.
 */
export interface SpanTable extends FlatTable {
  rawEnds: Uint32Array;
  lineEnds: Uint32Array;
  /** The last field is a quoted one that is never closed, so it can only stand at the very end of a file. */
  unclosed: boolean;
}

/** `parseCsvFlat` that also says where in the text every field and row was found. */
export function parseCsvSpans(text: string, delimiter = ','): SpanTable {
  const builder = new FlatBuilder();
  let rawEnds: Uint32Array = new Uint32Array(1024);
  let cells = 0;
  let lineEnds: Uint32Array = new Uint32Array(256);
  let rows = 0;
  const unclosed = scanCsv(
    text,
    delimiter,
    Infinity,
    (field, rawEnd) => {
      builder.cell(field);
      if (cells === rawEnds.length) {
        rawEnds = grow(rawEnds);
      }
      rawEnds[cells++] = rawEnd;
    },
    (lineEnd) => {
      builder.endRow();
      if (rows === lineEnds.length) {
        lineEnds = grow(lineEnds);
      }
      lineEnds[rows++] = lineEnd;
    },
  );
  return { ...builder.finish(), rawEnds: rawEnds.slice(0, cells), lineEnds: lineEnds.slice(0, rows), unclosed };
}

/** The rows of a `FlatTable` as arrays of fields. */
export function flatRows(table: FlatTable): string[][] {
  const rows: string[][] = [];
  let cell = 0;
  for (const rowEnd of table.rowEnds) {
    const row: string[] = [];
    for (; cell < rowEnd; cell++) {
      row.push(table.text.slice(cell ? table.ends[cell - 1] : 0, table.ends[cell]));
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The scanner behind every parser here. `onField` also gets the offset at which the field's raw
 * text ends (at its delimiter, its line break or the end of the text), and `onRow` the offset
 * behind the row's line break, which is what the editor needs to copy untouched fields as they
 * are. Returns true when the text ends inside a quoted field.
 */
function scanCsv(text: string, delimiter: string, maxRows: number, onField: (field: string, rawEnd: number) => void, onRow: (lineEnd: number) => void): boolean {
  let rows = 0;
  let fields = 0;
  let field = '';
  // An empty quoted field is still a field, which matters on a last line without a line break.
  let quoted = false;
  let unclosed = false;
  let i = 0;
  const length = text.length;
  while (i < length && rows < maxRows) {
    const ch = text[i];
    if (ch === '"' && field === '' && !quoted) {
      // A quoted field runs to the closing quote; "" inside it is a literal quote.
      quoted = true;
      i++;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close < 0) {
          field += text.slice(i);
          i = length;
          unclosed = true;
          break;
        }
        field += text.slice(i, close);
        i = close + 1;
        if (text[i] !== '"') {
          break;
        }
        field += '"';
        i++;
      }
      // Anything between the closing quote and the delimiter is kept as written.
      continue;
    }
    if (ch === delimiter) {
      onField(field, i);
      fields++;
      field = '';
      quoted = false;
      i++;
    } else if (ch === '\n' || ch === '\r') {
      onField(field, i);
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      onRow(i);
      rows++;
      fields = 0;
      field = '';
      quoted = false;
    } else {
      const next = nextSpecial(text, i, delimiter);
      field += text.slice(i, next);
      i = next;
    }
  }
  if ((field !== '' || fields || quoted) && rows < maxRows) {
    onField(field, length);
    onRow(length);
  }
  return unclosed;
}

function nextSpecial(text: string, from: number, delimiter: string): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === delimiter || ch === '\n' || ch === '\r') {
      return i;
    }
  }
  return text.length;
}

/** Writes one field, quoted only when it has to be. */
export function csvField(value: string, delimiter = ','): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvLine(fields: string[], delimiter = ','): string {
  return fields.map((field) => csvField(field, delimiter)).join(delimiter);
}

export function toCsv(rows: string[][], delimiter = ','): string {
  return rows.map((row) => csvLine(row, delimiter)).join('\r\n') + '\r\n';
}
