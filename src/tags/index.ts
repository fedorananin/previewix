import * as fs from 'fs';
import * as path from 'path';
import { Incomplete, emptyFields, type CoverChange, type Fields, type TagData } from './common';
import { capabilities, readGeneric, writeGeneric } from './ffmpeg';
import { readFlac, writeFlac } from './flac';
import { readMp3, writeMp3 } from './id3';
import { Mp4Refusal, readMp4, writeMp4 } from './mp4';
import { readWav, writeWav } from './wav';

export { FIELDS, imageMime, type CoverChange, type Fields } from './common';
export { readPeaks } from './ffmpeg';

export interface TagReport extends TagData {
  writable: boolean;
  coverWritable: boolean;
  /** Why the tags can't be edited (or shown), when that is the case. */
  note?: string;
  /** The tags can't even be read (no ffmpeg), so the tag section is left out. */
  unavailable?: boolean;
}

const NEEDS_FFMPEG = 'ffmpeg is needed to read and edit the tags of this format. Install it or set previewix.ffmpegPath.';

/** MP3, FLAC and WAV are handled here directly, and so is MP4 (see below); the other formats go through ffmpeg when it is available. */
const NATIVE: Record<string, { read: (file: string) => Promise<TagData | undefined>; write: typeof writeFlac }> = {
  mp3: { read: async (file) => readMp3(await fs.promises.readFile(file)), write: writeMp3 },
  flac: { read: readFlac, write: writeFlac },
  wav: { read: readWav, write: writeWav },
};

/**
 * MP4 has a native backend too, but one that declines the files it isn't certain how to
 * rewrite. Those are left to ffmpeg, as all MP4 files were before; a damaged file is not
 * rewritten by either.
 */
const MP4 = new Set(['m4a', 'm4b']);

const extensionOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/** The report for an MP4 file, or undefined when it is one for ffmpeg. */
async function mp4Report(file: string, ffmpeg: string | undefined): Promise<TagReport | undefined> {
  const mp4 = await readMp4(file);
  if (!mp4) {
    return undefined; // not an MP4 file, whatever its name says
  }
  const { data, refusal } = mp4;
  if (data && !refusal) {
    return { ...data, writable: true, coverWritable: true };
  }
  if (refusal?.kind !== 'damaged' && ffmpeg) {
    return undefined;
  }
  const note = refusal?.kind === 'damaged' ? refusal.message : `${refusal?.message ?? ''} With ffmpeg installed, its tags can be edited through ffmpeg.`;
  return { ...(data ?? { fields: emptyFields(), other: [] }), writable: false, coverWritable: false, note: note.trim() };
}

export async function readTagReport(file: string, ffmpeg: string | undefined): Promise<TagReport> {
  const ext = extensionOf(file);
  const mp4 = MP4.has(ext) ? await mp4Report(file, ffmpeg) : undefined;
  if (mp4) {
    return mp4;
  }
  const native = NATIVE[ext];
  if (native) {
    const data = await native.read(file).catch((e: unknown) => (e instanceof Incomplete ? e : undefined));
    if (data instanceof Incomplete) {
      // Not one for ffmpeg either, which gives up on such a file or reads it as if it were whole.
      return { fields: emptyFields(), other: [], writable: false, coverWritable: false, note: data.message };
    }
    if (data) {
      return { ...data, writable: true, coverWritable: true };
    }
  }
  const caps = native ? { writable: false, cover: false } : capabilities(file);
  if (!ffmpeg) {
    return { fields: emptyFields(), other: [], writable: false, coverWritable: false, unavailable: true };
  }
  const data = await readGeneric(ffmpeg, file);
  const note = caps.writable
    ? undefined
    : native
      ? 'The tags of this file are stored in a way that can be shown but not edited.'
      : `Tags can't be written to .${ext} files.`;
  return { ...data, writable: caps.writable, coverWritable: caps.cover, note };
}

export async function saveTags(link: string, fields: Fields, cover: CoverChange, ffmpeg: string | undefined): Promise<void> {
  // Every writer renames a new file over the old one. Done on a symbolic link, that would replace the link
  // with a regular file and leave the music it pointed at untouched. The format is told from the extension,
  // so a link to a file that is named differently is written the old way.
  const real = await fs.promises.realpath(link).catch(() => link);
  const file = extensionOf(real) === extensionOf(link) ? real : link;
  const native = NATIVE[extensionOf(file)];
  if (native) {
    return native.write(file, fields, cover);
  }
  if (MP4.has(extensionOf(file))) {
    try {
      return await writeMp4(file, fields, cover);
    } catch (e) {
      // A refusal comes before anything is written. Only an unusual file is handed on; a damaged one stays as it is.
      if (!(e instanceof Mp4Refusal) || e.kind === 'damaged' || (!ffmpeg && e.kind !== 'foreign')) {
        throw e;
      }
    }
  }
  if (!ffmpeg) {
    throw new Error(NEEDS_FFMPEG);
  }
  return writeGeneric(ffmpeg, file, fields, cover);
}
