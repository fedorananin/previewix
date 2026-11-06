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

  // ---- Requests -----------------------------------------------------------

  let seq = 0;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
  const waiting = new Map();

  /** @returns {Promise<any>} */
  function request(/** @type {string} */ method, /** @type {any[]} */ ...args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      vscode.postMessage({ type: 'request', id, method, args });
    });
  }

  // ---- State --------------------------------------------------------------

  /** @type {{size: number, tables: any[]} | null} */
  let schema = null;
  /** @type {'data' | 'structure' | 'query'} */
  let mode = saved.mode || 'data';
  /** Name of the table on screen. */
  let current = saved.table || '';
  let limit = saved.limit || 100;
  let offset = 0;
  /** @type {{column: string, desc: boolean} | null} */
  let sort = null;
  let filter = '';
  /** Last reply for the table on screen. @type {{table: any, rows: any[], total: number} | null} */
  let data = null;
  /**
   * The rows a followed foreign key narrows the table on screen to, and how to say so.
   * @type {{columns: string[], values: any[], text: string} | null}
   */
  let match = saved.match || null;
  /**
   * The views that following keys led away from, oldest first: enough of each to put it back.
   * @type {{table: string, offset: number, sort: any, filter: string, match: any, row: number, col: number, scroll: number[]}[]}
   */
  let trail = saved.trail || [];
  /** The entry of `trail` that was gone back to, until its rows are there and its cell can be selected again. @type {any} */
  let restore = null;
  let followToken = 0;
  /** Last reply of the SQL prompt. Its `source` is how an export of the result, or a blob in it, gets the rows again. @type {any} */
  let result = null;
  let exporting = false;

  /** Columns and rows of the grid as drawn. A row is either one from the file or a pending insert. */
  /** @type {any[]} */
  let columns = [];
  /** @type {{key?: any[], id?: string, cells?: any[], insert?: {values: Map<string, any>}}[]} */
  let view = [];
  /** @type {{row: number, col: number} | null} */
  let active = null;
  /** Rows picked in the gutter. @type {Set<number>} */
  const marked = new Set();
  let markAnchor = 0;

  /**
   * Unsaved changes per table: cell updates and deletions by row key, and new rows.
   * @type {Map<string, {updates: Map<string, {key: any[], values: Map<string, any>}>, deletes: Map<string, any[]>, inserts: {values: Map<string, any>}[]}>}
   */
  const pending = new Map();

  /** The open cell editor. @type {{row: number, col: number, input: HTMLTextAreaElement, original: string} | null} */
  let editor = null;
  /** A reload asked for while a cell was being edited. */
  let stale = false;
  let saving = false;
  let rowsToken = 0;
  let countsToken = 0;
  /** @type {Map<string, number>} */
  const counts = new Map();

  function saveState() {
    vscode.setState({ mode, table: current, limit, sql: $('sql').value, match, trail });
  }

  // ---- Values -------------------------------------------------------------

  const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  function formatSize(/** @type {number} */ bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${i && bytes < 100 ? bytes.toFixed(1) : Math.round(bytes)} ${units[i]}`;
  }

  /** How a value looks in a cell. */
  function display(/** @type {any} */ value) {
    if (value === undefined) {
      return { text: 'DEFAULT', kind: 'dim' };
    }
    if (value === null) {
      return { text: 'NULL', kind: 'dim' };
    }
    if (typeof value === 'number') {
      return { text: String(value), kind: 'num' };
    }
    if (typeof value === 'string') {
      return { text: value, kind: '' };
    }
    if ('blob' in value) {
      const picture = blobKind(value.hex)?.mime ? blobKind(value.hex) : null;
      return {
        text: `${picture ? `${picture.name} image` : 'BLOB'} ${formatSize(value.blob)}`,
        kind: picture ? 'dim image' : 'dim',
        title: value.hex.replace(/../g, '$& ').trim() + (value.blob > value.hex.length / 2 ? ' …' : ''),
      };
    }
    if ('text' in value) {
      return { text: value.text + '…', kind: '' };
    }
    return { text: value.int ?? value.num, kind: 'num' };
  }

  // Signature (hex), name, file extension and, for the pictures the page can show, the MIME type.
  const SIGNATURES = [
    ['89504e470d0a1a0a', 'PNG', 'png', 'image/png'],
    ['ffd8ff', 'JPEG', 'jpg', 'image/jpeg'],
    ['474946383761', 'GIF', 'gif', 'image/gif'],
    ['474946383961', 'GIF', 'gif', 'image/gif'],
    ['25504446', 'PDF', 'pdf', ''],
    ['504b0304', 'ZIP', 'zip', ''],
    ['1f8b08', 'gzip', 'gz', ''],
    ['53514c69746520666f726d6174203300', 'SQLite', 'sqlite', ''],
  ];

  /** What a blob is, as far as the first bytes that come with every cell can tell. */
  function blobKind(/** @type {string} */ hex) {
    for (const [signature, name, ext, mime] of SIGNATURES) {
      if (hex.startsWith(signature)) {
        return { name, ext, mime };
      }
    }
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') {
      return { name: 'WebP', ext: 'webp', mime: 'image/webp' };
    }
    // "BM" alone is too little to go by; the reserved bytes after the file size are zero in a bitmap.
    if (hex.startsWith('424d') && hex.slice(12, 20) === '00000000') {
      return { name: 'BMP', ext: 'bmp', mime: 'image/bmp' };
    }
    return null;
  }

  const isBlob = (/** @type {any} */ value) => !!value && typeof value === 'object' && 'blob' in value;

  /** Lets an edit that restores the stored value drop out of the pending changes. */
  function canon(/** @type {any} */ value) {
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return 's:' + value;
    }
    if (typeof value === 'number') {
      return 'n:' + value;
    }
    if ('int' in value) {
      return 'n:' + value.int;
    }
    if ('num' in value) {
      return 'n:' + (/^[+-]?\d+$/.test(value.num) ? BigInt(value.num) : Number(value.num));
    }
    // Shortened texts and blobs never equal anything typed.
    return 'x:' + JSON.stringify(value);
  }

  /**
   * Text typed into a cell, as the value SQLite would make of it in that column.
   * A CSV import converts its fields by the same rules: parseInput() in src/sqliteDb.ts. Keep the two in step.
   */
  function parseInput(/** @type {string} */ text, /** @type {any} */ column) {
    const number = NUMBER.test(text.trim());
    if (column.affinity === 'text') {
      return text;
    }
    if (column.affinity === 'numeric') {
      return text.trim() === '' ? null : number ? { num: text.trim() } : text;
    }
    return number ? { num: text.trim() } : text;
  }

  // ---- Pending changes ----------------------------------------------------

  function changesOf(/** @type {string} */ table) {
    let changes = pending.get(table);
    if (!changes) {
      changes = { updates: new Map(), deletes: new Map(), inserts: [] };
      pending.set(table, changes);
    }
    return changes;
  }

  function pendingCount() {
    let n = 0;
    for (const changes of pending.values()) {
      n += changes.deletes.size + changes.inserts.length;
      for (const update of changes.updates.values()) {
        n += update.values.size;
      }
    }
    return n;
  }

  function prune() {
    for (const [name, changes] of pending) {
      if (!changes.updates.size && !changes.deletes.size && !changes.inserts.length) {
        pending.delete(name);
      }
    }
  }

  function isDeleted(/** @type {any} */ row) {
    return !!row.id && !!pending.get(current)?.deletes.has(row.id);
  }

  /** The value a cell shows: the pending one if there is one. */
  function cellValue(/** @type {any} */ row, /** @type {number} */ col) {
    const name = columns[col].name;
    if (row.insert) {
      return { value: row.insert.values.get(name), changed: false };
    }
    const update = row.id && mode === 'data' ? pending.get(current)?.updates.get(row.id) : undefined;
    return update?.values.has(name) ? { value: update.values.get(name), changed: true } : { value: row.cells[col], changed: false };
  }

  function setCell(/** @type {any} */ row, /** @type {number} */ col, /** @type {any} */ value) {
    const name = columns[col].name;
    if (row.insert) {
      row.insert.values.set(name, value);
    } else {
      const changes = changesOf(current);
      let update = changes.updates.get(row.id);
      if (canon(value) === canon(row.cells[col])) {
        update?.values.delete(name);
        if (update && !update.values.size) {
          changes.updates.delete(row.id);
        }
      } else {
        if (!update) {
          update = { key: row.key, values: new Map() };
          changes.updates.set(row.id, update);
        }
        update.values.set(name, value);
      }
    }
    prune();
    updatePending();
  }

  /** Whether the cell's value may be replaced at all. */
  function canChange(/** @type {number} */ r, /** @type {number} */ c) {
    const row = view[r];
    return mode === 'data' && !saving && !!data?.table.key && !!row && !!columns[c] && !columns[c].generated && !isDeleted(row);
  }

  function updatePending() {
    const n = pendingCount();
    $('save').disabled = !n || saving;
    $('revert').disabled = !n || saving;
    if (n) {
      $('status').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
    } else if (/unsaved/.test($('status').textContent)) {
      $('status').textContent = '';
    }
    for (const item of $('tables').querySelectorAll('.table')) {
      item.classList.toggle('dirty', pending.has(item.dataset.name));
    }
  }

  // ---- Sidebar ------------------------------------------------------------

  function renderSidebar() {
    const tables = schema?.tables ?? [];
    const nodes = [];
    for (const [title, list] of [
      ['Tables', tables.filter((t) => t.type !== 'view')],
      ['Views', tables.filter((t) => t.type === 'view')],
    ]) {
      if (!list.length) {
        continue;
      }
      nodes.push(el('h2', '', `${title} (${list.length})`));
      for (const table of /** @type {any[]} */ (list)) {
        const item = el('button', 'table');
        item.dataset.name = table.name;
        item.title = table.name;
        const count = counts.get(table.name);
        item.append(el('span', 'name', table.name), el('span', 'count', count === undefined ? '' : count.toLocaleString('en-US')));
        item.addEventListener('click', () => openTable(table.name));
        nodes.push(item);
      }
    }
    $('tables').replaceChildren(...nodes);
    $('fileInfo').textContent = schema ? formatSize(schema.size) : '';
    updateChrome();
    updatePending();
  }

  /** Row counts are asked for one table at a time, so paging stays responsive in between. */
  async function loadCounts() {
    const token = ++countsToken;
    for (const table of schema?.tables ?? []) {
      try {
        const n = await request('count', table.name);
        if (token !== countsToken) {
          return;
        }
        counts.set(table.name, n);
        const badge = [...$('tables').querySelectorAll('.table')].find((item) => item.dataset.name === table.name)?.querySelector('.count');
        if (badge) {
          badge.textContent = n.toLocaleString('en-US');
        }
      } catch {
        // A table that can't be counted just has no number.
      }
    }
  }

  // ---- Chrome -------------------------------------------------------------

  function showMessage(/** @type {string} */ text) {
    $('message').textContent = text;
    $('message').hidden = !text;
  }

  function showNote(/** @type {string} */ text) {
    $('note').textContent = text;
    $('note').hidden = !text;
  }

  function updateChrome() {
    const table = schema?.tables.find((t) => t.name === current);
    const editable = mode === 'data' && !!data?.table.key;
    for (const button of $('modes').querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.mode === mode);
    }
    $('modes').hidden = mode === 'query' || !table;
    $('filter').hidden = mode !== 'data' || !table;
    $('editButtons').hidden = mode !== 'data' || !table;
    $('addRow').disabled = !editable || saving;
    $('deleteRow').disabled = !editable || saving || (!marked.size && !active);
    $('setNull').disabled = !active || !canChange(active.row, active.col);
    $('queryPanel').hidden = mode !== 'query';
    $('trail').hidden = mode !== 'data' || !table || (!match && !trail.length);
    $('back').hidden = !trail.length;
    $('back').textContent = trail.length ? `← ${trail[trail.length - 1].table}` : '';
    $('showAll').hidden = !match;
    $('trailText').textContent = match ? `${current} where ${match.text}` : '';
    $('pager').hidden = mode !== 'data' || !data;
    $('grid').hidden = mode === 'structure';
    $('structure').hidden = mode !== 'structure';
    $('exportWrap').hidden = mode === 'structure' || (mode === 'data' && !table);
    // A statement that wrote has a result too (RETURNING), but running it again would write again.
    $('export').disabled = exporting || (mode === 'query' ? !result?.source : !data);
    $('import').disabled = !schema;
    $('openQuery').classList.toggle('active', mode === 'query');
    for (const item of $('tables').querySelectorAll('.table')) {
      item.classList.toggle('active', mode !== 'query' && item.dataset.name === current);
    }
    if (data && mode === 'data') {
      const last = Math.min(offset + data.rows.length, data.total);
      $('pageInfo').textContent = data.total ? `${(offset + 1).toLocaleString('en-US')}–${last.toLocaleString('en-US')} of ${data.total.toLocaleString('en-US')}` : 'No rows';
      $('pageFirst').disabled = $('pagePrev').disabled = offset === 0;
      $('pageNext').disabled = $('pageLast').disabled = offset + limit >= data.total;
    }
    inspect();
    showRefs();
  }

  // ---- Grid ---------------------------------------------------------------

  function cellAt(/** @type {number} */ r, /** @type {number} */ c) {
    return /** @type {HTMLTableCellElement | undefined} */ ($('grid').tBodies[0]?.rows[r]?.cells[c + 1]);
  }

  function paintCell(/** @type {HTMLTableCellElement} */ td, /** @type {number} */ r, /** @type {number} */ c) {
    const { value, changed } = cellValue(view[r], c);
    const shown = display(value);
    td.className = [shown.kind, changed ? 'changed' : '', active?.row === r && active.col === c ? 'active' : ''].join(' ').trim();
    td.textContent = shown.text;
    td.title = shown.title || '';
    td.removeAttribute('style');
  }

  function rowClass(/** @type {number} */ r) {
    const row = view[r];
    return [row.insert ? 'inserted' : '', isDeleted(row) ? 'deleted' : '', marked.has(r) ? 'marked' : ''].join(' ').trim();
  }

  function renderGrid() {
    if (!columns.length) {
      $('grid').replaceChildren();
      updateChrome();
      return;
    }
    const head = el('tr');
    head.append(el('th', 'gutter'));
    const keys = mode === 'data' ? (schema?.tables.find((t) => t.name === current)?.foreignKeys ?? []) : [];
    columns.forEach((column, c) => {
      const th = el('th');
      th.append(el('span', 'name', column.name));
      if (column.type) {
        th.append(el('span', 'type', column.type.toLowerCase()));
      }
      const targets = keys.filter((/** @type {any} */ key) => key.columns.includes(column.name)).map(keyTarget);
      if (targets.length) {
        const mark = el('span', 'ref', '→');
        mark.title = `Refers to ${targets.join(' and ')}`;
        th.append(mark);
      }
      if (mode === 'data') {
        th.classList.add('sortable');
        th.title = 'Sort by this column';
        if (sort?.column === column.name) {
          th.append(el('span', 'arrow', sort.desc ? '▼' : '▲'));
        }
        th.dataset.col = String(c);
      }
      head.append(th);
    });
    const thead = el('thead');
    thead.append(head);

    const tbody = el('tbody');
    view.forEach((row, r) => {
      const tr = el('tr', rowClass(r));
      tr.append(el('td', 'gutter', row.insert ? '+' : (offset + r + 1).toLocaleString('en-US')));
      for (let c = 0; c < columns.length; c++) {
        const td = /** @type {HTMLTableCellElement} */ (el('td'));
        paintCell(td, r, c);
        tr.append(td);
      }
      tbody.append(tr);
    });
    $('grid').replaceChildren(thead, tbody);
    updateChrome();
  }

  /** Puts the table rows and its pending inserts on screen. */
  function showData() {
    if (!data) {
      return;
    }
    columns = data.table.columns;
    view = data.rows.map((row) => ({ ...row, id: row.key ? JSON.stringify(row.key) : undefined }));
    for (const insert of pending.get(current)?.inserts ?? []) {
      view.push({ insert });
    }
    if (active && (active.row >= view.length || active.col >= columns.length)) {
      active = null;
    }
    for (const r of [...marked]) {
      if (r >= view.length) {
        marked.delete(r);
      }
    }
    showMessage(view.length ? '' : filter ? 'No rows match the filter.' : match ? `No row of ${current} has ${match.text} any more.` : 'The table is empty.');
    renderGrid();
  }

  function setActive(/** @type {number} */ r, /** @type {number} */ c, scroll = true) {
    if (active) {
      cellAt(active.row, active.col)?.classList.remove('active');
    }
    active = r >= 0 && r < view.length && c >= 0 && c < columns.length ? { row: r, col: c } : null;
    if (active) {
      const td = cellAt(r, c);
      td?.classList.add('active');
      // A click must not move the grid: the second click of a double-click would land on another cell.
      if (scroll) {
        td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      $('gridWrap').focus({ preventScroll: true });
    }
    updateChrome();
  }

  function setMarked(/** @type {number[]} */ rows) {
    marked.clear();
    rows.forEach((r) => marked.add(r));
    const body = $('grid').tBodies[0];
    for (let r = 0; r < view.length; r++) {
      body.rows[r].className = rowClass(r);
    }
    updateChrome();
  }

  // ---- Loading ------------------------------------------------------------

  async function loadRows() {
    if (!current || mode !== 'data') {
      return;
    }
    const token = ++rowsToken;
    try {
      const reply = await request('rows', current, { offset, limit, sort, filter, match: matchOf() });
      if (token !== rowsToken || mode !== 'data') {
        return;
      }
      // A page past the end, after rows were deleted or the filter changed.
      if (!reply.rows.length && offset > 0 && reply.total > 0) {
        offset = Math.floor((reply.total - 1) / limit) * limit;
        return loadRows();
      }
      data = reply;
      if (editor) {
        stale = true;
      } else {
        showData();
        if (restore) {
          // The view a key was followed from, with its cell selected again.
          const { row, col, scroll } = restore;
          restore = null;
          setActive(row, col, false);
          $('gridWrap').scrollTo(scroll[0], scroll[1]);
        }
      }
    } catch (e) {
      if (token === rowsToken) {
        restore = null;
        data = null;
        columns = [];
        view = [];
        renderGrid();
        showMessage(/** @type {Error} */ (e).message);
      }
    }
  }

  function showStructure() {
    const table = schema?.tables.find((t) => t.name === current);
    if (!table) {
      return;
    }
    const grid = el('table');
    const head = el('tr');
    for (const title of ['#', 'Column', 'Type', 'Not null', 'Default', 'Key']) {
      head.append(el('th', '', title));
    }
    grid.append(head);
    table.columns.forEach((/** @type {any} */ column, /** @type {number} */ i) => {
      const tr = el('tr');
      tr.append(
        el('td', 'dim', String(i + 1)),
        el('td', '', column.name),
        el('td', '', column.type + (column.generated ? ' (generated)' : '')),
        el('td', '', column.notnull ? 'yes' : ''),
        el('td', '', column.dflt ?? ''),
        el('td', '', column.pk ? `PK${table.columns.filter((/** @type {any} */ c) => c.pk).length > 1 ? ' ' + column.pk : ''}` : ''),
      );
      grid.append(tr);
    });
    const sheet = (/** @type {string[]} */ titles, /** @type {(Node | string)[][]} */ rows) => {
      const node = el('table');
      const first = el('tr');
      first.append(...titles.map((title) => el('th', '', title)));
      node.append(first);
      for (const cells of rows) {
        const tr = el('tr');
        for (const cell of cells) {
          const td = el('td');
          td.append(cell);
          tr.append(td);
        }
        node.append(tr);
      }
      return node;
    };
    const link = (/** @type {string} */ name) => {
      const node = button(name, 'link', () => openTable(name));
      node.title = `Open ${name}`;
      return node;
    };
    const list = (/** @type {string[]} */ names) => names.join(', ');
    const nodes = [grid];
    if (table.foreignKeys.length) {
      nodes.push(
        el('h3', '', 'Foreign keys'),
        sheet(
          ['Columns', 'Refers to', 'Columns there', 'On update', 'On delete'],
          table.foreignKeys.map((/** @type {any} */ key) => [
            list(key.columns),
            ...(key.broken ? [key.table, el('span', 'broken', key.broken)] : [link(key.table), list(key.to)]),
            key.onUpdate.toLowerCase(),
            key.onDelete.toLowerCase(),
          ]),
        ),
      );
    }
    const inbound = inboundKeys(table.name);
    if (inbound.length) {
      nodes.push(el('h3', '', 'Referred to by'), sheet(['Table', 'Columns', 'Columns here'], inbound.map(({ from, key }) => [link(from), list(key.columns), list(key.to)])));
    }
    $('structure').replaceChildren(...nodes, ...table.sql.map((/** @type {string} */ sql) => el('pre', '', sql)));
    showMessage('');
    updateChrome();
  }

  function showCurrent() {
    if (mode === 'structure') {
      showStructure();
    } else if (mode === 'data') {
      columns = [];
      view = [];
      renderGrid();
      showMessage('Loading…');
      void loadRows();
    }
  }

  function openTable(/** @type {string} */ name) {
    closeEditor(true);
    if (mode === 'query') {
      mode = 'data';
    }
    // Picking a table is a new start: it shows all of its rows, and there is nothing to go back to.
    if (name !== current || !data || match) {
      current = name;
      offset = 0;
      sort = null;
      filter = '';
      $('filter').value = '';
      data = null;
    }
    match = null;
    trail = [];
    restore = null;
    followToken++;
    active = null;
    marked.clear();
    saveState();
    updateChrome();
    showCurrent();
  }

  function setMode(/** @type {'data' | 'structure' | 'query'} */ next) {
    closeEditor(true);
    mode = next;
    active = null;
    marked.clear();
    saveState();
    if (mode === 'query') {
      showResult();
    } else {
      showCurrent();
    }
    updateChrome();
  }

  /** Reads the schema again and redraws whatever is on screen. */
  async function refresh() {
    if (editor) {
      stale = true;
      return;
    }
    try {
      schema = await request('schema');
    } catch (e) {
      schema = null;
      data = null;
      $('grid').replaceChildren();
      renderSidebar();
      showMessage(/** @type {Error} */ (e).message);
      return;
    }
    const tables = /** @type {any[]} */ (schema?.tables);
    for (const name of [...pending.keys()]) {
      if (!tables.some((t) => t.name === name)) {
        pending.delete(name);
      }
    }
    trail = trail.filter((step) => tables.some((t) => t.name === step.table));
    if (!tables.some((t) => t.name === current)) {
      current = tables[0]?.name || '';
      data = null;
      offset = 0;
      sort = null;
      match = null;
    }
    renderSidebar();
    void loadCounts();
    if (mode === 'query') {
      return;
    }
    if (!current) {
      $('grid').replaceChildren();
      showMessage('The database has no tables.');
    } else if (mode === 'structure') {
      showStructure();
    } else {
      if (!data) {
        showMessage('Loading…');
      }
      await loadRows();
    }
  }

  // ---- Cell editor --------------------------------------------------------

  function editText(/** @type {any} */ value) {
    if (value === null || value === undefined) {
      return '';
    }
    return typeof value === 'object' ? value.int ?? value.num ?? '' : String(value);
  }

  async function startEdit(/** @type {number} */ r, /** @type {number} */ c, /** @type {string} */ typed = '') {
    const row = view[r];
    if (!editor && !typed && row && columns[c] && isBlob(cellValue(row, c).value)) {
      // A blob can't be typed; opening it shows the picture, if it is one, at full size.
      enlarge();
      return;
    }
    if (editor || !canChange(r, c)) {
      return;
    }
    let { value } = cellValue(row, c);
    if (isBlob(value)) {
      return;
    }
    if (value && typeof value === 'object' && 'more' in value) {
      // The grid holds only the beginning of a long text.
      try {
        value = await request('cell', current, row.key, columns[c].name);
      } catch (e) {
        showNote(/** @type {Error} */ (e).message);
        return;
      }
      if (editor || view[r] !== row || typeof value !== 'string') {
        return;
      }
    }
    const td = cellAt(r, c);
    if (!td) {
      return;
    }
    setActive(r, c, false);
    const original = editText(value);
    const rect = td.getBoundingClientRect();
    td.style.minWidth = `${rect.width}px`;
    td.style.height = `${rect.height}px`;
    td.textContent = '';
    td.classList.add('editing');
    const input = document.createElement('textarea');
    input.spellcheck = false;
    input.rows = 1;
    input.value = typed || original;
    td.append(input);
    editor = { row: r, col: c, input, original };

    const fit = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight + 2, 240)}px`;
    };
    input.addEventListener('input', fit);
    input.addEventListener('blur', () => closeEditor(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeEditor(false);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        closeEditor(true);
        setActive(Math.min(r + 1, view.length - 1), c);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeEditor(true);
        setActive(r, Math.max(0, Math.min(columns.length - 1, c + (e.shiftKey ? -1 : 1))));
      }
    });
    fit();
    input.focus();
    if (typed) {
      input.setSelectionRange(typed.length, typed.length);
    } else {
      input.select();
    }
  }

  function closeEditor(/** @type {boolean} */ commit) {
    if (!editor) {
      return;
    }
    const { row: r, col: c, input, original } = editor;
    // Cleared first: removing the input fires its blur handler.
    editor = null;
    const text = input.value.replace(/\r\n?/g, '\n');
    if (commit && text !== original && view[r]) {
      setCell(view[r], c, parseInput(text, columns[c]));
    }
    const td = cellAt(r, c);
    if (td) {
      paintCell(td, r, c);
    }
    showRefs();
    $('gridWrap').focus({ preventScroll: true });
    if (stale) {
      stale = false;
      void refresh();
    }
  }

  // ---- Row actions --------------------------------------------------------

  function addRow() {
    if (!data?.table.key || saving) {
      return;
    }
    closeEditor(true);
    changesOf(current).inserts.push({ values: new Map() });
    marked.clear();
    showData();
    updatePending();
    const first = columns.findIndex((column) => !column.generated);
    setActive(view.length - 1, Math.max(0, first));
  }

  function deleteRows() {
    if (!data?.table.key || saving) {
      return;
    }
    closeEditor(false);
    const targets = marked.size ? [...marked] : active ? [active.row] : [];
    const changes = changesOf(current);
    // A second press on rows that are all marked for deletion restores them.
    const restore = targets.every((r) => view[r].insert || isDeleted(view[r])) && targets.some((r) => !view[r].insert);
    for (const r of targets) {
      const row = view[r];
      if (row.insert) {
        changes.inserts.splice(changes.inserts.indexOf(row.insert), 1);
      } else if (restore) {
        changes.deletes.delete(/** @type {string} */ (row.id));
      } else {
        changes.deletes.set(/** @type {string} */ (row.id), /** @type {any[]} */ (row.key));
        changes.updates.delete(/** @type {string} */ (row.id));
      }
    }
    prune();
    marked.clear();
    active = null;
    showData();
    updatePending();
  }

  function setNull() {
    if (active && canChange(active.row, active.col)) {
      closeEditor(false);
      setCell(view[active.row], active.col, null);
      const td = cellAt(active.row, active.col);
      if (td) {
        paintCell(td, active.row, active.col);
      }
      inspect();
      showRefs();
    }
  }

  async function save() {
    closeEditor(true);
    if (saving || !pendingCount()) {
      return;
    }
    const changes = [];
    for (const [table, p] of pending) {
      for (const key of p.deletes.values()) {
        changes.push({ table, kind: 'delete', key });
      }
      for (const update of p.updates.values()) {
        changes.push({ table, kind: 'update', key: update.key, values: [...update.values] });
      }
      for (const insert of p.inserts) {
        changes.push({ table, kind: 'insert', values: [...insert.values].filter(([, value]) => value !== undefined) });
      }
    }
    saving = true;
    updatePending();
    updateChrome();
    $('status').textContent = 'Saving…';
    try {
      await request('save', changes);
      pending.clear();
      showNote('');
      $('status').textContent = 'Saved';
    } catch (e) {
      $('status').textContent = '';
      showNote(`The changes could not be saved, and nothing was written: ${/** @type {Error} */ (e).message}`);
    }
    saving = false;
    updatePending();
    await refresh();
  }

  function revert() {
    closeEditor(false);
    pending.clear();
    showNote('');
    updatePending();
    if (mode === 'data') {
      showData();
    }
  }

  // ---- Foreign keys -------------------------------------------------------

  const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform);
  const modifier = mac ? 'Cmd' : 'Ctrl';
  /** The modifier of a click that follows a key. On a Mac, Ctrl with a click is the right button. */
  const withCommand = (/** @type {MouseEvent} */ e) => (mac ? e.metaKey : e.ctrlKey);

  /** Columns of a table in words: "orders.customer_id" or "prices (product, region)". */
  const side = (/** @type {string} */ table, /** @type {string[]} */ names) => (names.length === 1 ? `${table}.${names[0]}` : `${table} (${names.join(', ')})`);

  /** What a key refers to, or why it refers to nothing. */
  function keyTarget(/** @type {any} */ key) {
    return key.broken ? `${key.table} (${key.broken})` : side(key.table, key.to);
  }

  /** The keys, of other tables and of the table itself, that refer to a table. */
  function inboundKeys(/** @type {string} */ name) {
    /** @type {{from: string, key: any}[]} */
    const found = [];
    for (const table of schema?.tables ?? []) {
      for (const key of table.foreignKeys) {
        if (key.table === name && !key.broken) {
          found.push({ from: table.name, key });
        }
      }
    }
    return found;
  }

  /** The followed key as the requests take it. */
  function matchOf() {
    return match && { columns: match.columns, values: match.values };
  }

  /**
   * A cell value as one side of a key: `value` when it can be looked up as it is, `long` when the
   * grid holds only its beginning, and `why` when no row is found by it.
   */
  function keyPart(/** @type {any} */ value) {
    if (value === undefined) {
      return { why: 'has no value yet' };
    }
    if (value === null) {
      return { why: 'is NULL' };
    }
    if (typeof value === 'object' && 'blob' in value) {
      return value.hex.length === value.blob * 2 ? { value: { hex: value.hex } } : { why: 'is a blob too long to look up' };
    }
    if (typeof value === 'object' && 'more' in value) {
      return { long: true };
    }
    return { value };
  }

  /**
   * Where a cell leads: along the keys its column is part of, and back along the keys that refer to its row.
   * `columns` are those of the table it leads to, `from` the ones of this table that hold the values.
   * @returns {{out: boolean, table: string, columns: string[], from: string[], parts: any[], text: string, why: string}[]}
   */
  function referencesOf(/** @type {number} */ r, /** @type {number} */ c) {
    const table = schema?.tables.find((t) => t.name === current);
    const row = view[r];
    if (mode !== 'data' || !table || !row || !columns[c] || data?.table.name !== current) {
      return [];
    }
    const link = (/** @type {boolean} */ out, /** @type {string} */ target, /** @type {string[]} */ there, /** @type {string[]} */ from) => {
      const values = from.map((name) => {
        const i = columns.findIndex((column) => column.name === name);
        return i < 0 ? undefined : cellValue(row, i).value;
      });
      const parts = values.map(keyPart);
      const bad = parts.findIndex((part) => part.why);
      const brief = (/** @type {any} */ value) => {
        const { text } = display(value);
        return text.length > 40 ? `${text.slice(0, 40)}…` : text;
      };
      const text = there.map((name, i) => `${name} = ${brief(values[i])}`).join(' and ');
      return { out, table: target, columns: there, from, parts, text, why: bad < 0 ? '' : `${from[bad]} ${parts[bad].why}` };
    };
    const links = [];
    for (const key of table.foreignKeys) {
      if (key.columns.includes(columns[c].name)) {
        links.push(key.broken ? { out: true, table: key.table, columns: [], from: key.columns, parts: [], text: '', why: key.broken } : link(true, key.table, key.to, key.columns));
      }
    }
    // A row that isn't in the database yet has nothing referring to it.
    for (const { from, key } of row.insert ? [] : inboundKeys(table.name)) {
      links.push(link(false, from, key.columns, key.to));
    }
    return links;
  }

  let refsId = '';

  /** Keeps the bar under the grid in step with the selected cell: it is there while that cell leads somewhere. */
  function showRefs() {
    const links = active ? referencesOf(active.row, active.col) : [];
    const id = links.length ? JSON.stringify([current, active, links.map((link) => [link.table, link.columns, link.text, link.why])]) : '';
    if (id === refsId) {
      return;
    }
    refsId = id;
    $('refs').hidden = !links.length;
    const nodes = [];
    for (const [title, out] of /** @type {[string, boolean][]} */ ([['Refers to', true], ['Referred to by', false]])) {
      const list = links.filter((link) => link.out === out);
      if (list.length) {
        nodes.push(el('span', 'label', title));
      }
      for (const link of list) {
        const name = out ? link.table : side(link.table, link.columns);
        if (link.why) {
          nodes.push(el('span', 'dim', `${name}: ${link.why}`));
          continue;
        }
        const node = button(out ? `${link.table} where ${link.text}` : name, '', () => void follow(link));
        node.title = out
          ? `Open the row of ${link.table} this value refers to (${modifier}+click on the cell, or ${modifier}+Enter)`
          : `Show the rows of ${link.table} with ${link.text}`;
        nodes.push(node);
      }
    }
    nodes.push(el('span', 'note'));
    $('refs').replaceChildren(...nodes);
  }

  function refsNote(/** @type {string} */ text) {
    const note = $('refs').querySelector('.note');
    if (note) {
      note.textContent = text;
    }
  }

  /**
   * Opens the rows a key leads to, in the table they are in. A key that leads to no row says so
   * where it is and nothing moves, so there is never an empty page to come back from.
   */
  async function follow(/** @type {ReturnType<typeof referencesOf>[number]} */ link) {
    const row = active ? view[active.row] : undefined;
    if (!row || link.why) {
      return;
    }
    closeEditor(true);
    const token = ++followToken;
    const from = current;
    let values;
    let reply;
    try {
      values = await Promise.all(link.parts.map((part, i) => (part.long ? request('cell', from, row.key, link.from[i]) : part.value)));
      reply = await request('rows', link.table, { offset: 0, limit, sort: null, filter: '', match: { columns: link.columns, values } });
    } catch (e) {
      if (token === followToken) {
        refsNote(/** @type {Error} */ (e).message);
      }
      return;
    }
    if (token !== followToken || mode !== 'data' || current !== from) {
      return;
    }
    if (!reply.total) {
      refsNote(`No row of ${link.table} has ${link.text}${link.out ? ': the reference leads nowhere.' : '.'}`);
      return;
    }
    trail.push({ table: current, offset, sort, filter, match, row: active?.row ?? -1, col: active?.col ?? -1, scroll: [$('gridWrap').scrollLeft, $('gridWrap').scrollTop] });
    if (trail.length > 50) {
      trail.shift();
    }
    // Rows of the table that was left may still be on their way.
    rowsToken++;
    restore = null;
    current = link.table;
    offset = 0;
    sort = null;
    filter = '';
    $('filter').value = '';
    match = { columns: link.columns, values, text: link.text };
    data = reply;
    active = null;
    marked.clear();
    saveState();
    showData();
    $('gridWrap').scrollTo(0, 0);
    setActive(0, Math.max(0, columns.findIndex((column) => column.name === link.columns[0])));
  }

  /** Puts back the view the last key was followed from, with its page, sort, filter and selected cell. */
  function back() {
    const step = mode === 'data' ? trail.pop() : undefined;
    if (!step) {
      return;
    }
    closeEditor(true);
    followToken++;
    current = step.table;
    offset = step.offset;
    sort = step.sort;
    filter = step.filter;
    $('filter').value = filter;
    match = step.match;
    data = null;
    active = null;
    marked.clear();
    restore = step;
    saveState();
    updateChrome();
    showCurrent();
  }

  /** Drops the narrowing to the rows of a key; the way back stays. */
  function showAll() {
    closeEditor(true);
    match = null;
    offset = 0;
    active = null;
    marked.clear();
    saveState();
    updateChrome();
    void loadRows();
  }

  // ---- SQL prompt ---------------------------------------------------------

  const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

  function showResult() {
    columns = (result?.columns ?? []).map((/** @type {string} */ name) => ({ name, type: '' }));
    view = (result?.rows ?? []).map((/** @type {any[]} */ cells) => ({ cells }));
    renderGrid();
    showMessage(result ? (columns.length && !view.length ? 'No rows.' : '') : 'Run a statement to see its result here.');
  }

  /** What a statement did, in a few words. */
  function outcomeText(/** @type {any} */ outcome) {
    const parts = [];
    if (outcome.rows !== null) {
      parts.push(`${plural(outcome.rows, 'row')}${outcome.truncated ? ' (more were left out)' : ''}`);
    }
    if (outcome.changes !== null) {
      parts.push(`${plural(outcome.changes, 'row')} changed`);
    }
    return parts.join(', ') || 'Done';
  }

  /** Says how the run of `sql` went: in one line for a single statement, and with the list of statements for a script. */
  function showOutcome(/** @type {string} */ sql) {
    const { statements, error, shown, wrote, rolledBack, ms } = result;
    const count = statements.length + (error ? 1 : 0);
    // A statement that could not be read has no end, so whether more follow is only known by the look of the text.
    const script = count > 1 || /;\s*\S/.test(sql);
    // There is no transaction around a script, so what stays of a script that stopped depends on the script.
    let undone = '';
    if (rolledBack >= 0) {
      undone = ` The transaction ${script ? `begun in statement ${rolledBack + 1}` : 'it began'} was ${error ? '' : 'not committed, so it was '}rolled back`;
      undone += !wrote || !script ? '.' : rolledBack ? `; what the ${rolledBack === 1 ? 'statement' : 'statements'} before it changed stays.` : ', and nothing was changed.';
    }
    let text;
    if (error) {
      const before = error.index;
      text = script ? `Statement ${before + 1} failed: ${error.message}.` : error.message;
      if (script) {
        text += !wrote
          ? ' Nothing was changed.'
          : undone || (before ? ` What the ${before === 1 ? 'statement' : `${before} statements`} before it changed stays (put BEGIN and COMMIT around a script to get all of it or nothing).` : '');
        text += ' Nothing after it was run.';
      }
    } else if (!count) {
      text = 'There is no statement to run.';
    } else {
      text = `${count === 1 ? outcomeText(statements[0]) : plural(count, 'statement')} in ${ms} ms${undone && '.'}${undone}`;
    }
    $('queryStatus').textContent = text;
    $('queryStatus').className = error ? 'error' : undone ? 'warning' : '';

    const line = (/** @type {string} */ sql, /** @type {string} */ outcome, /** @type {string} */ time, /** @type {string} */ className) => {
      const item = el('li', className);
      item.append(el('span', 'sql', sql.replace(/\s+/g, ' ')), el('span', 'outcome', outcome), el('span', 'ms', time));
      item.title = sql;
      return item;
    };
    const lines = statements.map((/** @type {any} */ outcome, /** @type {number} */ i) =>
      line(outcome.sql, outcomeText(outcome) + (i === shown && statements.some((/** @type {any} */ o, /** @type {number} */ j) => j !== i && o.rows !== null) ? ', shown below' : ''), `${outcome.ms} ms`, ''),
    );
    if (error) {
      lines.push(line(error.sql, error.message, '', 'error'));
    }
    $('queryLog').replaceChildren(...lines);
    $('queryLog').hidden = count < 2;
    $('queryLog').scrollTop = $('queryLog').scrollHeight;
  }

  async function runQuery() {
    closeComplete();
    const sql = $('sql').value.trim();
    if (!sql || $('run').disabled) {
      return;
    }
    $('run').disabled = true;
    $('queryStatus').textContent = 'Running…';
    $('queryStatus').className = '';
    $('queryLog').hidden = true;
    let failed = false;
    try {
      result = await request('query', sql);
      failed = !!result.error;
      showOutcome(sql);
      if (result.wrote) {
        // The script wrote, so tables, counts and the open page may all be different now.
        data = null;
        void refresh();
      }
    } catch (e) {
      // Not a statement that failed, but the run itself: the file is gone, or the worker.
      result = null;
      failed = true;
      $('queryStatus').textContent = /** @type {Error} */ (e).message;
      $('queryStatus').className = 'error';
    }
    $('run').disabled = false;
    // Comments alone are nothing to come back to.
    if (!result || result.statements.length || result.error) {
      void remember(sql, failed);
    }
    if (mode === 'query') {
      showResult();
      if (!result) {
        showMessage('');
      }
    }
  }

  // ---- History ------------------------------------------------------------

  /** What ran on this database before, newest first. A script is one entry. @type {{sql: string, at: number, failed?: boolean}[]} */
  let history = [];
  /** The entry in the prompt while stepping through them, or -1 for the text that was being written. */
  let historyAt = -1;
  let draft = '';
  /** Whether the prompt was changed by hand since an entry was put into it. */
  let edited = false;
  /** Set while the page itself changes the prompt, which is not typing. */
  let programmatic = false;

  async function remember(/** @type {string} */ sql, /** @type {boolean} */ failed) {
    try {
      history = await request('remember', sql, failed);
    } catch {
      // A history that can't be written is no reason to trouble the user.
    }
    historyAt = -1;
    edited = false;
  }

  /** Replaces a part of the prompt the way typing would, so that undo takes it back. */
  function replaceText(/** @type {number} */ start, /** @type {number} */ end, /** @type {string} */ text) {
    const input = $('sql');
    programmatic = true;
    input.focus();
    input.setSelectionRange(start, end);
    if (!(text ? document.execCommand('insertText', false, text) : start === end || document.execCommand('delete'))) {
      input.setRangeText(text, start, end, 'end');
    }
    programmatic = false;
    saveState();
  }

  /**
   * Puts an entry into the prompt. The text it replaces is kept, at the newest end, if it was written by hand.
   * Stepping past either end changes nothing; `again` is a pick from the list, which also brings back an entry that was edited.
   */
  function recall(/** @type {number} */ index, again = false) {
    const next = Math.max(-1, Math.min(history.length - 1, index));
    if (next === historyAt && !(again && edited)) {
      $('sql').focus();
      return;
    }
    if (historyAt < 0 || edited) {
      draft = $('sql').value;
    }
    historyAt = next;
    edited = false;
    replaceText(0, $('sql').value.length, next < 0 ? draft : history[next].sql);
  }

  function when(/** @type {number} */ at) {
    const date = new Date(at);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function closeHistory() {
    $('historyMenu').hidden = true;
  }

  function openHistory() {
    const nodes = history.map((item, i) => {
      const node = button('', item.failed ? 'failed' : '', () => {
        closeHistory();
        recall(i, true);
      });
      node.append(el('span', 'sql', item.sql.slice(0, 300).replace(/\s+/g, ' ')), el('span', 'when', `${item.failed ? 'failed · ' : ''}${when(item.at)}`));
      node.title = item.sql.length > 2000 ? `${item.sql.slice(0, 2000)}…` : item.sql;
      return node;
    });
    nodes.push(history.length ? button('Clear history…', 'clear', () => void clearHistory()) : el('p', 'hint', 'Nothing has been run on this database yet.'));
    $('historyMenu').replaceChildren(...nodes);
    $('historyMenu').hidden = false;
    $('historyMenu').scrollTop = 0;
    $('historyMenu').querySelector('button')?.focus();
  }

  async function clearHistory() {
    closeHistory();
    if (!(await ask('Clear history', `Forget the ${plural(history.length, 'statement')} remembered for this database?`, 'Clear'))) {
      return;
    }
    try {
      history = await request('clearHistory');
      historyAt = -1;
    } catch (e) {
      showNote(`The history could not be cleared: ${/** @type {Error} */ (e).message}`);
    }
  }

  // ---- Completion ---------------------------------------------------------

  const KEYWORDS = (
    'ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BLOB BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT ' +
    'CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT ' +
    'EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD ' +
    'INTEGER INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS NUMERIC OF OFFSET ON OR ORDER OUTER OVER ' +
    'PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE REAL RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWID ROWS ' +
    'SAVEPOINT SELECT SET STRICT TABLE TEMP TEMPORARY TEXT THEN TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT'
  ).split(' ');
  const FUNCTIONS = (
    'abs avg changes char coalesce concat concat_ws count cume_dist date datetime dense_rank first_value format glob group_concat hex ifnull iif instr json json_array ' +
    'json_array_length json_each json_extract json_group_array json_group_object json_insert json_object json_patch json_remove json_replace json_set json_tree json_type ' +
    'json_valid julianday lag last_insert_rowid last_value lead length like likelihood likely lower ltrim max min nth_value ntile nullif octet_length percent_rank printf quote ' +
    'random randomblob rank replace round row_number rtrim sign sqlite_version strftime string_agg substr substring sum time timediff total total_changes trim typeof unhex ' +
    'unicode unixepoch unlikely upper zeroblob'
  ).split(' ');
  /** The words SQLite takes for nothing but themselves, so a table or column of that name has to be quoted. */
  const RESERVED = new Set(
    (
      'ADD ALL ALTER AND AS AUTOINCREMENT BETWEEN CASE CAST CHECK COLLATE COMMIT CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DEFAULT DEFERRABLE DELETE ' +
      'DISTINCT DROP ELSE ESCAPE EXCEPT EXISTS FILTER FOREIGN FROM FULL GROUP HAVING IF IN INDEX INDEXED INNER INSERT INTERSECT INTO IS ISNULL JOIN LEFT LIMIT NATURAL NOT NOTHING ' +
      'NOTNULL NULL ON OR ORDER OUTER OVER PRIMARY RAISE REFERENCES RETURNING RIGHT SELECT SET TABLE THEN TO TRANSACTION UNION UNIQUE UPDATE USING VALUES WHEN WHERE WINDOW'
    ).split(' '),
  );
  const KEYWORD_SET = new Set(KEYWORDS);
  /** The words after which a table is named. */
  const TABLE_WORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'REFERENCES']);
  const WORD_START = /[A-Za-z_\u0080-￿]/;
  const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

  /** A name as a statement has to write it. */
  function sqlName(/** @type {string} */ name, quoted = false) {
    return !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toUpperCase()) ? name : `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Cuts SQL into words, quoted names, strings, numbers, comments and single characters. It only has
   * to tell the completion where it is, so it is far from a parser; statements are split by SQLite.
   * `open` marks a token that the end of the text cut short, or that goes on to the end of its line.
   * @returns {{type: 'word' | 'name' | 'string' | 'number' | 'comment' | 'other', value: string, start: number, end: number, open: boolean}[]}
   */
  function scanSql(/** @type {string} */ text) {
    const tokens = [];
    const length = text.length;
    let i = 0;
    while (i < length) {
      const ch = text[i];
      let end = i + 1;
      /** @type {'word' | 'name' | 'string' | 'number' | 'comment' | 'other'} */
      let type = 'other';
      let value = ch;
      let open = false;
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === '-' && text[i + 1] === '-') {
        const stop = text.indexOf('\n', i);
        end = stop < 0 ? length : stop;
        type = 'comment';
        open = true;
      } else if (ch === '/' && text[i + 1] === '*') {
        const stop = text.indexOf('*/', i + 2);
        end = stop < 0 ? length : stop + 2;
        type = 'comment';
        open = stop < 0;
      } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
        const close = ch === '[' ? ']' : ch;
        type = ch === "'" ? 'string' : 'name';
        value = '';
        for (let from = i + 1; ; ) {
          const stop = text.indexOf(close, from);
          if (stop < 0) {
            value += text.slice(from);
            end = length;
            open = true;
            break;
          }
          value += text.slice(from, stop);
          end = stop + 1;
          // A quote written twice stands for itself.
          if (close === ']' || text[end] !== close) {
            break;
          }
          value += close;
          from = end + 1;
        }
      } else if (WORD_START.test(ch) || /[0-9]/.test(ch)) {
        while (end < length && (WORD_CHAR.test(text[end]) || (text[end] === '.' && /[0-9]/.test(ch)))) {
          end++;
        }
        type = /[0-9]/.test(ch) ? 'number' : 'word';
        value = text.slice(i, end);
      }
      tokens.push({ type, value, start: i, end, open });
      i = end;
    }
    return tokens;
  }

  /**
   * What could be written at `caret`: the names that begin with the word there, and the part of the
   * text one of them replaces. Null when there is nothing to offer. `forced` is a list asked for,
   * which also comes up where nothing has been typed yet.
   * @returns {{start: number, end: number, items: {label: string, insert: string, kind: string}[]} | null}
   */
  function completionsAt(/** @type {string} */ text, /** @type {number} */ caret, /** @type {boolean} */ forced) {
    const tables = schema?.tables ?? [];
    let before = scanSql(text.slice(0, caret));
    const last = before[before.length - 1];
    // The token the caret is in, or at the end of.
    const typing = last && last.end === caret && (last.open || last.type === 'word' || last.type === 'number') ? last : null;
    if (typing && typing.type !== 'word' && typing.type !== 'name') {
      return null;
    }
    const start = typing ? typing.start : caret;
    let end = caret;
    const quoted = typing?.type === 'name';
    const prefix = typing ? (quoted ? text.slice(start + 1, caret) : typing.value) : '';
    if (typing) {
      before.pop();
    }
    if (quoted) {
      // A name that is being put into quotes takes the next quote on its line, which opens another name, for its end.
      // An odd number of quotes ahead says that one of them closes this name, and then the name is replaced as a whole.
      const close = text[start] === '[' ? ']' : text[start];
      const line = text.indexOf('\n', caret);
      const ahead = text.slice(caret, line < 0 ? text.length : line);
      if (close === ']' ? ahead.includes(close) && !/\[[^\]]*$/.test(ahead.slice(0, ahead.indexOf(close))) : ahead.split(close).length % 2 === 0) {
        end = caret + ahead.indexOf(close) + 1;
      }
    }

    // "orders." or "o." in front of the word asks for the columns of that table.
    let qualifier = null;
    const dot = before[before.length - 1];
    const owner = before[before.length - 2];
    if (dot?.value === '.' && dot.type === 'other' && dot.end === start) {
      if (!owner || owner.end !== dot.start || (owner.type !== 'word' && owner.type !== 'name')) {
        return null;
      }
      qualifier = owner.value;
      before = before.slice(0, -2);
    }

    // The statement around the caret, as far as semicolons tell. Inside a trigger that is one of its statements.
    const after = scanSql(text.slice(end));
    const isEnd = (/** @type {any} */ token) => token.type === 'other' && token.value === ';';
    const from = before.map(isEnd).lastIndexOf(true) + 1;
    const to = after.findIndex(isEnd);
    const ahead = before.slice(from);
    const statement = [...ahead, { type: 'other', value: '', start: 0, end: 0, open: false }, ...after.slice(0, to < 0 ? after.length : to)];

    // The tables the statement names, and the short names it gives them.
    /** @type {Set<any>} */
    const inPlay = new Set();
    /** @type {Map<string, any>} */
    const aliases = new Map();
    const find = (/** @type {string} */ name) => tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    statement.forEach((token, i) => {
      const table = (token.type === 'word' || token.type === 'name') && statement[i - 1]?.value !== '.' ? find(token.value) : undefined;
      if (!table) {
        return;
      }
      inPlay.add(table);
      let next = statement[i + 1];
      if (next?.type === 'word' && next.value.toUpperCase() === 'AS') {
        next = statement[i + 2];
      }
      if (next && (next.type === 'name' || (next.type === 'word' && !KEYWORD_SET.has(next.value.toUpperCase())))) {
        aliases.set(next.value.toLowerCase(), table);
      }
    });

    const lower = prefix.toLowerCase();
    const fits = (/** @type {string} */ name) => name.toLowerCase().startsWith(lower);
    /** @type {{label: string, insert: string, kind: string}[]} */
    const items = [];
    const addColumns = (/** @type {any[]} */ list) => {
      /** @type {Map<string, string[]>} */
      const owners = new Map();
      for (const table of list) {
        for (const column of table.columns) {
          if (fits(column.name)) {
            owners.set(column.name, [...(owners.get(column.name) ?? []), table.name]);
          }
        }
      }
      for (const [name, of] of owners) {
        items.push({ label: name, insert: sqlName(name, quoted), kind: of.length > 3 ? `${of.slice(0, 3).join(', ')}, …` : of.join(', ') });
      }
    };
    const addTables = () => {
      for (const table of tables.filter((t) => fits(t.name))) {
        items.push({ label: table.name, insert: sqlName(table.name, quoted), kind: table.type === 'view' ? 'view' : 'table' });
      }
    };
    const addWords = (/** @type {boolean} */ functions) => {
      if (quoted) {
        return;
      }
      // Keywords come in the case the word was begun in.
      const small = /[a-z]/.test(prefix) && !/[A-Z]/.test(prefix);
      for (const word of KEYWORDS.filter(fits)) {
        const shown = small ? word.toLowerCase() : word;
        items.push({ label: shown, insert: shown, kind: 'keyword' });
      }
      for (const name of functions ? FUNCTIONS.filter(fits) : []) {
        items.push({ label: `${name}()`, insert: `${name}(`, kind: 'function' });
      }
    };

    const previous = ahead[ahead.length - 1];
    const word = previous?.type === 'word' ? previous.value.toUpperCase() : '';
    if (qualifier !== null) {
      const table = aliases.get(qualifier.toLowerCase()) ?? find(qualifier);
      if (!table) {
        return null;
      }
      addColumns([table]);
    } else if (!forced && (!prefix || word === 'AS')) {
      // Unasked, a list comes up only for a word that has been begun, and not where a new name is being made up.
      return null;
    } else if (!previous) {
      addWords(false);
    } else if (TABLE_WORDS.has(word)) {
      addTables();
      if (!items.length) {
        // "INSERT INTO" after "INSERT", "IF EXISTS" after "TABLE": a keyword only where no table fits.
        addWords(false);
      }
    } else {
      addColumns([...inPlay]);
      addTables();
      addWords(true);
      if (!inPlay.size) {
        // Before the statement names a table, any column may be meant.
        addColumns(tables);
      }
    }
    const typed = text.slice(start, caret);
    return items.length && !items.every((item) => item.insert === typed) ? { start, end, items: items.slice(0, 200) } : null;
  }

  const COMPLETE_MAX = 200000;

  /** The list that is open. `forced` and `moved` are what make Enter take the selected name. @type {{start: number, end: number, items: {label: string, insert: string, kind: string}[], index: number, forced: boolean, moved: boolean} | null} */
  let completion = null;

  /** Where a character of the prompt is in the window, found by laying the text before it out in a copy of the prompt. */
  function caretPoint(/** @type {number} */ index) {
    const input = $('sql');
    const style = getComputedStyle(input);
    const copy = el('div', 'mirror');
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      copy.style[/** @type {any} */ (name)] = style[/** @type {any} */ (name)];
    }
    // The width inside the scrollbar, which is where the lines wrap.
    copy.style.width = `${input.clientWidth}px`;
    copy.textContent = input.value.slice(0, index);
    const mark = el('span', '', '​');
    copy.append(mark);
    document.body.append(copy);
    const box = input.getBoundingClientRect();
    const point = {
      left: box.left + input.clientLeft + mark.offsetLeft - input.scrollLeft,
      top: box.top + input.clientTop + mark.offsetTop - input.scrollTop,
      height: mark.offsetHeight,
    };
    copy.remove();
    return point;
  }

  function placeComplete() {
    if (!completion) {
      return;
    }
    const list = $('complete');
    const point = caretPoint(completion.start);
    const below = point.top + point.height;
    // Under the word, or above it when the window ends too soon.
    const top = below + list.offsetHeight > window.innerHeight && point.top - list.offsetHeight >= 0 ? point.top - list.offsetHeight : below;
    list.style.left = `${Math.max(0, Math.min(point.left, window.innerWidth - list.offsetWidth - 4))}px`;
    list.style.top = `${top}px`;
  }

  function selectComplete(/** @type {number} */ index) {
    if (!completion) {
      return;
    }
    const list = $('complete');
    list.children[completion.index]?.classList.remove('selected');
    completion.index = (index + completion.items.length) % completion.items.length;
    const item = /** @type {HTMLElement} */ (list.children[completion.index]);
    item.classList.add('selected');
    // Scrolled by hand: scrollIntoView() would move the page as well.
    if (item.offsetTop < list.scrollTop) {
      list.scrollTop = item.offsetTop;
    } else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
  }

  function closeComplete() {
    completion = null;
    $('complete').hidden = true;
  }

  /** Brings the list up for the place the caret is at, or takes it away when there is nothing to offer there. */
  function openComplete(/** @type {boolean} */ forced) {
    const input = $('sql');
    // The text is read through on every key, which a pasted dump is too long for.
    const found = input.selectionStart === input.selectionEnd && input.value.length <= COMPLETE_MAX ? completionsAt(input.value, input.selectionStart, forced) : null;
    if (!found) {
      closeComplete();
      return;
    }
    completion = { ...found, index: 0, forced, moved: false };
    $('complete').replaceChildren(
      ...found.items.map((item, i) => {
        const node = el('div', 'item');
        node.setAttribute('role', 'option');
        node.append(el('span', 'name', item.label), el('span', 'kind', item.kind));
        node.addEventListener('mousedown', (e) => {
          // The prompt keeps the focus.
          e.preventDefault();
          acceptComplete(i);
        });
        return node;
      }),
    );
    $('complete').hidden = false;
    $('complete').scrollTop = 0;
    selectComplete(0);
    placeComplete();
  }

  function acceptComplete(/** @type {number} */ index) {
    if (!completion) {
      return;
    }
    const { start, end, items } = completion;
    closeComplete();
    replaceText(start, end, items[index].insert);
    edited = true;
  }

  // ---- Blobs --------------------------------------------------------------

  /** The blob in the inspector. @type {{id: string, source: any, name: string, title: string, url: string} | null} */
  let shown = null;
  let inspectTimer = 0;
  /** Set when a picture was asked for at full size before it had arrived. */
  let wanted = false;

  function toBytes(/** @type {any} */ data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    // Older hosts serialize buffers to JSON instead of transferring them.
    return new Uint8Array(Array.isArray(data?.data) ? data.data : Object.values(data ?? {}));
  }

  function hexDump(/** @type {Uint8Array} */ bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const part = [...bytes.subarray(i, i + 16)];
      const hex = part.map((b) => b.toString(16).padStart(2, '0'));
      const text = part.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ').padEnd(23)}  ${hex.slice(8).join(' ').padEnd(23)}  ${text}`);
    }
    return lines.join('\n');
  }

  /** How the server finds the blob of a cell again. */
  function blobSource(/** @type {number} */ r, /** @type {number} */ c) {
    if (mode === 'query') {
      // Without a source the result can't be read again, and the request says why.
      return { sql: '', index: 0, ...result?.source, row: r, column: c };
    }
    const row = view[r];
    // A view has no row keys; there the row is found by its place in the sorted and filtered table.
    return row.key
      ? { table: current, key: row.key, column: columns[c].name }
      : { table: current, sort, filter, match: matchOf(), offset: offset + r, column: columns[c].name };
  }

  /** Keeps the inspector under the grid in step with the selected cell: it is there while that cell holds a blob. */
  function inspect() {
    const row = active ? view[active.row] : undefined;
    const value = active && row && columns[active.col] && mode !== 'structure' ? cellValue(row, active.col).value : null;
    const source = active && isBlob(value) ? blobSource(active.row, active.col) : null;
    const id = source ? JSON.stringify([source, value]) : '';
    if (id === (shown?.id ?? '')) {
      return;
    }
    clearTimeout(inspectTimer);
    if (shown?.url) {
      URL.revokeObjectURL(shown.url);
    }
    wanted = false;
    $('inspector').hidden = !source;
    if (!source || !active) {
      shown = null;
      return;
    }
    const kind = blobKind(value.hex);
    const size = `${formatSize(value.blob)}${value.blob >= 1024 ? ` (${value.blob.toLocaleString('en-US')} bytes)` : ''}`;
    const title = kind?.mime ? `${kind.name} image` : kind ? `BLOB (${kind.name})` : 'BLOB';
    const blob = (shown = { id, source, name: `${mode === 'query' ? 'blob' : `${current}-${columns[active.col].name}`}.${kind?.ext ?? 'bin'}`, title, url: '' });
    $('blobInfo').textContent = `${title} · ${size}`;
    $('blobView').replaceChildren(el('span', 'hint', 'Loading…'));

    const showHex = (/** @type {Uint8Array} */ bytes, /** @type {string} */ note) => {
      const rest = value.blob - bytes.length;
      const nodes = [el('pre', '', hexDump(bytes) + (rest > 0 ? `\n… ${rest.toLocaleString('en-US')} more bytes` : ''))];
      if (note) {
        nodes.unshift(el('p', 'hint', note));
      }
      $('blobView').replaceChildren(...nodes);
    };
    // Moving through a column of blobs with the arrow keys shouldn't fetch every one of them.
    inspectTimer = setTimeout(async () => {
      let reply;
      try {
        reply = await request('blob', source, !!kind?.mime);
      } catch (e) {
        if (shown === blob) {
          $('blobView').replaceChildren(el('span', 'hint', /** @type {Error} */ (e).message));
        }
        return;
      }
      if (shown !== blob) {
        return;
      }
      const bytes = toBytes(reply.bytes);
      if (!kind?.mime || !reply.complete) {
        showHex(bytes, kind?.mime ? 'Pictures over 16 MB are not shown here. Save the blob to a file to see it.' : '');
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.title = 'Click to see it at full size';
      img.addEventListener('load', () => {
        if (shown !== blob) {
          return;
        }
        blob.title = `${title} · ${img.naturalWidth} × ${img.naturalHeight}`;
        $('blobInfo').textContent = `${blob.title} · ${size}`;
        $('blobView').replaceChildren(img);
        if (wanted) {
          enlarge();
        }
      });
      img.addEventListener('error', () => shown === blob && showHex(bytes.subarray(0, 4096), 'The picture could not be decoded.'));
      img.addEventListener('click', enlarge);
      blob.url = URL.createObjectURL(new Blob([bytes], { type: kind.mime }));
      img.src = blob.url;
    }, 120);
  }

  /** Shows the picture of the inspector in a dialog, as large as the window allows. */
  function enlarge() {
    const img = $('blobView').querySelector('img');
    if (!shown || !img) {
      // The cell was opened before its picture arrived.
      wanted = !!shown;
      return;
    }
    wanted = false;
    const copy = document.createElement('img');
    copy.alt = '';
    copy.src = shown.url;
    const frame = el('div', 'picture');
    frame.append(copy);
    const close = button('Close', 'primary', closeDialog);
    openDialog(shown.title, [frame], [button('Save blob to file…', '', () => void saveBlob()), close], closeDialog, true);
    close.focus();
  }

  async function saveBlob() {
    if (!shown) {
      return;
    }
    try {
      const done = await request('saveBlob', shown.source, shown.name);
      if (done) {
        $('status').textContent = `Saved ${formatSize(done.size)} to ${done.name}`;
      }
    } catch (e) {
      showNote(`The blob could not be saved: ${/** @type {Error} */ (e).message}`);
    }
  }

  // ---- Dialogs ------------------------------------------------------------

  /** What Escape does while a dialog is open. @type {(() => void) | null} */
  let dismiss = null;

  function button(/** @type {string} */ text, /** @type {string} */ className, /** @type {() => void} */ onClick) {
    const node = /** @type {HTMLButtonElement} */ (el('button', className, text));
    node.addEventListener('click', onClick);
    return node;
  }

  function openDialog(/** @type {string} */ title, /** @type {Node[]} */ body, /** @type {Node[]} */ buttons, /** @type {() => void} */ onDismiss, wide = false) {
    closeEditor(true);
    $('dialogTitle').textContent = title;
    $('dialogBody').replaceChildren(...body);
    $('dialogButtons').replaceChildren(...buttons);
    $('dialogBox').classList.toggle('wide', wide);
    $('dialog').hidden = false;
    // Keeps Tab and the keyboard out of the page behind the dialog.
    $('side').inert = $('main').inert = true;
    dismiss = onDismiss;
  }

  function closeDialog() {
    $('dialog').hidden = true;
    $('dialogBody').replaceChildren();
    $('side').inert = $('main').inert = false;
    dismiss = null;
    $('gridWrap').focus({ preventScroll: true });
  }

  /** @returns {Promise<boolean>} */
  function ask(/** @type {string} */ title, /** @type {string} */ text, /** @type {string} */ ok) {
    return new Promise((resolve) => {
      const done = (/** @type {boolean} */ answer) => {
        closeDialog();
        resolve(answer);
      };
      const confirm = button(ok, 'primary', () => done(true));
      openDialog(title, [el('p', '', text)], [button('Cancel', '', () => done(false)), confirm], () => done(false));
      confirm.focus();
    });
  }

  // ---- Export -------------------------------------------------------------

  async function exportRows(/** @type {string} */ format) {
    if (exporting) {
      return;
    }
    closeEditor(true);
    const query = mode === 'query';
    const source = query ? result.source : { table: current, sort, filter, match: matchOf() };
    // The file gets what the database holds; edits that wait to be saved aren't in it.
    const staged = !query && pending.has(current);
    exporting = true;
    updateChrome();
    $('status').textContent = 'Exporting…';
    let outcome = '';
    try {
      const done = await request('export', source, format, query ? 'query' : current);
      outcome = !done
        ? ''
        : done.cancelled
          ? 'The export was cancelled'
          : `Exported ${done.rows.toLocaleString('en-US')} row${done.rows === 1 ? '' : 's'} to ${done.name}${staged ? ', without the unsaved changes' : ''}`;
    } catch (e) {
      showNote(`The export failed: ${/** @type {Error} */ (e).message}`);
    }
    exporting = false;
    updateChrome();
    $('status').textContent = '';
    updatePending();
    // Last, because updatePending() puts the count of unsaved changes into the same line.
    if (outcome) {
      $('status').textContent = outcome;
    }
  }

  // ---- Import -------------------------------------------------------------

  async function importCsv() {
    closeEditor(true);
    const n = pendingCount();
    if (n) {
      const go = await ask(
        'Import CSV',
        `There ${n === 1 ? 'is 1 unsaved change' : `are ${n} unsaved changes`}. An import is written into the database straight away, on its own. ` +
          'The unsaved changes stay as they are, and you can save or revert them afterwards.',
        'Continue',
      );
      if (!go) {
        return;
      }
    }
    try {
      const picked = await request('pickCsv');
      if (picked) {
        showImport(picked.name);
      }
    } catch (e) {
      showNote(/** @type {Error} */ (e).message);
    }
  }

  /** The import dialog: how the file is read, where it goes, and which column goes where. */
  function showImport(/** @type {string} */ fileName) {
    const tables = (schema?.tables ?? []).filter((t) => t.type === 'table');
    /** Last reply of `csvPreview`. @type {any} */
    let preview = null;
    /** One entry per CSV column: `name` and `type` for a new table, `column` of an existing one, or `skip`. @type {{name: string, type: string, column: string, skip: boolean}[]} */
    let mapping = [];
    let token = 0;
    let running = false;

    const option = (/** @type {string} */ value, /** @type {string} */ text) => {
      const node = /** @type {HTMLOptionElement} */ (el('option', '', text));
      node.value = value;
      return node;
    };
    const labelled = (/** @type {string} */ text, /** @type {HTMLElement} */ control, before = true) => {
      const label = el('label');
      label.append(...(before ? [text, control] : [control, text]));
      return label;
    };
    const check = (/** @type {string} */ title) => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.title = title;
      return box;
    };

    const delimiterBox = document.createElement('select');
    delimiterBox.append(option(',', 'Comma'), option(';', 'Semicolon'), option('\t', 'Tab'), option('|', 'Pipe'));
    const headerBox = check('The first row holds the column names and is not imported');
    const emptyBox = check('Otherwise an empty field becomes NULL');
    const targetBox = document.createElement('select');
    targetBox.append(option('', 'New table'), ...tables.map((t, i) => option(String(i), t.name)));
    const nameBox = document.createElement('input');
    nameBox.spellcheck = false;
    // The file name makes the name of the new table, with a number when it is taken.
    const base = fileName.replace(/\.[^.]*$/, '').replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'imported';
    const taken = (/** @type {string} */ name) => (schema?.tables ?? []).some((t) => t.name.toLowerCase() === name.toLowerCase());
    nameBox.value = base;
    for (let i = 2; taken(nameBox.value); i++) {
      nameBox.value = `${base}_${i}`;
    }
    const nameLabel = labelled('Name', nameBox);

    const grid = el('table', 'preview');
    const wrap = el('div', 'previewWrap');
    wrap.append(grid);
    const hint = el('p', 'hint', 'Reading the file…');
    const error = el('p', 'error');
    const first = el('div', 'options');
    first.append(labelled('Delimiter', delimiterBox), labelled('First row is header', headerBox, false), labelled('Empty fields as empty text', emptyBox, false));
    const second = el('div', 'options');
    second.append(labelled('Into', targetBox), nameLabel);

    const target = () => (targetBox.value === '' ? null : tables[Number(targetBox.value)]);
    const close = () => {
      if (!running) {
        token++;
        closeDialog();
      }
    };
    const run = button('Import', 'primary', () => void start());
    run.disabled = true;

    /** Says what stands in the way of the import, and lets it start when nothing does. */
    function validate() {
      const table = target();
      const used = mapping.filter((m) => (table ? m.column : !m.skip));
      const names = used.map((m) => (table ? m.column : m.name.trim()).toLowerCase());
      let problem = '';
      if (!preview) {
        problem = ' ';
      } else if (!used.length) {
        problem = 'Every column is skipped.';
      } else if (!table && !nameBox.value.trim()) {
        problem = 'The new table needs a name.';
      } else if (!table && taken(nameBox.value.trim())) {
        problem = `There is a table or view "${nameBox.value.trim()}" already.`;
      } else if (names.includes('')) {
        problem = 'Every column needs a name.';
      } else if (new Set(names).size < names.length) {
        problem = table ? 'Two columns of the file go to the same column of the table.' : 'Two columns have the same name.';
      }
      error.textContent = problem.trim();
      error.hidden = !problem.trim();
      run.disabled = !!problem || running;
    }

    /** Matches the columns of the file to the target from scratch. */
    function remap() {
      const table = target();
      const free = (table?.columns ?? []).filter((/** @type {any} */ c) => !c.generated).map((/** @type {any} */ c) => c.name);
      /** @type {Set<string>} */
      const given = new Set();
      mapping = preview.names.map((/** @type {string} */ name, /** @type {number} */ i) => {
        // By name when the file has a header, by position when it has none.
        const column = (preview.header ? free.find((/** @type {string} */ f) => f.toLowerCase() === name.toLowerCase() && !given.has(f)) : free[i]) ?? '';
        given.add(column);
        return { name, type: preview.types[i], column, skip: false };
      });
    }

    function draw() {
      const table = target();
      nameLabel.hidden = !!table;
      const source = el('tr');
      const goes = el('tr');
      mapping.forEach((m, i) => {
        source.append(el('th', 'source', preview.header ? preview.names[i] : `Column ${i + 1}`));
        const th = el('th');
        if (table) {
          const box = document.createElement('select');
          box.title = 'The column of the table these values go to';
          box.append(option('', '(skip)'), ...table.columns.filter((/** @type {any} */ c) => !c.generated).map((/** @type {any} */ c) => option(c.name, c.type ? `${c.name} (${c.type.toLowerCase()})` : c.name)));
          box.value = m.column;
          box.addEventListener('change', () => {
            m.column = box.value;
            validate();
          });
          th.append(box);
        } else {
          const name = document.createElement('input');
          name.spellcheck = false;
          name.title = 'Column name';
          name.value = m.name;
          name.disabled = m.skip;
          name.addEventListener('input', () => {
            m.name = name.value;
            validate();
          });
          const type = document.createElement('select');
          type.title = 'Column type';
          type.append(...['INTEGER', 'REAL', 'TEXT', 'BLOB'].map((t) => option(t, t)), option('', '(skip)'));
          type.value = m.skip ? '' : m.type;
          type.addEventListener('change', () => {
            m.skip = type.value === '';
            m.type = type.value || m.type;
            name.disabled = m.skip;
            validate();
          });
          th.append(name, type);
        }
        goes.append(th);
      });
      const head = el('thead');
      head.append(source, goes);
      const body = el('tbody');
      const visible = preview.rows.slice(0, 20);
      for (const row of visible) {
        const tr = el('tr');
        mapping.forEach((_, i) => tr.append(el('td', '', row[i] ?? '')));
        body.append(tr);
      }
      grid.replaceChildren(head, body);
      const rows = `${preview.sampled.toLocaleString('en-US')} row${preview.sampled === 1 ? '' : 's'}`;
      hint.textContent =
        `${fileName}, ${formatSize(preview.size)}: ` +
        (preview.complete ? rows : `more than ${rows}; the column types are taken from the first ${preview.sampled.toLocaleString('en-US')}`) +
        (preview.sampled > visible.length ? `. The first ${visible.length} are shown.` : '.');
      validate();
    }

    /** Reads the beginning of the file again; null leaves the delimiter or the header to be detected. */
    async function load(/** @type {string | null} */ delimiter, /** @type {boolean | null} */ header) {
      const mine = ++token;
      const firstTime = !preview;
      try {
        const reply = await request('csvPreview', { delimiter, header });
        if (mine !== token) {
          return;
        }
        preview = reply;
      } catch (e) {
        if (mine === token) {
          preview = null;
          grid.replaceChildren();
          hint.textContent = '';
          validate();
          error.textContent = /** @type {Error} */ (e).message;
          error.hidden = false;
        }
        return;
      }
      delimiterBox.value = preview.delimiter;
      headerBox.checked = preview.header;
      if (firstTime && mode !== 'query') {
        // The table on screen is the likely target when at least half of the file's columns are named like its own.
        const names = new Set(preview.names.map((/** @type {string} */ n) => n.toLowerCase()));
        const matches = (/** @type {any} */ t) => t.columns.filter((/** @type {any} */ c) => !c.generated && names.has(c.name.toLowerCase())).length;
        const index = tables.findIndex((t) => t.name === current && preview.header && matches(t) * 2 >= names.size);
        targetBox.value = index < 0 ? '' : String(index);
      }
      remap();
      draw();
    }

    async function start() {
      const table = target();
      const options = {
        delimiter: preview.delimiter,
        header: preview.header,
        emptyText: emptyBox.checked,
        table: table ? table.name : nameBox.value.trim(),
        create: !table,
        columns: mapping.map((m) => (table ? (m.column ? { name: m.column } : null) : m.skip ? null : { name: m.name.trim(), type: m.type })),
      };
      const controls = [...$('dialogBox').querySelectorAll('input, select, button')].filter((node) => !node.disabled);
      const lock = (/** @type {boolean} */ on) => controls.forEach((node) => (node.disabled = on));
      running = true;
      lock(true);
      error.hidden = true;
      const note = hint.textContent;
      hint.textContent = 'Importing…';
      try {
        const done = await request('import', options);
        running = false;
        close();
        showNote('');
        $('status').textContent = done.cancelled
          ? 'The import was cancelled, and nothing was written'
          : `Imported ${done.rows.toLocaleString('en-US')} row${done.rows === 1 ? '' : 's'} into "${options.table}"`;
        data = null;
        await refresh();
        if (!done.cancelled && schema?.tables.some((t) => t.name === options.table)) {
          mode = 'data';
          openTable(options.table);
        }
      } catch (e) {
        running = false;
        lock(false);
        hint.textContent = note;
        error.textContent = `Nothing was imported. ${/** @type {Error} */ (e).message}`;
        error.hidden = false;
      }
    }

    delimiterBox.addEventListener('change', () => void load(delimiterBox.value, null));
    headerBox.addEventListener('change', () => void load(delimiterBox.value, headerBox.checked));
    targetBox.addEventListener('change', () => {
      if (preview) {
        remap();
        draw();
      }
    });
    nameBox.addEventListener('input', validate);

    openDialog('Import CSV', [first, second, wrap, hint, error], [button('Cancel', '', close), run], close, true);
    validate();
    void load(null, null);
  }

  // ---- Events -------------------------------------------------------------

  $('grid').addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const td = /** @type {HTMLTableCellElement | null} */ (target.closest('td'));
    if (!td || target.tagName === 'TEXTAREA') {
      return;
    }
    const r = /** @type {HTMLTableRowElement} */ (td.parentElement).sectionRowIndex;
    closeEditor(true);
    if (td.cellIndex === 0) {
      if (e.shiftKey) {
        const [from, to] = [Math.min(markAnchor, r), Math.max(markAnchor, r)];
        setMarked(Array.from({ length: to - from + 1 }, (_, i) => from + i));
      } else if (e.metaKey || e.ctrlKey) {
        setMarked(marked.has(r) ? [...marked].filter((m) => m !== r) : [...marked, r]);
        markAnchor = r;
      } else {
        setMarked(marked.size === 1 && marked.has(r) ? [] : [r]);
        markAnchor = r;
      }
      e.preventDefault();
      $('gridWrap').focus({ preventScroll: true });
    } else {
      if (marked.size) {
        setMarked([]);
      }
      setActive(r, td.cellIndex - 1, false);
      const link = withCommand(e) ? referencesOf(r, td.cellIndex - 1).find((found) => found.out) : undefined;
      if (link) {
        e.preventDefault();
        void follow(link);
      }
    }
  });

  $('grid').addEventListener('dblclick', (/** @type {MouseEvent} */ e) => {
    const td = /** @type {HTMLTableCellElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('td'));
    if (td && td.cellIndex > 0 && !editor) {
      void startEdit(/** @type {HTMLTableRowElement} */ (td.parentElement).sectionRowIndex, td.cellIndex - 1);
    }
  });

  $('grid').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const th = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('th.sortable'));
    if (!th) {
      return;
    }
    // Ascending, descending, then back to the table's own order.
    const name = columns[Number(th.dataset.col)].name;
    sort = sort?.column !== name ? { column: name, desc: false } : sort.desc ? null : { column: name, desc: true };
    offset = 0;
    active = null;
    marked.clear();
    void loadRows();
  });

  for (const button of $('modes').querySelectorAll('button')) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }
  $('openQuery').addEventListener('click', () => {
    setMode('query');
    $('sql').focus();
  });
  $('addRow').addEventListener('click', addRow);
  $('deleteRow').addEventListener('click', deleteRows);
  $('setNull').addEventListener('click', setNull);
  $('refresh').addEventListener('click', () => void refresh());
  $('save').addEventListener('click', () => void save());
  $('revert').addEventListener('click', revert);
  $('run').addEventListener('click', () => void runQuery());
  $('back').addEventListener('click', back);
  $('showAll').addEventListener('click', showAll);
  $('import').addEventListener('click', () => void importCsv());
  $('saveBlob').addEventListener('click', () => void saveBlob());
  $('export').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    $('exportMenu').hidden = !$('exportMenu').hidden;
    e.stopPropagation();
  });
  for (const item of $('exportMenu').querySelectorAll('button')) {
    item.addEventListener('click', () => void exportRows(item.dataset.format));
  }
  document.addEventListener('click', () => {
    $('exportMenu').hidden = true;
    closeHistory();
  });

  $('history').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    if ($('historyMenu').hidden) {
      openHistory();
    } else {
      closeHistory();
    }
    e.stopPropagation();
  });
  $('historyMenu').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    const items = [...$('historyMenu').querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeHistory();
      $('history').focus();
    }
  });

  $('sql').addEventListener('input', (/** @type {InputEvent} */ e) => {
    saveState();
    if (programmatic) {
      return;
    }
    edited = true;
    // Typing brings the list up, and deleting keeps one that is open in step. Nothing else does: not a paste, not an undo.
    if (e.inputType === 'insertText' || (completion && e.inputType?.startsWith('delete'))) {
      openComplete(!!completion?.forced);
    } else {
      closeComplete();
    }
  });
  $('sql').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.isComposing) {
      return;
    }
    const command = e.metaKey || e.ctrlKey;
    // Ctrl+Space switches the keyboard layout on many Macs, hence the second way to ask for the list.
    if ((e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Space') || (e.altKey && !command && e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      openComplete(true);
      return;
    }
    if (e.altKey && !command && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      closeComplete();
      recall(historyAt + (e.key === 'ArrowUp' ? 1 : -1));
      return;
    }
    // From here on the keys belong to the list, and only while it is open.
    if (!completion) {
      return;
    }
    if (command || e.altKey) {
      // Run, undo and the like come first.
      closeComplete();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        completion.moved = true;
        selectComplete(completion.index + (e.key === 'ArrowDown' ? 1 : -1));
        break;
      case 'Tab':
        if (e.shiftKey) {
          closeComplete();
        } else {
          e.preventDefault();
          acceptComplete(completion.index);
        }
        break;
      case 'Enter':
        // A list that came up by itself must not eat the line break of someone who just goes on typing.
        if (e.shiftKey || !(completion.forced || completion.moved)) {
          closeComplete();
        } else {
          e.preventDefault();
          acceptComplete(completion.index);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        closeComplete();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        closeComplete();
        break;
    }
  });
  $('sql').addEventListener('blur', closeComplete);
  $('sql').addEventListener('mousedown', closeComplete);
  $('sql').addEventListener('scroll', placeComplete);
  window.addEventListener('resize', closeComplete);

  let filterTimer = 0;
  $('filter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filter = $('filter').value;
      offset = 0;
      active = null;
      marked.clear();
      void loadRows();
    }, 300);
  });

  function goTo(/** @type {number} */ next) {
    closeEditor(true);
    offset = Math.max(0, next);
    active = null;
    marked.clear();
    $('gridWrap').scrollTop = 0;
    void loadRows();
  }
  $('pageFirst').addEventListener('click', () => goTo(0));
  $('pagePrev').addEventListener('click', () => goTo(offset - limit));
  $('pageNext').addEventListener('click', () => goTo(offset + limit));
  $('pageLast').addEventListener('click', () => data && goTo(Math.floor((data.total - 1) / limit) * limit));
  $('pageSize').value = String(limit);
  $('pageSize').addEventListener('change', () => {
    limit = Number($('pageSize').value);
    saveState();
    goTo(Math.floor(offset / limit) * limit);
  });

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const command = e.metaKey || e.ctrlKey;
    if (!$('dialog').hidden) {
      if (e.key === 'Escape') {
        dismiss?.();
      }
      return;
    }
    if (e.key === 'Escape') {
      $('exportMenu').hidden = true;
      closeHistory();
    }
    if (command && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
      return;
    }
    if (command && e.key === 'Enter' && mode === 'query') {
      e.preventDefault();
      void runQuery();
      return;
    }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if (command && e.code === 'BracketLeft' && mode === 'data' && trail.length && !typing) {
      e.preventDefault();
      back();
      return;
    }
    if (command && e.key === 'Enter' && mode === 'data' && active && !typing && target.tagName !== 'BUTTON') {
      const link = referencesOf(active.row, active.col).find((found) => found.out);
      if (link) {
        e.preventDefault();
        void follow(link);
      }
      return;
    }
    if (typing || target.tagName === 'BUTTON' || command || e.altKey || !active) {
      return;
    }
    const { row, col } = active;
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const move = moves[/** @type {keyof typeof moves} */ (e.key)];
    if (move) {
      e.preventDefault();
      setActive(Math.max(0, Math.min(view.length - 1, row + move[0])), Math.max(0, Math.min(columns.length - 1, col + move[1])));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      setActive(row, Math.max(0, Math.min(columns.length - 1, col + (e.shiftKey ? -1 : 1))));
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      void startEdit(row, col);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setNull();
    } else if (e.key.length === 1 && e.key !== ' ') {
      // Typing over a cell replaces its value.
      e.preventDefault();
      void startEdit(row, col, e.key);
    }
  });

  // ---- Messages -----------------------------------------------------------

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        $('fileName').textContent = msg.name;
        $('fileName').title = msg.name;
        $('sql').value = saved.sql || '';
        if (msg.error) {
          showMessage(msg.error);
        } else {
          void refresh().then(() => mode === 'query' && showResult());
          request('history').then(
            (items) => (history = items),
            () => undefined,
          );
        }
        break;
      case 'response': {
        const pendingRequest = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error !== undefined) {
          pendingRequest?.reject(new Error(msg.error));
        } else {
          pendingRequest?.resolve(msg.result);
        }
        break;
      }
      case 'changed':
        // Our own save lands here too; it reloads by itself.
        if (!saving && schema) {
          void refresh();
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
