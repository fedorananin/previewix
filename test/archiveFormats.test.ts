import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import * as zlib from 'zlib';
import { PasswordError, extractEntries, extractFile, listArchive, maybeWrongPassword, type Listing } from '../src/archive/index';
import { tarFile, treeFiles, zipFile } from './archives';
import { fixture, scratch, tree } from './helpers';

// Reading the formats (src/archive/): every decoder this extension has of its own, against small archives
// of one known tree. The archives in test/fixtures/archive were written by bsdtar and 7-Zip (make.js there),
// and what they must unpack to is computed here, by treeFiles(). The RAR files are someone else's (see the
// README next to them). What can be written by hand (tar headers, ZIP names) is built in the test.

const dir = scratch();
const TREE = treeFiles();
const archive = (name: string) => fixture(path.join('archive', name));

let count = 0;
const fresh = () => {
  const target = path.join(dir, `out-${++count}`);
  fs.mkdirSync(target);
  return target;
};
const all = (listing: Listing) => listing.entries.map((_, i) => i);

/** The files under a folder with their content. */
function contents(folder: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const name of Object.keys(tree(folder))) {
    if (!name.endsWith('/')) {
      out[name.normalize('NFC')] = fs.readFileSync(path.join(folder, name));
    }
  }
  return out;
}

/** Lists the archive, unpacks all of it, and compares what lies on disk with the tree. */
async function unpacksToTree(file: string, format: string, password?: string): Promise<Listing> {
  const listing = await listArchive(file, { password });
  assert.equal(listing.format, format);
  // The listing alone says what there is and how large, before anything is unpacked.
  const listed = new Map(listing.entries.map((entry) => [entry.path.normalize('NFC'), entry]));
  for (const [name, data] of Object.entries(TREE)) {
    assert.equal(listed.get(name)?.kind, 'file', `${name} is not listed as a file`);
    assert.equal(listed.get(name)?.size, data.length, `the size of ${name}`);
  }
  assert.equal(listed.get('emptydir')?.kind, 'dir');
  assert.equal(listed.get('src/deep')?.kind, 'dir');

  const target = fresh();
  const summary = await extractEntries(file, listing, all(listing), target, { overwrite: false, password });
  assert.deepEqual(summary.failed, []);
  assert.equal(summary.files, Object.keys(TREE).length);
  assert.deepEqual(contents(target), TREE);
  assert.ok(fs.statSync(path.join(target, 'emptydir')).isDirectory());
  return listing;
}

// ---- tar ------------------------------------------------------------------------------------------

const ZSTD = typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === 'function';

test('tar.bz2: the bzip2 decoder', async () => {
  const listing = await unpacksToTree(archive('tree.tar.bz2'), 'tar.bz2');
  assert.equal(listing.warning, undefined);
});

test('tar.xz: the xz and LZMA2 decoders', async () => {
  const listing = await unpacksToTree(archive('tree.tar.xz'), 'tar.xz');
  assert.equal(listing.warning, undefined);
});

test('tar.zst, where the runtime has Zstandard', { skip: !ZSTD && 'this Node.js has no Zstandard in zlib (22.15 and later have)' }, async () => {
  await unpacksToTree(archive('tree.tar.zst'), 'tar.zst');
});

test('tar and tar.gz: time and executable bit come from the headers', { skip: process.platform === 'win32' && 'no file modes on Windows' }, async () => {
  const items = [
    ...Object.entries(TREE).map(([name, data]) => ({ name, data, pax: /[^\x20-\x7e]/.test(name), mode: name.endsWith('.sh') ? 0o755 : 0o644 })),
    { name: 'emptydir/', type: '5' },
    { name: 'src/deep/', type: '5' },
  ];
  for (const [name, bytes, format] of [['plain.tar', tarFile(items), 'tar'], ['packed.tgz', zlib.gzipSync(tarFile(items)), 'tar.gz']] as const) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    const listing = await unpacksToTree(file, format);
    const target = fresh();
    const index = listing.entries.findIndex((entry) => entry.path === 'src/deep/run.sh');
    // One file from the middle, by itself.
    await extractFile(file, listing, index, path.join(target, 'run.sh'));
    assert.deepEqual(fs.readFileSync(path.join(target, 'run.sh')), TREE['src/deep/run.sh']);
    assert.ok(fs.statSync(path.join(target, 'run.sh')).mode & 0o100);
    assert.equal(fs.statSync(path.join(target, 'run.sh')).mtimeMs, 1709374830000);
    assert.equal(listing.entries[index].mtime, 1709374830000);
  }
});

test('tar: long names the three ways they are written (ustar prefix, GNU, pax), and what a pax header says wins', async () => {
  const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}.txt`;
  const prefixed = tarFile([{ name: 'short.txt', data: Buffer.from('x') }]);
  // ustar: the name is the prefix at offset 345, a slash, and the name field.
  prefixed.write('some/prefix', 345, 'latin1');
  prefixed.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of prefixed.subarray(0, 512)) {
    sum += byte;
  }
  prefixed.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const cases: [string, Buffer, string[]][] = [
    ['prefix.tar', prefixed, ['some/prefix/short.txt']],
    ['gnu.tar', tarFile([{ name: long, data: Buffer.from('gnu'), gnu: true }, { name: 'after.txt', data: Buffer.from('a') }]), [long, 'after.txt']],
    ['pax.tar', tarFile([{ name: `юникод/${long}`, data: Buffer.from('pax'), pax: true }, { name: 'after.txt', data: Buffer.from('a') }]), [`юникод/${long}`, 'after.txt']],
  ];
  for (const [name, bytes, expected] of cases) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    assert.deepEqual((await listArchive(file)).entries.map((entry) => entry.path), expected, name);
  }
});

test('the format is told from the content, not from the name', async () => {
  const file = path.join(dir, 'really-a-tar.zip');
  fs.writeFileSync(file, zlib.gzipSync(tarFile([{ name: 'a.txt', data: Buffer.from('a') }])));
  assert.equal((await listArchive(file)).format, 'tar.gz');
  const other = path.join(dir, 'really-a-zip.tar.gz');
  fs.writeFileSync(other, zipFile([{ name: 'a.txt', data: Buffer.from('a') }]));
  assert.equal((await listArchive(other)).format, 'ZIP');
});

// ---- ZIP ------------------------------------------------------------------------------------------

test('ZIP: stored and deflated entries, and a program in front of the archive', async () => {
  const items = [...Object.entries(TREE).map(([name, data], i) => ({ name, data, method: i % 2 ? 8 : 0, flags: 0x800 })), { name: 'emptydir/' }, { name: 'src/deep/' }];
  const file = path.join(dir, 'plain.zip');
  fs.writeFileSync(file, zipFile(items));
  await unpacksToTree(file, 'ZIP');
  // A self-extracting archive: every offset in it is off by the length of the stub.
  const stubbed = path.join(dir, 'self-extracting.exe');
  fs.writeFileSync(stubbed, zipFile(items, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(3000, 0x90)])));
  await unpacksToTree(stubbed, 'ZIP');
});

for (const [name, what] of [['deflate64.zip', 'Deflate64'], ['bzip2.zip', 'bzip2'], ['lzma.zip', 'LZMA'], ['xz.zip', 'XZ']]) {
  test(`ZIP packed with ${what}`, async () => {
    await unpacksToTree(archive(name), 'ZIP');
  });
}

test('ZIP names without the UTF-8 flag: UTF-8 when the bytes are, otherwise CP866 for Russian and CP437 for the rest', async () => {
  // "Привет.txt" in CP866, "café.txt" in CP437, and UTF-8 that nobody flagged.
  const cp866 = Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2, 0x2e, 0x74, 0x78, 0x74]);
  const cp437 = Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]);
  const cases: [string, Buffer[], string[]][] = [
    ['cp866.zip', [cp866, Buffer.from('plain.txt')], ['Привет.txt', 'plain.txt']],
    ['cp437.zip', [cp437, Buffer.from('plain.txt')], ['café.txt', 'plain.txt']],
    ['utf8.zip', [Buffer.from('Привет 標題.txt', 'utf8')], ['Привет 標題.txt']],
  ];
  for (const [name, names, expected] of cases) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, zipFile(names.map((bytes) => ({ name: bytes, data: Buffer.from('x') }))));
    assert.deepEqual((await listArchive(file)).entries.map((entry) => entry.path), expected, name);
  }
  // A name that is only known once the code page is chosen is checked then, like any other.
  const climbing = path.join(dir, 'cp866-climbing.zip');
  fs.writeFileSync(climbing, zipFile([{ name: Buffer.concat([Buffer.from('../'), cp866]), data: Buffer.from('x') }]));
  const [entry] = (await listArchive(climbing)).entries;
  assert.equal(entry.path, '../Привет.txt');
  assert.match(entry.blocked ?? '', /outside the archive/);
});

test('ZIP: the Info-ZIP Unicode name is taken only when its checksum matches the plain name', async () => {
  const plain = Buffer.from([0x3f, 0x3f, 0x3f, 0x2e, 0x74, 0x78, 0x74]); // "???.txt", what an old archiver made of the name
  const unicode = (crc: number) => {
    const name = Buffer.from('имя.txt', 'utf8');
    const field = Buffer.alloc(9 + name.length);
    field.writeUInt16LE(0x7075, 0);
    field.writeUInt16LE(5 + name.length, 2);
    field[4] = 1;
    field.writeUInt32LE(crc, 5);
    name.copy(field, 9);
    return field;
  };
  const right = path.join(dir, 'unicode-path.zip');
  fs.writeFileSync(right, zipFile([{ name: plain, data: Buffer.from('x'), extra: unicode(zlib.crc32(plain)) }]));
  assert.deepEqual((await listArchive(right)).entries.map((entry) => entry.path), ['имя.txt']);
  const stale = path.join(dir, 'unicode-path-stale.zip');
  fs.writeFileSync(stale, zipFile([{ name: plain, data: Buffer.from('x'), extra: unicode(12345) }]));
  assert.deepEqual((await listArchive(stale)).entries.map((entry) => entry.path), ['???.txt']);
});

test('ZIP and 7z packed with PPMd are listed, with the reason those files can\'t be unpacked', async () => {
  for (const name of ['ppmd.zip', 'ppmd.7z']) {
    const listing = await listArchive(archive(name));
    const blocked = listing.entries.filter((entry) => entry.blocked);
    // 7-Zip stores the smallest files of a ZIP as they are; the larger ones are what PPMd was used on.
    assert.ok(blocked.length >= 2 && blocked.every((entry) => /PPMd/.test(entry.blocked ?? '')), `${name}: ${JSON.stringify(listing.entries.map((entry) => entry.blocked))}`);
    assert.ok(blocked.some((entry) => entry.path === 'src/text.js'));
    const target = fresh();
    const summary = await extractEntries(archive(name), listing, all(listing), target, { overwrite: false });
    assert.deepEqual(summary.failed.map((failure) => failure.path).sort(), blocked.map((entry) => entry.path).sort());
    // What could be unpacked is right, and nothing stands in for what couldn't.
    const written = contents(target);
    assert.equal(Object.keys(written).length, Object.keys(TREE).length - blocked.length);
    for (const [file, data] of Object.entries(written)) {
      assert.deepEqual(data, TREE[file], file);
    }
  }
});

// ---- 7z -------------------------------------------------------------------------------------------

for (const [name, what] of [
  ['lzma2.7z', 'LZMA2, solid'], ['lzma1-nonsolid.7z', 'LZMA, a folder per file'], ['bcj.7z', 'the x86 branch filter'], ['arm64.7z', 'the ARM64 branch filter'],
  ['delta.7z', 'the Delta filter'], ['bzip2.7z', 'bzip2'], ['deflate.7z', 'Deflate'], ['deflate64.7z', 'Deflate64'],
]) {
  test(`7z with ${what}`, async () => {
    await unpacksToTree(archive(name), '7z');
  });
}

test('7z: one file from the middle of a solid archive', async () => {
  const listing = await listArchive(archive('lzma2.7z'));
  const target = fresh();
  await extractFile(archive('lzma2.7z'), listing, listing.entries.findIndex((entry) => entry.path === 'src/text.js'), path.join(target, 'one.js'));
  assert.deepEqual(fs.readFileSync(path.join(target, 'one.js')), TREE['src/text.js']);
  assert.deepEqual(fs.readdirSync(target), ['one.js']);
});

// ---- Passwords --------------------------------------------------------------------------------------

/** No password and a wrong one: a PasswordError, or the "damaged, or the password is wrong" of a format without a check value, and nothing on disk. */
async function refusesWithout(file: string, listing: Listing, certain: boolean): Promise<void> {
  const target = fresh();
  await assert.rejects(extractEntries(file, listing, all(listing), target, { overwrite: false }), (e) => e instanceof PasswordError && !e.wrong);
  const wrong = await extractEntries(file, listing, all(listing), target, { overwrite: false, password: 'not it' }).catch((e: unknown) => e);
  if (certain) {
    assert.ok(wrong instanceof PasswordError && wrong.wrong, `a wrong password was not recognised: ${JSON.stringify(wrong)}`);
  } else {
    assert.ok(wrong instanceof PasswordError || maybeWrongPassword(wrong) || (!(wrong instanceof Error) && (wrong as { failed: unknown[] }).failed.length > 0), JSON.stringify(wrong));
  }
  // Whatever was said, nothing of the encrypted files may be on disk, and above all nothing wrong.
  assert.ok(Object.values(contents(target)).every((data) => data.length === 0), 'a file was written without the password');
}

for (const [name, what] of [['zipcrypto.zip', 'the classic ZIP encryption'], ['aes256.zip', 'WinZip AES-256'], ['aes128-lzma.zip', 'WinZip AES-128 over LZMA']]) {
  test(`ZIP with ${what}: the names are readable, the files need the password`, async () => {
    const listing = await listArchive(archive(name));
    assert.ok(listing.entries.filter((entry) => entry.kind === 'file' && entry.size).every((entry) => entry.encrypted));
    await refusesWithout(archive(name), listing, true);
    await unpacksToTree(archive(name), 'ZIP', 'Secret');
  });
}

test('7z with encrypted files: the names are readable, the files need the password', async () => {
  const listing = await listArchive(archive('encrypted.7z'));
  assert.ok(!listing.locked);
  assert.ok(listing.entries.filter((entry) => entry.kind === 'file' && entry.size).every((entry) => entry.encrypted));
  // 7z keeps no check value for a password.
  await refusesWithout(archive('encrypted.7z'), listing, false);
  await unpacksToTree(archive('encrypted.7z'), '7z', 'Secret');
});

test('7z with encrypted names: even the list needs the password', async () => {
  await assert.rejects(listArchive(archive('encrypted-names.7z')), (e) => e instanceof PasswordError && !e.wrong);
  await assert.rejects(listArchive(archive('encrypted-names.7z'), { password: 'not it' }), (e) => e instanceof PasswordError && e.wrong);
  const listing = await unpacksToTree(archive('encrypted-names.7z'), '7z', 'Secret');
  assert.equal(listing.locked, true);
});

// ---- RAR --------------------------------------------------------------------------------------------

const STEST = Buffer.from(Array.from({ length: 512 }, (_, i) => `${String(i).padStart(3, '0')}\n`).join(''));

for (const name of ['rar5-solid.rar', 'rar3-solid.rar']) {
  test(`RAR: ${name}`, async () => {
    const file = archive(path.join('rar', name));
    const listing = await listArchive(file);
    assert.equal(listing.format, 'RAR');
    assert.deepEqual(listing.entries.map((entry) => [entry.path, entry.kind, entry.size]), [['stest1.txt', 'file', 2048], ['stest2.txt', 'file', 2048]]);
    const target = fresh();
    const summary = await extractEntries(file, listing, all(listing), target, { overwrite: false });
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(contents(target), { 'stest1.txt': STEST, 'stest2.txt': STEST });
    // The second file of a solid archive, by itself.
    await extractFile(file, listing, 1, path.join(target, 'second.txt'));
    assert.deepEqual(fs.readFileSync(path.join(target, 'second.txt')), STEST);
  });
}

test('RAR with a password', async () => {
  const file = archive(path.join('rar', 'rar5-psw.rar'));
  const listing = await listArchive(file);
  assert.ok(listing.entries.every((entry) => entry.encrypted));
  await refusesWithout(file, listing, true);
  const target = fresh();
  const summary = await extractEntries(file, listing, all(listing), target, { overwrite: false, password: 'password' });
  assert.deepEqual(summary.failed, []);
  assert.deepEqual(contents(target), { 'stest1.txt': STEST, 'stest2.txt': STEST });
});

test('RAR: symbolic links are listed and never created, wherever they point', async () => {
  const file = archive(path.join('rar', 'rar5-symlink-unix.rar'));
  const listing = await listArchive(file);
  assert.deepEqual(listing.entries.map((entry) => [entry.path, entry.kind]).sort(), [['data.txt', 'file'], ['data_link', 'link'], ['random_link', 'link']]);
  const target = fresh();
  const summary = await extractEntries(file, listing, all(listing), target, { overwrite: false });
  assert.equal(summary.links, 2);
  assert.deepEqual(Object.keys(tree(target)), ['data.txt']);
  assert.equal(fs.readFileSync(path.join(target, 'data.txt'), 'utf8'), 'data\n');
});
