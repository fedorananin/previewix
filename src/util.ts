import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

export function parentOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

/** Fires `callback` when the file behind `uri` changes on disk, and with `includeDeletes` also when it disappears. */
export function watchFile(uri: vscode.Uri, callback: () => void, includeDeletes = false): vscode.Disposable {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parentOf(uri), name));
  let timer: NodeJS.Timeout | undefined;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(callback, 300);
  };
  watcher.onDidChange(debounced);
  watcher.onDidCreate(debounced);
  if (includeDeletes) {
    watcher.onDidDelete(debounced);
  }
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    watcher.dispose();
  });
}

/** What stays the same when a file is renamed: its device and inode. */
async function identityOf(file: string): Promise<string> {
  const stat = await fs.promises.stat(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

/** Looks through the folder of a vanished file for the same file under a new name. */
async function findRenamed(uri: vscode.Uri, identity: string): Promise<vscode.Uri | undefined> {
  const folder = path.dirname(uri.fsPath);
  const entries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && (await identityOf(path.join(folder, entry.name)).catch(() => '')) === identity) {
      return vscode.Uri.file(path.join(folder, entry.name));
    }
  }
  return undefined;
}

export interface FollowOptions {
  /** Called when the file's content changed on disk, or when the file came back after being gone. */
  onChange?: () => void;
  /** Returns true while the editor holds unsaved content that must stay reachable, which rules out both the placeholder and the move. */
  keep?: () => boolean;
}

/**
 * Keeps a custom editor in step with its file. A change on disk is passed on to `onChange`.
 * When the file is renamed outside VS Code, the editor is reopened on the new name (VS Code does
 * this itself for a rename in the Explorer). When it is deleted, the page is told to cover itself
 * with a placeholder (`missing`, see media/missing.js) until the file reappears (`restored`).
 */
export function followFile(panel: vscode.WebviewPanel, uri: vscode.Uri, viewType: string, options: FollowOptions = {}): vscode.Disposable {
  const { webview } = panel;
  const local = uri.scheme === 'file';
  let identity: string | undefined;
  let missing = false;
  let disposed = false;
  let moving = false;

  const check = async (changed: boolean) => {
    const exists = await vscode.workspace.fs.stat(uri).then(
      () => true,
      () => false,
    );
    if (exists) {
      if (local) {
        // A file that was replaced rather than rewritten has a new identity.
        identity = await identityOf(uri.fsPath).catch(() => identity);
      }
      if (disposed) {
        return;
      }
      if (missing) {
        missing = false;
        webview.postMessage({ type: 'restored' });
        options.onChange?.();
      } else if (changed) {
        options.onChange?.();
      }
      return;
    }
    if (options.keep?.()) {
      return;
    }
    const renamed = local && identity ? await findRenamed(uri, identity) : undefined;
    if (disposed || moving) {
      return;
    }
    // A tab in the background isn't pulled to the front: it moves over once the user comes back to it.
    if (renamed && panel.visible) {
      moving = true;
      await vscode.commands.executeCommand('vscode.openWith', renamed, viewType, {
        viewColumn: panel.viewColumn,
        preserveFocus: !panel.active,
        preview: false,
      });
      panel.dispose();
      return;
    }
    missing = true;
    webview.postMessage({ type: 'missing', name: path.posix.basename(uri.path) });
  };

  const watcher = watchFile(uri, () => void check(true), true);
  // A page that was rebuilt (a tab that came back from the background) has lost its placeholder.
  const messages = webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'ready') {
      void check(false);
    }
  });
  const visibility = panel.onDidChangeViewState(() => {
    if (panel.visible && missing) {
      void check(false);
    }
  });
  const subscription = vscode.Disposable.from(watcher, messages, visibility, { dispose: () => (disposed = true) });
  panel.onDidDispose(() => subscription.dispose());
  return subscription;
}

/** The stylesheet and script of the "file no longer exists" placeholder, for the `<head>` of a page that uses `followFile`. */
export function missingAssets(webview: vscode.Webview, mediaRoot: vscode.Uri, nonce: string): string {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'missing.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'missing.js'));
  return `<link rel="stylesheet" href="${css}"><script nonce="${nonce}" src="${js}"></script>`;
}
