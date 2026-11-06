// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  const stage = $('stage');
  const sheet = $('sheet');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_SCALE = 64;
  /** Longest side of an exported PNG; canvases beyond this fail to encode. */
  const MAX_EXPORT = 16384;
  /** CSS pixels per unit, for sizes given in absolute units. */
  const UNITS = { '': 1, px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16, ex: 8 };

  // ---- State --------------------------------------------------------------

  const saved = vscode.getState() || {};

  /** The picture on screen. It is replaced by a new element on every update, never reloaded in place. @type {HTMLImageElement | null} */
  let image = null;
  /** Size of the picture at 100%, in CSS pixels. */
  let base = { w: 0, h: 0 };
  /** Bumped by every update, so that a slower, older one is dropped when it finishes. */
  let latest = 0;
  let background = ['checker', 'light', 'dark'].includes(saved.background) ? saved.background : 'checker';

  // screen = image * scale + offset, in CSS pixels relative to the stage
  const view = { scale: 1, x: 0, y: 0 };
  /** Until the user zooms or pans, the picture keeps fitting the window. */
  let fitted = !saved.view;
  if (saved.view) {
    Object.assign(view, saved.view);
  }
  /** @type {{x: number, y: number} | null} */
  let panFrom = null;

  // ---- Helpers ------------------------------------------------------------

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  /** Sizes are shown without the noise of float arithmetic. */
  const tidy = (n) => String(Math.round(n * 100) / 100);

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const kb = bytes / 1024;
    return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(2)} MB`;
  }

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000);
  }

  function saveState() {
    vscode.setState({ background, view: fitted ? null : { ...view } });
  }

  /**
   * The SVG as an image URL. It has to be a `data:` URL: Chromium taints a canvas that an SVG with
   * `<foreignObject>` was drawn on from a `blob:` URL, and PNG export would then fail.
   * The charset in the URL overrides any `encoding` the XML declaration still names.
   */
  const toUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  /** Loads the SVG as an image, which is the only way this page ever renders it: scripts don't run and outside files aren't fetched. */
  function loadImage(svg) {
    const img = new Image();
    img.alt = '';
    img.draggable = false;
    img.src = toUrl(svg);
    return img.decode().then(() => img);
  }

  // ---- Size ---------------------------------------------------------------

  function parseLength(value) {
    const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(value ?? '');
    const unit = match ? UNITS[match[2].toLowerCase()] : undefined;
    const px = match && unit ? Number(match[1]) * unit : 0;
    // Percentages and anything unreadable count as "not given".
    return px > 0 && Number.isFinite(px) ? px : null;
  }

  function parseViewBox(value) {
    const parts = (value ?? '').trim().split(/[\s,]+/).map(Number);
    return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0
      ? { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
      : null;
  }

  /** The size the file asks for, or null when it gives the browser nothing to go by. */
  function declaredSize(root) {
    const w = parseLength(root.getAttribute('width'));
    const h = parseLength(root.getAttribute('height'));
    const box = parseViewBox(root.getAttribute('viewBox'));
    if (w && h) {
      return { w, h };
    }
    if (box) {
      // The browser would fall back to 300 × 150 here; the viewBox is the better guess.
      return w ? { w, h: (w * box.h) / box.w } : h ? { w: (h * box.w) / box.h, h } : { w: box.w, h: box.h };
    }
    return null;
  }

  /**
   * Finds where the drawing of an SVG without size and viewBox actually is, by rasterising it small
   * and looking for painted pixels: first a wide area, then closer in for precision. The file is still
   * only ever rendered as an image, so its bounding box can't be asked for directly.
   */
  async function measureContent(root) {
    const SIDE = 512;
    const probe = /** @type {Element} */ (root.cloneNode(true));
    probe.setAttribute('width', String(SIDE));
    probe.setAttribute('height', String(SIDE));
    probe.removeAttribute('preserveAspectRatio');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIDE;
    const c = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
    let area = { x: -8192, y: -8192, side: 16384 };
    let found = null;
    for (let pass = 0; pass < 4; pass++) {
      probe.setAttribute('viewBox', `${area.x} ${area.y} ${area.side} ${area.side}`);
      const img = await loadImage(new XMLSerializer().serializeToString(probe));
      c.clearRect(0, 0, SIDE, SIDE);
      c.drawImage(img, 0, 0, SIDE, SIDE);
      const data = c.getImageData(0, 0, SIDE, SIDE).data;
      let l = SIDE, t = SIDE, r = -1, b = -1;
      for (let y = 0; y < SIDE; y++) {
        for (let x = 0; x < SIDE; x++) {
          if (data[(y * SIDE + x) * 4 + 3] > 8) {
            l = Math.min(l, x);
            r = Math.max(r, x);
            t = Math.min(t, y);
            b = Math.max(b, y);
          }
        }
      }
      if (r < 0) {
        break;
      }
      const unit = area.side / SIDE;
      found = { x: area.x + l * unit, y: area.y + t * unit, w: (r - l + 1) * unit, h: (b - t + 1) * unit };
      // The next pass looks at the same spot with a small margin, at a finer grain.
      const side = Math.max(found.w, found.h) * 1.1 + unit * 2;
      area = { x: found.x + found.w / 2 - side / 2, y: found.y + found.h / 2 - side / 2, side };
    }
    if (!found) {
      return null;
    }
    // Whole units for anything but tiny drawings, so that the size reads well.
    const snap = found.w > 16 && found.h > 16 ? 1 : 0.01;
    const x = Math.floor(found.x / snap) * snap;
    const y = Math.floor(found.y / snap) * snap;
    return {
      x,
      y,
      w: Math.ceil((found.x + found.w) / snap) * snap - x,
      h: Math.ceil((found.y + found.h) / snap) * snap - y,
    };
  }

  // ---- View ---------------------------------------------------------------

  function place() {
    if (!image) {
      return;
    }
    // The element itself is resized rather than transformed: the browser then draws the vector
    // picture anew at that size, and it stays sharp at any zoom.
    sheet.style.left = `${view.x}px`;
    sheet.style.top = `${view.y}px`;
    sheet.style.width = `${base.w * view.scale}px`;
    sheet.style.height = `${base.h * view.scale}px`;
    $('statZoom').textContent = `${Math.round(view.scale * 100)}%`;
  }

  function fit() {
    if (!image) {
      return;
    }
    const pad = 24;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    // Unlike a bitmap, a small vector picture gains from being enlarged, up to a point.
    const most = Math.max(1, Math.min(8, 512 / Math.max(base.w, base.h)));
    view.scale = Math.max(Math.min((cw - pad * 2) / base.w, (ch - pad * 2) / base.h, most), 0.01);
    view.x = (cw - base.w * view.scale) / 2;
    view.y = (ch - base.h * view.scale) / 2;
    fitted = true;
    saveState();
    place();
  }

  function zoomAt(s, factor) {
    if (!image) {
      return;
    }
    const longest = Math.max(base.w, base.h);
    const next = clamp(view.scale * factor, Math.min(0.05, 16 / longest), Math.max(MAX_SCALE, 2048 / longest));
    view.x = s.x - ((s.x - view.x) * next) / view.scale;
    view.y = s.y - ((s.y - view.y) * next) / view.scale;
    view.scale = next;
    fitted = false;
    saveState();
    place();
  }

  function zoomTo(scale) {
    zoomAt({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }, scale / view.scale);
  }

  function pointerPos(e) {
    const rect = stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Pinch gestures arrive as ctrl+wheel with small deltas, so they get a stronger factor.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(pointerPos(e), Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
    },
    { passive: false },
  );

  stage.addEventListener('pointerdown', (e) => {
    if (!image || (e.button !== 0 && e.button !== 1)) {
      return;
    }
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    panFrom = pointerPos(e);
    stage.classList.add('panning');
  });

  stage.addEventListener('pointermove', (e) => {
    if (!panFrom) {
      return;
    }
    const s = pointerPos(e);
    view.x += s.x - panFrom.x;
    view.y += s.y - panFrom.y;
    panFrom = s;
    fitted = false;
    saveState();
    place();
  });

  function endPan() {
    panFrom = null;
    stage.classList.remove('panning');
  }
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  stage.addEventListener('dblclick', (e) => {
    Math.abs(view.scale - 1) < 0.001 ? fit() : zoomAt(pointerPos(e), 1 / view.scale);
  });

  new ResizeObserver(() => {
    if (fitted) {
      fit();
    }
  }).observe(stage);

  function setBackground(next) {
    background = next;
    $('background').value = next;
    sheet.className = next;
    saveState();
  }
  $('background').addEventListener('change', () => setBackground($('background').value));

  // ---- Loading ------------------------------------------------------------

  /** A file that can't be shown: the reason takes the place of the picture, and the last good picture stays, dimmed. */
  function showError(text) {
    $('error').textContent = text;
    $('error').hidden = false;
    $('message').hidden = true;
    stage.classList.add('broken');
  }

  function setEnabled(on) {
    for (const id of ['zoomFit', 'zoomActual', 'exportToggle']) {
      $(id).disabled = !on;
    }
    if (!on) {
      toggleExport(false);
    }
  }

  async function load(msg) {
    const mine = ++latest;
    // Parsed only to be inspected: the document is inert, and the page's policy applies to it as well
    // (the console reports the inline styles it refuses there, which is harmless).
    const doc = new DOMParser().parseFromString(msg.text, 'image/svg+xml');
    const root = doc.documentElement;
    const elements = doc.getElementsByTagName('*').length;
    const parseError = doc.querySelector('parsererror');
    const details = [formatBytes(msg.size) + (msg.unsaved ? ' (unsaved)' : '')];

    let problem = '';
    if (!msg.text.trim()) {
      problem = 'The file is empty.';
    } else if (parseError) {
      // Chromium words it as "error on line 3 at column 7: …" inside a styled block.
      const text = (parseError.querySelector('div') ?? parseError).textContent ?? '';
      problem = `This SVG is not well-formed XML.\n${text.trim()}`;
    } else if (root.localName !== 'svg') {
      problem = `The root element is <${root.nodeName}>, not <svg>.`;
    } else if (root.namespaceURI !== SVG_NS) {
      problem = `The <svg> element has no xmlns="${SVG_NS}" attribute, so it is not an SVG picture.`;
    }
    if (problem) {
      showError(problem);
      $('statInfo').textContent = details.join(' · ');
      return;
    }

    let source = msg.text;
    let size = declaredSize(root);
    let sizeNote = '';
    try {
      if (!size) {
        const box = await measureContent(root);
        if (mine !== latest) {
          return;
        }
        if (box) {
          // Shown through a viewBox around the drawing; the copy on the clipboard is still the file.
          root.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
          root.setAttribute('width', String(box.w));
          root.setAttribute('height', String(box.h));
          source = new XMLSerializer().serializeToString(root);
          size = { w: box.w, h: box.h };
          sizeNote = 'no size or viewBox, fitted to the drawing';
        } else {
          size = { w: 300, h: 150 };
          sizeNote = 'no size or viewBox, nothing drawn';
        }
      }
      const next = await loadImage(source);
      if (mine !== latest) {
        return;
      }
      const resized = !image || Math.abs(base.w - size.w) > 0.01 || Math.abs(base.h - size.h) > 0.01;
      const first = !image;
      base = size;
      if (resized) {
        // The export width follows the picture until the user sets one for this size.
        $('outWidth').value = '';
      }
      sheet.replaceChildren(next);
      image = next;
      sheet.hidden = false;
      $('error').hidden = true;
      $('message').hidden = true;
      stage.classList.remove('broken');
      setEnabled(true);
      // Typing in the source shouldn't throw away the zoom, unless the picture changed its size.
      if ((first && fitted) || (!first && resized)) {
        fit();
      } else {
        place();
      }
      updateExport();
    } catch {
      if (mine === latest) {
        showError('This SVG could not be rendered.');
      }
      return;
    }

    const viewBox = root.getAttribute('viewBox');
    details.unshift(
      `${tidy(size.w)} × ${tidy(size.h)} px${sizeNote ? ` (${sizeNote})` : ''}`,
      ...(sizeNote ? [] : [viewBox ? `viewBox ${viewBox.trim().split(/[\s,]+/).join(' ')}` : 'no viewBox']),
      `${elements} ${elements === 1 ? 'element' : 'elements'}`,
    );
    $('statInfo').textContent = details.join(' · ');
  }

  // ---- Export -------------------------------------------------------------

  function toggleExport(show) {
    $('exportPanel').hidden = !show;
    $('exportToggle').classList.toggle('active', show);
  }
  $('exportToggle').addEventListener('click', () => toggleExport($('exportPanel').hidden));

  /** The pixel size the export will have for the width in the panel. */
  function exportSize() {
    const limit = Math.floor(Math.min(MAX_EXPORT, (MAX_EXPORT * base.w) / base.h));
    const w = clamp(Math.round(Number($('outWidth').value)) || Math.round(base.w), 1, Math.max(1, limit));
    return { w, h: Math.max(1, Math.round((w * base.h) / base.w)) };
  }

  function updateExport() {
    if (!image) {
      return;
    }
    if (!Number($('outWidth').value)) {
      $('outWidth').value = Math.max(1, Math.round(base.w));
    }
    const { w, h } = exportSize();
    $('outSize').textContent = `${w} × ${h} px`;
    for (const button of document.querySelectorAll('#scales button')) {
      const scale = Number(/** @type {HTMLElement} */ (button).dataset.scale);
      button.classList.toggle('active', w === Math.max(1, Math.round(base.w * scale)));
    }
  }
  $('outWidth').addEventListener('input', updateExport);
  for (const button of document.querySelectorAll('#scales button')) {
    button.addEventListener('click', () => {
      $('outWidth').value = Math.max(1, Math.round(base.w * Number(/** @type {HTMLElement} */ (button).dataset.scale)));
      updateExport();
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
  $('save').addEventListener('click', async () => {
    if (!image) {
      return;
    }
    const { w, h } = exportSize();
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    // Drawing an SVG image at a size rasterises the vector picture at that size; nothing is upscaled.
    /** @type {CanvasRenderingContext2D} */ (out.getContext('2d')).drawImage(image, 0, 0, w, h);
    try {
      const blob = await new Promise((resolve, reject) => {
        out.toBlob((result) => (result ? resolve(result) : reject(new Error('The image could not be encoded.'))), 'image/png');
      });
      pendingSize = blob.size;
      vscode.postMessage({ type: 'save', data: await toBase64(blob) });
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  });

  // ---- Toolbar and keys ---------------------------------------------------

  $('openSource').addEventListener('click', (e) => vscode.postMessage({ type: 'openSource', beside: e.altKey }));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  $('zoomFit').addEventListener('click', fit);
  $('zoomActual').addEventListener('click', () => zoomTo(1));

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const typing = ['INPUT', 'SELECT'].includes(target.tagName);
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      if (image) {
        toggleExport(true);
      }
    } else if (e.key === 'Escape') {
      toggleExport(false);
    } else if (e.key === 'Enter' && target.id === 'outWidth') {
      $('save').click();
    } else if (typing || mod || e.altKey) {
      return;
    } else if (key === '0') {
      fit();
    } else if (key === '1') {
      zoomTo(1);
    } else if (key === '+' || key === '=') {
      zoomTo(view.scale * 1.25);
    } else if (key === '-') {
      zoomTo(view.scale / 1.25);
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'svg':
        load(msg);
        break;
      case 'error':
        showError(msg.message);
        break;
      case 'copied':
        toast('SVG source copied to clipboard');
        break;
      case 'saved':
        toast(`Saved ${msg.name} (${formatBytes(pendingSize)})`);
        toggleExport(false);
        break;
    }
  });

  setBackground(background);
  setEnabled(false);
  vscode.postMessage({ type: 'ready' });
})();
