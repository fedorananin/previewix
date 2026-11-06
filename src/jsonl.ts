/**
 * Reading of JSON Lines (one JSON value per line) into a flat table. No vscode import, so it can
 * be exercised outside VS Code.
 *
 * Bundled as a file of its own, this module is also a worker thread entry: started with
 * `workerData.previewixJsonLines`, it decodes and parses the bytes passed along and posts the result.
 */
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { decodeWithEncoding, FlatBuilder, type FlatTable } from './csv';

/** This many broken lines are named; the rest are only counted. */
const MAX_REPORTED = 20;

export interface BrokenLine {
  /** Line of the file, counted from 1. */
  line: number;
  message: string;
}

export interface JsonLines {
  /** The keys of the objects, in order of first appearance. */
  names: string[];
  /** One row per line that holds a value. Rows end at their last value, so a row may be shorter than `names`. */
  table: FlatTable;
  /** The line of the file behind every row, counted from 1. Left out when row `r` is simply line `r + 1`. */
  lines?: Uint32Array;
  /** Lines that aren't valid JSON, which are left out of the table: how many, and the first of them. */
  broken: number;
  firstBroken: BrokenLine[];
}

interface RawJson {
  rawJSON: string;
}

/** `JSON.parse` with access to the source text, and a value that is written back as that text (V8 11.4 and later). */
const json = JSON as unknown as {
  parse(text: string, reviver?: (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown): unknown;
  rawJSON?(text: string): RawJson;
  isRawJSON?(value: unknown): value is RawJson;
};

/** An integer too long for a double keeps its digits: IDs of 64 bits are common, and rounding one makes another ID of it. */
function keepLongIntegers(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source) ? json.rawJSON!(context.source) : value;
}

function parseLine(source: string): unknown {
  // The slower way is taken only by a line that has such a number in it.
  return json.rawJSON && /\d{16}/.test(source) ? json.parse(source, keepLongIntegers) : json.parse(source);
}

/** A key that an object lists ahead of the others, whatever the order they were written in: a whole number, as an index of an array is. */
const INDEX_KEY = /^(0|[1-9]\d{0,9})$/;
// The first character settles nearly every key without the pattern.
const isIndex = (name: string) => name.charCodeAt(0) >= 0x30 && name.charCodeAt(0) <= 0x39 && INDEX_KEY.test(name);

/**
 * The keys of the object that a line holds, in the order they are written. `JSON.parse` keeps that
 * order except for keys that look like whole numbers, which come first and sorted. The line is
 * known to be valid JSON, so this only has to tell keys from the rest: a text right after the
 * opening brace or a comma of the outermost object.
 */
function writtenKeys(source: string): string[] {
  const keys = new Set<string>();
  let depth = 0;
  let key = false;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === 0x22) {
      const start = i;
      for (i++; source.charCodeAt(i) !== 0x22; i++) {
        // A backslash takes the next character along, which may be a quote.
        if (source.charCodeAt(i) === 0x5c) {
          i++;
        }
      }
      if (key && depth === 1) {
        keys.add(JSON.parse(source.slice(start, i + 1)) as string);
        key = false;
      }
    } else if (code === 0x7b || code === 0x5b) {
      key = ++depth === 1;
    } else if (code === 0x7d || code === 0x5d) {
      depth--;
    } else if (code === 0x2c && depth === 1) {
      key = true;
    }
  }
  return [...keys];
}

/** A value as the text of a cell: a string as it is, null as nothing, an object or an array as compact JSON. */
function cellText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return json.isRawJSON?.(value) ? value.rawJSON : JSON.stringify(value);
}

/**
 * Parses JSON Lines. An object gives its values to the columns named by its keys; an array, to the
 * columns `1`, `2`, …; any other value goes to a column called `value`. Empty lines are skipped.
 */
export function parseJsonLines(text: string): JsonLines {
  const builder = new FlatBuilder();
  const columns = new Map<string, number>();
  const names: string[] = [];
  const column = (name: string): number => {
    let c = columns.get(name);
    if (c === undefined) {
      c = names.length;
      columns.set(name, c);
      names.push(name);
    }
    return c;
  };

  let lines = new Uint32Array(1024);
  let rows = 0;
  let line = 0;
  let broken = 0;
  const firstBroken: BrokenLine[] = [];
  /** The cells of the row being read, by column. */
  const row: string[] = [];
  let last = -1;
  const put = (c: number, value: unknown) => {
    const cell = cellText(value);
    row[c] = cell;
    if (cell !== '' && c > last) {
      last = c;
    }
  };

  const length = text.length;
  for (let pos = 0; pos < length; ) {
    let end = text.indexOf('\n', pos);
    if (end < 0) {
      end = length;
    }
    line++;
    const source = text.slice(pos, end);
    pos = end + 1;
    // Covers the empty line, the one of spaces and the carriage return of a Windows line end.
    if (!(source.charCodeAt(0) > 32) && source.trim() === '') {
      continue;
    }

    let value: unknown;
    try {
      value = parseLine(source);
    } catch (e) {
      broken++;
      if (firstBroken.length < MAX_REPORTED) {
        firstBroken.push({ line, message: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }

    last = -1;
    if (Array.isArray(value)) {
      value.forEach((item, index) => put(column(String(index + 1)), item));
    } else if (value !== null && typeof value === 'object' && !json.isRawJSON?.(value)) {
      const keys = Object.keys(value);
      // Only an object with such a key can have lost the order of its keys.
      for (const key of keys.length > 1 && keys.some(isIndex) ? writtenKeys(source) : keys) {
        put(column(key), (value as Record<string, unknown>)[key]);
      }
    } else {
      put(column('value'), value);
    }
    for (let c = 0; c <= last; c++) {
      builder.cell(row[c] ?? '');
    }
    builder.endRow();
    row.length = 0;

    if (rows === lines.length) {
      const bigger = new Uint32Array(lines.length * 2);
      bigger.set(lines);
      lines = bigger;
    }
    lines[rows++] = line;
  }

  // Row r is line r + 1 unless a line was skipped somewhere before the last row.
  const skipped = rows > 0 && lines[rows - 1] !== rows;
  return { names, table: builder.finish(), lines: skipped ? lines.slice(0, rows) : undefined, broken, firstBroken };
}

/** A file as it comes from disk: decoded like delimited text (UTF-8, UTF-16 by its mark, or Windows-1252), then parsed. */
export function readJsonLines(bytes: Uint8Array): JsonLines & { encoding: string } {
  const { text, encoding } = decodeWithEncoding(bytes);
  return { ...parseJsonLines(text), encoding };
}

if (!isMainThread && workerData?.previewixJsonLines) {
  try {
    const read = readJsonLines(workerData.previewixJsonLines as Uint8Array);
    parentPort?.postMessage({ read }, [read.table.ends.buffer, read.table.rowEnds.buffer, ...(read.lines ? [read.lines.buffer] : [])] as ArrayBuffer[]);
  } catch (e) {
    parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
}
