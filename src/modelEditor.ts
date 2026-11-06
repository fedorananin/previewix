import * as path from 'path';
import * as vscode from 'vscode';
import { followFile, getNonce, missingAssets, parentOf } from './util';

/**
 * The page holds the whole file in memory while it parses it, next to the geometry it builds from it.
 * Measured: a binary STL of 477 MB (ten million triangles) takes about 1.1 GB in the page and 0.7 GB on the GPU.
 * Text costs far more, because every line and number passes through the JavaScript heap: an OBJ of 144 MB
 * (four million triangles) peaks at 2.1 GB, which is as far as that heap can be trusted to stretch.
 */
const MAX_BYTES = { binary: 512 * 1024 * 1024, text: 128 * 1024 * 1024 };

/** Formats that are always text. STL and PLY come both ways, and their text flavour is told from the content. */
const TEXT = new Set(['gltf', 'obj']);

const icon = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** 3D model viewer (three.js) for glTF, GLB, STL, OBJ and PLY. */
export class ModelEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.model';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const { uri } = document;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    // A .gltf or an .mtl names its buffers and textures by relative path, so the page loads them itself.
    // The workspace folder is a root as well, for a model that keeps its textures in a folder next to its own.
    const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, distRoot, parentOf(uri), ...(workspace ? [workspace] : [])],
    };

    const name = path.posix.basename(uri.path);
    const ext = path.posix.extname(uri.path).slice(1).toLowerCase();
    webview.html = this.html(webview, mediaRoot, distRoot, TEXT.has(ext));

    const sendSource = async (reload: boolean) => {
      try {
        const { size } = await vscode.workspace.fs.stat(uri);
        const limit = TEXT.has(ext) ? MAX_BYTES.text : MAX_BYTES.binary;
        if (size > limit) {
          webview.postMessage({
            type: 'error',
            message: `This file is ${formatSize(size)}. Previewix opens ${TEXT.has(ext) ? `.${ext} files` : 'models'} of up to ${formatSize(limit)}.`,
          });
          return;
        }
        webview.postMessage({
          type: 'source',
          src: webview.asWebviewUri(uri).toString(),
          // Added to the model and to everything it refers to, so that a rewritten file isn't served from the cache.
          stamp: reload ? Date.now() : 0,
          name,
          ext,
          size,
          textLimit: MAX_BYTES.text,
        });
      } catch (e) {
        webview.postMessage({ type: 'error', message: `Could not read the file: ${e instanceof Error ? e.message : e}` });
      }
    };
    followFile(panel, uri, ModelEditorProvider.viewType, { onChange: () => void sendSource(true) });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await sendSource(false);
          break;
        case 'openSource':
          // In the viewer's own editor group, or next to it.
          await vscode.commands.executeCommand('vscode.openWith', uri, 'default', msg.beside ? vscode.ViewColumn.Beside : panel.viewColumn);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(String(msg.text));
          vscode.window.setStatusBarMessage('Previewix: model info copied', 2500);
          break;
        case 'save':
          await this.save(uri, String(msg.data), webview);
          break;
      }
    });
  }

  private async save(source: vscode.Uri, base64: string, webview: vscode.Webview): Promise<void> {
    const stem = path.posix.basename(source.path, path.posix.extname(source.path));
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(parentOf(source), `${stem}.png`),
      filters: { 'PNG image': ['png'] },
      title: 'Save view as PNG',
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

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri, distRoot: vscode.Uri, text: boolean): string {
    const nonce = getNonce();
    const csp = webview.cspSource;
    const assets = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'model')).toString() + '/';
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'model.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview', 'model.js'));
    // What the policy opens, and for what:
    //   connect-src   the model, its buffers and textures (glTF textures are fetched and decoded as bitmaps), the
    //                 Draco decoder; blob: and data: for the images and buffers embedded in a glTF
    //   img-src       textures of an .mtl, which are loaded through <img>
    //   wasm-unsafe-eval, worker-src blob:   the Draco and meshopt decoders are WebAssembly, and the Draco one
    //                 runs in workers that three.js starts from a blob
    // Nothing outside the webview's own origin can be reached, so a model can't make the page call a server.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src ${csp}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${csp} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body data-assets="${assets}">
  <header id="toolbar">
    ${text ? '<div class="group"><button id="openSource" title="Open the file in the text editor. Alt+click opens it to the side">Open source</button></div>' : ''}
    <div class="group">
      <button class="icon" id="reset" title="Reset the view (0)">${icon('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>')}</button>
      <button id="viewFront" title="Front view (1). Shift+click for the back">Front</button>
      <button id="viewSide" title="Side view from the right (2). Shift+click for the left">Side</button>
      <button id="viewTop" title="Top view (3). Shift+click for the bottom">Top</button>
    </div>
    <div class="group">
      <button class="icon" id="wireframe" title="Wireframe (W)">${icon('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>')}</button>
      <button class="icon" id="grid" title="Grid on the ground (G)">${icon('<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>')}</button>
      <button class="icon" id="axes" title="Axes at the origin: X red, Y green, Z blue (A)">${icon('<path d="M12 13V3M12 13l8.5 5M12 13l-8.5 5"/><path d="M9.5 5.5L12 3l2.5 2.5"/>')}</button>
    </div>
    <div class="group">
      <label title="Which axis of the file points up. Y unless chosen otherwise, and Z for STL">Up
        <select id="up">
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      </label>
      <label title="What is shown behind the model, and in a saved PNG. A checkerboard is saved as transparency">Background
        <select id="background">
          <option value="editor">Editor</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="checker">Checkerboard</option>
        </select>
      </label>
    </div>
    <div class="group right">
      <button class="icon" id="infoToggle" title="Model details (I)" aria-expanded="false">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.5"/>')}</button>
      <button id="exportToggle" class="primary" title="Save the current view as a picture (Ctrl/Cmd+S)">Save PNG…</button>
    </div>
  </header>

  <div id="exportPanel" hidden>
    <div class="group" id="scales">
      <button data-scale="1">1×</button>
      <button data-scale="2">2×</button>
      <button data-scale="4">4×</button>
    </div>
    <span id="outSize"></span>
    <button id="save" class="primary">Save as…</button>
  </div>

  <div id="main">
    <div id="stage">
      <canvas id="view"></canvas>
      <div id="notice" hidden>
        <span id="noticeText"></span>
        <button id="noticeClose" title="Hide" aria-label="Hide">${icon('<path d="M5 5l14 14M19 5L5 19"/>')}</button>
      </div>
      <div class="group" id="player" hidden>
        <button class="icon" id="play" title="Play or pause the animation (Space)">${icon('<path class="solid play" d="M7 4.5v15l12-7.5z"/><path class="solid pause" d="M6 4.5h4v15H6zM14 4.5h4v15h-4z"/>')}</button>
        <select id="clip" title="Animation"></select>
        <input type="range" id="seek" min="0" max="1" step="any" value="0" title="Position in the animation">
        <span id="time"></span>
      </div>
      <pre id="error" hidden></pre>
      <div id="message">Loading…</div>
    </div>
    <aside id="info">
      <div id="infoHeader">
        <strong>Model details</strong>
        <span class="spacer"></span>
        <button id="copyInfo" title="Copy all as text">Copy</button>
        <button id="closeInfo" title="Close (I)" aria-label="Close">${icon('<path d="M5 5l14 14M19 5L5 19"/>')}</button>
      </div>
      <div id="sections"><p class="muted">Reading…</p></div>
    </aside>
  </div>

  <footer id="status">
    <span id="statInfo"></span>
    <span id="statSize"></span>
    <span id="statGrid"></span>
    <span id="toast"></span>
  </footer>
  <script type="module" nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
