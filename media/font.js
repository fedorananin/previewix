// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const el = (/** @type {string} */ tag, className = '', text = '') => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };

  const saved = vscode.getState() || {};
  const WATERFALL = [12, 14, 18, 24, 32, 48, 64, 96];
  const GLYPH_PAGE = 600;

  /** @type {{name: string, size: number, format: string, faces: any[]} | null} */
  let file = null;
  let faceIndex = saved.face || 0;
  /** The face on screen. @type {any} */
  let face = null;
  /** Font registered for the face on screen. @type {FontFace | null} */
  let loaded = null;
  let loadCount = 0;

  let size = saved.size || 48;
  /** Sample text typed by the user; empty while a preset is shown. */
  let custom = saved.text || '';
  let preset = saved.preset || '';
  /** Axis values by tag. @type {Record<string, number>} */
  let axisValues = {};
  /** Features switched away from their default. @type {Record<string, boolean>} */
  let featureValues = {};
  /** Code points of the selected block, and how many of them are drawn. @type {number[]} */
  let glyphCodes = [];
  let glyphsShown = 0;
  let selectedCode = 0;

  function saveState() {
    vscode.setState({ face: faceIndex, size, text: custom, preset });
  }

  function toBytes(/** @type {any} */ data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    // Older hosts serialize buffers to JSON instead of transferring them.
    return new Uint8Array(Array.isArray(data?.data) ? data.data : Object.values(data));
  }

  function formatSize(/** @type {number} */ bytes) {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /** Axis positions come as 16.16 fixed-point numbers, which print with a long tail. */
  const round = (/** @type {number} */ value) => String(Number(value.toFixed(2)));
  const hex = (/** @type {number} */ code) => code.toString(16).toUpperCase().padStart(4, '0');

  // ---- Character set ------------------------------------------------------

  function has(/** @type {number} */ code) {
    return face.ranges.some((/** @type {[number, number]} */ [start, end]) => code >= start && code <= end);
  }

  /** Whitespace and control characters have nothing to show in the grid. */
  function drawable(/** @type {number} */ code) {
    return code > 0x20 && !(code >= 0x7f && code <= 0xa0) && !(code >= 0x2000 && code <= 0x200f) && !(code >= 0x2028 && code <= 0x202f) && code !== 0xfeff;
  }

  function codesOf(/** @type {number} */ blockIndex) {
    const codes = [];
    const blocks = /** @type {[string, number, number, number][]} */ (face.blocks);
    const picked = blocks[blockIndex];
    // "Other" is what is left outside the named blocks.
    const named = picked?.[0] === 'Other' ? blocks.filter((b) => b[0] !== 'Other') : [];
    for (const [start, end] of face.ranges) {
      const from = picked ? Math.max(start, picked[1]) : start;
      const to = picked ? Math.min(end, picked[2]) : end;
      for (let code = from; code <= to; code++) {
        if (drawable(code) && !named.some((b) => code >= b[1] && code <= b[2])) {
          codes.push(code);
        }
      }
    }
    return codes;
  }

  function firstCodes(/** @type {number} */ count) {
    const codes = [];
    for (const [start, end] of face.ranges) {
      for (let code = start; code <= end && codes.length < count; code++) {
        if (drawable(code)) {
          codes.push(code);
        }
      }
    }
    return codes;
  }

  // ---- Sample -------------------------------------------------------------

  /** @type {string[][]} */
  let presetList = [];

  /** Sample texts in the scripts the face supports. */
  function buildPresets() {
    const list = [];
    if (has(0x61)) {
      list.push(
        ['Pangram', 'The quick brown fox jumps over the lazy dog'],
        ['Alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz'],
        ['Paragraph', 'Typography is the craft of arranging type so that written language is legible, readable and appealing when displayed. The arrangement involves selecting typefaces, point sizes, line lengths, line spacing and letter spacing.'],
      );
    }
    if (has(0x30)) {
      list.push(['Numerals and punctuation', '0123456789\n.,:;!?‘’“”()[]{}/&@#%*+−=<>']);
    }
    if (has(0x430)) {
      list.push(['Cyrillic', 'Съешь же ещё этих мягких французских булок, да выпей чаю']);
    }
    if (has(0x3b1)) {
      list.push(['Greek', 'Ξεσκεπάζω την ψυχοφθόρα βδελυγμία']);
    }
    // Always available, and the only choice for symbol and icon fonts.
    list.push(['Characters of the font', firstCodes(80).map((code) => String.fromCodePoint(code)).join(has(0x61) ? '' : ' ')]);
    return list;
  }

  function sampleText() {
    return custom || presetList.find(([name]) => name === preset)?.[1] || presetList[0][1];
  }

  function renderPresets() {
    const options = presetList.map(([name]) => new Option(name, name));
    if (custom) {
      options.push(new Option('Your text', ''));
    }
    $('preset').replaceChildren(...options);
    $('preset').value = custom ? '' : presetList.some(([name]) => name === preset) ? preset : presetList[0][0];
  }

  function renderWaterfall() {
    const line = sampleText().split('\n')[0];
    $('waterfall').replaceChildren(
      ...WATERFALL.map((px) => {
        const row = el('div', 'row');
        const text = el('div', 'specimen', line);
        text.style.fontSize = `${px}px`;
        row.append(el('span', 'px', `${px}`), text);
        return row;
      }),
    );
  }

  function renderSample() {
    $('sample').textContent = sampleText();
    $('sample').style.fontSize = `${size}px`;
    $('size').value = String(size);
    $('sizeValue').textContent = `${size} px`;
    renderPresets();
    renderWaterfall();
  }

  // ---- Axes and features --------------------------------------------------

  function applyStyle() {
    const variations = face.axes.map((/** @type {any} */ axis) => `"${axis.tag}" ${axisValues[axis.tag]}`).join(', ');
    const features = Object.entries(featureValues).map(([tag, on]) => `"${tag}" ${on ? 1 : 0}`).join(', ');
    document.body.style.setProperty('--variations', variations || 'normal');
    document.body.style.setProperty('--features', features || 'normal');
    renderCss(variations, features);
  }

  // ---- CSS ----------------------------------------------------------------

  const CSS_FORMATS = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2', ttc: 'collection', otc: 'collection' };

  /** An `@font-face` rule for the file, and a usage example that carries the axes and features set on this page. */
  function renderCss(/** @type {string} */ variations, /** @type {string} */ features) {
    const quote = (/** @type {string} */ text) => `"${text.replace(/["\\]/g, '\\$&')}"`;
    const family = quote(face.family || file.name.replace(/\.[^.]+$/, ''));
    const format = CSS_FORMATS[file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()];
    // The sliders start at the axis defaults, which a browser applies anyway.
    const moved = face.axes.some((/** @type {any} */ axis) => axisValues[axis.tag] !== axis.def);
    const rule = [
      // Browsers don't load a face out of a collection.
      file.faces.length > 1 && '/* This file is a collection: extract the font into a file of its own before using it on the web. */',
      '@font-face {',
      `  font-family: ${family};`,
      `  src: url(${quote(encodeURI(file.name))})${format ? ` format("${format}")` : ''};`,
      face.css.weight && `  font-weight: ${face.css.weight};`,
      `  font-style: ${face.css.style};`,
      face.css.stretch && `  font-stretch: ${face.css.stretch};`,
      '  font-display: swap;',
      '}',
    ];
    const usage = [
      '.text {',
      `  font-family: ${family};`,
      moved && `  font-variation-settings: ${variations};`,
      features && `  font-feature-settings: ${features};`,
      '}',
    ];
    $('css').textContent = [rule, usage].map((lines) => lines.filter(Boolean).join('\n')).join('\n\n');
  }

  function renderAxes() {
    $('axesBox').hidden = !face.axes.length;
    const rows = face.axes.map((/** @type {any} */ axis) => {
      const row = el('label', 'axis');
      const input = /** @type {HTMLInputElement} */ (el('input'));
      input.type = 'range';
      input.min = String(axis.min);
      input.max = String(axis.max);
      input.step = axis.max - axis.min > 20 ? '1' : '0.01';
      input.value = String(axisValues[axis.tag]);
      const value = el('span', 'value', round(axisValues[axis.tag]));
      input.addEventListener('input', () => {
        axisValues[axis.tag] = Number(input.value);
        value.textContent = round(Number(input.value));
        $('instance').value = String(matchingInstance());
        applyStyle();
      });
      row.append(el('span', 'name', `${axis.name} (${axis.tag})`), input, value);
      return row;
    });
    $('axes').replaceChildren(...rows);
    $('instance').hidden = !face.instances.length;
    $('instance').replaceChildren(new Option('Custom', '-1'), ...face.instances.map((/** @type {any} */ instance, /** @type {number} */ i) => new Option(instance.name, String(i))));
    $('instance').value = String(matchingInstance());
  }

  function matchingInstance() {
    return face.instances.findIndex((/** @type {any} */ instance) => face.axes.every((/** @type {any} */ axis, /** @type {number} */ i) => Math.abs(instance.coords[i] - axisValues[axis.tag]) < 0.005));
  }

  function resetAxes() {
    axisValues = Object.fromEntries(face.axes.map((/** @type {any} */ axis) => [axis.tag, axis.def]));
    renderAxes();
    applyStyle();
  }

  function renderFeatures() {
    $('featuresBox').hidden = !face.features.length;
    $('features').replaceChildren(
      ...face.features.map((/** @type {any} */ feature) => {
        const label = el('label', 'feature');
        label.title = feature.tag;
        const input = /** @type {HTMLInputElement} */ (el('input'));
        input.type = 'checkbox';
        input.checked = featureValues[feature.tag] ?? feature.on;
        input.addEventListener('change', () => {
          if (input.checked === feature.on) {
            delete featureValues[feature.tag];
          } else {
            featureValues[feature.tag] = input.checked;
          }
          applyStyle();
        });
        label.append(input, el('span', '', feature.name), el('span', 'tag', feature.tag));
        return label;
      }),
    );
  }

  // ---- Characters ---------------------------------------------------------

  function blockOf(/** @type {number} */ code) {
    return face.blocks.find((/** @type {any[]} */ b) => b[0] !== 'Other' && code >= b[1] && code <= b[2])?.[0] ?? '';
  }

  function showGlyph(/** @type {number} */ code) {
    selectedCode = code;
    $('glyphDetail').hidden = false;
    $('glyphBig').textContent = String.fromCodePoint(code);
    $('glyphCode').textContent = `U+${hex(code)}`;
    $('glyphBlock').textContent = blockOf(code);
    $('glyphEntity').textContent = `&#x${code.toString(16).toUpperCase()};  ·  decimal ${code}`;
    for (const cell of $('glyphs').querySelectorAll('.selected')) {
      cell.classList.remove('selected');
    }
    $('glyphs').querySelector(`[data-code="${code}"]`)?.classList.add('selected');
  }

  /** Draws the next page of the selected block; a large font would otherwise mean tens of thousands of cells at once. */
  function moreGlyphs() {
    const next = glyphCodes.slice(glyphsShown, glyphsShown + GLYPH_PAGE).map((code) => {
      const cell = el('button', 'glyph', String.fromCodePoint(code));
      cell.dataset.code = String(code);
      cell.title = `U+${hex(code)}`;
      return cell;
    });
    $('glyphs').append(...next);
    glyphsShown += next.length;
    $('glyphsMore').hidden = glyphsShown >= glyphCodes.length;
    $('glyphsMore').textContent = `Show more (${(glyphCodes.length - glyphsShown).toLocaleString('en-US')} left)`;
  }

  function renderGlyphs() {
    glyphCodes = codesOf(Number($('block').value));
    glyphsShown = 0;
    $('glyphs').replaceChildren();
    moreGlyphs();
  }

  function renderBlocks() {
    const total = face.blocks.reduce((/** @type {number} */ sum, /** @type {any[]} */ b) => sum + b[3], 0);
    $('glyphsTitle').textContent = `Characters (${total.toLocaleString('en-US')})`;
    $('block').replaceChildren(
      new Option('All blocks', '-1'),
      ...face.blocks.map((/** @type {any[]} */ b, /** @type {number} */ i) => new Option(`${b[0]} (${b[3].toLocaleString('en-US')})`, String(i))),
    );
    $('block').hidden = face.blocks.length < 2;
    $('glyphDetail').hidden = true;
    renderGlyphs();
  }

  // ---- Details ------------------------------------------------------------

  function renderInfo() {
    const root = $('sections');
    root.textContent = '';
    for (const section of face.sections) {
      const list = el('dl');
      for (const [label, value] of section.rows) {
        list.append(el('dt', '', label), el('dd', '', value));
      }
      root.append(el('h3', '', section.title), list);
    }
  }

  // ---- Face ---------------------------------------------------------------

  function showNotice(/** @type {string} */ text) {
    $('notice').textContent = text;
    $('notice').hidden = !text;
  }

  function showFace() {
    if (!file) {
      return;
    }
    faceIndex = Math.min(faceIndex, file.faces.length - 1);
    face = file.faces[faceIndex];
    $('family').textContent = face.family || file.name;
    $('subtitle').textContent = [face.style, face.family ? file.name : ''].filter(Boolean).join(' · ');
    $('summary').textContent = `${face.summary} · ${formatSize(file.size)}`;
    featureValues = {};
    axisValues = Object.fromEntries(face.axes.map((/** @type {any} */ axis) => [axis.tag, axis.def]));
    renderAxes();
    renderFeatures();
    applyStyle();
    presetList = buildPresets();
    renderSample();
    renderBlocks();
    renderInfo();
    showNotice('');
    saveState();
    // The samples stay hidden until the face's own font has arrived.
    document.body.classList.remove('loaded', 'unloaded');
    vscode.postMessage({ type: 'face', index: faceIndex });
  }

  async function loadFont(/** @type {any} */ msg) {
    if (msg.index !== faceIndex) {
      return;
    }
    const previous = loaded;
    const family = `previewix-${++loadCount}`;
    try {
      if (!msg.bytes) {
        throw new Error('no data');
      }
      const bytes = toBytes(msg.bytes);
      const font = new FontFace(family, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      await font.load();
      document.fonts.add(font);
      loaded = font;
      document.body.style.setProperty('--font', `"${family}"`);
      document.body.classList.add('loaded');
    } catch {
      loaded = null;
      document.body.style.removeProperty('--font');
      document.body.classList.add('unloaded');
      showNotice("VS Code can't draw this font, so the samples below are shown in the default font. Its details are still listed.");
    }
    if (previous) {
      document.fonts.delete(previous);
    }
  }

  // ---- Events -------------------------------------------------------------

  $('face').addEventListener('change', () => {
    faceIndex = Number($('face').value);
    showFace();
  });
  $('preset').addEventListener('change', () => {
    if ($('preset').value) {
      preset = $('preset').value;
      custom = '';
      saveState();
      renderSample();
    }
  });
  $('sample').addEventListener('input', () => {
    custom = $('sample').innerText.replace(/\n$/, '');
    saveState();
    renderPresets();
    renderWaterfall();
  });
  $('size').addEventListener('input', () => {
    size = Number($('size').value);
    $('sample').style.fontSize = `${size}px`;
    $('sizeValue').textContent = `${size} px`;
    saveState();
  });
  $('instance').addEventListener('change', () => {
    const instance = face.instances[Number($('instance').value)];
    if (instance) {
      face.axes.forEach((/** @type {any} */ axis, /** @type {number} */ i) => (axisValues[axis.tag] = instance.coords[i]));
      renderAxes();
      applyStyle();
    }
  });
  $('axesReset').addEventListener('click', resetAxes);
  $('featuresReset').addEventListener('click', () => {
    featureValues = {};
    renderFeatures();
    applyStyle();
  });
  $('block').addEventListener('change', renderGlyphs);
  $('glyphsMore').addEventListener('click', moreGlyphs);
  $('glyphs').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const cell = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.glyph'));
    if (cell) {
      showGlyph(Number(cell.dataset.code));
    }
  });
  $('copyChar').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: String.fromCodePoint(selectedCode), what: 'character' }));
  $('copyCode').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: `U+${hex(selectedCode)}`, what: 'code point' }));
  $('copyCss').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: $('css').textContent, what: 'CSS' }));
  $('copy').addEventListener('click', () => {
    const text = face.sections
      .map((/** @type {any} */ s) => `${s.title}\n${s.rows.map((/** @type {string[]} */ [label, value]) => `  ${label}: ${value}`).join('\n')}`)
      .join('\n\n');
    vscode.postMessage({ type: 'copy', text, what: 'font details' });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        file = msg;
        $('page').classList.remove('failed');
        $('faceRow').hidden = msg.faces.length < 2;
        $('face').replaceChildren(
          ...msg.faces.map((/** @type {any} */ f, /** @type {number} */ i) => new Option([f.family, f.style].filter(Boolean).join(' ') || `Font ${i + 1}`, String(i))),
        );
        faceIndex = Math.min(faceIndex, msg.faces.length - 1);
        $('face').value = String(faceIndex);
        showFace();
        break;
      case 'font':
        void loadFont(msg);
        break;
      case 'error':
        file = null;
        $('page').classList.add('failed');
        $('family').textContent = msg.message;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
