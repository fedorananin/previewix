import { MessagePort, parentPort, workerData } from 'worker_threads';
import { Listing, Packing, PasswordError, Sink, Visitor } from './common';
import { listRar, visitRar } from './rar';
import { listSevenZip, visitSevenZip } from './sevenZip';
import { listTar, visitTar } from './tar';
import { visitZip } from './zip';

// Worker thread entry (dist/archiveWorker.js) for the formats whose decoders are code of this
// extension or WebAssembly: they compute for seconds on end, and UnRAR can't be interrupted at
// all. One worker does one job, a listing or a run over some entries, and is then terminated;
// cancelling a job terminates it too. A worker never writes a file: what it unpacks goes to the
// extension host piece by piece (see host.ts for the other end).

export interface Job {
  op: 'list' | 'visit';
  file: string;
  type: Listing['type'];
  packing?: Packing;
  password?: string;
  /** For `visit`. */
  listing?: Listing;
  wanted?: number[];
  probe?: boolean;
  /** Two counters shared with the host: pieces it has taken, and the number of the entry it wants no more of. */
  control: SharedArrayBuffer;
}

export interface Failure {
  message: string;
  name: string;
  wrong?: boolean;
}

/** Pieces that may be on their way to the host, which is what bounds the memory a fast decoder and a slow disk take. */
const WINDOW = 16;

function describe(e: unknown): Failure {
  if (e instanceof PasswordError) {
    return { message: e.message, name: e.name, wrong: e.wrong };
  }
  return e instanceof Error ? { message: e.message, name: e.name } : { message: String(e), name: 'Error' };
}

function sinkTo(port: MessagePort, shared: SharedArrayBuffer): Sink {
  const control = new Int32Array(shared);
  let sent = 0;
  let entry = 0;
  return {
    begin(index) {
      entry++;
      port.postMessage({ begin: index });
    },
    write(chunk) {
      if (Atomics.load(control, 1) === entry) {
        return false;
      }
      // A copy is what gets handed over: the chunk may be a view of memory that its reader goes on using.
      const piece = new Uint8Array(chunk);
      port.postMessage(piece, [piece.buffer]);
      sent++;
      // The decoders don't return to the event loop, so waiting for the host is done by blocking.
      for (let taken = Atomics.load(control, 0); sent - taken >= WINDOW; taken = Atomics.load(control, 0)) {
        Atomics.wait(control, 0, taken, 1000);
      }
      return Atomics.load(control, 1) !== entry;
    },
    end(error) {
      port.postMessage({ end: error === undefined ? null : describe(error) });
    },
  };
}

async function run(job: Job, port: MessagePort): Promise<unknown> {
  if (job.op === 'list') {
    return job.type === '7z' ? listSevenZip(job.file, job.password) : job.type === 'rar' ? listRar(job.file, job.password) : listTar(job.file, job.packing);
  }
  const listing = job.listing as Listing;
  const wanted = job.wanted as number[];
  const sink = sinkTo(port, job.control);
  const options = { password: job.password, probe: job.probe };
  if (job.type === '7z') {
    return visitSevenZip(job.file, listing, wanted, sink, options);
  }
  if (job.type === 'rar') {
    return visitRar(job.file, listing, wanted, sink, options);
  }
  // The ZIP and tar readers hand out entries their own way, as the host does it; here it is passed on.
  const visitor: Visitor = async (_, index, data) => {
    sink.begin(index);
    try {
      for await (const chunk of data) {
        if (!sink.write(chunk)) {
          break;
        }
      }
    } catch (e) {
      sink.end(e);
      return;
    }
    sink.end();
  };
  return job.type === 'zip' ? visitZip(job.file, listing, wanted, visitor, options) : visitTar(job.file, listing, wanted, visitor);
}

const job = (workerData as { previewixArchive?: Job } | null)?.previewixArchive;
if (job && parentPort) {
  const port = parentPort;
  run(job, port).then(
    (result) => port.postMessage({ done: result ?? null }),
    (e) => port.postMessage({ fail: describe(e) }),
  );
}
