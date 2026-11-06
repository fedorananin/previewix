import { spawnSync } from 'child_process';
import * as fs from 'fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zlib from 'zlib';
import { DecodeError, type Raster } from '../src/imageFormats/common';
import { unpackLzw } from '../src/imageFormats/lzw';
import { listTiff } from '../src/imageFormats/tiff';
import { decodeTiff } from '../src/imageFormats/tiffDecode';
import { random } from './helpers';

// Every TIFF here is written by the builder below, sample by sample, so the pixels a decoder has to hand
// back are known without asking another decoder. The packers (PackBits, LZW, the predictor) are the test's
// own; they share nothing with the unpackers in src/ (UTIF's, and our own for LZW).

/**
 * Set in the process that the last test of this file starts on this same bundle: there it only decodes the
 * files it is given, which may never finish, and says what came of each. No test is registered in it.
 */
const CHILD = 'PREVIEWIX_TIFF_CHILD';
if (process.env[CHILD]) {
  for (const file of JSON.parse(fs.readFileSync(0, 'utf8')) as string[]) {
    let outcome = 'picture';
    try {
      // LZW data that ends early or goes wrong is shown as far as it got, with a warning.
      outcome = decodeTiff(Buffer.from(file, 'base64'), 0).warning ? 'picture with a warning' : 'picture';
    } catch (e) {
      outcome = e instanceof DecodeError ? 'refused' : `threw ${e instanceof Error ? e.stack : e}`.replace(/\n/g, ' | ');
    }
    // Written at once: what is still on its way through a pipe is lost when the process is killed.
    fs.writeSync(1, `${outcome}\n`);
  }
  process.exit(0);
}

// ---- A TIFF writer ----------------------------------------------------------------

const BYTE = 1;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const UNDEFINED = 7;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

/** A tag with its values; a RATIONAL takes numerator and denominator in turn. */
type Tag = [tag: number, type: number, values: number[] | Uint8Array];

/** One directory: its tags, and the strips or tiles the writer places and points at. */
interface Dir {
  tags: Tag[];
  chunks: Uint8Array[];
  tiled?: boolean;
}

/**
 * Strips and tiles go in front of their directory, or, with `dataLast`, behind all directories, which is where
 * a cut file loses them first. `dataAt` is for the writer itself.
 */
function tiffFile(dirs: Dir[], little = true, dataLast = false, dataAt = 0): Buffer {
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    little ? b.writeUInt16LE(n) : b.writeUInt16BE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    little ? b.writeUInt32LE(n >>> 0) : b.writeUInt32BE(n >>> 0);
    return b;
  };
  const parts: Buffer[] = [Buffer.concat([Buffer.from(little ? 'II' : 'MM'), u16(42), u32(0)])];
  let size = 8;
  /** Appends at an even offset, as the format asks, and says where. */
  const put = (data: Uint8Array) => {
    const at = size;
    parts.push(Buffer.from(data), Buffer.alloc(data.length & 1));
    size += data.length + (data.length & 1);
    return at;
  };
  /** Where each directory is, and where its link to the next one is. */
  const placed: [number, number][] = [];
  let behind = dataAt;
  for (const dir of dirs) {
    const offsets = dir.chunks.map((chunk) => {
      if (!dataLast) {
        return put(chunk);
      }
      behind += chunk.length;
      return behind - chunk.length;
    });
    const tags: Tag[] = [...dir.tags, [dir.tiled ? 324 : 273, LONG, offsets], [dir.tiled ? 325 : 279, LONG, dir.chunks.map((chunk) => chunk.length)]];
    tags.sort((a, z) => a[0] - z[0]);
    const entries = tags.map(([tag, type, values]) => {
      const raw = Buffer.concat(type === SHORT ? Array.from(values, u16) : type === LONG || type === RATIONAL ? Array.from(values, u32) : [Buffer.from(values)]);
      const field = raw.length <= 4 ? Buffer.concat([raw, Buffer.alloc(4 - raw.length)]) : u32(put(raw));
      return Buffer.concat([u16(tag), u16(type), u32(raw.length / TYPE_SIZE[type]), field]);
    });
    const at = put(Buffer.concat([u16(entries.length), ...entries, u32(0)]));
    placed.push([at, at + 2 + entries.length * 12]);
  }
  const file = Buffer.concat(parts);
  placed.forEach(([at], i) => u32(at).copy(file, i ? placed[i - 1][1] : 4));
  if (!dataLast) {
    return file;
  }
  // The directories are as long whatever the offsets in them say, so a first pass tells where the data starts.
  return dataAt ? Buffer.concat([file, ...dirs.flatMap((dir) => dir.chunks)]) : tiffFile(dirs, little, true, file.length);
}

/** Where the 12-byte entry of a tag is in the first directory of a little-endian file, for the tests that damage one. */
function entryOf(file: Buffer, tag: number): number {
  const ifd = file.readUInt32LE(4);
  for (let i = 0; i < file.readUInt16LE(ifd); i++) {
    if (file.readUInt16LE(ifd + 2 + i * 12) === tag) {
      return ifd + 2 + i * 12;
    }
  }
  throw new Error(`no tag ${tag}`);
}

// ---- Packers ----------------------------------------------------------------------

/** PackBits, row by row as TIFF wants it: 257 − n repeats a byte n times, n − 1 is followed by n literal bytes. */
function packBits(data: Uint8Array, stride: number): Buffer {
  const out: number[] = [];
  for (let row = 0; row < data.length; row += stride) {
    const end = row + stride;
    for (let at = row; at < end; ) {
      let run = 1;
      while (at + run < end && run < 128 && data[at + run] === data[at]) {
        run++;
      }
      if (run > 1) {
        out.push(257 - run, data[at]);
        at += run;
        continue;
      }
      const start = at;
      while (at < end && at - start < 128 && !(at + 1 < end && data[at + 1] === data[at])) {
        at++;
      }
      out.push(at - start - 1, ...data.subarray(start, at));
    }
  }
  return Buffer.from(out);
}

/** TIFF's LZW: codes of 9 to 12 bits, most significant bit first, the code grows one entry early, 256 clears and 257 ends. */
function lzw(data: Uint8Array): Buffer {
  const out: number[] = [];
  let pending = 0;
  let held = 0;
  let width = 9;
  let next = 258;
  let table = new Map<number, number>();
  const emit = (code: number) => {
    pending = (pending << width) | code;
    held += width;
    while (held >= 8) {
      out.push((pending >> (held - 8)) & 255);
      held -= 8;
    }
    pending &= (1 << held) - 1;
  };
  emit(256);
  let prefix = -1;
  for (const byte of data) {
    const known = prefix < 0 ? byte : table.get(prefix * 256 + byte);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    table.set(prefix * 256 + byte, next++);
    if (next === 4094) {
      emit(256);
      table = new Map();
      next = 258;
      width = 9;
    } else if (next > (1 << width) - 1) {
      width++;
    }
    prefix = byte;
  }
  if (prefix >= 0) {
    emit(prefix);
  }
  emit(257);
  if (held) {
    out.push((pending << (8 - held)) & 255);
  }
  return Buffer.from(out);
}

const PACKERS: Record<number, (data: Uint8Array, stride: number) => Uint8Array> = {
  1: (data) => data,
  5: lzw,
  8: (data) => zlib.deflateSync(data),
  32773: packBits,
};

// ---- Pictures ---------------------------------------------------------------------

interface Layout {
  width: number;
  height: number;
  /** Bits per sample: 1, 2, 4, 8 or 16. */
  bits?: number;
  samples?: number;
  photometric: number;
  compression?: number;
  /** Rows per strip; one strip without it. */
  rows?: number;
  /** Width and height of a tile, instead of strips. */
  tile?: [number, number];
  /** Every sample in a plane of its own. */
  planar?: boolean;
  /** Horizontal differencing before packing (8-bit samples). */
  predictor?: boolean;
  more?: Tag[];
}

/**
 * A directory for `values`, the samples of the picture pixel by pixel and row by row, laid out as `layout`
 * says. Samples of 16 bits are written in the byte order of the file, smaller ones packed from the top bit.
 */
function page(layout: Layout, values: ArrayLike<number>, little = true): Dir {
  const { width, height } = layout;
  const bits = layout.bits ?? 8;
  const samples = layout.samples ?? 1;
  const compression = layout.compression ?? 1;
  const all = Array.from({ length: samples }, (_, s) => s);
  const planes = layout.planar ? all.map((s) => [s]) : [all];
  const [chunkWidth, chunkHeight] = layout.tile ?? [width, layout.rows ?? height];
  const chunks: Uint8Array[] = [];
  for (const plane of planes) {
    for (let top = 0; top < height; top += chunkHeight) {
      for (let left = 0; left < width; left += chunkWidth) {
        // A strip ends with the picture. A tile is always whole, and what lies outside the picture is padding.
        const rows = layout.tile ? chunkHeight : Math.min(chunkHeight, height - top);
        const stride = Math.ceil((chunkWidth * bits * plane.length) / 8);
        const raw = new Uint8Array(stride * rows);
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < chunkWidth; x++) {
            plane.forEach((s, k) => {
              const inside = left + x < width && top + y < height;
              const value = inside ? values[((top + y) * width + left + x) * samples + s] : 0;
              const i = x * plane.length + k;
              if (bits === 16) {
                raw[y * stride + i * 2 + (little ? 0 : 1)] = value & 255;
                raw[y * stride + i * 2 + (little ? 1 : 0)] = value >> 8;
              } else if (bits === 8) {
                raw[y * stride + i] = value;
              } else {
                raw[y * stride + ((i * bits) >> 3)] |= value << (8 - bits - ((i * bits) & 7));
              }
            });
          }
          if (layout.predictor) {
            for (let i = stride - 1; i >= plane.length; i--) {
              raw[y * stride + i] -= raw[y * stride + i - plane.length];
            }
          }
        }
        chunks.push(PACKERS[compression](raw, stride));
      }
    }
  }
  const tags: Tag[] = [
    [256, LONG, [width]],
    [257, LONG, [height]],
    [258, SHORT, all.map(() => bits)],
    [259, SHORT, [compression]],
    [262, SHORT, [layout.photometric]],
    [277, SHORT, [samples]],
    ...(layout.more ?? []),
  ];
  if (layout.tile) {
    tags.push([322, SHORT, [chunkWidth]], [323, SHORT, [chunkHeight]]);
  } else {
    tags.push([278, SHORT, [chunkHeight]]);
  }
  if (layout.planar) {
    tags.push([284, SHORT, [2]]);
  }
  if (layout.predictor) {
    tags.push([317, SHORT, [2]]);
  }
  return { tags, chunks, tiled: !!layout.tile };
}

const tiff = (layout: Layout, values: ArrayLike<number>, little = true) => tiffFile([page(layout, values, little)], little);

/** RGBA from samples of 8 bits: `pick` names the sample (or a constant, as a negative number's complement) of each channel. */
function rgba(values: ArrayLike<number>, samples: number, pick: (pixel: number[]) => number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += samples) {
    out.push(...pick(Array.from({ length: samples }, (_, s) => values[i + s])));
  }
  return out;
}
const opaque = (values: ArrayLike<number>) => rgba(values, 3, ([r, g, b]) => [r, g, b, 255]);

/** Compares pixel by pixel, so a failure names the first pixel that is wrong instead of printing two long arrays. */
function assertPixels(raster: Raster, width: number, height: number, expected: number[], tolerance = 0): void {
  assert.deepEqual([raster.width, raster.height], [width, height]);
  assert.equal(raster.data.length, width * height * 4);
  assert.equal(expected.length, raster.data.length);
  for (let i = 0; i < expected.length; i += 4) {
    const got = Array.from(raster.data.subarray(i, i + 4));
    const want = expected.slice(i, i + 4);
    if (got.some((value, c) => Math.abs(value - want[c]) > tolerance)) {
      assert.fail(`pixel ${(i / 4) % width}, ${Math.floor(i / 4 / width)}: got ${got}, expected ${want}`);
    }
  }
}

const rnd = random(7);
const W = 20;
const H = 18;
const RGB = rnd.bytes(W * H * 3);

// ---- Layouts and compressions -----------------------------------------------------

test('an uncompressed RGB picture comes out as it went in, in both byte orders', () => {
  for (const little of [true, false]) {
    const file = tiff({ width: W, height: H, samples: 3, photometric: 2 }, RGB, little);
    assertPixels(decodeTiff(file, 0), W, H, opaque(RGB));
  }
});

for (const [name, compression] of [
  ['uncompressed', 1],
  ['PackBits', 32773],
  ['LZW', 5],
  ['Deflate', 8],
] as const) {
  test(`${name} data in several strips decodes to the same pixels`, () => {
    // Rows of one color between the random ones give PackBits and LZW something to repeat.
    const values = Uint8Array.from(RGB);
    values.fill(200, W * 3 * 4, W * 3 * 9);
    const file = tiff({ width: W, height: H, samples: 3, photometric: 2, compression, rows: 5 }, values);
    assert.equal(listTiff(file)[0].compression, compression);
    assertPixels(decodeTiff(file, 0), W, H, opaque(values));
  });
}

test('an LZW stream long enough to fill its table and start over decodes', () => {
  const values = random(8).bytes(64 * 64 * 3);
  assertPixels(decodeTiff(tiff({ width: 64, height: 64, samples: 3, photometric: 2, compression: 5 }, values), 0), 64, 64, opaque(values));
});

test('horizontal differencing (predictor 2) is undone', () => {
  const file = tiff({ width: W, height: H, samples: 3, photometric: 2, compression: 5, predictor: true, rows: 7 }, RGB);
  assertPixels(decodeTiff(file, 0), W, H, opaque(RGB));
});

test('tiles are put together, and their padding beyond the picture is dropped', () => {
  for (const compression of [1, 5]) {
    const file = tiff({ width: W, height: H, samples: 3, photometric: 2, compression, tile: [16, 16] }, RGB);
    const [listed] = listTiff(file);
    assert.equal(listed.tiled, true);
    assert.equal(listed.complete, true);
    assertPixels(decodeTiff(file, 0), W, H, opaque(RGB));
  }
});

test('separate planes are woven into pixels', () => {
  for (const compression of [1, 5]) {
    const file = tiff({ width: W, height: H, samples: 3, photometric: 2, compression, planar: true, rows: 6 }, RGB);
    assert.equal(listTiff(file)[0].planar, 2);
    assertPixels(decodeTiff(file, 0), W, H, opaque(RGB));
  }
});

// ---- Depths and color types -------------------------------------------------------

test('16-bit samples are read in the byte order of the file and rounded to 8 bits', () => {
  // Multiples of 257 are the 16-bit values that are exactly an 8-bit one.
  const levels = Array.from({ length: 4 * 3 * 3 }, (_, i) => (i * 7) % 256);
  for (const little of [true, false]) {
    const file = tiff({ width: 4, height: 3, bits: 16, samples: 3, photometric: 2 }, levels.map((level) => level * 257), little);
    const raster = decodeTiff(file, 0);
    assertPixels(raster, 4, 3, opaque(levels));
    assert.deepEqual(raster.notes, [['Depth', '16 bits per channel, shown with 8']]);
  }
});

test('separate 16-bit planes keep both bytes of a sample', () => {
  const levels = Array.from({ length: 4 * 3 * 3 }, (_, i) => (i * 11) % 256);
  // 0x0101 × level has the same byte twice; a value with different halves tells the bytes apart.
  const values = levels.map((level) => level * 257);
  values[0] = 0xff00;
  values[1] = 0x00ff;
  const expected = opaque(levels);
  expected[0] = 254;
  expected[1] = 1;
  for (const little of [true, false]) {
    assertPixels(decodeTiff(tiff({ width: 4, height: 3, bits: 16, samples: 3, photometric: 2, planar: true }, values, little), 0), 4, 3, expected);
  }
});

test('grayscale: black is zero, white is zero, and 1, 2 and 4 bits per pixel', () => {
  const gray = rnd.bytes(W * H);
  assertPixels(decodeTiff(tiff({ width: W, height: H, photometric: 1 }, gray), 0), W, H, rgba(gray, 1, ([v]) => [v, v, v, 255]));
  assertPixels(decodeTiff(tiff({ width: W, height: H, photometric: 0 }, gray), 0), W, H, rgba(gray, 1, ([v]) => [255 - v, 255 - v, 255 - v, 255]));
  // 13 pixels a row: the rows don't end on a byte.
  for (const bits of [1, 2, 4]) {
    const top = (1 << bits) - 1;
    const small = Array.from({ length: 13 * 5 }, () => rnd.int(top + 1));
    const shade = (v: number) => Math.round((v * 255) / top);
    assertPixels(decodeTiff(tiff({ width: 13, height: 5, bits, photometric: 1 }, small), 0), 13, 5, rgba(small, 1, ([v]) => [shade(v), shade(v), shade(v), 255]));
    assertPixels(decodeTiff(tiff({ width: 13, height: 5, bits, photometric: 0 }, small), 0), 13, 5, rgba(small, 1, ([v]) => [255 - shade(v), 255 - shade(v), 255 - shade(v), 255]));
  }
});

test('a palette picture takes its colors from the color map, all reds first', () => {
  for (const bits of [4, 8]) {
    const size = 1 << bits;
    const map = Array.from({ length: size * 3 }, (_, i) => (i * 37) % 256);
    const indexes = Array.from({ length: 13 * 5 }, () => rnd.int(size));
    const file = tiff({ width: 13, height: 5, bits, photometric: 3, more: [[320, SHORT, map.map((level) => level * 257)]] }, indexes);
    assertPixels(decodeTiff(file, 0), 13, 5, rgba(indexes, 1, ([v]) => [map[v], map[size + v], map[size * 2 + v], 255]));
  }
});

test('a palette picture without its color map is refused', () => {
  assert.throws(() => decodeTiff(tiff({ width: 4, height: 4, photometric: 3 }, new Uint8Array(16)), 0), DecodeError);
});

test('CMYK is converted with a warning: no ink is white, full black is dark', () => {
  const inks = [0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0];
  const raster = decodeTiff(tiff({ width: 3, height: 1, samples: 4, photometric: 5 }, inks), 0);
  assert.deepEqual(Array.from(raster.data.subarray(0, 4)), [255, 255, 255, 255]);
  const [r, g, b, a] = raster.data.subarray(4, 8);
  assert.ok(r < 70 && g < 70 && b < 70 && a === 255, `black ink gave ${[r, g, b, a]}`);
  // Cyan ink takes the red away and leaves the blue.
  assert.ok(raster.data[8] < 80 && raster.data[10] > 180, `cyan ink gave ${Array.from(raster.data.subarray(8, 12))}`);
  assert.match(raster.warning ?? '', /CMYK/);
  assert.equal(raster.notes[0][0], 'Color');
});

test('CIE Lab is converted to sRGB', () => {
  // L 100 is white, L 0 black; a and b are signed bytes, and a = +80 is a strong red-magenta.
  const lab = [255, 0, 0, 0, 0, 0, 136, 80, 256 - 30];
  const raster = decodeTiff(tiff({ width: 3, height: 1, samples: 3, photometric: 8 }, lab), 0);
  assert.deepEqual(Array.from(raster.data.subarray(0, 8)), [255, 255, 255, 255, 0, 0, 0, 255]);
  const [r, g, b] = raster.data.subarray(8, 11);
  assert.ok(r > 200 && g < 110 && b > 150, `Lab(53, 80, -30) gave ${[r, g, b]}`);
  assert.deepEqual(raster.notes, [['Color', 'Lab, converted to sRGB']]);
});

// ---- Transparency -----------------------------------------------------------------

const RGBA = (() => {
  const values = Array.from(rnd.bytes(6 * 4 * 4));
  // Both ends of the alpha range are in.
  values[3] = 0;
  values[7] = 255;
  return values;
})();

test('an extra sample marked as plain alpha is the transparency, colors untouched', () => {
  const file = tiff({ width: 6, height: 4, samples: 4, photometric: 2, more: [[338, SHORT, [2]]] }, RGBA);
  assertPixels(decodeTiff(file, 0), 6, 4, RGBA);
});

test('colors multiplied by their alpha are divided again', () => {
  // What a writer of associated alpha stores, and the straight colors a reader has to give back.
  const stored = rgba(RGBA, 4, ([r, g, b, a]) => [Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255), a]);
  const straight = rgba(stored, 4, ([r, g, b, a]) => (a === 0 ? [r, g, b, a] : [...[r, g, b].map((c) => Math.min(255, Math.round((c * 255) / a))), a]));
  for (const more of [[[338, SHORT, [1]]], []] as Tag[][]) {
    // Without the tag a fourth RGB sample is read as libtiff reads it: associated alpha.
    assertPixels(decodeTiff(tiff({ width: 6, height: 4, samples: 4, photometric: 2, more }, stored), 0), 6, 4, straight);
  }
});

test('an extra sample of unspecified meaning is not transparency', () => {
  const file = tiff({ width: 6, height: 4, samples: 4, photometric: 2, more: [[338, SHORT, [0]]] }, RGBA);
  assertPixels(decodeTiff(file, 0), 6, 4, rgba(RGBA, 4, ([r, g, b]) => [r, g, b, 255]));
});

test('gray with alpha', () => {
  const values = rnd.bytes(5 * 3 * 2);
  const file = tiff({ width: 5, height: 3, samples: 2, photometric: 1, more: [[338, SHORT, [2]]] }, values);
  assertPixels(decodeTiff(file, 0), 5, 3, rgba(values, 2, ([v, a]) => [v, v, v, a]));
});

// ---- Orientation, profile, resolution ---------------------------------------------

test('the orientation tag turns the picture upright', () => {
  // 3 × 2, each pixel its own color. For every orientation: where the first stored row and the first stored
  // column are in the upright picture, as the TIFF specification lists them.
  const values = [10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0, 50, 0, 0, 60, 0, 0];
  const sides: Record<number, [row: string, column: string]> = {
    1: ['top', 'left'],
    2: ['top', 'right'],
    3: ['bottom', 'right'],
    4: ['bottom', 'left'],
    5: ['left', 'top'],
    6: ['right', 'top'],
    7: ['right', 'bottom'],
    8: ['left', 'bottom'],
  };
  for (const [orientation, [rowSide, columnSide]] of Object.entries(sides)) {
    const turned = rowSide === 'left' || rowSide === 'right';
    const [width, height] = turned ? [2, 3] : [3, 2];
    const expected = new Array<number>(width * height * 4).fill(0);
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 3; column++) {
        // A row counts along the side opposite to where the columns start, and the other way round.
        const along = columnSide === 'left' || columnSide === 'top' ? column : 2 - column;
        const across = rowSide === 'top' || rowSide === 'left' ? row : 1 - row;
        const [x, y] = turned ? [across, along] : [along, across];
        expected.splice((y * width + x) * 4, 4, values[(row * 3 + column) * 3], 0, 0, 255);
      }
    }
    const file = tiff({ width: 3, height: 2, samples: 3, photometric: 2, more: [[274, SHORT, [Number(orientation)]]] }, values);
    assert.equal(listTiff(file)[0].orientation, Number(orientation));
    assertPixels(decodeTiff(file, 0), width, height, expected);
  }
});

test('the color profile of an RGB picture is handed on untouched', () => {
  const profile = random(3).bytes(300);
  const file = tiff({ width: 2, height: 2, samples: 3, photometric: 2, more: [[34675, UNDEFINED, profile]] }, RGB.subarray(0, 12));
  assert.deepEqual(Buffer.from(decodeTiff(file, 0).icc ?? []), profile);
  assert.equal(decodeTiff(tiff({ width: 2, height: 2, samples: 3, photometric: 2 }, RGB.subarray(0, 12)), 0).icc, undefined);
  // A gray profile does not describe the RGB values that come out.
  const gray = tiff({ width: 2, height: 2, photometric: 1, more: [[34675, UNDEFINED, profile]] }, RGB.subarray(0, 4));
  assert.equal(decodeTiff(gray, 0).icc, undefined);
});

test('the resolution is given per inch, whatever unit the file uses', () => {
  const dpi = (more: Tag[]) => listTiff(tiff({ width: 2, height: 2, photometric: 1, more }, [1, 2, 3, 4]))[0].dpi;
  assert.deepEqual(dpi([[282, RATIONAL, [300, 1]], [283, RATIONAL, [1200, 4]], [296, SHORT, [2]]]), [300, 300]);
  assert.deepEqual(dpi([[282, RATIONAL, [100, 1]], [283, RATIONAL, [50, 1]], [296, SHORT, [3]]]), [254, 127]);
  // Unit 1 is "no unit": a ratio of the sides, not a resolution.
  assert.equal(dpi([[282, RATIONAL, [1, 1]], [283, RATIONAL, [1, 1]], [296, SHORT, [1]]]), undefined);
  assert.equal(dpi([]), undefined);
});

// ---- Pages ------------------------------------------------------------------------

test('every page is listed with its size and can be decoded on its own', () => {
  const second = rnd.bytes(5 * 7);
  const third = rnd.bytes(2 * 2 * 3);
  for (const little of [true, false]) {
    const file = tiffFile(
      [
        page({ width: W, height: H, samples: 3, photometric: 2, compression: 5 }, RGB, little),
        page({ width: 5, height: 7, photometric: 1, compression: 32773 }, second, little),
        page({ width: 2, height: 2, samples: 3, photometric: 2, more: [[254, LONG, [1]]] }, third, little),
      ],
      little,
    );
    const pages = listTiff(file);
    assert.deepEqual(
      pages.map((p) => [p.label, p.width, p.height, p.samples, p.reduced]),
      [
        [`Page 1 · ${W} × ${H}`, W, H, 3, false],
        ['Page 2 · 5 × 7', 5, 7, 1, false],
        ['Page 3 · 2 × 2 (reduced)', 2, 2, 3, true],
      ],
    );
    assertPixels(decodeTiff(file, 0), W, H, opaque(RGB));
    assertPixels(decodeTiff(file, 1), 5, 7, rgba(second, 1, ([v]) => [v, v, v, 255]));
    assertPixels(decodeTiff(file, 2), 2, 2, opaque(third));
    assert.throws(() => decodeTiff(file, 3), DecodeError);
  }
});

test('what a page is made of is read from its tags, with the defaults of the format', () => {
  const [bare] = listTiff(tiff({ width: 3, height: 2, photometric: 1 }, [1, 2, 3, 4, 5, 6]));
  assert.deepEqual(
    [bare.bits, bare.samples, bare.compression, bare.photometric, bare.orientation, bare.planar, bare.sampleFormat, bare.extra, bare.tiled, bare.complete],
    [8, 1, 1, 1, 1, 1, 1, undefined, false, true],
  );
  const [full] = listTiff(tiff({ width: 3, height: 2, bits: 16, samples: 4, photometric: 2, compression: 8, more: [[338, SHORT, [2]], [339, SHORT, [1, 1, 1, 1]]] }, new Array(24).fill(0)));
  assert.deepEqual([full.bits, full.samples, full.compression, full.photometric, full.extra, full.mixedBits], [16, 4, 8, 2, [2], false]);
  // BYTE and UNDEFINED tags come as bytes, the others as numbers.
  const [tagged] = listTiff(tiff({ width: 1, height: 1, photometric: 1, more: [[700, BYTE, Buffer.from('<x/>!')], [33432, SHORT, [7, 8, 9]]] }, [0]));
  assert.deepEqual(Buffer.from(tagged.values(700) as Uint8Array).toString(), '<x/>!');
  assert.deepEqual(tagged.values(33432), [7, 8, 9]);
  assert.equal(tagged.values(999), undefined);
});

// ---- What is refused --------------------------------------------------------------

test('what is not a TIFF, and BigTIFF, is refused in words', () => {
  assert.throws(() => listTiff(Buffer.from('not a picture at all')), DecodeError);
  assert.throws(() => listTiff(Buffer.alloc(0)), DecodeError);
  assert.throws(() => listTiff(Buffer.from('II\x2a\x00\x08\x00\x00')), DecodeError);
  assert.throws(() => listTiff(Buffer.from('II\x2c\x00\x08\x00\x00\x00', 'latin1')), /not a TIFF/);
  for (const magic of ['II\x2b\x00\x08\x00\x00\x00', 'MM\x00\x2b\x00\x08\x00\x00']) {
    const file = Buffer.concat([Buffer.from(magic, 'latin1'), Buffer.alloc(40)]);
    assert.throws(() => listTiff(file), (e: unknown) => e instanceof DecodeError && /BigTIFF/.test(e.message));
  }
});

test('layouts that would be shown wrong are refused with a DecodeError that names them', () => {
  const refused = (layout: Layout, values: ArrayLike<number>, message: RegExp) => {
    const file = tiff(layout, values);
    // The directory is fine: the page is listed, and only decoding says no.
    assert.equal(listTiff(file).length, 1);
    assert.throws(() => decodeTiff(file, 0), (e: unknown) => e instanceof DecodeError && message.test(e.message), `${message}`);
  };
  const some = new Array(64).fill(0);
  refused({ width: 2, height: 2, samples: 3, photometric: 2, more: [[339, SHORT, [3, 3, 3]]] }, some, /floating-point/);
  refused({ width: 2, height: 2, samples: 3, photometric: 2, more: [[339, SHORT, [2, 2, 2]]] }, some, /signed/);
  refused({ width: 2, height: 2, samples: 3, photometric: 6 }, some, /YCbCr/);
  refused({ width: 2, height: 2, samples: 3, photometric: 32803 }, some, /Camera sensor/);
  refused({ width: 2, height: 2, samples: 2, photometric: 2 }, some, /2 samples/);
  refused({ width: 2, height: 2, bits: 4, samples: 3, photometric: 2 }, some, /4 bits/);
  // Compressions the format knows and this reader doesn't: JPEG 2000, LZMA, Zstandard, and a number nobody knows.
  for (const [compression, name] of [[34712, /JPEG 2000/], [34925, /LZMA/], [50000, /Zstandard/], [65000, /type 65000/]] as const) {
    const file = tiff({ width: 2, height: 2, photometric: 1 }, some);
    file.writeUInt16LE(compression, entryOf(file, 259) + 8);
    assert.throws(() => decodeTiff(file, 0), (e: unknown) => e instanceof DecodeError && name.test(e.message));
  }
  // Samples of different sizes (5-6-5).
  const mixed = tiff({ width: 2, height: 2, samples: 3, photometric: 2 }, some);
  mixed.writeUInt16LE(5, mixed.readUInt32LE(entryOf(mixed, 258) + 8));
  assert.equal(listTiff(mixed)[0].mixedBits, true);
  assert.throws(() => decodeTiff(mixed, 0), (e: unknown) => e instanceof DecodeError && /different sizes/.test(e.message));
});

// ---- Damage -----------------------------------------------------------------------

/** No case may take longer. Each one is a file of about a kilobyte, so anything near this is a hang in the making. */
const BUDGET_MS = 1500;

type Outcome = 'picture' | 'refused';

/**
 * Runs the reader and the decoder on bytes that may be anything. They have to answer with pictures or with
 * a DecodeError, and soon. Returns what happened per page, for the tests that expect one of the two.
 */
function survive(bytes: Uint8Array, what: string): Outcome[] {
  const started = performance.now();
  const outcome: Outcome[] = [];
  const other = (e: unknown) => new Error(`${what}: threw something else than a DecodeError: ${e instanceof Error ? e.stack : e}`);
  let pages: ReturnType<typeof listTiff> = [];
  try {
    pages = listTiff(bytes);
  } catch (e) {
    if (!(e instanceof DecodeError)) {
      throw other(e);
    }
    outcome.push('refused');
  }
  for (let i = 0; i < Math.min(pages.length, 3); i++) {
    try {
      const raster = decodeTiff(bytes, i);
      assert.equal(raster.data.length, raster.width * raster.height * 4, what);
      outcome.push('picture');
    } catch (e) {
      if (!(e instanceof DecodeError)) {
        throw other(e);
      }
      outcome.push('refused');
    }
  }
  const took = performance.now() - started;
  assert.ok(took < BUDGET_MS, `${what}: took ${Math.round(took)} ms`);
  return outcome;
}

const STRIPS: Layout = { width: 12, height: 10, samples: 3, photometric: 2, compression: 32773, rows: 4, more: [[282, RATIONAL, [72, 1]], [283, RATIONAL, [72, 1]]] };

/** Two pages, strips and a tile, with values that live outside their entries: something of everything to damage. */
const SOUND = tiffFile([page(STRIPS, RGB.subarray(0, 360)), page({ width: 16, height: 16, photometric: 1, compression: 8, tile: [16, 16] }, RGB.subarray(0, 256))]);

test('the file the damage tests start from is sound', () => {
  assert.deepEqual(survive(SOUND, 'sound'), ['picture', 'picture']);
});

test('a file cut short at any length gives pictures or a DecodeError', () => {
  for (let length = 0; length < SOUND.length; length++) {
    // A copy of exactly that length: a view into the whole file would let a stray read succeed.
    survive(Uint8Array.from(SOUND.subarray(0, length)), `cut at ${length}`);
  }
});

test('a picture whose data is cut anywhere is refused, not shown with a hole', () => {
  // The directory first and the strips behind it, as most writers lay a file out: a cut takes strips away.
  for (const layout of [
    { ...STRIPS, compression: 1 },
    { ...STRIPS, compression: 1, rows: undefined },
    { ...STRIPS, compression: 5 },
    { ...STRIPS, compression: 5, rows: undefined, tile: [16, 16] },
    { ...STRIPS, planar: true },
  ] as Layout[]) {
    const file = tiffFile([page(layout, RGB.subarray(0, 360))], true, true);
    assertPixels(decodeTiff(file, 0), 12, 10, opaque(RGB.subarray(0, 360)));
    const data = Math.min(...(listTiff(file)[0].values(layout.tile ? 324 : 273) as number[]));
    for (let length = data; length < file.length; length++) {
      const cut = Uint8Array.from(file.subarray(0, length));
      assert.equal(listTiff(cut)[0].complete, false, `cut at ${length} of ${file.length}`);
      assert.throws(() => decodeTiff(cut, 0), (e: unknown) => e instanceof DecodeError && /outside the file/.test(e.message));
    }
  }
});

test('an uncompressed strip that is shorter than the picture is refused', () => {
  // One strip of 4 rows where the header promises 40. Old files leave the byte count out or get it wrong, so
  // the reader goes by the geometry: whatever the count says, 40 rows don't fit into this file.
  for (const count of [32, 8, 320, 0]) {
    const file = tiff({ width: 8, height: 4, photometric: 1 }, new Array(32).fill(9));
    file.writeUInt32LE(40, entryOf(file, 257) + 8);
    file.writeUInt16LE(40, entryOf(file, 278) + 8);
    file.writeUInt32LE(count, entryOf(file, 279) + 8);
    assert.equal(listTiff(file)[0].complete, false, `byte count ${count}`);
    assert.deepEqual(survive(file, 'short strip'), ['refused']);
  }
});

test('flipped bits anywhere in the file give pictures or a DecodeError', () => {
  const flip = random(11);
  for (let round = 0; round < 300; round++) {
    const file = Buffer.from(SOUND);
    for (let n = 1 + flip.int(3); n > 0; n--) {
      file[flip.int(file.length)] ^= 1 << flip.int(8);
    }
    survive(file, `flip round ${round}`);
  }
});

test('flipped bits in the directory give pictures or a DecodeError', () => {
  // The same, aimed at the 12-byte entries, where every bit means something.
  const flip = random(14);
  const file = tiff(STRIPS, RGB.subarray(0, 360));
  const ifd = file.readUInt32LE(4);
  const size = 2 + file.readUInt16LE(ifd) * 12 + 4;
  for (let round = 0; round < 400; round++) {
    const damaged = Buffer.from(file);
    for (let n = 1 + flip.int(2); n > 0; n--) {
      damaged[ifd + flip.int(size)] ^= 1 << flip.int(8);
    }
    survive(damaged, `directory flip round ${round}`);
  }
});

test('noise behind the magic number gives pictures or a DecodeError', () => {
  const noise = random(12);
  for (let round = 0; round < 150; round++) {
    // Sometimes the offset of the first directory survives as well, sometimes it points into the noise.
    const keep = noise.pick([4, 8]);
    const file = Buffer.concat([SOUND.subarray(0, keep), noise.bytes(200 + noise.int(400))]);
    if (keep === 4) {
      file.writeUInt32LE(8 + noise.int(100), 4);
    }
    survive(file, `noise round ${round}`);
  }
});

test('a chain of directories that loops ends the list', () => {
  const first = SOUND.readUInt32LE(4);
  const second = SOUND.readUInt32LE(first + 2 + SOUND.readUInt16LE(first) * 12);
  const linkOfSecond = second + 2 + SOUND.readUInt16LE(second) * 12;
  for (const target of [first, second]) {
    const file = Buffer.from(SOUND);
    file.writeUInt32LE(target, linkOfSecond);
    assert.equal(listTiff(file).length, 2);
    assert.deepEqual(survive(file, 'loop'), ['picture', 'picture']);
  }
  // A link that leaves the file, or lands where no directory fits.
  for (const target of [SOUND.length, SOUND.length + 1000, SOUND.length - 3, 0xffffffff]) {
    const file = Buffer.from(SOUND);
    file.writeUInt32LE(target, linkOfSecond);
    assert.equal(listTiff(file).length, 2);
  }
});

test('a first directory outside the file is a damaged file', () => {
  for (const target of [SOUND.length + 50, 0xfffffff0, 0, SOUND.length - 1]) {
    const file = Buffer.from(SOUND);
    file.writeUInt32LE(target, 4);
    assert.deepEqual(survive(file, `directory at ${target}`), ['refused']);
  }
});

test('a tag that claims four billion values is not followed', () => {
  for (const tag of [273, 279, 258, 282, 256]) {
    for (const count of [0xffffffff, 0x7fffffff, 0x40000000]) {
      const file = tiff(STRIPS, RGB.subarray(0, 360));
      file.writeUInt32LE(count, entryOf(file, tag) + 4);
      assert.deepEqual(survive(file, `tag ${tag} × ${count}`), ['refused']);
    }
  }
});

test('strips and tiles that lie outside the file are refused', () => {
  const strips = tiff(STRIPS, RGB.subarray(0, 360));
  const offsets = strips.readUInt32LE(entryOf(strips, 273) + 8);
  const lengths = strips.readUInt32LE(entryOf(strips, 279) + 8);
  for (const [at, value] of [[offsets, strips.length + 1000], [offsets + 8, 0xfffffff0], [lengths + 4, strips.length], [lengths, 0xffffffff]]) {
    const file = Buffer.from(strips);
    file.writeUInt32LE(value, at);
    assert.equal(listTiff(file)[0].complete, false);
    assert.deepEqual(survive(file, 'strip outside'), ['refused']);
  }
  const tiles = tiff({ width: 16, height: 16, photometric: 1, compression: 8, tile: [16, 16] }, RGB.subarray(0, 256));
  tiles.writeUInt32LE(tiles.length - 4, entryOf(tiles, 324) + 8);
  assert.deepEqual(survive(tiles, 'tile outside'), ['refused']);
  // Offsets without their byte counts, where the counts are needed.
  const noCounts = Buffer.from(strips);
  noCounts.writeUInt16LE(60000, entryOf(noCounts, 279));
  assert.deepEqual(survive(noCounts, 'no byte counts'), ['refused']);
});

test('a size no canvas can hold is refused before anything is unpacked', () => {
  for (const [width, height] of [[60000, 60000], [40000, 2], [2, 40000], [20000, 20000], [0xffffffff, 0xffffffff]]) {
    const file = tiff(STRIPS, RGB.subarray(0, 360));
    file.writeUInt32LE(width, entryOf(file, 256) + 8);
    file.writeUInt32LE(height, entryOf(file, 257) + 8);
    const started = performance.now();
    assert.throws(() => decodeTiff(file, 0), (e: unknown) => e instanceof DecodeError && /more than the editor can hold/.test(e.message));
    assert.ok(performance.now() - started < 250, 'refused without work');
  }
});

test('a page without a size is no page', () => {
  for (const tag of [256, 257]) {
    const file = tiff(STRIPS, RGB.subarray(0, 360));
    file.writeUInt32LE(0, entryOf(file, tag) + 8);
    assert.throws(() => listTiff(file), (e: unknown) => e instanceof DecodeError && /damaged or cut short/.test(e.message));
  }
  // A sound page behind it is still found.
  const file = Buffer.from(SOUND);
  file.writeUInt32LE(0, entryOf(file, 256) + 8);
  assert.deepEqual(listTiff(file).map((p) => p.label), ['Page 1 · 16 × 16']);
});

/** Files whose one strip was cut or overwritten: half of them say the strip is shorter than it is, half have bytes replaced. */
function scrambled(compression: number, seed: number, rounds: number): Buffer[] {
  const scramble = random(seed);
  const sound = tiff({ ...STRIPS, compression, rows: undefined }, RGB.subarray(0, 360));
  const length = sound.readUInt32LE(entryOf(sound, 279) + 8);
  return Array.from({ length: rounds }, (_, round) => {
    const file = Buffer.from(sound);
    if (round % 2) {
      file.writeUInt32LE(scramble.int(length), entryOf(file, 279) + 8);
    } else {
      // The strip is the first thing after the 8 bytes of the header.
      for (let n = 1 + scramble.int(4); n > 0; n--) {
        file[8 + scramble.int(length)] = scramble.int(256);
      }
    }
    return file;
  });
}

test('PackBits and Deflate data that is cut or scrambled inside its strip gives a picture or a DecodeError', () => {
  for (const compression of [8, 32773]) {
    scrambled(compression, 13, 60).forEach((file, round) => survive(file, `compression ${compression}, round ${round}`));
  }
});

// ---- A size the data can't fill ----------------------------------------------------

test('a picture far larger than its data could unpack to is refused before it is allocated', () => {
  // A sound little file whose size tags are then raised to the largest a canvas takes: 16384 × 16384 would be
  // 268 MB of samples and a gigabyte of pixels, from a few dozen bytes. Unrefused, this test would take seconds.
  for (const compression of [1, 5, 8, 32773]) {
    const file = tiff({ width: 16, height: 16, photometric: 1, compression, rows: 4 }, new Array(256).fill(9));
    enlarge(file);
    const before = process.memoryUsage().arrayBuffers;
    const started = performance.now();
    assert.throws(() => decodeTiff(file, 0), (e: unknown) => e instanceof DecodeError && /far too little data for a picture of 16384 × 16384/.test(e.message), `compression ${compression}`);
    assert.ok(performance.now() - started < 200, `compression ${compression}: took ${Math.round(performance.now() - started)} ms`);
    assert.ok(process.memoryUsage().arrayBuffers - before < 16 << 20, `compression ${compression}: memory was allocated`);
  }
  // The fax codings have no such ratio (a white row is a single bit), but fewer bits than rows is no picture either.
  const fax = tiff({ width: 16, height: 16, bits: 1, photometric: 0 }, new Array(256).fill(0));
  enlarge(fax);
  fax.writeUInt16LE(4, entryOf(fax, 259) + 8);
  fax.writeUInt32LE(32, entryOf(fax, 279) + 8);
  assert.throws(() => decodeTiff(fax, 0), (e: unknown) => e instanceof DecodeError && /far too little data/.test(e.message));
});

test('tiles far larger than the picture, a Deflate strip that unpacks without end, and a JPEG strip that claims another size are stopped', () => {
  // Every tile is allocated whole, so its size is held against the picture's.
  const tiled = tiff({ width: 16, height: 16, photometric: 1, compression: 8, tile: [16, 16] }, new Array(256).fill(9));
  tiled.writeUInt16LE(16384, entryOf(tiled, 322) + 8);
  tiled.writeUInt16LE(16384, entryOf(tiled, 323) + 8);
  let before = process.memoryUsage().arrayBuffers;
  assert.throws(() => decodeTiff(tiled, 0), (e: unknown) => e instanceof DecodeError && /tiles/.test(e.message));
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 << 20, 'a tile was allocated');

  // 64 MB of zeros deflate to 64 KB. The strip belongs to a picture of 256 bytes: unpacking stops there.
  const bomb = zlib.deflateSync(Buffer.alloc(64 << 20), { level: 9 });
  const dir = page({ width: 16, height: 16, photometric: 1, compression: 8 }, new Array(256).fill(9));
  dir.chunks = [bomb];
  before = process.memoryUsage().arrayBuffers;
  const started = performance.now();
  const raster = decodeTiff(tiffFile([dir]), 0);
  assert.ok(performance.now() - started < 200, `took ${Math.round(performance.now() - started)} ms`);
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 << 20, 'the strip was unpacked in full');
  assert.match(raster.warning ?? '', /damaged/);
  assert.ok(raster.data.every((value, i) => value === (i % 4 === 3 ? 255 : 0)));

  // A JPEG strip is decoded at the size its own header states. Start of image, then a frame of 65535 × 65535.
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  const jpeg = page({ width: 16, height: 16, photometric: 1, compression: 1 }, new Array(256).fill(9));
  jpeg.chunks = [frame];
  const jpegFile = tiffFile([jpeg]);
  jpegFile.writeUInt16LE(7, entryOf(jpegFile, 259) + 8);
  before = process.memoryUsage().arrayBuffers;
  assert.throws(() => decodeTiff(jpegFile, 0), (e: unknown) => e instanceof DecodeError && /JPEG strip/.test(e.message));
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 << 20);
});

test('fax data that is no fax data is refused at once, and fax data that goes on after the last row stops there', () => {
  // The bits of an uncompressed black-and-white picture, labelled as each of the three fax codings in turn.
  const noise = random(31).bytes(40_000).map((value) => value & 1);
  for (const compression of [2, 3, 4]) {
    const file = tiff({ width: 200, height: 200, bits: 1, photometric: 0 }, noise);
    file.writeUInt16LE(compression, entryOf(file, 259) + 8);
    const started = performance.now();
    assert.throws(() => decodeTiff(file, 0), (e: unknown) => e instanceof DecodeError && /fax data is not valid/.test(e.message), `compression ${compression}`);
    assert.ok(performance.now() - started < 300, `compression ${compression}: took ${Math.round(performance.now() - started)} ms`);
  }
  // In Group 4 a single 1 bit is "this row is like the one above": 100 kilobytes of them are 800,000 white rows.
  // The picture has 64, and that is where decoding ends.
  const rows = page({ width: 64, height: 64, bits: 1, photometric: 0 }, new Array(64 * 64).fill(0));
  rows.chunks = [Buffer.alloc(100_000, 0xff)];
  const endless = tiffFile([rows]);
  endless.writeUInt16LE(4, entryOf(endless, 259) + 8);
  const started = performance.now();
  const raster = decodeTiff(endless, 0);
  assert.ok(performance.now() - started < 300, `took ${Math.round(performance.now() - started)} ms`);
  assert.ok(raster.data.every((value) => value === 255), 'a white picture');
  // A fax coding on a picture that is not black and white is a mislabelled file.
  const gray = tiff({ width: 16, height: 16, photometric: 1 }, new Array(256).fill(9));
  gray.writeUInt16LE(4, entryOf(gray, 259) + 8);
  assert.throws(() => decodeTiff(gray, 0), (e: unknown) => e instanceof DecodeError && /not black and white/.test(e.message));
});

/** Raises the size tags of a little-endian file to the largest picture a canvas takes. */
function enlarge(file: Buffer): void {
  file.writeUInt32LE(16384, entryOf(file, 256) + 8);
  file.writeUInt32LE(16384, entryOf(file, 257) + 8);
}

test('a picture of one color, which packs as far as a format allows, is not mistaken for such a file', () => {
  // PackBits at its limit exactly: 128 equal bytes from two. Deflate and LZW close to theirs.
  for (const [compression, side] of [[32773, 512], [8, 1024], [5, 1024]] as const) {
    const values = new Uint8Array(side * side).fill(77);
    const file = tiff({ width: side, height: side, photometric: 1, compression }, values);
    const [listed] = listTiff(file);
    assert.ok(side * side > listed.dataBytes * 60, `compression ${compression}: packed ${side * side} bytes into ${listed.dataBytes}`);
    const raster = decodeTiff(file, 0);
    assert.equal(raster.warning, undefined);
    assert.ok(raster.data.every((value, i) => value === (i % 4 === 3 ? 255 : 77)), `compression ${compression}`);
  }
});

// ---- The LZW unpacker --------------------------------------------------------------

test('the LZW unpacker writes what it is asked for and no more, and says how much it wrote', () => {
  const data = random(21).bytes(5000).map((value) => value & 7);
  const packed = lzw(data);
  const whole = new Uint8Array(5000);
  assert.equal(unpackLzw(packed, 0, packed.length, whole, 0, 5000), 5000);
  assert.equal(Buffer.compare(whole, data), 0);
  // A window in the middle of a larger buffer: nothing outside it is touched.
  const framed = new Uint8Array(1200).fill(255);
  assert.equal(unpackLzw(packed, 0, packed.length, framed, 100, 1100), 1000);
  assert.equal(Buffer.compare(framed.subarray(100, 1100), data.subarray(0, 1000)), 0);
  assert.ok(framed.subarray(0, 100).every((value) => value === 255) && framed.subarray(1100).every((value) => value === 255));
  // Input that stops early gives what was there.
  const cut = new Uint8Array(5000);
  const got = unpackLzw(packed, 0, packed.length >> 1, cut, 0, 5000);
  assert.ok(got > 0 && got < 5000);
  assert.equal(Buffer.compare(cut.subarray(0, got), data.subarray(0, got)), 0);
  // A string that repeats its own first byte ("a", then "aa", "aaa"…) uses each code right as it is defined.
  const run = new Uint8Array(3000).fill(5);
  const packedRun = lzw(run);
  const unpackedRun = new Uint8Array(3000);
  assert.equal(unpackLzw(packedRun, 0, packedRun.length, unpackedRun, 0, 3000), 3000);
  assert.equal(Buffer.compare(unpackedRun, run), 0);
});

test('the LZW unpacker stops at codes that were never defined instead of following them', () => {
  const out = new Uint8Array(64);
  // Clear, the byte 7, then a code far past the table: one byte comes out.
  assert.equal(unpackLzw(ENDLESS_LZW, 0, ENDLESS_LZW.length, out, 0, 64), 1);
  assert.equal(out[0], 7);
  // A code right after a clear has to be a plain byte.
  assert.equal(unpackLzw(Buffer.from([0x80, 0x60, 0x40]), 0, 3, out, 0, 64), 0);
  // Nothing, and bytes that are no LZW at all.
  assert.equal(unpackLzw(Buffer.alloc(0), 0, 0, out, 0, 64), 0);
  const noise = random(22);
  for (let round = 0; round < 300; round++) {
    const bytes = noise.bytes(1 + noise.int(400));
    bytes[0] |= 0x80;
    const written = unpackLzw(bytes, 0, bytes.length, new Uint8Array(4096), 0, 4096);
    assert.ok(written >= 0 && written <= 4096);
  }
});

test('the LZW of TIFF 5 and older, which starts 00 01, is refused by name', () => {
  assert.throws(() => unpackLzw(Buffer.from([0x00, 0x01, 0x40, 0x20]), 0, 4, new Uint8Array(8), 0, 8), (e: unknown) => e instanceof DecodeError && /old-style LZW/.test(e.message));
});

// ---- LZW that is not LZW: decoded in a process of its own -------------------------

/**
 * Clear, the byte 7, then twice a code that was never defined. UTIF's own LZW unpacker never returns from
 * these six bytes, which is why src/ has one of its own.
 */
const ENDLESS_LZW = Buffer.from('8001e0703808', 'hex');

test('LZW data that is cut or scrambled inside its strip gives a picture or a DecodeError', () => {
  const endless = tiff({ width: 4, height: 4, photometric: 1, compression: 5 }, new Array(16).fill(0));
  assert.equal(endless.readUInt32LE(entryOf(endless, 273) + 8), 8);
  ENDLESS_LZW.copy(endless, 8);
  endless.writeUInt32LE(ENDLESS_LZW.length, entryOf(endless, 279) + 8);
  const files = [endless, ...scrambled(5, 13, 60)];
  // A loop that never ends can only be stopped from outside, and this is the test that would meet one again
  // if the unpacker lost its bounds. So this bundle is run once more as a plain script (see the top of the
  // file), given the files, and killed when it stops reporting.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawnSync(process.execPath, [__filename], {
    input: JSON.stringify(files.map((file) => file.toString('base64'))),
    env: { ...env, [CHILD]: '1' },
    timeout: 1000,
    encoding: 'utf8',
  });
  const said = child.stdout.split('\n').filter(Boolean);
  assert.equal(child.error, undefined, `file ${said.length} of ${files.length}: no answer within a second`);
  assert.deepEqual(said.filter((line) => !/^(picture|picture with a warning|refused)$/.test(line)), [], child.stderr);
  assert.equal(said.length, files.length);
  // One byte of sixteen could be unpacked: the picture is shown with the rest empty, and says so.
  assert.equal(said[0], 'picture with a warning');
});
