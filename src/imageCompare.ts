import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { isAnimated } from './animationView';
import { getNonce, parentOf, watchFile } from './util';

// The comparison of two images. It is a webview panel opened by a command, not a custom editor: it belongs to
// two files and to no file type, so it is absent from `contributes.customEditors` and from "Choose File Types…".

const VIEW_TYPE = 'previewix.imageCompare';

/** What can be compared: every raster format the image editor opens. */
const EXTENSIONS = ['png', 'apng', 'jpg', 'jpeg', 'jpe', 'webp', 'bmp', 'avif', 'ico', 'gif', 'heic', 'heif', 'tif', 'tiff', 'psd', 'psb', 'icns'];

const MODES = ['side', 'blink', 'swipe', 'onion', 'diff'];

/** Where the pairs of the open comparisons are kept, so that a tab can be restored after a window reload. */
const STORE = 'previewix.comparisons';
const STORED = 30;

interface Stored {
  id: string;
  a: string;
  b: string;
}

let host: vscode.ExtensionContext;
/** The mode chosen last in any comparison, which the next one starts in. */
let lastMode = 'side';

const baseName = (uri: vscode.Uri) => path.posix.basename(uri.path);
const isImage = (uri: vscode.Uri) => EXTENSIONS.includes(path.posix.extname(uri.path).slice(1).toLowerCase());

// ---- Git ------------------------------------------------------------------

/** The part of the built-in Git extension's API (extensions/git/src/api/git.d.ts) that is used here. */
interface GitRepository {
  state: { onDidChange: vscode.Event<void> };
  /** The content of a file in a commit, as bytes. */
  buffer(ref: string, file: string): Promise<Uint8Array>;
}

interface GitApi {
  state: 'uninitialized' | 'initialized';
  onDidChangeState: vscode.Event<string>;
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

/** The Git extension's API, or nothing when the extension is absent, switched off or broken: every caller copes without. */
async function gitApi(): Promise<GitApi | undefined> {
  try {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api: GitApi = exports.getAPI(1);
    if (api.state === 'uninitialized') {
      // Right after a window reload the repositories are still being found.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 10000);
        const listener = api.onDidChangeState(done);
        function done() {
          clearTimeout(timer);
          listener.dispose();
          resolve();
        }
      });
    }
    return api;
  } catch {
    return undefined;
  }
}

/** A `git:` URI of the Git extension names a file and a version of it in its query, as JSON. */
function gitVersion(uri: vscode.Uri): { path: string; ref: string } | undefined {
  if (uri.scheme !== 'git') {
    return undefined;
  }
  try {
    const query = JSON.parse(uri.query);
    return typeof query.path === 'string' && typeof query.ref === 'string' ? { path: query.path, ref: query.ref } : undefined;
  } catch {
    return undefined;
  }
}

/** The names the Git extension gives the versions that are not commits: "" and "~" are the index, "~1" to "~3" the sides of a merge. */
function refName(ref: string): string {
  if (ref === '' || ref === '~') {
    return 'Index';
  }
  const stage = /^~([123])$/.exec(ref);
  if (stage) {
    return ['Base', 'Ours', 'Theirs'][Number(stage[1]) - 1];
  }
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}

async function readSource(uri: vscode.Uri): Promise<Uint8Array> {
  const version = gitVersion(uri);
  if (version && /^[^~:]/.test(version.ref)) {
    // A commit, a branch or a tag is read through the Git extension's API.
    const repository = (await gitApi())?.getRepository(vscode.Uri.file(version.path));
    if (repository) {
      return repository.buffer(version.ref, version.path);
    }
  }
  // Everything else through its file system; for `git:` that is the Git extension again, which alone knows
  // what its names for the index and the merge stages stand for.
  return vscode.workspace.fs.readFile(uri);
}

// ---- Names ----------------------------------------------------------------

interface Label {
  name: string;
  /** What tells this picture from the other when the names are the same: a version or a folder. */
  detail: string;
  tip: string;
}

function labelsOf(uris: [vscode.Uri, vscode.Uri]): [Label, Label] {
  const sides = uris.map((uri) => {
    const version = gitVersion(uri);
    const file = version ? vscode.Uri.file(version.path) : uri;
    const detail = version ? refName(version.ref) : '';
    const where = file.scheme === 'file' ? file.fsPath : file.toString(true);
    return { version, file, name: baseName(file), detail, tip: detail ? `${where} (${detail})` : where };
  });
  sides.forEach((side, index) => {
    const other = sides[1 - index];
    if (!side.version && side.name === other.name) {
      side.detail = other.version ? 'Working Tree' : vscode.workspace.asRelativePath(parentOf(side.file), true);
    }
  });
  const [a, b] = sides.map(({ name, detail, tip }) => ({ name, detail, tip }));
  return [a, b];
}

const titleOf = ([a, b]: [Label, Label]) => (a.name === b.name ? `${a.name} (${a.detail} ↔ ${b.detail})` : `${a.name} ↔ ${b.name}`);

/** The folder a picture lives in, also for a version of it in Git. */
function folderOf(uri: vscode.Uri): vscode.Uri {
  const version = gitVersion(uri);
  return parentOf(version ? vscode.Uri.file(version.path) : uri);
}

// ---- The view -------------------------------------------------------------

const comparisons = new Set<Comparison>();

class Comparison {
  readonly key: string;
  private readonly labels: [Label, Label];
  /** A fingerprint of what the page was sent for each side, so that a change that changed nothing is not sent again. */
  private readonly sent: (string | undefined)[] = [undefined, undefined];
  private readonly reads = [0, 0];
  private disposed = false;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly id: string,
    private readonly uris: [vscode.Uri, vscode.Uri],
  ) {
    this.key = uris.join(' ');
    this.labels = labelsOf(uris);
    const { webview } = panel;
    const mediaRoot = vscode.Uri.joinPath(host.extensionUri, 'media');
    // The image decoders (dist/webview) and libheif (dist/libheif) are fetched by the page when a file needs them.
    const distRoot = vscode.Uri.joinPath(host.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, distRoot] };
    webview.html = html(webview, mediaRoot, distRoot);
    panel.title = titleOf(this.labels);

    comparisons.add(this);
    const subscription = vscode.Disposable.from(
      webview.onDidReceiveMessage((msg) => this.receive(msg)),
      ...uris.map((uri, index) => this.follow(uri, index)),
    );
    panel.onDidDispose(() => {
      this.disposed = true;
      comparisons.delete(this);
      subscription.dispose();
    });
  }

  /**
   * Keeps one side in step with its source. `followFile()` is made for an editor that shows one file (it covers
   * the page and reopens the editor on a renamed file); here a file that is gone leaves its side with a message
   * and the other picture on screen, and comes back when the file does.
   */
  private follow(uri: vscode.Uri, index: number): vscode.Disposable {
    const version = gitVersion(uri);
    if (!version) {
      return watchFile(uri, () => void this.sendSide(index, false), true);
    }
    // A version in Git changes when the commit or the index does. The repository reports far more than that
    // (every refresh of its status), which is what the fingerprint in `sendSide` is for.
    let listener: vscode.Disposable | undefined;
    let timer: NodeJS.Timeout | undefined;
    void gitApi().then((api) => {
      try {
        const repository = this.disposed ? undefined : api?.getRepository(vscode.Uri.file(version.path));
        listener = repository?.state.onDidChange(() => {
          clearTimeout(timer);
          timer = setTimeout(() => void this.sendSide(index, false), 500);
        });
      } catch {
        // Without the listener the side is read again when the tab is.
      }
    });
    return new vscode.Disposable(() => {
      clearTimeout(timer);
      listener?.dispose();
    });
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private async receive(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'init', id: this.id, mode: lastMode, sides: this.labels });
        await Promise.all([this.sendSide(0, true), this.sendSide(1, true)]);
        break;
      case 'mode':
        if (MODES.includes(String(msg.mode))) {
          lastMode = String(msg.mode);
        }
        break;
      case 'open': {
        const uri = this.uris[msg.index === 1 ? 1 : 0];
        await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: this.panel.viewColumn, preview: false });
        break;
      }
      case 'save':
        await this.save(String(msg.data));
        break;
    }
  }

  /** Reads a side and sends it to the page: the bytes of the file, or the reason there is no picture. */
  private async sendSide(index: number, always: boolean): Promise<void> {
    // A hidden tab has no page: it asks for both sides anew (`ready`) when it comes back.
    if (this.disposed || (!always && !this.panel.visible)) {
      return;
    }
    const uri = this.uris[index];
    const { name, detail } = this.labels[index];
    const version = gitVersion(uri);
    const read = ++this.reads[index];
    let message: { bytes: Uint8Array; size: number; hash: string; animated: boolean } | { error: string };
    try {
      const bytes = await readSource(uri);
      if (version && !bytes.length) {
        // Older versions of the Git extension answer with an empty file instead of an error.
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (/\.svgz?$/i.test(name) || /^(?:\xEF\xBB\xBF)?\s*<(?:\?xml|svg|!DOCTYPE)/i.test(Buffer.from(bytes.subarray(0, 64)).toString('latin1'))) {
        message = { error: `${name} is an SVG picture, and only pixel images can be compared. The SVG preview can export it to PNG.` };
      } else {
        message = { bytes, size: bytes.length, hash: createHash('sha1').update(bytes).digest('hex'), animated: isAnimated(bytes) };
      }
    } catch (e) {
      if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') {
        message = { error: version ? `${name} does not exist in ${detail}.` : `${name} does not exist.` };
      } else if (version) {
        // Git answers a file it does not have with a failed command, which says little: the likely reason is named.
        message = { error: `${name} could not be read from ${detail}. A file that is new there has no such version.` };
      } else {
        message = { error: `Could not read ${name}: ${e instanceof Error ? e.message : e}` };
      }
    }
    // A slow read that finishes after a newer one is dropped.
    const fingerprint = 'error' in message ? message.error : message.hash;
    if (read !== this.reads[index] || (!always && fingerprint === this.sent[index])) {
      return;
    }
    this.sent[index] = fingerprint;
    this.post({ type: 'side', index, ...message });
  }

  private async save(base64: string): Promise<void> {
    const [a, b] = this.labels.map((label) => path.posix.basename(label.name, path.posix.extname(label.name)));
    // Next to the file that is being worked on, which is the second of the two when one of them is history.
    const folder = folderOf(this.uris[gitVersion(this.uris[1]) && !gitVersion(this.uris[0]) ? 0 : 1]);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, a === b ? `${a}-diff.png` : `${a}-${b}-diff.png`),
      filters: { 'PNG image': ['png'] },
      title: 'Save the difference as',
    });
    if (!target) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
      this.post({ type: 'saved', name: baseName(target) });
    } catch (e) {
      vscode.window.showErrorMessage(`Previewix: could not save the difference. ${e instanceof Error ? e.message : e}`);
    }
  }
}

function stored(): Stored[] {
  const list = host.workspaceState.get<Stored[]>(STORE);
  return Array.isArray(list) ? list : [];
}

/** Opens the comparison of two pictures, `a` on the left as the earlier one, or shows the tab that already compares them. */
function openComparison(a: vscode.Uri, b: vscode.Uri): void {
  const key = [a, b].join(' ');
  const open = [...comparisons].find((comparison) => comparison.key === key);
  if (open) {
    open.panel.reveal();
    return;
  }
  // The page keeps only this id in its state. The files behind it stay here, so that a page can never name a file to read.
  const id = randomUUID();
  void host.workspaceState.update(STORE, [...stored(), { id, a: a.toString(), b: b.toString() }].slice(-STORED));
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Compare Images', vscode.ViewColumn.Active);
  new Comparison(panel, id, [a, b]);
}

/** After a window reload VS Code brings the tab back empty, with the state its page had saved. */
function restore(panel: vscode.WebviewPanel, state: unknown): void {
  const id = (state as { id?: unknown } | undefined)?.id;
  const entry = stored().find((item) => item.id === id);
  if (!entry) {
    panel.webview.html = '<!DOCTYPE html><html lang="en"><body><p>This comparison could not be restored. Close the tab and compare the images again.</p></body></html>';
    return;
  }
  new Comparison(panel, entry.id, [vscode.Uri.parse(entry.a, true), vscode.Uri.parse(entry.b, true)]);
}

// ---- The image editor inside a diff editor --------------------------------
//
// A changed image clicked in the Source Control view opens VS Code's diff editor, and so does "Compare Selected"
// in the Explorer: two whole image editors next to each other, one per version. The API has no word for "this
// editor is half of a diff" (the tab's input is unknown there), but it does report both halves as visible in one
// view column at once, which two editors of an ordinary tab group never are. That is what is looked for here.
// Nothing depends on the answer being right: a pair that is not recognised stays two ordinary editors, and a
// page that is told so wrongly only folds its toolbar away behind a button that brings it back.

interface OpenEditor {
  uri: vscode.Uri;
  panel: vscode.WebviewPanel;
  ready: boolean;
  paired: boolean;
}

/** In the order they were opened: a diff editor opens the original first. */
const editors = new Set<OpenEditor>();
let pairing: NodeJS.Timeout | undefined;

/** The other image editor of the diff editor this one sits in, if it sits in one. */
function partnerOf(editor: OpenEditor): OpenEditor | undefined {
  try {
    const { panel } = editor;
    if (!panel.visible || panel.viewColumn === undefined) {
      return undefined;
    }
    const key = editor.uri.toString();
    const others = [...editors].filter(
      (other) => other !== editor && other.panel.visible && other.panel.viewColumn === panel.viewColumn && other.uri.toString() !== key,
    );
    return others.length === 1 ? others[0] : undefined;
  } catch {
    return undefined;
  }
}

function updatePairs(): void {
  // The view states of a tab switch arrive one panel at a time; the answer is taken once they have settled.
  clearTimeout(pairing);
  pairing = setTimeout(() => {
    for (const editor of editors) {
      const paired = !!partnerOf(editor);
      if (paired !== editor.paired) {
        editor.paired = paired;
        if (editor.ready) {
          void editor.panel.webview.postMessage({ type: 'diff', paired });
        }
      }
    }
  }, 250);
}

/** How late a version is, to put the earlier picture first: a commit, then the index, then the file itself. */
function lateness(uri: vscode.Uri): number {
  const version = gitVersion(uri);
  return !version ? 2 : version.ref === '' || version.ref.startsWith('~') ? 1 : 0;
}

/**
 * Called by the image editor for each of its tabs. Tells the page when it shares a diff editor with another
 * image (`diff` `{paired}`), and answers its `compare` message: with the comparison of the two halves of the
 * diff, or else by asking which picture to compare with.
 */
export function joinImageEditor(panel: vscode.WebviewPanel, uri: vscode.Uri): void {
  const editor: OpenEditor = { uri, panel, ready: false, paired: false };
  editors.add(editor);
  panel.onDidChangeViewState(updatePairs);
  panel.onDidDispose(() => {
    editors.delete(editor);
    updatePairs();
  });
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'ready') {
      editor.ready = true;
      void panel.webview.postMessage({ type: 'diff', paired: editor.paired });
    } else if (msg.type === 'compare') {
      void compareWith(uri);
    }
  });
  updatePairs();
}

/** The pictures of the diff editor that shows `uri`, earlier first. */
function diffPair(uri: vscode.Uri): [vscode.Uri, vscode.Uri] | undefined {
  const key = uri.toString();
  for (const editor of editors) {
    const partner = editor.uri.toString() === key ? partnerOf(editor) : undefined;
    if (partner) {
      // Among equals the order of opening decides, which the set has kept.
      const [first, second] = [...editors].filter((item) => item === editor || item === partner).sort((x, y) => lateness(x.uri) - lateness(y.uri));
      return [first.uri, second.uri];
    }
  }
  return undefined;
}

// ---- Commands -------------------------------------------------------------

/** The image in the active tab, for a command that was started from the Command Palette. */
function activeImage(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri = input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
  return uri && isImage(uri) ? uri : undefined;
}

async function pickImage(title: string, near: vscode.Uri | undefined, many = false): Promise<vscode.Uri[]> {
  const picked = await vscode.window.showOpenDialog({
    title,
    openLabel: 'Compare',
    canSelectMany: many,
    defaultUri: near && folderOf(near),
    filters: { Images: EXTENSIONS, 'All files': ['*'] },
  });
  return picked ?? [];
}

/** "Compare with…": asks for the picture to hold against `uri`. */
async function compareWith(uri: vscode.Uri): Promise<void> {
  // In a diff editor the other picture is already on screen.
  const pair = diffPair(uri);
  if (pair) {
    openComparison(pair[0], pair[1]);
    return;
  }
  const version = gitVersion(uri);
  const file = version ? vscode.Uri.file(version.path) : uri;
  const name = baseName(file);
  type Choice = vscode.QuickPickItem & { pair?: [vscode.Uri, vscode.Uri] };
  const choices: Choice[] = [];
  if (version) {
    choices.push({ label: '$(file-media) The file itself', description: 'Working Tree', pair: [uri, file] });
  } else if (uri.scheme === 'file') {
    const api = await gitApi();
    let tracked = false;
    try {
      tracked = !!api?.getRepository(uri);
    } catch {
      // Without Git there is one choice less.
    }
    if (api && tracked) {
      choices.push({ label: '$(git-commit) The committed version', description: 'HEAD', pair: [api.toGitUri(uri, 'HEAD'), uri] });
    }
  }
  // Images that are open in other tabs are the likeliest candidates.
  const seen = new Set([uri.toString(), file.toString()]);
  for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
    const other = tab.input instanceof vscode.TabInputCustom ? tab.input.uri : undefined;
    if (other && isImage(other) && !seen.has(other.toString())) {
      seen.add(other.toString());
      const [, label] = labelsOf([uri, other]);
      choices.push({ label: `$(file-media) ${label.name}`, description: label.detail || vscode.workspace.asRelativePath(folderOf(other), true), pair: [uri, other] });
    }
  }
  let pick: Choice | undefined;
  if (choices.length) {
    choices.push({ label: '$(folder-opened) Choose a file…' });
    pick = await vscode.window.showQuickPick(choices, { placeHolder: `Compare ${name}${version ? ` (${refName(version.ref)})` : ''} with` });
    if (!pick) {
      return;
    }
  }
  if (pick?.pair) {
    openComparison(pick.pair[0], pick.pair[1]);
    return;
  }
  const [other] = await pickImage(`Compare ${name} with`, uri);
  if (other) {
    openComparison(uri, other);
  }
}

/** "Compare Images": two files selected in the Explorer, or whatever leads to two. */
async function compareImages(clicked?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
  const given = (selected?.length ? selected : [clicked]).filter((item): item is vscode.Uri => item instanceof vscode.Uri);
  if (given.length === 2) {
    openComparison(given[0], given[1]);
    return;
  }
  if (given.length > 2) {
    void vscode.window.showInformationMessage('Previewix compares two images at a time: select exactly two.');
    return;
  }
  const first = given[0] ?? activeImage();
  if (first) {
    await compareWith(first);
    return;
  }
  const picked = await pickImage('Choose the two images to compare', undefined, true);
  if (picked.length === 2) {
    openComparison(picked[0], picked[1]);
  } else if (picked.length === 1) {
    await compareWith(picked[0]);
  } else if (picked.length > 2) {
    void vscode.window.showInformationMessage('Previewix compares two images at a time: select exactly two.');
  }
}

/** "Compare with Committed Version": the file as it is in the last commit against the file on disk. */
async function compareWithHead(clicked?: vscode.Uri): Promise<void> {
  const given = clicked instanceof vscode.Uri ? clicked : activeImage();
  // Started on the old half of a diff, it still means the file.
  const version = given && gitVersion(given);
  const uri = version ? vscode.Uri.file(version.path) : given;
  if (!uri) {
    void vscode.window.showInformationMessage('Previewix: open or select an image first.');
    return;
  }
  const api = await gitApi();
  if (!api) {
    void vscode.window.showInformationMessage('Previewix: the built-in Git extension is not available.');
    return;
  }
  let tracked = false;
  try {
    tracked = !!api.getRepository(uri);
  } catch {
    // Reported below.
  }
  if (!tracked) {
    void vscode.window.showInformationMessage(`Previewix: ${baseName(uri)} is not inside a Git repository that is open in this window.`);
    return;
  }
  openComparison(api.toGitUri(uri, 'HEAD'), uri);
}

export function registerImageCompare(context: vscode.ExtensionContext): vscode.Disposable {
  host = context;
  return vscode.Disposable.from(
    vscode.commands.registerCommand('previewix.compareImages', compareImages),
    vscode.commands.registerCommand('previewix.compareImageWith', (uri?: vscode.Uri) => compareImages(uri)),
    vscode.commands.registerCommand('previewix.compareImageWithHead', compareWithHead),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        restore(panel, state);
      },
    }),
  );
}

// ---- The page -------------------------------------------------------------

const icon = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

function html(webview: vscode.Webview, mediaRoot: vscode.Uri, distRoot: vscode.Uri): string {
  const nonce = getNonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'compare.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'compare.js'));
  // Started from a blob by the page, like the decoders: a worker can't be started from the extension's files.
  const worker = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'compareWorker.js'));
  // The decoder is a module, and modules run once the document is parsed: compare.js is deferred, so it still comes after it.
  const decoder = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview', 'imageDecode.js'));
  // The decoders and the comparison worker are fetched (connect-src) and run as workers from blobs; libheif is WebAssembly.
  const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource};`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
</head>
<body data-worker="${worker}">
  <header id="toolbar">
    <div class="group" id="modes">
      <button data-mode="side" title="Both pictures next to each other, zoomed and moved together (S)">Side by side</button>
      <button data-mode="blink" title="One picture in place of the other: Space flips between A and B (B)">Blink</button>
      <button data-mode="swipe" title="A on one side of a divider, B on the other: drag it across (W)">Swipe</button>
      <button data-mode="onion" title="B over A, as see-through as the slider says (O)">Onion skin</button>
      <button data-mode="diff" title="Marks the pixels that differ (D)">Difference</button>
    </div>
    <div class="group" id="blinkOptions" hidden>
      <button id="flip" title="Show the other picture (Space)">A ⇄ B</button>
      <label title="Flips by itself, twice a second"><input type="checkbox" id="auto"> Auto</label>
    </div>
    <div class="group" id="onionOptions" hidden>
      <label title="How much of B covers A">B <input type="range" id="opacity" min="0" max="100" step="1"> <span id="opacityValue"></span></label>
    </div>
    <div class="group">
      <label title="How far the red, green, blue or alpha of a pixel may be from the other picture's (0 to 255) and still count as the same. Raise it until the noise of a re-saved JPEG is gone ( [ and ] )">Tolerance
        <input type="range" id="toleranceRange" min="0" max="64" step="1">
        <input type="number" id="tolerance" min="0" max="255" step="1">
      </label>
    </div>
    <div class="group" id="alignGroup" hidden>
      <label title="Where B lies on A. Alt+arrow keys move B by one pixel, with Shift by ten">Align
        <select id="align">
          <option value="tl">Top left</option>
          <option value="tr">Top right</option>
          <option value="c">Center</option>
          <option value="bl">Bottom left</option>
          <option value="br">Bottom right</option>
          <option value="custom" hidden>Moved</option>
          <option value="scale">B scaled to the size of A</option>
        </select>
      </label>
    </div>
    <div class="group">
      <button class="icon" id="zoomFit" title="Fit to window (0)">${icon('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>')}</button>
      <button id="zoomActual" title="Actual size (1)">1:1</button>
    </div>
    <div class="group right">
      <button class="icon" id="frame" title="Frame the area that changed (F)">${icon('<path class="dash" d="M4 4h16v16H4z"/><path class="solid" d="M10 10h4v4h-4z"/>')}</button>
      <button class="icon" id="jump" title="Go to the area that changed (J)">${icon('<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>')}</button>
      <button class="icon" id="swap" title="Swap A and B (X)">${icon('<path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/>')}</button>
      <button id="save" class="primary" title="Save the difference picture as PNG (Ctrl/Cmd+S)">Save difference…</button>
    </div>
  </header>

  <section id="facts">
    <div class="fact" id="factA"><b class="badge a">A</b><button class="link" title=""></button><span class="detail"></span><span class="props"></span></div>
    <div class="fact" id="factB"><b class="badge b">B</b><button class="link" title=""></button><span class="detail"></span><span class="props"></span></div>
    <div class="fact" id="result"></div>
    <div class="fact" id="alignNote" hidden></div>
  </section>

  <div id="stage">
    <canvas id="view"></canvas>
    <div class="tag a" id="tagA" hidden></div>
    <div class="tag b" id="tagB" hidden></div>
    <div class="note" id="noteA" hidden></div>
    <div class="note" id="noteB" hidden></div>
    <div id="divider" hidden title="Drag to uncover the other picture"><i></i></div>
    <div id="message">Loading…</div>
  </div>

  <footer id="status">
    <span id="statZoom"></span>
    <span id="statCursor"></span>
    <span class="statColor" id="statA" hidden><b>A</b><i></i><span></span></span>
    <span class="statColor" id="statB" hidden><b>B</b><i></i><span></span></span>
    <span id="statDelta"></span>
    <span id="toast"></span>
  </footer>
  <script type="module" nonce="${nonce}" src="${decoder}"></script>
  <script defer nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
