// Rebuilds the archives in this folder. They are committed, and the tests never run this.
//
//   SEVENZIP=<path to the cli.js of the 7z-wasm package> node test/fixtures/archive/make.js
//
// Needs bsdtar (for bzip2, xz and Zstandard), and 7-Zip for everything else: `npm install 7z-wasm` somewhere
// outside the project, it is a tool for this script only. The RAR archives can't be made here at all; see
// rar/README.md for where they come from.
//
// Every archive holds the same small tree. Its content is computed by content() below, and again by
// treeFiles() in test/archives.ts, which is what the tests compare the unpacked files with: keep the two alike.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Lines of text, which every method packs well. */
function text(name, lines) {
  return Buffer.from(Array.from({ length: lines }, (_, i) => `${name} line ${i + 1}: the quick brown fox jumps over the lazy dog\n`).join(''));
}

/** Bytes without a pattern (they stay as large as they are), then a long run and a short cycle (what bzip2 and the filters look at). */
function binary(length) {
  const out = Buffer.alloc(length + 3000 + 600);
  let state = 12345;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 16;
  }
  out.fill(0x41, length, length + 3000);
  for (let i = 0; i < 600; i++) {
    out[length + 3000 + i] = i % 7;
  }
  return out;
}

const FILES = {
  'hello.txt': Buffer.from('Hello, world\n'),
  'empty.txt': Buffer.alloc(0),
  'src/text.js': text('src/text.js', 40),
  'src/deep/data.bin': binary(1200),
  'src/deep/run.sh': Buffer.from('#!/bin/sh\necho hi\n'),
  'юникод/файл.txt': Buffer.from('Привет\n'),
};

const here = __dirname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'previewix-fx-'));
const tree = path.join(work, 'tree');
for (const [name, data] of Object.entries(FILES)) {
  const file = path.join(tree, ...name.normalize('NFC').split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.utimesSync(file, new Date('2024-03-02T10:20:30Z'), new Date('2024-03-02T10:20:30Z'));
}
fs.chmodSync(path.join(tree, 'src', 'deep', 'run.sh'), 0o755);
fs.mkdirSync(path.join(tree, 'emptydir'));

const out = (name) => path.join(here, name);
const tar = (name, ...options) => execFileSync('bsdtar', ['--no-mac-metadata', '--format', 'pax', ...options, '-cf', out(name), '-C', tree, '.']);
const sevenZip = (name, ...options) => {
  // 7-Zip compiled to WebAssembly sees the folder it is started in and what lies around it by relative paths only.
  execFileSync('node', [process.env.SEVENZIP, 'a', '-bso0', '-bsp0', `../${name}`, ...options, '.'], { cwd: tree });
  fs.copyFileSync(path.join(work, name), out(name));
};

tar('tree.tar.bz2', '-j');
tar('tree.tar.xz', '-J');
tar('tree.tar.zst', '--zstd');

sevenZip('lzma2.7z');
sevenZip('lzma1-nonsolid.7z', '-ms=off', '-m0=lzma:d=64k');
sevenZip('bcj.7z', '-mf=BCJ');
sevenZip('arm64.7z', '-mf=ARM64');
sevenZip('delta.7z', '-mf=Delta:4');
sevenZip('bzip2.7z', '-m0=bzip2');
sevenZip('deflate.7z', '-m0=deflate');
sevenZip('deflate64.7z', '-m0=deflate64');
sevenZip('ppmd.7z', '-m0=ppmd');
sevenZip('encrypted.7z', '-pSecret');
sevenZip('encrypted-names.7z', '-pSecret', '-mhe=on');

sevenZip('lzma.zip', '-tzip', '-mm=LZMA');
sevenZip('bzip2.zip', '-tzip', '-mm=BZip2');
sevenZip('deflate64.zip', '-tzip', '-mm=Deflate64');
sevenZip('xz.zip', '-tzip', '-mm=xz');
sevenZip('ppmd.zip', '-tzip', '-mm=PPMd');
sevenZip('aes256.zip', '-tzip', '-mem=AES256', '-pSecret');
sevenZip('aes128-lzma.zip', '-tzip', '-mem=AES128', '-mm=LZMA', '-pSecret');
sevenZip('zipcrypto.zip', '-tzip', '-mem=ZipCrypto', '-pSecret');

fs.rmSync(work, { recursive: true, force: true });
for (const name of fs.readdirSync(here).sort()) {
  console.log(String(fs.statSync(out(name)).size).padStart(7), name);
}
