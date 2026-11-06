import * as fs from 'fs';
import { Incomplete, emptyFields, imageMime, replaceFile, type CoverChange, type Field, type Fields, type Tag, type TagData } from './common';

/**
 * ID3v2.3 / v2.4 tags, as found at the start of MP3 files and inside a chunk of WAV files. Frames are kept as raw bytes and only the ones
 * behind an edited field are rebuilt, so everything else in the tag (ratings, replay
 * gain, extra pictures, player-specific frames) survives a save untouched.
 */

interface Frame {
  id: string;
  /** The complete frame, header included. */
  raw: Buffer;
  /** Decoded payload; undefined when the frame is compressed or encrypted. */
  data?: Buffer;
}

interface ParsedTag {
  version: 3 | 4;
  frames: Frame[];
  /** Bytes the tag occupies at the start of the buffer. */
  length: number;
}

const TEXT_FRAMES: Partial<Record<Field, string>> = {
  title: 'TIT2', artist: 'TPE1', album: 'TALB', album_artist: 'TPE2', track: 'TRCK', disc: 'TPOS', genre: 'TCON', composer: 'TCOM',
};
const DATE_FRAMES = ['TDRC', 'TYER'];

const FRAME_NAMES: Record<string, string> = {
  TBPM: 'BPM', TCOP: 'Copyright', TENC: 'Encoded by', TSSE: 'Encoder', TPUB: 'Publisher', TKEY: 'Key', TLAN: 'Language',
  TSRC: 'ISRC', TPE3: 'Conductor', TPE4: 'Remixer', TIT1: 'Grouping', TIT3: 'Subtitle', TCMP: 'Compilation', TLEN: 'Length (ms)',
  TEXT: 'Lyricist', TOPE: 'Original artist', TOAL: 'Original album', TSOP: 'Artist sort', TSOA: 'Album sort', TSOT: 'Title sort',
  TDAT: 'Date (DDMM)', TORY: 'Original year', TDOR: 'Original date', TMED: 'Media',
};

export const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies',
  'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks',
  'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental',
  'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative',
  'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk',
  'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle',
  'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk',
  'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

const syncsafe = (b: Buffer, at: number) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];
const toSyncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

/** Undoes ID3 "unsynchronisation", which inserts a zero byte after every 0xFF. */
function deunsync(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  let length = 0;
  for (let i = 0; i < data.length; i++) {
    out[length++] = data[i];
    if (data[i] === 0xff && data[i + 1] === 0) {
      i++;
    }
  }
  return out.subarray(0, length);
}

/** Parses the tag at the start of `file`; no tag at all is an empty one. Undefined for the unsupported v2.2. */
function parse(file: Buffer): ParsedTag | undefined {
  if (file.toString('latin1', 0, 3) !== 'ID3') {
    return { version: 3, frames: [], length: 0 };
  }
  const version = file[3];
  if (version !== 3 && version !== 4) {
    return undefined; // v2.2 uses a different frame layout
  }
  const flags = file[5];
  const size = syncsafe(file, 6);
  const total = 10 + size + (version === 4 && flags & 0x10 ? 10 : 0);
  let body = file.subarray(10, 10 + size);
  if (version === 3 && flags & 0x80) {
    body = deunsync(body);
  }
  let at = 0;
  if (flags & 0x40) {
    at = version === 3 ? 4 + body.readUInt32BE(0) : syncsafe(body, 0);
  }

  const frames: Frame[] = [];
  while (at + 10 <= body.length) {
    const id = body.toString('latin1', at, at + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) {
      break; // padding
    }
    const length = version === 3 ? body.readUInt32BE(at + 4) : syncsafe(body, at + 4);
    const format = body[at + 9];
    const raw = body.subarray(at, at + 10 + length);
    if (raw.length < 10 + length) {
      break;
    }
    let data: Buffer | undefined = raw.subarray(10);
    if (version === 3) {
      if (format & 0xc0) {
        data = undefined;
      } else if (format & 0x20) {
        data = data.subarray(1);
      }
    } else if (format & 0x0c) {
      data = undefined;
    } else {
      data = data.subarray((format & 0x40 ? 1 : 0) + (format & 0x01 ? 4 : 0));
      if (format & 0x02) {
        data = deunsync(data);
      }
    }
    frames.push({ id, raw, data });
    at += 10 + length;
  }
  return { version, frames, length: total };
}

// ---- Frame payloads ---------------------------------------------------------

function decodeText(encoding: number, bytes: Buffer): string {
  if (encoding === 1 || encoding === 2) {
    let big = encoding === 2;
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      big = true;
      bytes = bytes.subarray(2);
    } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      big = false;
      bytes = bytes.subarray(2);
    }
    const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
    return big ? Buffer.from(even).swap16().toString('utf16le') : even.toString('utf16le');
  }
  return bytes.toString(encoding === 3 ? 'utf8' : 'latin1');
}

/** Splits off a null-terminated string, whose terminator is two bytes wide in UTF-16. */
function splitTerminated(encoding: number, bytes: Buffer): [Buffer, Buffer] {
  const wide = encoding === 1 || encoding === 2;
  for (let i = 0; i + (wide ? 1 : 0) < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) {
      return [bytes.subarray(0, i), bytes.subarray(i + (wide ? 2 : 1))];
    }
  }
  return [bytes, Buffer.alloc(0)];
}

/** Text frames may hold several null-separated values (v2.4) and often end in a stray null. */
const cleanText = (text: string) => text.split('\0').filter(Boolean).join('; ');

function textOf(frame: Frame | undefined): string {
  return frame?.data?.length ? cleanText(decodeText(frame.data[0], frame.data.subarray(1))) : '';
}

/** COMM and USLT: encoding, language, description, text. */
function describedText(frame: Frame): { language: string; description: string; text: string } | undefined {
  if (!frame.data || frame.data.length < 4) {
    return undefined;
  }
  const encoding = frame.data[0];
  const [description, text] = splitTerminated(encoding, frame.data.subarray(4));
  return {
    language: frame.data.toString('latin1', 1, 4),
    description: decodeText(encoding, description),
    text: decodeText(encoding, text).replace(/\0+$/, ''),
  };
}

function pictureOf(frame: Frame): { type: number; image: Buffer } | undefined {
  if (!frame.data) {
    return undefined;
  }
  const encoding = frame.data[0];
  const [, afterMime] = splitTerminated(0, frame.data.subarray(1));
  const [, image] = splitTerminated(encoding, afterMime.subarray(1));
  return { type: afterMime[0], image };
}

/** Numeric genre references such as "(17)" or "17" stand for the ID3v1 genre list. */
function genreName(value: string): string {
  const match = /^\(?(\d{1,3})\)?$/.exec(value.trim());
  return (match && ID3V1_GENRES[Number(match[1])]) || value;
}

function encodeText(version: 3 | 4, text: string): [encoding: number, bytes: Buffer, terminator: Buffer] {
  if (version === 4) {
    return [3, Buffer.from(text, 'utf8'), Buffer.from([0])];
  }
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) {
    return [0, Buffer.from(text, 'latin1'), Buffer.from([0])];
  }
  return [1, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), Buffer.from([0, 0])];
}

function buildFrame(version: 3 | 4, id: string, data: Buffer): Frame {
  const size = version === 3 ? Buffer.alloc(4) : toSyncsafe(data.length);
  if (version === 3) {
    size.writeUInt32BE(data.length);
  }
  return { id, data, raw: Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), data]) };
}

function textFrame(version: 3 | 4, id: string, text: string): Frame {
  const [encoding, bytes] = encodeText(version, text);
  return buildFrame(version, id, Buffer.concat([Buffer.from([encoding]), bytes]));
}

function describedFrame(version: 3 | 4, id: string, language: string, description: string, text: string): Frame {
  const [encoding, bytes, terminator] = encodeText(version, text);
  // The description has to share the text's encoding; for UTF-16 that includes its own byte order mark.
  const [, descriptionBytes] = encoding === 1 ? [1, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(description, 'utf16le')])] : encodeText(version, description);
  const lang = Buffer.from((language + 'eng').slice(0, 3), 'latin1');
  return buildFrame(version, id, Buffer.concat([Buffer.from([encoding]), lang, descriptionBytes, terminator, bytes]));
}

function pictureFrame(version: 3 | 4, image: Buffer): Frame {
  const header = Buffer.concat([Buffer.from([0]), Buffer.from(imageMime(image), 'latin1'), Buffer.from([0, 3, 0])]);
  return buildFrame(version, 'APIC', Buffer.concat([header, image]));
}

// ---- Picking the frames behind each field -----------------------------------

/** The comment people mean: not the "iTunNORM"-style technical ones iTunes stores as comments. */
function mainComment(frames: Frame[]): Frame | undefined {
  const comments = frames.filter((f) => f.id === 'COMM' && describedText(f));
  return comments.find((f) => describedText(f)!.description === '') ?? comments.find((f) => !describedText(f)!.description.startsWith('iTun'));
}

function coverFrame(frames: Frame[]): Frame | undefined {
  const pictures = frames.filter((f) => f.id === 'APIC' && pictureOf(f));
  return pictures.find((f) => pictureOf(f)!.type === 3) ?? pictures[0];
}

const dateFrame = (frames: Frame[]) => DATE_FRAMES.map((id) => frames.find((f) => f.id === id)).find(Boolean);

function fieldsOf(frames: Frame[]): Fields {
  const fields = emptyFields();
  for (const [field, id] of Object.entries(TEXT_FRAMES) as [Field, string][]) {
    fields[field] = textOf(frames.find((f) => f.id === id));
  }
  fields.genre = genreName(fields.genre);
  fields.date = textOf(dateFrame(frames));
  const comment = mainComment(frames);
  fields.comment = comment ? describedText(comment)!.text : '';
  const lyrics = frames.find((f) => f.id === 'USLT');
  fields.lyrics = (lyrics && describedText(lyrics)?.text) || '';
  return fields;
}

/** Reads the tag at the start of `tag`. Undefined when it is an ID3v2.2 tag. */
export function readId3(tag: Buffer): TagData | undefined {
  const parsed = parse(tag);
  if (!parsed) {
    return undefined;
  }
  const { frames } = parsed;
  const shown = new Set([...Object.values(TEXT_FRAMES), ...DATE_FRAMES]);
  const other: Tag[] = [];
  for (const frame of frames) {
    if (frame.id === 'TXXX' && frame.data) {
      const [description, value] = splitTerminated(frame.data[0], frame.data.subarray(1));
      other.push([decodeText(frame.data[0], description), cleanText(decodeText(frame.data[0], value))]);
    } else if (frame.id.startsWith('T') && !shown.has(frame.id) && textOf(frame)) {
      other.push([FRAME_NAMES[frame.id] ?? frame.id, textOf(frame)]);
    }
  }
  const cover = coverFrame(frames);
  return { fields: fieldsOf(frames), other, cover: cover && pictureOf(cover)!.image };
}

/** Returns `tag` (an existing tag, or an empty buffer) with the fields and cover changed. */
export async function updateId3(tag: Buffer, fields: Fields, cover: CoverChange): Promise<Buffer> {
  const parsed = parse(tag);
  if (!parsed) {
    throw new Error('This file has an ID3v2.2 tag, which Previewix can read but not rewrite.');
  }
  const { version } = parsed;
  let frames = parsed.frames;
  const current = fieldsOf(frames);

  /** Swaps `old` for `next` in place, appends when there was nothing to replace, removes when `next` is undefined. */
  const put = (old: Frame | undefined, next: Frame | undefined) => {
    if (old) {
      frames = frames.flatMap((f) => (f === old ? (next ? [next] : []) : [f]));
    } else if (next) {
      frames = [...frames, next];
    }
  };

  for (const [field, id] of Object.entries(TEXT_FRAMES) as [Field, string][]) {
    if (fields[field] !== current[field]) {
      put(frames.find((f) => f.id === id), fields[field] ? textFrame(version, id, fields[field]) : undefined);
    }
  }
  if (fields.date !== current.date) {
    const old = dateFrame(frames);
    frames = frames.filter((f) => !DATE_FRAMES.includes(f.id) || f === old);
    // v2.3 only has a four-digit year frame; v2.4 takes a full timestamp.
    const value = version === 3 ? fields.date.replace(/^(\d{4}).*$/, '$1') : fields.date;
    put(old, value ? textFrame(version, version === 3 ? 'TYER' : 'TDRC', value) : undefined);
  }
  if (fields.comment !== current.comment) {
    const old = mainComment(frames);
    const info = old && describedText(old);
    put(old, fields.comment ? describedFrame(version, 'COMM', info?.language ?? 'eng', info?.description ?? '', fields.comment) : undefined);
  }
  if (fields.lyrics !== current.lyrics) {
    const old = frames.find((f) => f.id === 'USLT');
    const info = old && describedText(old);
    put(old, fields.lyrics ? describedFrame(version, 'USLT', info?.language ?? 'eng', info?.description ?? '', fields.lyrics) : undefined);
  }
  if (cover.action === 'replace') {
    put(coverFrame(frames), pictureFrame(version, await fs.promises.readFile(cover.path)));
  } else if (cover.action === 'remove') {
    // All pictures go: leaving a back cover behind would just make it show up as the cover.
    frames = frames.filter((f) => f.id !== 'APIC');
  }

  const body = Buffer.concat([...frames.map((f) => f.raw), Buffer.alloc(1024)]);
  const header = Buffer.concat([Buffer.from('ID3'), Buffer.from([version, 0, 0]), toSyncsafe(body.length)]);
  return Buffer.concat([header, body]);
}

// ---- MP3 files ----------------------------------------------------------------

export const MP3_ID3V22_NOTE = 'This file has an old ID3v2.2 tag, which can be shown but not edited.';

/**
 * A tag that says it is longer than the file: the file ends inside it. Saved as it comes, it would be a
 * tag of the frames that are whole and no audio, a file that looks complete.
 */
const endsInTag = (file: Buffer) => (parse(file)?.length ?? 0) > file.length;

export function readMp3(file: Buffer): TagData | undefined {
  if (endsInTag(file)) {
    throw new Incomplete('its ID3 tag');
  }
  return readId3(file);
}

export async function writeMp3(path: string, fields: Fields, cover: CoverChange): Promise<void> {
  const file = await fs.promises.readFile(path);
  if (endsInTag(file)) {
    throw new Incomplete('its ID3 tag');
  }
  const tag = await updateId3(file, fields, cover);
  const audioStart = parse(file)!.length;
  // The ID3v1 trailer is left out: it would keep showing the old values in players that read it.
  const hasV1 = file.length >= 128 && file.toString('latin1', file.length - 128, file.length - 125) === 'TAG';
  await replaceFile(path, Buffer.concat([tag, file.subarray(audioStart, hasV1 ? file.length - 128 : file.length)]));
}
