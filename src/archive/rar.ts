import * as fs from 'fs';
import * as path from 'path';
import createUnrar from 'node-unrar-js/dist/js/unrar';
import { Entry, Listing, OUTSIDE, PasswordError, Sink, VisitOptions, cleanPath, orPassword } from './common';

// RAR archives are read by UnRAR, RARLAB's own decoder, compiled to WebAssembly in the
// node-unrar-js package. Only its compiled module is used; this file drives it. UnRAR decides
// what to read and when, and calls back for every read of the archive and every piece of
// unpacked data, so nothing here touches the disk except through the functions below.
// It runs synchronously, which is one reason why it lives in the worker thread.

interface State {
  errCode: number;
}

interface RarHeader {
  state: State;
  name: string;
  flags: number;
  packSize: number;
  unpSize: number;
  time: number;
  fileAttr: number;
  hostOS: number;
}

interface RarArchive {
  open(file: string, password: string, listOnly: boolean): { state: State; flags: number };
  getFileHeader(): RarHeader;
  readFile(skip: boolean): State;
  delete(): void;
}

interface Callbacks {
  open(name: string): number;
  create(name: string): number;
  read(handle: number, pointer: number, size: number): number;
  write(handle: number, pointer: number, size: number): boolean;
  tell(handle: number): number;
  seek(handle: number, position: number, method: 'SET' | 'CUR' | 'END'): boolean;
  close(handle: number): void;
}

interface Unrar {
  RarArchive: new () => RarArchive;
  HEAPU8: Uint8Array;
  extractor: Callbacks;
}

const END_OF_ARCHIVE = 10;
const NO_MEMORY = 11;
const BAD_DATA = 12;
const OPEN_FAILED = 15;
const READ_FAILED = 18;
const WRITE_FAILED = 19;
const MISSING_PASSWORD = 22;
const BAD_REFERENCE = 23;
const BAD_PASSWORD = 24;

const ENCRYPTED = 0x04;
const DIRECTORY = 0x20;
const FROM_EARLIER_VOLUME = 0x01;
const HEADERS_ENCRYPTED = 0x80;
const HOST_UNIX = 3;

/** The handle given out for the file being unpacked, which exists only as a stream to the sink. */
const OUTPUT = 0x40000000;

let loading: Promise<Unrar> | undefined;

function load(): Promise<Unrar> {
  // esbuild.js copies the module next to the bundle.
  return (loading ??= createUnrar({ wasmBinary: fs.readFileSync(path.join(__dirname, 'unrar.wasm')) }) as Promise<Unrar>);
}

function failure(code: number, encrypted: boolean): Error {
  switch (code) {
    case MISSING_PASSWORD:
      return new PasswordError(false);
    case BAD_PASSWORD:
      return new PasswordError(true);
    case BAD_DATA:
      // RAR 5 checks a password before it unpacks; older archives only show a wrong one as broken data.
      return encrypted ? orPassword(new Error('The data is damaged')) : new Error('The data is damaged');
    case NO_MEMORY:
      return new Error('Not enough memory to unpack this');
    case BAD_REFERENCE:
      return new Error("A copy of another file in the archive, which Previewix can't unpack on its own");
    case OPEN_FAILED:
      return new Error('A volume of the archive is missing, or the file is not a RAR archive');
    case READ_FAILED:
      return new Error('The archive ends in the middle of the data');
    default:
      return new Error(`The RAR archive is damaged (UnRAR error ${code})`);
  }
}

/** What the current `readFile` call puts out, and where it goes. */
interface Output {
  size: number;
  written: number;
  write(chunk: Uint8Array): boolean;
  /** Set when the data ran past the size the archive declares. */
  overflow?: boolean;
}

interface Opened {
  archive: RarArchive;
  /** The archive's own flags. */
  flags: number;
  /** Says where the data of the next `readFile` call goes. */
  setOutput(to: Output | undefined): void;
  /** Whether UnRAR has read the volume it is in to its end. */
  atEnd(): boolean;
}

/** Opens the archive and hands it to `use`, with the file access UnRAR asks for wired to this archive only. */
async function withArchive<T>(file: string, password: string | undefined, listOnly: boolean, use: (archive: Opened) => T): Promise<T> {
  const unrar = await load();
  const folder = path.dirname(path.resolve(file));
  const files = new Map<number, { fd: number; position: number; size: number }>();
  let nextHandle = 1;
  let lastOpened = 0;
  let output: Output | undefined;

  unrar.extractor = {
    open(name) {
      // The archive itself, and its further volumes, which UnRAR looks for next to it.
      if (path.dirname(path.resolve(name)) !== folder) {
        return 0;
      }
      try {
        const fd = fs.openSync(name, 'r');
        files.set(nextHandle, { fd, position: 0, size: fs.fstatSync(fd).size });
        lastOpened = nextHandle;
        return nextHandle++;
      } catch {
        return 0;
      }
    },
    // Whatever name UnRAR would give the file: it is never created, its data goes to the sink.
    create: () => (output ? OUTPUT : 0),
    read(handle, pointer, size) {
      const open = files.get(handle);
      if (!open) {
        return 0;
      }
      const got = fs.readSync(open.fd, unrar.HEAPU8, pointer, size, open.position);
      open.position += got;
      return got;
    },
    write(handle, pointer, size) {
      if (handle !== OUTPUT || !output) {
        return false;
      }
      output.written += size;
      if (output.written > output.size) {
        output.overflow = true;
        return false;
      }
      return output.write(unrar.HEAPU8.slice(pointer, pointer + size));
    },
    tell: (handle) => (handle === OUTPUT ? (output?.written ?? 0) : (files.get(handle)?.position ?? 0)),
    seek(handle, position, method) {
      const open = files.get(handle);
      if (!open) {
        return false;
      }
      const target = method === 'SET' ? position : method === 'CUR' ? open.position + position : open.size + position;
      if (target < 0 || target > open.size) {
        return false;
      }
      open.position = target;
      return true;
    },
    close(handle) {
      const open = files.get(handle);
      if (open) {
        fs.closeSync(open.fd);
        files.delete(handle);
      }
    },
  };

  const archive = new unrar.RarArchive();
  try {
    const opened = archive.open(file, password ?? '', listOnly);
    if (opened.state.errCode) {
      throw failure(opened.state.errCode, password !== undefined);
    }
    return use({
      archive,
      flags: opened.flags,
      setOutput: (to) => (output = to),
      atEnd() {
        const volume = files.get(lastOpened);
        return !volume || volume.position >= volume.size;
      },
    });
  } finally {
    archive.delete();
    for (const open of files.values()) {
      fs.closeSync(open.fd);
    }
  }
}

function dosTime(stamp: number): number | undefined {
  const date = stamp >>> 16;
  const time = stamp & 0xffff;
  if (!date) {
    return undefined;
  }
  const ms = new Date(1980 + (date >>> 9), ((date >>> 5) & 15) - 1, date & 31, time >>> 11, (time >>> 5) & 63, (time & 31) * 2).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function entryOf(header: RarHeader, number: number): Entry | undefined {
  const { path: entryPath, unsafe } = cleanPath(header.name);
  if (!entryPath) {
    return undefined;
  }
  const unix = header.hostOS === HOST_UNIX;
  const isDir = (header.flags & DIRECTORY) !== 0;
  const isLink = !isDir && (unix ? (header.fileAttr & 0o170000) === 0o120000 : (header.fileAttr & 0x400) !== 0);
  const entry: Entry = {
    path: entryPath,
    kind: isDir ? 'dir' : isLink ? 'link' : 'file',
    size: isDir ? 0 : header.unpSize,
    packed: isDir ? 0 : header.packSize,
    mtime: dosTime(header.time),
    mode: unix ? header.fileAttr & 0o777 || undefined : undefined,
    offset: number,
  };
  if (unsafe) {
    entry.blocked = OUTSIDE;
  } else if (header.flags & FROM_EARLIER_VOLUME) {
    entry.blocked = 'Starts in an earlier volume of the archive: open the first one';
  } else if (header.flags & ENCRYPTED && entry.kind === 'file') {
    entry.encrypted = true;
  }
  return entry;
}

/**
 * Walks the file headers and calls `each` with every one and its number in the archive; `each`
 * has to read or skip the file, and returns false to stop.
 */
function walk({ archive, flags, atEnd }: Opened, each: (header: RarHeader, number: number) => boolean): void {
  for (let number = 0; ; ) {
    const header = archive.getFileHeader();
    const code = header.state.errCode;
    // Archives of the first versions of the format have no end mark, and UnRAR calls the missing header damage.
    if (code === END_OF_ARCHIVE || (code === BAD_DATA && atEnd())) {
      return;
    }
    if (code) {
      throw failure(code, (flags & HEADERS_ENCRYPTED) !== 0);
    }
    if (header.flags & FROM_EARLIER_VOLUME) {
      // The end of a file that began in an earlier volume. A listing never gets to see it, so it has no number.
      archive.readFile(true);
      continue;
    }
    if (!each(header, number++)) {
      return;
    }
  }
}

async function list(file: string, password: string | undefined): Promise<Listing> {
  const fileSize = fs.statSync(file).size;
  return withArchive(file, password, true, (opened) => {
    const entries: Entry[] = [];
    let warning: string | undefined;
    const locked = (opened.flags & HEADERS_ENCRYPTED) !== 0;
    try {
      walk(opened, (header, number) => {
        const entry = entryOf(header, number);
        if (entry) {
          entries.push(entry);
        }
        const code = opened.archive.readFile(true).errCode;
        if (code) {
          throw failure(code, locked);
        }
        return true;
      });
    } catch (e) {
      // What was read before the damage is still worth showing.
      if (!entries.length || e instanceof PasswordError) {
        throw e;
      }
      warning = 'The archive is damaged or cut off; the files after the damaged place are not listed.';
    }
    return { format: 'RAR', type: 'rar', fileSize, entries, warning, locked };
  });
}

export async function listRar(file: string, password?: string): Promise<Listing> {
  try {
    return await list(file, password);
  } catch (e) {
    if (password !== undefined && !(e instanceof PasswordError)) {
      // Older archives with encrypted headers have no check value: a wrong password just leaves them unreadable.
      // Whether the headers are encrypted shows when the archive is opened without a password.
      const locked = await list(file, undefined).then(
        () => false,
        (plain) => plain instanceof PasswordError,
      );
      if (locked) {
        throw new PasswordError(true);
      }
    }
    throw e;
  }
}

export async function visitRar(file: string, listing: Listing, wanted: number[], sink: Sink, options: VisitOptions = {}): Promise<void> {
  /** Number of the file in the archive -> index in the listing. */
  const targets = new Map<number, number>();
  for (const index of wanted) {
    targets.set(listing.entries[index].offset, index);
  }
  let left = targets.size;
  if (!left) {
    return;
  }
  await withArchive(file, options.password, false, (opened) => {
    const { archive, setOutput } = opened;
    if (options.probe) {
      // Any encrypted file shows whether the password fits; the first one is reached without unpacking others.
      let result: unknown;
      walk(opened, (header) => {
        if (!(header.flags & ENCRYPTED) || header.flags & DIRECTORY || !header.unpSize) {
          return !archive.readFile(true).errCode;
        }
        // The first piece of data is proof enough, and refusing it ends the unpacking.
        setOutput({ size: header.unpSize, written: 0, write: () => false });
        const code = archive.readFile(false).errCode;
        if (code === BAD_PASSWORD || code === MISSING_PASSWORD) {
          result = failure(code, true);
        }
        return false;
      });
      for (const index of wanted) {
        sink.begin(index);
        sink.end(result);
      }
      return;
    }

    walk(opened, (header, number) => {
      const index = targets.get(number);
      if (index === undefined) {
        // In a solid archive UnRAR unpacks a skipped file all the same, to have what the next ones build on.
        const code = archive.readFile(true).errCode;
        if (code) {
          throw failure(code, (header.flags & ENCRYPTED) !== 0);
        }
        return true;
      }
      const listed = listing.entries[index];
      if (cleanPath(header.name).path !== listed.path || header.unpSize !== listed.size) {
        throw new Error('The archive has changed since it was listed');
      }
      left--;
      sink.begin(index);
      let keep = true;
      const output: Output = {
        size: listed.size,
        written: 0,
        write(chunk) {
          keep &&= sink.write(chunk);
          // Unwanted data is still unpacked while files are waiting behind it: they may build on it.
          return keep || left > 0;
        },
      };
      setOutput(output);
      const code = archive.readFile(false).errCode;
      setOutput(undefined);
      if (output.overflow) {
        sink.end(new Error('The file is larger than the archive says'));
        return false;
      }
      if (code === WRITE_FAILED && !keep) {
        sink.end();
        return false;
      }
      let error: Error | undefined;
      if (code) {
        error = failure(code, (header.flags & ENCRYPTED) !== 0);
      } else if (keep && output.written < listed.size) {
        // UnRAR reports success for a hard link or a copy of an earlier file, which it would make from that file on disk.
        error = new Error(output.written ? 'The file is shorter than the archive says' : "A link to another file in the archive, or a copy of one, which Previewix can't unpack");
      }
      sink.end(error);
      // After damage to one file the place of the next header is still known, so the walk goes on. After anything else it isn't.
      if (left && code && code !== BAD_DATA && code !== BAD_PASSWORD && code !== MISSING_PASSWORD && code !== BAD_REFERENCE) {
        throw error;
      }
      return left > 0;
    });
    if (left) {
      throw new Error('The archive has changed since it was listed');
    }
  });
}
