import * as fs from 'fs';
import { pipeline } from 'stream';
import * as zlib from 'zlib';
import { bzip2Input } from './bzip2';
import { Entry, Listing, OUTSIDE, Packing, Visitor, abortError, cleanPath, strictUtf8 } from './common';
import { restOfFile } from './stream';
import { xzInput } from './xz';

const BLOCK = 512;
/** Long names and pax records are read into memory; nothing honest needs more than this. */
const MAX_META_BYTES = 1024 * 1024;

/**
 * The archive as a run of bytes that is read forward only. A plain tar is read from the file
 * and can jump over data; a packed one has to be unpacked all the way.
 */
class Source {
  private buffer: Buffer = Buffer.alloc(0);
  /** Bytes handed out or skipped so far. */
  position = 0;
  /** Reading has failed once; what comes after can't be trusted. */
  failed = false;
  private readonly pull: () => Promise<Buffer | undefined>;

  constructor(
    pull: () => Promise<Buffer | undefined>,
    private readonly jump: ((bytes: number) => void) | undefined,
    readonly close: () => Promise<void>,
  ) {
    this.pull = () =>
      pull().catch((e) => {
        this.failed = true;
        throw e;
      });
  }

  /** `length` bytes, or fewer when the data ends. */
  async read(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      const more = await this.pull();
      if (!more) {
        break;
      }
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, more]) : more;
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(out.length);
    this.position += out.length;
    return out;
  }

  async *chunks(length: number): AsyncGenerator<Buffer> {
    while (length > 0) {
      if (!this.buffer.length) {
        const more = await this.pull();
        if (!more) {
          throw new Error('The archive ends in the middle of a file');
        }
        this.buffer = more;
      }
      const out = this.buffer.subarray(0, Math.min(length, this.buffer.length));
      this.buffer = this.buffer.subarray(out.length);
      this.position += out.length;
      length -= out.length;
      yield out;
    }
  }

  /**
   * Reads on to the very end. A packing keeps its checksum there, behind the end of the tar and
   * whatever padding follows it, so this is what brings a mismatch to light.
   */
  async drain(): Promise<void> {
    this.buffer = Buffer.alloc(0);
    while (await this.pull()) {
      // Nothing to keep.
    }
  }

  async skip(length: number): Promise<void> {
    const buffered = Math.min(length, this.buffer.length);
    this.buffer = this.buffer.subarray(buffered);
    this.position += buffered;
    length -= buffered;
    if (length > 0 && this.jump) {
      this.jump(length);
      this.position += length;
      return;
    }
    for await (const chunk of this.chunks(length)) {
      void chunk;
    }
  }
}

async function fileSource(file: string, start = 0): Promise<Source> {
  const handle = await fs.promises.open(file, 'r');
  let position = start;
  return new Source(
    async () => {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      position += bytesRead;
      return bytesRead ? buffer.subarray(0, bytesRead) : undefined;
    },
    (bytes) => {
      position += bytes;
    },
    () => handle.close(),
  );
}

const NAMES: Record<Packing, string> = { gzip: 'gzip', bzip2: 'bzip2', xz: 'xz', zstd: 'Zstandard' };

// Zstandard came to Node.js later than the oldest VS Code this extension runs in.
const createZstd = (zlib as unknown as { createZstdDecompress?: () => zlib.Gunzip }).createZstdDecompress;

/** Whether a tar packed this way can be read here. */
export function canUnpack(packing: Packing): boolean {
  return packing !== 'zstd' || !!createZstd;
}

function packedSource(file: string, packing: Packing): Source {
  if (packing === 'bzip2' || packing === 'xz') {
    // These two are unpacked by code of this extension, which pulls its input as it goes (see stream.ts).
    const fd = fs.openSync(file, 'r');
    const input = packing === 'xz' ? xzInput(restOfFile(fd)) : bzip2Input(restOfFile(fd));
    return new Source(
      async () => {
        const piece = input.read();
        return piece && Buffer.from(piece.buffer, piece.byteOffset, piece.length);
      },
      undefined,
      async () => fs.closeSync(fd),
    );
  }
  if (packing === 'zstd' && !createZstd) {
    throw new Error('Zstandard archives need a newer version of VS Code');
  }
  const raw = fs.createReadStream(file);
  const unpack = packing === 'zstd' ? (createZstd as () => zlib.Gunzip)() : zlib.createGunzip();
  pipeline(raw, unpack, () => undefined);
  const iterator = (unpack as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  return new Source(
    async () => {
      try {
        const next = await iterator.next();
        return next.done ? undefined : next.value;
      } catch (e) {
        throw new Error(`The ${NAMES[packing]} data is damaged (${e instanceof Error ? e.message : e})`);
      }
    },
    undefined,
    async () => {
      raw.destroy();
      unpack.destroy();
    },
  );
}

/** A numeric header field: octal digits, or a binary number when the first bit is set (GNU, for values that don't fit). */
function number(header: Buffer, offset: number, length: number): number {
  if (header[offset] & 0x80) {
    let value = header[offset] & 0x7f;
    for (let i = 1; i < length; i++) {
      value = value * 256 + header[offset + i];
    }
    return value;
  }
  const text = header.toString('latin1', offset, offset + length).replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) || 0 : 0;
}

function text(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  const cut = nul < 0 ? bytes : bytes.subarray(0, nul);
  return strictUtf8(cut) ?? cut.toString('latin1');
}

function checksumOk(header: Buffer): boolean {
  let sum = 8 * 0x20;
  for (let i = 0; i < BLOCK; i++) {
    if (i < 148 || i >= 156) {
      sum += header[i];
    }
  }
  return sum === number(header, 148, 8);
}

/** Whether these bytes, the start of a file, are the first header of a tar archive. */
export function isTarHeader(header: Buffer): boolean {
  return header.length >= BLOCK && header.some((b) => b !== 0) && checksumOk(header);
}

/** pax records: "<length> <key>=<value>\n", the length counting the whole record in bytes. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  for (let p = 0; p < data.length; ) {
    const space = data.indexOf(0x20, p);
    const length = space < 0 ? 0 : parseInt(data.toString('latin1', p, space), 10);
    if (!length || p + length > data.length) {
      break;
    }
    const record = data.subarray(space + 1, p + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals > 0) {
      records.set(record.toString('latin1', 0, equals), record.toString('utf8', equals + 1));
    }
    p += length;
  }
  return records;
}

type Step = (entry: Entry, index: number, data: () => AsyncIterable<Buffer>) => Promise<boolean | void>;

/**
 * Walks the archive from the start and calls `step` for every entry; `step` returns false to
 * stop. Returns a warning when the archive breaks off after at least one good entry.
 */
async function scan(source: Source, packedKnown: boolean, step: Step, signal?: AbortSignal): Promise<string | undefined> {
  let index = 0;
  let zeroBlocks = 0;
  /** Set by the header entries that come in front of the entry they describe. */
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Map<string, string> | undefined;
  const global = new Map<string, string>();

  for (;;) {
    if (signal?.aborted) {
      throw abortError();
    }
    const header = await source.read(BLOCK);
    if (header.length < BLOCK) {
      // Some writers leave out the two empty blocks at the end, so stopping on a block boundary is fine.
      if (!header.length && (index || zeroBlocks)) {
        return undefined;
      }
      return index ? CUT_OFF : fail();
    }
    if (header.every((b) => b === 0)) {
      // Two empty blocks end the archive.
      if (++zeroBlocks === 2) {
        return undefined;
      }
      continue;
    }
    if (!checksumOk(header)) {
      if (zeroBlocks) {
        return undefined;
      }
      return index ? 'The archive is damaged; the files after the damaged place are not listed.' : fail();
    }
    zeroBlocks = 0;

    const type = String.fromCharCode(header[156] || 0x30);
    const storedSize = number(header, 124, 12);
    const padded = Math.ceil(storedSize / BLOCK) * BLOCK;

    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (storedSize > MAX_META_BYTES) {
        await source.skip(padded);
        continue;
      }
      const data = (await source.read(padded)).subarray(0, storedSize);
      if (type === 'L') {
        longName = text(data);
      } else if (type === 'K') {
        longLink = text(data);
      } else if (type === 'x') {
        pax = paxRecords(data);
      } else {
        paxRecords(data).forEach((value, key) => global.set(key, value));
      }
      continue;
    }

    const field = (key: string) => pax?.get(key) ?? global.get(key);
    let name = text(header.subarray(0, 100));
    // Only the POSIX format keeps the front part of a long path here; old GNU archives use these bytes for other things.
    if (header.toString('latin1', 257, 263) === 'ustar\0') {
      const prefix = text(header.subarray(345, 500));
      if (prefix) {
        name = `${prefix}/${name}`;
      }
    }
    name = field('path') ?? longName ?? name;
    const paxSize = field('size');
    const paxTime = field('mtime');
    const linked = type === '1' || type === '2';
    const isDir = type === '5' || (type !== '1' && type !== '2' && name.endsWith('/'));
    // Links, directories and devices have no data, whatever their size field says.
    const hasData = !(linked || type === '3' || type === '4' || type === '5' || type === '6');
    const size = hasData ? (paxSize !== undefined ? Number(paxSize) || 0 : storedSize) : 0;
    const { path, unsafe } = cleanPath(name);
    const entry: Entry = {
      path,
      kind: isDir ? 'dir' : linked ? 'link' : 'file',
      size: isDir ? 0 : size,
      packed: packedKnown && !isDir ? size : undefined,
      mtime: (paxTime !== undefined ? Number(paxTime) : number(header, 136, 12)) * 1000 || undefined,
      mode: number(header, 100, 8) & 0o777 || undefined,
      link: linked ? (field('linkpath') ?? longLink ?? text(header.subarray(157, 257))) : undefined,
      offset: source.position,
    };
    if (unsafe) {
      entry.blocked = OUTSIDE;
    } else if (type === '3' || type === '4' || type === '6') {
      entry.blocked = 'A device or a pipe, not a file';
    } else if (type === 'S' || field('GNU.sparse.major') !== undefined || field('GNU.sparse.map') !== undefined) {
      entry.blocked = "A sparse file, which Previewix can't unpack";
    }
    longName = longLink = pax = undefined;

    const end = source.position + Math.ceil(size / BLOCK) * BLOCK;
    if (path) {
      if ((await step(entry, index, () => source.chunks(entry.size))) === false) {
        return undefined;
      }
      index++;
    }
    await source.skip(end - source.position);
  }
}

const CUT_OFF = 'The archive is cut off at the end; the last files may be missing or incomplete.';

function fail(): never {
  throw new Error('This is not a tar archive, or it is damaged');
}

export async function listTar(file: string, packing?: Packing, signal?: AbortSignal): Promise<Listing> {
  const fileSize = (await fs.promises.stat(file)).size;
  const source = packing ? packedSource(file, packing) : await fileSource(file);
  try {
    const entries: Entry[] = [];
    let warning: string | undefined;
    try {
      warning = await scan(
        source,
        !packing,
        async (entry) => {
          entries.push(entry);
        },
        signal,
      );
    } catch (e) {
      if (signal?.aborted) {
        throw e;
      }
      // What was read before the damage is still worth showing.
      if (!entries.length) {
        throw e;
      }
      warning = `${e instanceof Error ? e.message : e}. The files after the damaged place are not listed.`;
    }
    if (packing && !warning) {
      try {
        await source.drain();
      } catch (e) {
        if (signal?.aborted) {
          throw e;
        }
        // A tar has no checksums for the content of its files; the packing around it is all there is.
        warning = `${e instanceof Error ? e.message.replace(/\.$/, '') : e}.${packing === 'bzip2' ? '' : ' Files unpacked from this archive may be damaged.'}`;
      }
    }
    // A plain tar is listed by jumping over the data, which doesn't notice that it isn't all there.
    const last = entries[entries.length - 1];
    if (!packing && last && last.offset + last.size > fileSize) {
      warning ??= CUT_OFF;
    }
    const format = { gzip: 'tar.gz', bzip2: 'tar.bz2', xz: 'tar.xz', zstd: 'tar.zst' };
    return { format: packing ? format[packing] : 'tar', type: 'tar', packing, fileSize, entries, warning };
  } finally {
    await source.close();
  }
}

/** Visits the wanted entries in archive order. */
export async function visitTar(file: string, listing: Listing, wanted: number[], visitor: Visitor, signal?: AbortSignal): Promise<void> {
  const order = [...wanted].sort((a, b) => a - b);
  if (!order.length) {
    return;
  }
  if (!listing.packing) {
    // The listing recorded where each entry's data lies, so nothing else has to be read.
    for (const index of order) {
      if (signal?.aborted) {
        throw abortError();
      }
      const entry = listing.entries[index];
      const source = await fileSource(file, entry.offset);
      try {
        await visitor(entry, index, source.chunks(entry.size));
      } finally {
        await source.close();
      }
    }
    return;
  }
  const source = packedSource(file, listing.packing);
  // When the archive is unpacked to its last entry, the little that follows is read too, for the checksum at its end.
  const toEnd = order[order.length - 1] === listing.entries.length - 1;
  let next = 0;
  try {
    await scan(
      source,
      false,
      async (entry, index, data) => {
        // Past the last wanted entry nothing matches any more, and the walk goes on to the end.
        if (index !== order[next]) {
          return;
        }
        const listed = listing.entries[index];
        if (listed.path !== entry.path || listed.size !== entry.size) {
          throw new Error('The archive has changed since it was listed');
        }
        await visitor(listed, index, data());
        return ++next < order.length || (toEnd && !source.failed);
      },
      signal,
    );
    if (next < order.length) {
      throw new Error('The archive has changed since it was listed');
    }
    if (toEnd && !source.failed) {
      await source.drain();
    }
  } catch (e) {
    // gzip, xz and Zstandard carry their checksum at the end (of the whole, or of a block), behind files that have been
    // handed out by then. bzip2 is checked block by block before anything of a block gets out (see bzip2.ts).
    if (next && listing.packing !== 'bzip2' && e instanceof Error && e.name !== 'AbortError' && /damaged/.test(e.message)) {
      e.message = `${e.message.replace(/\.$/, '')}. Files unpacked from this archive before that may be damaged too`;
    }
    throw e;
  } finally {
    await source.close();
  }
}
