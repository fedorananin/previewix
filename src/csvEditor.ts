import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { editedTable, fingerprint, packBackup, readOps, rowsAfter, runRender, unpackBackup, type Conversion, type Op, type RenderJob, type RenderResult } from './csvEdit';
import { MAX_BYTES, copyText, formatSize, openSource, startWorker, tableHtml } from './tableEditor';
import { replaceFile } from './tags/common';
import { followFile } from './util';

/** One step of the undo history: what the page did, and how to take it back. */
interface Edit {
  ops: Op[];
  inverse: Op[];
  /** Which reading of the file the step belongs to. A step from before a reload has nothing left to act on. */
  generation: number;
}

interface Page {
  panel: vscode.WebviewPanel;
  post(message: unknown): void;
}

/**
 * A delimited text file open as a table. The pages hold the table itself; this holds what a save
 * needs and VS Code may ask for at any time: the file as it was read, and the edits made since.
 */
class CsvDocument implements vscode.CustomDocument {
  /** The file the edits are counted from: as it was read, or as it was written last. Undefined while it can't be shown. */
  bytes: Uint8Array | undefined;
  /** Why there is no table: the file is too large, or could not be read. */
  error: string | undefined;
  /** What tells this content from another one that turns up on disk. */
  print = '';
  /** The delimiter picked by hand; empty while it is detected. */
  delimiter = '';
  /** The delimiter the table was split by, which holds for as long as there are edits. */
  used = ',';
  /** Rows of the table as it stands, to tell an edit that can't belong to it. */
  rows = 0;

  /**
   * The undo history, as VS Code keeps it too: `index` steps of `log` are applied. `bytes` is the
   * table `anchor` steps in, after the steps of `detour`: those lead from the file to a state that
   * can be reached in the history, once undoing past a save and editing on has cut the saved state off.
   */
  log: Edit[] = [];
  index = 0;
  anchor = 0;
  detour: Op[] = [];
  /** VS Code's idea of which step is the saved one no longer matches `anchor`. */
  detached = false;
  generation = 0;
  /** Counts every change of the table, so that an edit made to an older one can be told. */
  version = 0;
  loads = 0;

  /** The file was changed by someone else while there were unsaved edits. */
  changedOnDisk = false;
  /** A text editor holds unsaved changes to the same file. */
  textDirty = false;
  /** Set while the extension itself writes the file, when the watcher must neither read it nor take it for gone. */
  saving = false;
  /** The state the pages were told last, so that they are told again only when it changes. */
  told = '';
  readonly pages = new Set<Page>();
  /** Reactions to the file changing on disk, one after the other. */
  queue: Promise<void> = Promise.resolve();

  constructor(readonly uri: vscode.Uri) {}

  get unsaved(): boolean {
    return this.detour.length > 0 || this.index !== this.anchor;
  }

  /** The steps that lead from the file to the table as it stands. */
  path(): Op[] {
    const ops = [...this.detour];
    for (let i = this.anchor; i < this.index; i++) {
      ops.push(...this.log[i].ops);
    }
    for (let i = this.anchor - 1; i >= this.index; i--) {
      ops.push(...this.log[i].inverse);
    }
    return ops;
  }

  /** Starts over from a content of the file. The undo history doesn't apply to it, so its steps are made to do nothing. */
  adopt(bytes: Uint8Array | undefined, error?: string): void {
    this.bytes = bytes;
    this.error = error;
    this.print = bytes ? fingerprint(bytes) : '';
    this.forget();
    this.changedOnDisk = false;
  }

  forget(): void {
    this.generation++;
    this.log = [];
    this.index = this.anchor = 0;
    this.detour = [];
    this.detached = false;
    this.version++;
  }

  dispose(): void {
    this.pages.clear();
  }
}

/**
 * The table editor for delimited text (CSV, TSV). The page is the one of `TableEditorProvider`,
 * but cells are edited in it, so this is a full custom editor: VS Code shows the document as
 * unsaved, saves it on Ctrl/Cmd+S, undoes and redoes, asks before closing and backs it up.
 */
export class CsvEditorProvider implements vscode.CustomEditorProvider<CsvDocument> {
  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CsvDocument> | vscode.CustomDocumentContentChangeEvent<CsvDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  private readonly documents = new Map<string, CsvDocument>();

  constructor(private readonly context: vscode.ExtensionContext) {
    // A text editor on the same file is a second copy of it, and each of the two has to know of the other's unsaved changes.
    const twin = (text: vscode.TextDocument) => {
      const document = this.documents.get(text.uri.toString());
      if (document) {
        this.setState(document);
      }
    };
    context.subscriptions.push(
      this.changes,
      vscode.workspace.onDidChangeTextDocument((e) => twin(e.document)),
      vscode.workspace.onDidSaveTextDocument(twin),
      vscode.workspace.onDidOpenTextDocument(twin),
      vscode.workspace.onDidCloseTextDocument((text) => setTimeout(() => twin(text), 0)),
    );
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<CsvDocument> {
    const document = new CsvDocument(uri);
    const backup = openContext.backupId ? await this.readBackup(openContext.backupId) : undefined;
    if (backup) {
      // The edits come back as steps that lead away from the file they were made to.
      document.adopt(backup.bytes);
      document.delimiter = backup.delimiter;
      document.detour = backup.ops;
      document.detached = true;
      const disk = await this.readFile(uri).catch(() => undefined);
      document.changedOnDisk = !!disk && fingerprint(disk) !== document.print;
    } else {
      await this.readInto(document);
      if (openContext.backupId) {
        void vscode.window.showWarningMessage(`Previewix: the unsaved changes to "${nameOf(uri)}" could not be restored. The file is shown as it is on disk.`);
      }
    }
    return document;
  }

  resolveCustomEditor(document: CsvDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const { uri } = document;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    webview.html = tableHtml(this.context, webview, 'csv');

    let disposed = false;
    const page: Page = {
      panel,
      post: (message) => {
        if (!disposed) {
          webview.postMessage(message);
        }
      },
    };
    const key = uri.toString();
    document.pages.add(page);
    this.documents.set(key, document);
    panel.onDidDispose(() => {
      disposed = true;
      document.pages.delete(page);
      if (!document.pages.size && this.documents.get(key) === document) {
        this.documents.delete(key);
      }
    });

    followFile(panel, uri, 'previewix.csv', {
      // Every editor of the document watches the file; the queue lets the first one act and the others find nothing new.
      onChange: () => void (document.queue = document.queue.then(() => this.diskChanged(document)).catch(() => undefined)),
      keep: () => document.unsaved || document.saving,
    });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          // A page that was rebuilt remembers the delimiter that was chosen for it. With edits, or a second editor, the document's own holds.
          if (typeof msg.delimiter === 'string' && msg.delimiter !== document.delimiter && !document.log.length && !document.unsaved && document.pages.size === 1) {
            document.delimiter = msg.delimiter;
          }
          this.send(document, page);
          break;
        case 'reload':
          this.send(document, page);
          break;
        case 'delimiter':
          // Another delimiter makes other rows and columns of the same file, which the edits would not fit.
          if (document.unsaved) {
            this.send(document, page);
            break;
          }
          if (String(msg.value) !== document.delimiter) {
            document.delimiter = String(msg.value);
            document.forget();
          }
          this.sendAll(document);
          break;
        case 'edit':
          this.edit(document, page, msg);
          break;
        case 'readClipboard':
          page.post({ type: 'clipboard', text: await vscode.env.clipboard.readText() });
          break;
        case 'revert':
          // The command acts on the active editor, which is this one right after a click in it.
          if (panel.active) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
          }
          break;
        case 'openSource':
          if (document.unsaved) {
            // The text editor reads the file, which doesn't have the edits yet; it would look as if they were lost.
            const save = 'Save and Open Source';
            const answer = await vscode.window.showWarningMessage(
              `"${nameOf(uri)}" has unsaved changes in the table.`,
              { modal: true, detail: 'The text editor shows the file as it is on disk, without them.' },
              save,
            );
            if (answer !== save || !panel.active) {
              break;
            }
            await vscode.commands.executeCommand('workbench.action.files.save');
            if (document.unsaved) {
              break;
            }
          }
          await openSource(uri, panel, msg.line);
          break;
        case 'copy':
          await copyText(msg);
          break;
      }
    });
  }

  // ---- The table and its edits ---------------------------------------------

  private async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(uri);
  }

  /** Reads the file from disk and makes it what the document shows. */
  private async readInto(document: CsvDocument): Promise<void> {
    try {
      const { size } = await vscode.workspace.fs.stat(document.uri);
      if (size > MAX_BYTES.csv) {
        document.adopt(undefined, `This file is ${formatSize(size)}. Previewix opens delimited text of up to ${MAX_BYTES.csv / 1024 / 1024} MB.`);
        return;
      }
      document.adopt(await this.readFile(document.uri));
    } catch (e) {
      document.adopt(undefined, `Could not read the file: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Sends a page the table as it stands: the file, with the edits made since it was read. */
  private send(document: CsvDocument, page: Page): void {
    const load = ++document.loads;
    const name = nameOf(document.uri);
    const file = { type: 'file', load, kind: 'csv', name, sheets: [{ name, hidden: 0 }] };
    if (!document.bytes) {
      page.post({ ...file, error: document.error ?? 'Could not read the file.' });
      return;
    }
    try {
      const { table, encoding, delimiter, detected } = editedTable(document.bytes, document.path(), document.delimiter);
      document.used = delimiter;
      document.rows = table.rowEnds.length;
      // A file from a place that can't be written to, such as an older version in a comparison, is only shown.
      const editable = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== false;
      page.post({ ...file, size: document.bytes.length, encoding, delimiter, detected, editable, state: this.stateOf(document) });
      // The text travels as bytes: a string of this size would be turned into JSON and parsed again on the other side.
      page.post({ type: 'table', load, index: 0, text: new Uint8Array(Buffer.from(table.text, 'utf8')), ends: table.ends, rowEnds: table.rowEnds, version: document.version });
    } catch (e) {
      page.post({ ...file, error: `Could not read the file: ${e instanceof Error ? e.message : e}` });
    }
  }

  private sendAll(document: CsvDocument): void {
    document.told = '';
    for (const page of document.pages) {
      this.send(document, page);
    }
  }

  private stateOf(document: CsvDocument): { dirty: boolean; changedOnDisk: boolean; textDirty: boolean } {
    const key = document.uri.toString();
    document.textDirty = vscode.workspace.textDocuments.some((text) => text.isDirty && text.uri.toString() === key);
    return { dirty: document.unsaved, changedOnDisk: document.changedOnDisk, textDirty: document.textDirty };
  }

  private setState(document: CsvDocument): void {
    const state = { type: 'state', ...this.stateOf(document) };
    // A text editor on the same file reports every key that is pressed in it.
    const told = JSON.stringify(state);
    if (told === document.told) {
      return;
    }
    document.told = told;
    for (const page of document.pages) {
      page.post(state);
    }
  }

  /** Takes an edit from the page that made it, hands it to the other pages of the document, and tells VS Code. */
  private edit(document: CsvDocument, page: Page, msg: { version?: unknown; ops?: unknown; inverse?: unknown; label?: unknown }): void {
    let edit: Edit;
    try {
      // An edit made to a table that has changed meanwhile names other rows than it means.
      if (!document.bytes || msg.version !== document.version) {
        throw new Error('The table has changed.');
      }
      edit = { ops: readOps(msg.ops), inverse: readOps(msg.inverse), generation: document.generation };
      const rows = rowsAfter(edit.ops, document.rows);
      if (rowsAfter(edit.inverse, rows) !== document.rows) {
        throw new Error('The edit and its inverse do not match.');
      }
      document.rows = rows;
    } catch {
      // The page has applied it already; the table as it really stands puts that right.
      this.send(document, page);
      return;
    }
    // A new edit ends what could be redone. When that cuts off the step the file was saved at,
    // the way from the file to the table leads back through the steps that are dropped.
    const cut = document.index < document.anchor;
    if (cut) {
      for (let i = document.anchor - 1; i >= document.index; i--) {
        document.detour.push(...document.log[i].inverse);
      }
      document.anchor = document.index;
      document.detached = true;
    }
    document.log.length = document.index;
    document.log.push(edit);
    document.index++;
    const from = document.version++;
    for (const other of document.pages) {
      if (other !== page) {
        other.post({ type: 'ops', from, ops: edit.ops });
      }
    }
    this.changes.fire({
      document,
      label: typeof msg.label === 'string' ? msg.label : 'Edit',
      undo: () => this.step(document, edit, false),
      redo: () => this.step(document, edit, true),
    });
    if (cut) {
      // VS Code counts the steps to its saved one, and would call the document saved again when the
      // count happens to match. A change without a step keeps it unsaved until it is written.
      this.changes.fire({ document });
    }
    this.setState(document);
  }

  /** Undo or redo, as VS Code asks for it. */
  private step(document: CsvDocument, edit: Edit, redo: boolean): void {
    if (edit.generation !== document.generation || document.log[redo ? document.index : document.index - 1] !== edit) {
      return;
    }
    const ops = redo ? edit.ops : edit.inverse;
    document.index += redo ? 1 : -1;
    document.rows = rowsAfter(ops, document.rows);
    const from = document.version++;
    for (const page of document.pages) {
      page.post({ type: 'ops', from, ops, step: redo ? 'redo' : 'undo' });
    }
    this.setState(document);
  }

  /** The file changed on disk, or came back. Without unsaved edits the table follows it; with them it stays, and a save asks first. */
  private async diskChanged(document: CsvDocument): Promise<void> {
    if (document.saving) {
      return;
    }
    const disk = await this.readFile(document.uri).catch(() => undefined);
    if (disk && fingerprint(disk) === document.print) {
      return;
    }
    if (document.unsaved) {
      if (disk && !document.changedOnDisk) {
        document.changedOnDisk = true;
        this.setState(document);
      }
      return;
    }
    await this.readInto(document);
    this.sendAll(document);
  }

  // ---- Saving ---------------------------------------------------------------

  /** Writing a large file means parsing it twice, which takes seconds; that is done in a worker thread when the build has one. */
  private async render(job: RenderJob): Promise<RenderResult> {
    if (job.bytes.length < 1024 * 1024 || !fs.existsSync(path.join(this.context.extensionPath, 'dist', 'csvEdit.js'))) {
      return runRender(job);
    }
    return startWorker<RenderResult>(this.context.extensionPath, 'csvEdit.js', { previewixCsv: job }).result;
  }

  /** The file with the edits in it, checked to read back as the table. Asks when the encoding of the file can't hold them. */
  private async rendered(document: CsvDocument, cancellation: vscode.CancellationToken): Promise<{ at: number; generation: number; result: RenderResult & { bytes: Uint8Array } }> {
    let convert: Conversion | undefined;
    for (;;) {
      if (!document.bytes) {
        throw new Error('The file is not open as a table, so there is nothing to save.');
      }
      const at = document.index;
      const { generation } = document;
      const result = await this.render({ bytes: document.bytes, ops: document.path(), options: { delimiter: document.used, eol: os.EOL, verify: true, convert } });
      if (cancellation.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (result.bytes) {
        return { at, generation, result: { ...result, bytes: result.bytes } };
      }
      const { encoding, chars } = result.unencodable ?? { encoding: 'its encoding', chars: [] };
      const plain = 'Save as UTF-8';
      const marked = 'Save as UTF-8 with BOM';
      const answer = await vscode.window.showWarningMessage(
        chars.length
          ? `"${nameOf(document.uri)}" is encoded as ${encoding}, which has no ${chars.map((char) => `“${char}”`).join(', ')}.`
          : `"${nameOf(document.uri)}" is read as ${encoding}, but with these changes it would be read as UTF-8 and show other characters.`,
        { modal: true, detail: 'The whole file can be written as UTF-8 instead. Excel reads UTF-8 reliably only with a byte order mark (BOM); some other programs show the mark as a stray character.' },
        plain,
        marked,
      );
      if (answer !== plain && answer !== marked) {
        throw new vscode.CancellationError();
      }
      convert = answer === marked ? 'UTF-8 with BOM' : 'UTF-8';
    }
  }

  async saveCustomDocument(document: CsvDocument, cancellation: vscode.CancellationToken): Promise<void> {
    const name = nameOf(document.uri);
    // The last look before a user's file is replaced: is it still the file the edits were made to?
    const disk = await this.readFile(document.uri).catch(() => undefined);
    if (disk && fingerprint(disk) !== document.print) {
      const overwrite = 'Overwrite';
      const answer = await vscode.window.showWarningMessage(
        `"${name}" has changed on disk since it was opened.`,
        { modal: true, detail: 'Saving replaces the newer file with the table as it is here. To take the newer file instead, use "File: Revert File".' },
        overwrite,
      );
      if (answer !== overwrite) {
        throw new vscode.CancellationError();
      }
    }
    if (this.stateOf(document).textDirty) {
      const save = 'Save Anyway';
      const answer = await vscode.window.showWarningMessage(
        `"${name}" also has unsaved changes in a text editor.`,
        { modal: true, detail: 'The two sets of changes are apart: saving the table writes the file without those of the text editor, which will then find the file changed under it.' },
        save,
      );
      if (answer !== save) {
        throw new vscode.CancellationError();
      }
    }
    // VS Code takes the document for saved as it stands when this returns, so an edit made while
    // the file was being written is written too.
    for (let round = 0; round < 5; round++) {
      const { at, generation, result } = await this.rendered(document, cancellation);
      if (generation !== document.generation) {
        return;
      }
      // Nothing to write when no edit is left and the file is there as it was read.
      if (!(disk && fingerprint(disk) === document.print && Buffer.compare(result.bytes, document.bytes as Uint8Array) === 0)) {
        document.saving = true;
        try {
          await writeFile(document.uri, result.bytes);
        } finally {
          document.saving = false;
        }
      }
      // The watcher reports the write a little later. It then finds the file to be the one that is known here, and leaves it at that.
      document.bytes = result.bytes;
      document.print = fingerprint(result.bytes);
      document.anchor = at;
      document.detour = [];
      document.detached = false;
      document.changedOnDisk = false;
      // A file is read with the delimiter that fits its first lines best. If the edits changed which one that is,
      // the table goes on being split as it was, and the user is told that the next reader may differ.
      if (!document.delimiter && result.detected && result.detected !== document.used) {
        document.delimiter = document.used;
        void vscode.window.showWarningMessage(`Previewix: after these changes "${name}" no longer looks ${DELIMITERS[document.used] ?? document.used}-separated to a program that guesses the delimiter. The table keeps it; choose it under Delimiter if the file opens differently next time.`);
      }
      for (const page of document.pages) {
        page.post({ type: 'saved', size: result.bytes.length, encoding: result.encoding, delimiter: document.used, detected: !document.delimiter });
      }
      if (document.index === at) {
        break;
      }
    }
    this.setState(document);
  }

  async saveCustomDocumentAs(document: CsvDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    const { result } = await this.rendered(document, cancellation);
    await writeFile(destination, result.bytes);
    // VS Code now counts the document as saved, though its own file is as it was.
    document.detached = true;
  }

  async revertCustomDocument(document: CsvDocument): Promise<void> {
    const disk = await this.readFile(document.uri).catch(() => undefined);
    if (disk && fingerprint(disk) === document.print && !document.detached) {
      // The file is the one the edits were made to: the steps up to the saved one can still be undone, as VS Code expects.
      document.index = document.anchor;
      document.log.length = document.anchor;
      document.version++;
      document.changedOnDisk = false;
    } else {
      await this.readInto(document);
    }
    this.sendAll(document);
  }

  async backupCustomDocument(document: CsvDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    if (!document.bytes) {
      throw new Error('The file is not open as a table, so there is nothing to back up.');
    }
    const { destination } = context;
    await vscode.workspace.fs.writeFile(destination, packBackup(document.delimiter || document.used, document.bytes, document.path()));
    return {
      id: destination.toString(),
      delete: () => void vscode.workspace.fs.delete(destination).then(undefined, () => undefined),
    };
  }

  private async readBackup(id: string): Promise<ReturnType<typeof unpackBackup>> {
    try {
      return unpackBackup(await vscode.workspace.fs.readFile(vscode.Uri.parse(id)));
    } catch {
      return undefined;
    }
  }
}

const DELIMITERS: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

function nameOf(uri: vscode.Uri): string {
  return path.posix.basename(uri.path);
}

/** Writes a file so that a failure midway can't leave half a table: next to the target, then renamed over it. */
async function writeFile(target: vscode.Uri, data: Uint8Array): Promise<void> {
  if (target.scheme !== 'file') {
    await vscode.workspace.fs.writeFile(target, data);
    return;
  }
  // The rename goes to where a link points, or it would put a plain file in the link's place.
  const file = await fs.promises.realpath(target.fsPath).catch(() => target.fsPath);
  if (fs.existsSync(file)) {
    await replaceFile(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  } else {
    await fs.promises.writeFile(file, data);
  }
}
