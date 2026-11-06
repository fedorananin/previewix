import { createDecipheriv, createHash } from 'crypto';
import * as fs from 'fs';
import { bzip2Input } from './bzip2';
import { CHECKSUM, Entry, Listing, OUTSIDE, PasswordError, Sink, VisitOptions, cleanPath, crc32, orPassword } from './common';
import { bcj2Input, filterInput, filterProblem } from './filters';
import { inflateInput } from './inflate';
import { lzma2Input, lzmaInput } from './lzma';
import { Arena, ByteReader, CHUNK, ENDS_EARLY, Input, fileInput, readAll } from './stream';

// The 7z format, after 7zFormat.txt in the LZMA SDK. Files are packed in "folders": chains of
// coders whose output is the content of one or many files one after the other (a solid block).
// The list of files is itself usually packed, and may be encrypted, with such a chain.

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const DAMAGED = 'The 7z archive is damaged';
/** The list of files is read into memory whole, so its size is a matter of trust; this is millions of files. */
const MAX_HEADER_BYTES = 256 * 1024 * 1024;
const MAX_CODERS = 32;

/** A password is tried on a first file of up to this size, checksum and all. */
const PROBE_BYTES = 4 * 1024 * 1024;

const AES = '06f10701';
const BCJ2 = '0303011b';

/** Coders by their id in hex. The branch filters have an old, long id and a new one shared with xz. */
const CODERS: Record<string, { name: string; filter?: number; supported?: boolean }> = {
  '00': { name: 'Copy', supported: true },
  '03': { name: 'Delta', filter: 0x03 },
  '04': { name: 'x86', filter: 0x04 },
  '05': { name: 'PowerPC', filter: 0x05 },
  '06': { name: 'IA-64', filter: 0x06 },
  '07': { name: 'ARM', filter: 0x07 },
  '08': { name: 'ARM Thumb', filter: 0x08 },
  '09': { name: 'SPARC', filter: 0x09 },
  '0a': { name: 'ARM64', filter: 0x0a },
  '0b': { name: 'RISC-V', filter: 0x0b },
  '21': { name: 'LZMA2', supported: true },
  '030101': { name: 'LZMA', supported: true },
  '03030103': { name: 'x86', filter: 0x04 },
  '03030205': { name: 'PowerPC', filter: 0x05 },
  '03030401': { name: 'IA-64', filter: 0x06 },
  '03030501': { name: 'ARM', filter: 0x07 },
  '03030701': { name: 'ARM Thumb', filter: 0x08 },
  '03030805': { name: 'SPARC', filter: 0x09 },
  [BCJ2]: { name: 'BCJ2', supported: true },
  '030401': { name: 'PPMd' },
  '040108': { name: 'Deflate', supported: true },
  '040109': { name: 'Deflate64', supported: true },
  '040202': { name: 'bzip2', supported: true },
  '04f71101': { name: 'Zstandard' },
  '04f71102': { name: 'Brotli' },
  '04f71104': { name: 'LZ4' },
  '04f71105': { name: 'LZ5' },
  '04f71106': { name: 'Lizard' },
  [AES]: { name: 'AES', supported: true },
};

interface Coder {
  id: string;
  inputs: number;
  outputs: number;
  props: Buffer;
}

interface Folder {
  coders: Coder[];
  /** Which input of the chain reads which output of it. */
  pairs: { in: number; out: number }[];
  /** The inputs that read from the file, in the order of the packed streams. */
  packed: number[];
  /** Size of every output of the chain. */
  sizes: number[];
  crc?: number;
  /** Index of the folder's first packed stream among all of the archive. */
  firstPack: number;
  /** Number of files in it. */
  streams: number;
  /** The files it holds, by their number in the archive, in the order they lie in it. */
  files: number[];
  encrypted: boolean;
  /** Why it can't be unpacked. */
  problem?: string;
}

interface Streams {
  /** Where the packed streams start in the file. */
  packStart: number;
  packSizes: number[];
  /** Where each of them starts, worked out on first use. */
  packOffsets?: number[];
  folders: Folder[];
  /** Size and checksum of every file with content, folder after folder. */
  sizes: number[];
  crcs: (number | undefined)[];
}

interface FileInfo {
  name: string;
  hasStream: boolean;
  isDir: boolean;
  anti: boolean;
  mtime?: number;
  attributes?: number;
  size: number;
  crc?: number;
  /** -1 for a file without content. */
  folder: number;
}

interface Archive {
  streams?: Streams;
  files: FileInfo[];
  /** The list of files was encrypted. */
  locked: boolean;
}

/** Reads the fields of a header that is in memory. */
class Fields {
  at = 0;

  constructor(private readonly data: Buffer) {}

  byte(): number {
    if (this.at >= this.data.length) {
      throw new Error(DAMAGED);
    }
    return this.data[this.at++];
  }

  bytes(length: number): Buffer {
    if (length < 0 || this.at + length > this.data.length) {
      throw new Error(DAMAGED);
    }
    this.at += length;
    return this.data.subarray(this.at - length, this.at);
  }

  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }

  /** Everything that hasn't been read yet. */
  rest(): Buffer {
    return this.bytes(this.data.length - this.at);
  }

  /** A number of up to 64 bits: the leading one-bits of the first byte say how many bytes follow. */
  number(): number {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if (!(first & mask)) {
        value += (first & (mask - 1)) * 2 ** (8 * i);
        break;
      }
      value += this.byte() * 2 ** (8 * i);
      mask >>= 1;
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new Error(DAMAGED);
    }
    return value;
  }

  /** A count of things that each take at least one byte, so it can't honestly exceed what is left. */
  count(): number {
    const value = this.number();
    if (value > this.data.length - this.at) {
      throw new Error(DAMAGED);
    }
    return value;
  }

  bits(count: number): boolean[] {
    const out: boolean[] = new Array(count);
    let byte = 0;
    let mask = 0;
    for (let i = 0; i < count; i++) {
      if (!mask) {
        byte = this.byte();
        mask = 0x80;
      }
      out[i] = (byte & mask) !== 0;
      mask >>= 1;
    }
    return out;
  }

  /** A vector that is either stored or, the common case, said to be all ones. */
  defined(count: number): boolean[] {
    return this.byte() ? new Array<boolean>(count).fill(true) : this.bits(count);
  }

  digests(count: number): (number | undefined)[] {
    return this.defined(count).map((has) => (has ? this.u32() : undefined));
  }
}

const END = 0x00;
const HEADER = 0x01;
const MAIN_STREAMS = 0x04;
const FILES = 0x05;
const PACK_INFO = 0x06;
const UNPACK_INFO = 0x07;
const SUBSTREAMS = 0x08;
const SIZE = 0x09;
const CRC = 0x0a;
const FOLDER = 0x0b;
const UNPACK_SIZES = 0x0c;
const STREAM_COUNTS = 0x0d;
const EMPTY_STREAM = 0x0e;
const EMPTY_FILE = 0x0f;
const ANTI = 0x10;
const NAMES = 0x11;
const MTIME = 0x14;
const ATTRIBUTES = 0x15;
const ENCODED_HEADER = 0x17;

function readFolder(f: Fields): Folder {
  const coderCount = f.number();
  if (!coderCount || coderCount > MAX_CODERS) {
    throw new Error(DAMAGED);
  }
  const coders: Coder[] = [];
  let inputs = 0;
  let outputs = 0;
  for (let i = 0; i < coderCount; i++) {
    const flags = f.byte();
    if (flags & 0xc0) {
      throw new Error(DAMAGED);
    }
    const id = f.bytes(flags & 0x0f).toString('hex');
    const coder: Coder = { id, inputs: 1, outputs: 1, props: Buffer.alloc(0) };
    if (flags & 0x10) {
      coder.inputs = f.number();
      coder.outputs = f.number();
      if (coder.inputs > MAX_CODERS || coder.outputs !== 1) {
        throw new Error(DAMAGED);
      }
    }
    if (flags & 0x20) {
      coder.props = f.bytes(f.number());
    }
    inputs += coder.inputs;
    outputs += coder.outputs;
    coders.push(coder);
  }
  const pairs: Folder['pairs'] = [];
  for (let i = 0; i < outputs - 1; i++) {
    pairs.push({ in: f.number(), out: f.number() });
  }
  const packedCount = inputs - pairs.length;
  if (packedCount < 1) {
    throw new Error(DAMAGED);
  }
  const packed: number[] = [];
  if (packedCount === 1) {
    for (let i = 0; i < inputs; i++) {
      if (!pairs.some((pair) => pair.in === i)) {
        packed.push(i);
        break;
      }
    }
  } else {
    for (let i = 0; i < packedCount; i++) {
      packed.push(f.number());
    }
  }
  if (packed.length !== packedCount) {
    throw new Error(DAMAGED);
  }
  const unknown = coders.find((coder) => !CODERS[coder.id]?.supported && (CODERS[coder.id]?.filter === undefined || filterProblem(CODERS[coder.id].filter as number)));
  const folder: Folder = {
    coders,
    pairs,
    packed,
    sizes: [],
    firstPack: 0,
    streams: 1,
    files: [],
    encrypted: coders.some((coder) => coder.id === AES),
  };
  if (unknown) {
    folder.problem = `Packed with ${CODERS[unknown.id]?.name ?? `the method ${unknown.id}`}, which Previewix can't unpack`;
  }
  return folder;
}

/** The output of the chain that no other coder reads: the content. */
function mainOutput(folder: Folder): number {
  for (let i = 0; i < folder.coders.length; i++) {
    if (!folder.pairs.some((pair) => pair.out === i)) {
      return i;
    }
  }
  throw new Error(DAMAGED);
}

function readStreams(f: Fields): Streams {
  const streams: Streams = { packStart: 0, packSizes: [], folders: [], sizes: [], crcs: [] };
  let id = f.byte();
  if (id === PACK_INFO) {
    streams.packStart = 32 + f.number();
    const count = f.count();
    for (id = f.byte(); id !== END; id = f.byte()) {
      if (id === SIZE) {
        for (let i = 0; i < count; i++) {
          streams.packSizes.push(f.number());
        }
      } else if (id === CRC) {
        f.digests(count);
      } else {
        throw new Error(DAMAGED);
      }
    }
    if (streams.packSizes.length !== count) {
      throw new Error(DAMAGED);
    }
    id = f.byte();
  }
  if (id === UNPACK_INFO) {
    if (f.byte() !== FOLDER) {
      throw new Error(DAMAGED);
    }
    const count = f.count();
    if (f.byte() !== 0) {
      // Folders stored outside the header: nothing writes that.
      throw new Error(DAMAGED);
    }
    let firstPack = 0;
    for (let i = 0; i < count; i++) {
      const folder = readFolder(f);
      folder.firstPack = firstPack;
      firstPack += folder.packed.length;
      streams.folders.push(folder);
    }
    if (firstPack > streams.packSizes.length || f.byte() !== UNPACK_SIZES) {
      throw new Error(DAMAGED);
    }
    for (const folder of streams.folders) {
      for (let i = 0; i < folder.coders.length; i++) {
        folder.sizes.push(f.number());
      }
    }
    for (id = f.byte(); id !== END; id = f.byte()) {
      if (id !== CRC) {
        throw new Error(DAMAGED);
      }
      f.digests(count).forEach((crc, i) => (streams.folders[i].crc = crc));
    }
    id = f.byte();
  }
  const sizeOf = (folder: Folder) => folder.sizes[mainOutput(folder)];
  if (id === SUBSTREAMS) {
    id = f.byte();
    if (id === STREAM_COUNTS) {
      for (const folder of streams.folders) {
        folder.streams = f.count();
      }
      id = f.byte();
    }
    for (const folder of streams.folders) {
      let sum = 0;
      for (let i = 0; i < folder.streams - 1; i++) {
        const size = id === SIZE ? f.number() : 0;
        streams.sizes.push(size);
        sum += size;
      }
      if (folder.streams) {
        if (sum > sizeOf(folder)) {
          throw new Error(DAMAGED);
        }
        streams.sizes.push(sizeOf(folder) - sum);
      }
    }
    if (id === SIZE) {
      id = f.byte();
    }
    // Checksums are stored only for the files whose folder doesn't already carry one for its single file.
    const own = (folder: Folder) => folder.streams === 1 && folder.crc !== undefined;
    let stored: (number | undefined)[] | undefined;
    for (; id !== END; id = f.byte()) {
      if (id !== CRC) {
        throw new Error(DAMAGED);
      }
      stored = f.digests(streams.folders.reduce((sum, folder) => sum + (own(folder) ? 0 : folder.streams), 0));
    }
    let next = 0;
    for (const folder of streams.folders) {
      for (let i = 0; i < folder.streams; i++) {
        streams.crcs.push(own(folder) ? folder.crc : stored?.[next++]);
      }
    }
    id = f.byte();
  } else {
    for (const folder of streams.folders) {
      streams.sizes.push(sizeOf(folder));
      streams.crcs.push(folder.crc);
    }
  }
  if (id !== END) {
    throw new Error(DAMAGED);
  }
  return streams;
}

function readFiles(f: Fields, streams: Streams | undefined): FileInfo[] {
  const count = f.count();
  const files: FileInfo[] = [];
  for (let i = 0; i < count; i++) {
    files.push({ name: '', hasStream: true, isDir: false, anti: false, size: 0, folder: -1 });
  }
  let emptyStream: boolean[] | undefined;
  let emptyFile: boolean[] | undefined;
  let anti: boolean[] | undefined;
  for (;;) {
    const type = f.number();
    if (type === END) {
      break;
    }
    const field = new Fields(f.bytes(f.number()));
    const empties = () => emptyStream?.filter(Boolean).length ?? 0;
    if (type === EMPTY_STREAM) {
      emptyStream = field.bits(count);
    } else if (type === EMPTY_FILE) {
      emptyFile = field.bits(empties());
    } else if (type === ANTI) {
      anti = field.bits(empties());
    } else if (type === NAMES) {
      if (field.byte() !== 0) {
        throw new Error(DAMAGED);
      }
      const text = field.rest();
      let start = 0;
      for (const file of files) {
        let end = start;
        while (end + 1 < text.length && (text[end] || text[end + 1])) {
          end += 2;
        }
        if (end + 1 >= text.length) {
          throw new Error(DAMAGED);
        }
        file.name = text.toString('utf16le', start, end);
        start = end + 2;
      }
    } else if (type === MTIME || type === ATTRIBUTES) {
      const has = field.defined(count);
      if (field.byte() !== 0) {
        throw new Error(DAMAGED);
      }
      files.forEach((file, i) => {
        if (!has[i]) {
          return;
        }
        if (type === ATTRIBUTES) {
          file.attributes = field.u32();
        } else {
          // Hundreds of nanoseconds since 1601.
          const time = Number(field.bytes(8).readBigUInt64LE(0) / 10000n) - 11644473600000;
          file.mtime = time > 0 ? time : undefined;
        }
      });
    }
    // Other properties (creation and access times, start positions, padding) aren't shown.
  }

  let empty = 0;
  let stream = 0;
  let folder = 0;
  let inFolder = 0;
  files.forEach((file, index) => {
    if (emptyStream?.[index]) {
      file.hasStream = false;
      file.isDir = !emptyFile?.[empty];
      file.anti = !!anti?.[empty];
      empty++;
      return;
    }
    if (!streams) {
      throw new Error(DAMAGED);
    }
    while (folder < streams.folders.length && inFolder >= streams.folders[folder].streams) {
      folder++;
      inFolder = 0;
    }
    if (folder >= streams.folders.length) {
      throw new Error(DAMAGED);
    }
    file.folder = folder;
    file.size = streams.sizes[stream];
    file.crc = streams.crcs[stream];
    streams.folders[folder].files.push(index);
    stream++;
    inFolder++;
  });
  return files;
}

/** The keys worked out in this run: the folders of an archive usually share salt and rounds, and deriving a key takes a while. */
const keys = new Map<string, Buffer>();

/** Parameters of 7z's AES coder: how often the password is hashed, a salt, and the start vector. */
function aesKey(props: Buffer, password: string): { key: Buffer; iv: Buffer } {
  if (!props.length) {
    throw new Error(DAMAGED);
  }
  const power = props[0] & 0x3f;
  let saltSize = 0;
  let ivSize = 0;
  if (props[0] & 0xc0) {
    if (props.length < 2) {
      throw new Error(DAMAGED);
    }
    saltSize = ((props[0] >> 7) & 1) + (props[1] >> 4);
    ivSize = ((props[0] >> 6) & 1) + (props[1] & 0x0f);
  }
  if (props.length < 2 + saltSize + ivSize) {
    throw new Error(DAMAGED);
  }
  if (power > 24 && power !== 0x3f) {
    // More than 2^24 rounds is used by nothing and would keep the reader busy for minutes.
    throw new Error('The archive asks for more password hashing than Previewix allows');
  }
  const salt = props.subarray(2, 2 + saltSize);
  const iv = Buffer.alloc(16);
  props.copy(iv, 0, 2 + saltSize, 2 + saltSize + ivSize);
  const id = `${power}:${salt.toString('hex')}:${password}`;
  let key = keys.get(id);
  if (!key) {
    keys.set(id, (key = deriveKey(power, salt, Buffer.from(password, 'utf16le'))));
  }
  return { key, iv };
}

function deriveKey(power: number, salt: Buffer, secret: Buffer): Buffer {
  if (power === 0x3f) {
    const key = Buffer.alloc(32);
    Buffer.concat([salt, secret]).copy(key);
    return key;
  }
  // SHA-256 over salt, password and a counter, repeated 2^power times. The rounds are fed in batches.
  const round = salt.length + secret.length + 8;
  const perBatch = Math.max(1, Math.min(1 << power, Math.floor(65536 / round)));
  const batch = Buffer.alloc(round * perBatch);
  for (let i = 0; i < perBatch; i++) {
    salt.copy(batch, i * round);
    secret.copy(batch, i * round + salt.length);
  }
  const hash = createHash('sha256');
  const total = 2 ** power;
  for (let done = 0; done < total; ) {
    const n = Math.min(perBatch, total - done);
    for (let i = 0; i < n; i++) {
      batch.writeUInt32LE(done + i, i * round + round - 8);
    }
    hash.update(n === perBatch ? batch : batch.subarray(0, n * round));
    done += n;
  }
  return hash.digest();
}

function aesInput(src: Input, props: Buffer, password: string | undefined): Input {
  if (password === undefined) {
    throw new PasswordError(false);
  }
  const { key, iv } = aesKey(props, password);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let done = false;
  return {
    read() {
      while (!done) {
        const piece = src.read();
        if (!piece) {
          done = true;
          try {
            decipher.final();
          } catch {
            // The encrypted data isn't a whole number of blocks.
            throw new Error(DAMAGED);
          }
          break;
        }
        const out = decipher.update(piece);
        if (out.length) {
          return out;
        }
      }
      return undefined;
    },
  };
}

/** At most `size` bytes of `src`; what a coder puts out beyond its declared size is never read. */
function capped(src: Input, size: number): Input {
  let left = size;
  return {
    read() {
      if (left <= 0) {
        return undefined;
      }
      const piece = src.read();
      if (!piece) {
        return undefined;
      }
      if (piece.length <= left) {
        left -= piece.length;
        return piece;
      }
      const cut = piece.subarray(0, left);
      left = 0;
      return cut;
    },
  };
}

/** The content of a folder: its chain of coders, set up from the content end back to the packed streams. */
function openFolder(fd: number, streams: Streams, folder: Folder, password: string | undefined, arena?: Arena): Input {
  if (folder.problem) {
    throw new Error(folder.problem);
  }
  const firstInput: number[] = [];
  let inputs = 0;
  for (const coder of folder.coders) {
    firstInput.push(inputs);
    inputs += coder.inputs;
  }
  if (!streams.packOffsets) {
    streams.packOffsets = [];
    let offset = streams.packStart;
    for (const size of streams.packSizes) {
      streams.packOffsets.push(offset);
      offset += size;
    }
  }
  const { packOffsets } = streams;
  const open = new Set<number>();

  const inputOf = (index: number): Input => {
    const pair = folder.pairs.find((p) => p.in === index);
    if (pair) {
      return outputOf(pair.out);
    }
    const stream = folder.packed.indexOf(index);
    if (stream < 0) {
      throw new Error(DAMAGED);
    }
    return fileInput(fd, packOffsets[folder.firstPack + stream], streams.packSizes[folder.firstPack + stream]);
  };

  const outputOf = (index: number): Input => {
    const coder = folder.coders[index];
    // A chain that reads its own output would never end.
    if (!coder || open.has(index)) {
      throw new Error(DAMAGED);
    }
    open.add(index);
    const size = folder.sizes[index];
    const known = CODERS[coder.id];
    let out: Input;
    if (coder.id === BCJ2) {
      if (coder.inputs !== 4) {
        throw new Error(DAMAGED);
      }
      const first = firstInput[index];
      out = bcj2Input(inputOf(first), inputOf(first + 1), inputOf(first + 2), inputOf(first + 3), size);
    } else {
      if (coder.inputs !== 1) {
        throw new Error(DAMAGED);
      }
      const src = inputOf(firstInput[index]);
      if (coder.id === '00') {
        out = src;
      } else if (coder.id === '21') {
        out = lzma2Input(new ByteReader(src), coder.props[0] ?? 255, size, arena);
      } else if (coder.id === '030101') {
        out = lzmaInput(new ByteReader(src), coder.props, size, arena);
      } else if (coder.id === '040202') {
        out = bzip2Input(src, arena);
      } else if (coder.id === '040108' || coder.id === '040109') {
        out = inflateInput(src, coder.id === '040109', arena);
      } else if (coder.id === AES) {
        out = aesInput(src, coder.props, password);
      } else if (known?.filter !== undefined) {
        out = filterInput(known.filter, known.filter === 0x03 ? coder.props : Buffer.alloc(0), src);
      } else {
        throw new Error(DAMAGED);
      }
    }
    return capped(out, size);
  };

  return outputOf(mainOutput(folder));
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const got = fs.readSync(fd, buffer, done, length - done, position + done);
    if (!got) {
      throw new Error('The 7z archive is cut off: its list of files is missing');
    }
    done += got;
  }
  return buffer;
}

function readArchive(fd: number, password: string | undefined): Archive {
  const fileSize = fs.fstatSync(fd).size;
  if (fileSize < 32) {
    throw new Error('This is not a 7z archive');
  }
  const start = readAt(fd, 0, 32);
  if (SIGNATURE.some((byte, i) => start[i] !== byte)) {
    throw new Error('This is not a 7z archive');
  }
  if (crc32(start.subarray(12, 32)) !== start.readUInt32LE(8)) {
    throw new Error(DAMAGED);
  }
  const offset = Number(start.readBigUInt64LE(12));
  const size = Number(start.readBigUInt64LE(20));
  if (!size) {
    return { files: [], locked: false };
  }
  if (size > MAX_HEADER_BYTES || 32 + offset + size > fileSize) {
    throw new Error(32 + offset + size > fileSize ? 'The 7z archive is cut off: its list of files is missing' : DAMAGED);
  }
  let header = readAt(fd, 32 + offset, size);
  if (crc32(header) !== start.readUInt32LE(28)) {
    throw new Error(DAMAGED);
  }

  let locked = false;
  // The header is usually packed, as a folder of its own described by a small header in its place.
  for (let depth = 0; header[0] === ENCODED_HEADER; depth++) {
    if (depth > 4) {
      throw new Error(DAMAGED);
    }
    const fields = new Fields(header);
    fields.byte();
    const streams = readStreams(fields);
    const folder = streams.folders[0];
    if (!folder) {
      throw new Error(DAMAGED);
    }
    const unpacked = folder.sizes[mainOutput(folder)];
    if (unpacked > MAX_HEADER_BYTES) {
      throw new Error(DAMAGED);
    }
    locked ||= folder.encrypted;
    const packed = openFolder(fd, streams, folder, password);
    try {
      header = readAll(packed, unpacked);
      if (header.length !== unpacked || (folder.crc !== undefined && crc32(header) !== folder.crc)) {
        throw new Error(DAMAGED);
      }
    } catch (e) {
      // Nothing in the format tells a wrong password from damage here; with wrong keys the data is noise, which is what this looks like.
      if (folder.encrypted) {
        throw new PasswordError(true);
      }
      throw new Error('The list of files in this 7z archive is damaged');
    }
  }

  const fields = new Fields(header);
  if (fields.byte() !== HEADER) {
    throw new Error(DAMAGED);
  }
  const archive: Archive = { files: [], locked };
  for (let id = fields.byte(); id !== END; id = fields.byte()) {
    if (id === MAIN_STREAMS) {
      archive.streams = readStreams(fields);
    } else if (id === FILES) {
      archive.files = readFiles(fields, archive.streams);
    } else if (id === 0x02) {
      // Archive properties: nothing that is shown.
      while (fields.number() !== END) {
        fields.bytes(fields.number());
      }
    } else if (id === 0x03) {
      readStreams(fields);
    } else {
      throw new Error(DAMAGED);
    }
  }
  return archive;
}

function entryOf(file: FileInfo, index: number, streams: Streams | undefined): Entry | undefined {
  const { path, unsafe } = cleanPath(file.name);
  if (!path || file.anti) {
    return undefined;
  }
  const attributes = file.attributes ?? 0;
  // The high half holds Unix permissions when the archiver ran on Unix and says so with this bit.
  const unixMode = attributes & 0x8000 ? attributes >>> 16 : 0;
  const isDir = file.isDir || (attributes & 0x10) !== 0 || (unixMode & 0o170000) === 0o040000;
  const isLink = !isDir && ((unixMode & 0o170000) === 0o120000 || (attributes & 0x400) !== 0);
  const folder = file.folder >= 0 ? streams?.folders[file.folder] : undefined;
  const entry: Entry = {
    path,
    kind: isDir ? 'dir' : isLink ? 'link' : 'file',
    size: isDir ? 0 : file.size,
    mtime: file.mtime,
    mode: unixMode & 0o777 || undefined,
    offset: index,
    crc: file.crc,
  };
  // A folder of one file is the only place where 7z says how much a file takes in the archive.
  if (folder && streams && folder.streams === 1) {
    entry.packed = folder.packed.reduce((sum, _, i) => sum + streams.packSizes[folder.firstPack + i], 0);
  } else if (!folder) {
    entry.packed = 0;
  }
  if (unsafe) {
    entry.blocked = OUTSIDE;
  } else if (folder?.problem && !isDir) {
    entry.blocked = folder.problem;
  } else if (folder?.encrypted && !isDir) {
    entry.encrypted = true;
  }
  return entry;
}

export function listSevenZip(file: string, password?: string): Listing {
  const fd = fs.openSync(file, 'r');
  try {
    const archive = readArchive(fd, password);
    const entries: Entry[] = [];
    archive.files.forEach((info, index) => {
      const entry = entryOf(info, index, archive.streams);
      if (entry) {
        entries.push(entry);
      }
    });
    return { format: '7z', type: '7z', fileSize: fs.fstatSync(fd).size, entries, locked: archive.locked };
  } finally {
    fs.closeSync(fd);
  }
}

/** Hands the wanted entries to `sink`, folder after folder: a file is reached by unpacking what lies before it in its folder. */
export function visitSevenZip(file: string, listing: Listing, wanted: number[], sink: Sink, options: VisitOptions = {}): void {
  const fd = fs.openSync(file, 'r');
  try {
    const archive = readArchive(fd, options.password);
    const { streams } = archive;
    /** Folder -> file number in the archive -> index in the listing. */
    const byFolder = new Map<number, Map<number, number>>();
    for (const index of [...wanted].sort((a, b) => a - b)) {
      const listed = listing.entries[index];
      const info = archive.files[listed.offset];
      if (!info || cleanPath(info.name).path !== listed.path || info.size !== listed.size) {
        throw new Error('The archive has changed since it was listed');
      }
      if (info.folder < 0) {
        sink.begin(index);
        sink.end();
        continue;
      }
      let files = byFolder.get(info.folder);
      if (!files) {
        byFolder.set(info.folder, (files = new Map()));
      }
      files.set(listed.offset, index);
    }

    const arena = new Arena();
    for (const [folderIndex, files] of byFolder) {
      // The decoders of the folder before are done with their memory.
      arena.release();
      const folder = (streams as Streams).folders[folderIndex];
      let left = files.size;
      let produced = 0;
      /** What went wrong in this folder; nothing after it can be read. */
      let failure: unknown;
      const fail = (e: unknown) => {
        if (e instanceof PasswordError || !folder.encrypted) {
          return e;
        }
        // Wrong keys turn the data into noise, which a decoder gives up on right away. Later, damage is as likely.
        return produced ? orPassword(e) : new PasswordError(true);
      };
      let rd: ByteReader | undefined;
      try {
        rd = new ByteReader(openFolder(fd, streams as Streams, folder, options.password, arena));
      } catch (e) {
        // Before anything was read: a missing password, not enough memory. Not a sign of a wrong one.
        failure = e;
      }
      if (options.probe && rd) {
        try {
          // The first bytes, and the whole first file when it is small enough to check its checksum on the spot.
          const first = archive.files[folder.files[0]];
          if (first && first.crc !== undefined && first.size <= PROBE_BYTES) {
            if (crc32(rd.bytes(first.size)) !== first.crc) {
              throw new Error(CHECKSUM);
            }
          } else {
            rd.fill();
          }
        } catch (e) {
          failure = fail(e);
        }
      }
      for (const number of folder.files) {
        if (!left) {
          break;
        }
        const index = files.get(number);
        const info = archive.files[number];
        if (index === undefined) {
          if (!failure) {
            try {
              for (let skip = info.size; skip > 0; ) {
                const piece = (rd as ByteReader).some(Math.min(skip, CHUNK));
                if (!piece) {
                  throw new Error(ENDS_EARLY);
                }
                skip -= piece.length;
                produced += piece.length;
              }
            } catch (e) {
              failure = fail(e);
            }
          }
          continue;
        }
        left--;
        sink.begin(index);
        if (failure || options.probe) {
          sink.end(failure);
          continue;
        }
        try {
          let crc = 0;
          let keep = true;
          for (let rest = info.size; rest > 0; ) {
            const piece = (rd as ByteReader).some(Math.min(rest, CHUNK));
            if (!piece) {
              throw new Error(ENDS_EARLY);
            }
            rest -= piece.length;
            produced += piece.length;
            crc = crc32(piece, crc);
            if (keep && !sink.write(piece)) {
              keep = false;
              if (!left) {
                // Nobody wants the rest of this file, and nothing behind it either.
                break;
              }
            }
          }
          if (keep && info.crc !== undefined && crc !== info.crc) {
            throw new Error(CHECKSUM);
          }
          sink.end();
        } catch (e) {
          failure = fail(e);
          sink.end(failure);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}
