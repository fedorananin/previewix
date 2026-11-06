import pako from 'pako';
import * as UTIF from 'utif2';
import { CMYK_NOTE, CMYK_WARNING, DecodeError, Raster, checkSize, cmykToSrgb, labToSrgb, orient, to8, unpremultiply } from './common';
import { unpackLzw } from './lzw';
import { TIFF_COMPRESSIONS, TIFF_PHOTOMETRICS, TiffPage, listTiff } from './tiff';

/** A directory the way UTIF wants it: every tag as `t<number>` with its values. */
interface UtifIfd {
  [tag: string]: unknown;
  data?: Uint8Array;
}

/** Only UTIF's decompression is used; reading the directories and turning samples into colors is done here. */
const utif = UTIF as unknown as {
  decodeImage(buffer: ArrayBuffer, ifd: UtifIfd, ifds: UtifIfd[]): void;
  decode: {
    _decodeLZW(data: Uint8Array, at: number, length: number, target: Uint8Array, to: number): void;
    _decodeNewJPEG(ifd: UtifIfd, data: Uint8Array, at: number, length: number, target: Uint8Array, to: number): void;
    /** The fax code tables, looked up with the bits read so far as a string, and what appends a run to the row. */
    _lens: [Record<string, number>, Record<string, number>];
    _dmap: Record<string, number>;
    _addNtimes(row: number[], count: number, value: number): void;
    _writeBits(row: number[], target: Uint8Array, at: number): void;
    _decodeG2: FaxDecoder;
    _decodeG3: FaxDecoder;
    _decodeG4: FaxDecoder;
  };
};
type FaxDecoder = (...args: unknown[]) => void;

/**
 * UTIF lays out the strips and tiles and calls an unpacker for each. Most of those don't know when to stop,
 * and are replaced or fenced in below. This is what they are told about the strip or tile at hand.
 */
const chunk = {
  /** The bytes it unpacks to, its size in pixels, and its width and height. */
  bytes: 0,
  pixels: 0,
  across: 0,
  down: 0,
  /** For the fax decoders: the rows written so far, and the runs added to the row in the making. */
  rows: 0,
  runs: 0,
  /** Set when the data gave fewer or more bytes than the rows need: it ended early, or is not what it says. */
  damaged: false,
};

// LZW: UTIF's unpacker follows whatever codes it reads, and for some streams (the six bytes 80 01 e0 70 38 08
// are enough) it never returns. Ours takes its place.
utif.decode._decodeLZW = (data, at, length, target, to) => {
  const wanted = Math.min(chunk.bytes, target.length - to);
  const end = Math.min(data.length, at + (length || 0));
  chunk.damaged ||= unpackLzw(data, at, end, target, to, to + wanted) < wanted;
};

// Deflate: UTIF asks pako for the whole stream, however far it unpacks, and a megabyte of zeros deflated is a
// gigabyte. This stops at what the strip holds.
const TOO_LONG = new Error('too long');
pako.inflateRaw = (input) => {
  const out = new Uint8Array(chunk.bytes);
  let filled = 0;
  const inflate = new pako.Inflate({ raw: true });
  inflate.onData = (part) => {
    if (filled + part.length > out.length) {
      throw TOO_LONG;
    }
    out.set(part, filled);
    filled += part.length;
  };
  inflate.onEnd = (status) => {
    inflate.err = status;
  };
  try {
    inflate.push(input, true);
  } catch (e) {
    if (e !== TOO_LONG) {
      throw e;
    }
    chunk.damaged = true;
    return out;
  }
  if (inflate.err) {
    throw new Error(inflate.msg || 'the Deflate data is not valid');
  }
  return out.subarray(0, filled);
};

// JPEG: the decoder allocates what the stream's own header claims, up to 65535 × 65535, whatever the strip is.
const decodeJpeg = utif.decode._decodeNewJPEG;
utif.decode._decodeNewJPEG = (ifd, data, at, length, target, to) => {
  const end = Math.min(data.length, at + (length || 0));
  for (let pos = at + 2; pos + 9 < end && data[pos] === 0xff; pos += 2 + ((data[pos + 2] << 8) | data[pos + 3])) {
    // The start of a frame: precision, height, width.
    if (data[pos + 1] >= 0xc0 && data[pos + 1] <= 0xc2) {
      const claimed = ((data[pos + 5] << 8) | data[pos + 6]) * ((data[pos + 7] << 8) | data[pos + 8]);
      // Encoders round a strip up to whole blocks, and that is all the slack there is.
      if (claimed > chunk.pixels * 4 + 65536) {
        throw new DecodeError('This TIFF is damaged: a JPEG strip in it claims a size far beyond the picture.');
      }
      break;
    }
  }
  decodeJpeg(ifd, data, at, length, target, to);
};

// Fax (CCITT): UTIF's three decoders collect the bits read so far in a string and the pixels of the row in an
// array, and look the string up after every bit. On data that is no fax data the string never matches and the
// row never ends: both grow for as long as there is input, which is quadratic time and unbounded memory. Their
// loops can't be reached, but their tables and the functions that extend and write a row can: no code is longer
// than 13 bits, a row longer than the picture is wide (twice, with the slack the Group 3 decoder needs) or made
// of more runs than it has pixels is damage, and after the last row of the strip there is nothing left to decode
// (a megabyte of 1 bits is a million valid white rows in Group 4).
const FAX_DAMAGED = 'This TIFF is damaged: its fax data is not valid.';
const FAX_DONE = new Error('done');
const fenced = (table: Record<string, number>) =>
  new Proxy(table, {
    get(codes, bits) {
      if (typeof bits === 'string' && bits.length > 64) {
        throw new DecodeError(FAX_DAMAGED);
      }
      return codes[bits as string];
    },
  });
utif.decode._lens = [fenced(utif.decode._lens[0]), fenced(utif.decode._lens[1])];
utif.decode._dmap = fenced(utif.decode._dmap);
utif.decode._addNtimes = (row, count, value) => {
  if (!(count >= 0) || row.length + count > chunk.across * 2 + 4096 || ++chunk.runs > chunk.across * 4 + 64) {
    throw new DecodeError(FAX_DAMAGED);
  }
  for (let i = 0; i < count; i++) {
    row.push(value);
  }
};
const writeRow = utif.decode._writeBits;
utif.decode._writeBits = (row, target, at) => {
  if (++chunk.rows > chunk.down) {
    throw FAX_DONE;
  }
  chunk.runs = 0;
  writeRow(row, target, at);
};
for (const name of ['_decodeG2', '_decodeG3', '_decodeG4'] as const) {
  const decode = utif.decode[name];
  utif.decode[name] = (...args) => {
    chunk.rows = chunk.runs = 0;
    try {
      decode(...args);
    } catch (e) {
      if (e !== FAX_DONE) {
        throw e;
      }
    }
  };
}

/**
 * How many bytes one byte of a strip can unpack to at the very most. A file that claims a picture its data
 * could never fill is refused before anything of that size is allocated. For the fax codings there is no
 * such ratio, but a row costs at least a bit.
 */
const EXPANSION: Record<number, number> = { 1: 1, 5: 3000, 7: 4096, 8: 1040, 32946: 1040, 32773: 64 };

/** What UTIF unpacks reliably, checked against other decoders. Anything else is refused rather than shown wrong. */
const COMPRESSIONS = new Set([1, 2, 3, 4, 5, 7, 8, 32946, 32773]);

/** Tags the decompression reads: geometry, strips and tiles, and the parameters of the codecs. */
const CODEC_TAGS = [256, 257, 258, 259, 262, 266, 273, 277, 278, 279, 292, 293, 317, 322, 323, 324, 325, 347, 530];

/** Number of color samples per photometric interpretation. */
const COLOR_SAMPLES: Record<number, number> = { 0: 1, 1: 1, 2: 3, 3: 1, 5: 4, 6: 3, 8: 3 };

/** `what` names the feature in the singular or the plural, verb included. */
function unsupported(what: string): DecodeError {
  return new DecodeError(`This TIFF can't be shown: ${what} not supported.`);
}

/** Decompresses the page into rows of samples as the file orders them, 16-bit ones in little-endian order. */
function unpack(buffer: ArrayBuffer, page: TiffPage): Uint8Array {
  const ifd: UtifIfd = {};
  for (const tag of CODEC_TAGS) {
    const values = page.values(tag);
    if (values) {
      ifd[`t${tag}`] = values;
    }
  }
  ifd.t258 = [page.bits];
  ifd.t262 = [page.photometric];
  const stride = Math.ceil((page.width * page.bits * page.samples) / 8);
  const expected = stride * page.height;
  const separate = page.planar === 2 && page.samples > 1;
  // The strip or tile, as rows of the samples one call unpacks: all of a pixel's, or one plane's.
  const [across, down] = page.tiled
    ? [Number((page.values(322) as number[] | undefined)?.[0]) || page.width, Number((page.values(323) as number[] | undefined)?.[0]) || page.height]
    : [page.width, Math.min((page.values(278) as number[] | undefined)?.[0] || page.height, page.height)];
  chunk.bytes = Math.ceil((across * page.bits * (separate ? 1 : page.samples)) / 8) * down;
  chunk.pixels = across * down;
  chunk.across = across;
  chunk.down = down;
  const log = console.log;
  // UTIF prints while it works.
  console.log = () => undefined;
  try {
    if (!separate) {
      utif.decodeImage(buffer, ifd, []);
      if (!ifd.data || ifd.data.length < expected) {
        throw new DecodeError('This TIFF is damaged: its picture data is incomplete.');
      }
      return ifd.data;
    }
    // One plane per sample: each is unpacked as a picture with a single sample, then they are woven together.
    const [offsetTag, lengthTag] = page.tiled ? ['t324', 't325'] : ['t273', 't279'];
    const offsets = ifd[offsetTag] as number[];
    const lengths = ifd[lengthTag] as number[];
    const perPlane = offsets.length / page.samples;
    const bytes = page.bits >> 3;
    const data = new Uint8Array(expected);
    for (let s = 0; s < page.samples; s++) {
      const plane: UtifIfd = { ...ifd, t277: [1], t262: [1] };
      plane[offsetTag] = offsets.slice(s * perPlane, (s + 1) * perPlane);
      plane[lengthTag] = lengths.slice(s * perPlane, (s + 1) * perPlane);
      utif.decodeImage(buffer, plane, []);
      if (!plane.data || plane.data.length < page.width * page.height * bytes) {
        throw new DecodeError('This TIFF is damaged: its picture data is incomplete.');
      }
      for (let i = 0, to = s * bytes; i < page.width * page.height * bytes; i += bytes, to += page.samples * bytes) {
        data[to] = plane.data[i];
        if (bytes === 2) {
          data[to + 1] = plane.data[i + 1];
        }
      }
    }
    return data;
  } catch (e) {
    if (e instanceof DecodeError) {
      throw e;
    }
    throw new DecodeError(`This TIFF is damaged: its picture data can't be unpacked (${e instanceof Error ? e.message : e}).`);
  } finally {
    console.log = log;
  }
}

/** Decodes one page of a TIFF file. `index` counts the pages `listTiff()` returns. */
export function decodeTiff(b: Uint8Array, index: number): Raster {
  const page = listTiff(b)[index];
  if (!page) {
    throw new DecodeError('This TIFF has no such page.');
  }
  const { width, height, bits, samples } = page;
  checkSize(width, height);
  if (!page.complete) {
    throw new DecodeError('This TIFF is damaged or cut short: part of its picture data lies outside the file.');
  }
  if (!COMPRESSIONS.has(page.compression)) {
    throw unsupported(`${TIFF_COMPRESSIONS[page.compression] ?? `type ${page.compression}`} compression is`);
  }
  let photometric = page.photometric;
  const jpeg = page.compression === 7;
  // The JPEG decoder hands out RGB whatever the tag says about the samples inside.
  if (jpeg && photometric === 6) {
    photometric = 2;
  }
  const colors = COLOR_SAMPLES[photometric];
  if (colors === undefined || photometric === 6) {
    throw unsupported(`${TIFF_PHOTOMETRICS[photometric] ?? `color type ${photometric}`}${photometric === 6 ? ' without JPEG compression' : ''} is`);
  }
  if (page.sampleFormat !== 1 || page.mixedBits) {
    throw unsupported(`${page.sampleFormat === 3 ? 'floating-point samples' : page.mixedBits ? 'samples of different sizes' : 'signed samples'} are`);
  }
  const small = colors === 1 && samples === 1 && (bits === 1 || bits === 2 || bits === 4);
  if (!(bits === 8 || bits === 16 || small) || (photometric === 3 && bits === 16) || samples < colors) {
    throw unsupported(`${bits} bits per sample with ${samples} sample${samples === 1 ? '' : 's'} per pixel (${TIFF_PHOTOMETRICS[photometric]}) is`);
  }
  if (page.planar === 2 && (jpeg || bits < 8)) {
    throw unsupported('this layout of separate planes is');
  }
  if (page.compression >= 2 && page.compression <= 4 && (bits !== 1 || samples !== 1)) {
    throw new DecodeError('This TIFF is damaged: it uses a fax compression for a picture that is not black and white.');
  }
  // The size the file claims against the data it brings.
  const needed = Math.ceil((width * bits * samples) / 8) * height;
  if (page.tiled) {
    // A tile may reach past the picture, but not by orders of magnitude: each one is allocated whole.
    const [across, down] = [322, 323].map((tag) => Number((page.values(tag) as number[] | undefined)?.[0]) || 0);
    if (!across || !down || Math.ceil((across * bits * samples) / 8) * down > needed * 4 + (4 << 20)) {
      throw new DecodeError('This TIFF is damaged: the size of its tiles does not fit the picture.');
    }
  }
  const ratio = EXPANSION[page.compression];
  if (ratio ? page.dataBytes * ratio < needed : page.dataBytes * 8 < height) {
    throw new DecodeError(`This TIFF is damaged or cut short: it holds far too little data for a picture of ${width} × ${height} px.`);
  }

  // UTIF reads at offsets from the start of the buffer it is given.
  const whole = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength;
  const buffer = (whole ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) as ArrayBuffer;
  chunk.damaged = false;
  const source = unpack(buffer, page);

  const pixels = width * height;
  const data = new Uint8Array(pixels * 4);
  const notes: [string, string][] = [];
  let warning: string | undefined;
  const wide = bits === 16;
  const step = samples * (wide ? 2 : 1);
  /** Sample `c` of the pixel that starts at byte `at`, as 8 bits. */
  const sample = wide ? (at: number, c: number) => to8(source[at + c * 2] | (source[at + c * 2 + 1] << 8)) : (at: number, c: number) => source[at + c];
  if (wide) {
    notes.push(['Depth', '16 bits per channel, shown with 8']);
  }

  // What the first sample after the color means. A fourth sample of an RGB file that doesn't say is alpha, as libtiff reads it.
  const extra = page.extra ? page.extra[0] : samples === 4 && photometric === 2 ? 1 : undefined;
  const alpha = samples > colors && (extra === 1 || extra === 2);

  if (photometric <= 1 || photometric === 3) {
    const map = photometric === 3 ? (page.values(320) as number[] | undefined) : undefined;
    const size = 1 << bits;
    if (photometric === 3 && (!map || map.length < size * 3)) {
      throw new DecodeError('This TIFF is damaged: its color table is missing.');
    }
    const stride = Math.ceil((width * bits * samples) / 8);
    const scale = 255 / (size - 1);
    for (let i = 0, y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        const at = y * stride + x * step;
        let value: number;
        if (bits >= 8) {
          value = map ? source[at] : sample(at, 0);
        } else {
          const per = 8 / bits;
          value = (source[y * stride + ((x / per) | 0)] >> (8 - bits * ((x % per) + 1))) & (size - 1);
        }
        if (map) {
          data[i * 4] = to8(map[value]);
          data[i * 4 + 1] = to8(map[size + value]);
          data[i * 4 + 2] = to8(map[size * 2 + value]);
        } else {
          const gray = bits >= 8 ? value : Math.round(value * scale);
          data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = photometric === 0 ? 255 - gray : gray;
        }
        data[i * 4 + 3] = alpha ? sample(at, 1) : 255;
      }
    }
  } else {
    for (let i = 0, at = 0; i < pixels; i++, at += step) {
      if (photometric === 2) {
        data[i * 4] = sample(at, 0);
        data[i * 4 + 1] = sample(at, 1);
        data[i * 4 + 2] = sample(at, 2);
      } else if (photometric === 5) {
        // Unlike in a Photoshop file, 0 is no ink here.
        cmykToSrgb(sample(at, 0), sample(at, 1), sample(at, 2), sample(at, 3), data, i * 4);
      } else if (wide) {
        // Lightness is unsigned; a and b are signed.
        const a = ((source[at + 2] | (source[at + 3] << 8)) << 16) >> 16;
        const bb = ((source[at + 4] | (source[at + 5] << 8)) << 16) >> 16;
        labToSrgb(((source[at] | (source[at + 1] << 8)) / 65535) * 100, a / 256, bb / 256, data, i * 4);
      } else {
        labToSrgb((source[at] / 255) * 100, (source[at + 1] << 24) >> 24, (source[at + 2] << 24) >> 24, data, i * 4);
      }
      data[i * 4 + 3] = alpha ? sample(at, colors) : 255;
    }
    if (photometric === 5) {
      warning = CMYK_WARNING;
      notes.push(CMYK_NOTE);
    } else if (photometric === 8) {
      notes.push(['Color', 'Lab, converted to sRGB']);
    }
  }
  if (alpha && extra === 1) {
    unpremultiply(data);
  }
  if (chunk.damaged) {
    // What could be unpacked is shown; the rows that are missing stay empty.
    warning = 'This TIFF is damaged: part of its picture data is missing or not valid, and that part of the picture is empty.';
    notes.push(['Damage', 'Part of the picture data could not be unpacked']);
  }
  const icc = photometric === 2 ? page.icc : undefined;
  return orient({ width, height, data, icc, notes, warning }, page.orientation);
}
