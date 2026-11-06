import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface HistoryItem {
  sql: string;
  /** When it ran last, in milliseconds since the epoch. */
  at: number;
  /** Set when that run ended in an error. */
  failed?: true;
}

/** Statements kept for one database. */
const MAX_ITEMS = 200;
/** A statement longer than this, a pasted dump for one, is not kept. */
const MAX_SQL = 100_000;
/** Characters of SQL kept for one database; the oldest statements go first. */
const MAX_TOTAL = 1_000_000;
/** Databases whose history is kept; the ones queried longest ago go first. */
const MAX_FILES = 100;

/** Whether the folder has been tidied in this session. */
let tidied = false;

/**
 * The statements run from the SQL prompt of one database, newest first. They live in a file of
 * their own per database, in a folder the extension owns, so they outlast the tab and VS Code, are
 * shared by every window, and never touch the database or its folder.
 */
export class QueryHistory {
  private readonly file: string;
  /** Changes wait for one another, so two of them can't each write over what the other one read. */
  private queue: Promise<unknown> = Promise.resolve();

  /** `database` is what names the database, its URI for one. */
  constructor(
    private readonly folder: string,
    private readonly database: string,
  ) {
    this.file = path.join(folder, `${createHash('sha256').update(database).digest('hex').slice(0, 32)}.json`);
  }

  async read(): Promise<HistoryItem[]> {
    try {
      const stored = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as { items?: unknown };
      const items = Array.isArray(stored.items) ? stored.items : [];
      return items.filter((item): item is HistoryItem => typeof item?.sql === 'string' && typeof item?.at === 'number');
    } catch {
      // No history yet, or a file that can't be read, which is the same to the user.
      return [];
    }
  }

  /** Puts a statement that just ran at the top; one that was there already moves up instead of appearing twice. */
  add(sql: string, failed: boolean): Promise<HistoryItem[]> {
    return this.change((items) => {
      if (!sql || sql.length > MAX_SQL) {
        return null;
      }
      const next = [{ sql, at: Date.now(), ...(failed ? { failed: true as const } : {}) }, ...items.filter((item) => item.sql !== sql)].slice(0, MAX_ITEMS);
      let total = 0;
      const fits = next.findIndex((item) => (total += item.sql.length) > MAX_TOTAL);
      return fits < 0 ? next : next.slice(0, fits);
    });
  }

  clear(): Promise<HistoryItem[]> {
    return this.change(() => []);
  }

  /** Reads the list, changes it and writes it back. `edit` returns null to leave it as it is. */
  private change(edit: (items: HistoryItem[]) => HistoryItem[] | null): Promise<HistoryItem[]> {
    const done = this.queue.then(async () => {
      const items = await this.read();
      const next = edit(items);
      if (!next) {
        return items;
      }
      if (!next.length) {
        await fs.promises.rm(this.file, { force: true });
        return next;
      }
      await fs.promises.mkdir(this.folder, { recursive: true });
      // Written aside and renamed, so another window never reads half a file.
      const temp = `${this.file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
      try {
        await fs.promises.writeFile(temp, JSON.stringify({ database: this.database, items: next }));
        await fs.promises.rename(temp, this.file);
      } catch (e) {
        await fs.promises.rm(temp, { force: true });
        throw e;
      }
      if (!tidied) {
        tidied = true;
        await tidy(this.folder);
      }
      return next;
    });
    this.queue = done.catch(() => undefined);
    return done;
  }
}

/** Drops the history of the databases that were queried longest ago, and what a crashed write left behind. */
async function tidy(folder: string): Promise<void> {
  try {
    const files = await Promise.all(
      (await fs.promises.readdir(folder)).map(async (name) => ({ name, time: (await fs.promises.stat(path.join(folder, name))).mtimeMs })),
    );
    const histories = files.filter((f) => f.name.endsWith('.json')).sort((a, b) => b.time - a.time);
    const stale = files.filter((f) => f.name.endsWith('.tmp') && Date.now() - f.time > 60_000);
    await Promise.all([...histories.slice(MAX_FILES), ...stale].map((f) => fs.promises.rm(path.join(folder, f.name), { force: true })));
  } catch {
    // Tidying is a courtesy; the history works without it.
  }
}
