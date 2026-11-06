import * as fs from 'fs';
import {
  Incomplete, decodeLoose, emptyFields, readRange, rewriteFile,
  type CoverChange, type Field, type Fields, type Part, type Tag, type TagData,
} from './common';
import { readId3, updateId3 } from './id3';

/**
 * WAV tags. There are two places for them: the original RIFF "LIST INFO" chunk, which only
 * knows a handful of fields, and an "id3 " chunk holding a full ID3v2 tag, which is what
 * modern taggers and players use. Both are read (ID3 wins) and both are written, so that
 * simple software still sees the basic fields while everything, cover included, is kept.
 */

const INFO: Partial<Record<Field, string>> = {
  title: 'INAM', artist: 'IART', album: 'IPRD', date: 'ICRD', genre: 'IGNR', comment: 'ICMT', track: 'ITRK',
};
const INFO_NAMES: Record<string, string> = { ISFT: 'Software', ICOP: 'Copyright', IENG: 'Engineer', ISRC: 'Source', ITCH: 'Technician' };

interface Chunk {
  id: string;
  /** Offset and size of the chunk's data, header excluded. */
  start: number;
  size: number;
}

const isId3 = (chunk: Chunk) => chunk.id.toLowerCase() === 'id3 ';

/** A sound file has a dozen chunks at most; a file of zeros behind the header is an empty chunk every eight bytes. */
const MAX_CHUNKS = 1024;

async function scan(handle: fs.promises.FileHandle): Promise<Chunk[] | undefined> {
  const fileSize = (await handle.stat()).size;
  const header = await readRange(handle, 0, 12);
  if (header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') {
    return undefined; // RF64 and other variants for files over 4 GB
  }
  const chunks: Chunk[] = [];
  for (let at = 12; at + 8 <= fileSize; ) {
    if (chunks.length >= MAX_CHUNKS) {
      return undefined;
    }
    const head = await readRange(handle, at, 8);
    const id = head.toString('latin1', 0, 4);
    const declared = head.readUInt32LE(4);
    const left = fileSize - at - 8;
    // Only the audio may be shorter than it says: recorders that were cut off leave the size of the data chunk
    // at zero or at its maximum. Any other chunk that ends behind the file means a file that was cut, and saving
    // that would give a file that looks complete, with the chunk shortened to fit.
    if (id !== 'data' && declared > left) {
      throw new Incomplete('one of its chunks');
    }
    const size = Math.min(declared === 0 && id === 'data' ? fileSize : declared, left);
    chunks.push({ id, start: at + 8, size });
    at += 8 + size + (size & 1);
  }
  return chunks;
}

/** The sub-chunks of a LIST chunk of type INFO; undefined for any other LIST. */
function parseInfo(data: Buffer): Tag[] | undefined {
  if (data.toString('latin1', 0, 4) !== 'INFO') {
    return undefined;
  }
  const entries: Tag[] = [];
  for (let at = 4; at + 8 <= data.length; ) {
    const size = data.readUInt32LE(at + 4);
    const text = decodeLoose(data.subarray(at + 8, at + 8 + size)).replace(/\0+$/, '');
    entries.push([data.toString('latin1', at, at + 4), text]);
    at += 8 + size + (size & 1);
  }
  return entries;
}

function chunk(id: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}

interface WavTags {
  chunks: Chunk[];
  info: Tag[];
  infoChunk?: Chunk;
  id3?: Buffer;
  id3Chunk?: Chunk;
}

async function load(handle: fs.promises.FileHandle): Promise<WavTags | undefined> {
  const chunks = await scan(handle);
  if (!chunks) {
    return undefined;
  }
  const result: WavTags = { chunks, info: [] };
  for (const c of chunks) {
    if (c.id === 'LIST' && !result.infoChunk) {
      const info = parseInfo(await readRange(handle, c.start, c.size));
      if (info) {
        result.info = info;
        result.infoChunk = c;
      }
    } else if (isId3(c) && !result.id3Chunk) {
      result.id3 = await readRange(handle, c.start, c.size);
      result.id3Chunk = c;
    }
  }
  return result;
}

/** ffmpeg and some recorders store the track number as IPRT ("part") rather than ITRK. */
const infoField = (id: string) => (id === 'IPRT' ? 'track' : (Object.keys(INFO) as Field[]).find((field) => INFO[field] === id));

export async function readWav(file: string): Promise<TagData | undefined> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const wav = await load(handle);
    if (!wav) {
      return undefined;
    }
    const id3 = wav.id3 && readId3(wav.id3);
    const fields = id3 ? id3.fields : emptyFields();
    const other: Tag[] = id3 ? [...id3.other] : [];
    for (const [id, value] of wav.info) {
      const field = infoField(id);
      if (field) {
        fields[field] ||= value;
      } else if (value) {
        other.push([INFO_NAMES[id] ?? id, value]);
      }
    }
    return { fields, other, cover: id3 ? id3.cover : undefined };
  } finally {
    await handle.close();
  }
}

export async function writeWav(file: string, fields: Fields, cover: CoverChange): Promise<void> {
  const handle = await fs.promises.open(file, 'r');
  let wav;
  try {
    wav = await load(handle);
  } finally {
    await handle.close();
  }
  if (!wav) {
    throw new Error('This is not a standard RIFF WAVE file (it may be RF64) and was left untouched.');
  }

  // INFO: the mapped fields are replaced, anything else in the chunk is carried over.
  const info = wav.info.filter(([id]) => !infoField(id));
  for (const field of Object.keys(INFO) as Field[]) {
    if (fields[field]) {
      info.push([INFO[field]!, fields[field]]);
    }
  }
  const infoData = Buffer.concat([
    Buffer.from('INFO'),
    // Values are null-terminated; chunk() adds the padding byte for odd lengths.
    ...info.map(([id, value]) => chunk(id, Buffer.concat([Buffer.from(value, 'utf8'), Buffer.alloc(1)]))),
  ]);

  // An unreadable (v2.2) tag is replaced rather than extended.
  const oldTag = wav.id3 && readId3(wav.id3) ? wav.id3 : Buffer.alloc(0);
  const tag = await updateId3(oldTag, fields, cover);

  const body: Part[] = [];
  let length = 4; // "WAVE"
  const add = (part: Part) => {
    body.push(part);
    length += Buffer.isBuffer(part) ? part.length : part.end - part.start;
  };
  for (const c of wav.chunks) {
    if (c === wav.infoChunk || c === wav.id3Chunk) {
      continue;
    }
    const head = Buffer.alloc(8);
    head.write(c.id, 'latin1');
    head.writeUInt32LE(c.size, 4);
    add(head);
    add({ start: c.start, end: c.start + c.size });
    if (c.size & 1) {
      add(Buffer.alloc(1));
    }
  }
  // Tags go after the audio, where no player is thrown off by them.
  if (info.length) {
    add(chunk('LIST', infoData));
  }
  add(chunk('id3 ', tag));
  if (length > 0xffffffff) {
    throw new Error('The file would exceed the 4 GB limit of the WAV format.');
  }
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 'latin1');
  riff.writeUInt32LE(length, 4);
  riff.write('WAVE', 8, 'latin1');
  await rewriteFile(file, [riff, ...body]);
}
