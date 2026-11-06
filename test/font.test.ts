import * as fs from 'fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zlib from 'zlib';
import { type Face, faceBytes, parseFont } from '../src/fontInfo';
import { random } from './helpers';

// Fonts written by hand, table by table, so every name, character and axis the parser has to find is known
// beforehand. They have no glyph outlines worth the name: fontInfo.ts never reads outlines, the browser does.

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
/** A 16.16 fixed-point number. */
const fixed = (n: number) => u32(Math.round(n * 65536));
const pad4 = (data: Uint8Array) => Buffer.concat([data, Buffer.alloc(-data.length & 3)]);

// ---- Tables -----------------------------------------------------------------------

type Tables = Record<string, Buffer>;

/** Seconds since the start of 1904, as `head` counts them. */
const fontTime = (iso: string) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt((Date.parse(iso) - Date.UTC(1904, 0, 1)) / 1000));
  return b;
};

function head(unitsPerEm: number, created: string, modified: string, macStyle = 0): Buffer {
  return Buffer.concat([u32(0x00010000), fixed(1.5), u32(0), u32(0x5f0f3cf5), u16(0), u16(unitsPerEm), fontTime(created), fontTime(modified), Buffer.alloc(8), u16(macStyle), u16(8), u16(2), u16(0), u16(0)]);
}

const hhea = (ascender: number, descender: number, lineGap: number) => Buffer.concat([u32(0x00010000), u16(ascender), u16(descender), u16(lineGap), Buffer.alloc(26)]);
const maxp = (glyphs: number) => Buffer.concat([u32(0x00010000), u16(glyphs), Buffer.alloc(26)]);
const post = (italicAngle: number, monospaced: boolean) => Buffer.concat([u32(0x00030000), fixed(italicAngle), u16(-100), u16(50), u32(monospaced ? 1 : 0), Buffer.alloc(16)]);

interface Os2 {
  weight: number;
  width: number;
  /** fsType: 0 installable, 2 restricted, 4 preview and print, 8 editable. */
  embedding?: number;
  vendor?: string;
  italic?: boolean;
  xHeight?: number;
  capHeight?: number;
}

/** Version 4 of the table: 96 bytes. */
function os2(spec: Os2): Buffer {
  const table = Buffer.alloc(96);
  table.writeUInt16BE(4, 0);
  table.writeUInt16BE(spec.weight, 4);
  table.writeUInt16BE(spec.width, 6);
  table.writeUInt16BE(spec.embedding ?? 0, 8);
  table.write(spec.vendor ?? 'TEST', 58, 'latin1');
  table.writeUInt16BE(spec.italic ? 0x01 : 0x40, 62);
  table.writeInt16BE(spec.xHeight ?? 0, 86);
  table.writeInt16BE(spec.capHeight ?? 0, 88);
  return table;
}

/** A name record: Windows Unicode in US English unless said otherwise. Platform 1 is Mac Roman. */
type Name = [id: number, text: string, platform?: number, language?: number];

function name(records: Name[]): Buffer {
  const strings: Buffer[] = [];
  let offset = 0;
  const rows = records.map(([id, text, platform = 3, language = platform === 3 ? 0x409 : 0]) => {
    const raw = platform === 1 ? latin(text) : Buffer.from(text, 'utf16le').swap16();
    strings.push(raw);
    offset += raw.length;
    return Buffer.concat([u16(platform), u16(platform === 3 ? 1 : 0), u16(language), u16(id), u16(raw.length), u16(offset - raw.length)]);
  });
  return Buffer.concat([u16(0), u16(records.length), u16(6 + rows.length * 12), ...rows, ...strings]);
}

/** A segment of a format 4 subtable: codes `start` to `end` map to glyphs by adding `delta`, or through `glyphs`, one per code. */
interface Segment {
  start: number;
  end: number;
  delta?: number;
  glyphs?: number[];
}

function cmap4(segments: Segment[]): Buffer {
  const all = [...segments, { start: 0xffff, end: 0xffff, delta: 1 }];
  const count = all.length;
  const glyphArray: number[] = [];
  const rangeOffsets = all.map((segment, i) => {
    if (!segment.glyphs) {
      return 0;
    }
    // Counted in bytes from the offset's own place to the segment's first glyph.
    const offset = (count - i + glyphArray.length) * 2;
    glyphArray.push(...segment.glyphs);
    return offset;
  });
  const body = Buffer.concat([
    ...all.map((s) => u16(s.end)),
    u16(0),
    ...all.map((s) => u16(s.start)),
    ...all.map((s) => u16(s.delta ?? 0)),
    ...rangeOffsets.map(u16),
    ...glyphArray.map(u16),
  ]);
  return Buffer.concat([u16(4), u16(14 + body.length), u16(0), u16(count * 2), u16(0), u16(0), u16(0), body]);
}

/** A format 12 subtable: groups of [first code, last code, first glyph]. */
const cmap12 = (groups: [number, number, number][]) => Buffer.concat([u16(12), u16(0), u32(16 + groups.length * 12), u32(0), u32(groups.length), ...groups.flatMap((group) => group.map(u32))]);

function cmap(subtables: [platform: number, encoding: number, data: Buffer][]): Buffer {
  let offset = 4 + subtables.length * 8;
  const records = subtables.map(([platform, encoding, data]) => {
    const record = Buffer.concat([u16(platform), u16(encoding), u32(offset)]);
    offset += data.length;
    return record;
  });
  return Buffer.concat([u16(0), u16(subtables.length), ...records, ...subtables.map(([, , data]) => data)]);
}

/** A variation axis: tag, range, default, and the name ID of its label. */
type AxisSpec = [tag: string, min: number, def: number, max: number, nameId: number];

function fvar(axes: AxisSpec[], instances: [nameId: number, coords: number[]][]): Buffer {
  return Buffer.concat([
    u32(0x00010000),
    u16(16),
    u16(2),
    u16(axes.length),
    u16(20),
    u16(instances.length),
    u16(4 + axes.length * 4),
    ...axes.flatMap(([tag, min, def, max, nameId]) => [latin(tag), fixed(min), fixed(def), fixed(max), u16(0), u16(nameId)]),
    ...instances.flatMap(([nameId, coords]) => [u16(nameId), u16(0), ...coords.map(fixed)]),
  ]);
}

/** A GSUB or GPOS table with a feature list and nothing behind it. A feature may name the ID of its label, as stylistic sets do. */
function layout(features: [tag: string, labelNameId?: number][]): Buffer {
  const tables = features.map(([, label]) => (label === undefined ? Buffer.concat([u16(0), u16(0)]) : Buffer.concat([u16(4), u16(0), u16(0), u16(label)])));
  let offset = 2 + features.length * 6;
  const records = features.map(([tag], i) => {
    const record = Buffer.concat([latin(tag), u16(offset)]);
    offset += tables[i].length;
    return record;
  });
  // Version, then the offsets of the script, feature and lookup lists; the scripts take the four bytes in between.
  return Buffer.concat([u32(0x00010000), u16(10), u16(14), u16(0), Buffer.alloc(4), u16(features.length), ...records, ...tables]);
}

// ---- Containers -------------------------------------------------------------------

function checksum(data: Uint8Array): number {
  const padded = pad4(data);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) {
    sum = (sum + padded.readUInt32BE(i)) >>> 0;
  }
  return sum;
}

const TRUETYPE = 0x00010000;
const OTTO = 0x4f54544f;

/** A font file: the table directory with checksums, the tables in tag order on 4-byte boundaries. */
function sfnt(tables: Tables, version = TRUETYPE): Buffer {
  const tags = Object.keys(tables).sort();
  const selector = Math.floor(Math.log2(tags.length));
  let offset = 12 + tags.length * 16;
  const records = tags.map((tag) => {
    const record = Buffer.concat([latin(tag), u32(checksum(tables[tag])), u32(offset), u32(tables[tag].length)]);
    offset += pad4(tables[tag]).length;
    return record;
  });
  const file = Buffer.concat([u32(version), u16(tags.length), u16(16 << selector), u16(selector), u16(tags.length * 16 - (16 << selector)), ...records, ...tags.map((tag) => pad4(tables[tag]))]);
  // The whole file sums to a magic number once `head` holds the difference.
  const headAt = tables.head ? file.readUInt32BE(12 + tags.indexOf('head') * 16 + 8) : -1;
  if (headAt > 0) {
    file.writeUInt32BE((0xb1b0afba - checksum(file)) >>> 0, headAt + 8);
  }
  return file;
}

/** WOFF: the same tables, each deflated on its own when that makes it smaller. The tables in `plain` are stored as they are, which a writer may always do. */
function woff(tables: Tables, plain: string[] = [], flavor = TRUETYPE): Buffer {
  const tags = Object.keys(tables).sort();
  let offset = 44 + tags.length * 20;
  const stored: Buffer[] = [];
  const records = tags.map((tag) => {
    const packed = zlib.deflateSync(tables[tag]);
    const data = packed.length < tables[tag].length && !plain.includes(tag) ? packed : tables[tag];
    stored.push(pad4(data));
    const record = Buffer.concat([latin(tag), u32(offset), u32(data.length), u32(tables[tag].length), u32(checksum(tables[tag]))]);
    offset += pad4(data).length;
    return record;
  });
  return Buffer.concat([latin('wOFF'), u32(flavor), u32(offset), u16(tags.length), u16(0), u32(sfnt(tables).length), Buffer.alloc(24), ...records, ...stored]);
}

/** The tags a WOFF2 directory names by number (the "known table tags" of the specification), as far as these fonts go. */
const WOFF2_KNOWN: Record<string, number> = { cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, 'OS/2': 6, post: 7, glyf: 10, loca: 11, GPOS: 27, GSUB: 28, COLR: 34, fvar: 47 };

/** A number in 7-bit groups, most significant first, all but the last with the top bit set. */
function base128(n: number): Buffer {
  const groups = [n & 0x7f];
  for (let rest = n >>> 7; rest; rest >>>= 7) {
    groups.unshift((rest & 0x7f) | 0x80);
  }
  return Buffer.from(groups);
}

/**
 * WOFF2: a directory of [flags, original length, and for a transformed table the stored length], then every
 * table in one Brotli stream. `transformed` tables are stored as the given bytes instead of their own.
 */
function woff2(tables: Tables, order: string[], transformed: Record<string, Buffer> = {}, flavor = TRUETYPE): Buffer {
  const directory = order.map((tag) => {
    const outline = tag === 'glyf' || tag === 'loca';
    // Transform version 3 means "as it is" for the outline tables, whose version 0 is their transformed form; for the rest 0 does.
    const version = transformed[tag] ? (outline ? 0 : 1) : outline ? 3 : 0;
    const known = WOFF2_KNOWN[tag];
    return Buffer.concat([Buffer.from([(version << 6) | (known ?? 63)]), known === undefined ? latin(tag) : Buffer.alloc(0), base128(tables[tag].length), transformed[tag] ? base128(transformed[tag].length) : Buffer.alloc(0)]);
  });
  const stream = zlib.brotliCompressSync(Buffer.concat(order.map((tag) => transformed[tag] ?? tables[tag])));
  const header = Buffer.concat([latin('wOF2'), u32(flavor), u32(0), u16(order.length), u16(0), u32(sfnt(tables).length), u32(stream.length), Buffer.alloc(24)]);
  const file = Buffer.concat([header, ...directory, stream]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

/** A collection: every face has its own directory, and a table that several faces use is stored once. */
function ttc(faces: [tables: Tables, version?: number][]): Buffer {
  const unique = [...new Set(faces.flatMap(([tables]) => Object.values(tables)))];
  let offset = 12 + faces.length * 4 + faces.reduce((sum, [tables]) => sum + 12 + Object.keys(tables).length * 16, 0);
  const placed = new Map<Buffer, number>();
  for (const table of unique) {
    placed.set(table, offset);
    offset += pad4(table).length;
  }
  let directoryAt = 12 + faces.length * 4;
  const offsets: Buffer[] = [];
  const directories = faces.map(([tables, version = TRUETYPE]) => {
    const tags = Object.keys(tables).sort();
    offsets.push(u32(directoryAt));
    directoryAt += 12 + tags.length * 16;
    return Buffer.concat([u32(version), u16(tags.length), Buffer.alloc(6), ...tags.map((tag) => Buffer.concat([latin(tag), u32(checksum(tables[tag])), u32(placed.get(tables[tag]) as number), u32(tables[tag].length)]))]);
  });
  return Buffer.concat([latin('ttcf'), u32(0x00010000), u32(faces.length), ...offsets, ...directories, ...unique.map(pad4)]);
}

/** The tables of a font file by tag, read from its directory by the test itself. */
function tablesOf(file: Buffer): Tables {
  const tables: Tables = {};
  for (let i = 0; i < file.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    const [offset, length] = [file.readUInt32BE(record + 8), file.readUInt32BE(record + 12)];
    assert.ok(offset % 4 === 0 && offset + length <= file.length, `table ${i} at ${offset}`);
    tables[file.toString('latin1', record, record + 4)] = file.subarray(offset, offset + length);
  }
  return tables;
}

// ---- The fonts of these tests -----------------------------------------------------

const NAMES: Name[] = [
  [0, '© 2024 Example Type'],
  // Family and style as old programs want them, and the typographic pair that goes before them.
  [1, 'Testa Sans Cond'],
  [2, 'Bold Italic'],
  [16, 'Testa Sans'],
  [17, 'Condensed Bold Italic'],
  [4, 'Testa Sans Condensed Bold Italic'],
  [5, 'Version 1.500'],
  [6, 'TestaSans-CondBoldItalic'],
  [9, 'Jane Doe'],
  [13, 'SIL Open Font License 1.1'],
  // The same IDs in other tongues and on the Mac: English for Windows is preferred to all of them.
  [1, 'Mac Name', 1],
  [16, 'Testa Grotesk', 3, 0x407],
  [4, 'Mac Full Name', 1],
  // Labels the other tables refer to.
  [256, 'Weight axis'],
  [257, 'Heavy'],
  [258, 'Alternate a'],
];

/** Latin with gaps: a whole segment, one with a code that maps to the missing glyph, one that goes through a glyph list with holes. */
const SEGMENTS: Segment[] = [
  { start: 0x20, end: 0x7e, delta: -0x1f },
  { start: 0xa0, end: 0xaf, delta: -0xa5 },
  { start: 0x410, end: 0x414, glyphs: [5, 0, 6, 0, 7] },
];
const RANGES: [number, number][] = [[0x20, 0x7e], [0xa0, 0xa4], [0xa6, 0xaf], [0x410, 0x410], [0x412, 0x412], [0x414, 0x414]];

const STATIC: Tables = {
  head: head(2048, '2024-03-15T00:00:00Z', '2025-01-02T12:00:00Z'),
  hhea: hhea(1900, -500, 0),
  maxp: maxp(1234),
  'OS/2': os2({ weight: 700, width: 3, embedding: 8, vendor: 'TEST', italic: true, xHeight: 1000, capHeight: 1400 }),
  name: name(NAMES),
  cmap: cmap([[3, 1, cmap4(SEGMENTS)]]),
  post: post(-12.5, false),
  glyf: Buffer.alloc(10),
  loca: Buffer.alloc(6),
  GSUB: layout([['liga'], ['smcp'], ['ss01', 258], ['ss02'], ['cv05'], ['zzzz']]),
  GPOS: layout([['kern'], ['mark']]),
};

const VARIABLE: Tables = {
  ...STATIC,
  'OS/2': os2({ weight: 400, width: 5, xHeight: 1000, capHeight: 1400 }),
  // Beyond the first plane, where only format 12 reaches; the format 4 table beside it is the fallback for old programs.
  cmap: cmap([
    [3, 1, cmap4([{ start: 0x20, end: 0x7e, delta: -0x1f }])],
    [3, 10, cmap12([[0x20, 0x7e, 1], [0x7f, 0x80, 96], [0x400, 0x4ff, 100], [0x870, 0x871, 400], [0x1f600, 0x1f64f, 500]])],
  ]),
  fvar: fvar(
    [
      ['wght', 100, 400, 900, 256],
      ['wdth', 75, 100, 125, 300],
    ],
    [
      [257, [900, 100]],
      [999, [100, 75]],
    ],
  ),
};

const face = (tables: Tables, version = TRUETYPE): Face => parseFont(sfnt(tables, version)).faces[0];
const section = (parsed: Face, title: string): Record<string, string> => Object.fromEntries(parsed.sections.find((s) => s.title === title)?.rows ?? []);

// ---- Names, characters, features --------------------------------------------------

test('the font file of these tests is well-formed: its words sum to the magic number', () => {
  assert.equal(checksum(sfnt(STATIC)), 0xb1b0afba);
  assert.deepEqual(Object.keys(tablesOf(sfnt(STATIC))).sort(), Object.keys(STATIC).sort());
});

test('names: the typographic family and style go first, English for Windows before other records', () => {
  const parsed = parseFont(sfnt(STATIC));
  assert.equal(parsed.format, 'TrueType');
  assert.equal(parsed.faces.length, 1);
  const [only] = parsed.faces;
  assert.deepEqual([only.family, only.style], ['Testa Sans', 'Condensed Bold Italic']);
  assert.deepEqual(section(only, 'Names'), {
    Family: 'Testa Sans',
    Style: 'Condensed Bold Italic',
    'Full name': 'Testa Sans Condensed Bold Italic',
    'PostScript name': 'TestaSans-CondBoldItalic',
    Version: 'Version 1.500',
    Designer: 'Jane Doe',
    Copyright: '© 2024 Example Type',
    License: 'SIL Open Font License 1.1',
  });
});

test('names: without the typographic pair the plain family and style are used, from the Mac records if need be', () => {
  const plain = face({ ...STATIC, name: name([[1, 'Plain'], [2, 'Regular']]) });
  assert.deepEqual([plain.family, plain.style], ['Plain', 'Regular']);
  const mac = face({ ...STATIC, name: name([[1, 'Caf\xe9 Mac', 1], [2, 'Roman', 1], [1, 'Nicht englisch', 1, 2]]) });
  assert.deepEqual([mac.family, mac.style], ['Café Mac', 'Roman']);
  // Unicode platform records count as well, below English for Windows.
  const unicode = face({ ...STATIC, name: name([[1, 'Unicode Name', 0], [1, 'Mac Name', 1]]) });
  assert.equal(unicode.family, 'Unicode Name');
  const nameless = face({ ...STATIC, name: name([]) });
  assert.deepEqual([nameless.family, nameless.style, section(nameless, 'Names')], ['', '', {}]);
});

test('characters: format 4 segments by delta and by glyph list, without the codes that map to the missing glyph', () => {
  const parsed = face(STATIC);
  assert.deepEqual(parsed.ranges, RANGES);
  // 95 + 5 + 10 + 3 characters, in the three blocks they belong to.
  assert.deepEqual(parsed.blocks, [
    ['Basic Latin', 0x0, 0x7f, 95],
    ['Latin-1 Supplement', 0x80, 0xff, 15],
    ['Cyrillic', 0x400, 0x4ff, 3],
  ]);
  assert.equal(section(parsed, 'Font').Characters, '113');
});

test('characters: a format 12 table is preferred, reaches beyond the first plane, and touching groups are merged', () => {
  const parsed = face(VARIABLE);
  assert.deepEqual(parsed.ranges, [[0x20, 0x80], [0x400, 0x4ff], [0x870, 0x871], [0x1f600, 0x1f64f]]);
  assert.deepEqual(parsed.blocks, [
    ['Basic Latin', 0x0, 0x7f, 96],
    ['Latin-1 Supplement', 0x80, 0xff, 1],
    ['Cyrillic', 0x400, 0x4ff, 256],
    ['Emoticons', 0x1f600, 0x1f64f, 80],
    // U+0870 had no block in the Unicode version the list was made from.
    ['Other', 0, 0x10ffff, 2],
  ]);
});

test('characters: the subtable is chosen by what it covers, not by where it stands', () => {
  const twelve = cmap12([[0x41, 0x5a, 1]]);
  const four = cmap4([{ start: 0x61, end: 0x7a, delta: 1 }]);
  const symbol = cmap4([{ start: 0xf020, end: 0xf07e, delta: 1 }]);
  const mac = Buffer.concat([u16(0), u16(262), u16(0), Buffer.from(Array.from({ length: 256 }, (_, code) => (code >= 0x30 && code <= 0x39 ? 1 : 0)))]);
  const trimmed = Buffer.concat([u16(6), u16(16), u16(0), u16(0x100), u16(3), u16(9), u16(0), u16(9)]);
  const ranges = (...subtables: [number, number, Buffer][]) => face({ ...STATIC, cmap: cmap(subtables) }).ranges;
  assert.deepEqual(ranges([1, 0, mac], [3, 1, four], [3, 10, twelve]), [[0x41, 0x5a]]);
  assert.deepEqual(ranges([0, 4, twelve], [3, 1, four]), [[0x41, 0x5a]]);
  assert.deepEqual(ranges([3, 0, symbol], [1, 0, mac], [0, 3, four]), [[0x61, 0x7a]]);
  assert.deepEqual(ranges([1, 0, mac], [3, 0, symbol]), [[0xf020, 0xf07e]]);
  assert.deepEqual(ranges([1, 0, mac]), [[0x30, 0x39]]);
  // Format 6: a first code and a list of glyphs, where 0 is "none".
  assert.deepEqual(ranges([0, 3, trimmed]), [[0x100, 0x100], [0x102, 0x102]]);
  // Nothing that is Unicode or Mac Roman: no characters, rather than a guess.
  assert.deepEqual(ranges([3, 3, four]), []);
});

test('characters: groups that are upside down or run past the last code point do no harm', () => {
  const parsed = face({ ...STATIC, cmap: cmap([[3, 10, cmap12([[0x50, 0x41, 1], [0x10fff0, 0x7fffffff, 2], [0x41, 0x42, 3]])]]) });
  assert.deepEqual(parsed.ranges, [[0x41, 0x42], [0x10fff0, 0x10ffff]]);
});

test('features: the well-known ones as switches with their names, numbered sets after them, the rest only listed', () => {
  const parsed = face(STATIC);
  assert.deepEqual(parsed.features, [
    { tag: 'kern', name: 'Kerning', on: true },
    { tag: 'liga', name: 'Standard ligatures', on: true },
    { tag: 'smcp', name: 'Small capitals', on: false },
    { tag: 'cv05', name: 'Character variant 5', on: false },
    // The font names its first stylistic set; the second has to do with its number.
    { tag: 'ss01', name: 'Alternate a', on: false },
    { tag: 'ss02', name: 'Stylistic set 2', on: false },
  ]);
  assert.equal(section(parsed, 'Layout').Features, 'cv05, kern, liga, mark, smcp, ss01, ss02, zzzz');
  assert.deepEqual(face({ ...STATIC, GSUB: layout([]), GPOS: layout([]) }).features, []);
});

test('features: a feature that both tables list appears once', () => {
  const parsed = face({ ...STATIC, GSUB: layout([['calt'], ['ss03', 258]]), GPOS: layout([['calt'], ['ss03']]) });
  assert.deepEqual(parsed.features, [
    { tag: 'calt', name: 'Contextual alternates', on: true },
    { tag: 'ss03', name: 'Alternate a', on: false },
  ]);
});

// ---- Details ----------------------------------------------------------------------

test('the details: outlines, counts, metrics, dates and embedding come from their tables', () => {
  const parsed = face(STATIC);
  assert.deepEqual(section(parsed, 'Font'), {
    Format: 'TrueType',
    Outlines: 'TrueType',
    Glyphs: '1,234',
    Characters: '113',
    'Units per em': '2048',
    'Weight class': '700',
    'Width class': '3',
    'Italic angle': '-12.5°',
    Monospaced: 'No',
    Vendor: 'TEST',
    Embedding: 'Editable',
    Created: '2024-03-15',
    Modified: '2025-01-02',
  });
  assert.deepEqual(section(parsed, 'Metrics'), { Ascender: '1900', Descender: '-500', 'Line gap': '0', 'x-height': '1000', 'Cap height': '1400' });
  assert.equal(parsed.summary, 'TrueType · 1,234 glyphs · 113 characters');
  assert.deepEqual(Object.keys(section(parsed, 'Tables')), Object.keys(STATIC).sort());
  assert.equal(section(parsed, 'Tables')['OS/2'], '96 B');
});

test('the details: embedding permissions, fixed pitch, and a date nobody set', () => {
  const embedding = (bits: number) => section(face({ ...STATIC, 'OS/2': os2({ weight: 400, width: 5, embedding: bits }) }), 'Font').Embedding;
  assert.deepEqual([0, 2, 4, 8].map(embedding), ['Installable', 'Restricted', 'Preview and print', 'Editable']);
  // Restricted wins when a font sets several bits.
  assert.equal(embedding(2 | 8), 'Restricted');
  const mono = section(face({ ...STATIC, post: post(0, true), head: head(1000, '1970-01-01T00:00:00Z', '1904-01-01T00:00:00Z') }), 'Font');
  assert.deepEqual([mono.Monospaced, mono['Italic angle'], mono['Units per em'], mono.Created, mono.Modified], ['Yes', '0°', '1000', undefined, undefined]);
});

test('the details: PostScript outlines and color glyphs are named', () => {
  const { glyf: _glyf, loca: _loca, ...rest } = STATIC;
  const cff = parseFont(sfnt({ ...rest, 'CFF ': Buffer.alloc(8), COLR: Buffer.alloc(14), 'SVG ': Buffer.alloc(10) }, OTTO));
  assert.equal(cff.format, 'OpenType');
  assert.deepEqual([section(cff.faces[0], 'Font').Format, section(cff.faces[0], 'Font').Outlines, section(cff.faces[0], 'Font')['Color glyphs']], ['OpenType', 'PostScript (CFF)', 'COLR, SVG']);
  assert.equal(cff.faces[0].summary, 'OpenType · 1,234 glyphs · 113 characters · color');
  assert.equal(section(face({ ...rest, CFF2: Buffer.alloc(8) }, OTTO), 'Font').Outlines, 'PostScript (CFF2)');
  assert.equal(section(face(rest), 'Font').Outlines, undefined);
});

// ---- Variable fonts and the @font-face descriptors --------------------------------

test('variable axes and named instances are read, with names from the font or from the registered tags', () => {
  const parsed = face(VARIABLE);
  assert.deepEqual(parsed.axes, [
    { tag: 'wght', name: 'Weight axis', min: 100, def: 400, max: 900 },
    // Its name ID is not in the name table.
    { tag: 'wdth', name: 'Width', min: 75, def: 100, max: 125 },
  ]);
  assert.deepEqual(parsed.instances, [
    { name: 'Heavy', coords: [900, 100] },
    { name: 'Instance 2', coords: [100, 75] },
  ]);
  assert.deepEqual(section(parsed, 'Variable axes'), { 'Weight axis (wght)': '100 to 900, default 400', 'Width (wdth)': '75 to 125, default 100' });
  assert.equal(section(parsed, 'Layout')['Named instances'], 'Heavy, Instance 2');
  assert.equal(parsed.summary, 'TrueType · 1,234 glyphs · 435 characters · variable (wght, wdth)');
  assert.deepEqual([face(STATIC).axes, face(STATIC).instances, section(face(STATIC), 'Variable axes')], [[], [], {}]);
});

test('axes with fractions, and one the registry does not know', () => {
  const parsed = face({ ...STATIC, fvar: fvar([['opsz', 8.5, 12, 144, 300], ['GRAD', -0.5, 0, 1, 300]], []) });
  assert.deepEqual(parsed.axes, [
    { tag: 'opsz', name: 'Optical size', min: 8.5, def: 12, max: 144 },
    { tag: 'GRAD', name: 'GRAD', min: -0.5, def: 0, max: 1 },
  ]);
});

test('@font-face descriptors of a static font come from OS/2: weight, italic, and a width other than normal', () => {
  assert.deepEqual(face(STATIC).css, { weight: '700', style: 'italic', stretch: '75%' });
  assert.deepEqual(face({ ...STATIC, 'OS/2': os2({ weight: 400, width: 5 }) }).css, { weight: '400', style: 'normal', stretch: '' });
  // The nine width classes, as the percentages CSS gives them.
  const stretch = (width: number) => face({ ...STATIC, 'OS/2': os2({ weight: 400, width }) }).css.stretch;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(stretch), ['50%', '62.5%', '75%', '87.5%', '', '112.5%', '125%', '150%', '200%']);
  assert.equal(stretch(0), '');
  assert.equal(stretch(12), '');
});

test('@font-face descriptors without an OS/2 table: the style bits of head say italic, the weight is left out', () => {
  const { 'OS/2': _os2, ...rest } = STATIC;
  assert.deepEqual(face({ ...rest, head: head(1000, '2024-03-15T00:00:00Z', '2024-03-15T00:00:00Z', 0x02) }).css, { weight: '', style: 'italic', stretch: '' });
  // Bold alone (bit 0) is not italic.
  assert.deepEqual(face({ ...rest, head: head(1000, '2024-03-15T00:00:00Z', '2024-03-15T00:00:00Z', 0x01) }).css, { weight: '', style: 'normal', stretch: '' });
});

test('@font-face descriptors of a variable font are the ranges of its axes', () => {
  assert.deepEqual(face(VARIABLE).css, { weight: '100 900', style: 'normal', stretch: '75% 125%' });
  // Italic is no axis here: it stays what OS/2 says.
  assert.deepEqual(face({ ...VARIABLE, 'OS/2': STATIC['OS/2'] }).css, { weight: '100 900', style: 'italic', stretch: '75% 125%' });
  // A slant axis leans clockwise with negative values, CSS with positive ones: −12 to 0 is "oblique 0deg 12deg".
  const slanted = face({ ...VARIABLE, 'OS/2': os2({ weight: 400, width: 5 }), fvar: fvar([['slnt', -12, 0, 0, 300], ['wght', 300, 300, 300, 300]], []) });
  assert.deepEqual(slanted.css, { weight: '300', style: 'oblique 0deg 12deg', stretch: '' });
  // An axis that can't move says nothing about the style.
  const fixedSlant = face({ ...VARIABLE, 'OS/2': os2({ weight: 400, width: 5 }), fvar: fvar([['slnt', -8, -8, -8, 300]], []) });
  assert.equal(fixedSlant.css.style, 'normal');
});

// ---- WOFF, WOFF2, collections -----------------------------------------------------

/** What a face says apart from the name of its container. */
function content(parsed: Face): unknown {
  return {
    ...parsed,
    summary: parsed.summary.replace(/^[^·]+/, ''),
    sections: parsed.sections.map((s) => (s.title === 'Font' ? { ...s, rows: s.rows.filter(([label]) => label !== 'Format') } : s)),
  };
}

test('WOFF: the same face comes out of tables that are deflated one by one', () => {
  for (const tables of [STATIC, VARIABLE]) {
    // Names and characters are stored as they are, the rest deflated where that helps: both ways are read.
    const file = woff(tables, ['name', 'cmap']);
    const packed = Object.keys(tables).map((_, i) => file.readUInt32BE(44 + i * 20 + 8) < file.readUInt32BE(44 + i * 20 + 12));
    assert.ok(packed.filter(Boolean).length > 3 && packed.filter((is) => !is).length >= 2);
    const parsed = parseFont(file);
    assert.equal(parsed.format, 'WOFF');
    assert.deepEqual(content(parsed.faces[0]), content(face(tables)));
    assert.equal(section(parsed.faces[0], 'Font').Format, 'WOFF');
    assert.equal(section(parsed.faces[0], 'Font').Outlines, 'TrueType');
  }
});

test('WOFF2: the same face comes out of one Brotli stream, whatever the order of the tables', () => {
  for (const tables of [STATIC, VARIABLE]) {
    const tags = Object.keys(tables);
    for (const order of [tags, [...tags].reverse(), [...tags].sort()]) {
      const parsed = parseFont(woff2(tables, order));
      assert.equal(parsed.format, 'WOFF2');
      assert.deepEqual({ ...(content(parsed.faces[0]) as Face), sections: [] }, { ...(content(face(tables)) as Face), sections: [] });
      assert.deepEqual(section(parsed.faces[0], 'Names'), section(face(tables), 'Names'));
      assert.deepEqual(section(parsed.faces[0], 'Tables'), section(face(tables), 'Tables'));
    }
  }
});

test('WOFF2: a transformed table is stepped over by its stored length, and a tag outside the known list is spelled out', () => {
  // The outline tables in their transformed form, shorter than the originals, in front of everything else:
  // every table behind them is found only when their stored size is counted, not their original one.
  const tables: Tables = { ...VARIABLE, glyf: Buffer.alloc(400, 7), loca: Buffer.alloc(120, 8), hmtx: Buffer.alloc(64, 9), zzzz: latin('some private table') };
  const order = ['glyf', 'loca', 'hmtx', 'zzzz', ...Object.keys(VARIABLE).filter((tag) => tag !== 'glyf' && tag !== 'loca')];
  const parsed = parseFont(woff2(tables, order, { glyf: Buffer.alloc(33, 1), loca: Buffer.alloc(0), hmtx: Buffer.alloc(17, 2) })).faces[0];
  const plain = face(tables);
  assert.deepEqual([parsed.family, parsed.ranges, parsed.axes, parsed.features, parsed.css], [plain.family, plain.ranges, plain.axes, plain.features, plain.css]);
  assert.deepEqual(section(parsed, 'Metrics'), section(plain, 'Metrics'));
  // The sizes in the table list are those of the original tables.
  assert.deepEqual(section(parsed, 'Tables'), section(plain, 'Tables'));
  assert.equal(section(parsed, 'Font').Outlines, 'TrueType');
});

test('a collection lists every face, and tells TrueType collections from OpenType ones', () => {
  const second: Tables = { ...VARIABLE, name: name([[1, 'Testa Serif'], [2, 'Regular']]) };
  const parsed = parseFont(ttc([[STATIC], [second]]));
  assert.equal(parsed.format, 'TrueType collection');
  assert.deepEqual(parsed.faces.map((f) => [f.family, f.style, f.axes.length]), [['Testa Sans', 'Condensed Bold Italic', 0], ['Testa Serif', 'Regular', 2]]);
  assert.deepEqual(content(parsed.faces[0]), content(face(STATIC)));
  assert.deepEqual(content(parsed.faces[1]), content(face(second)));
  const { glyf: _glyf, loca: _loca, ...rest } = STATIC;
  assert.equal(parseFont(ttc([[STATIC], [{ ...rest, 'CFF ': Buffer.alloc(8) }, OTTO]])).format, 'OpenType collection');
});

test('a face of a collection is copied out as a font file of its own that parses to the same face', () => {
  const second: Tables = { ...VARIABLE, name: name([[1, 'Testa Serif'], [2, 'Regular']]), 'odd ': latin('7 bytes') };
  const collection = ttc([[STATIC], [second], [{ ...STATIC, 'CFF ': Buffer.alloc(8) }, OTTO]]);
  const parsed = parseFont(collection);
  [STATIC, second].forEach((tables, index) => {
    const single = faceBytes(collection, index);
    assert.equal(single.readUInt32BE(0), TRUETYPE);
    // Every table is there, whole, on a 4-byte boundary and inside the file.
    assert.deepEqual(tablesOf(single), tables);
    const alone = parseFont(single);
    assert.equal(alone.format, 'TrueType');
    assert.equal(alone.faces.length, 1);
    assert.deepEqual(content(alone.faces[0]), content(parsed.faces[index]));
  });
  assert.equal(faceBytes(collection, 2).readUInt32BE(0), OTTO);
  // The copy is a font of its own: it shares no bytes with the collection.
  assert.ok(faceBytes(collection, 1).length < collection.length);
});

test('a file that is no collection is handed to the browser as it is', () => {
  for (const file of [sfnt(STATIC), woff(STATIC), woff2(STATIC, Object.keys(STATIC))]) {
    assert.equal(faceBytes(file, 0), file);
  }
});

// ---- Damage -----------------------------------------------------------------------

test('what is not a font is refused in words', () => {
  assert.throws(() => parseFont(Buffer.alloc(0)), /too short to be a font/);
  assert.throws(() => parseFont(latin('wOFF')), /too short to be a font/);
  assert.throws(() => parseFont(latin('This is not a font at all.')), /not a TrueType, OpenType, WOFF or WOFF2 font/);
  assert.throws(() => parseFont(Buffer.concat([latin('wOF2'), latin('ttcf'), Buffer.alloc(60)])), /WOFF2 font collections are not supported/);
  // Apple's old signature for TrueType is a font.
  assert.equal(parseFont(sfnt(STATIC, 0x74727565)).format, 'TrueType');
});

test('a damaged table costs only its own rows', () => {
  const sound = face(VARIABLE);
  const junk = random(61).bytes(40);
  const without = (tag: string, data: Buffer) => face({ ...VARIABLE, [tag]: data });

  const noAxes = without('fvar', Buffer.from([0, 1, 0]));
  assert.deepEqual([noAxes.axes, noAxes.instances], [[], []]);
  assert.deepEqual([noAxes.family, noAxes.ranges, noAxes.features, section(noAxes, 'Metrics')], [sound.family, sound.ranges, sound.features, section(sound, 'Metrics')]);
  // Without the axes the descriptors fall back on OS/2.
  assert.deepEqual(noAxes.css, { weight: '400', style: 'normal', stretch: '' });

  const noCharacters = without('cmap', VARIABLE.cmap.subarray(0, 30));
  assert.deepEqual([noCharacters.ranges, noCharacters.blocks, section(noCharacters, 'Font').Characters], [[], [], '0']);
  assert.deepEqual([noCharacters.family, noCharacters.axes, noCharacters.features], [sound.family, sound.axes, sound.features]);

  // The features of the other table stay.
  const noSubstitutions = without('GSUB', junk);
  assert.deepEqual(noSubstitutions.features, [{ tag: 'kern', name: 'Kerning', on: true }]);
  assert.deepEqual([noSubstitutions.family, noSubstitutions.ranges, noSubstitutions.axes], [sound.family, sound.ranges, sound.axes]);

  // Without names the axes and features fall back on their tags and numbers.
  const noNames = without('name', Buffer.from([0, 0, 0, 9]));
  assert.deepEqual([noNames.family, noNames.style, section(noNames, 'Names')], ['', '', {}]);
  assert.deepEqual([noNames.ranges, noNames.axes.map((axis) => axis.name), noNames.features.map((f) => f.name)], [sound.ranges, ['Weight', 'Width'], ['Kerning', 'Standard ligatures', 'Small capitals', 'Character variant 5', 'Stylistic set 1', 'Stylistic set 2']]);

  // A table that ends early loses the fields behind the cut and keeps those in front of it.
  const shortOs2 = section(without('OS/2', VARIABLE['OS/2'].subarray(0, 7)), 'Font');
  assert.deepEqual([shortOs2['Weight class'], shortOs2['Width class'], shortOs2.Vendor, shortOs2.Embedding, shortOs2['Units per em'], shortOs2.Glyphs], ['400', undefined, undefined, undefined, '2048', '1,234']);
  const shortHead = section(without('head', VARIABLE.head.subarray(0, 24)), 'Font');
  assert.deepEqual([shortHead['Units per em'], shortHead.Created, shortHead.Modified, shortHead['Weight class']], ['2048', undefined, undefined, '400']);
  const shortHhea = section(without('hhea', VARIABLE.hhea.subarray(0, 7)), 'Metrics');
  assert.deepEqual(shortHhea, { Ascender: '1900', 'x-height': '1000', 'Cap height': '1400' });
});

/** No file here is larger than a few kilobytes; a parser that needs longer is stuck. */
const BUDGET_MS = 1000;
const REFUSALS = ['The file is too short to be a font.', 'The font file is damaged.', 'This is not a TrueType, OpenType, WOFF or WOFF2 font.', 'WOFF2 font collections are not supported.'];

/** Parses bytes that may be anything: the answer is a font or one of the parser's own refusals, and it comes soon. */
function survive(bytes: Buffer, what: string): void {
  const started = performance.now();
  try {
    const parsed = parseFont(bytes);
    for (const one of parsed.faces) {
      assert.ok(Array.isArray(one.ranges) && Array.isArray(one.sections), what);
    }
  } catch (e) {
    if (!(e instanceof Error) || !REFUSALS.includes(e.message)) {
      throw new Error(`${what}: threw ${e instanceof Error ? e.stack : e}`);
    }
  }
  const took = performance.now() - started;
  assert.ok(took < BUDGET_MS, `${what}: took ${Math.round(took)} ms`);
}

const CONTAINERS: [string, Buffer][] = [
  ['a font file', sfnt(VARIABLE)],
  ['WOFF', woff(VARIABLE)],
  ['WOFF2', woff2(VARIABLE, Object.keys(VARIABLE))],
  ['a collection', ttc([[STATIC], [VARIABLE]])],
];

for (const [container, sound] of CONTAINERS) {
  test(`${container} cut short at any length is parsed or refused, nothing else`, () => {
    for (let length = 0; length < sound.length; length++) {
      // A copy of exactly that length: a view into the whole file would let a stray read succeed.
      survive(Buffer.from(Uint8Array.from(sound.subarray(0, length))), `cut at ${length}`);
    }
  });

  test(`${container} with flipped bits or noise is parsed or refused, nothing else`, () => {
    const damage = random(62);
    for (let round = 0; round < 400; round++) {
      const flipped = Buffer.from(sound);
      for (let n = 1 + damage.int(4); n > 0; n--) {
        // Half of the flips go to the directory at the start, where every bit is an offset or a length.
        flipped[damage.int(round % 2 ? flipped.length : 300)] ^= 1 << damage.int(8);
      }
      survive(flipped, `flip round ${round}`);
    }
    for (let round = 0; round < 100; round++) {
      survive(Buffer.concat([sound.subarray(0, damage.pick([4, 12, 48])), damage.bytes(damage.int(600))]), `noise round ${round}`);
    }
  });
}

test('a face of a damaged collection is copied out or refused, nothing else', () => {
  const sound = ttc([[STATIC], [VARIABLE]]);
  const damage = random(63);
  const copy = (file: Buffer, what: string) => {
    for (const index of [0, 1]) {
      try {
        faceBytes(file, index);
      } catch (e) {
        // A read past the end of the file is the only thing that may go wrong.
        assert.ok(e instanceof RangeError, `${what}: threw ${e instanceof Error ? e.stack : e}`);
      }
    }
  };
  for (let length = 4; length < 200; length++) {
    copy(Buffer.from(Uint8Array.from(sound.subarray(0, length))), `cut at ${length}`);
  }
  for (let round = 0; round < 200; round++) {
    const flipped = Buffer.from(sound);
    // Not the two top bytes of a length: a table of gigabytes is a matter of its own.
    flipped[4 + damage.int(400)] ^= 1 << damage.int(8);
    copy(flipped, `flip round ${round}`);
  }
});

test('a character map whose segments all claim the whole plane is read as fast as one that says it once', () => {
  // Every segment maps U+0000 to U+FFFE through the same list of glyphs; the answer is one range however many there are.
  // 24 of them were 0.2 s and hundreds of megabytes, 4,000 (a font of 160 KB) the end of the process.
  const whole: Segment = { start: 0, end: 0xfffe, glyphs: [] };
  for (const count of [24, 4000, 16000]) {
    const table = cmap4(Array.from({ length: count }, () => whole));
    const hostile = sfnt({ ...STATIC, cmap: cmap([[3, 1, Buffer.concat([table, Buffer.alloc(0x20000, 1)])]]) });
    const started = performance.now();
    const parsed = parseFont(hostile).faces[0];
    const took = performance.now() - started;
    assert.deepEqual([parsed.ranges.length, parsed.ranges[0]], [1, [0, 0xfffe]], `${count} segments`);
    // A few milliseconds; the 24 segments alone took more than twice this limit.
    assert.ok(took < 100, `${count} segments took ${Math.round(took)} ms`);
  }
});

test('characters: the other formats cost what their table is long, whatever they claim', () => {
  // Format 12 and 13 keep one entry per group, and a group is 12 bytes of the file: 80,000 groups that each claim every code point are one range.
  const everything = cmap12(Array.from({ length: 80000 }, (): [number, number, number] => [0, 0x10ffff, 1]));
  const thirteen = Buffer.from(everything);
  thirteen.writeUInt16BE(13, 0);
  for (const table of [everything, thirteen]) {
    const started = performance.now();
    assert.deepEqual(face({ ...STATIC, cmap: cmap([[3, 10, table]]) }).ranges, [[0, 0x10ffff]]);
    assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
  }
  // A count of groups that the table has no room for is a damaged table: no characters, and no four billion rounds.
  const lying = Buffer.from(cmap12([[0x41, 0x5a, 1]]));
  lying.writeUInt32BE(0xffffffff, 12);
  assert.deepEqual(face({ ...STATIC, cmap: cmap([[3, 10, lying]]) }).ranges, []);
  // Format 6 has codes of 16 bits: a list that starts at the last of them and goes on maps that one code.
  const six = Buffer.concat([u16(6), u16(0), u16(0), u16(0xffff), u16(0xffff), Buffer.alloc(0x1fffe, 1)]);
  assert.deepEqual(face({ ...STATIC, cmap: cmap([[0, 3, six]]) }).ranges, [[0xffff, 0xffff]]);
});

test('characters: a code that several segments claim belongs to the first that ends at or behind it', () => {
  const ranges = (segments: Segment[]) => face({ ...STATIC, cmap: cmap([[3, 1, cmap4(segments)]]) }).ranges;
  // The second segment has glyphs for U+0041 to U+0043 too, but a lookup never gets to it for those: the first has none there.
  assert.deepEqual(ranges([{ start: 0x41, end: 0x43, glyphs: [5, 0, 0] }, { start: 0x41, end: 0x46, glyphs: [1, 2, 3, 4, 0, 6] }]), [[0x41, 0x41], [0x44, 0x44], [0x46, 0x46]]);
  // The same with glyphs by delta, where one code of a segment lands on glyph 0.
  assert.deepEqual(ranges([{ start: 0x41, end: 0x43, delta: 0x10000 - 0x42 }, { start: 0x40, end: 0x50, delta: 0x10000 - 0x44 }]), [[0x41, 0x41], [0x43, 0x43], [0x45, 0x50]]);
  // A segment that ends in front of the one before it is never reached, and one that is upside down maps nothing.
  assert.deepEqual(ranges([{ start: 0x60, end: 0x70, delta: 1 }, { start: 0x41, end: 0x5a, delta: 1 }, { start: 0x90, end: 0x80, delta: 1 }, { start: 0x100, end: 0x101, delta: 1 }]), [[0x60, 0x70], [0x100, 0x101]]);
});

// ---- A second opinion: the fonts of this machine ----------------------------------

// Not committed (their licences don't allow it): read where they are, and only for what must hold for any font.
const SYSTEM_FONTS = ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Menlo.ttc', 'C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].filter((file) =>
  fs.existsSync(file),
);

test('system fonts parse to faces that are consistent in themselves', { skip: SYSTEM_FONTS.length ? false : 'none of the known system fonts is on this machine' }, () => {
  for (const file of SYSTEM_FONTS) {
    const data = fs.readFileSync(file);
    const parsed = parseFont(data);
    assert.ok(parsed.faces.length >= 1, file);
    assert.equal(parsed.faces.length > 1, parsed.format.endsWith('collection'), file);
    parsed.faces.slice(0, 4).forEach((one, index) => {
      const what = `${file} face ${index}`;
      assert.ok(one.family.length > 0, what);
      // Ranges ascend and neither touch nor overlap.
      one.ranges.forEach(([start, end], i) => assert.ok(start <= end && end <= 0x10ffff && (i === 0 || start > one.ranges[i - 1][1] + 1), `${what}: range ${i}`));
      const characters = one.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
      assert.ok(characters > 90, what);
      // Every character is counted in exactly one block.
      assert.equal(one.blocks.reduce((sum, block) => sum + block[3], 0), characters, what);
      assert.equal(section(one, 'Font').Characters, characters.toLocaleString('en-US'), what);
      for (const axis of one.axes) {
        assert.ok(axis.min <= axis.def && axis.def <= axis.max && /^[\x20-\x7e]{4}$/.test(axis.tag), `${what}: axis ${axis.tag}`);
      }
      one.instances.forEach((instance) => assert.equal(instance.coords.length, one.axes.length, what));
      assert.match(one.css.weight, /^([\d.]+( [\d.]+)?)?$/, what);
      // The face the browser is given is a font file of its own with the same face in it.
      const single = parseFont(faceBytes(data, index));
      assert.equal(single.faces.length, 1, what);
      // As one text: a font has thousands of ranges, and a difference between two such lists should be said in a line.
      assert.equal(JSON.stringify([single.faces[0].family, single.faces[0].style, single.faces[0].ranges, single.faces[0].axes]), JSON.stringify([one.family, one.style, one.ranges, one.axes]), what);
    });
  }
});
