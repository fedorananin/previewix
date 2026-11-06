// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  const stage = $('stage');
  /** @type {HTMLCanvasElement} */
  const canvas = $('view');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  /** @type {HTMLTextAreaElement} */
  const textInput = $('textInput');
  const colorInput = $('color');
  const lineWidthInput = $('lineWidth');
  const fontSizeInput = $('fontSize');
  const outlineInput = $('outline');

  const TEXT_FONT = 'system-ui, sans-serif';
  const LINE_HEIGHT = 1.25;
  const MAX_SCALE = 64;
  const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  /** The highlighter draws this many times wider than the line width, at this opacity, so text under it stays readable. */
  const MARKER_SCALE = 6;
  const MARKER_ALPHA = 0.4;
  /** Block size of the blur and pixelate tools, relative to their base unit, for strengths 1 to 5. */
  const STRENGTHS = [0.6, 0.8, 1, 1.5, 2.5];
  const DRAW_TOOLS = ['arrow', 'rect', 'ellipse', 'marker'];
  const REGION_TOOLS = ['blur', 'pixelate'];

  // ---- State --------------------------------------------------------------

  /** Current raster. Never mutated in place: a crop replaces it, which keeps undo snapshots cheap. */
  /** @type {HTMLCanvasElement | null} */
  let base = null;
  /** Arrows, shapes, highlighter strokes and texts, in image pixel coordinates. @type {any[]} */
  let items = [];
  /** @type {any} */
  let selected = null;
  /** Annotation being drawn. @type {any} */
  let draft = null;
  /** Area being dragged out with the blur or pixelate tool, in image coordinates. @type {{x0: number, y0: number, x1: number, y1: number} | null} */
  let region = null;
  /** Crop rectangle in image coordinates. @type {{x: number, y: number, w: number, h: number} | null} */
  let crop = null;
  /** Width / height the crop frame is locked to, or null for a free-form crop. @type {number | null} */
  let cropRatio = null;
  /** Whether the frame was placed by a ratio preset rather than drawn or adjusted by hand. */
  let cropIsPreset = false;
  /** Text item being edited in the textarea (hidden from the canvas meanwhile). @type {any} */
  let editing = null;
  /** @type {{x: number, y: number} | null} */
  let textAnchor = null;

  // screen = image * scale + offset, in CSS pixels relative to the stage
  const view = { scale: 1, x: 0, y: 0 };
  let tool = 'select';
  /** @type {any} */
  let drag = null;
  let spaceDown = false;
  let fileInfo = { name: '', ext: '', mime: '', size: 0 };
  /** The file as it arrived, kept to decode another of the pictures in it. @type {Uint8Array | null} */
  let fileBytes = null;
  /** The pictures the file holds (the sizes of an icon, the pages of a TIFF) and the one on screen. @type {{label: string, width: number, height: number}[]} */
  let pages = [];
  let pageIndex = 0;
  /** What the decoder did to the picture on its way to the screen, as rows for the info panel. @type {[string, string][]} */
  let decodeNotes = [];
  /** @type {any[]} */
  const undoStack = [];
  /** @type {any[]} */
  const redoStack = [];
  // Every edit gets a number of its own, and undo and redo bring the number back with the state.
  // Comparing it with the number of the last exported state tells whether something would be lost.
  let stateId = 0;
  let stateCount = 0;
  let cleanId = 0;
  /** Last position of the pointer over the canvas, in stage pixels. @type {{x: number, y: number} | null} */
  let hover = null;
  let folder = { index: -1, count: 0 };
  /** @type {{title: string, rows: [string, string][]}[]} */
  let sections = [];

  // ---- Helpers ------------------------------------------------------------

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const toImage = (s) => ({ x: (s.x - view.x) / view.scale, y: (s.y - view.y) / view.scale });
  const toScreen = (p) => ({ x: p.x * view.scale + view.x, y: p.y * view.scale + view.y });

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const kb = bytes / 1024;
    return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(2)} MB`;
  }

  /** Black or white, whichever reads better against `hex`. */
  function contrastColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return luminance > 0.6 ? '#000000' : '#ffffff';
  }

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000);
  }

  // ---- Drawing ------------------------------------------------------------

  const checker = (() => {
    const tile = makeCanvas(16, 16);
    const t = /** @type {CanvasRenderingContext2D} */ (tile.getContext('2d'));
    t.fillStyle = '#ffffff';
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = '#d9d9d9';
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
    return /** @type {CanvasPattern} */ (ctx.createPattern(tile, 'repeat'));
  })();

  const measureCtx = /** @type {CanvasRenderingContext2D} */ (makeCanvas(1, 1).getContext('2d'));
  const fontOf = (size) => `600 ${size}px ${TEXT_FONT}`;

  function textBox(item) {
    measureCtx.font = fontOf(item.size);
    const lines = item.text.split('\n');
    const w = Math.max(...lines.map((line) => measureCtx.measureText(line).width));
    return { x: item.x, y: item.y, w, h: lines.length * item.size * LINE_HEIGHT };
  }

  function drawArrow(c, a) {
    const dx = a.x2 - a.x1;
    const dy = a.y2 - a.y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) {
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    const head = Math.min(len, Math.max(a.width * 4, 10));
    const half = head * 0.45;
    const bx = a.x2 - ux * head;
    const by = a.y2 - uy * head;
    c.strokeStyle = c.fillStyle = a.color;
    c.lineWidth = a.width;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(a.x1, a.y1);
    c.lineTo(bx, by);
    c.stroke();
    c.beginPath();
    c.moveTo(a.x2, a.y2);
    c.lineTo(bx - uy * half, by + ux * half);
    c.lineTo(bx + uy * half, by - ux * half);
    c.closePath();
    c.fill();
  }

  function drawText(c, t) {
    const lineHeight = t.size * LINE_HEIGHT;
    const inset = (lineHeight - t.size) / 2;
    c.font = fontOf(t.size);
    c.textBaseline = 'top';
    const lines = t.text.split('\n');
    if (t.outline) {
      c.lineJoin = 'round';
      c.lineWidth = Math.max(2, t.size / 7);
      c.strokeStyle = contrastColor(t.color);
      lines.forEach((line, i) => c.strokeText(line, t.x, t.y + inset + i * lineHeight));
    }
    c.fillStyle = t.color;
    lines.forEach((line, i) => c.fillText(line, t.x, t.y + inset + i * lineHeight));
  }

  function drawRect(c, r) {
    c.strokeStyle = r.color;
    c.lineWidth = r.width;
    c.lineJoin = 'miter';
    c.strokeRect(r.x, r.y, r.w, r.h);
  }

  function drawEllipse(c, r) {
    c.strokeStyle = r.color;
    c.lineWidth = r.width;
    c.beginPath();
    c.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w) / 2, Math.abs(r.h) / 2, 0, 0, Math.PI * 2);
    c.stroke();
  }

  function drawMarker(c, m) {
    const pts = m.points;
    if (pts.length < 2) {
      return;
    }
    c.save();
    // One path stroked once: a stroke that crosses itself doesn't get darker there.
    c.globalAlpha = MARKER_ALPHA;
    c.strokeStyle = m.color;
    c.lineWidth = m.width * MARKER_SCALE;
    c.lineCap = 'butt';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    c.stroke();
    c.restore();
  }

  const DRAW = { arrow: drawArrow, text: drawText, rect: drawRect, ellipse: drawEllipse, marker: drawMarker };

  /** Draws annotations in image coordinates; shared by the viewport and the exporter. */
  function drawItems(c, list) {
    for (const item of list) {
      if (item !== editing) {
        DRAW[item.type](c, item);
      }
    }
  }

  // ---- Annotation geometry ------------------------------------------------

  /** Items that are reshaped through a box with eight handles. */
  const hasBox = (item) => item.type === 'rect' || item.type === 'ellipse' || item.type === 'marker';

  function boxOf(item) {
    if (item.type === 'text') {
      return textBox(item);
    }
    if (item.type === 'rect' || item.type === 'ellipse') {
      return { x: item.x, y: item.y, w: item.w, h: item.h };
    }
    const pts = item.type === 'arrow' ? [{ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 }] : item.points;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  /**
   * Moves an item to where `map` sends its points. `map` is a shift, a quarter turn or a mirror,
   * so boxes stay boxes. A text is not turned or mirrored itself: it stays readable and follows its centre.
   */
  function mapItem(item, map) {
    if (item.type === 'arrow') {
      const a = map({ x: item.x1, y: item.y1 });
      const b = map({ x: item.x2, y: item.y2 });
      Object.assign(item, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    } else if (item.type === 'marker') {
      // A new array: undo snapshots share the old one.
      item.points = item.points.map(map);
    } else if (item.type === 'text') {
      const box = textBox(item);
      const centre = map({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
      item.x = centre.x - box.w / 2;
      item.y = centre.y - box.h / 2;
    } else {
      Object.assign(item, mapRect(item, map));
    }
  }

  function mapRect(r, map) {
    const a = map({ x: r.x, y: r.y });
    const b = map({ x: r.x + r.w, y: r.y + r.h });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  const moveItem = (item, dx, dy) => mapItem(item, (p) => ({ x: p.x + dx, y: p.y + dy }));

  /** Stretches a boxed item from the box it had when the drag began to the edges l, t, r, b (which may have crossed). */
  function setBox(item, from, points, l, t, r, b) {
    if (item.type === 'marker') {
      const sx = from.w ? (r - l) / from.w : 1;
      const sy = from.h ? (b - t) / from.h : 1;
      item.points = points.map((p) => ({ x: l + (p.x - from.x) * sx, y: t + (p.y - from.y) * sy }));
    } else {
      Object.assign(item, { x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) });
    }
  }

  let frame = 0;
  function requestDraw() {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!base) {
      updateStatus();
      return;
    }

    ctx.fillStyle = checker;
    ctx.fillRect(view.x, view.y, base.width * view.scale, base.height * view.scale);

    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    // Show individual pixels when zoomed far in.
    ctx.imageSmoothingEnabled = view.scale < 4;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0);
    ctx.beginPath();
    ctx.rect(0, 0, base.width, base.height);
    ctx.clip();
    drawItems(ctx, draft ? [...items, draft] : items);
    ctx.restore();

    drawSelection();
    drawRegion();
    drawCrop(cw, ch);
    positionTextInput();
    updateOptions();
    updateStatus();
  }

  function drawRegion() {
    if (!region) {
      return;
    }
    const r = regionPixels();
    const a = toScreen(r);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, r.w * view.scale - 1, r.h * view.scale - 1);
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, r.w * view.scale - 1, r.h * view.scale - 1);
    ctx.restore();
  }

  const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

  /** Where a handle sits on a box, in the box's own coordinates. */
  function handlePoint(box, handle) {
    return {
      x: handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.w : box.x + box.w / 2,
      y: handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2,
    };
  }

  function drawSelection() {
    if (!selected || selected === editing) {
      return;
    }
    ctx.save();
    ctx.strokeStyle = '#3794ff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    if (selected.type === 'text') {
      const box = textBox(selected);
      const p = toScreen(box);
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(p.x - 4, p.y - 4, box.w * view.scale + 8, box.h * view.scale + 8);
    } else if (hasBox(selected)) {
      const box = boxOf(selected);
      const p = toScreen(box);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(p.x, p.y, box.w * view.scale, box.h * view.scale);
      ctx.restore();
      for (const handle of HANDLES) {
        const h = toScreen(handlePoint(box, handle));
        ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
        ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
      }
    } else {
      for (const end of [{ x: selected.x1, y: selected.y1 }, { x: selected.x2, y: selected.y2 }]) {
        const p = toScreen(end);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function cropScreen() {
    const c = /** @type {NonNullable<typeof crop>} */ (crop);
    const a = toScreen({ x: c.x, y: c.y });
    const b = toScreen({ x: c.x + c.w, y: c.y + c.h });
    return { l: a.x, t: a.y, r: b.x, b: b.y };
  }

  function drawCrop(cw, ch) {
    if (!crop) {
      return;
    }
    const r = cropScreen();
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, cw, r.t);
    ctx.fillRect(0, r.b, cw, ch - r.b);
    ctx.fillRect(0, r.t, r.l, r.b - r.t);
    ctx.fillRect(r.r, r.t, cw - r.r, r.b - r.t);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.l + 0.5, r.t + 0.5, r.r - r.l - 1, r.b - r.t - 1);
    ctx.fillStyle = '#ffffff';
    const xs = [r.l, (r.l + r.r) / 2, r.r];
    const ys = [r.t, (r.t + r.b) / 2, r.b];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i !== 1 || j !== 1) {
          ctx.fillRect(xs[i] - 4, ys[j] - 4, 8, 8);
        }
      }
    }
    const size = cropPixels();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${size.w} × ${size.h}`, r.l, Math.max(14, r.t - 6));
    ctx.restore();
  }

  function updateStatus() {
    if (!base) {
      // A picture that could not be decoded leaves nothing to report.
      for (const id of ['statSize', 'statZoom', 'statCursor', 'statShape']) {
        $(id).textContent = '';
      }
      $('statColor').hidden = true;
      return;
    }
    $('statSize').textContent =
      `${base.width} × ${base.height} px · ${formatBytes(fileInfo.size)} · ${fileInfo.ext.toUpperCase()}`;
    $('statZoom').textContent = `${Math.round(view.scale * 100)}%`;
    $('statShape').textContent = shapeStatus();
    updateProbe();
  }

  /** Size of whatever is being framed right now: the crop, an area, a shape or an arrow. */
  function shapeStatus() {
    const size = (w, h) => `${Math.round(Math.abs(w))} × ${Math.round(Math.abs(h))} px`;
    if (crop && crop.w >= 1 && crop.h >= 1) {
      const r = cropPixels();
      return `Crop ${size(r.w, r.h)}`;
    }
    if (region) {
      const r = regionPixels();
      return `Area ${size(r.w, r.h)}`;
    }
    const item = draft || (selected !== editing ? selected : null);
    if (item?.type === 'rect' || item?.type === 'ellipse') {
      return `Shape ${size(item.w, item.h)}`;
    }
    if (item?.type === 'arrow') {
      return `Arrow ${Math.round(Math.hypot(item.x2 - item.x1, item.y2 - item.y1))} px`;
    }
    return '';
  }

  // ---- Color under the pointer --------------------------------------------

  const probe = /** @type {CanvasRenderingContext2D} */ (makeCanvas(1, 1).getContext('2d', { willReadFrequently: true }));

  /**
   * The pixel of the composed image (raster plus annotations) under an image point.
   * Only that one pixel is composed, which is cheap enough to do on every pointer move.
   */
  function sampleAt(p) {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (!base || x < 0 || y < 0 || x >= base.width || y >= base.height) {
      return null;
    }
    probe.setTransform(1, 0, 0, 1, 0, 0);
    probe.clearRect(0, 0, 1, 1);
    probe.drawImage(base, x, y, 1, 1, 0, 0, 1, 1);
    probe.translate(-x, -y);
    drawItems(probe, items);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return { x, y, r, g, b, a, hex };
  }

  function updateProbe() {
    const pixel = hover && sampleAt(toImage(hover));
    $('statCursor').textContent = pixel ? `${pixel.x}, ${pixel.y}` : '';
    $('statColor').hidden = !pixel;
    if (pixel) {
      $('statSwatch').style.setProperty('--swatch', `rgba(${pixel.r}, ${pixel.g}, ${pixel.b}, ${pixel.a / 255})`);
      $('statColorText').textContent =
        `${pixel.hex} · rgb(${pixel.r}, ${pixel.g}, ${pixel.b}) · alpha ${Math.round((pixel.a / 255) * 100)}%`;
    }
  }

  function pickColor(p) {
    const pixel = sampleAt(p);
    if (!pixel) {
      return;
    }
    // A translucent pixel is copied with its alpha; the color control has none, so it takes the opaque color.
    const text = pixel.a < 255 ? pixel.hex + pixel.a.toString(16).padStart(2, '0') : pixel.hex;
    colorInput.value = pixel.hex;
    vscode.postMessage({ type: 'copy', text, what: 'color' });
    toast(`${text} copied and set as the annotation color`);
  }

  // ---- View ---------------------------------------------------------------

  function fit() {
    if (!base) {
      return;
    }
    const pad = 24;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    view.scale = Math.min((cw - pad * 2) / base.width, (ch - pad * 2) / base.height, 1);
    view.scale = Math.max(view.scale, 0.01);
    view.x = (cw - base.width * view.scale) / 2;
    view.y = (ch - base.height * view.scale) / 2;
    requestDraw();
  }

  function zoomAt(s, factor) {
    if (!base) {
      return;
    }
    const minScale = Math.min(0.05, 16 / Math.max(base.width, base.height));
    const next = clamp(view.scale * factor, minScale, MAX_SCALE);
    view.x = s.x - ((s.x - view.x) * next) / view.scale;
    view.y = s.y - ((s.y - view.y) * next) / view.scale;
    view.scale = next;
    requestDraw();
  }

  function zoomTo(scale) {
    const center = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
    zoomAt(center, scale / view.scale);
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Pinch gestures arrive as ctrl+wheel with small deltas, so they get a stronger factor.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(pointerPos(e), Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
    },
    { passive: false },
  );

  new ResizeObserver(requestDraw).observe(stage);

  // ---- Undo ---------------------------------------------------------------

  const snapshot = () => ({ base, items: items.map((item) => ({ ...item })), id: stateId });

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 100) {
      undoStack.shift();
    }
    stateId = ++stateCount;
    redoStack.length = 0;
    updateButtons();
  }

  function restore(state) {
    const resized = !base || base.width !== state.base.width || base.height !== state.base.height;
    base = state.base;
    items = state.items;
    stateId = state.id;
    selected = null;
    setCrop(null);
    if (resized) {
      baseResized();
    }
    updateButtons();
    requestDraw();
  }

  function undo() {
    const state = undoStack.pop();
    if (state) {
      redoStack.push(snapshot());
      restore(state);
    }
  }

  function redo() {
    const state = redoStack.pop();
    if (state) {
      undoStack.push(snapshot());
      restore(state);
    }
  }

  function updateButtons() {
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
  }

  function baseResized() {
    if (!base) {
      return;
    }
    $('outWidth').value = base.width;
    $('outHeight').value = base.height;
    if ($('cropRatio').value === 'original') {
      cropRatio = base.width / base.height;
    }
    fit();
  }

  // ---- Tools --------------------------------------------------------------

  function setTool(next) {
    commitText();
    if (next !== 'crop') {
      setCrop(null);
    }
    if (next !== 'select') {
      selected = null;
    }
    tool = next;
    updateCropBar();
    for (const button of document.querySelectorAll('#tools button')) {
      button.classList.toggle('active', /** @type {HTMLElement} */ (button).dataset.tool === tool);
    }
    updateStrength();
    updateCursor(null);
    requestDraw();
  }

  function updateCursor(s) {
    let cursor = 'default';
    if (drag?.kind === 'pan' || spaceDown) {
      cursor = drag ? 'grabbing' : 'grab';
    } else if (tool === 'crop') {
      const handle = s && cropHandleAt(s);
      cursor = handle ? CROP_CURSORS[handle] : 'crosshair';
    } else if (DRAW_TOOLS.includes(tool) || REGION_TOOLS.includes(tool) || tool === 'picker') {
      cursor = 'crosshair';
    } else if (tool === 'text') {
      cursor = 'text';
    } else if (s && boxHandleAt(toImage(s))) {
      cursor = CROP_CURSORS[boxHandleAt(toImage(s))];
    } else if (s && hitTest(toImage(s))) {
      cursor = 'move';
    }
    canvas.style.cursor = cursor;
  }

  function distanceToSegment(p, a) {
    const dx = a.x2 - a.x1;
    const dy = a.y2 - a.y1;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? clamp(((p.x - a.x1) * dx + (p.y - a.y1) * dy) / lengthSq, 0, 1) : 0;
    return Math.hypot(p.x - (a.x1 + t * dx), p.y - (a.y1 + t * dy));
  }

  function hitTest(p) {
    const slack = 6 / view.scale;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'text') {
        const box = textBox(item);
        if (p.x >= box.x - slack && p.x <= box.x + box.w + slack && p.y >= box.y - slack && p.y <= box.y + box.h + slack) {
          return item;
        }
      } else if (distanceTo(p, item) <= Math.max((item.type === 'marker' ? item.width * MARKER_SCALE : item.width) / 2, slack)) {
        return item;
      }
    }
    return null;
  }

  /** Distance from a point to the drawn line of an arrow, shape or highlighter stroke. Shapes are outlines, so their inside doesn't count. */
  function distanceTo(p, item) {
    if (item.type === 'arrow') {
      return distanceToSegment(p, item);
    }
    if (item.type === 'marker') {
      let best = Infinity;
      for (let i = 1; i < item.points.length; i++) {
        const a = item.points[i - 1];
        const b = item.points[i];
        best = Math.min(best, distanceToSegment(p, { x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      }
      return best;
    }
    const rx = item.w / 2;
    const ry = item.h / 2;
    if (item.type === 'ellipse' && rx > 0.5 && ry > 0.5) {
      // Measured along the ray from the centre, which is close enough to the true distance for picking.
      const dx = p.x - item.x - rx;
      const dy = p.y - item.y - ry;
      const k = Math.hypot(dx / rx, dy / ry);
      return k ? Math.hypot(dx, dy) * Math.abs(1 - 1 / k) : Math.min(rx, ry);
    }
    const outX = Math.max(item.x - p.x, 0, p.x - item.x - item.w);
    const outY = Math.max(item.y - p.y, 0, p.y - item.y - item.h);
    if (outX || outY) {
      return Math.hypot(outX, outY);
    }
    return Math.min(p.x - item.x, item.x + item.w - p.x, p.y - item.y, item.y + item.h - p.y);
  }

  /** Which handle of the selected shape or stroke is under the pointer, if any. */
  function boxHandleAt(p) {
    if (!selected || !hasBox(selected) || tool !== 'select') {
      return null;
    }
    const box = boxOf(selected);
    const slack = 7 / view.scale;
    return HANDLES.find((handle) => {
      const h = handlePoint(box, handle);
      return Math.abs(p.x - h.x) <= slack && Math.abs(p.y - h.y) <= slack;
    }) || null;
  }

  /** Which end of the selected arrow is under the pointer, if any. */
  function arrowEndAt(p) {
    if (selected?.type !== 'arrow') {
      return 0;
    }
    const slack = 8 / view.scale;
    if (Math.hypot(p.x - selected.x2, p.y - selected.y2) <= slack) {
      return 2;
    }
    return Math.hypot(p.x - selected.x1, p.y - selected.y1) <= slack ? 1 : 0;
  }

  function select(item) {
    selected = item;
    if (item) {
      colorInput.value = item.color;
      if (item.type !== 'text') {
        lineWidthInput.value = item.width;
      } else {
        fontSizeInput.value = item.size;
        outlineInput.checked = item.outline;
      }
    }
  }

  /** Keeps the angle of a line being drawn to multiples of 45° while Shift is held. */
  function snapAngle(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const length = Math.hypot(dx, dy);
    return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
  }

  // ---- Crop ---------------------------------------------------------------

  const CROP_CURSORS = {
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'move',
  };

  function setCrop(rect) {
    crop = rect;
    updateCropBar();
  }

  function updateCropBar() {
    const empty = !crop || crop.w < 1 || crop.h < 1;
    $('cropActions').hidden = tool !== 'crop';
    $('cropApply').disabled = empty;
    $('cropCancel').disabled = empty;
  }

  /** Crop of the locked ratio stretching from a fixed anchor point towards `p`, kept inside the image. */
  function setCropFromAnchor(anchor, p) {
    if (!base || !cropRatio) {
      return;
    }
    const ax = clamp(anchor.x, 0, base.width);
    const ay = clamp(anchor.y, 0, base.height);
    const right = p.x >= ax;
    const down = p.y >= ay;
    // The pointer sets whichever dimension it has pulled further, the other follows the ratio.
    let w = Math.abs(p.x - ax);
    let h = Math.abs(p.y - ay);
    if (w / cropRatio > h) {
      h = w / cropRatio;
    } else {
      w = h * cropRatio;
    }
    const scale = Math.min(1, (right ? base.width - ax : ax) / (w || 1), (down ? base.height - ay : ay) / (h || 1));
    w *= scale;
    h *= scale;
    setCrop({ x: right ? ax : ax - w, y: down ? ay : ay - h, w, h });
  }

  /** Dragging an edge handle with a locked ratio: the opposite edge stays put and the frame grows around its middle. */
  function setCropFromEdge(handle, edges, p) {
    if (!base || !cropRatio) {
      return;
    }
    if (handle === 'n' || handle === 's') {
      const anchor = handle === 'n' ? edges.b : edges.t;
      const center = (edges.l + edges.r) / 2;
      const down = p.y >= anchor;
      let h = Math.min(Math.abs(p.y - anchor), down ? base.height - anchor : anchor);
      const w = Math.min(h * cropRatio, 2 * Math.min(center, base.width - center));
      h = w / cropRatio;
      setCrop({ x: center - w / 2, y: down ? anchor : anchor - h, w, h });
    } else {
      const anchor = handle === 'w' ? edges.r : edges.l;
      const center = (edges.t + edges.b) / 2;
      const right = p.x >= anchor;
      let w = Math.min(Math.abs(p.x - anchor), right ? base.width - anchor : anchor);
      const h = Math.min(w / cropRatio, 2 * Math.min(center, base.height - center));
      w = h * cropRatio;
      setCrop({ x: right ? anchor : anchor - w, y: center - h / 2, w, h });
    }
  }

  /** Reads the ratio controls. A frame that already exists is reshaped; otherwise the largest one that fits is offered. */
  function updateCropRatio() {
    const choice = $('cropRatio').value;
    $('cropCustom').hidden = choice !== 'custom';
    if (choice === 'free' || !base) {
      cropRatio = null;
      return;
    }
    if (choice === 'original') {
      cropRatio = base.width / base.height;
    } else {
      const [w, h] = choice === 'custom' ? [$('cropRatioW').value, $('cropRatioH').value] : choice.split(':');
      const ratio = Number(w) / Number(h);
      if (!(ratio > 0) || !Number.isFinite(ratio)) {
        return;
      }
      cropRatio = ratio;
    }
    // A frame the user has drawn or adjusted keeps its place and width; a preset one is simply replaced.
    const has = crop && crop.w >= 1 && crop.h >= 1 && !cropIsPreset;
    let w = has ? crop.w : base.width;
    let h = w / cropRatio;
    const scale = Math.min(1, base.width / w, base.height / h);
    w *= scale;
    h *= scale;
    const cx = has ? crop.x + crop.w / 2 : base.width / 2;
    const cy = has ? crop.y + crop.h / 2 : base.height / 2;
    setCrop({ x: clamp(cx - w / 2, 0, base.width - w), y: clamp(cy - h / 2, 0, base.height - h), w, h });
    cropIsPreset = !has;
    requestDraw();
  }

  function setCropEdges(l, t, r, b) {
    if (!base) {
      return;
    }
    const x0 = clamp(Math.min(l, r), 0, base.width);
    const x1 = clamp(Math.max(l, r), 0, base.width);
    const y0 = clamp(Math.min(t, b), 0, base.height);
    const y1 = clamp(Math.max(t, b), 0, base.height);
    setCrop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  /** The crop rectangle snapped to whole pixels. */
  function cropPixels() {
    const c = /** @type {NonNullable<typeof crop>} */ (crop);
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    if (cropRatio && base) {
      // Rounding the two sides independently could leave the ratio a pixel off.
      const w = Math.max(1, Math.min(Math.round(c.w), base.width - x));
      const h = clamp(Math.round(w / cropRatio), 1, base.height);
      return { x, y: Math.min(y, base.height - h), w, h };
    }
    return { x, y, w: Math.round(c.x + c.w) - x, h: Math.round(c.y + c.h) - y };
  }

  function cropHandleAt(s) {
    if (!crop) {
      return null;
    }
    const r = cropScreen();
    const tol = 8;
    const inX = s.x >= r.l - tol && s.x <= r.r + tol;
    const inY = s.y >= r.t - tol && s.y <= r.b + tol;
    let handle = '';
    if (inX && Math.abs(s.y - r.t) <= tol) {
      handle += 'n';
    } else if (inX && Math.abs(s.y - r.b) <= tol) {
      handle += 's';
    }
    if (inY && Math.abs(s.x - r.l) <= tol) {
      handle += 'w';
    } else if (inY && Math.abs(s.x - r.r) <= tol) {
      handle += 'e';
    }
    if (handle) {
      return handle;
    }
    return s.x > r.l && s.x < r.r && s.y > r.t && s.y < r.b ? 'move' : null;
  }

  function applyCrop() {
    if (!base || !crop) {
      return;
    }
    const r = cropPixels();
    if (r.w < 1 || r.h < 1) {
      return;
    }
    pushUndo();
    const next = makeCanvas(r.w, r.h);
    /** @type {CanvasRenderingContext2D} */ (next.getContext('2d')).drawImage(base, -r.x, -r.y);
    base = next;
    for (const item of items) {
      moveItem(item, -r.x, -r.y);
    }
    setCrop(null);
    baseResized();
  }

  // ---- Rotate and flip ----------------------------------------------------

  // Canvas matrices (a, b, c, d, e, f) for an image of w × h, and the same mapping for single points.
  const TRANSFORMS = {
    right: { turn: true, matrix: (w, h) => [0, 1, -1, 0, h, 0], map: (w, h) => (p) => ({ x: h - p.y, y: p.x }) },
    left: { turn: true, matrix: (w, h) => [0, -1, 1, 0, 0, w], map: (w, h) => (p) => ({ x: p.y, y: w - p.x }) },
    horizontal: { turn: false, matrix: (w, h) => [-1, 0, 0, 1, w, 0], map: (w, h) => (p) => ({ x: w - p.x, y: p.y }) },
    vertical: { turn: false, matrix: (w, h) => [1, 0, 0, -1, 0, h], map: (w, h) => (p) => ({ x: p.x, y: h - p.y }) },
  };

  /** Turns or mirrors the raster together with everything placed on it: annotations and the crop frame. */
  function transform(kind) {
    if (!base) {
      return;
    }
    commitText();
    const { turn, matrix, map } = TRANSFORMS[kind];
    const w = base.width;
    const h = base.height;
    pushUndo();
    const next = turn ? makeCanvas(h, w) : makeCanvas(w, h);
    const c = /** @type {CanvasRenderingContext2D} */ (next.getContext('2d'));
    c.setTransform(...matrix(w, h));
    c.drawImage(base, 0, 0);
    base = next;
    const point = map(w, h);
    for (const item of items) {
      mapItem(item, point);
    }
    const frame = crop && mapRect(crop, point);
    if (turn) {
      turnCropRatio();
      // Refits the view, since the sides have swapped.
      baseResized();
    }
    if (frame) {
      setCrop(frame);
    }
    requestDraw();
  }

  /** After a quarter turn a locked 16:9 frame is a 9:16 one. */
  function turnCropRatio() {
    const choice = $('cropRatio').value;
    if (choice === 'free' || choice === 'original') {
      return;
    }
    const [w, h] = choice === 'custom' ? [$('cropRatioW').value, $('cropRatioH').value] : choice.split(':');
    const turned = `${h}:${w}`;
    if (choice !== 'custom' && [...$('cropRatio').options].some((option) => option.value === turned)) {
      $('cropRatio').value = turned;
    } else {
      $('cropRatio').value = 'custom';
      $('cropRatioW').value = h;
      $('cropRatioH').value = w;
      $('cropCustom').hidden = false;
    }
    if (cropRatio) {
      cropRatio = 1 / cropRatio;
    }
  }

  // ---- Blur and pixelate --------------------------------------------------

  /**
   * Block size in pixels for the current strength. These tools hide private data, so the size
   * follows the image: on a larger screenshot the text is larger too, and a block has to stay
   * about as tall as a line of text for the content to be gone rather than just softened.
   */
  function blockSize() {
    const longest = base ? Math.max(base.width, base.height) : 0;
    const unit = Math.max(16, Math.round(longest / 80));
    return Math.round(unit * STRENGTHS[clamp(Number($('strength').value), 1, 5) - 1]);
  }

  function updateStrength() {
    $('strengthValue').textContent = `${blockSize()} px`;
  }

  /** The dragged area snapped to whole pixels inside the image. */
  function regionPixels() {
    const r = /** @type {NonNullable<typeof region>} */ (region);
    const b = /** @type {HTMLCanvasElement} */ (base);
    const x = clamp(Math.floor(Math.min(r.x0, r.x1)), 0, b.width);
    const y = clamp(Math.floor(Math.min(r.y0, r.y1)), 0, b.height);
    return {
      x,
      y,
      w: clamp(Math.ceil(Math.max(r.x0, r.x1)), 0, b.width) - x,
      h: clamp(Math.ceil(Math.max(r.y0, r.y1)), 0, b.height) - y,
    };
  }

  /**
   * Replaces every block × block cell of the pixels with its average color. The average is the
   * step that throws the content away; a little noise on top keeps a cell from being matched
   * exactly against renderings of guessed text.
   */
  function mosaic(image, block) {
    const { data, width, height } = image;
    for (let by = 0; by < height; by += block) {
      for (let bx = 0; bx < width; bx += block) {
        const x1 = Math.min(bx + block, width);
        const y1 = Math.min(by + block, height);
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let y = by; y < y1; y++) {
          for (let i = (y * width + bx) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
            // Weighted by alpha, so transparent pixels don't drag the color towards black.
            const alpha = data[i + 3];
            r += data[i] * alpha;
            g += data[i + 1] * alpha;
            b += data[i + 2] * alpha;
            a += alpha;
          }
        }
        const count = (x1 - bx) * (y1 - by);
        const noise = () => (a ? Math.round((Math.random() - 0.5) * 6) : 0);
        const cr = a ? clamp(Math.round(r / a) + noise(), 0, 255) : 0;
        const cg = a ? clamp(Math.round(g / a) + noise(), 0, 255) : 0;
        const cb = a ? clamp(Math.round(b / a) + noise(), 0, 255) : 0;
        const ca = Math.round(a / count);
        for (let y = by; y < y1; y++) {
          for (let i = (y * width + bx) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
            data[i] = cr;
            data[i + 1] = cg;
            data[i + 2] = cb;
            data[i + 3] = ca;
          }
        }
      }
    }
  }

  /** Blurs or pixelates the dragged area of the raster. The result is a new `base`; annotations stay above it. */
  function applyRegion(kind) {
    if (!base || !region) {
      return;
    }
    const r = regionPixels();
    if (r.w < 1 || r.h < 1) {
      return;
    }
    const block = blockSize();
    pushUndo();
    const next = makeCanvas(base.width, base.height);
    const c = /** @type {CanvasRenderingContext2D} */ (next.getContext('2d'));
    c.drawImage(base, 0, 0);
    const pixels = c.getImageData(r.x, r.y, r.w, r.h);
    if (kind === 'pixelate') {
      mosaic(pixels, block);
      c.putImageData(pixels, r.x, r.y);
    } else {
      // A Gaussian blur alone can be sharpened back to a degree. Averaging first removes the
      // detail for good, and the blur then only smooths the cells away.
      const cell = Math.max(2, Math.round(block * 0.75));
      mosaic(pixels, cell);
      // The area is blurred on its own, with its edge pixels repeated outwards, so nothing from
      // around it bleeds in and its rim doesn't fade towards transparent.
      const pad = cell * 3;
      const padded = makeCanvas(r.w + pad * 2, r.h + pad * 2);
      const pc = /** @type {CanvasRenderingContext2D} */ (padded.getContext('2d'));
      pc.putImageData(pixels, pad, pad);
      pc.imageSmoothingEnabled = false;
      pc.drawImage(padded, pad, pad, r.w, 1, pad, 0, r.w, pad);
      pc.drawImage(padded, pad, pad + r.h - 1, r.w, 1, pad, pad + r.h, r.w, pad);
      pc.drawImage(padded, pad, 0, 1, padded.height, 0, 0, pad, padded.height);
      pc.drawImage(padded, pad + r.w - 1, 0, 1, padded.height, pad + r.w, 0, pad, padded.height);
      const blurred = makeCanvas(r.w, r.h);
      const bc = /** @type {CanvasRenderingContext2D} */ (blurred.getContext('2d'));
      bc.filter = `blur(${cell}px)`;
      bc.drawImage(padded, -pad, -pad);
      c.clearRect(r.x, r.y, r.w, r.h);
      c.drawImage(blurred, r.x, r.y);
    }
    base = next;
  }

  // ---- Text ---------------------------------------------------------------

  function startText(p, existing) {
    editing = existing || null;
    textAnchor = existing ? { x: existing.x, y: existing.y } : p;
    textInput.value = existing ? existing.text : '';
    textInput.hidden = false;
    positionTextInput();
    textInput.focus();
    requestDraw();
  }

  function positionTextInput() {
    if (textInput.hidden || !textAnchor) {
      return;
    }
    const s = toScreen(textAnchor);
    const size = editing ? editing.size : Number(fontSizeInput.value);
    // -1 compensates for the dashed border so the glyphs land where they will be drawn.
    textInput.style.left = `${s.x - 1}px`;
    textInput.style.top = `${s.y - 1}px`;
    textInput.style.fontSize = `${size * view.scale}px`;
    textInput.style.color = editing ? editing.color : colorInput.value;
  }

  function commitText(cancel = false) {
    if (textInput.hidden) {
      return;
    }
    const text = textInput.value.replace(/\s+$/, '');
    const existing = editing;
    const anchor = textAnchor;
    textInput.hidden = true;
    editing = null;
    textAnchor = null;
    if (!cancel && existing && text !== existing.text) {
      pushUndo();
      if (text) {
        existing.text = text;
      } else {
        items = items.filter((item) => item !== existing);
        selected = null;
      }
    } else if (!cancel && !existing && text && anchor) {
      pushUndo();
      items.push({
        type: 'text',
        x: anchor.x,
        y: anchor.y,
        text,
        color: colorInput.value,
        size: Number(fontSizeInput.value),
        outline: outlineInput.checked,
      });
    }
    requestDraw();
  }

  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      commitText(true);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    }
  });
  textInput.addEventListener('blur', () => commitText());

  // ---- Pointer input ------------------------------------------------------

  // Keeps focus (e.g. in the text box) from moving on click; the handlers below manage it explicitly.
  canvas.addEventListener('mousedown', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (!base) {
      return;
    }
    const wasEditing = !textInput.hidden;
    commitText();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const s = pointerPos(e);
    const p = toImage(s);
    canvas.setPointerCapture(e.pointerId);

    if (e.button === 1 || spaceDown) {
      drag = { kind: 'pan', last: s };
    } else if (e.button !== 0) {
      return;
    } else if (tool === 'select') {
      const end = arrowEndAt(p);
      const handle = boxHandleAt(p);
      const hit = end || handle ? selected : hitTest(p);
      select(hit);
      if (end) {
        drag = { kind: 'end', end, moved: false };
      } else if (handle) {
        drag = { kind: 'box', handle, box: boxOf(selected), points: selected.points, moved: false };
      } else {
        drag = hit ? { kind: 'move', last: p, moved: false } : { kind: 'pan', last: s };
      }
    } else if (DRAW_TOOLS.includes(tool)) {
      const style = { color: colorInput.value, width: clamp(Number(lineWidthInput.value) || 1, 1, 200) };
      if (tool === 'arrow') {
        draft = { type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...style };
      } else if (tool === 'marker') {
        draft = { type: 'marker', points: [p], ...style };
      } else {
        draft = { type: tool, x: p.x, y: p.y, w: 0, h: 0, ...style };
      }
      drag = { kind: tool === 'arrow' || tool === 'marker' ? tool : 'shape', start: p };
    } else if (REGION_TOOLS.includes(tool)) {
      region = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      drag = { kind: 'region', tool };
    } else if (tool === 'picker') {
      pickColor(p);
    } else if (tool === 'text') {
      // A click while typing only commits the current text.
      if (!wasEditing) {
        startText(p, hitTest(p)?.type === 'text' ? hitTest(p) : null);
      }
    } else if (tool === 'crop') {
      const handle = cropHandleAt(s);
      cropIsPreset = false;
      if (handle && crop) {
        drag = { kind: 'crop', handle, start: p, edges: { l: crop.x, t: crop.y, r: crop.x + crop.w, b: crop.y + crop.h } };
      } else {
        drag = { kind: 'crop', handle: 'new', start: p };
        cropRatio ? setCropFromAnchor(p, p) : setCropEdges(p.x, p.y, p.x, p.y);
      }
    }
    updateCursor(s);
    requestDraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!base) {
      return;
    }
    const s = pointerPos(e);
    const p = toImage(s);
    hover = s;
    if (!drag) {
      updateCursor(s);
      updateProbe();
      return;
    }
    switch (drag.kind) {
      case 'pan':
        view.x += s.x - drag.last.x;
        view.y += s.y - drag.last.y;
        drag.last = s;
        break;
      case 'move': {
        const dx = p.x - drag.last.x;
        const dy = p.y - drag.last.y;
        if (!drag.moved && Math.hypot(dx, dy) * view.scale < 3) {
          return;
        }
        if (!drag.moved) {
          pushUndo();
          drag.moved = true;
        }
        moveItem(selected, dx, dy);
        drag.last = p;
        break;
      }
      case 'box': {
        if (!drag.moved) {
          pushUndo();
          drag.moved = true;
        }
        const from = drag.box;
        const has = (side) => drag.handle.includes(side);
        setBox(
          selected,
          from,
          drag.points,
          has('w') ? p.x : from.x,
          has('n') ? p.y : from.y,
          has('e') ? p.x : from.x + from.w,
          has('s') ? p.y : from.y + from.h,
        );
        break;
      }
      case 'shape': {
        let w = p.x - drag.start.x;
        let h = p.y - drag.start.y;
        if (e.shiftKey) {
          // Shift makes it a square or a circle.
          const side = Math.max(Math.abs(w), Math.abs(h));
          w = w < 0 ? -side : side;
          h = h < 0 ? -side : side;
        }
        Object.assign(draft, { w, h });
        break;
      }
      case 'marker': {
        const last = draft.points[draft.points.length - 1];
        if (e.shiftKey) {
          // Shift gives a straight stroke, which is what underlining a line of text needs.
          draft.points = [drag.start, snapAngle(drag.start, p)];
        } else if (Math.hypot(p.x - last.x, p.y - last.y) * view.scale >= 2) {
          draft.points = [...draft.points, p];
        }
        break;
      }
      case 'region':
        Object.assign(region, { x1: p.x, y1: p.y });
        break;
      case 'end': {
        if (!drag.moved) {
          pushUndo();
          drag.moved = true;
        }
        const other = drag.end === 1 ? { x: selected.x2, y: selected.y2 } : { x: selected.x1, y: selected.y1 };
        const q = e.shiftKey ? snapAngle(other, p) : p;
        selected[`x${drag.end}`] = q.x;
        selected[`y${drag.end}`] = q.y;
        break;
      }
      case 'arrow': {
        const q = e.shiftKey ? snapAngle({ x: draft.x1, y: draft.y1 }, p) : p;
        draft.x2 = q.x;
        draft.y2 = q.y;
        break;
      }
      case 'crop': {
        const c = /** @type {NonNullable<typeof crop>} */ (crop);
        if (drag.handle === 'new') {
          cropRatio ? setCropFromAnchor(drag.start, p) : setCropEdges(drag.start.x, drag.start.y, p.x, p.y);
        } else if (drag.handle === 'move') {
          const w = drag.edges.r - drag.edges.l;
          const h = drag.edges.b - drag.edges.t;
          const x = clamp(drag.edges.l + p.x - drag.start.x, 0, base.width - w);
          const y = clamp(drag.edges.t + p.y - drag.start.y, 0, base.height - h);
          setCrop({ x, y, w: c.w, h: c.h });
        } else if (cropRatio && drag.handle.length === 2) {
          // A corner handle pivots around the opposite corner.
          const anchor = {
            x: drag.handle.includes('w') ? drag.edges.r : drag.edges.l,
            y: drag.handle.includes('n') ? drag.edges.b : drag.edges.t,
          };
          setCropFromAnchor(anchor, p);
        } else if (cropRatio) {
          setCropFromEdge(drag.handle, drag.edges, p);
        } else {
          const edges = { ...drag.edges };
          if (drag.handle.includes('n')) {
            edges.t = p.y;
          }
          if (drag.handle.includes('s')) {
            edges.b = p.y;
          }
          if (drag.handle.includes('w')) {
            edges.l = p.x;
          }
          if (drag.handle.includes('e')) {
            edges.r = p.x;
          }
          setCropEdges(edges.l, edges.t, edges.r, edges.b);
        }
        break;
      }
    }
    requestDraw();
  });

  function endDrag(e) {
    if (!drag) {
      return;
    }
    if (draft) {
      // A click without a drag leaves nothing behind.
      const box = boxOf(draft);
      if (Math.hypot(box.w, box.h) * view.scale >= 4) {
        if (draft.type === 'rect' || draft.type === 'ellipse') {
          Object.assign(draft, { x: box.w < 0 ? box.x + box.w : box.x, y: box.h < 0 ? box.y + box.h : box.y, w: Math.abs(box.w), h: Math.abs(box.h) });
        }
        pushUndo();
        items.push(draft);
      }
      draft = null;
    } else if (drag.kind === 'region' && region) {
      const r = regionPixels();
      if (Math.min(r.w, r.h) * view.scale >= 3) {
        applyRegion(drag.tool);
      }
      region = null;
    } else if (drag.kind === 'crop' && crop && (crop.w < 1 || crop.h < 1)) {
      setCrop(null);
    }
    drag = null;
    updateCursor(pointerPos(e));
    requestDraw();
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    updateProbe();
  });

  canvas.addEventListener('dblclick', (e) => {
    if (!base || tool !== 'select') {
      return;
    }
    const hit = hitTest(toImage(pointerPos(e)));
    if (hit?.type === 'text') {
      select(hit);
      startText(null, hit);
    } else if (!hit) {
      Math.abs(view.scale - 1) < 0.001 ? fit() : zoomAt(pointerPos(e), 1 / view.scale);
    }
  });

  // ---- Toolbar ------------------------------------------------------------

  for (const button of document.querySelectorAll('#tools button')) {
    button.addEventListener('click', () => setTool(/** @type {HTMLElement} */ (button).dataset.tool));
  }
  $('cropApply').addEventListener('click', applyCrop);
  for (const id of ['cropRatio', 'cropRatioW', 'cropRatioH']) {
    $(id).addEventListener('change', updateCropRatio);
  }
  $('cropCancel').addEventListener('click', () => {
    setCrop(null);
    requestDraw();
  });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('zoomFit').addEventListener('click', fit);
  $('zoomActual').addEventListener('click', () => zoomTo(1));
  $('rotateLeft').addEventListener('click', () => transform('left'));
  $('rotateRight').addEventListener('click', () => transform('right'));
  $('flipH').addEventListener('click', () => transform('horizontal'));
  $('flipV').addEventListener('click', () => transform('vertical'));
  $('prev').addEventListener('click', () => navigate(-1));
  $('next').addEventListener('click', () => navigate(1));
  $('strength').addEventListener('input', updateStrength);

  // A button that keeps the focus after a click would be pressed again by Space (pan) and Enter (apply crop).
  $('toolbar').addEventListener('click', (e) => {
    const button = /** @type {HTMLElement} */ (e.target).closest('button');
    if (button && e.detail > 0) {
      button.blur();
    }
  });

  /** Shows the controls that matter for the current tool or the selected annotation. */
  function updateOptions() {
    const type = selected ? selected.type : tool;
    const line = DRAW_TOOLS.includes(type);
    const text = type === 'text';
    const strength = REGION_TOOLS.includes(tool);
    $('lineRow').hidden = !line;
    $('fontRow').hidden = !text;
    $('outlineRow').hidden = !text;
    $('strengthRow').hidden = !strength;
    $('toolOptions').hidden = tool === 'crop' || !(line || text || strength);
  }

  // ---- Browsing the folder ------------------------------------------------

  function updateFolder() {
    const known = folder.count > 0 && folder.index >= 0;
    $('position').textContent = known ? `${folder.index + 1} / ${folder.count}` : '';
    $('prev').disabled = $('next').disabled = folder.count < 2;
  }

  function navigate(delta) {
    if (folder.count < 2) {
      return;
    }
    commitText();
    // The provider asks before leaving edits behind: a webview can't show a confirmation itself.
    vscode.postMessage({ type: 'navigate', delta, dirty: stateId !== cleanId });
  }

  // ---- Image info ---------------------------------------------------------

  function setInfoOpen(open) {
    document.body.classList.toggle('info-open', open);
    $('infoToggle').classList.toggle('active', open);
    $('infoToggle').setAttribute('aria-expanded', String(open));
  }

  function toggleInfo() {
    const open = !document.body.classList.contains('info-open');
    setInfoOpen(open);
    // The provider remembers it, so the panel stays open in the next image of the folder.
    vscode.postMessage({ type: 'infoOpen', open });
  }
  $('infoToggle').addEventListener('click', toggleInfo);
  $('closeInfo').addEventListener('click', toggleInfo);

  /** The provider's sections, read from the file, followed by what the decoder says about the picture on screen. */
  function infoSections() {
    const rows = [...decodeNotes];
    if (pages.length > 1) {
      rows.unshift(['Picture', `${pages[pageIndex].label} (${pageIndex + 1} of ${pages.length})`]);
    }
    return rows.length ? [...sections, { title: 'On screen', rows }] : sections;
  }

  function renderInfo() {
    const root = $('sections');
    root.textContent = '';
    for (const section of infoSections()) {
      const title = document.createElement('h3');
      title.textContent = section.title;
      const list = document.createElement('dl');
      for (const [label, value] of section.rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
      }
      root.append(title, list);
    }
  }

  $('copyInfo').addEventListener('click', () => {
    const text = infoSections()
      .map((s) => `${s.title}\n${s.rows.map(([label, value]) => `  ${label}: ${value}`).join('\n')}`)
      .join('\n\n');
    vscode.postMessage({ type: 'copy', text, what: 'info' });
  });
  $('openMap').addEventListener('click', () => vscode.postMessage({ type: 'openMap' }));

  // Style controls also restyle the selected annotation. Dragging in the color
  // picker fires many `input` events, which should collapse into one undo step.
  let colorUndoPushed = false;
  colorInput.addEventListener('input', () => {
    if (selected) {
      if (!colorUndoPushed) {
        pushUndo();
        colorUndoPushed = true;
      }
      selected.color = colorInput.value;
    }
    requestDraw();
  });
  colorInput.addEventListener('change', () => (colorUndoPushed = false));

  function bindStyle(input, type, apply) {
    input.addEventListener('change', () => {
      if (selected && (selected.type === 'text') === (type === 'text')) {
        pushUndo();
        apply(selected);
      }
      requestDraw();
    });
  }
  bindStyle(lineWidthInput, 'line', (item) => (item.width = clamp(Number(lineWidthInput.value) || 1, 1, 200)));
  bindStyle(fontSizeInput, 'text', (item) => (item.size = clamp(Number(fontSizeInput.value) || 6, 6, 1000)));
  bindStyle(outlineInput, 'text', (item) => (item.outline = outlineInput.checked));

  function deleteSelected() {
    if (selected) {
      pushUndo();
      items = items.filter((item) => item !== selected);
      selected = null;
      requestDraw();
    }
  }

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
    const mod = e.metaKey || e.ctrlKey;
    let key = e.key.toLowerCase();
    // On a keyboard layout without Latin letters the shortcuts go by the position of the key.
    if (key.length === 1 && key > '\x7f' && /^Key[A-Z]$/.test(e.code)) {
      key = e.code.slice(3).toLowerCase();
    }
    if (mod && key === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      toggleExport(true);
    } else if (e.key === 'Escape') {
      if (!$('exportPanel').hidden) {
        toggleExport(false);
      } else if (crop) {
        setCrop(null);
      } else {
        selected = null;
      }
      // A shape or an area that is still being dragged out is abandoned as well.
      if (draft || region) {
        draft = region = drag = null;
      }
      requestDraw();
    } else if (typing || mod || e.altKey) {
      return;
    } else if (e.key === ' ') {
      e.preventDefault();
      spaceDown = true;
      updateCursor(null);
    } else if (e.key === 'Enter' && crop) {
      applyCrop();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelected();
    } else if (key === '0') {
      fit();
    } else if (key === '1') {
      zoomTo(1);
    } else if (key === '+' || key === '=') {
      zoomTo(view.scale * 1.25);
    } else if (key === '-') {
      zoomTo(view.scale / 1.25);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      arrowKey(e.key, e.shiftKey ? 10 : 1);
    } else if ((e.key === 'PageUp' || e.key === 'PageDown') && pages.length > 1) {
      e.preventDefault();
      choosePage(pageIndex + (e.key === 'PageDown' ? 1 : -1));
    } else if (key === 'i') {
      toggleInfo();
    } else if (e.shiftKey) {
      const kind = { l: 'left', r: 'right', h: 'horizontal', v: 'vertical' }[key];
      if (kind) {
        e.preventDefault();
        transform(kind);
      }
    } else {
      const shortcut = {
        v: 'select', c: 'crop', a: 'arrow', t: 'text',
        r: 'rect', e: 'ellipse', h: 'marker', b: 'blur', p: 'pixelate', d: 'picker',
      }[key];
      if (shortcut) {
        e.preventDefault();
        setTool(shortcut);
      }
    }
  });

  let nudged = null;
  let nudgeState = -1;

  /** The arrow keys move what is selected, or the crop frame; with neither they step through the folder. */
  function arrowKey(name, step) {
    const dx = name === 'ArrowLeft' ? -step : name === 'ArrowRight' ? step : 0;
    const dy = name === 'ArrowUp' ? -step : name === 'ArrowDown' ? step : 0;
    if (selected) {
      // A run of key presses on one item is a single undo step.
      if (nudged !== selected || nudgeState !== stateId) {
        pushUndo();
        nudged = selected;
        nudgeState = stateId;
      }
      moveItem(selected, dx, dy);
      requestDraw();
    } else if (crop && base) {
      setCrop({ ...crop, x: clamp(crop.x + dx, 0, base.width - crop.w), y: clamp(crop.y + dy, 0, base.height - crop.h) });
      cropIsPreset = false;
      requestDraw();
    } else if (dx) {
      navigate(dx);
    }
  }

  document.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      updateCursor(null);
    }
  });

  // ---- Export -------------------------------------------------------------

  function toggleExport(show) {
    $('exportPanel').hidden = !show;
    $('exportToggle').classList.toggle('active', show);
  }
  $('exportToggle').addEventListener('click', () => toggleExport($('exportPanel').hidden));

  function updateQualityRow() {
    $('qualityRow').hidden = $('format').value === 'png';
    $('qualityValue').textContent = $('quality').value;
  }
  $('format').addEventListener('change', updateQualityRow);
  $('quality').addEventListener('input', updateQualityRow);

  $('outWidth').addEventListener('input', () => {
    if (base && $('lockAspect').checked) {
      $('outHeight').value = Math.max(1, Math.round((Number($('outWidth').value) * base.height) / base.width));
    }
  });
  $('outHeight').addEventListener('input', () => {
    if (base && $('lockAspect').checked) {
      $('outWidth').value = Math.max(1, Math.round((Number($('outHeight').value) * base.width) / base.height));
    }
  });
  for (const button of document.querySelectorAll('#exportPanel [data-scale]')) {
    button.addEventListener('click', () => {
      if (base) {
        const scale = Number(/** @type {HTMLElement} */ (button).dataset.scale);
        $('outWidth').value = Math.max(1, Math.round(base.width * scale));
        $('outHeight').value = Math.max(1, Math.round(base.height * scale));
      }
    });
  }

  /** Flattens the image with its annotations at the requested size. */
  function compose(width, height, opaque) {
    const source = /** @type {HTMLCanvasElement} */ (base);
    let result = makeCanvas(source.width, source.height);
    let c = /** @type {CanvasRenderingContext2D} */ (result.getContext('2d'));
    if (opaque) {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, result.width, result.height);
    }
    c.drawImage(source, 0, 0);
    drawItems(c, items);

    // Halving in steps avoids the aliasing of one big bilinear downscale.
    const scaleTo = (w, h) => {
      const next = makeCanvas(w, h);
      c = /** @type {CanvasRenderingContext2D} */ (next.getContext('2d'));
      c.imageSmoothingQuality = 'high';
      c.drawImage(result, 0, 0, w, h);
      result = next;
    };
    while (result.width / 2 > width && result.height / 2 > height) {
      scaleTo(Math.ceil(result.width / 2), Math.ceil(result.height / 2));
    }
    if (result.width !== width || result.height !== height) {
      scaleTo(width, height);
    }
    return result;
  }

  function encode(format, width, height) {
    const quality = format === 'png' ? undefined : Number($('quality').value) / 100;
    return new Promise((resolve, reject) => {
      compose(width, height, format === 'jpg').toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
        MIME[format],
        quality,
      );
    });
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  let pendingSize = 0;
  /** The state that went into the file being saved; it counts as exported once the provider confirms the save. */
  let savingId = 0;
  $('save').addEventListener('click', async () => {
    if (!base) {
      return;
    }
    commitText();
    const format = $('format').value;
    const width = clamp(Math.round(Number($('outWidth').value)) || base.width, 1, 32767);
    const height = clamp(Math.round(Number($('outHeight').value)) || base.height, 1, 32767);
    try {
      const blob = await encode(format, width, height);
      pendingSize = blob.size;
      savingId = stateId;
      vscode.postMessage({ type: 'save', ext: format, data: await toBase64(blob) });
    } catch (err) {
      toast(String(err));
    }
  });

  $('copyImage').addEventListener('click', async () => {
    if (!base) {
      return;
    }
    commitText();
    try {
      const blob = await encode('png', base.width, base.height);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Image copied to clipboard');
    } catch (err) {
      toast(`Could not copy: ${err}`);
    }
  });

  // ---- Comparing ----------------------------------------------------------

  // The provider answers by asking for the other picture, or by opening the comparison of both halves of a diff editor.
  $('compare').addEventListener('click', () => vscode.postMessage({ type: 'compare' }));
  $('diffCompare').addEventListener('click', () => vscode.postMessage({ type: 'compare' }));

  // In a diff editor (a changed image opened from Source Control) this page is one of two halves, each half as
  // wide. The provider says so (`diff`), and the editing groups step aside for the way to the comparison view.
  // "Tools" brings them back for good, which also covers a provider that was wrong about the diff.
  let toolsWanted = false;
  $('diffTools').addEventListener('click', () => {
    toolsWanted = true;
    document.body.classList.remove('in-diff');
  });

  // ---- Loading ------------------------------------------------------------

  function toBytes(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    // Older hosts serialize buffers to JSON instead of transferring them.
    return new Uint8Array(Array.isArray(data?.data) ? data.data : Object.values(data));
  }

  /** The text over the stage: why there is no picture, or (`busy`) that one is on its way. */
  function showMessage(text, busy = false) {
    $('message').textContent = text;
    $('message').classList.toggle('busy', busy);
    $('message').hidden = !text;
  }

  /** Empties the editor, edits included. */
  function clearImage() {
    commitText(true);
    base = null;
    items = [];
    selected = draft = region = drag = null;
    undoStack.length = redoStack.length = 0;
    stateId = cleanId = 0;
    setCrop(null);
    updateButtons();
    requestDraw();
  }

  /** The decode in progress, which a newer one makes pointless. @type {AbortController | null} */
  let decoding = null;

  /**
   * Decodes one of the pictures in the file and makes it the image being edited. Without `page` it is the
   * one a viewer would normally show. Everything Chromium can't decode itself runs in a worker
   * (dist/webview/imageDecode.js), so the page stays usable and can move on to another file meanwhile.
   */
  async function showPage(page) {
    decoding?.abort();
    const control = (decoding = new AbortController());
    let waiting = 'Loading…';
    let shown = false;
    // A picture that is there at once replaces the old one without a blank moment in between.
    const slow = setTimeout(() => {
      shown = true;
      clearImage();
      showMessage(waiting, true);
    }, 200);
    let result;
    try {
      const decoder = /** @type {any} */ (window).previewixImages;
      if (!decoder) {
        throw new Error('The image decoder (dist/webview/imageDecode.js) could not be loaded.');
      }
      result = await decoder.decode(fileBytes, {
        page,
        mime: fileInfo.mime,
        signal: control.signal,
        onBusy: (/** @type {string} */ format) => {
          waiting = `Decoding ${format}…`;
          if (shown) {
            showMessage(waiting, true);
          }
        },
      });
    } catch (err) {
      clearTimeout(slow);
      if (!control.signal.aborted) {
        clearImage();
        showMessage(err instanceof Error ? err.message : String(err));
        // When only this one picture of the file is the trouble, the list comes with the error and another can be chosen.
        const failed = /** @type {any} */ (err);
        pages = failed?.pages ?? [];
        pageIndex = failed?.page ?? 0;
        updatePages(/** @type {any} */ (window).previewixImages?.formatOf(fileBytes));
        decodeNotes = [];
        renderInfo();
      }
      return;
    }
    clearTimeout(slow);
    const { bitmap } = result;
    if (control.signal.aborted) {
      bitmap.close();
      return;
    }
    clearImage();
    base = makeCanvas(bitmap.width, bitmap.height);
    /** @type {CanvasRenderingContext2D} */ (base.getContext('2d')).drawImage(bitmap, 0, 0);
    bitmap.close();

    pages = result.pages;
    pageIndex = result.page;
    decodeNotes = result.notes;
    const longest = Math.max(base.width, base.height);
    lineWidthInput.value = Math.max(2, Math.round(longest / 300));
    fontSizeInput.value = Math.max(12, Math.round(longest / 40));
    showMessage('');
    updateStrength();
    baseResized();
    updatePages(result.format);
    renderInfo();
    vscode.setState({ page: pageIndex });
    if (result.warning) {
      toast(result.warning);
    }
  }

  function load(msg) {
    fileBytes = toBytes(msg.bytes);
    // The same file again, after a change on disk, stays on the picture that was shown.
    const page = msg.name === fileInfo.name ? pageIndex : vscode.getState()?.page;
    fileInfo = { name: msg.name, ext: msg.ext, mime: msg.mime, size: fileBytes.byteLength };
    setInfoOpen(!!msg.infoOpen);
    $('format').value = MIME[msg.ext] ? msg.ext : msg.ext === 'jpeg' || msg.ext === 'jpe' ? 'jpg' : 'png';
    updateQualityRow();
    showPage(page);
  }

  // ---- Several pictures in one file ---------------------------------------

  function updatePages(format) {
    const select = $('pages');
    select.textContent = '';
    pages.forEach((page, i) => select.append(new Option(page.label, String(i))));
    select.value = String(pageIndex);
    const what = format === 'ICO' || format === 'ICNS' ? 'sizes in this icon' : format === 'TIFF' ? 'pages of this file' : 'pictures in this file';
    select.title = `The ${what} (Page Up / Page Down)`;
    $('pagesGroup').hidden = pages.length < 2;
  }

  function choosePage(index) {
    if (index === pageIndex || index < 0 || index >= pages.length) {
      return;
    }
    commitText();
    if (stateId !== cleanId) {
      // The provider asks before the edits are dropped, and answers with `page`.
      $('pages').value = String(pageIndex);
      vscode.postMessage({ type: 'page', index });
    } else {
      showPage(index);
    }
  }

  $('pages').addEventListener('change', () => {
    // A select that keeps the focus would swallow the shortcuts.
    $('pages').blur();
    choosePage(Number($('pages').value));
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        load(msg);
        break;
      case 'page':
        showPage(msg.index);
        break;
      case 'error':
        showMessage(msg.message);
        break;
      case 'saved':
        toast(`Saved ${msg.name} (${formatBytes(pendingSize)})`);
        toggleExport(false);
        cleanId = savingId;
        break;
      case 'meta':
        sections = msg.sections;
        $('openMap').hidden = !msg.hasPlace;
        renderInfo();
        break;
      case 'folder':
        folder = { index: msg.index, count: msg.count };
        updateFolder();
        break;
      case 'diff':
        document.body.classList.toggle('in-diff', !!msg.paired && !toolsWanted);
        break;
      case 'changed':
        // Reload only when there is nothing to lose.
        if (!undoStack.length && !redoStack.length) {
          vscode.postMessage({ type: 'ready' });
        } else {
          toast('The file changed on disk');
        }
        break;
    }
  });

  setTool('select');
  updateButtons();
  updateFolder();
  vscode.postMessage({ type: 'ready' });
})();
