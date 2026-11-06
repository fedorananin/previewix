import * as fs from 'fs';
import * as path from 'path';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import * as zlib from 'zlib';
import { crc32 } from './common';

// Writing a ZIP archive from files and folders: Deflate, UTF-8 names, ZIP64 where the plain
// fields are too small, modification times and Unix permissions. No data descriptors: sizes and
// checksum are written into the header in front of the data once they are known, which is the
// form every unpacker reads.

/** Files up to this size are read and packed in one go; larger ones are streamed. */
const SMALL_BYTES = 256 * 1024;
const WRITE_BYTES = 1024 * 1024;
const MAX32 = 0xffffffff;
/**
 * A file this large gets room for 64-bit sizes in its header before it is packed. The margin
 * below 4 GiB covers a file that grows a little while it is read, and Deflate making incompressible data slightly larger.
 */
const ZIP64_FROM = 0xff000000;
const LEVEL = 6;
/** Below this, Deflate's own overhead is more than it can save. */
const TINY_BYTES = 24;

/**
 * Deflate settings for a file that is packed in one go. By default zlib sets up a quarter of a
 * megabyte for every stream and Node a 16 KB buffer for its output, which for a tree of tens of
 * thousands of small files is most of the work and leaves a gigabyte for the collector. A window
 * and an output buffer no larger than the file give the same result.
 */
function smallOptions(size: number): zlib.ZlibOptions {
  const windowBits = Math.max(9, Math.min(15, Math.ceil(Math.log2(size))));
  return { level: LEVEL, windowBits, memLevel: Math.max(1, Math.min(8, windowBits - 7)), chunkSize: Math.max(64, Math.min(16384, size + 64)) };
}

type Kind = 'file' | 'dir' | 'link';

interface Item {
  /** Where it is on disk. */
  source: string;
  /** Its name in the archive, with forward slashes. */
  name: string;
  kind: Kind;
  size: number;
  mtime: number;
  mode: number;
}

/** What the central directory needs to know about an entry that was written. */
interface Written {
  name: Buffer;
  kind: Kind;
  method: number;
  crc: number;
  packed: number;
  size: number;
  offset: number;
  mtime: number;
  mode: number;
  zip64: boolean;
}

export interface ZipOptions {
  signal?: AbortSignal;
  /** Called as files are read, with the bytes read so far, the total, and the file being read. */
  onProgress?: (doneBytes: number, totalBytes: number, name: string) => void;
}

export interface ZipSummary {
  /** The archive as it was finally named; undefined when nothing was written. */
  target?: string;
  files: number;
  folders: number;
  /** Symbolic links, stored as links. */
  links: number;
  /** Size of the content and of the archive. */
  bytes: number;
  size: number;
  /** What was left out, and why. */
  skipped: { path: string; reason: string }[];
  cancelled: boolean;
}

function reasonOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'No permission to read it';
  }
  if (code === 'ENOENT') {
    return 'It is no longer there';
  }
  if (code === 'EBUSY') {
    return 'It is in use by another program';
  }
  return (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
}

async function exists(target: string): Promise<boolean> {
  return fs.promises.lstat(target).then(
    () => true,
    () => false,
  );
}

/** A name in `folder` that nothing has yet: "name.zip", then "name 2.zip", "name 3.zip"… */
export async function freeName(folder: string, base: string, extension: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, `${base}${n > 1 ? ` ${n}` : ''}${extension}`);
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}

/** Lists everything that goes into the archive: the given files and folders, and all that the folders hold. */
async function collect(sources: string[], skipped: ZipSummary['skipped'], avoid: Set<string>, signal?: AbortSignal): Promise<Item[]> {
  const resolved = [...new Set(sources.map((source) => path.resolve(source)))];
  // An item inside a folder that is given too comes with that folder.
  const tops = resolved.filter((source) => !resolved.some((other) => other !== source && source.startsWith(other + path.sep)));
  const items: Item[] = [];
  const taken = new Set<string>();

  const add = async (source: string, name: string): Promise<void> => {
    if (signal?.aborted || avoid.has(source)) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(source);
    } catch (e) {
      skipped.push({ path: name, reason: reasonOf(e) });
      return;
    }
    const base = { source, name, mtime: stat.mtimeMs, mode: stat.mode & 0xffff };
    if (stat.isSymbolicLink()) {
      items.push({ ...base, kind: 'link', size: 0 });
    } else if (stat.isDirectory()) {
      let children: string[];
      try {
        children = await fs.promises.readdir(source);
      } catch (e) {
        skipped.push({ path: name, reason: reasonOf(e) });
        return;
      }
      items.push({ ...base, kind: 'dir', size: 0 });
      // Byte order, the same on every system, so that the same folder always gives the same archive.
      for (const child of children.sort()) {
        await add(path.join(source, child), `${name}/${child}`);
      }
    } else if (stat.isFile()) {
      items.push({ ...base, kind: 'file', size: stat.size });
    } else {
      skipped.push({ path: name, reason: 'A device, pipe or socket, not a file' });
    }
  };

  for (const source of tops) {
    // Items picked from different folders may share a name; inside the archive they lie side by side.
    const parsed = path.parse(source);
    let name = parsed.base || 'files';
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name = `${parsed.name} ${n}${parsed.ext}`;
    }
    taken.add(name.toLowerCase());
    await add(source, name);
  }
  return items;
}

/** Date and time the way DOS kept them, in local time, which is all a ZIP header has room for. */
function dosStamp(ms: number): { date: number; time: number } {
  const d = new Date(ms);
  const year = d.getFullYear();
  if (year < 1980) {
    return { date: 0x21, time: 0 };
  }
  if (year > 2107) {
    return { date: 0xff9f, time: 0xbf7d };
  }
  return { date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) };
}

/** The "extended timestamp" field: the modification time in UTC and to the second, which DOS time is not. */
function timeField(ms: number): Buffer {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 0 || seconds > 0x7fffffff) {
    return Buffer.alloc(0);
  }
  const field = Buffer.alloc(9);
  field.writeUInt16LE(0x5455, 0);
  field.writeUInt16LE(5, 2);
  field[4] = 1;
  field.writeUInt32LE(seconds, 5);
  return field;
}

function localHeader(entry: Written): Buffer {
  const extra = [timeField(entry.mtime)];
  if (entry.zip64) {
    const field = Buffer.alloc(20);
    field.writeUInt16LE(0x0001, 0);
    field.writeUInt16LE(16, 2);
    field.writeBigUInt64LE(BigInt(entry.size), 4);
    field.writeBigUInt64LE(BigInt(entry.packed), 12);
    extra.unshift(field);
  }
  const extraBytes = Buffer.concat(extra);
  const { date, time } = dosStamp(entry.mtime);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(entry.zip64 ? 45 : 20, 4);
  // Bit 11: the name is UTF-8.
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.zip64 ? MAX32 : entry.packed, 18);
  header.writeUInt32LE(entry.zip64 ? MAX32 : entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(extraBytes.length, 28);
  return Buffer.concat([header, entry.name, extraBytes]);
}

function centralHeader(entry: Written): Buffer {
  // Only the values that don't fit their 32-bit field move to the ZIP64 field, in this order.
  const wide: number[] = [];
  const fit = (value: number) => {
    if (value >= MAX32) {
      wide.push(value);
      return MAX32;
    }
    return value;
  };
  const size = fit(entry.size);
  const packed = fit(entry.packed);
  const offset = fit(entry.offset);
  const extra = [timeField(entry.mtime)];
  if (wide.length) {
    const field = Buffer.alloc(4 + wide.length * 8);
    field.writeUInt16LE(0x0001, 0);
    field.writeUInt16LE(wide.length * 8, 2);
    wide.forEach((value, i) => field.writeBigUInt64LE(BigInt(value), 4 + i * 8));
    extra.unshift(field);
  }
  const extraBytes = Buffer.concat(extra);
  const { date, time } = dosStamp(entry.mtime);
  const version = entry.zip64 || wide.length ? 45 : 20;
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  // Made on Unix, which is what makes unpackers read the permissions below.
  header.writeUInt16LE((3 << 8) | version, 4);
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(packed, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(extraBytes.length, 30);
  // Unix mode in the high half, the DOS "directory" bit in the low one.
  header.writeUInt32LE(((entry.mode << 16) | (entry.kind === 'dir' ? 0x10 : 0)) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, entry.name, extraBytes]);
}

function endRecords(count: number, directorySize: number, directoryOffset: number, zip64: boolean): Buffer {
  const parts: Buffer[] = [];
  if (zip64 || count >= 0xffff || directorySize >= MAX32 || directoryOffset >= MAX32) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE((3 << 8) | 45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(directorySize), 40);
    record.writeBigUInt64LE(BigInt(directoryOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(directoryOffset + directorySize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(Math.min(directorySize, MAX32), 12);
  end.writeUInt32LE(Math.min(directoryOffset, MAX32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * The content of a small file, in `buffer`, which is used for one file after the other: reading
 * each into memory of its own leaves tens of thousands of buffers behind for the collector.
 */
async function readSmall(source: string, buffer: Buffer): Promise<Buffer> {
  const handle = await fs.promises.open(source, 'r');
  try {
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) {
        return buffer.subarray(0, size);
      }
      size += bytesRead;
    }
    // Longer than it was when the folder was listed.
    throw new Error('It grew while it was being packed');
  } finally {
    await handle.close();
  }
}

/** The archive being written: small writes are gathered, since most entries of a large tree are tiny. */
class Output {
  /** Bytes given to `write` so far, which is where the next ones will lie. */
  position = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly handle: fs.promises.FileHandle) {}

  async write(data: Buffer): Promise<void> {
    this.pending.push(data);
    this.pendingBytes += data.length;
    this.position += data.length;
    if (this.pendingBytes >= WRITE_BYTES) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.pendingBytes) {
      const data = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingBytes);
      const start = this.position - this.pendingBytes;
      this.pending = [];
      this.pendingBytes = 0;
      for (let done = 0; done < data.length; ) {
        done += (await this.handle.write(data, done, data.length - done, start + done)).bytesWritten;
      }
    }
  }

  /** Writes over bytes that are already in the file. */
  async rewrite(data: Buffer, position: number): Promise<void> {
    await this.flush();
    await this.handle.write(data, 0, data.length, position);
  }

  /** Takes back everything from `position` on. */
  async rewind(position: number): Promise<void> {
    await this.flush();
    await this.handle.truncate(position);
    this.position = position;
  }
}

/**
 * Packs the given files and folders into a new archive at `target`. Each folder goes in whole,
 * under its own name. Symbolic links are stored as links and never followed, so the archive
 * holds only what was picked, however the links point. What can't be read is left out and listed
 * in the summary. The archive appears under its name only when it is complete.
 */
export async function createZip(sources: string[], target: string, options: ZipOptions = {}): Promise<ZipSummary> {
  const { signal } = options;
  const summary: ZipSummary = { files: 0, folders: 0, links: 0, bytes: 0, size: 0, skipped: [], cancelled: false };
  const temp = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  const items = await collect(sources, summary.skipped, new Set([path.resolve(target), path.resolve(temp)]), signal);
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (signal?.aborted) {
    summary.cancelled = true;
    return summary;
  }
  if (!items.length) {
    return summary;
  }

  const handle = await fs.promises.open(temp, 'wx');
  const out = new Output(handle);
  const small = Buffer.allocUnsafeSlow(SMALL_BYTES);
  const written: Written[] = [];
  let done = 0;
  try {
    for (const item of items) {
      if (signal?.aborted) {
        break;
      }
      // Composed characters, as Windows and Linux expect them; macOS hands out names either way.
      const name = Buffer.from((item.kind === 'dir' ? `${item.name}/` : item.name).normalize('NFC'), 'utf8');
      if (name.length > 0xffff) {
        summary.skipped.push({ path: item.name, reason: 'The name is too long for a ZIP archive' });
        continue;
      }
      const entry: Written = { name, kind: item.kind, method: 0, crc: 0, packed: 0, size: 0, offset: out.position, mtime: item.mtime, mode: item.mode, zip64: false };
      options.onProgress?.(done, total, item.name);
      const before = done;
      try {
        if (item.kind === 'dir') {
          await out.write(localHeader(entry));
        } else if (item.kind === 'link' || item.size < SMALL_BYTES) {
          // A link's content is where it points, as zip and Finder store it.
          const data = item.kind === 'link' ? Buffer.from(await fs.promises.readlink(item.source), 'utf8') : await readSmall(item.source, small);
          const packed = item.kind === 'file' && data.length >= TINY_BYTES ? zlib.deflateRawSync(data, smallOptions(data.length)) : data;
          const smaller = packed.length < data.length;
          entry.method = smaller ? 8 : 0;
          entry.crc = crc32(data);
          entry.size = data.length;
          entry.packed = smaller ? packed.length : data.length;
          await out.write(localHeader(entry));
          // `data` is the shared buffer, which the next file will overwrite.
          await out.write(smaller ? packed : Buffer.from(data));
          done += data.length;
        } else {
          entry.method = 8;
          entry.zip64 = item.size >= ZIP64_FROM;
          const header = localHeader(entry);
          await out.write(header);
          const dataStart = out.position;
          try {
            await pipeline(
              fs.createReadStream(item.source, { highWaterMark: WRITE_BYTES }),
              new Transform({
                transform(chunk: Buffer, _, callback) {
                  entry.crc = crc32(chunk, entry.crc);
                  entry.size += chunk.length;
                  done += chunk.length;
                  options.onProgress?.(done, total, item.name);
                  callback(null, chunk);
                },
              }),
              zlib.createDeflateRaw({ level: LEVEL }),
              new Writable({
                write(chunk: Buffer, _, callback) {
                  out.write(chunk).then(() => callback(), callback);
                },
              }),
              { signal },
            );
            entry.packed = out.position - dataStart;
            if (!entry.zip64 && (entry.size >= MAX32 || entry.packed >= MAX32)) {
              throw new Error('It grew while it was being packed');
            }
          } catch (e) {
            // Half an entry is no entry: the archive goes on from where this one started.
            await out.rewind(entry.offset);
            throw e;
          }
          await out.rewrite(localHeader(entry), entry.offset);
        }
      } catch (e) {
        if (signal?.aborted) {
          break;
        }
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EIO') {
          // Not about this file: the archive itself can't be written.
          throw e;
        }
        summary.skipped.push({ path: item.name, reason: reasonOf(e) });
        done = before + item.size;
        continue;
      }
      done = before + item.size;
      written.push(entry);
      summary.bytes += entry.size;
      if (item.kind === 'dir') {
        summary.folders++;
      } else if (item.kind === 'link') {
        summary.links++;
      } else {
        summary.files++;
      }
    }

    if (signal?.aborted) {
      summary.cancelled = true;
      return summary;
    }
    if (!written.length) {
      // Nothing could be read; an empty archive would only hide that.
      return summary;
    }
    const directoryOffset = out.position;
    for (const entry of written) {
      await out.write(centralHeader(entry));
    }
    const zip64 = written.some((entry) => entry.zip64 || entry.offset >= MAX32);
    await out.write(endRecords(written.length, out.position - directoryOffset, directoryOffset, zip64));
    await out.flush();
    summary.size = out.position;
    await handle.close();
    // Something may have taken the name since it was chosen.
    const parsed = path.parse(target);
    const final = (await exists(target)) ? await freeName(parsed.dir, parsed.name, parsed.ext) : target;
    await fs.promises.rename(temp, final);
    summary.target = final;
    return summary;
  } finally {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
}
