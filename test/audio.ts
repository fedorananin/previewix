import * as zlib from 'zlib';
import { FIELDS, type Fields } from '../src/tags/common';
import type { Random } from './helpers';

// Sound files built by hand for the tag tests, and readers of the tests' own for them. The readers share no
// code with src/tags on purpose: they are what says whether a save kept the audio and the other tags.
// None of the "audio" here can be played; the writers never look inside it.

export const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
export const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
export const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const latin = (text: string) => Buffer.from(text, 'latin1');

/** The form's values: every field, empty unless given. */
export const fields = (values: Partial<Fields> = {}): Fields => ({ ...(Object.fromEntries(FIELDS.map((f) => [f, ''])) as Fields), ...values });

// ---- Pictures -------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([latin(type), data]);
  return Buffer.concat([u32(data.length), body, u32(zlib.crc32(body))]);
}

/** A real PNG of one colour. `extra` bytes of text chunk make it as large as a test needs. */
export function png(width: number, height: number, extra = 0): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])])),
    ...(extra ? [pngChunk('tEXt', Buffer.concat([latin('Comment\0'), Buffer.alloc(extra, 0x61)]))] : []),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The frame of a JPEG file (start, a frame header with the size, end) around `filler` bytes; enough for a tag writer. */
export function jpeg(width: number, height: number, filler: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), latin('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), u16(height), u16(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    filler,
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ---- ID3 ------------------------------------------------------------------------

const syncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const unsyncsafe = (b: Buffer, at: number) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];

export function id3Frame(version: 3 | 4, id: string, data: Buffer, flags = 0): Buffer {
  return Buffer.concat([latin(id), version === 3 ? u32(data.length) : syncsafe(data.length), u16(flags), data]);
}

/** Text in one of the four ID3 encodings: 0 Latin-1, 1 UTF-16 with a byte order mark, 2 UTF-16BE, 3 UTF-8. */
export function id3Text(encoding: number, text: string): Buffer {
  switch (encoding) {
    case 0:
      return latin(text);
    case 1:
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 2:
      return Buffer.from(text, 'utf16le').swap16();
    default:
      return Buffer.from(text, 'utf8');
  }
}

const terminator = (encoding: number) => Buffer.alloc(encoding === 1 || encoding === 2 ? 2 : 1);

export const id3TextFrame = (version: 3 | 4, id: string, text: string, encoding = 0): Buffer =>
  id3Frame(version, id, Buffer.concat([Buffer.from([encoding]), id3Text(encoding, text)]));

/** COMM, USLT: encoding, language, description, text. */
export const id3Described = (version: 3 | 4, id: string, language: string, description: string, text: string, encoding = 0): Buffer =>
  id3Frame(version, id, Buffer.concat([Buffer.from([encoding]), latin(language), id3Text(encoding, description), terminator(encoding), id3Text(encoding, text)]));

export const id3Picture = (version: 3 | 4, type: number, image: Buffer, mime = 'image/jpeg', description = ''): Buffer =>
  id3Frame(version, 'APIC', Buffer.concat([Buffer.from([0]), latin(mime), Buffer.from([0, type]), latin(description), Buffer.from([0]), image]));

export const id3UserText = (version: 3 | 4, description: string, value: string): Buffer =>
  id3Frame(version, 'TXXX', Buffer.concat([Buffer.from([0]), latin(description), Buffer.from([0]), latin(value)]));

export function id3Tag(version: 2 | 3 | 4, frames: Buffer[], padding = 0, flags = 0): Buffer {
  const body = Buffer.concat([...frames, Buffer.alloc(padding)]);
  return Buffer.concat([latin('ID3'), Buffer.from([version, 0, flags]), syncsafe(body.length), body]);
}

export interface Id3Frame {
  id: string;
  /** The whole frame, header included. */
  raw: Buffer;
  data: Buffer;
}

/** The frames of a plain tag (no unsynchronisation, no extended header), which is what the writer produces. */
export function id3Frames(tag: Buffer): { version: number; flags: number; length: number; frames: Id3Frame[]; padding: Buffer } {
  if (tag.toString('latin1', 0, 3) !== 'ID3') {
    throw new Error('no ID3 tag');
  }
  const version = tag[3];
  const end = 10 + unsyncsafe(tag, 6);
  const frames: Id3Frame[] = [];
  let at = 10;
  while (at + 10 <= end && tag[at] !== 0) {
    const size = version === 4 ? unsyncsafe(tag, at + 4) : tag.readUInt32BE(at + 4);
    frames.push({ id: tag.toString('latin1', at, at + 4), raw: tag.subarray(at, at + 10 + size), data: tag.subarray(at + 10, at + 10 + size) });
    at += 10 + size;
  }
  return { version, flags: tag[5], length: end, frames, padding: tag.subarray(at, end) };
}

/** Bytes that look like MPEG audio frames to nobody but a tag writer: a frame sync, then noise. */
export const mpegAudio = (rand: Random, length: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), rand.bytes(length - 4)]);

/** An ID3v1 trailer: 128 bytes that start with "TAG". */
export function id3v1(title: string): Buffer {
  const tag = Buffer.alloc(128);
  tag.write('TAG', 'latin1');
  tag.write(title, 3, 'latin1');
  tag[127] = 17;
  return tag;
}

// ---- FLAC -----------------------------------------------------------------------

export const FLAC = { STREAMINFO: 0, PADDING: 1, APPLICATION: 2, SEEKTABLE: 3, VORBIS_COMMENT: 4, PICTURE: 6 };

export interface FlacBlock {
  type: number;
  data: Buffer;
}

export function vorbisComment(vendor: string, entries: string[]): Buffer {
  const text = (value: string) => {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([u32le(bytes.length), bytes]);
  };
  return Buffer.concat([text(vendor), u32le(entries.length), ...entries.map(text)]);
}

export function flacPictureBlock(type: number, image: Buffer, mime = 'image/jpeg', description = ''): Buffer {
  const text = Buffer.from(description, 'utf8');
  return Buffer.concat([u32(type), u32(mime.length), latin(mime), u32(text.length), text, u32(1), u32(1), u32(24), u32(0), u32(image.length), image]);
}

export function flacFile(blocks: FlacBlock[], audio: Buffer): Buffer {
  const parts: Buffer[] = [latin('fLaC')];
  blocks.forEach((block, i) => {
    const header = u32(block.data.length);
    header[0] = block.type | (i === blocks.length - 1 ? 0x80 : 0);
    parts.push(header, block.data);
  });
  return Buffer.concat([...parts, audio]);
}

export function flacBlocks(file: Buffer): { blocks: FlacBlock[]; audio: Buffer } {
  if (file.toString('latin1', 0, 4) !== 'fLaC') {
    throw new Error('not FLAC');
  }
  const blocks: FlacBlock[] = [];
  for (let at = 4; ; ) {
    const length = file.readUIntBE(at + 1, 3);
    if (at + 4 + length > file.length) {
      throw new Error('a metadata block ends behind the file');
    }
    blocks.push({ type: file[at] & 0x7f, data: file.subarray(at + 4, at + 4 + length) });
    const last = file[at] & 0x80;
    at += 4 + length;
    if (last) {
      return { blocks, audio: file.subarray(at) };
    }
  }
}

export function vorbisEntries(data: Buffer): { vendor: string; entries: string[] } {
  const vendorLength = data.readUInt32LE(0);
  const vendor = data.toString('utf8', 4, 4 + vendorLength);
  let at = 4 + vendorLength;
  const count = data.readUInt32LE(at);
  at += 4;
  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = data.readUInt32LE(at);
    entries.push(data.toString('utf8', at + 4, at + 4 + length));
    at += 4 + length;
  }
  if (at !== data.length) {
    throw new Error('the comment block has bytes left over');
  }
  return { vendor, entries };
}

/** Frame sync of a FLAC frame, then noise. */
export const flacAudio = (rand: Random, length: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xf8, 0xc9, 0x18]), rand.bytes(length - 4)]);

export const streamInfo = (rand: Random): FlacBlock => ({ type: FLAC.STREAMINFO, data: rand.bytes(34) });

// ---- WAV ------------------------------------------------------------------------

export type RiffChunk = [id: string, data: Buffer];

export function riffChunk(id: string, data: Buffer): Buffer {
  return Buffer.concat([latin(id), u32le(data.length), data, Buffer.alloc(data.length & 1)]);
}

export function wavFile(chunks: RiffChunk[]): Buffer {
  const body = Buffer.concat([latin('WAVE'), ...chunks.map(([id, data]) => riffChunk(id, data))]);
  return Buffer.concat([latin('RIFF'), u32le(body.length), body]);
}

export const infoList = (entries: [id: string, text: string][]): Buffer =>
  Buffer.concat([latin('INFO'), ...entries.map(([id, text]) => riffChunk(id, Buffer.concat([Buffer.from(text, 'utf8'), Buffer.alloc(1)])))]);

/** The chunks of a RIFF file whose sizes all add up, which is what a save has to produce. */
export function riffChunks(file: Buffer): RiffChunk[] {
  if (file.toString('latin1', 0, 4) !== 'RIFF' || file.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not RIFF WAVE');
  }
  if (file.readUInt32LE(4) !== file.length - 8) {
    throw new Error(`the RIFF size says ${file.readUInt32LE(4)}, the file has ${file.length - 8} bytes behind it`);
  }
  return subChunks(file.subarray(12));
}

export function subChunks(data: Buffer): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let at = 0;
  while (at < data.length) {
    const size = data.readUInt32LE(at + 4);
    if (at + 8 + size + (size & 1) > data.length) {
      throw new Error(`chunk ${data.toString('latin1', at, at + 4)} ends behind its parent`);
    }
    chunks.push([data.toString('latin1', at, at + 4), data.subarray(at + 8, at + 8 + size)]);
    at += 8 + size + (size & 1);
  }
  return chunks;
}

/** 16-bit stereo PCM format chunk. */
export const WAV_FORMAT = Buffer.from([1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0]);

// ---- MP4 ------------------------------------------------------------------------

export function box(type: string, ...parts: Buffer[]): Buffer {
  return Buffer.concat([u32(parts.reduce((sum, part) => sum + part.length, 8)), latin(type), ...parts]);
}

/** A box with a 64-bit size field. */
export function wideBox(type: string, ...parts: Buffer[]): Buffer {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(parts.reduce((sum, part) => sum + part.length, 16)));
  return Buffer.concat([u32(1), latin(type), size, ...parts]);
}

export const dataBox = (kind: number, value: Buffer): Buffer => box('data', u32(kind), u32(0), value);
export const textItem = (type: string, ...texts: string[]): Buffer => box(type, ...texts.map((text) => dataBox(1, Buffer.from(text, 'utf8'))));
/** Track or disc: iTunes writes two reserved bytes behind the track total and none behind the disc total. */
export const pairItem = (type: 'trkn' | 'disk', number: number, total: number): Buffer =>
  box(type, dataBox(0, Buffer.concat([u16(0), u16(number), u16(total), Buffer.alloc(type === 'trkn' ? 2 : 0)])));
export const freeformItem = (mean: string, name: string, value: Buffer, kind = 1): Buffer =>
  box('----', box('mean', u32(0), Buffer.from(mean, 'utf8')), box('name', u32(0), Buffer.from(name, 'utf8')), dataBox(kind, value));
export const coverItem = (...images: Buffer[]): Buffer => box('covr', ...images.map((image) => dataBox(image[0] === 0x89 ? 14 : 13, image)));
export const numberItem = (type: string, value: number, bytes = 1): Buffer => {
  const data = Buffer.alloc(bytes);
  data.writeUIntBE(value, 0, bytes);
  return box(type, dataBox(21, data));
};

/** The handler that marks a meta atom as an iTunes tag list. */
export const MDIR = box('hdlr', Buffer.alloc(8), latin('mdirappl'), Buffer.alloc(9));

export interface TagAtoms {
  /** The items of the list; undefined leaves the list out (a meta atom with its handler only). */
  items?: Buffer[];
  /** A `free` atom of this size behind the list, inside meta. */
  pad?: number;
  /** meta without version and flags, as QuickTime writes it. */
  plain?: boolean;
  /** Atoms of udta in front of meta. */
  before?: Buffer[];
  /** The four zero bytes that may end a udta. */
  terminated?: boolean;
  handler?: Buffer;
  /** Atoms inside meta behind the handler and in front of the list. */
  inMeta?: Buffer[];
}

export function udta(tags: TagAtoms | undefined, extra: { noMeta?: boolean } = {}): Buffer {
  const t = tags ?? {};
  const meta = box(
    'meta',
    ...(t.plain ? [] : [u32(0)]),
    t.handler ?? MDIR,
    ...(t.inMeta ?? []),
    ...(t.items ? [box('ilst', ...t.items)] : []),
    ...(t.pad ? [box('free', Buffer.alloc(t.pad - 8))] : []),
  );
  return box('udta', ...(t.before ?? []), ...(extra.noMeta ? [] : [meta]), ...(t.terminated ? [Buffer.alloc(4)] : []));
}

export interface Track {
  /** The sample data of every chunk, in samples. */
  chunks: Buffer[][];
  /** A 64-bit chunk offset table (co64) in place of stco. */
  wide?: boolean;
  /** More atoms for the sample table. */
  inTable?: Buffer[];
  /** Flags of the data reference; 1 says "in this file". */
  reference?: number;
  /** Sample sizes in the compact table (stz2) with this field size. */
  compact?: 8 | 16;
}

/** A track of `count` chunks with a few samples each, of sizes that differ. */
export function track(rand: Random, count: number, more: Partial<Track> = {}): Track {
  return {
    chunks: Array.from({ length: count }, (_, i) => Array.from({ length: i % 3 === 2 ? 2 : 3 }, () => rand.bytes(40 + rand.int(120)))),
    ...more,
  };
}

function trak(t: Track, offsets: number[]): Buffer {
  const samples = t.chunks.flat();
  // One run per change in the number of samples per chunk.
  const runs: Buffer[] = [];
  t.chunks.forEach((chunk, i) => {
    if (i === 0 || chunk.length !== t.chunks[i - 1].length) {
      runs.push(Buffer.concat([u32(i + 1), u32(chunk.length), u32(1)]));
    }
  });
  const sizes = t.compact
    ? box('stz2', u32(0), Buffer.from([0, 0, 0, t.compact]), u32(samples.length), ...samples.map((s) => (t.compact === 8 ? Buffer.from([s.length]) : u16(s.length))))
    : box('stsz', u32(0), u32(0), u32(samples.length), ...samples.map((s) => u32(s.length)));
  const table = t.wide
    ? box('co64', u32(0), u32(offsets.length), ...offsets.map((offset) => Buffer.concat([u32(Math.floor(offset / 2 ** 32)), u32(offset % 2 ** 32)])))
    : box('stco', u32(0), u32(offsets.length), ...offsets.map(u32));
  const stbl = box(
    'stbl',
    box('stsd', u32(0), u32(1), box('mp4a', Buffer.alloc(28))),
    box('stts', u32(0), u32(1), u32(samples.length), u32(1024)),
    box('stsc', u32(0), u32(runs.length), ...runs),
    sizes,
    table,
    ...(t.inTable ?? []),
  );
  const dinf = box('dinf', box('dref', u32(0), u32(1), box('url ', u32(t.reference ?? 1))));
  return box(
    'trak',
    box('tkhd', Buffer.alloc(84)),
    box('mdia', box('mdhd', Buffer.alloc(24)), box('hdlr', Buffer.alloc(8), latin('soun'), Buffer.alloc(13)), box('minf', box('smhd', Buffer.alloc(8)), dinf, stbl)),
  );
}

export interface Mp4 {
  /** moov in front of the audio (what `-movflags +faststart` and iTunes write) or behind it. */
  front: boolean;
  tracks: Track[];
  /** The udta atom, or nothing for a file without one. */
  udta?: Buffer;
  /** More atoms inside moov, behind udta. */
  inMoov?: Buffer[];
  /** Top-level atoms between moov and mdat when moov is in front (iTunes leaves a `free` there). */
  behindMoov?: Buffer[];
  /** How mdat states its size: in 32 bits, as zero ("to the end of the file"), or in 64 bits. */
  mdat?: 'plain' | 'open' | 'wide';
  /** Top-level atoms at the very end. */
  tail?: Buffer[];
}

/** An MP4 file whose chunk offsets, sample tables and sizes are consistent. Chunks of the tracks are interleaved in mdat. */
export function mp4File(spec: Mp4): Buffer {
  const ftyp = box('ftyp', latin('M4A '), u32(0), latin('M4A mp42isom'));
  // Where every chunk starts inside the payload of mdat.
  const payload: Buffer[] = [];
  const relative = spec.tracks.map((): number[] => []);
  let at = 0;
  for (let i = 0; spec.tracks.some((t) => i < t.chunks.length); i++) {
    spec.tracks.forEach((t, n) => {
      if (i < t.chunks.length) {
        const chunk = Buffer.concat(t.chunks[i]);
        relative[n].push(at);
        payload.push(chunk);
        at += chunk.length;
      }
    });
  }
  const audio = Buffer.concat(payload);
  const mdat =
    spec.mdat === 'wide' ? wideBox('mdat', audio) : spec.mdat === 'open' ? Buffer.concat([u32(0), latin('mdat'), audio]) : box('mdat', audio);
  const head = mdat.length - audio.length;
  const moov = (base: number) =>
    box(
      'moov',
      box('mvhd', Buffer.alloc(100)),
      ...spec.tracks.map((t, n) => trak(t, relative[n].map((offset) => base + offset))),
      ...(spec.udta ? [spec.udta] : []),
      ...(spec.inMoov ?? []),
    );
  const between = Buffer.concat(spec.behindMoov ?? []);
  const tail = Buffer.concat(spec.tail ?? []);
  if (spec.front) {
    // The size of moov doesn't depend on the offsets in it.
    const base = ftyp.length + moov(0).length + between.length + head;
    return Buffer.concat([ftyp, moov(base), between, mdat, tail]);
  }
  return Buffer.concat([ftyp, mdat, moov(ftyp.length + head), tail]);
}

export interface Box {
  type: string;
  /** Where the header starts, where the content starts and where the atom ends, in the file. */
  start: number;
  content: number;
  end: number;
}

/** The atoms that fill `from`..`to` exactly; anything else is an error, since a saved file must add up. */
export function boxes(file: Buffer, from = 0, to = file.length, terminated = false): Box[] {
  const list: Box[] = [];
  for (let at = from; at < to; ) {
    if (terminated && to - at === 4 && file.readUInt32BE(at) === 0) {
      break;
    }
    if (at + 8 > to) {
      throw new Error(`${to - at} stray bytes at ${at}`);
    }
    let size = file.readUInt32BE(at);
    let head = 8;
    if (size === 1) {
      size = Number(file.readBigUInt64BE(at + 8));
      head = 16;
    } else if (size === 0 && to === file.length) {
      size = to - at;
    }
    if (size < head || at + size > to) {
      throw new Error(`atom ${JSON.stringify(file.toString('latin1', at + 4, at + 8))} at ${at} has size ${size}, ${to - at} bytes are left`);
    }
    list.push({ type: file.toString('latin1', at + 4, at + 8), start: at, content: at + head, end: at + size });
    at += size;
  }
  return list;
}

const only = (list: Box[], type: string): Box => {
  const found = list.filter((item) => item.type === type);
  if (found.length !== 1) {
    throw new Error(`${found.length} ${type} atoms where one was expected`);
  }
  return found[0];
};

export const within = (file: Buffer, parent: Box, skip = 0, terminated = false): Box[] => boxes(file, parent.content + skip, parent.end, terminated);

export interface Mp4Tags {
  udta?: Box;
  meta?: Box;
  /** meta has version and flags in front of its atoms. */
  full?: boolean;
  /** The atoms of meta. */
  parts: Box[];
  ilst?: Box;
  /** The items of the list, whole, in order. */
  items: { type: string; raw: Buffer }[];
}

/** The tag atoms of a file, found without src/tags/mp4.ts. */
export function mp4Tags(file: Buffer): Mp4Tags {
  const moov = only(boxes(file), 'moov');
  const udtaBox = within(file, moov).find((item) => item.type === 'udta');
  const meta = udtaBox && within(file, udtaBox, 0, true).find((item) => item.type === 'meta');
  if (!meta) {
    return { udta: udtaBox, parts: [], items: [] };
  }
  // A full box starts with four zero bytes, a plain one with the size of its first atom.
  const full = file.readUInt32BE(meta.content) === 0;
  const parts = within(file, meta, full ? 4 : 0);
  const ilst = parts.find((item) => item.type === 'ilst');
  const items = ilst ? within(file, ilst).map((item) => ({ type: item.type, raw: Buffer.from(file.subarray(item.start, item.end)) })) : [];
  return { udta: udtaBox, meta, full, parts, ilst, items };
}

export interface Chunk {
  track: number;
  offset: number;
  data: Buffer;
}

/** Every chunk of every track, read through the chunk offsets and the sample tables. Throws when one lies outside the file. */
export function mp4Chunks(file: Buffer): Chunk[] {
  const moov = only(boxes(file), 'moov');
  const chunks: Chunk[] = [];
  within(file, moov)
    .filter((item) => item.type === 'trak')
    .forEach((trakBox, n) => {
      const stbl = within(file, only(within(file, only(within(file, only(within(file, trakBox), 'mdia')), 'minf')), 'stbl'));
      const table = stbl.find((item) => item.type === 'stco' || item.type === 'co64');
      const stsc = only(stbl, 'stsc');
      const sizeBox = stbl.find((item) => item.type === 'stsz' || item.type === 'stz2');
      if (!table || !sizeBox) {
        throw new Error('a track without chunk offsets or sample sizes');
      }
      const count = file.readUInt32BE(table.content + 4);
      const offsets = Array.from({ length: count }, (_, i) =>
        table.type === 'co64' ? Number(file.readBigUInt64BE(table.content + 8 + i * 8)) : file.readUInt32BE(table.content + 8 + i * 4),
      );
      const width = sizeBox.type === 'stz2' ? file[sizeBox.content + 7] / 8 : 4;
      const sizes = Array.from({ length: file.readUInt32BE(sizeBox.content + 8) }, (_, i) => file.readUIntBE(sizeBox.content + 12 + i * width, width));
      const runs = Array.from({ length: file.readUInt32BE(stsc.content + 4) }, (_, i) => ({
        first: file.readUInt32BE(stsc.content + 8 + i * 12),
        samples: file.readUInt32BE(stsc.content + 12 + i * 12),
      }));
      let sample = 0;
      offsets.forEach((offset, i) => {
        const run = runs.filter((r) => r.first <= i + 1).at(-1);
        let length = 0;
        for (let k = 0; k < (run?.samples ?? 0); k++) {
          length += sizes[sample++];
        }
        if (offset + length > file.length) {
          throw new Error(`chunk ${i} of track ${n} ends behind the file`);
        }
        chunks.push({ track: n, offset, data: Buffer.from(file.subarray(offset, offset + length)) });
      });
    });
  return chunks;
}

/** The payload of every mdat atom with the place it starts at. */
export function mp4Audio(file: Buffer): { start: number; data: Buffer }[] {
  return boxes(file)
    .filter((item) => item.type === 'mdat')
    .map((item) => ({ start: item.content, data: Buffer.from(file.subarray(item.content, item.end)) }));
}
