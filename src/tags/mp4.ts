import * as fs from 'fs';
import {
  FIELDS, decodeLoose, emptyFields, imageMime, readRange, rewriteFile, uint32,
  type CoverChange, type Field, type Fields, type Part, type Tag, type TagData,
} from './common';
import { ID3V1_GENRES } from './id3';

/**
 * MP4 tags (M4A, M4B): the iTunes-style item list in moov/udta/meta/ilst. Items are kept as
 * raw bytes and only the ones behind an edited field are rebuilt, so freeform atoms, sort
 * names, purchase data and gapless info survive a save untouched.
 *
 * The index (moov) usually sits in front of the audio (mdat) and addresses it by absolute
 * file offsets, so a tag that changes size would move the audio away from them. A save
 * therefore first tries to take the difference from padding, which moves nothing, and only
 * then moves the audio and corrects the offset tables of every track. Whatever was written
 * is read back and compared with the original before it replaces it.
 *
 * A file whose layout isn't fully understood here is refused rather than guessed at: see
 * Mp4Refusal.
 */

/**
 * Why a file is not rewritten here. "foreign" is not an MP4 file at all and "unsupported" is
 * a sound file with a layout this module doesn't rewrite: both are left to ffmpeg. "damaged"
 * is a broken file that nothing should rewrite.
 */
export class Mp4Refusal extends Error {
  constructor(readonly kind: 'foreign' | 'unsupported' | 'damaged', message: string) {
    super(message);
  }
}

const unsupported = (what: string) => new Mp4Refusal('unsupported', `This file ${what}, which Previewix doesn't rewrite on its own.`);
const damaged = (what = 'is incomplete or damaged') => new Mp4Refusal('damaged', `This file ${what}, so its tags can't be edited.`);

interface Atom {
  type: string;
  /** Position of the header: in the file for top-level atoms, in the moov buffer for the ones inside it. */
  start: number;
  /** Length of the header: 8 bytes, or 16 with a 64-bit size. */
  head: number;
  end: number;
  /** The size field is zero: the atom runs to the end of the file. */
  open?: boolean;
}

/** Chunk offset table of one track (stco, or co64 with 64-bit entries). */
interface Table {
  wide: boolean;
  atom: Atom;
  /** The atoms around it, moov first. */
  path: Atom[];
  offsets: number[];
  /** Bytes of sample data in each chunk, as far as the sample tables tell. */
  lengths: number[];
}

interface Item {
  type: string;
  /** The complete item, header included. */
  raw: Buffer;
  /** Namespace and name of a freeform (`----`) item. */
  mean?: string;
  name?: string;
  /** The item's data atoms: type code, payload, and position inside `raw`. Empty when the item couldn't be parsed. */
  data: Value[];
}

interface Value {
  kind: number;
  value: Buffer;
  start: number;
  end: number;
}

interface Layout {
  size: number;
  /** Top-level atoms of the file. */
  atoms: Atom[];
  moov: Atom;
  /** The whole moov atom. Never modified; every change is made on a copy. */
  body: Buffer;
  udta?: Atom;
  meta?: Atom;
  hdlr?: Atom;
  ilst?: Atom;
  /** A `free` atom right behind ilst, the padding taggers leave there. */
  pad?: Atom;
  items: Item[];
  tables: Table[];
}

const COPYRIGHT = '\xa9'; // the first byte of most iTunes item names, as Latin-1

const TEXT: Partial<Record<Field, string>> = {
  title: `${COPYRIGHT}nam`, artist: `${COPYRIGHT}ART`, album: `${COPYRIGHT}alb`, album_artist: 'aART', date: `${COPYRIGHT}day`,
  composer: `${COPYRIGHT}wrt`, comment: `${COPYRIGHT}cmt`, lyrics: `${COPYRIGHT}lyr`,
};
const PAIRS = { track: 'trkn', disc: 'disk' } as const;
/** The genre as text, and as a number into the ID3v1 list (plus one), which is what iTunes writes for the genres on that list. */
const GENRE_TEXT = `${COPYRIGHT}gen`;
const GENRE_NUMBER = 'gnre';
const COVER = 'covr';
const FREEFORM = '----';
/** Items the form edits; all the others are only shown. */
const MANAGED = new Set([...Object.values(TEXT), ...Object.values(PAIRS), GENRE_TEXT, GENRE_NUMBER, COVER]);

const ITEM_NAMES: Record<string, string> = {
  [`${COPYRIGHT}too`]: 'Encoder', [`${COPYRIGHT}enc`]: 'Encoded by', cprt: 'Copyright', [`${COPYRIGHT}grp`]: 'Grouping',
  [`${COPYRIGHT}wrk`]: 'Work', [`${COPYRIGHT}mvn`]: 'Movement', [`${COPYRIGHT}mvi`]: 'Movement number', [`${COPYRIGHT}mvc`]: 'Movement count',
  [`${COPYRIGHT}nrt`]: 'Narrator', [`${COPYRIGHT}pub`]: 'Publisher', [`${COPYRIGHT}con`]: 'Conductor', tmpo: 'BPM', cpil: 'Compilation',
  pgap: 'Gapless playback', pcst: 'Podcast', shwm: 'Show work and movement', hdvd: 'HD video', rtng: 'Content rating', stik: 'Media kind',
  catg: 'Category', keyw: 'Keywords', purl: 'Podcast URL', egid: 'Episode GUID', desc: 'Description', ldes: 'Long description',
  tvsh: 'Show', tven: 'Episode ID', tvsn: 'Season', tves: 'Episode', tvnn: 'Network', sonm: 'Title sort', soar: 'Artist sort',
  soal: 'Album sort', soaa: 'Album artist sort', soco: 'Composer sort', sosn: 'Show sort', purd: 'Purchase date', apID: 'Account',
  ownr: 'Owner', cnID: 'Catalog ID', atID: 'Artist ID', plID: 'Album ID', geID: 'Genre ID', sfID: 'Storefront', xid: 'Vendor ID',
};
const FLAGS = new Set(['cpil', 'pgap', 'pcst', 'shwm']);
const VALUE_NAMES: Record<string, Record<number, string>> = {
  rtng: { 0: 'None', 1: 'Explicit', 2: 'Clean', 4: 'Explicit' },
  stik: { 0: 'Movie', 1: 'Music', 2: 'Audiobook', 6: 'Music video', 9: 'Movie', 10: 'TV show', 11: 'Booklet', 14: 'Ringtone', 21: 'Podcast', 23: 'iTunes U' },
};

/** The Winamp extensions of the ID3v1 genre list, numbers 80 to 191. */
const MORE_GENRES = [
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast-Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde',
  'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening',
  'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet',
  'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore', 'Terror',
  'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop', 'Abstract',
  'Art Rock', 'Baroque', 'Bhangra', 'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo', 'Dub', 'EBM', 'Eclectic', 'Electro',
  'Electroclash', 'Emo', 'Experimental', 'Garage', 'Global', 'IDM', 'Illbient', 'Industro-Goth', 'Jam Band', 'Krautrock',
  'Leftfield', 'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz', 'Post-Punk', 'Post-Rock', 'Psytrance', 'Shoegaze', 'Space Rock',
  'Trop Rock', 'World Music', 'Neoclassical', 'Audiobook', 'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock',
  'G-Funk', 'Dubstep', 'Garage Rock', 'Psybient',
];
const GENRES = [...ID3V1_GENRES, ...MORE_GENRES];

/** Top-level atoms that hold no file offsets, or only the ones corrected here, and so may be moved. */
const MOVABLE = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']);
/** Atoms of a fragmented file, whose audio is addressed from tables this module doesn't rewrite. */
const FRAGMENTS = new Set(['moof', 'mfra', 'sidx', 'ssix', 'styp']);
/** What a sample table may hold besides the chunk offsets. Anything else could address the file (saio does), so it is not moved. */
const SAMPLE_TABLE = new Set([
  'stsd', 'stts', 'ctts', 'cslg', 'stsc', 'stsz', 'stz2', 'stss', 'stps', 'stsh', 'sdtp', 'stdp', 'padb', 'sbgp', 'sgpd', 'subs', 'free', 'skip',
]);

/** A cover and long lyrics fit many times over; a larger index is not read into memory. */
const MAX_MOOV = 256 << 20;
/** Padding left behind the tags when the audio has to be moved anyway, so that the next edits move nothing. */
const PADDING = 2048;
/** Padding may grow up to this before a save reclaims it: a removed cover should make the file smaller. */
const SLACK = 64 << 10;
/** The largest `free` atom that is rebuilt in memory when a save takes space from it. */
const MAX_FREE = 16 << 20;
/** A sound file has a handful of top-level atoms; one that has thousands is something else. */
const MAX_ATOMS = 4096;

// ---- Atoms --------------------------------------------------------------------

/** Reads the atom header at `at`. `rest`, for the top level only, is what an atom of size zero extends over. */
function headerAt(buffer: Buffer, at: number, rest?: number): { type: string; head: number; size: number; open: boolean } | undefined {
  if (at + 8 > buffer.length) {
    return undefined;
  }
  let size = buffer.readUInt32BE(at);
  let head = 8;
  const open = size === 0 && rest !== undefined;
  if (size === 1) {
    if (at + 16 > buffer.length) {
      return undefined;
    }
    const wide = buffer.readBigUInt64BE(at + 8);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    size = Number(wide);
    head = 16;
  } else if (open) {
    size = rest!;
  }
  return size < head ? undefined : { type: buffer.toString('latin1', at + 4, at + 8), head, size, open };
}

/** The atoms that fill `from`..`to` of the moov buffer exactly. A user data list may end in four zero bytes. */
function childrenOf(body: Buffer, from: number, to: number, terminated = false): Atom[] {
  if (from > to) {
    throw damaged();
  }
  const within = body.subarray(0, to);
  const list: Atom[] = [];
  for (let at = from; at < to; ) {
    if (terminated && to - at === 4 && body.readUInt32BE(at) === 0) {
      break;
    }
    const header = headerAt(within, at);
    if (!header || at + header.size > to) {
      throw damaged();
    }
    list.push({ type: header.type, start: at, head: header.head, end: at + header.size });
    at += header.size;
  }
  return list;
}

const inside = (body: Buffer, atom: Atom, terminated = false) => childrenOf(body, atom.start + atom.head, atom.end, terminated);

/** ISO files make meta a full box, with version and flags in front of its children; QuickTime files don't. */
function metaChildren(body: Buffer, meta: Atom): Atom[] {
  for (const skip of [4, 0]) {
    try {
      return childrenOf(body, meta.start + meta.head + skip, meta.end);
    } catch {
      // the other form
    }
  }
  throw damaged();
}

function atom(type: string, ...parts: Buffer[]): Buffer {
  const size = parts.reduce((sum, part) => sum + part.length, 8);
  if (size > 0xffffffff) {
    throw new Error('The tags are too large for an MP4 file.');
  }
  return Buffer.concat([uint32(size), Buffer.from(type, 'latin1'), ...parts]);
}

const padding = (type: string, size: number) => (size ? atom(type, Buffer.alloc(size - 8)) : Buffer.alloc(0));

/** A copy of `body` with `from`..`to` replaced; `path` are the atoms around that range, whose sizes follow. */
function splice(body: Buffer, path: Atom[], from: number, to: number, bytes: Buffer): Buffer {
  const delta = bytes.length - (to - from);
  const out = Buffer.concat([body.subarray(0, from), bytes, body.subarray(to)]);
  for (const { start, head, end } of delta ? path : []) {
    const size = end - start + delta;
    if (head === 16) {
      out.writeBigUInt64BE(BigInt(size), start + 8);
    } else if (size > 0xffffffff) {
      throw new Error('The tags are too large for an MP4 file.');
    } else {
      out.writeUInt32BE(size, start);
    }
  }
  return out;
}

// ---- Reading the file -----------------------------------------------------------

/** The top-level atoms, as far as they can be followed, and what is wrong with the file if something is. */
async function scan(handle: fs.promises.FileHandle, size: number): Promise<{ atoms: Atom[]; problem?: Mp4Refusal }> {
  const atoms: Atom[] = [];
  for (let at = 0; at < size; ) {
    const header = headerAt(await readRange(handle, at, 16), 0, size - at);
    if (!atoms.length && header?.type !== 'ftyp') {
      throw new Mp4Refusal('foreign', 'This is not an MP4 file.');
    }
    if (!header) {
      return { atoms, problem: unsupported('has data behind its last atom') };
    }
    if (at + header.size > size) {
      return { atoms, problem: damaged('ends before its data does (it is incomplete or damaged)') };
    }
    if (FRAGMENTS.has(header.type)) {
      return { atoms, problem: unsupported('is a fragmented MP4 file') };
    }
    if (atoms.length === MAX_ATOMS) {
      return { atoms, problem: unsupported('has an unusual layout') };
    }
    atoms.push({ type: header.type, start: at, head: header.head, end: at + header.size, open: header.open });
    at += header.size;
  }
  if (!atoms.length) {
    throw new Mp4Refusal('foreign', 'This is not an MP4 file.');
  }
  const unknown = atoms.find((a) => !MOVABLE.has(a.type));
  return { atoms, problem: unknown && unsupported(`has an unusual part (${JSON.stringify(unknown.type)})`) };
}

/** The tag atoms inside moov and the items of the list. Throws when the tags can't be read at all. */
function readTagAtoms(body: Buffer, moov: Atom): Pick<Layout, 'udta' | 'meta' | 'hdlr' | 'ilst' | 'pad' | 'items'> & { problem?: Mp4Refusal } {
  const top = inside(body, moov);
  if (top.some((a) => a.type === 'cmov')) {
    throw unsupported('has a compressed index');
  }
  // A meta atom directly in moov is where QuickTime keeps its own kind of tag list, which is not read here.
  if (top.some((a) => a.type === 'meta')) {
    throw unsupported('keeps its tags as QuickTime metadata rather than as an iTunes tag list');
  }
  const udtas = top.filter((a) => a.type === 'udta');
  const udta = udtas.at(0);
  const metas = udta ? inside(body, udta, true).filter((a) => a.type === 'meta') : [];
  const meta = metas.at(0);
  const parts = meta ? metaChildren(body, meta) : [];
  const hdlr = parts.find((a) => a.type === 'hdlr');
  const handler = hdlr && body.toString('latin1', hdlr.start + hdlr.head + 8, hdlr.start + hdlr.head + 12);
  if (parts.some((a) => a.type === 'keys') || (handler !== undefined && handler !== 'mdir')) {
    throw unsupported('keeps its tags as QuickTime metadata rather than as an iTunes tag list');
  }
  const ilsts = parts.filter((a) => a.type === 'ilst');
  const ilst = ilsts.at(0);
  const next = ilst && parts[parts.indexOf(ilst) + 1];
  const problem =
    udtas.length > 1 || metas.length > 1 || ilsts.length > 1
      ? unsupported('has more than one tag list')
      : meta && !hdlr
        ? unsupported('has a tag list of an unknown kind')
        : undefined;
  return { udta, meta, hdlr, ilst, pad: next?.type === 'free' ? next : undefined, items: ilst ? itemsOf(body, ilst) : [], problem };
}

function itemsOf(body: Buffer, ilst: Atom): Item[] {
  return inside(body, ilst).map((entry) => {
    const item: Item = { type: entry.type, raw: body.subarray(entry.start, entry.end), data: [] };
    let parts: Atom[];
    try {
      parts = inside(body, entry);
    } catch {
      return item; // not a list of atoms: carried along as it is
    }
    for (const part of parts) {
      const from = part.start + part.head;
      if (part.type === 'data' && part.end - from >= 8) {
        // One byte of type set (always zero), three of type; the locale follows.
        const kind = body.readUInt32BE(from) & 0xffffff;
        item.data.push({ kind, value: body.subarray(from + 8, part.end), start: part.start - entry.start, end: part.end - entry.start });
      } else if ((part.type === 'mean' || part.type === 'name') && part.end - from >= 4) {
        item[part.type] = body.toString('utf8', from + 4, part.end);
      }
    }
    return item;
  });
}

/**
 * The chunk offset table of every track. Throws unless each track is laid out in a way that
 * makes these tables the only thing to correct when the audio moves.
 */
function tablesOf(body: Buffer): Table[] {
  const moov: Atom = { type: 'moov', start: 0, head: headerAt(body, 0, body.length)!.head, end: body.length };
  const top = inside(body, moov);
  if (top.some((a) => a.type === 'mvex')) {
    throw unsupported('is a fragmented MP4 file');
  }
  const child = (parent: Atom, type: string) => {
    const found = inside(body, parent).filter((a) => a.type === type);
    if (found.length !== 1) {
      throw unsupported('has a track with an unusual layout');
    }
    return found[0];
  };
  // Item locations (iloc) are file offsets as well.
  const locatesItems = (parent: Atom) =>
    inside(body, parent).some((a) => a.type === 'meta' && metaChildren(body, a).some((part) => part.type === 'iloc'));

  return top.filter((a) => a.type === 'trak').map((trak) => {
    const mdia = child(trak, 'mdia');
    const minf = child(mdia, 'minf');
    const stbl = child(minf, 'stbl');
    // The offsets are only this file's when every data reference says "in this file".
    const dref = child(child(minf, 'dinf'), 'dref');
    const references = childrenOf(body, dref.start + dref.head + 8, dref.end);
    if (locatesItems(trak) || !references.every((r) => body[r.start + r.head + 3] & 1)) {
      throw unsupported('has a track with an unusual layout');
    }
    const parts = inside(body, stbl);
    const tables = parts.filter((a) => a.type === 'stco' || a.type === 'co64');
    if (tables.length !== 1 || parts.some((a) => a !== tables[0] && !SAMPLE_TABLE.has(a.type))) {
      throw unsupported('has a track with an unusual layout');
    }
    const table = tables[0];
    const wide = table.type === 'co64';
    const from = table.start + table.head;
    const count = body.readUInt32BE(from + 4);
    if (table.end - from !== 8 + count * (wide ? 8 : 4)) {
      throw damaged();
    }
    const offsets: number[] = [];
    for (let i = 0, at = from + 8; i < count; i++, at += wide ? 8 : 4) {
      const offset = wide ? body.readBigUInt64BE(at) : body.readUInt32BE(at);
      if (offset > Number.MAX_SAFE_INTEGER) {
        throw damaged();
      }
      offsets.push(Number(offset));
    }
    return { wide, atom: table, path: [moov, trak, mdia, minf, stbl], offsets, lengths: chunkLengths(body, parts, count) };
  });
}

/**
 * The size of every chunk of a track: the sample sizes (stsz, stz2) dealt out by the
 * sample-to-chunk runs (stsc). It is what tells a file that was cut short from a whole one
 * when the size of mdat doesn't. Where the tables are of a kind not known here the result
 * is too small rather than too large.
 */
function chunkLengths(body: Buffer, parts: Atom[], chunks: number): number[] {
  const lengths = new Array<number>(chunks).fill(0);
  const runs = parts.find((a) => a.type === 'stsc');
  const sizes = parts.find((a) => a.type === 'stsz' || a.type === 'stz2');
  if (!runs || !sizes) {
    return lengths;
  }
  const at = sizes.start + sizes.head;
  const uniform = sizes.type === 'stsz' ? body.readUInt32BE(at + 4) : 0;
  const bits = sizes.type === 'stsz' ? 32 : body[at + 7];
  const samples = body.readUInt32BE(at + 8);
  if (![4, 8, 16, 32].includes(bits) || (!uniform && sizes.end - at < 12 + Math.ceil((samples * bits) / 8))) {
    throw damaged();
  }
  const sizeOf = (i: number) =>
    bits === 32 ? body.readUInt32BE(at + 12 + i * 4)
      : bits === 16 ? body.readUInt16BE(at + 12 + i * 2)
        : bits === 8 ? body[at + 12 + i]
          : (body[at + 12 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15;

  const from = runs.start + runs.head;
  const count = body.readUInt32BE(from + 4);
  if (runs.end - from < 8 + count * 12) {
    throw damaged();
  }
  let sample = 0;
  for (let run = 0; run < count; run++) {
    // Each run: the first chunk it applies to (counted from one) and the samples per chunk from there on.
    const first = Math.max(1, body.readUInt32BE(from + 8 + run * 12));
    const perChunk = body.readUInt32BE(from + 12 + run * 12);
    const next = run + 1 < count ? body.readUInt32BE(from + 20 + run * 12) : chunks + 1;
    for (let chunk = first; chunk < next && chunk <= chunks; chunk++) {
      const take = Math.min(perChunk, samples - sample);
      let bytes = uniform * take;
      for (let i = 0; !uniform && i < take; i++) {
        bytes += sizeOf(sample + i);
      }
      sample += take;
      lengths[chunk - 1] = bytes;
    }
  }
  return lengths;
}

/** Runs a parsing step; a read past the end of the buffer means the sizes in the file don't add up. */
function parse<T>(step: () => T): T | Mp4Refusal {
  try {
    return step();
  } catch (e) {
    if (e instanceof Mp4Refusal) {
      return e;
    }
    if (e instanceof RangeError) {
      return damaged();
    }
    throw e;
  }
}

/**
 * Reads the structure of the file. `layout` is there when the tags could be read, `problem`
 * when the file can't be rewritten. Throws only for a "foreign" file and for I/O errors.
 */
async function load(file: string): Promise<{ layout?: Layout; problem?: Mp4Refusal }> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const { atoms, problem: found } = await scan(handle, size);
    let problem = found;
    // The first reason is the one reported, except that damage outweighs an unusual layout.
    const note = (next: Mp4Refusal | undefined) => {
      if (next && (!problem || (next.kind === 'damaged' && problem.kind !== 'damaged'))) {
        problem = next;
      }
    };
    const moovs = atoms.filter((a) => a.type === 'moov');
    const moov = moovs.at(0);
    if (!moov) {
      note(damaged('has no index (it is incomplete or damaged)'));
      return { problem };
    }
    if (moovs.length > 1) {
      note(unsupported('has more than one index'));
    }
    if (moov.end - moov.start > MAX_MOOV) {
      note(unsupported('has an unusually large index'));
      return { problem };
    }
    const body = await readRange(handle, moov.start, moov.end - moov.start);
    if (body.length !== moov.end - moov.start) {
      note(damaged());
      return { problem };
    }
    // Inside the buffer the atom starts at zero.
    const tags = parse(() => readTagAtoms(body, { ...moov, start: 0, end: body.length }));
    if (tags instanceof Mp4Refusal) {
      note(tags);
      return { problem };
    }
    const { problem: unusual, ...list } = tags;
    note(unusual);
    const tables = parse(() => tablesOf(body));
    if (tables instanceof Mp4Refusal) {
      note(tables);
      return { layout: { size, atoms, moov, body, ...list, tables: [] }, problem };
    }
    // Every chunk is expected inside an mdat atom. One that isn't is not understood, and not moved; one that ends
    // behind the file has lost its end, which a size of mdat that says "to the end of the file" doesn't show.
    const audio = atoms.filter((a) => a.type === 'mdat');
    const ends = tables.flatMap((t) => t.offsets.map((offset, i) => [offset, offset + t.lengths[i]]));
    const stray = ends.filter(([start, end]) => !audio.some((a) => start >= a.start + a.head && end <= a.end));
    if (stray.length) {
      note(stray.some(([, end]) => end > size) ? damaged('ends before its data does (it is incomplete or damaged)') : unsupported('keeps audio data in an unusual place'));
    }
    return { layout: { size, atoms, moov, body, ...list, tables }, problem };
  } finally {
    await handle.close();
  }
}

// ---- Items ----------------------------------------------------------------------

function textOf({ kind, value }: Pick<Value, 'kind' | 'value'>): string {
  const text =
    kind === 2 || kind === 5
      ? Buffer.from(value.subarray(0, value.length & ~1)).swap16().toString('utf16le')
      : kind === 1 || kind === 4
        ? value.toString('utf8')
        : decodeLoose(value);
  return text.replace(/\0+$/, '');
}

/** Track and disc: two reserved bytes, the number, the total. */
function pairOf(item: Item | undefined): [number: number, total: number] {
  const value = item?.data[0]?.value;
  return value && value.length >= 4 ? [value.readUInt16BE(2), value.length >= 6 ? value.readUInt16BE(4) : 0] : [0, 0];
}

const pairText = ([number, total]: [number, number]) => (total ? `${number}/${total}` : number ? String(number) : '');

function parsePair(text: string): [number, number] | undefined {
  const match = /^(\d{1,5})?(?:\s*\/\s*(\d{1,5}))?$/.exec(text.trim());
  const pair: [number, number] | undefined = match ? [Number(match[1] ?? 0), Number(match[2] ?? 0)] : undefined;
  return pair && pair.every((n) => n <= 0xffff) ? pair : undefined;
}

const genreNumber = (item: Item | undefined) => {
  const value = item?.data[0]?.value;
  return value && value.length >= 2 ? value.readUInt16BE(value.length - 2) : 0;
};

/** A field may be stored as several values (two artists, say); they are shown joined. */
const joined = (item: Item | undefined) => (item ? item.data.map(textOf).filter(Boolean).join('; ') : '');

function fieldsOf(items: Item[]): Fields {
  const fields = emptyFields();
  const first = (type: string) => items.find((item) => item.type === type);
  for (const [field, type] of Object.entries(TEXT) as [Field, string][]) {
    fields[field] = joined(first(type));
  }
  fields.track = pairText(pairOf(first(PAIRS.track)));
  fields.disc = pairText(pairOf(first(PAIRS.disc)));
  fields.genre = joined(first(GENRE_TEXT)) || (GENRES[genreNumber(first(GENRE_NUMBER)) - 1] ?? '');
  return fields;
}

const pictures = (items: Item[]) => items.filter((item) => item.type === COVER).flatMap((item) => item.data.filter((d) => d.value.length));

const byteCount = (n: number) => (n < 1024 ? `${n} bytes` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

const IMAGES: Record<number, string> = { 13: 'JPEG', 14: 'PNG', 27: 'BMP' };

function showValue(type: string, { kind, value }: Value): string {
  if (kind === 1 || kind === 2 || kind === 4 || kind === 5) {
    return textOf({ kind, value });
  }
  if (IMAGES[kind]) {
    return `${IMAGES[kind]} image, ${byteCount(value.length)}`;
  }
  // 21 is a signed integer and 22 an unsigned one, of whatever length the writer chose.
  if ((kind === 21 || kind === 22) && value.length >= 1 && value.length <= 4) {
    const number = kind === 21 ? value.readIntBE(0, value.length) : value.readUIntBE(0, value.length);
    return FLAGS.has(type) ? (number ? 'Yes' : 'No') : (VALUE_NAMES[type]?.[number] ?? String(number));
  }
  if ((kind === 21 || kind === 22) && value.length === 8) {
    return String(kind === 21 ? value.readBigInt64BE() : value.readBigUInt64BE());
  }
  return value.length <= 16 ? value.toString('hex').replace(/(..)(?=.)/g, '$1 ') : `${byteCount(value.length)} of data`;
}

function otherOf(items: Item[]): Tag[] {
  const other: Tag[] = [];
  for (const item of items) {
    if (!MANAGED.has(item.type)) {
      const key =
        item.type === FREEFORM
          ? `${item.mean && item.mean !== 'com.apple.iTunes' ? `${item.mean}:` : ''}${item.name ?? item.type}`
          : (ITEM_NAMES[item.type.trim()] ?? item.type);
      const value = item.data.map((d) => showValue(item.type, d)).filter(Boolean).join('; ');
      if (value) {
        other.push([key, value]);
      }
    }
  }
  const number = genreNumber(items.find((item) => item.type === GENRE_NUMBER));
  if (number && !GENRES[number - 1]) {
    other.push(['Genre number', String(number)]);
  }
  for (const picture of pictures(items).slice(1)) {
    other.push(['Additional picture', showValue(COVER, picture)]);
  }
  return other;
}

const tagsOf = (items: Item[]): TagData => ({ fields: fieldsOf(items), other: otherOf(items), cover: pictures(items).at(0)?.value });

/** The form trims its values and normalises line ends; a stored value that differs only in that was not edited. */
const tidy = (text: string) => text.replace(/\r\n?/g, '\n').trim();

function sameValue(field: Field, a: string, b: string): boolean {
  if (field === 'track' || field === 'disc') {
    const [first, second] = [parsePair(a), parsePair(b)];
    if (first && second) {
      return first[0] === second[0] && first[1] === second[1];
    }
  }
  return tidy(a) === tidy(b);
}

const dataAtom = (kind: number, value: Buffer) => atom('data', uint32(kind), uint32(0), value);
const textItem = (type: string, text: string) => atom(type, dataAtom(1, Buffer.from(text, 'utf8')));

function pairItem(field: 'track' | 'disc', text: string): Buffer | undefined {
  const pair = parsePair(text);
  if (!pair) {
    throw new Error(`${field === 'track' ? 'Track' : 'Disc'} has to be a number, or number/total (3/12, up to 65535), in an MP4 file.`);
  }
  if (!pair[0] && !pair[1]) {
    return undefined;
  }
  // iTunes writes two more reserved bytes after the track total, and none after the disc total.
  const value = Buffer.alloc(field === 'track' ? 8 : 6);
  value.writeUInt16BE(pair[0], 2);
  value.writeUInt16BE(pair[1], 4);
  return atom(PAIRS[field], dataAtom(0, value));
}

/** The raw items of the list after the edit. Untouched items are the original bytes. */
function editItems(items: Item[], fields: Fields, cover: CoverChange, image: Buffer | undefined): Buffer[] {
  let list = items.map(({ type, raw }) => ({ type, raw }));
  const current = fieldsOf(items);
  /** The new item takes the place of the first one it replaces; without a new item they are all removed. */
  const put = (types: string[], next: Buffer | undefined) => {
    const first = list.findIndex((item) => types.includes(item.type));
    list = list.flatMap((item, i) => (!types.includes(item.type) ? [item] : i === first && next ? [{ type: types[0], raw: next }] : []));
    if (first < 0 && next) {
      list.push({ type: types[0], raw: next });
    }
  };

  for (const field of FIELDS) {
    if (sameValue(field, fields[field], current[field])) {
      continue;
    }
    const value = tidy(fields[field]);
    if (field === 'track' || field === 'disc') {
      put([PAIRS[field]], pairItem(field, value));
    } else if (field === 'genre') {
      // Always written as text: the number can't name a genre outside its list.
      put([GENRE_TEXT, GENRE_NUMBER], value ? textItem(GENRE_TEXT, value) : undefined);
    } else {
      put([TEXT[field]!], value ? textItem(TEXT[field]!, value) : undefined);
    }
  }

  if (cover.action === 'remove') {
    // All pictures go: leaving a back cover behind would just make it show up as the cover.
    put([COVER], undefined);
  } else if (image) {
    const picture = dataAtom(imageMime(image) === 'image/png' ? 14 : 13, image);
    // The cover is the first picture of the first item that has one; further pictures stay where they are.
    const holder = items.find((item) => item.type === COVER && item.data.some((d) => d.value.length)) ?? items.find((item) => item.type === COVER);
    const entry = holder && list.find((item) => item.raw === holder.raw);
    if (entry && holder) {
      const { raw, data } = holder;
      const old = data.find((d) => d.value.length) ?? data.at(0);
      entry.raw = old ? atom(COVER, raw.subarray(headerAt(raw, 0)!.head, old.start), picture, raw.subarray(old.end)) : atom(COVER, picture);
    } else {
      list.push({ type: COVER, raw: atom(COVER, picture) });
    }
  }
  return list.map((item) => item.raw);
}

// ---- Writing --------------------------------------------------------------------

/** The handler atom that marks a meta atom as an iTunes tag list. */
const HANDLER = atom('hdlr', Buffer.alloc(8), Buffer.from('mdirappl'), Buffer.alloc(9));

/** A copy of moov with the new tag list and `pad` bytes of padding behind it; missing parent atoms are created. */
function withList(layout: Layout, ilst: Buffer, pad: number): Buffer {
  const { body, udta, meta, hdlr } = layout;
  const moov: Atom = { ...layout.moov, start: 0, end: body.length };
  const list = Buffer.concat([ilst, padding('free', pad)]);
  if (layout.ilst) {
    return splice(body, [moov, udta!, meta!], layout.ilst.start, (layout.pad ?? layout.ilst).end, list);
  }
  if (meta) {
    return splice(body, [moov, udta!, meta], hdlr!.end, hdlr!.end, list);
  }
  const fresh = atom('meta', uint32(0), HANDLER, list);
  if (udta) {
    // In front of the four zero bytes that may end the list.
    const end = inside(body, udta, true).at(-1)?.end ?? udta.start + udta.head;
    return splice(body, [moov, udta], end, end, fresh);
  }
  return splice(body, [moov], body.length, body.length, atom('udta', fresh));
}

/**
 * Corrects the chunk offsets in a copy of moov that has grown or shrunk: everything behind
 * the old moov moves by the difference. A 32-bit table that can't hold a moved offset
 * becomes a 64-bit one, which moves the audio a little further still.
 */
function relocate(grown: Buffer, layout: Layout): Buffer {
  let body = grown;
  for (;;) {
    const tables = tablesOf(body);
    const shift = body.length - layout.body.length;
    const moved = (offset: number) => (offset >= layout.moov.end ? offset + shift : offset);
    const narrow = tables.find((t) => !t.wide && t.offsets.some((o) => moved(o) > 0xffffffff));
    if (narrow) {
      const entries = Buffer.alloc(narrow.offsets.length * 8);
      narrow.offsets.forEach((offset, i) => entries.writeBigUInt64BE(BigInt(offset), i * 8));
      const head = narrow.atom.start + narrow.atom.head;
      body = splice(body, narrow.path, narrow.atom.start, narrow.atom.end, atom('co64', body.subarray(head, head + 8), entries));
      continue;
    }
    for (const table of tables) {
      table.offsets.forEach((offset, i) => {
        const at = table.atom.start + table.atom.head + 8 + i * (table.wide ? 8 : 4);
        table.wide ? body.writeBigUInt64BE(BigInt(moved(offset)), at) : body.writeUInt32BE(moved(offset), at);
      });
    }
    return body;
  }
}

/** The parts of the new file, and how far the audio behind moov moves. In the first two cases it stays where it is. */
function plan(layout: Layout, ilst: Buffer): { parts: Part[]; shift: number } {
  const { atoms, moov, body, size } = layout;
  const fits = (pad: number, was: number) => (pad === 0 || pad >= 8) && pad <= Math.max(was, SLACK);
  const before: Part = { start: 0, end: moov.start };

  // 1. The padding behind the list takes the difference, and moov keeps its size.
  if (layout.ilst) {
    const was = layout.pad ? layout.pad.end - layout.pad.start : 0;
    const pad = was + (layout.ilst.end - layout.ilst.start) - ilst.length;
    if (fits(pad, was)) {
      return { parts: [before, withList(layout, ilst, pad), { start: moov.end, end: size }], shift: 0 };
    }
  }
  // 2. A free atom right behind moov takes it, which is where iTunes leaves its padding.
  const next = atoms[atoms.indexOf(moov) + 1];
  if (next && (next.type === 'free' || next.type === 'skip') && next.head === 8 && !next.open) {
    const bare = withList(layout, ilst, 0);
    const was = next.end - next.start;
    const room = was - (bare.length - body.length);
    if (fits(room, was) && room <= MAX_FREE) {
      return { parts: [before, bare, padding(next.type, room), { start: next.end, end: size }], shift: 0 };
    }
  }
  // 3. Everything behind moov moves, and the offset tables follow.
  const moved = relocate(withList(layout, ilst, PADDING), layout);
  return { parts: [before, moved, { start: moov.end, end: size }], shift: moved.length - body.length };
}

const FAILED = 'The rewritten file did not pass the integrity check; the original was left untouched.';

/**
 * Compares the assembled file with the original before it takes its place: the tags must
 * read back as requested, every other item must be the same bytes, and every chunk of every
 * track must be found at its new offset.
 */
async function verify(
  file: string, temp: string, before: Layout, expected: { size: number; shift: number; fields: Fields; pictures: Buffer[] },
): Promise<void> {
  const { layout: after, problem } = await load(temp);
  const check = (ok: boolean) => {
    if (!ok) {
      throw new Error(FAILED);
    }
  };
  check(!!after && !problem);
  const { items, tables, size } = after!;
  check(size === expected.size);

  const tags = tagsOf(items);
  check(FIELDS.every((field) => sameValue(field, tags.fields[field], expected.fields[field])));
  const shown = pictures(items);
  check(shown.length === expected.pictures.length && shown.every((picture, i) => picture.value.equals(expected.pictures[i])));
  const kept = (list: Item[]) => list.filter((item) => !MANAGED.has(item.type));
  check(kept(items).length === kept(before.items).length && kept(items).every((item, i) => item.raw.equals(kept(before.items)[i].raw)));

  const moved = (offset: number) => (offset >= before.moov.end ? offset + expected.shift : offset);
  const audio = (layout: Layout) => layout.atoms.filter((a) => a.type === 'mdat');
  check(audio(after!).length === audio(before).length);
  check(audio(after!).every((a, i) => a.start === moved(audio(before)[i].start) && a.end - a.start === audio(before)[i].end - audio(before)[i].start));
  check(tables.length === before.tables.length);
  const [original, written] = await Promise.all([fs.promises.open(file, 'r'), fs.promises.open(temp, 'r')]);
  try {
    for (const [i, table] of tables.entries()) {
      const old = before.tables[i].offsets;
      check(table.offsets.length === old.length && table.offsets.every((offset, j) => offset === moved(old[j])));
      // The start, the middle and the end of a spread of chunks, read through the new table, have to be the bytes
      // the old table pointed at. Nothing is read past a chunk: what follows the last one may be moov itself.
      const step = Math.max(1, Math.floor(old.length / 64));
      for (let j = 0; j < old.length; j += step) {
        const length = before.tables[i].lengths[j];
        check(table.lengths[j] === length);
        for (const at of new Set([0, Math.max(0, Math.floor(length / 2) - 32), Math.max(0, length - 64)])) {
          const span = Math.min(64, length - at);
          const [was, now] = await Promise.all([readRange(original, old[j] + at, span), readRange(written, table.offsets[j] + at, span)]);
          check(was.length === span && was.equals(now));
        }
      }
    }
  } finally {
    await Promise.all([original.close(), written.close()]);
  }
}

// ---- Entry points -----------------------------------------------------------------

export interface Mp4Report {
  /** The tags, when they could be read. */
  data?: TagData;
  /** Why the file can't be rewritten here, when that is the case. */
  refusal?: Mp4Refusal;
}

/** Reads the tags and says whether writeMp4() would take the file. Undefined when this is not an MP4 file. */
export async function readMp4(file: string): Promise<Mp4Report | undefined> {
  try {
    const { layout, problem } = await load(file);
    return { data: layout && tagsOf(layout.items), refusal: problem };
  } catch (e) {
    if (e instanceof Mp4Refusal) {
      return undefined;
    }
    throw e;
  }
}

/** Throws an Mp4Refusal, before anything is written, when the file is not one to rewrite here. */
export async function writeMp4(file: string, fields: Fields, cover: CoverChange): Promise<void> {
  const { layout, problem } = await load(file);
  if (problem || !layout) {
    throw problem ?? damaged();
  }
  const image = cover.action === 'replace' ? await fs.promises.readFile(cover.path) : undefined;
  if (image?.length === 0) {
    throw new Error('The cover image is an empty file.');
  }
  const ilst = atom('ilst', ...editItems(layout.items, fields, cover, image));
  const { body } = layout;
  if (layout.ilst ? ilst.equals(body.subarray(layout.ilst.start, layout.ilst.end)) : ilst.length === 8) {
    return; // nothing to write: the file already says exactly this
  }
  const { parts, shift } = plan(layout, ilst);
  const size = parts.reduce((sum: number, part) => sum + (Buffer.isBuffer(part) ? part.length : part.end - part.start), 0);
  const old = pictures(layout.items).map((picture) => picture.value);
  const expected = { size, shift, fields, pictures: cover.action === 'remove' ? [] : image ? [image, ...old.slice(1)] : old };
  await rewriteFile(file, parts, (temp) => verify(file, temp, layout, expected));
}
