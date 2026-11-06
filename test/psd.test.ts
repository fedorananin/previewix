import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecodeError, type Raster } from '../src/imageFormats/common';
import { decodePsd, readPsd } from '../src/imageFormats/psd';
import { random } from './helpers';

// Photoshop files written by hand, channel by channel, so the flattened picture a decoder has to hand back
// is known without asking another program. What decides whether a fourth channel is transparency follows
// AGENTS.md ("Image decoding", PSD).

// ---- A PSD writer -----------------------------------------------------------------

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n: number) => Buffer.concat([u32(0), u32(n)]);

interface Psd {
  width: number;
  height: number;
  /** One per channel, each `height` rows of samples as the file stores them (big-endian for 16 and 32 bits). */
  planes: Uint8Array[];
  depth?: number;
  /** 3 (RGB) unless given. */
  mode?: number;
  /** The large document format: version 2, with 64-bit lengths. */
  large?: boolean;
  /** The color table of an indexed picture: 256 reds, 256 greens, 256 blues. */
  palette?: Uint8Array;
  resources?: [id: number, data: Uint8Array][];
  /** The content of the layer and mask section. */
  layers?: Uint8Array;
  /** 0 as it is, 1 PackBits row by row; anything else is written as a code only. */
  compression?: number;
  /** Rows the test packed itself, channel after channel, instead of the packer's. */
  packed?: Buffer[];
}

/** PackBits of one row: a count n < 128 is followed by n + 1 literal bytes, n > 128 repeats the next byte 257 − n times. */
function packRow(row: Uint8Array): Buffer {
  const out: number[] = [];
  for (let at = 0; at < row.length; ) {
    let run = 1;
    while (at + run < row.length && run < 128 && row[at + run] === row[at]) {
      run++;
    }
    if (run > 1) {
      out.push(257 - run, row[at]);
      at += run;
      continue;
    }
    const start = at;
    while (at < row.length && at - start < 128 && !(at + 1 < row.length && row[at + 1] === row[at])) {
      at++;
    }
    out.push(at - start - 1, ...row.subarray(start, at));
  }
  return Buffer.from(out);
}

function psd(spec: Psd): Buffer {
  const { width, height, planes } = spec;
  const depth = spec.depth ?? 8;
  const size = spec.large ? u64 : u32;
  const resources = Buffer.concat(
    (spec.resources ?? []).map(([id, data]) =>
      // An empty name: its length byte and one byte of padding.
      Buffer.concat([Buffer.from('8BIM'), u16(id), u16(0), u32(data.length), data, Buffer.alloc(data.length & 1)]),
    ),
  );
  const layers = spec.layers ?? new Uint8Array(0);
  const compression = spec.compression ?? 0;
  let picture: Buffer[] = planes.map((plane) => Buffer.from(plane));
  if (compression === 1) {
    const rowBytes = planes[0].length / height;
    const rows = spec.packed ?? planes.flatMap((plane) => Array.from({ length: height }, (_, y) => packRow(plane.subarray(y * rowBytes, (y + 1) * rowBytes))));
    // The packed length of every row of every channel, then the rows.
    picture = [...rows.map((row) => (spec.large ? u32 : u16)(row.length)), ...rows];
  }
  return Buffer.concat([
    Buffer.from('8BPS'),
    u16(spec.large ? 2 : 1),
    Buffer.alloc(6),
    u16(planes.length),
    u32(height),
    u32(width),
    u16(depth),
    u16(spec.mode ?? 3),
    u32(spec.palette?.length ?? 0),
    spec.palette ?? Buffer.alloc(0),
    u32(resources.length),
    resources,
    size(layers.length),
    layers,
    u16(compression),
    ...picture,
  ]);
}

/** A layer section that only says how many layers there are. A negative count is Photoshop's "the merged picture has transparency". */
const layerCount = (count: number, large = false) => Buffer.concat([(large ? u64 : u32)(2), u16(count)]);

/** The layer section of a 16- or 32-bit document: both plain parts empty, then tagged blocks with what they would have held. */
function taggedLayers(blocks: [key: string, data: Uint8Array][], large = false): Buffer {
  return Buffer.concat([(large ? u64 : u32)(0), u32(0), ...blocks.flatMap(([key, data]) => [Buffer.from('8BIM'), Buffer.from(key), (large ? u64 : u32)(data.length), data])]);
}

const W = 9;
const H = 7;
const rnd = random(21);
const plane = () => rnd.bytes(W * H);
const [R, G, B, A] = [plane(), plane(), plane(), plane()];

/** RGBA from planes of 8 bits, or from a function of the pixel's index. */
function rgba(r: ArrayLike<number>, g: ArrayLike<number>, b: ArrayLike<number>, a?: ArrayLike<number>): number[] {
  return Array.from({ length: r.length }, (_, i) => [r[i], g[i], b[i], a ? a[i] : 255]).flat();
}

/** Compares pixel by pixel and names the first one that is wrong. Colors under an alpha of 0 mean nothing and are not compared. */
function assertPixels(raster: Raster, width: number, height: number, expected: number[], tolerance = 0): void {
  assert.deepEqual([raster.width, raster.height], [width, height]);
  assert.equal(raster.data.length, width * height * 4);
  assert.equal(expected.length, raster.data.length);
  for (let i = 0; i < expected.length; i += 4) {
    const got = Array.from(raster.data.subarray(i, i + 4));
    const want = expected.slice(i, i + 4);
    const hidden = got[3] === 0 && want[3] === 0;
    if (got[3] !== want[3] || (!hidden && got.some((value, c) => Math.abs(value - want[c]) > tolerance))) {
      assert.fail(`pixel ${(i / 4) % width}, ${Math.floor(i / 4 / width)}: got ${got}, expected ${want}`);
    }
  }
}

// ---- The flattened picture --------------------------------------------------------

test('an RGB picture comes out as it went in: raw, packed, and in the large format', () => {
  // A stretch of one value gives PackBits runs beside its literals.
  const r = Uint8Array.from(R);
  r.fill(77, 10, 40);
  for (const spec of [{ compression: 0 }, { compression: 1 }, { compression: 0, large: true }, { compression: 1, large: true }]) {
    const file = psd({ width: W, height: H, planes: [r, G, B], ...spec });
    assert.equal(readPsd(file).large, !!spec.large);
    const raster = decodePsd(file);
    assertPixels(raster, W, H, rgba(r, G, B));
    assert.deepEqual(raster.notes, []);
    assert.equal(raster.warning, undefined);
  }
});

test('rows of 128 and 129 equal bytes, where a PackBits run ends', () => {
  for (const width of [127, 128, 129, 300]) {
    const flat = new Uint8Array(width * 2).fill(200);
    const noisy = rnd.bytes(width * 2);
    const raster = decodePsd(psd({ width, height: 2, planes: [flat, noisy, flat], compression: 1 }));
    assertPixels(raster, width, 2, rgba(flat, noisy, flat));
  }
});

test('a count byte of 128 does nothing, as PackBits defines it', () => {
  // 128, two literals, 128, a run of two: 10 20 30 30.
  const row = Buffer.from([0x80, 0x01, 10, 20, 0x80, 0xff, 30]);
  const raster = decodePsd(psd({ width: 4, height: 1, planes: [Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)], compression: 1, packed: [row, row, row] }));
  assertPixels(raster, 4, 1, rgba([10, 20, 30, 30], [10, 20, 30, 30], [10, 20, 30, 30]));
});

test('the header is read as it is written', () => {
  const info = readPsd(psd({ width: W, height: H, planes: [R, G, B, A], depth: 8, mode: 3 }));
  assert.deepEqual([info.width, info.height, info.channels, info.depth, info.mode, info.large], [W, H, 4, 8, 3, false]);
  assert.deepEqual([info.layers, info.composite, info.dpi, info.icc, info.exif], [undefined, undefined, undefined, undefined, undefined]);
});

// ---- Which channel is transparency ------------------------------------------------

test('a file without layers: a channel beyond the named selections is its alpha, colors as stored', () => {
  const file = psd({ width: W, height: H, planes: [R, G, B, A], compression: 1 });
  assert.deepEqual([readPsd(file).transparent, readPsd(file).matted, readPsd(file).layers], [true, false, undefined]);
  assertPixels(decodePsd(file), W, H, rgba(R, G, B, A));
});

test('a file without layers: a fourth channel that has a name is a saved selection', () => {
  const names: [number, Uint8Array] = [1006, Buffer.from('\x07Alpha 1', 'latin1')];
  for (const compression of [0, 1]) {
    // Packed, the rows of the channel that is not read still have their lengths in the table in front.
    const selection = psd({ width: W, height: H, planes: [R, G, B, A], resources: [names], compression });
    assert.equal(readPsd(selection).transparent, false);
    assertPixels(decodePsd(selection), W, H, rgba(R, G, B));
  }
  // One name for two extra channels: the first is the alpha, the second the selection.
  const both = psd({ width: W, height: H, planes: [R, G, B, A, plane()], resources: [names] });
  assert.equal(readPsd(both).transparent, true);
  assertPixels(decodePsd(both), W, H, rgba(R, G, B, A));
});

test('a positive layer count: the extra channel is a saved selection', () => {
  const file = psd({ width: W, height: H, planes: [R, G, B, A], layers: layerCount(2) });
  assert.deepEqual([readPsd(file).layers, readPsd(file).transparent], [2, false]);
  assertPixels(decodePsd(file), W, H, rgba(R, G, B));
});

/** Straight colors with every kind of alpha, and what Photoshop and macOS store for them. */
const SEE_THROUGH = (() => {
  const alpha = Uint8Array.from({ length: W * H }, (_, i) => [0, 128, 200, 255][i % 4]);
  const blend = (color: Uint8Array, stored: (c: number, a: number) => number) => Uint8Array.from(color, (c, i) => stored(c, alpha[i]));
  const overWhite = (c: number, a: number) => Math.round((c * a) / 255 + 255 - a);
  const multiplied = (c: number, a: number) => Math.round((c * a) / 255);
  return {
    alpha,
    straight: rgba(R, G, B, alpha),
    overWhite: [R, G, B].map((color) => blend(color, overWhite)),
    multiplied: [R, G, B].map((color) => blend(color, multiplied)),
  };
})();

test('a negative layer count marks transparency, and the white Photoshop blended in is taken out again', () => {
  for (const large of [false, true]) {
    const file = psd({ width: W, height: H, planes: [...SEE_THROUGH.overWhite, SEE_THROUGH.alpha], layers: layerCount(-1, large), large });
    const info = readPsd(file);
    assert.deepEqual([info.layers, info.transparent, info.matted], [1, true, true]);
    // An alpha of 128 leaves half a level of rounding in the stored value, which is one level after un-blending.
    assertPixels(decodePsd(file), W, H, SEE_THROUGH.straight, 1);
  }
});

test('the same structure with colors multiplied by the alpha is told apart by its pixels', () => {
  const file = psd({ width: W, height: H, planes: [...SEE_THROUGH.multiplied, SEE_THROUGH.alpha], layers: layerCount(-3) });
  assert.deepEqual([readPsd(file).layers, readPsd(file).matted], [3, true]);
  assertPixels(decodePsd(file), W, H, SEE_THROUGH.straight, 1);
});

test('16-bit documents say it in tagged blocks: Mt16 for transparency, Lr16 for the layers', () => {
  const wide = (planes8: Uint8Array[]) => planes8.map((p) => Buffer.concat(Array.from(p, (level) => u16(level * 257))));
  const planes = wide([...SEE_THROUGH.overWhite, SEE_THROUGH.alpha]);
  for (const large of [false, true]) {
    const marked = psd({ width: W, height: H, depth: 16, planes, large, layers: taggedLayers([['Mt16', Buffer.alloc(0)], ['Lr16', u16(4)]], large) });
    assert.deepEqual([readPsd(marked).transparent, readPsd(marked).matted, readPsd(marked).layers], [true, true, 4]);
    const raster = decodePsd(marked);
    assertPixels(raster, W, H, SEE_THROUGH.straight, 1);
    assert.deepEqual(raster.notes, [['Depth', '16 bits per channel, shown with 8']]);
    // Layers, but no word about transparency: the channel is a selection.
    const plain = psd({ width: W, height: H, depth: 16, planes, large, layers: taggedLayers([['Lr16', u16(4)]], large) });
    assert.deepEqual([readPsd(plain).transparent, readPsd(plain).layers], [false, 4]);
    assert.equal(decodePsd(plain).data[3], 255);
  }
});

// ---- Modes and depths -------------------------------------------------------------

test('16-bit samples are big-endian and rounded to 8 bits', () => {
  // 0xff00 and 0x00ff tell the two bytes apart; the multiples of 257 are exactly an 8-bit level.
  const values = [0, 65535, 0xff00, 0x00ff, 128 * 257, 1 * 257];
  const wide = Buffer.concat(values.map(u16));
  const raster = decodePsd(psd({ width: 6, height: 1, depth: 16, planes: [wide, wide, wide] }));
  assert.deepEqual(Array.from(raster.data.filter((_, i) => i % 4 === 0)), [0, 255, 254, 1, 128, 1]);
});

test('grayscale and duotone show their one plate', () => {
  const gray = decodePsd(psd({ width: W, height: H, mode: 1, planes: [R], compression: 1 }));
  assertPixels(gray, W, H, rgba(R, R, R));
  const duotone = decodePsd(psd({ width: W, height: H, mode: 8, planes: [R] }));
  assertPixels(duotone, W, H, rgba(R, R, R));
  assert.match(duotone.notes[0][1], /Duotone/);
  const withAlpha = decodePsd(psd({ width: W, height: H, mode: 1, planes: [R, A] }));
  assertPixels(withAlpha, W, H, rgba(R, R, R, A));
});

test('a bitmap has one bit per pixel, set for black, in rows that end on a byte', () => {
  // 10 pixels a row: two bytes, the last six bits unused.
  const bits = [0b10110010, 0b01000000, 0b00000001, 0b10000000];
  const raster = decodePsd(psd({ width: 10, height: 2, depth: 1, mode: 0, planes: [Buffer.from(bits)] }));
  const row = (text: string) => Array.from(text, (bit) => (bit === '1' ? [0, 0, 0, 255] : [255, 255, 255, 255])).flat();
  assertPixels(raster, 10, 2, [...row('1011001001'), ...row('0000000110')]);
});

test('an indexed picture takes its colors from the table, and one index can be see-through', () => {
  const palette = rnd.bytes(768);
  const indexes = Uint8Array.from({ length: W * H }, (_, i) => (i * 5) % 256);
  const expected = rgba(indexes.map((i) => palette[i]), indexes.map((i) => palette[256 + i]), indexes.map((i) => palette[512 + i]));
  assertPixels(decodePsd(psd({ width: W, height: H, mode: 2, palette, planes: [indexes] })), W, H, expected);
  const clear = psd({ width: W, height: H, mode: 2, palette, planes: [indexes], resources: [[1047, u16(10)]] });
  assert.equal(readPsd(clear).transparentIndex, 10);
  const seeThrough = expected.map((value, i) => (i % 4 === 3 && indexes[i >> 2] === 10 ? 0 : value));
  assert.equal(seeThrough.filter((value, i) => i % 4 === 3 && value === 0).length, 1);
  assertPixels(decodePsd(clear), W, H, seeThrough);
  assert.throws(() => decodePsd(psd({ width: W, height: H, mode: 2, planes: [indexes] })), (e: unknown) => e instanceof DecodeError && /color table/.test(e.message));
});

test('CMYK inks are stored inverted and converted with a warning', () => {
  // 255 is no ink. Pixel by pixel: paper, full black, full cyan.
  const c = Buffer.from([255, 255, 0]);
  const m = Buffer.from([255, 255, 255]);
  const y = Buffer.from([255, 255, 255]);
  const k = Buffer.from([255, 0, 255]);
  const raster = decodePsd(psd({ width: 3, height: 1, mode: 4, planes: [c, m, y, k] }));
  assert.deepEqual(Array.from(raster.data.subarray(0, 4)), [255, 255, 255, 255]);
  const black = Array.from(raster.data.subarray(4, 8));
  assert.ok(black[0] < 70 && black[1] < 70 && black[2] < 70 && black[3] === 255, `black ink gave ${black}`);
  assert.ok(raster.data[8] < 80 && raster.data[10] > 180, `cyan ink gave ${Array.from(raster.data.subarray(8, 12))}`);
  assert.match(raster.warning ?? '', /CMYK/);
});

test('Lab: lightness over the whole range, a and b around the middle', () => {
  const raster = decodePsd(psd({ width: 3, height: 1, mode: 9, planes: [Buffer.from([255, 0, 136]), Buffer.from([128, 128, 208]), Buffer.from([128, 128, 98])] }));
  assert.deepEqual(Array.from(raster.data.subarray(0, 8)), [255, 255, 255, 255, 0, 0, 0, 255]);
  // The same color as in the TIFF test, L 53, a +80, b −30: a strong magenta.
  const [r, g, b] = raster.data.subarray(8, 11);
  assert.ok(r > 200 && g < 110 && b > 150, `Lab(53, 80, -30) gave ${[r, g, b]}`);
  assert.deepEqual(raster.notes, [['Color', 'Lab, converted to sRGB']]);
});

test('32-bit samples are linear light: they get the sRGB curve, the alpha does not', () => {
  const floats = (values: number[]) => {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((value, i) => b.writeFloatBE(value, i * 4));
    return b;
  };
  // Linear 0.2140 is the sRGB level 127.5 (0.5 on the encoded scale), and 0.5 is level 188.
  const light = floats([0, 1, 4, 0.5, -1, 0.214]);
  const alpha = floats([0.5, 1, 1, 1, 1, 1]);
  const file = psd({ width: 6, height: 1, depth: 32, planes: [light, light, light, alpha], resources: [[1039, Buffer.from('a profile')]] });
  const raster = decodePsd(file);
  const reds = Array.from(raster.data.filter((_, i) => i % 4 === 0));
  assert.deepEqual([reds[0], reds[1], reds[2], reds[4]], [0, 255, 255, 0]);
  assert.ok(Math.abs(reds[3] - 188) <= 1 && Math.abs(reds[5] - 128) <= 1, `0.5 and 0.214 gave ${reds[3]} and ${reds[5]}`);
  assert.equal(raster.data[3], 128);
  // The profile described the linear values, not what comes out.
  assert.equal(raster.icc, undefined);
  assert.match(raster.notes[0][1], /32 bits per channel/);
});

// ---- Resources --------------------------------------------------------------------

test('resolution, profile and EXIF block are found among the resources', () => {
  const profile = rnd.bytes(201);
  const exif = Buffer.from('II*\0 and so on', 'latin1');
  // 300 and 72.5 pixels per inch as 16.16 fixed point, each followed by its two unit words.
  const resolution = Buffer.concat([u32(300 * 65536), u16(1), u16(1), u32(72.5 * 65536), u16(1), u16(1)]);
  const file = psd({ width: W, height: H, planes: [R, G, B], resources: [[1005, resolution], [1039, profile], [1058, exif], [1036, rnd.bytes(33)]] });
  const info = readPsd(file);
  assert.deepEqual(info.dpi, [300, 72.5]);
  assert.deepEqual(Buffer.from(info.icc ?? []), profile);
  assert.deepEqual(Buffer.from(info.exif ?? []), exif);
  assert.deepEqual(Buffer.from(decodePsd(file).icc ?? []), profile);
  // A profile of a gray picture does not describe the RGB that comes out.
  assert.equal(decodePsd(psd({ width: W, height: H, mode: 1, planes: [R], resources: [[1039, profile]] })).icc, undefined);
});

test('a file saved without its flattened picture is refused with the reason', () => {
  // Resource 1057: version, then the flag "has real merged data".
  const flag = (set: number) => Buffer.concat([u32(1), Buffer.from([set]), Buffer.alloc(24)]);
  const without = psd({ width: W, height: H, planes: [R, G, B], resources: [[1057, flag(0)]], layers: layerCount(3) });
  assert.equal(readPsd(without).composite, false);
  assert.throws(() => decodePsd(without), (e: unknown) => e instanceof DecodeError && /Maximize Compatibility/.test(e.message));
  const withIt = psd({ width: W, height: H, planes: [R, G, B], resources: [[1057, flag(1)]], layers: layerCount(3) });
  assert.equal(readPsd(withIt).composite, true);
  assertPixels(decodePsd(withIt), W, H, rgba(R, G, B));
});

// ---- What is refused --------------------------------------------------------------

test('what is not a Photoshop file, or a kind that is not read, is refused in words', () => {
  const refused = (file: Uint8Array, message: RegExp) => assert.throws(() => decodePsd(file), (e: unknown) => e instanceof DecodeError && message.test(e.message), `${message}`);
  refused(Buffer.from('This is not a picture at all.'), /not a Photoshop file/);
  refused(Buffer.alloc(0), /not a Photoshop file/);
  refused(Buffer.from('8BPS\0\x01'), /not a Photoshop file/);
  const sound = psd({ width: W, height: H, planes: [R, G, B] });
  const patched = (at: number, value: number) => {
    const file = Buffer.from(sound);
    file.writeUInt16BE(value, at);
    return file;
  };
  refused(patched(4, 3), /version 3/);
  refused(patched(4, 0), /version 0/);
  refused(patched(24, 7), /Multichannel/);
  refused(patched(24, 5), /color mode 5/);
  refused(patched(22, 12), /12 bits per channel/);
  refused(patched(22, 1), /1 bits per channel/);
  refused(patched(12, 2), /2 channels/);
  // ZIP, with and without prediction, is what Photoshop never writes for the flattened picture.
  refused(psd({ width: W, height: H, planes: [R, G, B], compression: 2 }), /ZIP/);
  refused(psd({ width: W, height: H, planes: [R, G, B], compression: 3 }), /ZIP/);
  // 32 bits are read for gray and RGB only.
  refused(psd({ width: 1, height: 1, depth: 32, mode: 4, planes: [0, 1, 2, 3].map(() => Buffer.alloc(4)) }), /32 bits per channel/);
});

// ---- Damage -----------------------------------------------------------------------

/** No case may take longer; the files are a few hundred bytes. */
const BUDGET_MS = 1000;

/** The decoder has to answer bytes that may be anything with a picture or a DecodeError, and soon. */
function survive(bytes: Uint8Array, what: string): 'picture' | 'refused' {
  const started = performance.now();
  let outcome: 'picture' | 'refused' = 'picture';
  try {
    const raster = decodePsd(bytes);
    assert.equal(raster.data.length, raster.width * raster.height * 4, what);
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

const RESOURCES: [number, Uint8Array][] = [[1005, Buffer.concat([u32(72 * 65536), u32(0x10001), u32(72 * 65536), u32(0x10001)])], [1006, Buffer.from('\x02ab\x03cde', 'latin1')], [1039, rnd.bytes(40)]];
const SOUND = [0, 1].map((compression) => psd({ width: W, height: H, planes: [R, G, B, A], resources: RESOURCES, layers: layerCount(-1), compression }));
const SOUND_LARGE = psd({ width: W, height: H, depth: 16, planes: [R, G, B, A].map((p) => Buffer.concat([p, p])), large: true, layers: taggedLayers([['Mt16', Buffer.alloc(0)], ['Lr16', u16(1)]], true), compression: 1 });

test('the files the damage tests start from are sound', () => {
  for (const file of [...SOUND, SOUND_LARGE]) {
    assert.equal(survive(file, 'sound'), 'picture');
  }
});

test('a file cut short at any length is refused: the picture is the last thing in it', () => {
  for (const file of [...SOUND, SOUND_LARGE]) {
    for (let length = 0; length < file.length; length++) {
      // A copy of exactly that length: a view into the whole file would let a stray read succeed.
      assert.equal(survive(Uint8Array.from(file.subarray(0, length)), `cut at ${length} of ${file.length}`), 'refused');
    }
  }
});

test('flipped bits in front of the picture give a picture or a DecodeError', () => {
  const flip = random(22);
  for (const file of [...SOUND, SOUND_LARGE]) {
    const front = readPsd(file).imageData + 2 + 4 * H * 4;
    for (let round = 0; round < 200; round++) {
      const damaged = Buffer.from(file);
      for (let n = 1 + flip.int(3); n > 0; n--) {
        damaged[flip.int(Math.min(front, damaged.length))] ^= 1 << flip.int(8);
      }
      survive(damaged, `flip round ${round}`);
    }
  }
});

test('noise behind the header gives a picture or a DecodeError', () => {
  const noise = random(23);
  for (let round = 0; round < 200; round++) {
    // Sometimes only the signature and the version survive, sometimes the whole header with its small sizes.
    const keep = noise.pick([6, 26]);
    survive(Buffer.concat([SOUND[round % 2].subarray(0, keep), noise.bytes(100 + noise.int(600))]), `noise round ${round}`);
  }
});

test('a size no canvas can hold is refused before anything is read', () => {
  for (const [width, height] of [[300000, 300000], [40000, 1], [1, 40000], [20000, 20000], [0, 5], [5, 0]]) {
    const file = Buffer.from(SOUND[0]);
    file.writeUInt32BE(height, 14);
    file.writeUInt32BE(width, 18);
    const started = performance.now();
    assert.throws(() => decodePsd(file), DecodeError);
    assert.ok(performance.now() - started < 250, 'refused without work');
  }
});

test('a small file that claims a large picture is refused without the memory being taken first', () => {
  // 16000 × 16000 fits a canvas; a file of a kilobyte can't hold it, raw or packed.
  for (const sound of SOUND) {
    const file = Buffer.from(sound);
    file.writeUInt32BE(16000, 14);
    file.writeUInt32BE(16000, 18);
    const before = process.memoryUsage().arrayBuffers;
    const started = performance.now();
    assert.throws(() => decodePsd(file), (e: unknown) => e instanceof DecodeError && /damaged or cut short/.test(e.message));
    assert.ok(performance.now() - started < 250, 'refused without work');
    assert.ok(process.memoryUsage().arrayBuffers - before < 64 << 20, 'no plane was allocated');
    // Long enough for the table of row lengths a packed picture of that size starts with, and for nothing else:
    // PackBits makes 128 bytes of two at the most, so the planes can't be in there.
    const padded = Buffer.concat([file, Buffer.alloc(300_000)]);
    const beforePadded = process.memoryUsage().arrayBuffers;
    assert.throws(() => decodePsd(padded), (e: unknown) => e instanceof DecodeError && /damaged or cut short/.test(e.message));
    assert.ok(process.memoryUsage().arrayBuffers - beforePadded < 64 << 20, 'no plane was allocated for the padded file');
  }
});

test('sections that claim to be longer than the file are refused', () => {
  // The three length fields in front of the picture: color table, resources, layers.
  const lengths = [26, 30, 30 + 4 + SOUND[0].readUInt32BE(30)];
  for (const at of lengths) {
    for (const value of [0xffffffff, 0x7fffffff, SOUND[0].length]) {
      const file = Buffer.from(SOUND[0]);
      file.writeUInt32BE(value, at);
      assert.equal(survive(file, `length at ${at}`), 'refused');
    }
  }
  // A resource that runs over the end of its section ends the list; the picture is still there.
  const file = Buffer.from(SOUND[0]);
  const firstResource = 34;
  file.writeUInt32BE(0xffffff00, firstResource + 8);
  assert.equal(readPsd(file).dpi, undefined);
  assert.equal(survive(file, 'resource overrun'), 'picture');
});

test('packed rows that are cut or scrambled give a picture or a DecodeError', () => {
  const scramble = random(24);
  const sound = SOUND[1];
  const table = readPsd(sound).imageData + 2;
  for (let round = 0; round < 200; round++) {
    const file = Buffer.from(sound);
    for (let n = 1 + scramble.int(4); n > 0; n--) {
      // The table of row lengths and the rows alike.
      file[table + scramble.int(file.length - table)] = scramble.int(256);
    }
    survive(file, `scramble round ${round}`);
  }
});
