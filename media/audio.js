// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  /** @type {HTMLAudioElement} */
  const audio = $('audio');
  /** @type {HTMLCanvasElement} */
  const wave = $('wave');
  const speed = $('speed');
  const loop = $('loop');

  const saved = vscode.getState() || {};
  let fileName = '';

  // ---- Playback -----------------------------------------------------------

  /** Position to return to once a (re)loaded source is ready. */
  let resume = { time: saved.time || 0, playing: false };

  function showNotice(text) {
    $('notice').textContent = text;
  }

  function saveState() {
    vscode.setState({ time: audio.currentTime, speed: speed.value, loop: loop.checked });
  }

  function setSource(src) {
    audio.src = src;
    audio.playbackRate = Number(speed.value);
  }

  if (saved.speed) {
    speed.value = saved.speed;
  }
  loop.checked = !!saved.loop;
  audio.loop = loop.checked;

  audio.addEventListener('loadedmetadata', () => {
    audio.playbackRate = Number(speed.value);
    if (resume.time && resume.time < audio.duration - 0.5) {
      audio.currentTime = resume.time;
    }
    if (resume.playing) {
      audio.play().catch(() => undefined);
    }
    resume = { time: 0, playing: false };
    drawWave();
  });

  audio.addEventListener('error', () => {
    if (audio.src) {
      showNotice("VS Code can't play this file: its format or codec isn't supported by the built-in player.");
    }
  });

  let lastSave = 0;
  audio.addEventListener('timeupdate', () => {
    if (Date.now() - lastSave > 1000) {
      lastSave = Date.now();
      saveState();
    }
    drawWave();
  });
  for (const event of ['seeked', 'play', 'pause', 'ended']) {
    audio.addEventListener(event, drawWave);
  }

  speed.addEventListener('change', () => {
    audio.playbackRate = Number(speed.value);
    saveState();
  });
  loop.addEventListener('change', () => {
    audio.loop = loop.checked;
    saveState();
  });

  // ---- Waveform -----------------------------------------------------------

  /** @type {number[]} */
  let peaks = [];

  function drawWave() {
    if (wave.hidden) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = wave.clientWidth;
    const height = wave.clientHeight;
    if (wave.width !== Math.round(width * dpr) || wave.height !== Math.round(height * dpr)) {
      wave.width = Math.round(width * dpr);
      wave.height = Math.round(height * dpr);
    }
    const ctx = /** @type {CanvasRenderingContext2D} */ (wave.getContext('2d'));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const style = getComputedStyle(wave);
    const played = style.getPropertyValue('--played').trim();
    const rest = style.getPropertyValue('--rest').trim();
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    const step = 3;
    const bars = Math.floor(width / step);
    for (let i = 0; i < bars; i++) {
      // Each bar shows the loudest of the peaks that fall into it.
      const from = Math.floor((i * peaks.length) / bars);
      const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars));
      let peak = 0;
      for (let j = from; j < to; j++) {
        peak = Math.max(peak, peaks[j]);
      }
      const bar = Math.max(2, peak * (height - 4));
      ctx.fillStyle = (i + 0.5) / bars <= progress ? played : rest;
      ctx.fillRect(i * step, (height - bar) / 2, step - 1, bar);
    }
  }

  function seekFromPointer(e) {
    if (audio.duration) {
      const rect = wave.getBoundingClientRect();
      audio.currentTime = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * audio.duration;
      drawWave();
    }
  }

  wave.addEventListener('pointerdown', (e) => {
    wave.setPointerCapture(e.pointerId);
    seekFromPointer(e);
  });
  wave.addEventListener('pointermove', (e) => {
    if (wave.hasPointerCapture(e.pointerId)) {
      seekFromPointer(e);
    }
  });
  new ResizeObserver(drawWave).observe(wave);

  // ---- Tags ---------------------------------------------------------------

  const FIELDS = [
    { key: 'title', label: 'Title', wide: true },
    { key: 'artist', label: 'Artist' },
    { key: 'album', label: 'Album' },
    { key: 'album_artist', label: 'Album artist' },
    { key: 'composer', label: 'Composer' },
    { key: 'genre', label: 'Genre' },
    { key: 'date', label: 'Year' },
    { key: 'track', label: 'Track', hint: 'number, or number/total' },
    { key: 'disc', label: 'Disc', hint: 'number, or number/total' },
    { key: 'comment', label: 'Comment', wide: true, rows: 2 },
    { key: 'lyrics', label: 'Lyrics', wide: true, rows: 6 },
  ];

  /** @type {Record<string, HTMLInputElement | HTMLTextAreaElement>} */
  const inputs = {};
  /** Tags as they are in the file. @type {Record<string, string>} */
  let original = {};
  /** @type {{mime: string, bytes: any} | null} */
  let originalCover = null;
  /** What saving will do to the cover. @type {'keep' | 'remove' | 'replace'} */
  let coverAction = 'keep';
  let writable = false;
  let coverWritable = false;
  let coverUrl = '';

  for (const field of FIELDS) {
    const label = document.createElement('label');
    label.className = field.wide ? 'field wide' : 'field';
    const caption = document.createElement('span');
    caption.textContent = field.label;
    const input = document.createElement(field.rows ? 'textarea' : 'input');
    if (field.rows) {
      /** @type {HTMLTextAreaElement} */ (input).rows = field.rows;
    }
    input.spellcheck = false;
    input.title = field.hint || '';
    input.addEventListener('input', updateDirty);
    inputs[field.key] = input;
    label.append(caption, input);
    $('form').append(label);
  }

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

  function showCover(cover) {
    if (coverUrl) {
      URL.revokeObjectURL(coverUrl);
    }
    coverUrl = cover ? URL.createObjectURL(new Blob([toBytes(cover.bytes)], { type: cover.mime })) : '';
    $('coverImage').hidden = !cover;
    $('coverEmpty').hidden = !!cover;
    if (cover) {
      $('coverImage').src = coverUrl;
    }
    $('coverRemove').disabled = !cover || !coverWritable;
  }

  const currentFields = () => Object.fromEntries(FIELDS.map((f) => [f.key, inputs[f.key].value.replace(/\r\n?/g, '\n').trim()]));

  // What the form reads back right after the stored values were put into it. A stored value with CRLF or
  // outer spaces doesn't survive that trip, and must not count as an edit.
  let clean = {};

  function isDirty() {
    const now = currentFields();
    return coverAction !== 'keep' || FIELDS.some((f) => now[f.key] !== clean[f.key]);
  }

  // Fields that weren't edited go back exactly as they are stored, so a save rewrites only what changed.
  function editedFields() {
    const now = currentFields();
    return Object.fromEntries(FIELDS.map((f) => [f.key, now[f.key] === clean[f.key] ? original[f.key] || '' : now[f.key]]));
  }

  function updateDirty() {
    const dirty = writable && isDirty();
    $('save').disabled = !dirty;
    $('revert').disabled = !dirty;
    if (dirty) {
      $('status').textContent = '';
    }
  }

  function updateHeader() {
    $('title').textContent = original.title || fileName;
    $('subtitle').textContent = [original.artist, original.album].filter(Boolean).join(' — ');
  }

  function resetForm() {
    for (const field of FIELDS) {
      inputs[field.key].value = original[field.key] || '';
    }
    clean = currentFields();
    coverAction = 'keep';
    showCover(originalCover);
    updateDirty();
  }

  function loadTags(msg) {
    $('tags').hidden = !!msg.unavailable;
    original = msg.fields || {};
    originalCover = msg.cover || null;
    writable = !!msg.writable;
    coverWritable = !!msg.coverWritable;
    for (const field of FIELDS) {
      inputs[field.key].readOnly = !writable;
    }
    $('coverChange').disabled = !coverWritable;
    $('coverButtons').hidden = !writable;
    $('tagNote').textContent = msg.note || '';
    $('tagNote').hidden = !msg.note;

    const other = msg.other || [];
    $('otherBox').hidden = !other.length;
    $('other').replaceChildren(...other.flatMap(([key, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }));
    resetForm();
    updateHeader();
  }

  function save() {
    if ($('save').disabled) {
      return;
    }
    $('save').disabled = true;
    $('revert').disabled = true;
    $('status').textContent = 'Saving…';
    // The file is about to be replaced; playback picks up where it was.
    resume = { time: audio.currentTime, playing: !audio.paused };
    vscode.postMessage({ type: 'save', fields: editedFields(), cover: coverAction });
  }

  $('save').addEventListener('click', save);
  $('revert').addEventListener('click', resetForm);
  $('coverChange').addEventListener('click', () => vscode.postMessage({ type: 'pickCover' }));
  $('coverRemove').addEventListener('click', () => {
    coverAction = originalCover ? 'remove' : 'keep';
    showCover(null);
    updateDirty();
  });

  // ---- Stream details -----------------------------------------------------

  let sections = [];

  function renderInfo() {
    const root = $('sections');
    root.textContent = '';
    for (const section of sections) {
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

  $('copy').addEventListener('click', () => {
    const text = sections
      .map((s) => `${s.title}\n${s.rows.map(([label, value]) => `  ${label}: ${value}`).join('\n')}`)
      .join('\n\n');
    vscode.postMessage({ type: 'copy', text });
  });

  // ---- Keyboard -----------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(target.tagName) || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    } else if (e.key === ' ' && target !== audio) {
      e.preventDefault();
      audio.paused ? audio.play() : audio.pause();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && target !== audio) {
      audio.currentTime += e.key === 'ArrowLeft' ? -5 : 5;
    }
  });

  // ---- Messages -----------------------------------------------------------

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'source':
        fileName = msg.name;
        if (audio.src && !resume.time) {
          resume = { time: audio.currentTime, playing: !audio.paused };
        }
        showNotice('');
        setSource(msg.src);
        updateHeader();
        break;
      case 'info':
        sections = msg.sections;
        $('summary').textContent = msg.summary;
        renderInfo();
        break;
      case 'peaks':
        peaks = msg.peaks;
        wave.hidden = !peaks.length;
        drawWave();
        break;
      case 'tags':
        loadTags(msg);
        break;
      case 'coverPicked':
        coverAction = 'replace';
        showCover(msg.cover);
        updateDirty();
        break;
      case 'saved':
        $('status').textContent = 'Saved';
        break;
      case 'saveError':
        $('status').textContent = '';
        $('tagNote').textContent = `The tags could not be saved: ${msg.message}`;
        $('tagNote').hidden = false;
        updateDirty();
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
