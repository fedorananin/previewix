import * as fs from 'fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zlib from 'zlib';
import { type ImageMeta, readImageMeta } from '../src/imageMeta';
import { fixture, random } from './helpers';

// What the info panel says about a picture. Every file is built here from the values the panel then has to
// show; none of them holds a picture that could be decoded, because nothing in imageMeta.ts decodes one.

const latin = (text: string) => Buffer.from(text, 'latin1');
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
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
const u24le = (n: number) => u32le(n).subarray(0, 3);

/** The rows of one section by label; empty when the section is not there. */
const rows = (meta: ImageMeta, title: string): Record<string, string> => Object.fromEntries(meta.sections.find((section) => section.title === title)?.rows ?? []);
const file = async (bytes: Uint8Array) => rows(await readImageMeta(bytes), 'File');

// ---- A TIFF structure, as EXIF blocks and TIFF files are made of ------------------

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const UNDEFINED = 7;
const SRATIONAL = 10;

/** A tag with its values: a text for ASCII, numerator and denominator in turn for the rationals. */
type Entry = [tag: number, type: number, values: number[] | string | Uint8Array];

/**
 * Directories with their values, big-endian. As `exif`, the first is the main one and points at the second
 * (EXIF) and the third (GPS); as `pages`, each is linked to the next, as the pages of a TIFF file are.
 */
function tiffData(directories: Entry[][], how: 'exif' | 'pages' = 'exif'): Buffer {
  const encode = ([, type, values]: Entry) =>
    typeof values === 'string' ? latin(`${values}\0`) : type === SHORT ? Buffer.concat(Array.from(values, u16)) : type === LONG || type === RATIONAL || type === SRATIONAL ? Buffer.concat(Array.from(values, u32)) : Buffer.from(values);
  const unit = (type: number) => (type === SHORT ? 2 : type === LONG ? 4 : type === RATIONAL || type === SRATIONAL ? 8 : 1);
  const even = (raw: Buffer) => raw.length + (raw.length & 1);
  // Each directory is followed by the values that don't fit into its entries, so its size says where the next one starts.
  const pointers = (i: number) => (how === 'exif' && i === 0 ? directories.length - 1 : 0);
  const starts: number[] = [];
  let pos = 8;
  directories.forEach((entries, i) => {
    starts.push(pos);
    pos += 2 + (entries.length + pointers(i)) * 12 + 4 + entries.map(encode).reduce((sum, raw) => sum + (raw.length > 4 ? even(raw) : 0), 0);
  });
  const parts: Buffer[] = [latin('MM'), u16(42), u32(8)];
  directories.forEach((given, i) => {
    const entries: Entry[] = [...given];
    if (pointers(i)) {
      entries.push(...[0x8769, 0x8825].slice(0, pointers(i)).map<Entry>((tag, k) => [tag, LONG, [starts[k + 1]]]));
    }
    entries.sort((a, z) => a[0] - z[0]);
    let outside = starts[i] + 2 + entries.length * 12 + 4;
    const values: Buffer[] = [];
    parts.push(u16(entries.length));
    for (const entry of entries) {
      const raw = encode(entry);
      let field = Buffer.concat([raw, Buffer.alloc(4)]).subarray(0, 4);
      if (raw.length > 4) {
        field = u32(outside);
        values.push(raw, Buffer.alloc(raw.length & 1));
        outside += even(raw);
      }
      parts.push(u16(entry[0]), u16(entry[1]), u32(raw.length / unit(entry[1])), field);
    }
    parts.push(u32(how === 'pages' && i + 1 < directories.length ? starts[i + 1] : 0), ...values);
  });
  return Buffer.concat(parts);
}

/** Degrees, minutes and seconds (to a hundredth) as the three rationals of a GPS tag. */
const dms = (degrees: number, minutes: number, seconds: number) => [degrees, 1, minutes, 1, Math.round(seconds * 100), 100];

const CAMERA: Entry[] = [
  [0x010e, ASCII, 'Harbour at dawn'],
  [0x010f, ASCII, 'ACME'],
  [0x0110, ASCII, 'Roadrunner 3'],
  [0x0131, ASCII, 'Darkroom 1.2'],
  [0x0132, ASCII, '2024:05:07 10:11:12'],
  [0x013b, ASCII, 'Jane Doe'],
  [0x8298, ASCII, '(c) Jane'],
];
const EXPOSURE: Entry[] = [
  [0x829a, RATIONAL, [1, 250]],
  [0x829d, RATIONAL, [28, 10]],
  [0x8822, SHORT, [3]],
  [0x8827, SHORT, [100]],
  [0x9003, ASCII, '2024:05:06 07:08:09'],
  [0x9004, ASCII, '2024:05:06 07:08:10'],
  [0x9011, ASCII, '+02:00'],
  [0x9204, SRATIONAL, [-2, 3]],
  [0x920a, RATIONAL, [35, 1]],
  [0xa001, SHORT, [1]],
  [0xa405, SHORT, [52]],
  [0xa433, ASCII, 'LensCo'],
  [0xa434, ASCII, '35mm F1.4'],
];
/** The Eiffel tower: 48°51′29.6″ N, 2°17′40.2″ E. */
const PARIS: Entry[] = [
  [1, ASCII, 'N'],
  [2, RATIONAL, dms(48, 51, 29.6)],
  [3, ASCII, 'E'],
  [4, RATIONAL, dms(2, 17, 40.2)],
];

// ---- JPEG -------------------------------------------------------------------------

const segment = (marker: number, data: Uint8Array) => Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]);

interface Jpeg {
  width: number;
  height: number;
  /** The start-of-frame marker: 0xc0 baseline, 0xc2 progressive, and so on. */
  frame?: number;
  components?: number;
  /** JFIF density: unit (0 none, 1 per inch, 2 per centimetre), then x and y. */
  density?: [number, number, number];
  exif?: Uint8Array;
  /** Segments between the metadata and the frame header. */
  more?: Buffer[];
}

function jpeg(spec: Jpeg): Buffer {
  const components = spec.components ?? 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(spec.density ? [segment(0xe0, Buffer.concat([latin('JFIF\0'), Buffer.from([1, 2, spec.density[0]]), u16(spec.density[1]), u16(spec.density[2]), Buffer.alloc(2)]))] : []),
    ...(spec.exif ? [segment(0xe1, Buffer.concat([latin('Exif\0\0'), spec.exif]))] : []),
    segment(0xdb, Buffer.alloc(65)),
    ...(spec.more ?? []),
    segment(spec.frame ?? 0xc0, Buffer.concat([Buffer.from([8]), u16(spec.height), u16(spec.width), Buffer.from([components]), Buffer.alloc(components * 3)])),
    segment(0xda, Buffer.alloc(10)),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}

const PHOTO = jpeg({ width: 4000, height: 3000, density: [1, 72, 72], exif: tiffData([[...CAMERA, [0x0112, SHORT, [6]], [0x011a, RATIONAL, [300, 1]], [0x011b, RATIONAL, [300, 1]], [0x0128, SHORT, [2]]], EXPOSURE, PARIS]) });

test('JPEG: the frame header gives size, depth, color type and the kind of compression', async () => {
  assert.deepEqual(await file(jpeg({ width: 4000, height: 3000 })), {
    Format: 'JPEG',
    Size: '108 B',
    Dimensions: '4000 × 3000 px (12 MP)',
    'Bit depth': '8 bits per channel',
    'Color type': 'YCbCr',
    Compression: 'Baseline',
  });
  for (const [frame, components, compression, color] of [
    [0xc1, 1, 'Extended sequential', 'Grayscale'],
    [0xc2, 4, 'Progressive', 'CMYK'],
    [0xc3, 3, 'Lossless', 'YCbCr'],
    [0xc9, 3, 'Arithmetic coding', 'YCbCr'],
  ] as const) {
    const said = await file(jpeg({ width: 30, height: 20, frame, components }));
    assert.deepEqual([said.Compression, said['Color type'], said.Dimensions], [compression, color, '30 × 20 px']);
  }
});

test('JPEG: a Huffman table in front of the frame header is not taken for one, and fill bytes are stepped over', async () => {
  // 0xc4 lies in the range of the frame markers, and its content here would read as 0x1111 × 0x2222.
  const table = segment(0xc4, Buffer.from([8, 0x22, 0x22, 0x11, 0x11, 3, 0, 0, 0]));
  const said = await file(jpeg({ width: 640, height: 480, more: [table, Buffer.from([0xff, 0xff, 0xff])] }));
  assert.equal(said.Dimensions, '640 × 480 px (0.3 MP)');
});

test('JPEG: the JFIF density is the resolution, per inch or per centimetre', async () => {
  assert.equal((await file(jpeg({ width: 8, height: 8, density: [1, 72, 72] }))).Resolution, '72 DPI');
  assert.equal((await file(jpeg({ width: 8, height: 8, density: [2, 100, 50] }))).Resolution, '254 × 127 DPI');
  // Unit 0 gives the shape of a pixel, not a resolution.
  assert.equal((await file(jpeg({ width: 8, height: 8, density: [0, 1, 1] }))).Resolution, undefined);
});

test('JPEG: an EXIF orientation that turns the picture swaps the reported sides', async () => {
  const cases: [number, string, string | undefined][] = [
    [1, '400 × 300 px (0.1 MP)', undefined],
    [2, '400 × 300 px (0.1 MP)', 'Mirror horizontal'],
    [3, '400 × 300 px (0.1 MP)', 'Rotate 180'],
    [4, '400 × 300 px (0.1 MP)', 'Mirror vertical'],
    [5, '300 × 400 px (0.1 MP)', 'Mirror horizontal and rotate 270 CW'],
    [6, '300 × 400 px (0.1 MP)', 'Rotate 90 CW'],
    [7, '300 × 400 px (0.1 MP)', 'Mirror horizontal and rotate 90 CW'],
    [8, '300 × 400 px (0.1 MP)', 'Rotate 270 CW'],
  ];
  for (const [orientation, dimensions, label] of cases) {
    const said = await file(jpeg({ width: 400, height: 300, exif: tiffData([[[0x0112, SHORT, [orientation]]]]) }));
    assert.deepEqual([said.Dimensions, said.Orientation], [dimensions, label], `orientation ${orientation}`);
  }
});

test('JPEG: the EXIF resolution wins over the JFIF one, and centimetres are converted', async () => {
  const inch = tiffData([[[0x011a, RATIONAL, [300, 1]], [0x011b, RATIONAL, [600, 2]], [0x0128, SHORT, [2]]]]);
  assert.equal((await file(jpeg({ width: 8, height: 8, density: [1, 72, 72], exif: inch }))).Resolution, '300 DPI');
  const cm = tiffData([[[0x011a, RATIONAL, [100, 1]], [0x011b, RATIONAL, [200, 1]], [0x0128, SHORT, [3]]]]);
  assert.equal((await file(jpeg({ width: 8, height: 8, exif: cm }))).Resolution, '254 × 508 DPI');
});

test('JPEG: camera, exposure, dates and the rest are shown as a photographer writes them', async () => {
  const meta = await readImageMeta(PHOTO);
  assert.deepEqual(meta.sections.map((section) => section.title), ['File', 'Camera', 'Exposure', 'Dates', 'GPS', 'Color', 'Other']);
  assert.deepEqual(rows(meta, 'File'), {
    Format: 'JPEG',
    Size: `${PHOTO.length} B`,
    Dimensions: '3000 × 4000 px (12 MP)',
    'Bit depth': '8 bits per channel',
    'Color type': 'YCbCr',
    Resolution: '300 DPI',
    Orientation: 'Rotate 90 CW',
    Compression: 'Baseline',
  });
  assert.deepEqual(rows(meta, 'Camera'), { Make: 'ACME', Model: 'Roadrunner 3', Lens: 'LensCo 35mm F1.4', Software: 'Darkroom 1.2' });
  assert.deepEqual(rows(meta, 'Exposure'), {
    Shutter: '1/250 s',
    Aperture: 'f/2.8',
    ISO: '100',
    'Focal length': '35 mm (52 mm in 35 mm equivalent)',
    Compensation: '−0.67 EV',
    Program: 'Aperture priority',
  });
  // The digits of the file, whatever the time zone of this machine; the offset only where the file states one.
  assert.deepEqual(rows(meta, 'Dates'), { Taken: '2024-05-06 07:08:09 +02:00', Digitized: '2024-05-06 07:08:10', Modified: '2024-05-07 10:11:12' });
  assert.deepEqual(rows(meta, 'Color'), { 'Color space': 'sRGB' });
  assert.deepEqual(rows(meta, 'Other'), { Description: 'Harbour at dawn', Author: 'Jane Doe', Copyright: '(c) Jane' });
});

test('JPEG: the same moment three times over is shown once', async () => {
  const stamp = '2023:12:31 23:59:58';
  const meta = await readImageMeta(jpeg({ width: 8, height: 8, exif: tiffData([[[0x0132, ASCII, stamp]], [[0x9003, ASCII, stamp], [0x9004, ASCII, stamp]]]) }));
  assert.deepEqual(rows(meta, 'Dates'), { Taken: '2023-12-31 23:59:58' });
});

test('JPEG: long exposures are decimals, short ones fractions; a compensation of zero is not shown', async () => {
  const exposure = async (time: [number, number], bias: [number, number]) =>
    rows(await readImageMeta(jpeg({ width: 8, height: 8, exif: tiffData([[], [[0x829a, RATIONAL, time], [0x9204, SRATIONAL, bias]]]) })), 'Exposure');
  assert.deepEqual(await exposure([1, 8000], [0, 1]), { Shutter: '1/8000 s' });
  assert.deepEqual(await exposure([5, 2], [1, 3]), { Shutter: '2.5 s', Compensation: '+0.33 EV' });
  assert.deepEqual(await exposure([30, 1], [-1, 1]), { Shutter: '30 s', Compensation: '−1 EV' });
});

// ---- GPS --------------------------------------------------------------------------

const located = (gps: Entry[]) => readImageMeta(jpeg({ width: 8, height: 8, exif: tiffData([[], [], gps]) }));

test('GPS: the place is returned in decimal degrees beside the rows, for the provider to keep', async () => {
  const meta = await readImageMeta(PHOTO);
  assert.ok(meta.gps);
  assert.ok(Math.abs(meta.gps.lat - (48 + 51 / 60 + 29.6 / 3600)) < 1e-9, String(meta.gps.lat));
  assert.ok(Math.abs(meta.gps.lon - (2 + 17 / 60 + 40.2 / 3600)) < 1e-9, String(meta.gps.lon));
  assert.deepEqual(rows(meta, 'GPS'), { Coordinates: '48°51′29.6″ N, 2°17′40.2″ E', Decimal: '48.858222, 2.294500' });
});

test('GPS: south and west are negative', async () => {
  // Rio de Janeiro: 22°54′24.5″ S, 43°10′22.4″ W, 7.5 m up, looking east.
  const meta = await located([[1, ASCII, 'S'], [2, RATIONAL, dms(22, 54, 24.5)], [3, ASCII, 'W'], [4, RATIONAL, dms(43, 10, 22.4)], [5, 1, [0]], [6, RATIONAL, [75, 10]], [0x11, RATIONAL, [90, 1]]]);
  assert.ok(meta.gps && Math.abs(meta.gps.lat + (22 + 54 / 60 + 24.5 / 3600)) < 1e-9 && Math.abs(meta.gps.lon + (43 + 10 / 60 + 22.4 / 3600)) < 1e-9, JSON.stringify(meta.gps));
  assert.deepEqual(rows(meta, 'GPS'), {
    Coordinates: '22°54′24.5″ S, 43°10′22.4″ W',
    Decimal: '-22.906806, -43.172889',
    Altitude: '7.5 m above sea level',
    Direction: '90°',
  });
});

test('GPS: an altitude can be below sea level, and seconds that round up carry into the minutes', async () => {
  // The Dead Sea shore, with seconds of 59.96, which is 60.0 at one decimal.
  const meta = await located([[1, ASCII, 'N'], [2, RATIONAL, [31, 1, 29, 1, 5996, 100]], [3, ASCII, 'E'], [4, RATIONAL, [35, 1, 59, 1, 5996, 100]], [5, 1, [1]], [6, RATIONAL, [4305, 10]]]);
  assert.deepEqual(rows(meta, 'GPS'), { Coordinates: '31°30′00.0″ N, 36°00′00.0″ E', Decimal: '31.499989, 35.999989', Altitude: '430.5 m below sea level' });
});

test('GPS: zero-zero, which devices write without a fix, and impossible values are no place', async () => {
  const noFix = await located([[1, ASCII, 'N'], [2, RATIONAL, dms(0, 0, 0)], [3, ASCII, 'E'], [4, RATIONAL, dms(0, 0, 0)], [0x11, RATIONAL, [90, 1]]]);
  assert.equal(noFix.gps, undefined);
  assert.deepEqual(rows(noFix, 'GPS'), {});
  const impossible = await located([[1, ASCII, 'N'], [2, RATIONAL, dms(95, 0, 0)], [3, ASCII, 'E'], [4, RATIONAL, dms(10, 0, 0)]]);
  assert.equal(impossible.gps, undefined);
  // On the equator, east of Greenwich, is a place.
  const equator = await located([[1, ASCII, 'N'], [2, RATIONAL, dms(0, 0, 0)], [3, ASCII, 'E'], [4, RATIONAL, dms(9, 27, 0)]]);
  assert.deepEqual(equator.gps, { lat: 0, lon: 9.45 });
  assert.equal((await readImageMeta(jpeg({ width: 8, height: 8 }))).gps, undefined);
});

// ---- PNG --------------------------------------------------------------------------

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([latin(type), data]);
  return Buffer.concat([u32(data.length), body, u32(zlib.crc32(body))]);
}

/** A PNG of chunks: the header as given (bit depth, color type, …, interlace), then whatever the test adds. */
function png(width: number, height: number, header: number[], chunks: Buffer[] = []): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from(header)])),
    ...chunks,
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const text = (keyword: string, value: string) => pngChunk('tEXt', latin(`${keyword}\0${value}`));
const international = (keyword: string, value: string, language = 'en', translated = '') =>
  pngChunk('iTXt', Buffer.concat([latin(`${keyword}\0\0\0${language}\0`), Buffer.from(`${translated}\0${value}`, 'utf8')]));

test('PNG: the header gives size, depth and color type', async () => {
  const cases: [number[], string, string][] = [
    [[8, 6, 0, 0, 0], '8 bits per channel (32 per pixel)', 'RGB with alpha'],
    [[16, 2, 0, 0, 0], '16 bits per channel (48 per pixel)', 'RGB'],
    [[8, 4, 0, 0, 0], '8 bits per channel (16 per pixel)', 'Grayscale with alpha'],
    [[16, 0, 0, 0, 0], '16 bits per channel', 'Grayscale'],
    [[4, 3, 0, 0, 0], '4-bit palette', 'Palette'],
  ];
  for (const [header, depth, color] of cases) {
    const bytes = png(640, 480, header);
    assert.deepEqual(await file(bytes), { Format: 'PNG', Size: `${bytes.length} B`, Dimensions: '640 × 480 px (0.3 MP)', 'Bit depth': depth, 'Color type': color });
  }
});

test('PNG: megapixels are named from a tenth of one upwards', async () => {
  assert.equal((await file(png(300, 300, [8, 2, 0, 0, 0]))).Dimensions, '300 × 300 px');
  assert.equal((await file(png(400, 250, [8, 2, 0, 0, 0]))).Dimensions, '400 × 250 px (0.1 MP)');
  assert.equal((await file(png(6000, 4000, [8, 2, 0, 0, 0]))).Dimensions, '6000 × 4000 px (24 MP)');
  assert.equal((await file(png(5472, 3648, [8, 2, 0, 0, 0]))).Dimensions, '5472 × 3648 px (20 MP)');
});

test('PNG: interlacing and animation are noted', async () => {
  const said = await file(png(8, 8, [8, 6, 0, 0, 1], [pngChunk('acTL', Buffer.concat([u32(12), u32(0)]))]));
  assert.deepEqual([said.Interlacing, said.Animation], ['Adam7', '12 frames (APNG)']);
  const plain = await file(png(8, 8, [8, 6, 0, 0, 0]));
  assert.deepEqual([plain.Interlacing, plain.Animation], [undefined, undefined]);
});

test('PNG: pixels per metre become DPI; a bare aspect ratio is no resolution', async () => {
  const phys = (x: number, y: number, unit: number) => pngChunk('pHYs', Buffer.concat([u32(x), u32(y), Buffer.from([unit])]));
  // 11811 px/m is 300 DPI, 2835 is 72, 3780 is 96.
  assert.equal((await file(png(8, 8, [8, 2, 0, 0, 0], [phys(11811, 11811, 1)]))).Resolution, '300 DPI');
  assert.equal((await file(png(8, 8, [8, 2, 0, 0, 0], [phys(2835, 3780, 1)]))).Resolution, '72 × 96 DPI');
  assert.equal((await file(png(8, 8, [8, 2, 0, 0, 0], [phys(1, 2, 0)]))).Resolution, undefined);
});

test('PNG: text chunks fill the rows that EXIF would fill in a photo', async () => {
  const bytes = png(8, 8, [8, 2, 0, 0, 0], [
    text('Title', 'Quarterly chart'),
    // tEXt is Latin-1, iTXt is UTF-8 with a language and a translated keyword in front.
    text('Author', 'Jos\xe9 Mu\xf1oz'),
    international('Description', 'Größe und Gewicht ✓', 'de', 'Beschreibung'),
    international('Copyright', '© 2024 Example', '', ''),
    text('Software', 'Paint 9'),
    text('Creation Time', '2024-01-02T03:04:05'),
    text('Comment', 'Hello'),
    text('Unheard-of', 'nothing shows this'),
  ]);
  const meta = await readImageMeta(bytes);
  assert.deepEqual(rows(meta, 'Other'), { Title: 'Quarterly chart', Description: 'Größe und Gewicht ✓', Author: 'José Muñoz', Copyright: '© 2024 Example', Comment: 'Hello' });
  assert.deepEqual(rows(meta, 'Camera'), { Software: 'Paint 9' });
  assert.deepEqual(rows(meta, 'Dates'), { Created: '2024-01-02T03:04:05' });
});

test('PNG: a compressed text chunk in front does not hide the chunks behind it', async () => {
  const zipped = pngChunk('zTXt', Buffer.concat([latin('Comment\0\0'), zlib.deflateSync(latin('zipped'))]));
  const zippedInternational = pngChunk('iTXt', Buffer.concat([latin('Comment\0\x01\0\0\0'), zlib.deflateSync(latin('zipped'))]));
  const meta = await readImageMeta(png(8, 8, [8, 2, 0, 0, 0], [zipped, zippedInternational, text('Title', 'Still here'), pngChunk('pHYs', Buffer.concat([u32(3780), u32(3780), Buffer.from([1])]))]));
  assert.equal(rows(meta, 'Other').Title, 'Still here');
  assert.equal(rows(meta, 'File').Resolution, '96 DPI');
});

test('PNG: compressed text chunks (zTXt, and iTXt with its flag set) are read like the plain ones', async () => {
  const zipped = pngChunk('zTXt', Buffer.concat([latin('Copyright\0\0'), zlib.deflateSync(latin('(c) zipped'))]));
  const zippedInternational = pngChunk('iTXt', Buffer.concat([latin('Title\0\x01\0\0\0'), zlib.deflateSync(Buffer.from('Größe', 'utf8'))]));
  // With a language and a translated keyword in front of the packed text.
  const translated = pngChunk('iTXt', Buffer.concat([latin('Description\0\x01\0de\0'), Buffer.from('Beschreibung\0', 'utf8'), zlib.deflateSync(Buffer.from('Größe und Gewicht ✓', 'utf8'))]));
  const meta = await readImageMeta(png(8, 8, [8, 2, 0, 0, 0], [zipped, zippedInternational, translated]));
  assert.deepEqual(rows(meta, 'Other'), { Title: 'Größe', Description: 'Größe und Gewicht ✓', Copyright: '(c) zipped' });
});

test('PNG: a compressed text chunk that unpacks to more than a megabyte, or is no zlib stream, is passed over', async () => {
  // Sixty megabytes of zeros deflate to sixty kilobytes; unpacked in full, this test would say so by its time and memory.
  const bomb = zlib.deflateSync(Buffer.alloc(60 << 20), { level: 9 });
  assert.ok(bomb.length < 100_000);
  const chunks = [
    pngChunk('zTXt', Buffer.concat([latin('Comment\0\0'), bomb])),
    pngChunk('iTXt', Buffer.concat([latin('Description\0\x01\0\0\0'), bomb])),
    pngChunk('zTXt', Buffer.concat([latin('Copyright\0\0'), latin('this is not deflated')])),
    // A compression method nobody knows.
    pngChunk('zTXt', Buffer.concat([latin('Author\0\x07'), zlib.deflateSync(latin('someone'))])),
    // Just under the limit is read.
    pngChunk('zTXt', Buffer.concat([latin('Title\0\0'), zlib.deflateSync(Buffer.alloc((1 << 20) - 1, 0x78))])),
    text('Software', 'Paint 9'),
  ];
  const before = process.memoryUsage().arrayBuffers;
  const started = performance.now();
  const meta = await readImageMeta(png(8, 8, [8, 2, 0, 0, 0], chunks));
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 << 20, 'the chunk was unpacked');
  assert.deepEqual(Object.keys(rows(meta, 'Other')), ['Title']);
  assert.equal(rows(meta, 'Other').Title.length, (1 << 20) - 1);
  assert.deepEqual(rows(meta, 'Camera'), { Software: 'Paint 9' });
});

test('the size row names bytes, and from a kilobyte on both', async () => {
  const sized = async (extra: number) => {
    const bytes = png(8, 8, [8, 2, 0, 0, 0], [text('Comment', 'x'.repeat(extra))]);
    return [bytes.length, (await file(bytes)).Size] as const;
  };
  const [small, saidSmall] = await sized(100);
  assert.equal(saidSmall, `${small} B`);
  const [medium, saidMedium] = await sized(2472 - small + 100);
  assert.deepEqual([medium, saidMedium], [2472, '2.4 KB (2,472 bytes)']);
  const [large, saidLarge] = await sized(3 * 1024 * 1024 - small + 100);
  assert.deepEqual([large, saidLarge], [3145728, '3.00 MB (3,145,728 bytes)']);
});

// ---- WebP -------------------------------------------------------------------------

const riffChunk = (type: string, data: Uint8Array) => Buffer.concat([latin(type), u32le(data.length), data, Buffer.alloc(data.length & 1)]);
function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([latin('WEBP'), ...chunks]);
  return Buffer.concat([latin('RIFF'), u32le(body.length), body]);
}
/** The start of a lossy bitstream: frame tag, start code, then 14 bits of width and of height. */
const vp8 = (width: number, height: number) => riffChunk('VP8 ', Buffer.concat([Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]), u16le(width), u16le(height), Buffer.alloc(11)]));
/** The start of a lossless bitstream: a signature byte, then width − 1 and height − 1 in 14 bits each and the alpha bit. */
const vp8l = (width: number, height: number, alpha: boolean) => riffChunk('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le((width - 1) | ((height - 1) << 14) | (alpha ? 1 << 28 : 0)), Buffer.alloc(8)]));
/** The extended header: flags (0x10 alpha, 0x02 animation), three reserved bytes, the canvas size less one in 24 bits each. */
const vp8x = (width: number, height: number, flags: number) => riffChunk('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]));

/** An ICC profile with nothing in it but a header and a description. */
function profile(name: string): Buffer {
  const description = Buffer.concat([latin('desc'), u32(0), u32(name.length + 1), latin(name), Buffer.alloc(1 + 78)]);
  const header = Buffer.alloc(128);
  header.write('RGB ', 16, 'latin1');
  header.write('acsp', 36, 'latin1');
  const bytes = Buffer.concat([header, u32(1), latin('desc'), u32(144), u32(description.length), description]);
  bytes.writeUInt32BE(bytes.length, 0);
  return bytes;
}

test('WebP: lossy, lossless and extended headers give the size', async () => {
  const lossy = await file(webp(vp8(1920, 1080)));
  assert.deepEqual([lossy.Format, lossy.Dimensions, lossy['Color type'], lossy['Bit depth']], ['WebP (lossy)', '1920 × 1080 px (2.1 MP)', 'RGB', '8 bits per channel']);
  const lossless = await file(webp(vp8l(4000, 16383, true)));
  assert.deepEqual([lossless.Format, lossless.Dimensions, lossless['Color type']], ['WebP (lossless)', '4000 × 16383 px (65.5 MP)', 'RGB with alpha']);
  assert.equal((await file(webp(vp8l(1, 1, false))))['Color type'], 'RGB');
  // With an extended header the canvas is the size, whatever the bitstream behind it says.
  const extended = await file(webp(vp8x(70000, 300, 0x10), vp8(64, 64)));
  assert.deepEqual([extended.Format, extended.Dimensions, extended['Color type'], extended.Animation], ['WebP (lossy)', '70000 × 300 px (21 MP)', 'RGB with alpha', undefined]);
});

test('WebP: an animation is noted, and its kind is that of its frames', async () => {
  const frame = (inner: Buffer) => riffChunk('ANMF', Buffer.concat([Buffer.alloc(16), inner]));
  const said = await file(webp(vp8x(320, 240, 0x02), riffChunk('ANIM', Buffer.alloc(6)), frame(vp8l(320, 240, false)), frame(vp8l(320, 240, false))));
  assert.deepEqual([said.Format, said.Dimensions, said.Animation, said['Color type']], ['WebP (lossless)', '320 × 240 px', 'Yes', 'RGB']);
});

test('WebP: the EXIF chunk is read, with or without the JPEG prefix, and so is the profile', async () => {
  const exif = tiffData([[...CAMERA, [0x0112, SHORT, [8]]], EXPOSURE, PARIS]);
  for (const payload of [exif, Buffer.concat([latin('Exif\0\0'), exif])]) {
    // An odd chunk in front: chunks are padded to even lengths.
    const meta = await readImageMeta(webp(vp8x(800, 600, 0x2c), riffChunk('ICCP', profile('Display P3')), riffChunk('XTRA', Buffer.alloc(5)), vp8(800, 600), riffChunk('EXIF', payload)));
    assert.deepEqual(rows(meta, 'Camera'), { Make: 'ACME', Model: 'Roadrunner 3', Lens: 'LensCo 35mm F1.4', Software: 'Darkroom 1.2' });
    assert.deepEqual([rows(meta, 'File').Dimensions, rows(meta, 'File').Orientation], ['600 × 800 px (0.5 MP)', 'Rotate 270 CW']);
    assert.equal(rows(meta, 'Color').Profile, 'Display P3');
    assert.equal(rows(meta, 'Dates').Taken, '2024-05-06 07:08:09 +02:00');
    assert.ok(meta.gps && Math.abs(meta.gps.lat - 48.858222) < 1e-5);
  }
});

// ---- GIF and BMP ------------------------------------------------------------------

test('GIF: version, size and the depth of the palette', async () => {
  const gif = (version: string, flags: number) => Buffer.concat([latin(`GIF${version}`), u16le(500), u16le(280), Buffer.from([flags, 0, 0]), Buffer.alloc(40)]);
  const said = await file(gif('89a', 0xf7));
  assert.deepEqual([said.Format, said.Dimensions, said['Bit depth'], said['Color type']], ['GIF (89a)', '500 × 280 px (0.1 MP)', '8-bit palette', 'Palette']);
  // Four colors; and no global palette at all, where the depth is not known.
  assert.equal((await file(gif('87a', 0x81)))['Bit depth'], '2-bit palette');
  assert.deepEqual([(await file(gif('87a', 0x07))).Format, (await file(gif('87a', 0x07)))['Bit depth']], ['GIF (87a)', undefined]);
});

test('BMP: size, depth and resolution from the info header', async () => {
  const bmp = (width: number, height: number, bits: number, perMetre: [number, number] = [0, 0]) =>
    Buffer.concat([latin('BM'), u32le(54), u32le(0), u32le(54), u32le(40), u32le(width), u32le(height), u16le(1), u16le(bits), u32le(0), u32le(0), u32le(perMetre[0]), u32le(perMetre[1]), u32le(0), u32le(0)]);
  const plain = await file(bmp(640, 480, 24, [3780, 3780]));
  assert.deepEqual(plain, { Format: 'BMP', Size: '54 B', Dimensions: '640 × 480 px (0.3 MP)', 'Bit depth': '24 bits per pixel', 'Color type': 'RGB', Resolution: '96 DPI' });
  // A negative height only means that the top row comes first.
  const topDown = await file(bmp(320, -200, 32));
  assert.deepEqual([topDown.Dimensions, topDown['Bit depth'], topDown['Color type'], topDown.Resolution], ['320 × 200 px', '32 bits per pixel', 'RGB with alpha', undefined]);
  const indexed = await file(bmp(16, 16, 4));
  assert.deepEqual([indexed['Bit depth'], indexed['Color type']], ['4-bit palette', 'Palette']);
});

// ---- The formats read through src/imageFormats ------------------------------------

test('TIFF: size, depth, color, compression, layout and pages come from the directories', async () => {
  // The strips need not hold anything: they only have to lie inside the file.
  const picture = (width: number, height: number, more: Entry[]): Entry[] => [[256, LONG, [width]], [257, LONG, [height]], [273, LONG, [8]], [279, LONG, [4]], ...more];
  const first = picture(1200, 800, [[258, SHORT, [8, 8, 8, 8]], [259, SHORT, [5]], [262, SHORT, [2]], [277, SHORT, [4]], [338, SHORT, [2]], [282, RATIONAL, [150, 1]], [283, RATIONAL, [150, 1]], [296, SHORT, [2]], [271, ASCII, 'ScanCo'], [34675, UNDEFINED, profile('Wide Gamut RGB')]]);
  const meta = await readImageMeta(tiffData([first, picture(600, 400, [[258, SHORT, [8]]]), picture(1200, 800, [[258, SHORT, [8]]])], 'pages'));
  const said = rows(meta, 'File');
  delete said.Size;
  assert.deepEqual(said, { Format: 'TIFF', Dimensions: '1200 × 800 px (1 MP)', 'Bit depth': '8 bits per channel (32 per pixel)', 'Color type': 'RGB with alpha', Resolution: '150 DPI', Compression: 'LZW', Pages: '3 (1200 × 800, 600 × 400)' });
  assert.equal(rows(meta, 'Camera').Make, 'ScanCo');
  assert.equal(rows(meta, 'Color').Profile, 'Wide Gamut RGB');

  const fax = await file(tiffData([picture(1728, 2200, [[258, SHORT, [1]], [259, SHORT, [4]], [262, SHORT, [0]], [322, SHORT, [256]], [323, SHORT, [256]], [324, LONG, [8]], [325, LONG, [4]]]), picture(1728, 2200, [])], 'pages'));
  assert.deepEqual([fax['Bit depth'], fax['Color type'], fax.Compression, fax.Layout, fax.Pages], ['1 bit per pixel', 'Grayscale (white is zero)', 'CCITT Group 4 (fax)', 'Tiles', '2']);
  // "With alpha" is said of an extra sample that is one: not of a selection, which is marked as unspecified.
  const colorOf = async (samples: number, photometric: number, extra?: number) =>
    (await file(tiffData([picture(10, 10, [[258, SHORT, new Array(samples).fill(8)], [262, SHORT, [photometric]], [277, SHORT, [samples]], ...(extra === undefined ? [] : [[338, SHORT, [extra]] as Entry])])], 'pages')))['Color type'];
  assert.deepEqual([await colorOf(4, 2, 1), await colorOf(4, 2, 0), await colorOf(3, 2), await colorOf(2, 1, 2), await colorOf(5, 5, 0)], ['RGB with alpha', 'RGB', 'RGB', 'Grayscale with alpha', 'CMYK']);
  const single = await file(tiffData([picture(10, 10, [[258, SHORT, [16]], [262, SHORT, [1]], [259, SHORT, [60000]]])], 'pages'));
  assert.deepEqual([single['Bit depth'], single.Compression, single.Pages, single.Layout], ['16 bits per pixel', 'Type 60000', undefined, undefined]);
});

/** A Photoshop file as far as its sections go; the flattened picture behind them is left out. */
function psd(spec: { width: number; height: number; channels: number; depth: number; mode: number; large?: boolean; resources?: [number, Uint8Array][]; layers?: number }): Buffer {
  const resources = Buffer.concat((spec.resources ?? []).map(([id, data]) => Buffer.concat([latin('8BIM'), u16(id), u16(0), u32(data.length), data, Buffer.alloc(data.length & 1)])));
  const layers = spec.layers === undefined ? Buffer.alloc(0) : Buffer.concat([...(spec.large ? [u32(0)] : []), u32(2), u16(spec.layers)]);
  return Buffer.concat([latin('8BPS'), u16(spec.large ? 2 : 1), Buffer.alloc(6), u16(spec.channels), u32(spec.height), u32(spec.width), u16(spec.depth), u16(spec.mode), u32(0), u32(resources.length), resources, ...(spec.large ? [u32(0)] : []), u32(layers.length), layers, u16(0)]);
}

test('PSD: mode, depth, channels and layers, and the EXIF block and profile among its resources', async () => {
  const resolution = Buffer.concat([u32(240 * 65536), u32(0x10001), u32(240 * 65536), u32(0x10001)]);
  const flattened = (set: number) => Buffer.concat([u32(1), Buffer.from([set]), Buffer.alloc(7)]);
  const meta = await readImageMeta(psd({ width: 3000, height: 2000, channels: 4, depth: 16, mode: 3, layers: -5, resources: [[1005, resolution], [1039, profile('ProPhoto RGB')], [1058, tiffData([CAMERA, EXPOSURE, PARIS])], [1057, flattened(0)]] }));
  const said = rows(meta, 'File');
  delete said.Size;
  assert.deepEqual(said, {
    Format: 'Photoshop (PSD)',
    Dimensions: '3000 × 2000 px (6 MP)',
    'Bit depth': '16 bits per channel',
    'Color type': 'RGB with transparency',
    Resolution: '240 DPI',
    Channels: '4',
    Layers: '5 (the flattened picture is shown)',
    'Flattened picture': 'Not saved (Maximize Compatibility off)',
  });
  assert.deepEqual(rows(meta, 'Camera'), { Make: 'ACME', Model: 'Roadrunner 3', Lens: 'LensCo 35mm F1.4', Software: 'Darkroom 1.2' });
  assert.equal(rows(meta, 'Color').Profile, 'ProPhoto RGB');
  assert.ok(meta.gps);

  const large = await file(psd({ width: 100, height: 50, channels: 1, depth: 1, mode: 0, large: true }));
  assert.deepEqual([large.Format, large['Bit depth'], large['Color type'], large.Channels, large.Layers, large['Flattened picture']], ['Photoshop large document (PSB)', '1 bit per pixel', 'Bitmap', '1', undefined, undefined]);
  const cmyk = await file(psd({ width: 100, height: 50, channels: 4, depth: 8, mode: 4, layers: 2 }));
  assert.deepEqual([cmyk['Color type'], cmyk.Layers], ['CMYK', '2 (the flattened picture is shown)']);
});

/** The header of a bitmap inside an icon: 40 bytes, the height counted twice. */
const iconBitmap = (side: number, bits: number) => Buffer.concat([u32le(40), u32le(side), u32le(side * 2), u16le(1), u16le(bits), Buffer.alloc(24 + 8)]);
const pngOf = (width: number, height: number) => png(width, height, [8, 6, 0, 0, 0]);
function ico(type: number, pictures: Buffer[]): Buffer {
  let offset = 6 + pictures.length * 16;
  const records = pictures.map((data) => {
    const record = Buffer.concat([Buffer.alloc(4), u16le(1), u16le(32), u32le(data.length), u32le(offset)]);
    offset += data.length;
    return record;
  });
  return Buffer.concat([u16le(0), u16le(type), u16le(pictures.length), ...records, ...pictures]);
}

test('ICO: the largest picture is the one described, and the sizes are listed', async () => {
  const icon = await file(ico(1, [iconBitmap(16, 32), pngOf(256, 256), iconBitmap(32, 8)]));
  assert.deepEqual([icon.Format, icon.Dimensions, icon['Bit depth'], icon.Sizes], ['Icon (ICO)', '256 × 256 px', '32 bits per pixel', '256 × 256 · 32-bit PNG, 32 × 32 · 8-bit, 16 × 16 · 32-bit']);
  const cursor = await file(ico(2, [iconBitmap(32, 32)]));
  assert.deepEqual([cursor.Format, cursor.Dimensions, cursor.Sizes], ['Cursor (CUR)', '32 × 32 px', undefined]);
});

test('ICNS: the largest picture that can be shown is the one described, with sizes and variants', async () => {
  const entry = (type: string, data: Uint8Array) => Buffer.concat([latin(type), u32(data.length + 8), data]);
  const icns = (...entries: Buffer[]) => Buffer.concat([latin('icns'), u32(8 + entries.reduce((sum, e) => sum + e.length, 0)), ...entries]);
  const jp2 = Buffer.concat([u32(12), latin('jP  '), Buffer.alloc(40)]);
  const said = await file(icns(entry('ic10', jp2), entry('ic09', pngOf(512, 512)), entry('ic11', pngOf(32, 32)), entry('\xfd\xd9\x2f\xa8', icns(entry('ic11', pngOf(32, 32))))));
  assert.deepEqual([said.Format, said.Dimensions, said.Sizes, said.Variants], ['Apple icon (ICNS)', '512 × 512 px (0.3 MP)', '1024 × 1024 (512 pt @2x) · JPEG 2000, 512 × 512, 32 × 32 (16 pt @2x)', 'dark']);
});

// ---- HEIF and AVIF ----------------------------------------------------------------

const box = (type: string, ...content: Uint8Array[]) => Buffer.concat([u32(8 + content.reduce((sum, part) => sum + part.length, 0)), latin(type), ...content]);
const fullBox = (type: string, ...content: Uint8Array[]) => box(type, Buffer.alloc(4), ...content);
const ispe = (width: number, height: number) => fullBox('ispe', u32(width), u32(height));
const irot = (turns: number) => box('irot', Buffer.from([turns]));
const imir = (axis: number) => box('imir', Buffer.from([axis]));
const nclx = (primaries: number, transfer: number) => box('colr', latin('nclx'), u16(primaries), u16(transfer), u16(6), Buffer.from([0x80]));
const hvcC = (bits: number) => {
  const record = Buffer.alloc(23);
  record[17] = 0xf8 | (bits - 8);
  return box('hvcC', record);
};

/**
 * A HEIF file with one picture that is given all `properties`. Without `main`, the box that names the main
 * picture is left out. An EXIF block goes in as an item of its own, as cameras store it.
 */
function heif(brands: string[], type: string, properties: Buffer[], options: { main?: boolean; movie?: boolean; exif?: Uint8Array } = {}): Buffer {
  const ftyp = box('ftyp', latin(brands[0]), u32(0), ...brands.slice(1).map(latin));
  const ipma = fullBox('ipma', u32(1), u16(1), Buffer.from([properties.length, ...properties.map((_, i) => 0x80 | (i + 1))]));
  const infe = (id: number, itemType: string) => box('infe', Buffer.from([2, 0, 0, 0]), u16(id), u16(0), latin(itemType), Buffer.alloc(1));
  // The four bytes in front say how far behind them the TIFF structure starts: here, after "Exif" and two zeros.
  const data = options.exif ? Buffer.concat([u32(6), latin('Exif\0\0'), options.exif]) : Buffer.alloc(32);
  const meta = (dataAt: number) =>
    fullBox(
      'meta',
      fullBox('hdlr', u32(0), latin('pict'), Buffer.alloc(13)),
      ...(options.main === false ? [] : [fullBox('pitm', u16(1))]),
      box('iinf', Buffer.from([0, 0, 0, 0]), u16(options.exif ? 2 : 1), infe(1, type), ...(options.exif ? [infe(2, 'Exif')] : [])),
      // Where the data of item 2 is: offsets and lengths of 4 bytes, one extent.
      ...(options.exif ? [fullBox('iloc', Buffer.from([0x44, 0]), u16(1), u16(2), u16(0), u16(1), u32(dataAt), u32(data.length))] : []),
      box('iprp', box('ipco', ...properties), ipma),
    );
  // `iloc` counts from the start of the file, so the box is laid out once to learn where the data will be.
  const dataAt = ftyp.length + meta(0).length + 8;
  return Buffer.concat([ftyp, meta(dataAt), box('mdat', data), ...(options.movie ? [box('moov', Buffer.alloc(16))] : [])]);
}

test('HEIF: the container turns the picture, so the sides and the orientation come from its boxes', async () => {
  // Quarter turns counter-clockwise in the file; the row uses the clockwise words of EXIF.
  const cases: [number, string, string | undefined][] = [
    [0, '4032 × 3024 px (12.2 MP)', undefined],
    [1, '3024 × 4032 px (12.2 MP)', 'Rotate 270 CW'],
    [2, '4032 × 3024 px (12.2 MP)', 'Rotate 180'],
    [3, '3024 × 4032 px (12.2 MP)', 'Rotate 90 CW'],
  ];
  for (const [turns, dimensions, orientation] of cases) {
    const said = await file(heif(['heic', 'mif1'], 'hvc1', [ispe(4032, 3024), irot(turns), hvcC(8)]));
    assert.deepEqual([said.Format, said.Dimensions, said.Orientation, said['Bit depth']], ['HEIF (heic, HEVC)', dimensions, orientation, '8 bits per channel']);
  }
});

test('HEIF: the EXIF orientation is not applied, because no decoder applies it there', async () => {
  const exif = (orientation: number) => tiffData([[...CAMERA, [0x0112, SHORT, [orientation]]], EXPOSURE]);
  // A file whose EXIF says "turn me" while the container doesn't: it is shown as stored, and described so.
  const exifOnly = await readImageMeta(heif(['heic', 'mif1', 'heic'], 'hvc1', [ispe(4032, 3024), hvcC(8)], { exif: exif(6) }));
  assert.deepEqual([rows(exifOnly, 'File').Dimensions, rows(exifOnly, 'File').Orientation], ['4032 × 3024 px (12.2 MP)', undefined]);
  // The EXIF block was found, all the same.
  assert.deepEqual([rows(exifOnly, 'Camera').Make, rows(exifOnly, 'Exposure').Shutter], ['ACME', '1/250 s']);
  // What a phone writes: both say the same, and the sides are swapped once, not twice.
  const phone = await readImageMeta(heif(['heic', 'mif1', 'heic'], 'hvc1', [ispe(4032, 3024), irot(3), nclx(12, 13), hvcC(8)], { exif: exif(6) }));
  assert.deepEqual([rows(phone, 'File').Dimensions, rows(phone, 'File').Orientation, rows(phone, 'File')['Color primaries'], rows(phone, 'Camera').Model], ['3024 × 4032 px (12.2 MP)', 'Rotate 90 CW', 'Display P3', 'Roadrunner 3']);
  // And when they disagree, the container is right.
  const disagreeing = await readImageMeta(heif(['heic', 'mif1', 'heic'], 'hvc1', [ispe(4032, 3024), irot(2), hvcC(8)], { exif: exif(8) }));
  assert.deepEqual([rows(disagreeing, 'File').Dimensions, rows(disagreeing, 'File').Orientation], ['4032 × 3024 px (12.2 MP)', 'Rotate 180']);
});

test('HEIF: which way the picture is mirrored is named as the decoder does it', async () => {
  // Axis 0 exchanges top and bottom, which EXIF calls "Mirror vertical" (orientation 4); axis 1 exchanges left
  // and right, "Mirror horizontal" (orientation 2). What libheif does with the two is pinned in imageFormats.test.ts.
  const mirrored = async (axis: number) => (await file(heif(['heic'], 'hvc1', [ispe(40, 30), imir(axis)]))).Orientation;
  assert.deepEqual([await mirrored(0), await mirrored(1)], ['Mirror vertical', 'Mirror horizontal']);
});

test('HEIF: a mirrored picture keeps its sides and says that it is mirrored', async () => {
  for (const axis of [0, 1]) {
    const said = await file(heif(['heic'], 'hvc1', [ispe(40, 30), imir(axis)]));
    assert.equal(said.Dimensions, '40 × 30 px');
    assert.match(said.Orientation, /^Mirror (horizontal|vertical)$/);
  }
  const both = await file(heif(['heic'], 'hvc1', [ispe(40, 30), imir(1), irot(1)]));
  assert.equal(both.Dimensions, '30 × 40 px');
  assert.equal(both.Orientation, 'Mirror horizontal and rotate 270 CW');
});

test('HEIF: a mirror and a turn are named together in the words of EXIF, by the order the file applies them', async () => {
  // The properties of an item are applied one after the other, and mirroring before a turn is not mirroring
  // after it. Each chain comes to one of the eight EXIF orientations; libheif applying exactly these is checked
  // against real files outside the suite (AGENTS.md, "Image formats").
  const cases: [Buffer[], string | undefined][] = [
    [[imir(1), irot(1)], 'Mirror horizontal and rotate 270 CW'],
    [[irot(1), imir(1)], 'Mirror horizontal and rotate 90 CW'],
    [[imir(1), irot(3)], 'Mirror horizontal and rotate 90 CW'],
    [[irot(3), imir(1)], 'Mirror horizontal and rotate 270 CW'],
    [[imir(0), irot(1)], 'Mirror horizontal and rotate 90 CW'],
    [[irot(1), imir(0)], 'Mirror horizontal and rotate 270 CW'],
    // Top and bottom exchanged is left and right exchanged plus a half turn.
    [[imir(1), irot(2)], 'Mirror vertical'],
    [[imir(0), irot(2)], 'Mirror horizontal'],
    // What undoes itself says nothing.
    [[imir(1), imir(1)], undefined],
    [[imir(0), imir(1)], 'Rotate 180'],
    [[irot(1), irot(3)], undefined],
  ];
  for (const [chain, orientation] of cases) {
    assert.equal((await file(heif(['heic'], 'hvc1', [ispe(40, 30), ...chain]))).Orientation, orientation, chain.map((b) => `${b.subarray(4, 8)} ${b[8]}`).join(', '));
  }
});

test('HEIF: depth, tiles, wide primaries, HDR and sequences are noted', async () => {
  const wide = await file(heif(['heic', 'mif1'], 'grid', [ispe(8000, 6000), nclx(12, 13), hvcC(10)]));
  assert.deepEqual([wide.Format, wide['Bit depth'], wide['Color primaries']], ['HEIF (heic, tiled)', '10 bits per channel', 'Display P3']);
  assert.equal((await file(heif(['heic'], 'hvc1', [ispe(64, 64), nclx(9, 16)])))['Color primaries'], 'BT.2020, PQ (HDR)');
  assert.equal((await file(heif(['heic'], 'hvc1', [ispe(64, 64), nclx(9, 18)])))['Color primaries'], 'BT.2020, HLG (HDR)');
  assert.equal((await file(heif(['heic'], 'hvc1', [ispe(64, 64), nclx(1, 13)])))['Color primaries'], 'BT.709 / sRGB');
  // Code points that name no known primaries say nothing.
  assert.equal((await file(heif(['heic'], 'hvc1', [ispe(64, 64), nclx(2, 2)])))['Color primaries'], undefined);
  const sequence = await file(heif(['msf1', 'hevc'], 'hvc1', [ispe(64, 64)], { movie: true }));
  assert.deepEqual([sequence.Format, sequence.Sequence], ['HEIF (msf1, HEVC)', 'Yes']);
  const profiled = await readImageMeta(heif(['heic'], 'hvc1', [ispe(64, 64), box('colr', latin('prof'), profile('Display P3')), nclx(9, 16)]));
  assert.equal(rows(profiled, 'Color').Profile, 'Display P3');
});

test('AVIF is named by its brand, wherever in the list it stands', async () => {
  const av1C = box('av1C', Buffer.from([0x81, 0x08, 0x40, 0]));
  for (const brands of [['avif', 'mif1', 'miaf'], ['mif1', 'miaf', 'avif'], ['avis', 'msf1']]) {
    const said = await file(heif(brands, 'av01', [ispe(1280, 720), irot(1), av1C]));
    assert.deepEqual([said.Format, said.Dimensions, said.Orientation, said['Bit depth']], ['AVIF', '720 × 1280 px (0.9 MP)', 'Rotate 270 CW', '10 bits per channel']);
  }
});

test('HEIF: when the boxes can not be followed, the largest stated size is taken', async () => {
  const pixi = fullBox('pixi', Buffer.from([3, 10, 10, 10]));
  const heic = await file(heif(['heic'], 'hvc1', [ispe(160, 120), ispe(4032, 3024), ispe(512, 512), pixi], { main: false }));
  assert.deepEqual([heic.Format, heic.Dimensions, heic['Bit depth'], heic.Orientation], ['HEIF', '4032 × 3024 px (12.2 MP)', '10 bits per channel', undefined]);
  assert.equal((await file(heif(['avif'], 'av01', [ispe(160, 120)], { main: false }))).Format, 'AVIF');
});

test('a real HEIC from macOS is described from its boxes', async () => {
  // How the fixture was made is said where it is decoded, in imageFormats.test.ts.
  const said = await file(fs.readFileSync(fixture('images/quad.heic')));
  assert.deepEqual(said, { Format: 'HEIF (heic, HEVC)', Size: '525 B', Dimensions: '64 × 48 px', 'Bit depth': '8 bits per channel' });
});

// ---- Damage -----------------------------------------------------------------------

test('what is no picture has a size row and nothing else', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([1, 2, 3]), latin('This is not a picture at all.\n'.repeat(40)), random(51).bytes(600)]) {
    const meta = await readImageMeta(bytes);
    assert.deepEqual(meta.sections.map((section) => [section.title, section.rows.map(([label]) => label)]), [['File', ['Size']]]);
    assert.equal(meta.gps, undefined);
  }
});

const SOUND: [string, Buffer][] = [
  ['JPEG', PHOTO],
  ['PNG', png(640, 480, [8, 6, 0, 0, 1], [pngChunk('pHYs', Buffer.concat([u32(3780), u32(3780), Buffer.from([1])])), text('Title', 'A title'), international('Description', 'Größe'), pngChunk('eXIf', tiffData([CAMERA, EXPOSURE, PARIS]))])],
  ['WebP', webp(vp8x(800, 600, 0x2c), riffChunk('ICCP', profile('Display P3')), vp8(800, 600), riffChunk('EXIF', tiffData([CAMERA, EXPOSURE, PARIS])))],
  ['GIF', Buffer.concat([latin('GIF89a'), u16le(500), u16le(280), Buffer.from([0xf7, 0, 0]), Buffer.alloc(40)])],
  ['BMP', Buffer.concat([latin('BM'), u32le(54), u32le(0), u32le(54), u32le(40), u32le(640), u32le(480), u16le(1), u16le(24), Buffer.alloc(24)])],
  ['TIFF', tiffData([[[256, LONG, [1200]], [257, LONG, [800]], [258, SHORT, [8, 8, 8]], [273, LONG, [8]], [279, LONG, [4]], [282, RATIONAL, [150, 1]], [271, ASCII, 'ScanCo']], [[256, LONG, [60]], [257, LONG, [40]]]], 'pages')],
  ['PSD', psd({ width: 300, height: 200, channels: 4, depth: 8, mode: 3, layers: -1, resources: [[1006, latin('\x02ab')], [1039, profile('sRGB')], [1058, tiffData([CAMERA, EXPOSURE, PARIS])]] })],
  ['ICO', ico(1, [iconBitmap(16, 32), pngOf(64, 64)])],
  ['HEIF', heif(['heic', 'mif1'], 'hvc1', [ispe(4032, 3024), irot(1), imir(0), nclx(12, 13), hvcC(10)])],
];

/** No file here is larger than a few kilobytes; a reader that needs longer is stuck. */
const BUDGET_MS = 1500;

/** Reads a damaged file. Whatever is wrong with it, the answer is sections, not an exception. */
async function survive(bytes: Uint8Array, what: string): Promise<void> {
  const started = performance.now();
  let meta: ImageMeta;
  try {
    meta = await readImageMeta(bytes);
  } catch (e) {
    throw new Error(`${what}: threw ${e instanceof Error ? e.stack : e}`);
  }
  const took = performance.now() - started;
  assert.ok(took < BUDGET_MS, `${what}: took ${Math.round(took)} ms`);
  assert.ok(Array.isArray(meta.sections), what);
  for (const section of meta.sections) {
    assert.ok(section.rows.every(([label, value]) => typeof label === 'string' && typeof value === 'string' && value !== ''), `${what}: ${JSON.stringify(section)}`);
  }
}

test('the files the damage tests start from are understood', async () => {
  for (const [format, bytes] of SOUND) {
    const said = await file(bytes);
    assert.ok(said.Format.startsWith(format === 'ICO' ? 'Icon' : format === 'PSD' ? 'Photoshop' : format), `${format}: ${said.Format}`);
    assert.ok(said.Dimensions, format);
  }
});

for (const [format, sound] of SOUND) {
  test(`${format}: cut short at any length, the reader still answers`, async () => {
    // Every length for the first few hundred bytes, where the structure is; then in steps.
    for (let length = 0; length < sound.length; length += length < 400 ? 1 : 7) {
      await survive(Uint8Array.from(sound.subarray(0, length)), `cut at ${length}`);
    }
  });

  test(`${format}: with flipped bits and with noise, the reader still answers`, async () => {
    const damage = random(52);
    for (let round = 0; round < 150; round++) {
      const flipped = Buffer.from(sound);
      for (let n = 1 + damage.int(3); n > 0; n--) {
        flipped[damage.int(flipped.length)] ^= 1 << damage.int(8);
      }
      await survive(flipped, `flip round ${round}`);
      // The signature survives, the rest is noise.
      await survive(Buffer.concat([sound.subarray(0, 12), damage.bytes(damage.int(500))]), `noise round ${round}`);
    }
  });
}
