import * as zlib from 'zlib';
import { BLOCKS } from './unicodeBlocks';

export interface Axis {
  tag: string;
  name: string;
  min: number;
  def: number;
  max: number;
}

export interface Instance {
  name: string;
  coords: number[];
}

export interface Feature {
  tag: string;
  name: string;
  /** Whether text layout applies the feature without being asked. */
  on: boolean;
}

export interface Section {
  title: string;
  rows: [string, string][];
}

export interface Face {
  family: string;
  style: string;
  summary: string;
  /** Code points the font has a glyph for, as inclusive ranges in ascending order. */
  ranges: [number, number][];
  /** Unicode blocks the font covers: name, first and last code point, number of characters present. */
  blocks: [string, number, number, number][];
  axes: Axis[];
  instances: Instance[];
  /** Features worth a switch; the full list of tags is in the sections. */
  features: Feature[];
  /** Descriptor values for an `@font-face` rule; a variable font gives ranges. An empty string leaves the descriptor out. */
  css: { weight: string; style: string; stretch: string };
  sections: Section[];
}

export interface FontFile {
  format: string;
  faces: Face[];
}

interface Source {
  format: string;
  /** One table reader per face. */
  faces: Tables[];
}

interface Tables {
  version: number;
  tags: string[];
  size(tag: string): number;
  get(tag: string): Buffer | undefined;
}

const TTCF = 0x74746366;
const WOFF = 0x774f4646;
const WOFF2 = 0x774f4632;
const OTTO = 0x4f54544f;

// Tags a WOFF2 table directory refers to by number.
const WOFF2_TAGS = (
  'cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH ' +
  'CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill'
).match(/.{4} ?/g)!.map((tag) => tag.slice(0, 4));

const FEATURE_NAMES: Record<string, string> = {
  liga: 'Standard ligatures',
  clig: 'Contextual ligatures',
  calt: 'Contextual alternates',
  kern: 'Kerning',
  dlig: 'Discretionary ligatures',
  hlig: 'Historical ligatures',
  smcp: 'Small capitals',
  c2sc: 'Small capitals from capitals',
  pcap: 'Petite capitals',
  c2pc: 'Petite capitals from capitals',
  unic: 'Unicase',
  titl: 'Titling',
  onum: 'Oldstyle figures',
  lnum: 'Lining figures',
  pnum: 'Proportional figures',
  tnum: 'Tabular figures',
  frac: 'Fractions',
  afrc: 'Alternative fractions',
  ordn: 'Ordinals',
  zero: 'Slashed zero',
  sups: 'Superscript',
  subs: 'Subscript',
  sinf: 'Scientific inferiors',
  numr: 'Numerators',
  dnom: 'Denominators',
  case: 'Case-sensitive forms',
  cpsp: 'Capital spacing',
  swsh: 'Swash',
  cswh: 'Contextual swash',
  salt: 'Stylistic alternates',
  nalt: 'Alternate annotation forms',
  hist: 'Historical forms',
  ornm: 'Ornaments',
};
const FEATURES_ON = new Set(['liga', 'clig', 'calt', 'kern']);

const AXIS_NAMES: Record<string, string> = { wght: 'Weight', wdth: 'Width', slnt: 'Slant', ital: 'Italic', opsz: 'Optical size' };

const tagAt = (data: Buffer, offset: number) => data.toString('latin1', offset, offset + 4);
const fixed = (data: Buffer, offset: number) => data.readInt32BE(offset) / 65536;

// ---- Containers -------------------------------------------------------------

function sfntTables(data: Buffer, offset: number): Tables {
  const count = data.readUInt16BE(offset + 4);
  const entries = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const record = offset + 12 + i * 16;
    entries.set(tagAt(data, record), { offset: data.readUInt32BE(record + 8), length: data.readUInt32BE(record + 12) });
  }
  return {
    version: data.readUInt32BE(offset),
    tags: [...entries.keys()],
    size: (tag) => entries.get(tag)?.length ?? 0,
    get: (tag) => {
      const entry = entries.get(tag);
      return entry && data.subarray(entry.offset, entry.offset + entry.length);
    },
  };
}

/** The most a packed table or font may unpack to. A few bytes of zlib or Brotli can claim gigabytes, in the extension host. */
const MAX_UNPACKED = 256 << 20;

function woffTables(data: Buffer): Tables {
  const count = data.readUInt16BE(12);
  const entries = new Map<string, { offset: number; packed: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const record = 44 + i * 20;
    entries.set(tagAt(data, record), { offset: data.readUInt32BE(record + 4), packed: data.readUInt32BE(record + 8), length: data.readUInt32BE(record + 12) });
  }
  return {
    version: data.readUInt32BE(4),
    tags: [...entries.keys()],
    size: (tag) => entries.get(tag)?.length ?? 0,
    get: (tag) => {
      const entry = entries.get(tag);
      if (!entry) {
        return undefined;
      }
      const raw = data.subarray(entry.offset, entry.offset + entry.packed);
      return entry.packed < entry.length ? zlib.inflateSync(raw, { maxOutputLength: Math.min(entry.length, MAX_UNPACKED) }) : raw;
    },
  };
}

function woff2Tables(data: Buffer): Tables {
  const version = data.readUInt32BE(4);
  if (version === TTCF) {
    throw new Error('WOFF2 font collections are not supported.');
  }
  const count = data.readUInt16BE(12);
  const packedSize = data.readUInt32BE(20);
  let pos = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = data[pos++];
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) {
        break;
      }
    }
    return value;
  };

  // The tables follow each other in one Brotli stream, in directory order.
  const entries = new Map<string, { offset: number; stored: number; length: number; transformed: boolean }>();
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const flags = data[pos++];
    let tag = WOFF2_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 0x3f) {
      tag = tagAt(data, pos);
      pos += 4;
    }
    const length = base128();
    // For glyf and loca, transform version 0 is the transformed form; for every other table it means "as is".
    const transformed = tag === 'glyf' || tag === 'loca' ? flags >> 6 === 0 : flags >> 6 !== 0;
    const stored = transformed ? base128() : length;
    entries.set(tag, { offset, stored, length, transformed });
    offset += stored;
  }
  let stream: Buffer | undefined;
  const start = pos;
  return {
    version,
    tags: [...entries.keys()],
    size: (tag) => entries.get(tag)?.length ?? 0,
    get: (tag) => {
      const entry = entries.get(tag);
      // Transformed tables (glyph outlines and metrics) would have to be rebuilt; nothing here reads them.
      if (!entry || entry.transformed) {
        return undefined;
      }
      stream ??= zlib.brotliDecompressSync(data.subarray(start, start + packedSize), { maxOutputLength: MAX_UNPACKED });
      return stream.subarray(entry.offset, entry.offset + entry.stored);
    },
  };
}

function open(data: Buffer): Source {
  if (data.length < 12) {
    throw new Error('The file is too short to be a font.');
  }
  const signature = data.readUInt32BE(0);
  if (signature === WOFF) {
    return { format: 'WOFF', faces: [woffTables(data)] };
  }
  if (signature === WOFF2) {
    return { format: 'WOFF2', faces: [woff2Tables(data)] };
  }
  if (signature === TTCF) {
    const count = data.readUInt32BE(8);
    const faces = Array.from({ length: count }, (_, i) => sfntTables(data, data.readUInt32BE(12 + i * 4)));
    return { format: faces.some((f) => f.version === OTTO) ? 'OpenType collection' : 'TrueType collection', faces };
  }
  if (signature === 0x00010000 || signature === OTTO || signature === 0x74727565 /* 'true' */) {
    return { format: signature === OTTO ? 'OpenType' : 'TrueType', faces: [sfntTables(data, 0)] };
  }
  throw new Error('This is not a TrueType, OpenType, WOFF or WOFF2 font.');
}

/**
 * The bytes the webview should load for one face. Browsers don't read collections,
 * so a face of a collection is copied out into a font file of its own.
 */
export function faceBytes(data: Buffer, index: number): Buffer {
  if (data.readUInt32BE(0) !== TTCF) {
    return data;
  }
  const start = data.readUInt32BE(12 + index * 4);
  const count = data.readUInt16BE(start + 4);
  const header = 12 + count * 16;
  const records = Array.from({ length: count }, (_, i) => {
    const record = start + 12 + i * 16;
    return { record, offset: data.readUInt32BE(record + 8), length: data.readUInt32BE(record + 12) };
  });
  const out = Buffer.alloc(header + records.reduce((sum, r) => sum + ((r.length + 3) & ~3), 0));
  data.copy(out, 0, start, start + header);
  let pos = header;
  records.forEach((r, i) => {
    data.copy(out, pos, r.offset, r.offset + r.length);
    out.writeUInt32BE(pos, 12 + i * 16 + 8);
    pos += (r.length + 3) & ~3;
  });
  return out;
}

// ---- Tables -----------------------------------------------------------------

/** Name strings by name ID, preferring English. */
function readNames(table: Buffer | undefined): Map<number, string> {
  const names = new Map<number, string>();
  if (!table) {
    return names;
  }
  const ranks = new Map<number, number>();
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    const platform = table.readUInt16BE(record);
    const encoding = table.readUInt16BE(record + 2);
    const language = table.readUInt16BE(record + 4);
    const id = table.readUInt16BE(record + 6);
    const raw = table.subarray(strings + table.readUInt16BE(record + 10), strings + table.readUInt16BE(record + 10) + table.readUInt16BE(record + 8));
    let rank: number;
    let text: string;
    if (platform === 3 || platform === 0) {
      rank = platform === 0 ? 3 : language === 0x409 ? 4 : 2;
      text = Buffer.from(raw.subarray(0, raw.length & ~1)).swap16().toString('utf16le');
    } else if (platform === 1 && encoding === 0) {
      rank = language === 0 ? 1 : 0;
      text = raw.toString('latin1');
    } else {
      continue;
    }
    text = text.replace(/\0/g, '').trim();
    if (text && rank > (ranks.get(id) ?? -1)) {
      ranks.set(id, rank);
      names.set(id, text);
    }
  }
  return names;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Code points that map to a glyph, from the most complete Unicode subtable of the cmap. */
function readCmap(table: Buffer | undefined): [number, number][] {
  if (!table) {
    return [];
  }
  let best = -1;
  let at = 0;
  const count = table.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const platform = table.readUInt16BE(4 + i * 8);
    const encoding = table.readUInt16BE(6 + i * 8);
    const offset = table.readUInt32BE(8 + i * 8);
    const format = table.readUInt16BE(offset);
    let score = -1;
    if ((format === 12 || format === 13) && ((platform === 3 && encoding === 10) || platform === 0)) {
      score = 5;
    } else if (format === 4 && (platform === 0 || (platform === 3 && encoding === 1))) {
      score = 4;
    } else if (format === 4 && platform === 3 && encoding === 0) {
      score = 3;
    } else if ((format === 6 || format === 0) && platform <= 1) {
      score = platform === 0 ? 2 : 1;
    }
    if (score > best) {
      best = score;
      at = offset;
    }
  }
  if (best < 0) {
    return [];
  }

  const ranges: [number, number][] = [];
  const format = table.readUInt16BE(at);
  if (format === 12 || format === 13) {
    const groups = table.readUInt32BE(at + 12);
    for (let i = 0; i < groups; i++) {
      const start = table.readUInt32BE(at + 16 + i * 12);
      const end = Math.min(table.readUInt32BE(at + 20 + i * 12), 0x10ffff);
      if (start <= end) {
        ranges.push([start, end]);
      }
    }
  } else if (format === 4) {
    const segments = table.readUInt16BE(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const offsets = deltas + segments * 2;
    // A code is looked up in the first segment that ends at or behind it, so a segment speaks only for the codes
    // behind the end of those before it. Read like that, no code is visited twice, whatever the segments claim:
    // a few thousand of them that each span the whole plane are a small file, and were gigabytes of entries.
    let next = 0;
    for (let s = 0; s < segments; s++) {
      const start = table.readUInt16BE(starts + s * 2);
      const end = table.readUInt16BE(ends + s * 2);
      const rangeOffset = table.readUInt16BE(offsets + s * 2);
      const from = Math.max(start, next);
      next = Math.max(next, end + 1);
      if (start === 0xffff || from > end) {
        continue;
      }
      if (rangeOffset === 0) {
        // The one code of the segment that would land on glyph 0, the "missing" glyph.
        const missing = (0x10000 - table.readUInt16BE(deltas + s * 2)) & 0xffff;
        if (missing >= from && missing <= end) {
          if (missing > from) {
            ranges.push([from, missing - 1]);
          }
          if (missing < end) {
            ranges.push([missing + 1, end]);
          }
        } else {
          ranges.push([from, end]);
        }
      } else {
        for (let code = from; code <= end && code < 0xffff; code++) {
          const glyph = offsets + s * 2 + rangeOffset + (code - start) * 2;
          if (glyph + 2 <= table.length && table.readUInt16BE(glyph) !== 0) {
            ranges.push([code, code]);
          }
        }
      }
    }
  } else if (format === 6) {
    const first = table.readUInt16BE(at + 6);
    const entries = table.readUInt16BE(at + 8);
    // The codes of this format are 16 bits wide, so a list that runs on behind U+FFFF maps nothing there.
    for (let i = 0; i < entries && first + i <= 0xffff; i++) {
      if (table.readUInt16BE(at + 10 + i * 2) !== 0) {
        ranges.push([first + i, first + i]);
      }
    }
  } else if (format === 0) {
    for (let code = 0; code < 256; code++) {
      if (table[at + 6 + code] !== 0) {
        ranges.push([code, code]);
      }
    }
  }
  return mergeRanges(ranges);
}

function readBlocks(ranges: [number, number][]): Face['blocks'] {
  const blocks: Face['blocks'] = [];
  let covered = 0;
  let r = 0;
  for (const [first, last, name] of BLOCKS) {
    while (r < ranges.length && ranges[r][1] < first) {
      r++;
    }
    let count = 0;
    for (let i = r; i < ranges.length && ranges[i][0] <= last; i++) {
      count += Math.min(ranges[i][1], last) - Math.max(ranges[i][0], first) + 1;
    }
    if (count) {
      blocks.push([name, first, last, count]);
      covered += count;
    }
  }
  const total = ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  if (total > covered) {
    // Newer than the block list, or not assigned to any block.
    blocks.push(['Other', 0, 0x10ffff, total - covered]);
  }
  return blocks;
}

function readAxes(table: Buffer | undefined, names: Map<number, string>): { axes: Axis[]; instances: Instance[] } {
  if (!table) {
    return { axes: [], instances: [] };
  }
  const axesOffset = table.readUInt16BE(4);
  const axisCount = table.readUInt16BE(8);
  const axisSize = table.readUInt16BE(10);
  const instanceCount = table.readUInt16BE(12);
  const instanceSize = table.readUInt16BE(14);
  const axes = Array.from({ length: axisCount }, (_, i) => {
    const at = axesOffset + i * axisSize;
    const tag = tagAt(table, at);
    return { tag, name: names.get(table.readUInt16BE(at + 18)) ?? AXIS_NAMES[tag] ?? tag, min: fixed(table, at + 4), def: fixed(table, at + 8), max: fixed(table, at + 12) };
  });
  const instances = Array.from({ length: instanceCount }, (_, i) => {
    const at = axesOffset + axisCount * axisSize + i * instanceSize;
    return { name: names.get(table.readUInt16BE(at)) ?? `Instance ${i + 1}`, coords: axes.map((_, a) => fixed(table, at + 4 + a * 4)) };
  });
  return { axes, instances };
}

/** Feature tags of a GSUB or GPOS table, with the names a font gives its stylistic sets and character variants. */
function readFeatures(table: Buffer | undefined, names: Map<number, string>, into: Map<string, string>): void {
  if (!table) {
    return;
  }
  const list = table.readUInt16BE(6);
  const count = table.readUInt16BE(list);
  for (let i = 0; i < count; i++) {
    const tag = tagAt(table, list + 2 + i * 6);
    const feature = list + table.readUInt16BE(list + 6 + i * 6);
    let name = into.get(tag) ?? '';
    const params = table.readUInt16BE(feature);
    if (!name && params && /^(ss|cv)\d\d$/.test(tag)) {
      // Both parameter tables keep the name ID of the feature's label in their second field.
      name = names.get(table.readUInt16BE(feature + params + 2)) ?? '';
    }
    into.set(tag, name);
  }
}

function featureList(tags: Map<string, string>): Feature[] {
  const features: Feature[] = [];
  for (const [tag, label] of [...tags].sort(([a], [b]) => a.localeCompare(b))) {
    const set = /^(ss|cv)(\d\d)$/.exec(tag);
    const name = set ? label || `${set[1] === 'ss' ? 'Stylistic set' : 'Character variant'} ${Number(set[2])}` : FEATURE_NAMES[tag];
    if (name) {
      features.push({ tag, name, on: FEATURES_ON.has(tag) });
    }
  }
  // The common switches first, the numbered sets after them.
  return [...features.filter((f) => FEATURE_NAMES[f.tag]), ...features.filter((f) => !FEATURE_NAMES[f.tag])];
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A head table timestamp: seconds since the start of 1904. */
function fontDate(table: Buffer, offset: number): string {
  const seconds = Number(table.readBigInt64BE(offset));
  const date = new Date(Date.UTC(1904, 0, 1) + seconds * 1000);
  // Font tools that don't know the date write the Unix epoch.
  return date.getUTCFullYear() > 1970 && date.getUTCFullYear() < 2200 ? date.toISOString().slice(0, 10) : '';
}

/** Runs one optional piece of parsing, so that a damaged table costs only its own rows. */
function attempt<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

/** `font-stretch` percentages of the nine OS/2 width classes. */
const WIDTHS = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];

function fontFaceDescriptors(axes: Axis[], os2: Buffer | undefined, head: Buffer | undefined): Face['css'] {
  const axis = (tag: string) => axes.find((a) => a.tag === tag);
  const range = (a: Axis, unit = '') => (a.min === a.max ? `${a.min}${unit}` : `${a.min}${unit} ${a.max}${unit}`);
  const wght = axis('wght');
  const wdth = axis('wdth');
  const slnt = axis('slnt');
  const weightClass = attempt(() => os2?.readUInt16BE(4), undefined);
  const width = attempt(() => os2 && WIDTHS[os2.readUInt16BE(6) - 1], undefined);
  // fsSelection in OS/2, with macStyle in head for fonts without that table.
  const italic = attempt(() => (os2 ? (os2.readUInt16BE(62) & 1) === 1 : !!head && (head.readUInt16BE(44) & 2) === 2), false);
  return {
    weight: wght ? range(wght) : weightClass ? String(weightClass) : '',
    // The axis leans clockwise with negative values, CSS with positive ones.
    style: slnt && slnt.min !== slnt.max ? `oblique ${-slnt.max}deg ${-slnt.min}deg` : italic ? 'italic' : 'normal',
    stretch: wdth ? range(wdth, '%') : width && width !== 100 ? `${width}%` : '',
  };
}

function readFace(tables: Tables, format: string): Face {
  const table = (tag: string) => attempt(() => tables.get(tag), undefined);
  const names = attempt(() => readNames(table('name')), new Map<number, string>());
  const ranges = attempt(() => readCmap(table('cmap')), []);
  const { axes, instances } = attempt(() => readAxes(table('fvar'), names), { axes: [], instances: [] });
  const tags = new Map<string, string>();
  attempt(() => readFeatures(table('GSUB'), names, tags), undefined);
  attempt(() => readFeatures(table('GPOS'), names, tags), undefined);

  const family = names.get(16) ?? names.get(1) ?? '';
  const style = names.get(17) ?? names.get(2) ?? '';
  const characters = ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  const glyphs = attempt(() => table('maxp')?.readUInt16BE(4), undefined);
  const has = (tag: string) => tables.tags.includes(tag);
  const outlines = has('glyf') ? 'TrueType' : has('CFF2') ? 'PostScript (CFF2)' : has('CFF ') ? 'PostScript (CFF)' : '';
  const color = ['COLR', 'SVG ', 'CBDT', 'sbix'].filter(has).map((tag) => tag.trim());

  const sections: Section[] = [];
  const add = (title: string, rows: [string, string | number | undefined][]) => {
    const kept = rows.filter((row): row is [string, string | number] => row[1] !== undefined && row[1] !== '').map<[string, string]>(([label, value]) => [label, String(value)]);
    if (kept.length) {
      sections.push({ title, rows: kept });
    }
  };

  add('Names', [
    ['Family', family],
    ['Style', style],
    ['Full name', names.get(4)],
    ['PostScript name', names.get(6)],
    ['Version', names.get(5)],
    ['Unique ID', names.get(3)],
    ['Designer', names.get(9)],
    ['Designer URL', names.get(12)],
    ['Manufacturer', names.get(8)],
    ['Vendor URL', names.get(11)],
    ['Description', names.get(10)],
    ['Copyright', names.get(0)],
    ['Trademark', names.get(7)],
    ['License', names.get(13)],
    ['License URL', names.get(14)],
  ]);

  const head = table('head');
  const os2 = table('OS/2');
  const post = table('post');
  const hhea = table('hhea');
  add('Font', [
    ['Format', format],
    ['Outlines', outlines],
    ['Color glyphs', color.join(', ')],
    ['Glyphs', glyphs?.toLocaleString('en-US')],
    ['Characters', characters.toLocaleString('en-US')],
    ['Units per em', attempt(() => head?.readUInt16BE(18), undefined)],
    ['Weight class', attempt(() => os2?.readUInt16BE(4), undefined)],
    ['Width class', attempt(() => os2?.readUInt16BE(6), undefined)],
    ['Italic angle', attempt(() => post && Number(fixed(post, 4).toFixed(2)) + '°', undefined)],
    ['Monospaced', attempt(() => post && (post.readUInt32BE(12) ? 'Yes' : 'No'), undefined)],
    ['Vendor', attempt(() => os2 && tagAt(os2, 58).trim(), undefined)],
    [
      'Embedding',
      attempt(() => {
        const type = os2 ? os2.readUInt16BE(8) & 0xf : -1;
        return type < 0 ? undefined : type & 2 ? 'Restricted' : type & 4 ? 'Preview and print' : type & 8 ? 'Editable' : 'Installable';
      }, undefined),
    ],
    ['Created', attempt(() => head && fontDate(head, 20), undefined)],
    ['Modified', attempt(() => head && fontDate(head, 28), undefined)],
  ]);

  add('Metrics', [
    ['Ascender', attempt(() => hhea?.readInt16BE(4), undefined)],
    ['Descender', attempt(() => hhea?.readInt16BE(6), undefined)],
    ['Line gap', attempt(() => hhea?.readInt16BE(8), undefined)],
    // Fields that were added in version 2 of the table.
    ['x-height', attempt(() => (os2 && os2.readUInt16BE(0) >= 2 && os2.readInt16BE(86)) || undefined, undefined)],
    ['Cap height', attempt(() => (os2 && os2.readUInt16BE(0) >= 2 && os2.readInt16BE(88)) || undefined, undefined)],
  ]);

  add(
    'Variable axes',
    axes.map((axis) => [`${axis.name} (${axis.tag})`, `${axis.min} to ${axis.max}, default ${axis.def}`]),
  );
  add('Layout', [
    ['Features', [...tags.keys()].sort().join(', ')],
    ['Named instances', instances.map((i) => i.name).join(', ')],
  ]);
  add('Tables', [...tables.tags].sort().map((tag) => [tag, formatSize(tables.size(tag))]));

  const summary = [
    format,
    glyphs !== undefined ? `${glyphs.toLocaleString('en-US')} glyphs` : '',
    `${characters.toLocaleString('en-US')} characters`,
    axes.length ? `variable (${axes.map((a) => a.tag).join(', ')})` : '',
    color.length ? 'color' : '',
  ];
  return { family, style, summary: summary.filter(Boolean).join(' · '), ranges, blocks: readBlocks(ranges), axes, instances, features: featureList(tags), css: fontFaceDescriptors(axes, os2, head), sections };
}

export function parseFont(data: Buffer): FontFile {
  let source: Source;
  try {
    source = open(data);
  } catch (e) {
    // A read past the end of a truncated file.
    throw e instanceof RangeError ? new Error('The font file is damaged.') : e;
  }
  return { format: source.format, faces: source.faces.map((tables) => readFace(tables, source.format)) };
}
