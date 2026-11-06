// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  /** Height of a row in px; the same number is in archive.css. */
  const ROW = 22;
  /** Rows drawn beyond each edge of the visible part, so that scrolling doesn't show gaps. */
  const OVERSCAN = 8;
  /** Expanded folders remembered across reloads of the page. */
  const MAX_SAVED_OPEN = 2000;

  const FILE = 0;
  const DIR = 1;
  const LINK = 2;

  /**
   * @typedef {object} Node
   * @property {string} name
   * @property {string} path
   * @property {Node | null} parent
   * @property {number} depth
   * @property {number} kind
   * @property {number} index Entry index in the provider's listing; -1 for a folder the archive has no entry for.
   * @property {number} size
   * @property {number} packed -1 when the format has no packed size per entry.
   * @property {number} mtime
   * @property {string} note Why the entry can't be extracted.
   * @property {boolean} secret Protected with a password.
   * @property {string} link
   * @property {Node[] | null} children
   * @property {Map<string, Node> | null} folders
   * @property {boolean} sorted
   * @property {boolean} open
   * @property {boolean | undefined} filterOpen What the user chose while a filter is on.
   * @property {boolean} hit The name matches the filter.
   * @property {boolean} has Something below matches the filter.
   * @property {number} files
   */

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const tree = $('tree');
  const spacer = $('spacer');
  const rowsBox = $('rows');
  const message = $('message');
  const locked = $('locked');
  const filterInput = /** @type {HTMLInputElement} */ ($('filter'));
  const extractAll = /** @type {HTMLButtonElement} */ ($('extractAll'));
  const extractSelected = /** @type {HTMLButtonElement} */ ($('extractSelected'));

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const numberFormat = new Intl.NumberFormat('en-US');

  const saved = vscode.getState() || {};
  /** @type {Set<string> | undefined} Folders to reopen; undefined on the first visit, when the top level opens by itself. */
  let savedOpen = saved.open ? new Set(saved.open) : undefined;
  let savedSelected = /** @type {string | undefined} */ (saved.selected);
  let savedScroll = /** @type {number} */ (saved.scroll || 0);

  /** @type {Node} */
  let root = folderNode('', null);
  /** @type {Node[]} Every node, parents before their children. */
  let all = [];
  /** @type {Node[]} The rows of the tree as it is unfolded now. */
  let rows = [];
  /** @type {Node | null} */
  let selected = null;
  let needle = '';
  let frame = 0;

  filterInput.value = saved.filter || '';

  function formatSize(/** @type {number} */ bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let unit = -1;
    do {
      bytes /= 1024;
      unit++;
    } while (bytes >= 1024 && unit < units.length - 1);
    return `${bytes < 100 ? bytes.toFixed(1) : Math.round(bytes)} ${units[unit]}`;
  }

  function plural(/** @type {number} */ count, /** @type {string} */ noun) {
    return `${numberFormat.format(count)} ${noun}${count === 1 ? '' : 's'}`;
  }

  /** @returns {Node} */
  function folderNode(/** @type {string} */ name, /** @type {Node | null} */ parent) {
    return {
      name,
      path: parent && parent.path ? `${parent.path}/${name}` : name,
      parent,
      depth: parent ? parent.depth + 1 : -1,
      kind: DIR,
      index: -1,
      size: 0,
      packed: 0,
      mtime: 0,
      note: '',
      secret: false,
      link: '',
      children: [],
      folders: new Map(),
      sorted: false,
      open: false,
      filterOpen: undefined,
      hit: false,
      has: false,
      files: 0,
    };
  }

  /** Builds the tree from the entries, which arrive as `[path, kind, size, packed, mtime, note, link, secret]`. */
  function build(/** @type {any[][]} */ entries) {
    root = folderNode('', null);
    all = [];
    const folder = (/** @type {Node} */ parent, /** @type {string} */ name) => {
      const folders = /** @type {Map<string, Node>} */ (parent.folders);
      let node = folders.get(name);
      if (!node) {
        node = folderNode(name, parent);
        folders.set(name, node);
        /** @type {Node[]} */ (parent.children).push(node);
        all.push(node);
      }
      return node;
    };
    entries.forEach((entry, index) => {
      const [path, kind, size, packed, mtime, note, link, secret] = entry;
      const parts = path.split('/');
      let parent = root;
      for (let i = 0; i < parts.length - 1; i++) {
        parent = folder(parent, parts[i]);
      }
      const name = parts[parts.length - 1];
      if (kind === DIR) {
        const node = folder(parent, name);
        node.index = index;
        node.mtime = mtime;
        node.note = note;
        return;
      }
      /** @type {Node} */
      const node = { ...folderNode(name, parent), kind, index, size, packed, mtime, note, secret: !!secret, link, children: null, folders: null, files: 1 };
      /** @type {Node[]} */ (parent.children).push(node);
      all.push(node);
    });
    // Parents come before their children in `all`, so one pass backwards adds everything up.
    for (let i = all.length - 1; i >= 0; i--) {
      const node = all[i];
      const parent = /** @type {Node} */ (node.parent);
      parent.size += node.size;
      parent.files += node.kind === DIR ? node.files : 1;
      parent.packed = parent.packed < 0 || node.packed < 0 ? -1 : parent.packed + node.packed;
    }
  }

  /** The children in display order: folders first, then natural order ("file2" before "file10"). Sorted on first use. */
  function childrenOf(/** @type {Node} */ node) {
    const children = /** @type {Node[]} */ (node.children);
    if (!node.sorted) {
      children.sort((a, b) => (a.children ? 0 : 1) - (b.children ? 0 : 1) || collator.compare(a.name, b.name));
      node.sorted = true;
    }
    return children;
  }

  function isOpen(/** @type {Node} */ node) {
    // Under a filter the folders that lead to a match stand open, until the user says otherwise.
    return needle ? (node.filterOpen !== undefined ? node.filterOpen : node.has) : node.open;
  }

  function applyFilter() {
    needle = filterInput.value.trim().toLowerCase();
    const byPath = needle.includes('/');
    for (const node of all) {
      node.has = false;
      node.filterOpen = undefined;
    }
    let hits = 0;
    if (needle) {
      for (let i = all.length - 1; i >= 0; i--) {
        const node = all[i];
        node.hit = (byPath ? node.path : node.name).toLowerCase().includes(needle);
        if (node.hit) {
          hits++;
        }
        if ((node.hit || node.has) && node.parent) {
          node.parent.has = true;
        }
      }
    }
    $('matches').textContent = needle ? (hits ? `${numberFormat.format(hits)} ${hits === 1 ? 'match' : 'matches'}` : 'Nothing matches') : '';
  }

  function flatten() {
    rows = [];
    /** `within` is set below a folder that matches itself: its whole content is shown. */
    const walk = (/** @type {Node} */ parent, /** @type {boolean} */ within) => {
      for (const node of childrenOf(parent)) {
        if (needle && !within && !node.hit && !node.has) {
          continue;
        }
        rows.push(node);
        if (node.children && isOpen(node)) {
          walk(node, within || node.hit);
        }
      }
    };
    walk(root, false);
    spacer.style.height = `${rows.length * ROW}px`;
    message.hidden = rows.length > 0;
    if (!rows.length) {
      message.textContent = all.length ? 'No file or folder matches the filter.' : 'The archive is empty.';
    }
    if (selected && !rows.includes(selected)) {
      // The selection moves to the nearest ancestor that is still shown.
      let node = selected.parent;
      while (node && node !== root && !rows.includes(node)) {
        node = node.parent;
      }
      select(node && node !== root ? node : null, false);
    }
    render();
  }

  const ICONS = {
    [FILE]: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor"/></svg>',
    [DIR]: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h5l1.5 2h6.5v8h-13z" fill="currentColor" fill-opacity="0.25" stroke="currentColor"/></svg>',
    [LINK]: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor"/><path d="M6.5 11.5l3-3m0 0h-2.4m2.4 0v2.4" fill="none" stroke="currentColor"/></svg>',
  };
  const LOCK = '<svg viewBox="0 0 16 16"><path d="M4.5 7.5h7v6h-7z M6 7.5V5.2a2 2 0 0 1 4 0v2.3" fill="none" stroke="currentColor"/></svg>';

  function span(/** @type {string} */ className, /** @type {string} */ text = '') {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function rowElement(/** @type {Node} */ node, /** @type {number} */ index) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.row = String(index);
    row.setAttribute('role', 'treeitem');
    row.classList.toggle('selected', node === selected);
    row.classList.toggle('blocked', !!node.note);
    row.classList.toggle('folder', node.kind === DIR);
    row.title = node.note ? `${node.path}\n${node.note}.` : node.link ? `${node.path} → ${node.link}` : node.secret ? `${node.path}\nProtected with a password.` : node.path;

    const name = span('name');
    name.style.paddingLeft = `${6 + node.depth * 14}px`;
    const twisty = span(node.children && node.children.length ? (isOpen(node) ? 'twisty open' : 'twisty') : 'twisty none');
    const icon = span('icon');
    icon.innerHTML = ICONS[node.kind];
    const label = span('label');
    const at = needle && !needle.includes('/') ? node.name.toLowerCase().indexOf(needle) : -1;
    if (at >= 0) {
      const mark = document.createElement('mark');
      mark.textContent = node.name.slice(at, at + needle.length);
      label.append(node.name.slice(0, at), mark, node.name.slice(at + needle.length));
    } else {
      label.textContent = node.name;
    }
    name.append(twisty, icon, label);
    if (node.secret) {
      const lock = span('lock');
      lock.innerHTML = LOCK;
      name.append(lock);
    }
    if (node.link) {
      name.append(span('detail', `→ ${node.link}`));
    }
    if (node.note) {
      name.append(span('detail', node.note));
    }
    if (node.kind === DIR) {
      row.setAttribute('aria-expanded', String(isOpen(node)));
      name.append(span('detail', node.files ? plural(node.files, 'file') : 'empty'));
    }

    row.append(
      name,
      span('num', node.kind === DIR && !node.files ? '' : formatSize(node.size)),
      span('num', node.packed < 0 || (node.kind === DIR && !node.files) ? '' : formatSize(node.packed)),
      span('date', node.mtime ? dateFormat.format(node.mtime) : ''),
    );
    return row;
  }

  /** Draws only the rows in view: an archive can have more entries than a page can hold as elements. */
  function render() {
    frame = 0;
    const first = Math.max(0, Math.floor(tree.scrollTop / ROW) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((tree.scrollTop + tree.clientHeight) / ROW) + OVERSCAN);
    const elements = [];
    for (let i = first; i < last; i++) {
      elements.push(rowElement(rows[i], i));
    }
    rowsBox.style.transform = `translateY(${first * ROW}px)`;
    rowsBox.replaceChildren(...elements);
  }

  function schedule() {
    frame = frame || requestAnimationFrame(render);
  }

  let saveTimer = 0;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const open = [];
      for (const node of all) {
        if (node.open && open.length < MAX_SAVED_OPEN) {
          open.push(node.path);
        }
      }
      vscode.setState({ open, selected: selected ? selected.path : undefined, filter: filterInput.value, scroll: tree.scrollTop });
    }, 200);
  }

  function select(/** @type {Node | null} */ node, reveal = true) {
    selected = node;
    extractSelected.disabled = !node;
    extractSelected.title = node ? `Extract "${node.name}"` : 'Extract the selected file or folder';
    if (node && reveal) {
      const top = rows.indexOf(node) * ROW;
      if (top < tree.scrollTop) {
        tree.scrollTop = top;
      } else if (top + ROW > tree.scrollTop + tree.clientHeight) {
        tree.scrollTop = top + ROW - tree.clientHeight;
      }
    }
    schedule();
    saveState();
  }

  function toggle(/** @type {Node} */ node, /** @type {boolean} */ open = !isOpen(node)) {
    if (needle) {
      node.filterOpen = open;
    } else {
      node.open = open;
    }
    flatten();
    saveState();
  }

  function activate(/** @type {Node} */ node) {
    if (node.children) {
      toggle(node);
    } else if (node.kind === FILE) {
      vscode.postMessage({ type: 'open', index: node.index });
    }
  }

  function show(/** @type {any} */ msg) {
    // A reload keeps what was open and selected; the first load takes it from the saved state.
    if (all.length) {
      savedOpen = new Set(all.filter((n) => n.open).map((n) => n.path));
      savedSelected = selected ? selected.path : undefined;
      savedScroll = tree.scrollTop;
    }
    build(msg.entries);
    selected = null;
    for (const node of all) {
      if (node.children && savedOpen && savedOpen.has(node.path)) {
        node.open = true;
      }
      if (node.path === savedSelected) {
        selected = node;
      }
    }
    if (!savedOpen) {
      // A lone folder at the top, the usual shape of a source archive, is opened right away.
      let node = root;
      while (node.children && node.children.length === 1 && node.children[0].children) {
        node = node.children[0];
        node.open = true;
      }
    }

    let folders = 0;
    let secrets = 0;
    for (const node of all) {
      folders += node.kind === DIR ? 1 : 0;
      secrets += node.secret ? 1 : 0;
    }
    const parts = [msg.format, `${plural(root.files, 'file')}${folders ? `, ${plural(folders, 'folder')}` : ''}`];
    if (secrets || msg.locked) {
      parts[0] += msg.locked ? ', encrypted, names too' : secrets < root.files ? ', partly encrypted' : ', encrypted';
    }
    // A ratio only says something when packing made the content smaller; a few small files weigh less than the archive's own records.
    const ratio = msg.fileSize < root.size ? (msg.fileSize / root.size) * 100 : 0;
    parts.push(`${formatSize(root.size)}, packed ${formatSize(msg.fileSize)}${ratio ? ` (${ratio < 1 ? '<1' : Math.round(ratio)}%)` : ''}`);
    $('name').textContent = msg.name;
    $('summary').textContent = parts.join(' · ');
    $('note').textContent = msg.warning || '';
    $('note').hidden = !msg.warning;
    document.body.classList.remove('failed');
    locked.hidden = true;
    extractAll.disabled = !all.length;
    extractSelected.disabled = !selected;

    applyFilter();
    flatten();
    tree.scrollTop = savedScroll;
    render();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'listing') {
      show(msg);
    } else if (msg.type === 'error' || msg.type === 'locked') {
      // Nothing can be listed: the page is the name of the archive and what is the matter with it.
      const isLocked = msg.type === 'locked';
      build([]);
      rows = [];
      selected = null;
      spacer.style.height = '0';
      rowsBox.replaceChildren();
      $('name').textContent = msg.name;
      $('summary').textContent = '';
      $('note').hidden = true;
      document.body.classList.add('failed');
      extractAll.disabled = extractSelected.disabled = true;
      message.hidden = isLocked;
      message.textContent = isLocked ? '' : msg.message;
      locked.hidden = !isLocked;
    }
  });

  tree.addEventListener('scroll', () => {
    schedule();
    saveState();
  });
  new ResizeObserver(schedule).observe(tree);

  rowsBox.addEventListener('click', (e) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.row'));
    const node = row && rows[Number(row.dataset.row)];
    if (node) {
      select(node, false);
      activate(node);
    }
  });

  tree.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !rows.length) {
      return;
    }
    const at = selected ? rows.indexOf(selected) : -1;
    const page = Math.max(1, Math.floor(tree.clientHeight / ROW) - 1);
    const move = (/** @type {number} */ to) => select(rows[Math.max(0, Math.min(rows.length - 1, to))]);
    switch (e.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? 0 : at - 1);
        break;
      case 'PageDown':
        move(at + page);
        break;
      case 'PageUp':
        move(at - page);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (selected && selected.children) {
          if (!isOpen(selected)) {
            toggle(selected, true);
          } else if (rows[at + 1] && rows[at + 1].parent === selected) {
            move(at + 1);
          }
        }
        break;
      case 'ArrowLeft':
        if (selected && selected.children && isOpen(selected)) {
          toggle(selected, false);
        } else if (selected && selected.parent && selected.parent !== root) {
          select(selected.parent);
        }
        break;
      case 'Enter':
        if (selected) {
          activate(selected);
        }
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  let filterTimer = 0;
  filterInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      applyFilter();
      tree.scrollTop = 0;
      flatten();
      saveState();
    }, 120);
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      tree.focus();
      if (!selected && rows.length) {
        select(rows[0]);
      }
    }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      filterInput.focus();
      filterInput.select();
    }
  });

  $('unlock').addEventListener('click', () => vscode.postMessage({ type: 'unlock' }));
  extractAll.addEventListener('click', () => vscode.postMessage({ type: 'extract' }));
  extractSelected.addEventListener('click', () => {
    if (selected) {
      vscode.postMessage({ type: 'extract', path: selected.path });
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
