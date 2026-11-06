// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  const stage = $('stage');
  /** @type {HTMLCanvasElement} */
  const canvas = $('view');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

  const MAX_SCALE = 64;
  const MODES = ['side', 'blink', 'swipe', 'onion', 'diff'];
  const ALIGNMENTS = ['tl', 'tr', 'c', 'bl', 'br', 'custom', 'scale'];
  /** The color of the marks: one that screenshots and photographs rarely contain. */
  const MARK = [255, 0, 200];
  const MARK_CSS = `rgb(${MARK.join(', ')})`;
  /** How much of picture A stays under the marks in the difference mode. */
  const FADE = 0.3;
  /** Between the two halves of the side-by-side mode, px. */
  const GAP = 2;
  /** Pixels read from each picture per step of a comparison: small enough for the page to stay smooth meanwhile. */
  const STRIP_PIXELS = 1_500_000;

  // ---- State --------------------------------------------------------------

  const newSide = () => ({
    name: '',
    detail: '',
    tip: '',
    size: 0,
    hash: '',
    format: '',
    /** @type {ImageBitmap | null} */
    bitmap: null,
    /** Why there is no picture. */
    error: '',
    /** What is being waited for, while there is no picture yet. */
    busy: 'Loading…',
    /** Things to know about the picture on screen: one frame of several, a decoder's warning. @type {string[]} */
    remarks: [],
    /** @type {AbortController | null} */
    control: null,
  });
  /** The two pictures in the provider's order. `settings.swapped` says which of them is A. */
  const sides = [newSide(), newSide()];

  const kept = vscode.getState() || {};
  const settings = {
    mode: MODES.includes(kept.mode) ? kept.mode : 'side',
    tolerance: Number.isInteger(kept.tolerance) ? Math.min(255, Math.max(0, kept.tolerance)) : 0,
    /** Of B over A in the onion skin, percent. */
    opacity: Number.isFinite(kept.opacity) ? Math.min(100, Math.max(0, kept.opacity)) : 50,
    swapped: !!kept.swapped,
    align: ALIGNMENTS.includes(kept.align) ? kept.align : 'tl',
    /** Where B lies on A when it was moved by hand (`align` is 'custom'). */
    dx: Number.isInteger(kept.dx) ? kept.dx : 0,
    dy: Number.isInteger(kept.dy) ? kept.dy : 0,
    frame: kept.frame !== false,
    /** The divider of the swipe mode, as a share of the stage's width. */
    split: Number.isFinite(kept.split) ? Math.min(1, Math.max(0, kept.split)) : 0.5,
  };
  /** The provider's name for this comparison; all a restored tab has to say which pictures it showed. */
  let id = kept.id;
  /** The picture on screen in the blink mode: 0 for A, 1 for B. */
  let shown = 0;

  // screen = pane origin + plane * scale + offset, in CSS pixels
  const view = { scale: 1, x: 0, y: 0 };
  /** Until the view is zoomed or moved by hand it follows the window. */
  let autoFit = true;
  /** @type {{w: number, h: number} | null} */
  let lastPane = null;
  /** @type {any} */
  let drag = null;
  /** The pointer over the stage: the pane it is in and the point of the plane under it. @type {{pane: number, x: number, y: number} | null} */
  let hover = null;

  /**
   * Where the pictures lie. The plane is measured in pixels of A, whose top left corner is the origin; B lies
   * where the alignment puts it. `overlap` is what both cover, and the only part that is compared.
   * @typedef {{x: number, y: number, w: number, h: number}} Rect
   * @type {{rects: (Rect | null)[], union: Rect | null, overlap: Rect | null}}
   */
  let plane = { rects: [null, null], union: null, overlap: null };

  // ---- Helpers ------------------------------------------------------------

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  /** Picture A (0) or B (1). */
  const pic = (index) => sides[settings.swapped ? 1 - index : index];
  const number = (n) => n.toLocaleString('en-US');

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

  let toastTimer;
  function toast(text, stay = false) {
    $('toast').textContent = text;
    clearTimeout(toastTimer);
    if (!stay) {
      toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000);
    }
  }

  /** The view a tab had before it was rebuilt (it came back from the background, or the window was reloaded). @type {any} */
  let keptView = kept.view && [kept.view.scale, kept.view.x, kept.view.y].every(Number.isFinite) && kept.view.scale > 0 ? kept.view : null;

  function keep() {
    // The view is only worth keeping once it was set by hand, and only fits pictures of the same extent.
    vscode.setState({ id, ...settings, view: autoFit || !plane.union ? keptView : { ...view, extent: extent() } });
  }

  let keeping = 0;
  /** For what changes many times a second: the view while it is moved. */
  function keepSoon() {
    clearTimeout(keeping);
    keeping = setTimeout(keep, 300);
  }

  // ---- Where the pictures lie ---------------------------------------------

  /** Where the top left corner of B lies on A. */
  function offsetOf(a, b) {
    const right = a.width - b.width;
    const bottom = a.height - b.height;
    switch (settings.align) {
      case 'tr':
        return [right, 0];
      case 'bl':
        return [0, bottom];
      case 'br':
        return [right, bottom];
      case 'c':
        return [Math.round(right / 2), Math.round(bottom / 2)];
      case 'custom':
        return [settings.dx, settings.dy];
      default:
        return [0, 0];
    }
  }

  function layOut() {
    const a = pic(0).bitmap;
    const b = pic(1).bitmap;
    const ra = a ? { x: 0, y: 0, w: a.width, h: a.height } : null;
    let rb = null;
    if (b && a && settings.align === 'scale') {
      rb = { x: 0, y: 0, w: a.width, h: a.height };
    } else if (b) {
      const [x, y] = a ? offsetOf(a, b) : [0, 0];
      rb = { x, y, w: b.width, h: b.height };
    }
    const both = [ra, rb].filter(Boolean);
    let union = null;
    let overlap = null;
    if (both.length) {
      const left = Math.min(...both.map((r) => r.x));
      const top = Math.min(...both.map((r) => r.y));
      union = { x: left, y: top, w: Math.max(...both.map((r) => r.x + r.w)) - left, h: Math.max(...both.map((r) => r.y + r.h)) - top };
    }
    if (ra && rb) {
      const left = Math.max(ra.x, rb.x);
      const top = Math.max(ra.y, rb.y);
      const w = Math.min(ra.x + ra.w, rb.x + rb.w) - left;
      const h = Math.min(ra.y + ra.h, rb.y + rb.h) - top;
      overlap = w > 0 && h > 0 ? { x: left, y: top, w, h } : null;
    }
    plane = { rects: [ra, rb], union, overlap };
  }

  const sameSize = () => {
    const a = pic(0).bitmap;
    const b = pic(1).bitmap;
    return !!a && !!b && a.width === b.width && a.height === b.height;
  };

  /** Says in words how the pictures are held against each other whenever that is not simply "one on the other". */
  function updateAlignment() {
    const a = pic(0).bitmap;
    const b = pic(1).bitmap;
    const note = $('alignNote');
    const differ = !!a && !!b && !sameSize();
    $('alignGroup').hidden = !(differ || (a && b && settings.align === 'custom'));
    $('align').querySelector('[value=custom]').hidden = settings.align !== 'custom';
    $('align').querySelector('[value=scale]').hidden = !differ;
    $('align').value = !differ && settings.align !== 'custom' ? 'tl' : settings.align;
    if (!a || !b || (!differ && settings.align !== 'custom')) {
      note.hidden = true;
      return;
    }
    const compared = plane.overlap ? `the ${number(plane.overlap.w)} × ${number(plane.overlap.h)} px that both cover are compared` : 'they do not overlap, so nothing is compared';
    const side = (d, more, less) => (d ? `${number(Math.abs(d))} px ${d > 0 ? more : less}` : '');
    const sizes = [side(b.width - a.width, 'wider', 'narrower'), side(b.height - a.height, 'taller', 'shorter')].filter(Boolean).join(' and ');
    let text = differ ? `The sizes differ: B is ${sizes} than A. ` : '';
    if (settings.align === 'scale') {
      const skewed = Math.abs(a.width / a.height - b.width / b.height) > 1 / Math.min(a.height, b.height);
      text += `B is shown and compared scaled to the size of A${skewed ? ', which distorts it, since the proportions differ too' : ''}. Scaling softens edges: expect small differences there, and raise the tolerance to see past them.`;
    } else {
      const [x, y] = offsetOf(a, b);
      const names = { tl: 'at the top left corner', tr: 'at the top right corner', bl: 'at the bottom left corner', br: 'at the bottom right corner', c: 'in the middle' };
      const where = settings.align === 'custom' ? `B was moved to ${x}, ${y} on A` : `B lies ${names[settings.align]} of A`;
      text += `Nothing is stretched: ${where}, pixel for pixel, and ${compared}.`;
      // The same picture at another scale, a 2× screenshot against a 1× one, only compares when scaled.
      if (differ && Math.abs(a.width / a.height - b.width / b.height) <= 1 / Math.min(a.height, b.height)) {
        text += ' The proportions are the same: “B scaled to the size of A” compares them as one picture.';
      }
    }
    note.textContent = text;
    note.hidden = false;
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

  /** Whether the two halves of the side-by-side mode lie above each other, which shows wide pictures larger. */
  function stacked() {
    const u = plane.union;
    if (!u) {
      return false;
    }
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const beside = Math.min((w - GAP) / 2 / u.w, h / u.h);
    const above = Math.min(w / u.w, (h - GAP) / 2 / u.h);
    return above > beside * 1.25;
  }

  /** The parts of the stage that show the plane: two in the side-by-side mode, with one view between them, else the whole stage. */
  function panes() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (settings.mode !== 'side') {
      return [{ x: 0, y: 0, w, h }];
    }
    if (stacked()) {
      const half = Math.floor((h - GAP) / 2);
      return [{ x: 0, y: 0, w, h: half }, { x: 0, y: half + GAP, w, h: half }];
    }
    const half = Math.floor((w - GAP) / 2);
    return [{ x: 0, y: 0, w: half, h }, { x: half + GAP, y: 0, w: half, h }];
  }

  /**
   * A pane that changed its size (the window, or the step between one pane and two) keeps the middle in the
   * middle. Called when that happens rather than when it is drawn, so that whatever moves the view next
   * already starts from the new pane.
   */
  function settlePane() {
    const [first] = panes();
    if (lastPane && (lastPane.w !== first.w || lastPane.h !== first.h)) {
      if (autoFit) {
        fitNow();
      } else {
        view.x += (first.w - lastPane.w) / 2;
        view.y += (first.h - lastPane.h) / 2;
      }
    }
    lastPane = { w: first.w, h: first.h };
  }

  let frameRequest = 0;
  function requestDraw() {
    frameRequest ||= requestAnimationFrame(() => {
      frameRequest = 0;
      draw();
    });
  }

  /** Draws pictures of the plane into a pane, clipped to `clip`. */
  function paint(pane, clip, layers, backdrop = true) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    for (const { index } of layers) {
      const r = plane.rects[index];
      if (r && backdrop) {
        ctx.fillStyle = checker;
        ctx.fillRect(pane.x + view.x + r.x * view.scale, pane.y + view.y + r.y * view.scale, r.w * view.scale, r.h * view.scale);
      }
    }
    ctx.translate(pane.x + view.x, pane.y + view.y);
    ctx.scale(view.scale, view.scale);
    for (const { index, alpha } of layers) {
      const r = plane.rects[index];
      const bitmap = pic(index).bitmap;
      if (!r || !bitmap) {
        continue;
      }
      ctx.globalAlpha = alpha;
      // Show individual pixels when zoomed far in, as the image editor does.
      ctx.imageSmoothingEnabled = (view.scale * r.w) / bitmap.width < 4;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  /** A rectangle of the plane, outlined on screen one pixel outside of it, so the line covers nothing it frames. */
  function outline(pane, r, dash) {
    const x = pane.x + view.x + r.x * view.scale - 1.5;
    const y = pane.y + view.y + r.y * view.scale - 1.5;
    const w = r.w * view.scale + 3;
    const h = r.h * view.scale + 3;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    // A dark line under the colored one keeps it visible on any picture.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeRect(x, y, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = dash ? '#ffffff' : MARK_CSS;
    ctx.setLineDash(dash ? [4, 4] : []);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const list = panes();
    const [first] = list;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    placeLabels(list);
    updateStatus();
    if (!plane.union) {
      return;
    }

    switch (settings.mode) {
      case 'side':
        paint(list[0], list[0], [{ index: 0, alpha: 1 }]);
        paint(list[1], list[1], [{ index: 1, alpha: 1 }]);
        break;
      case 'blink':
        paint(first, first, [{ index: shown, alpha: 1 }]);
        break;
      case 'swipe': {
        const x = Math.round(settings.split * cw);
        paint(first, { x: 0, y: 0, w: x, h: ch }, [{ index: 0, alpha: 1 }]);
        paint(first, { x, y: 0, w: cw - x, h: ch }, [{ index: 1, alpha: 1 }]);
        break;
      }
      case 'onion':
        paint(first, first, [{ index: 0, alpha: 1 }, { index: 1, alpha: settings.opacity / 100 }]);
        break;
      case 'diff':
        paint(first, first, [{ index: 0, alpha: FADE }], false);
        if (marks && job && marks.job === job) {
          ctx.save();
          ctx.translate(view.x, view.y);
          ctx.scale(view.scale, view.scale);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(marks.bitmap, marks.x, marks.y, marks.w, marks.h);
          ctx.restore();
        }
        wantMarks(first);
        // Where the pictures cover different ground, the line shows how far the comparison reaches.
        if (plane.overlap && plane.union && (plane.overlap.w !== plane.union.w || plane.overlap.h !== plane.union.h)) {
          outline(first, plane.overlap, true);
        }
        break;
    }

    const box = changedArea();
    if (box && settings.frame) {
      list.forEach((pane) => outline(pane, box, false));
    }
    // In the side-by-side mode a cross shows, in the other half, the point the pointer is on.
    if (settings.mode === 'side' && hover && !drag) {
      const pane = list[1 - hover.pane];
      const x = Math.round(pane.x + view.x + (hover.x + 0.5) * view.scale);
      const y = Math.round(pane.y + view.y + (hover.y + 0.5) * view.scale);
      if (x > pane.x && x < pane.x + pane.w && y > pane.y && y < pane.y + pane.h) {
        ctx.save();
        for (const [width, style] of /** @type {[number, string][]} */ ([[3, 'rgba(0, 0, 0, 0.6)'], [1, '#ffffff']])) {
          ctx.lineWidth = width;
          ctx.strokeStyle = style;
          ctx.beginPath();
          ctx.moveTo(x - 9, y + 0.5);
          ctx.lineTo(x + 9, y + 0.5);
          ctx.moveTo(x + 0.5, y - 9);
          ctx.lineTo(x + 0.5, y + 9);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  // ---- Labels over the stage ----------------------------------------------

  const waiting = (side) => side.error || side.busy;

  /** Puts the A and B tags, the divider and the messages of a side without a picture where the mode has them. */
  function placeLabels(list) {
    const cw = stage.clientWidth;
    const side = settings.mode === 'side';
    const at = (el, x, y, right = false) => {
      el.style.left = right ? '' : `${Math.round(x)}px`;
      el.style.right = right ? `${Math.round(cw - x)}px` : '';
      el.style.top = `${Math.round(y)}px`;
    };
    for (const index of [0, 1]) {
      const tag = $(index ? 'tagB' : 'tagA');
      const picture = pic(index);
      tag.textContent = `${index ? 'B' : 'A'}  ${picture.name}${picture.detail ? ` (${picture.detail})` : ''}`;
      const pane = list[side ? index : 0];
      tag.hidden = !picture.name || (settings.mode === 'blink' && shown !== index) || (settings.mode === 'diff' && index === 1);
      // Each picture's tag sits in its half, or on its side of the divider; in the blink mode both take the same place.
      const right = !side && index === 1 && settings.mode !== 'blink';
      at(tag, right ? pane.w - 8 : pane.x + 8, pane.y + 8, right);
      const note = $(index ? 'noteB' : 'noteA');
      note.hidden = !side || !!picture.bitmap || !waiting(picture);
      note.textContent = waiting(picture);
      note.classList.toggle('busy', !picture.error);
      note.style.left = `${pane.x}px`;
      note.style.top = `${pane.y}px`;
      note.style.width = `${pane.w}px`;
      note.style.height = `${pane.h}px`;
    }
    $('divider').hidden = settings.mode !== 'swipe' || !plane.union;
    $('divider').style.left = `${Math.round(settings.split * cw)}px`;

    // Outside the side-by-side mode the pictures share the stage, and so do their messages.
    const lines = side ? [] : [0, 1].filter((index) => !pic(index).bitmap && waiting(pic(index))).map((index) => `${index ? 'B' : 'A'}: ${waiting(pic(index))}`);
    $('message').hidden = !lines.length;
    $('message').textContent = lines.join('\n');
    $('message').classList.toggle('banner', !!plane.union);
    $('message').classList.toggle('busy', lines.length > 0 && [0, 1].every((index) => pic(index).bitmap || !pic(index).error));
  }

  // ---- The facts ----------------------------------------------------------

  function updateFacts() {
    for (const index of [0, 1]) {
      const picture = pic(index);
      const row = $(index ? 'factB' : 'factA');
      const name = row.querySelector('button');
      name.textContent = picture.name;
      name.title = `${picture.tip}\nClick to open`;
      row.querySelector('.detail').textContent = picture.detail;
      const props = row.querySelector('.props');
      props.classList.toggle('error', !!picture.error);
      if (picture.bitmap) {
        props.textContent = [`${number(picture.bitmap.width)} × ${number(picture.bitmap.height)} px`, picture.format, formatBytes(picture.size), ...picture.remarks].join(' · ');
      } else {
        props.textContent = waiting(picture);
      }
    }
    updateAlignment();
    updateResult();
  }

  const share = (part, whole) => {
    const percent = (part / whole) * 100;
    return percent >= 99.995 && part < whole ? '>99.99%' : percent < 0.005 ? '<0.01%' : `${percent.toFixed(2)}%`;
  };

  /** How many pixels differ by more than the tolerance. */
  function countOver(histogram, tolerance) {
    let count = 0;
    for (let d = tolerance + 1; d < 256; d++) {
      count += histogram[d];
    }
    return count;
  }

  /** The area that changed, on the plane, once the worker has found it for the current tolerance. */
  function changedArea() {
    if (!job || !job.box || job.boxFor !== settings.tolerance) {
      return null;
    }
    return { x: job.box.x + job.overlap.x, y: job.box.y + job.overlap.y, w: job.box.w, h: job.box.h };
  }

  function updateResult() {
    const result = $('result');
    result.textContent = '';
    result.className = 'fact';
    const a = pic(0);
    const b = pic(1);
    const usable = !!job && !!job.histogram;
    $('save').disabled = !usable;
    $('jump').disabled = $('frame').disabled = !changedArea();
    $('frame').classList.toggle('active', settings.frame);
    if (!a.bitmap || !b.bitmap) {
      result.textContent = a.error || b.error ? 'Nothing to compare: one of the pictures can\'t be shown.' : '';
      return;
    }
    if (!plane.overlap) {
      result.textContent = 'Nothing to compare: the pictures do not overlap.';
      return;
    }
    if (!job || job.failed) {
      result.textContent = job ? `The comparison failed: ${job.failed}` : '';
      return;
    }
    if (!job.histogram) {
      result.textContent = `Comparing… ${Math.floor((job.done / job.overlap.h) * 100)}%`;
      result.classList.add('working');
      return;
    }
    const total = job.overlap.w * job.overlap.h;
    const tolerance = settings.tolerance;
    const differing = countOver(job.histogram, tolerance);
    const any = total - job.histogram[0];
    let largest = 255;
    while (largest > 0 && !job.histogram[largest]) {
      largest--;
    }
    if (!any) {
      result.classList.add('same');
      result.textContent = `Identical: all ${number(total)} pixels are the same.${a.hash && a.hash === b.hash ? ' The two files are the same, byte for byte.' : ''}`;
    } else if (!differing) {
      result.classList.add('same');
      result.textContent = `The same within the tolerance: ${number(any)} of ${number(total)} pixels differ (${share(any, total)}), none by more than ${largest}.`;
    } else {
      result.classList.add('differ');
      const by = tolerance ? ` by more than ${tolerance}` : '';
      result.append(`${number(differing)} of ${number(total)} pixels ${differing === 1 ? 'differs' : 'differ'}${by} (${share(differing, total)}) · largest difference ${largest} of 255`);
      const box = changedArea();
      if (box) {
        const go = document.createElement('button');
        go.className = 'link';
        go.title = 'Go to the area that changed (J)';
        go.textContent = `${number(box.w)} × ${number(box.h)} px at ${number(box.x)}, ${number(box.y)}`;
        go.addEventListener('click', jump);
        result.append(' · changed area ', go);
      }
      if (tolerance && any > differing) {
        result.append(` · ${number(any - differing)} more differ within the tolerance`);
      }
    }
  }

  // ---- Under the pointer --------------------------------------------------

  const probe = /** @type {CanvasRenderingContext2D} */ (makeCanvas(1, 1).getContext('2d', { willReadFrequently: true }));

  /** The pixel of a picture under a point of the plane: its own pixel, also when the picture is shown scaled. */
  function sample(index, x, y) {
    const r = plane.rects[index];
    const bitmap = pic(index).bitmap;
    if (!r || !bitmap || x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) {
      return null;
    }
    const px = Math.min(bitmap.width - 1, Math.floor(((x - r.x + 0.5) * bitmap.width) / r.w));
    const py = Math.min(bitmap.height - 1, Math.floor(((y - r.y + 0.5) * bitmap.height) / r.h));
    probe.globalCompositeOperation = 'copy';
    probe.drawImage(bitmap, px, py, 1, 1, 0, 0, 1, 1);
    const [red, green, blue, alpha] = probe.getImageData(0, 0, 1, 1).data;
    return { x: px, y: py, r: red, g: green, b: blue, a: alpha };
  }

  /** The measure of the worker (compareWorker.js), for one pair of pixels. */
  function distance(p, q) {
    const weigh = (v, alpha) => Math.round((v * alpha) / 255);
    return Math.max(Math.abs(p.a - q.a), ...['r', 'g', 'b'].map((c) => Math.abs(weigh(p[c], p.a) - weigh(q[c], q.a))));
  }

  function updateStatus() {
    $('statZoom').textContent = plane.union ? `${Math.round(view.scale * 100)}%` : '';
    const pixels = hover ? [sample(0, hover.x, hover.y), sample(1, hover.x, hover.y)] : [null, null];
    const [a, b] = pixels;
    // The position is given in each picture's own pixels, which are the same numbers unless B is moved or scaled.
    const places = pixels.map((p) => (p ? `${p.x}, ${p.y}` : ''));
    $('statCursor').textContent = !a && !b ? '' : places[0] === places[1] || !a || !b ? places[0] || `B ${places[1]}` : `${places[0]} · B ${places[1]}`;
    pixels.forEach((p, index) => {
      const el = $(index ? 'statB' : 'statA');
      el.hidden = !p;
      if (p) {
        el.querySelector('i').style.setProperty('--swatch', `rgba(${p.r}, ${p.g}, ${p.b}, ${p.a / 255})`);
        const hex = '#' + [p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('');
        el.querySelector('span').textContent = p.a < 255 ? `${hex} · alpha ${Math.round((p.a / 255) * 100)}%` : hex;
      }
    });
    const d = a && b ? distance(a, b) : -1;
    $('statDelta').textContent = d < 0 ? '' : d === 0 ? 'same' : `differ by ${d}${d <= settings.tolerance ? ' (within the tolerance)' : ''}`;
    $('statDelta').classList.toggle('over', d > settings.tolerance);
  }

  // ---- View ---------------------------------------------------------------

  function fitNow() {
    const u = plane.union;
    if (!u) {
      return;
    }
    const [pane] = panes();
    const pad = Math.min(24, pane.w / 10, pane.h / 10);
    view.scale = Math.max(0.01, Math.min((pane.w - pad * 2) / u.w, (pane.h - pad * 2) / u.h, 1));
    view.x = (pane.w - u.w * view.scale) / 2 - u.x * view.scale;
    view.y = (pane.h - u.h * view.scale) / 2 - u.y * view.scale;
  }

  function fit() {
    autoFit = true;
    keptView = null;
    fitNow();
    keep();
    requestDraw();
  }

  /** Zooms around a point of a pane, given relative to the pane's corner. */
  function zoomAt(p, factor) {
    const u = plane.union;
    if (!u) {
      return;
    }
    const minScale = Math.min(0.05, 16 / Math.max(u.w, u.h));
    const next = clamp(view.scale * factor, minScale, MAX_SCALE);
    view.x = p.x - ((p.x - view.x) * next) / view.scale;
    view.y = p.y - ((p.y - view.y) * next) / view.scale;
    view.scale = next;
    autoFit = false;
    keepSoon();
    requestDraw();
  }

  function zoomTo(scale) {
    const [pane] = panes();
    zoomAt({ x: pane.w / 2, y: pane.h / 2 }, scale / view.scale);
  }

  /** Brings the area that changed into view, as large as it goes without leaving its surroundings behind. */
  function jump() {
    const box = changedArea();
    if (!box) {
      return;
    }
    const [pane] = panes();
    view.scale = clamp(Math.min((pane.w * 0.6) / box.w, (pane.h * 0.6) / box.h), 0.01, 8);
    view.x = pane.w / 2 - (box.x + box.w / 2) * view.scale;
    view.y = pane.h / 2 - (box.y + box.h / 2) * view.scale;
    autoFit = false;
    keepSoon();
    requestDraw();
  }

  /** The pane under a point of the stage and the pixel of the plane there. */
  function locate(e) {
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const list = panes();
    let pane = list.findIndex((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
    if (pane < 0) {
      // In the gap between the halves the nearer one answers.
      pane = list.length > 1 && (x > list[1].x || y > list[1].y) ? 1 : 0;
    }
    const local = { x: x - list[pane].x, y: y - list[pane].y };
    return { pane, local, x: Math.floor((local.x - view.x) / view.scale), y: Math.floor((local.y - view.y) / view.scale) };
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Pinch gestures arrive as ctrl+wheel with small deltas, so they get a stronger factor.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(locate(e).local, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, viewX: view.x, viewY: view.y };
    canvas.classList.add('panning');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      view.x = drag.viewX + e.clientX - drag.x;
      view.y = drag.viewY + e.clientY - drag.y;
      autoFit = false;
      keepSoon();
    }
    const at = locate(e);
    hover = { pane: at.pane, x: at.x, y: at.y };
    requestDraw();
  });

  const endDrag = () => {
    drag = null;
    canvas.classList.remove('panning');
    requestDraw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!drag) {
      hover = null;
      requestDraw();
    }
  });
  canvas.addEventListener('dblclick', () => (autoFit ? zoomTo(1) : fit()));

  // The divider of the swipe mode. It moves over the pictures, which stay where they are.
  const divider = $('divider');
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  divider.addEventListener('pointermove', (e) => {
    if (divider.hasPointerCapture(e.pointerId)) {
      const rect = stage.getBoundingClientRect();
      settings.split = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      requestDraw();
    }
  });
  divider.addEventListener('pointerup', keep);

  new ResizeObserver(() => {
    settlePane();
    requestDraw();
  }).observe(stage);

  // ---- The comparison -----------------------------------------------------

  /**
   * One comparison of the two pictures as they lie now, and the worker that holds its result. A change of
   * either picture or of the alignment ends the worker and starts another, which is also what frees its memory.
   * @type {any}
   */
  let job = null;
  /** The marks of the difference mode for the part in view, drawn by the worker. @type {any} */
  let marks = null;
  /** @type {Promise<string> | null} */
  let workerCode = null;
  let restart = 0;

  /** A worker can't be started from the extension's files, which are another origin for a webview, so its code is fetched and started from a blob. */
  function workerUrl() {
    workerCode ??= fetch(String(document.body.dataset.worker)).then(async (response) => {
      if (!response.ok) {
        throw new Error(`compareWorker.js: ${response.status}`);
      }
      return URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
    });
    // A failed download is tried again next time.
    workerCode.catch(() => (workerCode = null));
    return workerCode;
  }

  function endJob() {
    job?.worker?.terminate();
    // Whoever waits for marks from this worker is told that none will come.
    job?.renders.forEach((request) => request.reject(new Error('The pictures changed meanwhile.')));
    job = null;
    marks?.bitmap.close();
    marks = null;
  }

  function compare() {
    clearTimeout(restart);
    endJob();
    const a = pic(0).bitmap;
    const b = pic(1).bitmap;
    const overlap = plane.overlap;
    if (a && b && overlap) {
      const rows = clamp(Math.floor(STRIP_PIXELS / overlap.w), 1, overlap.h);
      const current = (job = {
        worker: /** @type {Worker | null} */ (null),
        overlap,
        rects: plane.rects,
        bitmaps: [a, b],
        rows,
        strip: /** @type {CanvasRenderingContext2D} */ (makeCanvas(overlap.w, rows).getContext('2d', { willReadFrequently: true })),
        next: 0,
        done: 0,
        failed: '',
        histogram: /** @type {Uint32Array | null} */ (null),
        box: /** @type {Rect | null} */ (null),
        boxFor: -1,
        seq: 0,
        /** @type {Map<number, {resolve: (bitmap: ImageBitmap) => void, reject: (reason: Error) => void}>} */
        renders: new Map(),
        rendering: '',
      });
      const fail = (/** @type {string} */ reason) => {
        if (job === current) {
          current.failed = reason;
          updateResult();
        }
      };
      workerUrl().then((url) => {
        if (job !== current) {
          return;
        }
        const worker = (current.worker = new Worker(url));
        worker.onmessage = (e) => job === current && fromWorker(current, e.data);
        worker.onerror = (e) => fail(e.message || 'the worker stopped');
        worker.postMessage({ type: 'begin', width: overlap.w, height: overlap.h });
        try {
          // Two strips are under way at any time: the worker is never idle and the page never far ahead of it.
          sendStrip(current);
          sendStrip(current);
        } catch (err) {
          fail(String(err));
        }
      }, (err) => fail(String(err?.message ?? err)));
    }
    updateResult();
    requestDraw();
  }

  /** The pixels of some rows of the compared area, as one of the pictures has them there. */
  function readStrip(current, index, y, rows) {
    const { overlap, strip } = current;
    const r = current.rects[index];
    const bitmap = current.bitmaps[index];
    // "copy" replaces what the strip held, also where the picture leaves it empty.
    strip.globalCompositeOperation = 'copy';
    if (r.w === bitmap.width && r.h === bitmap.height) {
      strip.setTransform(1, 0, 0, 1, 0, 0);
      strip.imageSmoothingEnabled = false;
      strip.drawImage(bitmap, overlap.x - r.x, overlap.y - r.y + y, overlap.w, rows, 0, 0, overlap.w, rows);
    } else {
      // A scaled picture is drawn whole and clipped by the strip, so the rows of two strips join without a seam.
      strip.setTransform(r.w / bitmap.width, 0, 0, r.h / bitmap.height, r.x - overlap.x, r.y - overlap.y - y);
      strip.imageSmoothingEnabled = true;
      strip.imageSmoothingQuality = 'high';
      strip.drawImage(bitmap, 0, 0);
    }
    return strip.getImageData(0, 0, overlap.w, rows).data;
  }

  function sendStrip(current) {
    const { overlap } = current;
    if (job !== current || current.next >= overlap.h) {
      return;
    }
    const y = current.next;
    const rows = Math.min(current.rows, overlap.h - y);
    current.next += rows;
    const a = readStrip(current, 0, y, rows);
    const b = readStrip(current, 1, y, rows);
    current.worker.postMessage({ type: 'rows', y, rows, a: a.buffer, b: b.buffer }, [a.buffer, b.buffer]);
    if (current.next >= overlap.h) {
      current.worker.postMessage({ type: 'end' });
    }
  }

  function fromWorker(current, msg) {
    switch (msg.type) {
      case 'rows':
        current.done = msg.y;
        updateResult();
        try {
          sendStrip(current);
        } catch (err) {
          current.failed = String(err);
          updateResult();
        }
        break;
      case 'done':
        current.histogram = msg.histogram;
        askBox();
        updateResult();
        requestDraw();
        break;
      case 'box':
        if (msg.tolerance === settings.tolerance) {
          current.box = msg.box;
          current.boxFor = msg.tolerance;
          updateResult();
          requestDraw();
        }
        break;
      case 'rendered':
        current.renders.get(msg.seq)?.resolve(msg.bitmap);
        current.renders.delete(msg.seq);
        break;
    }
  }

  function askBox() {
    if (job?.histogram && job.boxFor !== settings.tolerance) {
      job.worker.postMessage({ type: 'box', tolerance: settings.tolerance });
    }
  }

  /** The marks of a part of the compared area, as a picture of the given size. @returns {Promise<ImageBitmap>} */
  function render(current, area, outWidth, outHeight) {
    return new Promise((resolve, reject) => {
      const seq = ++current.seq;
      current.renders.set(seq, { resolve, reject });
      current.worker.postMessage({ type: 'render', seq, ...area, outWidth, outHeight, tolerance: settings.tolerance, color: MARK });
    });
  }

  /** Asks for the marks of what the pane shows, unless they are there or on their way. One request runs at a time; `draw()` asks again. */
  function wantMarks(pane) {
    if (!job?.histogram || job.rendering) {
      return;
    }
    const o = job.overlap;
    const dpr = window.devicePixelRatio || 1;
    const density = view.scale * dpr;
    let left = Math.max(o.x, Math.floor(-view.x / view.scale));
    let top = Math.max(o.y, Math.floor(-view.y / view.scale));
    let right = Math.min(o.x + o.w, Math.ceil((pane.w - view.x) / view.scale));
    let bottom = Math.min(o.y + o.h, Math.ceil((pane.h - view.y) / view.scale));
    if (right <= left || bottom <= top) {
      return;
    }
    let outWidth = right - left;
    let outHeight = bottom - top;
    if (density < 1) {
      // Zoomed out, the marks are made for the pixels of the screen, one for one: drawn at any other size,
      // a mark of a single pixel could fall between two of them and be lost.
      const toScreen = (v, offset) => (offset + v * view.scale) * dpr;
      const x0 = Math.floor(toScreen(left, view.x));
      const y0 = Math.floor(toScreen(top, view.y));
      outWidth = Math.ceil(toScreen(right, view.x)) - x0;
      outHeight = Math.ceil(toScreen(bottom, view.y)) - y0;
      left = (x0 / dpr - view.x) / view.scale;
      top = (y0 / dpr - view.y) / view.scale;
      right = left + outWidth / density;
      bottom = top + outHeight / density;
    }
    const area = { x: left - o.x, y: top - o.y, w: right - left, h: bottom - top };
    const key = [settings.tolerance, area.x, area.y, area.w, area.h, outWidth, outHeight].join();
    if (marks?.key === key && marks.job === job) {
      return;
    }
    const current = job;
    current.rendering = key;
    render(current, area, outWidth, outHeight).then(
      (bitmap) => {
        current.rendering = '';
        marks?.bitmap.close();
        marks = { job: current, key, bitmap, x: left, y: top, w: area.w, h: area.h };
        requestDraw();
      },
      () => undefined,
    );
  }

  const extent = () => (plane.union ? `${plane.union.w} × ${plane.union.h}` : '');

  /**
   * The pictures or the way they lie changed: everything that follows from them is worked out again. The view
   * is kept when the plane has its old size, which is what a file that is being edited comes back with.
   */
  function rearrange(refit = false) {
    const before = extent();
    layOut();
    if (keptView && keptView.extent === extent()) {
      Object.assign(view, { scale: keptView.scale, x: keptView.x, y: keptView.y });
      autoFit = false;
      keptView = null;
    } else if (refit || extent() !== before) {
      autoFit = true;
      fitNow();
    }
    settlePane();
    updateFacts();
    compare();
  }

  // ---- Saving the difference ----------------------------------------------

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  let saving = false;
  let pendingSize = 0;

  /**
   * The picture of the difference mode at full size: the compared area of A, faded towards white, with the
   * pixels that differ marked. It is put together strip by strip, like the comparison itself.
   */
  async function saveDifference() {
    const current = job;
    if (!current?.histogram || saving) {
      return;
    }
    saving = true;
    toast('Preparing the difference picture…', true);
    try {
      const { overlap } = current;
      const out = makeCanvas(overlap.w, overlap.h);
      const c = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, overlap.w, overlap.h);
      c.globalAlpha = FADE;
      c.drawImage(current.bitmaps[0], -overlap.x, -overlap.y);
      c.globalAlpha = 1;
      for (let y = 0; y < overlap.h; y += current.rows) {
        const rows = Math.min(current.rows, overlap.h - y);
        const bitmap = await render(current, { x: 0, y, w: overlap.w, h: rows }, overlap.w, rows);
        c.drawImage(bitmap, 0, y);
        bitmap.close();
      }
      const blob = await new Promise((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded.'))), 'image/png'),
      );
      pendingSize = blob.size;
      vscode.postMessage({ type: 'save', data: await toBase64(blob) });
      toast('');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    saving = false;
  }

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

  /** Decodes run one after the other: two decoders at once would double the peak of memory on large pictures. */
  let decodes = Promise.resolve();

  function setBitmap(side, bitmap) {
    if (side.bitmap) {
      // Nothing may read the old picture after this.
      endJob();
      side.bitmap.close();
    }
    side.bitmap = bitmap;
  }

  function receiveSide(msg) {
    const side = sides[msg.index === 1 ? 1 : 0];
    side.control?.abort();
    const control = (side.control = new AbortController());
    if (msg.error) {
      setBitmap(side, null);
      Object.assign(side, { error: String(msg.error), busy: '', size: 0, hash: '', format: '', remarks: [] });
      rearrange();
      return;
    }
    const bytes = toBytes(msg.bytes);
    // A picture that is replaced (the file changed on disk) stays on screen until the new one is ready.
    side.error = '';
    side.busy = side.bitmap ? '' : 'Loading…';
    updateFacts();
    requestDraw();
    decodes = decodes.then(async () => {
      if (control.signal.aborted) {
        return;
      }
      let result;
      try {
        const decoder = /** @type {any} */ (window).previewixImages;
        if (!decoder) {
          throw new Error('The image decoder (dist/webview/imageDecode.js) could not be loaded.');
        }
        result = await decoder.decode(bytes, {
          signal: control.signal,
          onBusy: (/** @type {string} */ format) => {
            if (!side.bitmap && !control.signal.aborted) {
              side.busy = `Decoding ${format}…`;
              updateFacts();
              requestDraw();
            }
          },
        });
      } catch (err) {
        if (!control.signal.aborted) {
          setBitmap(side, null);
          Object.assign(side, { error: err instanceof Error ? err.message : String(err), busy: '', remarks: [] });
          rearrange();
        }
        return;
      }
      if (control.signal.aborted) {
        result.bitmap.close();
        return;
      }
      setBitmap(side, result.bitmap);
      const remarks = [];
      if (msg.animated) {
        remarks.push('first frame of an animation');
      } else if (result.pages.length > 1) {
        remarks.push(`one of ${result.pages.length} pictures in the file`);
      }
      if (result.warning) {
        remarks.push(result.warning);
      }
      Object.assign(side, { size: msg.size, hash: msg.hash, format: result.format, busy: '', error: '', remarks });
      rearrange();
    });
  }

  // ---- Controls -----------------------------------------------------------

  let blinking = 0;

  function updateControls() {
    document.body.dataset.mode = settings.mode;
    document.querySelectorAll('#modes button').forEach((button) => {
      const el = /** @type {HTMLElement} */ (button);
      el.classList.toggle('active', el.dataset.mode === settings.mode);
    });
    $('blinkOptions').hidden = settings.mode !== 'blink';
    $('onionOptions').hidden = settings.mode !== 'onion';
    $('opacity').value = String(settings.opacity);
    $('opacityValue').textContent = `${settings.opacity}%`;
    $('toleranceRange').value = String(settings.tolerance);
    // Not while it is being typed into: an emptied field would turn into 0 under the cursor.
    if (document.activeElement !== $('tolerance')) {
      $('tolerance').value = String(settings.tolerance);
    }
    clearInterval(blinking);
    blinking = 0;
    if (settings.mode === 'blink' && $('auto').checked) {
      blinking = setInterval(() => {
        shown = 1 - shown;
        requestDraw();
      }, 500);
    }
  }

  function setMode(mode) {
    if (settings.mode !== mode) {
      settings.mode = mode;
      keep();
      // The provider starts the next comparison in the mode used last.
      vscode.postMessage({ type: 'mode', mode });
    }
    updateControls();
    settlePane();
    requestDraw();
  }

  /** Space: the other picture in place of the one on screen. From another mode it leads into the blink mode. */
  function flip() {
    shown = settings.mode === 'blink' ? 1 - shown : 1;
    setMode('blink');
  }

  function setTolerance(value) {
    const tolerance = clamp(Math.round(Number(value)) || 0, 0, 255);
    if (tolerance !== settings.tolerance) {
      settings.tolerance = tolerance;
      keep();
      askBox();
      updateResult();
      requestDraw();
    }
    updateControls();
  }

  function swap() {
    settings.swapped = !settings.swapped;
    if (settings.align === 'custom') {
      // B stays where it was on screen, which seen from the other picture is the opposite way.
      settings.dx = -settings.dx;
      settings.dy = -settings.dy;
    }
    keep();
    rearrange(true);
  }

  function setAlignment(align) {
    settings.align = align;
    keep();
    rearrange(true);
  }

  /** Moves B over A by whole pixels, for a picture that was cropped or shifted. */
  function nudge(dx, dy) {
    const a = pic(0).bitmap;
    const b = pic(1).bitmap;
    if (!a || !b || settings.align === 'scale') {
      return;
    }
    const [x, y] = offsetOf(a, b);
    settings.align = 'custom';
    settings.dx = x + dx;
    settings.dy = y + dy;
    keep();
    layOut();
    settlePane();
    updateFacts();
    endJob();
    updateResult();
    requestDraw();
    // A run of key presses is compared once, when it ends.
    clearTimeout(restart);
    restart = setTimeout(compare, 150);
  }

  document.querySelectorAll('#modes button').forEach((button) => {
    button.addEventListener('click', () => setMode(/** @type {HTMLElement} */ (button).dataset.mode));
  });
  $('flip').addEventListener('click', flip);
  $('auto').addEventListener('change', updateControls);
  $('opacity').addEventListener('input', () => {
    settings.opacity = Number($('opacity').value);
    keep();
    updateControls();
    requestDraw();
  });
  $('toleranceRange').addEventListener('input', () => setTolerance($('toleranceRange').value));
  $('tolerance').addEventListener('input', () => setTolerance($('tolerance').value));
  $('tolerance').addEventListener('change', () => {
    $('tolerance').blur();
    updateControls();
  });
  for (const input of [$('opacity'), $('toleranceRange'), $('auto')]) {
    // A control that keeps the focus after the mouse let go of it would swallow the shortcuts.
    input.addEventListener('change', () => input.blur());
  }
  $('align').addEventListener('change', () => {
    // A select that keeps the focus would swallow the shortcuts.
    $('align').blur();
    setAlignment($('align').value);
  });
  $('zoomFit').addEventListener('click', fit);
  $('zoomActual').addEventListener('click', () => zoomTo(1));
  $('frame').addEventListener('click', () => {
    settings.frame = !settings.frame;
    keep();
    updateResult();
    requestDraw();
  });
  $('jump').addEventListener('click', jump);
  $('swap').addEventListener('click', swap);
  $('save').addEventListener('click', saveDifference);
  for (const index of [0, 1]) {
    // The provider knows the pictures by its own numbers, whichever is A now.
    $(index ? 'factB' : 'factA').querySelector('button').addEventListener('click', () => vscode.postMessage({ type: 'open', index: settings.swapped ? 1 - index : index }));
  }

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
    let key = e.key.toLowerCase();
    // On a keyboard layout without Latin letters the shortcuts go by the position of the key.
    if (key.length === 1 && key > '\x7f') {
      const letter = /^Key([A-Z])$/.exec(e.code);
      key = letter ? letter[1].toLowerCase() : e.code === 'BracketLeft' ? '[' : e.code === 'BracketRight' ? ']' : key;
    }
    if ((e.metaKey || e.ctrlKey) && key === 's') {
      e.preventDefault();
      saveDifference();
    } else if (typing || e.metaKey || e.ctrlKey) {
      return;
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.altKey ? (e.shiftKey ? 10 : 1) : e.shiftKey ? 200 : 40;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (e.altKey) {
        nudge(dx, dy);
      } else {
        // The arrows move the eye over the pictures, so the pictures go the other way.
        view.x -= dx;
        view.y -= dy;
        autoFit = false;
        keepSoon();
        requestDraw();
      }
    } else if (e.altKey) {
      return;
    } else if (e.key === ' ') {
      e.preventDefault();
      flip();
    } else if (key === '0') {
      fit();
    } else if (key === '1') {
      zoomTo(1);
    } else if (key === '+' || key === '=') {
      zoomTo(view.scale * 1.25);
    } else if (key === '-') {
      zoomTo(view.scale / 1.25);
    } else if (key === '[' || key === ']') {
      setTolerance(settings.tolerance + (key === ']' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    } else if (key === 'j') {
      jump();
    } else if (key === 'x') {
      swap();
    } else if (key === 'f') {
      $('frame').click();
    } else {
      const mode = { s: 'side', b: 'blink', w: 'swipe', o: 'onion', d: 'diff' }[key];
      if (mode) {
        e.preventDefault();
        setMode(mode);
      }
    }
  });

  // A button that keeps the focus would take the next Space for itself.
  document.addEventListener('click', (e) => {
    const button = /** @type {HTMLElement} */ (e.target).closest?.('button');
    button?.blur();
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        // A tab that is new starts in the mode used last; one that came back keeps its own.
        if (id !== msg.id && MODES.includes(msg.mode)) {
          settings.mode = msg.mode;
        }
        id = msg.id;
        keep();
        msg.sides.forEach((label, index) => Object.assign(sides[index], { name: label.name, detail: label.detail, tip: label.tip }));
        updateControls();
        settlePane();
        updateFacts();
        requestDraw();
        break;
      case 'side':
        receiveSide(msg);
        break;
      case 'saved':
        toast(`Saved ${msg.name} (${formatBytes(pendingSize)})`);
        break;
    }
  });

  updateControls();
  updateFacts();
  vscode.postMessage({ type: 'ready' });
})();
