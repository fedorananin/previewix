import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** The tags offered for editing, whatever the file format calls them. */
export const FIELDS = [
  'title', 'artist', 'album', 'album_artist', 'date', 'track', 'disc', 'genre', 'composer', 'comment', 'lyrics',
] as const;

export type Field = (typeof FIELDS)[number];
export type Fields = Record<Field, string>;
export type Tag = [key: string, value: string];

export type CoverChange = { action: 'keep' } | { action: 'remove' } | { action: 'replace'; path: string };

export interface TagData {
  fields: Fields;
  /** Tags outside the editable set; shown, and preserved when saving. */
  other: Tag[];
  cover?: Uint8Array;
}

/**
 * Thrown by a native backend for a file that ends before its own sizes say it does. Such a file is
 * neither rewritten nor handed to ffmpeg; the message is shown in place of the form.
 */
export class Incomplete extends Error {
  constructor(what: string) {
    super(`This file ends inside ${what} (it is incomplete or damaged), so its tags can't be edited.`);
  }
}

export const emptyFields = (): Fields => Object.fromEntries(FIELDS.map((field) => [field, ''])) as Fields;

export function imageMime(image: Uint8Array): string {
  return image[0] === 0x89 && image[1] === 0x50 ? 'image/png' : 'image/jpeg';
}

export function imageSize(image: Buffer): { width: number; height: number } {
  if (imageMime(image) === 'image/png') {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }
  // JPEG: walk the segments up to the first start-of-frame marker.
  for (let i = 2; i + 9 < image.length && image[i] === 0xff; ) {
    const marker = image[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: image.readUInt16BE(i + 7), height: image.readUInt16BE(i + 5) };
    }
    i += 2 + image.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}

export const uint32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** A FLAC picture block body (front cover); also what Vorbis comments embed as cover art. */
export function flacPicture(image: Buffer): Buffer {
  const mime = Buffer.from(imageMime(image));
  const { width, height } = imageSize(image);
  return Buffer.concat([
    uint32(3), uint32(mime.length), mime, uint32(0), uint32(width), uint32(height), uint32(24), uint32(0), uint32(image.length), image,
  ]);
}

/** A sibling path to build a replacement in, so that swapping it in is a rename on the same volume. */
export function tempSibling(file: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `.${path.basename(file, ext)}.previewix-${crypto.randomBytes(4).toString('hex')}${ext}`);
}

/** Replaces `file` with `data` in one step, so a failure midway can't leave a truncated file. */
export async function replaceFile(file: string, data: Buffer): Promise<void> {
  const temp = tempSibling(file);
  try {
    await fs.promises.writeFile(temp, data, { mode: (await fs.promises.stat(file)).mode });
    await fs.promises.rename(temp, file);
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
}

/** A piece of a file being assembled: literal bytes, or a byte range copied from the original. */
export type Part = Buffer | { start: number; end: number };

/**
 * Replaces `file` with the concatenation of `parts`. Ranges are streamed from the original,
 * so large audio data is never held in memory, and the swap itself is a rename. `check` sees
 * the assembled file first and stops the swap by throwing.
 */
export async function rewriteFile(file: string, parts: Part[], check?: (temp: string) => Promise<void>): Promise<void> {
  const temp = tempSibling(file);
  const source = await fs.promises.open(file, 'r');
  try {
    const target = await fs.promises.open(temp, 'w', (await source.stat()).mode);
    try {
      const buffer = Buffer.alloc(1 << 20);
      for (const part of parts) {
        if (Buffer.isBuffer(part)) {
          await target.write(part);
          continue;
        }
        for (let at = part.start; at < part.end; ) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, part.end - at), at);
          if (!bytesRead) {
            throw new Error('Unexpected end of file.');
          }
          await target.write(buffer, 0, bytesRead);
          at += bytesRead;
        }
      }
    } finally {
      await target.close();
    }
    await check?.(temp);
    await fs.promises.rename(temp, file);
  } finally {
    await source.close();
    await fs.promises.rm(temp, { force: true });
  }
}

export async function readRange(handle: fs.promises.FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

/** Text of unknown legacy encoding: UTF-8 when it is valid UTF-8, Latin-1 otherwise. */
export function decodeLoose(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}
