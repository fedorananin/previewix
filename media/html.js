// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  const stage = $('stage');
  const sheet = $('sheet');

  const MAC = /^Mac/i.test(navigator.platform);
  const WIDTHS = [390, 768, 1280, 1920];
  /** How long a changed page may take to load before it replaces the one on screen anyway. */
  const SWAP_AFTER = 1000;
  /** A page that loads itself again is written anew, but not without end. */
  const RELOADS = { count: 3, within: 5000 };

  /**
   * The address a frame is loaded from before the page is written into it. VS Code serves the files of a
   * webview through a service worker, which tells by the `id` in the address a frame was loaded from which
   * webview a request belongs to. VS Code loads its own frame from `fake.html?id=…` for that reason, and so
   * does this one: a frame made from `srcdoc` or a blob gets "not found" for every file next to the page.
   */
  const ADDRESS = (() => {
    const entry = performance.getEntriesByType('navigation')[0];
    for (const address of [entry && entry.name, location.href]) {
      try {
        const id = new URL(String(address)).searchParams.get('id');
        if (id) {
          const params = new URLSearchParams({ id });
          if (globalThis.crossOriginIsolated) {
            params.set('vscode-coi', '3');
          }
          return `./fake.html?${params}`;
        }
      } catch {
        // Not an address: the next one is tried.
      }
    }
    return 'about:blank';
  })();

  // ---- State --------------------------------------------------------------

  const saved = vscode.getState() || {};

  /** The last `page` message: the file as it is written into a frame. @type {any} */
  let page = null;
  /** The origin the files next to the page are served from. */
  let local = '';
  /** The frame on screen. @type {HTMLIFrameElement | null} */
  let shown = null;
  /** A frame that loads a changed page behind the one on screen. @type {HTMLIFrameElement | null} */
  let pending = null;
  /** The document that was written into a frame, which is how a frame that went elsewhere is told. @type {WeakMap<HTMLIFrameElement, Document>} */
  const written = new WeakMap();
  /** The scroll position a frame has yet to take, until its page has loaded or the user scrolls. @type {WeakMap<HTMLIFrameElement, {x: number, y: number}>} */
  const wanted = new WeakMap();
  /** True once the page has left its frame for another address. */
  let gone = false;
  /** The addresses a page led on to that were opened, each once: a redirect must not open its target on every keystroke in the source. */
  const followed = new Set();
  /** When the page loaded itself again. @type {number[]} */
  let reloads = [];
  /** The files reported to the provider last. */
  let reported = '';

  /** @type {number | 'fit'} */
  let width = WIDTHS.includes(saved.width) ? saved.width : 'fit';
  let scroll = { x: Number(saved.scroll?.x) || 0, y: Number(saved.scroll?.y) || 0 };

  // ---- Helpers ------------------------------------------------------------

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

  let stateTimer;
  function saveState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => vscode.setState({ width, scroll }), 200);
  }

  /** What takes the place of the page: why there is none, or where it went. */
  function showMessage(text) {
    $('message').textContent = text;
    $('message').hidden = !text;
  }

  /** The window of a frame, as long as the frame still holds the page that was written into it. */
  function windowOf(/** @type {HTMLIFrameElement | null} */ frame) {
    try {
      const doc = frame && frame.contentDocument;
      return doc && frame && doc === written.get(frame) ? frame.contentWindow : null;
    } catch {
      return null;
    }
  }

  /** Origin and path of an address, without the differences in how a path can be escaped. */
  function fileOf(/** @type {URL} */ url) {
    try {
      return url.origin + decodeURIComponent(url.pathname);
    } catch {
      return url.origin + url.pathname;
    }
  }

  // ---- Size ---------------------------------------------------------------

  function layout() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) {
      return;
    }
    const want = width === 'fit' ? w : width;
    // A page wider than the tab is shown whole and smaller, as a phone shows a desktop page.
    const scale = Math.min(1, w / want);
    sheet.style.width = `${want}px`;
    sheet.style.height = `${h / scale}px`;
    sheet.style.left = `${Math.max(0, (w - want * scale) / 2)}px`;
    sheet.style.transform = scale < 1 ? `scale(${scale})` : '';
    sheet.classList.toggle('framed', width !== 'fit');
    $('statView').textContent = `${Math.round(want)} × ${Math.round(h / scale)}${scale < 1 ? ` at ${Math.round(scale * 100)}%` : ''}`;
  }
  new ResizeObserver(layout).observe(stage);

  // ---- Loading ------------------------------------------------------------

  /** Shows `page` in a new frame. The frame on screen stays until the new one has something to show. */
  function load() {
    if (!page) {
      return;
    }
    const msg = page;
    pending?.remove();
    gone = false;
    const frame = document.createElement('iframe');
    frame.title = msg.name;
    if (!msg.scripts) {
      // Scripting is off for the frame as a whole, on top of the policy in the page: only then does the page
      // show what it keeps in <noscript>. The listeners below belong to this page and go on working.
      frame.setAttribute('sandbox', 'allow-same-origin allow-forms');
    }
    if (windowOf(shown)) {
      frame.className = 'pending';
    } else {
      // Nothing worth keeping is on screen: the page that left its frame, or none yet.
      shown?.remove();
      shown = null;
    }
    // Written a task after the empty page has loaded, as VS Code does for its own frame (Chromium issue 978325).
    frame.addEventListener('load', () => setTimeout(() => write(frame, msg), 0), { once: true });
    frame.src = ADDRESS;
    pending = frame;
    sheet.appendChild(frame);
  }

  function write(/** @type {HTMLIFrameElement} */ frame, msg) {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (frame !== pending || !win || !doc) {
      return;
    }
    written.set(frame, doc);
    doc.open();
    // After open(), which drops every listener of the window, and before the page's scripts add theirs.
    hook(frame, win);
    doc.write(msg.html);
    doc.close();
    // Any later load of the frame is a page that went elsewhere.
    frame.addEventListener('load', () => {
      if (!windowOf(frame)) {
        left(frame);
      }
    });
    if (shown) {
      setTimeout(() => reveal(frame), SWAP_AFTER);
    } else {
      wanted.set(frame, scroll);
      reveal(frame);
    }
  }

  /** Puts a frame on screen in the place of the one before it, at the scroll position of that one. */
  function reveal(/** @type {HTMLIFrameElement} */ frame) {
    if (frame !== pending) {
      return;
    }
    const old = shown;
    const before = windowOf(old);
    if (before) {
      wanted.set(frame, { x: before.scrollX, y: before.scrollY });
    }
    shown = frame;
    pending = null;
    frame.classList.remove('pending');
    old?.remove();
    restore(frame);
    if (!gone) {
      showMessage(page.empty ? 'The file is empty.' : '');
    }
    describe();
  }

  function restore(/** @type {HTMLIFrameElement} */ frame) {
    const at = wanted.get(frame);
    const win = windowOf(frame);
    if (at && win) {
      win.scrollTo(at.x, at.y);
    }
  }

  function describe() {
    if (!page) {
      return;
    }
    const title = windowOf(shown)?.document.title.trim();
    $('statInfo').textContent = [title, formatBytes(page.size) + (page.unsaved ? ' (unsaved)' : ''), page.scripts ? '' : 'scripts off'].filter(Boolean).join(' · ');
  }

  /** Tells the provider which files next to the page were loaded, so that a change to one of them reloads the page. */
  function report(/** @type {HTMLIFrameElement} */ frame) {
    const win = windowOf(frame);
    if (frame !== shown || !win) {
      return;
    }
    const urls = new Set();
    for (const entry of win.performance.getEntriesByType('resource')) {
      try {
        const url = new URL(entry.name);
        if (url.origin === local) {
          urls.add(url.origin + url.pathname);
        }
      } catch {
        // Not an address of a file.
      }
    }
    const list = [...urls].sort().slice(0, 400);
    if (list.join('\n') !== reported) {
      reported = list.join('\n');
      vscode.postMessage({ type: 'resources', urls: list });
    }
  }

  let reportTimer;
  function reportSoon(/** @type {HTMLIFrameElement} */ frame) {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => report(frame), 300);
  }

  // ---- The page in its frame ----------------------------------------------

  /**
   * Listens inside a frame. The listeners are functions of this page, so they need no script in the previewed
   * page and work when its scripts are off.
   */
  function hook(/** @type {HTMLIFrameElement} */ frame, /** @type {Window} */ win) {
    // These have to see whether the page handled the event itself, so they must run after every listener of
    // the page, also one on its window. Each is moved to the end of the list while the event is on its way down.
    const last = (/** @type {string} */ type, /** @type {(e: any) => void} */ listener) => {
      win.addEventListener(
        type,
        () => {
          win.removeEventListener(type, listener);
          win.addEventListener(type, listener);
        },
        true,
      );
      win.addEventListener(type, listener);
    };
    last('click', (e) => onClick(win, e));
    last('submit', onSubmit);
    last('keydown', (e) => onKey(win, e));
    last('keyup', (e) => onKey(win, e));

    win.addEventListener(
      'scroll',
      () => {
        if (frame === shown && !wanted.has(frame)) {
          scroll = { x: win.scrollX, y: win.scrollY };
          saveState();
        }
      },
      { passive: true },
    );
    // Once the user moves the page, it is no longer put back where it was.
    for (const type of ['wheel', 'pointerdown', 'keydown']) {
      win.addEventListener(type, () => wanted.delete(frame), { capture: true, passive: true });
    }
    win.addEventListener('DOMContentLoaded', () => {
      restore(frame);
      if (frame === shown) {
        describe();
      }
    });
    win.addEventListener('load', () => {
      reveal(frame);
      // Only now does the page have its full height.
      restore(frame);
      wanted.delete(frame);
      describe();
      reportSoon(frame);
    });
    // Where this is missing, a page that leaves is stopped by the policy of this page, with less grace.
    /** @type {any} */ (win).navigation?.addEventListener('navigate', (/** @type {any} */ e) => onNavigate(win, e));
    try {
      // What the page loads later (a picture further down, the answer to a request) is reported as it comes.
      new /** @type {any} */ (win).PerformanceObserver(() => reportSoon(frame)).observe({ type: 'resource' });
    } catch {
      // Then the files known when the page has loaded have to do.
    }
  }

  function onClick(/** @type {Window} */ win, /** @type {MouseEvent} */ e) {
    if (e.defaultPrevented || e.button !== 0) {
      return;
    }
    const link = /** @type {Element | undefined} */ (
      e.composedPath().find((node) => {
        const el = /** @type {Element} */ (node);
        return el.nodeType === 1 && (el.localName === 'a' || el.localName === 'area') && (el.hasAttribute('href') || el.hasAttribute('xlink:href'));
      })
    );
    if (!link) {
      return;
    }
    const href = (link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? '').trim();
    // A script behind a link is the page's own business.
    if (/^javascript:/i.test(href)) {
      return;
    }
    // The frame never goes to another address: it could not come back, and the file would not be found there.
    e.preventDefault();
    let url;
    try {
      url = new URL(href, win.document.baseURI);
    } catch {
      return;
    }
    if (href === '' || href.startsWith('#') || fileOf(url) === fileOf(new URL(page.own))) {
      // A place on this page. With a <base> in the head, the link itself would lead to the folder instead.
      if (!url.hash) {
        win.scrollTo(0, 0);
      }
      win.location.hash = url.hash;
    } else {
      vscode.postMessage({ type: 'link', href: url.href });
    }
  }

  function onSubmit(/** @type {SubmitEvent} */ e) {
    if (e.defaultPrevented) {
      return;
    }
    const form = /** @type {Element} */ (e.target);
    const method = e.submitter?.getAttribute('formmethod') || form.getAttribute('method') || '';
    // A form that only closes its dialog goes nowhere.
    if (method.toLowerCase() === 'dialog') {
      return;
    }
    e.preventDefault();
    toast('Forms are not submitted in the preview');
  }

  /** Cut, copy, paste, select all, undo and redo, by the letter of the key or, on a layout without Latin letters, by its place. */
  function editCommand(/** @type {KeyboardEvent} */ e) {
    const mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.altKey) {
      return '';
    }
    const letter = (/^[a-z]$/i.test(e.key) ? e.key : (/^Key([A-Z])$/.exec(e.code)?.[1] ?? '')).toLowerCase();
    if (e.shiftKey) {
      return letter === 'z' ? 'redo' : '';
    }
    return { c: 'copy', x: 'cut', v: 'paste', a: 'selectAll', z: 'undo', y: MAC ? '' : 'redo' }[letter] ?? '';
  }

  /**
   * Keys pressed inside the page. VS Code hears the keys of a webview through a listener on the window of
   * this page, which a key pressed in a frame inside it never reaches, so its shortcuts would be dead while
   * the page has the focus. Each key is repeated here for that listener.
   */
  function onKey(/** @type {Window} */ win, /** @type {KeyboardEvent} */ e) {
    // A key the page took for itself, or one a script made up, is not passed on.
    if (e.defaultPrevented || !e.isTrusted) {
      return;
    }
    if (e.type === 'keydown') {
      // The editing keys are VS Code's as well: it stops them and sends the command back, to this page.
      // The command is carried out where the selection is instead, as VS Code does in its own frame.
      const command = editCommand(e);
      if (command) {
        e.preventDefault();
        win.document.execCommand(command);
        return;
      }
    }
    window.dispatchEvent(
      new KeyboardEvent(e.type, {
        key: e.key,
        code: e.code,
        // Not in the standard dictionary, but Chromium takes it, and VS Code reads the key from it.
        .../** @type {any} */ ({ keyCode: e.keyCode }),
        location: e.location,
        repeat: e.repeat,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  // "Copy" from VS Code's menu arrives as a command to this page, which has nothing selected: the selection of the page inside is handed over.
  document.addEventListener('copy', (e) => {
    const text = windowOf(shown)?.getSelection()?.toString();
    if (text && e.clipboardData) {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    }
  });

  // ---- A page that leaves --------------------------------------------------

  /**
   * The page is about to go to another address: a script set `location`, or its head holds a redirect. It is
   * stopped before it leaves, because the frame could not show that address (a file is not found there) and
   * could not come back from it. The address is opened the way a link to it is.
   */
  function onNavigate(/** @type {Window} */ win, /** @type {any} */ e) {
    // A place on the same page, or an address the page gave itself with pushState: nothing leaves.
    if (e.hashChange || e.destination.sameDocument || !e.cancelable) {
      return;
    }
    e.preventDefault();
    let url;
    try {
      url = new URL(e.destination.url);
    } catch {
      return;
    }
    if (e.navigationType === 'reload' || fileOf(url) === fileOf(new URL(page.own))) {
      again();
      return;
    }
    const file = url.origin === local;
    // Right after a click or a key, as in the handler of a button, it is what the user asked for.
    const asked = !!(/** @type {any} */ (win.navigator).userActivation?.isActive);
    // A redirect opens its target once, since it runs again with every keystroke in the source, and never the browser.
    if (asked ? file || /^(https?|mailto|tel):$/.test(url.protocol) : file && !followed.has(url.href)) {
      followed.add(url.href);
      vscode.postMessage({ type: 'link', href: url.href });
    }
    if (!asked) {
      const name = file ? decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '') : url.href;
      toast(`This page leads on to ${name.length > 80 ? `${name.slice(0, 80)}…` : name}`);
    }
  }

  /** The page asked to be loaded again. */
  function again() {
    const now = Date.now();
    reloads = reloads.filter((time) => now - time < RELOADS.within);
    reloads.push(now);
    if (reloads.length > RELOADS.count) {
      gone = true;
      showMessage('This page keeps loading itself again.\nReload starts it once more.');
    } else {
      load();
    }
  }

  // What follows is for a page that got away all the same: the policy of this page stops the frame at its
  // door, and the frame is left with an error page. The policy tells no more of the address than its origin.
  function lost() {
    gone = true;
    showMessage('This page went on to another address.\nReload shows it again.');
  }

  document.addEventListener('securitypolicyviolation', (e) => {
    if (e.effectiveDirective === 'frame-src') {
      lost();
    }
  });

  /** A frame that no longer holds the page written into it. */
  function left(/** @type {HTMLIFrameElement} */ frame) {
    if (frame !== shown && frame !== pending) {
      return;
    }
    let reloaded = false;
    try {
      reloaded = !!frame.contentDocument;
    } catch {
      // Another origin.
    }
    if (reloaded) {
      // Still an address of the webview: the page loaded itself again, which finds no file there.
      again();
    } else if (!gone) {
      lost();
    }
  }

  // ---- Toolbar ------------------------------------------------------------

  $('openSource').addEventListener('click', (e) => vscode.postMessage({ type: 'openSource', beside: e.altKey }));
  $('openBrowser').addEventListener('click', () => vscode.postMessage({ type: 'openBrowser' }));
  $('reload').addEventListener('click', () => {
    reloads = [];
    load();
  });
  $('scripts').addEventListener('change', () => vscode.postMessage({ type: 'scripts', on: $('scripts').checked }));
  $('width').addEventListener('change', () => {
    const value = Number($('width').value);
    width = WIDTHS.includes(value) ? value : 'fit';
    saveState();
    layout();
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'page': {
        // Saving the source, or closing it, sends the text that is on screen already: the page keeps running.
        const same = page && windowOf(shown) && !pending && !gone && !msg.force && msg.html === page.html;
        page = msg;
        local = new URL(msg.own).origin;
        $('scripts').checked = msg.scripts;
        $('openBrowser').hidden = !msg.browser;
        $('error').hidden = true;
        stage.classList.remove('broken');
        if (same) {
          describe();
        } else {
          load();
        }
        break;
      }
      case 'error':
        // The last page that could be read stays behind the reason, dimmed.
        $('error').textContent = msg.message;
        $('error').hidden = false;
        showMessage('');
        stage.classList.add('broken');
        break;
      case 'note':
        toast(msg.text);
        break;
    }
  });

  $('width').value = String(width);
  layout();
  vscode.postMessage({ type: 'ready' });
})();
