import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { docxToMarkdown, type MarkdownExport } from './docxMarkdown';
import { replaceFile } from './tags/common';
import { followFile, getNonce, missingAssets, parentOf } from './util';

type Kind = 'pdf' | 'docx';

const VIEW_TYPES: Record<Kind, string> = { pdf: 'previewix.pdf', docx: 'previewix.docx' };

/** What both pages can ask for: opening a link, and saving the document as Markdown. */
async function handleCommon(source: vscode.Uri, webview: vscode.Webview, msg: any): Promise<void> {
  if (msg.type === 'openLink' && /^(https?|mailto):/i.test(msg.href)) {
    await vscode.env.openExternal(vscode.Uri.parse(msg.href));
  } else if (msg.type === 'saveMarkdown' || msg.type === 'convertToMarkdown') {
    try {
      // A PDF is converted in the webview, where pdf.js has it open; a Word file is converted here.
      await saveMarkdown(source, async (imageDir) =>
        msg.type === 'saveMarkdown'
          ? { markdown: String(msg.markdown), images: [] }
          : docxToMarkdown(await vscode.workspace.fs.readFile(source), imageDir),
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Previewix: the conversion failed. ${e instanceof Error ? e.message : e}`);
    }
    webview.postMessage({ type: 'converted' });
  }
}

/** Read-only viewer for Word documents (docx-preview). */
export class DocumentViewerProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewTypes = VIEW_TYPES;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, distRoot, parentOf(document.uri)] };
    webview.html = docxHtml(webview, mediaRoot, distRoot);

    const sendSource = (reload: boolean) => {
      // The cache-busting query makes the webview pick up a file that was rewritten on disk.
      const src = webview.asWebviewUri(document.uri).toString() + (reload ? `?t=${Date.now()}` : '');
      webview.postMessage({ type: 'source', src });
    };
    followFile(panel, document.uri, VIEW_TYPES.docx, { onChange: () => sendSource(true) });

    webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        sendSource(false);
      } else {
        await handleCommon(document.uri, webview, msg);
      }
    });
  }
}

/** A PDF open in the editor. The page holds the changes; this is what the extension has to remember about them. */
class PdfDocument implements vscode.CustomDocument {
  /** The one editor that shows the document. */
  panel: vscode.WebviewPanel | undefined;
  /** True while the page has the document open and can hand out its bytes. */
  loaded = false;
  /** Whether there are changes that aren't in the file yet. */
  dirty: boolean;
  signed = false;
  /** The user has agreed once to saving into a signed document. */
  signedAccepted = false;
  /** The file was changed by someone else while this editor had unsaved changes. */
  changedOnDisk = false;
  /** Set around the extension's own write, so the file watcher doesn't take it for an outside change. */
  saving = false;
  /** Sends the document to the page again; set when the editor is resolved. */
  reload: (() => Promise<void>) | undefined;

  /** `backup` is a copy with the unsaved changes in it: the one VS Code restored from, or the newest one written. */
  constructor(
    readonly uri: vscode.Uri,
    public backup: vscode.Uri | undefined,
  ) {
    this.dirty = !!backup;
  }

  dispose(): void {
    this.panel = undefined;
  }
}

interface PdfBytes {
  /** The request the page answered, which tells it later which of its states was saved. */
  id: number;
  data: Uint8Array;
}

/** Bytes arrive from the page as a typed array, but older transports turn that into a plain object. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  const values = (data as { data?: unknown } | undefined)?.data;
  return new Uint8Array(Array.isArray(values) ? values : Object.values((data ?? {}) as Record<string, number>));
}

/** Writes a PDF so that a failure midway can't leave half a document: next to the target, then renamed over it. */
async function writePdf(target: vscode.Uri, data: Uint8Array): Promise<void> {
  if (target.scheme === 'file' && fs.existsSync(target.fsPath)) {
    // The real path, so that a link to the document stays a link.
    await replaceFile(await fs.promises.realpath(target.fsPath), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  } else {
    await vscode.workspace.fs.writeFile(target, data);
  }
}

/**
 * The PDF viewer (pdf.js). Annotations and form values are changes to the file, so this is a full custom
 * editor: VS Code shows the document as unsaved, saves it on Ctrl/Cmd+S, asks before closing and backs it up.
 */
export class PdfEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
  static readonly viewType = VIEW_TYPES.pdf;
  private static readonly darkKey = 'pdf.darkPages';

  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<PdfDocument>>();
  // Content changes without undo steps: the undo history lives in pdf.js, inside the page.
  readonly onDidChangeCustomDocument = this.changes.event;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly requests = new Map<number, { resolve: (bytes: PdfBytes) => void; reject: (reason: Error) => void }>();
  private lastRequest = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): PdfDocument {
    return new PdfDocument(uri, openContext.backupId ? vscode.Uri.parse(openContext.backupId) : undefined);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, distRoot, parentOf(document.uri)] };
    webview.html = pdfHtml(webview, mediaRoot, distRoot);
    document.panel = panel;
    this.webviews.add(webview);

    const sendSource = async (reload: boolean) => {
      document.loaded = false;
      const dark = this.context.globalState.get(PdfEditorProvider.darkKey, false);
      if (document.backup) {
        // The backup isn't in a folder the page may read from, so its bytes are sent instead of an address.
        try {
          const data = await vscode.workspace.fs.readFile(document.backup);
          webview.postMessage({ type: 'source', data, unsaved: true, dark });
          return;
        } catch {
          document.backup = undefined;
        }
      }
      // The cache-busting query makes the webview pick up a file that was rewritten on disk.
      const src = webview.asWebviewUri(document.uri).toString() + (reload ? `?t=${Date.now()}` : '');
      webview.postMessage({ type: 'source', src, dark });
    };
    document.reload = () => sendSource(true);

    followFile(panel, document.uri, VIEW_TYPES.pdf, {
      onChange: () => {
        if (document.saving) {
          return;
        }
        if (document.dirty) {
          // Reloading would throw the unsaved changes away, so the page only says what happened.
          document.changedOnDisk = true;
          webview.postMessage({ type: 'changedOnDisk' });
        } else {
          void sendSource(true);
        }
      },
      keep: () => document.dirty || document.saving,
    });

    webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await sendSource(false);
        if (document.changedOnDisk) {
          webview.postMessage({ type: 'changedOnDisk' });
        }
      } else if (msg.type === 'loaded') {
        document.loaded = true;
        document.signed = !!msg.signed;
      } else if (msg.type === 'edited') {
        document.dirty = true;
        this.changes.fire({ document });
      } else if (msg.type === 'bytes') {
        const request = this.requests.get(msg.id);
        this.requests.delete(msg.id);
        if (msg.error) {
          request?.reject(new Error(String(msg.error)));
        } else {
          request?.resolve({ id: msg.id, data: toBytes(msg.data) });
        }
      } else if (msg.type === 'requestSave' || msg.type === 'revert') {
        // Both commands act on the active editor, which is this one right after a click in it.
        if (panel.active) {
          await vscode.commands.executeCommand(msg.type === 'revert' ? 'workbench.action.files.revert' : 'workbench.action.files.save');
        }
      } else if (msg.type === 'dark') {
        await this.context.globalState.update(PdfEditorProvider.darkKey, !!msg.on);
        for (const other of this.webviews) {
          if (other !== webview) {
            other.postMessage({ type: 'dark', on: !!msg.on });
          }
        }
      } else {
        await handleCommon(document.uri, webview, msg);
      }
    });

    panel.onDidDispose(() => {
      this.webviews.delete(webview);
      document.panel = undefined;
      document.loaded = false;
    });
  }

  async saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await this.confirmSave(document);
    const { id, data } = await this.bytesOf(document, false, cancellation);
    document.saving = true;
    try {
      await writePdf(document.uri, data);
    } finally {
      // The watcher reports the write a little later, and by then it must still count as our own.
      setTimeout(() => (document.saving = false), 1000);
    }
    document.backup = undefined;
    document.changedOnDisk = false;
    document.dirty = false;
    // The page answers with 'edited' if something was changed after it handed out this copy.
    document.panel?.webview.postMessage({ type: 'saved', id });
  }

  async saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    const { data } = await this.bytesOf(document, false, cancellation);
    await writePdf(destination, data);
  }

  async revertCustomDocument(document: PdfDocument): Promise<void> {
    document.backup = undefined;
    document.changedOnDisk = false;
    document.dirty = false;
    await document.reload?.();
  }

  async backupCustomDocument(
    document: PdfDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const { data } = await this.bytesOf(document, true, cancellation);
    const { destination } = context;
    await vscode.workspace.fs.writeFile(destination, data);
    // Also what the page is given if VS Code ever has to build it anew while the changes are unsaved.
    document.backup = destination;
    return {
      id: destination.toString(),
      delete: () => {
        if (document.backup?.toString() === destination.toString()) {
          document.backup = undefined;
        }
        void vscode.workspace.fs.delete(destination).then(undefined, () => undefined);
      },
    };
  }

  /** The document with every change written into it, which only the page can produce. */
  private async bytesOf(document: PdfDocument, backup: boolean, cancellation: vscode.CancellationToken): Promise<PdfBytes> {
    const { panel } = document;
    if (!panel || !document.loaded) {
      // A page that isn't there has changed nothing, so the copy it would have started from is still the document.
      if (document.backup) {
        return { id: 0, data: await vscode.workspace.fs.readFile(document.backup) };
      }
      throw new Error('The PDF is not open in an editor, so its changes cannot be read.');
    }
    const id = ++this.lastRequest;
    const bytes = await new Promise<PdfBytes>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The PDF viewer did not answer.')), 120_000);
      const listeners = vscode.Disposable.from(
        cancellation.onCancellationRequested(() => reject(new vscode.CancellationError())),
        panel.onDidDispose(() => reject(new Error('The PDF was closed.'))),
      );
      const settle = () => {
        clearTimeout(timer);
        listeners.dispose();
        this.requests.delete(id);
      };
      this.requests.set(id, {
        resolve: (value) => (settle(), resolve(value)),
        reject: (reason) => (settle(), reject(reason)),
      });
      panel.webview.postMessage({ type: 'save', id, backup });
    });
    // The last check before anything is written over a user's file.
    if (!Buffer.from(bytes.data.subarray(0, 1024)).includes('%PDF-')) {
      throw new Error('The PDF viewer returned something that is not a PDF. Nothing was written.');
    }
    return bytes;
  }

  /** Asks before a save that does more than the user may expect. Declining cancels the save. */
  private async confirmSave(document: PdfDocument): Promise<void> {
    const name = path.posix.basename(document.uri.path);
    if (document.changedOnDisk) {
      const overwrite = 'Overwrite';
      const answer = await vscode.window.showWarningMessage(
        `"${name}" has changed on disk since it was opened.`,
        { modal: true, detail: 'Saving replaces the newer file with the version open here and your changes to it.' },
        overwrite,
      );
      if (answer !== overwrite) {
        throw new vscode.CancellationError();
      }
    }
    if (document.signed && !document.signedAccepted) {
      const save = 'Save Anyway';
      const answer = await vscode.window.showWarningMessage(
        `"${name}" is digitally signed.`,
        {
          modal: true,
          detail:
            'Your changes are added after the signed content, which stays as it is, but PDF readers will report that the document was changed after it was signed. To keep the signed file untouched, use "Save As…" instead.',
        },
        save,
      );
      if (answer !== save) {
        throw new vscode.CancellationError();
      }
      document.signedAccepted = true;
    }
  }
}

async function saveMarkdown(source: vscode.Uri, convert: (imageDir: string) => Promise<MarkdownExport>): Promise<void> {
  const stem = path.posix.basename(source.path, path.posix.extname(source.path));
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(parentOf(source), `${stem}.md`),
    filters: { Markdown: ['md'] },
    title: 'Save as Markdown',
  });
  if (!target) {
    return;
  }
  const imageDir = `${path.posix.basename(target.path, path.posix.extname(target.path))}_images`;
  const { markdown, images } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Converting to Markdown…' },
    () => convert(imageDir),
  );
  if (!markdown.trim()) {
    vscode.window.showWarningMessage(
      'Previewix: no text was found in this document. If it is a scan, it needs OCR first.',
    );
    return;
  }
  for (const image of images) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(parentOf(target), imageDir, image.name), image.data);
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
  await vscode.commands.executeCommand('vscode.open', target, vscode.ViewColumn.Beside);
}

function pdfHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, distRoot: vscode.Uri): string {
  const nonce = getNonce();
  const csp = webview.cspSource;
  const assets = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'pdfjs')).toString() + '/';
  const viewerCss = `${assets}pdf_viewer.css`;
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'pdf.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview', 'pdf.js'));
  // worker-src blob: and 'wasm-unsafe-eval' are what pdf.js needs for its worker and image decoders.
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} blob: data:; font-src ${csp} blob: data:; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${csp} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${viewerCss}">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body data-assets="${assets}">
  <header id="toolbar">
    <div class="group">
      <button id="thumbsToggle" title="Page thumbnails" aria-pressed="false">Pages</button>
      <button id="outlineToggle" title="Table of contents" aria-pressed="false" hidden>Outline</button>
      <button id="prev" title="Previous page">‹</button>
      <input type="number" id="page" min="1" value="1" title="Page">
      <span id="pages">/ 0</span>
      <button id="next" title="Next page">›</button>
    </div>
    <div class="group">
      <button id="zoomOut" title="Zoom out">−</button>
      <select id="scale" title="Zoom">
        <option value="auto">Automatic</option>
        <option value="page-fit">Fit page</option>
        <option value="page-width">Fit width</option>
        <option value="0.5">50%</option>
        <option value="0.75">75%</option>
        <option value="1">100%</option>
        <option value="1.25">125%</option>
        <option value="1.5">150%</option>
        <option value="2">200%</option>
        <option value="3">300%</option>
        <option value="4">400%</option>
        <option id="customScale" hidden></option>
      </select>
      <button id="zoomIn" title="Zoom in">+</button>
      <button id="rotate" title="Rotate clockwise">Rotate</button>
      <button id="dark" title="Dark pages: light text on a dark page, photographs as they are" aria-pressed="false">Dark</button>
    </div>
    <div class="group">
      <button id="toolHighlight" title="Highlight: select text, or drag where there is none" aria-pressed="false">Highlight</button>
      <button id="toolText" title="Text: click on the page to write a note" aria-pressed="false">Text</button>
      <button id="toolDraw" title="Draw freehand" aria-pressed="false">Draw</button>
      <button id="toolImage" title="Place a picture on the page" aria-pressed="false">Image</button>
      <button id="save" class="primary" title="Save the changes into this PDF (Ctrl/Cmd+S)" disabled>Save</button>
    </div>
    <div class="group right">
      <input type="search" id="find" placeholder="Find in document" title="Find (Ctrl/Cmd+F)">
      <span id="findCount"></span>
      <button id="findPrev" title="Previous match (Shift+Enter)">↑</button>
      <button id="findNext" title="Next match (Enter)">↓</button>
      <button id="toMarkdown" title="Save the text of this PDF as a Markdown file">To Markdown</button>
    </div>
  </header>
  <div id="toolOptions" hidden>
    <div class="group" data-tool="toolHighlight" hidden>
      <span id="highlightColors" class="swatches">
        <button data-color="#FFFF98" title="Yellow" aria-pressed="false"></button>
        <button data-color="#53FFBC" title="Green" aria-pressed="false"></button>
        <button data-color="#80EBFF" title="Blue" aria-pressed="false"></button>
        <button data-color="#FFCBE6" title="Pink" aria-pressed="false"></button>
        <button data-color="#FF4F5F" title="Red" aria-pressed="false"></button>
      </span>
      <label title="Width of a highlight drawn by hand">Thickness <input type="range" id="highlightThickness" min="8" max="24" value="12"></label>
      <label title="Show or hide every highlight in the document"><input type="checkbox" id="highlightShowAll" checked> Show all</label>
    </div>
    <div class="group" data-tool="toolText" hidden>
      <label>Color <input type="color" id="textColor" value="#000000"></label>
      <label>Size <input type="number" id="textSize" min="5" max="100" value="10"></label>
    </div>
    <div class="group" data-tool="toolDraw" hidden>
      <label>Color <input type="color" id="inkColor" value="#000000"></label>
      <label>Thickness <input type="range" id="inkThickness" min="1" max="20" value="1"></label>
      <label>Opacity <input type="range" id="inkOpacity" min="5" max="100" step="5" value="100"></label>
    </div>
    <div class="group" data-tool="toolImage" hidden>
      <button id="addImage">Add Image…</button>
    </div>
    <div class="group right">
      <button id="undo" title="Undo (Ctrl/Cmd+Z)" disabled>Undo</button>
      <button id="redo" title="Redo (Ctrl/Cmd+Shift+Z)" disabled>Redo</button>
    </div>
  </div>
  <div id="notice" hidden>
    <span id="noticeText"></span>
    <button id="noticeAction" hidden></button>
    <button id="noticeClose" title="Dismiss">×</button>
  </div>
  <div id="main">
    <nav id="thumbs"><div id="thumbsInner"></div></nav>
    <nav id="outline"></nav>
    <div id="stage">
      <div id="viewerContainer" tabindex="0"><div id="viewer" class="pdfViewer"></div></div>
      <div id="message">Loading…</div>
      <form id="password" hidden>
        <label id="passwordLabel" for="passwordInput"></label>
        <input type="password" id="passwordInput">
        <button class="primary">Open</button>
      </form>
    </div>
  </div>
  <svg id="filters" aria-hidden="true">
    <filter id="night" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.574 -1.43 -0.144 0 1  -0.426 -0.43 -0.144 0 1  -0.426 -1.43 0.856 0 1  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="gamma" amplitude="0.8" exponent="0.6" offset="0.1"/>
        <feFuncG type="gamma" amplitude="0.8" exponent="0.6" offset="0.1"/>
        <feFuncB type="gamma" amplitude="0.8" exponent="0.6" offset="0.1"/>
      </feComponentTransfer>
    </filter>
  </svg>
  <script type="module" nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function docxHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, distRoot: vscode.Uri): string {
  const nonce = getNonce();
  const csp = webview.cspSource;
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'docx.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview', 'docx.js'));
  // docx-preview injects the document's styles, fonts and images as inline <style>, blob: and data: resources.
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} blob: data:; font-src blob: data:; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${csp};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <header id="toolbar">
    <div class="group">
      <button id="zoomOut" title="Zoom out">−</button>
      <span id="zoomValue">100%</span>
      <button id="zoomIn" title="Zoom in">+</button>
      <button id="fit" title="Shrink wide pages to the window">Fit width</button>
      <button id="actual" title="Actual size">100%</button>
    </div>
    <span id="info"></span>
    <button id="toMarkdown" title="Save this document as a Markdown file">To Markdown</button>
  </header>
  <div id="document"></div>
  <div id="message">Loading…</div>
  <script type="module" nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
