import * as path from 'path';
import * as vscode from 'vscode';
import { textDecoder } from './textDecoding';
import { followFile, getNonce, missingAssets, parentOf } from './util';

/** Decodes an SVG file the way an XML parser would: by its byte order mark, then by its XML declaration, else as UTF-8. */
function decodeXml(bytes: Uint8Array): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
  } else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    const declared = /^<\?xml[^>]*\sencoding\s*=\s*["']([\w.:-]+)["']/.exec(Buffer.from(bytes.subarray(0, 200)).toString('latin1'));
    // A UTF-16 file without a byte order mark wouldn't have a readable declaration in the first place.
    if (declared && !/^utf-?16/i.test(declared[1])) {
      encoding = declared[1];
    }
  }
  try {
    return textDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export class SvgEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.svg';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    // The file itself is never loaded by URL, so its folder is not a resource root.
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webview.html = this.html(webview, mediaRoot);

    const name = path.posix.basename(document.uri.path);
    const key = document.uri.toString();
    /** What the page shows, which is also what "Copy SVG" copies. */
    let shown = '';
    let latest = 0;

    const send = async () => {
      const mine = ++latest;
      try {
        // Unsaved edits in a text editor win over the file; a clean document may lag behind the disk.
        const open = vscode.workspace.textDocuments.find((doc) => doc.isDirty && doc.uri.toString() === key);
        let text: string;
        let size: number;
        if (open) {
          text = open.getText();
          size = Buffer.byteLength(text);
        } else {
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          text = decodeXml(bytes);
          size = bytes.byteLength;
        }
        // A slower, older read must not overwrite a newer one.
        if (mine === latest) {
          shown = text;
          webview.postMessage({ type: 'svg', name, text, size, unsaved: !!open });
        }
      } catch (e) {
        if (mine === latest) {
          webview.postMessage({ type: 'error', message: `Could not read the file: ${e instanceof Error ? e.message : e}` });
        }
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const sendSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void send(), 150);
    };
    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === key) {
          sendSoon();
        }
      }),
      // Closing a text editor without saving throws its edits away, and the file is the truth again.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.toString() === key) {
          sendSoon();
        }
      }),
      followFile(panel, document.uri, SvgEditorProvider.viewType, { onChange: () => void send() }),
    ];
    panel.onDidDispose(() => {
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
    });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await send();
          break;
        case 'openSource':
          // In the preview's own editor group, or next to it so that the preview follows the typing.
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', msg.beside ? vscode.ViewColumn.Beside : panel.viewColumn);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(shown);
          webview.postMessage({ type: 'copied' });
          break;
        case 'save':
          await this.save(document.uri, String(msg.data), webview);
          break;
      }
    });
  }

  private async save(source: vscode.Uri, base64: string, webview: vscode.Webview): Promise<void> {
    const stem = path.posix.basename(source.path, path.posix.extname(source.path));
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(parentOf(source), `${stem}.png`),
      filters: { 'PNG image': ['png'] },
      title: 'Export PNG',
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

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'svg.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'svg.js'));
    // The policy allows the page's own stylesheets and scripts and nothing else but `data:` images, which is
    // how the SVG reaches its <img>. Shown as an image, an SVG runs no scripts and loads no outside files;
    // should that ever fail, `default-src 'none'` still leaves it nothing to connect to.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <header id="toolbar">
    <div class="group">
      <button id="openSource" title="Open the file in the text editor. Alt+click opens it to the side, and the preview follows what you type">Open source</button>
    </div>
    <div class="group">
      <label title="What is shown behind the picture">Background
        <select id="background">
          <option value="checker">Checkerboard</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </div>
    <div class="group">
      <button id="zoomFit" title="Fit to window (0)">Fit</button>
      <button id="zoomActual" title="Actual size (1)">100%</button>
    </div>
    <div class="group right">
      <button id="copy" title="Copy the SVG source to the clipboard">Copy SVG</button>
      <button id="exportToggle" class="primary" title="Export (Ctrl/Cmd+S)">Export PNG…</button>
    </div>
  </header>

  <div id="exportPanel" hidden>
    <div class="group" id="scales">
      <button data-scale="1">1×</button>
      <button data-scale="2">2×</button>
      <button data-scale="4">4×</button>
    </div>
    <label>Width <input type="number" id="outWidth" min="1" step="1"> px</label>
    <span id="outSize"></span>
    <button id="save" class="primary">Save as…</button>
  </div>

  <div id="stage">
    <div id="sheet" hidden></div>
    <pre id="error" hidden></pre>
    <div id="message">Loading…</div>
  </div>

  <footer id="status">
    <span id="statInfo"></span>
    <span id="statZoom"></span>
    <span id="toast"></span>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
