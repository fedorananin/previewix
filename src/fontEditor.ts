import * as path from 'path';
import * as vscode from 'vscode';
import { faceBytes, parseFont } from './fontInfo';
import { followFile, getNonce, missingAssets } from './util';

/** Above this size a font isn't handed to the webview: the message channel copies it several times over. */
const MAX_FONT_BYTES = 64 * 1024 * 1024;

/** Font specimen: sample text, variable axes, OpenType features, the character set and the font's details. */
export class FontEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.font';

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

    /** The file as it was last read; faces are cut out of it on request. */
    let data: Buffer | undefined;

    const sendFont = async () => {
      try {
        data = Buffer.from(await vscode.workspace.fs.readFile(uri));
        webview.postMessage({ type: 'init', name: path.posix.basename(uri.path), size: data.length, ...parseFont(data) });
      } catch (e) {
        data = undefined;
        webview.postMessage({ type: 'error', message: `Could not read the font: ${e instanceof Error ? e.message : e}` });
      }
    };

    followFile(panel, uri, FontEditorProvider.viewType, { onChange: () => void sendFont() });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await sendFont();
          break;
        case 'face':
          // The bytes are sent over instead of a URL: a face of a collection isn't a file the webview could load.
          if (data) {
            try {
              const bytes = faceBytes(data, msg.index);
              webview.postMessage({ type: 'font', index: msg.index, bytes: bytes.length <= MAX_FONT_BYTES ? bytes : undefined });
            } catch {
              webview.postMessage({ type: 'font', index: msg.index });
            }
          }
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage(`Previewix: ${msg.what} copied`, 2500);
          break;
      }
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'font.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'font.js'));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <main id="page">
    <section id="head">
      <h1 id="family">Loading…</h1>
      <div id="subtitle"></div>
      <div id="summary"></div>
      <label id="faceRow" hidden>Font in this collection <select id="face"></select></label>
      <p id="notice" hidden></p>
    </section>

    <section id="sampleBox">
      <div class="sectionHead">
        <h2>Sample</h2>
        <select id="preset" title="Sample text"></select>
        <label title="Font size, px">Size <input type="range" id="size" min="8" max="240" step="1"> <span id="sizeValue"></span></label>
      </div>
      <div id="sample" class="specimen" contenteditable="plaintext-only" spellcheck="false" title="Click to type your own text"></div>
    </section>

    <section id="axesBox" hidden>
      <div class="sectionHead">
        <h2>Variable axes</h2>
        <select id="instance" title="Named instances of the font"></select>
        <button id="axesReset">Reset</button>
      </div>
      <div id="axes"></div>
    </section>

    <section id="featuresBox" hidden>
      <div class="sectionHead">
        <h2>OpenType features</h2>
        <button id="featuresReset">Reset</button>
      </div>
      <div id="features"></div>
    </section>

    <section id="waterfallBox">
      <div class="sectionHead"><h2>Sizes</h2></div>
      <div id="waterfall"></div>
    </section>

    <section id="glyphsBox">
      <div class="sectionHead">
        <h2 id="glyphsTitle">Characters</h2>
        <select id="block" title="Unicode block"></select>
      </div>
      <div id="glyphDetail" hidden>
        <div id="glyphBig" class="specimen"></div>
        <div id="glyphText">
          <div id="glyphCode"></div>
          <div id="glyphBlock"></div>
          <div id="glyphEntity"></div>
          <div class="buttons">
            <button id="copyChar">Copy character</button>
            <button id="copyCode">Copy code point</button>
          </div>
        </div>
      </div>
      <div id="glyphs" class="specimen"></div>
      <button id="glyphsMore" hidden>Show more</button>
    </section>

    <section id="cssBox">
      <div class="sectionHead">
        <h2>CSS</h2>
        <button id="copyCss" title="Copy the @font-face rule and the usage example">Copy</button>
      </div>
      <pre id="css"></pre>
    </section>

    <details id="infoBox">
      <summary>Font details</summary>
      <button id="copy" title="Copy all as text">Copy</button>
      <div id="sections"></div>
    </details>
  </main>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
