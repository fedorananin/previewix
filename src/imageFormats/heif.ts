import { ascii, u16be, u32be } from './common';
import { brandsOf } from './sniff';

/** What a HEIF or AVIF file says about its main picture, read from its boxes without decoding. */
export interface HeifInfo {
  brands: string[];
  /** The size as stored, before the turn below. */
  width?: number;
  height?: number;
  /** Quarter turns counter-clockwise that every reader applies (the `irot` property). */
  turns: number;
  /** Mirroring that every reader applies (the `imir` property): axis 0 exchanges top and bottom, axis 1 left and right. */
  mirror?: 0 | 1;
  /** Turn and mirroring together, in the order the file applies them, as the EXIF orientation (1 to 8) that does the same. */
  orientation: number;
  bits?: number;
  channels?: number;
  /** How the main picture is coded: `hvc1` (HEVC), `av01` (AV1), `grid` (tiles), and so on. */
  codec?: string;
  icc?: Uint8Array;
  /** The color space as ITU-T H.273 code points, when there is no profile. */
  nclx?: { primaries: number; transfer: number; matrix: number };
  /** The file holds a movie track, i.e. an image sequence. */
  sequence: boolean;
}

interface Box {
  type: string;
  start: number;
  end: number;
}

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const found: Box[] = [];
  for (let pos = start; pos + 8 <= end; ) {
    let size = u32be(b, pos);
    let header = 8;
    if (size === 1 && pos + 16 <= end) {
      // A 64-bit size. Nothing that is read here is that large, but the box has to be stepped over.
      size = u32be(b, pos + 8) * 0x100000000 + u32be(b, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) {
      break;
    }
    found.push({ type: ascii(b, pos + 4, 4), start: pos + header, end: pos + size });
    pos += size;
  }
  return found;
}

export function readHeif(b: Uint8Array): HeifInfo | undefined {
  const brands = brandsOf(b);
  if (!brands.length) {
    return undefined;
  }
  const info: HeifInfo = { brands, turns: 0, orientation: 1, sequence: false };
  const top = boxes(b, 0, b.length);
  info.sequence = top.some((box) => box.type === 'moov');
  const meta = top.find((box) => box.type === 'meta');
  if (!meta) {
    return info;
  }
  // `meta` and most of what is in it start with a version byte and three flag bytes.
  const inner = boxes(b, meta.start + 4, meta.end);
  const find = (list: Box[], type: string) => list.find((box) => box.type === type);

  const pitm = find(inner, 'pitm');
  if (!pitm) {
    return info;
  }
  const primary = b[pitm.start] === 0 ? u16be(b, pitm.start + 4) : u32be(b, pitm.start + 4);

  const iinf = find(inner, 'iinf');
  if (iinf) {
    for (const infe of boxes(b, iinf.start + (b[iinf.start] === 0 ? 6 : 8), iinf.end)) {
      const version = b[infe.start];
      const id = version >= 3 ? u32be(b, infe.start + 4) : u16be(b, infe.start + 4);
      if (version >= 2 && id === primary) {
        info.codec = ascii(b, infe.start + (version >= 3 ? 10 : 8), 4);
      }
    }
  }

  const iprp = find(inner, 'iprp');
  const children = iprp ? boxes(b, iprp.start, iprp.end) : [];
  const properties = boxes(b, find(children, 'ipco')?.start ?? 0, find(children, 'ipco')?.end ?? 0);
  /** The properties each item is given, as indexes into the list above. */
  const assigned = new Map<number, number[]>();
  const ipma = find(children, 'ipma');
  if (ipma) {
    const wideId = b[ipma.start] >= 1;
    const wideIndex = (b[ipma.start + 3] & 1) !== 0;
    let pos = ipma.start + 8;
    for (let entries = u32be(b, ipma.start + 4); entries > 0 && pos + 3 <= ipma.end; entries--) {
      const id = wideId ? u32be(b, pos) : u16be(b, pos);
      pos += wideId ? 4 : 2;
      const count = b[pos++];
      const list: number[] = [];
      for (let i = 0; i < count && pos < ipma.end; i++) {
        // The top bit says "essential"; the rest is the index, counted from 1.
        list.push(wideIndex ? u16be(b, pos) & 0x7fff : b[pos] & 0x7f);
        pos += wideIndex ? 2 : 1;
      }
      assigned.set(id, list);
    }
  }
  const depthOf = (id: number): number | undefined => {
    for (const index of assigned.get(id) ?? []) {
      const box = properties[index - 1];
      if (box?.type === 'hvcC') {
        return (b[box.start + 17] & 7) + 8;
      }
      if (box?.type === 'av1C') {
        return b[box.start + 2] & 0x40 ? (b[box.start + 2] & 0x20 ? 12 : 10) : 8;
      }
    }
    return undefined;
  };

  // The transformations are applied in the order the item lists them, and a mirror before a turn is not the same
  // as after it. Any chain of them comes to one of eight: mirror left and right or not, then quarter turns clockwise.
  let flipped = false;
  let clockwise = 0;
  for (const index of assigned.get(primary) ?? []) {
    const box = properties[index - 1];
    if (!box) {
      continue;
    }
    const at = box.start;
    if (box.type === 'ispe') {
      info.width = u32be(b, at + 4);
      info.height = u32be(b, at + 8);
    } else if (box.type === 'irot') {
      info.turns = b[at] & 3;
      clockwise = (clockwise + 4 - info.turns) % 4;
    } else if (box.type === 'imir') {
      info.mirror = (b[at] & 1) as 0 | 1;
      // Mirroring after a turn is mirroring before the opposite turn; top and bottom is left and right plus a half turn.
      flipped = !flipped;
      clockwise = ((info.mirror ? 0 : 2) + 4 - clockwise) % 4;
    } else if (box.type === 'pixi') {
      info.channels = b[at + 4];
      info.bits = b[at + 5];
    } else if (box.type === 'colr') {
      const kind = ascii(b, at, 4);
      if (kind === 'nclx') {
        info.nclx = { primaries: u16be(b, at + 4), transfer: u16be(b, at + 6), matrix: u16be(b, at + 8) };
      } else if (kind === 'prof' || kind === 'rICC') {
        info.icc = b.subarray(at + 4, box.end);
      }
    }
  }
  info.orientation = flipped ? [2, 7, 4, 5][clockwise] : [1, 6, 3, 8][clockwise];
  info.bits ??= depthOf(primary);
  if (info.bits === undefined) {
    // A picture made of tiles: the tiles carry the codec settings.
    const iref = find(inner, 'iref');
    const wide = iref ? b[iref.start] >= 1 : false;
    for (const ref of iref ? boxes(b, iref.start + 4, iref.end) : []) {
      const from = wide ? u32be(b, ref.start) : u16be(b, ref.start);
      if (ref.type === 'dimg' && from === primary) {
        const first = ref.start + (wide ? 6 : 4);
        info.bits = depthOf(wide ? u32be(b, first) : u16be(b, first));
        break;
      }
    }
  }
  return info;
}
