import './pdfjs-global.js';
import * as pdfjs from 'pdfjs-dist';
import { EventBus, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { linesToMarkdown, pageLines } from './pdfMarkdown.js';

const { AnnotationEditorParamsType: Param, AnnotationEditorType: Tool } = pdfjs;

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const assets = document.body.dataset.assets;
const container = $('viewerContainer');
const pageInput = $('page');
const scaleSelect = $('scale');
const findInput = $('find');

const saved = vscode.getState() || {};
const state = {
  page: saved.page || 1,
  scale: saved.scale || 'auto',
  rotation: saved.rotation || 0,
  // Which sidebar is open: 'thumbs', 'outline' or ''. Older states only knew the outline.
  side: saved.side ?? (saved.outline ? 'outline' : ''),
};
const saveState = () => vscode.setState(state);

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

// ---- Viewer ---------------------------------------------------------------

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({
  container,
  viewer: $('viewer'),
  eventBus,
  linkService,
  findController,
  imageResourcesPath: `${assets}images/`,
  // The colors offered for a highlight, in pdf.js' own notation.
  annotationEditorHighlightColors: 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F',
  enableHighlightFloatingButton: true,
});
linkService.setViewer(viewer);

/** @type {Promise<Worker> | undefined} */
let workerReady;

// A worker can't be started straight from the extension's files, which are cross-origin
// for the webview, so its code is fetched and started from a blob instead.
function getWorker() {
  workerReady ??= (async () => {
    const code = await (await fetch(`${assets}pdf.worker.min.mjs`)).text();
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    return new Worker(url, { type: 'module' });
  })();
  return workerReady;
}

let loadingTask;
let pdf;
// True while the viewer exchanges one document for another.
let swapping = false;
// Counts the loads, so that one that finishes late can't replace a newer one.
let loads = 0;

/** Bytes from the extension arrive as a typed array, or as what an older transport made of one. */
function toBytes(data) {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return data;
  }
  return new Uint8Array(Array.isArray(data?.data) ? data.data : Object.values(data));
}

/** Opens the document at an address, or from bytes when the extension sends a copy that has unsaved changes in it. */
async function load(source, unsaved = false) {
  const current = ++loads;
  showMessage('Loading…');
  $('password').hidden = true;
  let opened;
  try {
    const [data, worker] = await Promise.all([
      typeof source === 'string' ? fetch(source).then((r) => r.arrayBuffer()) : toBytes(source),
      getWorker(),
    ]);
    if (current !== loads) {
      return;
    }
    pdfjs.GlobalWorkerOptions.workerPort = worker;
    await loadingTask?.destroy();
    loadingTask = pdfjs.getDocument({
      data,
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
    });
    loadingTask.onPassword = askPassword;
    opened = await loadingTask.promise;
  } catch (e) {
    if (current === loads) {
      showMessage(`This PDF could not be opened: ${e?.message ?? e}`);
    }
    return;
  }
  if (current !== loads) {
    return;
  }
  pdf = opened;
  $('password').hidden = true;
  showMessage('');
  resetEditing();
  // A document restored from a backup already carries changes the file doesn't have.
  setDirty(unsaved);
  photos.clear();
  // Taking the old pages away makes a field that was being typed in report one last change.
  swapping = true;
  viewer.setDocument(pdf);
  linkService.setDocument(pdf);
  swapping = false;
  $('pages').textContent = `/ ${pdf.numPages}`;
  pageInput.max = String(pdf.numPages);
  resetThumbs();
  const [outline, metadata] = await Promise.all([pdf.getOutline().catch(() => null), pdf.getMetadata().catch(() => null)]);
  if (current !== loads) {
    return;
  }
  renderOutline(outline);
  signed = !!metadata?.info?.IsSignaturesPresent;
  vscode.postMessage({ type: 'loaded', signed });
}

function askPassword(update, reason) {
  showMessage('');
  $('password').hidden = false;
  // Reason 2 is pdf.js' "incorrect password".
  $('passwordLabel').textContent = reason === 2 ? 'Wrong password, try again:' : 'This PDF is password-protected:';
  const input = $('passwordInput');
  input.value = '';
  input.focus();
  $('password').onsubmit = (e) => {
    e.preventDefault();
    update(input.value);
  };
}

eventBus.on('pagesinit', () => {
  viewer.currentScaleValue = String(state.scale);
  viewer.pagesRotation = state.rotation;
  viewer.currentPageNumber = Math.min(state.page, viewer.pagesCount);
  if (findInput.value) {
    find();
  }
  layoutThumbs();
});

eventBus.on('pagechanging', ({ pageNumber }) => {
  pageInput.value = String(pageNumber);
  state.page = pageNumber;
  saveState();
  markThumb(pageNumber);
});

eventBus.on('scalechanging', ({ scale, presetValue }) => {
  const value = presetValue || String(scale);
  const custom = $('customScale');
  const known = [...scaleSelect.options].some((option) => option !== custom && option.value === value);
  custom.hidden = known;
  if (!known) {
    custom.value = value;
    custom.textContent = `${Math.round(scale * 100)}%`;
  }
  scaleSelect.value = value;
  state.scale = presetValue || scale;
  saveState();
});

// ---- Toolbar --------------------------------------------------------------

$('prev').addEventListener('click', () => viewer.previousPage());
$('next').addEventListener('click', () => viewer.nextPage());
pageInput.addEventListener('change', () => {
  const page = Math.round(Number(pageInput.value));
  if (page >= 1 && page <= viewer.pagesCount) {
    viewer.currentPageNumber = page;
  } else {
    pageInput.value = String(viewer.currentPageNumber);
  }
});

$('zoomIn').addEventListener('click', () => viewer.increaseScale());
$('zoomOut').addEventListener('click', () => viewer.decreaseScale());
scaleSelect.addEventListener('change', () => (viewer.currentScaleValue = scaleSelect.value));

$('rotate').addEventListener('click', () => {
  state.rotation = (viewer.pagesRotation + 90) % 360;
  viewer.pagesRotation = state.rotation;
  saveState();
  resetThumbs();
});

// Ctrl/Cmd + wheel, which is also what a trackpad pinch produces, zooms around the pointer.
container.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) {
      return;
    }
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    viewer.updateScale({ scaleFactor: Math.exp(-delta * 0.01), origin: [e.clientX, e.clientY], drawingDelay: 300 });
  },
  { passive: false },
);

// ---- Find -----------------------------------------------------------------

function find(type = '', previous = false) {
  eventBus.dispatch('find', {
    source: window,
    type,
    query: findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
  });
}

let findTimer;
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => find(), 250);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    find('again', e.shiftKey);
  } else if (e.key === 'Escape') {
    findInput.value = '';
    find();
    container.focus();
  }
});
$('findNext').addEventListener('click', () => find('again', false));
$('findPrev').addEventListener('click', () => find('again', true));

function showMatches({ matchesCount }) {
  const { current = 0, total = 0 } = matchesCount ?? {};
  $('findCount').textContent = findInput.value ? (total ? `${current} / ${total}` : 'No results') : '';
}
eventBus.on('updatefindmatchescount', showMatches);
eventBus.on('updatefindcontrolstate', showMatches);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findInput.focus();
    findInput.select();
  }
});

// ---- Sidebar: thumbnails and outline --------------------------------------

let hasOutline = false;

function setSide(side) {
  state.side = side;
  const shown = side === 'outline' && !hasOutline ? '' : side;
  document.body.classList.toggle('outline-open', shown === 'outline');
  document.body.classList.toggle('thumbs-open', shown === 'thumbs');
  $('outlineToggle').setAttribute('aria-pressed', String(shown === 'outline'));
  $('thumbsToggle').setAttribute('aria-pressed', String(shown === 'thumbs'));
  saveState();
  if (shown === 'thumbs') {
    layoutThumbs();
    markThumb(viewer.currentPageNumber, true);
  }
}

function outlineList(items) {
  const list = document.createElement('ul');
  for (const item of items) {
    const entry = document.createElement('li');
    const link = document.createElement('a');
    link.textContent = item.title;
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (item.dest) {
        linkService.goToDestination(item.dest);
      } else if (item.url) {
        vscode.postMessage({ type: 'openLink', href: item.url });
      }
    });
    entry.append(link);
    if (item.items?.length) {
      entry.append(outlineList(item.items));
    }
    list.append(entry);
  }
  return list;
}

function renderOutline(outline) {
  hasOutline = !!outline?.length;
  $('outlineToggle').hidden = !hasOutline;
  $('outline').replaceChildren(...(hasOutline ? [outlineList(outline)] : []));
  setSide(state.side);
}

$('outlineToggle').addEventListener('click', () => setSide(state.side === 'outline' ? '' : 'outline'));
$('thumbsToggle').addEventListener('click', () => setSide(state.side === 'thumbs' ? '' : 'thumbs'));

// The list is virtual: every page has a slot of the same height, and only the slots in view have
// an element and a picture, so a thousand pages cost no more than a dozen.
const thumbs = $('thumbs');
const thumbsInner = $('thumbsInner');
const THUMB_WIDTH = 128;
const THUMB_LABEL = 22;
const THUMB_GAP = 10;
const THUMB_CACHE = 120;
/** Rendered pictures by page number, in order of use. @type {Map<number, HTMLCanvasElement>} */
const thumbCache = new Map();
/** Slots in the document right now. @type {Map<number, HTMLElement>} */
const thumbCells = new Map();
// Height of the picture area of a slot; pages of another shape are fitted into it.
let thumbHeight = 0;
let thumbTask;
let thumbBusy = false;
// Changes when the pictures made so far no longer apply (another document, another rotation).
let thumbEpoch = 0;

const thumbRow = () => thumbHeight + THUMB_LABEL + THUMB_GAP;

function resetThumbs() {
  thumbEpoch++;
  thumbTask?.cancel();
  thumbCache.clear();
  thumbCells.clear();
  thumbsInner.replaceChildren();
  thumbHeight = 0;
  layoutThumbs();
}

async function layoutThumbs() {
  if (!pdf || state.side !== 'thumbs') {
    return;
  }
  if (!thumbHeight) {
    const epoch = thumbEpoch;
    const first = await pdf.getPage(1);
    if (epoch !== thumbEpoch || thumbHeight) {
      return;
    }
    const { width, height } = first.getViewport({ scale: 1, rotation: (first.rotate + viewer.pagesRotation) % 360 });
    thumbHeight = Math.round(THUMB_WIDTH * Math.min(2, Math.max(0.4, height / width)));
    thumbs.style.setProperty('--thumb-height', `${thumbHeight}px`);
    thumbsInner.style.height = `${pdf.numPages * thumbRow() + THUMB_GAP}px`;
    markThumb(viewer.currentPageNumber, true);
  }
  drawThumbs();
}

function drawThumbs() {
  if (!thumbHeight || !pdf) {
    return;
  }
  const row = thumbRow();
  const first = Math.max(1, Math.floor(thumbs.scrollTop / row) - 1);
  const last = Math.min(pdf.numPages, Math.ceil((thumbs.scrollTop + thumbs.clientHeight) / row) + 2);
  for (const [number, cell] of thumbCells) {
    if (number < first || number > last) {
      cell.remove();
      thumbCells.delete(number);
    }
  }
  for (let number = first; number <= last; number++) {
    if (thumbCells.has(number)) {
      continue;
    }
    const cell = document.createElement('a');
    cell.className = 'thumb';
    cell.href = '#';
    cell.dataset.page = String(number);
    cell.title = `Page ${number}`;
    cell.style.top = `${THUMB_GAP + (number - 1) * row}px`;
    cell.classList.toggle('current', number === viewer.currentPageNumber);
    const picture = document.createElement('span');
    picture.className = 'picture';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = String(number);
    cell.append(picture, label);
    const ready = thumbCache.get(number);
    if (ready) {
      picture.append(ready);
    }
    thumbCells.set(number, cell);
    thumbsInner.append(cell);
  }
  // A picture that is no longer wanted shouldn't hold up the ones that are.
  if (thumbTask && !thumbCells.has(thumbTask.number)) {
    thumbTask.cancel();
  }
  pumpThumbs();
}

/** The slot in view that still has no picture and is nearest to the middle of the list. */
function nextThumb() {
  const middle = (thumbs.scrollTop + thumbs.clientHeight / 2) / thumbRow() + 0.5;
  let best = 0;
  for (const number of thumbCells.keys()) {
    if (!thumbCache.has(number) && (!best || Math.abs(number - middle) < Math.abs(best - middle))) {
      best = number;
    }
  }
  return best;
}

async function pumpThumbs() {
  if (thumbBusy || state.side !== 'thumbs') {
    return;
  }
  thumbBusy = true;
  try {
    for (let number = nextThumb(); number; number = nextThumb()) {
      const epoch = thumbEpoch;
      let canvas;
      try {
        canvas = await renderThumb(number);
      } catch (e) {
        // One that was cancelled because it scrolled away is simply asked for again when it comes back.
        if (e?.name === 'RenderingCancelledException') {
          continue;
        }
        // A page that can't be drawn keeps an empty slot, so it isn't tried over and over.
        canvas = document.createElement('canvas');
      }
      if (epoch !== thumbEpoch) {
        continue;
      }
      thumbCache.set(number, canvas);
      for (const old of thumbCache.keys()) {
        if (thumbCache.size <= THUMB_CACHE) {
          break;
        }
        if (!thumbCells.has(old)) {
          thumbCache.delete(old);
        }
      }
      thumbCells.get(number)?.firstElementChild.replaceChildren(canvas);
    }
  } finally {
    thumbBusy = false;
  }
}

async function renderThumb(number) {
  const page = await pdf.getPage(number);
  const rotation = (page.rotate + viewer.pagesRotation) % 360;
  const size = page.getViewport({ scale: 1, rotation });
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: Math.min(THUMB_WIDTH / size.width, thumbHeight / size.height) * ratio, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  canvas.style.width = `${canvas.width / ratio}px`;
  canvas.style.height = `${canvas.height / ratio}px`;
  const task = page.render({ canvas, canvasContext: null, viewport });
  thumbTask = { number, cancel: () => task.cancel() };
  try {
    await task.promise;
  } finally {
    thumbTask = undefined;
    // The viewer answers this by freeing the page's data unless it shows that page itself.
    eventBus.dispatch('thumbnailrendered', { source: thumbs, pageNumber: number, pdfPage: page });
  }
  return canvas;
}

/** Marks the slot of the current page and, when the list is open, brings it into view. */
function markThumb(number, center = false) {
  for (const [page, cell] of thumbCells) {
    cell.classList.toggle('current', page === number);
  }
  if (state.side !== 'thumbs' || !thumbHeight) {
    return;
  }
  const row = thumbRow();
  const top = THUMB_GAP + (number - 1) * row;
  if (center) {
    thumbs.scrollTop = top - (thumbs.clientHeight - row) / 2;
  } else if (top < thumbs.scrollTop) {
    thumbs.scrollTop = top - THUMB_GAP;
  } else if (top + row > thumbs.scrollTop + thumbs.clientHeight) {
    thumbs.scrollTop = top + row - thumbs.clientHeight;
  }
  drawThumbs();
}

let thumbFrame = 0;
thumbs.addEventListener('scroll', () => {
  thumbFrame ||= requestAnimationFrame(() => {
    thumbFrame = 0;
    drawThumbs();
  });
});
new ResizeObserver(() => drawThumbs()).observe(thumbs);

thumbsInner.addEventListener('click', (e) => {
  const cell = /** @type {HTMLElement} */ (e.target).closest('.thumb');
  if (cell) {
    e.preventDefault();
    viewer.currentPageNumber = Number(cell.dataset.page);
  }
});

// ---- Dark pages -----------------------------------------------------------

// The inversion itself is CSS (see pdf.css): a layer over every page that inverts what is under it.
// What is done here is the exception to it. Each page is drawn once more, very small, with pdf.js
// noting where it paints pictures; those that look like photographs get a hole in that layer and
// keep their colors.
let dark = false;
/** Per page: the corners of its photographs as fractions of the page and the rotation they were found at, or null while that is being worked out. */
const photos = new Map();
const PROBE_WIDTH = 160;
const PHOTO_LIMIT = 200;

function setDark(on) {
  dark = on;
  document.body.classList.toggle('dark-pages', on);
  $('dark').setAttribute('aria-pressed', String(on));
  if (on) {
    for (const view of viewer.getCachedPageViews()) {
      keepPhotos(view.id);
    }
  }
}

/** Tells a photograph from "paper": a scan, a chart or a formula is white for half its area or more, and reads better inverted. */
function isPhoto(context, x, y, width, height) {
  const { data } = context.getImageData(x, y, width, height);
  let light = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 > 215) {
      light++;
    }
  }
  return light < data.length / 8;
}

async function findPhotos(number) {
  const page = await pdf.getPage(number);
  const viewport = page.getViewport({ scale: PROBE_WIDTH / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: null, viewport, recordImages: true }).promise;
  const coordinates = page.imageCoordinates ?? [];
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const boxes = [];
  for (let i = 0; i + 6 <= coordinates.length && boxes.length < PHOTO_LIMIT; i += 6) {
    // Three corners of the picture; the fourth follows from them.
    const [x1, y1, x2, y2, x3, y3] = coordinates.subarray(i, i + 6);
    const xs = [x1, x2, x2 + x3 - x1, x3];
    const ys = [y1, y2, y2 + y3 - y1, y3];
    const left = Math.max(0, Math.floor(Math.min(...xs) * canvas.width));
    const top = Math.max(0, Math.floor(Math.min(...ys) * canvas.height));
    const width = Math.min(canvas.width, Math.ceil(Math.max(...xs) * canvas.width)) - left;
    const height = Math.min(canvas.height, Math.ceil(Math.max(...ys) * canvas.height)) - top;
    // Rules, bullets and other small decorations (under about a third of an inch) belong to the text around them.
    const small = (24 * viewport.scale) | 0;
    if (width > small && height > small && isPhoto(context, left, top, width, height)) {
      boxes.push(xs.flatMap((x, corner) => [x, ys[corner]]));
    }
  }
  return { rotation: viewport.rotation, boxes };
}

/** Cuts the photographs of a page out of its dark layer, finding them first if that hasn't been done. */
function keepPhotos(number) {
  if (!dark || !pdf) {
    return;
  }
  const entry = photos.get(number);
  if (entry === undefined) {
    const source = pdf;
    photos.set(number, null);
    findPhotos(number).then(
      (found) => {
        if (source === pdf) {
          photos.set(number, found);
          keepPhotos(number);
        }
      },
      // A page that can't be examined is simply inverted as a whole.
      () => undefined,
    );
    return;
  }
  const view = viewer.getPageView(number - 1);
  const wrapper = view?.div.querySelector('.canvasWrapper');
  if (!entry || !wrapper) {
    return;
  }
  if (!entry.boxes.length) {
    wrapper.style.removeProperty('--photos');
    return;
  }
  // The corners were found on the page as the file has it; the viewer may show it turned.
  const turns = (((view.viewport.rotation - entry.rotation) / 90) % 4 + 4) % 4;
  const polygons = entry.boxes.map((box) => {
    const points = [];
    for (let i = 0; i < 8; i += 2) {
      let [x, y] = [box[i], box[i + 1]];
      for (let turn = 0; turn < turns; turn++) {
        [x, y] = [1 - y, x];
      }
      points.push(`${+x.toFixed(5)},${+y.toFixed(5)}`);
    }
    return `<polygon points='${points.join(' ')}'/>`;
  });
  // A mask image works by its transparency, so the holes are cut with a mask of its own inside the picture.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1' preserveAspectRatio='none' shape-rendering='crispEdges'>` +
    `<mask id='m'><rect width='1' height='1' fill='white'/>${polygons.join('')}</mask>` +
    `<rect width='1' height='1' mask='url(#m)'/></svg>`;
  wrapper.style.setProperty('--photos', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
}

// The start of a drawing is early enough for a page that is known already, and both cover a page that isn't.
eventBus.on('pagerender', ({ pageNumber }) => keepPhotos(pageNumber));
eventBus.on('pagerendered', ({ pageNumber }) => keepPhotos(pageNumber));

$('dark').addEventListener('click', () => {
  setDark(!dark);
  vscode.postMessage({ type: 'dark', on: dark });
});

// ---- Annotating and form filling ------------------------------------------

const TOOLS = { toolHighlight: Tool.HIGHLIGHT, toolText: Tool.FREETEXT, toolDraw: Tool.INK, toolImage: Tool.STAMP };
const toolOptions = $('toolOptions');
let uiManager;
let signed = false;
let dirty = false;
// Counts the changes since the document was loaded, to tell which of them a finished save has covered.
let edits = 0;
let editTimer;

function editingAllowed() {
  return !!pdf && viewer.annotationEditorMode !== Tool.DISABLE;
}

function setTool(mode) {
  if (editingAllowed()) {
    viewer.annotationEditorMode = { mode };
  }
}

function showTool(mode) {
  for (const [id, tool] of Object.entries(TOOLS)) {
    $(id).setAttribute('aria-pressed', String(tool === mode));
  }
  toolOptions.hidden = mode === Tool.NONE || mode === Tool.DISABLE;
  for (const group of toolOptions.querySelectorAll('[data-tool]')) {
    group.hidden = TOOLS[group.dataset.tool] !== mode;
  }
  document.body.classList.toggle('editing', !toolOptions.hidden);
}

function resetEditing() {
  uiManager = undefined;
  showTool(Tool.NONE);
  edits = 0;
  snapshots.clear();
  clearTimeout(editTimer);
  setDirty(false);
  showNotice('');
  // The tools come back when pdf.js says this document can be edited (a pure XFA form, for one, can't).
  for (const id of ['undo', 'redo', ...Object.keys(TOOLS)]) {
    $(id).disabled = true;
  }
}

for (const [id, tool] of Object.entries(TOOLS)) {
  $(id).addEventListener('click', () => setTool(viewer.annotationEditorMode === tool ? Tool.NONE : tool));
}

eventBus.on('annotationeditormodechanged', ({ mode }) => showTool(mode));
// pdf.js asks for a tool itself: a double click on an annotation, or its "highlight" button next to a selection.
eventBus.on('switchannotationeditormode', (e) => {
  if (e.source !== window && editingAllowed()) {
    viewer.annotationEditorMode = e;
  }
});
eventBus.on('showannotationeditorui', ({ mode }) => setTool(mode));

// pdf.js has a flag for "modified", but it is raised already when a form is merely drawn (a radio group
// writes its state down), and only once. So changes are noticed where they are made: every step of the
// annotation tools goes through the three methods wrapped here, and form fields answer to input and change.
eventBus.on('annotationeditoruimanager', (e) => {
  uiManager = e.uiManager;
  for (const id of Object.keys(TOOLS)) {
    $(id).disabled = false;
  }
  for (const method of ['addCommands', 'undo', 'redo']) {
    const original = uiManager[method];
    if (typeof original === 'function') {
      uiManager[method] = function (...args) {
        const result = original.apply(this, args);
        edited();
        return result;
      };
    }
  }
});
for (const type of ['input', 'change']) {
  $('viewer').addEventListener(type, (e) => {
    if (!swapping && /** @type {HTMLElement} */ (e.target).closest?.('.annotationLayer')) {
      edited();
    }
  });
}

function setDirty(value) {
  dirty = value;
  $('save').disabled = !value;
}

function edited() {
  edits++;
  if (!dirty) {
    setDirty(true);
    vscode.postMessage({ type: 'edited' });
    if (signed) {
      showNotice(
        'This PDF is digitally signed. Saving keeps the signed content as it is and adds your changes after it, so PDF readers will report that the document was changed after signing.',
      );
    }
    return;
  }
  // The document is known to be unsaved already; the later changes only keep VS Code's backup of it fresh.
  clearTimeout(editTimer);
  editTimer = setTimeout(() => vscode.postMessage({ type: 'edited' }), 400);
}

eventBus.on('editingstateschanged', ({ details }) => {
  $('undo').disabled = !details.hasSomethingToUndo;
  $('redo').disabled = !details.hasSomethingToRedo;
});
$('undo').addEventListener('click', () => eventBus.dispatch('editingaction', { source: window, name: 'undo' }));
$('redo').addEventListener('click', () => eventBus.dispatch('editingaction', { source: window, name: 'redo' }));

function setParam(type, value) {
  eventBus.dispatch('switchannotationeditorparams', { source: window, type, value });
}

const swatches = $('highlightColors');
for (const swatch of swatches.querySelectorAll('button')) {
  swatch.style.setProperty('--swatch', swatch.dataset.color);
  swatch.addEventListener('click', () => setParam(Param.HIGHLIGHT_COLOR, swatch.dataset.color));
}

/** Controls of the options bar by the pdf.js parameter they set, with the way to read and to show a value. */
const PARAMS = new Map([
  [Param.HIGHLIGHT_THICKNESS, ['highlightThickness', Number, String]],
  [Param.FREETEXT_COLOR, ['textColor', String, String]],
  [Param.FREETEXT_SIZE, ['textSize', Number, String]],
  [Param.INK_COLOR, ['inkColor', String, String]],
  [Param.INK_THICKNESS, ['inkThickness', Number, String]],
  [Param.INK_OPACITY, ['inkOpacity', (value) => Number(value) / 100, (value) => String(Math.round(value * 100))]],
]);
for (const [type, [id, read]] of PARAMS) {
  $(id).addEventListener('input', () => setParam(type, read($(id).value)));
}
$('highlightShowAll').addEventListener('change', () => setParam(Param.HIGHLIGHT_SHOW_ALL, $('highlightShowAll').checked));
$('addImage').addEventListener('click', () => setParam(Param.CREATE, undefined));

// The other direction: selecting an annotation shows its own color and size in the bar.
eventBus.on('annotationeditorparamschanged', ({ details }) => {
  for (const [type, value] of details) {
    const control = PARAMS.get(type);
    if (control) {
      $(control[0]).value = control[2](value);
    } else if (type === Param.HIGHLIGHT_COLOR) {
      for (const swatch of swatches.querySelectorAll('button')) {
        swatch.setAttribute('aria-pressed', String(swatch.dataset.color.toLowerCase() === String(value).toLowerCase()));
      }
    } else if (type === Param.HIGHLIGHT_SHOW_ALL) {
      $('highlightShowAll').checked = !!value;
    }
  }
});

// ---- Saving ---------------------------------------------------------------

// When the user last asked for a save from inside the page (the button or the shortcut).
let askedToSave = 0;

$('save').addEventListener('click', () => {
  askedToSave = Date.now();
  vscode.postMessage({ type: 'requestSave' });
});
document.addEventListener(
  'keydown',
  (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      askedToSave = Date.now();
    }
  },
  true,
);

/** The number of changes each requested copy of the document contains, by request. */
const snapshots = new Map();

/** Answers the extension's request for the document with every change written into it. */
async function sendBytes({ id, backup }) {
  try {
    if (!pdf) {
      throw new Error('The document is not open.');
    }
    // A note that is still being typed isn't part of the document yet. It is finished for a save, but not for
    // a backup or an auto save that happens to run meanwhile: taking the cursor away would be worse, and
    // finishing the note later marks the document as changed again.
    const typing = document.activeElement?.closest?.('.annotationEditorLayer [contenteditable="true"]');
    if (!backup && (!typing || Date.now() - askedToSave < 5000)) {
      uiManager?.endCurrentEditing?.();
    }
    clearTimeout(editTimer);
    snapshots.set(id, edits);
    const data = await pdf.saveDocument();
    vscode.postMessage({ type: 'bytes', id, data }, [data.buffer]);
  } catch (e) {
    vscode.postMessage({ type: 'bytes', id, error: String(e?.message ?? e) });
  }
}

/** The extension has written the copy it asked for with request `id` into the file. */
function onSaved(id) {
  const covered = snapshots.get(id) ?? 0;
  snapshots.clear();
  if (covered === edits) {
    setDirty(false);
    showNotice('');
  } else {
    // Something was changed while the file was being written, and VS Code has just called the document saved.
    vscode.postMessage({ type: 'edited' });
  }
}

// ---- Notice ---------------------------------------------------------------

let noticeAction;

function showNotice(text, label = '', action = undefined) {
  $('notice').hidden = !text;
  $('noticeText').textContent = text;
  $('noticeAction').hidden = !label;
  $('noticeAction').textContent = label;
  noticeAction = action;
}
$('noticeAction').addEventListener('click', () => noticeAction?.());
$('noticeClose').addEventListener('click', () => showNotice(''));

// ---- Markdown export ------------------------------------------------------

const toMarkdown = $('toMarkdown');
const TO_MARKDOWN_LABEL = toMarkdown.textContent;

function resetToMarkdown() {
  toMarkdown.disabled = false;
  toMarkdown.textContent = TO_MARKDOWN_LABEL;
}

toMarkdown.addEventListener('click', async () => {
  if (!pdf) {
    return;
  }
  toMarkdown.disabled = true;
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      toMarkdown.textContent = `Reading ${number} / ${pdf.numPages}…`;
      const page = await pdf.getPage(number);
      pages.push(pageLines((await page.getTextContent()).items));
    }
    const markdown = linesToMarkdown(pages);
    // The extension asks where to save and answers with 'converted' when it is done.
    vscode.postMessage({ type: 'saveMarkdown', markdown });
  } catch (e) {
    resetToMarkdown();
    showMessage(`The text could not be extracted: ${e?.message ?? e}`);
  }
});

// ---- Messages -------------------------------------------------------------

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'source') {
    setDark(!!msg.dark);
    load(msg.src ?? msg.data, !!msg.unsaved);
  } else if (msg.type === 'converted') {
    resetToMarkdown();
  } else if (msg.type === 'dark') {
    setDark(!!msg.on);
  } else if (msg.type === 'save') {
    sendBytes(msg);
  } else if (msg.type === 'saved') {
    onSaved(msg.id);
  } else if (msg.type === 'changedOnDisk') {
    showNotice('This file has changed on disk. Your unsaved changes are kept; saving will replace the newer file.', 'Discard and Reload', () =>
      vscode.postMessage({ type: 'revert' }),
    );
  }
});

resetEditing();
vscode.postMessage({ type: 'ready' });
