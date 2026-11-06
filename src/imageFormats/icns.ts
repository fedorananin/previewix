import { DecodeError, PageInfo, Raster, ascii, isPng, u32be } from './common';

export interface IcnsEntry extends PageInfo {
  type: string;
  /** 'dark', 'template' or 'selected' for the pictures of a variant of the icon; empty for the icon itself. */
  variant: string;
  /** How the picture is stored: a PNG or JPEG 2000 file, packed ARGB planes, or packed RGB planes with a mask elsewhere. */
  kind: 'png' | 'jp2' | 'argb' | 'rgb';
  offset: number;
  size: number;
  /** The mask that belongs to an `rgb` picture: 8 bits per pixel, or the old icon with a 1-bit mask when that is all there is. */
  mask?: { offset: number; size: number };
}

/** Side in pixels, the scale it is meant for, and the types of the masks that go with packed RGB (8 bits, then 1 bit). */
const TYPES: Record<string, [number, 1 | 2, string?, string?]> = {
  is32: [16, 1, 's8mk', 'ics#'],
  il32: [32, 1, 'l8mk', 'ICN#'],
  ih32: [48, 1, 'h8mk', 'ich#'],
  it32: [128, 1, 't8mk'],
  icp4: [16, 1, 's8mk', 'ics#'],
  icp5: [32, 1, 'l8mk', 'ICN#'],
  icp6: [48, 1, 'h8mk', 'ich#'],
  ic04: [16, 1],
  ic05: [32, 2],
  icsb: [18, 1],
  icsB: [36, 2],
  sb24: [24, 1],
  SB24: [48, 2],
  ic07: [128, 1],
  ic08: [256, 1],
  ic09: [512, 1],
  ic10: [1024, 2],
  ic11: [32, 2],
  ic12: [64, 2],
  ic13: [256, 2],
  ic14: [512, 2],
};

/** Entries that are whole icon files of their own: the variants of the icon. */
const VARIANTS: Record<string, string> = { '\xfd\xd9\x2f\xa8': 'dark', sbtp: 'template', slct: 'selected' };

const isJp2 = (b: Uint8Array, at: number) =>
  (b[at] === 0xff && b[at + 1] === 0x4f && b[at + 2] === 0xff && b[at + 3] === 0x51) || (u32be(b, at) === 12 && ascii(b, at + 4, 4) === 'jP  ');

function collect(b: Uint8Array, start: number, end: number, variant: string, entries: IcnsEntry[], depth: number): void {
  const blocks = new Map<string, { offset: number; size: number }>();
  for (let pos = start; pos + 8 <= end; ) {
    const type = ascii(b, pos, 4);
    const length = u32be(b, pos + 4);
    if (length < 8 || pos + length > end) {
      break;
    }
    blocks.set(type, { offset: pos + 8, size: length - 8 });
    pos += length;
  }
  for (const [type, { offset, size }] of blocks) {
    if (VARIANTS[type]) {
      // A list of entries like the file itself, with or without a file header of its own. A template has a selected variant in turn.
      if (depth < 2 && size >= 8) {
        const inner = ascii(b, offset, 4) === 'icns' ? offset + 8 : offset;
        collect(b, inner, offset + size, variant ? `${variant}, ${VARIANTS[type]}` : VARIANTS[type], entries, depth + 1);
      }
      continue;
    }
    const known = TYPES[type];
    let side = known?.[0] ?? 0;
    let height = side;
    let kind: IcnsEntry['kind'];
    let mask: IcnsEntry['mask'];
    if (isPng(b, offset)) {
      // Whatever the type, a PNG says its own size, which also covers types newer than the table.
      kind = 'png';
      side = u32be(b, offset + 16);
      height = u32be(b, offset + 20);
    } else if (!known || size < 8) {
      continue;
    } else if (isJp2(b, offset)) {
      kind = 'jp2';
    } else if (ascii(b, offset, 4) === 'ARGB') {
      kind = 'argb';
    } else if (known[2]) {
      kind = 'rgb';
      mask = blocks.get(known[2]) ?? (known[3] ? blocks.get(known[3]) : undefined);
    } else {
      continue;
    }
    const points = known?.[1] === 2 ? ` (${side / 2} pt @2x)` : '';
    // The same size is often stored twice, as a PNG and in an older way: saying which keeps the two apart.
    const how = kind === 'jp2' ? ' · JPEG 2000' : kind === 'argb' ? ' · ARGB' : kind === 'rgb' ? ' · RGB' : '';
    entries.push({ type, variant, kind, offset, size, mask, width: side, height, label: `${side} × ${height}${points}${how}${variant ? ` · ${variant}` : ''}` });
  }
}

/**
 * The pictures of an `.icns` file: the icon itself before its variants, and each largest first.
 * The ones in JPEG 2000 are listed, although they can't be shown.
 */
export function listIcns(b: Uint8Array): IcnsEntry[] {
  if (b.length < 8 || ascii(b, 0, 4) !== 'icns') {
    throw new DecodeError('This is not an ICNS file.');
  }
  const entries: IcnsEntry[] = [];
  collect(b, 8, Math.min(b.length, u32be(b, 4)), '', entries, 0);
  // A picture that can be decoded goes before one of the same size that can't.
  return entries.sort(
    (a, z) => Number(!!a.variant) - Number(!!z.variant) || z.width * z.height - a.width * a.height || Number(a.kind === 'jp2') - Number(z.kind === 'jp2'),
  );
}

/**
 * Unpacks `planes` channels of `pixels` bytes each. A byte with the top bit set repeats the next byte
 * (its value minus 125 times); any other byte is followed by that many literal bytes plus one.
 * The channels follow each other as one stream: in the ARGB kind a run may start in one and end in the next.
 */
function unpack(b: Uint8Array, at: number, end: number, pixels: number, planes: number): Uint8Array[] {
  const total = pixels * planes;
  const out = new Uint8Array(total);
  let filled = 0;
  while (filled < total && at + 1 < end) {
    const control = b[at++];
    if (control & 0x80) {
      const run = Math.min(control - 125, total - filled);
      out.fill(b[at++], filled, filled + run);
      filled += run;
    } else {
      const run = Math.min(control + 1, total - filled, end - at);
      out.set(b.subarray(at, at + run), filled);
      at += control + 1;
      filled += run;
    }
  }
  if (filled < total) {
    throw new DecodeError('This icon is damaged: its picture data ends early.');
  }
  return Array.from({ length: planes }, (_, p) => out.subarray(p * pixels, (p + 1) * pixels));
}

/** One picture of the icon: the PNG file it is stored as, or its pixels. */
export function decodeIcns(b: Uint8Array, entry: IcnsEntry): { png: Uint8Array } | { raster: Raster } {
  const { offset, size, width, height } = entry;
  const end = offset + size;
  if (entry.kind === 'png') {
    return { png: b.subarray(offset, end) };
  }
  if (entry.kind === 'jp2') {
    throw new DecodeError(`The ${width} × ${height} picture of this icon is stored as JPEG 2000, an old format that is not supported. The other sizes can be shown.`);
  }
  const pixels = width * height;
  const data = new Uint8Array(pixels * 4);
  let planes: Uint8Array[];
  if (entry.kind === 'argb') {
    const [a, r, g, bl] = unpack(b, offset + 4, end, pixels, 4);
    planes = [r, g, bl, a];
  } else {
    // The 128 px picture starts with four zero bytes that belong to no channel.
    const start = entry.type === 'it32' && u32be(b, offset) === 0 ? offset + 4 : offset;
    if (end - start === pixels * 4) {
      // Not packed at all: one unused byte and three color bytes per pixel.
      planes = [1, 2, 3].map((channel) => Uint8Array.from({ length: pixels }, (_, i) => b[start + i * 4 + channel]));
    } else {
      planes = unpack(b, start, end, pixels, 3);
    }
    const alpha = new Uint8Array(pixels).fill(255);
    const mask = entry.mask;
    if (mask && mask.size >= pixels) {
      alpha.set(b.subarray(mask.offset, mask.offset + pixels));
    } else if (mask && mask.size >= pixels / 4) {
      // A black-and-white icon of the same size: its second half is a mask of one bit per pixel.
      const bits = mask.offset + pixels / 8;
      for (let i = 0; i < pixels; i++) {
        alpha[i] = (b[bits + (i >> 3)] >> (7 - (i & 7))) & 1 ? 255 : 0;
      }
    }
    planes.push(alpha);
  }
  for (let i = 0; i < pixels; i++) {
    data[i * 4] = planes[0][i];
    data[i * 4 + 1] = planes[1][i];
    data[i * 4 + 2] = planes[2][i];
    data[i * 4 + 3] = planes[3][i];
  }
  return { raster: { width, height, data, notes: [] } };
}
