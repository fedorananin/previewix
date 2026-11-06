import { DecodeError, PageInfo, isPng, u16le, u32be, u32le } from './common';

/** Icons stop at 256 pixels on paper and at 1024 in practice; anything far beyond that is not a size but damage. */
const MAX_SIDE = 4096;

export interface IcoEntry extends PageInfo {
  /** Bits per pixel. */
  bits: number;
  png: boolean;
  offset: number;
  size: number;
  /** Where the entry's 16-byte record sits in the directory. */
  record: number;
}

/**
 * The pictures of an `.ico` or `.cur` file, largest and deepest first, so the first one is what
 * a viewer would normally pick. Entries that point outside the file are left out.
 */
export function listIco(b: Uint8Array): IcoEntry[] {
  if (b.length < 6 || u16le(b, 0) !== 0 || (u16le(b, 2) !== 1 && u16le(b, 2) !== 2)) {
    throw new DecodeError('This is not an icon file.');
  }
  const entries: IcoEntry[] = [];
  const count = u16le(b, 4);
  for (let i = 0; i < count && 6 + (i + 1) * 16 <= b.length; i++) {
    const record = 6 + i * 16;
    const size = u32le(b, record + 8);
    const offset = u32le(b, record + 12);
    if (size < 40 || offset + size > b.length) {
      continue;
    }
    // The directory holds each side in one byte, so the picture's own header is the better source.
    let width = b[record] || 256;
    let height = b[record + 1] || 256;
    let bits: number;
    const png = isPng(b, offset);
    if (png) {
      width = u32be(b, offset + 16);
      height = u32be(b, offset + 20);
      const channels = [1, 0, 3, 1, 2, 0, 4][b[offset + 25]] || 1;
      bits = b[offset + 25] === 3 ? b[offset + 24] : b[offset + 24] * channels;
    } else {
      width = Math.abs(u32le(b, offset + 4) | 0);
      // The bitmap's height counts the mask below the picture as well.
      height = Math.abs(u32le(b, offset + 8) | 0) >> 1;
      bits = u16le(b, offset + 14);
      // A record that points at something else than a bitmap header: the file is damaged there.
      if (u32le(b, offset) < 40 || u32le(b, offset) > 124 || ![1, 4, 8, 16, 24, 32].includes(bits)) {
        continue;
      }
    }
    if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) {
      continue;
    }
    entries.push({ width, height, bits, png, offset, size, record, label: `${width} × ${height} · ${bits}-bit${png ? ' PNG' : ''}` });
  }
  return entries.sort((a, z) => z.width * z.height - a.width * a.height || z.bits - a.bits);
}

/**
 * One picture of the icon as a file a browser decodes: the PNG as it is, a bitmap as an icon file
 * with that single entry, which leaves the browser nothing to choose.
 */
export function icoPicture(b: Uint8Array, entry: IcoEntry): { bytes: Uint8Array; mime: string } {
  const data = b.subarray(entry.offset, entry.offset + entry.size);
  if (entry.png) {
    return { bytes: data, mime: 'image/png' };
  }
  const bytes = new Uint8Array(22 + data.length);
  bytes.set(b.subarray(0, 4));
  bytes[4] = 1;
  bytes.set(b.subarray(entry.record, entry.record + 12), 6);
  bytes[18] = 22;
  bytes.set(data, 22);
  return { bytes, mime: 'image/x-icon' };
}
