import { StatementSync } from 'node:sqlite';
import { parentPort, workerData } from 'worker_threads';
import * as db from './sqliteDb';

// node:sqlite is synchronous. Running it here keeps a slow query on a big database
// from freezing the extension host.
const file: string = workerData.file;

// VS Code 1.101 and 1.102 have the module, but in a version (Node.js 22.15) without the statement methods the
// row reader, the SQL prompt and the export are built on. Stopping here gives the editor one clear message
// instead of a browser in which half of the actions fail.
if (typeof StatementSync.prototype.setReturnArrays !== 'function' || typeof StatementSync.prototype.columns !== 'function') {
  throw new Error('node:sqlite is too old in this runtime');
}

// A long request reports its progress and looks at a flag in shared memory to see whether it was
// cancelled: the thread is busy until the request is done, so a message would not get through.
let job: db.Job = { progress: () => undefined, cancelled: () => false };

const methods: Record<string, (...args: any[]) => unknown> = {
  schema: () => db.schema(file),
  count: (table) => db.count(file, table),
  rows: (table, options) => db.rows(file, table, options),
  cell: (table, key, column) => db.cell(file, table, key, column),
  save: (changes) => db.save(file, changes),
  query: (sql) => db.query(file, sql),
  blob: (source, full) => db.blob(file, source, full),
  saveBlob: (source, target) => db.saveBlob(file, source, target),
  exportRows: (source, format, target) => db.exportRows(file, source, format, target, job),
  csvPreview: (csv, options) => db.csvPreview(csv, options),
  importCsv: (csv, options) => db.importCsv(file, csv, options, job),
};

parentPort?.on('message', (msg: { id: number; method: string; args: unknown[]; cancel?: SharedArrayBuffer }) => {
  const flag = msg.cancel ? new Int32Array(msg.cancel) : undefined;
  let reported = 0;
  job = {
    progress: (done, total) => {
      const now = Date.now();
      if (now - reported >= 100) {
        reported = now;
        parentPort?.postMessage({ id: msg.id, progress: { done, total } });
      }
    },
    cancelled: () => !!flag && Atomics.load(flag, 0) === 1,
  };
  try {
    const method = methods[msg.method];
    if (!method) {
      throw new Error(`Unknown request: ${msg.method}`);
    }
    parentPort?.postMessage({ id: msg.id, result: method(...msg.args) });
  } catch (e) {
    parentPort?.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) });
  }
});
