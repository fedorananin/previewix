import * as zlib from 'zlib';

// Archives built by hand for the archive tests, the tree the committed fixtures hold, and a ZIP reader of
// the tests' own. Nothing here uses src/archive.

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

// ---- The tree in test/fixtures/archive ---------------------------------------------------

const text = (name: string, lines: number) => Buffer.from(Array.from({ length: lines }, (_, i) => `${name} line ${i + 1}: the quick brown fox jumps over the lazy dog\n`).join(''));

function binary(length: number): Buffer {
  const out = Buffer.alloc(length + 3000 + 600);
  let state = 12345;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 16;
  }
  out.fill(0x41, length, length + 3000);
  for (let i = 0; i < 600; i++) {
    out[length + 3000 + i] = i % 7;
  }
  return out;
}

/** The files every archive made by fixtures/archive/make.js holds, as that script computes them. There is an empty folder `emptydir` too. */
export const treeFiles = (): Record<string, Buffer> => ({
  'hello.txt': Buffer.from('Hello, world\n'),
  'empty.txt': Buffer.alloc(0),
  'src/text.js': text('src/text.js', 40),
  'src/deep/data.bin': binary(1200),
  'src/deep/run.sh': Buffer.from('#!/bin/sh\necho hi\n'),
  'юникод/файл.txt': Buffer.from('Привет\n'),
});

// ---- ZIP ------------------------------------------------------------------------------------

export interface ZipItem {
  /** The name as text (stored as UTF-8), or as the bytes that go into the archive. */
  name: string | Buffer;
  data?: Buffer;
  /** 0 stores, 8 deflates; any other number is written as the method with the data as given. */
  method?: number;
  /** Unix mode with the file type, which makes the entry "made by Unix": 0o120777 is a symbolic link. */
  mode?: number;
  /** General purpose flags; 0x800 says the name is UTF-8. */
  flags?: number;
  /** What the directory says the unpacked size is, when that should be a lie. */
  size?: number;
  crc?: number;
  /** Extra field for both headers. */
  extra?: Buffer;
}

/** A ZIP archive with the entries as given, lies included. `stub` goes in front, as the program of a self-extracting archive does. */
export function zipFile(items: ZipItem[], stub: Buffer = Buffer.alloc(0)): Buffer {
  const parts: Buffer[] = [stub];
  const central: Buffer[] = [];
  let offset = stub.length;
  for (const item of items) {
    const name = typeof item.name === 'string' ? Buffer.from(item.name, 'utf8') : item.name;
    const data = item.data ?? Buffer.alloc(0);
    const method = item.method ?? 0;
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = item.crc ?? zlib.crc32(data);
    const size = item.size ?? data.length;
    const flags = item.flags ?? 0;
    const extra = item.extra ?? Buffer.alloc(0);
    // DOS time and date: 2024-03-02 10:20:30.
    const stamp = Buffer.concat([u16((10 << 11) | (20 << 5) | 15), u16(((2024 - 1980) << 9) | (3 << 5) | 2)]);
    const shared = Buffer.concat([u16(flags), u16(method), stamp, u32(crc), u32(packed.length), u32(size), u16(name.length), u16(extra.length)]);
    const local = Buffer.concat([u32(0x04034b50), u16(20), shared, name, extra]);
    central.push(
      Buffer.concat([u32(0x02014b50), u16(item.mode === undefined ? 20 : (3 << 8) | 20), u16(20), shared, u16(0), u16(0), u16(0), u32(((item.mode ?? 0) << 16) >>> 0), u32(offset - stub.length), name, extra]),
    );
    parts.push(local, packed);
    offset += local.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(items.length), u16(items.length), u32(directory.length), u32(offset - stub.length), u16(0)]);
  return Buffer.concat([...parts, directory, end]);
}

export interface ZipRead {
  name: string;
  /** The name is flagged as UTF-8. */
  utf8: boolean;
  method: number;
  data: Buffer;
  /** Unix mode from the external attributes when the entry was made by Unix. */
  mode?: number;
  /** DOS time and date as [year, month, day, hour, minute, second]. */
  dos: number[];
  /** Extra fields of the directory entry by their id. */
  extra: Map<number, Buffer>;
  madeBy: number;
  flags: number;
  zip64: boolean;
}

/**
 * Reads a ZIP archive whole, strictly: both headers of every entry have to agree, the data has to unpack to
 * the stated size and checksum, and nothing may lie between the last entry, the directory and the end record.
 */
export function readZip(file: Buffer): ZipRead[] {
  const end = file.length - 22;
  if (file.readUInt32LE(end) !== 0x06054b50) {
    throw new Error('no end record at the end of the file (or it has a comment)');
  }
  const count = file.readUInt16LE(end + 10);
  const directorySize = file.readUInt32LE(end + 12);
  const directoryAt = file.readUInt32LE(end + 16);
  if (directoryAt + directorySize !== end) {
    throw new Error('the directory does not end where the end record begins');
  }
  const entries: ZipRead[] = [];
  let at = directoryAt;
  let expected = 0;
  for (let i = 0; i < count; i++) {
    if (file.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`entry ${i}: no directory header`);
    }
    const madeBy = file.readUInt16LE(at + 4);
    const flags = file.readUInt16LE(at + 8);
    const method = file.readUInt16LE(at + 10);
    const time = file.readUInt16LE(at + 12);
    const date = file.readUInt16LE(at + 14);
    const crc = file.readUInt32LE(at + 16);
    const packed = file.readUInt32LE(at + 20);
    const size = file.readUInt32LE(at + 24);
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const attributes = file.readUInt32LE(at + 38);
    const offset = file.readUInt32LE(at + 42);
    const nameBytes = file.subarray(at + 46, at + 46 + nameLength);
    const extra = new Map<number, Buffer>();
    for (let e = at + 46 + nameLength; e < at + 46 + nameLength + extraLength; ) {
      const length = file.readUInt16LE(e + 2);
      extra.set(file.readUInt16LE(e), file.subarray(e + 4, e + 4 + length));
      e += 4 + length;
    }
    at += 46 + nameLength + extraLength + file.readUInt16LE(at + 32);

    if (offset !== expected) {
      throw new Error(`entry ${i}: starts at ${offset}, the entry before it ends at ${expected}`);
    }
    if (file.readUInt32LE(offset) !== 0x04034b50) {
      throw new Error(`entry ${i}: no local header`);
    }
    if (flags & 8) {
      throw new Error(`entry ${i}: uses a data descriptor`);
    }
    const local = { flags: file.readUInt16LE(offset + 6), method: file.readUInt16LE(offset + 8), crc: file.readUInt32LE(offset + 14), packed: file.readUInt32LE(offset + 18), size: file.readUInt32LE(offset + 22) };
    const localName = file.subarray(offset + 30, offset + 30 + file.readUInt16LE(offset + 26));
    if (local.flags !== flags || local.method !== method || local.crc !== crc || local.packed !== packed || local.size !== size || !localName.equals(nameBytes)) {
      throw new Error(`entry ${i}: the local header and the directory disagree`);
    }
    const start = offset + 30 + localName.length + file.readUInt16LE(offset + 28);
    const raw = file.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (method !== 0 && method !== 8) {
      throw new Error(`entry ${i}: method ${method}`);
    }
    if (data.length !== size || zlib.crc32(data) !== crc) {
      throw new Error(`entry ${i}: size or checksum is wrong`);
    }
    expected = start + packed;
    entries.push({
      name: nameBytes.toString('utf8'),
      utf8: !!(flags & 0x800),
      method,
      data: Buffer.from(data),
      mode: madeBy >> 8 === 3 ? attributes >>> 16 : undefined,
      dos: [(date >> 9) + 1980, (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2],
      extra,
      madeBy,
      flags,
      zip64: extra.has(1),
    });
  }
  if (expected !== directoryAt) {
    throw new Error('bytes between the last entry and the directory');
  }
  return entries;
}

// ---- tar ------------------------------------------------------------------------------------

export interface TarItem {
  name: string;
  data?: Buffer;
  /** '0' file (the default), '5' folder, '2' symbolic link, '1' hard link, '3' character device… */
  type?: string;
  link?: string;
  mode?: number;
  /** The size the header states, when that should be a lie. */
  size?: number;
  /** The name goes into a pax header in front, and the header itself gets a stand-in name. */
  pax?: boolean;
  /** The name goes into a GNU long-name entry in front. */
  gnu?: boolean;
}

function tarHeader(name: string, size: number, type: string, link: string, mode: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'latin1');
  header.write('0000000\0', 108, 'latin1');
  header.write('0000000\0', 116, 'latin1');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  // 2024-03-02 10:20:30 UTC.
  header.write(`${(1709374830).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
  header.write('        ', 148, 'latin1');
  header.write(type, 156, 'latin1');
  header.write(link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return header;
}

const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

export function tarFile(items: TarItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    const data = item.data ?? Buffer.alloc(0);
    const type = item.type ?? '0';
    let name = item.name;
    if (item.pax) {
      const record = (key: string, value: string) => {
        const body = ` ${key}=${value}\n`;
        let length = body.length + 1;
        while (Buffer.byteLength(`${length}${body}`) !== length) {
          length = Buffer.byteLength(`${length}${body}`);
        }
        return `${length}${body}`;
      };
      const records = Buffer.from(record('path', name) + (item.link ? record('linkpath', item.link) : ''), 'utf8');
      parts.push(tarHeader('PaxHeader/entry', records.length, 'x', '', 0o644), padded(records));
      name = 'stand-in';
    } else if (item.gnu) {
      const long = Buffer.from(`${name}\0`, 'utf8');
      parts.push(tarHeader('././@LongLink', long.length, 'L', '', 0o644), padded(long));
      name = 'stand-in';
    }
    parts.push(tarHeader(name, item.size ?? data.length, type, item.pax ? '' : (item.link ?? ''), item.mode ?? (type === '5' ? 0o755 : 0o644)), padded(data));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

// ---- 7z: one folder with the Copy coder, an unpacked header -------------------------------------

function number7(value: number): Buffer {
  // Up to six bytes behind the first one: more than any test archive needs.
  for (let i = 0; i < 7; i++) {
    if (value < 2 ** (7 * (i + 1))) {
      const first = ((0xff00 >> i) & 0xff) | Math.floor(value / 2 ** (8 * i));
      const rest = Buffer.alloc(i);
      if (i) {
        rest.writeUIntLE(value % 2 ** (8 * i), 0, i);
      }
      return Buffer.concat([Buffer.from([first]), rest]);
    }
  }
  throw new Error('too large');
}

export interface SevenItem {
  name: string;
  data?: Buffer;
  /** Windows attributes with the Unix mode in the upper half; see SEVEN below. */
  attributes?: number;
}

const UNIX = 0x8000;
export const SEVEN = {
  file: (mode = 0o644) => (UNIX | ((0o100000 | mode) << 16)) >>> 0,
  link: (mode = 0o777) => (UNIX | ((0o120000 | mode) << 16)) >>> 0,
  folder: (mode = 0o755) => (UNIX | 0x10 | ((0o040000 | mode) << 16)) >>> 0,
};

/**
 * A 7z archive of stored files. `declared` gives the unpacked sizes the header states in place of the
 * real ones, for archives that lie. Items without data are folders (attribute 0x10) or empty files.
 */
export function sevenZipFile(items: SevenItem[], declared?: number[]): Buffer {
  const withData = items.filter((item) => item.data?.length);
  const data = Buffer.concat(withData.map((item) => item.data as Buffer));
  const sizes = declared ?? withData.map((item) => (item.data as Buffer).length);
  const h: Buffer[] = [Buffer.from([0x01])];
  if (withData.length) {
    h.push(Buffer.from([0x04, 0x06]), number7(0), number7(1), Buffer.from([0x09]), number7(data.length), Buffer.from([0x00]));
    h.push(Buffer.from([0x07, 0x0b]), number7(1), Buffer.from([0x00]), number7(1), Buffer.from([0x01, 0x00]), Buffer.from([0x0c]), number7(sizes.reduce((a, b) => a + b, 0)), Buffer.from([0x00]));
    h.push(Buffer.from([0x08, 0x0d]), number7(withData.length));
    if (withData.length > 1) {
      h.push(Buffer.from([0x09]), ...sizes.slice(0, -1).map(number7));
    }
    h.push(Buffer.from([0x0a, 0x01]), ...withData.map((item) => u32(zlib.crc32(item.data as Buffer))), Buffer.from([0x00, 0x00]));
  }
  h.push(Buffer.from([0x05]), number7(items.length));
  if (withData.length !== items.length) {
    const bits = (flags: boolean[]) => {
      const out = Buffer.alloc(Math.ceil(flags.length / 8));
      flags.forEach((flag, i) => {
        if (flag) {
          out[i >> 3] |= 0x80 >> (i & 7);
        }
      });
      return out;
    };
    const empty = bits(items.map((item) => !item.data?.length));
    // Among the items without data, the ones that are files and not folders.
    const emptyFiles = bits(items.filter((item) => !item.data?.length).map((item) => !((item.attributes ?? 0) & 0x10)));
    h.push(Buffer.from([0x0e]), number7(empty.length), empty, Buffer.from([0x0f]), number7(emptyFiles.length), emptyFiles);
  }
  const names = Buffer.concat(items.map((item) => Buffer.from(`${item.name}\0`, 'utf16le')));
  h.push(Buffer.from([0x11]), number7(names.length + 1), Buffer.from([0x00]), names);
  const attributes = Buffer.concat([Buffer.from([0x01, 0x00]), ...items.map((item) => u32(item.attributes ?? SEVEN.file()))]);
  h.push(Buffer.from([0x15]), number7(attributes.length), attributes, Buffer.from([0x00, 0x00]));
  const header = Buffer.concat(h);
  const start = Buffer.concat([u64(data.length), u64(header.length), u32(zlib.crc32(header))]);
  return Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]), u32(zlib.crc32(start)), start, data, header]);
}

// ---- RAR 5: stored files only ----------------------------------------------------------------

function vint(value: number): Buffer {
  const out: number[] = [];
  for (;;) {
    const low = value % 128;
    value = Math.floor(value / 128);
    if (value) {
      out.push(low | 0x80);
    } else {
      out.push(low);
      return Buffer.from(out);
    }
  }
}

function rarBlock(body: Buffer): Buffer {
  const sized = Buffer.concat([vint(body.length), body]);
  return Buffer.concat([u32(zlib.crc32(sized)), sized]);
}

export interface RarItem {
  name: string;
  data: Buffer;
  /** The unpacked size the header states, when that should be a lie. */
  size?: number;
  /** Unix mode with the file type; 0o120777 is a symbolic link. */
  mode?: number;
}

export function rarFile(items: RarItem[]): Buffer {
  const parts = [Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), rarBlock(Buffer.concat([vint(1), vint(0), vint(0)]))];
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const body = Buffer.concat([
      vint(2), vint(0x0002), vint(item.data.length), vint(0x0004), vint(item.size ?? item.data.length), vint(item.mode ?? 0o100644),
      u32(zlib.crc32(item.data)), vint(0), vint(1), vint(name.length), name,
    ]);
    parts.push(rarBlock(body), item.data);
  }
  parts.push(rarBlock(Buffer.concat([vint(5), vint(0), vint(0)])));
  return Buffer.concat(parts);
}
