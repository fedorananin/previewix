import { createCipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import { Readable, pipeline } from 'stream';
import * as zlib from 'zlib';
import { bzip2Input } from './bzip2';
import { CHECKSUM, Entry, Listing, OUTSIDE, PasswordError, VisitOptions, Visitor, abortError, cleanPath, crc32, crcTable, orPassword, strictUtf8 } from './common';
import { inflateInput } from './inflate';
import { lzmaInput } from './lzma';
import { Arena, ByteReader, Input, fileInput } from './stream';
import { xzInput } from './xz';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;

/** The end record is 22 bytes plus a comment of up to 64 KB; the ZIP64 locator sits right before it. */
const TAIL_BYTES = 22 + 0xffff + 20;
/** A central directory takes about 100 bytes per entry, so this is millions of files. */
const MAX_DIRECTORY_BYTES = 1024 * 1024 * 1024;

const STORED = 0;
const DEFLATE = 8;
const DEFLATE64 = 9;
const BZIP2 = 12;
const LZMA = 14;
const ZSTD = 93;
const XZ = 95;
const AES = 99;

const METHODS: Record<number, string> = {
  1: 'Shrink',
  6: 'Implode',
  [ZSTD]: 'Zstandard',
  98: 'PPMd',
};

// Zstandard came to Node.js later than the oldest VS Code this extension runs in.
const createZstd = (zlib as unknown as { createZstdDecompress?: () => zlib.InflateRaw }).createZstdDecompress;

/** Methods unpacked by this extension's own decoders, which is slow enough to be kept off the extension host's thread. */
export function isHeavy(entry: Entry): boolean {
  return entry.method === DEFLATE64 || entry.method === BZIP2 || entry.method === LZMA || entry.method === XZ;
}

/** Upper half of code page 437, the encoding of a ZIP name without the UTF-8 flag. */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
/** Code page 866 differs from 437 in the letters: Cyrillic at 80-AF and E0-F7. */
const CP866 =
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп' + CP437.slice(0x30, 0x60) + 'рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ ';

function decodeWith(table: string, bytes: Buffer): string {
  let text = '';
  for (const byte of bytes) {
    text += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80];
  }
  return text;
}

/**
 * Tells names written by a Russian Windows archiver (CP866) from Western ones (CP437). Russian
 * words are runs of bytes from the Cyrillic ranges; accented Latin letters in CP437 fall into
 * the same ranges but stand alone between ASCII letters.
 */
function looksCyrillic(names: Buffer[]): boolean {
  let high = 0;
  let inRuns = 0;
  for (const name of names) {
    for (let i = 0; i < name.length; i++) {
      const byte = name[i];
      if (byte < 0x80) {
        continue;
      }
      if (!((byte >= 0x80 && byte <= 0xaf) || (byte >= 0xe0 && byte <= 0xf1))) {
        return false;
      }
      high++;
      if ((i > 0 && name[i - 1] >= 0x80) || (i + 1 < name.length && name[i + 1] >= 0x80)) {
        inRuns++;
      }
    }
  }
  return high > 0 && inRuns * 2 > high;
}

async function readAt(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) {
      break;
    }
    done += bytesRead;
  }
  return buffer.subarray(0, done);
}

function uint64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The ZIP archive is damaged');
  }
  return Number(value);
}

interface Directory {
  offset: number;
  size: number;
  count: number;
  /** Bytes in front of the archive (a self-extracting stub), which every stored offset ignores. */
  shift: number;
}

async function findDirectory(handle: fs.promises.FileHandle, fileSize: number): Promise<Directory> {
  const tailStart = Math.max(0, fileSize - TAIL_BYTES);
  const tail = await readAt(handle, tailStart, fileSize - tailStart);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    // The comment length must lead exactly to the end of the file, or the signature is part of a comment.
    if (tail.readUInt32LE(i) === SIG_END && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error('This is not a ZIP archive, or its end is missing');
  }
  let count = tail.readUInt16LE(end + 10);
  let size = tail.readUInt32LE(end + 12);
  let offset = tail.readUInt32LE(end + 16);
  /** Where the directory ends, which is where the end records begin. */
  let directoryEnd = tailStart + end;

  if (end >= 20 && tail.readUInt32LE(end - 20) === SIG_LOCATOR64) {
    const recordAt = uint64(tail, end - 20 + 8);
    const record = await readAt(handle, recordAt, 56);
    if (record.length === 56 && record.readUInt32LE(0) === SIG_END64) {
      count = uint64(record, 32);
      size = uint64(record, 40);
      offset = uint64(record, 48);
      directoryEnd = recordAt;
    }
  }
  if (size > MAX_DIRECTORY_BYTES || offset + size > fileSize) {
    throw new Error('The ZIP archive is damaged');
  }
  const shift = directoryEnd - size - offset;
  return { offset, size, count, shift: shift > 0 ? shift : 0 };
}

function dosTime(date: number, time: number): number | undefined {
  if (!date) {
    return undefined;
  }
  // DOS time has no zone; archivers write local time.
  const ms = new Date(1980 + (date >>> 9), ((date >>> 5) & 15) - 1, date & 31, time >>> 11, (time >>> 5) & 63, (time & 31) * 2).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Lists the archive from its central directory; file data is not touched. */
export async function listZip(file: string): Promise<Listing> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    const directory = await findDirectory(handle, fileSize);
    let data = await readAt(handle, directory.offset + directory.shift, directory.size);
    let shift = directory.shift;
    if (shift && (data.length < 4 || data.readUInt32LE(0) !== SIG_CENTRAL)) {
      // The gap in front of the end record was something else than a stub at the start.
      shift = 0;
      data = await readAt(handle, directory.offset, directory.size);
    }

    const entries: Entry[] = [];
    /** Names that are neither flagged nor well-formed UTF-8, decoded once the code page is known. */
    const legacy: { entry: Entry; name: Buffer }[] = [];
    let warning: string | undefined;
    let at = 0;
    // The directory is read to its end rather than by the stored count, which wraps around at 65,536 in archives without ZIP64.
    for (let n = 0; at < data.length; n++) {
      if (at + 46 > data.length || data.readUInt32LE(at) !== SIG_CENTRAL) {
        if (n < directory.count) {
          warning = 'The list of files in this archive is damaged; some entries may be missing.';
        }
        break;
      }
      const madeBy = data.readUInt16LE(at + 4);
      const flags = data.readUInt16LE(at + 8);
      let method = data.readUInt16LE(at + 10);
      const dosClock = data.readUInt16LE(at + 12);
      /** WinZip AES: format version (AE-1 or AE-2), key strength and the real packing method. */
      let aes: { version: number; strength: number; method: number } | undefined;
      const crc = data.readUInt32LE(at + 16);
      let packed = data.readUInt32LE(at + 20);
      let size = data.readUInt32LE(at + 24);
      const nameLength = data.readUInt16LE(at + 28);
      const extraLength = data.readUInt16LE(at + 30);
      const commentLength = data.readUInt16LE(at + 32);
      const attributes = data.readUInt32LE(at + 38);
      let offset = data.readUInt32LE(at + 42);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > data.length) {
        warning = 'The list of files in this archive is damaged; some entries may be missing.';
        break;
      }
      const name = data.subarray(at + 46, at + 46 + nameLength);
      const extra = data.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      let mtime = dosTime(data.readUInt16LE(at + 14), data.readUInt16LE(at + 12));
      let unicodeName: string | undefined;
      at = next;

      for (let p = 0; p + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(p);
        const length = extra.readUInt16LE(p + 2);
        const field = extra.subarray(p + 4, p + 4 + length);
        p += 4 + length;
        if (id === 0x0001) {
          // ZIP64: holds, in this order, only the values that overflowed their 32-bit fields.
          let q = 0;
          if (size === 0xffffffff && q + 8 <= field.length) {
            size = uint64(field, q);
            q += 8;
          }
          if (packed === 0xffffffff && q + 8 <= field.length) {
            packed = uint64(field, q);
            q += 8;
          }
          if (offset === 0xffffffff && q + 8 <= field.length) {
            offset = uint64(field, q);
          }
        } else if (id === 0x7075 && field.length > 5 && field[0] === 1 && field.readUInt32LE(1) === crc32(name)) {
          // Info-ZIP Unicode path. Its checksum ties it to the plain name, so a stale one is ignored.
          unicodeName = strictUtf8(field.subarray(5));
        } else if (id === 0x5455 && field.length >= 5 && field[0] & 1) {
          // Unix timestamp in UTC, more exact than the DOS time.
          mtime = field.readInt32LE(1) * 1000;
        } else if (id === 0x9901 && field.length >= 7) {
          aes = { version: field.readUInt16LE(0), strength: field[4], method: field.readUInt16LE(5) };
        }
      }

      const unixMode = madeBy >>> 8 === 3 || madeBy >>> 8 === 19 ? attributes >>> 16 : 0;
      // Without the UTF-8 flag the name is still tried as UTF-8 first: macOS writes it that way, and legacy
      // text almost never happens to be well-formed UTF-8. A flagged name that isn't UTF-8 is treated as legacy too.
      const raw = (flags & 0x800 ? undefined : unicodeName) ?? strictUtf8(name);
      const { path, unsafe } = cleanPath(raw ?? name.toString('latin1'));
      const isDir = name[name.length - 1] === 0x2f || name[name.length - 1] === 0x5c || (unixMode & 0o170000) === 0o040000 || (!unixMode && (attributes & 0x10) !== 0 && size === 0);
      const entry: Entry = {
        path,
        kind: isDir ? 'dir' : (unixMode & 0o170000) === 0o120000 ? 'link' : 'file',
        size: isDir ? 0 : size,
        packed: isDir ? 0 : packed,
        mtime,
        mode: unixMode & 0o777 || undefined,
        offset: offset + shift,
        method,
        crc,
      };
      if (method === AES && aes && aes.strength >= 1 && aes.strength <= 3) {
        method = entry.method = aes.method;
        entry.aes = { keyBytes: 8 + aes.strength * 8, hasCrc: aes.version === 1 };
      }
      const readable = [STORED, DEFLATE, DEFLATE64, BZIP2, LZMA, XZ].includes(method) || (method === ZSTD && !!createZstd);
      if (unsafe) {
        entry.blocked = OUTSIDE;
      } else if (isDir) {
        // Nothing to unpack, whatever the flags say.
      } else if (method === AES || flags & 0x2040) {
        // PKWARE's certificate-based "strong encryption", or AES without its description.
        entry.blocked = "Encrypted in a way Previewix can't open";
      } else if (!readable) {
        entry.blocked = method === ZSTD ? 'Packed with Zstandard, which needs a newer version of VS Code' : `Packed with ${METHODS[method] ?? `method ${method}`}, which Previewix can't unpack`;
      } else if (flags & 1) {
        entry.encrypted = true;
        if (!entry.aes) {
          // The classic encryption: the last byte of its header repeats a byte of the checksum, or of the time when the checksum came after the data.
          entry.check = [crc >>> 24, dosClock >>> 8];
        }
      }
      if (raw === undefined) {
        legacy.push({ entry, name: Buffer.from(name) });
      } else if (!path) {
        continue;
      }
      entries.push(entry);
    }

    if (legacy.length) {
      const codePage = looksCyrillic(legacy.map((l) => l.name)) ? CP866 : CP437;
      for (const { entry, name } of legacy) {
        const { path, unsafe } = cleanPath(decodeWith(codePage, name));
        entry.path = path;
        if (unsafe) {
          entry.blocked = OUTSIDE;
        }
      }
    }
    return { format: 'ZIP', type: 'zip', fileSize, entries: legacy.length ? entries.filter((e) => e.path) : entries, warning };
  } finally {
    await handle.close();
  }
}

async function* rawChunks(handle: fs.promises.FileHandle, position: number, length: number): AsyncGenerator<Buffer> {
  while (length > 0) {
    const chunk = await readAt(handle, position, Math.min(length, 256 * 1024));
    if (!chunk.length) {
      throw new Error('The archive ends in the middle of the file');
    }
    position += chunk.length;
    length -= chunk.length;
    yield chunk;
  }
}

/** What undoes the encryption of an entry: `update` for every piece of its data in turn, `finish` after the last. */
interface Decryptor {
  /** Where the encrypted data starts and how long it is, without the salt, check values and signature around it. */
  start: number;
  length: number;
  update(chunk: Buffer): Buffer;
  finish(): void;
}

/** The classic ZIP encryption ("ZipCrypto"): three 32-bit keys stirred by every byte that passes. */
function zipCrypto(password: string, header: Buffer, entry: Entry, start: number, packed: number): Decryptor {
  const t = crcTable();
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  const stir = (byte: number) => {
    key0 = t[(key0 ^ byte) & 0xff] ^ (key0 >>> 8);
    key1 = (Math.imul(key1 + (key0 & 0xff), 134775813) + 1) | 0;
    key2 = t[(key2 ^ (key1 >>> 24)) & 0xff] ^ (key2 >>> 8);
  };
  const update = (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i++) {
      const temp = (key2 | 2) & 0xffff;
      const byte = chunk[i] ^ (((temp * (temp ^ 1)) >>> 8) & 0xff);
      chunk[i] = byte;
      stir(byte);
    }
    return chunk;
  };
  for (const byte of Buffer.from(password, 'utf8')) {
    stir(byte);
  }
  const last = update(Buffer.from(header))[11];
  if (!entry.check?.includes(last)) {
    throw new PasswordError(true);
  }
  return { start: start + 12, length: packed - 12, update, finish: () => undefined };
}

/**
 * WinZip AES: AES in counter mode with keys derived from the password and a salt. Two bytes
 * derived along with the keys show a wrong password; an HMAC of the data follows it.
 */
function winZipAes(password: string, lead: Buffer, signature: Buffer, entry: Entry, start: number, packed: number): Decryptor {
  const { keyBytes } = entry.aes as { keyBytes: number };
  const saltBytes = keyBytes / 2;
  const derived = pbkdf2Sync(Buffer.from(password, 'utf8'), lead.subarray(0, saltBytes), 1000, keyBytes * 2 + 2, 'sha1');
  if (derived[keyBytes * 2] !== lead[saltBytes] || derived[keyBytes * 2 + 1] !== lead[saltBytes + 1]) {
    throw new PasswordError(true);
  }
  // The counter is little-endian, which no cipher mode of OpenSSL does; so the key stream is made block by block.
  const cipher = createCipheriv(`aes-${keyBytes * 8}-ecb`, derived.subarray(0, keyBytes), null);
  cipher.setAutoPadding(false);
  const hmac = createHmac('sha1', derived.subarray(keyBytes, keyBytes * 2));
  let counter = 1;
  let stream: Buffer = Buffer.alloc(0);
  let used = 0;
  return {
    start: start + saltBytes + 2,
    length: packed - saltBytes - 2 - 10,
    update(chunk) {
      hmac.update(chunk);
      const blocks = Math.ceil(Math.max(0, chunk.length - (stream.length - used)) / 16);
      if (blocks) {
        const counters = Buffer.alloc(blocks * 16);
        for (let i = 0; i < blocks; i++) {
          counters.writeUIntLE(counter++, i * 16, 6);
        }
        stream = Buffer.concat([stream.subarray(used), cipher.update(counters)]);
        used = 0;
      }
      for (let i = 0; i < chunk.length; i++) {
        chunk[i] ^= stream[used++];
      }
      return chunk;
    },
    finish() {
      if (!timingSafeEqual(hmac.digest().subarray(0, 10), signature)) {
        throw new Error('The signature of the encrypted data does not match: the data is damaged');
      }
    },
  };
}

/** The unpacked bytes of one entry. Throws at the end when the size or the checksum is wrong. */
async function* entryData(file: string, handle: fs.promises.FileHandle, entry: Entry, options: VisitOptions, arena: Arena): AsyncGenerator<Buffer> {
  const header = await readAt(handle, entry.offset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error('The archive is damaged at this file');
  }
  // The local header repeats the name and has extra fields of its own, so its length isn't known from the directory.
  let start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  let length = entry.packed ?? 0;
  let decryptor: Decryptor | undefined;
  if (entry.encrypted) {
    if (options.password === undefined) {
      throw new PasswordError(false);
    }
    const leadBytes = entry.aes ? entry.aes.keyBytes / 2 + 2 : 12;
    if (length < leadBytes + (entry.aes ? 10 : 0)) {
      throw new Error('The archive is damaged at this file');
    }
    const lead = await readAt(handle, start, leadBytes);
    const signature = entry.aes ? await readAt(handle, start + length - 10, 10) : undefined;
    if (lead.length < leadBytes || (signature && signature.length < 10)) {
      throw new Error('The archive ends in the middle of the file');
    }
    decryptor = signature ? winZipAes(options.password, lead, signature, entry, start, length) : zipCrypto(options.password, lead, entry, start, length);
    ({ start, length } = decryptor);
  }
  if (options.probe) {
    return;
  }

  let stream: AsyncIterable<Buffer>;
  let close: () => void;
  if (isHeavy(entry)) {
    // The decoders of this extension pull their input, which a file read with a plain descriptor can give them.
    const fd = fs.openSync(file, 'r');
    close = () => fs.closeSync(fd);
    const raw = fileInput(fd, start, length);
    const plain: Input = decryptor
      ? {
          read() {
            const piece = raw.read();
            if (!piece) {
              (decryptor as Decryptor).finish();
              return undefined;
            }
            return (decryptor as Decryptor).update(Buffer.from(piece.buffer, piece.byteOffset, piece.length));
          },
        }
      : raw;
    let unpacked: Input;
    if (entry.method === LZMA) {
      // Two bytes of version, the length of the settings (always five), the settings, then the stream itself.
      const rd = new ByteReader(plain);
      rd.bytes(2);
      const props = rd.bytes(rd.byte() | (rd.byte() << 8));
      unpacked = lzmaInput(rd, props, entry.size, arena);
    } else {
      unpacked = entry.method === BZIP2 ? bzip2Input(plain, arena) : entry.method === XZ ? xzInput(plain) : inflateInput(plain, true, arena);
    }
    stream = (async function* () {
      for (let piece = unpacked.read(); piece; piece = unpacked.read()) {
        yield Buffer.from(piece.buffer, piece.byteOffset, piece.length);
      }
    })();
  } else {
    const chunks = decryptor
      ? (async function* () {
          for await (const chunk of rawChunks(handle, start, length)) {
            yield (decryptor as Decryptor).update(chunk);
          }
          (decryptor as Decryptor).finish();
        })()
      : rawChunks(handle, start, length);
    const raw = Readable.from(chunks, { objectMode: false });
    let unpack: Readable = raw;
    if (entry.method !== STORED) {
      const inflate = entry.method === ZSTD ? (createZstd as () => zlib.InflateRaw)() : zlib.createInflateRaw();
      // The callback form is what passes an error of either side on to the other.
      pipeline(raw, inflate, () => undefined);
      unpack = inflate;
    }
    stream = unpack as AsyncIterable<Buffer>;
    close = () => {
      raw.destroy();
      unpack.destroy();
    };
  }

  let crc = 0;
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      // What the directory promises is also the most that is unpacked.
      if (size > entry.size) {
        throw new Error('The file is larger than the archive says');
      }
      crc = crc32(chunk, crc);
      yield chunk;
    }
    if (size !== entry.size) {
      throw new Error('The file is shorter than the archive says');
    }
    // AE-2 leaves the checksum out; its signature has covered the data by now.
    if (crc !== entry.crc && !(entry.aes && !entry.aes.hasCrc)) {
      throw new Error(CHECKSUM);
    }
  } catch (e) {
    let error = e;
    // zlib's own words ("invalid stored block lengths") say little to anyone.
    if (typeof (e as NodeJS.ErrnoException)?.code === 'string' && /^(Z_|ERR_ZSTD|ZSTD_)/.test((e as NodeJS.ErrnoException).code as string)) {
      error = new Error(`The packed data is damaged (${(e as Error).message})`);
    }
    // The classic encryption checks a password with a single byte, so a wrong one gets this far once in a while.
    throw entry.check && !(error instanceof PasswordError) && (error as Error)?.name !== 'AbortError' ? orPassword(error) : error;
  } finally {
    close();
  }
}

/** Visits the wanted entries in the order they lie in the file. */
export async function visitZip(file: string, listing: Listing, wanted: number[], visitor: Visitor, options: VisitOptions = {}): Promise<void> {
  const { signal } = options;
  const handle = await fs.promises.open(file, 'r');
  const arena = new Arena();
  try {
    const order = [...wanted].sort((a, b) => listing.entries[a].offset - listing.entries[b].offset);
    for (const index of order) {
      if (signal?.aborted) {
        throw abortError();
      }
      // The decoder of the entry before is done with its memory.
      arena.release();
      const data = entryData(file, handle, listing.entries[index], options, arena);
      try {
        await visitor(listing.entries[index], index, data);
      } finally {
        // Ends a generator that wasn't read to the end, which closes its streams.
        await data.return(undefined);
      }
    }
  } finally {
    await handle.close();
  }
}
