import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { csvField, detectDelimiter } from './csv';
import { textDecoder, type Decoder } from './textDecoding';

/** A value on its way to the webview. Long texts and blobs are cut down to a preview. */
export type Wire = null | number | string | { int: string } | { text: string; more: true } | { blob: number; hex: string };

/** A value coming back: a row key echoed as it was sent, or a new cell value (`num` is a number as it was typed). */
export type Input = null | number | string | { int: string } | { hex: string } | { num: string };

export interface Column {
  name: string;
  type: string;
  notnull: boolean;
  pk: number;
  dflt: string | null;
  generated: boolean;
  affinity: 'text' | 'numeric' | 'none';
}

/** A foreign key of a table, with both sides under the names the columns really have. */
export interface ForeignKey {
  /** The columns of the table itself, and the columns of `table` they refer to, in the same order. */
  columns: string[];
  table: string;
  to: string[];
  onUpdate: string;
  onDelete: string;
  /** Why the key leads nowhere, when it does: the table is missing, or the columns it refers to can't be told. */
  broken: string;
}

export interface Table {
  name: string;
  type: 'table' | 'view' | 'virtual';
  columns: Column[];
  foreignKeys: ForeignKey[];
  /** SQL expressions that identify a row, or null when rows can't be addressed (views, virtual tables). */
  key: string[] | null;
  /** CREATE statements of the table and of its indexes and triggers. */
  sql: string[];
}

export interface Schema {
  size: number;
  tables: Table[];
}

export interface Row {
  key: (Wire | { hex: string })[] | null;
  cells: Wire[];
}

/** The rows whose `columns` hold `values`: where following a foreign key leads. */
export interface Match {
  columns: string[];
  values: Input[];
}

export interface RowsOptions {
  offset: number;
  limit: number;
  sort: { column: string; desc: boolean } | null;
  filter: string;
  match?: Match | null;
}

/** What says which rows of a table are meant, and in which order. */
type Scope = Pick<RowsOptions, 'sort' | 'filter' | 'match'>;

export type Change =
  | { table: string; kind: 'update'; key: Input[]; values: [string, Input][] }
  | { table: string; kind: 'insert'; values: [string, Input][] }
  | { table: string; kind: 'delete'; key: Input[] };

/**
 * A result of the SQL prompt, as the way to get it again: the rows of statement number `index` of
 * the script `sql`, after the statements in front of it have run.
 */
export interface ResultSource {
  sql: string;
  index: number;
}

/** The rows an export writes: a table as the grid shows it, or the result of a statement. */
export type RowSource = ({ table: string } & Scope) | ResultSource;

/**
 * Where a blob is: in a row with a key, in a row that has none (a view) by its position in the
 * sorted and filtered table, or in the result of a statement by row and column number.
 */
export type BlobSource =
  | { table: string; key: Input[]; column: string }
  | ({ table: string; offset: number; column: string } & Scope)
  | (ResultSource & { row: number; column: number });

/** The link of a long request to the editor: progress out, cancellation in. */
export interface Job {
  /** `total` is 0 when it isn't known. */
  progress(done: number, total: number): void;
  cancelled(): boolean;
}

export interface CsvPreview {
  size: number;
  delimiter: string;
  header: boolean;
  /** Column names: the header row, or "column_1" and so on. */
  names: string[];
  /** A type for each column that fits every sampled value: INTEGER, REAL, BLOB or TEXT. */
  types: string[];
  /** The first data rows, with long fields cut. */
  rows: string[][];
  /** Data rows the types were inferred from, and whether that was the whole file. */
  sampled: number;
  complete: boolean;
}

export interface ImportOptions {
  delimiter: string;
  header: boolean;
  /** Import an empty field as an empty text where the column takes one, instead of NULL. */
  emptyText: boolean;
  table: string;
  /** Create `table` first, with the names and types in `columns`. */
  create: boolean;
  /** One entry per CSV column: the table column it goes to, or null to leave it out. */
  columns: ({ name: string; type?: string } | null)[];
}

/** What became of one statement of a script. */
export interface Outcome {
  /** The beginning of the statement. */
  sql: string;
  /** Rows it returned, counted up to the limit of what is shown, or null when it returns none. */
  rows: number | null;
  truncated: boolean;
  /** Rows it changed, or null when it is not a statement that changes rows. */
  changes: number | null;
  ms: number;
}

export interface QueryResult {
  /** The statements that ran, in order. */
  statements: Outcome[];
  /** The last result set of the script, and the number of the statement it came from (-1 when there is none). */
  shown: number;
  columns: string[];
  rows: Wire[][];
  truncated: boolean;
  /** How an export, or a blob of the result, gets these rows again. Null when that would mean writing a second time. */
  source: ResultSource | null;
  /** The statement that failed, which is where the script stopped. */
  error: { index: number; message: string; sql: string } | null;
  /** Whether the script had to open the file for writing, so anything on screen may be out of date. */
  wrote: boolean;
  /** The statement in which the script began a transaction it never ended, which was rolled back with it; -1 when there is none. */
  rolledBack: number;
  ms: number;
}

const GRID_TEXT = 300;
const QUERY_TEXT = 2000;
const QUERY_ROWS = 1000;
const BLOB_PREVIEW = 16;
const SQLITE_READONLY = 8;
/** How much of a statement is sent back to say which one it was. */
const STATEMENT_TEXT = 300;
/** How much of a script SQLite is handed at first to find one statement in. */
const SCRIPT_WINDOW = 16 * 1024;
/** The largest blob that is handed to the page in full, to be shown as a picture. */
const BLOB_MAX = 16 * 1024 * 1024;
/** How much of any other blob the page gets for its hex view. */
const BLOB_VIEW = 4096;
const CSV_CHUNK = 1024 * 1024;
/** How much of a CSV file is read to show it and to infer the column types. */
const PREVIEW_BYTES = 4 * 1024 * 1024;
const PREVIEW_ROWS = 50;
const PREVIEW_TEXT = 200;
const NEW_TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB'];

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** A blob as SQL writes it, which is how the CSV export writes one too. */
const BLOB_LITERAL = /^[xX]'((?:[0-9a-fA-F]{2})*)'$/;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function withDb<T>(file: string, readOnly: boolean, work: (db: DatabaseSync) => T): T {
  // A writable open would silently create a database in place of a file that is gone.
  if (!fs.existsSync(file)) {
    throw new Error('The file no longer exists.');
  }
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    return work(db);
  } finally {
    db.close();
  }
}

function toWire(value: unknown, textLimit: number, blobLength?: number): Wire {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : { int: value.toString() };
  }
  if (typeof value === 'number') {
    // Infinity and NaN don't survive the JSON trip to the webview.
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'string') {
    return value.length > textLimit ? { text: value.slice(0, textLimit), more: true } : value;
  }
  const bytes = value as Uint8Array;
  return { blob: blobLength ?? bytes.length, hex: Buffer.from(bytes.subarray(0, BLOB_PREVIEW)).toString('hex') };
}

/** Row keys travel in full, because they have to find the row again. */
function keyToWire(value: unknown): Wire | { hex: string } {
  return value instanceof Uint8Array ? { hex: Buffer.from(value).toString('hex') } : toWire(value, Infinity);
}

function toSql(value: Input): SQLInputValue {
  if (value === null || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    // A JS number is bound as a float, which would turn 5 into 5.0 in a column without a type.
    return Number.isSafeInteger(value) ? BigInt(value) : value;
  }
  if ('int' in value) {
    return BigInt(value.int);
  }
  if ('hex' in value) {
    return Buffer.from(value.hex, 'hex');
  }
  if (/^[+-]?\d+$/.test(value.num)) {
    const int = BigInt(value.num);
    if (int >= -(2n ** 63n) && int < 2n ** 63n) {
      return int;
    }
  }
  return Number(value.num);
}

/**
 * Column affinity as SQLite derives it from the declared type. ANY is no type of its own there, and so a
 * numeric one like every unknown word; in a STRICT table it is the type that stores a value as it is given.
 */
function affinity(type: string, strict: boolean): Column['affinity'] {
  if (strict && /^any$/i.test(type)) {
    return 'none';
  }
  if (/INT/i.test(type)) {
    return 'numeric';
  }
  if (/CHAR|CLOB|TEXT/i.test(type)) {
    return 'text';
  }
  return !type || /BLOB/i.test(type) ? 'none' : 'numeric';
}

/** SQLite compares names without regard to the case of ASCII letters. */
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function foreignKeys(db: DatabaseSync, name: string, columns: Column[]): ForeignKey[] {
  const list = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as unknown as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }[];
  const keys = new Map<number, { key: ForeignKey; to: (string | null)[] }>();
  // The keys are numbered from the last one declared to the first.
  for (const row of list.sort((a, b) => b.id - a.id || a.seq - b.seq)) {
    let entry = keys.get(row.id);
    if (!entry) {
      entry = { key: { columns: [], table: row.table, to: [], onUpdate: row.on_update, onDelete: row.on_delete, broken: '' }, to: [] };
      keys.set(row.id, entry);
    }
    entry.key.columns.push(columns.find((c) => sameName(c.name, row.from))?.name ?? row.from);
    entry.to.push(row.to);
  }
  return [...keys.values()].map(({ key, to }) => {
    const parent = db.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type <> 'view' AND name = ? COLLATE NOCASE").get(key.table) as { name: string } | undefined;
    if (!parent) {
      return { ...key, to: to.map((name) => name ?? ''), broken: `There is no table "${key.table}".` };
    }
    const info = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(parent.name) as unknown as { name: string; pk: number }[];
    // A key that names no columns means the primary key of the other table.
    const primary = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
    const named = to.every((column) => column !== null);
    let broken = '';
    if (!named && primary.length !== to.length) {
      broken = `"${parent.name}" has no primary key of ${to.length === 1 ? 'one column' : `${to.length} columns`} to refer to.`;
    }
    const resolved = to.map((column, i) => {
      const found = named ? info.find((c) => sameName(c.name, column as string)) : primary[i];
      if (!found && !broken) {
        broken = `"${parent.name}" has no column "${column}".`;
      }
      return found?.name ?? column ?? '';
    });
    return { ...key, table: parent.name, to: resolved, broken };
  });
}

function describe(db: DatabaseSync, name: string, type: string, withoutRowid: boolean, strict: boolean): Table {
  const info = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all() as unknown as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
  }[];
  const columns = info
    // 1 marks the hidden columns of a virtual table; 2 and 3 are generated columns.
    .filter((c) => c.hidden !== 1)
    .map<Column>((c) => ({
      name: c.name,
      type: c.type,
      notnull: !!c.notnull,
      pk: c.pk,
      dflt: c.dflt_value,
      generated: c.hidden > 1,
      affinity: affinity(c.type, strict),
    }));

  let key: string[] | null = null;
  if (type === 'table' || type === 'shadow') {
    if (withoutRowid) {
      key = columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => quote(c.name));
    } else {
      // A column may be named like the rowid, and then that name means the column.
      const taken = new Set(columns.map((c) => c.name.toLowerCase()));
      const alias = ['rowid', '_rowid_', 'oid'].find((a) => !taken.has(a));
      key = alias ? [alias] : null;
    }
  }
  const sql = db.prepare('SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type <> ?, type, name').all(name, type === 'view' ? 'view' : 'table') as unknown as { sql: string }[];
  return {
    name,
    type: type === 'view' ? 'view' : type === 'virtual' ? 'virtual' : 'table',
    columns,
    foreignKeys: foreignKeys(db, name, columns),
    key: key?.length ? key : null,
    sql: sql.map((s) => s.sql),
  };
}

function listTables(db: DatabaseSync): Table[] {
  const list = db
    .prepare("SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name <> 'sqlite_schema' ORDER BY type = 'view', name COLLATE NOCASE")
    .all() as unknown as { name: string; type: string; wr: number; strict: number }[];
  return list.map((t) => describe(db, t.name, t.type, !!t.wr, !!t.strict));
}

function findTable(db: DatabaseSync, name: string): Table {
  const found = db.prepare("SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(name) as unknown as
    | { name: string; type: string; wr: number; strict: number }
    | undefined;
  if (!found) {
    throw new Error(`There is no table "${name}" any more.`);
  }
  return describe(db, found.name, found.type, !!found.wr, !!found.strict);
}

/** The filter, the followed key and the sort of the grid as SQL, shared by everything that has to see the same rows in the same order. */
function scope(table: Table, options: Scope): { where: string; order: string; params: SQLInputValue[] } {
  const filter = options.filter.trim();
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter) {
    // One plain "?" per column, each with the pattern again: Node.js 22.17 to 22.19 (VS Code 1.103 and
    // some after it) answer "column index out of range" to a numbered "?1".
    const pattern = `%${filter.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(${table.columns.map((c) => `${quote(c.name)} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...table.columns.map(() => pattern));
  }
  const match = options.match;
  if (match) {
    if (!match.columns.length || match.columns.length !== match.values.length) {
      throw new Error('The reference could not be followed.');
    }
    match.columns.forEach((name, i) => {
      const column = table.columns.find((c) => sameName(c.name, name));
      if (!column) {
        throw new Error(`There is no column "${name}" in "${table.name}" any more.`);
      }
      // The value is compared the way the column compares, which is how SQLite matches a key to the row it refers to.
      params.push(toSql(match.values[i]));
      conditions.push(`${quote(column.name)} = ?`);
    });
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sorted = options.sort && table.columns.some((c) => c.name === options.sort?.column);
  const order = options.sort && sorted ? ` ORDER BY ${quote(options.sort.column)} ${options.sort.desc ? 'DESC' : 'ASC'}` : '';
  return { where, order, params };
}

export function schema(file: string): Schema {
  return withDb(file, true, (db) => ({ size: fs.statSync(file).size, tables: listTables(db) }));
}

export function count(file: string, table: string): number {
  return withDb(file, true, (db) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n));
}

/**
 * The first `length` bytes of a blob, as SQL. substr() alone answers NULL for a blob of no bytes, which made
 * an empty blob look like no value at all.
 */
const blobHead = (q: string, length: number) => `ifnull(substr(${q}, 1, ${length}), x'')`;

export function rows(file: string, name: string, options: RowsOptions): { table: Table; rows: Row[]; total: number } {
  return withDb(file, true, (db) => {
    const table = findTable(db, name);
    const from = quote(table.name);
    const keys = table.key ?? [];

    // Big values are cut down by SQLite itself, so a page of large blobs never has to be loaded.
    const select = [
      ...keys.map((k, i) => `${k} AS k${i}`),
      ...table.columns.flatMap((c, i) => {
        const q = quote(c.name);
        return [
          `CASE typeof(${q}) WHEN 'blob' THEN ${blobHead(q, BLOB_PREVIEW)} WHEN 'text' THEN substr(${q}, 1, ${GRID_TEXT + 1}) ELSE ${q} END AS c${i}`,
          `CASE WHEN typeof(${q}) = 'blob' THEN length(${q}) END AS b${i}`,
        ];
      }),
    ];

    const { where, order, params } = scope(table, options);
    const limit = Math.max(1, Math.min(5000, Math.floor(options.limit)));
    const offset = Math.max(0, Math.floor(options.offset));

    const stmt = db.prepare(`SELECT ${select.join(', ')} FROM ${from}${where}${order} LIMIT ${limit} OFFSET ${offset}`);
    stmt.setReadBigInts(true);
    const result = (stmt.all(...params) as Record<string, unknown>[]).map<Row>((row) => ({
      key: table.key && keys.map((_, i) => keyToWire(row[`k${i}`])),
      cells: table.columns.map((_, i) => toWire(row[`c${i}`], GRID_TEXT, row[`b${i}`] === null ? undefined : Number(row[`b${i}`]))),
    }));
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${from}${where}`).get(...params) as { n: number }).n);
    return { table, rows: result, total };
  });
}

const whereKey = (table: Table) => (table.key ?? []).map((k) => `${k} = ?`).join(' AND ');

/** The complete value of one cell, for editing a text the grid only shows the beginning of. */
export function cell(file: string, name: string, key: Input[], column: string): Wire {
  return withDb(file, true, (db) => {
    const table = findTable(db, name);
    if (!table.key || !table.columns.some((c) => c.name === column)) {
      throw new Error('The value could not be found.');
    }
    const stmt = db.prepare(`SELECT ${quote(column)} AS v FROM ${quote(table.name)} WHERE ${whereKey(table)}`);
    stmt.setReadBigInts(true);
    const row = stmt.get(...key.map(toSql)) as { v: unknown } | undefined;
    if (!row) {
      throw new Error('The row no longer exists.');
    }
    return toWire(row.v, Infinity);
  });
}

function apply(db: DatabaseSync, change: Change, tables: Map<string, Table>): void {
  let table = tables.get(change.table);
  if (!table) {
    table = findTable(db, change.table);
    tables.set(change.table, table);
  }
  const from = quote(table.name);
  if (change.kind === 'insert') {
    const names = change.values.map(([name]) => quote(name));
    const sql = names.length
      ? `INSERT INTO ${from} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
      : `INSERT INTO ${from} DEFAULT VALUES`;
    db.prepare(sql).run(...change.values.map(([, value]) => toSql(value)));
    return;
  }
  if (!table.key || change.key.length !== table.key.length) {
    throw new Error(`The rows of "${table.name}" can't be edited.`);
  }
  const key = change.key.map(toSql);
  const result =
    change.kind === 'delete'
      ? db.prepare(`DELETE FROM ${from} WHERE ${whereKey(table)}`).run(...key)
      : db
          .prepare(`UPDATE ${from} SET ${change.values.map(([name]) => `${quote(name)} = ?`).join(', ')} WHERE ${whereKey(table)}`)
          .run(...change.values.map(([, value]) => toSql(value)), ...key);
  if (Number(result.changes) !== 1) {
    throw new Error(`A row of "${table.name}" no longer exists. Refresh and try again.`);
  }
}

/** Applies all changes in one transaction: either every one of them is written, or none. */
export function save(file: string, changes: Change[]): void {
  withDb(file, false, (db) => {
    const tables = new Map<string, Table>();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const change of changes) {
        apply(db, change, tables);
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite has already rolled back on its own.
      }
      throw e;
    }
  });
}

// ---- SQL prompt -------------------------------------------------------------

/**
 * Where the next statement of a script begins: past everything that may stand between two
 * statements, which is blank space, comments and empty statements. No string or quoted name can
 * be open there, so this needs no knowledge of SQL beyond the two kinds of comment.
 */
function skipBlank(sql: string, from: number): number {
  let i = from;
  for (;;) {
    const ch = sql[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === ';' || ch === '﻿') {
      i++;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else {
      return i;
    }
  }
}

/**
 * Takes a script apart the way SQLite reads it. SQLite is handed the text from where the last
 * statement ended, compiles the first statement it finds there, and says how much of the text that
 * was. So strings, quoted names, comments and the body of a trigger are told apart by SQLite's own
 * parser. A statement can only be compiled once the ones before it have run, since it may use what
 * they made.
 */
class Script {
  /** Number of the statement taken last, the offset at which it begins and its text. */
  index = -1;
  start = 0;
  text = '';
  /** The offset right behind it. */
  end = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  /** Compiles the next statement, or returns null at the end of the script. */
  next(): StatementSync | null {
    const { sql } = this;
    const start = skipBlank(sql, this.end);
    if (start >= sql.length) {
      return null;
    }
    this.index++;
    this.start = start;
    // A statement that can't be compiled has no end that anyone knows; its first line is what an error names it by.
    this.text = sql.slice(start, start + STATEMENT_TEXT).split('\n', 1)[0];
    this.end = sql.length;
    if (sql[start] === '\0') {
      throw new Error('There is a NUL character here, and SQLite reads no further.');
    }
    // A long script is not handed over whole for every statement in it. A statement that SQLite
    // ends before the end of a piece is the one it would have found in the whole text; anything
    // else (the piece used up, an error that may come from the cut) is tried again with more.
    for (let size = SCRIPT_WINDOW; ; size *= 4) {
      const whole = start + size >= sql.length;
      const piece = whole ? sql.slice(start) : sql.slice(start, start + size);
      let stmt: StatementSync;
      try {
        stmt = this.db.prepare(piece);
      } catch (e) {
        if (whole) {
          throw e;
        }
        continue;
      }
      const source = (stmt as unknown as { sourceSQL: string | (() => string) }).sourceSQL;
      // Only the length is taken: a broken surrogate pair comes back as another character.
      const length = (typeof source === 'function' ? source.call(stmt) : source).length;
      if (!length) {
        throw new Error('The statement could not be read.');
      }
      if (whole || length < piece.length) {
        this.end = start + length;
        this.text = sql.slice(start, this.end);
        return stmt;
      }
    }
  }
}

/** Whether a transaction is open, which only a statement of the script can have done. */
function inTransaction(db: DatabaseSync): boolean {
  const known = (db as { isTransaction?: boolean }).isTransaction;
  if (typeof known === 'boolean') {
    return known;
  }
  // Older runtimes don't say. A second BEGIN is refused inside a transaction and harmless outside one.
  try {
    db.exec('BEGIN');
  } catch {
    return true;
  }
  db.exec('ROLLBACK');
  return false;
}

/**
 * The statement behind a result, ready to be read again: the script is run up to it. On the
 * read-only connection this is meant for, the statements in front can prepare the ground (a
 * temporary table, a PRAGMA) but can't write to the database.
 */
function resultStatement(db: DatabaseSync, source: ResultSource): StatementSync {
  const script = new Script(db, source.sql);
  for (;;) {
    const stmt = script.next();
    if (!stmt) {
      // A result that can't be read again is sent to the page without a script.
      throw new Error("The statement that returned these rows also changed the database, so it can't be run a second time.");
    }
    if (script.index >= source.index) {
      return stmt;
    }
    // A plain query leaves nothing behind. Anything else does all it does in its first step.
    if (!/^(?:SELECT|VALUES|EXPLAIN)\b/i.test(script.text)) {
      stmt.get();
    }
  }
}

/**
 * Runs a script, statement by statement, and stops at the first one that fails. It is tried on a
 * read-only connection first, and only a script that turns out to write is run again, from its
 * beginning, on one that may: nothing of the first run has reached the file then.
 *
 * There is no transaction around the script. Each statement is committed as it ends, as SQLite does,
 * unless the script has its own BEGIN; a transaction that is still open when the script stops is
 * rolled back when the connection closes.
 */
export function query(file: string, sql: string): QueryResult {
  const started = Date.now();
  const run = (readOnly: boolean): QueryResult | null =>
    withDb(file, readOnly, (db) => {
      const total = readOnly ? null : db.prepare('SELECT total_changes() AS n');
      const totalChanges = () => Number((total?.get() as { n: number } | undefined)?.n ?? 0);
      const script = new Script(db, sql);
      const result: QueryResult = { statements: [], shown: -1, columns: [], rows: [], truncated: false, source: null, error: null, wrote: !readOnly, rolledBack: -1, ms: 0 };
      for (;;) {
        const began = Date.now();
        try {
          const stmt = script.next();
          if (!stmt) {
            break;
          }
          const before = totalChanges();
          stmt.setReadBigInts(true);
          // Arrays keep columns that share a name apart, as in a join.
          stmt.setReturnArrays(true);
          const columns = stmt.columns().map((c) => c.name);
          const rows: Wire[][] = [];
          let truncated = false;
          // Leaving the loop early resets the statement, so it holds no lock against the ones that follow.
          for (const row of stmt.iterate() as unknown as Iterable<unknown[]>) {
            if (rows.length === QUERY_ROWS) {
              truncated = true;
              break;
            }
            rows.push(row.map((value) => toWire(value, QUERY_TEXT)));
          }
          const changed = totalChanges() - before;
          result.statements.push({
            sql: script.text.slice(0, STATEMENT_TEXT),
            rows: columns.length ? rows.length : null,
            truncated,
            // DDL and the like change no rows, and "0 rows changed" would be a strange thing to say about them.
            changes: !readOnly && (changed > 0 || /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(script.text)) ? changed : null,
            ms: Date.now() - began,
          });
          if (columns.length) {
            result.shown = script.index;
            result.columns = columns;
            result.rows = rows;
            result.truncated = truncated;
            // Read-only, the whole script up to here can run again and gives the same rows. After a
            // script that wrote, only the statement itself can, and not if it is the one that wrote.
            result.source = readOnly ? { sql: sql.slice(0, script.end), index: script.index } : changed ? null : { sql: script.text, index: 0 };
          }
        } catch (e) {
          if (readOnly && ((e as { errcode?: number }).errcode ?? 0) % 256 === SQLITE_READONLY) {
            return null;
          }
          result.error = { index: script.index, message: e instanceof Error ? e.message : String(e), sql: script.text.slice(0, STATEMENT_TEXT) };
          break;
        }
        if (!inTransaction(db)) {
          result.rolledBack = -1;
        } else if (result.rolledBack < 0) {
          result.rolledBack = script.index;
        }
      }
      // An error may have ended the transaction by itself (a conflict clause, a full disk).
      if (result.rolledBack >= 0 && !inTransaction(db)) {
        result.rolledBack = -1;
      }
      result.ms = Date.now() - started;
      return result;
    });
  return run(true) ?? (run(false) as QueryResult);
}

// ---- Blobs ------------------------------------------------------------------

/** Reads the blob at `source`: all of it, or only its size and first `head` bytes. */
function readBlob(db: DatabaseSync, source: BlobSource, head: number | null): { size: number; bytes: Uint8Array } {
  let value: unknown;
  let size: unknown;
  if ('sql' in source) {
    // A result has no row keys, so the statement runs again up to the row in question.
    const stmt = resultStatement(db, source);
    // The other columns of the row are read too, and one of them may hold an integer too large for a number.
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    let n = 0;
    for (const row of stmt.iterate() as unknown as Iterable<unknown[]>) {
      if (n++ === source.row) {
        value = row[source.column];
        break;
      }
    }
  } else {
    const table = findTable(db, source.table);
    if (!table.columns.some((c) => c.name === source.column)) {
      throw new Error('The value could not be found.');
    }
    const q = quote(source.column);
    // The cut is made by SQLite, so a hex view of a huge blob doesn't load it.
    const select = `SELECT ${head === null ? q : `CASE typeof(${q}) WHEN 'blob' THEN ${blobHead(q, head)} END`} AS v, CASE typeof(${q}) WHEN 'blob' THEN length(${q}) END AS n FROM ${quote(table.name)}`;
    let row: { v: unknown; n: unknown } | undefined;
    if ('key' in source) {
      if (!table.key || source.key.length !== table.key.length) {
        throw new Error('The value could not be found.');
      }
      row = db.prepare(`${select} WHERE ${whereKey(table)}`).get(...source.key.map(toSql)) as typeof row;
    } else {
      const { where, order, params } = scope(table, source);
      row = db.prepare(`${select}${where}${order} LIMIT 1 OFFSET ${Math.max(0, Math.floor(source.offset))}`).get(...params) as typeof row;
    }
    value = row?.v;
    size = row?.n;
  }
  if (!(value instanceof Uint8Array) || size === null) {
    throw new Error('The cell no longer holds a blob.');
  }
  return { size: size === undefined ? value.length : Number(size), bytes: head === null ? value : value.subarray(0, head) };
}

/**
 * The bytes of a blob for the page. With `full`, a blob of up to 16 MB comes whole (`complete`),
 * to be shown as a picture; otherwise only its first 4096 bytes do.
 */
export function blob(file: string, source: BlobSource, full: boolean): { size: number; bytes: Uint8Array; complete: boolean } {
  return withDb(file, true, (db) => {
    let { size, bytes } = readBlob(db, source, BLOB_VIEW);
    if (full && size > bytes.length && size <= BLOB_MAX) {
      ({ size, bytes } = readBlob(db, source, null));
    }
    // A copy of its own: the bytes may sit in a larger buffer that would be sent along.
    return { size, bytes: new Uint8Array(bytes), complete: bytes.length === size };
  });
}

/** Writes a whole blob into a file and returns its size. */
export function saveBlob(file: string, source: BlobSource, target: string): number {
  return withDb(file, true, (db) => {
    const { bytes } = readBlob(db, source, null);
    fs.writeFileSync(target, bytes);
    return bytes.length;
  });
}

// ---- Export -----------------------------------------------------------------

/** A real as text that reads back as the same real: the shortest digits that do, and never the look of an integer. */
function realText(value: number): string {
  if (!Number.isFinite(value)) {
    // SQLite has no literal for infinity; a number too large for a double is how it is written.
    return value > 0 ? '9e999' : '-9e999';
  }
  const text = String(value);
  return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

function csvValue(value: unknown): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return realText(value);
  }
  if (typeof value === 'string') {
    // Quotes tell an empty text from NULL, which is an empty field.
    return value === '' ? '""' : csvField(value);
  }
  return `X'${Buffer.from(value as Uint8Array).toString('hex').toUpperCase()}'`;
}

function jsonValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'bigint') {
    // Most JSON readers keep numbers as doubles, which would round an integer this large.
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? value.toString() : `"${value}"`;
  }
  if (typeof value === 'number') {
    return realText(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return `"${Buffer.from(value as Uint8Array).toString('base64')}"`;
}

/** Object keys for a JSON row. Columns that share a name, as in a join, get a number. */
function jsonKeys(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let key = name;
    for (let n = 2; taken.has(key); n++) {
      key = `${name}_${n}`;
    }
    taken.add(key);
    return JSON.stringify(key);
  });
}

/**
 * Writes every row of `source` into a CSV or JSON file. Rows go from SQLite to the file one by one,
 * so the size of the table doesn't matter. The file appears under its name only when it is complete.
 */
export function exportRows(file: string, source: RowSource, format: 'csv' | 'json', target: string, job: Job): { rows: number; cancelled: boolean } {
  return withDb(file, true, (db) => {
    let stmt: StatementSync;
    let params: SQLInputValue[] = [];
    let total = 0;
    if ('sql' in source) {
      // The connection is read-only, so a statement that writes fails here instead of running a second time.
      stmt = resultStatement(db, source);
    } else {
      const table = findTable(db, source.table);
      const from = quote(table.name);
      const { where, order, params: p } = scope(table, source);
      params = p;
      stmt = db.prepare(`SELECT ${table.columns.map((c) => quote(c.name)).join(', ')} FROM ${from}${where}${order}`);
      // Counting filtered rows would scan the table twice; then the progress just has no end.
      total = where ? 0 : Number((db.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get() as { n: number }).n);
    }
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const names = stmt.columns().map((c) => c.name);
    if (!names.length) {
      throw new Error('The statement has no result to export.');
    }
    const keys = jsonKeys(names);

    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
    const fd = fs.openSync(temp, 'w');
    let buffer = format === 'csv' ? names.map((name) => csvField(name)).join(',') + '\r\n' : '[';
    let rows = 0;
    let cancelled = false;
    let complete = false;
    try {
      for (const row of stmt.iterate(...params) as unknown as Iterable<unknown[]>) {
        buffer +=
          format === 'csv'
            ? row.map(csvValue).join(',') + '\r\n'
            : `${rows ? ',' : ''}\n{${row.map((value, i) => `${keys[i]}:${jsonValue(value)}`).join(',')}}`;
        rows++;
        if (buffer.length >= 1 << 16) {
          fs.writeSync(fd, buffer);
          buffer = '';
        }
        if (rows % 256 === 0) {
          if (job.cancelled()) {
            cancelled = true;
            break;
          }
          job.progress(rows, total);
        }
      }
      if (!cancelled) {
        fs.writeSync(fd, format === 'csv' ? buffer : `${buffer}\n]\n`);
        complete = true;
      }
    } finally {
      fs.closeSync(fd);
      if (!complete) {
        fs.rmSync(temp, { force: true });
      }
    }
    if (complete) {
      fs.renameSync(temp, target);
    }
    return { rows, cancelled };
  });
}

// ---- Import -----------------------------------------------------------------

interface CsvRow {
  fields: string[];
  /** Whether each field was written in quotes, which is what tells "" from an empty field. */
  quoted: boolean[];
}

/**
 * Cuts one row out of `text`, by the rules of parseCsv() in csv.ts. Returns null when the row
 * isn't complete yet and more text is to come, or when the text has ended.
 */
function readRow(text: string, from: number, delimiter: string, eof: boolean): (CsvRow & { next: number }) | null {
  const length = text.length;
  const fields: string[] = [];
  const quoted: boolean[] = [];
  let field = '';
  let inQuotes = false;
  let i = from;
  for (;;) {
    if (i >= length) {
      if (!eof || (field === '' && !inQuotes && !fields.length)) {
        return null;
      }
      fields.push(field);
      quoted.push(inQuotes);
      return { fields, quoted, next: length };
    }
    const ch = text[i];
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      for (;;) {
        const close = text.indexOf('"', i);
        // The character after the quote decides whether it closes the field.
        if (!eof && (close < 0 || close + 1 >= length)) {
          return null;
        }
        if (close < 0) {
          field += text.slice(i);
          i = length;
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
      continue;
    }
    if (ch === delimiter) {
      fields.push(field);
      quoted.push(inQuotes);
      field = '';
      inQuotes = false;
      i++;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && i + 1 >= length && !eof) {
        return null;
      }
      fields.push(field);
      quoted.push(inQuotes);
      return { fields, quoted, next: i + (ch === '\r' && text[i + 1] === '\n' ? 2 : 1) };
    } else {
      let next = i + 1;
      while (next < length && text[next] !== delimiter && text[next] !== '\n' && text[next] !== '\r') {
        next++;
      }
      field += text.slice(i, next);
      i = next;
    }
  }
}

/**
 * The choice decodeText() in csv.ts makes, from the beginning of the file alone: UTF-16 with that
 * byte order mark, Windows-1252 when the bytes aren't valid UTF-8, UTF-8 otherwise.
 */
function encodingOf(head: Uint8Array): string {
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
    return head[0] === 0xff ? 'utf-16le' : 'utf-16be';
  }
  try {
    // Streaming, so a character cut off at the end of the chunk isn't taken for a wrong byte.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

/** Reads a CSV file row by row, a chunk at a time, so its size doesn't matter. */
class CsvFile {
  readonly size: number;
  /** Bytes taken from the file so far. */
  read = 0;
  /** The line of the file on which the row returned last begins. */
  line = 0;
  private nextLine = 1;
  private readonly fd: number;
  private readonly chunk = Buffer.alloc(CSV_CHUNK);
  private decoder: Decoder | undefined;
  private text = '';
  private pos = 0;
  private eof = false;

  constructor(file: string, private readonly delimiter: string) {
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }

  next(): CsvRow | null {
    for (;;) {
      const row = readRow(this.text, this.pos, this.delimiter, this.eof);
      if (row) {
        this.line = this.nextLine;
        this.nextLine++;
        // Only a quoted field can hold line breaks of its own.
        row.fields.forEach((field, i) => {
          if (row.quoted[i] && /[\r\n]/.test(field)) {
            this.nextLine += field.match(/\r\n|\r|\n/g)?.length ?? 0;
          }
        });
        this.pos = row.next;
        return row;
      }
      if (this.eof) {
        return null;
      }
      this.fill();
    }
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  private fill(): void {
    const n = fs.readSync(this.fd, this.chunk, 0, CSV_CHUNK, null);
    const bytes = this.chunk.subarray(0, n);
    this.decoder ??= textDecoder(encodingOf(bytes));
    this.read += n;
    this.eof = n === 0;
    this.text = this.text.slice(this.pos) + this.decoder.decode(bytes, { stream: !this.eof });
    this.pos = 0;
  }
}

/**
 * Text as the value SQLite would make of it in a column of that affinity. This is parseInput() of
 * media/sqlite.js, so an imported value and a typed one come out the same; keep the two in step.
 * The one addition is a blob literal (X'…'), which lets an exported blob come back.
 */
function parseInput(text: string, columnAffinity: Column['affinity']): SQLInputValue {
  const number = NUMBER.test(text.trim());
  if (columnAffinity === 'text') {
    return text;
  }
  if (columnAffinity === 'numeric') {
    return text.trim() === '' ? null : number ? toSql({ num: text.trim() }) : text;
  }
  const literal = BLOB_LITERAL.exec(text);
  if (literal) {
    return Buffer.from(literal[1], 'hex');
  }
  return number ? toSql({ num: text.trim() }) : text;
}

/** The narrowest type that holds every value of a column. */
function inferType(values: string[]): string {
  let type = '';
  for (const value of values) {
    const text = value.trim();
    if (text === '') {
      continue;
    }
    let fits = 'TEXT';
    if (BLOB_LITERAL.test(text)) {
      fits = 'BLOB';
    } else if (/^[+-]?(0|[1-9]\d*)$/.test(text) && BigInt(text) >= -(2n ** 63n) && BigInt(text) < 2n ** 63n) {
      fits = 'INTEGER';
    } else if (NUMBER.test(text) && !/^[+-]?0\d/.test(text)) {
      // A number with leading zeros is a code of some kind (a ZIP, a phone number) and stays text.
      fits = 'REAL';
    }
    if (!type || (type === 'INTEGER' && fits === 'REAL')) {
      type = fits;
    } else if (type !== fits && !(type === 'REAL' && fits === 'INTEGER')) {
      return 'TEXT';
    }
  }
  return type || 'TEXT';
}

/** What an import of the file would read: the delimiter, the header and the first rows, with a type for each column. */
export function csvPreview(csvPath: string, options: { delimiter: string | null; header: boolean | null }): CsvPreview {
  let delimiter = options.delimiter;
  if (!delimiter) {
    // detectDelimiter() looks at 64 K characters and has to see that the text goes on after them.
    const fd = fs.openSync(csvPath, 'r');
    try {
      const head = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      delimiter = detectDelimiter(textDecoder(encodingOf(head.subarray(0, n))).decode(head.subarray(0, n)));
    } finally {
      fs.closeSync(fd);
    }
  }

  const reader = new CsvFile(csvPath, delimiter);
  try {
    const first = reader.next();
    const width = first?.fields.length ?? 0;
    const numeric = (text: string) => NUMBER.test(text.trim());
    const unique = new Set(first?.fields.map((name) => name.trim().toLowerCase()));
    // A header is a row of distinct names; a row with a number or a gap in it is taken for data.
    const header = options.header ?? (!!first && unique.size === width && first.fields.every((name) => name.trim() !== '' && !numeric(name)));

    const taken = new Set<string>();
    const names = Array.from({ length: width }, (_, i) => {
      const base = (header && first?.fields[i].trim()) || `column_${i + 1}`;
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        name = `${base}_${n}`;
      }
      taken.add(name.toLowerCase());
      return name;
    });

    const values: string[][] = names.map(() => []);
    const rows: string[][] = [];
    let sampled = 0;
    let complete = false;
    for (let row = header ? reader.next() : first; ; row = reader.next()) {
      if (!row) {
        complete = true;
        break;
      }
      if (width > 1 && row.fields.length === 1 && row.fields[0] === '' && !row.quoted[0]) {
        continue;
      }
      sampled++;
      row.fields.slice(0, width).forEach((field, i) => values[i].push(field));
      if (rows.length < PREVIEW_ROWS) {
        rows.push(row.fields.map((field) => (field.length > PREVIEW_TEXT ? `${field.slice(0, PREVIEW_TEXT)}…` : field)));
      }
      if (reader.read > PREVIEW_BYTES) {
        break;
      }
    }
    return { size: reader.size, delimiter, header, names, types: values.map(inferType), rows, sampled, complete };
  } finally {
    reader.close();
  }
}

/**
 * Adds the rows of a CSV file to a table, in one transaction: a row that is refused undoes
 * all of them, and the error says which row it was.
 */
export function importCsv(file: string, csvPath: string, options: ImportOptions, job: Job): { rows: number; cancelled: boolean } {
  return withDb(file, false, (db) => {
    const reader = new CsvFile(csvPath, options.delimiter);
    try {
      db.exec('BEGIN IMMEDIATE');
      const used = options.columns.flatMap((column, index) => (column ? [{ ...column, index }] : []));
      if (!used.length) {
        throw new Error('No column of the file is set to be imported.');
      }
      if (options.create) {
        if (!options.table.trim()) {
          throw new Error('The new table needs a name.');
        }
        const definitions = used.map((column) => {
          const type = (column.type ?? '').toUpperCase();
          if (!NEW_TYPES.includes(type)) {
            throw new Error(`"${type}" is not a column type.`);
          }
          return `${quote(column.name)} ${type}`;
        });
        db.exec(`CREATE TABLE ${quote(options.table)} (${definitions.join(', ')})`);
      }
      const table = findTable(db, options.table);
      const affinities = used.map((column) => {
        const found = table.columns.find((c) => c.name === column.name);
        if (!found || found.generated) {
          throw new Error(found ? `The column "${column.name}" is generated and can't be imported into.` : `There is no column "${column.name}" in "${table.name}".`);
        }
        return found.affinity;
      });
      const insert = db.prepare(`INSERT INTO ${quote(table.name)} (${used.map((c) => quote(c.name)).join(', ')}) VALUES (${used.map(() => '?').join(', ')})`);

      const width = options.columns.length;
      let rows = 0;
      let cancelled = false;
      let first = true;
      for (let row = reader.next(); row; row = reader.next()) {
        if (first && options.header) {
          first = false;
          continue;
        }
        first = false;
        // An empty line, unless the file has one column and the line is that column's empty value.
        if (width > 1 && row.fields.length === 1 && row.fields[0] === '' && !row.quoted[0]) {
          continue;
        }
        rows++;
        try {
          if (row.fields.length > width) {
            throw new Error(`it has ${row.fields.length} fields, and the first row of the file has ${width}`);
          }
          const { fields, quoted } = row;
          insert.run(
            ...used.map((column, i) => {
              // A row that ends early is short of fields, which then count as empty.
              const text = fields[column.index] ?? '';
              return text === '' && !quoted[column.index] && !options.emptyText ? null : parseInput(text, affinities[i]);
            }),
          );
        } catch (e) {
          throw new Error(`Row ${rows.toLocaleString('en-US')} (line ${reader.line.toLocaleString('en-US')} of the file): ${e instanceof Error ? e.message : e}`);
        }
        if (rows % 256 === 0) {
          if (job.cancelled()) {
            cancelled = true;
            break;
          }
          job.progress(reader.read, reader.size);
        }
      }
      db.exec(cancelled ? 'ROLLBACK' : 'COMMIT');
      return { rows: cancelled ? 0 : rows, cancelled };
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite has already rolled back on its own.
      }
      throw e;
    } finally {
      reader.close();
    }
  });
}
