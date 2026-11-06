import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Entry, Listing, OUTSIDE, Packing, PasswordError, VisitOptions, Visitor, isRar, isSevenZip, safeSegments } from './common';
import { runJob } from './host';
import { canUnpack, isTarHeader, listTar, visitTar } from './tar';
import { isHeavy, listZip, visitZip } from './zip';

export type { Entry, Listing } from './common';
export { PasswordError, safeSegments } from './common';
export { ZipSummary, createZip, freeName } from './zipWrite';

/** What a tar is packed with, from the first bytes of the file. */
function packingOf(head: Buffer): Packing | undefined {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return 'gzip';
  }
  if (head.length >= 10 && head.toString('latin1', 0, 3) === 'BZh' && head[3] >= 0x31 && head[3] <= 0x39 && [0x314159265359, 0x177245385090].includes(head.readUIntBE(4, 6))) {
    return 'bzip2';
  }
  if (head.length >= 6 && head.readUIntBE(0, 6) === 0xfd377a585a00) {
    return 'xz';
  }
  // A Zstandard frame, or one of the skippable frames that may come before it.
  if (head.length >= 4 && (head.readUInt32LE(0) === 0xfd2fb528 || head.readUInt32LE(0) >>> 4 === 0x184d2a5)) {
    return 'zstd';
  }
  return undefined;
}

/**
 * Reads the list of entries. The format is told from the content, not from the file name.
 * Throws a `PasswordError` when even the list is encrypted and the password is missing or wrong.
 */
export async function listArchive(file: string, options: { password?: string; signal?: AbortSignal } = {}): Promise<Listing> {
  const { password, signal } = options;
  const handle = await fs.promises.open(file, 'r');
  let head: Buffer;
  try {
    const buffer = Buffer.alloc(512);
    head = buffer.subarray(0, (await handle.read(buffer, 0, 512, 0)).bytesRead);
  } finally {
    await handle.close();
  }
  const packing = packingOf(head);
  if (packing === 'bzip2' || packing === 'xz') {
    // Unpacked by this extension's own code, which is kept off this thread (see worker.ts).
    return runJob<Listing>({ op: 'list', file, type: 'tar', packing }, undefined, signal);
  }
  if (packing) {
    if (!canUnpack(packing)) {
      throw new Error('Zstandard archives need a newer version of VS Code');
    }
    return listTar(file, packing, signal);
  }
  if (isSevenZip(head)) {
    return runJob<Listing>({ op: 'list', file, type: '7z', password }, undefined, signal);
  }
  if (isRar(head)) {
    return runJob<Listing>({ op: 'list', file, type: 'rar', password }, undefined, signal);
  }
  if (isTarHeader(head)) {
    return listTar(file, undefined, signal);
  }
  // Everything else is tried as ZIP, which is recognised by its end: a self-extracting archive starts with a program.
  try {
    return await listZip(file);
  } catch (e) {
    // "Not a ZIP archive" is only the right thing to say about a file that set out as one.
    if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) {
      throw e;
    }
    throw new Error(head.length ? 'This is not a ZIP, 7z, RAR or tar archive, or it is damaged beyond recognition' : 'The file is empty');
  }
}

/** Hands the unpacked data of the wanted entries (indexes into `listing.entries`) to `visitor`, in the order that suits the format. */
export function visitEntries(file: string, listing: Listing, wanted: number[], visitor: Visitor, options: VisitOptions = {}): Promise<void> {
  const { type } = listing;
  const inWorker =
    type === '7z' || type === 'rar' || (type === 'tar' && (listing.packing === 'bzip2' || listing.packing === 'xz')) || (type === 'zip' && wanted.some((index) => isHeavy(listing.entries[index])));
  if (inWorker) {
    const job = { op: 'visit' as const, file, type, listing, wanted, password: options.password, probe: options.probe };
    return runJob<void>(job, (index, data) => visitor(listing.entries[index], index, data), options.signal);
  }
  return type === 'zip' ? visitZip(file, listing, wanted, visitor, options) : visitTar(file, listing, wanted, visitor, options.signal);
}

/** How many encrypted entries a password is tried on before it is called wrong. */
const PROBES = 3;

/**
 * Finds out whether the password opens the encrypted ones of these entries, before anything is
 * written. Throws a `PasswordError` when it is missing or wrong. Several entries are tried, since
 * one that is damaged in the wrong place looks just like a wrong password. Formats without a
 * check value only show a wrong password when the data comes out broken, and pass here.
 */
async function checkPassword(file: string, listing: Listing, indexes: number[], options: VisitOptions): Promise<void> {
  const encrypted = indexes.filter((index) => listing.entries[index].encrypted && listing.entries[index].kind === 'file' && !listing.entries[index].blocked);
  if (!encrypted.length) {
    return;
  }
  if (options.password === undefined) {
    throw new PasswordError(false);
  }
  let refused: unknown;
  for (const index of encrypted.slice(0, PROBES)) {
    try {
      await visitEntries(
        file,
        listing,
        [index],
        async (_, __, data) => {
          for await (const chunk of data) {
            void chunk;
          }
        },
        { ...options, probe: true },
      );
      return;
    } catch (e) {
      if (options.signal?.aborted) {
        throw e;
      }
      if (!(e instanceof PasswordError)) {
        // Anything else will come up again, with the entry it belongs to, when the files are unpacked.
        return;
      }
      refused = e;
    }
  }
  throw refused;
}

/** Why this entry can't be written as a file, or undefined when it can. */
function refusal(entry: Entry): string | undefined {
  return entry.blocked ?? (entry.kind === 'file' ? undefined : entry.kind === 'link' ? 'A link, not a file' : 'A folder, not a file');
}

/**
 * Writes `data` to `target` through a file next to it, so that a failure halfway
 * (a wrong checksum, a full disk, a cancel) never leaves a broken file under the final name.
 */
async function writeFile(target: string, entry: Entry, data: AsyncIterable<Buffer>, signal?: AbortSignal): Promise<void> {
  const part = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    await pipeline(Readable.from(data, { objectMode: false }), fs.createWriteStream(part, { mode: entry.mode && entry.mode & 0o111 ? 0o755 : 0o644 }), { signal });
    if (entry.mtime) {
      await fs.promises.utimes(part, new Date(), new Date(entry.mtime)).catch(() => undefined);
    }
    await fs.promises.rename(part, target);
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Extracts one file entry to the file `target`, whose folder must exist. Throws a `PasswordError`
 * when the entry is encrypted and the password is missing or wrong.
 */
export async function extractFile(file: string, listing: Listing, index: number, target: string, options: VisitOptions = {}): Promise<void> {
  const entry = listing.entries[index];
  const reason = refusal(entry);
  if (reason) {
    throw new Error(reason);
  }
  if (entry.encrypted && options.password === undefined) {
    throw new PasswordError(false);
  }
  let written = false;
  await visitEntries(
    file,
    listing,
    [index],
    async (found, _, data) => {
      await writeFile(target, found, data, options.signal);
      written = true;
    },
    options,
  );
  if (!written) {
    throw new Error('The archive has changed since it was listed');
  }
}

/** Whether this error may come from a wrong password, in a format that can't tell that from damaged data. */
export function maybeWrongPassword(e: unknown): boolean {
  return (e as Error)?.name === 'UnsurePasswordError';
}

export interface ExtractOptions {
  /** Number of leading characters to drop from every entry path, so that a subtree lands in the folder under its own name. */
  strip?: number;
  /** Replace files that already exist; otherwise they are left alone and counted as skipped. */
  overwrite: boolean;
  /** For the encrypted entries among them. */
  password?: string;
  signal?: AbortSignal;
  /** Called as bytes are written, with the totals so far and the entry being written. */
  onProgress?: (doneBytes: number, totalBytes: number, entryPath: string) => void;
}

export interface ExtractSummary {
  files: number;
  folders: number;
  /** Files left alone because they exist. */
  skipped: number;
  /** Symbolic and hard links, which are never created. */
  links: number;
  failed: { path: string; reason: string }[];
  cancelled: boolean;
}

/**
 * Where an entry goes inside `folder`, or undefined when its path can't be trusted.
 * The resolved path is compared with the folder as a last line of defence against "zip slip".
 */
export function targetOf(folder: string, entryPath: string): string | undefined {
  const segments = safeSegments(entryPath);
  if (!segments) {
    return undefined;
  }
  const root = path.resolve(folder);
  const target = path.resolve(root, ...segments);
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep) ? target : undefined;
}

interface Plan {
  /** Entry index -> where it goes. */
  files: Map<number, string>;
  folders: string[];
  links: number;
  failed: { path: string; reason: string }[];
  bytes: number;
}

function plan(listing: Listing, indexes: number[], folder: string, strip: number): Plan {
  const result: Plan = { files: new Map(), folders: [], links: 0, failed: [], bytes: 0 };
  for (const index of indexes) {
    const entry = listing.entries[index];
    if (entry.kind === 'link' && !entry.blocked) {
      result.links++;
      continue;
    }
    const target = entry.blocked ? undefined : targetOf(folder, entry.path.slice(strip));
    if (!target) {
      result.failed.push({ path: entry.path, reason: entry.blocked ?? OUTSIDE });
    } else if (entry.kind === 'dir') {
      result.folders.push(target);
    } else {
      result.files.set(index, target);
      result.bytes += entry.size;
    }
  }
  return result;
}

async function exists(target: string): Promise<boolean> {
  return fs.promises.lstat(target).then(
    () => true,
    () => false,
  );
}

/** How many of the files an extraction would write are already there. */
export async function countExisting(listing: Listing, indexes: number[], folder: string, strip = 0): Promise<number> {
  const targets = [...plan(listing, indexes, folder, strip).files.values()];
  let count = 0;
  for (let i = 0; i < targets.length; i += 64) {
    const found = await Promise.all(targets.slice(i, i + 64).map(exists));
    count += found.filter(Boolean).length;
  }
  return count;
}

function reasonOf(e: unknown): string {
  if (e instanceof PasswordError) {
    return e.wrong ? 'The password does not open this file' : 'It needs a password';
  }
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'EEXIST' || code === 'ENOTEMPTY') {
    return 'A file or folder with this name is in the way';
  }
  if (code === 'ENOSPC') {
    return 'The disk is full';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'No permission to write here';
  }
  return (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
}

/**
 * Extracts the given entries into `folder`. Problems with single entries are collected in the
 * summary; an archive that can't be read any further throws. So does a missing or wrong
 * password (`PasswordError`), before anything is written.
 */
export async function extractEntries(file: string, listing: Listing, indexes: number[], folder: string, options: ExtractOptions): Promise<ExtractSummary> {
  const { signal, password } = options;
  const todo = plan(listing, indexes, folder, options.strip ?? 0);
  await checkPassword(file, listing, [...todo.files.keys()], { password, signal });
  const summary: ExtractSummary = { files: 0, folders: 0, skipped: 0, links: todo.links, failed: todo.failed, cancelled: false };
  /** Folders known to exist, so that 50,000 files in one folder mean one mkdir. */
  const made = new Set<string>();
  const makeFolder = async (target: string) => {
    if (!made.has(target)) {
      await fs.promises.mkdir(target, { recursive: true });
      made.add(target);
    }
  };

  for (const target of todo.folders) {
    try {
      await makeFolder(target);
      summary.folders++;
    } catch (e) {
      summary.failed.push({ path: path.relative(folder, target), reason: reasonOf(e) });
    }
  }

  let done = 0;
  try {
    await visitEntries(
      file,
      listing,
      [...todo.files.keys()],
      async (entry, index, data) => {
        const target = todo.files.get(index) as string;
        options.onProgress?.(done, todo.bytes, entry.path);
        const before = done;
        try {
          await makeFolder(path.dirname(target));
          if (!options.overwrite && (await exists(target))) {
            summary.skipped++;
          } else {
            const counted = (async function* () {
              for await (const chunk of data) {
                done += chunk.length;
                options.onProgress?.(done, todo.bytes, entry.path);
                yield chunk;
              }
            })();
            await writeFile(target, entry, counted, signal);
            summary.files++;
          }
        } catch (e) {
          if (signal?.aborted) {
            throw e;
          }
          summary.failed.push({ path: entry.path, reason: reasonOf(e) });
        }
        done = before + entry.size;
      },
      { password, signal },
    );
  } catch (e) {
    if (!signal?.aborted) {
      throw e;
    }
    summary.cancelled = true;
  }
  return summary;
}
