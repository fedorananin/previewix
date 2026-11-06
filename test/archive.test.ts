import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import * as zlib from 'zlib';
import { cleanPath } from '../src/archive/common';
import { PasswordError, countExisting, extractEntries, extractFile, listArchive, safeSegments, targetOf, type Listing } from '../src/archive/index';
import { SEVEN, rarFile, sevenZipFile, tarFile, zipFile, type TarItem, type ZipItem } from './archives';
import { random, scratch, tree } from './helpers';

// Extraction (src/archive/): where a file may be written, what is never created, how much is ever unpacked,
// and what a damaged archive leaves behind. Every archive here is built by hand in archives.ts, so the tests
// decide what the names, sizes and checksums say. Reading the formats themselves is in archiveFormats.test.ts.

const dir = scratch();

let count = 0;
/** A folder of its own with the archive in it and an empty `target` to extract into; everything else in it is trespassing. */
function sandbox(name: string, bytes: Buffer): { archive: string; root: string; target: string } {
  const root = path.join(dir, `${++count}`);
  fs.mkdirSync(path.join(root, 'target'), { recursive: true });
  const archive = path.join(root, name);
  fs.writeFileSync(archive, bytes);
  return { archive, root, target: path.join(root, 'target') };
}

const all = (listing: Listing) => listing.entries.map((_, i) => i);
const extractAll = async (archive: string, target: string, overwrite = false) => {
  const listing = await listArchive(archive);
  return { listing, summary: await extractEntries(archive, listing, all(listing), target, { overwrite }) };
};
/** The files under a folder with their text. */
function files(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(tree(folder))) {
    if (!name.endsWith('/') && !fs.lstatSync(path.join(folder, name)).isSymbolicLink()) {
      out[name] = fs.readFileSync(path.join(folder, name), 'utf8');
    }
  }
  return out;
}
const links = (folder: string) => Object.entries(tree(folder)).filter(([, value]) => value.startsWith('-> '));
const leftovers = (folder: string) => Object.keys(tree(folder)).filter((name) => name.endsWith('.part'));

// ---- Paths ----------------------------------------------------------------------------------

test('a stored name becomes a relative path: backslashes are separators, what makes it absolute is dropped', () => {
  assert.deepEqual(cleanPath('dir/file.txt'), { path: 'dir/file.txt', unsafe: false });
  assert.deepEqual(cleanPath('dir\\sub\\file.txt'), { path: 'dir/sub/file.txt', unsafe: false });
  assert.deepEqual(cleanPath('/etc/passwd'), { path: 'etc/passwd', unsafe: false });
  assert.deepEqual(cleanPath('///etc//passwd'), { path: 'etc/passwd', unsafe: false });
  assert.deepEqual(cleanPath('C:\\Windows\\system.ini'), { path: 'Windows/system.ini', unsafe: false });
  assert.deepEqual(cleanPath('c:/x'), { path: 'x', unsafe: false });
  assert.deepEqual(cleanPath('./a/./b/'), { path: 'a/b', unsafe: false });
  assert.deepEqual(cleanPath('/'), { path: '', unsafe: false });
  // A name that climbs is kept as it is and marked, never "resolved" into something harmless-looking.
  assert.equal(cleanPath('../x').unsafe, true);
  assert.equal(cleanPath('a/../../x').unsafe, true);
  assert.equal(cleanPath('a\\..\\x').unsafe, true);
  assert.equal(cleanPath('a/..').unsafe, true);
  assert.equal(cleanPath('....//x').unsafe, false);
  // A zero byte ends the name for the system calls, so what follows it would be a lie.
  assert.deepEqual(cleanPath('safe.txt\0../../evil'), { path: 'safe.txt', unsafe: true });
});

test('the check extraction relies on refuses every path that is not plain segments', () => {
  assert.deepEqual(safeSegments('a/b/c.txt', 'linux'), ['a', 'b', 'c.txt']);
  for (const bad of ['', '..', '../x', 'a/../x', 'a/..', '/abs', 'a//b', 'a/./b', './a', 'a/', 'a\\b', 'a\0b', 'a/..\\..\\x']) {
    assert.equal(safeSegments(bad, 'linux'), undefined, JSON.stringify(bad));
    assert.equal(safeSegments(bad, 'win32'), undefined, JSON.stringify(bad));
  }
  // On Windows a colon addresses a drive or a stream, and some names are devices.
  assert.deepEqual(safeSegments('C:/x', 'win32'), ['C_', 'x']);
  assert.deepEqual(safeSegments('a/file.txt:stream', 'win32'), ['a', 'file.txt_stream']);
  assert.deepEqual(safeSegments('con/NUL.txt/lpt1', 'win32'), ['_con', '_NUL.txt', '_lpt1']);
  assert.deepEqual(safeSegments('trailing. /x', 'win32'), ['trailing', 'x']);
  assert.deepEqual(safeSegments('...', 'win32'), ['_']);
  assert.deepEqual(safeSegments('con/a:b', 'linux'), ['con', 'a:b']);
});

test('the place a file goes is inside the folder, or nowhere', () => {
  const folder = path.join(dir, 'into');
  assert.equal(targetOf(folder, 'a/b.txt'), path.join(folder, 'a', 'b.txt'));
  assert.equal(targetOf(`${folder}${path.sep}`, 'a'), path.join(folder, 'a'));
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', '', '.', 'a/..']) {
    assert.equal(targetOf(folder, bad), undefined, JSON.stringify(bad));
  }
});

// ---- Hostile names, in every format -----------------------------------------------------------

const NAMES = [
  'ok/normal.txt', '../evil1.txt', '/abs/evil2.txt', 'C:\\Windows\\evil3.txt', 'a/../../evil4.txt', '..\\evil5.txt', 'dir/./dot.txt', 'a/b/../../../evil6.txt',
  '....//evil7.txt', 'юникод/файл.txt', 'ok/sub/../evil8.txt', 'trailing/space .txt',
];
const body = (name: string) => Buffer.from(`content of ${name}\n`);
const OUTSIDE_LINK = '/tmp/previewix-test-link-target';

/** What the documented rules make of a stored name: the path it is listed and written under, or undefined when it climbs. */
function expectedPath(name: string): string | undefined {
  const parts = name.replace(/\\/g, '/').split('/').map((part, i) => (i === 0 ? part.replace(/^[A-Za-z]:/, '') : part)).filter((part) => part !== '' && part !== '.');
  return parts.includes('..') ? undefined : parts.join('/');
}

const HOSTILE: Record<string, () => Buffer> = {
  'hostile.zip': () =>
    zipFile([
      ...NAMES.map((name): ZipItem => ({ name, data: body(name), method: 8 })),
      { name: 'link', data: Buffer.from(OUTSIDE_LINK), mode: 0o120777 },
      { name: 'link/inside.txt', data: body('link/inside.txt') },
    ]),
  'hostile.tar': () => tarFile(hostileTar()),
  'hostile.tar.gz': () => zlib.gzipSync(tarFile(hostileTar())),
  'hostile.7z': () =>
    sevenZipFile([
      ...NAMES.map((name) => ({ name, data: body(name) })),
      { name: 'link', data: Buffer.from(OUTSIDE_LINK), attributes: SEVEN.link() },
      { name: 'link/inside.txt', data: body('link/inside.txt') },
    ]),
  'hostile.rar': () =>
    rarFile([
      ...NAMES.map((name) => ({ name, data: body(name) })),
      { name: 'link', data: Buffer.from(OUTSIDE_LINK), mode: 0o120777 },
      { name: 'link/inside.txt', data: body('link/inside.txt') },
    ]),
};

function hostileTar(): TarItem[] {
  return [
    ...NAMES.map((name): TarItem => ({ name, data: body(name), pax: /[^\x20-\x7e]/.test(name) })),
    { name: 'link', type: '2', link: OUTSIDE_LINK },
    { name: 'hard', type: '1', link: '../../etc/passwd' },
    { name: 'link/inside.txt', data: body('link/inside.txt') },
  ];
}

for (const [name, build] of Object.entries(HOSTILE)) {
  test(`${name}: names that climb are refused, the others land inside the folder, links are not created`, async () => {
    const { archive, root, target } = sandbox(name, build());
    const { listing, summary } = await extractAll(archive, target);

    // Nothing next to the folder, nothing where the absolute names and the link point, no link anywhere.
    assert.deepEqual(fs.readdirSync(root).sort(), [name, 'target'].sort());
    assert.equal(fs.existsSync(OUTSIDE_LINK), false);
    assert.deepEqual(links(root), []);
    assert.deepEqual(leftovers(root), []);

    const safe = NAMES.filter((stored) => expectedPath(stored) !== undefined);
    const climbing = NAMES.filter((stored) => expectedPath(stored) === undefined);
    // Every file that was written holds the content of the entry it was listed as.
    const expected = Object.fromEntries([...safe.map((stored) => [expectedPath(stored), body(stored).toString()]), ['link/inside.txt', body('link/inside.txt').toString()]]);
    assert.deepEqual(files(target), expected);

    // The climbing names are listed, so that the user sees them, and are blocked there already.
    const blocked = listing.entries.filter((entry) => entry.blocked);
    assert.equal(blocked.length, climbing.length);
    assert.equal(summary.failed.length, climbing.length);
    for (const failure of summary.failed) {
      assert.match(failure.reason, /outside the archive/);
    }
    // The link is listed as one, with where it points when the format says, and counted as left out.
    const link = listing.entries.find((entry) => entry.path === 'link');
    assert.equal(link?.kind, 'link');
    assert.equal(summary.links, name.includes('.tar') ? 2 : 1);
    assert.equal(summary.files, safe.length + 1);
    // What stood where the link would be is a real folder with a real file in it.
    assert.ok(fs.lstatSync(path.join(target, 'link')).isDirectory());
  });
}

test('a link is never extracted as a file either, and a folder is not a file', async () => {
  const { archive, target } = sandbox('kinds.zip', zipFile([{ name: 'folder/' }, { name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }, { name: 'file.txt', data: Buffer.from('x') }]));
  const listing = await listArchive(archive);
  assert.deepEqual(listing.entries.map((entry) => [entry.path, entry.kind]), [['folder', 'dir'], ['link', 'link'], ['file.txt', 'file']]);
  await assert.rejects(extractFile(archive, listing, 0, path.join(target, 'out')), /folder/);
  await assert.rejects(extractFile(archive, listing, 1, path.join(target, 'out')), /link/);
  assert.deepEqual(fs.readdirSync(target), []);
  await extractFile(archive, listing, 2, path.join(target, 'out'));
  assert.equal(fs.readFileSync(path.join(target, 'out'), 'utf8'), 'x');
});

test('tar: devices, pipes and sparse files are listed and not created', async () => {
  const { archive, target } = sandbox('special.tar', tarFile([{ name: 'dev/null', type: '3' }, { name: 'pipe', type: '6' }, { name: 'sparse.bin', type: 'S', data: Buffer.alloc(512) }, { name: 'ok.txt', data: Buffer.from('ok') }]));
  const { listing, summary } = await extractAll(archive, target);
  assert.deepEqual(listing.entries.map((entry) => !!entry.blocked), [true, true, true, false]);
  assert.equal(summary.failed.length, 3);
  assert.deepEqual(files(target), { 'ok.txt': 'ok' });
});

test('tar: the size field of a link is not data to skip', async () => {
  // A link has no data, whatever its header says; taking the number at its word would swallow what follows.
  const { archive, target } = sandbox('link-size.tar', tarFile([{ name: 'link', type: '2', link: 'elsewhere', size: 1024 }, { name: 'after.txt', data: Buffer.from('still here') }]));
  const { listing, summary } = await extractAll(archive, target);
  assert.deepEqual(listing.entries.map((entry) => [entry.path, entry.kind]), [['link', 'link'], ['after.txt', 'file']]);
  assert.equal(listing.entries[0].link, 'elsewhere');
  assert.equal(summary.links, 1);
  assert.deepEqual(files(target), { 'after.txt': 'still here' });
});

// ---- Sizes and checksums that lie ----------------------------------------------------------------

test('ZIP: an entry that unpacks to more than the directory says is cut off there and not kept', async () => {
  const zeros = Buffer.alloc(4 << 20);
  const { archive, root, target } = sandbox('bomb.zip', zipFile([{ name: 'zeros.bin', data: zeros, method: 8, size: 1000 }, { name: 'ok.txt', data: Buffer.from('fine\n'), method: 8 }]));
  const listing = await listArchive(archive);
  assert.equal(listing.entries[0].size, 1000);
  // What the directory promises is the most that is ever unpacked: the count of bytes written never passes it.
  let most = 0;
  const summary = await extractEntries(archive, listing, all(listing), target, { overwrite: false, onProgress: (done) => (most = Math.max(most, done)) });
  assert.ok(most <= 1000 + 5, `${most} bytes were unpacked`);
  assert.deepEqual(summary.failed.map((failure) => failure.path), ['zeros.bin']);
  assert.deepEqual(files(target), { 'ok.txt': 'fine\n' });
  assert.deepEqual(leftovers(root), []);
});

test('ZIP: a wrong checksum, or data shorter than stated, leaves nothing under the final name', async () => {
  const data = Buffer.from('some text that is long enough to be worth packing, packing, packing\n');
  for (const [label, lie] of [['checksum', { crc: 12345 }], ['size', { size: data.length + 10 }]] as const) {
    for (const method of [0, 8]) {
      const { archive, root, target } = sandbox(`${label}-${method}.zip`, zipFile([{ name: 'a.txt', data, method, ...lie }, { name: 'b.txt', data: Buffer.from('b') }]));
      const { summary } = await extractAll(archive, target);
      assert.deepEqual(summary.failed.map((failure) => failure.path), ['a.txt'], `${label}, method ${method}`);
      assert.deepEqual(files(target), { 'b.txt': 'b' });
      assert.deepEqual(leftovers(root), []);
    }
  }
});

test('7z: sizes that lie about where one file ends and the next begins are caught by the checksums', async () => {
  const { archive, root, target } = sandbox('lie.7z', sevenZipFile([{ name: 'a.txt', data: Buffer.alloc(1000, 0x41) }, { name: 'b.txt', data: Buffer.from('tail\n') }], [10, 995]));
  const listing = await listArchive(archive);
  const summary = await extractEntries(archive, listing, all(listing), target, { overwrite: false }).catch((e: Error) => e);
  // Whatever is reported, no file may be there with content that is not its own.
  assert.ok(summary instanceof Error || summary.failed.length === 2, JSON.stringify(summary));
  assert.deepEqual(files(target), {});
  assert.deepEqual(leftovers(root), []);
});

test('RAR: output past the declared size is refused', async () => {
  const { archive, root, target } = sandbox('lie.rar', rarFile([{ name: 'a.txt', data: Buffer.alloc(100_000, 0x78), size: 10 }, { name: 'b.txt', data: Buffer.from('after\n') }]));
  const listing = await listArchive(archive);
  assert.equal(listing.entries[0].size, 10);
  const summary = await extractEntries(archive, listing, all(listing), target, { overwrite: false }).catch((e: Error) => e);
  assert.ok(summary instanceof Error || summary.failed.some((failure) => failure.path === 'a.txt'), JSON.stringify(summary));
  assert.equal(fs.existsSync(path.join(target, 'a.txt')), false);
  assert.deepEqual(leftovers(root), []);
});

// ---- Existing files, subtrees, cancelling -----------------------------------------------------------

const PLAIN = () => zipFile([{ name: 'top.txt', data: Buffer.from('top') }, { name: 'src/' }, { name: 'src/a.txt', data: Buffer.from('a'), method: 8 }, { name: 'src/deep/b.txt', data: Buffer.from('b') }, { name: 'src/deep/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o100755 }]);

test('files that exist are counted and left alone, or replaced when that is asked for', async () => {
  const { archive, target } = sandbox('plain.zip', PLAIN());
  const listing = await listArchive(archive);
  assert.equal(await countExisting(listing, all(listing), target), 0);
  const first = await extractEntries(archive, listing, all(listing), target, { overwrite: false });
  assert.deepEqual([first.files, first.folders, first.skipped, first.failed.length], [4, 1, 0, 0]);
  assert.equal(await countExisting(listing, all(listing), target), 4);

  fs.writeFileSync(path.join(target, 'top.txt'), 'mine');
  const kept = await extractEntries(archive, listing, all(listing), target, { overwrite: false });
  assert.deepEqual([kept.files, kept.skipped], [0, 4]);
  assert.equal(fs.readFileSync(path.join(target, 'top.txt'), 'utf8'), 'mine');

  const replaced = await extractEntries(archive, listing, all(listing), target, { overwrite: true });
  assert.deepEqual([replaced.files, replaced.skipped], [4, 0]);
  assert.equal(fs.readFileSync(path.join(target, 'top.txt'), 'utf8'), 'top');
});

test('a subtree lands under its own name, with the time and the executable bit of the entry', { skip: process.platform === 'win32' && 'no file modes on Windows' }, async () => {
  const { archive, target } = sandbox('plain.zip', PLAIN());
  const listing = await listArchive(archive);
  const wanted = all(listing).filter((i) => listing.entries[i].path.startsWith('src/deep'));
  const summary = await extractEntries(archive, listing, wanted, target, { overwrite: false, strip: 'src/'.length });
  assert.equal(summary.files, 2);
  assert.deepEqual(Object.keys(tree(target)), ['deep/', 'deep/b.txt', 'deep/run.sh']);
  assert.ok(fs.statSync(path.join(target, 'deep', 'run.sh')).mode & 0o100);
  assert.equal(fs.statSync(path.join(target, 'deep', 'b.txt')).mode & 0o111, 0);
  assert.equal(fs.statSync(path.join(target, 'deep', 'b.txt')).mtimeMs, listing.entries[3].mtime);
});

test('something in the way of a file or a folder fails that entry and not the others', async () => {
  const { archive, target } = sandbox('plain.zip', PLAIN());
  fs.writeFileSync(path.join(target, 'src'), 'a file where a folder should be');
  const { summary } = await extractAll(archive, target);
  assert.equal(summary.files, 1);
  assert.ok(summary.failed.length >= 3);
  assert.ok(summary.failed.every((failure) => /in the way/.test(failure.reason)), JSON.stringify(summary.failed));
  assert.equal(fs.readFileSync(path.join(target, 'src'), 'utf8'), 'a file where a folder should be');
  assert.equal(fs.readFileSync(path.join(target, 'top.txt'), 'utf8'), 'top');
});

test('a cancelled extraction reports that it was cancelled and leaves no half-written file', async () => {
  const big = random(5).bytes(300_000);
  const { archive, root, target } = sandbox('big.zip', zipFile(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.bin`, data: big, method: 8 }))));
  const listing = await listArchive(archive);
  const abort = new AbortController();
  const summary = await extractEntries(archive, listing, all(listing), target, {
    overwrite: false,
    signal: abort.signal,
    onProgress: (done) => {
      if (done > 1_000_000) {
        abort.abort();
      }
    },
  });
  assert.equal(summary.cancelled, true);
  assert.ok(summary.files < 30);
  assert.deepEqual(leftovers(root), []);
  for (const name of fs.readdirSync(target)) {
    assert.ok(fs.readFileSync(path.join(target, name)).equals(big), `${name} is not whole`);
  }
});

test('an archive that is not one says so, and an empty file says that', async () => {
  const garbage = sandbox('garbage.zip', random(9).bytes(2000));
  await assert.rejects(listArchive(garbage.archive), /not a ZIP, 7z, RAR or tar archive/);
  const empty = sandbox('empty.zip', Buffer.alloc(0));
  await assert.rejects(listArchive(empty.archive), /empty/);
});

// ---- Passwords -------------------------------------------------------------------------------------

test('a password problem is a PasswordError that says whether the password is missing or wrong', () => {
  assert.equal(new PasswordError(false).wrong, false);
  assert.equal(new PasswordError(true).wrong, true);
  // The name is how it is recognised after it has crossed from the worker thread.
  assert.equal(new PasswordError(true).name, 'PasswordError');
});

// ---- Damage -----------------------------------------------------------------------------------------
//
// Cut, flipped and zeroed archives. The reader may list less, warn, fail entries or throw; what it may not
// do is hang, leave a .part file, or write a file whose content is not the content of a file of the archive.
// (tar has no checksum of its own, so a flipped byte in a plain tar is a flipped byte in the file; a packed
// tar is verified at the end of the stream, which the listing reports as a warning.)

const ORIGINAL: Record<string, Buffer> = {
  'a.txt': Buffer.from(Array.from({ length: 60 }, (_, i) => `line ${i} of the first file\n`).join('')),
  'dir/b.bin': random(11).bytes(3000),
  'dir/c.txt': Buffer.from('short\n'),
  'd.txt': Buffer.from(Array.from({ length: 80 }, (_, i) => `${i * 7919}\n`).join('')),
};
const items = Object.entries(ORIGINAL).map(([name, data]) => ({ name, data }));

const DAMAGED: Record<string, { bytes: () => Buffer; strict: boolean }> = {
  'damaged.zip': { bytes: () => zipFile(items.map((item) => ({ ...item, method: 8 }))), strict: true },
  'damaged-stored.zip': { bytes: () => zipFile(items), strict: true },
  'damaged.7z': { bytes: () => sevenZipFile(items), strict: true },
  'damaged.rar': { bytes: () => rarFile(items), strict: true },
  'damaged.tar.gz': { bytes: () => zlib.gzipSync(tarFile(items)), strict: false },
  'damaged.tar': { bytes: () => tarFile(items), strict: false },
};

for (const [name, { bytes, strict }] of Object.entries(DAMAGED)) {
  test(`${name}: damage never produces a file with content of its own making`, { timeout: 60_000 }, async () => {
    const whole = bytes();
    const rand = random(name.length * 7919);
    const flip = (at: number) => {
      const copy = Buffer.from(whole);
      copy[at] ^= 1 << rand.int(8);
      return copy;
    };
    // The worker formats take longer per archive, so they get fewer variants.
    const worker = name.endsWith('.7z') || name.endsWith('.rar');
    const variants: [string, Buffer][] = [
      ['cut to 3 bytes', whole.subarray(0, 3)],
      ['cut in half', whole.subarray(0, whole.length >> 1)],
      ['cut 20 bytes short', whole.subarray(0, whole.length - 20)],
      ['zeros in the middle', Buffer.concat([whole.subarray(0, whole.length >> 1), Buffer.alloc(200), whole.subarray((whole.length >> 1) + 200)])],
      ...Array.from({ length: worker ? 6 : 24 }, (): [string, Buffer] => {
        const at = rand.int(whole.length);
        return [`a bit flipped at ${at}`, flip(at)];
      }),
      ...Array.from({ length: worker ? 2 : 6 }, (): [string, Buffer] => {
        const at = 1 + rand.int(whole.length - 1);
        return [`cut at ${at}`, whole.subarray(0, at)];
      }),
    ];
    const contents = Object.values(ORIGINAL);
    for (const [label, damaged] of variants) {
      const { archive, root, target } = sandbox(name, damaged);
      let reported = false;
      try {
        const listing = await listArchive(archive);
        reported ||= !!listing.warning || listing.entries.length !== items.length;
        const summary = await extractEntries(archive, listing, all(listing), target, { overwrite: false });
        reported ||= summary.failed.length > 0;
      } catch {
        reported = true;
      }
      assert.deepEqual(leftovers(root), [], `${label}: a .part file was left`);
      assert.deepEqual(fs.readdirSync(root).sort(), [name, 'target'].sort(), label);
      const written = Object.keys(tree(target)).filter((entry) => !entry.endsWith('/'));
      const foreign = written.filter((entry) => !contents.some((content) => content.equals(fs.readFileSync(path.join(target, entry)))));
      if (strict) {
        assert.deepEqual(foreign, [], `${label}: files with content that is in no file of the archive`);
      } else {
        assert.ok(!foreign.length || reported || name.endsWith('.tar'), `${label}: ${foreign.join(', ')} changed and nothing was reported`);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
