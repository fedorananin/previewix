import * as path from 'path';
import { Worker } from 'worker_threads';
import * as vscode from 'vscode';
import { QueryHistory } from './sqliteHistory';
import { followFile, getNonce, missingAssets, parentOf, watchFile } from './util';

interface Progress {
  done: number;
  total: number;
}

/** Runs the database requests of one editor in a worker thread, started on first use. */
class Database {
  private worker: Worker | undefined;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** Stops each of the long requests under way. */
  private readonly jobs = new Set<() => void>();

  constructor(
    private readonly script: string,
    private readonly file: string,
  ) {}

  call(method: string, args: unknown[]): Promise<unknown> {
    const worker = (this.worker ??= this.start());
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  }

  /**
   * Runs a long request (an export, an import) in a worker of its own, so the page can go on reading
   * meanwhile. The worker is told to stop through shared memory, since it reads no messages while it works.
   */
  run(method: string, args: unknown[], report: (progress: Progress) => void, token: vscode.CancellationToken): Promise<unknown> {
    const cancel = new SharedArrayBuffer(4);
    const stop = () => void Atomics.store(new Int32Array(cancel), 0, 1);
    const worker = new Worker(this.script, { workerData: { file: this.file } });
    const subscription = token.onCancellationRequested(stop);
    this.jobs.add(stop);
    return new Promise<unknown>((resolve, reject) => {
      worker.on('message', (msg: { progress?: Progress; result?: unknown; error?: string }) => {
        if (msg.progress) {
          report(msg.progress);
        } else if (msg.error !== undefined) {
          reject(new Error(msg.error));
        } else {
          resolve(msg.result);
        }
      });
      worker.on('error', (e) => reject(explain(e)));
      worker.on('exit', () => reject(new Error('The database worker stopped.')));
      worker.postMessage({ id: 0, method, args, cancel });
    }).finally(() => {
      subscription.dispose();
      this.jobs.delete(stop);
      void worker.terminate();
    });
  }

  dispose(): void {
    void this.worker?.terminate();
    // A long request is asked to stop rather than cut off, so it can undo what it has written so far.
    this.jobs.forEach((stop) => stop());
  }

  private start(): Worker {
    const worker = new Worker(this.script, { workerData: { file: this.file } });
    worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
      const waiting = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error !== undefined) {
        waiting?.reject(new Error(msg.error));
      } else {
        waiting?.resolve(msg.result);
      }
    });
    const fail = (error: Error) => {
      this.worker = undefined;
      for (const waiting of this.pending.values()) {
        waiting.reject(error);
      }
      this.pending.clear();
    };
    worker.on('error', (e) => fail(explain(e)));
    worker.on('exit', () => fail(new Error('The database worker stopped.')));
    return worker;
  }
}

function explain(e: Error): Error {
  // The SQLite module ships with the Node.js runtime of VS Code 1.101 and later, and is complete enough from 1.103.
  return /node:sqlite|built-in module/i.test(String(e)) ? new Error('SQLite databases need a newer version of VS Code.') : e;
}

const count = (n: number) => n.toLocaleString('en-US');

/** A name the file system takes, made from a table or column name. */
const fileName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'export';

/** Browser for SQLite databases: tables, rows with staged edits, foreign keys to follow, table structure, an SQL prompt with history, export, CSV import and blobs. */
export class SqliteEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.sqlite';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const { uri } = document;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webview.html = this.html(webview, mediaRoot);

    const local = uri.scheme === 'file';
    const database = new Database(path.join(this.context.extensionPath, 'dist', 'sqliteWorker.js'), uri.fsPath);
    // Kept under the database's address, so a file that is moved or renamed starts a new history.
    const history = new QueryHistory(path.join(this.context.globalStorageUri.fsPath, 'sqlite-history'), uri.toString());

    // In WAL mode a change lands in the "-wal" file and leaves the database file itself untouched.
    const changed = () => webview.postMessage({ type: 'changed' });
    const watchers = [followFile(panel, uri, SqliteEditorProvider.viewType, { onChange: changed }), watchFile(uri.with({ path: `${uri.path}-wal` }), changed)];
    let disposed = false;
    panel.onDidDispose(() => {
      disposed = true;
      database.dispose();
      watchers.forEach((w) => w.dispose());
    });

    /** A worker request under a progress notification with a Cancel button. */
    const long = (title: string, method: string, args: unknown[], describe: (progress: Progress) => string) =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
        let shown = 0;
        return database.run(
          method,
          args,
          (p) => {
            const percent = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
            // Without an increment the bar keeps running, which is right when the end isn't known.
            progress.report({ message: describe(p), increment: p.total ? percent - shown : undefined });
            shown = percent;
          },
          token,
        );
      });

    const saveTo = async (name: string, filters: Record<string, string[]>) => {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(parentOf(uri), name), filters });
      if (target && target.scheme !== 'file') {
        throw new Error('The file can only be saved on this computer.');
      }
      return target;
    };

    /** The CSV file picked for an import. The page never names a file to read itself. */
    let csvFile: string | undefined;
    const csv = () => {
      if (!csvFile) {
        throw new Error('Choose a CSV file first.');
      }
      return csvFile;
    };

    // The requests that need a dialog or a progress notification are served here; the rest go to the worker as they are.
    const own: Record<string, (...args: any[]) => Thenable<unknown>> = {
      export: async (source: unknown, format: 'csv' | 'json', name: string) => {
        const target = await saveTo(`${fileName(name)}.${format}`, format === 'json' ? { JSON: ['json'] } : { CSV: ['csv'] });
        if (!target) {
          return null;
        }
        const file = path.basename(target.fsPath);
        const result = await long(`Exporting to ${file}`, 'exportRows', [source, format, target.fsPath], (p) =>
          p.total ? `${count(p.done)} of ${count(p.total)} rows` : `${count(p.done)} rows`,
        );
        return { ...(result as object), name: file };
      },
      pickCsv: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          defaultUri: parentOf(uri),
          openLabel: 'Import',
          filters: { 'Delimited text': ['csv', 'tsv', 'tab', 'txt'], 'All files': ['*'] },
        });
        if (!picked?.length) {
          return null;
        }
        if (picked[0].scheme !== 'file') {
          throw new Error('The file can only be read from this computer.');
        }
        csvFile = picked[0].fsPath;
        return { name: path.basename(csvFile) };
      },
      csvPreview: (options: unknown) => database.call('csvPreview', [csv(), options]),
      import: (options: { table: string }) =>
        long(`Importing ${path.basename(csv())} into "${options.table}"`, 'importCsv', [csv(), options], (p) => `${Math.floor((p.done / (p.total || 1)) * 100)}%`),
      saveBlob: async (source: unknown, name: string) => {
        const target = await saveTo(fileName(name), {});
        if (!target) {
          return null;
        }
        const size = await database.call('saveBlob', [source, target.fsPath]);
        return { size, name: path.basename(target.fsPath) };
      },
      history: () => history.read(),
      remember: (sql: unknown, failed: unknown) => history.add(String(sql), !!failed),
      clearHistory: () => history.clear(),
    };

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          webview.postMessage({
            type: 'init',
            name: path.posix.basename(uri.path),
            error: local ? '' : 'SQLite databases can only be opened from this computer.',
          });
          break;
        case 'request': {
          const served = own[msg.method];
          const reply = await (served ? Promise.resolve().then(() => served(...msg.args)) : database.call(msg.method, msg.args)).then(
            (result) => ({ result }),
            (e) => ({ error: e instanceof Error ? e.message : String(e) }),
          );
          // Closing the tab stops the worker, which fails the requests still in flight.
          if (!disposed) {
            webview.postMessage({ type: 'response', id: msg.id, ...reply });
          }
          break;
        }
      }
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'sqlite.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'sqlite.js'));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src blob:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <aside id="side">
    <div id="fileName"></div>
    <div id="fileInfo"></div>
    <nav id="tables"></nav>
    <button id="openQuery" title="Run an SQL statement">SQL query</button>
  </aside>

  <main id="main">
    <header id="toolbar">
      <div class="group" id="modes">
        <button data-mode="data">Data</button>
        <button data-mode="structure">Structure</button>
      </div>
      <input type="search" id="filter" placeholder="Filter rows…" title="Show the rows that contain this text in any column" spellcheck="false">
      <div class="group" id="editButtons">
        <button id="addRow" title="Add a row">Add row</button>
        <button id="deleteRow" title="Delete the selected rows">Delete row</button>
        <button id="setNull" title="Set the selected cell to NULL (Delete)">Set NULL</button>
      </div>
      <button id="refresh" title="Read the database again">Refresh</button>
      <div class="group" id="transfer">
        <div id="exportWrap">
          <button id="export" title="Write all rows, as sorted and filtered here, into a file">Export…</button>
          <div id="exportMenu" hidden>
            <button data-format="csv">CSV…</button>
            <button data-format="json">JSON…</button>
          </div>
        </div>
        <button id="import" title="Add the rows of a CSV file to a table, or make a new table of them">Import CSV…</button>
      </div>
      <div class="group right">
        <span id="status"></span>
        <button id="revert" disabled title="Drop the unsaved changes">Revert</button>
        <button id="save" class="primary" disabled title="Write the changes into the database (Ctrl/Cmd+S)">Save changes</button>
      </div>
    </header>
    <p id="note" hidden></p>
    <div id="trail" hidden>
      <button id="back" title="Back to where the reference was followed from (Ctrl/Cmd+[)"></button>
      <span id="trailText"></span>
      <button id="showAll" title="Show every row of the table again">Show all rows</button>
    </div>

    <section id="queryPanel" hidden>
      <textarea id="sql" rows="5" spellcheck="false" placeholder="SELECT * FROM …   (several statements, separated by semicolons, run in order)"></textarea>
      <div class="group">
        <button id="run" class="primary" title="Run the statements in order (Ctrl/Cmd+Enter). A script stops at the first one that fails; what ran before it stays, unless the script has its own BEGIN and COMMIT around it">Run</button>
        <div id="historyWrap">
          <button id="history" title="Statements run on this database before (Alt+Up and Alt+Down step through them)">History</button>
          <div id="historyMenu" hidden></div>
        </div>
        <span id="queryStatus"></span>
      </div>
      <ol id="queryLog" hidden></ol>
    </section>

    <div id="gridWrap" tabindex="0">
      <table id="grid"></table>
      <div id="structure" hidden></div>
      <div id="message">Loading…</div>
    </div>

    <div id="refs" hidden></div>

    <section id="inspector" hidden>
      <div class="group">
        <span id="blobInfo"></span>
        <button id="saveBlob" title="Write the blob into a file as it is">Save blob to file…</button>
      </div>
      <div id="blobView"></div>
    </section>

    <footer id="pager">
      <div class="group">
        <button id="pageFirst" title="First page">«</button>
        <button id="pagePrev" title="Previous page">‹</button>
        <span id="pageInfo"></span>
        <button id="pageNext" title="Next page">›</button>
        <button id="pageLast" title="Last page">»</button>
      </div>
      <label>Rows per page
        <select id="pageSize">
          <option>100</option><option>250</option><option>500</option><option>1000</option>
        </select>
      </label>
    </footer>
  </main>

  <div id="complete" role="listbox" hidden></div>

  <div id="dialog" hidden>
    <div id="dialogBox" role="dialog" aria-modal="true">
      <h3 id="dialogTitle"></h3>
      <div id="dialogBody"></div>
      <div id="dialogButtons" class="group"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
