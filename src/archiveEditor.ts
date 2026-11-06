import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExtractSummary, Listing, PasswordError, ZipSummary, countExisting, createZip, extractEntries, extractFile, freeName, listArchive, maybeWrongPassword, safeSegments } from './archive';
import { followFile, getNonce, missingAssets, parentOf } from './util';

/** Opening a file unpacks it to a temporary folder first; above this size the user is asked. */
const OPEN_CONFIRM_BYTES = 100 * 1024 * 1024;

const KINDS = { file: 0, dir: 1, link: 2 };

let session: Promise<string> | undefined;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The folder for the files opened from archives in this session. Global storage is shared by all
 * VS Code windows, so each extension host has a folder named after its process, and the first use
 * removes the folders whose process is gone: what a crash or a closed window left behind.
 */
function sessionFolder(context: vscode.ExtensionContext): Promise<string> {
  return (session ??= (async () => {
    const root = path.join(context.globalStorageUri.fsPath, 'archive');
    await fs.promises.mkdir(root, { recursive: true });
    for (const name of await fs.promises.readdir(root)) {
      const pid = parseInt(name, 10);
      // A folder with this process's number was left by an earlier process that had the same one.
      if (!(pid > 0) || pid === process.pid || !alive(pid)) {
        await fs.promises.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const folder = path.join(root, `${process.pid}-${Date.now().toString(36)}`);
    await fs.promises.mkdir(folder, { recursive: true });
    return folder;
  })());
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${unit && bytes < 100 ? bytes.toFixed(1) : Math.round(bytes)} ${units[unit]}`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

function messageOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
}

const REVEAL = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Reveal in File Explorer' : 'Open Containing Folder';

/** Browser for ZIP, 7z, RAR and tar archives: a tree of the content, opening single files, extraction. */
export class ArchiveEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.archive';
  private panels = 0;

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
    const file = uri.fsPath;
    const panelId = ++this.panels;
    let disposed = false;
    /** The listing the page shows; the indexes it sends refer to this one. */
    let listing: Listing | undefined;
    /** Counts the reads, so that a slow one that was overtaken is dropped. */
    let generation = 0;
    /** This panel's folder of opened files, made on first use. */
    let folder: Promise<string> | undefined;
    /** Entry index -> the temporary file it was unpacked to, for the current listing. */
    let opened = new Map<number, string>();
    let opens = 0;
    let lastTarget: vscode.Uri | undefined;
    /** What the user typed for this archive. It lives in this tab's memory only and goes with the tab. */
    let password: string | undefined;
    /** The read in progress, which a newer one or the closing of the tab cancels. */
    let reading: AbortController | undefined;
    let asking = false;
    let askedOnOpen = false;

    const post = (read: Listing) =>
      webview.postMessage({
        type: 'listing',
        name,
        format: read.format,
        fileSize: read.fileSize,
        warning: read.warning,
        locked: !!read.locked,
        // One short array per entry: 50,000 objects with named fields would triple the message.
        entries: read.entries.map((e) => [e.path, KINDS[e.kind], e.size, e.packed ?? -1, e.mtime ?? 0, e.blocked ?? '', e.link ?? '', e.encrypted ? 1 : 0]),
      });

    /** Reads the archive and shows it. Returns whether the list of files turned out to need a password that isn't known. */
    const load = async (): Promise<boolean> => {
      const mine = ++generation;
      if (uri.scheme !== 'file') {
        webview.postMessage({ type: 'error', name, message: 'Archives can only be opened from this computer.' });
        return false;
      }
      reading?.abort();
      const abort = (reading = new AbortController());
      try {
        const read = await listArchive(file, { password, signal: abort.signal });
        if (disposed || mine !== generation) {
          return false;
        }
        listing = read;
        opened = new Map();
        post(read);
      } catch (e) {
        if (disposed || mine !== generation) {
          return false;
        }
        listing = undefined;
        if (e instanceof PasswordError) {
          // A password that no longer fits (the file was replaced) isn't worth keeping.
          password = undefined;
          webview.postMessage({ type: 'locked', name });
          return true;
        }
        webview.postMessage({ type: 'error', name, message: `${messageOf(e)}.` });
      }
      return false;
    };

    const ask = (what: string, wrong: boolean) =>
      vscode.window.showInputBox({
        title: `Password for "${name}"`,
        prompt: wrong ? `This password doesn't open ${what}. Try another one.` : `${what[0].toUpperCase()}${what.slice(1)} is protected with a password.`,
        password: true,
        ignoreFocusOut: true,
      });

    /** For an archive whose list of files is encrypted: asks until the list can be read or the user gives up. */
    const unlock = async () => {
      if (asking) {
        return;
      }
      asking = true;
      try {
        for (let wrong = false; ; wrong = true) {
          const typed = await ask('this archive', wrong);
          if (typed === undefined || disposed) {
            return;
          }
          password = typed;
          if (!(await load())) {
            return;
          }
        }
      } finally {
        asking = false;
      }
    };

    /**
     * Runs `action` with the password of this tab. When the archive says that one is missing or
     * wrong, the user is asked and the action runs again. Returns undefined when the user gives up.
     */
    const withPassword = async <T>(what: string, action: (password: string | undefined) => Thenable<T>): Promise<{ value: T } | undefined> => {
      for (;;) {
        try {
          return { value: await action(password) };
        } catch (e) {
          if (!(e instanceof PasswordError)) {
            throw e;
          }
          const typed = await ask(what, e.wrong);
          if (typed === undefined || disposed) {
            return undefined;
          }
          password = typed;
        }
      }
    };

    const open = async (index: number) => {
      const current = listing;
      const entry = current?.entries[index];
      if (!current || !entry || entry.kind !== 'file') {
        return;
      }
      const entryName = path.posix.basename(entry.path);
      if (entry.blocked) {
        void vscode.window.showWarningMessage(`"${entryName}" can't be opened. ${entry.blocked}.`);
        return;
      }
      let target = opened.get(index);
      if (!target) {
        if (entry.size > OPEN_CONFIRM_BYTES) {
          const answer = await vscode.window.showWarningMessage(
            `"${entryName}" is ${formatSize(entry.size)} unpacked.`,
            { modal: true, detail: 'To open it, Previewix unpacks it to a temporary folder, which is removed when this tab closes.' },
            'Unpack and Open',
          );
          if (!answer || disposed) {
            return;
          }
        }
        folder ??= sessionFolder(this.context).then((root) => path.join(root, String(panelId)));
        // A folder per opened file keeps the entry's own name, which is what picks the editor, without clashes between folders of the archive.
        const dir = path.join(await folder, String(++opens));
        const safeName = safeSegments(entryName)?.[0] ?? 'file';
        const unpacked = path.join(dir, safeName);
        try {
          await fs.promises.mkdir(dir, { recursive: true });
          const done = await withPassword(`"${entryName}"`, (secret) =>
            vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Unpacking ${entryName}…` }, () => extractFile(file, current, index, unpacked, { password: secret })),
          );
          if (!done) {
            return;
          }
          // Edits to a temporary copy would be lost, so VS Code is told not to allow them.
          await fs.promises.chmod(unpacked, 0o444).catch(() => undefined);
        } catch (e) {
          if (maybeWrongPassword(e)) {
            // Some formats can't tell a wrong password from damaged data, so the way to another password stays open.
            const again = await vscode.window.showErrorMessage(`Could not unpack "${entryName}". ${messageOf(e)}.`, 'Try Another Password');
            if (again && !disposed) {
              password = undefined;
              await open(index);
            }
            return;
          }
          void vscode.window.showErrorMessage(`Could not unpack "${entryName}". ${messageOf(e)}.`);
          return;
        }
        if (disposed) {
          return;
        }
        if (listing === current) {
          opened.set(index, unpacked);
        }
        target = unpacked;
      }
      // Not as a preview tab: this tab is often one itself, and the opened file would take its place.
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), { viewColumn: panel.viewColumn, preview: false });
    };

    /** Extracts everything, or with `selected` the entry or folder at that path, placed under its own name. */
    const extract = async (selected: string | undefined) => {
      const current = listing;
      if (!current) {
        return;
      }
      const indexes: number[] = [];
      current.entries.forEach((e, i) => {
        if (selected === undefined || e.path === selected || e.path.startsWith(`${selected}/`)) {
          indexes.push(i);
        }
      });
      if (!indexes.length) {
        return;
      }
      const what = selected === undefined ? name : path.posix.basename(selected);
      const strip = selected === undefined ? 0 : selected.lastIndexOf('/') + 1;
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: lastTarget ?? parentOf(uri),
        openLabel: 'Extract Here',
        title: `Extract "${what}" to…`,
      });
      if (!picked?.length) {
        return;
      }
      lastTarget = picked[0];
      const target = picked[0].fsPath;
      const targetName = path.basename(target) || target;

      let overwrite = false;
      const existing = await countExisting(current, indexes, target, strip);
      if (existing) {
        const answer = await vscode.window.showWarningMessage(
          `${plural(existing, 'file')} from "${what}" already ${existing === 1 ? 'exists' : 'exist'} in "${targetName}".`,
          { modal: true, detail: 'Replace them with the files from the archive, or keep them and extract only the rest?' },
          'Replace',
          'Keep Existing',
        );
        if (!answer) {
          return;
        }
        overwrite = answer === 'Replace';
      }

      let summary: ExtractSummary;
      try {
        // A wrong password shows before anything is written, so asking again starts a clean run.
        const done = await withPassword(`"${what}"`, (secret) =>
          vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Extracting "${what}"`, cancellable: true }, (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            let reported = 0;
            let last = 0;
            return extractEntries(file, current, indexes, target, {
              strip,
              overwrite,
              password: secret,
              signal: abort.signal,
              onProgress: (done, total, entryPath) => {
                const now = Date.now();
                if (now - last < 100) {
                  return;
                }
                last = now;
                const percent = total ? (done / total) * 100 : 0;
                progress.report({ increment: percent - reported, message: path.posix.basename(entryPath) });
                reported = percent;
              },
            });
          }),
        );
        if (!done) {
          return;
        }
        summary = done.value;
      } catch (e) {
        void vscode.window.showErrorMessage(`Extraction stopped. ${messageOf(e)}.`);
        return;
      }

      const parts = [`${summary.cancelled ? 'Extraction cancelled:' : 'Extracted'} ${plural(summary.files, 'file')} ${summary.cancelled ? 'written ' : ''}to "${targetName}"`];
      if (summary.skipped) {
        parts.push(`${plural(summary.skipped, 'existing file')} kept`);
      }
      if (summary.links) {
        parts.push(`${plural(summary.links, 'link')} left out`);
      }
      let text = `${parts.join(', ')}.`;
      const failures = summary.failed.length;
      if (failures) {
        const first = summary.failed[0];
        text += ` ${failures.toLocaleString('en-US')} ${failures === 1 ? 'entry' : 'entries'} could not be extracted: "${first.path}" (${first.reason})${failures > 1 ? ' and others' : ''}.`;
      }
      const show = summary.failed.length || summary.cancelled ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      // The extracted item itself is selected in the file manager when it is a single one; otherwise the folder is.
      const top = selected === undefined ? undefined : safeSegments(what)?.[0];
      const reveal = top && fs.existsSync(path.join(target, top)) ? vscode.Uri.file(path.join(target, top)) : picked[0];
      void show(text, REVEAL).then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('revealFileInOS', reveal);
        }
      });
    };

    followFile(panel, uri, ArchiveEditorProvider.viewType, { onChange: () => void load() });

    panel.onDidDispose(() => {
      disposed = true;
      password = undefined;
      reading?.abort();
      void folder?.then((dir) => fs.promises.rm(dir, { recursive: true, force: true })).catch(() => undefined);
    });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          // A tab that comes back from the background builds its page anew. The listing is still good
          // (a change on disk replaces it), and reading a large tar.gz again would take a while.
          if (listing) {
            post(listing);
          } else if ((await load()) && panel.active && !askedOnOpen) {
            // Asked right away once, for the tab the user has just opened; a tab that comes back later shows a button instead.
            askedOnOpen = true;
            await unlock();
          }
          break;
        case 'unlock':
          await unlock();
          break;
        case 'open':
          await open(msg.index);
          break;
        case 'extract':
          await extract(typeof msg.path === 'string' ? msg.path : undefined);
          break;
      }
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'archive.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'archive.js'));
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
  <header id="head">
    <div id="titleRow">
      <h1 id="name"></h1>
      <div id="summary"></div>
    </div>
    <div id="toolbar">
      <input type="search" id="filter" placeholder="Filter by name…" title="Show the files and folders whose name contains this text. With a slash, the whole path is searched" spellcheck="false">
      <span id="matches"></span>
      <button id="extractSelected" disabled title="Extract the selected file or folder">Extract selected…</button>
      <button id="extractAll" class="primary" disabled title="Extract the whole archive into a folder">Extract all…</button>
    </div>
    <p id="note" hidden></p>
  </header>

  <div id="columns">
    <span>Name</span>
    <span class="num">Size</span>
    <span class="num">Packed</span>
    <span>Modified</span>
  </div>
  <div id="tree" tabindex="0" role="tree" aria-label="Archive content">
    <div id="spacer"><div id="rows"></div></div>
  </div>
  <div id="message">Loading…</div>
  <div id="locked" hidden>
    <p>The names of the files in this archive are encrypted.</p>
    <button id="unlock" class="primary">Enter Password…</button>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function zipResult(summary: ZipSummary): string {
  const parts = [plural(summary.files, 'file')];
  if (summary.folders) {
    parts.push(plural(summary.folders, 'folder'));
  }
  if (summary.links) {
    parts.push(`${plural(summary.links, 'link')} (stored as ${summary.links === 1 ? 'a link' : 'links'})`);
  }
  let text = `Compressed ${parts.join(', ')} into "${path.basename(summary.target as string)}": ${formatSize(summary.bytes)} packed to ${formatSize(summary.size)}.`;
  const skipped = summary.skipped.length;
  if (skipped) {
    const first = summary.skipped[0];
    text += ` ${skipped.toLocaleString('en-US')} ${skipped === 1 ? 'item was' : 'items were'} left out: "${first.path}" (${first.reason})${skipped > 1 ? ' and others' : ''}.`;
  }
  return text;
}

/**
 * "Compress to ZIP" in the Explorer's context menu. VS Code passes the item that was clicked and,
 * when several are selected, all of them. The archive is written next to the clicked item.
 */
export async function compressToZip(clicked?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
  const picked = selected?.length ? selected : clicked ? [clicked] : [];
  const uris = picked.filter((uri) => uri.scheme === 'file');
  if (!uris.length) {
    void vscode.window.showInformationMessage(picked.length ? 'Compress to ZIP works for files on this computer.' : 'Select files or folders in the Explorer, then choose "Compress to ZIP" from their context menu.');
    return;
  }
  const paths = uris.map((uri) => uri.fsPath);
  const anchor = clicked?.scheme === 'file' ? clicked.fsPath : paths[0];
  // One item gives the archive its name, as Finder does; several get a neutral one.
  const target = await freeName(path.dirname(anchor), paths.length === 1 ? path.basename(anchor) : 'Archive', '.zip');
  const targetName = path.basename(target);

  let summary: ZipSummary;
  try {
    summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Compressing to "${targetName}"`, cancellable: true }, (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      let reported = 0;
      let last = 0;
      return createZip(paths, target, {
        signal: abort.signal,
        onProgress: (done, total, itemName) => {
          const now = Date.now();
          if (now - last < 100) {
            return;
          }
          last = now;
          const percent = total ? (done / total) * 100 : 0;
          progress.report({ increment: percent - reported, message: path.posix.basename(itemName) });
          reported = percent;
        },
      });
    });
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not compress to "${targetName}". ${reasonOfWrite(e)}.`);
    return;
  }
  if (summary.cancelled) {
    return;
  }
  if (!summary.target) {
    const first = summary.skipped[0];
    void vscode.window.showWarningMessage(first ? `Nothing was compressed: "${first.path}" could not be read (${first.reason}).` : 'Nothing was compressed.');
    return;
  }
  const result = vscode.Uri.file(summary.target);
  const show = summary.skipped.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  void show(zipResult(summary), REVEAL).then((choice) => {
    if (choice) {
      void vscode.commands.executeCommand('revealFileInOS', result);
    }
  });
}

function reasonOfWrite(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'The disk is full';
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'No permission to write in this folder';
  }
  return messageOf(e);
}
