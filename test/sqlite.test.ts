import assert from 'node:assert/strict';
import * as fs from 'fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import * as path from 'path';
import { Worker, type WorkerOptions } from 'worker_threads';
import * as db from '../src/sqliteDb';
import { random, scratch } from './helpers';

const dir = scratch();
let files = 0;
const newFile = (ext = 'db'): string => path.join(dir, `${++files}.${ext}`);

// ---- The test's own way into a database, independent of the code under test ----

function open<T>(file: string, work: (conn: DatabaseSync) => T): T {
  const conn = new DatabaseSync(file);
  try {
    // The data has references that lead nowhere on purpose, and node:sqlite enforces foreign keys by default.
    conn.exec('PRAGMA foreign_keys = OFF');
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

function copy(file: string): string {
  const target = newFile();
  fs.copyFileSync(file, target);
  return target;
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

/** Everything a database holds, as text: the schema and every row of every table, with the type of every value. */
function dump(file: string): string {
  return open(file, (conn) => {
    const objects = conn.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name, type').all() as { type: string; name: string; sql: string | null }[];
    const lines = objects.map((o) => `${o.type} ${o.name}: ${o.sql}`);
    for (const { type, name } of objects) {
      if (type !== 'table' || name.startsWith('sqlite_')) {
        continue;
      }
      const columns = conn.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0').all(name) as { name: string }[];
      // quote() writes 1 and 1.0, 'text', X'blob' and NULL apart.
      const row = columns.map((c) => `quote("${c.name.replace(/"/g, '""')}")`).join(" || ',' || ");
      for (const { line } of conn.prepare(`SELECT ${row} AS line FROM "${name.replace(/"/g, '""')}" ORDER BY 1`).all() as { line: string }[]) {
        lines.push(`${name}: ${line}`);
      }
    }
    return lines.join('\n');
  });
}

const ALL: db.RowsOptions = { offset: 0, limit: 1000, sort: null, filter: '' };

/** A row key as the page sends it back: unchanged. */
const keyOf = (row: db.Row): db.Input[] => row.key as db.Input[];
const tableOf = (file: string, name: string): db.Table => {
  const table = db.schema(file).tables.find((t) => t.name === name);
  assert.ok(table, `no table ${name}`);
  return table;
};
/** The row of a page in which the cell of `column` is `value`. */
function rowWith(page: { table: db.Table; rows: db.Row[] }, column: string, value: db.Wire): db.Row {
  const index = page.table.columns.findIndex((c) => c.name === column);
  const row = page.rows.find((r) => r.cells[index] === value);
  assert.ok(row, `no row with ${column} = ${String(value)}`);
  return row;
}

// ---- The database most tests read: every kind of table and of foreign key ----

const LONG = 'Lorem ipsum dolor sit amet; '.repeat(40);
/** A 1 × 1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const BIG_BLOB = random(7).bytes(10000);
const MID_BLOB = random(8).bytes(5000);
const token = (n: number): Buffer => Buffer.from(String(n).padStart(32, '0'), 'hex');

const CUSTOMERS = 40;
const ORDERS = 60;
/** The customer of an order, or null: every twentieth order has none. */
const customerOf = (order: number): number | null => (order % 20 === 0 ? null : (order % CUSTOMERS) + 1);

function buildShop(wal: boolean): string {
  const file = newFile();
  open(file, (conn) => {
    if (wal) {
      conn.exec('PRAGMA journal_mode = WAL');
    }
    conn.exec(`
BEGIN;
CREATE TABLE countries (code TEXT PRIMARY KEY, name TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  country TEXT REFERENCES countries(code) ON UPDATE CASCADE ON DELETE SET NULL,
  referrer INTEGER REFERENCES customers,          -- self-reference, implied primary key
  token BLOB UNIQUE,
  bio TEXT,
  big INTEGER
);
CREATE TABLE products (sku TEXT, region TEXT, title TEXT, price REAL, picture BLOB, PRIMARY KEY (sku, region)) WITHOUT ROWID;
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  customer_email TEXT REFERENCES Customers(EMAIL),   -- a unique column that is not the rowid, written in another case
  sku TEXT,
  region TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  FOREIGN KEY (sku, region) REFERENCES products (sku, region)
);
CREATE TABLE sessions (id INTEGER PRIMARY KEY, token BLOB REFERENCES customers(token), long_ref TEXT REFERENCES docs(body));
CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT UNIQUE);
CREATE TABLE "odd name" ("select" INTEGER PRIMARY KEY, "from" TEXT, "two words" TEXT, "quo""te" TEXT, key TEXT, "customer id" INTEGER REFERENCES customers(id));
CREATE TABLE strict_t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, t TEXT, r REAL, b BLOB, a ANY) STRICT;
CREATE TABLE files (id INTEGER PRIMARY KEY, data BLOB);
CREATE TABLE log (at TEXT, what TEXT);
CREATE VIEW active_customers AS SELECT id, name, country FROM customers WHERE country IS NOT NULL;
CREATE VIEW files_view AS SELECT id, data FROM files;
CREATE INDEX orders_customer ON orders (customer_id);
`);
    const run = (sql: string, ...args: SQLInputValue[]) => conn.prepare(sql).run(...args);
    for (const [code, name] of [['DE', 'Germany'], ['FR', 'France'], ['JP', 'Japan'], ['US', 'United States']]) {
      run('INSERT INTO countries VALUES (?, ?)', code, name);
    }
    for (let i = 1; i <= CUSTOMERS; i++) {
      const country = i % 7 === 0 ? null : ['DE', 'FR', 'JP', 'US'][i % 4];
      const big = i === 2 ? 9223372036854775807n : i === 4 ? -9007199254740993n : BigInt(i);
      run('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?)', i, `user${i}@example.com`, `User ${i}`, country, i > 1 ? Math.ceil(i / 2) : null, token(i), i === 3 ? LONG : `bio ${i}`, big);
    }
    // A customer whose country and referrer lead nowhere.
    run('INSERT INTO customers VALUES (900, ?, ?, ?, ?, NULL, NULL, 0)', 'ghost@example.com', 'Ghost', 'ZZ', 4242);
    for (const [sku, region, title, price] of [['A1', 'EU', 'Anvil', 10.5], ['A1', 'US', 'Anvil', 12], ['B2', 'EU', 'Bucket', 3.25], ['C3', 'US', 'Crate; large', 99]] as const) {
      run('INSERT INTO products VALUES (?, ?, ?, ?, ?)', sku, region, title, price, sku === 'A1' ? PNG : null);
    }
    for (let i = 1; i <= ORDERS; i++) {
      const customer = customerOf(i);
      run(
        'INSERT INTO orders (id, customer_id, customer_email, sku, region, qty, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        i, customer, customer && `user${customer}@example.com`, i % 3 ? 'A1' : 'B2', i % 3 ? (i % 2 ? 'EU' : 'US') : 'EU', (i % 5) + 1, i === 7 ? LONG : null,
      );
    }
    // Dangling single and composite keys, and a composite key that is NULL in part.
    run("INSERT INTO orders (id, customer_id, customer_email, sku, region) VALUES (9001, 77777, 'nobody@example.com', 'ZZ', 'EU')");
    run("INSERT INTO orders (id, customer_id, sku, region) VALUES (9002, 1, 'A1', NULL)");
    run('INSERT INTO docs VALUES (1, ?), (2, ?)', LONG, 'short');
    run('INSERT INTO sessions VALUES (1, ?, ?), (2, ?, ?), (3, ?, NULL)', token(1), LONG, Buffer.from('ff'.repeat(40), 'hex'), 'short', Buffer.from('ab'.repeat(16), 'hex'));
    run(`INSERT INTO "odd name" VALUES (1, 'f', 'tw', 'q', 'k', 2)`);
    run("INSERT INTO strict_t VALUES (1, 1, 'one', 1.5, ?, 'any')", PNG);
    run('INSERT INTO files VALUES (1, ?), (2, ?), (3, ?), (4, NULL)', BIG_BLOB, MID_BLOB, PNG);
    // After the rows, so that the log starts empty.
    conn.exec(`CREATE TRIGGER orders_log AFTER INSERT ON orders BEGIN INSERT INTO log VALUES ('now', 'order ' || new.id || '; inserted'); END; COMMIT;`);
  });
  return file;
}

/** Read by many tests and never written: a test that writes takes a copy. */
const SHOP = buildShop(false);
const WAL = buildShop(true);

// ---- save() -------------------------------------------------------------------

test('save writes staged updates, deletes and inserts of several tables', () => {
  const file = copy(SHOP);
  const others = dump(file).split('\n').filter((line) => !/^(customers|log|products|odd name): /.test(line));
  db.save(file, [
    { table: 'customers', kind: 'update', key: [5], values: [['name', 'Renamed'], ['bio', null]] },
    { table: 'customers', kind: 'delete', key: [900] },
    { table: 'log', kind: 'insert', values: [['at', 'then'], ['what', 'a; b']] },
    { table: 'products', kind: 'update', key: ['C3', 'US'], values: [['price', { num: '100' }]] },
    { table: 'odd name', kind: 'insert', values: [['select', { num: '7' }], ['two words', 'x'], ['quo"te', 'y']] },
    // A row with nothing filled in gets the defaults.
    { table: 'log', kind: 'insert', values: [] },
  ]);
  assert.deepEqual(all(file, 'SELECT name, bio FROM customers WHERE id = 5'), [['Renamed', null]]);
  assert.deepEqual(all(file, 'SELECT COUNT(*) FROM customers'), [[CUSTOMERS]]);
  assert.deepEqual(all(file, 'SELECT at, what FROM log ORDER BY rowid'), [['then', 'a; b'], [null, null]]);
  assert.deepEqual(all(file, "SELECT price, typeof(price) FROM products WHERE sku = 'C3'"), [[100, 'real']]);
  assert.deepEqual(all(file, 'SELECT "select", "from", "two words", "quo""te" FROM "odd name" ORDER BY 1'), [[1, 'f', 'tw', 'q'], [7, null, 'x', 'y']]);
  // Nothing else moved.
  assert.deepEqual(dump(file).split('\n').filter((line) => !/^(customers|log|products|odd name): /.test(line)), others);
});

// Every case ends in a change that is refused, after changes that would have gone through.
const REFUSED: [string, db.Change, RegExp][] = [
  ['an update that hits no row', { table: 'customers', kind: 'update', key: [4040], values: [['name', 'nobody']] }, /A row of "customers" no longer exists/],
  ['a delete that hits no row', { table: 'products', kind: 'delete', key: ['A1', 'ZZ'] }, /A row of "products" no longer exists/],
  ['a constraint', { table: 'countries', kind: 'insert', values: [['code', 'DE'], ['name', 'Again']] }, /UNIQUE constraint failed/],
  ['a missing value', { table: 'countries', kind: 'insert', values: [['code', 'XX']] }, /NOT NULL constraint failed/],
  ['a wrong type in a STRICT table', { table: 'strict_t', kind: 'update', key: [1], values: [['n', 'not a number']] }, /cannot store TEXT value in INTEGER column/],
  ['a broken foreign key', { table: 'orders', kind: 'insert', values: [['customer_id', { num: '123456' }]] }, /FOREIGN KEY constraint failed/],
  ['a table that is gone', { table: 'nowhere', kind: 'insert', values: [] }, /no table "nowhere"/],
  ['a key of the wrong length', { table: 'products', kind: 'delete', key: ['A1'] }, /can't be edited/],
  ['an update of a view', { table: 'active_customers', kind: 'update', key: [1], values: [['name', 'x']] }, /can't be edited/],
  ['a delete from a view', { table: 'active_customers', kind: 'delete', key: [1] }, /can't be edited/],
  ['an insert into a view', { table: 'active_customers', kind: 'insert', values: [['name', 'x']] }, /view/],
];
for (const [what, refused, message] of REFUSED) {
  test(`save: ${what} aborts the whole save and leaves the database as it was`, () => {
    const file = copy(SHOP);
    const before = dump(file);
    assert.throws(
      () =>
        db.save(file, [
          { table: 'log', kind: 'insert', values: [['at', 'a'], ['what', 'b']] },
          { table: 'customers', kind: 'update', key: [5], values: [['name', 'changed']] },
          { table: 'orders', kind: 'delete', key: [3] },
          { table: 'products', kind: 'update', key: ['A1', 'EU'], values: [['title', 'changed']] },
          refused,
          { table: 'log', kind: 'insert', values: [['at', 'after']] },
        ]),
      message,
    );
    assert.equal(dump(file), before);
  });
}

test('save: the same changes without the refused one are written', () => {
  // What makes the tests above mean something: the changes around the refused one are valid.
  const file = copy(SHOP);
  db.save(file, [
    { table: 'log', kind: 'insert', values: [['at', 'a'], ['what', 'b']] },
    { table: 'customers', kind: 'update', key: [5], values: [['name', 'changed']] },
    { table: 'orders', kind: 'delete', key: [3] },
    { table: 'products', kind: 'update', key: ['A1', 'EU'], values: [['title', 'changed']] },
    { table: 'log', kind: 'insert', values: [['at', 'after']] },
  ]);
  assert.deepEqual(all(file, 'SELECT at FROM log ORDER BY rowid'), [['a'], ['after']]);
  assert.deepEqual(all(file, "SELECT (SELECT name FROM customers WHERE id = 5), (SELECT COUNT(*) FROM orders WHERE id = 3), (SELECT title FROM products WHERE sku = 'A1' AND region = 'EU')"), [['changed', 0, 'changed']]);
});

test('save: a row is addressed by rowid, or by _rowid_ or oid when a column takes the name', () => {
  // The columns named like the rowid say the opposite of the real one, so a key that used them would hit the other row.
  const file = make(`
    CREATE TABLE plain (v TEXT);
    CREATE TABLE one (rowid TEXT, v TEXT);
    CREATE TABLE two (RowId TEXT, _rowid_ TEXT, v TEXT);
    CREATE TABLE three (rowid TEXT, _ROWID_ TEXT, Oid TEXT, v TEXT);
    INSERT INTO plain VALUES ('a'), ('b');
    INSERT INTO one VALUES (2, 'a'), (1, 'b');
    INSERT INTO two VALUES (2, 2, 'a'), (1, 1, 'b');
    INSERT INTO three VALUES (2, 2, 2, 'a'), (1, 1, 1, 'b');
  `);
  for (const name of ['plain', 'one', 'two']) {
    const page = db.rows(file, name, ALL);
    db.save(file, [{ table: name, kind: 'update', key: keyOf(rowWith(page, 'v', 'b')), values: [['v', 'changed']] }]);
    assert.deepEqual(all(file, `SELECT v FROM ${name} ORDER BY v`), [['a'], ['changed']], name);
    db.save(file, [{ table: name, kind: 'delete', key: keyOf(rowWith(page, 'v', 'a')) }]);
    assert.deepEqual(all(file, `SELECT v FROM ${name}`), [['changed']], name);
  }
  // With all three names taken there is nothing to address a row by.
  assert.equal(tableOf(file, 'three').key, null);
  assert.deepEqual(db.rows(file, 'three', ALL).rows.map((row) => row.key), [null, null]);
  assert.throws(() => db.save(file, [{ table: 'three', kind: 'delete', key: [1] }]), /can't be edited/);
  assert.deepEqual(all(file, 'SELECT COUNT(*) FROM three'), [[2]]);
});

test('save: a WITHOUT ROWID row is addressed by its primary key', () => {
  // The key columns are declared in another order than the columns, and each value is in both rows.
  const file = make(`
    CREATE TABLE pairs (b TEXT, a TEXT, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
    INSERT INTO pairs VALUES ('x', 'y', 'first'), ('y', 'x', 'second'), ('x', 'x', 'third');
  `);
  const page = db.rows(file, 'pairs', ALL);
  db.save(file, [
    { table: 'pairs', kind: 'update', key: keyOf(rowWith(page, 'v', 'first')), values: [['v', 'changed']] },
    { table: 'pairs', kind: 'delete', key: keyOf(rowWith(page, 'v', 'second')) },
    // The key itself can be edited.
    { table: 'pairs', kind: 'update', key: keyOf(rowWith(page, 'v', 'third')), values: [['a', 'z']] },
  ]);
  assert.deepEqual(all(file, 'SELECT b, a, v FROM pairs ORDER BY v'), [['x', 'y', 'changed'], ['x', 'z', 'third']]);
});

test('save: keys travel in full, a blob and a text longer than the grid shows', () => {
  const head = 'ab'.repeat(16);
  const text = 'k'.repeat(300);
  const file = make(`
    CREATE TABLE tokens (token BLOB PRIMARY KEY, v TEXT) WITHOUT ROWID;
    CREATE TABLE names (name TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    INSERT INTO tokens VALUES (x'${head}01', 'one'), (x'${head}02', 'two');
    INSERT INTO names VALUES ('${text}1', 'one'), ('${text}2', 'two');
  `);
  for (const name of ['tokens', 'names']) {
    const page = db.rows(file, name, ALL);
    db.save(file, [
      { table: name, kind: 'update', key: keyOf(rowWith(page, 'v', 'two')), values: [['v', 'changed']] },
      { table: name, kind: 'delete', key: keyOf(rowWith(page, 'v', 'one')) },
    ]);
  }
  assert.deepEqual(exact(file, 'SELECT token, v FROM tokens'), [[`x'${head}02'`, 'changed']]);
  assert.deepEqual(all(file, 'SELECT name, v FROM names'), [[`${text}2`, 'changed']]);
});

test('save: rowids beyond 2^53 find their own row', () => {
  const file = make(`
    CREATE TABLE wide (id INTEGER PRIMARY KEY, v TEXT);
    INSERT INTO wide VALUES (9007199254740992, 'even'), (9007199254740993, 'odd'), (-9223372036854775808, 'least'), (9223372036854775807, 'most');
  `);
  const page = db.rows(file, 'wide', ALL);
  assert.deepEqual(
    page.rows.map((row) => row.key),
    [[{ int: '-9223372036854775808' }], [{ int: '9007199254740992' }], [{ int: '9007199254740993' }], [{ int: '9223372036854775807' }]],
  );
  db.save(file, [
    { table: 'wide', kind: 'delete', key: keyOf(rowWith(page, 'v', 'odd')) },
    { table: 'wide', kind: 'update', key: keyOf(rowWith(page, 'v', 'most')), values: [['v', 'changed']] },
    { table: 'wide', kind: 'delete', key: keyOf(rowWith(page, 'v', 'least')) },
  ]);
  assert.deepEqual(exact(file, 'SELECT id, v FROM wide ORDER BY id'), [[9007199254740992n, 'even'], [9223372036854775807n, 'changed']]);
});

// What the page sends for a typed value, the column it goes to, and what the database must hold then.
const TYPED: [string, db.Input, string, unknown][] = [
  // A column without a type keeps what it is given, so the value has to arrive with the right type.
  ['a', { num: '5' }, 'integer', 5n],
  ['a', { num: '+5' }, 'integer', 5n],
  ['a', { num: '-17' }, 'integer', -17n],
  ['a', { num: '5.0' }, 'real', 5],
  ['a', { num: '1e3' }, 'real', 1000],
  ['a', { num: '.5' }, 'real', 0.5],
  ['a', 5, 'integer', 5n],
  ['a', 5.5, 'real', 5.5],
  ['a', '5', 'text', '5'],
  ['a', '', 'text', ''],
  ['a', null, 'null', null],
  ['a', { hex: '00ff10' }, 'blob', "x'00ff10'"],
  // 64-bit integers keep every digit, typed or echoed.
  ['a', { num: '9223372036854775807' }, 'integer', 9223372036854775807n],
  ['a', { num: '-9223372036854775808' }, 'integer', -9223372036854775808n],
  ['a', { num: '9007199254740993' }, 'integer', 9007199254740993n],
  ['a', { int: '-9007199254740993' }, 'integer', -9007199254740993n],
  // One more than fits is a real, as it is for SQLite.
  ['a', { num: '9223372036854775808' }, 'real', 2 ** 63],
  // Columns with a type convert as SQLite does.
  ['i', { num: '42' }, 'integer', 42n],
  ['i', { num: '1e3' }, 'integer', 1000n],
  ['i', { num: '2.5' }, 'real', 2.5],
  ['i', '42', 'integer', 42n],
  ['i', 'abc', 'text', 'abc'],
  ['i', { num: '9007199254740993' }, 'integer', 9007199254740993n],
  ['r', { num: '5' }, 'real', 5],
  ['r', { num: '9007199254740993' }, 'real', 9007199254740992],
  ['n', { num: '5' }, 'integer', 5n],
  ['n', { num: '5.5' }, 'real', 5.5],
  ['t', '007', 'text', '007'],
  ['t', ' 5 ', 'text', ' 5 '],
  ['b', { num: '5' }, 'integer', 5n],
];

test('save: inserted values arrive with the type they were typed as', () => {
  const file = make('CREATE TABLE typed (id INTEGER PRIMARY KEY, i INTEGER, r REAL, t TEXT, n NUMERIC, a, b BLOB)');
  db.save(file, TYPED.map(([column, value]) => ({ table: 'typed', kind: 'insert', values: [[column, value]] })));
  const stored = exact(file, `SELECT ${['i', 'r', 't', 'n', 'a', 'b'].map((c) => `typeof(${c}), ${c}`).join(', ')} FROM typed ORDER BY id`);
  TYPED.forEach(([column, value, type, expected], row) => {
    const at = ['i', 'r', 't', 'n', 'a', 'b'].indexOf(column) * 2;
    assert.deepEqual(stored[row].slice(at, at + 2), [type, expected], `${column} = ${JSON.stringify(value)}`);
  });
});

test('save: updated values arrive with the type they were typed as', () => {
  const file = make(`CREATE TABLE typed (id INTEGER PRIMARY KEY, i INTEGER, r REAL, t TEXT, n NUMERIC, a, b BLOB); INSERT INTO typed (id) VALUES (1)`);
  for (const [column, value, type, expected] of TYPED) {
    db.save(file, [{ table: 'typed', kind: 'update', key: [1], values: [[column, value]] }]);
    assert.deepEqual(exact(file, `SELECT typeof(${column}), ${column} FROM typed`), [[type, expected]], `${column} = ${JSON.stringify(value)}`);
  }
});

test('save: a generated column refuses a value, and the row keeps the value it computes', () => {
  const file = make('CREATE TABLE gen (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) STORED); INSERT INTO gen VALUES (1)');
  assert.throws(() => db.save(file, [{ table: 'gen', kind: 'update', key: [1], values: [['a', { num: '5' }], ['b', { num: '7' }]] }]), /generated column/);
  db.save(file, [{ table: 'gen', kind: 'update', key: [1], values: [['a', { num: '5' }]] }]);
  assert.deepEqual(all(file, 'SELECT a, b FROM gen'), [[5, 10]]);
});

test('save: foreign key actions run', () => {
  const file = copy(SHOP);
  const orders = all(file, 'SELECT COUNT(*) FROM orders WHERE customer_id = 40')[0][0] as number;
  assert.ok(orders > 0);
  db.save(file, [
    // Nobody refers to customer 40 but its orders, which go with it.
    { table: 'customers', kind: 'delete', key: [40] },
    // ON UPDATE CASCADE
    { table: 'countries', kind: 'update', key: ['JP'], values: [['code', 'NI']] },
  ]);
  assert.deepEqual(all(file, 'SELECT COUNT(*) FROM orders WHERE customer_id = 40'), [[0]]);
  assert.deepEqual(all(file, "SELECT COUNT(*) FROM customers WHERE country = 'JP'"), [[0]]);
  assert.deepEqual(all(file, "SELECT COUNT(*) FROM customers WHERE country = 'NI'"), [[Array.from({ length: CUSTOMERS - 1 }, (_, i) => i + 1).filter((i) => i % 7 && i % 4 === 2).length]]);
});

test('save: a file that is gone is not created again', () => {
  const file = newFile();
  assert.throws(() => db.save(file, [{ table: 'log', kind: 'insert', values: [] }]), /no longer exists/);
  assert.throws(() => db.schema(file), /no longer exists/);
  assert.throws(() => db.query(file, 'CREATE TABLE t (a)'), /no longer exists/);
  assert.ok(!fs.existsSync(file));
});

test('save: a WAL database is written beside another connection, which sees the change', () => {
  const file = copy(WAL);
  const other = new DatabaseSync(file);
  try {
    // The row stays in the write-ahead log, where a reader has to find it.
    other.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO log VALUES ('wal', 'only in the wal')");
    assert.ok(fs.statSync(`${file}-wal`).size > 0);
    assert.deepEqual(db.rows(file, 'log', ALL).rows.map((row) => row.cells), [['wal', 'only in the wal']]);
    assert.equal(db.count(file, 'log'), 1);
    db.save(file, [
      { table: 'log', kind: 'update', key: keyOf(db.rows(file, 'log', ALL).rows[0]), values: [['what', 'changed']] },
      { table: 'log', kind: 'insert', values: [['at', 'saved']] },
    ]);
    assert.deepEqual(other.prepare('SELECT at, what FROM log ORDER BY rowid').all().map((row) => Object.values(row)), [['wal', 'changed'], ['saved', null]]);
    assert.deepEqual(Object.values(other.prepare('PRAGMA journal_mode').get() ?? {}), ['wal']);
  } finally {
    other.close();
  }
});

// ---- query(): reading and writing -----------------------------------------------

test('query: one statement returns its columns and rows, and how to read them again', () => {
  const sql = 'SELECT id, name FROM customers WHERE id < 4';
  const r = db.query(SHOP, sql);
  assert.equal(r.error, null);
  assert.deepEqual(r.columns, ['id', 'name']);
  assert.deepEqual(r.rows, [[1, 'User 1'], [2, 'User 2'], [3, 'User 3']]);
  assert.equal(r.wrote, false);
  assert.equal(r.truncated, false);
  assert.equal(r.rolledBack, -1);
  assert.deepEqual(r.source, { sql, index: 0 });
  assert.deepEqual(r.statements.map((s) => [s.sql, s.rows, s.changes, s.truncated]), [[sql, 3, null, false]]);
});

for (const [name, template] of [['a rollback-journal', SHOP], ['a WAL', WAL]] as const) {
  test(`query: a script that only reads leaves ${name} database file untouched`, () => {
    const file = copy(template);
    const old = new Date(Date.UTC(2020, 0, 1));
    fs.utimesSync(file, old, old);
    const before = fs.readFileSync(file);
    const r = db.query(file, "SELECT COUNT(*) FROM orders; CREATE TEMP TABLE picks AS SELECT id FROM customers; SELECT * FROM picks; PRAGMA table_info('orders'); BEGIN; SELECT 1; COMMIT");
    assert.equal(r.error, null);
    assert.equal(r.wrote, false);
    assert.equal(r.statements.length, 7);
    assert.ok(fs.readFileSync(file).equals(before));
    assert.equal(fs.statSync(file).mtimeMs, old.getTime());
    db.rows(file, 'customers', ALL);
    db.schema(file);
    db.exportRows(file, { table: 'customers', sort: null, filter: '' }, 'csv', newFile('csv'), { progress: () => undefined, cancelled: () => false });
    assert.equal(fs.statSync(file).mtimeMs, old.getTime());
  });
}

test('query: a script that writes is run once, from its beginning, on a connection that may', () => {
  const file = copy(SHOP);
  // The first attempt is read-only and fails at the second statement. Had the first one counted then, it would say 0.
  const r = db.query(file, "CREATE TEMP TABLE seen AS SELECT COUNT(*) AS n FROM log; INSERT INTO log VALUES ('q', 'one'); INSERT INTO log VALUES ('q', 'two'); SELECT (SELECT n FROM seen), COUNT(*) FROM log");
  assert.equal(r.error, null);
  assert.equal(r.wrote, true);
  assert.deepEqual(r.rows, [[0, 2]]);
  assert.deepEqual(all(file, 'SELECT what FROM log ORDER BY rowid'), [['one'], ['two']]);
});

test('query: each statement says the rows it returned or changed, and the last result set is shown', () => {
  const file = copy(SHOP);
  const orders = all(file, 'SELECT COUNT(*) FROM orders WHERE customer_id = 40')[0][0] as number;
  const r = db.query(
    file,
    [
      'SELECT 1 AS a',
      'SELECT 2 AS b, 3 AS c',
      'CREATE TABLE made (x)',
      'INSERT INTO made VALUES (1), (2), (3)',
      'UPDATE made SET x = x WHERE 0',
      // A trigger writes one log row for the order.
      'INSERT INTO orders (id, customer_id) VALUES (500, 1)',
      // The orders of the customer go with it.
      'DELETE FROM customers WHERE id = 40',
      'DROP TABLE made',
      "SELECT 'x' AS d WHERE 0",
    ].join(';\n'),
  );
  assert.equal(r.error, null);
  assert.deepEqual(
    r.statements.map((s) => [s.rows, s.changes]),
    [[1, null], [1, null], [null, null], [null, 3], [null, 0], [null, 2], [null, 1 + orders], [null, null], [0, null]],
  );
  assert.equal(r.shown, 8);
  assert.deepEqual(r.columns, ['d']);
  assert.deepEqual(r.rows, []);
  assert.equal(r.wrote, true);
});

test('query: values cross as Wire', () => {
  const r = db.query(SHOP, 'SELECT big, bio, token, 1.5, NULL FROM customers WHERE id IN (2, 3) ORDER BY id');
  assert.deepEqual(r.rows[0], [{ int: '9223372036854775807' }, 'bio 2', { blob: 16, hex: token(2).toString('hex') }, 1.5, null]);
  // More of a text than the grid shows, since a result has no cell to open.
  assert.equal(r.rows[1][1], LONG);
  const cut = db.query(SHOP, "SELECT printf('%.*c', 30000, 'x')").rows[0][0] as { text: string; more: true };
  assert.equal(cut.more, true);
  assert.ok(cut.text.length >= LONG.length && cut.text.length < 30000 && /^x+$/.test(cut.text));
  const blob = db.query(SHOP, 'SELECT data FROM files WHERE id = 1').rows[0][0];
  assert.deepEqual(blob, { blob: 10000, hex: BIG_BLOB.subarray(0, 16).toString('hex') });
});

test('query: columns that share a name stay apart', () => {
  const r = db.query(SHOP, 'SELECT c.id, o.id, 1 AS id FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.id = 5');
  assert.deepEqual(r.columns, ['id', 'id', 'id']);
  assert.deepEqual(r.rows, [[customerOf(5), 5, 1]]);
});

test('query: the first 1000 rows are shown, and a result cut short does not lock what follows', () => {
  const file = copy(SHOP);
  const r = db.query(file, 'SELECT o.id FROM orders o, customers; CREATE TABLE after_cut AS SELECT 1 AS a; DROP TABLE after_cut; SELECT id FROM orders');
  assert.equal(r.error, null);
  assert.deepEqual([r.statements[0].rows, r.statements[0].truncated], [1000, true]);
  assert.equal(r.rows.length, ORDERS + 2);
  assert.equal(r.truncated, false);
  const cut = db.query(file, 'SELECT o.id FROM orders o, customers');
  assert.equal(cut.rows.length, 1000);
  assert.equal(cut.truncated, true);
});

// ---- query(): where a statement ends --------------------------------------------

test('query: semicolons in strings, quoted names, comments and a trigger body end no statement', () => {
  const file = copy(SHOP);
  const sql = [
    '-- a comment; with a semicolon',
    '/* another; one\n   over lines; */ ;;  ;',
    'CREATE TABLE "semi;colon" ("a;b" TEXT, [c;d] TEXT, `e;f` TEXT); -- trailing; comment',
    `INSERT INTO "semi;colon" VALUES ('it''s; here', 'x /* not a comment */ ; y', '-- nor this;');`,
    'CREATE TRIGGER "trg;1" AFTER INSERT ON "semi;colon"',
    'BEGIN',
    "  INSERT INTO log VALUES ('t', 'a;b'); -- inside; the trigger",
    `  UPDATE log SET what = what || ';' WHERE at = 't' AND CASE WHEN new."a;b" = 'END;' THEN 1 ELSE 1 END;`,
    '  /* END; */',
    "  SELECT CASE WHEN 1 THEN 'END' END;",
    'END;',
    `INSERT INTO "semi;colon" ("a;b") VALUES ('second;')`,
    ';',
    'SELECT "a;b" AS "col;umn", [c;d], `e;f` FROM "semi;colon" ORDER BY rowid /* tail */ -- end',
  ].join('\n');
  const r = db.query(file, sql);
  assert.equal(r.error, null);
  assert.deepEqual(
    r.statements.map((s) => s.sql.split('\n')[0]),
    [
      'CREATE TABLE "semi;colon" ("a;b" TEXT, [c;d] TEXT, `e;f` TEXT);',
      `INSERT INTO "semi;colon" VALUES ('it''s; here', 'x /* not a comment */ ; y', '-- nor this;');`,
      'CREATE TRIGGER "trg;1" AFTER INSERT ON "semi;colon"',
      `INSERT INTO "semi;colon" ("a;b") VALUES ('second;')`,
      'SELECT "a;b" AS "col;umn", [c;d], `e;f` FROM "semi;colon" ORDER BY rowid /* tail */ -- end',
    ],
  );
  assert.ok(r.statements[2].sql.endsWith('END;'));
  assert.deepEqual(r.columns, ['col;umn', 'c;d', 'e;f']);
  assert.deepEqual(r.rows, [["it's; here", 'x /* not a comment */ ; y', '-- nor this;'], ['second;', null, null]]);
  // The trigger is whole: it logged the second insert and ran its update.
  assert.deepEqual(all(file, "SELECT what FROM log WHERE at = 't'"), [['a;b;']]);
});

test('query: a byte order mark, CRLF, text beyond ASCII and a missing last semicolon', () => {
  const r = db.query(SHOP, `﻿SELECT 'é😀ж' AS "ключ😀";\r\n\r\nSELECT 2 AS two\r\n`);
  assert.equal(r.error, null);
  assert.deepEqual(r.statements.map((s) => s.sql), [`SELECT 'é😀ж' AS "ключ😀";`, 'SELECT 2 AS two\r\n']);
  assert.deepEqual(r.rows, [[2]]);
  assert.deepEqual(db.query(SHOP, `SELECT 'é😀ж' AS "ключ😀"`).rows, [['é😀ж']]);
  assert.deepEqual(db.query(SHOP, `SELECT 'é😀ж' AS "ключ😀"`).columns, ['ключ😀']);
});

test('query: comments and blanks alone are no statement', () => {
  const r = db.query(SHOP, ' -- nothing\n /* at all */ ;; \n');
  assert.deepEqual([r.statements.length, r.error, r.shown, r.source, r.wrote], [0, null, -1, null, false]);
  assert.deepEqual(db.query(SHOP, '').statements, []);
});

test('query: a statement that ends exactly where a piece of the script ends', () => {
  // The script is handed to SQLite 16 K characters at a time, and the first statement ends around that mark.
  for (const delta of [-2, -1, 0, 1, 2]) {
    for (const tail of ['SELECT 2 AS b', ' SELECT 2 AS b;', '', ';', ' -- c']) {
      const first = `SELECT '${'a'.repeat(16384 + delta - 10)}';`;
      assert.equal(first.length, 16384 + delta);
      const r = db.query(SHOP, first + tail);
      const label = `${delta} ${JSON.stringify(tail)}`;
      assert.equal(r.error, null, label);
      assert.equal(r.statements.length, tail.includes('SELECT') ? 2 : 1, label);
      assert.deepEqual(r.rows, tail.includes('SELECT') ? [[2]] : [[{ text: 'a'.repeat(2000), more: true }]], label);
      // A statement is named by its beginning, not sent back whole.
      assert.ok(r.statements[0].sql.length < 1000 && first.startsWith(r.statements[0].sql), label);
    }
  }
});

test('query: a string, a comment and a trigger cut by the end of a piece', () => {
  const file = copy(SHOP);
  const pad = 'x'.repeat(16300);
  let r = db.query(file, `SELECT 1; SELECT '${pad}; SELECT ''no'';' AS s, 2 AS two; SELECT 3 AS three`);
  assert.equal(r.error, null);
  assert.deepEqual([r.statements.length, r.columns], [3, ['three']]);
  r = db.query(file, `SELECT 1 /* ${pad}; SELECT 9; ${pad} */ AS one; -- ${pad}; SELECT 9\nSELECT 2 AS two`);
  assert.equal(r.error, null);
  assert.deepEqual([r.statements.length, r.rows], [2, [[2]]]);
  r = db.query(file, `CREATE TABLE tt (a); CREATE TRIGGER big AFTER INSERT ON tt BEGIN SELECT '${pad}'; SELECT '${pad}'; INSERT INTO tt SELECT 1 WHERE 0; END; INSERT INTO tt VALUES (1); SELECT COUNT(*) FROM tt; DROP TABLE tt`);
  assert.equal(r.error, null);
  assert.deepEqual([r.statements.length, r.rows], [5, [[1]]]);
});

test('query: an emoji or a lone surrogate at the end of a piece does not shift what follows', () => {
  for (const lead of [16380, 16381, 16382, 16383]) {
    const r = db.query(SHOP, `SELECT '${'b'.repeat(lead - 8)}😀' AS e; SELECT 'ok' AS k`);
    assert.equal(r.error, null, String(lead));
    assert.deepEqual(r.rows, [['ok']], String(lead));
  }
  const r = db.query(SHOP, "SELECT '\ud800' AS a; SELECT 'ok' AS b");
  assert.deepEqual([r.statements.length, r.rows], [2, [['ok']]]);
});

test('query: a long script is cut in pieces without changing what it does', () => {
  const file = copy(SHOP);
  const count = 700;
  const parts = ['CREATE TABLE bulk (n INTEGER, t TEXT)'];
  let length = 0;
  for (let i = 0; i < count; i++) {
    parts.push(`INSERT INTO bulk VALUES (${i}, '${'p;'.repeat(i % 40)}—é😀')`);
    length += 2 * (i % 40) + 3;
  }
  // One statement far longer than the first piece SQLite is handed.
  parts.push(`INSERT INTO bulk VALUES (-1, '${"q'';''".repeat(20000)}')`);
  parts.push('SELECT COUNT(*), SUM(n), SUM(length(t)) FROM bulk');
  const sql = parts.join(';\n');
  assert.ok(sql.length > 16384 * 8);
  const r = db.query(file, sql);
  assert.equal(r.error, null);
  assert.equal(r.statements.length, count + 3);
  assert.deepEqual(r.rows, [[count + 1, (count * (count - 1)) / 2 - 1, length + 4 * 20000]]);

  // The same script with a mistake near its end, inside a transaction of its own.
  db.query(file, 'DROP TABLE bulk');
  const bad = db.query(file, `BEGIN;${sql.replace(`VALUES (${count - 1},`, `VALUES ${count - 1},`)}`);
  assert.equal(bad.error?.index, count + 1);
  assert.match(bad.error?.message ?? '', /syntax error/);
  assert.ok(bad.error?.sql.startsWith(`INSERT INTO bulk VALUES ${count - 1},`));
  assert.equal(bad.statements.length, count + 1);
  assert.equal(bad.rolledBack, 0);
  assert.deepEqual(all(file, "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'bulk'"), [[0]]);
});

// ---- query(): errors and transactions ---------------------------------------------

test('query: stops at the first error, keeps what ran before it and runs nothing after it', () => {
  const file = copy(SHOP);
  const r = db.query(file, "INSERT INTO log VALUES ('s', 'one');\nSELECT COUNT(*) AS n FROM log;\nINSERT INTO nope VALUES (1);\nINSERT INTO log VALUES ('s', 'never');");
  assert.deepEqual(r.error, { index: 2, message: 'no such table: nope', sql: 'INSERT INTO nope VALUES (1);' });
  assert.deepEqual(r.statements.map((s) => [s.rows, s.changes]), [[null, 1], [1, null]]);
  assert.equal(r.rolledBack, -1);
  assert.equal(r.wrote, true);
  // The result of the statement before the error is still the one shown.
  assert.equal(r.shown, 1);
  assert.deepEqual(r.rows, [[1]]);
  assert.deepEqual(all(file, 'SELECT what FROM log'), [['one']]);
});

test('query: a statement is compiled only when the ones before it ran', () => {
  const file = copy(SHOP);
  const r = db.query(file, 'CREATE TABLE made (x); INSERT INTO made VALUES (1), (2); ALTER TABLE made ADD COLUMN y DEFAULT 7; SELECT x, y FROM made; DROP TABLE made;');
  assert.equal(r.error, null);
  assert.deepEqual(r.rows, [[1, 7], [2, 7]]);
  assert.equal(r.shown, 3);
});

test('query: errors that SQLite finds while reading the script', () => {
  let r = db.query(SHOP, 'SELEC 1; SELECT 2');
  assert.deepEqual([r.error?.index, r.statements.length, r.wrote], [0, 0, false]);
  assert.match(r.error?.message ?? '', /syntax error/);
  r = db.query(SHOP, "SELECT 1; SELECT 'unterminated");
  assert.deepEqual([r.error?.index, r.shown], [1, 0]);
  assert.match(r.error?.message ?? '', /unrecognized token/);
  r = db.query(SHOP, 'CREATE TRIGGER t9 AFTER INSERT ON log BEGIN SELECT 1;');
  assert.match(r.error?.message ?? '', /incomplete input/);
  r = db.query(SHOP, 'SELECT 1;\0SELECT 2');
  assert.equal(r.error?.index, 1);
  assert.match(r.error?.message ?? '', /NUL/);
});

test('query: a transaction left open is rolled back and reported', () => {
  const file = copy(SHOP);
  const before = dump(file);
  const r = db.query(file, "SELECT 1; BEGIN; INSERT INTO log VALUES ('s3', 'x'); SELECT COUNT(*) FROM log");
  assert.equal(r.error, null);
  assert.equal(r.rolledBack, 1);
  // The script saw its own insert.
  assert.deepEqual(r.rows, [[1]]);
  assert.equal(dump(file), before);
  // A script that only reads says so too.
  const read = db.query(file, 'BEGIN; SELECT 1');
  assert.deepEqual([read.wrote, read.rolledBack], [false, 0]);
});

test("query: an error inside the script's own transaction rolls it back, and what was committed before stays", () => {
  const file = copy(SHOP);
  const r = db.query(file, "INSERT INTO log VALUES ('s2', 'kept');\nBEGIN;\nINSERT INTO log VALUES ('s2', 'undone');\nINSERT INTO strict_t (id, n) VALUES (50, 'not a number');\nCOMMIT;");
  assert.equal(r.error?.index, 3);
  assert.match(r.error?.message ?? '', /cannot store TEXT value in INTEGER column/);
  assert.equal(r.rolledBack, 1);
  assert.deepEqual(all(file, 'SELECT what FROM log'), [['kept']]);
});

test('query: transactions the script ends itself are not reported', () => {
  const file = copy(SHOP);
  let r = db.query(file, "BEGIN IMMEDIATE; INSERT INTO log VALUES ('s4', 'a'); SAVEPOINT sp; INSERT INTO log VALUES ('s4', 'b'); ROLLBACK TO sp; RELEASE sp; COMMIT; BEGIN; INSERT INTO log VALUES ('s4', 'c'); ROLLBACK;");
  assert.equal(r.error, null);
  assert.equal(r.rolledBack, -1);
  assert.equal(r.statements.length, 10);
  assert.deepEqual(all(file, 'SELECT what FROM log'), [['a']]);
  // A second transaction, left open, is named by its own BEGIN.
  r = db.query(file, "BEGIN; INSERT INTO log VALUES ('s5', 'a'); COMMIT; SELECT 1; BEGIN; INSERT INTO log VALUES ('s5', 'b')");
  assert.equal(r.rolledBack, 4);
  assert.deepEqual(all(file, "SELECT what FROM log WHERE at = 's5'"), [['a']]);
});

test('query: a transaction that the error itself ended is not said to be rolled back by the run', () => {
  const file = make('CREATE TABLE u (a UNIQUE); INSERT INTO u VALUES (1)');
  const r = db.query(file, 'BEGIN; INSERT INTO u VALUES (2); INSERT OR ROLLBACK INTO u VALUES (1); COMMIT');
  assert.equal(r.error?.index, 2);
  assert.equal(r.rolledBack, -1);
  assert.deepEqual(all(file, 'SELECT a FROM u'), [[1]]);
});

test('query: foreign keys are enforced, and a PRAGMA can turn them off for the run', () => {
  const file = copy(SHOP);
  let r = db.query(file, 'INSERT INTO orders (id, customer_id) VALUES (9100, 123456)');
  assert.match(r.error?.message ?? '', /FOREIGN KEY constraint failed/);
  r = db.query(file, 'PRAGMA foreign_keys = OFF; INSERT INTO orders (id, customer_id) VALUES (9100, 123456); PRAGMA foreign_keys');
  assert.equal(r.error, null);
  assert.deepEqual(r.rows, [[0]]);
  assert.deepEqual(all(file, 'SELECT customer_id FROM orders WHERE id = 9100'), [[123456]]);
});

// ---- query(): reading a result again ----------------------------------------------

const JOB: db.Job = { progress: () => undefined, cancelled: () => false };
const readCsv = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\r\n');

test('query: after a read-only script the source is the script up to the statement, temporary table included', () => {
  const sql = "CREATE TEMP TABLE picks AS SELECT id, big FROM customers WHERE id IN (2, 4);\nSELECT 'skipped';\nSELECT p.id, p.big, c.token FROM picks p JOIN customers c USING (id) ORDER BY 1;\nSELECT 'after'";
  const r = db.query(SHOP, sql);
  assert.equal(r.error, null);
  assert.equal(r.wrote, false);
  assert.deepEqual(r.source, { sql, index: 3 });
  const target = newFile('csv');
  assert.deepEqual(db.exportRows(SHOP, r.source as db.ResultSource, 'csv', target, JOB), { rows: 1, cancelled: false });
  assert.deepEqual(readCsv(target), ["'after'", 'after', '']);

  // An earlier result set of the same script, as the page asks for it when the script ends there.
  const third = db.query(SHOP, sql.slice(0, sql.indexOf("SELECT 'after'")));
  assert.equal(third.source?.index, 2);
  db.exportRows(SHOP, third.source as db.ResultSource, 'csv', target, JOB);
  assert.deepEqual(readCsv(target), ['id,big,token', `2,9223372036854775807,X'${token(2).toString('hex').toUpperCase()}'`, `4,-9007199254740993,X'${token(4).toString('hex').toUpperCase()}'`, '']);
  const blob = db.blob(SHOP, { ...(third.source as db.ResultSource), row: 1, column: 2 }, false);
  assert.deepEqual([Buffer.from(blob.bytes).toString('hex'), blob.size, blob.complete], [token(4).toString('hex'), 16, true]);

  // The result shown is not always the last statement, and what follows it is not needed to get it again.
  assert.deepEqual(db.query(SHOP, 'SELECT 1 AS a; CREATE TEMP TABLE later (x)').source, { sql: 'SELECT 1 AS a;', index: 0 });
});

test('query: after a script that wrote, the source is the one statement, and none when that statement wrote', () => {
  const file = copy(SHOP);
  let r = db.query(file, "INSERT INTO log VALUES ('r', 'x'); SELECT what FROM log; ");
  assert.deepEqual(r.source, { sql: 'SELECT what FROM log;', index: 0 });
  const target = newFile('csv');
  db.exportRows(file, r.source as db.ResultSource, 'csv', target, JOB);
  assert.deepEqual(readCsv(target), ['what', 'x', '']);

  r = db.query(file, "INSERT INTO log VALUES ('r', 'y'), ('r', 'z') RETURNING what");
  assert.deepEqual(r.rows, [['y'], ['z']]);
  assert.equal(r.statements[0].changes, 2);
  assert.equal(r.source, null);
});

test('query: reading a result again can never write', () => {
  const file = copy(SHOP);
  const before = dump(file);
  const folder = path.join(dir, 'never');
  fs.mkdirSync(folder);
  const target = path.join(folder, 'never.csv');
  assert.throws(() => db.exportRows(file, { sql: "INSERT INTO log VALUES ('e', 'x'); SELECT 1", index: 1 }, 'csv', target, JOB), /readonly database/);
  assert.throws(() => db.exportRows(file, { sql: "INSERT INTO log VALUES ('e', 'x') RETURNING what", index: 0 }, 'csv', target, JOB), /readonly database/);
  assert.throws(() => db.exportRows(file, { sql: 'SELECT 1; DELETE FROM log', index: 1 }, 'csv', target, JOB), /no result to export|readonly database/);
  assert.throws(() => db.blob(file, { sql: 'DELETE FROM files RETURNING data', index: 0, row: 0, column: 0 }, true), /readonly database/);
  // A source that names a statement the script doesn't have.
  assert.throws(() => db.exportRows(file, { sql: 'SELECT 1', index: 1 }, 'csv', target, JOB), /can't be run a second time/);
  assert.equal(dump(file), before);
  assert.deepEqual(fs.readdirSync(folder), []);
});

// ---- rows(), count(), cell() --------------------------------------------------------

test('rows: a page of a table, with the key of every row and the number of all rows', () => {
  const page = db.rows(SHOP, 'customers', { offset: 10, limit: 5, sort: null, filter: '' });
  assert.equal(page.total, CUSTOMERS + 1);
  assert.deepEqual(page.rows.map((row) => [row.key, row.cells[0], row.cells[2]]), [11, 12, 13, 14, 15].map((id) => [[id], id, `User ${id}`]));
  assert.equal(page.table.name, 'customers');
  const last = db.rows(SHOP, 'customers', { offset: 40, limit: 5, sort: null, filter: '' });
  assert.deepEqual(last.rows.map((row) => row.key), [[900]]);
  assert.equal(db.rows(SHOP, 'customers', { offset: 500, limit: 5, sort: null, filter: '' }).rows.length, 0);
  assert.throws(() => db.rows(SHOP, 'nowhere', ALL), /no table "nowhere"/);
});

test('rows: sorted by a column, either way', () => {
  for (const desc of [false, true]) {
    const page = db.rows(SHOP, 'customers', { offset: 3, limit: 7, sort: { column: 'name', desc }, filter: '' });
    const expected = all(SHOP, `SELECT id FROM customers ORDER BY name ${desc ? 'DESC' : 'ASC'} LIMIT 7 OFFSET 3`).map(([id]) => id);
    assert.deepEqual(page.rows.map((row) => row.cells[0]), expected);
    assert.equal(page.total, CUSTOMERS + 1);
  }
  // By value, not as text: 2^63 - 1 is the largest and -(2^53 + 1) the smallest.
  const big = db.rows(SHOP, 'customers', { ...ALL, sort: { column: 'big', desc: true } });
  assert.deepEqual([big.rows[0].cells[0], big.rows[CUSTOMERS].cells[0]], [2, 4]);
  // A name that needs quoting.
  assert.equal(db.rows(SHOP, 'odd name', { ...ALL, sort: { column: 'quo"te', desc: true } }).rows.length, 1);
});

test('rows: the filter keeps the rows that contain the text in any column, taken literally', () => {
  const file = make(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, a TEXT, b TEXT);
    INSERT INTO notes VALUES (1, '100% sure', NULL), (2, '1000 times', 'x'), (3, 'snake_case', 'X'), (4, 'snakeXcase', NULL), (5, 'back\\slash', '50'), (6, NULL, 'Sure, 100%');
  `);
  const ids = (filter: string) => db.rows(file, 'notes', { ...ALL, filter }).rows.map((row) => row.cells[0]);
  assert.deepEqual(ids('100%'), [1, 6]);
  assert.deepEqual(ids('e_c'), [3]);
  assert.deepEqual(ids('k\\s'), [5]);
  // Any column, numbers included, without regard to the case of ASCII letters.
  assert.deepEqual(ids('sure'), [1, 6]);
  assert.deepEqual(ids('5'), [5]);
  assert.deepEqual(ids('x'), [2, 3, 4]);
  assert.deepEqual(ids('  times '), [2]);
  assert.deepEqual(ids('nothing like it'), []);
  const page = db.rows(file, 'notes', { offset: 1, limit: 1, sort: { column: 'id', desc: true }, filter: 'x' });
  assert.deepEqual([page.rows.map((row) => row.cells[0]), page.total], [[3], 3]);
});

test('rows: a view has rows and no keys', () => {
  const page = db.rows(SHOP, 'active_customers', { ...ALL, sort: { column: 'id', desc: false } });
  const expected = all(SHOP, 'SELECT id, name, country FROM active_customers ORDER BY id');
  assert.deepEqual(page.rows.map((row) => row.cells), expected);
  assert.ok(page.rows.every((row) => row.key === null));
  assert.equal(page.total, expected.length);
});

// The values of one column, in rowid order, and what the grid gets for each.
const WIRE: [SQLInputValue, db.Wire][] = [
  [9007199254740991n, 9007199254740991],
  [9007199254740992n, { int: '9007199254740992' }],
  [-9007199254740991n, -9007199254740991],
  [-9007199254740992n, { int: '-9007199254740992' }],
  [9223372036854775807n, { int: '9223372036854775807' }],
  [-9223372036854775808n, { int: '-9223372036854775808' }],
  ['t'.repeat(300), 't'.repeat(300)],
  ['t'.repeat(301), { text: 't'.repeat(300), more: true }],
  [LONG, { text: LONG.slice(0, 300), more: true }],
  ['', ''],
  [Buffer.from('00112233445566778899aabbccddeeff', 'hex'), { blob: 16, hex: '00112233445566778899aabbccddeeff' }],
  [Buffer.from('00112233445566778899aabbccddeeff0102', 'hex'), { blob: 18, hex: '00112233445566778899aabbccddeeff' }],
  [BIG_BLOB, { blob: 10000, hex: BIG_BLOB.subarray(0, 16).toString('hex') }],
  [1.5, 1.5],
  [-0.25, -0.25],
  [null, null],
];

test('rows: values cross as Wire, with big integers, long texts and blobs cut down', () => {
  const file = make('CREATE TABLE w (id INTEGER PRIMARY KEY, v)');
  open(file, (conn) => WIRE.forEach(([value]) => conn.prepare('INSERT INTO w (v) VALUES (?)').run(value)));
  const page = db.rows(file, 'w', ALL);
  assert.deepEqual(page.rows.map((row) => row.cells[1]), WIRE.map(([, wire]) => wire));
});

test('rows: an empty blob is a blob', () => {
  // substr(x'', 1, 16) is NULL in SQLite, and that is how the first bytes are asked for.
  const file = make("CREATE TABLE e (id INTEGER PRIMARY KEY, v); INSERT INTO e (v) VALUES (x''), (NULL), (''), (zeroblob(0)); CREATE VIEW ev AS SELECT v FROM e");
  const empty = { size: 0, bytes: new Uint8Array(0), complete: true };
  assert.deepEqual(db.query(file, 'SELECT v FROM e').rows, [[{ blob: 0, hex: '' }], [null], [''], [{ blob: 0, hex: '' }]]);
  assert.deepEqual(db.rows(file, 'e', ALL).rows.map((row) => row.cells[1]), [{ blob: 0, hex: '' }, null, '', { blob: 0, hex: '' }]);
  for (const full of [true, false]) {
    // By row key, by position (a view has no keys), and in a query result.
    assert.deepEqual(db.blob(file, { table: 'e', key: [1], column: 'v' }, full), empty);
    assert.deepEqual(db.blob(file, { table: 'ev', offset: 3, column: 'v', sort: null, filter: '' }, full), empty);
    assert.deepEqual(db.blob(file, { sql: 'SELECT v FROM e', index: 0, row: 0, column: 0 }, full), empty);
  }
  // What is no blob is still none: NULL and the empty text.
  assert.throws(() => db.blob(file, { table: 'e', key: [2], column: 'v' }, true), /no longer holds a blob/);
  assert.throws(() => db.blob(file, { table: 'e', key: [3], column: 'v' }, true), /no longer holds a blob/);
  const target = newFile('bin');
  assert.equal(db.saveBlob(file, { table: 'e', key: [1], column: 'v' }, target), 0);
  assert.equal(fs.statSync(target).size, 0);
});

test('rows: every value survives the trip to the page as JSON, infinity included', () => {
  const file = make('CREATE TABLE w (id INTEGER PRIMARY KEY, v)');
  open(file, (conn) => [...WIRE.map(([value]) => value), Infinity, -Infinity].forEach((value) => conn.prepare('INSERT INTO w (v) VALUES (?)').run(value)));
  for (const cells of [db.rows(file, 'w', ALL).rows.map((row) => row.cells[1]), db.query(file, 'SELECT v FROM w').rows.map((row) => row[0])]) {
    assert.deepEqual(JSON.parse(JSON.stringify(cells)), cells);
    assert.ok(cells.slice(-2).every((value) => value !== null));
    assert.notDeepEqual(cells[cells.length - 2], cells[cells.length - 1]);
  }
});

test('count: the rows of a table or a view', () => {
  assert.equal(db.count(SHOP, 'customers'), CUSTOMERS + 1);
  assert.equal(db.count(SHOP, 'odd name'), 1);
  assert.equal(db.count(SHOP, 'active_customers'), all(SHOP, 'SELECT COUNT(*) FROM customers WHERE country IS NOT NULL')[0][0]);
  assert.equal(db.count(SHOP, 'log'), 0);
});

test('cell: the complete value the grid showed the beginning of', () => {
  const page = db.rows(SHOP, 'customers', ALL);
  const row = rowWith(page, 'id', 3);
  assert.deepEqual(row.cells[6], { text: LONG.slice(0, 300), more: true });
  assert.equal(db.cell(SHOP, 'customers', keyOf(row), 'bio'), LONG);
  assert.deepEqual(db.cell(SHOP, 'customers', [2], 'big'), { int: '9223372036854775807' });
  assert.equal(db.cell(SHOP, 'products', ['C3', 'US'], 'title'), 'Crate; large');
  assert.equal(db.cell(SHOP, 'odd name', [1], 'quo"te'), 'q');
  assert.throws(() => db.cell(SHOP, 'customers', [4040], 'bio'), /row no longer exists/);
  assert.throws(() => db.cell(SHOP, 'customers', [3], 'nope'), /could not be found/);
  assert.throws(() => db.cell(SHOP, 'active_customers', [3], 'name'), /could not be found/);
});

// ---- Following a foreign key: rows narrowed to a value ----------------------------------

const follow = (table: string, columns: string[], values: db.Input[], more: Partial<db.RowsOptions> = {}) => db.rows(SHOP, table, { ...ALL, match: { columns, values }, ...more });
const ids = (page: { rows: db.Row[] }) => page.rows.map((row) => row.cells[0]);

test('match: a key to a rowid, to a unique column in another case, and of several columns', () => {
  assert.deepEqual([ids(follow('customers', ['id'], [5])), follow('customers', ['id'], [5]).total], [[5], 1]);
  assert.deepEqual(ids(follow('customers', ['EMAIL'], ['user17@example.com'])), [17]);
  const product = follow('products', ['sku', 'region'], ['A1', 'US']);
  assert.deepEqual([product.total, product.rows[0].key, product.rows[0].cells[3]], [1, ['A1', 'US'], 12]);
  assert.deepEqual(ids(follow('countries', ['code'], ['FR'])), ['FR']);
});

test('match: a dangling key and a NULL find nothing', () => {
  assert.equal(follow('customers', ['id'], [77777]).total, 0);
  assert.equal(follow('products', ['sku', 'region'], ['ZZ', 'EU']).total, 0);
  assert.equal(follow('countries', ['code'], ['ZZ']).total, 0);
  assert.equal(follow('products', ['sku', 'region'], ['A1', null]).total, 0);
  assert.equal(follow('customers', ['referrer'], [null]).total, 0);
});

test('match: the rows that refer to a row, with paging and sort on top', () => {
  const expected = Array.from({ length: ORDERS }, (_, i) => i + 1).filter((order) => customerOf(order) === 2);
  assert.ok(expected.length > 1);
  const page = follow('orders', ['customer_id'], [2]);
  assert.deepEqual([ids(page), page.total], [expected, expected.length]);
  const sorted = follow('orders', ['customer_id'], [2], { sort: { column: 'id', desc: true }, limit: 1, offset: 1 });
  assert.deepEqual([ids(sorted), sorted.total], [[expected[expected.length - 2]], expected.length]);
});

test('match: the filter narrows the rows that refer to a row further', () => {
  const expected = Array.from({ length: ORDERS }, (_, i) => i + 1).filter((order) => customerOf(order) === 1);
  const filtered = follow('orders', ['customer_id'], [1], { filter: 'user1@' });
  assert.deepEqual([ids(filtered), filtered.total], [expected, expected.length]);
  // Order 9002 refers to customer 1 as well and has no email.
  assert.deepEqual(ids(follow('orders', ['customer_id'], [1])), [...expected, 9002]);
});

test('match: a self-reference, both ways', () => {
  assert.deepEqual(ids(follow('customers', ['id'], [3])), [3]);
  assert.deepEqual(ids(follow('customers', ['referrer'], [3])), [5, 6]);
});

test('match: a blob, a 64-bit integer, a typed number and a long text as the value', () => {
  assert.deepEqual(ids(follow('customers', ['token'], [{ hex: token(1).toString('hex') }])), [1]);
  assert.deepEqual(ids(follow('customers', ['big'], [{ int: '9223372036854775807' }])), [2]);
  assert.deepEqual(ids(follow('customers', ['big'], [{ int: '-9007199254740993' }])), [4]);
  assert.deepEqual(ids(follow('customers', ['id'], [{ num: '8' }])), [8]);
  assert.deepEqual(ids(follow('docs', ['body'], [LONG])), [1]);
  // The value is compared the way the column compares: a text against an integer column.
  assert.deepEqual(ids(follow('customers', ['id'], ['5'])), [5]);
});

test('match: a column that is gone is said', () => {
  assert.throws(() => follow('customers', ['nope'], [1]), /no column "nope"/);
  assert.throws(() => follow('customers', [], []), /could not be followed/);
  assert.throws(() => follow('customers', ['id', 'name'], [1]), /could not be followed/);
});

// ---- blob() and saveBlob() ---------------------------------------------------------------

test('blob: by row key, the first 4096 bytes or all of it', () => {
  const head = db.blob(SHOP, { table: 'files', key: [1], column: 'data' }, false);
  assert.deepEqual([head.size, head.complete, head.bytes.length], [10000, false, 4096]);
  assert.ok(BIG_BLOB.subarray(0, 4096).equals(head.bytes));
  const whole = db.blob(SHOP, { table: 'files', key: [1], column: 'data' }, true);
  assert.deepEqual([whole.size, whole.complete], [10000, true]);
  assert.ok(BIG_BLOB.equals(whole.bytes));
  // A blob that fits in the first bytes is complete either way.
  const small = db.blob(SHOP, { table: 'products', key: ['A1', 'EU'], column: 'picture' }, false);
  assert.deepEqual([small.size, small.complete], [PNG.length, true]);
  assert.ok(PNG.equals(small.bytes));
});

test('blob: in a view, by position in the sorted rows or in the rows a key was followed to', () => {
  const at = (offset: number, more: Partial<db.RowsOptions> = {}) => db.blob(SHOP, { table: 'files_view', offset, column: 'data', sort: { column: 'id', desc: true }, filter: '', ...more }, true);
  // Sorted from the last row: NULL, the PNG, the 5000 bytes, the 10000 bytes.
  assert.ok(PNG.equals(at(1).bytes));
  assert.ok(MID_BLOB.equals(at(2).bytes));
  assert.ok(BIG_BLOB.equals(at(3).bytes));
  assert.throws(() => at(0), /no longer holds a blob/);
  assert.throws(() => at(4), /no longer holds a blob/);
  assert.ok(MID_BLOB.equals(at(0, { match: { columns: ['id'], values: [2] } }).bytes));
  assert.ok(BIG_BLOB.equals(at(0, { sort: null }).bytes));
});

test('blob: by position under a filter', () => {
  // Of the two anvils, the one for the US has a picture too, and it is the only row left.
  const product = db.blob(SHOP, { table: 'products', offset: 0, column: 'picture', sort: null, filter: 'US', match: { columns: ['sku'], values: ['A1'] } }, true);
  assert.deepEqual([product.size, product.complete], [PNG.length, true]);
  assert.throws(() => db.blob(SHOP, { table: 'products', offset: 1, column: 'picture', sort: null, filter: 'US', match: { columns: ['sku'], values: ['A1'] } }, true), /no longer holds a blob/);
});

test('blob: in the result of a statement, by row and column', () => {
  const source = { sql: "SELECT 'no blob'; SELECT id, big, data FROM files JOIN customers USING (id) ORDER BY id", index: 1 };
  assert.ok(MID_BLOB.equals(db.blob(SHOP, { ...source, row: 1, column: 2 }, true).bytes));
  const head = db.blob(SHOP, { ...source, row: 0, column: 2 }, false);
  assert.deepEqual([head.size, head.complete, head.bytes.length], [10000, false, 4096]);
  assert.throws(() => db.blob(SHOP, { ...source, row: 1, column: 1 }, true), /no longer holds a blob/);
  assert.throws(() => db.blob(SHOP, { ...source, row: 9, column: 2 }, true), /no longer holds a blob/);
});

test('blob: a cell that holds something else, or is gone', () => {
  assert.throws(() => db.blob(SHOP, { table: 'files', key: [4], column: 'data' }, true), /no longer holds a blob/);
  assert.throws(() => db.blob(SHOP, { table: 'files', key: [99], column: 'data' }, true), /no longer holds a blob/);
  assert.throws(() => db.blob(SHOP, { table: 'customers', key: [1], column: 'name' }, true), /no longer holds a blob/);
  assert.throws(() => db.blob(SHOP, { table: 'files', key: [1], column: 'nope' }, true), /could not be found/);
  assert.throws(() => db.blob(SHOP, { table: 'files_view', key: [1], column: 'data' }, true), /could not be found/);
});

test('blob: up to 16 MB comes whole, a larger one only as its beginning', () => {
  const limit = 16 * 1024 * 1024;
  const file = make(`CREATE TABLE huge (id INTEGER PRIMARY KEY, data BLOB); INSERT INTO huge VALUES (1, zeroblob(${limit})), (2, zeroblob(${limit + 1}))`);
  const fits = db.blob(file, { table: 'huge', key: [1], column: 'data' }, true);
  assert.deepEqual([fits.size, fits.complete, fits.bytes.length], [limit, true, limit]);
  const over = db.blob(file, { table: 'huge', key: [2], column: 'data' }, true);
  assert.deepEqual([over.size, over.complete, over.bytes.length], [limit + 1, false, 4096]);
  // Saving takes the blob as it is, whatever its size.
  const target = newFile('bin');
  assert.equal(db.saveBlob(file, { table: 'huge', key: [2], column: 'data' }, target), limit + 1);
  assert.equal(fs.statSync(target).size, limit + 1);
  fs.rmSync(target);
  fs.rmSync(file);
});

test('saveBlob: writes the whole blob to a file', () => {
  const target = newFile('bin');
  assert.equal(db.saveBlob(SHOP, { table: 'files', key: [1], column: 'data' }, target), 10000);
  assert.ok(BIG_BLOB.equals(fs.readFileSync(target)));
  assert.equal(db.saveBlob(SHOP, { table: 'files_view', offset: 1, column: 'data', sort: null, filter: '' }, target), 5000);
  assert.ok(MID_BLOB.equals(fs.readFileSync(target)));
  assert.throws(() => db.saveBlob(SHOP, { table: 'files', key: [4], column: 'data' }, newFile('bin')), /no longer holds a blob/);
});

// ---- schema() ------------------------------------------------------------------------------

test('schema: tables and views with their columns', () => {
  const schema = db.schema(SHOP);
  assert.equal(schema.size, fs.statSync(SHOP).size);
  assert.deepEqual(
    schema.tables.map((t) => [t.name, t.type]).sort(),
    [
      ...['countries', 'customers', 'docs', 'files', 'log', 'odd name', 'orders', 'products', 'sessions', 'strict_t'].map((name) => [name, 'table']),
      ['active_customers', 'view'],
      ['files_view', 'view'],
    ].sort(),
  );
  // The views come after the tables.
  assert.deepEqual(schema.tables.slice(-2).map((t) => t.type), ['view', 'view']);

  const orders = tableOf(SHOP, 'orders');
  assert.deepEqual(orders.columns.map((c) => c.name), ['id', 'customer_id', 'customer_email', 'sku', 'region', 'qty', 'note']);
  assert.deepEqual(orders.columns[0], { name: 'id', type: 'INTEGER', notnull: false, pk: 1, dflt: null, generated: false, affinity: 'numeric' });
  assert.deepEqual(orders.columns[5], { name: 'qty', type: 'INTEGER', notnull: true, pk: 0, dflt: '1', generated: false, affinity: 'numeric' });
  assert.deepEqual(tableOf(SHOP, 'products').columns.map((c) => c.pk), [1, 2, 0, 0, 0]);
  assert.deepEqual(tableOf(SHOP, 'odd name').columns.map((c) => c.name), ['select', 'from', 'two words', 'quo"te', 'key', 'customer id']);
  assert.deepEqual(tableOf(SHOP, 'active_customers').columns.map((c) => c.name), ['id', 'name', 'country']);
});

test('schema: the affinity of a column follows its declared type as in SQLite', () => {
  // The types and what SQLite makes of each are the examples of its documentation ("Determination Of Column Affinity").
  const types: [string, db.Column['affinity']][] = [
    ['INT', 'numeric'], ['BIGINT', 'numeric'], ['UNSIGNED BIG INT', 'numeric'], ['CHARACTER(20)', 'text'], ['VARCHAR(255)', 'text'], ['NVARCHAR(100)', 'text'],
    ['TEXT', 'text'], ['CLOB', 'text'], ['BLOB', 'none'], ['', 'none'], ['REAL', 'numeric'], ['DOUBLE PRECISION', 'numeric'], ['FLOAT', 'numeric'],
    ['NUMERIC', 'numeric'], ['DECIMAL(10,5)', 'numeric'], ['BOOLEAN', 'numeric'], ['DATE', 'numeric'], ['DATETIME', 'numeric'],
    // "INT" wins over "CHAR", and a type that only looks like text is numeric.
    ['CHARINT', 'numeric'], ['STRING', 'numeric'],
  ];
  const file = make(`CREATE TABLE types (${types.map(([type], i) => `c${i} ${type}`).join(', ')}); INSERT INTO types VALUES (${types.map(() => "'12'").join(', ')})`);
  assert.deepEqual(tableOf(file, 'types').columns.map((c) => [c.type, c.affinity]), types);
  // What SQLite stores for the text '12' says the same: converted in a numeric column, kept in the others.
  const stored = all(file, `SELECT ${types.map((_, i) => `typeof(c${i})`).join(', ')} FROM types`)[0];
  assert.deepEqual(stored.map((type) => (type === 'text' ? 'kept' : 'converted')), types.map(([, affinity]) => (affinity === 'numeric' ? 'converted' : 'kept')));
});

test('schema: keys, generated columns and the CREATE statements of a table', () => {
  assert.deepEqual(tableOf(SHOP, 'customers').key, ['rowid']);
  assert.equal(tableOf(SHOP, 'products').key?.length, 2);
  assert.equal(tableOf(SHOP, 'active_customers').key, null);

  const orders = tableOf(SHOP, 'orders').sql;
  assert.equal(orders.length, 3);
  assert.match(orders[0], /^CREATE TABLE orders/);
  assert.deepEqual(orders.slice(1).map((sql) => sql.split(' ').slice(0, 3).join(' ')).sort(), ['CREATE INDEX orders_customer', 'CREATE TRIGGER orders_log']);
  assert.deepEqual(tableOf(SHOP, 'active_customers').sql, ['CREATE VIEW active_customers AS SELECT id, name, country FROM customers WHERE country IS NOT NULL']);

  const file = make('CREATE TABLE gen (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) STORED, c AS (a + 1), d TEXT)');
  assert.deepEqual(tableOf(file, 'gen').columns.map((c) => [c.name, c.generated]), [['a', false], ['b', true], ['c', true], ['d', false]]);
});

test('schema: a virtual table is read-only', (t) => {
  const file = newFile();
  try {
    open(file, (conn) => conn.exec("CREATE VIRTUAL TABLE search USING fts5(body); INSERT INTO search VALUES ('some text')"));
  } catch {
    t.skip('this SQLite has no FTS5');
    return;
  }
  const search = tableOf(file, 'search');
  assert.deepEqual([search.type, search.key, search.columns.map((c) => c.name)], ['virtual', null, ['body']]);
  assert.deepEqual(db.rows(file, 'search', ALL).rows, [{ key: null, cells: ['some text'] }]);
  assert.throws(() => db.save(file, [{ table: 'search', kind: 'delete', key: [1] }]), /can't be edited/);
});

const keysOf = (file: string, name: string) => tableOf(file, name).foreignKeys.map((k) => `${k.columns}>${k.table}(${k.to})${k.broken ? '!' : ''}`);

test('schema: foreign keys under the real names of both sides, in the order they were declared', () => {
  assert.deepEqual(keysOf(SHOP, 'customers'), ['country>countries(code)', 'referrer>customers(id)']);
  // "Customers(EMAIL)" is written in another case than the table and the column.
  assert.deepEqual(keysOf(SHOP, 'orders'), ['customer_id>customers(id)', 'customer_email>customers(email)', 'sku,region>products(sku,region)']);
  assert.deepEqual(keysOf(SHOP, 'sessions'), ['token>customers(token)', 'long_ref>docs(body)']);
  assert.deepEqual(keysOf(SHOP, 'odd name'), ['customer id>customers(id)']);
  assert.deepEqual(keysOf(SHOP, 'countries'), []);
  assert.deepEqual(keysOf(SHOP, 'active_customers'), []);
  const [country, referrer] = tableOf(SHOP, 'customers').foreignKeys;
  assert.deepEqual([country.onUpdate, country.onDelete], ['CASCADE', 'SET NULL']);
  assert.deepEqual([referrer.onUpdate, referrer.onDelete], ['NO ACTION', 'NO ACTION']);
  assert.equal(tableOf(SHOP, 'orders').foreignKeys[0].onDelete, 'CASCADE');
});

test('schema: a key without columns means the primary key of the other table, in its order', () => {
  const file = make(`
    CREATE TABLE pairs (b TEXT, a TEXT, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
    CREATE TABLE links (x TEXT, y TEXT, FOREIGN KEY (x, y) REFERENCES pairs);
    CREATE TABLE crossed (x TEXT, y TEXT, FOREIGN KEY (y, x) REFERENCES pairs (b, a));
  `);
  assert.deepEqual(keysOf(file, 'links'), ['x,y>pairs(a,b)']);
  assert.deepEqual(keysOf(file, 'crossed'), ['y,x>pairs(b,a)']);
});

test('schema: a key that leads nowhere says why', () => {
  // Not in the shop: SQLite refuses to change a table that such a key refers to.
  const broken = make(`
    CREATE TABLE countries (code TEXT PRIMARY KEY, name TEXT) WITHOUT ROWID;
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
    CREATE VIEW active_customers AS SELECT id, name FROM customers;
    CREATE TABLE orphans (id INTEGER PRIMARY KEY, ghost INTEGER REFERENCES nowhere(id), bad INTEGER REFERENCES countries, v REFERENCES active_customers(id), nocol REFERENCES customers(nope));
  `);
  assert.deepEqual(keysOf(broken, 'orphans'), ['ghost>nowhere(id)!', 'bad>countries(code)', 'v>active_customers(id)!', 'nocol>customers(nope)!']);
  const [ghost, , view, column] = tableOf(broken, 'orphans').foreignKeys;
  assert.match(ghost.broken, /no table "nowhere"/);
  // A view can't be referred to.
  assert.match(view.broken, /no table "active_customers"/);
  assert.match(column.broken, /no column "nope"/);

  const file = make('CREATE TABLE nopk (a, b); CREATE TABLE two (a, b, PRIMARY KEY (a, b)); CREATE TABLE refs_nopk (x REFERENCES nopk); CREATE TABLE refs_two (x REFERENCES two)');
  assert.match(tableOf(file, 'refs_nopk').foreignKeys[0].broken, /no primary key of one column/);
  assert.match(tableOf(file, 'refs_two').foreignKeys[0].broken, /no primary key of one column/);
});

// ---- The worker thread (sqliteWorker.ts) ------------------------------------------------------

interface Reply {
  result?: unknown;
  error?: string;
  progress: { done: number; total: number }[];
}

/** Starts the worker as the editor does. The runner puts its bundle next to this one. */
function startWorker(file: string, options: WorkerOptions = {}): { worker: Worker; request: (method: string, args: unknown[], cancel?: SharedArrayBuffer) => Promise<Reply> } {
  const worker = new Worker(path.join(__dirname, 'sqliteWorker.js'), { workerData: { file }, ...options });
  let id = 0;
  const request = (method: string, args: unknown[], cancel?: SharedArrayBuffer) =>
    new Promise<Reply>((resolve, reject) => {
      const mine = ++id;
      const progress: Reply['progress'] = [];
      const listen = (msg: { id: number; result?: unknown; error?: string; progress?: Reply['progress'][number] }) => {
        if (msg.id !== mine) {
          return;
        }
        if (msg.progress) {
          progress.push(msg.progress);
          return;
        }
        worker.off('message', listen);
        resolve({ ...('error' in msg ? { error: msg.error } : { result: msg.result }), progress });
      };
      worker.on('message', listen);
      worker.once('error', reject);
      worker.postMessage({ id: mine, method, args, cancel });
    });
  return { worker, request };
}

test('worker: answers requests by their id, and a failed one with its message', async () => {
  const { worker, request } = startWorker(SHOP);
  try {
    const [schema, count, unknown, failed] = await Promise.all([
      request('schema', []),
      request('count', ['customers']),
      request('nothing', []),
      request('rows', ['nowhere', ALL]),
    ]);
    assert.deepEqual(schema.result, JSON.parse(JSON.stringify(db.schema(SHOP))));
    assert.equal(count.result, CUSTOMERS + 1);
    assert.match(unknown.error ?? '', /Unknown request: nothing/);
    assert.match(failed.error ?? '', /no table "nowhere"/);
    // It is still there after a failure.
    const answer = (await request('query', ['SELECT id, big, token FROM customers WHERE id = 2'])).result as db.QueryResult;
    assert.deepEqual(answer.rows, [[2, { int: '9223372036854775807' }, { blob: 16, hex: token(2).toString('hex') }]]);
  } finally {
    await worker.terminate();
  }
});

test('worker: a long job reports its progress and reads its cancellation from shared memory', async () => {
  const file = make('CREATE TABLE many (n INTEGER)');
  open(file, (conn) => conn.exec('WITH RECURSIVE count(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM count WHERE n < 1000) INSERT INTO many SELECT n FROM count'));
  const folder = path.join(dir, 'worker');
  fs.mkdirSync(folder);
  const target = path.join(folder, 'many.csv');
  const { worker, request } = startWorker(file);
  try {
    const flag = new SharedArrayBuffer(4);
    const done = await request('exportRows', [{ table: 'many', sort: null, filter: '' }, 'csv', target], flag);
    assert.deepEqual(done.result, { rows: 1000, cancelled: false });
    assert.ok(done.progress.length > 0);
    assert.ok(done.progress.every((p) => p.total === 1000 && p.done > 0 && p.done <= 1000));
    fs.rmSync(target);

    new Int32Array(flag)[0] = 1;
    const stopped = (await request('exportRows', [{ table: 'many', sort: null, filter: '' }, 'csv', target], flag)).result as { rows: number; cancelled: boolean };
    assert.equal(stopped.cancelled, true);
    assert.ok(stopped.rows < 1000);
    assert.deepEqual(fs.readdirSync(folder), []);
  } finally {
    await worker.terminate();
  }
});

for (const method of ['setReturnArrays', 'columns']) {
  test(`worker: refuses to start in a runtime whose node:sqlite has no ${method}()`, async () => {
    // A stand-in for VS Code 1.101 and 1.102 (Node.js 22.15): the method is taken away before the worker's code loads.
    const preload = path.join(dir, `without-${method}.js`);
    fs.writeFileSync(preload, `delete require('node:sqlite').StatementSync.prototype.${method};\n`);
    const { worker } = startWorker(SHOP, { execArgv: ['--require', preload], stderr: true });
    try {
      const error = await new Promise<Error>((resolve, reject) => {
        worker.once('error', resolve);
        worker.once('message', (msg) => reject(new Error(`the worker answered: ${JSON.stringify(msg)}`)));
        worker.postMessage({ id: 1, method: 'schema', args: [] });
      });
      assert.equal(error.message, 'node:sqlite is too old in this runtime');
    } finally {
      await worker.terminate();
    }
  });
}
