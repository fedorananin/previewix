import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FIELDS, emptyFields, flacPicture, tempSibling, type CoverChange, type Field, type Fields, type Tag, type TagData } from './common';

/**
 * Reading and writing audio tags with ffmpeg, for the formats that have no dedicated
 * writer here (M4A, Ogg, Opus, AIFF). Tags travel as an ffmetadata file, and a save
 * remuxes the file with `-c copy`: the audio data itself is never re-encoded, which
 * writeTags() verifies before it replaces the original.
 */

/** Formats ffmpeg stores cover art in as an attached picture stream. */
const PICTURE_STREAM = new Set(['m4a', 'm4b']);
/** Ogg keeps both tags and the cover in the audio stream's Vorbis comment. */
const OGG = new Set(['ogg', 'oga', 'opus']);
const TAGS_ONLY = new Set(['aiff', 'aif']);

/** ffmpeg's names per field, the first being the one written when the tag is new. Lyrics may carry a language suffix. */
const NAMES: Record<Field, string[]> = {
  title: ['title'],
  artist: ['artist'],
  album: ['album'],
  album_artist: ['album_artist', 'albumartist', 'album artist'],
  date: ['date', 'year'],
  track: ['track', 'tracknumber'],
  disc: ['disc', 'discnumber'],
  genre: ['genre'],
  composer: ['composer'],
  comment: ['comment', 'description'],
  lyrics: ['lyrics', 'unsyncedlyrics'],
};

const fieldOf = (key: string) => {
  const name = key.toLowerCase().replace(/^lyrics-.*/, 'lyrics');
  return FIELDS.find((field) => NAMES[field].includes(name));
};

/** Container properties that ffmpeg lists among the metadata but that aren't tags. */
const NOT_TAGS = new Set(['major_brand', 'minor_version', 'compatible_brands']);
const OGG_PICTURE = 'metadata_block_picture';

const extensionOf = (file: string) => path.extname(file).slice(1).toLowerCase();

export function capabilities(file: string): { writable: boolean; cover: boolean } {
  const ext = extensionOf(file);
  const cover = PICTURE_STREAM.has(ext) || OGG.has(ext);
  return { writable: cover || TAGS_ONLY.has(ext), cover };
}

function run(ffmpeg: string, args: string[], signal?: AbortSignal, onData?: (chunk: Buffer) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (onData ? onData(chunk) : out.push(chunk)));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new Error('cancelled'));
      } else if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

/** Parses the global section of an ffmetadata dump (`key=value` lines with backslash escapes). */
export function parseMetadata(text: string): Tag[] {
  const tags: Tag[] = [];
  let key = '';
  let value: string | undefined;
  let lineStart = true;
  const flush = () => {
    if (key && value !== undefined) {
      tags.push([key, value]);
    }
    key = '';
    value = undefined;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (lineStart && value === undefined && key === '') {
      if (char === '[') {
        break; // [CHAPTER] and [STREAM] sections follow the global tags
      }
      if (char === ';' || char === '#') {
        i = text.indexOf('\n', i);
        if (i < 0) {
          break;
        }
        continue;
      }
    }
    lineStart = false;
    if (char === '\\' && i + 1 < text.length) {
      const next = text[++i];
      value === undefined ? (key += next) : (value += next);
    } else if (char === '\n') {
      flush();
      lineStart = true;
    } else if (char === '=' && value === undefined) {
      value = '';
    } else {
      value === undefined ? (key += char) : (value += char);
    }
  }
  flush();
  return tags;
}

export function serializeMetadata(tags: Tag[]): string {
  const escape = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[=;#\\\n]/g, (char) => `\\${char}`);
  return `;FFMETADATA1\n${tags.map(([key, value]) => `${escape(key)}=${escape(value)}\n`).join('')}`;
}

export async function readTags(ffmpeg: string, file: string): Promise<Tag[]> {
  // For Ogg the tags sit on the audio stream rather than on the container.
  const source = OGG.has(extensionOf(file)) ? ['-map_metadata', '0:s:a:0'] : [];
  const dump = await run(ffmpeg, ['-i', file, ...source, '-f', 'ffmetadata', '-']);
  return parseMetadata(dump.toString('utf8')).filter(
    ([key]) => !NOT_TAGS.has(key.toLowerCase()) && key.toLowerCase() !== OGG_PICTURE,
  );
}

/** The embedded cover picture, as the image file it was stored as. */
export async function readCover(ffmpeg: string, file: string): Promise<Buffer | undefined> {
  try {
    const image = await run(ffmpeg, ['-i', file, '-map', '0:v:0', '-frames:v', '1', '-c', 'copy', '-f', 'image2pipe', '-']);
    return image.length ? image : undefined;
  } catch {
    return undefined; // no picture stream
  }
}

function audioDigest(ffmpeg: string, file: string): Promise<string> {
  return run(ffmpeg, ['-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).then((out) => out.toString().trim());
}

/**
 * Rewrites `file` with exactly `tags` and the requested cover change. The result is built
 * next to the original and only takes its place once its audio is proven identical.
 */
export async function writeTags(ffmpeg: string, file: string, tags: Tag[], cover: CoverChange): Promise<void> {
  const ext = extensionOf(file);
  if (!capabilities(file).writable) {
    throw new Error(`Tags can't be written to .${ext} files.`);
  }
  // The output keeps the original extension: that is how ffmpeg picks the container format.
  const output = tempSibling(file);
  const metaFile = path.join(path.dirname(file), `.previewix-${crypto.randomBytes(4).toString('hex')}.ffmeta`);

  const meta = tags.filter(([key, value]) => key && value !== '');
  const inputs = ['-i', file, '-f', 'ffmetadata', '-i', metaFile];
  const maps = ['-map', '0:a'];
  const flags: string[] = [];

  if (OGG.has(ext)) {
    const image =
      cover.action === 'replace' ? await fs.promises.readFile(cover.path) : cover.action === 'keep' ? await readCover(ffmpeg, file) : undefined;
    if (image) {
      meta.push([OGG_PICTURE.toUpperCase(), flacPicture(image).toString('base64')]);
    }
    // The stream's own comment would otherwise be merged back in, resurrecting removed tags.
    flags.push('-map_metadata:s:a:0', '-1');
  } else if (PICTURE_STREAM.has(ext)) {
    if (cover.action === 'replace') {
      inputs.push('-i', cover.path);
      maps.push('-map', '2:v', '-disposition:v:0', 'attached_pic');
    } else if (cover.action === 'keep') {
      maps.push('-map', '0:v?');
    }
  }
  if (ext === 'aiff' || ext === 'aif') {
    flags.push('-write_id3v2', '1');
  } else if (ext === 'm4a' || ext === 'm4b') {
    flags.push('-movflags', '+faststart');
  }

  try {
    await fs.promises.writeFile(metaFile, serializeMetadata(meta));
    await run(ffmpeg, [...inputs, ...maps, '-c', 'copy', '-map_metadata', '1', '-map_chapters', '0', ...flags, '-y', output]);
    const [before, after] = await Promise.all([audioDigest(ffmpeg, file), audioDigest(ffmpeg, output)]);
    if (!before || before !== after) {
      throw new Error('The rewritten file did not pass the audio integrity check; the original was left untouched.');
    }
    await fs.promises.chmod(output, (await fs.promises.stat(file)).mode);
    await fs.promises.rename(output, file);
  } finally {
    await fs.promises.rm(metaFile, { force: true });
    await fs.promises.rm(output, { force: true });
  }
}

export async function readGeneric(ffmpeg: string, file: string): Promise<TagData> {
  const [tags, cover] = await Promise.all([readTags(ffmpeg, file), readCover(ffmpeg, file)]);
  const fields = emptyFields();
  const other: Tag[] = [];
  for (const [key, value] of tags) {
    const field = fieldOf(key);
    if (field) {
      fields[field] ||= value;
    } else {
      other.push([key, value]);
    }
  }
  return { fields, other, cover };
}

export async function writeGeneric(ffmpeg: string, file: string, fields: Fields, cover: CoverChange): Promise<void> {
  let tags = await readTags(ffmpeg, file);
  for (const field of FIELDS) {
    // The new value takes the place, and the name, of the first tag it replaces.
    const first = tags.findIndex(([key]) => fieldOf(key) === field);
    const name = first >= 0 ? tags[first][0] : NAMES[field][0];
    tags = tags.flatMap((tag, i): Tag[] => (fieldOf(tag[0]) !== field ? [tag] : i === first ? [[name, fields[field]]] : []));
    if (first < 0) {
      tags.push([name, fields[field]]);
    }
  }
  await writeTags(ffmpeg, file, tags, cover);
}

/** Loudness envelope of the first audio stream: `buckets` peak values in 0..1. */
export async function readPeaks(ffmpeg: string, file: string, buckets: number, signal?: AbortSignal): Promise<number[]> {
  const WINDOW = 200; // samples per coarse peak, 50 ms at the 4 kHz the audio is decoded to
  const coarse: number[] = [];
  let peak = 0;
  let count = 0;
  let carry: Buffer | undefined;
  await run(ffmpeg, ['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '4000', '-f', 's16le', '-'], signal, (chunk) => {
    const data = carry ? Buffer.concat([carry, chunk]) : chunk;
    const even = data.length - (data.length % 2);
    for (let i = 0; i < even; i += 2) {
      peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
      if (++count === WINDOW) {
        coarse.push(peak);
        peak = count = 0;
      }
    }
    carry = even < data.length ? data.subarray(even) : undefined;
  });
  if (count) {
    coarse.push(peak);
  }
  const top = Math.max(1, ...coarse);
  const size = Math.min(buckets, coarse.length);
  return Array.from({ length: size }, (_, i) => {
    const from = Math.floor((i * coarse.length) / size);
    const to = Math.max(from + 1, Math.floor(((i + 1) * coarse.length) / size));
    return Math.max(...coarse.slice(from, to)) / top;
  });
}
