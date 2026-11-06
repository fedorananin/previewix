// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const root = $('content');
  const bar = $('bar');

  /**
   * Ids of the page's own parts ("missing" is the placeholder of media/missing.js). The document must not repeat
   * them: a heading called "Outline" would take the styles of #outline. Such an id is kept in `data-id` instead.
   */
  const taken = new Set(['missing', ...[...document.querySelectorAll('[id]')].map((el) => el.id)]);
  const anchorOf = (/** @type {Element} */ el) => el.id || /** @type {HTMLElement} */ (el).dataset.id || '';

  /** What the page keeps while its tab is in the background, when it is torn down and built again. */
  const saved = vscode.getState() ?? {};

  // ---- Document state -----------------------------------------------------

  /** Source lines of the document. @type {string[]} */
  let lines = [];
  /** Rendered top-level blocks with their source line ranges. @type {{start: number, end: number, html: string}[]} */
  let blocks = [];
  /** Document version the state above corresponds to; edits are rejected by the host if it is stale. */
  let version = 0;
  let firstRender = true;
  /** Top-level headings of the document, as the host found them. @type {{level: number, text: string, id: string}[]} */
  let outline = [];

  /**
   * The block being edited. Its text is synced to the document while typing, one edit
   * at a time: `synced` is what the document holds, `sent` what is on its way there.
   * @type {{start: number, end: number, ta: HTMLTextAreaElement, wrap: HTMLElement, preview: HTMLElement,
   *   synced: string, sent: string, inflight: boolean, closing: boolean, removed: boolean, timer: any} | null}
   */
  let editing = null;
  /** Block to open once the current editor has finished closing. @type {{start: number, word: string, refEnd: number} | null} */
  let pendingOpen = null;

  const sourceOf = (start, end) => lines.slice(start, end).join('\n');

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').textContent = ''), 5000);
  }

  let stateTimer;
  function saveState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      // Until the document is on the page there is no scroll position of its own to remember.
      const scrollY = firstRender ? (saved.scrollY ?? 0) : window.scrollY;
      vscode.setState({ scrollY, outline: outlineOpen, sizes });
    }, 200);
  }

  // ---- Rendering ----------------------------------------------------------

  function blockElement(block) {
    const el = document.createElement('section');
    el.className = 'block';
    el.dataset.start = String(block.start);
    el.dataset.end = String(block.end);
    el.innerHTML = block.html;
    if (block.html.includes('id=')) {
      for (const node of /** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll('[id]'))) {
        if (taken.has(node.id)) {
          node.dataset.id = node.id;
          node.removeAttribute('id');
        }
      }
    }
    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.title = 'Edit this block (or double-click it)';
    edit.textContent = '✎';
    el.prepend(edit);
    return el;
  }

  function render() {
    const before = [];
    const inside = [];
    const after = [];
    for (const block of blocks) {
      const el = blockElement(block);
      if (!editing || block.end <= editing.start) {
        before.push(el);
      } else if (block.start >= editing.end) {
        after.push(el);
      } else {
        inside.push(el);
      }
    }
    if (!editing) {
      root.replaceChildren(...before);
      root.classList.toggle('empty', !before.length);
    } else {
      // The editor node itself is left in place, so it keeps focus and the caret.
      root.classList.remove('empty');
      for (const child of [...root.children]) {
        if (child !== editing.wrap) {
          child.remove();
        }
      }
      editing.wrap.before(...before);
      editing.wrap.after(...after);
      // Whatever the edited lines currently render to serves as a live preview.
      editing.preview.replaceChildren(...inside);
      editing.preview.hidden = !inside.length;
    }
    hydrate();
    headings = null;
    markCurrent();
  }

  // ---- Diagrams -----------------------------------------------------------

  // The host sends a Mermaid diagram as its source, `<div class="diagram"><pre>`, and the picture is drawn here.
  // The page is built anew on every change of the document, so what has been drawn is kept and put back at once.

  /** Where Mermaid is, a bundle that is imported when the first diagram turns up. */
  const mermaidUrl = document.body.dataset.mermaid;
  const stage = $('stage');
  /** @typedef {{node?: HTMLElement, size?: [number, number], error?: string}} Picture */
  /** Finished pictures, and the messages of the diagrams that failed, by theme and source. @type {Map<string, Picture>} */
  const drawn = new Map();
  /**
   * The last good picture of each diagram on the page. A diagram is known by the first line of its block (and its
   * number inside the block), which stays the same while the block is being edited.
   * @type {Map<string, Picture>}
   */
  let shown = new Map();
  /** Diagrams on the page that have no picture yet. @type {{box: HTMLElement, slot: string, source: string, key: string, look: object}[]} */
  let waiting = [];
  let drawing = false;
  let drawCount = 0;
  /** @type {Promise<{draw: (id: string, source: string, look: object, stage: HTMLElement) => Promise<string>}> | null} */
  let mermaid = null;
  /**
   * Size of every diagram of the document, by a hash of its source. It outlives the page (see saveState), so that
   * a diagram has its place from the start and the scroll position can be restored before Mermaid has even loaded.
   * For a diagram that failed it is `[0, height of its box with the message]`.
   * @type {Record<string, [number, number]>}
   */
  let sizes = saved.sizes ?? {};
  let lookKey = '';

  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    }
    return (h >>> 0).toString(36) + text.length.toString(36);
  }

  /** The part of Mermaid's configuration that follows the VS Code theme. */
  function diagramLook() {
    const kinds = document.body.classList;
    const style = getComputedStyle(document.body);
    const fontFamily = style.fontFamily;
    const dark = !kinds.contains('vscode-light') && !kinds.contains('vscode-high-contrast-light');
    if (!kinds.contains('vscode-high-contrast') && !kinds.contains('vscode-high-contrast-light')) {
      return { theme: dark ? 'dark' : 'default', fontFamily };
    }
    // Neither of Mermaid's own themes is high contrast, so one is made of the editor's colors: outlines only.
    const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const back = color('--vscode-editor-background', dark ? '#000000' : '#ffffff');
    const fore = color('--vscode-editor-foreground', dark ? '#ffffff' : '#000000');
    const border = color('--vscode-contrastBorder', fore);
    return {
      theme: 'base',
      fontFamily,
      themeVariables: {
        darkMode: dark,
        background: back,
        primaryColor: back,
        secondaryColor: back,
        tertiaryColor: back,
        primaryTextColor: fore,
        secondaryTextColor: fore,
        tertiaryTextColor: fore,
        textColor: fore,
        lineColor: fore,
        primaryBorderColor: border,
        secondaryBorderColor: border,
        tertiaryBorderColor: border,
        noteBkgColor: back,
        noteTextColor: fore,
        noteBorderColor: border,
      },
    };
  }

  /** Finds the diagrams of the page and gives each its picture, or queues it for drawing. Safe to call again. */
  function hydrate() {
    const boxes = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.diagram')]).filter((box) => box.querySelector(':scope > pre'));
    const last = shown;
    shown = new Map();
    waiting = [];
    if (!boxes.length || !mermaidUrl) {
      sizes = {};
      return;
    }
    const look = diagramLook();
    lookKey = JSON.stringify(look);
    /** @type {Record<string, [number, number]>} */
    const live = {};
    /** @type {Set<string>} */
    const slots = new Set();
    for (const box of boxes) {
      const start = /** @type {HTMLElement | null} */ (box.closest('.block'))?.dataset.start;
      let slot = `${start}:0`;
      for (let nth = 1; slots.has(slot); nth++) {
        slot = `${start}:${nth}`;
      }
      slots.add(slot);
      const source = box.querySelector(':scope > pre')?.textContent ?? '';
      const key = lookKey + source;
      const id = hash(source);
      if (sizes[id]) {
        live[id] = sizes[id];
      }
      const picture = drawn.get(key);
      const good = picture?.node ? picture : last.get(slot);
      if (good) {
        shown.set(slot, good);
      }
      if (picture) {
        show(box, good, picture.error);
        continue;
      }
      // While the new picture is drawn, the previous one of this diagram stays, or at least its place is kept.
      if (good) {
        show(box, good);
      } else {
        reserve(box, sizes[id]);
      }
      waiting.push({ box, slot, source, key, look });
    }
    sizes = live;
    drawWaiting();
  }

  /**
   * Puts a picture into a diagram's box. With an error, the message goes under the source. In the preview of the
   * block editor, where the source is right above, it goes under the last good picture instead, if there is one.
   * @param {HTMLElement} box @param {Picture | undefined} picture @param {string} [error]
   */
  function show(box, picture, error) {
    const pre = /** @type {HTMLElement} */ (box.querySelector(':scope > pre'));
    box.style.minHeight = '';
    let node = (error && !box.closest('.editor-preview') ? null : picture?.node) ?? null;
    // One element per picture, moved to wherever the picture is shown next; a second place gets a copy.
    if (node?.isConnected && node.parentElement !== box) {
      node = /** @type {HTMLElement} */ (node.cloneNode(true));
    }
    for (const child of [...box.children]) {
      if (child !== pre && child !== node) {
        child.remove();
      }
    }
    if (node && node.parentElement !== box) {
      box.prepend(node);
    }
    pre.hidden = !!node;
    box.classList.toggle('failed', !!error);
    if (error) {
      const note = document.createElement('div');
      note.className = 'diagram-error';
      note.textContent = error;
      box.append(note);
    }
  }

  /** Keeps the place of a diagram whose size is known from an earlier life of the page. */
  function reserve(box, size) {
    if (!size || box.querySelector(':scope > .picture')) {
      return;
    }
    if (!size[0]) {
      box.style.minHeight = `${size[1]}px`;
      return;
    }
    const hold = document.createElement('div');
    hold.className = 'picture';
    hold.style.maxWidth = `${size[0]}px`;
    hold.style.aspectRatio = `${size[0]} / ${size[1]}`;
    box.prepend(hold);
    /** @type {HTMLElement} */ (box.querySelector(':scope > pre')).hidden = true;
  }

  /** Draws what is waiting, one diagram at a time, starting with the ones nearest to what is on screen. */
  async function drawWaiting() {
    if (drawing) {
      return;
    }
    drawing = true;
    try {
      await drawQueue();
    } finally {
      drawing = false;
    }
    // Every state of a diagram that is being typed ends up in `drawn`; only what is on the page is worth keeping.
    if (drawn.size > 200) {
      const kept = new Set(shown.values());
      for (const [key, picture] of drawn) {
        if (!kept.has(picture)) {
          drawn.delete(key);
        }
      }
    }
    markCurrent();
  }

  async function drawQueue() {
    while (waiting.length) {
      const middle = window.innerHeight / 2;
      const distance = (job) => {
        const rect = job.box.getBoundingClientRect();
        return Math.abs((rect.top + rect.bottom) / 2 - middle);
      };
      const job = waiting.reduce((best, other) => (distance(other) < distance(best) ? other : best));
      const picture = await draw(job);
      drawn.set(job.key, picture);
      let size = picture.size;
      // The page may have been built again meanwhile, so the picture goes to whatever waits for it now.
      waiting = waiting.filter((other) => {
        if (other.key !== job.key) {
          return true;
        }
        if (picture.node) {
          shown.set(other.slot, picture);
        }
        show(other.box, shown.get(other.slot), picture.error);
        if (picture.error && other.box.isConnected) {
          size = [0, other.box.getBoundingClientRect().height];
        }
        return false;
      });
      if (size) {
        sizes[hash(job.source)] = size;
        saveState();
      }
    }
  }

  /** @returns {Promise<Picture>} */
  async function draw(job) {
    try {
      mermaid ??= import(/** @type {string} */ (mermaidUrl)).catch((e) => {
        throw new Error(`Mermaid could not be loaded: ${e instanceof Error ? e.message : e}`);
      });
      const library = await mermaid;
      // Some diagrams (Gantt charts, for one) take their width from where they are laid out.
      stage.style.width = `${job.box.clientWidth || root.clientWidth}px`;
      const svg = await library.draw(`previewix-diagram-${++drawCount}`, job.source, job.look, stage);
      const node = document.createElement('div');
      node.className = 'picture';
      node.innerHTML = svg;
      const picture = node.querySelector('svg');
      const box = picture?.viewBox.baseVal;
      if (!picture || !box?.width || !box.height) {
        return { node };
      }
      const width = parseFloat(picture.style.maxWidth) || box.width;
      const round = (/** @type {number} */ value) => Math.round(value * 100) / 100;
      return { node, size: [round(width), round((width * box.height) / box.width)] };
    } catch (e) {
      stage.replaceChildren();
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // The message of a failed diagram wraps, so the height kept for its box is only good for one width of the page.
  let measuredWidth = 0;
  new ResizeObserver(() => {
    if (root.clientWidth === measuredWidth) {
      return;
    }
    measuredWidth = root.clientWidth;
    for (const box of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.diagram.failed'))) {
      sizes[hash(box.querySelector(':scope > pre')?.textContent ?? '')] = [0, box.getBoundingClientRect().height];
    }
    saveState();
  }).observe(root);

  // VS Code changes the classes of <body> and the color variables on <html> when the theme changes.
  const themeWatch = new MutationObserver(() => {
    if (lookKey && JSON.stringify(diagramLook()) !== lookKey) {
      hydrate();
    }
  });
  themeWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---- Outline ------------------------------------------------------------

  const outlineBox = $('outline');
  const outlineToggle = $('outlineToggle');
  let outlineOpen = saved.outline ?? document.body.dataset.outline === 'open';
  let outlineKey = '';
  /** The elements of the headings in `outline`, looked up when first needed after a render. @type {(HTMLElement | undefined)[] | null} */
  let headings = null;
  let current = -1;
  /** When an outline entry was clicked: the scrolling it causes must not move the mark off that entry. */
  let jumpedAt = 0;

  function showOutline(open) {
    outlineOpen = open;
    // Not a class of <body>, where VS Code keeps its own.
    document.documentElement.classList.toggle('with-outline', open);
    outlineBox.hidden = !open;
    outlineToggle.setAttribute('aria-pressed', String(open));
    markCurrent();
  }

  function drawOutline() {
    const key = JSON.stringify(outline);
    if (key === outlineKey) {
      return;
    }
    outlineKey = key;
    current = -1;
    const top = Math.min(...outline.map((heading) => heading.level));
    outlineBox.replaceChildren(
      ...outline.map((heading, index) => {
        const entry = document.createElement('a');
        entry.href = `#${encodeURIComponent(heading.id)}`;
        entry.className = `level-${heading.level - top}`;
        entry.dataset.index = String(index);
        entry.textContent = entry.title = heading.text;
        return entry;
      }),
    );
    outlineBox.classList.toggle('empty', !outline.length);
  }

  /** The element a link like `#id` points at. Only inside the document: the page's own parts have ids too. */
  function findAnchor(id) {
    const find = (/** @type {string} */ value) => {
      const name = CSS.escape(value);
      return root.querySelector(`[id="${name}"], [data-id="${name}"], a[name="${name}"]`);
    };
    return /** @type {HTMLElement | null} */ (find(id) ?? find(id.toLowerCase()));
  }

  function jumpTo(id) {
    const target = findAnchor(id);
    if (!target) {
      return;
    }
    target.scrollIntoView();
    // A footnote and the place it is referred from are small: show which one it was.
    const lit = target.closest('.footnote, .footnote-ref');
    if (lit) {
      lit.classList.remove('lit');
      void (/** @type {HTMLElement} */ (lit).offsetWidth);
      lit.classList.add('lit');
    }
  }

  /** Marks the heading the top of the window is in. */
  function markCurrent() {
    if (!outlineOpen || !outline.length) {
      return;
    }
    if (!headings) {
      /** @type {Map<string, HTMLElement>} */
      const byId = new Map();
      for (const el of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        byId.has(anchorOf(el)) || byId.set(anchorOf(el), /** @type {HTMLElement} */ (el));
      }
      headings = outline.map((heading) => byId.get(heading.id));
    }
    const list = headings;
    let index = current;
    if (performance.now() - jumpedAt > 200 || !list[index]) {
      // Headings are in the order of the document, so the last one above the line is found by halving. The
      // line is just under the bar; at the end of the document, where the last headings never get that far up,
      // it is the bottom of the window.
      const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      const line = atEnd ? window.innerHeight : bar.getBoundingClientRect().bottom + 24;
      let low = 0;
      let high = list.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        const el = list[mid];
        if (el && el.getBoundingClientRect().top > line) {
          high = mid;
        } else {
          low = mid + 1;
        }
      }
      index = low - 1;
    }
    if (index === current) {
      return;
    }
    outlineBox.children[current]?.classList.remove('current');
    current = index;
    const entry = /** @type {HTMLElement | undefined} */ (outlineBox.children[index]);
    if (entry) {
      entry.classList.add('current');
      // Kept in view by hand: scrollIntoView() may scroll the document as well.
      const top = entry.offsetTop;
      if (top < outlineBox.scrollTop) {
        outlineBox.scrollTop = top;
      } else if (top + entry.offsetHeight > outlineBox.scrollTop + outlineBox.clientHeight) {
        outlineBox.scrollTop = top + entry.offsetHeight - outlineBox.clientHeight;
      }
    }
  }

  outlineToggle.addEventListener('click', () => {
    showOutline(!outlineOpen);
    saveState();
    vscode.postMessage({ type: 'outline', open: outlineOpen });
  });

  outlineBox.addEventListener('click', (e) => {
    const entry = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('a'));
    if (!entry) {
      return;
    }
    e.preventDefault();
    const index = Number(entry.dataset.index);
    // The mark goes to the entry that was clicked, even when the page can't scroll its heading up to the top.
    outlineBox.children[current]?.classList.remove('current');
    entry.classList.add('current');
    current = index;
    jumpedAt = performance.now();
    jumpTo(outline[index].id);
    // In a narrow window the outline lies over the text it has just led to.
    if (matchMedia('(max-width: 720px)').matches) {
      showOutline(false);
      saveState();
    }
  });

  // The outline hangs under the bar, whose height depends on the fonts.
  new ResizeObserver(() => document.body.style.setProperty('--bar', `${bar.offsetHeight}px`)).observe(bar);
  showOutline(outlineOpen);

  // ---- Editing ------------------------------------------------------------

  function startEdit(start, end, word = '') {
    if (editing) {
      pendingOpen = { start, word, refEnd: editing.end };
      closeEditor();
      return;
    }
    const text = sourceOf(start, end);
    const wrap = document.createElement('div');
    wrap.className = 'editor';
    const tools = document.createElement('div');
    tools.className = 'tools';
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.value = text;
    ta.placeholder = 'Write Markdown…';
    const preview = document.createElement('div');
    preview.className = 'editor-preview';

    const tool = (label, title, action) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.title = title;
      // Keeps the focus, and with it the selection, in the textarea.
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', action);
      tools.append(button);
      return button;
    };
    tool('B', 'Bold', () => wrapSelection(ta, '**', '**')).classList.add('bold');
    tool('I', 'Italic', () => wrapSelection(ta, '*', '*')).classList.add('italic');
    tool('</>', 'Inline code', () => wrapSelection(ta, '`', '`'));
    tool('Link', 'Link', () => wrapSelection(ta, '[', '](url)'));
    const keys = document.createElement('span');
    keys.className = 'keys';
    keys.textContent = 'Esc to finish';
    tools.append(keys);
    tool('Done', 'Finish editing (Esc)', closeEditor).classList.add('primary');

    wrap.append(tools, ta, preview);
    editing = { start, end, ta, wrap, preview, synced: text, sent: text, inflight: false, closing: false, removed: false, timer: 0 };
    root.append(wrap);
    render();

    ta.addEventListener('input', () => {
      if (editing) {
        clearTimeout(editing.timer);
        editing.timer = setTimeout(pump, 200);
      }
    });
    ta.addEventListener('keydown', (e) => onEditorKey(e, ta));
    ta.addEventListener('blur', () => {
      pump();
      // Switching to another window or tab shouldn't end the edit, only clicking elsewhere in the document.
      setTimeout(() => {
        if (editing?.ta === ta && document.hasFocus() && document.activeElement !== ta) {
          closeEditor();
        }
      }, 0);
    });

    ta.focus();
    const at = word ? text.indexOf(word) : -1;
    at >= 0 ? ta.setSelectionRange(at, at + word.length) : ta.setSelectionRange(text.length, text.length);
    wrap.scrollIntoView({ block: 'nearest' });
  }

  /** Sends the next pending edit, or completes a close once everything has reached the document. */
  function pump() {
    const e = editing;
    if (!e || e.inflight) {
      return;
    }
    const text = e.ta.value;
    const blank = text.trim() === '';
    if (e.start === e.end && blank) {
      // Nothing was written into a new block.
      if (e.closing) {
        finishClose();
      }
      return;
    }
    const remove = e.closing && blank;
    if (text !== e.synced || (remove && !e.removed)) {
      e.inflight = true;
      e.sent = text;
      e.removed = remove;
      vscode.postMessage({ type: 'edit', version, start: e.start, end: e.end, text, remove });
    } else if (e.closing) {
      finishClose();
    }
  }

  function closeEditor() {
    if (!editing || editing.closing) {
      return;
    }
    editing.closing = true;
    editing.ta.readOnly = true;
    clearTimeout(editing.timer);
    pump();
  }

  function finishClose() {
    const e = editing;
    if (!e) {
      return;
    }
    editing = null;
    e.wrap.remove();
    render();
    const next = pendingOpen;
    pendingOpen = null;
    if (next) {
      // Blocks below the closed editor moved if its line count changed.
      const start = next.start >= next.refEnd ? next.start + e.end - next.refEnd : next.start;
      // Removing a block may also take a neighbouring blank line.
      const block = blocks.find((b) => b.start === start) ?? blocks.find((b) => b.start === start - 1);
      if (block) {
        startEdit(block.start, block.end, next.word);
      }
    }
  }

  function discardEditor(reason) {
    if (!editing) {
      return;
    }
    clearTimeout(editing.timer);
    editing.wrap.remove();
    editing = null;
    pendingOpen = null;
    toast(reason);
  }

  /** Inserts text through the browser's editing pipeline, which keeps the textarea's native undo history. */
  function insertText(ta, text) {
    ta.focus();
    document.execCommand('insertText', false, text);
  }

  function wrapSelection(ta, before, after) {
    const start = ta.selectionStart;
    const selected = ta.value.slice(start, ta.selectionEnd);
    insertText(ta, before + selected + after);
    ta.setSelectionRange(start + before.length, start + before.length + selected.length);
  }

  function onEditorKey(e, ta) {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      closeEditor();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      // VS Code saves on this shortcut by itself, possibly before the last keystrokes arrive;
      // this save is queued behind them.
      clearTimeout(editing?.timer);
      pump();
      vscode.postMessage({ type: 'save' });
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      insertText(ta, '  ');
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {
      continueList(e, ta);
    }
  }

  /** Enter inside a list item starts the next item; on an empty item it ends the list. */
  function continueList(e, ta) {
    const caret = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', caret - 1) + 1;
    const line = ta.value.slice(lineStart, caret);
    const match = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/.exec(line);
    if (!match) {
      return;
    }
    e.preventDefault();
    if (match[0] === line) {
      ta.setSelectionRange(lineStart, caret);
      document.execCommand('delete');
      return;
    }
    const number = /^(\d+)([.)])$/.exec(match[2]);
    const marker = number ? `${Number(number[1]) + 1}${number[2]}` : match[2];
    insertText(ta, `\n${match[1]}${marker}${match[3]}${match[4] ? '[ ] ' : ''}`);
  }

  // ---- Interaction with the rendered document -----------------------------

  root.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const block = /** @type {HTMLElement | null} */ (target.closest('.block'));

    if (target.classList.contains('edit') && block) {
      startEdit(Number(block.dataset.start), Number(block.dataset.end));
      return;
    }
    if (target instanceof HTMLInputElement && target.classList.contains('task')) {
      vscode.postMessage({ type: 'toggleTask', line: Number(target.dataset.line) });
      return;
    }
    const link = target.closest('a');
    const href = link?.getAttribute('href');
    if (href) {
      e.preventDefault();
      if (href.startsWith('#')) {
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // Not percent-encoded after all.
        }
        jumpTo(id);
      } else {
        vscode.postMessage({ type: 'openLink', href });
      }
    }
  });

  root.addEventListener('dblclick', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const block = /** @type {HTMLElement | null} */ (target.closest('.block'));
    if (!block || target.closest('a, input, .editor')) {
      return;
    }
    // A double-click selects the word under the pointer, which tells where to put the caret.
    const word = String(getSelection()).trim();
    startEdit(Number(block.dataset.start), Number(block.dataset.end), word);
  });

  $('add').addEventListener('click', () => startEdit(lines.length, lines.length));
  $('source').addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));

  let scrollFrame = 0;
  window.addEventListener('scroll', () => {
    saveState();
    scrollFrame ||= requestAnimationFrame(() => {
      scrollFrame = 0;
      markCurrent();
    });
  });

  // ---- Messages from the extension ----------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    const e = editing;
    switch (msg.type) {
      case 'update':
        version = msg.version;
        lines = msg.lines;
        blocks = msg.blocks;
        outline = msg.outline ?? [];
        if (e && msg.own && msg.range) {
          e.start = msg.range.start;
          e.end = msg.range.end;
        } else if (e && e.start === e.end) {
          // A block that hasn't been inserted yet always goes to the end.
          e.start = e.end = lines.length;
        } else if (e && sourceOf(e.start, e.end) !== e.synced) {
          // The document changed under the editor (another editor, git, a formatter…).
          discardEditor('The file changed elsewhere, editing was closed');
        }
        drawOutline();
        render();
        if (firstRender) {
          firstRender = false;
          window.scrollTo(0, saved.scrollY ?? 0);
        }
        break;
      case 'applied':
        version = msg.version;
        if (e) {
          e.inflight = false;
          e.synced = e.sent;
          e.start = msg.start;
          e.end = msg.end;
          pump();
        }
        break;
      case 'rejected':
        // The edit was based on an outdated version; by now the fresh one has arrived, so try again.
        if (e) {
          e.inflight = false;
          e.removed = false;
          pump();
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
