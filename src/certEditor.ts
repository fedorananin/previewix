import * as path from 'path';
import * as vscode from 'vscode';
import { MAX_BYTES, parseCertFile } from './certInfo';
import { followFile, getNonce, missingAssets } from './util';

/** Certificates, certificate requests and keys in PEM or DER, described instead of shown as Base64. */
export class CertEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.cert';

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

    const name = path.posix.basename(uri.path);
    let latest = 0;

    // The file's bytes stay on this side. The page gets the description that parseCertFile() makes of them,
    // which holds nothing of a private key and none of the text around the blocks.
    const send = async () => {
      const mine = ++latest;
      try {
        const { size } = await vscode.workspace.fs.stat(uri);
        if (size > MAX_BYTES) {
          webview.postMessage({ type: 'file', name, size, format: '', text: true, blocks: [], notes: [], message: 'This file is too large to be a certificate file.' });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        // A slower, older read must not overwrite a newer one.
        if (mine === latest) {
          webview.postMessage({ type: 'file', name, size: bytes.byteLength, ...parseCertFile(bytes) });
        }
      } catch (e) {
        if (mine === latest) {
          webview.postMessage({ type: 'error', name, message: `Could not read the file: ${e instanceof Error ? e.message : e}` });
        }
      }
    };

    followFile(panel, uri, CertEditorProvider.viewType, { onChange: () => void send() });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await send();
          break;
        case 'openSource':
          await vscode.commands.executeCommand('vscode.openWith', uri, 'default', msg.beside ? vscode.ViewColumn.Beside : panel.viewColumn);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(String(msg.text));
          vscode.window.setStatusBarMessage(`Previewix: ${msg.what} copied`, 2500);
          break;
      }
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cert.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'cert.js'));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <main id="page">
    <header id="head">
      <div id="titleRow">
        <h1 id="name">Loading…</h1>
        <div class="buttons">
          <button id="openSource" hidden title="Open the file in the text editor. Alt+click opens it to the side">Open source</button>
          <button id="copyReport" hidden title="Copy everything on this page as text">Copy report</button>
        </div>
      </div>
      <div id="summary"></div>
    </header>
    <p id="message" hidden></p>
    <div id="notes"></div>
    <section id="chain" hidden>
      <p id="chainText"></p>
      <div id="tree"></div>
    </section>
    <div id="tools" hidden>
      <input type="search" id="filter" placeholder="Filter by name, issuer, fingerprint…" spellcheck="false">
      <span id="matches"></span>
      <button id="expandAll">Expand all</button>
      <button id="collapseAll">Collapse all</button>
    </div>
    <div id="blocks"></div>
  </main>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
