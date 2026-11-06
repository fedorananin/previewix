import * as fs from 'fs';
import {
  FIELDS, Incomplete, emptyFields, flacPicture, readRange, rewriteFile, uint32,
  type CoverChange, type Field, type Fields, type Part, type Tag, type TagData,
} from './common';

/**
 * FLAC tags: a Vorbis comment block for the text and picture blocks for cover art.
 * Saving rewrites only the metadata blocks in front of the audio frames.
 */

const STREAMINFO = 0;
const PADDING = 1;
const VORBIS_COMMENT = 4;
const PICTURE = 6;

/** Comment names per field, the first being the one written when the tag is new. Names are case-insensitive. */
const NAMES: Record<Field, string[]> = {
  title: ['TITLE'],
  artist: ['ARTIST'],
  album: ['ALBUM'],
  album_artist: ['ALBUMARTIST', 'ALBUM ARTIST'],
  date: ['DATE', 'YEAR'],
  track: ['TRACKNUMBER'],
  disc: ['DISCNUMBER'],
  genre: ['GENRE'],
  composer: ['COMPOSER'],
  comment: ['COMMENT', 'DESCRIPTION'],
  lyrics: ['LYRICS', 'UNSYNCEDLYRICS'],
};

interface Block {
  type: number;
  data: Buffer;
}

interface Comments {
  vendor: Buffer;
  entries: Tag[];
}

/** No tagger writes more than a few dozen; a file of zeros behind the signature is millions of empty blocks. */
const MAX_BLOCKS = 1024;

/**
 * The metadata blocks and where the audio begins; undefined when the file doesn't start as a FLAC stream.
 * A file that ends before its last block does is refused here, for reading too: taken as it comes, it would
 * be saved as a file that looks complete, with that block cut short and without any audio.
 */
async function scan(handle: fs.promises.FileHandle): Promise<{ blocks: Block[]; audioStart: number } | undefined> {
  if ((await readRange(handle, 0, 4)).toString('latin1') !== 'fLaC') {
    return undefined;
  }
  const blocks: Block[] = [];
  for (let at = 4; ; ) {
    const header = await readRange(handle, at, 4);
    if (header.length < 4 || blocks.length >= MAX_BLOCKS) {
      throw new Incomplete('its metadata');
    }
    const length = header.readUIntBE(1, 3);
    const data = await readRange(handle, at + 4, length);
    if (data.length < length) {
      throw new Incomplete('its metadata');
    }
    blocks.push({ type: header[0] & 0x7f, data });
    at += 4 + length;
    if (header[0] & 0x80) {
      return { blocks, audioStart: at };
    }
  }
}

function parseComments(data: Buffer | undefined): Comments {
  if (!data) {
    return { vendor: Buffer.from('Previewix'), entries: [] };
  }
  const vendorLength = data.readUInt32LE(0);
  const vendor = data.subarray(4, 4 + vendorLength);
  const entries: Tag[] = [];
  let at = 4 + vendorLength;
  const count = data.readUInt32LE(at);
  at += 4;
  for (let i = 0; i < count && at + 4 <= data.length; i++) {
    const length = data.readUInt32LE(at);
    const entry = data.toString('utf8', at + 4, at + 4 + length);
    const split = entry.indexOf('=');
    if (split > 0) {
      entries.push([entry.slice(0, split), entry.slice(split + 1)]);
    }
    at += 4 + length;
  }
  return { vendor, entries };
}

function buildComments({ vendor, entries }: Comments): Buffer {
  const le = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const parts = [le(vendor.length), vendor, le(entries.length)];
  for (const [key, value] of entries) {
    const entry = Buffer.from(`${key}=${value}`, 'utf8');
    parts.push(le(entry.length), entry);
  }
  return Buffer.concat(parts);
}

const fieldOf = (key: string) => FIELDS.find((field) => NAMES[field].includes(key.toUpperCase()));

/** A field may be stored as several comments (two artists, say); they are shown joined. */
function fieldsOf(entries: Tag[]): Fields {
  const fields = emptyFields();
  for (const [key, value] of entries) {
    const field = fieldOf(key);
    if (field) {
      fields[field] = fields[field] ? `${fields[field]}; ${value}` : value;
    }
  }
  return fields;
}

function pictureOf(block: Block): { type: number; image: Buffer } {
  const { data } = block;
  let at = 4;
  at += 4 + data.readUInt32BE(at); // MIME type
  at += 4 + data.readUInt32BE(at); // description
  at += 16; // width, height, depth, colours
  return { type: data.readUInt32BE(0), image: data.subarray(at + 4, at + 4 + data.readUInt32BE(at)) };
}

function coverBlock(blocks: Block[]): Block | undefined {
  const pictures = blocks.filter((b) => b.type === PICTURE);
  return pictures.find((b) => pictureOf(b).type === 3) ?? pictures[0];
}

export async function readFlac(file: string): Promise<TagData | undefined> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const scanned = await scan(handle);
    if (!scanned) {
      return undefined;
    }
    const { entries } = parseComments(scanned.blocks.find((b) => b.type === VORBIS_COMMENT)?.data);
    const cover = coverBlock(scanned.blocks);
    return {
      fields: fieldsOf(entries),
      other: entries.filter(([key]) => !fieldOf(key) && key.toUpperCase() !== 'METADATA_BLOCK_PICTURE'),
      cover: cover && pictureOf(cover).image,
    };
  } finally {
    await handle.close();
  }
}

export async function writeFlac(file: string, fields: Fields, cover: CoverChange): Promise<void> {
  const handle = await fs.promises.open(file, 'r');
  let scanned;
  let size;
  try {
    scanned = await scan(handle);
    size = (await handle.stat()).size;
  } finally {
    await handle.close();
  }
  if (!scanned) {
    throw new Error('This FLAC file has an unexpected layout and was left untouched.');
  }

  const comments = parseComments(scanned.blocks.find((b) => b.type === VORBIS_COMMENT)?.data);
  const current = fieldsOf(comments.entries);
  for (const field of FIELDS) {
    if (fields[field] === current[field]) {
      continue;
    }
    // The new value takes the place, and the name, of the first comment it replaces.
    const first = comments.entries.findIndex(([key]) => fieldOf(key) === field);
    const name = first >= 0 ? comments.entries[first][0] : NAMES[field][0];
    comments.entries = comments.entries.flatMap((entry, i): Tag[] =>
      fieldOf(entry[0]) !== field ? [entry] : i === first && fields[field] ? [[name, fields[field]]] : [],
    );
    if (first < 0 && fields[field]) {
      comments.entries.push([name, fields[field]]);
    }
  }

  // Replacing swaps the cover picture only; removing drops every picture, or a back cover would show up as the cover.
  const oldCover = cover.action === 'replace' ? coverBlock(scanned.blocks) : undefined;
  const blocks = scanned.blocks.filter(
    (b) => b.type !== VORBIS_COMMENT && b.type !== PADDING && b !== oldCover && !(cover.action === 'remove' && b.type === PICTURE),
  );
  // STREAMINFO has to stay first; everything else follows in its original order.
  blocks.sort((a, b) => Number(b.type === STREAMINFO) - Number(a.type === STREAMINFO));
  blocks.push({ type: VORBIS_COMMENT, data: buildComments(comments) });
  if (cover.action === 'replace') {
    blocks.push({ type: PICTURE, data: flacPicture(await fs.promises.readFile(cover.path)) });
  }
  blocks.push({ type: PADDING, data: Buffer.alloc(2048) });

  const parts: Part[] = [Buffer.from('fLaC')];
  blocks.forEach((block, i) => {
    if (block.data.length > 0xffffff) {
      throw new Error('The cover image is too large for a FLAC file (16 MB at most).');
    }
    const header = uint32(block.data.length);
    header[0] = block.type | (i === blocks.length - 1 ? 0x80 : 0);
    parts.push(header, block.data);
  });
  parts.push({ start: scanned.audioStart, end: size });
  await rewriteFile(file, parts);
}
