import { DecodeError, PageInfo } from './common';

export interface TiffPage extends PageInfo {
  /** Bits per sample; every sample of a pixel has the same. */
  bits: number;
  /** Whether the samples differ in size, which nothing here reads. */
  mixedBits: boolean;
  samples: number;
  compression: number;
  photometric: number;
  /** 1 to 8, as in EXIF. */
  orientation: number;
  /** 1: the samples of a pixel are stored together; 2: every sample has its own plane. */
  planar: number;
  /** 1 unsigned integer, 2 signed integer, 3 floating point. */
  sampleFormat: number;
  /** What the samples after the color mean: 1 alpha multiplied into the color, 2 plain alpha, 0 anything else. Undefined when the file doesn't say. */
  extra?: number[];
  tiled: boolean;
  /** A smaller copy of another page (a thumbnail or a pyramid level). */
  reduced: boolean;
  /** Pixels per inch. */
  dpi?: [number, number];
  icc?: Uint8Array;
  /** Whether the directory and the strips or tiles it points at lie inside the file. */
  complete: boolean;
  /** How many bytes of the file the strips or tiles take up together. */
  dataBytes: number;
  /** All values of a tag of this page: numbers, or the bytes of a BYTE or UNDEFINED tag. Only offsets that lie inside the file are followed. */
  values(tag: number): number[] | Uint8Array | undefined;
}

export const TIFF_COMPRESSIONS: Record<number, string> = {
  1: 'None',
  2: 'CCITT RLE',
  3: 'CCITT Group 3 (fax)',
  4: 'CCITT Group 4 (fax)',
  5: 'LZW',
  6: 'JPEG (old style)',
  7: 'JPEG',
  8: 'Deflate',
  32946: 'Deflate',
  32773: 'PackBits',
  34712: 'JPEG 2000',
  34925: 'LZMA',
  50000: 'Zstandard',
  50001: 'WebP',
  34676: 'LogLuv',
  34677: 'LogLuv',
};

export const TIFF_PHOTOMETRICS: Record<number, string> = {
  0: 'Grayscale (white is zero)',
  1: 'Grayscale',
  2: 'RGB',
  3: 'Palette',
  4: 'Transparency mask',
  5: 'CMYK',
  6: 'YCbCr',
  8: 'CIE Lab',
  9: 'ICC Lab',
  32803: 'Camera sensor data (raw)',
  34892: 'Linear raw',
};

/** More directories than any document has; a file that claims more is a chain gone wrong. */
const MAX_PAGES = 10_000;

/** Bytes per value of every tag type, 1 (BYTE) to 13 (IFD). */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/**
 * The pages of a TIFF file, read from its directories without touching a pixel. Every offset is checked
 * against the file, and a directory chain that loops or leaves the file ends the list. The decoder is
 * given only what was read here, because it trusts its input.
 */
export function listTiff(b: Uint8Array): TiffPage[] {
  const little = b[0] === 0x49 && b[1] === 0x49;
  if (b.length < 8 || (!little && !(b[0] === 0x4d && b[1] === 0x4d))) {
    throw new DecodeError('This is not a TIFF file.');
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(2) === 43) {
    throw new DecodeError('This is a BigTIFF file (64-bit offsets), which is not supported.');
  }
  if (u16(2) !== 42) {
    throw new DecodeError('This is not a TIFF file.');
  }

  const pages: TiffPage[] = [];
  const seen = new Set<number>();
  for (let ifd = u32(4); ifd !== 0 && !seen.has(ifd) && ifd + 2 <= b.length && pages.length < MAX_PAGES; ) {
    seen.add(ifd);
    const count = u16(ifd);
    const end = ifd + 2 + count * 12;
    if (end + 4 > b.length) {
      break;
    }
    /** Every tag with unsigned values, as [where the first value is, how many, the type]. */
    const tags = new Map<number, [number, number, number]>();
    let sound = true;
    for (let entry = ifd + 2; entry < end; entry += 12) {
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      const size = TYPE_SIZE[type];
      if (!size) {
        continue;
      }
      const at = n * size <= 4 ? entry + 8 : u32(entry + 8);
      if (at + n * size > b.length) {
        sound = false;
      } else if (type === 1 || type === 3 || type === 4 || type === 5 || type === 7) {
        tags.set(u16(entry), [at, n, type]);
      }
    }
    const value = (tag: number, index = 0): number | undefined => {
      const found = tags.get(tag);
      if (!found || index >= found[1]) {
        return undefined;
      }
      const [at, , type] = found;
      return type === 3 ? u16(at + index * 2) : type === 4 ? u32(at + index * 4) : type === 5 ? u32(at + index * 8) / (u32(at + index * 8 + 4) || 1) : b[at + index];
    };
    const values = (tag: number): number[] | Uint8Array | undefined => {
      const found = tags.get(tag);
      if (!found) {
        return undefined;
      }
      const [at, n, type] = found;
      return type === 1 || type === 7 ? b.subarray(at, at + n) : Array.from({ length: n }, (_, i) => value(tag, i) as number);
    };
    const list = (tag: number): number[] | undefined => {
      const found = tags.get(tag);
      return found ? Array.from({ length: Math.min(found[1], 16) }, (_, i) => value(tag, i) as number) : undefined;
    };

    const width = value(256);
    const height = value(257);
    if (width && height) {
      const bitsList = list(258) ?? [1];
      const tiled = tags.has(322);
      // Every strip or tile has to lie inside the file, or the decoder would fill the gaps with nothing.
      const offsets = tags.get(tiled ? 324 : 273);
      const lengths = tags.get(tiled ? 325 : 279);
      const [offsetTag, lengthTag] = tiled ? [324, 325] : [273, 279];
      const plain = !tiled && offsets?.[1] === 1 && (value(259) ?? 1) === 1;
      let complete = sound && !!offsets && (plain || lengths?.[1] === offsets[1]);
      let dataBytes = 0;
      for (let i = 0; lengths && offsets && i < offsets[1] && complete; i++) {
        const length = value(lengthTag, i) as number;
        complete = (value(offsetTag, i) as number) + length <= b.length;
        dataBytes += length;
      }
      if (plain && complete) {
        // An uncompressed picture in one strip is read by its geometry, whatever the byte count says (old files leave it out).
        dataBytes = Math.ceil((width * bitsList[0] * (value(277) ?? 1)) / 8) * height;
        complete = (value(273) as number) + dataBytes <= b.length;
      }
      const icc = tags.get(34675);
      const [xRes, yRes] = [value(282), value(283)];
      const perInch = value(296) === 3 ? 2.54 : 1;
      const reduced = ((value(254) ?? 0) & 1) !== 0;
      pages.push({
        width,
        height,
        label: `Page ${pages.length + 1} · ${width} × ${height}${reduced ? ' (reduced)' : ''}`,
        bits: bitsList[0],
        mixedBits: bitsList.some((bits) => bits !== bitsList[0]),
        samples: value(277) ?? 1,
        compression: value(259) ?? 1,
        photometric: value(262) ?? (bitsList[0] === 1 ? 0 : 2),
        orientation: value(274) ?? 1,
        planar: value(284) ?? 1,
        sampleFormat: value(339) ?? 1,
        extra: list(338),
        tiled,
        reduced,
        dpi: xRes && yRes && value(296) !== 1 ? [xRes * perInch, yRes * perInch] : undefined,
        icc: icc ? b.subarray(icc[0], icc[0] + icc[1]) : undefined,
        complete,
        dataBytes,
        values,
      });
    }
    ifd = u32(end);
  }
  if (!pages.length) {
    throw new DecodeError('This TIFF file is damaged or cut short: no picture can be found in it.');
  }
  return pages;
}
