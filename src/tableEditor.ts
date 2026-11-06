import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import * as vscode from 'vscode';
import { flatRows, toCsv, type FlatTable } from './csv';
import { DBF_ENCODINGS, readDbf, type DbfOptions, type DbfTable } from './dbf';
import { readJsonLines } from './jsonl';
import type { ParquetSource, ParquetTable } from './parquetRead';
import { followFile, getNonce, missingAssets, parentOf } from './util';
import { readWorkbook, type Sheet } from './xlsxRead';

export type Kind = 'csv' | 'jsonl' | 'xlsx' | 'parquet' | 'dbf';

/**
 * Larger files are refused. Text takes about a second per 50 MB to parse; a spreadsheet takes ten
 * times that, and a gigabyte of memory per 100 MB while it is being read. A Parquet file on disk
 * has no limit, because only the part that is shown is read; the limit is for one that has to be
 * loaded whole from another file system. A dBase file is read whole, but shown up to the limits of its reader.
 */
export const MAX_BYTES: Record<Kind, number> = { csv: 100 * 1024 * 1024, jsonl: 100 * 1024 * 1024, xlsx: 50 * 1024 * 1024, parquet: 256 * 1024 * 1024, dbf: 256 * 1024 * 1024 };
const NOUN: Record<Kind, string> = { csv: 'delimited text', jsonl: 'JSON Lines files', xlsx: 'spreadsheets', parquet: 'Parquet files that are not on a local disk', dbf: 'dBase files' };
/** A memo file is read whole as well; a larger one is left out, and its cells are marked instead. */
const MAX_MEMO_BYTES = 256 * 1024 * 1024;

/** What a table brings along besides its cells, which depends on the format. */
interface TableExtras {
  /** Spreadsheets: the number behind every cell, and the merged ranges. */
  nums?: Float64Array;
  merges?: Uint32Array;
  /** JSON Lines, Parquet and dBase: the column names, which are not a row of the table there. */
  names?: string[];
  /** JSON Lines: the line of the file behind every row, when lines were skipped. */
  lines?: Uint32Array;
  /** Parquet and dBase: the type of every column, short and in full, and which columns hold numbers. */
  types?: string[];
  details?: string[];
  numeric?: Uint8Array;
}

/**
 * Read-only table viewers for JSON Lines, spreadsheets (Excel, OpenDocument, Numbers), Parquet and
 * dBase files. Delimited text is shown by the same page, but through `CsvEditorProvider`, which edits it.
 */
export class TableEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewTypes: Record<Kind, string> = { csv: 'previewix.csv', jsonl: 'previewix.jsonl', xlsx: 'previewix.xlsx', parquet: 'previewix.parquet', dbf: 'previewix.dbf' };

  /** The table view of a text file, for the way back from its source. */
  static textViewType(uri: vscode.Uri): string {
    return TableEditorProvider.viewTypes[/\.(jsonl|ndjson)$/i.test(uri.path) ? 'jsonl' : 'csv'];
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly kind: Exclude<Kind, 'csv'>,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const { uri } = document;
    const { kind } = this;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webview.html = tableHtml(this.context, webview, kind);

    /** The sheets of the workbook as last read. They are sent one at a time, when the page asks for one. */
    let sheets: Sheet[] = [];
    /** The code page of a dBase file picked by hand; empty while the file says it, or it is guessed. */
    let codePage = '';
    let loads = 0;
    let disposed = false;
    /** The reader that is at work, which a newer load or the closing of the tab stops. */
    let reader: Worker | undefined;
    const stopReader = () => {
      void reader?.terminate();
      reader = undefined;
    };
    panel.onDidDispose(() => {
      disposed = true;
      stopReader();
    });

    const post = (message: unknown) => {
      if (!disposed) {
        webview.postMessage(message);
      }
    };
    // The text travels as bytes: a string of this size would be turned into JSON and parsed again on the other side.
    const sendBytes = (load: number, index: number, text: Uint8Array, ends: Uint32Array, rowEnds: Uint32Array, extras: TableExtras = {}) =>
      post({ type: 'table', load, index, text, ends, rowEnds, ...extras });
    const sendTable = (load: number, index: number, table: FlatTable, extras?: TableExtras) =>
      sendBytes(load, index, new Uint8Array(Buffer.from(table.text, 'utf8')), table.ends, table.rowEnds, extras);
    const work = <T>(name: string, data: object, watch?: typeof WATCHED): Promise<T> => {
      stopReader();
      const started = startWorker<T>(this.context.extensionPath, name, data, watch);
      reader = started.worker;
      return started.result;
    };

    const load = async () => {
      const id = ++loads;
      const name = path.posix.basename(uri.path);
      const file = { type: 'file', load: id, kind, name, sheets: [{ name, hidden: 0 }] };
      try {
        const { size } = await vscode.workspace.fs.stat(uri);
        const onDisk = kind === 'parquet' && uri.scheme === 'file';
        if (size > MAX_BYTES[kind] && !onDisk) {
          const limit = `${MAX_BYTES[kind] / 1024 / 1024} MB`;
          post({ ...file, size, error: `This file is ${formatSize(size)}. Previewix opens ${NOUN[kind]} of up to ${limit}.` });
          return;
        }
        if (kind === 'parquet') {
          const source: ParquetSource = onDisk ? { path: uri.fsPath } : { bytes: await vscode.workspace.fs.readFile(uri) };
          const { table } = await work<{ table: ParquetTable }>('parquetRead.js', { previewixParquet: source }, WATCHED);
          if (id !== loads) {
            return;
          }
          const { text, ends, rowEnds, names, types, details, numeric, ...parquet } = table;
          post({ ...file, size, parquet });
          sendBytes(id, 0, text, ends, rowEnds, { names, types, details, numeric });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (id !== loads) {
          return;
        }
        if (kind === 'dbf') {
          const options: DbfOptions = { ...(await this.besideDbf(uri)), encoding: codePage };
          const read = fs.existsSync(path.join(this.context.extensionPath, 'dist', 'dbf.js'))
            ? (await work<{ dbf: DbfTable }>('dbf.js', { previewixDbf: { bytes, ...options } })).dbf
            : readDbf(bytes, options);
          if (id !== loads) {
            return;
          }
          const { text, ends, rowEnds, names, types, details, numeric, info } = read;
          post({ ...file, size, dbf: info, encodings: DBF_ENCODINGS, chosen: codePage });
          sendTable(id, 0, { text, ends, rowEnds }, { names, types, details, numeric });
        } else if (kind === 'jsonl') {
          const { table, names, lines, broken, firstBroken, encoding } = await this.offThread(bytes, 'jsonl.js', 'previewixJsonLines', 'read', readJsonLines, work);
          if (id !== loads) {
            return;
          }
          post({ ...file, size, encoding, broken, firstBroken });
          sendTable(id, 0, table, { names, lines });
        } else {
          const read = await this.offThread(bytes, 'xlsxRead.js', 'previewixSheets', 'sheets', readWorkbook, work);
          if (id !== loads) {
            return;
          }
          sheets = read;
          post({ ...file, size, sheets: sheets.map(({ name, hidden, rows, cols }) => ({ name, hidden, rows, cols })) });
        }
      } catch (e) {
        if (id === loads) {
          sheets = [];
          post({ ...file, error: `Could not read the file: ${e instanceof Error ? e.message : e}` });
        }
      }
    };

    followFile(panel, uri, TableEditorProvider.viewTypes[kind], { onChange: () => void load() });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          // A page that was rebuilt remembers the code page that was chosen for it.
          codePage = typeof msg.encoding === 'string' ? msg.encoding : '';
          await load();
          break;
        case 'encoding':
          codePage = String(msg.value);
          await load();
          break;
        case 'sheet': {
          const sheet = msg.load === loads ? sheets[msg.index] : undefined;
          if (sheet) {
            sendTable(msg.load, msg.index, sheet.table, { nums: sheet.nums, merges: sheet.merges });
          }
          break;
        }
        case 'export':
          try {
            if (sheets[msg.index]) {
              await this.exportCsv(uri, sheets[msg.index]);
            }
          } catch (e) {
            vscode.window.showErrorMessage(`Previewix: the export failed. ${e instanceof Error ? e.message : e}`);
          }
          post({ type: 'exported' });
          break;
        case 'openSource':
          await openSource(uri, panel, msg.line);
          break;
        case 'copy':
          await copyText(msg);
          break;
      }
    });
  }

  /**
   * What lies next to a dBase table and belongs to it: the memo file (`.dbt`, or `.fpt` of FoxPro)
   * and the `.cpg` file that names the code page. They carry the table's name, in any case.
   */
  private async besideDbf(uri: vscode.Uri): Promise<DbfOptions> {
    const folder = parentOf(uri);
    const stem = path.posix.basename(uri.path).replace(/\.[^.]*$/, '').toLowerCase();
    const found: DbfOptions = {};
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
        const dot = name.lastIndexOf('.');
        const ext = name.slice(dot + 1).toLowerCase();
        if (dot < 0 || type === vscode.FileType.Directory || name.slice(0, dot).toLowerCase() !== stem) {
          continue;
        }
        const file = vscode.Uri.joinPath(folder, name);
        if ((ext === 'dbt' || ext === 'fpt') && !found.memo && (await vscode.workspace.fs.stat(file)).size <= MAX_MEMO_BYTES) {
          found.memo = await vscode.workspace.fs.readFile(file);
        } else if (ext === 'cpg' && found.cpg === undefined && (await vscode.workspace.fs.stat(file)).size <= 1024) {
          found.cpg = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('latin1');
        }
      }
    } catch {
      // A folder that can't be listed has no memo file to offer; the table is shown without.
    }
    return found;
  }

  /**
   * Reading a large workbook or a long JSON Lines file takes seconds, and it is synchronous. It runs
   * in a worker thread when the build has the reader as a bundle of its own, which answers with its
   * result under `key`; otherwise here, holding up the extension host.
   */
  private async offThread<T>(bytes: Uint8Array, script: string, data: string, key: string, read: (bytes: Uint8Array) => T, work: <R>(name: string, data: object) => Promise<R>): Promise<T> {
    if (!fs.existsSync(path.join(this.context.extensionPath, 'dist', script))) {
      return read(bytes);
    }
    return (await work<Record<string, T>>(script, { [data]: bytes }))[key];
  }

  private async exportCsv(source: vscode.Uri, sheet: Sheet): Promise<void> {
    const stem = path.posix.basename(source.path, path.posix.extname(source.path));
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(parentOf(source), `${stem} - ${sheet.name.replace(/[\\/:*?"<>|]/g, '_')}.csv`),
      filters: { CSV: ['csv'] },
      title: 'Export sheet to CSV',
    });
    if (!target) {
      return;
    }
    // Rows end at their last value; a CSV file has the same number of fields in every line.
    const rows = flatRows(sheet.table).map((row) => (row.length < sheet.cols ? row.concat(new Array<string>(sheet.cols - row.length).fill('')) : row));
    await vscode.workspace.fs.writeFile(target, Buffer.from(toCsv(rows), 'utf8'));
    await vscode.commands.executeCommand('vscode.open', target, vscode.ViewColumn.Beside);
  }
}

/** The page of every table viewer. What a kind doesn't have is left out of it. */
export function tableHtml(context: vscode.ExtensionContext, webview: vscode.Webview, kind: Kind): string {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const nonce = getNonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'table.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'table.js'));
  // A text file has a source to open; the names of the columns are a row of the table only in CSV and spreadsheets.
  const text = kind === 'csv' || kind === 'jsonl';
  const headerRow = kind === 'csv' || kind === 'xlsx';
  // Delimited text is the one kind that is edited.
  const edited = kind === 'csv';
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body data-kind="${kind}">
  <header id="toolbar">
    <input type="search" id="filter" placeholder="Filter rows…" title="Show the rows that contain this text in any column (Ctrl/Cmd+F)" spellcheck="false">
    <span id="matches"></span>
    <button id="clearFilters" title="Remove the row filter and every column filter" hidden>Clear filters</button>
    ${edited ? '<button id="reapply" title="Rows stay where they are while you edit them. This sorts and filters them again." hidden>Sort and filter again</button>' : ''}
    ${headerRow ? '<label title="Use the first row for the column names"><input type="checkbox" id="header"> First row is header</label>' : ''}
    ${
      kind === 'csv'
        ? `<label>Delimiter
      <select id="delimiter" title="The character that separates the fields">
        <option value="">Auto</option>
        <option value=",">Comma</option>
        <option value=";">Semicolon</option>
        <option value="&#9;">Tab</option>
        <option value="|">Pipe</option>
      </select>
    </label>`
        : ''
    }
    ${kind === 'dbf' ? '<label>Encoding <select id="encoding" title="The code page the text of this file is read with"><option value="">Auto</option></select></label>' : ''}
    <div class="group right">
      ${edited ? '<button id="addRow" title="Add a row below the selected one, or at the end of the file (Ctrl/Cmd+Enter)">Add row</button>' : ''}
      <button id="copyAs" title="Copy the selected cells in another format" aria-haspopup="menu" disabled>Copy as…</button>
      ${text ? '<button id="openSource" title="Open this file in the text editor">Open source</button>' : ''}
      ${kind === 'xlsx' ? '<button id="export" title="Save the sheet on screen as a CSV file">Export sheet to CSV…</button>' : ''}
    </div>
  </header>
  <div id="notice" hidden></div>
  <div id="gridWrap" tabindex="0">
    <div id="canvas">
      <div id="head"></div>
      <div id="rows"></div>
      ${edited ? '<textarea id="editor" rows="1" wrap="off" spellcheck="false" autocomplete="off" hidden></textarea>' : ''}
    </div>
    <div id="message">Loading…</div>
  </div>
  <section id="detail" hidden>
    <div id="detailTitle"></div>
    <pre id="detailText"></pre>
  </section>
  <nav id="sheets" hidden></nav>
  <footer id="status">
    <span id="info"></span>
    <span id="selection"></span>
  </footer>
  <div id="copyMenu" class="popup menu" role="menu" hidden>
    <button role="menuitem" data-format="tsv">Copy<span class="hint">tab-separated</span></button>
    <button role="menuitem" data-format="markdown">Copy as Markdown table</button>
    <button role="menuitem" data-format="json">Copy as JSON</button>
    <button role="menuitem" data-format="csv">Copy as CSV</button>
    ${
      edited
        ? `<button role="menuitem" data-edit="cut" class="divided">Cut</button>
    <button role="menuitem" data-edit="paste">Paste</button>
    <button role="menuitem" data-edit="clear">Clear cells<span class="hint">Delete</span></button>
    <button role="menuitem" data-edit="above" class="divided">Insert row above</button>
    <button role="menuitem" data-edit="below">Insert row below</button>
    <button role="menuitem" data-edit="deleteRows">Delete rows</button>`
        : ''
    }
    <button role="menuitem" id="menuFilter" class="divided">Keep the rows with this value</button>
  </div>
  ${
    edited
      ? `<div id="columnMenu" class="popup menu" role="menu" hidden>
    <button role="menuitem" data-column="rename">Rename column</button>
    <button role="menuitem" data-column="left" class="divided">Insert column left</button>
    <button role="menuitem" data-column="right">Insert column right</button>
    <button role="menuitem" data-column="delete">Delete column</button>
  </div>`
      : ''
  }
  <div id="columnFilter" class="popup" hidden>
    <div id="columnFilterTitle"></div>
    <select id="filterOp" title="How the cells of this column are compared">
      <optgroup label="Text">
        <option value="contains">contains</option>
        <option value="notContains">does not contain</option>
        <option value="equals">equals</option>
        <option value="starts">starts with</option>
        <option value="ends">ends with</option>
      </optgroup>
      <optgroup label="Number">
        <option value="eq">=</option>
        <option value="ne">≠</option>
        <option value="gt">&gt;</option>
        <option value="ge">≥</option>
        <option value="lt">&lt;</option>
        <option value="le">≤</option>
      </optgroup>
      <optgroup label="Cell">
        <option value="empty">is empty</option>
        <option value="notEmpty">is not empty</option>
      </optgroup>
    </select>
    <input type="text" id="filterValue" spellcheck="false">
    <div class="group">
      <button id="filterRemove" title="Remove the filter of this column">Clear</button>
      <button id="filterClose">Done</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

/**
 * Starts one of the readers that are bundles of their own (`dist/<name>`) in a worker thread, so
 * that seconds of synchronous work don't hold up the extension host. The reader posts one message:
 * its result, or `error`.
 *
 * With `watch`, the reader is one that a damaged file might send into a loop or out of memory in
 * spite of its checks (see `WATCHED`): its heap is limited, it posts `{alive: true}` every second
 * for as long as its thread gets to run, and one that has stopped doing so is given up and stopped.
 */
export function startWorker<T>(extensionPath: string, name: string, data: object, watch?: typeof WATCHED): { worker: Worker; result: Promise<T> } {
  const worker = new Worker(path.join(extensionPath, 'dist', name), { workerData: data, ...(watch && { resourceLimits: { maxOldGenerationSizeMb: watch.heap } }) });
  const result = new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let missed = 0;
    // Half the time, twice: a computer that wakes from sleep finds the first half over, and the reader gets to say that it is still there.
    const wait = () => {
      clearTimeout(timer);
      timer = watch && setTimeout(() => {
        if (++missed < 2) {
          wait();
          return;
        }
        reject(new Error(`the reader gave no sign of life for ${watch.silence / 1000} seconds and was stopped. The file is probably damaged.`));
        void worker.terminate();
      }, watch.silence / 2);
    };
    const onMessage = (msg: T & { error?: string; alive?: boolean }) => {
      if (watch && msg.alive) {
        missed = 0;
        wait();
        return;
      }
      clearTimeout(timer);
      worker.off('message', onMessage);
      if (msg.error === undefined) {
        resolve(msg);
      } else {
        reject(new Error(msg.error));
      }
      void worker.terminate();
    };
    worker.on('message', onMessage);
    worker.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('the file is too large to fit in memory.') : e));
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('the reader stopped.'));
    });
    wait();
  });
  return { worker, result };
}

/**
 * The limits of a watched reader: megabytes of heap, which is twice what the largest table that is
 * shown has been seen to take, and the milliseconds without a sign of life after which it is given up.
 */
export const WATCHED = { heap: 2048, silence: 20_000 };

/** Opens the text of a file in the editor group of its table, not in a split. A line of the file, when one is named, is put under the cursor. */
export async function openSource(uri: vscode.Uri, panel: vscode.WebviewPanel, at?: unknown): Promise<void> {
  const line = typeof at === 'number' && Number.isInteger(at) && at > 0 ? new vscode.Range(at - 1, 0, at - 1, 0) : undefined;
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', line ? { viewColumn: panel.viewColumn, selection: line } : panel.viewColumn);
}

/** The clipboard of a webview isn't always writable from the page, so the extension writes it. */
export async function copyText(msg: { text?: unknown; what?: unknown }): Promise<void> {
  await vscode.env.clipboard.writeText(String(msg.text));
  vscode.window.setStatusBarMessage(`Previewix: ${msg.what} copied`, 2500);
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
