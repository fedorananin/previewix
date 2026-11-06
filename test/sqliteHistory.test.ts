import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import { QueryHistory } from '../src/sqliteHistory';
import { scratch } from './helpers';

const dir = scratch();
let folders = 0;
/** A folder of its own for every test, so that the one file in it is the history under test. */
const newFolder = (): string => path.join(dir, `history-${++folders}`);
const texts = (items: { sql: string }[]): string[] => items.map((item) => item.sql);
const historyFiles = (folder: string): string[] => fs.readdirSync(folder).filter((name) => name.endsWith('.json'));

// ---- The folder ---------------------------------------------------------------------------

// This one has to come first: the folder is tidied once per session, on the first write of the process.
test('the histories of the 100 databases used last are kept, and what a crashed write left behind is removed', async () => {
  const folder = newFolder();
  fs.mkdirSync(folder);
  const name = (i: number) => `${String(i).padStart(32, '0')}.json`;
  for (let i = 0; i < 130; i++) {
    fs.writeFileSync(path.join(folder, name(i)), JSON.stringify({ database: `d${i}`, items: [{ sql: 'x', at: i }] }));
    // The higher the number, the later it was used.
    fs.utimesSync(path.join(folder, name(i)), 1000 + i, 1000 + i);
  }
  fs.writeFileSync(path.join(folder, 'crashed.tmp'), 'half a file');
  fs.utimesSync(path.join(folder, 'crashed.tmp'), 1000, 1000);
  // A temporary file of this minute may be another window's write in progress.
  fs.writeFileSync(path.join(folder, 'writing.tmp'), 'half a file');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not ours');

  await new QueryHistory(folder, 'file:///new.db').add('SELECT 1', false);

  const left = fs.readdirSync(folder);
  const histories = left.filter((file) => file.endsWith('.json'));
  assert.equal(histories.length, 100);
  // The new one and the 99 used last.
  assert.deepEqual(histories.filter((file) => /^0+\d+\.json$/.test(file)).sort(), Array.from({ length: 99 }, (_, i) => name(31 + i)));
  assert.deepEqual(left.filter((file) => !file.endsWith('.json')).sort(), ['notes.txt', 'writing.tmp']);
  assert.deepEqual(texts(await new QueryHistory(folder, 'file:///new.db').read()), ['SELECT 1']);
});

test('a history is one file named by a hash of what names the database', async () => {
  const folder = newFolder();
  const a = new QueryHistory(folder, 'file:///home/me/a.db');
  // Nothing is made before there is something to keep.
  assert.deepEqual(await a.read(), []);
  assert.ok(!fs.existsSync(folder));
  await a.add('SELECT 1', false);
  await new QueryHistory(folder, 'file:///home/me/b.db').add('SELECT 2', false);
  const files = historyFiles(folder);
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => /^[0-9a-f]{32}\.json$/.test(file)));
  assert.deepEqual(fs.readdirSync(folder).sort(), files.sort());
  // Each database has its own, and a new object for the same database finds it again.
  assert.deepEqual(texts(await new QueryHistory(folder, 'file:///home/me/a.db').read()), ['SELECT 1']);
  assert.deepEqual(texts(await new QueryHistory(folder, 'file:///home/me/b.db').read()), ['SELECT 2']);
  assert.deepEqual(await new QueryHistory(folder, 'file:///home/me/A.db').read(), []);
  const stored = files.map((file) => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')).database).sort();
  assert.deepEqual(stored, ['file:///home/me/a.db', 'file:///home/me/b.db']);
});

// ---- The list -------------------------------------------------------------------------------

test('the newest statement comes first, with the time it ran', async () => {
  const history = new QueryHistory(newFolder(), 'db');
  const before = Date.now();
  await history.add('SELECT 1', false);
  await history.add('SELECT 2', false);
  const items = await history.add('SELECT 3', false);
  const after = Date.now();
  assert.deepEqual(texts(items), ['SELECT 3', 'SELECT 2', 'SELECT 1']);
  assert.ok(items.every((item) => item.at >= before && item.at <= after));
  assert.ok(items[0].at >= items[1].at && items[1].at >= items[2].at);
  // What add() returns is what is stored.
  assert.deepEqual(await history.read(), items);
});

test('the same text moves up instead of appearing twice, and only a failed run is marked', async () => {
  const history = new QueryHistory(newFolder(), 'db');
  await history.add('SELECT 1', false);
  await history.add('SELEC', true);
  await history.add('SELECT 2', false);
  let items = await history.add('SELECT 1', false);
  assert.deepEqual(items.map((item) => [item.sql, item.failed]), [['SELECT 1', undefined], ['SELECT 2', undefined], ['SELEC', true]]);
  // The mark follows the last run: a statement that works now is no longer a failed one, and the other way round.
  items = await history.add('SELEC', false);
  assert.deepEqual(items.map((item) => [item.sql, item.failed]), [['SELEC', undefined], ['SELECT 1', undefined], ['SELECT 2', undefined]]);
  items = await history.add('SELECT 2', true);
  assert.deepEqual(items.map((item) => [item.sql, item.failed]), [['SELECT 2', true], ['SELEC', undefined], ['SELECT 1', undefined]]);
  // Texts that differ in anything are different statements.
  items = await history.add('select 2', false);
  assert.equal(items.length, 4);
});

test('a script is one entry, and odd text survives', async () => {
  const folder = newFolder();
  const script = "CREATE TABLE t (a);\r\nINSERT INTO t VALUES ('é😀 \\n', \"ж\"); -- comment\n\tSELECT * FROM t;\n";
  await new QueryHistory(folder, 'db').add(script, false);
  assert.deepEqual(texts(await new QueryHistory(folder, 'db').read()), [script]);
});

test('adds made at once all land, in the order they were made', async () => {
  const history = new QueryHistory(newFolder(), 'db');
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => history.add(`SELECT ${i}`, i % 2 === 0)));
  assert.deepEqual(results.map((items) => items.length), Array.from({ length: 40 }, (_, i) => i + 1));
  const items = await history.read();
  assert.deepEqual(texts(items), Array.from({ length: 40 }, (_, i) => `SELECT ${39 - i}`));
  assert.deepEqual(items.map((item) => !!item.failed), Array.from({ length: 40 }, (_, i) => (39 - i) % 2 === 0));
});

// ---- The limits ------------------------------------------------------------------------------

test('200 statements are kept, and the oldest go first', async () => {
  const history = new QueryHistory(newFolder(), 'db');
  for (let i = 0; i < 205; i++) {
    await history.add(`SELECT ${i}`, false);
  }
  const items = await history.read();
  assert.deepEqual(texts(items), Array.from({ length: 200 }, (_, i) => `SELECT ${204 - i}`));
  // One that is there already takes no place.
  assert.equal((await history.add('SELECT 5', false)).length, 200);
  assert.deepEqual(texts(await history.read()).slice(0, 2).concat(texts(await history.read()).slice(-1)), ['SELECT 5', 'SELECT 204', 'SELECT 6']);
});

test('a statement over 100,000 characters is not kept, and the list stays as it was', async () => {
  const history = new QueryHistory(newFolder(), 'db');
  await history.add('SELECT 1', false);
  assert.deepEqual(texts(await history.add('x'.repeat(100_001), false)), ['SELECT 1']);
  assert.deepEqual(texts(await history.read()), ['SELECT 1']);
  // Exactly 100,000 is kept.
  assert.deepEqual((await history.add('y'.repeat(100_000), false)).map((item) => item.sql.length), [100_000, 8]);
  // Nothing is nothing to remember.
  assert.equal((await history.add('', false)).length, 2);
});

test('a million characters of SQL are kept for a database, and the oldest statements go first', async () => {
  const folder = newFolder();
  const history = new QueryHistory(folder, 'db');
  const sql = (i: number) => String(i).padStart(100_000, '-');
  for (let i = 0; i < 10; i++) {
    await history.add(sql(i), false);
  }
  // Ten of them are a million exactly.
  assert.deepEqual(texts(await history.read()), Array.from({ length: 10 }, (_, i) => sql(9 - i)));
  const items = await history.add('SELECT 1', false);
  assert.deepEqual(texts(items), ['SELECT 1', ...Array.from({ length: 9 }, (_, i) => sql(9 - i))]);
  assert.ok(fs.statSync(path.join(folder, historyFiles(folder)[0])).size < 1_100_000);
  // A short one more only costs what does not fit.
  assert.equal((await history.add('SELECT 2', false)).length, 11);
});

// ---- The file ---------------------------------------------------------------------------------

test('every change writes a new file aside and renames it, and leaves nothing else behind', async () => {
  const folder = newFolder();
  const history = new QueryHistory(folder, 'db');
  await history.add('SELECT 1', false);
  const file = path.join(folder, historyFiles(folder)[0]);
  // A file that is renamed into place is another file than the one before, which a rewrite in place would not be.
  const first = fs.statSync(file).ino;
  await history.add('SELECT 2', false);
  const second = fs.statSync(file).ino;
  await history.add('SELECT 1', true);
  assert.notEqual(second, first);
  assert.notEqual(fs.statSync(file).ino, second);
  assert.deepEqual(fs.readdirSync(folder), [path.basename(file)]);
  assert.deepEqual(texts(JSON.parse(fs.readFileSync(file, 'utf8')).items), ['SELECT 1', 'SELECT 2']);
});

test('a write that fails leaves no temporary file, and the next change is not held up by it', async () => {
  const folder = newFolder();
  const history = new QueryHistory(folder, 'db');
  await history.add('SELECT 1', false);
  const file = path.join(folder, historyFiles(folder)[0]);
  // A folder where the file should be: the new file can be written aside but not renamed into place.
  fs.rmSync(file);
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'inside'), '');
  await assert.rejects(history.add('SELECT 2', false));
  assert.deepEqual(fs.readdirSync(folder), [path.basename(file)]);
  assert.deepEqual(await history.read(), []);
  fs.rmSync(file, { recursive: true });
  assert.deepEqual(texts(await history.add('SELECT 3', false)), ['SELECT 3']);
});

test('a folder that can not be made fails the add, and reading stays empty', async () => {
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'a file where the folder should be');
  const history = new QueryHistory(path.join(blocked, 'sub'), 'db');
  await assert.rejects(history.add('SELECT 1', false));
  assert.deepEqual(await history.read(), []);
  await assert.rejects(history.add('SELECT 2', false));
  fs.rmSync(blocked);
  assert.deepEqual(texts(await history.add('SELECT 3', false)), ['SELECT 3']);
});

test('a damaged history file reads as an empty history and is written over', async () => {
  const folder = newFolder();
  const history = new QueryHistory(folder, 'db');
  await history.add('SELECT 1', false);
  const file = path.join(folder, historyFiles(folder)[0]);
  for (const junk of ['{"items": [', '', 'null', '5', '"text"', '[]', '{}', '{"items": "no"}', '{"items": {"0": {"sql": "x", "at": 1}}}', '\u0000\u0001']) {
    fs.writeFileSync(file, junk);
    assert.deepEqual(await history.read(), [], JSON.stringify(junk));
  }
  // Entries that are not entries are left out, and the others are kept.
  fs.writeFileSync(file, '{"items": [1, null, "x", [], {"sql": 5, "at": 1}, {"sql": "no time"}, {"sql": "ok", "at": 1}, {"sql": "failed", "at": 2, "failed": true}]}');
  assert.deepEqual(await history.read(), [{ sql: 'ok', at: 1 }, { sql: 'failed', at: 2, failed: true }]);

  fs.writeFileSync(file, '{broken');
  assert.deepEqual(texts(await history.add('SELECT 2', false)), ['SELECT 2']);
  assert.deepEqual(texts(JSON.parse(fs.readFileSync(file, 'utf8')).items), ['SELECT 2']);
});

test('clearing removes the file', async () => {
  const folder = newFolder();
  const history = new QueryHistory(folder, 'db');
  await history.add('SELECT 1', false);
  await new QueryHistory(folder, 'other').add('SELECT 2', false);
  assert.equal(historyFiles(folder).length, 2);
  assert.deepEqual(await history.clear(), []);
  assert.equal(historyFiles(folder).length, 1);
  assert.deepEqual(await history.read(), []);
  // The other database keeps its own, and clearing nothing is fine.
  assert.deepEqual(texts(await new QueryHistory(folder, 'other').read()), ['SELECT 2']);
  assert.deepEqual(await history.clear(), []);
  assert.deepEqual(texts(await history.add('SELECT 3', false)), ['SELECT 3']);
});
