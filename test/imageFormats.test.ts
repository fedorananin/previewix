import * as fs from 'fs';
import { createRequire } from 'module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'path';
import * as zlib from 'zlib';
import { bmpWithProfile, isRgbProfile } from '../src/imageFormats/bmp';
import { DecodeError, type Raster, checkSize, encodeSrgb, iccName, labToSrgb, orient, to8, unpremultiply } from '../src/imageFormats/common';
import { type LibHeif, decodeHeic } from '../src/imageFormats/heicDecode';
import { readHeif } from '../src/imageFormats/heif';
import { type IcnsEntry, decodeIcns, listIcns } from '../src/imageFormats/icns';
import { icoPicture, listIco } from '../src/imageFormats/ico';
import { decodePsd } from '../src/imageFormats/psd';
import { FORMAT_NAMES, brandsOf, sniffFormat } from '../src/imageFormats/sniff';
import { listTiff } from '../src/imageFormats/tiff';
import { decodeTiff } from '../src/imageFormats/tiffDecode';
import { fixture, needs, random, root, run, scratch, which } from './helpers';

// Sniffing, the shared arithmetic, the bitmap wrapper, ICO, ICNS, the HEIF box reader and libheif.
// TIFF and PSD have files of their own (tiff.test.ts, psd.test.ts). Every file but one small HEIC is
// built here by hand, so what a reader has to find in it is known beforehand.

const dir = scratch();
const rnd = random(41);
const latin = (text: string) => Buffer.from(text, 'latin1');
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([latin(type), data]);
  return Buffer.concat([u32(data.length), body, u32(zlib.crc32(body))]);
}

/** A real PNG. `colorType` 6 takes RGBA, 2 RGB, 3 palette indexes (with a gray palette), all 8 bits. */
function png(width: number, height: number, samples?: Uint8Array, colorType = 6): Buffer {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const data = samples ?? new Uint8Array(width * height * channels);
  const rows = Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), data.subarray(y * width * channels, (y + 1) * width * channels)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, colorType, 0, 0, 0])])),
    ...(colorType === 3 ? [pngChunk('PLTE', Buffer.from(Array.from({ length: 768 }, (_, i) => Math.floor(i / 3))))] : []),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Compares pixel by pixel and names the first one that is wrong. Colors under an alpha of 0 mean nothing and are not compared. */
function assertPixels(raster: Raster, width: number, height: number, expected: ArrayLike<number>, tolerance = 0): void {
  assert.deepEqual([raster.width, raster.height], [width, height]);
  assert.equal(raster.data.length, width * height * 4);
  assert.equal(expected.length, raster.data.length);
  for (let i = 0; i < expected.length; i += 4) {
    const got = Array.from(raster.data.subarray(i, i + 4));
    const want = Array.from({ length: 4 }, (_, c) => expected[i + c]);
    const hidden = got[3] === 0 && want[3] === 0;
    if (got[3] !== want[3] || (!hidden && got.some((value, c) => Math.abs(value - want[c]) > tolerance))) {
      assert.fail(`pixel ${(i / 4) % width}, ${Math.floor(i / 4 / width)}: got ${got}, expected ${want}`);
    }
  }
}

/** No damaged file may keep a reader busy for longer; they are all small. */
const BUDGET_MS = 1000;

/** Runs `work` on a damaged file: it may refuse with a DecodeError, and nothing else, and has to be quick about it. */
function survive(what: string, work: () => void): 'fine' | 'refused' {
  const started = performance.now();
  let outcome: 'fine' | 'refused' = 'fine';
  try {
    work();
  } catch (e) {
    if (!(e instanceof DecodeError)) {
      throw new Error(`${what}: threw something else than a DecodeError: ${e instanceof Error ? e.stack : e}`);
    }
    outcome = 'refused';
  }
  const took = performance.now() - started;
  assert.ok(took < BUDGET_MS, `${what}: took ${Math.round(took)} ms`);
  return outcome;
}

// ---- Sniffing ---------------------------------------------------------------------

const ftyp = (major: string, ...compatible: string[]) => Buffer.concat([u32(16 + compatible.length * 4), latin('ftyp'), latin(major), u32(0), ...compatible.map(latin)]);
const padded = (start: Uint8Array) => Buffer.concat([start, Buffer.alloc(32)]);

test('every format is told from its first bytes', () => {
  const signatures: [Uint8Array, string][] = [
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'jpeg'],
    [latin('GIF89a'), 'gif'],
    [latin('GIF87a'), 'gif'],
    [latin('RIFF\x24\0\0\0WEBPVP8 '), 'webp'],
    [latin('8BPS\0\x01'), 'psd'],
    [latin('8BPS\0\x02'), 'psd'],
    [latin('icns\0\0\x10\0'), 'icns'],
    [latin('II*\0\x08\0\0\0'), 'tiff'],
    [latin('MM\0*\0\0\0\x08'), 'tiff'],
    // BigTIFF is a TIFF to the sniffer; the reader is the one to say that it can't be shown.
    [latin('II+\0\x08\0\0\0'), 'tiff'],
    [latin('MM\0+\0\x08\0\0'), 'tiff'],
    [ftyp('heic', 'mif1', 'heic'), 'heic'],
    [ftyp('heix', 'mif1'), 'heic'],
    [ftyp('mif1', 'mif1', 'heic'), 'heic'],
    [ftyp('msf1', 'hevc'), 'heic'],
    [ftyp('avif', 'mif1', 'miaf'), 'avif'],
    [ftyp('avis', 'msf1'), 'avif'],
    // An AVIF picture that names the general brand first is still Chromium's to decode.
    [ftyp('mif1', 'miaf', 'avif'), 'avif'],
    [latin('BM\x36\0\0\0\0\0\0\0\x36\0\0\0'), 'bmp'],
    [Buffer.from([0, 0, 1, 0, 1, 0]), 'ico'],
    [Buffer.from([0, 0, 2, 0, 1, 0]), 'ico'],
  ];
  for (const [start, format] of signatures) {
    assert.equal(sniffFormat(padded(start)), format, Buffer.from(start).toString('latin1'));
  }
});

test('what is no picture, or too short to tell, has no format', () => {
  for (const bytes of [Buffer.alloc(0), latin('GIF89a'), latin('This is not a picture at all.'), Buffer.alloc(64), padded(latin('RIFF\x24\0\0\0WAVEfmt ')), padded(Buffer.from([0, 0, 3, 0])), padded(latin('II\0*')), padded(latin('MM*\0'))]) {
    assert.equal(sniffFormat(bytes), '');
  }
  // The four bytes in front of `ftyp` are a length, not part of the signature.
  assert.equal(sniffFormat(padded(latin('ftypheic'))), '');
});

test('the brands of an ISO media file: the major one, then the compatible ones, within the box', () => {
  assert.deepEqual(brandsOf(Buffer.concat([ftyp('heic', 'mif1', 'miaf'), latin('junkjunk')])), ['heic', 'mif1', 'miaf']);
  assert.deepEqual(brandsOf(ftyp('avif')), ['avif']);
  assert.deepEqual(brandsOf(latin('RIFF\0\0\0\0WEBPVP8 ')), []);
  // A box that claims to be longer than the file ends with the file.
  const cut = ftyp('heic', 'mif1', 'miaf').subarray(0, 22);
  assert.deepEqual(brandsOf(cut), ['heic', 'mif1']);
});

test('every format the sniffer knows has a name for the user', () => {
  assert.equal(FORMAT_NAMES[sniffFormat(padded(latin('8BPS\0\x01')))], 'PSD');
  assert.equal(FORMAT_NAMES[sniffFormat(padded(ftyp('heic')))], 'HEIC');
  assert.equal(FORMAT_NAMES[sniffFormat(Buffer.alloc(40))], 'image');
  for (const name of Object.values(FORMAT_NAMES)) {
    assert.ok(name.length > 0);
  }
});

// ---- Shared arithmetic ------------------------------------------------------------

test('checkSize refuses what a canvas can not hold, and what is no size at all', () => {
  for (const [width, height] of [[1, 1], [16384, 16384], [32767, 8192], [8192, 32767]]) {
    checkSize(width, height);
  }
  for (const [width, height] of [[0, 10], [10, 0], [-5, 10], [Number.NaN, 10], [10, Number.NaN]]) {
    assert.throws(() => checkSize(width, height), (e: unknown) => e instanceof DecodeError && /valid picture size/.test(e.message));
  }
  for (const [width, height] of [[32768, 1], [1, 32768], [16385, 16384], [20000, 20000], [0xffffffff, 0xffffffff]]) {
    assert.throws(() => checkSize(width, height), (e: unknown) => e instanceof DecodeError && e.message.includes(`${width} × ${height} px`));
  }
});

test('16-bit samples round to the nearest 8-bit level', () => {
  for (let level = 0; level < 256; level++) {
    // level × 257 is the 16-bit value that means exactly this level; the values around it belong to it too.
    assert.equal(to8(level * 257), level);
    assert.equal(to8(Math.min(65535, level * 257 + 100)), level);
    assert.equal(to8(Math.max(0, level * 257 - 100)), level);
  }
});

test('colors multiplied by their alpha are divided again, and nothing else is touched', () => {
  const data = Uint8Array.from([10, 20, 30, 0, 10, 20, 30, 255, 64, 32, 100, 128, 200, 200, 3, 100]);
  unpremultiply(data);
  // 64 at half alpha is 127.5, which rounds up; 200 at alpha 100 would be 510 and stops at white.
  assert.deepEqual(Array.from(data), [10, 20, 30, 0, 10, 20, 30, 255, 128, 64, 199, 128, 255, 255, 8, 100]);
});

test('a raster is left alone by orientation 1 and by values that mean nothing', () => {
  const raster: Raster = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), notes: [] };
  for (const orientation of [1, 0, 9, -1, Number.NaN]) {
    assert.equal(orient(raster, orientation), raster);
  }
  const turned = orient(raster, 6);
  assert.deepEqual([turned.width, turned.height, Array.from(turned.data)], [1, 2, [1, 2, 3, 4, 5, 6, 7, 8]]);
  const mirrored = orient(raster, 2);
  assert.deepEqual([mirrored.width, mirrored.height, Array.from(mirrored.data)], [2, 1, [5, 6, 7, 8, 1, 2, 3, 4]]);
});

test('linear light and Lab arrive at the sRGB values of the textbooks', () => {
  // 0.5 linear is 0.7354 encoded; middle gray (L* 50) is 0.4663.
  assert.deepEqual([encodeSrgb(0), encodeSrgb(1), encodeSrgb(-3), encodeSrgb(7), encodeSrgb(Number.NEGATIVE_INFINITY)], [0, 255, 0, 255, 0]);
  assert.ok(Math.abs(encodeSrgb(0.5) - 188) <= 1);
  assert.ok(Math.abs(encodeSrgb(0.002) - 7) <= 1);
  const out = new Uint8Array(9);
  labToSrgb(100, 0, 0, out, 0);
  labToSrgb(0, 0, 0, out, 3);
  labToSrgb(50, 0, 0, out, 6);
  assert.deepEqual(Array.from(out.subarray(0, 6)), [255, 255, 255, 0, 0, 0]);
  for (const channel of out.subarray(6)) {
    assert.ok(Math.abs(channel - 119) <= 1, `L* 50 gave ${Array.from(out.subarray(6))}`);
  }
  // The sRGB primaries, as Lab under D50 (Lindbloom's tables): red, green, blue.
  const primaries: [number[], number[]][] = [
    [[54.29, 80.81, 69.89], [255, 0, 0]],
    [[87.82, -79.29, 80.99], [0, 255, 0]],
    [[29.57, 68.3, -112.03], [0, 0, 255]],
  ];
  for (const [[L, a, b], rgb] of primaries) {
    const color = new Uint8Array(3);
    labToSrgb(L, a, b, color, 0);
    assert.ok(rgb.every((value, c) => Math.abs(color[c] - value) <= 3), `Lab(${L}, ${a}, ${b}) gave ${Array.from(color)}`);
  }
});

/** An ICC profile with nothing in it but a header and a description, in the old (`desc`) or the new (`mluc`) form. */
function profile(name: string, form: 'desc' | 'mluc' = 'desc', space = 'RGB '): Buffer {
  const text =
    form === 'desc'
      ? Buffer.concat([latin('desc'), u32(0), u32(name.length + 1), latin(name), Buffer.alloc(1 + 78)])
      : Buffer.concat([latin('mluc'), u32(0), u32(1), u32(12), latin('enUS'), u32(name.length * 2), u32(28), Buffer.from(name, 'utf16le').swap16()]);
  const header = Buffer.alloc(128);
  header.write(space, 16, 'latin1');
  header.write('acsp', 36, 'latin1');
  // Two tags, the description second, so the table has to be walked.
  const table = Buffer.concat([u32(2), latin('cprt'), u32(156), u32(12), latin('desc'), u32(168), u32(text.length)]);
  const file = Buffer.concat([header, table, latin('text\0\0\0\0(c)\0'), text]);
  file.writeUInt32BE(file.length, 0);
  return file;
}

test('a color profile is named by its description tag, old form and new', () => {
  assert.equal(iccName(profile('Display P3')), 'Display P3');
  assert.equal(iccName(profile('Adobe RGB (1998)', 'mluc')), 'Adobe RGB (1998)');
  assert.equal(iccName(profile('Größe ΔE', 'mluc')), 'Größe ΔE');
  // Anything unreadable simply has no name.
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(200), profile('Display P3').subarray(0, 150), rnd.bytes(400)]) {
    assert.equal(typeof iccName(bytes), 'string');
  }
  assert.equal(iccName(Buffer.alloc(200)), '');
});

// ---- The bitmap that carries a profile into Chromium ------------------------------

test('a raster and its profile are wrapped as a version 5 bitmap with the pixels untouched', () => {
  const raster: Raster = { width: 5, height: 3, data: Uint8Array.from(rnd.bytes(60)), notes: [] };
  const icc = profile('Display P3');
  const file = Buffer.concat(bmpWithProfile(raster, icc));
  // Read back the way the format is documented: BITMAPFILEHEADER, then BITMAPV5HEADER.
  assert.equal(file.toString('latin1', 0, 2), 'BM');
  assert.equal(file.readUInt32LE(2), file.length);
  const pixels = file.readUInt32LE(10);
  const header = 14;
  assert.equal(file.readUInt32LE(header), 124);
  assert.equal(file.readInt32LE(header + 4), 5);
  // A negative height: the first row is the top one.
  assert.equal(file.readInt32LE(header + 8), -3);
  assert.deepEqual([file.readUInt16LE(header + 12), file.readUInt16LE(header + 14)], [1, 32]);
  // BI_BITFIELDS, with masks that put red in the first byte and alpha in the last.
  assert.equal(file.readUInt32LE(header + 16), 3);
  assert.equal(file.readUInt32LE(header + 20), 60);
  assert.deepEqual([40, 44, 48, 52].map((at) => file.readUInt32LE(header + at)), [0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000]);
  assert.deepEqual(Array.from(file.subarray(pixels, pixels + 60)), Array.from(raster.data));
  // PROFILE_EMBEDDED, and where the profile is, counted from the start of the header.
  assert.equal(file.toString('latin1', header + 56, header + 60), 'DEBM');
  const at = header + file.readUInt32LE(header + 112);
  assert.equal(file.readUInt32LE(header + 116), icc.length);
  assert.deepEqual(file.subarray(at, at + icc.length), icc);
  assert.equal(at + icc.length, file.length);
});

test('only an RGB profile can go into a bitmap', () => {
  assert.equal(isRgbProfile(profile('sRGB')), true);
  assert.equal(isRgbProfile(profile('Gray', 'desc', 'GRAY')), false);
  assert.equal(isRgbProfile(profile('Press', 'desc', 'CMYK')), false);
  assert.equal(isRgbProfile(profile('sRGB').subarray(0, 100)), false);
  assert.equal(isRgbProfile(Buffer.alloc(0)), false);
  const noSignature = profile('sRGB');
  noSignature.write('xxxx', 36);
  assert.equal(isRgbProfile(noSignature), false);
});

// ---- ICO --------------------------------------------------------------------------

/** A bitmap as an icon holds it: the header with the height doubled, a palette up to 8 bits, the picture, the 1-bit mask. */
function dib(width: number, height: number, bits: number): Buffer {
  const header = Buffer.concat([u32le(40), u32le(width), u32le(height * 2), u16le(1), u16le(bits), Buffer.alloc(24)]);
  const palette = bits <= 8 ? rnd.bytes(4 << bits) : Buffer.alloc(0);
  const row = (perPixel: number) => Math.ceil((width * perPixel) / 32) * 4;
  return Buffer.concat([header, palette, rnd.bytes(row(bits) * height), Buffer.alloc(row(1) * height)]);
}

/** An icon file. The directory says what `listed` says, which need not be true. */
function ico(pictures: { data: Uint8Array; listed?: [width: number, height: number] }[], type = 1): Buffer {
  let offset = 6 + pictures.length * 16;
  const records = pictures.map(({ data, listed }) => {
    const record = Buffer.concat([Buffer.from([listed?.[0] ?? 0, listed?.[1] ?? 0, 0, 0]), u16le(1), u16le(32), u32le(data.length), u32le(offset)]);
    offset += data.length;
    return record;
  });
  return Buffer.concat([u16le(0), u16le(type), u16le(pictures.length), ...records, ...pictures.map((p) => p.data)]);
}

const ICON_PARTS = {
  small32: dib(16, 16, 32),
  small8: dib(16, 16, 8),
  medium24: dib(32, 32, 24),
  tall4: dib(24, 48, 4),
  large: png(256, 256),
  rgb: png(48, 48, undefined, 2),
  indexed: png(20, 20, undefined, 3),
};
const ICON = ico([
  { data: ICON_PARTS.small8, listed: [16, 16] },
  { data: ICON_PARTS.medium24, listed: [32, 32] },
  { data: ICON_PARTS.small32, listed: [16, 16] },
  // The directory has one byte per side: 256 is written as 0. And a writer may get the byte wrong.
  { data: ICON_PARTS.large, listed: [0, 0] },
  { data: ICON_PARTS.rgb, listed: [99, 99] },
  { data: ICON_PARTS.tall4, listed: [99, 7] },
  { data: ICON_PARTS.indexed, listed: [20, 20] },
]);

test('the pictures of an icon are listed largest and deepest first, sized by their own headers', () => {
  assert.deepEqual(
    listIco(ICON).map((entry) => [entry.label, entry.width, entry.height, entry.bits, entry.png]),
    [
      ['256 × 256 · 32-bit PNG', 256, 256, 32, true],
      ['48 × 48 · 24-bit PNG', 48, 48, 24, true],
      ['24 × 48 · 4-bit', 24, 48, 4, false],
      ['32 × 32 · 24-bit', 32, 32, 24, false],
      ['20 × 20 · 8-bit PNG', 20, 20, 8, true],
      ['16 × 16 · 32-bit', 16, 16, 32, false],
      ['16 × 16 · 8-bit', 16, 16, 8, false],
    ],
  );
});

test('a PNG picture of an icon is handed out as the PNG file it is', () => {
  const [large] = listIco(ICON);
  const picture = icoPicture(ICON, large);
  assert.equal(picture.mime, 'image/png');
  assert.deepEqual(Buffer.from(picture.bytes), ICON_PARTS.large);
});

test('a bitmap picture is handed out as an icon file with that one entry', () => {
  for (const type of [1, 2]) {
    const file = ico([{ data: ICON_PARTS.small8, listed: [16, 16] }, { data: ICON_PARTS.medium24, listed: [32, 32] }, { data: ICON_PARTS.large }], type);
    const entry = listIco(file).find((e) => e.width === 32);
    assert.ok(entry);
    const picture = icoPicture(file, entry);
    const bytes = Buffer.from(picture.bytes);
    assert.equal(picture.mime, 'image/x-icon');
    // Header: reserved, the type of the source (icon or cursor), one picture.
    assert.deepEqual([bytes.readUInt16LE(0), bytes.readUInt16LE(2), bytes.readUInt16LE(4)], [0, type, 1]);
    // Its record: sides, planes and depth as in the source, then the size and the place of the data, right behind it.
    assert.deepEqual(Array.from(bytes.subarray(6, 14)), [32, 32, 0, 0, 1, 0, 32, 0]);
    assert.deepEqual([bytes.readUInt32LE(14), bytes.readUInt32LE(18)], [ICON_PARTS.medium24.length, 22]);
    assert.deepEqual(bytes.subarray(22), ICON_PARTS.medium24);
    // And it reads back as an icon with that picture alone.
    assert.deepEqual(listIco(bytes).map((e) => e.label), ['32 × 32 · 24-bit']);
  }
});

test('entries that point outside the file, or at something else than a picture, are left out', () => {
  const sound = ico([{ data: ICON_PARTS.small32 }, { data: ICON_PARTS.medium24 }, { data: ICON_PARTS.small8 }]);
  const recordOf = (i: number) => 6 + i * 16;
  const damaged = (change: (file: Buffer) => void) => {
    const file = Buffer.from(sound);
    change(file);
    return listIco(file).map((entry) => entry.label);
  };
  const others = ['16 × 16 · 32-bit', '16 × 16 · 8-bit'];
  assert.deepEqual(damaged((f) => f.writeUInt32LE(f.length + 10, recordOf(1) + 12)), others);
  assert.deepEqual(damaged((f) => f.writeUInt32LE(0xfffffff0, recordOf(1) + 12)), others);
  assert.deepEqual(damaged((f) => f.writeUInt32LE(f.length, recordOf(1) + 8)), others);
  assert.deepEqual(damaged((f) => f.writeUInt32LE(12, recordOf(1) + 8)), others);
  // The record points into the middle of pixel data: no bitmap header there.
  assert.deepEqual(damaged((f) => f.writeUInt32LE(f.readUInt32LE(recordOf(1) + 12) + 61, recordOf(1) + 12)), others);
  // A header that claims a side no icon has.
  assert.deepEqual(damaged((f) => f.writeUInt32LE(70000, f.readUInt32LE(recordOf(1) + 12) + 4)), others);
  assert.deepEqual(damaged((f) => f.writeUInt32LE(0, f.readUInt32LE(recordOf(1) + 12) + 4)), others);
  assert.deepEqual(damaged((f) => f.writeUInt16LE(13, f.readUInt32LE(recordOf(1) + 12) + 14)), others);
  // A count that promises more records than the file has room for.
  assert.equal(damaged((f) => f.writeUInt16LE(60000, 4)).length, 3);
  assert.deepEqual(damaged((f) => f.writeUInt16LE(0, 4)), []);
});

test('what is not an icon file is refused', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 0, 1]), latin('GIF89a....'), Buffer.from([0, 0, 3, 0, 1, 0]), Buffer.from([1, 0, 1, 0, 1, 0])]) {
    assert.throws(() => listIco(bytes), (e: unknown) => e instanceof DecodeError && /not an icon/.test(e.message));
  }
});

// ---- ICNS -------------------------------------------------------------------------

const icns = (entries: [type: string, data: Uint8Array][], header = true) => {
  const body = Buffer.concat(entries.flatMap(([type, data]) => [latin(type), u32(data.length + 8), data]));
  return header ? Buffer.concat([latin('icns'), u32(body.length + 8), body]) : body;
};

/** The packing of icon channels: a byte over 127 repeats the next one (its value − 125 times), any other is followed by that many bytes + 1. */
function packIcon(data: Uint8Array): Buffer {
  const out: number[] = [];
  for (let at = 0; at < data.length; ) {
    let run = 1;
    while (at + run < data.length && run < 130 && data[at + run] === data[at]) {
      run++;
    }
    if (run >= 3) {
      out.push(run + 125, data[at]);
      at += run;
      continue;
    }
    const start = at;
    while (at < data.length && at - start < 128 && !(at + 2 < data.length && data[at + 1] === data[at] && data[at + 2] === data[at])) {
      at++;
    }
    out.push(at - start - 1, ...data.subarray(start, at));
  }
  return Buffer.from(out);
}

/** A picture of `side` × `side` as four planes: noise, with flat stretches for the packer to find. */
function iconPlanes(side: number, seed: number): { r: Buffer; g: Buffer; b: Buffer; a: Buffer; rgba: number[] } {
  const noise = random(seed);
  const plane = () => {
    const p = noise.bytes(side * side);
    p.fill(noise.int(256), side, side * 3);
    return p;
  };
  const [r, g, b, a] = [plane(), plane(), plane(), plane()];
  return { r, g, b, a, rgba: Array.from({ length: side * side }, (_, i) => [r[i], g[i], b[i], a[i]]).flat() };
}
const rasterOf = (file: Uint8Array, entry: IcnsEntry): Raster => {
  const decoded = decodeIcns(file, entry);
  assert.ok('raster' in decoded, `${entry.type} should come as pixels`);
  return decoded.raster;
};

test('ARGB pictures are unpacked, whether the runs stop at the channels or run across them', () => {
  const p = iconPlanes(16, 1);
  // Opaque, and the red plane starts with the same value: packed as one stream, a run crosses from alpha into red.
  p.a.fill(255);
  p.r.fill(255, 0, 20);
  const rgba = p.rgba.map((value, i) => (i % 4 === 3 ? 255 : i % 4 === 0 && i < 80 ? 255 : value));
  const asOne = Buffer.concat([latin('ARGB'), packIcon(Buffer.concat([p.a, p.r, p.g, p.b]))]);
  const perChannel = Buffer.concat([latin('ARGB'), ...[p.a, p.r, p.g, p.b].map(packIcon)]);
  assert.ok(asOne.length < perChannel.length);
  for (const data of [asOne, perChannel]) {
    const file = icns([['ic04', data]]);
    const [entry] = listIcns(file);
    assert.deepEqual([entry.type, entry.kind, entry.label, entry.width, entry.height], ['ic04', 'argb', '16 × 16 · ARGB', 16, 16]);
    assertPixels(rasterOf(file, entry), 16, 16, rgba);
  }
});

test('ARGB is straight alpha: colors under a faint alpha are not scaled', () => {
  const p = iconPlanes(18, 2);
  const file = icns([['icsb', Buffer.concat([latin('ARGB'), packIcon(Buffer.concat([p.a, p.r, p.g, p.b]))])]]);
  assertPixels(rasterOf(file, listIcns(file)[0]), 18, 18, p.rgba);
});

test('packed RGB takes its transparency from the 8-bit mask of its size', () => {
  for (const [type, maskType, side] of [['is32', 's8mk', 16], ['il32', 'l8mk', 32], ['ih32', 'h8mk', 48]] as const) {
    const p = iconPlanes(side, 3);
    const file = icns([[maskType, p.a], [type, Buffer.concat([p.r, p.g, p.b].map(packIcon))], ['ICN#', Buffer.alloc(side * side / 4, 0xff)]]);
    const [entry] = listIcns(file);
    assert.deepEqual([entry.type, entry.kind, entry.label], [type, 'rgb', `${side} × ${side} · RGB`]);
    assertPixels(rasterOf(file, entry), side, side, p.rgba);
  }
});

test('the 128 px picture skips the four zero bytes in front of its channels', () => {
  const p = iconPlanes(128, 4);
  const packed = Buffer.concat([p.r, p.g, p.b].map(packIcon));
  for (const data of [Buffer.concat([Buffer.alloc(4), packed]), packed]) {
    const file = icns([['it32', data], ['t8mk', p.a]]);
    assertPixels(rasterOf(file, listIcns(file)[0]), 128, 128, p.rgba);
  }
});

test('without an 8-bit mask the 1-bit mask of the classic icon is used, and without any the picture is opaque', () => {
  const p = iconPlanes(32, 5);
  // The classic icon: 32 × 32 bits of picture, then as many of mask. Here every third pixel is see-through.
  const bits = Buffer.alloc(128);
  const mask = Buffer.alloc(128);
  for (let i = 0; i < 1024; i++) {
    if (i % 3) {
      mask[i >> 3] |= 0x80 >> (i & 7);
    }
  }
  const rgb = Buffer.concat([p.r, p.g, p.b].map(packIcon));
  const classic = icns([['il32', rgb], ['ICN#', Buffer.concat([bits, mask])]]);
  assertPixels(rasterOf(classic, listIcns(classic)[0]), 32, 32, p.rgba.map((value, i) => (i % 4 === 3 ? ((i >> 2) % 3 ? 255 : 0) : value)));
  const bare = icns([['il32', rgb]]);
  assertPixels(rasterOf(bare, listIcns(bare)[0]), 32, 32, p.rgba.map((value, i) => (i % 4 === 3 ? 255 : value)));
});

test('RGB that is not packed at all: one unused byte and three colors per pixel', () => {
  const p = iconPlanes(16, 6);
  const plain = Buffer.from(Array.from({ length: 256 }, (_, i) => [0, p.r[i], p.g[i], p.b[i]]).flat());
  const file = icns([['is32', plain], ['s8mk', p.a]]);
  assertPixels(rasterOf(file, listIcns(file)[0]), 16, 16, p.rgba);
});

test('a PNG entry is handed out as the PNG it is, with the size the PNG states', () => {
  const picture = png(64, 64, rnd.bytes(64 * 64 * 4));
  // ic12 is "32 pt at 2x"; a type the table doesn't know is listed all the same when it holds a PNG.
  const file = icns([['TOC ', rnd.bytes(16)], ['ic12', picture], ['icXX', png(40, 30)], ['info', latin('bplist00')]]);
  const entries = listIcns(file);
  assert.deepEqual(entries.map((e) => [e.type, e.kind, e.label, e.width, e.height]), [['ic12', 'png', '64 × 64 (32 pt @2x)', 64, 64], ['icXX', 'png', '40 × 30', 40, 30]]);
  const decoded = decodeIcns(file, entries[0]);
  assert.ok('png' in decoded);
  assert.deepEqual(Buffer.from(decoded.png), picture);
});

test('JPEG 2000 entries are listed behind what can be shown, and refused in words', () => {
  const jp2 = Buffer.concat([u32(12), latin('jP  '), Buffer.from([0x0d, 0x0a, 0x87, 0x0a]), rnd.bytes(40)]);
  const codestream = Buffer.concat([Buffer.from([0xff, 0x4f, 0xff, 0x51]), rnd.bytes(40)]);
  const file = icns([['ic08', jp2], ['ic13', png(256, 256)], ['ic09', codestream], ['ic07', png(128, 128)]]);
  const entries = listIcns(file);
  assert.deepEqual(entries.map((e) => [e.type, e.kind, e.label]), [
    ['ic09', 'jp2', '512 × 512 · JPEG 2000'],
    ['ic13', 'png', '256 × 256 (128 pt @2x)'],
    ['ic08', 'jp2', '256 × 256 · JPEG 2000'],
    ['ic07', 'png', '128 × 128'],
  ]);
  assert.throws(() => decodeIcns(file, entries[0]), (e: unknown) => e instanceof DecodeError && /JPEG 2000/.test(e.message) && /512 × 512/.test(e.message));
});

test('the dark, template and selected variants are listed after the icon itself, and decode', () => {
  const p = iconPlanes(16, 7);
  const argb = Buffer.concat([latin('ARGB'), packIcon(Buffer.concat([p.a, p.r, p.g, p.b]))]);
  const selected = icns([['ic04', argb]], false);
  const file = icns([
    // The dark variant is a whole icon file of its own, header included; a template has no header, and a variant in turn.
    ['\xfd\xd9\x2f\xa8', icns([['ic07', png(128, 128)], ['ic04', argb]])],
    ['sbtp', icns([['ic11', png(32, 32)], ['slct', selected]], false)],
    ['ic04', argb],
    ['ic08', png(256, 256)],
  ]);
  const entries = listIcns(file);
  assert.deepEqual(entries.map((e) => [e.label, e.variant]), [
    ['256 × 256', ''],
    ['16 × 16 · ARGB', ''],
    ['128 × 128 · dark', 'dark'],
    ['32 × 32 (16 pt @2x) · template', 'template'],
    ['16 × 16 · ARGB · dark', 'dark'],
    ['16 × 16 · ARGB · template, selected', 'template, selected'],
  ]);
  for (const entry of entries.filter((e) => e.kind === 'argb')) {
    assertPixels(rasterOf(file, entry), 16, 16, p.rgba);
  }
});

test('what is not an ICNS file is refused, and an empty one has no pictures', () => {
  for (const bytes of [Buffer.alloc(0), latin('icn'), latin('This is not a picture at all.'), ICON]) {
    assert.throws(() => listIcns(bytes), (e: unknown) => e instanceof DecodeError && /not an ICNS/.test(e.message));
  }
  assert.deepEqual(listIcns(icns([])), []);
  assert.deepEqual(listIcns(icns([['TOC ', Buffer.alloc(8)]])), []);
});

test('an entry that overruns the file ends the list, and what came before it stays', () => {
  const sound = icns([['ic07', png(128, 128)], ['ic12', png(64, 64)], ['ic11', png(32, 32)]]);
  const second = 8 + 8 + png(128, 128).length;
  for (const length of [0x7fffffff, 0xffffffff, sound.length, 4, 0]) {
    const file = Buffer.from(sound);
    file.writeUInt32BE(length, second + 4);
    assert.deepEqual(listIcns(file).map((e) => e.type), ['ic07']);
  }
  // The length in the header counts: what lies behind it is not part of the icon.
  const short = Buffer.from(sound);
  short.writeUInt32BE(second, 4);
  assert.deepEqual(listIcns(short).map((e) => e.type), ['ic07']);
  short.writeUInt32BE(8, 4);
  assert.deepEqual(listIcns(short), []);
});

test('packed channels that end early are a damaged icon, not a picture with a hole', () => {
  const p = iconPlanes(16, 8);
  const argb = Buffer.concat([latin('ARGB'), packIcon(Buffer.concat([p.a, p.r, p.g, p.b]))]);
  const rgb = Buffer.concat([p.r, p.g, p.b].map(packIcon));
  for (const [type, data] of [['ic04', argb], ['is32', rgb]] as const) {
    for (const keep of [8, 9, data.length >> 1, data.length - 1]) {
      const file = icns([[type, data.subarray(0, keep)]]);
      const [entry] = listIcns(file);
      assert.throws(() => decodeIcns(file, entry), (e: unknown) => e instanceof DecodeError && /ends early/.test(e.message), `${type} cut to ${keep}`);
    }
  }
});

// ---- Damage to icons --------------------------------------------------------------

const readIco = (file: Uint8Array) => listIco(file).map((entry) => icoPicture(file, entry));
const readIcns = (file: Uint8Array) =>
  listIcns(file).map((entry) => {
    // JPEG 2000 is refused by design; any other entry has to decode or be called damaged.
    try {
      const decoded = decodeIcns(file, entry);
      if ('raster' in decoded) {
        assert.equal(decoded.raster.data.length, decoded.raster.width * decoded.raster.height * 4);
      }
    } catch (e) {
      if (!(e instanceof DecodeError)) {
        throw e;
      }
    }
  });

const SOUND_ICNS = (() => {
  const small = iconPlanes(16, 9);
  const medium = iconPlanes(32, 10);
  const argb = Buffer.concat([latin('ARGB'), packIcon(Buffer.concat([small.a, small.r, small.g, small.b]))]);
  return icns([
    ['ic04', argb],
    ['il32', Buffer.concat([medium.r, medium.g, medium.b].map(packIcon))],
    ['l8mk', medium.a],
    ['ic11', png(32, 32)],
    ['\xfd\xd9\x2f\xa8', icns([['ic04', argb]])],
  ]);
})();
const SOUND_ICO = ico([{ data: ICON_PARTS.small32 }, { data: ICON_PARTS.rgb }, { data: ICON_PARTS.small8 }]);

for (const [name, sound, read, count] of [
  ['ICO', SOUND_ICO, readIco, 3],
  ['ICNS', SOUND_ICNS, readIcns, 4],
] as const) {
  test(`${name}: the file the damage tests start from is sound`, () => {
    assert.equal(read(sound).length, count);
  });

  test(`${name}: cut short at any length, the readers answer or refuse`, () => {
    for (let length = 0; length < sound.length; length++) {
      // A copy of exactly that length: a view into the whole file would let a stray read succeed.
      survive(`cut at ${length}`, () => read(Uint8Array.from(sound.subarray(0, length))));
    }
  });

  test(`${name}: with flipped bits, the readers answer or refuse`, () => {
    const flip = random(42);
    for (let round = 0; round < 400; round++) {
      const file = Buffer.from(sound);
      for (let n = 1 + flip.int(3); n > 0; n--) {
        // Half of the flips go to the start, where the structure is.
        file[flip.int(round % 2 ? file.length : 120)] ^= 1 << flip.int(8);
      }
      survive(`flip round ${round}`, () => read(file));
    }
  });

  test(`${name}: with noise behind the magic number, the readers answer or refuse`, () => {
    const noise = random(43);
    for (let round = 0; round < 200; round++) {
      survive(`noise round ${round}`, () => read(Buffer.concat([sound.subarray(0, noise.pick([4, 6, 8, 22])), noise.bytes(noise.int(500))])));
    }
  });
}

// ---- The HEIF box reader ----------------------------------------------------------

const box = (type: string, ...content: Uint8Array[]) => Buffer.concat([u32(8 + content.reduce((sum, part) => sum + part.length, 0)), latin(type), ...content]);
const fullBox = (type: string, version: number, flags: number, ...content: Uint8Array[]) => box(type, Buffer.from([version, flags >> 16, flags >> 8, flags]), ...content);

/** Properties as they are stored in `ipco`. */
const PROPERTY = {
  ispe: (width: number, height: number) => fullBox('ispe', 0, 0, u32(width), u32(height)),
  irot: (turns: number) => box('irot', Buffer.from([turns])),
  imir: (axis: number) => box('imir', Buffer.from([axis])),
  pixi: (...bits: number[]) => fullBox('pixi', 0, 0, Buffer.from([bits.length, ...bits])),
  nclx: (primaries: number, transfer: number, matrix: number) => box('colr', latin('nclx'), u16(primaries), u16(transfer), u16(matrix), Buffer.from([0x80])),
  icc: (data: Uint8Array) => box('colr', latin('prof'), data),
  /** The HEVC configuration record: the luma depth is in the low bits of its byte 17, as depth − 8. */
  hvcC: (bits: number) => {
    const record = Buffer.alloc(23);
    record[0] = 1;
    record[17] = 0xf8 | (bits - 8);
    record[18] = 0xf8 | (bits - 8);
    return box('hvcC', record);
  },
  /** The AV1 configuration: the third byte holds "more than 8 bits" (0x40) and "12 rather than 10" (0x20). */
  av1C: (bits: number) => box('av1C', Buffer.from([0x81, 0x08, bits === 12 ? 0x60 : bits === 10 ? 0x40 : 0, 0])),
};

interface HeifFile {
  brands: string[];
  primary: number;
  /** The items, each with the properties it is given, as indexes into `properties` counted from 1. */
  items: { id: number; type: string; properties: number[] }[];
  properties: Buffer[];
  /** `dimg` references: which items a grid is made of. */
  tiles?: [from: number, to: number[]];
  /** Wide forms of every box that has one: 32-bit item ids and 15-bit property indexes. */
  wide?: boolean;
  /** Boxes in front of `meta`, and behind it. */
  before?: Buffer[];
  after?: Buffer[];
}

function heif(file: HeifFile): Buffer {
  const wide = !!file.wide;
  const id = wide ? u32 : u16;
  const infe = (item: HeifFile['items'][number]) => fullBox('infe', wide ? 3 : 2, 0, id(item.id), u16(0), latin(item.type), Buffer.alloc(1));
  const ipma = fullBox(
    'ipma',
    wide ? 1 : 0,
    wide ? 1 : 0,
    u32(file.items.length),
    ...file.items.flatMap((item) => [id(item.id), Buffer.from([item.properties.length]), ...item.properties.map((index) => (wide ? u16(0x8000 | index) : Buffer.from([0x80 | index])))]),
  );
  const iref = file.tiles ? [fullBox('iref', wide ? 1 : 0, 0, box('dimg', id(file.tiles[0]), u16(file.tiles[1].length), ...file.tiles[1].map(id)))] : [];
  const meta = fullBox(
    'meta',
    0,
    0,
    fullBox('hdlr', 0, 0, u32(0), latin('pict'), Buffer.alloc(13)),
    fullBox('pitm', wide ? 1 : 0, 0, id(file.primary)),
    fullBox('iinf', 0, 0, u16(file.items.length), ...file.items.map(infe)),
    ...iref,
    box('iprp', box('ipco', ...file.properties), ipma),
  );
  return Buffer.concat([ftyp(file.brands[0], ...file.brands.slice(1)), ...(file.before ?? []), meta, ...(file.after ?? [box('mdat', rnd.bytes(50))])]);
}

/** A phone photo: the picture and its thumbnail, each with its own size, the picture turned and mirrored. */
const PHOTO: HeifFile = {
  brands: ['heic', 'mif1', 'heic'],
  primary: 2,
  items: [
    { id: 1, type: 'hvc1', properties: [1, 2] },
    { id: 2, type: 'hvc1', properties: [3, 4, 5, 6, 7, 8] },
  ],
  properties: [PROPERTY.ispe(320, 240), PROPERTY.hvcC(8), PROPERTY.ispe(4032, 3024), PROPERTY.hvcC(10), PROPERTY.irot(3), PROPERTY.imir(1), PROPERTY.pixi(10, 10, 10), PROPERTY.nclx(12, 13, 6)],
};

test('the main picture is described by the properties it is given, not by those of the thumbnail', () => {
  for (const wide of [false, true]) {
    const info = readHeif(heif({ ...PHOTO, wide }));
    assert.deepEqual(info, {
      brands: ['heic', 'mif1', 'heic'],
      width: 4032,
      height: 3024,
      turns: 3,
      mirror: 1,
      // A quarter turn clockwise, then left and right exchanged: EXIF's "mirror horizontal and rotate 270 CW".
      orientation: 5,
      channels: 3,
      bits: 10,
      codec: 'hvc1',
      nclx: { primaries: 12, transfer: 13, matrix: 6 },
      sequence: false,
    });
  }
  // The same file with the thumbnail as its main picture.
  const thumbnail = readHeif(heif({ ...PHOTO, primary: 1 }));
  assert.deepEqual([thumbnail?.width, thumbnail?.height, thumbnail?.turns, thumbnail?.mirror, thumbnail?.bits], [320, 240, 0, undefined, 8]);
});

test('every quarter turn and both mirror axes are read', () => {
  for (const turns of [0, 1, 2, 3]) {
    for (const axis of [0, 1, undefined]) {
      const properties = [PROPERTY.ispe(40, 30), PROPERTY.irot(turns), ...(axis === undefined ? [] : [PROPERTY.imir(axis)])];
      const info = readHeif(heif({ brands: ['heic'], primary: 1, items: [{ id: 1, type: 'hvc1', properties: properties.map((_, i) => i + 1) }], properties }));
      assert.deepEqual([info?.width, info?.height, info?.turns, info?.mirror], [40, 30, turns, axis]);
      // The two together as the EXIF orientation that does the same: the turn first here, then the mirror.
      const afterTurn = axis === undefined ? [1, 8, 3, 6] : axis === 1 ? [2, 7, 4, 5] : [4, 5, 2, 7];
      assert.equal(info?.orientation, afterTurn[turns], `irot ${turns}, imir ${axis}`);
    }
  }
});

test('a picture made of tiles takes its depth from the tiles', () => {
  for (const wide of [false, true]) {
    const info = readHeif(
      heif({
        brands: ['heic', 'mif1'],
        primary: 9,
        items: [
          { id: 9, type: 'grid', properties: [1] },
          { id: 10, type: 'hvc1', properties: [2, 3] },
          { id: 11, type: 'hvc1', properties: [2, 3] },
        ],
        properties: [PROPERTY.ispe(8000, 6000), PROPERTY.ispe(512, 512), PROPERTY.hvcC(10)],
        tiles: [9, [10, 11]],
        wide,
      }),
    );
    assert.deepEqual([info?.codec, info?.width, info?.height, info?.bits], ['grid', 8000, 6000, 10]);
  }
});

test('AVIF: the depth is read from the AV1 configuration, and the profile is handed on', () => {
  const icc = profile('Display P3');
  for (const bits of [8, 10, 12]) {
    const info = readHeif(heif({ brands: ['avif', 'mif1', 'miaf'], primary: 1, items: [{ id: 1, type: 'av01', properties: [1, 2, 3] }], properties: [PROPERTY.ispe(64, 48), PROPERTY.av1C(bits), PROPERTY.icc(icc)] }));
    assert.deepEqual([info?.codec, info?.bits, info?.brands[0], info?.nclx], ['av01', bits, 'avif', undefined]);
    assert.deepEqual(Buffer.from(info?.icc ?? []), icc);
  }
});

test('boxes with a 64-bit size, and a last box that runs to the end of the file, are stepped over', () => {
  const large = Buffer.concat([u32(1), latin('free'), u32(0), u32(16 + 40), Buffer.alloc(40)]);
  const toTheEnd = Buffer.concat([u32(0), latin('mdat'), rnd.bytes(70)]);
  const info = readHeif(heif({ ...PHOTO, before: [large], after: [toTheEnd] }));
  assert.deepEqual([info?.width, info?.height], [4032, 3024]);
});

test('a movie track makes the file a sequence', () => {
  assert.equal(readHeif(heif({ ...PHOTO, after: [box('moov', box('mvhd', Buffer.alloc(100)))] }))?.sequence, true);
  assert.equal(readHeif(heif(PHOTO))?.sequence, false);
});

test('a file without the boxes says what it can', () => {
  assert.equal(readHeif(latin('RIFF\x24\0\0\0WEBPVP8 ....')), undefined);
  assert.equal(readHeif(Buffer.alloc(0)), undefined);
  // Only the type box: the brands are known and nothing else.
  assert.deepEqual(readHeif(ftyp('heic', 'mif1')), { brands: ['heic', 'mif1'], turns: 0, orientation: 1, sequence: false });
  // A main picture that was given no properties.
  const bare = readHeif(heif({ brands: ['heic'], primary: 1, items: [{ id: 1, type: 'hvc1', properties: [] }], properties: [PROPERTY.ispe(4, 4)] }));
  assert.deepEqual([bare?.codec, bare?.width, bare?.turns], ['hvc1', undefined, 0]);
  // A property index that points past the list.
  const beyond = readHeif(heif({ brands: ['heic'], primary: 1, items: [{ id: 1, type: 'hvc1', properties: [5, 1] }], properties: [PROPERTY.ispe(4, 6)] }));
  assert.deepEqual([beyond?.width, beyond?.height], [4, 6]);
});

test('HEIF boxes cut short, scrambled or replaced by noise never make the reader throw', () => {
  const sound = heif({ ...PHOTO, tiles: [2, [1]] });
  const read = (file: Uint8Array, what: string) => {
    const started = performance.now();
    readHeif(file);
    assert.ok(performance.now() - started < BUDGET_MS, what);
  };
  for (let length = 0; length < sound.length; length++) {
    read(Uint8Array.from(sound.subarray(0, length)), `cut at ${length}`);
  }
  const damage = random(44);
  for (let round = 0; round < 400; round++) {
    const file = Buffer.from(sound);
    for (let n = 1 + damage.int(3); n > 0; n--) {
      file[damage.int(file.length)] ^= 1 << damage.int(8);
    }
    read(file, `flip round ${round}`);
    read(Buffer.concat([sound.subarray(0, damage.pick([24, 36, 60])), damage.bytes(damage.int(400))]), `noise round ${round}`);
  }
});

// ---- libheif ----------------------------------------------------------------------

// libheif is not bundled: the extension ships its own script and WebAssembly file and loads them at run time,
// and so does this test, from node_modules.
const libheifFolder = path.join(root, 'node_modules', 'libheif-js', 'libheif-wasm');
const noLibheif = fs.existsSync(path.join(libheifFolder, 'libheif.wasm')) ? false : 'libheif-js is not installed';
let loading: Promise<LibHeif> | undefined;
function libheif(): Promise<LibHeif> {
  loading ??= new Promise<LibHeif>((resolve, reject) => {
    const factory = createRequire(path.join(root, 'package.json'))('libheif-js/libheif-wasm/libheif.js') as (module: object) => void;
    // The object handed to the factory becomes the library, as in webview/heicWorker.js.
    const module = {
      wasmBinary: fs.readFileSync(path.join(libheifFolder, 'libheif.wasm')),
      print: () => undefined,
      printErr: () => undefined,
      onRuntimeInitialized: () => resolve(module as unknown as LibHeif),
      onAbort: (reason: unknown) => reject(new Error(String(reason))),
    };
    factory(module);
  });
  return loading;
}

// 64 × 48, four flat quarters. Made on macOS with
//   sips -s format heic quad.png --out quad.heic
// from a PNG with these colors (HEVC, 4:2:0, 8 bits, 525 bytes). sips writes an `irot` property of no turn.
const QUAD = fs.readFileSync(fixture('images/quad.heic'));
const QUARTERS = { red: [200, 40, 40], green: [40, 160, 60], blue: [50, 70, 200], gray: [128, 128, 128] };
type Quarter = keyof typeof QUARTERS;

/** Checks the color in the middle of each quarter of the picture, clockwise from the top left. */
function assertQuarters(raster: Raster, width: number, height: number, clockwise: [Quarter, Quarter, Quarter, Quarter]): void {
  assert.deepEqual([raster.width, raster.height], [width, height]);
  const centers = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]];
  const names = centers.map(([fx, fy]) => {
    const at = (Math.floor(fy * height) * width + Math.floor(fx * width)) * 4;
    const pixel = Array.from(raster.data.subarray(at, at + 4));
    // The file is lossy: a few levels off is the same color.
    return (Object.keys(QUARTERS) as Quarter[]).find((name) => pixel[3] === 255 && QUARTERS[name].every((value, c) => Math.abs(value - pixel[c]) <= 4)) ?? `(${pixel})`;
  });
  assert.deepEqual(names, clockwise);
}

/** The fixture with its `irot` box rewritten: another turn, or a mirror box, which is as long. */
function transformed(type: 'irot' | 'imir', value: number): Buffer {
  const file = Buffer.from(QUAD);
  const at = file.indexOf('irot');
  assert.ok(at > 0 && file.readUInt32BE(at - 4) === 9);
  file.write(type, at, 'latin1');
  file[at + 4] = value;
  return file;
}

test('a HEIC picture is decoded to its pixels', { skip: noLibheif }, async () => {
  const { raster, pages, page } = decodeHeic(await libheif(), QUAD);
  assertQuarters(raster, 64, 48, ['red', 'green', 'gray', 'blue']);
  assert.equal(raster.data.length, 64 * 48 * 4);
  assert.deepEqual(pages, [{ width: 64, height: 48, label: '64 × 48' }]);
  assert.equal(page, 0);
  assert.equal(raster.warning, undefined);
  assert.deepEqual([raster.notes.length, raster.notes[0][0]], [1, 'Decoder']);
  assert.match(raster.notes[0][1], /^libheif \d+\.\d+/);
  // The box reader sees the same picture.
  const info = readHeif(QUAD);
  assert.deepEqual([info?.width, info?.height, info?.turns, info?.mirror, info?.bits, info?.codec], [64, 48, 0, undefined, 8, 'hvc1']);
});

test('a page number the file does not have gives the main picture', { skip: noLibheif }, async () => {
  const lib = await libheif();
  for (const index of [5, -1]) {
    const { raster, page } = decodeHeic(lib, QUAD, index);
    assert.equal(page, 0);
    assertQuarters(raster, 64, 48, ['red', 'green', 'gray', 'blue']);
  }
});

test('the turn stored in the file is applied: quarter turns counter-clockwise', { skip: noLibheif }, async () => {
  const lib = await libheif();
  const turns: [Quarter, Quarter, Quarter, Quarter][] = [
    ['red', 'green', 'gray', 'blue'],
    ['green', 'gray', 'blue', 'red'],
    ['gray', 'blue', 'red', 'green'],
    ['blue', 'red', 'green', 'gray'],
  ];
  for (const [count, clockwise] of turns.entries()) {
    const file = transformed('irot', count);
    assert.equal(readHeif(file)?.turns, count);
    const [width, height] = count % 2 ? [48, 64] : [64, 48];
    const { raster, pages } = decodeHeic(lib, file);
    assertQuarters(raster, width, height, clockwise);
    assert.deepEqual([pages[0].width, pages[0].height], [width, height]);
  }
});

test('the mirroring stored in the file is applied: axis 0 exchanges top and bottom, axis 1 left and right', { skip: noLibheif }, async () => {
  // ISO/IEC 23008-12:2022, 6.5.12: "0 indicates that the top and bottom parts of the image are exchanged;
  // 1 indicates that the left and right parts are exchanged."
  const lib = await libheif();
  assert.deepEqual([readHeif(transformed('imir', 0))?.mirror, readHeif(transformed('imir', 0))?.orientation], [0, 4]);
  assertQuarters(decodeHeic(lib, transformed('imir', 0)).raster, 64, 48, ['blue', 'gray', 'green', 'red']);
  assert.deepEqual([readHeif(transformed('imir', 1))?.mirror, readHeif(transformed('imir', 1))?.orientation], [1, 2]);
  assertQuarters(decodeHeic(lib, transformed('imir', 1)).raster, 64, 48, ['green', 'red', 'blue', 'gray']);
});

test('a damaged HEIC gives a picture or a DecodeError, and leaves the library usable', { skip: noLibheif }, async () => {
  const lib = await libheif();
  const decode = (file: Uint8Array, what: string) =>
    survive(what, () => {
      const { raster } = decodeHeic(lib, file);
      assert.equal(raster.data.length, raster.width * raster.height * 4);
    });
  for (let length = 0; length < QUAD.length; length++) {
    assert.equal(decode(Uint8Array.from(QUAD.subarray(0, length)), `cut at ${length}`), 'refused');
  }
  const damage = random(45);
  for (let round = 0; round < 300; round++) {
    const file = Buffer.from(QUAD);
    for (let n = 1 + damage.int(3); n > 0; n--) {
      file[damage.int(file.length)] ^= 1 << damage.int(8);
    }
    decode(file, `flip round ${round}`);
  }
  for (let round = 0; round < 100; round++) {
    assert.equal(decode(Buffer.concat([QUAD.subarray(0, 36), damage.bytes(damage.int(400))]), `noise round ${round}`), 'refused');
  }
  assert.throws(() => decodeHeic(lib, latin('This is not a picture at all.')), DecodeError);
  // Nothing of all that is left behind in the library.
  assertQuarters(decodeHeic(lib, QUAD).raster, 64, 48, ['red', 'green', 'gray', 'blue']);
});

// ---- A second opinion: files written by macOS -------------------------------------

const sips = process.platform === 'darwin' ? which('sips') : undefined;

/** 32 × 32 of noise with every kind of alpha, as a PNG and as what sips makes of it. */
const SOURCE = (() => {
  const data = random(46).bytes(32 * 32 * 4);
  for (let i = 3; i < data.length; i += 4) {
    data[i] = [0, 255, 128, 200, 30][(i >> 2) % 5];
  }
  return data;
})();
function converted(format: string, ...options: string[]): Buffer {
  const source = path.join(dir, 'source.png');
  fs.writeFileSync(source, png(32, 32, SOURCE));
  const out = path.join(dir, `converted-${options.length}.${format}`);
  run(sips as string, ['-s', 'format', format, ...options, source, '--out', out]);
  return fs.readFileSync(out);
}

test('a TIFF written by sips decodes to the pixels of its source, plain and LZW', { skip: needs(sips, 'sips') }, () => {
  for (const options of [[], ['-s', 'formatOptions', 'lzw']]) {
    const file = converted('tiff', ...options);
    assert.equal(sniffFormat(file), 'tiff');
    assert.equal(listTiff(file)[0].compression, options.length ? 5 : 1);
    assertPixels(decodeTiff(file, 0), 32, 32, SOURCE);
  }
});

test('a PSD written by sips decodes to the pixels of its source', { skip: needs(sips, 'sips') }, () => {
  const file = converted('psd');
  assert.equal(sniffFormat(file), 'psd');
  assertPixels(decodePsd(file), 32, 32, SOURCE);
});

test('an ICNS written by sips decodes to the pixels of its source', { skip: needs(sips, 'sips') }, () => {
  const file = converted('icns');
  assert.equal(sniffFormat(file), 'icns');
  const entries = listIcns(file);
  assert.deepEqual(entries.map((entry) => [entry.width, entry.height]), [[32, 32]]);
  const decoded = decodeIcns(file, entries[0]);
  // Packed RGB with a mask on the systems seen so far; a PNG entry would be Chromium's to decode.
  if ('raster' in decoded) {
    assertPixels(decoded.raster, 32, 32, SOURCE);
  } else {
    assert.equal(sniffFormat(decoded.png), 'png');
  }
});
