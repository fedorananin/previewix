// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  const stage = $('stage');
  /** @type {HTMLCanvasElement} */
  const canvas = $('view');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  /** @type {HTMLImageElement} */
  const fallback = $('fallback');
  const strip = $('strip');
  const stripInner = $('stripInner');
  const scrub = $('scrub');

  const MAX_SCALE = 64;
  /** Decoded frames kept around, by their RGBA size. Past this the least recently used ones are dropped. */
  const CACHE_BYTES = 192 * 1024 * 1024;
  /** Frames decoded ahead of the one on screen during playback. */
  const AHEAD = 3;
  const THUMB_HEIGHT = 48;
  /** Thumbnails kept once drawn; the cells themselves exist only while they are in view. */
  const MAX_THUMBS = 800;

  // ---- State --------------------------------------------------------------

  const saved = vscode.getState() || {};

  /** @type {any} */
  let decoder = null;
  /** Bumped by every load, so that a decode started for the previous file is dropped when it arrives. */
  let generation = 0;
  let width = 0;
  let height = 0;
  let count = 0;
  /** Delay of every frame in ms, as played. @type {number[]} */
  let delays = [];
  /** Time at which every frame starts, in ms. @type {number[]} */
  let starts = [];
  let total = 0;
  /** False when the container couldn't be read and the delays are learned from frames as they are decoded. */
  let delaysKnown = true;
  let fileInfo = { name: '', size: 0, format: '', plays: 0, frames: 0 };

  let index = Number(saved.frame) || 0;
  let playing = saved.playing !== false;
  let speed = Number(saved.speed) || 1;
  let loop = saved.loop !== false;
  let stripShown = saved.strip !== false;
  /** The page is in `<img>` mode: the animation plays, but single frames are out of reach. */
  let plain = false;
  let loaded = false;

  /** Decoded frames, least recently used first. @type {Map<number, ImageBitmap>} */
  const cache = new Map();
  let cacheLimit = 8;
  /** Frames the decoder gave up on, so they aren't asked for again. @type {Set<number>} */
  const failed = new Set();
  /** The frame that is on screen, which lags behind `index` while that one is being decoded. */
  let shownIndex = -1;
  let busy = false;

  /** @type {Map<number, HTMLCanvasElement>} */
  const thumbs = new Map();
  /** Cells currently in the strip. @type {Map<number, HTMLElement>} */
  const cells = new Map();
  let thumbWidth = THUMB_HEIGHT;
  let cellWidth = THUMB_HEIGHT + 8;

  // screen = image * scale + offset, in CSS pixels relative to the stage
  const view = { scale: 1, x: 0, y: 0 };
  /** Until the user zooms or pans, the picture keeps fitting the window. */
  let fitted = true;
  /** @type {{x: number, y: number} | null} */
  let panFrom = null;

  // ---- Helpers ------------------------------------------------------------

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const kb = bytes / 1024;
    return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(2)} MB`;
  }

  function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    return `${minutes}:${((ms - minutes * 60000) / 1000).toFixed(2).padStart(5, '0')}`;
  }

  /** Browsers play a frame with a delay of 10 ms or less for 100 ms, and so does this page. */
  const played = (ms) => (ms > 10 ? ms : 100);

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000);
  }

  function showMessage(text) {
    $('message').textContent = text;
    $('message').hidden = !text;
  }

  let stateTimer = 0;
  /** Playback changes the frame many times a second, so the state is written at most a few times a second. */
  function saveState() {
    stateTimer ||= setTimeout(() => {
      stateTimer = 0;
      vscode.setState({ frame: index, playing, speed, loop, strip: stripShown, view: fitted ? null : { ...view } });
    }, 300);
  }

  function setTimes() {
    starts = [];
    total = 0;
    for (const delay of delays) {
      starts.push(total);
      total += delay;
    }
  }

  // ---- Drawing ------------------------------------------------------------

  const checker = (() => {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 16;
    const t = /** @type {CanvasRenderingContext2D} */ (tile.getContext('2d'));
    t.fillStyle = '#ffffff';
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = '#d9d9d9';
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
    return /** @type {CanvasPattern} */ (ctx.createPattern(tile, 'repeat'));
  })();

  let frameRequest = 0;
  function requestDraw() {
    frameRequest ||= requestAnimationFrame(() => {
      frameRequest = 0;
      draw();
    });
  }

  function draw() {
    $('statZoom').textContent = width ? `${Math.round(view.scale * 100)}%` : '';
    if (plain) {
      fallback.style.left = `${view.x}px`;
      fallback.style.top = `${view.y}px`;
      fallback.style.width = `${width * view.scale}px`;
      fallback.style.height = `${height * view.scale}px`;
      fallback.classList.toggle('pixels', view.scale >= 4);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    // While the wanted frame is being decoded the previous one stays up, which is what makes scrubbing smooth.
    const bitmap = cache.get(index) ?? cache.get(shownIndex);
    if (!bitmap) {
      return;
    }
    shownIndex = cache.has(index) ? index : shownIndex;
    ctx.fillStyle = checker;
    ctx.fillRect(view.x, view.y, width * view.scale, height * view.scale);
    // Show individual pixels when zoomed far in.
    ctx.imageSmoothingEnabled = view.scale < 4;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, view.x, view.y, width * view.scale, height * view.scale);
  }

  // ---- View ---------------------------------------------------------------

  function fit() {
    if (!width) {
      return;
    }
    const pad = 24;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    view.scale = Math.max(Math.min((cw - pad * 2) / width, (ch - pad * 2) / height, 1), 0.01);
    view.x = (cw - width * view.scale) / 2;
    view.y = (ch - height * view.scale) / 2;
    fitted = true;
    saveState();
    requestDraw();
  }

  function zoomAt(s, factor) {
    if (!width) {
      return;
    }
    const minScale = Math.min(0.05, 16 / Math.max(width, height));
    const next = clamp(view.scale * factor, minScale, MAX_SCALE);
    view.x = s.x - ((s.x - view.x) * next) / view.scale;
    view.y = s.y - ((s.y - view.y) * next) / view.scale;
    view.scale = next;
    fitted = false;
    saveState();
    requestDraw();
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
    if (!width || (e.button !== 0 && e.button !== 1)) {
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
    requestDraw();
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
    fitted ? fit() : requestDraw();
    renderStrip();
  }).observe(stage);

  // ---- Decoding -----------------------------------------------------------

  function dropFrames() {
    for (const bitmap of cache.values()) {
      bitmap.close();
    }
    cache.clear();
    failed.clear();
    shownIndex = -1;
  }

  function store(i, bitmap) {
    cache.get(i)?.close();
    cache.delete(i);
    cache.set(i, bitmap);
    for (const key of cache.keys()) {
      if (cache.size <= cacheLimit) {
        break;
      }
      // The frame on screen and the one about to be shown are not up for eviction.
      if (key !== index && key !== shownIndex && key !== i) {
        /** @type {ImageBitmap} */ (cache.get(key)).close();
        cache.delete(key);
      }
    }
  }

  /** Marks a frame as recently used. */
  function touch(i) {
    const bitmap = cache.get(i);
    if (bitmap) {
      cache.delete(i);
      cache.set(i, bitmap);
    }
  }

  /** The frame to decode next: the one to show, then the ones playback is about to need, then thumbnails in view. */
  function nextJob() {
    const wanted = (i) => !cache.has(i) && !failed.has(i);
    if (wanted(index)) {
      return index;
    }
    if (playing) {
      for (let k = 1; k <= Math.min(AHEAD, cacheLimit - 2); k++) {
        const i = index + k < count ? index + k : loop ? (index + k) % count : -1;
        if (i >= 0 && wanted(i)) {
          return i;
        }
      }
    }
    if (stripShown) {
      // In ascending order, which is the cheap direction for formats whose frames build on the previous one.
      for (const i of [...cells.keys()].sort((a, b) => a - b)) {
        if (!thumbs.has(i) && !failed.has(i)) {
          return i;
        }
      }
    }
    return -1;
  }

  /** One decode at a time: what is worth decoding changes with every step and scroll. */
  async function pump() {
    if (busy || !decoder) {
      return;
    }
    const i = nextJob();
    if (i < 0) {
      return;
    }
    busy = true;
    const mine = generation;
    try {
      let bitmap = cache.get(i);
      if (!bitmap) {
        const { image } = await decoder.decode({ frameIndex: i });
        const duration = image.duration;
        bitmap = await createImageBitmap(image);
        image.close();
        if (mine !== generation) {
          bitmap.close();
          return;
        }
        if (!delaysKnown && duration !== null && played(duration / 1000) !== delays[i]) {
          delays[i] = played(Math.round(duration / 1000));
          setTimes();
          updateCounter();
          updateInfo();
        }
        store(i, bitmap);
      }
      paintThumb(i, bitmap);
      if (i === index) {
        showMessage('');
        requestDraw();
      }
    } catch (err) {
      if (mine === generation) {
        failed.add(i);
        if (i === index) {
          toast(`Frame ${i + 1} could not be decoded`);
        }
      }
    } finally {
      busy = false;
      if (mine === generation) {
        pump();
      }
    }
  }

  // ---- Frame strip --------------------------------------------------------

  function paintThumb(i, bitmap) {
    if (thumbs.has(i) || !stripShown) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const thumb = document.createElement('canvas');
    thumb.width = Math.round(thumbWidth * dpr);
    thumb.height = Math.round(THUMB_HEIGHT * dpr);
    thumb.style.width = `${thumbWidth}px`;
    const t = /** @type {CanvasRenderingContext2D} */ (thumb.getContext('2d'));
    // Very wide or tall pictures are letterboxed into the clamped cell.
    const scale = Math.min(thumb.width / width, thumb.height / height);
    t.imageSmoothingQuality = 'high';
    t.drawImage(bitmap, (thumb.width - width * scale) / 2, (thumb.height - height * scale) / 2, width * scale, height * scale);
    thumbs.set(i, thumb);
    cells.get(i)?.firstElementChild?.replaceWith(thumb);
    for (const key of thumbs.keys()) {
      if (thumbs.size <= MAX_THUMBS) {
        break;
      }
      if (!cells.has(key)) {
        thumbs.delete(key);
      }
    }
  }

  function makeCell(i) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.index = String(i);
    cell.style.left = `${i * cellWidth + 4}px`;
    let picture = thumbs.get(i);
    if (!picture) {
      picture = /** @type {any} */ (document.createElement('div'));
      /** @type {HTMLElement} */ (picture).className = 'blank';
      /** @type {HTMLElement} */ (picture).style.width = `${thumbWidth}px`;
    }
    const label = document.createElement('span');
    label.textContent = String(i + 1);
    cell.append(/** @type {Node} */ (picture), label);
    cell.classList.toggle('current', i === index);
    return cell;
  }

  /** Keeps cells only for the stretch of the strip that is in view, however many frames there are. */
  function renderStrip() {
    if (!stripShown || !count || plain) {
      return;
    }
    const from = Math.max(0, Math.floor(strip.scrollLeft / cellWidth) - 2);
    const to = Math.min(count - 1, Math.ceil((strip.scrollLeft + strip.clientWidth) / cellWidth) + 2);
    for (const [i, cell] of cells) {
      if (i < from || i > to) {
        cell.remove();
        cells.delete(i);
      }
    }
    for (let i = from; i <= to; i++) {
      if (!cells.has(i)) {
        const cell = makeCell(i);
        cells.set(i, cell);
        stripInner.append(cell);
      }
    }
    pump();
  }

  function resetStrip() {
    for (const cell of cells.values()) {
      cell.remove();
    }
    cells.clear();
    thumbs.clear();
    thumbWidth = clamp(Math.round((THUMB_HEIGHT * width) / height), 24, 128);
    cellWidth = thumbWidth + 8;
    stripInner.style.width = `${count * cellWidth + 6}px`;
  }

  /** Scrolls the strip so that the current frame is in view. */
  function followStrip() {
    if (!stripShown || plain) {
      return;
    }
    const left = index * cellWidth;
    if (left < strip.scrollLeft || left + cellWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = left - (strip.clientWidth - cellWidth) / 2;
    }
    renderStrip();
  }

  let stripRequest = 0;
  strip.addEventListener('scroll', () => {
    stripRequest ||= requestAnimationFrame(() => {
      stripRequest = 0;
      renderStrip();
    });
  });

  // A mouse wheel only scrolls vertically, and the strip has nowhere to go that way.
  strip.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        strip.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      }
    },
    { passive: false },
  );

  stripInner.addEventListener('click', (e) => {
    const cell = /** @type {HTMLElement} */ (e.target).closest('.cell');
    if (cell) {
      pause();
      setIndex(Number(/** @type {HTMLElement} */ (cell).dataset.index));
    }
  });

  function setStrip(show) {
    stripShown = show;
    strip.hidden = !show || plain;
    $('stripToggle').classList.toggle('active', show && !plain);
    saveState();
    if (show) {
      followStrip();
    }
  }

  // ---- Playback -----------------------------------------------------------

  /** The moment (on the `performance.now()` clock) the next frame is due. */
  let dueAt = 0;
  let tickRequest = 0;

  function updateCounter() {
    if (!count || plain) {
      $('counter').textContent = '';
      return;
    }
    $('counter').textContent =
      `${index + 1} / ${count} · ${delays[index]} ms · ${formatTime(starts[index])} / ${formatTime(total)}`;
  }

  function setIndex(i) {
    const next = clamp(i, 0, count - 1);
    cells.get(index)?.classList.remove('current');
    index = next;
    cells.get(index)?.classList.add('current');
    touch(index);
    scrub.value = String(index + 1);
    updateCounter();
    followStrip();
    saveState();
    requestDraw();
    pump();
  }

  function requestTick() {
    tickRequest ||= requestAnimationFrame(tick);
  }

  function tick(now) {
    tickRequest = 0;
    if (!playing || !decoder) {
      return;
    }
    if (now >= dueAt) {
      const next = index + 1 < count ? index + 1 : 0;
      if (next === 0 && !loop) {
        pause();
        return;
      }
      // Frames are never skipped: a format like GIF has to decode every one of them anyway.
      if (cache.has(next) || failed.has(next)) {
        // A frame that is a little late keeps the rhythm; after a real stall the clock starts over.
        dueAt = (now - dueAt < 50 ? dueAt : now) + delays[next] / speed;
        setIndex(next);
      } else {
        pump();
      }
    }
    requestTick();
  }

  function play() {
    if (!decoder || count < 2) {
      return;
    }
    if (index === count - 1 && !loop) {
      setIndex(0);
    }
    playing = true;
    document.body.classList.add('playing');
    dueAt = performance.now() + delays[index] / speed;
    saveState();
    pump();
    requestTick();
  }

  function pause() {
    playing = false;
    document.body.classList.remove('playing');
    saveState();
  }

  /** A jump made by hand: playback goes on from the new frame. */
  function jump(i) {
    setIndex(i);
    dueAt = performance.now() + delays[index] / speed;
  }

  function step(by) {
    pause();
    setIndex(index + by);
  }

  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('first').addEventListener('click', () => jump(0));
  $('last').addEventListener('click', () => jump(count - 1));
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  scrub.addEventListener('input', () => jump(Number(scrub.value) - 1));
  $('speed').addEventListener('change', () => {
    speed = Number($('speed').value) || 1;
    dueAt = performance.now() + delays[index] / speed;
    saveState();
  });
  $('loop').addEventListener('change', () => {
    loop = $('loop').checked;
    saveState();
  });
  $('stripToggle').addEventListener('click', () => setStrip(!stripShown));
  $('zoomFit').addEventListener('click', fit);
  $('zoomActual').addEventListener('click', () => zoomTo(1));

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      saveFrame();
      return;
    }
    if (mod || e.altKey || target.tagName === 'SELECT') {
      return;
    }
    // The scrubber and the buttons would otherwise act on these keys a second time.
    const handled = () => {
      e.preventDefault();
      if (target instanceof HTMLElement && target !== document.body) {
        target.blur();
      }
    };
    if (key === '0') {
      fit();
    } else if (key === '1') {
      zoomTo(1);
    } else if (key === '+' || key === '=') {
      zoomTo(view.scale * 1.25);
    } else if (key === '-') {
      zoomTo(view.scale / 1.25);
    } else if (plain || !decoder) {
      return;
    } else if (e.key === ' ') {
      handled();
      playing ? pause() : play();
    } else if (key === ',' || e.key === 'ArrowLeft') {
      handled();
      step(-1);
    } else if (key === '.' || e.key === 'ArrowRight') {
      handled();
      step(1);
    } else if (e.key === 'Home') {
      handled();
      jump(0);
    } else if (e.key === 'End') {
      handled();
      jump(count - 1);
    } else if (key === 'l') {
      $('loop').click();
    } else if (key === 'f') {
      setStrip(!stripShown);
    }
  });

  // ---- Saving and copying a frame -----------------------------------------

  /** The frame on screen as a PNG, at its own size. */
  function encodeFrame() {
    const bitmap = cache.get(index);
    if (!bitmap) {
      return Promise.reject(new Error('The frame is still being decoded.'));
    }
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    /** @type {CanvasRenderingContext2D} */ (out.getContext('2d')).drawImage(bitmap, 0, 0);
    return new Promise((resolve, reject) => {
      out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The frame could not be encoded.'))), 'image/png');
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
  async function saveFrame() {
    if (!decoder) {
      return;
    }
    // The dialog takes a while; the frame it is about shouldn't move on meanwhile.
    pause();
    try {
      const blob = await encodeFrame();
      pendingSize = blob.size;
      vscode.postMessage({ type: 'save', frame: index + 1, data: await toBase64(blob) });
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  }
  $('saveFrame').addEventListener('click', saveFrame);

  // Left out altogether where the webview has no image clipboard.
  const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
  $('copyFrame').addEventListener('click', async () => {
    try {
      const blob = await encodeFrame();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(`Frame ${index + 1} copied to clipboard`);
    } catch (err) {
      toast(`Could not copy: ${err instanceof Error ? err.message : err}`);
    }
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

  function updateInfo() {
    if (!width) {
      return;
    }
    const { format, plays, size } = fileInfo;
    const parts = [format, `${width} × ${height} px`];
    const frames = plain ? fileInfo.frames : count;
    if (frames > 1) {
      parts.push(`${frames} ${frames === 1 ? 'frame' : 'frames'}`, `${(total / 1000).toFixed(2)} s`);
      parts.push(plays === 0 ? 'loops forever' : plays === 1 ? 'plays once' : `plays ${plays} times`);
    }
    parts.push(formatBytes(size));
    $('statInfo').textContent = parts.join(' · ');
  }

  function setControls() {
    const frames = !plain && count > 0;
    for (const id of ['first', 'prev', 'play', 'next', 'last', 'speed', 'loop', 'stripToggle', 'saveFrame', 'copyFrame']) {
      $(id).disabled = !frames || (count < 2 && id !== 'saveFrame' && id !== 'copyFrame');
    }
    scrub.disabled = !frames || count < 2;
    scrub.max = String(Math.max(1, count));
    scrub.value = String(index + 1);
    $('copyFrame').hidden = !canCopy;
    $('speed').value = String(speed);
    $('loop').checked = loop;
    strip.hidden = !stripShown || !frames;
    $('timeline').hidden = plain;
    $('stripToggle').classList.toggle('active', stripShown && frames);
  }

  /** Shows the file in an `<img>`, which animates on its own but gives no access to single frames. */
  function loadPlain(blob, info, note) {
    plain = true;
    count = 0;
    canvas.hidden = true;
    fallback.hidden = false;
    $('notice').textContent = note;
    $('notice').hidden = false;
    const mine = generation;
    const url = URL.createObjectURL(blob);
    fallback.onload = () => {
      if (mine !== generation) {
        return;
      }
      width = fallback.naturalWidth;
      height = fallback.naturalHeight;
      delays = info.delays.map(played);
      setTimes();
      updateInfo();
      showMessage('');
      fit();
    };
    fallback.onerror = () => showMessage('This image could not be decoded.');
    fallback.src = url;
    setControls();
    updateCounter();
  }

  async function load(msg) {
    const mine = ++generation;
    const first = !loaded;
    const bytes = toBytes(msg.bytes);
    const info = msg.info;
    const blob = new Blob([bytes], { type: info.mime });

    decoder?.close();
    decoder = null;
    dropFrames();
    plain = false;
    canvas.hidden = false;
    fallback.hidden = true;
    $('notice').hidden = true;
    fileInfo = { name: msg.name, size: bytes.byteLength, format: info.format, plays: info.plays, frames: info.delays.length };

    const Decoder = /** @type {any} */ (window).ImageDecoder;
    if (!Decoder || !(await Decoder.isTypeSupported(info.mime).catch(() => false))) {
      if (mine === generation) {
        loadPlain(blob, info, 'Stepping through frames needs a newer VS Code: this one cannot decode single frames. The animation plays as it is.');
      }
      return;
    }

    let opened;
    let firstFrame;
    try {
      opened = new Decoder({ data: bytes, type: info.mime, preferAnimation: true });
      // With the whole file at hand, this settles once every frame has been found.
      await opened.completed;
      await opened.tracks.ready;
      firstFrame = (await opened.decode({ frameIndex: 0 })).image;
    } catch (err) {
      opened?.close();
      if (mine === generation) {
        loadPlain(blob, info, `The frames of this file could not be decoded (${err instanceof Error ? err.message : err}). It is shown as it is.`);
      }
      return;
    }
    if (mine !== generation) {
      firstFrame.close();
      opened.close();
      return;
    }

    decoder = opened;
    const resized = width !== firstFrame.displayWidth || height !== firstFrame.displayHeight;
    width = firstFrame.displayWidth;
    height = firstFrame.displayHeight;
    count = opened.tracks.selectedTrack.frameCount;
    // The container is the quick way to every delay; a file it was misread for falls back to learning them.
    delaysKnown = info.delays.length === count;
    delays = delaysKnown ? info.delays.map(played) : new Array(count).fill(played(Math.round((firstFrame.duration ?? 0) / 1000)));
    setTimes();
    cacheLimit = clamp(Math.floor(CACHE_BYTES / (width * height * 4)), 4, 400);
    index = clamp(index, 0, count - 1);
    resetStrip();
    store(0, await createImageBitmap(firstFrame));
    firstFrame.close();
    if (mine !== generation) {
      return;
    }

    loaded = true;
    showMessage('');
    setControls();
    updateInfo();
    updateCounter();
    if (first && saved.view) {
      Object.assign(view, saved.view);
      fitted = false;
    } else if (first || resized || fitted) {
      fit();
    }
    setIndex(index);
    if (playing && count > 1) {
      play();
    } else {
      pause();
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        load(msg);
        break;
      case 'error':
        showMessage(msg.message);
        break;
      case 'saved':
        toast(`Saved ${msg.name} (${formatBytes(pendingSize)})`);
        break;
    }
  });

  setControls();
  vscode.postMessage({ type: 'ready' });
})();
