import { CMYK_NOTE, CMYK_WARNING, DecodeError, Raster, ascii, checkSize, cmykToSrgb, encodeSrgb, labToSrgb, to8, u16be, u32be, unpremultiply } from './common';

export const PSD_MODES: Record<number, string> = {
  0: 'Bitmap',
  1: 'Grayscale',
  2: 'Indexed',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel',
  8: 'Duotone',
  9: 'Lab',
};

/** How many of the channels make up the color in each mode; the ones after them are transparency, masks and spot colors. */
const COLOR_CHANNELS: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 3, 4: 4, 8: 1, 9: 3 };

export interface PsdInfo {
  /** The large document format (`.psb`), with 64-bit lengths. */
  large: boolean;
  channels: number;
  width: number;
  height: number;
  /** Bits per channel: 1, 8, 16 or 32. */
  depth: number;
  mode: number;
  /** False when Photoshop wrote no flattened picture ("Maximize Compatibility" off); undefined when the file doesn't say. */
  composite?: boolean;
  /** Whether the first channel after the color ones is the transparency of the flattened picture. */
  transparent: boolean;
  /** Whether the file marks that channel as merged transparency, which means the colors were blended with a background. */
  matted: boolean;
  layers?: number;
  icc?: Uint8Array;
  /** The EXIF block, a TIFF structure. */
  exif?: Uint8Array;
  dpi?: [number, number];
  palette?: Uint8Array;
  transparentIndex?: number;
  /** Where the flattened picture starts. */
  imageData: number;
}

const TRUNCATED = 'This Photoshop file is damaged or cut short: the flattened picture is missing.';

const u64be = (b: Uint8Array, at: number) => u32be(b, at) * 0x100000000 + u32be(b, at + 4);

/** Reads everything in front of the flattened picture that says how to read it. No pixels are touched. */
export function readPsd(b: Uint8Array): PsdInfo {
  if (b.length < 26 || ascii(b, 0, 4) !== '8BPS') {
    throw new DecodeError('This is not a Photoshop file.');
  }
  const version = u16be(b, 4);
  if (version !== 1 && version !== 2) {
    throw new DecodeError(`Photoshop file version ${version} is not supported.`);
  }
  const large = version === 2;
  const info: PsdInfo = {
    large,
    channels: u16be(b, 12),
    height: u32be(b, 14),
    width: u32be(b, 18),
    depth: u16be(b, 22),
    mode: u16be(b, 24),
    transparent: false,
    matted: false,
    imageData: 0,
  };
  let pos = 26;
  /** Steps over a section that starts with its own length and returns where its content is. */
  const section = (lengthBytes: 4 | 8): [number, number] => {
    if (pos + lengthBytes > b.length) {
      throw new DecodeError(TRUNCATED);
    }
    const start = pos + lengthBytes;
    const end = start + (lengthBytes === 8 ? u64be(b, pos) : u32be(b, pos));
    if (end > b.length) {
      throw new DecodeError(TRUNCATED);
    }
    pos = end;
    return [start, end];
  };

  const [paletteStart, paletteEnd] = section(4);
  if (info.mode === 2 && paletteEnd - paletteStart >= 768) {
    info.palette = b.subarray(paletteStart, paletteStart + 768);
  }

  /** Names of the channels that are saved selections, which is what tells them from transparency. */
  let alphaNames = 0;
  const [resourceStart, resourceEnd] = section(4);
  for (let at = resourceStart; at + 12 <= resourceEnd; ) {
    const id = u16be(b, at + 4);
    // The name is a Pascal string padded to an even length, its length byte included.
    const sizeAt = at + 6 + ((b[at + 6] + 2) & ~1);
    const size = u32be(b, sizeAt);
    const data = sizeAt + 4;
    if (data + size > resourceEnd) {
      break;
    }
    if (id === 1005 && size >= 14) {
      info.dpi = [u32be(b, data) / 65536, u32be(b, data + 8) / 65536];
    } else if (id === 1006) {
      for (let name = data; name < data + size; name += b[name] + 1) {
        alphaNames++;
      }
    } else if (id === 1039) {
      info.icc = b.subarray(data, data + size);
    } else if (id === 1047 && size >= 2) {
      info.transparentIndex = u16be(b, data);
    } else if (id === 1057 && size >= 5) {
      info.composite = b[data + 4] !== 0;
    } else if (id === 1058) {
      info.exif = b.subarray(data, data + size);
    }
    at = data + size + (size & 1);
  }

  const lengthBytes = large ? 8 : 4;
  const [layerStart, layerEnd] = section(lengthBytes);
  let count: number | undefined;
  let merged = false;
  if (layerEnd - layerStart >= lengthBytes + 2) {
    const infoLength = large ? u64be(b, layerStart) : u32be(b, layerStart);
    let at = layerStart + lengthBytes;
    if (infoLength >= 2) {
      count = (u16be(b, at) << 16) >> 16;
    } else if (at + 4 <= layerEnd) {
      // Documents with 16 or 32 bits per channel keep their layers in a tagged block after the (empty) global mask,
      // and say "the merged picture has transparency" with a block of its own in front of it.
      at += 4 + u32be(b, at);
      while (at + 8 + lengthBytes + 2 <= layerEnd && /^8B(IM|64)$/.test(ascii(b, at, 4))) {
        const key = ascii(b, at + 4, 4);
        const data = at + 8 + lengthBytes;
        if (key === 'Lr16' || key === 'Lr32') {
          count = (u16be(b, data) << 16) >> 16;
        } else if (key === 'Mt16' || key === 'Mt32' || key === 'Mtrn') {
          merged = true;
          at = data + (large ? u64be(b, at + 8) : u32be(b, at + 8));
          continue;
        }
        break;
      }
    }
  }
  const extra = info.channels - (COLOR_CHANNELS[info.mode] ?? info.channels);
  if (count !== undefined || merged) {
    info.layers = count === undefined ? undefined : Math.abs(count);
    // A negative count is Photoshop's way of saying that the first extra channel is the transparency of the merged picture.
    info.transparent = info.matted = extra > 0 && (merged || (count as number) < 0);
  } else {
    // A file without layers, as other programs write it: a channel beyond the named selections is its alpha.
    info.transparent = extra > alphaNames;
  }
  info.imageData = pos;
  return info;
}

/** PackBits: a count byte n, then n + 1 literal bytes (n < 128) or one byte repeated 257 − n times (n > 128). */
function unpackBits(b: Uint8Array, at: number, end: number, out: Uint8Array, to: number, length: number): void {
  const stop = to + length;
  while (to < stop && at < end) {
    const n = b[at++];
    if (n < 128) {
      const run = Math.min(n + 1, stop - to, end - at);
      out.set(b.subarray(at, at + run), to);
      at += n + 1;
      to += run;
    } else if (n > 128) {
      if (at >= end) {
        break;
      }
      const run = Math.min(257 - n, stop - to);
      out.fill(b[at++], to, to + run);
      to += run;
    }
  }
  if (to < stop) {
    throw new DecodeError(TRUNCATED);
  }
}

/** The flattened picture of a Photoshop file. The layers are not read. */
export function decodePsd(b: Uint8Array): Raster {
  const info = readPsd(b);
  const { width, height, depth, mode, channels } = info;
  checkSize(width, height);
  const modeName = PSD_MODES[mode] ?? `color mode ${mode}`;
  const colors = COLOR_CHANNELS[mode];
  if (colors === undefined) {
    throw new DecodeError(`Photoshop files in ${PSD_MODES[mode] ? `${modeName} mode` : modeName} are not supported.`);
  }
  if (![1, 8, 16, 32].includes(depth) || (depth === 1) !== (mode === 0) || (depth === 32 && mode !== 1 && mode !== 3) || channels < colors) {
    throw new DecodeError(`This kind of Photoshop file is not supported (${modeName}, ${depth} bits per channel, ${channels} channels).`);
  }
  if (info.composite === false) {
    throw new DecodeError(
      'This Photoshop file holds only layers: it was saved without a flattened picture (“Maximize Compatibility” off), and Previewix does not render layers.',
    );
  }

  // ---- The planes, one per channel
  const used = colors + (info.transparent ? 1 : 0);
  const rowBytes = depth === 1 ? Math.ceil(width / 8) : width * (depth >> 3);
  const planeBytes = rowBytes * height;
  if (info.imageData + 2 > b.length) {
    throw new DecodeError(TRUNCATED);
  }
  const compression = u16be(b, info.imageData);
  let at = info.imageData + 2;
  const planes: Uint8Array[] = [];
  if (compression === 0) {
    if (at + planeBytes * used > b.length) {
      throw new DecodeError(TRUNCATED);
    }
    for (let c = 0; c < used; c++) {
      planes.push(b.subarray(at + c * planeBytes, at + (c + 1) * planeBytes));
    }
  } else if (compression === 1) {
    // The packed length of every row of every channel comes first.
    const countBytes = info.large ? 4 : 2;
    const table = at;
    at += channels * height * countBytes;
    // Two packed bytes give 128 at the most: a file too short for its planes even so is not worth allocating them for.
    if (at > b.length || (b.length - at) * 64 < planeBytes * used) {
      throw new DecodeError(TRUNCATED);
    }
    for (let c = 0; c < used; c++) {
      const plane = new Uint8Array(planeBytes);
      for (let y = 0; y < height; y++) {
        const entry = table + (c * height + y) * countBytes;
        const length = countBytes === 4 ? u32be(b, entry) : u16be(b, entry);
        unpackBits(b, at, Math.min(b.length, at + length), plane, y * rowBytes, rowBytes);
        at += length;
      }
      planes.push(plane);
    }
  } else {
    throw new DecodeError('The flattened picture of this Photoshop file is ZIP-compressed, which is not supported.');
  }

  // ---- To RGBA
  const pixels = width * height;
  const data = new Uint8Array(pixels * 4);
  const notes: [string, string][] = [];
  let warning: string | undefined;
  /** Channel `c` of pixel `i`, as 8 bits. */
  let sample: (c: number, i: number) => number;
  if (depth === 16) {
    sample = (c, i) => to8((planes[c][i * 2] << 8) | planes[c][i * 2 + 1]);
    notes.push(['Depth', '16 bits per channel, shown with 8']);
  } else if (depth === 32) {
    // Floating point, linear light: 1.0 is white. The alpha channel is linear by nature and takes no curve.
    const views = planes.map((plane) => new DataView(plane.buffer, plane.byteOffset, plane.byteLength));
    sample = (c, i) => {
      const value = views[c].getFloat32(i * 4);
      return c < colors ? encodeSrgb(value) : Math.round(255 * Math.min(1, Math.max(0, value)));
    };
    notes.push(['Depth', '32 bits per channel (linear), shown with 8; values above white are clipped']);
  } else {
    sample = (c, i) => planes[c][i];
  }

  if (mode === 0) {
    for (let i = 0, y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        // A set bit is black.
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = (planes[0][y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
      }
    }
  } else if (mode === 2) {
    const palette = info.palette;
    if (!palette) {
      throw new DecodeError('This indexed Photoshop file has no color table.');
    }
    for (let i = 0; i < pixels; i++) {
      const index = planes[0][i];
      data[i * 4] = palette[index];
      data[i * 4 + 1] = palette[256 + index];
      data[i * 4 + 2] = palette[512 + index];
      data[i * 4 + 3] = index === info.transparentIndex ? 0 : 255;
    }
  } else if (mode === 3) {
    for (let i = 0; i < pixels; i++) {
      data[i * 4] = sample(0, i);
      data[i * 4 + 1] = sample(1, i);
      data[i * 4 + 2] = sample(2, i);
    }
  } else if (mode === 4) {
    // The inks are stored inverted: 255 is no ink.
    for (let i = 0; i < pixels; i++) {
      cmykToSrgb(255 - sample(0, i), 255 - sample(1, i), 255 - sample(2, i), 255 - sample(3, i), data, i * 4);
    }
    warning = CMYK_WARNING;
    notes.push(CMYK_NOTE);
  } else if (mode === 9) {
    const wide = depth === 16;
    for (let i = 0; i < pixels; i++) {
      // Lightness spans the whole range of the sample; a and b are centered on its middle.
      const j = wide ? i * 2 : i;
      const L = wide ? (planes[0][j] << 8) | planes[0][j + 1] : planes[0][j] * 257;
      const A = wide ? (planes[1][j] << 8) | planes[1][j + 1] : planes[1][j] * 256;
      const B = wide ? (planes[2][j] << 8) | planes[2][j + 1] : planes[2][j] * 256;
      labToSrgb((L / 65535) * 100, A / 256 - 128, B / 256 - 128, data, i * 4);
    }
    notes.push(['Color', 'Lab, converted to sRGB']);
  } else {
    for (let i = 0; i < pixels; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = sample(0, i);
    }
    if (mode === 8) {
      notes.push(['Color', 'Duotone, shown as its grayscale plate without the inks']);
    }
  }

  if (mode !== 2) {
    if (info.transparent) {
      // Photoshop stores a see-through picture blended with white; macOS and ImageMagick write the same structure
      // with the colors multiplied by the alpha instead. The pixels tell which: blended with white, no channel
      // can be darker than 255 − alpha; multiplied, none can be brighter than alpha.
      let white = info.matted;
      let black = info.matted;
      for (let i = 0; i < pixels; i++) {
        const alpha = (data[i * 4 + 3] = sample(colors, i));
        if (alpha > 0 && alpha < 255 && (white || black)) {
          for (let c = 0; c < 3; c++) {
            white &&= data[i * 4 + c] >= 253 - alpha;
            black &&= data[i * 4 + c] <= alpha + 2;
          }
        }
      }
      if (white) {
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3];
          if (alpha > 0 && alpha < 255) {
            for (let c = 0; c < 3; c++) {
              data[i + c] = Math.min(255, Math.max(0, Math.round(((data[i + c] + alpha - 255) * 255) / alpha)));
            }
          }
        }
      } else if (black) {
        unpremultiply(data);
      }
    } else {
      for (let i = 3; i < data.length; i += 4) {
        data[i] = 255;
      }
    }
  }
  // A 32-bit picture has just been taken out of its linear space, so its profile no longer describes the values.
  return { width, height, data, icc: mode === 3 && depth !== 32 ? info.icc : undefined, notes, warning };
}
