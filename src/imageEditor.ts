import * as path from 'path';
import * as vscode from 'vscode';
import { isAnimated, resolveAnimation } from './animationView';
import { joinImageEditor } from './imageCompare';
import { readImageMeta } from './imageMeta';
import { followFile, getNonce, missingAssets, parentOf } from './util';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  gif: 'image/gif',
};

const FILTERS: Record<string, { [name: string]: string[] }> = {
  png: { 'PNG image': ['png'] },
  jpg: { 'JPEG image': ['jpg', 'jpeg'] },
  webp: { 'WebP image': ['webp'] },
};

/** What "previous / next image" steps through: every picture Previewix opens, whichever of its editors takes it. */
const BROWSABLE = new Set(['png', 'jpg', 'jpeg', 'jpe', 'webp', 'bmp', 'avif', 'ico', 'gif', 'svg', 'heic', 'heif', 'tif', 'tiff', 'psd', 'psb', 'icns']);

// "img2" before "img10", and upper case next to lower case, the way file managers list a folder.
const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const extensionOf = (name: string) => path.posix.extname(name).slice(1).toLowerCase();

/** The images in the folder of `uri`, in browsing order. Read anew every time, since files come and go. */
async function listImages(uri: vscode.Uri): Promise<string[]> {
  const entries = await vscode.workspace.fs.readDirectory(parentOf(uri));
  return entries
    .filter(([name, type]) => (type & vscode.FileType.File) !== 0 && BROWSABLE.has(extensionOf(name)))
    .map(([name]) => name)
    .sort((a, b) => naturalOrder.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

const icon = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export class ImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.image';

  /** Shared by all image tabs, so the panel stays open while the user flips through a folder. */
  private infoOpen = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    // An animation would be flattened to one frame by the editor, so it gets the player instead.
    // Only the content tells: most .png and .webp files are still images.
    if (/\.(gif|png|apng|webp)$/i.test(document.uri.path)) {
      const bytes = await vscode.workspace.fs.readFile(document.uri).then(
        (b) => b,
        () => undefined,
      );
      if (bytes && isAnimated(bytes)) {
        resolveAnimation(this.context, document, panel, ImageEditorProvider.viewType);
        return;
      }
    }
    this.showEditor(document, panel);
  }

  private showEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    // The decoders (dist/webview) and libheif (dist/libheif) are fetched by the page when a file needs them.
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, distRoot] };
    webview.html = this.html(webview, mediaRoot, distRoot);

    const name = path.posix.basename(document.uri.path);
    const ext = extensionOf(name);
    // Kept here rather than taken from the page, so the link can only ever open the file's own place.
    let gps: { lat: number; lon: number } | undefined;
    let navigating = false;

    // The bytes are sent over instead of loading the file by URL: a cross-origin
    // image would taint the canvas and make exporting impossible.
    const sendImage = async () => {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(document.uri);
        webview.postMessage({ type: 'init', name, ext, mime: MIME[ext] ?? '', bytes, infoOpen: this.infoOpen });
      } catch (e) {
        webview.postMessage({ type: 'error', message: `Could not read the file: ${e instanceof Error ? e.message : e}` });
        return;
      }
      try {
        const meta = await readImageMeta(bytes);
        gps = meta.gps;
        webview.postMessage({ type: 'meta', sections: meta.sections, hasPlace: !!gps });
      } catch (e) {
        webview.postMessage({ type: 'meta', sections: [{ title: 'File', rows: [['Error', String(e)]] }], hasPlace: false });
      }
    };

    const sendFolder = async () => {
      try {
        const names = await listImages(document.uri);
        webview.postMessage({ type: 'folder', index: names.indexOf(name), count: names.length });
      } catch {
        // A folder that can't be listed leaves the page without the counter.
        webview.postMessage({ type: 'folder', index: -1, count: 0 });
      }
    };

    followFile(panel, document.uri, ImageEditorProvider.viewType, { onChange: () => webview.postMessage({ type: 'changed' }) });
    // The way to the comparison of two images, and a quieter toolbar when this editor is one half of a diff editor.
    joinImageEditor(panel, document.uri);

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          void sendFolder();
          await sendImage();
          break;
        case 'save':
          await this.save(document.uri, msg.ext, msg.data, webview);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(String(msg.text));
          vscode.window.setStatusBarMessage(`Previewix: ${msg.what === 'color' ? 'color' : 'image info'} copied`, 2500);
          break;
        case 'infoOpen':
          this.infoOpen = !!msg.open;
          break;
        case 'page': {
          // Sent only with unexported edits: another size or page replaces the picture, and a webview can't ask.
          const leave = await vscode.window.showWarningMessage(
            `Show another picture of ${name}?`,
            { modal: true, detail: 'The edits made to this picture have not been exported and will be lost.' },
            'Discard Edits',
          );
          if (leave === 'Discard Edits') {
            webview.postMessage({ type: 'page', index: Number(msg.index) });
          }
          break;
        }
        case 'openMap':
          if (gps) {
            const at = `${gps.lat.toFixed(6)}/${gps.lon.toFixed(6)}`;
            await vscode.env.openExternal(
              vscode.Uri.parse(`https://www.openstreetmap.org/?mlat=${gps.lat.toFixed(6)}&mlon=${gps.lon.toFixed(6)}#map=16/${at}`),
            );
          }
          break;
        case 'navigate':
          // Key repeat would otherwise queue a move for every event while the first is still opening.
          if (!navigating) {
            navigating = true;
            try {
              await this.navigate(panel, document.uri, msg.delta < 0 ? -1 : 1, !!msg.dirty);
            } finally {
              navigating = false;
            }
            void sendFolder();
          }
          break;
      }
    });
  }

  /** Opens the previous or next image of the folder in place of this tab. */
  private async navigate(panel: vscode.WebviewPanel, uri: vscode.Uri, delta: 1 | -1, dirty: boolean): Promise<void> {
    const name = path.posix.basename(uri.path);
    let names: string[];
    try {
      names = await listImages(uri);
    } catch {
      return;
    }
    let index = names.indexOf(name);
    if (index < 0) {
      // The file itself is gone: step from the place it would have had in the list.
      index = names.findIndex((other) => naturalOrder.compare(other, name) > 0);
      index = index < 0 ? names.length : index;
      names.splice(index, 0, name);
    }
    if (names.length < 2) {
      return;
    }
    const target = names[(index + delta + names.length) % names.length];
    if (dirty) {
      const leave = await vscode.window.showWarningMessage(
        `Leave ${name}?`,
        { modal: true, detail: 'The edits made to this image have not been exported and will be lost.' },
        'Discard Edits',
      );
      if (leave !== 'Discard Edits') {
        return;
      }
    }
    // A preview tab (italic title) is reused by VS Code itself; a pinned one is replaced by hand,
    // so flipping through a folder never piles up tabs.
    const key = uri.toString();
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((t) => t.group.viewColumn === panel.viewColumn && t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === key);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(parentOf(uri), target), {
      viewColumn: panel.viewColumn,
      preview: tab?.isPreview ?? false,
    });
    panel.dispose();
  }

  private async save(source: vscode.Uri, ext: string, base64: string, webview: vscode.Webview): Promise<void> {
    if (!FILTERS[ext]) {
      return;
    }
    const stem = path.posix.basename(source.path, path.posix.extname(source.path));
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(parentOf(source), `${stem}-edited.${ext}`),
      filters: FILTERS[ext],
      title: 'Save image as',
    });
    if (!target) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
      webview.postMessage({ type: 'saved', name: path.posix.basename(target.path) });
    } catch (e) {
      vscode.window.showErrorMessage(`Previewix: could not save the image. ${e instanceof Error ? e.message : e}`);
    }
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri, distRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'image.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'image.js'));
    // The decoder is a module, and modules run once the document is parsed: image.js is deferred, so it still comes after it.
    const decoder = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview', 'imageDecode.js'));
    // The decoders are fetched (connect-src) and run as workers from blobs; libheif is WebAssembly.
    const csp = `default-src 'none'; img-src blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource};`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <header id="toolbar">
    <div class="group" id="browse">
      <button class="icon" id="prev" title="Previous image in the folder (←)">${icon('<path d="M15 5l-7 7 7 7"/>')}</button>
      <span id="position" title="Position among the images of this folder"></span>
      <button class="icon" id="next" title="Next image in the folder (→)">${icon('<path d="M9 5l7 7-7 7"/>')}</button>
    </div>
    <div class="group" id="pagesGroup" hidden>
      <select id="pages" title="The pictures in this file (Page Up / Page Down)"></select>
    </div>
    <div class="group" id="tools">
      <button class="icon" data-tool="select" title="Select / move / pan (V)">${icon('<path d="M6 3l12 9-5.5 1L10 19z"/>')}</button>
      <button class="icon" data-tool="crop" title="Crop (C)">${icon('<path d="M7 2v15h15M2 7h15v15"/>')}</button>
      <span class="sep"></span>
      <button class="icon" data-tool="arrow" title="Arrow (A)">${icon('<path d="M5 19L19 5M10 5h9v9"/>')}</button>
      <button class="icon" data-tool="rect" title="Rectangle (R)">${icon('<rect x="3.5" y="6" width="17" height="12" rx="1"/>')}</button>
      <button class="icon" data-tool="ellipse" title="Ellipse (E)">${icon('<ellipse cx="12" cy="12" rx="9" ry="6.5"/>')}</button>
      <button class="icon" data-tool="marker" title="Highlighter (H)">${icon('<path d="M14.5 4l5.5 5.5-8 8H7.5L6 16v-3.5z"/><path class="soft" d="M3 21h18"/>')}</button>
      <button class="icon" data-tool="text" title="Text (T)">${icon('<path d="M5 7V5h14v2M12 5v14M9 19h6"/>')}</button>
      <span class="sep"></span>
      <button class="icon" data-tool="blur" title="Blur an area (B)">${icon('<path d="M12 3c4 4.5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6.5 6-11z"/>')}</button>
      <button class="icon" data-tool="pixelate" title="Pixelate an area (P)">${icon('<path class="solid" d="M4 4h5v5H4zM14 4h6v5h-6zM9 9h5v6H9zM4 15h5v5H4zM14 15h6v5h-6z"/>')}</button>
      <button class="icon" data-tool="picker" title="Pick a color from the image (D)">${icon('<path d="M13.5 6.5l4 4M15 5a2.1 2.1 0 0 1 4 4l-2.5 2.5-4-4zM13 9l-8 8-1 3 3-1 8-8"/>')}</button>
    </div>
    <div class="group" id="colorGroup">
      <label title="Color of annotations"><input type="color" id="color" value="#ff3b30"></label>
    </div>
    <div class="group" id="transforms">
      <button class="icon" id="rotateLeft" title="Rotate 90° left (Shift+L)">${icon('<path d="M4 4v5h5"/><path d="M4.6 9A8 8 0 1 1 4 12.5"/>')}</button>
      <button class="icon" id="rotateRight" title="Rotate 90° right (Shift+R)">${icon('<path d="M20 4v5h-5"/><path d="M19.4 9A8 8 0 1 0 20 12.5"/>')}</button>
      <button class="icon" id="flipH" title="Flip horizontally (Shift+H)">${icon('<path class="dash" d="M12 3v18"/><path d="M8.5 7v10H3zM15.5 7v10H21z"/>')}</button>
      <button class="icon" id="flipV" title="Flip vertically (Shift+V)">${icon('<path class="dash" d="M3 12h18"/><path d="M7 8.5h10V3zM7 15.5h10V21z"/>')}</button>
    </div>
    <div class="group" id="history">
      <button class="icon" id="undo" title="Undo (Ctrl/Cmd+Z)">${icon('<path d="M8 5L4 9l4 4"/><path d="M4 9h10a5 5 0 0 1 0 10h-4"/>')}</button>
      <button class="icon" id="redo" title="Redo (Ctrl/Cmd+Shift+Z)">${icon('<path d="M16 5l4 4-4 4"/><path d="M20 9H10a5 5 0 0 0 0 10h4"/>')}</button>
    </div>
    <div class="group">
      <button class="icon" id="zoomFit" title="Fit to window (0)">${icon('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>')}</button>
      <button id="zoomActual" title="Actual size (1)">1:1</button>
    </div>
    <div class="group right">
      <button id="diffCompare" class="primary" title="Open both pictures of this diff in the comparison view: blink, swipe, onion skin and the pixels that differ">Compare</button>
      <button id="diffTools" title="Show the editing tools">Tools</button>
      <button class="icon" id="compare" title="Compare with another image…">${icon('<rect x="3" y="5" width="7.5" height="14" rx="1"/><rect class="dash" x="13.5" y="5" width="7.5" height="14" rx="1"/>')}</button>
      <button class="icon" id="infoToggle" title="Image info and metadata (I)" aria-expanded="false">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.5"/>')}</button>
      <button class="icon" id="copyImage" title="Copy image to clipboard">${icon('<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/>')}</button>
      <button id="exportToggle" class="primary" title="Save in another format or size (Ctrl/Cmd+S)">Export…</button>
    </div>
  </header>

  <section id="exportPanel" hidden>
    <label>Format
      <select id="format">
        <option value="png">PNG</option>
        <option value="jpg">JPEG</option>
        <option value="webp">WebP</option>
      </select>
    </label>
    <label id="qualityRow">Quality <input type="range" id="quality" min="1" max="100" value="90"> <span id="qualityValue">90</span></label>
    <div class="sizeRow">
      <label>Width <input type="number" id="outWidth" min="1" max="32767"></label>
      <label>Height <input type="number" id="outHeight" min="1" max="32767"></label>
    </div>
    <label><input type="checkbox" id="lockAspect" checked> Keep aspect ratio</label>
    <div class="sizeRow">
      <button data-scale="0.25">25%</button><button data-scale="0.5">50%</button><button data-scale="1">100%</button><button data-scale="2">200%</button>
    </div>
    <button id="save" class="primary">Save as…</button>
  </section>

  <div id="main">
    <div id="stage">
      <canvas id="view"></canvas>
      <textarea id="textInput" hidden spellcheck="false"></textarea>
      <div class="group floatBar" id="toolOptions" hidden>
        <label id="lineRow" title="Line width, px">Line <input type="number" id="lineWidth" min="1" max="200" step="1"></label>
        <label id="fontRow" title="Font size, px">Font <input type="number" id="fontSize" min="6" max="1000" step="1"></label>
        <label id="outlineRow" title="Contrast outline around text"><input type="checkbox" id="outline" checked> Outline</label>
        <label id="strengthRow" title="How coarse the blur or the pixels are">Strength <input type="range" id="strength" min="1" max="5" step="1" value="3"> <span id="strengthValue"></span></label>
      </div>
      <div class="group floatBar" id="cropActions" hidden>
        <label title="Keep the crop frame at a fixed aspect ratio">Ratio
          <select id="cropRatio">
            <option value="free">Free</option>
            <option value="original">Original</option>
            <option value="1:1">1:1 (square)</option>
            <optgroup label="Landscape">
              <option value="5:4">5:4</option>
              <option value="4:3">4:3</option>
              <option value="3:2">3:2</option>
              <option value="16:9">16:9</option>
              <option value="21:9">21:9</option>
            </optgroup>
            <optgroup label="Portrait">
              <option value="4:5">4:5</option>
              <option value="3:4">3:4</option>
              <option value="2:3">2:3</option>
              <option value="9:16">9:16</option>
            </optgroup>
            <option value="custom">Custom…</option>
          </select>
        </label>
        <span id="cropCustom" hidden>
          <input type="number" id="cropRatioW" min="0.01" step="any" value="1" title="Width part of the ratio">
          :
          <input type="number" id="cropRatioH" min="0.01" step="any" value="1" title="Height part of the ratio">
        </span>
        <button id="cropApply" class="primary" title="Apply crop (Enter)">Apply crop</button>
        <button id="cropCancel" title="Cancel crop (Esc)">Cancel</button>
      </div>
      <div id="message">Loading…</div>
    </div>
    <aside id="info">
      <div id="infoHeader">
        <strong>Image info</strong>
        <span class="spacer"></span>
        <button id="copyInfo" title="Copy all as text">Copy</button>
        <button id="closeInfo" title="Close (I)" aria-label="Close">${icon('<path d="M5 5l14 14M19 5L5 19"/>')}</button>
      </div>
      <div id="sections"><p class="muted">Reading…</p></div>
      <button id="openMap" class="link" hidden title="Opens the coordinates in OpenStreetMap">Show on a map ↗</button>
      <p class="muted" id="metaNote">Exported and copied images don't carry this metadata: only the pixels are written.</p>
    </aside>
  </div>

  <footer id="status">
    <span id="statSize"></span>
    <span id="statZoom"></span>
    <span id="statCursor"></span>
    <span id="statColor" hidden><i id="statSwatch"></i><span id="statColorText"></span></span>
    <span id="statShape"></span>
    <span id="toast"></span>
  </footer>
  <script type="module" nonce="${nonce}" src="${decoder}"></script>
  <script defer nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
