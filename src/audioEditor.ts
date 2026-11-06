import * as path from 'path';
import * as vscode from 'vscode';
import { findFfmpeg } from './ffmpeg';
import { analyze } from './mediaInfo';
import { imageMime, readPeaks, readTagReport, saveTags, type CoverChange } from './tags';
import { followFile, getNonce, missingAssets, parentOf } from './util';

const WAVEFORM_BUCKETS = 1200;

/** Audio player with a waveform, stream details, and an editor for the file's tags and cover art. */
export class AudioEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.audio';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const { uri } = document;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, parentOf(uri)] };
    webview.html = this.html(webview, mediaRoot);

    const local = uri.scheme === 'file';
    const ffmpeg = () => findFfmpeg(vscode.workspace.getConfiguration('previewix').get<string>('ffmpegPath') ?? '');
    const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

    /** Cover image picked in the dialog, written into the file on the next save. */
    let pickedCover: string | undefined;
    /** Background ffmpeg work (the waveform) to stop when the file changes or the tab closes. */
    let jobs = new AbortController();
    /** Set around our own save, whose file change shouldn't be treated as an external edit. */
    let saving = false;

    const sendSource = (reload: boolean) => {
      // The cache-busting query makes the webview pick up a file that was rewritten on disk.
      const src = webview.asWebviewUri(uri).toString() + (reload ? `?t=${Date.now()}` : '');
      webview.postMessage({ type: 'source', src, name: path.posix.basename(uri.path) });
    };

    const sendInfo = async () => {
      try {
        const report = await analyze(uri, this.context.extensionPath);
        webview.postMessage({ type: 'info', ...report });
      } catch (e) {
        webview.postMessage({ type: 'info', summary: '', sections: [{ title: 'File', rows: [['Error', message(e)]] }] });
      }
    };

    const sendTags = async () => {
      if (!local) {
        webview.postMessage({ type: 'tags', note: 'Tags are only available for files on this computer.' });
        return;
      }
      try {
        const { cover, ...report } = await readTagReport(uri.fsPath, await ffmpeg());
        webview.postMessage({ type: 'tags', ...report, cover: cover && { mime: imageMime(cover), bytes: cover } });
      } catch (e) {
        webview.postMessage({ type: 'tags', note: `The tags could not be read: ${message(e)}` });
      }
    };

    const sendPeaks = async () => {
      const tool = local ? await ffmpeg() : undefined;
      if (!tool) {
        return;
      }
      const { signal } = jobs;
      try {
        const peaks = await readPeaks(tool, uri.fsPath, WAVEFORM_BUCKETS, signal);
        if (!signal.aborted) {
          webview.postMessage({ type: 'peaks', peaks });
        }
      } catch {
        // The waveform is a nicety; the player works without it.
      }
    };

    const pickCover = async () => {
      const [picked] = (await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: parentOf(uri),
        filters: { Images: ['jpg', 'jpeg', 'png'] },
        title: 'Choose a cover image',
      })) ?? [];
      if (picked) {
        pickedCover = picked.fsPath;
        const bytes = await vscode.workspace.fs.readFile(picked);
        webview.postMessage({ type: 'coverPicked', cover: { mime: imageMime(bytes), bytes } });
      }
    };

    const save = async (msg: { fields: Record<string, string>; cover: 'keep' | 'remove' | 'replace' }) => {
      const cover: CoverChange =
        msg.cover === 'replace' && pickedCover ? { action: 'replace', path: pickedCover } : { action: msg.cover === 'remove' ? 'remove' : 'keep' };
      saving = true;
      try {
        await saveTags(uri.fsPath, msg.fields as Parameters<typeof saveTags>[1], cover, await ffmpeg());
        pickedCover = undefined;
        // The file was replaced, so the player has to reopen it; the audio itself is unchanged.
        sendSource(true);
        await Promise.all([sendTags(), sendInfo()]);
        webview.postMessage({ type: 'saved' });
      } catch (e) {
        webview.postMessage({ type: 'saveError', message: message(e) });
      } finally {
        // The watcher reports our own write a moment later.
        setTimeout(() => (saving = false), 1000);
      }
    };

    const loadAll = (reload: boolean) => {
      jobs.abort();
      jobs = new AbortController();
      sendSource(reload);
      void sendInfo();
      void sendTags();
      void sendPeaks();
    };

    followFile(panel, uri, AudioEditorProvider.viewType, {
      onChange: () => {
        if (!saving) {
          loadAll(true);
        }
      },
      // Our own save swaps the file, which leaves a moment without it.
      keep: () => saving,
    });
    panel.onDidDispose(() => jobs.abort());

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          loadAll(false);
          break;
        case 'pickCover':
          await pickCover();
          break;
        case 'save':
          await save(msg);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('Previewix: media info copied', 2500);
          break;
      }
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'audio.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'audio.js'));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; media-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <main id="page">
    <section id="head">
      <div id="cover"><img id="coverImage" alt="Cover" hidden><span id="coverEmpty">♪</span></div>
      <div id="headText">
        <h1 id="title"></h1>
        <div id="subtitle"></div>
        <div id="summary"></div>
      </div>
    </section>

    <section id="player">
      <canvas id="wave" hidden title="Click or drag to seek"></canvas>
      <audio id="audio" controls controlslist="nodownload noplaybackrate" preload="metadata"></audio>
      <div id="bar">
        <label>Speed
          <select id="speed">
            <option>0.5</option><option>0.75</option><option selected>1</option>
            <option>1.25</option><option>1.5</option><option>2</option>
          </select>
        </label>
        <label><input type="checkbox" id="loop"> Loop</label>
        <span id="notice"></span>
      </div>
    </section>

    <section id="tags">
      <div class="sectionHead">
        <h2>Tags</h2>
        <span id="status"></span>
        <button id="revert" disabled>Revert</button>
        <button id="save" class="primary" disabled title="Write the tags into the file (Ctrl/Cmd+S)">Save tags</button>
      </div>
      <p id="tagNote" hidden></p>
      <div id="form"></div>
      <div id="coverButtons">
        <button id="coverChange">Change cover…</button>
        <button id="coverRemove">Remove cover</button>
      </div>
      <details id="otherBox" hidden>
        <summary>Other tags</summary>
        <dl id="other"></dl>
      </details>
    </section>

    <details id="infoBox">
      <summary>File and stream details</summary>
      <button id="copy" title="Copy all as text">Copy</button>
      <div id="sections"></div>
    </details>
  </main>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
