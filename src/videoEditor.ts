import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findFfmpeg } from './ffmpeg';
import { analyze } from './mediaInfo';
import { MAX_SUBTITLE_BYTES, SUBTITLE_EXTENSIONS, decodeSubtitles, findSidecars, languageOf, toWebVtt } from './subtitles';
import { followFile, getNonce, missingAssets, parentOf } from './util';
import { clipStarts, cutClip, inspect, isCancelled, keyframesAround, readSubtitleStream, textSubtitles, type FileInfo, type Keyframe } from './videoTools';

/** A subtitle track on offer: a file, or a text stream inside the video that ffmpeg reads out. */
interface Offer {
  id: string;
  label: string;
  /** Shown beside the label: the file name, or where the track comes from. */
  detail: string;
  /** Changes with the track's content, which tells the page to ask for it again. */
  rev: string;
  language?: string;
  uri?: vscode.Uri;
  stream?: number;
  /** A file next to the video, as opposed to one the user opened. */
  sidecar?: boolean;
  /** The file that carries the video's name and nothing else, such as `movie.srt`. */
  exact?: boolean;
}

const extensionOf = (uri: vscode.Uri) => path.posix.extname(uri.path).slice(1).toLowerCase();

export class VideoEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'previewix.video';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const { uri } = document;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const folder = parentOf(uri);
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, folder] };
    webview.html = this.html(webview, mediaRoot);

    // ffmpeg works on a path, so what depends on it (clips, subtitle tracks inside the file) is left out elsewhere.
    const local = uri.scheme === 'file';
    const ffmpeg = async () => (local ? findFfmpeg(vscode.workspace.getConfiguration('previewix').get<string>('ffmpegPath') ?? '') : undefined);

    let frameRate = 0;
    let offers: Offer[] = [];
    /** Files opened with "Load subtitles…". They stay on offer while the tab lives; the page names a track by its id, never by a path. */
    const picked: vscode.Uri[] = [];
    /** The streams of the file as ffmpeg lists them, read once per version of the file. */
    let streams: Promise<FileInfo | undefined> | undefined;
    let streamsKnown = false;
    /** The text of the subtitle streams read so far, by stream index. */
    const embedded = new Map<number, Promise<string>>();
    /** Counts the versions of the file seen on disk. */
    let generation = 0;
    /** Stops the ffmpeg runs that read from the file when it changes or the tab closes. */
    let reading = new AbortController();
    let listing = 0;
    let clipping = false;

    const fileInfo = () =>
      (streams ??= ffmpeg()
        .then((tool) => (tool ? inspect(tool, uri.fsPath, reading.signal) : undefined))
        .catch(() => undefined));

    const sendInfo = async () => {
      try {
        const report = await analyze(uri, this.context.extensionPath);
        frameRate = report.frameRate ?? 0;
        webview.postMessage({ type: 'info', ...report });
      } catch (e) {
        webview.postMessage({ type: 'info', summary: '', sections: [{ title: 'File', rows: [['Error', String(e)]] }] });
      }
    };
    const sendSource = (reload: boolean) => {
      // The cache-busting query makes the webview pick up a file that was rewritten on disk.
      const src = webview.asWebviewUri(uri).toString() + (reload ? `?t=${Date.now()}` : '');
      webview.postMessage({ type: 'source', src });
    };

    /** Lists the subtitle tracks on offer. `select` asks the page to switch to that one. */
    const sendSubtitles = async (select?: string) => {
      const turn = ++listing;
      const list: Offer[] = [];
      const fromFile = async (file: vscode.Uri, offer: Omit<Offer, 'rev' | 'uri'>) => {
        const stat = await vscode.workspace.fs.stat(file).then(
          (s) => s,
          () => undefined,
        );
        if (stat) {
          list.push({ ...offer, rev: `${stat.mtime}:${stat.size}`, uri: file });
        }
      };
      const entries = await vscode.workspace.fs.readDirectory(folder).then(
        (found) => found,
        () => [],
      );
      const names = entries.filter(([, type]) => type & vscode.FileType.File).map(([name]) => name);
      for (const { name, label, language, exact } of findSidecars(names, path.posix.basename(uri.path))) {
        await fromFile(vscode.Uri.joinPath(folder, name), { id: `file:${name}`, label, detail: label === name ? '' : name, language, sidecar: true, exact });
      }
      for (const file of picked) {
        await fromFile(file, { id: `picked:${file.toString()}`, label: path.posix.basename(file.path), detail: '' });
      }
      // What is shown before the user has chosen: the file named like the video, else one in VS Code's language, else the first.
      const ui = vscode.env.language.split('-')[0].toLowerCase();
      const suggested = list.find((offer) => offer.exact) ?? list.find((offer) => offer.sidecar && offer.language?.split('-')[0].toLowerCase() === ui) ?? list.find((offer) => offer.sidecar);
      const send = (info: FileInfo | undefined, chosen?: string) => {
        if (turn !== listing) {
          return;
        }
        const inside = (info ? textSubtitles(info) : []).map((stream): Offer => {
          const language = stream.language ? languageOf(stream.language) : undefined;
          return {
            id: `stream:${stream.index}`,
            label: [language?.name ?? stream.language, stream.title].filter(Boolean).join(' · ') || `Track ${stream.index}`,
            detail: 'in the video',
            rev: String(generation),
            language: language?.code,
            stream: stream.index,
          };
        });
        offers = [...list, ...inside];
        webview.postMessage({
          type: 'subtitles',
          tracks: offers.map(({ id, label, detail, rev }) => ({ id, label, detail, rev })),
          suggested: suggested?.id,
          select: chosen,
        });
      };
      if (streamsKnown) {
        send(await fileInfo(), select);
        return;
      }
      // The files next to the video don't wait for ffmpeg, which may take its time over a large one.
      send(undefined, select);
      const info = await fileInfo();
      streamsKnown = true;
      if (info && textSubtitles(info).length) {
        send(info);
      }
    };

    const readTrack = async (offer: Offer): Promise<string> => {
      if (offer.uri) {
        const name = path.posix.basename(offer.uri.path);
        if ((await vscode.workspace.fs.stat(offer.uri)).size > MAX_SUBTITLE_BYTES) {
          throw new Error(`${name} is too large to be a subtitle file.`);
        }
        const { text } = decodeSubtitles(await vscode.workspace.fs.readFile(offer.uri), offer.language);
        const { vtt, cues } = toWebVtt(text, extensionOf(offer.uri));
        if (cues === 0) {
          throw new Error(`No subtitles were found in ${name}.`);
        }
        return vtt;
      }
      const tool = await ffmpeg();
      const index = offer.stream;
      if (!tool || index === undefined) {
        throw new Error('ffmpeg is needed to read this track.');
      }
      let text = embedded.get(index);
      if (!text) {
        text = readSubtitleStream(tool, uri.fsPath, index, reading.signal);
        embedded.set(index, text);
        text.catch(() => embedded.delete(index));
      }
      return text;
    };

    const sendCues = async (id: string) => {
      const offer = offers.find((o) => o.id === id);
      if (!offer) {
        return; // the list has changed meanwhile, and the page has the new one
      }
      try {
        webview.postMessage({ type: 'cues', id, rev: offer.rev, vtt: await readTrack(offer), language: offer.language });
      } catch (e) {
        if (isCancelled(e)) {
          return;
        }
        webview.postMessage({ type: 'cues', id, rev: offer.rev, error: e instanceof Error ? e.message : String(e) });
        // A file that turned out not to be subtitles doesn't stay in the menu.
        const at = picked.findIndex((file) => file.toString() === offer.uri?.toString());
        if (at >= 0) {
          picked.splice(at, 1);
          void sendSubtitles();
        }
      }
    };

    const pickSubtitles = async () => {
      const [file] =
        (await vscode.window.showOpenDialog({
          defaultUri: folder,
          canSelectMany: false,
          filters: { Subtitles: SUBTITLE_EXTENSIONS, 'All files': ['*'] },
          title: 'Load subtitles',
          openLabel: 'Load',
        })) ?? [];
      if (!file) {
        return;
      }
      const known = offers.find((offer) => offer.uri?.toString() === file.toString());
      if (!known) {
        picked.push(file);
      }
      await sendSubtitles(known?.id ?? `picked:${file.toString()}`);
    };

    followFile(panel, uri, VideoEditorProvider.viewType, {
      onChange: () => {
        generation++;
        streams = undefined;
        streamsKnown = false;
        embedded.clear();
        reading.abort();
        reading = new AbortController();
        sendSource(true);
        void sendInfo();
        void sendSubtitles();
      },
    });

    // Subtitle files can appear, change and go while the video is open.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*'));
    let relist: NodeJS.Timeout | undefined;
    const onSibling = (file: vscode.Uri) => {
      if (SUBTITLE_EXTENSIONS.includes(extensionOf(file))) {
        clearTimeout(relist);
        relist = setTimeout(() => void sendSubtitles(), 300);
      }
    };
    watcher.onDidCreate(onSibling);
    watcher.onDidChange(onSibling);
    watcher.onDidDelete(onSibling);
    panel.onDidDispose(() => {
      clearTimeout(relist);
      watcher.dispose();
      reading.abort();
    });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          sendSource(false);
          void sendInfo();
          void sendSubtitles();
          void ffmpeg().then((tool) => webview.postMessage({ type: 'tools', clip: !!tool }));
          break;
        case 'fullscreen':
          await toggleWorkbenchFullscreen(msg.enter);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('Previewix: media info copied', 2500);
          break;
        case 'saveFrame':
          await saveFrame(uri, msg.label, msg.data);
          break;
        case 'subtitle':
          await sendCues(String(msg.id));
          break;
        case 'pickSubtitles':
          await pickSubtitles();
          break;
        case 'saveClip': {
          const tool = await ffmpeg();
          if (!tool) {
            break;
          }
          if (clipping) {
            vscode.window.showInformationMessage('Previewix: the previous clip is still being saved.');
            break;
          }
          clipping = true;
          try {
            await saveClip(tool, uri, { start: msg.start, end: msg.end, duration: Number(msg.duration) || 0, frameRate });
          } finally {
            clipping = false;
          }
          break;
        }
      }
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'video.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'video.js'));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <main id="player">
    <div id="stage">
      <video id="video" playsinline preload="metadata" crossorigin="anonymous"></video>
      <div id="subsTop" class="subs"></div>
      <div id="subs" class="subs"></div>
      <div id="notice" hidden></div>
      <div id="toast" hidden></div>
      <div id="controls">
        <div id="peek" hidden><canvas id="peekFrame" hidden></canvas><span id="peekTime"></span></div>
        <div id="subMenu" role="menu" aria-label="Subtitles" hidden></div>
        <div id="seek"><div id="seekBuffered"></div><div id="seekPlayed"></div><div id="seekRange" hidden></div><div id="markA" class="mark" hidden></div><div id="markB" class="mark" hidden></div></div>
        <div id="buttons">
          <button id="play" class="icon" title="Play / pause (Space)"><svg class="play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><svg class="pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>
          <span id="time" title="Click to switch between time and timecode with the frame number">0:00 / 0:00</span>
          <span class="spacer"></span>
          <button id="prevFrame" class="icon" title="Previous frame (,)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zM19 6v12l-9-6z"/></svg></button>
          <button id="nextFrame" class="icon" title="Next frame (.)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM5 6v12l9-6z"/></svg></button>
          <button id="snapshot" class="icon" title="Save the current frame as PNG (S)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg></button>
          <span class="group">
            <button id="setA" class="icon toggle" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h7v2.5H9.5v11H14V20H7z"/></svg></button>
            <button id="setB" class="icon toggle" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 4h-7v2.5h4.5v11H10V20h7z"/></svg></button>
            <button id="clearAB" class="icon" title="Remove the A–B marks (X)" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>
            <button id="clip" class="icon" title="Save the marked range as a new file, without re-encoding" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3h-3z"/></svg></button>
          </span>
          <select id="speed" title="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select>
          <button id="loop" class="icon toggle" title="Loop" aria-pressed="false"><svg class="repeat" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg></button>
          <button id="cc" class="icon toggle" title="Subtitles (C turns them on and off)" aria-pressed="false" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z"/></svg></button>
          <button id="mute" class="icon" title="Mute (M)"><svg class="sound" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg><svg class="silent" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5V12zM19 12c0 .9-.2 1.8-.5 2.6l1.5 1.5A9 9 0 0 0 14 3.2v2.1A7 7 0 0 1 19 12zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3c-.7.5-1.4.9-2.3 1.2v2.1a9 9 0 0 0 3.7-1.9l2 2 1.3-1.3L4.3 3zM12 4 9.9 6.1 12 8.2V4z"/></svg></button>
          <input type="range" id="volume" min="0" max="1" step="0.05" value="1" title="Volume">
          <button id="fullscreen" class="icon" title="Fullscreen (F)"><svg class="expand" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg><svg class="shrink" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg></button>
        </div>
      </div>
    </div>
    <button id="bar" title="Show or hide detailed media info (I)" aria-expanded="false"><span id="summary">Media info</span></button>
  </main>
  <aside id="info">
    <div id="infoHeader">
      <strong>Media info</strong>
      <span class="spacer"></span>
      <button id="copy" title="Copy all as text">Copy</button>
      <button id="closeInfo" title="Close (I)" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>
    </div>
    <div id="sections"><p class="muted">Analyzing…</p></div>
  </aside>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Writes a frame that the webview captured as PNG to a place the user picks, next to the video by default. */
async function saveFrame(source: vscode.Uri, label: string, base64: string): Promise<void> {
  const stem = path.posix.basename(source.path, path.posix.extname(source.path));
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(parentOf(source), `${stem} ${String(label).replace(/[^\w.-]+/g, '-')}.png`),
    filters: { 'PNG image': ['png'] },
    title: 'Save frame as',
  });
  if (!target) {
    return;
  }
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
    const open = 'Open';
    if ((await vscode.window.showInformationMessage(`Previewix: frame saved as ${path.posix.basename(target.path)}`, open)) === open) {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Previewix: could not save the frame. ${e instanceof Error ? e.message : e}`);
  }
}

/** A position as it is read aloud, to the millisecond: "1:02.500", "1:00:02.500". */
function clock(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  return `${h ? `${h}:${pad(m)}` : m}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/** A length of time: "0.48 s", "12.5 s", "2 min 5 s". */
function span(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  }
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([fs.promises.stat(a, { bigint: true }), fs.promises.stat(b, { bigint: true })]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false; // the target doesn't exist yet
  }
}

interface ClipRequest {
  /** The A and B marks in seconds; null for a mark that isn't set, which stands for that end of the video. */
  start: number | null;
  end: number | null;
  duration: number;
  frameRate: number;
}

/**
 * Saves the marked range as a new file by copying its packets. A copied video stream can only
 * start at a keyframe, so when the start mark isn't on one, the user chooses between the keyframe
 * in front of it (a longer clip) and the one after it (a shorter one) before anything is written,
 * and the closing message repeats what the clip covers.
 */
async function saveClip(ffmpeg: string, source: vscode.Uri, request: ClipRequest): Promise<void> {
  const file = source.fsPath;
  const mark = typeof request.start === 'number' ? Math.max(0, request.start) : 0;
  const end = typeof request.end === 'number' ? request.end : undefined;
  const until = end ?? request.duration;
  if (!(until > mark)) {
    return;
  }
  const frame = 1 / (request.frameRate || 30);
  try {
    const info = await inspect(ffmpeg, file);
    let start = mark;
    let keyframe: Keyframe | undefined;
    if (mark > 0) {
      const keys = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Previewix: looking for keyframes' }, () =>
        keyframesAround(ffmpeg, file, info, mark, until),
      );
      // Without a video stream every packet stands on its own and the cut is where the mark is.
      if (keys) {
        const { exact, before, after } = clipStarts(keys, mark, until, frame);
        const choices: (vscode.QuickPickItem & { keyframe: Keyframe })[] = [];
        if (before) {
          choices.push({
            label: `Start at ${clock(before.time)}`,
            description: `${span(mark - before.time)} before the mark`,
            detail: 'The keyframe in front of the mark. Nothing of the marked range is lost, and the clip is that much longer.',
            keyframe: before,
          });
        }
        if (after) {
          choices.push({
            label: `Start at ${clock(after.time)}`,
            description: `${span(after.time - mark)} after the mark`,
            detail: 'The next keyframe. Nothing from before the mark gets into the clip, and the range loses its beginning.',
            keyframe: after,
          });
        }
        if (exact) {
          keyframe = exact;
        } else if (!choices.length) {
          vscode.window.showWarningMessage('Previewix: there is no keyframe in the marked range, so it can not be saved without re-encoding.');
          return;
        } else {
          const choice = await vscode.window.showQuickPick(choices, {
            title: 'Save clip: without re-encoding, a clip starts at a keyframe',
            placeHolder: `The start mark is at ${clock(mark)}. Where should the clip start?`,
          });
          if (!choice) {
            return;
          }
          keyframe = choice.keyframe;
        }
        start = keyframe.time;
      }
    }

    const ext = path.extname(file).slice(1);
    const label = (seconds: number) => clock(seconds).replace(/\.\d+$/, '').replace(/:/g, '.');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(file), `${path.basename(file, path.extname(file))} ${label(start)}-${label(until)}.${ext}`)),
      // Matroska takes nearly every kind of stream, which makes it the way out when the video's own format refuses.
      filters: ext.toLowerCase() === 'mkv' ? { 'Matroska video': ['mkv'] } : { [`${ext.toUpperCase()} video`]: [ext], 'Matroska video': ['mkv'] },
      title: 'Save clip as',
    });
    if (!target) {
      return;
    }
    if (target.scheme !== 'file') {
      vscode.window.showErrorMessage('Previewix: a clip can only be saved to a local folder.');
      return;
    }
    if (await sameFile(target.fsPath, file)) {
      vscode.window.showErrorMessage("Previewix: a clip can't replace the video it is cut from. Save it under another name.");
      return;
    }
    const name = path.basename(target.fsPath);

    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Previewix: saving ${name}`, cancellable: true }, (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      let reported = 0;
      return cutClip(ffmpeg, file, target.fsPath, info, {
        start,
        keyframe,
        end,
        signal: abort.signal,
        onProgress: (written) => {
          const percent = Math.min(100, (written / (until - start)) * 100);
          progress.report({ increment: percent - reported, message: `${Math.floor(percent)}%` });
          reported = percent;
        },
      });
    });

    const notes = [`Previewix: clip saved as ${name}. It covers ${clock(start)} – ${clock(start + result.duration)} of the video (${span(result.duration)}).`];
    if (Math.abs(start - mark) >= frame) {
      notes.push(`It starts ${span(Math.abs(start - mark))} ${start < mark ? 'before' : 'after'} the start mark, at a keyframe.`);
    }
    const dropped = Object.entries(result.dropped).map(([type, count]) => `${count} ${type} stream${count === 1 ? '' : 's'}`);
    if (dropped.length) {
      notes.push(`Not copied, because ${path.extname(name)} files can't hold them: ${dropped.join(', ')}.`);
    }
    const open = 'Open';
    if ((await vscode.window.showInformationMessage(notes.join(' '), open)) === open) {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  } catch (e) {
    if (!isCancelled(e)) {
      vscode.window.showErrorMessage(`Previewix: could not save the clip. ${e instanceof Error ? e.message : e}`);
    }
  }
}

/**
 * Webviews can't use the HTML Fullscreen API, so fullscreen is emulated with Zen Mode,
 * which hides all workbench chrome and (by default) makes the window fullscreen.
 */
async function toggleWorkbenchFullscreen(enter: boolean): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.toggleZenMode');
  // Zen Mode centers the editor by default, which would leave wide margins around the video.
  if (enter && vscode.workspace.getConfiguration('zenMode').get<boolean>('centerLayout')) {
    await vscode.commands.executeCommand('workbench.action.toggleCenteredLayout');
  }
}
