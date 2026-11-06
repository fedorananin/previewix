import assert from 'node:assert/strict';
import * as fs from 'fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import * as path from 'path';
import { parseCsv } from '../src/csv';
import * as db from '../src/sqliteDb';
import { random, scratch } from './helpers';

// The export and the CSV import of sqliteDb.ts. Everything else of that module is in sqlite.test.ts.

const dir = scratch();
let files = 0;
const newFile = (ext = 'db'): string => path.join(dir, `${++files}.${ext}`);
/** An empty folder, for the tests that look at what a job leaves in it. */
const newFolder = (): string => {
  const folder = newFile('dir');
  fs.mkdirSync(folder);
  return folder;
};

function open<T>(file: string, work: (conn: DatabaseSync) => T): T {
  const conn = new DatabaseSync(file);
  try {
    return work(conn);
  } finally {
    conn.close();
  }
}

/** A new database made by `sql`. */
function make(sql: string): string {
  const file = newFile();
  open(file, (conn) => conn.exec(sql));
  return file;
}

/** The rows of a query as arrays of values. */
function all(file: string, sql: string, ...params: SQLInputValue[]): unknown[][] {
  return open(file, (conn) => conn.prepare(sql).all(...params).map((row) => Object.values(row)));
}

/** The same with nothing rounded: integers as bigint, reals as number, blobs as `x'hex'`. */
function exact(file: string, sql: string): unknown[][] {
  return open(file, (conn) => {
    const stmt = conn.prepare(sql);
    stmt.setReadBigInts(true);
    return stmt.all().map((row) => Object.values(row).map((value) => (value instanceof Uint8Array ? `x'${Buffer.from(value).toString('hex')}'` : value)));
  });
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The schema and the number of rows of every table: enough to see that an import left nothing behind. */
function outline(file: string): unknown[][] {
  return open(file, (conn) => {
    const objects = conn.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all() as { type: string; name: string; sql: string }[];
    return objects.map((o) => [o.name, o.sql, o.type === 'table' ? Object.values(conn.prepare(`SELECT COUNT(*) FROM ${quote(o.name)}`).get() ?? {})[0] : null]);
  });
}

/** The rows that are in `a` and not in `b`, comparing the type of every value along with it. */
function difference(file: string, a: string, b: string, columns: string[]): unknown[][] {
  const list = columns.map((c) => `${quote(c)}, typeof(${quote(c)})`).join(', ');
  return all(file, `SELECT ${list} FROM ${quote(a)} EXCEPT SELECT ${list} FROM ${quote(b)}`);
}

const JOB: db.Job = { progress: () => undefined, cancelled: () => false };

const WHOLE = { sort: null, filter: '' };

function csvFile(content: string | Uint8Array): string {
  const file = newFile('csv');
  fs.writeFileSync(file, content);
  return file;
}

/** Columns of an import into an existing table, by name; null leaves a column of the file out. */
const into = (...names: (string | null)[]): db.ImportOptions['columns'] => names.map((name) => (name === null ? null : { name }));
/** Columns of a new table, as "name TYPE". */
const fresh = (...columns: string[]): db.ImportOptions['columns'] => columns.map((column) => ({ name: column.slice(0, column.lastIndexOf(' ')), type: column.slice(column.lastIndexOf(' ') + 1) }));

function importCsv(file: string, content: string | Uint8Array, options: Partial<db.ImportOptions> & Pick<db.ImportOptions, 'table' | 'columns'>, job = JOB) {
  return db.importCsv(file, csvFile(content), { delimiter: ',', header: true, emptyText: false, create: false, ...options }, job);
}

// ---- Export: what the files look like -----------------------------------------------------

// One value of every kind in a column without a type, and how a CSV file and a JSON file write it.
const KINDS: [SQLInputValue | 'empty blob', string, unknown][] = [
  [null, '', null],
  ['', '""', ''],
  ['plain', 'plain', 'plain'],
  ['with,comma', '"with,comma"', 'with,comma'],
  ['with "quotes"', '"with ""quotes"""', 'with "quotes"'],
  ['two\r\nlines', '"two\r\nlines"', 'two\r\nlines'],
  [' padded ', '" padded "', ' padded '],
  ['é😀ж', 'é😀ж', 'é😀ж'],
  // A text that looks like a number is still written as it is.
  ['5', '5', '5'],
  [5n, '5', 5],
  [-5n, '-5', -5],
  [9007199254740991n, '9007199254740991', 9007199254740991],
  [9007199254740992n, '9007199254740992', '9007199254740992'],
  [-9007199254740993n, '-9007199254740993', '-9007199254740993'],
  [9223372036854775807n, '9223372036854775807', '9223372036854775807'],
  [-9223372036854775808n, '-9223372036854775808', '-9223372036854775808'],
  [5.0, '5.0', 5],
  [-2.5, '-2.5', -2.5],
  [0.1, '0.1', 0.1],
  [1e20, '100000000000000000000.0', 1e20],
  [1e300, '1e+300', 1e300],
  [1e-7, '1e-7', 1e-7],
  [5e-324, '5e-324', 5e-324],
  [Infinity, '9e999', Infinity],
  [-Infinity, '-9e999', -Infinity],
  [Buffer.from('00ff10', 'hex'), "X'00FF10'", 'AP8Q'],
  [Buffer.from('89504e470d0a1a0a', 'hex'), "X'89504E470D0A1A0A'", 'iVBORw0KGgo='],
  ['empty blob', "X''", ''],
];

function kinds(): string {
  const file = make('CREATE TABLE kinds (id INTEGER PRIMARY KEY, v, "the, name" TEXT)');
  open(file, (conn) => {
    for (const [value] of KINDS) {
      // A JS number is bound as a real and a bigint as an integer, which is what tells 5 from 5.0 here.
      if (value === 'empty blob') {
        conn.exec("INSERT INTO kinds (v) VALUES (x'')");
      } else {
        conn.prepare('INSERT INTO kinds (v) VALUES (?)').run(value);
      }
    }
  });
  return file;
}

test('export: CSV writes NULL, empty text, integers, reals, infinity and blobs apart', () => {
  const file = kinds();
  const target = newFile('csv');
  assert.deepEqual(db.exportRows(file, { table: 'kinds', ...WHOLE }, 'csv', target, JOB), { rows: KINDS.length, cancelled: false });
  const expected = ['id,v,"the, name"', ...KINDS.map(([, csv], i) => `${i + 1},${csv},`), ''].join('\r\n');
  assert.equal(fs.readFileSync(target, 'utf8'), expected);
  // No byte order mark: the file is plain UTF-8.
  assert.equal(fs.readFileSync(target)[0], 'i'.charCodeAt(0));
});

test('export: a real in CSV reads back as the same real and never looks like an integer', () => {
  const rand = random(11);
  const values = [0, 1, -1, 123456789, 2 ** 53, 2 ** 63, -(2 ** 63), 1e21, 1e22, 0.30000000000000004, 1 / 3, Number.MAX_VALUE, Number.MIN_VALUE, 4.35, 100, 1e15, 123456789012345680000];
  while (values.length < 200) {
    const value = rand.bytes(8).readDoubleLE(0);
    if (Number.isFinite(value)) {
      values.push(value);
    }
  }
  const file = make('CREATE TABLE reals (r REAL)');
  open(file, (conn) => values.forEach((value) => conn.prepare('INSERT INTO reals VALUES (?)').run(value)));
  const target = newFile('csv');
  db.exportRows(file, { table: 'reals', ...WHOLE }, 'csv', target, JOB);
  const lines = fs.readFileSync(target, 'utf8').split('\r\n').slice(1, -1);
  assert.equal(lines.length, values.length);
  lines.forEach((line, i) => {
    assert.equal(Number(line), values[i], line);
    assert.match(line, /[.e]/, line);
  });
});

test('export: JSON is an array of objects, with big integers as strings and blobs as base64', () => {
  const file = kinds();
  const target = newFile('json');
  assert.deepEqual(db.exportRows(file, { table: 'kinds', ...WHOLE }, 'json', target, JOB), { rows: KINDS.length, cancelled: false });
  const text = fs.readFileSync(target, 'utf8');
  // 9e999 is how JSON gets an infinity, which it has no word for.
  assert.deepEqual(JSON.parse(text), KINDS.map(([, , json], i) => ({ id: i + 1, v: json, 'the, name': null })));
  // Reals stay reals for a reader that tells them apart, and integers within 2^53 are numbers.
  assert.ok(text.includes('{"id":17,"v":5.0,'));
  assert.ok(text.includes('{"id":10,"v":5,'));
  assert.ok(text.includes('"v":9007199254740991,'));
  assert.ok(text.includes('"v":"9007199254740992",'));
  assert.ok(text.includes('"v":9e999,') && text.includes('"v":-9e999,'));
});

test('export: columns of a result that share a name get a number in JSON', () => {
  const file = make('CREATE TABLE a (id INTEGER, name TEXT); CREATE TABLE b (id INTEGER, name TEXT); INSERT INTO a VALUES (1, \'x\'); INSERT INTO b VALUES (2, \'y\')');
  const target = newFile('json');
  db.exportRows(file, { sql: 'SELECT a.id, b.id, a.name, b.name, 3 AS id FROM a, b', index: 0 }, 'json', target, JOB);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), [{ id: 1, id_2: 2, name: 'x', name_2: 'y', id_3: 3 }]);
  // CSV keeps the names as they are.
  const csv = newFile('csv');
  db.exportRows(file, { sql: 'SELECT a.id, b.id, a.name, b.name, 3 AS id FROM a, b', index: 0 }, 'csv', csv, JOB);
  assert.equal(fs.readFileSync(csv, 'utf8'), 'id,id,name,name,id\r\n1,2,x,y,3\r\n');
});

test('export: a table without rows is a header in CSV and an empty array in JSON', () => {
  const file = make('CREATE TABLE none (a, "b c")');
  const csv = newFile('csv');
  const json = newFile('json');
  assert.deepEqual(db.exportRows(file, { table: 'none', ...WHOLE }, 'csv', csv, JOB), { rows: 0, cancelled: false });
  assert.equal(fs.readFileSync(csv, 'utf8'), 'a,b c\r\n');
  db.exportRows(file, { table: 'none', ...WHOLE }, 'json', json, JOB);
  assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), []);
  assert.throws(() => db.exportRows(file, { sql: 'DROP TABLE none', index: 0 }, 'csv', csv, JOB), /no result to export|readonly database/);
});

// ---- Export: which rows, and how the file appears --------------------------------------------

/** A table of `count` rows: n from 1, and a text that says whether n is even. */
function numbered(count: number): string {
  const file = make('CREATE TABLE many (n INTEGER PRIMARY KEY, kind TEXT, half INTEGER)');
  open(file, (conn) => {
    conn.exec('BEGIN');
    const insert = conn.prepare('INSERT INTO many VALUES (?, ?, ?)');
    for (let n = 1; n <= count; n++) {
      insert.run(n, n % 2 ? 'odd' : 'even', Math.floor(n / 2));
    }
    conn.exec('COMMIT');
  });
  return file;
}

/** The first column of what an export of `source` writes. */
function exported(file: string, source: db.RowSource): number[] {
  const target = newFile('csv');
  db.exportRows(file, source, 'csv', target, JOB);
  return fs.readFileSync(target, 'utf8').split('\r\n').slice(1, -1).map((line) => Number(line.split(',')[0]));
}

test('export: the rows of a table as the grid shows them, sorted and narrowed to a key', () => {
  const file = numbered(40);
  const numbers = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.deepEqual(exported(file, { table: 'many', sort: null, filter: '' }), numbers);
  assert.deepEqual(exported(file, { table: 'many', sort: { column: 'n', desc: true }, filter: '' }), [...numbers].reverse());
  assert.deepEqual(exported(file, { table: 'many', sort: null, filter: '', match: { columns: ['half'], values: [7] } }), [14, 15]);
  assert.deepEqual(exported(file, { table: 'many', sort: { column: 'n', desc: true }, filter: '', match: { columns: ['half'], values: [{ num: '7' }] } }), [15, 14]);
});

test('export: the rows of a table as the grid shows them, filtered', () => {
  const file = numbered(600);
  const numbers = Array.from({ length: 600 }, (_, i) => i + 1);
  assert.deepEqual(exported(file, { table: 'many', sort: null, filter: 'ODD' }), numbers.filter((n) => n % 2));
  assert.deepEqual(exported(file, { table: 'many', sort: { column: 'n', desc: true }, filter: 'even', match: { columns: ['half'], values: [7] } }), [14]);
  // Counting the rows first would scan the table twice, so a filtered export has no total to report.
  const totals: number[] = [];
  const target = newFile('json');
  db.exportRows(file, { table: 'many', sort: null, filter: 'd' }, 'json', target, { progress: (_, total) => totals.push(total), cancelled: () => false });
  assert.ok(totals.length > 0 && totals.every((total) => total === 0));
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).length, 300);
});

test('export: the file is written beside its place and appears under its name only when it is complete', () => {
  const file = numbered(600);
  const folder = newFolder();
  const target = path.join(folder, 'out.csv');
  fs.writeFileSync(target, 'the file that was there before');
  const seen: { done: number; total: number; names: string[]; old: string }[] = [];
  const job: db.Job = {
    progress: (done, total) => seen.push({ done, total, names: fs.readdirSync(folder), old: fs.readFileSync(target, 'utf8') }),
    cancelled: () => false,
  };
  assert.deepEqual(db.exportRows(file, { table: 'many', ...WHOLE }, 'csv', target, job), { rows: 600, cancelled: false });
  // While it ran, the old file was untouched and one more file stood next to it.
  assert.ok(seen.length > 0);
  for (const at of seen) {
    assert.deepEqual([at.total, at.names.length, at.old], [600, 2, 'the file that was there before']);
    assert.ok(at.done > 0 && at.done <= 600);
  }
  assert.deepEqual(fs.readdirSync(folder), ['out.csv']);
  assert.equal(fs.readFileSync(target, 'utf8').split('\r\n').length, 602);
});

for (const existing of [false, true]) {
  test(`export: a cancelled export leaves ${existing ? 'the file that was there as it was' : 'no file'}`, () => {
    const file = numbered(600);
    const folder = newFolder();
    const target = path.join(folder, 'out.json');
    if (existing) {
      fs.writeFileSync(target, 'before');
    }
    let asked = 0;
    const result = db.exportRows(file, { table: 'many', ...WHOLE }, 'json', target, { progress: () => undefined, cancelled: () => ++asked === 2 });
    assert.equal(result.cancelled, true);
    assert.ok(result.rows < 600);
    assert.deepEqual(fs.readdirSync(folder), existing ? ['out.json'] : []);
    if (existing) {
      assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    }
  });
}

test('export: a statement that fails halfway leaves no file', () => {
  const file = numbered(600);
  const folder = newFolder();
  const target = path.join(folder, 'out.csv');
  // abs() of the smallest integer can't be computed, and SQLite only finds out at row 500.
  const source = { sql: 'SELECT CASE WHEN n = 500 THEN abs(-9223372036854775807 - 1) ELSE n END FROM many', index: 0 };
  assert.throws(() => db.exportRows(file, source, 'csv', target, JOB), /integer overflow/);
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.throws(() => db.exportRows(file, { table: 'gone', ...WHOLE }, 'csv', target, JOB), /no table "gone"/);
  assert.deepEqual(fs.readdirSync(folder), []);
});

// ---- Import: values ---------------------------------------------------------------------------

test('import: an empty field is NULL and a quoted "" is an empty text', () => {
  const file = make('CREATE TABLE t (id INTEGER, a TEXT, b)');
  const csv = 'id,a,b\r\n1,,\r\n2,"",""\r\n3,x,y\r\n';
  assert.deepEqual(importCsv(file, csv, { table: 't', columns: into('id', 'a', 'b') }), { rows: 3, cancelled: false });
  assert.deepEqual(all(file, 'SELECT id, a, b FROM t'), [[1, null, null], [2, '', ''], [3, 'x', 'y']]);
});

test('import: with "empty fields as empty text", an empty field is an empty text where the column takes one', () => {
  const file = make('CREATE TABLE t (id INTEGER, a TEXT, b, n INTEGER)');
  importCsv(file, 'id,a,b,n\r\n1,,,\r\n2,"","",5\r\n', { table: 't', columns: into('id', 'a', 'b', 'n'), emptyText: true });
  // A number column has no empty text: an empty value there is NULL, as when it is typed.
  assert.deepEqual(all(file, 'SELECT id, a, b, n FROM t'), [[1, '', '', null], [2, '', '', 5]]);
});

// The same text in a column of every affinity. `a` has no type and `b` is a BLOB column, which convert nothing by
// themselves: there the value has to arrive as what it looks like.
const TEXTS: [string, [string, unknown], [string, unknown]][] = [
  ['5', ['integer', 5n], ['integer', 5n]],
  ['+5', ['integer', 5n], ['integer', 5n]],
  ['-17', ['integer', -17n], ['integer', -17n]],
  ['5.0', ['real', 5], ['real', 5]],
  ['.5', ['real', 0.5], ['real', 0.5]],
  ['1e3', ['real', 1000], ['real', 1000]],
  ['007', ['integer', 7n], ['integer', 7n]],
  [' 12 ', ['integer', 12n], ['integer', 12n]],
  ['abc', ['text', 'abc'], ['text', 'abc']],
  ['12abc', ['text', '12abc'], ['text', '12abc']],
  ['0x10', ['text', '0x10'], ['text', '0x10']],
  ['9223372036854775807', ['integer', 9223372036854775807n], ['integer', 9223372036854775807n]],
  ['-9223372036854775808', ['integer', -9223372036854775808n], ['integer', -9223372036854775808n]],
  ['9007199254740993', ['integer', 9007199254740993n], ['integer', 9007199254740993n]],
  ['9223372036854775808', ['real', 2 ** 63], ['real', 2 ** 63]],
  // An exported blob comes back as a blob.
  ["X'00FF10'", ['blob', "x'00ff10'"], ['blob', "x'00ff10'"]],
  ["x'ab'", ['blob', "x'ab'"], ['blob', "x'ab'"]],
  ["X''", ['blob', "x''"], ['blob', "x''"]],
  ["X'0'", ['text', "X'0'"], ['text', "X'0'"]],
  ["X'zz'", ['text', "X'zz'"], ['text', "X'zz'"]],
];

test('import: a value is stored the way SQLite itself stores that text in the column', () => {
  const file = make(`
    CREATE TABLE t (i INTEGER, r REAL, t TEXT, n NUMERIC, a, b BLOB);
    CREATE TABLE oracle (i INTEGER, r REAL, t TEXT, n NUMERIC);
  `);
  const field = (text: string) => `"${text}"`;
  const csv = TEXTS.map(([text]) => Array.from({ length: 6 }, () => field(text)).join(',')).join('\r\n');
  importCsv(file, csv, { table: 't', columns: into('i', 'r', 't', 'n', 'a', 'b'), header: false });
  // What SQLite makes of the text by the affinity of each column, without any help.
  open(file, (conn) => TEXTS.forEach(([text]) => conn.prepare('INSERT INTO oracle VALUES (?, ?, ?, ?)').run(text, text, text, text)));

  const typed = ['i', 'r', 't', 'n'].map((c) => `typeof(${c}), ${c}`).join(', ');
  assert.deepEqual(exact(file, `SELECT ${typed} FROM t ORDER BY rowid`), exact(file, `SELECT ${typed} FROM oracle ORDER BY rowid`));
  // In a text column nothing is converted at all.
  assert.deepEqual(all(file, 'SELECT t FROM t ORDER BY rowid'), TEXTS.map(([text]) => [text]));
  const loose = exact(file, 'SELECT typeof(a), a, typeof(b), b FROM t ORDER BY rowid');
  TEXTS.forEach(([text, a, b], row) => assert.deepEqual(loose[row], [...a, ...b], text));
});

test('import: a STRICT table takes what fits its types', () => {
  const file = make('CREATE TABLE s (i INTEGER, r REAL, t TEXT, b BLOB, a ANY) STRICT');
  importCsv(file, "i,r,t,b,a\r\n5,5,5,X'05',5\r\n-9223372036854775808,1e3,\"\",X'',x\r\n,,,,\r\n", { table: 's', columns: into('i', 'r', 't', 'b', 'a') });
  assert.deepEqual(exact(file, 'SELECT i, r, t, b, a, typeof(r), typeof(a) FROM s'), [
    [5n, 5, '5', "x'05'", 5n, 'real', 'integer'],
    [-9223372036854775808n, 1000, '', "x''", 'x', 'real', 'text'],
    [null, null, null, null, null, 'null', 'null'],
  ]);
});

// In a STRICT table ANY means "stored as given", where in any other table it is a numeric type like every unknown one.
// Taken for numeric there too, an exported blob came back as text and "" as NULL.
test('import: an ANY column of a STRICT table converts nothing, like a column without a type', () => {
  const file = make("CREATE TABLE s (id INTEGER PRIMARY KEY, a ANY) STRICT; INSERT INTO s (a) VALUES (x'00ff'), (''), (5), (5.0), ('x'); CREATE TABLE loose (a ANY, b any, c ANYTHING); CREATE TABLE rowless (k any PRIMARY KEY, i INT, r REAL, t TEXT, b BLOB) STRICT, WITHOUT ROWID");
  const affinities = (table: string) => db.schema(file).tables.find((t) => t.name === table)!.columns.map((c) => c.affinity);
  assert.deepEqual(affinities('s'), ['numeric', 'none']);
  // Outside a STRICT table ANY is a word like any other, and SQLite gives such a column numeric affinity.
  assert.deepEqual(affinities('loose'), ['numeric', 'numeric', 'numeric']);
  assert.deepEqual(affinities('rowless'), ['none', 'numeric', 'numeric', 'text', 'none']);
  assert.equal(db.rows(file, 's', { limit: 1, offset: 0, sort: null, filter: '' }).table.columns[1].affinity, 'none');
  const csv = newFile('csv');
  db.exportRows(file, { table: 's', ...WHOLE }, 'csv', csv, JOB);
  db.importCsv(file, csv, { delimiter: ',', header: true, emptyText: false, create: false, table: 's', columns: [null, { name: 'a' }] }, JOB);
  assert.deepEqual(exact(file, 'SELECT typeof(a), a FROM s WHERE id > 5'), exact(file, 'SELECT typeof(a), a FROM s WHERE id <= 5'));
});

// ---- Import: the table and its columns -----------------------------------------------------------

test('import: into a new table, created with the names and types that were chosen', () => {
  const file = make('CREATE TABLE other (x)');
  const result = importCsv(file, 'a,b,c,d\r\n1,2.5,x,X\'00\'\r\n,,,\r\n', { table: 'new "table"', create: true, columns: fresh('the id INTEGER', 'r REAL', 'quo"te TEXT', 'data blob') });
  assert.deepEqual(result, { rows: 2, cancelled: false });
  assert.deepEqual(all(file, `SELECT name, type FROM pragma_table_info('new "table"')`), [['the id', 'INTEGER'], ['r', 'REAL'], ['quo"te', 'TEXT'], ['data', 'BLOB']]);
  assert.deepEqual(exact(file, 'SELECT * FROM "new ""table"""'), [[1n, 2.5, 'x', "x'00'"], [null, null, null, null]]);
});

test('import: a new table that can not be made leaves the database as it was', () => {
  const file = make('CREATE TABLE taken (x); INSERT INTO taken VALUES (1)');
  const before = outline(file);
  const csv = 'a,b\r\n1,2\r\n';
  assert.throws(() => importCsv(file, csv, { table: 'taken', create: true, columns: fresh('a INTEGER', 'b INTEGER') }), /already exists/);
  assert.throws(() => importCsv(file, csv, { table: '  ', create: true, columns: fresh('a INTEGER', 'b INTEGER') }), /needs a name/);
  // Only the four types of a new table can be asked for, so no SQL gets in through a type.
  assert.throws(() => importCsv(file, csv, { table: 'n', create: true, columns: fresh('a INTEGER', 'b INTEGER); DROP TABLE taken; --') }), /is not a column type/);
  assert.throws(() => importCsv(file, csv, { table: 'n', create: true, columns: [{ name: 'a', type: 'INTEGER' }, { name: 'b' }] }), /is not a column type/);
  assert.throws(() => importCsv(file, csv, { table: 'n', create: true, columns: fresh('a INTEGER', 'a TEXT') }), /duplicate column name/);
  assert.throws(() => importCsv(file, csv, { table: 'n', create: true, columns: [null, null] }), /No column of the file/);
  assert.deepEqual(outline(file), before);
});

test('import: each column of the file goes to the table column chosen for it, or nowhere', () => {
  const file = make("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT DEFAULT 'none', gen AS (id * 2))");
  importCsv(file, 'x,y,z\r\nfirst,skipped,1\r\nsecond,skipped,2\r\n', { table: 't', columns: into('name', null, 'id') });
  assert.deepEqual(all(file, 'SELECT id, name, note, gen FROM t'), [[1, 'first', 'none', 2], [2, 'second', 'none', 4]]);
  const before = outline(file);
  assert.throws(() => importCsv(file, 'a\r\n1\r\n', { table: 't', columns: into('nope') }), /no column "nope" in "t"/);
  assert.throws(() => importCsv(file, 'a\r\n1\r\n', { table: 't', columns: into('gen') }), /generated/);
  assert.throws(() => importCsv(file, 'a\r\n1\r\n', { table: 'gone', columns: into('a') }), /no table "gone"/);
  assert.throws(() => importCsv(file, 'a\r\n1\r\n', { table: 't', columns: into(null) }), /No column of the file/);
  assert.deepEqual(outline(file), before);
});

test('import: the first row is data when the file has no header', () => {
  const file = make('CREATE TABLE t (a TEXT, b TEXT)');
  assert.deepEqual(importCsv(file, 'a,b\r\n1,2\r\n', { table: 't', columns: into('a', 'b'), header: false }), { rows: 2, cancelled: false });
  assert.deepEqual(importCsv(file, 'a,b\r\n3,4', { table: 't', columns: into('a', 'b'), header: true }), { rows: 1, cancelled: false });
  assert.deepEqual(all(file, 'SELECT a, b FROM t'), [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('import: other delimiters, and a delimiter inside quotes', () => {
  const file = make('CREATE TABLE t (a TEXT, b TEXT)');
  importCsv(file, 'a;b\n"x;y";z,w\n', { table: 't', columns: into('a', 'b'), delimiter: ';' });
  importCsv(file, 'a\tb\n"x\ty"\tz;w\n', { table: 't', columns: into('a', 'b'), delimiter: '\t' });
  assert.deepEqual(all(file, 'SELECT a, b FROM t'), [['x;y', 'z,w'], ['x\ty', 'z;w']]);
});

// ---- Import: rows -----------------------------------------------------------------------------------

test('import: short rows are filled with NULL and empty lines are left out', () => {
  const file = make('CREATE TABLE t (a TEXT, b TEXT, c TEXT)');
  assert.deepEqual(importCsv(file, 'a,b,c\r\n1,2,3\r\n\r\n4\r\n5,6\r\n\r\n\r\n,,\r\n""\r\n', { table: 't', columns: into('a', 'b', 'c') }), { rows: 5, cancelled: false });
  assert.deepEqual(all(file, 'SELECT a, b, c FROM t'), [['1', '2', '3'], ['4', null, null], ['5', '6', null], [null, null, null], ['', null, null]]);
});

test('import: in a file of one column an empty line is that column\'s empty value', () => {
  const file = make('CREATE TABLE t (a TEXT)');
  assert.deepEqual(importCsv(file, 'a\nx\n\ny\n', { table: 't', columns: into('a') }), { rows: 3, cancelled: false });
  assert.deepEqual(all(file, 'SELECT a FROM t'), [['x'], [null], ['y']]);
});

test('import: a refused row undoes all of them, and the message names the row and its line in the file', () => {
  const file = make('CREATE TABLE s (n INTEGER, t TEXT) STRICT; INSERT INTO s VALUES (0, \'before\')');
  const before = outline(file);
  // The second row has a line break inside quotes, so the third one begins on line 5.
  assert.throws(() => importCsv(file, 'n,t\r\n1,a\r\n2,"x\r\ny"\r\noops,c\r\n4,d\r\n', { table: 's', columns: into('n', 't') }), /^Error: Row 3 \(line 5 of the file\): cannot store TEXT value in INTEGER column/);
  assert.throws(() => importCsv(file, '1,a\n2,b,c\n', { table: 's', columns: into('n', 't'), header: false }), /^Error: Row 2 \(line 2 of the file\): it has 3 fields, and the first row of the file has 2/);
  assert.deepEqual(outline(file), before);

  // A constraint, in a table the import creates itself: the table goes too.
  const other = make('CREATE TABLE u (a TEXT UNIQUE)');
  assert.throws(() => importCsv(other, 'a\n\nx\ny\n\nx\n', { table: 'u', columns: into('a', null) }), /^Error: Row 3 \(line 6 of the file\): UNIQUE constraint failed/);
  assert.throws(() => importCsv(other, 'a,b\n1,2\n3,4,5\n', { table: 'made', create: true, columns: fresh('a INTEGER', 'b INTEGER') }), /^Error: Row 2 \(line 3 of the file\)/);
  assert.deepEqual(outline(other), [['sqlite_autoindex_u_1', null, null], ['u', 'CREATE TABLE u (a TEXT UNIQUE)', 0]]);
});

test('import: a cancelled import rolls back completely', () => {
  const lines = ['n,kind', ...Array.from({ length: 1000 }, (_, i) => `${i},row`)].join('\r\n');
  for (const create of [false, true]) {
    const file = make("CREATE TABLE t (n INTEGER, kind TEXT); INSERT INTO t VALUES (-1, 'before')");
    const before = outline(file);
    // Not at the first chance: rows are in the table by then.
    let asked = 0;
    const job: db.Job = { progress: () => undefined, cancelled: () => ++asked === 2 };
    const columns = create ? fresh('n INTEGER', 'kind TEXT') : into('n', 'kind');
    assert.deepEqual(importCsv(file, lines, { table: create ? 'made' : 't', create, columns }, job), { rows: 0, cancelled: true });
    assert.equal(asked, 2);
    assert.deepEqual(outline(file), before);
    // The same import, left alone, goes through.
    assert.deepEqual(importCsv(file, lines, { table: create ? 'made' : 't', create, columns }), { rows: 1000, cancelled: false });
    assert.deepEqual(all(file, `SELECT COUNT(*), SUM(n) FROM ${create ? 'made' : 't'} WHERE kind = 'row'`), [[1000, 499500]]);
  }
});

test('import: progress is counted in bytes of the file', () => {
  const lines = ['n', ...Array.from({ length: 1000 }, (_, i) => String(i))].join('\n');
  const file = make('CREATE TABLE t (n INTEGER)');
  const seen: [number, number][] = [];
  importCsv(file, lines, { table: 't', columns: into('n') }, { progress: (done, total) => seen.push([done, total]), cancelled: () => false });
  // The file is smaller than one chunk, so all of it was read before the first row was done.
  assert.ok(seen.length > 0);
  assert.ok(seen.every(([done, total]) => done === lines.length && total === lines.length));
});

// ---- Import: the bytes of the file -------------------------------------------------------------------

const utf16 = (text: string, bigEndian: boolean): Buffer => {
  const body = Buffer.from(`﻿${text}`, 'utf16le');
  return bigEndian ? body.swap16() : body;
};

test('import: UTF-16 by its byte order mark, Windows-1252 when the bytes are not UTF-8, UTF-8 otherwise', () => {
  const file = make('CREATE TABLE t (name TEXT, price TEXT)');
  const text = 'name,price\r\ncafé ж 😀,"€ 5"\r\n';
  const expected = [['café ж 😀', '€ 5']];
  for (const [label, bytes] of [
    ['UTF-8', Buffer.from(text)],
    ['UTF-8 with a byte order mark', Buffer.from(`﻿${text}`)],
    ['UTF-16 LE', utf16(text, false)],
    ['UTF-16 BE', utf16(text, true)],
  ] as const) {
    open(file, (conn) => conn.exec('DELETE FROM t'));
    importCsv(file, bytes, { table: 't', columns: into('name', 'price') });
    assert.deepEqual(all(file, 'SELECT name, price FROM t'), expected, label);
  }
  // 0xE9 is é and 0x80 is the euro sign in Windows-1252, and neither is UTF-8 on its own.
  open(file, (conn) => conn.exec('DELETE FROM t'));
  importCsv(file, Buffer.from('name,price\r\ncaf\xe9,"\x80 5"\r\n', 'latin1'), { table: 't', columns: into('name', 'price') });
  assert.deepEqual(all(file, 'SELECT name, price FROM t'), [['café', '€ 5']]);
});

test('import: a byte order mark is not part of the first value', () => {
  const file = make('CREATE TABLE t (a TEXT, b TEXT)');
  for (const bytes of [Buffer.from('﻿x,y\n'), utf16('x,y\n', false), utf16('x,y\n', true)]) {
    importCsv(file, bytes, { table: 't', columns: into('a', 'b'), header: false });
  }
  assert.deepEqual(all(file, 'SELECT DISTINCT a, b, length(a) FROM t'), [['x', 'y', 1]]);
  assert.deepEqual(db.csvPreview(csvFile(Buffer.from('﻿name,price\n1,2\n')), { delimiter: null, header: null }).names, ['name', 'price']);
});

const CHUNK = 1024 * 1024;

test('import: nothing is lost or doubled where one chunk of the file ends and the next begins', () => {
  // The file is read 1 MB at a time. The end of the first chunk is moved through every byte of these rows:
  // between the two quotes of an escaped one, between CR and LF, inside the bytes of é and of an emoji.
  const tail = Buffer.from('"a""b","c\r\nd"\r\né😀,"x"\r\nlast,row\r\n');
  const file = make('CREATE TABLE t (a TEXT, b TEXT)');
  const csv = newFile('csv');
  for (let k = 0; k <= tail.length; k++) {
    const filler = CHUNK - k - 'f,\n'.length;
    fs.writeFileSync(csv, Buffer.concat([Buffer.from(`f,${'p'.repeat(filler)}\n`), tail]));
    open(file, (conn) => conn.exec('DELETE FROM t'));
    assert.deepEqual(db.importCsv(file, csv, { delimiter: ',', header: false, emptyText: false, create: false, table: 't', columns: into('a', 'b') }, JOB), { rows: 4, cancelled: false }, String(k));
    assert.deepEqual(all(file, "SELECT a, CASE WHEN a = 'f' THEN length(b) ELSE b END FROM t ORDER BY rowid"), [['f', filler], ['a"b', 'c\r\nd'], ['é😀', 'x'], ['last', 'row']], String(k));
  }
});

test('import: a CR LF in two halves, one in each chunk, is one line break', () => {
  // In a file of one column an empty line is a value, so a line break taken for two would show as a row.
  const file = make('CREATE TABLE t (a TEXT)');
  const csv = `${'p'.repeat(CHUNK - 1)}\r\nlast\r\n`;
  assert.deepEqual(importCsv(file, csv, { table: 't', columns: into('a'), header: false }), { rows: 2, cancelled: false });
  assert.deepEqual(all(file, "SELECT CASE WHEN a = 'last' THEN a ELSE length(a) END FROM t ORDER BY rowid"), [[CHUNK - 1], ['last']]);
});

test('import: a UTF-16 character in two halves, one in each chunk', () => {
  // The byte order mark and "f,ppp…\n" fill the first chunk up to its last two bytes, where the emoji begins.
  const filler = (CHUNK - 4) / 2 - 'f,\n'.length;
  const bytes = utf16(`f,${'p'.repeat(filler)}\n😀é,x\n`, false);
  assert.equal(bytes.indexOf(Buffer.from('😀', 'utf16le')), CHUNK - 2);
  const file = make('CREATE TABLE t (a TEXT, b TEXT)');
  importCsv(file, bytes, { table: 't', columns: into('a', 'b'), header: false });
  assert.deepEqual(all(file, "SELECT a, CASE WHEN a = 'f' THEN length(b) ELSE b END FROM t ORDER BY rowid"), [['f', filler], ['😀é', 'x']]);
});

test('import: fields of every shape come back as they were written', () => {
  // A writer of the test's own: quotes where they are needed and, at random, where they are not.
  const rand = random(5);
  const pieces = ['a', 'B', '1', ' ', ',', ';', '"', '""', "'", '\r', '\n', '\r\n', '\t', 'é', '😀', ''];
  const rows = Array.from({ length: 300 }, (_, id) => [String(id), ...Array.from({ length: 3 }, () => (rand.int(8) === 0 ? null : Array.from({ length: rand.int(7) }, () => rand.pick(pieces)).join('')))]);
  const write = (value: string | null): string => {
    if (value === null) {
      return '';
    }
    // A field that begins with a quote, holds a break or the delimiter, or is empty has to be quoted.
    return value === '' || /[",\r\n]/.test(value) || rand.int(3) === 0 ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const csv = rows.map((row) => row.map(write).join(',')).join(rand.int(2) ? '\r\n' : '\n');
  const file = make('CREATE TABLE t (id TEXT, a TEXT, b TEXT, c TEXT)');
  assert.deepEqual(importCsv(file, csv, { table: 't', columns: into('id', 'a', 'b', 'c'), header: false }), { rows: 300, cancelled: false });
  assert.deepEqual(all(file, 'SELECT id, a, b, c FROM t ORDER BY rowid'), rows);
});

test('import: rows and fields are cut where parseCsv() of csv.ts cuts them', () => {
  // Texts of the characters that mean something in CSV, in any order, well-formed or not.
  const rand = random(12345);
  const pieces = ['a', 'b', ',', ',', '"', '"', '\n', '\r', '\r\n', ' '];
  const file = newFile('csv');
  for (let n = 0; n < 400; n++) {
    const text = Array.from({ length: rand.int(14) }, () => rand.pick(pieces)).join('');
    fs.writeFileSync(file, text);
    const expected = parseCsv(text, ',');
    // The import leaves empty lines out where the file has several columns, and can tell "" from one; parseCsv() can't.
    const several = (expected[0]?.length ?? 0) > 1;
    const kept = (rows: string[][]) => rows.filter((row) => !(several && row.length === 1 && row[0] === ''));
    assert.deepEqual(kept(db.csvPreview(file, { delimiter: ',', header: false }).rows), kept(expected), JSON.stringify(text));
  }
});

// ---- The round trip: table -> CSV -> table ----------------------------------------------------------------

/** Exports `table`, imports the file into the new table `copy` as the preview of the file suggests, and compares the two. */
function roundTrip(file: string, table: string, columns: string[]): db.CsvPreview {
  const csv = newFile('csv');
  const count = all(file, `SELECT COUNT(*) FROM ${quote(table)}`)[0][0] as number;
  assert.deepEqual(db.exportRows(file, { table, ...WHOLE }, 'csv', csv, JOB), { rows: count, cancelled: false });
  const preview = db.csvPreview(csv, { delimiter: null, header: null });
  assert.deepEqual([preview.delimiter, preview.header, preview.names, preview.complete, preview.sampled], [',', true, columns, true, count]);
  const result = db.importCsv(file, csv, { delimiter: preview.delimiter, header: preview.header, emptyText: false, create: true, table: 'copy', columns: preview.names.map((name, i) => ({ name, type: preview.types[i] })) }, JOB);
  assert.deepEqual(result, { rows: count, cancelled: false });
  assert.deepEqual(all(file, 'SELECT COUNT(*) FROM copy'), [[count]]);
  assert.deepEqual(difference(file, table, 'copy', columns), []);
  assert.deepEqual(difference(file, 'copy', table, columns), []);
  return preview;
}

test('round trip: a table of every type comes back from its CSV export with the same values and types', () => {
  const rand = random(3);
  const columns = ['id', 'whole', 'r', 'the "text"', 'data, raw'];
  const file = make('CREATE TABLE src (id INTEGER PRIMARY KEY, whole INTEGER, r REAL, "the ""text""" TEXT, "data, raw" BLOB)');
  const pieces = ['a', 'B', 'z', ' ', ',', ';', '\t', '"', "'", '\r', '\n', '\r\n', 'é', 'ж', '😀', '0', '7', '.', '-', 'X', 'e'];
  const integers: (bigint | null)[] = [null, 0n, 1n, -1n, 2n ** 53n, -(2n ** 53n) - 1n, 2n ** 63n - 1n, -(2n ** 63n)];
  const reals: (number | null)[] = [null, 0, 5, -2.5, 0.1, 1e20, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, Infinity, -Infinity, 2 ** 53, 123456789012345680000];
  // Texts that look like something else stay texts in a text column.
  const texts: (string | null)[] = [null, '', ' ', '12', '007', '1e5', '-0.5', "X'00FF'", 'NULL', '""', '"', ',', '\r\n', ' padded ', 'line\nbreak', 'é😀ж'];
  const blobs: (Buffer | null)[] = [null, Buffer.from([0]), Buffer.from('00ff10', 'hex'), Buffer.from('X\'00\'')];
  open(file, (conn) => {
    conn.exec('BEGIN');
    const insert = conn.prepare('INSERT INTO src (whole, r, "the ""text""", "data, raw") VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 300; i++) {
      let real = rand.bytes(8).readDoubleLE(0);
      real = Number.isNaN(real) ? 0.5 : real;
      insert.run(
        integers[i] !== undefined ? integers[i] : rand.int(4) ? rand.bytes(8).readBigInt64LE(0) : BigInt(rand.int(2000) - 1000),
        reals[i] !== undefined ? reals[i] : rand.int(4) ? real : rand.int(2000) - 1000,
        texts[i] !== undefined ? texts[i] : Array.from({ length: rand.int(13) }, () => rand.pick(pieces)).join(''),
        blobs[i] !== undefined ? blobs[i] : rand.bytes(1 + rand.int(40)),
      );
    }
    // An empty blob, which a bound value can't be on every runtime.
    conn.exec(`INSERT INTO src ("data, raw") VALUES (x''); COMMIT`);
  });
  const preview = roundTrip(file, 'src', columns);
  assert.deepEqual(preview.types, ['INTEGER', 'INTEGER', 'REAL', 'TEXT', 'BLOB']);
});

test('round trip: a column without a type keeps the type of every value', () => {
  const file = make('CREATE TABLE src (id INTEGER PRIMARY KEY, v); CREATE TABLE back (id INTEGER PRIMARY KEY, v)');
  // No text that looks like a number or a blob: a column without a type can't tell it from one.
  const values: SQLInputValue[] = [null, '', 'text', ' padded ', 'a,b', '"', 5n, -5n, 2n ** 63n - 1n, -(2n ** 63n), 5, -2.5, 1e20, 1e300, Infinity, -Infinity, Buffer.from('00ff', 'hex'), Buffer.from('5')];
  open(file, (conn) => values.forEach((value) => conn.prepare('INSERT INTO src (v) VALUES (?)').run(value)));
  const csv = newFile('csv');
  db.exportRows(file, { table: 'src', ...WHOLE }, 'csv', csv, JOB);
  db.importCsv(file, csv, { delimiter: ',', header: true, emptyText: false, create: false, table: 'back', columns: into('id', 'v') }, JOB);
  assert.deepEqual(all(file, 'SELECT COUNT(*) FROM back'), [[values.length]]);
  assert.deepEqual(difference(file, 'src', 'back', ['id', 'v']), []);
  assert.deepEqual(difference(file, 'back', 'src', ['id', 'v']), []);
});

// ---- csvPreview() ------------------------------------------------------------------------------------------

const preview = (content: string | Uint8Array, delimiter: string | null = null, header: boolean | null = null) => db.csvPreview(csvFile(content), { delimiter, header });

test('preview: the delimiter is detected and can be given', () => {
  assert.equal(preview('a,b,c\n1,2,3\n').delimiter, ',');
  assert.equal(preview('a;b;c\n1,5;2;3\n').delimiter, ';');
  assert.equal(preview('a\tb\tc\n1\t2\t3\n').delimiter, '\t');
  const forced = preview('a;b,c\n1;2,3\n', ',');
  assert.deepEqual([forced.delimiter, forced.names, forced.rows], [',', ['a;b', 'c'], [['1;2', '3']]]);
});

test('preview: a first row of distinct names is a header, and one with a number or a gap in it is data', () => {
  let p = preview('id,name\n1,x\n2,y\n');
  assert.deepEqual([p.header, p.names, p.rows, p.sampled, p.complete], [true, ['id', 'name'], [['1', 'x'], ['2', 'y']], 2, true]);
  p = preview('1,x\n2,y\n');
  assert.deepEqual([p.header, p.names, p.rows, p.sampled], [false, ['column_1', 'column_2'], [['1', 'x'], ['2', 'y']], 2]);
  assert.equal(preview('id,\n1,x\n').header, false);
  assert.equal(preview('name,Name\n1,x\n').header, false);
  // The choice can be made for it, and names are then told apart.
  p = preview('name,Name, name ,\n1,x,y,z\n', null, true);
  assert.deepEqual([p.header, p.names, p.rows], [true, ['name', 'Name_2', 'name_3', 'column_4'], [['1', 'x', 'y', 'z']]]);
  p = preview('id,name\n1,x\n', null, false);
  assert.deepEqual([p.header, p.names, p.sampled], [false, ['column_1', 'column_2'], 2]);
});

test('preview: the narrowest type that holds every value of a column', () => {
  const columns: [string, string[]][] = [
    ['INTEGER', ['1', '-2', '', '+3', '9223372036854775807', '0']],
    ['REAL', ['1', '2.5', '', '1e3', '.5', '-0.25']],
    ['REAL', ['1.5', '2', '3', '', '', '']],
    // An integer too large for 64 bits can only be kept as a real.
    ['REAL', ['1', '9223372036854775808', '', '', '', '']],
    ['TEXT', ['1', 'x', '', '', '', '']],
    // Numbers with leading zeros are codes of some kind.
    ['TEXT', ['01234', '90210', '', '', '', '']],
    ['TEXT', ['007', '', '', '', '', '']],
    ['TEXT', ['1.5', '00.5', '', '', '', '']],
    ['BLOB', ["X'00FF'", "x''", '', '', '', '']],
    ['TEXT', ["X'00FF'", '5', '', '', '', '']],
    ['TEXT', ['', '', '', '', '', '']],
    ['TEXT', ['0x10', '', '', '', '', '']],
  ];
  const lines = [columns.map((_, i) => `c${i}`).join(',')];
  for (let row = 0; row < 6; row++) {
    lines.push(columns.map(([, values]) => values[row]).join(','));
  }
  const p = preview(lines.join('\n'));
  assert.equal(p.header, true);
  assert.deepEqual(p.types, columns.map(([type]) => type));
});

test('preview: the types come from the first 4 MB of a larger file', () => {
  // 4.5 MB of rows with a number, then rows where that column holds text.
  const row = `${'x'.repeat(990)},12345\n`;
  const csv = `t,n\n${row.repeat(4500)}${'late,text\n'.repeat(10)}`;
  const p = preview(csv);
  assert.deepEqual([p.types, p.complete, p.size], [['TEXT', 'INTEGER'], false, csv.length]);
  assert.ok(p.sampled > 4000 && p.sampled < 4500);
  // The rows shown are the first ones, and a long field is shown cut.
  assert.ok(p.rows.length > 0 && p.rows.length <= 100);
  assert.ok(p.rows[0][0].length < 990 && p.rows[0][0].startsWith('xxx'));
  assert.equal(p.rows[0][1], '12345');
});
