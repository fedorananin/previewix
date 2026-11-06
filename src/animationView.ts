import * as path from 'path';
import * as vscode from 'vscode';
import { followFile, getNonce, missingAssets, parentOf } from './util';

export interface AnimationInfo {
  format: 'GIF' | 'APNG' | 'PNG' | 'WebP';
  mime: string;
  width: number;
  height: number;
  /** The delay of every frame as the file states it, in milliseconds. */
  delays: number[];
  /** How many times the animation plays; 0 means forever. */
  plays: number;
  /** More than one frame. */
  animated: boolean;
}

const ascii = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length));
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function inspectGif(b: Uint8Array): AnimationInfo {
  const delays: number[] = [];
  // Without the NETSCAPE extension a GIF plays once.
  let plays = 1;
  let delay = 0;
  const skipSubBlocks = (at: number) => {
    while (at < b.length && b[at]) {
      at += b[at] + 1;
    }
    return at + 1;
  };
  let pos = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
  while (pos < b.length) {
    const block = b[pos++];
    if (block === 0x21) {
      const label = b[pos++];
      if (label === 0xf9 && b[pos] === 4) {
        delay = u16le(b, pos + 2) * 10;
      } else if (label === 0xff && b[pos] === 11 && b[pos + 12] === 3 && b[pos + 13] === 1) {
        const app = ascii(b, pos + 1, 11);
        if (app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') {
          const repeats = u16le(b, pos + 14);
          // The field counts repetitions after the first run.
          plays = repeats ? repeats + 1 : 0;
        }
      }
      pos = skipSubBlocks(pos);
    } else if (block === 0x2c) {
      const flags = b[pos + 8];
      pos += 9 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0) + 1;
      pos = skipSubBlocks(pos);
      // A frame cut off by the end of the file doesn't count.
      if (pos <= b.length) {
        delays.push(delay);
      }
      delay = 0;
    } else {
      break;
    }
  }
  return { format: 'GIF', mime: 'image/gif', width: u16le(b, 6), height: u16le(b, 8), delays, plays, animated: delays.length > 1 };
}

function inspectPng(b: Uint8Array): AnimationInfo {
  const delays: number[] = [];
  let width = 0;
  let height = 0;
  let frames = 0;
  let plays = 0;
  let sawData = false;
  for (let pos = 8; pos + 12 <= b.length; ) {
    const length = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    const data = pos + 8;
    if (type === 'IHDR') {
      width = u32be(b, data);
      height = u32be(b, data + 4);
    } else if (type === 'acTL' && !sawData) {
      // An acTL after the image data is ignored by decoders, and the file is then a plain PNG.
      frames = u32be(b, data);
      plays = u32be(b, data + 4);
    } else if (type === 'IDAT') {
      sawData = true;
      if (!frames) {
        break;
      }
    } else if (type === 'fcTL' && frames) {
      const denominator = u16be(b, data + 22) || 100;
      delays.push(Math.round((u16be(b, data + 20) * 1000) / denominator));
    } else if (type === 'IEND') {
      break;
    }
    pos = data + length + 4;
  }
  const animated = frames > 1;
  return { format: animated ? 'APNG' : 'PNG', mime: 'image/png', width, height, delays, plays: animated ? plays : 1, animated };
}

function inspectWebp(b: Uint8Array): AnimationInfo {
  const delays: number[] = [];
  let width = 0;
  let height = 0;
  let plays = 1;
  let flagged = false;
  for (let pos = 12; pos + 8 <= b.length; ) {
    const type = ascii(b, pos, 4);
    const length = u32le(b, pos + 4);
    const data = pos + 8;
    if (type === 'VP8X' && pos === 12) {
      flagged = (b[data] & 0x02) !== 0;
      width = u24le(b, data + 4) + 1;
      height = u24le(b, data + 7) + 1;
      if (!flagged) {
        break;
      }
    } else if (pos === 12) {
      // A simple file starts with the bitstream itself and can't hold an animation.
      break;
    } else if (type === 'ANIM') {
      plays = u16le(b, data + 4);
    } else if (type === 'ANMF') {
      delays.push(u24le(b, data + 12));
    }
    // Chunks are padded to an even length.
    pos = data + length + (length & 1);
  }
  const animated = flagged && delays.length > 1;
  return { format: 'WebP', mime: 'image/webp', width, height, delays, plays: animated ? plays : 1, animated };
}

/** Reads the animation structure of a GIF, PNG or WebP file from its container, without decoding any frame. */
export function inspectAnimation(bytes: Uint8Array): AnimationInfo | undefined {
  try {
    if (bytes.length >= 13 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
      return inspectGif(bytes);
    }
    if (bytes.length >= 16 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) {
      return inspectPng(bytes);
    }
    if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
      return inspectWebp(bytes);
    }
  } catch {
    // A damaged file is simply not an animation.
  }
  return undefined;
}

/**
 * Whether the file is a GIF, APNG or WebP animation with more than one frame. The extension can't
 * tell: `.png` and `.webp` files are usually still images.
 */
export function isAnimated(bytes: Uint8Array): boolean {
  return inspectAnimation(bytes)?.animated === true;
}

/** Turns a webview panel into the animation page. Called by the image provider for files that `isAnimated`. */
export function resolveAnimation(
  context: vscode.ExtensionContext,
  document: vscode.CustomDocument,
  panel: vscode.WebviewPanel,
  viewType: string,
): void {
  const { webview } = panel;
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
  webview.html = html(webview, mediaRoot);

  const name = path.posix.basename(document.uri.path);

  // The bytes are sent over instead of a URL, as in the image editor: frames decoded from a
  // cross-origin source couldn't be read back for "Save frame".
  const send = async () => {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      const info = inspectAnimation(bytes);
      if (!info) {
        webview.postMessage({ type: 'error', message: 'This file is not a GIF, PNG or WebP image.' });
        return;
      }
      webview.postMessage({ type: 'init', name, info, bytes });
    } catch (e) {
      webview.postMessage({ type: 'error', message: `Could not read the file: ${e instanceof Error ? e.message : e}` });
    }
  };

  // Nothing on the page can be lost, so a change on disk simply loads the file again.
  followFile(panel, document.uri, viewType, { onChange: () => void send() });

  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        await send();
        break;
      case 'save':
        await saveFrame(document.uri, Number(msg.frame) || 1, String(msg.data), webview);
        break;
    }
  });
}

async function saveFrame(source: vscode.Uri, frame: number, base64: string, webview: vscode.Webview): Promise<void> {
  const stem = path.posix.basename(source.path, path.posix.extname(source.path));
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(parentOf(source), `${stem}-frame-${String(frame).padStart(3, '0')}.png`),
    filters: { 'PNG image': ['png'] },
    title: `Save frame ${frame} as`,
  });
  if (!target) {
    return;
  }
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
    webview.postMessage({ type: 'saved', name: path.posix.basename(target.path) });
  } catch (e) {
    vscode.window.showErrorMessage(`Previewix: could not save the frame. ${e instanceof Error ? e.message : e}`);
  }
}

function html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const nonce = getNonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'animation.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'animation.js'));
  // img-src blob: is for the fallback <img>, which is used when frames can't be decoded one by one.
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body>
  <header id="toolbar">
    <div class="group" id="transport">
      <button id="first" class="icon" title="First frame (Home)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
      <button id="prev" class="icon" title="Previous frame (, or ←)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5v14L5 12z"/></svg></button>
      <button id="play" class="icon primary" title="Play / pause (Space)"><svg class="play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><svg class="pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>
      <button id="next" class="icon" title="Next frame (. or →)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></button>
      <button id="last" class="icon" title="Last frame (End)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
    </div>
    <div class="group">
      <label title="Playback speed">Speed
        <select id="speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select>
      </label>
      <label title="Start over after the last frame (L)"><input type="checkbox" id="loop" checked> Loop</label>
    </div>
    <div class="group">
      <button id="stripToggle" title="Show or hide the frame strip (F)">Frames</button>
      <button id="zoomFit" title="Fit to window (0)">Fit</button>
      <button id="zoomActual" title="Actual size (1)">100%</button>
    </div>
    <div class="group right">
      <button id="copyFrame" title="Copy the current frame to the clipboard" hidden>Copy frame</button>
      <button id="saveFrame" class="primary" title="Save the current frame (Ctrl/Cmd+S)">Save frame as PNG…</button>
    </div>
  </header>

  <div id="stage">
    <canvas id="view"></canvas>
    <img id="fallback" alt="" hidden>
    <div id="notice" hidden></div>
    <div id="message">Loading…</div>
  </div>

  <div id="timeline">
    <input type="range" id="scrub" min="1" max="1" step="1" value="1" title="Frame" disabled>
    <span id="counter"></span>
  </div>
  <div id="strip" hidden><div id="stripInner"></div></div>

  <footer id="status">
    <span id="statInfo"></span>
    <span id="statZoom"></span>
    <span id="toast"></span>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
