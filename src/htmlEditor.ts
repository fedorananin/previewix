import * as path from 'path';
import * as vscode from 'vscode';
import { introduceHtml } from './associations';
import { decodeHtml, pagePolicy, preparePage } from './htmlPage';
import { followFile, getNonce, missingAssets, parentOf } from './util';

/** The whole text goes to the page in one message and is parsed there in one go. */
const MAX_BYTES = 32 * 1024 * 1024;
/** How many of the files a page loaded are watched, and in how many folders. */
const MAX_WATCHED = { files: 400, folders: 30 };

/** Rendered view of an HTML file: the page as a browser shows it, with the files next to it. */
export class HtmlEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.html';
  private static readonly scriptsKey = 'html.scripts';
  /** The open previews, which all follow the "Scripts" switch. */
  private readonly open = new Set<() => void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const { uri } = document;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const folder = parentOf(uri);
    // The page names its styles, scripts and pictures by relative path and loads them itself. The workspace
    // folder is a root as well, for a page that reaches them through `../`.
    const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri;
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, folder, ...(workspace ? [workspace] : [])] };
    webview.html = this.html(webview, mediaRoot);
    introduceHtml(this.context);

    const name = path.posix.basename(uri.path);
    const key = uri.toString();
    const own = webview.asWebviewUri(uri).toString();
    const origin = new URL(own).origin;
    let latest = 0;

    /** The file behind an address of the page, which names files only that way. Undefined for an address elsewhere. */
    const fileOf = (href: unknown): vscode.Uri | undefined => {
      try {
        const url = new URL(String(href));
        // The origin stands for the scheme and the authority of the file system, so only the path is left to take over.
        return url.origin === origin ? uri.with({ path: decodeURIComponent(url.pathname), query: '', fragment: '' }) : undefined;
      } catch {
        return undefined;
      }
    };

    const send = async (force = false) => {
      const mine = ++latest;
      try {
        // Unsaved edits in a text editor win over the file; a clean document may lag behind the disk.
        const edited = vscode.workspace.textDocuments.find((doc) => doc.isDirty && doc.uri.toString() === key);
        let text: string;
        let size: number;
        if (edited) {
          text = edited.getText();
          size = Buffer.byteLength(text);
        } else {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_BYTES) {
            if (mine === latest) {
              webview.postMessage({
                type: 'error',
                message: `This file is ${(stat.size / 1024 / 1024).toFixed(0)} MB. Previewix renders HTML files of up to ${MAX_BYTES / 1024 / 1024} MB.`,
              });
            }
            return;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          text = decodeHtml(bytes);
          size = bytes.byteLength;
        }
        // A slower, older read must not overwrite a newer one.
        if (mine !== latest) {
          return;
        }
        const scripts = this.context.globalState.get(HtmlEditorProvider.scriptsKey, true);
        webview.postMessage({
          type: 'page',
          name,
          size,
          unsaved: !!edited,
          empty: !text.trim(),
          scripts,
          // A page whose text is the one on screen is left alone, unless a file it loads has changed.
          force,
          html: preparePage(text, {
            policy: pagePolicy(webview.cspSource, scripts),
            folder: `${webview.asWebviewUri(folder).toString().replace(/\/$/, '')}/`,
            source: webview.cspSource,
          }),
          own,
          // The default browser can be handed a file only on the machine it runs on.
          browser: uri.scheme === 'file' && !vscode.env.remoteName,
        });
      } catch (e) {
        if (mine === latest) {
          webview.postMessage({ type: 'error', message: `Could not read the file: ${e instanceof Error ? e.message : e}` });
        }
      }
    };

    let timer: NodeJS.Timeout | undefined;
    let forced = false;
    const sendSoon = (force = false) => {
      forced ||= force;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void send(forced);
        forced = false;
      }, 300);
    };

    // The styles, scripts and pictures the page loaded. A change to one of them shows as a change to the file does.
    let used = new Set<string>();
    let watched = '';
    let watchers: vscode.Disposable[] = [];
    const watchResources = (urls: unknown) => {
      const files = (Array.isArray(urls) ? urls : [])
        .slice(0, MAX_WATCHED.files)
        .map(fileOf)
        .filter((file): file is vscode.Uri => !!file && file.toString() !== key);
      used = new Set(files.map((file) => file.toString()));
      const folders = [...new Set(files.map((file) => parentOf(file).toString()))].sort().slice(0, MAX_WATCHED.folders);
      if (folders.join('\n') === watched) {
        return;
      }
      watched = folders.join('\n');
      watchers.forEach((watcher) => watcher.dispose());
      // One watcher per folder rather than per file: a page with a hundred pictures usually keeps them in two or three.
      watchers = folders.map((each) => {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(each), '*'));
        const changed = (file: vscode.Uri) => {
          if (used.has(file.toString())) {
            sendSoon(true);
          }
        };
        watcher.onDidChange(changed);
        watcher.onDidCreate(changed);
        watcher.onDidDelete(changed);
        return watcher;
      });
    };

    const follow = async (href: unknown) => {
      let target = fileOf(href);
      if (!target) {
        if (/^(https?|mailto|tel):/i.test(String(href))) {
          await vscode.env.openExternal(vscode.Uri.parse(String(href)));
        }
        return;
      }
      const typeOf = (file: vscode.Uri) =>
        vscode.workspace.fs.stat(file).then(
          (stat) => stat.type,
          () => undefined,
        );
      let type = await typeOf(target);
      // A link to a folder means its index page, as on a web server.
      if (type !== undefined && type & vscode.FileType.Directory) {
        target = vscode.Uri.joinPath(target, 'index.html');
        type = await typeOf(target);
      }
      if (type === undefined) {
        webview.postMessage({ type: 'note', text: `${path.posix.basename(target.path)} was not found` });
        return;
      }
      // In the editor VS Code has for the file: another page opens as a preview, a picture in its viewer.
      await vscode.commands.executeCommand('vscode.open', target, { viewColumn: panel.viewColumn });
    };

    const refresh = () => void send();
    this.open.add(refresh);
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
      followFile(panel, uri, HtmlEditorProvider.viewType, { onChange: () => void send() }),
    ];
    panel.onDidDispose(() => {
      clearTimeout(timer);
      this.open.delete(refresh);
      subscriptions.forEach((subscription) => subscription.dispose());
      watchers.forEach((watcher) => watcher.dispose());
    });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await send();
          break;
        case 'openSource':
          // In the preview's own editor group, or next to it so that the preview follows the typing.
          await vscode.commands.executeCommand('vscode.openWith', uri, 'default', msg.beside ? vscode.ViewColumn.Beside : panel.viewColumn);
          break;
        case 'openBrowser':
          await vscode.env.openExternal(uri);
          break;
        case 'scripts':
          await this.context.globalState.update(HtmlEditorProvider.scriptsKey, !!msg.on);
          this.open.forEach((each) => each());
          break;
        case 'link':
          await follow(msg.href);
          break;
        case 'resources':
          watchResources(msg.urls);
          break;
      }
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'html.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'html.js'));
    // This is the policy of the toolbar around the page, not of the page, which is written into a frame with
    // a policy of its own (`pagePolicy()`). `frame-src 'self'` is that frame, and it is also what keeps the
    // page in it: a page that tries to go to another address is stopped here, and html.js says where it went.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
      <button id="reload" title="Load the page again">Reload</button>
    </div>
    <div class="group">
      <label title="The width the page is laid out at. A width that doesn't fit the tab is shown scaled down">Width
        <select id="width">
          <option value="fit">Window</option>
          <option value="390">Phone · 390</option>
          <option value="768">Tablet · 768</option>
          <option value="1280">Laptop · 1280</option>
          <option value="1920">Desktop · 1920</option>
        </select>
      </label>
    </div>
    <div class="group">
      <label title="Run the scripts of the page. The choice applies to every HTML preview"><input type="checkbox" id="scripts"> Scripts</label>
    </div>
    <div class="group right">
      <button id="openBrowser" hidden title="Open the file in the default browser">Open in browser</button>
    </div>
  </header>

  <div id="stage">
    <div id="sheet"></div>
    <pre id="error" hidden></pre>
    <div id="message">Loading…</div>
  </div>

  <footer id="status">
    <span id="statInfo"></span>
    <span id="statView"></span>
    <span id="toast"></span>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
