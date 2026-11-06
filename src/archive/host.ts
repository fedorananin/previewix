import * as path from 'path';
import { Worker } from 'worker_threads';
import { PasswordError, abortError } from './common';
import type { Failure, Job } from './worker';

// The extension host's end of the worker thread in worker.ts.

type Message = Uint8Array | { begin: number } | { end: Failure | null } | { done: unknown } | { fail: Failure };

function revive(failure: Failure): Error {
  if (failure.name === 'PasswordError') {
    return new PasswordError(!!failure.wrong);
  }
  const error = new Error(failure.message);
  error.name = failure.name;
  return error;
}

/**
 * Runs one job in a worker thread of its own and returns its result. For a `visit` job, `onEntry`
 * is called for every entry the worker unpacks, with its index and its data; data left unread
 * is dropped. An error of a single entry is thrown from its data, an error of the job from here.
 */
export async function runJob<T>(job: Omit<Job, 'control'>, onEntry?: (index: number, data: AsyncIterable<Buffer>) => Promise<void>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw abortError();
  }
  const control = new Int32Array(new SharedArrayBuffer(8));
  // Next to this bundle, like the other worker entries (see esbuild.js).
  const worker = new Worker(path.join(__dirname, 'archiveWorker.js'), { workerData: { previewixArchive: { ...job, control: control.buffer } } });
  const queue: Message[] = [];
  let wake: (() => void) | undefined;
  /** Set when no further message can come. */
  let over: Error | undefined;
  const stop = (reason: Error) => {
    over ??= reason;
    wake?.();
  };
  worker.on('message', (message: Message) => {
    queue.push(message);
    wake?.();
  });
  // A worker that runs out of memory takes only itself down.
  worker.on('error', (e) => stop(e instanceof RangeError || (e as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('Not enough memory to read this archive') : e));
  worker.on('exit', () => stop(new Error('The archive reader stopped unexpectedly')));
  const onAbort = () => {
    stop(abortError());
    void worker.terminate();
  };
  signal?.addEventListener('abort', onAbort);

  const next = async (): Promise<Message> => {
    while (!queue.length) {
      if (over) {
        throw over;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
    return queue.shift() as Message;
  };
  /** Tells the worker that a piece has been taken, which lets it send another. */
  const taken = () => {
    Atomics.add(control, 0, 1);
    Atomics.notify(control, 0);
  };

  try {
    for (let entry = 1; ; entry++) {
      const message = await next();
      if (message instanceof Uint8Array || 'end' in message) {
        throw new Error('The archive reader answered out of turn');
      }
      if ('done' in message) {
        return message.done as T;
      }
      if ('fail' in message) {
        throw revive(message.fail);
      }
      let ended = false;
      const data = (async function* (): AsyncGenerator<Buffer> {
        while (!ended) {
          const piece = await next();
          if (piece instanceof Uint8Array) {
            taken();
            yield Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
          } else if ('end' in piece) {
            ended = true;
            if (piece.end) {
              throw revive(piece.end);
            }
          } else {
            throw new Error('The archive reader answered out of turn');
          }
        }
      })();
      await onEntry?.(message.begin, data);
      if (!ended) {
        // The rest of this entry isn't wanted: the worker is told, and what is already on its way is dropped.
        Atomics.store(control, 1, entry);
        Atomics.notify(control, 0);
        for (let piece = await next(); piece instanceof Uint8Array || !('end' in piece); piece = await next()) {
          if (!(piece instanceof Uint8Array)) {
            throw new Error('The archive reader answered out of turn');
          }
          taken();
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    worker.removeAllListeners();
    void worker.terminate();
  }
}
