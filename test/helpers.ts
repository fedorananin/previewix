import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { after } from 'node:test';
import * as os from 'os';
import * as path from 'path';

/** The project folder. The tests run as bundles in a temporary folder, so `__dirname` is not it. */
export const root = process.env.PREVIEWIX_ROOT ?? process.cwd();

/** A committed fixture, from test/fixtures/. */
export const fixture = (name: string): string => path.join(root, 'test', 'fixtures', name);

/** A folder for the files of one test file, removed when its tests are done. */
export function scratch(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'previewix-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const sha = (data: Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex');

export interface Random {
  /** A number in [0, 1). */
  (): number;
  /** An integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  bytes(n: number): Buffer;
}

/**
 * Random numbers that are the same on every run (mulberry32), so a randomised test that fails
 * can be run again and fails the same way.
 */
export function random(seed: number): Random {
  let state = seed >>> 0;
  const next = (() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Random;
  next.int = (n) => Math.floor(next() * n);
  next.pick = (items) => items[next.int(items.length)];
  next.bytes = (n) => Buffer.from(Array.from({ length: n }, () => next.int(256)));
  return next;
}

const found = new Map<string, string | undefined>();

/** The path of a program on the PATH, or undefined. */
export function which(name: string): string | undefined {
  if (!found.has(name)) {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
    let hit: string | undefined;
    for (const dir of dirs) {
      for (const candidate of names) {
        const file = path.join(dir, candidate);
        try {
          fs.accessSync(file, fs.constants.X_OK);
          if (fs.statSync(file).isFile()) {
            hit ??= file;
          }
        } catch {
          // not here
        }
      }
    }
    found.set(name, hit);
  }
  return found.get(name);
}

/**
 * A Python that can import `module`, or undefined. PREVIEWIX_TEST_PYTHON names the interpreter to
 * try first (a virtual environment with mutagen or pyarrow, say); `python3` on the PATH is the other.
 */
export function python(module: string): string | undefined {
  const key = `python:${module}`;
  if (!found.has(key)) {
    const candidates = [process.env.PREVIEWIX_TEST_PYTHON, which('python3')].filter((item): item is string => !!item);
    found.set(
      key,
      candidates.find((exe) => spawnSync(exe, ['-c', `import ${module}`], { stdio: 'ignore', timeout: 20000 }).status === 0),
    );
  }
  return found.get(key);
}

/** The `skip` option of a test that needs a program: false when it is there, the reason otherwise. */
export const needs = (tool: string | undefined, name: string): string | false => (tool ? false : `${name} is not installed`);

/** Runs a program and returns what it printed; throws with its error output when it fails. */
export function run(exe: string, args: string[], input?: string | Uint8Array): Buffer {
  const result = spawnSync(exe, args, { input, maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    throw new Error(`${path.basename(exe)} ${args.join(' ')}\n${result.stderr?.toString() ?? result.error?.message ?? ''}`);
  }
  return result.stdout;
}

/** Every file under `dir` with its content, by relative path with forward slashes; links as `-> target`. */
export function tree(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const item of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(at, item.name);
      const name = prefix + item.name;
      if (item.isSymbolicLink()) {
        result[name] = `-> ${fs.readlinkSync(full)}`;
      } else if (item.isDirectory()) {
        result[`${name}/`] = '';
        walk(full, `${name}/`);
      } else {
        result[name] = sha(fs.readFileSync(full));
      }
    }
  };
  walk(dir, '');
  return result;
}
