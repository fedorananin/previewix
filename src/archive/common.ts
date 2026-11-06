import * as zlib from 'zlib';

export type EntryKind = 'file' | 'dir' | 'link';

export interface Entry {
  /** Cleaned name: forward slashes, no leading slash or drive letter, no trailing slash. */
  path: string;
  kind: EntryKind;
  /** Unpacked size in bytes. */
  size: number;
  /** Size inside the archive, where the format records one per entry. */
  packed?: number;
  /** Modification time, ms since the epoch. */
  mtime?: number;
  /** Unix permission bits, when the archive carries them. */
  mode?: number;
  /** Target of a symbolic or hard link. */
  link?: string;
  /** Why the entry can't be extracted. A sentence without the final period. */
  blocked?: string;
  /** Protected with a password, which has to be given to extract it. */
  encrypted?: boolean;
  /** ZIP: where the local header starts. tar: where the data starts. 7z and RAR: the entry's number in the archive. */
  offset: number;
  /** ZIP only: the packing method. */
  method?: number;
  /** ZIP and 7z. */
  crc?: number;
  /** ZIP with WinZip AES: the key length in bytes, and whether the entry also has a checksum of its own (AE-1). */
  aes?: { keyBytes: number; hasCrc: boolean };
  /** ZIP with the classic encryption: the two values the decrypted header may end with, which is how a wrong password shows. */
  check?: [number, number];
}

export type Packing = 'gzip' | 'bzip2' | 'xz' | 'zstd';

export interface Listing {
  /** Shown in the header: "ZIP", "tar", "tar.gz", "7z", "RAR". */
  format: string;
  type: 'zip' | 'tar' | '7z' | 'rar';
  /** tar only: what the archive is packed with, which means it can only be read from the start. */
  packing?: Packing;
  /** Size of the archive file itself. */
  fileSize: number;
  entries: Entry[];
  /** Something the reader had to work around, for the page to show. */
  warning?: string;
  /** Even the list of files is encrypted: it was read with the password. */
  locked?: boolean;
}

export interface VisitOptions {
  password?: string;
  /** Only find out whether the password fits: every wanted entry is begun and ended without its data. */
  probe?: boolean;
  signal?: AbortSignal;
}

/**
 * A password is missing (`wrong` is false) or doesn't fit. Formats that keep a check value say so
 * for certain; where there is none, a decoder that fails on the very first bytes is taken for it.
 */
export class PasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'The password is wrong' : 'A password is needed');
    this.name = 'PasswordError';
  }
}

/** Whether these bytes start a 7z archive. */
export function isSevenZip(head: Buffer): boolean {
  return head.length >= 6 && head.readUIntBE(0, 6) === 0x377abcaf271c;
}

/** Whether these bytes start a RAR archive, of either generation of the format. */
export function isRar(head: Buffer): boolean {
  return head.length >= 7 && head.toString('latin1', 0, 6) === 'Rar!\x1a\x07' && (head[6] === 0 || head[6] === 1);
}

export const CHECKSUM = 'The checksum does not match: the data is damaged';

/** The same error for an encrypted entry in a format that can't tell damage from a wrong password. */
export function orPassword(e: unknown): Error {
  const error = new Error(`${(e instanceof Error ? e.message : String(e)).replace(/\.$/, '')}, or the password is wrong`);
  error.name = 'UnsurePasswordError';
  return error;
}

/**
 * Where the readers that run in the worker thread put what they unpack: `begin` an entry (by its
 * index in the listing), `write` its data, `end` it, with what went wrong if something did.
 * `write` returns false when the rest of the entry isn't wanted.
 */
export interface Sink {
  begin(index: number): void;
  write(chunk: Uint8Array): boolean;
  end(error?: unknown): void;
}

/**
 * Called for every wanted entry with its unpacked data. Data left unread is skipped;
 * the data must not be read after the visitor has returned.
 */
export type Visitor = (entry: Entry, index: number, data: AsyncIterable<Buffer>) => Promise<void>;

export const OUTSIDE = 'The name leads outside the archive';

/**
 * Turns a name as stored into the path that is shown and extracted. Backslashes count as
 * separators (Windows archivers write them, and on Windows they would act as such anyway),
 * and what makes a name absolute is dropped, as tar and unzip do. A name with ".." is kept
 * as it is and reported as unsafe. Returns an empty path for names like "/" or "./".
 */
export function cleanPath(raw: string): { path: string; unsafe: boolean } {
  const nul = raw.indexOf('\0');
  const parts = (nul < 0 ? raw : raw.slice(0, nul)).replace(/\\/g, '/').split('/');
  const out: string[] = [];
  let unsafe = nul >= 0;
  for (let part of parts) {
    if (!out.length) {
      part = part.replace(/^[A-Za-z]:/, '');
    }
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      unsafe = true;
    }
    out.push(part);
  }
  return { path: out.join('/'), unsafe };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/**
 * The segments of an entry's path as they may be created on disk, or undefined when the path
 * can't be trusted. This is the check extraction relies on; it doesn't assume `cleanPath` ran.
 */
export function safeSegments(entryPath: string, platform: string = process.platform): string[] | undefined {
  if (!entryPath || entryPath.includes('\0')) {
    return undefined;
  }
  const segments: string[] = [];
  for (let part of entryPath.split('/')) {
    if (part === '' || part === '.' || part === '..' || part.includes('\\')) {
      return undefined;
    }
    if (platform === 'win32') {
      // A colon would address a drive or an alternate data stream; the rest can't be in a Windows name at all.
      part = part.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
      if (!part || WINDOWS_RESERVED.test(part)) {
        part = `_${part}`;
      }
    }
    segments.push(part);
  }
  return segments;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The text when the bytes are well-formed UTF-8, otherwise undefined. */
export function strictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

export function abortError(): Error {
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  return error;
}

let table: Int32Array | undefined;

/** The table of the CRC-32 that ZIP, gzip, xz and 7z share. */
export function crcTable(): Int32Array {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  return table;
}

// zlib.crc32 is native but only exists in newer Node.js versions than the oldest VS Code this extension runs in.
const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

export function crc32(data: Uint8Array, value = 0): number {
  if (nativeCrc32) {
    return nativeCrc32(data, value);
  }
  const t = crcTable();
  let crc = ~value;
  for (let i = 0; i < data.length; i++) {
    crc = t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

