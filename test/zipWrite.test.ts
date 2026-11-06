import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import { createZip, extractEntries, freeName, listArchive } from '../src/archive/index';
import { readZip } from './archives';
import { needs, python, random, run, scratch, tree, which } from './helpers';

// "Compress to ZIP" (src/archive/zipWrite.ts). What it wrote is read by readZip() in archives.ts, a strict
// reader of the tests' own (both headers of every entry must agree, the data must unpack to the stated size
// and checksum, no data descriptors, nothing between the parts), and then by the extension's own reader.

const dir = scratch();
const rand = random(0x21b);
const POSIX = process.platform !== 'win32';

const TEXT = Buffer.from(Array.from({ length: 400 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog\n`).join(''));
const NOISE = rand.bytes(5000);
// Larger than the 256 KB up to which a file is packed in one go, and than the megabyte it is then read in at a time.
const LARGE = Buffer.concat([rand.bytes(60_000), Buffer.alloc(1_300_000, 0x20), TEXT]);
const WHEN = new Date('2024-03-02T10:20:31Z');

let count = 0;
/** A folder `project` with files of every kind the writer treats differently. */
function project(): string {
  const root = path.join(dir, `${++count}`, 'project');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'tiny.txt'), 'hi\n');
  fs.writeFileSync(path.join(root, 'nothing.txt'), '');
  fs.writeFileSync(path.join(root, 'src', 'text.txt'), TEXT);
  fs.writeFileSync(path.join(root, 'src', 'noise.bin'), NOISE);
  fs.writeFileSync(path.join(root, 'src', 'deep', 'large.bin'), LARGE);
  fs.writeFileSync(path.join(root, 'src', 'deep', 'run.sh'), '#!/bin/sh\necho hi\n');
  // Decomposed, as macOS hands names out: "é" as "e" and a combining accent.
  fs.writeFileSync(path.join(root, 'café Привет.txt'), 'unicode\n');
  if (POSIX) {
    fs.chmodSync(path.join(root, 'src', 'deep', 'run.sh'), 0o755);
  }
  fs.utimesSync(path.join(root, 'tiny.txt'), WHEN, WHEN);
  fs.utimesSync(path.join(root, 'src', 'deep', 'large.bin'), WHEN, WHEN);
  return root;
}

const byName = (file: string) => new Map(readZip(fs.readFileSync(file)).map((entry) => [entry.name, entry]));

test('a folder goes in whole, under its own name, and every file comes out as it went in', async () => {
  const root = project();
  const target = path.join(path.dirname(root), 'project.zip');
  const summary = await createZip([root], target);
  assert.equal(summary.target, target);
  assert.deepEqual([summary.files, summary.folders, summary.links, summary.skipped.length, summary.cancelled], [7, 4, 0, 0, false]);
  assert.equal(summary.size, fs.statSync(target).size);
  assert.equal(summary.bytes, 3 + TEXT.length + NOISE.length + LARGE.length + 18 + 8);
  // Only the archive is next to the folder: the file it was built in is gone.
  assert.deepEqual(fs.readdirSync(path.dirname(root)).sort(), ['project', 'project.zip']);

  const entries = byName(target);
  assert.deepEqual([...entries.keys()].sort(), [
    'project/', 'project/café Привет.txt', 'project/empty/', 'project/nothing.txt', 'project/src/', 'project/src/deep/', 'project/src/deep/large.bin',
    'project/src/deep/run.sh', 'project/src/noise.bin', 'project/src/text.txt', 'project/tiny.txt',
  ]);
  assert.deepEqual(entries.get('project/src/text.txt')!.data, TEXT);
  assert.deepEqual(entries.get('project/src/noise.bin')!.data, NOISE);
  assert.deepEqual(entries.get('project/src/deep/large.bin')!.data, LARGE);
  assert.equal(entries.get('project/nothing.txt')!.data.length, 0);
  // Deflate where it helps, stored where it doesn't.
  assert.equal(entries.get('project/src/text.txt')!.method, 8);
  assert.equal(entries.get('project/src/deep/large.bin')!.method, 8);
  assert.equal(entries.get('project/src/noise.bin')!.method, 0);
  assert.equal(entries.get('project/tiny.txt')!.method, 0);
  assert.ok(summary.size < summary.bytes);
});

test('names are composed UTF-8 with the flag for it; folders end in a slash', async () => {
  const root = project();
  const target = path.join(path.dirname(root), 'names.zip');
  await createZip([root], target);
  const entries = readZip(fs.readFileSync(target));
  assert.ok(entries.every((entry) => entry.utf8), 'the UTF-8 flag on every entry');
  // Composed characters, as Windows and Linux expect them.
  assert.ok(entries.some((entry) => entry.name === 'project/café Привет.txt'));
  assert.ok(entries.every((entry) => entry.name === entry.name.normalize('NFC') && !entry.name.includes('\\') && !entry.name.startsWith('/')));
  for (const entry of entries.filter((item) => item.name.endsWith('/'))) {
    assert.equal(entry.data.length, 0);
    assert.equal(entry.method, 0);
  }
});

test('entries are "made by Unix" with the mode of the file, and carry its time in UTC', { skip: !POSIX && 'no file modes on Windows' }, async () => {
  const root = project();
  const target = path.join(path.dirname(root), 'modes.zip');
  await createZip([root], target);
  const entries = byName(target);
  for (const entry of entries.values()) {
    assert.equal(entry.madeBy >> 8, 3, entry.name);
    assert.equal(entry.zip64, false, 'no 64-bit sizes where 32 bits do');
  }
  assert.equal(entries.get('project/src/deep/run.sh')!.mode! & 0o170777, 0o100755);
  assert.equal(entries.get('project/tiny.txt')!.mode! & 0o170000, 0o100000);
  assert.equal(entries.get('project/tiny.txt')!.mode! & 0o111, 0);
  assert.equal(entries.get('project/src/')!.mode! & 0o170000, 0o040000);
  // The extended timestamp field: a flag byte that says "modification time", then seconds since 1970.
  for (const name of ['project/tiny.txt', 'project/src/deep/large.bin']) {
    const stamp = entries.get(name)!.extra.get(0x5455);
    assert.ok(stamp, `${name} has no timestamp field`);
    assert.equal(stamp[0] & 1, 1);
    assert.equal(stamp.readUInt32LE(1), Math.floor(WHEN.getTime() / 1000));
    // The DOS time next to it is the same moment on the local clock, in steps of two seconds.
    const [year, month, day, hour, minute, second] = entries.get(name)!.dos;
    assert.equal(new Date(year, month - 1, day, hour, minute, second).getTime(), WHEN.getTime() - 1000);
  }
});

test('a symbolic link is stored as a link and never followed', { skip: !POSIX && 'symbolic links need a privilege on Windows' }, async () => {
  const root = project();
  const outside = path.join(path.dirname(root), 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not picked');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'file-link'));
  fs.symlinkSync(outside, path.join(root, 'folder-link'));
  fs.symlinkSync('no/such/place', path.join(root, 'broken-link'));
  const target = path.join(path.dirname(root), 'links.zip');
  const summary = await createZip([root], target);
  assert.equal(summary.links, 3);
  const entries = byName(target);
  for (const [name, to] of [['file-link', path.join(outside, 'secret.txt')], ['folder-link', outside], ['broken-link', 'no/such/place']]) {
    const entry = entries.get(`project/${name}`)!;
    assert.equal(entry.mode! & 0o170000, 0o120000, `${name} is not stored as a link`);
    assert.equal(entry.data.toString('utf8'), to);
  }
  // Nothing of what the links point at is in the archive.
  assert.ok(![...entries.values()].some((entry) => entry.data.includes('not picked')));
  assert.ok(![...entries.keys()].some((name) => name.includes('secret')));
});

test('several picked items go in side by side; one that lies inside another comes with it, once', async () => {
  const root = project();
  const single = path.join(path.dirname(root), 'single.txt');
  fs.writeFileSync(single, 'alone\n');
  const target = path.join(path.dirname(root), 'Archive.zip');
  const summary = await createZip([path.join(root, 'src'), single, path.join(root, 'src', 'deep'), path.join(root, 'tiny.txt')], target);
  assert.equal(summary.files, 6);
  assert.deepEqual([...byName(target).keys()].sort(), ['single.txt', 'src/', 'src/deep/', 'src/deep/large.bin', 'src/deep/run.sh', 'src/noise.bin', 'src/text.txt', 'tiny.txt']);
});

test('the archive reads back with the extension\'s own reader, and unpacks to the folder it was made from', async () => {
  const root = project();
  const target = path.join(path.dirname(root), 'back.zip');
  await createZip([root], target);
  const listing = await listArchive(target);
  assert.equal(listing.format, 'ZIP');
  assert.equal(listing.warning, undefined);
  const out = path.join(path.dirname(root), 'out');
  const summary = await extractEntries(target, listing, listing.entries.map((_, i) => i), out, { overwrite: false });
  assert.deepEqual(summary.failed, []);
  // The name comes back composed, which is the same file to macOS and another one to Linux.
  const normal = (names: Record<string, string>) => Object.fromEntries(Object.entries(names).map(([name, value]) => [name.normalize('NFC'), value]));
  assert.deepEqual(normal(tree(path.join(out, 'project'))), normal(tree(root)));
  if (POSIX) {
    assert.ok(fs.statSync(path.join(out, 'project', 'src', 'deep', 'run.sh')).mode & 0o100);
    // To the second: the reader takes the time from the timestamp field, not from the coarser DOS time.
    assert.equal(fs.statSync(path.join(out, 'project', 'tiny.txt')).mtimeMs, WHEN.getTime());
  }
});

test('an archive made inside the folder it packs does not pack itself', async () => {
  const root = project();
  const target = path.join(root, 'project.zip');
  await createZip([root], target);
  const names = [...byName(target).keys()];
  assert.ok(!names.some((name) => name.endsWith('.zip') || name.endsWith('.part')), names.join(', '));
  assert.equal(names.length, 11);
});

test('what can\'t be read is left out and named; pipes are not opened', { skip: (!POSIX && 'needs file modes and mkfifo') || (process.getuid?.() === 0 && 'root can read everything') || needs(which('mkfifo'), 'mkfifo') }, async () => {
  const root = project();
  fs.chmodSync(path.join(root, 'src', 'text.txt'), 0);
  fs.mkdirSync(path.join(root, 'locked'));
  fs.writeFileSync(path.join(root, 'locked', 'inside.txt'), 'x');
  fs.chmodSync(path.join(root, 'locked'), 0);
  run(which('mkfifo')!, [path.join(root, 'pipe')]);
  const target = path.join(path.dirname(root), 'partial.zip');
  try {
    const summary = await createZip([root], target);
    assert.deepEqual(summary.skipped.map((item) => item.path).sort(), ['project/locked', 'project/pipe', 'project/src/text.txt']);
    assert.ok(summary.skipped.every((item) => item.reason));
    const names = [...byName(target).keys()];
    assert.ok(names.includes('project/src/noise.bin') && !names.includes('project/src/text.txt') && !names.includes('project/pipe'));
    assert.equal(summary.files, 6);
    // When nothing at all could be read, there is no archive: an empty one would only hide that.
    const none = await createZip([path.join(root, 'src', 'text.txt')], path.join(path.dirname(root), 'none.zip'));
    assert.equal(none.target, undefined);
    assert.equal(none.skipped.length, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(root)).sort(), ['partial.zip', 'project']);
  } finally {
    fs.chmodSync(path.join(root, 'locked'), 0o755);
  }
});

test('with nothing to pack, no archive is written', async () => {
  const folder = path.join(dir, `${++count}`);
  fs.mkdirSync(folder);
  const target = path.join(folder, 'nothing.zip');
  const summary = await createZip([path.join(folder, 'no-such-file')], target);
  assert.equal(summary.target, undefined);
  assert.equal(summary.skipped.length, 1);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('a cancelled run leaves nothing behind', async () => {
  const root = project();
  const target = path.join(path.dirname(root), 'cancelled.zip');
  const before = new AbortController();
  before.abort();
  assert.equal((await createZip([root], target, { signal: before.signal })).cancelled, true);
  // And in the middle of the large file.
  const during = new AbortController();
  const summary = await createZip([root], target, {
    signal: during.signal,
    onProgress: (done) => {
      if (done > 100_000) {
        during.abort();
      }
    },
  });
  assert.equal(summary.cancelled, true);
  assert.equal(summary.target, undefined);
  assert.deepEqual(fs.readdirSync(path.dirname(root)), ['project']);
});

test('progress starts at nothing, never goes back and never passes the size of everything that was picked', async () => {
  const root = project();
  const seen: number[] = [];
  let total = 0;
  const summary = await createZip([root], path.join(path.dirname(root), 'progress.zip'), {
    onProgress: (done, all) => {
      seen.push(done);
      total = all;
    },
  });
  assert.equal(total, summary.bytes);
  assert.equal(seen[0], 0);
  assert.ok(seen.every((done, i) => done <= total && (i === 0 || done >= seen[i - 1])), 'progress went backwards or past the end');
  // It is called as a file is begun and as a large one is read, so the last call lies before the end of the last file.
  assert.ok(seen.length >= 8 && (seen.at(-1) as number) > total / 2);
});

test('a name that is taken is left alone: the archive gets the next free one', async () => {
  const folder = path.join(dir, `${++count}`);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
  assert.equal(await freeName(folder, 'Archive', '.zip'), path.join(folder, 'Archive.zip'));
  fs.writeFileSync(path.join(folder, 'Archive.zip'), 'mine');
  assert.equal(await freeName(folder, 'Archive', '.zip'), path.join(folder, 'Archive 2.zip'));
  fs.mkdirSync(path.join(folder, 'Archive 2.zip'));
  assert.equal(await freeName(folder, 'Archive', '.zip'), path.join(folder, 'Archive 3.zip'));
  // Even when asked for the taken name outright, as when something took it while the archive was written.
  const summary = await createZip([path.join(folder, 'a.txt')], path.join(folder, 'Archive.zip'));
  assert.equal(summary.target, path.join(folder, 'Archive 3.zip'));
  assert.equal(fs.readFileSync(path.join(folder, 'Archive.zip'), 'utf8'), 'mine');
  assert.deepEqual([...byName(summary.target).keys()], ['a.txt']);
});

// ---- Against other programs --------------------------------------------------------------------

test('unzip accepts the archive and unpacks the same files', { skip: needs(which('unzip'), 'unzip') }, async () => {
  const root = project();
  const target = path.join(path.dirname(root), 'for-unzip.zip');
  await createZip([root], target);
  const tested = spawnSync(which('unzip')!, ['-t', '-qq', target]);
  assert.equal(tested.status, 0, tested.stdout.toString() + tested.stderr.toString());
  const out = path.join(path.dirname(root), 'unzipped');
  run(which('unzip')!, ['-q', target, '-d', out]);
  for (const name of ['tiny.txt', 'src/text.txt', 'src/noise.bin', 'src/deep/large.bin']) {
    assert.deepEqual(fs.readFileSync(path.join(out, 'project', name)), fs.readFileSync(path.join(root, name)), name);
  }
});

test('Python\'s zipfile finds no bad entry and the same names', { skip: needs(python('zipfile'), 'Python') }, async () => {
  const root = project();
  const target = path.join(path.dirname(root), 'for-python.zip');
  await createZip([root], target);
  const script = 'import sys, json, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad": z.testzip(), "names": sorted(z.namelist())}))';
  const result = JSON.parse(run(python('zipfile')!, ['-c', script, target]).toString()) as { bad: string | null; names: string[] };
  assert.equal(result.bad, null);
  assert.deepEqual(result.names, [...byName(target).keys()].sort());
});
