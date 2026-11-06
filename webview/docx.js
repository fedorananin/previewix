import { renderAsync } from 'docx-preview';

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const container = $('document');
const state = { zoom: vscode.getState()?.zoom ?? 'fit' };

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

const pages = () => container.querySelectorAll('.docx-wrapper > section');

/** The scale at which the widest page fills the window, never above 100%. */
function fitScale() {
  let width = 0;
  for (const page of pages()) {
    width = Math.max(width, page.offsetWidth);
  }
  return width ? Math.min(1, (container.clientWidth - 48) / width) : 1;
}

function applyZoom() {
  const wrapper = container.querySelector('.docx-wrapper');
  if (!wrapper) {
    return;
  }
  const scale = state.zoom === 'fit' ? fitScale() : state.zoom;
  wrapper.style.zoom = String(scale);
  $('zoomValue').textContent = `${Math.round(scale * 100)}%`;
  $('fit').classList.toggle('active', state.zoom === 'fit');
  vscode.setState(state);
}

function setZoom(zoom) {
  state.zoom = zoom === 'fit' ? zoom : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  applyZoom();
}

const currentScale = () => (state.zoom === 'fit' ? fitScale() : state.zoom);

$('zoomIn').addEventListener('click', () => setZoom(currentScale() * 1.2));
$('zoomOut').addEventListener('click', () => setZoom(currentScale() / 1.2));
$('actual').addEventListener('click', () => setZoom(1));
$('fit').addEventListener('click', () => setZoom('fit'));

// Ctrl/Cmd + wheel, which is also what a trackpad pinch produces.
container.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      setZoom(currentScale() * Math.exp(-delta * 0.01));
    }
  },
  { passive: false },
);

new ResizeObserver(() => {
  if (state.zoom === 'fit') {
    applyZoom();
  }
}).observe(container);

// Word bullets are usually private-use characters meant for the Symbol or Wingdings fonts,
// which browsers render as empty boxes; these are their closest Unicode equivalents.
const BULLETS = { f0b7: '•', f0a7: '▪', f0d8: '➢', f0fc: '✓', f0a8: '◆', f076: '❖', f0e0: '→', f02d: '–' };

function fixBullets() {
  for (const style of container.querySelectorAll('style')) {
    const css = style.textContent;
    const fixed = css.replace(/[\uf000-\uf0ff]|\\f0[0-9a-f]{2}\s?/gi, (match) => {
      const code = match.startsWith('\\') ? match.slice(1).trim().toLowerCase() : match.charCodeAt(0).toString(16);
      return BULLETS[code] ?? '•';
    });
    if (fixed !== css) {
      style.textContent = fixed;
    }
  }
}

async function load(src) {
  showMessage('Loading…');
  try {
    const data = await (await fetch(src)).arrayBuffer();
    const scroll = container.scrollTop;
    container.replaceChildren();
    await renderAsync(data, container, undefined, {
      inWrapper: true,
      breakPages: true,
      experimental: true,
      renderChanges: false,
    });
    fixBullets();
    showMessage('');
    applyZoom();
    container.scrollTop = scroll;
    const count = pages().length;
    $('info').textContent = `${count} ${count === 1 ? 'page' : 'pages'} (approximate layout)`;
  } catch (e) {
    container.replaceChildren();
    showMessage(`This document could not be opened: ${e?.message ?? e}`);
  }
}

// Links inside the document: web links go to the browser, bookmarks scroll.
container.addEventListener('click', (e) => {
  const href = e.target.closest?.('a')?.getAttribute('href');
  if (!href) {
    return;
  }
  e.preventDefault();
  if (href.startsWith('#')) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
  } else {
    vscode.postMessage({ type: 'openLink', href });
  }
});

const toMarkdown = $('toMarkdown');
toMarkdown.addEventListener('click', () => {
  // The conversion works on the file itself and runs in the extension, which answers with 'converted'.
  toMarkdown.disabled = true;
  vscode.postMessage({ type: 'convertToMarkdown' });
});

window.addEventListener('message', (e) => {
  if (e.data.type === 'source') {
    load(e.data.src);
  } else if (e.data.type === 'converted') {
    toMarkdown.disabled = false;
  }
});

vscode.postMessage({ type: 'ready' });
