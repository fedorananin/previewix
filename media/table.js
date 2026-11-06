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

  /** 'csv', 'jsonl', 'xlsx', 'parquet' or 'dbf'. */
  const kind = document.body.dataset.kind;
  const csv = kind === 'csv';
  const dbf = kind === 'dbf';
  /** A spreadsheet names its columns with letters and its cells like A1; the other kinds count both. */
  const sheet = kind === 'xlsx';
  const saved = vscode.getState() || {};
  const wrap = /** @type {HTMLElement} */ ($('gridWrap'));

  /** Heights of a row and of the header; table.css has the same numbers. */
  const ROW = 24;
  const HEAD = 26;
  /** Rows drawn beyond both edges of the window, so that a fast scroll doesn't show blanks. */
  const OVERSCAN = 8;
  /** Chromium stops laying out an element somewhere past 33 million pixels; a taller table is scrolled at a scale. */
  const MAX_HEIGHT = 30_000_000;
  const MIN_WIDTH = 36;
  const MAX_AUTO_WIDTH = 360;
  /** Horizontal padding and border of a cell. */
  const CELL_EXTRA = 17;
  /** A cell shows this much of its text; the rest is in the panel under the grid. */
  const CELL_CHARS = 300;
  const DETAIL_CHARS = 100_000;
  const MAX_COPY_CELLS = 2_000_000;
  /** The width of a column that an edit has added. */
  const NEW_WIDTH = 100;
  /** The editor of a cell grows with its text up to this width and this many lines. */
  const MAX_EDITOR_WIDTH = 480;
  const MAX_EDITOR_LINES = 8;
  /** What counts as a number in a text file. Sorting, alignment, the statistics and the number filters all go by it. */
  const NUMBER = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
  /** A number that JSON would write the same way, so that copying as JSON doesn't change a digit of it. */
  const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
  /** The statistics of a selection are worked out for this long at a time, in milliseconds, and then let the page breathe. */
  const STATS_SLICE = 8;
  const FORMATS = /** @type {Record<string, string>} */ ({ tsv: '', markdown: ' as Markdown', json: ' as JSON', csv: ' as CSV' });
  const CODECS = /** @type {Record<string, string>} */ ({ UNCOMPRESSED: 'uncompressed', SNAPPY: 'Snappy', GZIP: 'gzip', BROTLI: 'Brotli', ZSTD: 'Zstandard', LZ4: 'LZ4', LZ4_RAW: 'LZ4' });
  const DELIMITERS = /** @type {Record<string, string>} */ ({ ',': 'Comma', ';': 'Semicolon', '\t': 'Tab', '|': 'Pipe' });

  // ---- State --------------------------------------------------------------

  /** The last `file` message: what the file is and which sheets it has. @type {any} */
  let file = null;
  let sheetIndex = -1;
  /** Name of the sheet on screen, which is what survives a reload. */
  let sheetName = saved.sheet || '';

  /**
   * The table on screen. All cells are one string: cell `i` runs from `ends[i - 1]` to `ends[i]`,
   * and row `r` holds the cells from `rowEnds[r - 1]` up to `rowEnds[r]`.
   */
  let text = '';
  let ends = new Uint32Array(0);
  let rowEnds = new Uint32Array(0);
  /** Spreadsheets only: the number behind each cell, NaN for the rest. @type {Float64Array | null} */
  let nums = null;
  /** Spreadsheets only: merged ranges, four numbers each. @type {Uint32Array | null} */
  let merges = null;
  /** JSON Lines and Parquet: the column names, which are not a row of the table there. @type {string[] | null} */
  let names = null;
  /** JSON Lines only: the line of the file behind every row, when lines were skipped. @type {Uint32Array | null} */
  let lines = null;
  /** Parquet only: the type of every column, short and in full, and a 1 for the columns that hold numbers. @type {string[] | null} */
  let types = null;
  /** @type {string[] | null} */
  let details = null;
  /** @type {Uint8Array | null} */
  let numeric = null;
  let rowCount = 0;
  let cols = 0;
  let loaded = false;

  /** @type {boolean} */
  let headerOn = saved.header ?? csv;
  let needle = '';
  /** The filters of single columns, by column. One that isn't complete yet (a comparison without a number) is kept but not applied. @type {Map<number, {op: string, value: string}>} */
  const filters = new Map();
  /** @type {{col: number, desc: boolean} | null} */
  let sort = null;
  /** File rows in the order they are shown, or null when that is every row in file order. @type {Uint32Array | null} */
  let order = null;

  /** @type {number[]} */
  let widths = [];
  /** Left edge of every column, and of the end of the last one. */
  let lefts = new Float64Array(1);
  let gutter = 40;

  /** Selection in rows as shown: the range between `anchor` and `active`. @type {{row: number, col: number} | null} */
  let active = null;
  /** @type {{row: number, col: number} | null} */
  let anchor = null;

  /** The latest count over the selection. @type {{run: number, done: boolean, filled: number, numbers: number, sum: number, lost: number, min: number, max: number} | null} */
  let stats = null;
  let statsRun = 0;
  /** Something to say in place of the statistics until the selection changes, such as why nothing was copied. */
  let selectionNote = '';

  /** Delimited text is edited in place; the provider says so with the file. */
  let editable = false;
  /** Counts the changes of the table, as the provider does: an edit names the version it was made to. */
  let version = 0;
  /** What the provider knows about the document: unsaved edits, a newer file on disk, unsaved text in a text editor. */
  let docState = { dirty: false, changedOnDisk: false, textDirty: false };
  /** Rows were edited since they were filtered and sorted, so some may no longer be where the filter and the sort would put them. */
  let stale = false;
  /** A character that was typed or pasted and that the encoding of the file has no place for. */
  let unwritable = '';

  function saveState() {
    vscode.setState({ header: headerOn, sheet: sheetName, delimiter: csv ? $('delimiter').value : undefined, encoding: dbf ? $('encoding').value : undefined });
  }

  // ---- Table access -------------------------------------------------------

  /** Number of table rows above the data: the header row, when the names of the columns are one. */
  function first() {
    return !names && headerOn && rowCount ? 1 : 0;
  }

  function shown() {
    return order ? order.length : rowCount - first();
  }

  function fileRow(/** @type {number} */ d) {
    return order ? order[d] : d + first();
  }

  /** Index of a cell in `ends`, or -1 when the row is shorter than that. */
  function cellIndex(/** @type {number} */ r, /** @type {number} */ c) {
    const i = (r ? rowEnds[r - 1] : 0) + c;
    return i < rowEnds[r] ? i : -1;
  }

  function cellText(/** @type {number} */ r, /** @type {number} */ c) {
    const i = cellIndex(r, c);
    return i < 0 ? '' : text.slice(i ? ends[i - 1] : 0, ends[i]);
  }

  function letters(/** @type {number} */ c) {
    let name = '';
    for (c++; c > 0; c = Math.floor((c - 1) / 26)) {
      name = String.fromCharCode(65 + ((c - 1) % 26)) + name;
    }
    return name;
  }

  /** What a column is called without a header row: its letter in a spreadsheet, its number elsewhere. */
  function columnName(/** @type {number} */ c) {
    return sheet ? letters(c) : String(c + 1);
  }

  /** The name a column has of its own: from the file, or from the header row. Empty when it has none. */
  function label(/** @type {number} */ c) {
    return names ? (names[c] ?? '') : headerOn ? cellText(0, c) : '';
  }

  /** The number shown next to a row: the sheet's own row number, the line of a JSON Lines file, or the count of records. */
  function rowNumber(/** @type {number} */ r) {
    return lines ? lines[r] : csv && headerOn ? r : r + 1;
  }

  /**
   * The number in a cell, or NaN when the cell holds something else. A spreadsheet and a Parquet
   * file know which cells are numbers; in a text file a cell is one when it reads as one.
   */
  function numberAt(/** @type {number} */ i, /** @type {number} */ c) {
    if (i < 0) {
      return NaN;
    }
    if (nums) {
      return nums[i];
    }
    const start = i ? ends[i - 1] : 0;
    const end = ends[i];
    if (end === start) {
      return NaN;
    }
    if (numeric) {
      return numeric[c] ? Number(text.slice(start, end)) : NaN;
    }
    // Most cells that aren't numbers start with a letter, which settles them without a look at the rest.
    const code = text.charCodeAt(start);
    if (end - start >= 40 || (code > 57 && code < 128)) {
      return NaN;
    }
    const value = text.slice(start, end);
    return NUMBER.test(value) ? Number(value) : NaN;
  }

  function formatSize(/** @type {number} */ bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${i && bytes < 100 ? bytes.toFixed(1) : Math.round(bytes)} ${units[i]}`;
  }

  const count = (/** @type {number} */ n, /** @type {string} */ noun) => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

  // ---- Filter and sort ----------------------------------------------------

  /** True for a filter that can be applied: one that needs no value, or has a usable one. */
  function isComplete(/** @type {{op: string, value: string}} */ filter) {
    if (filter.op === 'empty' || filter.op === 'notEmpty') {
      return true;
    }
    return ['eq', 'ne', 'gt', 'ge', 'lt', 'le'].includes(filter.op) ? filter.value.trim() !== '' && !Number.isNaN(Number(filter.value)) : filter.value !== '';
  }

  /** The test a column filter stands for. It is given the index of the cell, or -1 where the row has none. */
  function columnTest(/** @type {number} */ col, /** @type {{op: string, value: string}} */ filter) {
    const wanted = filter.value.toLowerCase();
    const number = Number(filter.value);
    const lower = (/** @type {number} */ i) => (i < 0 ? '' : text.slice(i ? ends[i - 1] : 0, ends[i]).toLowerCase());
    const length = (/** @type {number} */ i) => (i < 0 ? 0 : ends[i] - (i ? ends[i - 1] : 0));
    /** @type {Record<string, (i: number) => boolean>} */
    const tests = {
      contains: (i) => length(i) >= wanted.length && lower(i).includes(wanted),
      notContains: (i) => !(length(i) >= wanted.length && lower(i).includes(wanted)),
      equals: (i) => lower(i) === wanted,
      starts: (i) => lower(i).startsWith(wanted),
      ends: (i) => lower(i).endsWith(wanted),
      empty: (i) => !length(i),
      notEmpty: (i) => length(i) > 0,
      // A cell that isn't a number fails every comparison, including "not equal".
      eq: (i) => numberAt(i, col) === number,
      ne: (i) => {
        const value = numberAt(i, col);
        return value === value && value !== number;
      },
      gt: (i) => numberAt(i, col) > number,
      ge: (i) => numberAt(i, col) >= number,
      lt: (i) => numberAt(i, col) < number,
      le: (i) => numberAt(i, col) <= number,
    };
    return { col, test: tests[filter.op] };
  }

  function activeTests() {
    return [...filters].filter(([col, filter]) => col < cols && isComplete(filter)).map(([col, filter]) => columnTest(col, filter));
  }

  function filtered() {
    return !!needle || activeTests().length > 0;
  }

  /** The data rows that pass every column filter and contain the text of the row filter in one of their cells, in file order. */
  function filterRows(/** @type {ReturnType<typeof columnTest>[]} */ tests) {
    const out = new Uint32Array(rowCount - first());
    let n = 0;
    rows: for (let r = first(); r < rowCount; r++) {
      const a = r ? rowEnds[r - 1] : 0;
      const b = rowEnds[r];
      // One cell each, so these come before the search through the whole row.
      for (const { col, test } of tests) {
        if (!test(col < b - a ? a + col : -1)) {
          continue rows;
        }
      }
      if (!needle) {
        out[n++] = r;
        continue;
      }
      if (a === b) {
        continue;
      }
      // The whole row is searched at once, which settles most rows with one call.
      if (!text.slice(a ? ends[a - 1] : 0, ends[b - 1]).toLowerCase().includes(needle)) {
        continue;
      }
      // A hit there may straddle two cells.
      for (let i = a; i < b; i++) {
        const start = i ? ends[i - 1] : 0;
        if (ends[i] - start >= needle.length && text.slice(start, ends[i]).toLowerCase().includes(needle)) {
          out[n++] = r;
          break;
        }
      }
    }
    return out.slice(0, n);
  }

  /** Numbers first, by value; then texts; empty cells always at the end. Equal cells keep their file order. */
  function sortRows(/** @type {Uint32Array} */ rows, /** @type {number} */ col, /** @type {boolean} */ desc) {
    const n = rows.length;
    const kinds = new Uint8Array(n);
    const numbers = new Float64Array(n);
    /** @type {string[]} */
    const texts = new Array(n);
    for (let k = 0; k < n; k++) {
      const i = cellIndex(rows[k], col);
      const value = i < 0 ? '' : text.slice(i ? ends[i - 1] : 0, ends[i]);
      const number = numberAt(i, col);
      if (value === '') {
        kinds[k] = 2;
      } else if (number === number) {
        numbers[k] = number;
      } else {
        kinds[k] = 1;
        texts[k] = value.toLowerCase();
      }
    }
    const dir = desc ? -1 : 1;
    const perm = new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      perm[k] = k;
    }
    perm.sort((a, b) => {
      const ka = kinds[a];
      const kb = kinds[b];
      if (ka !== kb) {
        return ka === 2 ? 1 : kb === 2 ? -1 : (ka - kb) * dir;
      }
      if (ka === 0) {
        return (numbers[a] - numbers[b]) * dir || a - b;
      }
      if (ka === 1) {
        const ta = texts[a];
        const tb = texts[b];
        return ta === tb ? a - b : (ta < tb ? -1 : 1) * dir;
      }
      return a - b;
    });
    for (let k = 0; k < n; k++) {
      perm[k] = rows[perm[k]];
    }
    return perm;
  }

  /** Works out which rows are shown, and in which order, after the filter, the sort or the header row changed. */
  function rebuild() {
    // What is being typed into a cell belongs to the table before it is sorted and filtered.
    closeEditor(true);
    const tests = activeTests();
    /** @type {Uint32Array | null} */
    let rows = needle || tests.length ? filterRows(tests) : null;
    if (sort && sort.col < cols) {
      if (!rows) {
        rows = new Uint32Array(rowCount - first());
        for (let k = 0; k < rows.length; k++) {
          rows[k] = k + first();
        }
      }
      rows = sortRows(rows, sort.col, sort.desc);
    }
    order = rows;
    stale = false;
    active = anchor = null;
    pinned = null;
    wrap.scrollTop = 0;
    layout();
    updateDetail();
    updateStatus();
    const nothing = sheet ? 'This sheet is empty.' : csv ? 'The file is empty.' : 'The file has no rows.';
    showMessage(!loaded ? '' : !rowCount ? nothing : !shown() ? (needle || tests.length ? 'No rows match the filter.' : 'No rows after the header.') : '');
    draw();
  }

  // ---- Layout -------------------------------------------------------------

  /** Texts are measured in the page itself, so that the font and its number style are the ones the grid uses. */
  const ruler = el('div', 'ruler');
  document.body.append(ruler);

  /** Widths of texts set as a cell (''), a number cell ('num'), a header ('bold') or a row number ('small'). */
  function measure(/** @type {[string, string][]} */ items) {
    const spans = items.map(([value, kind]) => el('span', kind, value.slice(0, CELL_CHARS)));
    ruler.replaceChildren(...spans);
    const result = spans.map((span) => span.getBoundingClientRect().width);
    ruler.replaceChildren();
    return result;
  }

  function isNumber(/** @type {number} */ i, /** @type {number} */ c) {
    return !Number.isNaN(numberAt(i, c));
  }

  /** What to measure for a column: its header, its type when the file names one, and the cell at index `longest` when there is one. */
  function columnTexts(/** @type {number} */ c, /** @type {number} */ longest) {
    const value = longest < 0 ? '' : text.slice(longest ? ends[longest - 1] : 0, ends[longest]);
    return /** @type {[string, string][]} */ ([
      [label(c) || columnName(c), 'bold'],
      [types?.[c] ?? '', 'small'],
      [value, isNumber(longest, c) ? 'num' : ''],
    ]);
  }

  /** The header leaves room for the sort arrow, and for the type after the name. */
  function columnWidth(/** @type {number} */ header, /** @type {number} */ type, /** @type {number} */ cell, /** @type {number} */ limit) {
    return Math.ceil(Math.max(MIN_WIDTH, Math.min(limit, Math.max(header + (type ? type + 6 : 0) + 14, cell) + CELL_EXTRA)));
  }

  /** Sizes the columns to what the first rows hold. Lengths come from the index, so only one cell per column is measured. */
  function fitColumns() {
    const longest = new Int32Array(cols).fill(-1);
    const lengths = new Uint32Array(cols);
    const sample = Math.min(rowCount, 500);
    for (let r = first(); r < sample; r++) {
      const a = r ? rowEnds[r - 1] : 0;
      for (let i = a; i < rowEnds[r]; i++) {
        const length = ends[i] - (i ? ends[i - 1] : 0);
        if (length > lengths[i - a]) {
          lengths[i - a] = length;
          longest[i - a] = i;
        }
      }
    }
    const measured = measure(Array.from(longest, (cell, c) => columnTexts(c, cell)).flat());
    widths = Array.from(longest, (_, c) => columnWidth(measured[c * 3], measured[c * 3 + 1], measured[c * 3 + 2], MAX_AUTO_WIDTH));
  }

  /** Recomputes the column positions and the size of the scrolled area. */
  function layout() {
    lefts = new Float64Array(cols + 1);
    for (let c = 0; c < cols; c++) {
      lefts[c + 1] = lefts[c] + widths[c];
    }
    const last = rowCount ? rowNumber(rowCount - 1) : 0;
    gutter = Math.ceil(Math.max(36, measure([[last.toLocaleString('en-US'), 'small']])[0] + 18));
    $('canvas').style.width = `${gutter + lefts[cols]}px`;
    $('canvas').style.height = `${HEAD + Math.min(shown() * ROW, MAX_HEIGHT)}px`;
  }

  /** A scroll position set by the keyboard, kept exact where the scaled scrollbar can only come close. @type {{scroll: number, top: number} | null} */
  let pinned = null;

  function viewHeight() {
    return Math.max(0, wrap.clientHeight - HEAD);
  }

  /** Distance from the first row to the top of the window, in unscaled pixels. */
  function virtualTop() {
    const height = shown() * ROW;
    if (height <= MAX_HEIGHT) {
      return wrap.scrollTop;
    }
    if (pinned && pinned.scroll === wrap.scrollTop) {
      return pinned.top;
    }
    const view = viewHeight();
    return (wrap.scrollTop * (height - view)) / (MAX_HEIGHT - view);
  }

  function scrollToTop(/** @type {number} */ top) {
    const height = shown() * ROW;
    const view = viewHeight();
    top = Math.max(0, Math.min(top, height - view));
    wrap.scrollTop = height <= MAX_HEIGHT ? top : (top * (MAX_HEIGHT - view)) / (height - view);
    pinned = { scroll: wrap.scrollTop, top };
  }

  function columnAt(/** @type {number} */ x) {
    let lo = 0;
    let hi = cols - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lefts[mid] <= x) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  function reveal(/** @type {number} */ d, /** @type {number} */ c) {
    const top = virtualTop();
    const view = viewHeight();
    if (d * ROW < top) {
      scrollToTop(d * ROW);
    } else if ((d + 1) * ROW > top + view) {
      scrollToTop((d + 1) * ROW - view);
    }
    const width = wrap.clientWidth - gutter;
    if (lefts[c] < wrap.scrollLeft) {
      wrap.scrollLeft = lefts[c];
    } else if (lefts[c + 1] > wrap.scrollLeft + width) {
      wrap.scrollLeft = Math.min(lefts[c], lefts[c + 1] - width);
    }
  }

  // ---- Drawing ------------------------------------------------------------

  function range() {
    if (!active || !anchor) {
      return null;
    }
    return {
      r1: Math.min(active.row, anchor.row),
      r2: Math.max(active.row, anchor.row),
      c1: Math.min(active.col, anchor.col),
      c2: Math.max(active.col, anchor.col),
    };
  }

  /** Puts a value into a cell: cut to a sensible length, on one line, with the filter text marked. */
  function fill(/** @type {HTMLElement} */ node, /** @type {string} */ value) {
    let shownText = value.length > CELL_CHARS ? value.slice(0, CELL_CHARS) + '…' : value;
    if (/[\r\n]/.test(shownText)) {
      shownText = shownText.replace(/\r\n?|\n/g, '↵');
    }
    const lower = needle ? shownText.toLowerCase() : '';
    // Lower-casing changes the length of a few characters, and the positions with it.
    if (!needle || lower.length !== shownText.length || !lower.includes(needle)) {
      node.textContent = shownText;
      return;
    }
    let pos = 0;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, pos)) {
      node.append(shownText.slice(pos, at), el('mark', '', shownText.slice(at, at + needle.length)));
      pos = at + needle.length;
    }
    node.append(shownText.slice(pos));
  }

  function makeCell(/** @type {number} */ d, /** @type {number} */ c, /** @type {number} */ r, /** @type {ReturnType<typeof range>} */ selected) {
    const node = el('div', 'cell');
    const i = cellIndex(r, c);
    if (i >= 0) {
      if (isNumber(i, c)) {
        node.classList.add('num');
      }
      fill(node, text.slice(i ? ends[i - 1] : 0, ends[i]));
    }
    if (selected && d >= selected.r1 && d <= selected.r2 && c >= selected.c1 && c <= selected.c2) {
      node.classList.add('selected');
    }
    if (active && active.row === d && active.col === c) {
      node.classList.add('active');
    }
    node.dataset.row = String(d);
    node.dataset.col = String(c);
    node.style.left = `${gutter + lefts[c]}px`;
    node.style.width = `${widths[c]}px`;
    return node;
  }

  let frame = 0;
  function schedule() {
    frame ||= requestAnimationFrame(draw);
  }

  /** Draws the rows and columns that are in the window, and nothing else. */
  function draw() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!loaded || !cols) {
      $('head').replaceChildren();
      $('rows').replaceChildren();
      return;
    }
    const total = shown();
    const top = virtualTop();
    // Where a row sits on the canvas, which differs from its real position once the scrollbar is scaled.
    const shift = HEAD + wrap.scrollTop - top;
    const d1 = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const d2 = Math.min(total - 1, Math.ceil((top + viewHeight()) / ROW) + OVERSCAN);
    const c1 = Math.max(0, columnAt(wrap.scrollLeft) - 1);
    const c2 = Math.min(cols - 1, columnAt(wrap.scrollLeft + wrap.clientWidth - gutter) + 1);
    const selected = range();

    const head = [];
    const corner = el('div', 'corner');
    corner.style.width = `${gutter}px`;
    corner.title = 'Select everything';
    head.push(corner);
    for (let c = c1; c <= c2; c++) {
      const name = label(c);
      const filter = filters.get(c);
      const th = el('div', filter && isComplete(filter) ? 'th filtered' : 'th');
      th.append(el('span', name ? 'name' : 'name auto', (name || columnName(c)).slice(0, CELL_CHARS)));
      if (types?.[c]) {
        th.append(el('span', 'type', types[c]));
      }
      if (sort?.col === c) {
        th.append(el('span', 'arrow', sort.desc ? '▼' : '▲'));
      }
      const funnel = el('div', 'funnel');
      funnel.append(FUNNEL.cloneNode(true));
      funnel.title = filter && isComplete(filter) ? `Filtered: ${describe(filter)}\nClick to change` : 'Filter this column';
      th.append(funnel, el('div', 'resize'));
      th.title = `${name || `Column ${columnName(c)}`}${details?.[c] ? `\n${details[c]}` : ''}\nClick to sort`;
      th.dataset.col = String(c);
      th.style.left = `${gutter + lefts[c]}px`;
      th.style.width = `${widths[c]}px`;
      head.push(th);
    }
    $('head').replaceChildren(...head);

    const rows = [];
    for (let d = d1; d <= d2; d++) {
      const r = fileRow(d);
      const row = el('div', 'row');
      row.style.top = `${shift + d * ROW}px`;
      const number = el('div', 'gutter', rowNumber(r).toLocaleString('en-US'));
      number.style.width = `${gutter}px`;
      number.dataset.row = String(d);
      if (selected && d >= selected.r1 && d <= selected.r2) {
        number.classList.add('selected');
      }
      row.append(number);
      for (let c = c1; c <= c2; c++) {
        row.append(makeCell(d, c, r, selected));
      }
      rows.push(row);
    }

    // Merged cells are drawn over the cells they cover. Once rows are filtered or sorted they no longer sit together.
    if (merges && !order) {
      const skip = first();
      for (let m = 0; m < merges.length; m += 4) {
        const mr1 = merges[m] - skip;
        const mr2 = merges[m + 2] - skip;
        const mc1 = merges[m + 1];
        const mc2 = Math.min(merges[m + 3], cols - 1);
        if (mr1 < 0 || mr2 < d1 || mr1 > d2 || mc2 < c1 || mc1 > c2) {
          continue;
        }
        const node = makeCell(mr1, mc1, merges[m], selected);
        node.classList.add('merged');
        if (active && active.row >= mr1 && active.row <= mr2 && active.col >= mc1 && active.col <= mc2) {
          node.classList.add('active');
        }
        node.style.top = `${shift + mr1 * ROW}px`;
        node.style.width = `${lefts[mc2 + 1] - lefts[mc1]}px`;
        node.style.height = `${(Math.min(mr2, total - 1) - mr1 + 1) * ROW}px`;
        rows.push(node);
      }
    }
    $('rows').replaceChildren(...rows);
    placeEditor();
  }

  // ---- Selection ----------------------------------------------------------

  function showMessage(/** @type {string} */ message) {
    $('message').textContent = message;
    $('message').hidden = !message;
  }

  /** Shows the whole text of the selected cell when the grid can't. */
  function updateDetail() {
    let cut = false;
    let value = '';
    if (active && active.row < shown()) {
      const i = cellIndex(fileRow(active.row), active.col);
      value = i < 0 ? '' : text.slice(i ? ends[i - 1] : 0, ends[i]);
      cut = value.length > CELL_CHARS || /[\r\n]/.test(value) || measure([[value, isNumber(i, active.col) ? 'num' : '']])[0] > widths[active.col] - CELL_EXTRA + 0.5;
    }
    $('detail').hidden = !cut;
    if (cut && active) {
      const r = fileRow(active.row);
      const name = label(active.col);
      $('detailTitle').textContent = sheet
        ? `${letters(active.col)}${r + 1}${name ? ` · ${name}` : ''}`
        : `${name || `Column ${columnName(active.col)}`}, ${lines ? 'line' : 'row'} ${rowNumber(r).toLocaleString('en-US')}`;
      $('detailText').textContent =
        value.length > DETAIL_CHARS ? `${value.slice(0, DETAIL_CHARS)}…\n\n(${(value.length - DETAIL_CHARS).toLocaleString('en-US')} more characters; copy the cell to get all of it)` : value;
      $('detailText').scrollTop = 0;
    }
  }

  /** A sum or an average as people read it: grouped, and without the digits that only the arithmetic of floats put there. */
  function formatNumber(/** @type {number} */ value) {
    const size = Math.abs(value);
    if (!Number.isFinite(value)) {
      return String(value);
    }
    // Past the digits a float keeps, the exponent says plainly that the rest is rounded.
    if (size >= 1e15 || (size > 0 && size < 1e-6)) {
      return Number(value.toPrecision(10)).toExponential();
    }
    return value.toLocaleString('en-US', size >= 1 ? { maximumFractionDigits: 6 } : { maximumSignificantDigits: 8 });
  }

  /** What the status line says about the selection: its size, and the count and the numbers in it once they are known. */
  function showSelection() {
    const selected = range();
    const rows = selected ? selected.r2 - selected.r1 + 1 : 0;
    const columns = selected ? selected.c2 - selected.c1 + 1 : 0;
    const parts = [];
    if (selectionNote) {
      parts.push(selectionNote);
    } else if (rows * columns > 1) {
      parts.push(`${count(rows, 'row')} × ${count(columns, 'column')} selected`);
      if (!stats?.done) {
        parts.push('counting…');
      } else {
        parts.push(`Count ${stats.filled.toLocaleString('en-US')}`);
        if (stats.numbers) {
          const sum = stats.sum + stats.lost;
          parts.push(
            `Numbers ${stats.numbers.toLocaleString('en-US')}`,
            `Sum ${formatNumber(sum)}`,
            `Average ${formatNumber(sum / stats.numbers)}`,
            `Min ${formatNumber(stats.min)}`,
            `Max ${formatNumber(stats.max)}`,
          );
        }
      }
    }
    $('selection').textContent = parts.join('  ·  ');
    $('copyAs').disabled = !selected;
  }

  /**
   * Counts the selected cells that hold something and adds up the numbers among them. A whole
   * column of a large table takes a few milliseconds; everything in it takes long enough to be
   * done a slice at a time, and a new selection drops the count of the old one.
   */
  function countSelection() {
    const run = ++statsRun;
    const selected = range();
    stats = null;
    if (!selected || (selected.r2 - selected.r1 + 1) * (selected.c2 - selected.c1 + 1) < 2) {
      return;
    }
    const { r2, c1, c2 } = selected;
    const sums = (stats = { run, done: false, filled: 0, numbers: 0, sum: 0, lost: 0, min: Infinity, max: -Infinity });
    // The clock is read once per block of rows, of about four thousand cells.
    const block = Math.max(1, Math.floor(4096 / (c2 - c1 + 1)));
    let d = selected.r1;
    const slice = () => {
      if (run !== statsRun) {
        return;
      }
      const until = performance.now() + STATS_SLICE;
      while (d <= r2) {
        for (const stop = Math.min(r2, d + block - 1); d <= stop; d++) {
          const r = fileRow(d);
          const a = r ? rowEnds[r - 1] : 0;
          for (let c = c1, i = a + c1, last = Math.min(a + c2, rowEnds[r] - 1); i <= last; i++, c++) {
            if (ends[i] === (i ? ends[i - 1] : 0)) {
              continue;
            }
            sums.filled++;
            const value = numberAt(i, c);
            if (value !== value) {
              continue;
            }
            sums.numbers++;
            // Neumaier's sum: the digits each addition drops are collected, so 0.1 added ten times is 1.
            const next = sums.sum + value;
            if (Number.isFinite(next)) {
              sums.lost += Math.abs(sums.sum) >= Math.abs(value) ? sums.sum - next + value : value - next + sums.sum;
            }
            sums.sum = next;
            if (value < sums.min) {
              sums.min = value;
            }
            if (value > sums.max) {
              sums.max = value;
            }
          }
        }
        if (performance.now() >= until) {
          break;
        }
      }
      if (d > r2) {
        sums.done = true;
        showSelection();
      } else {
        setTimeout(slice, 0);
      }
    };
    slice();
  }

  function updateStatus() {
    selectionNote = '';
    if (!file || !loaded) {
      $('info').textContent = file && !file.error ? 'Loading…' : '';
      $('matches').textContent = '';
      $('clearFilters').hidden = true;
      statsRun++;
      stats = null;
      showSelection();
      return;
    }
    const all = rowCount - first();
    /** Rows the file has, which is more than the table shows when a limit cut it. */
    const total = file.parquet ? file.parquet.totalRows : file.dbf ? Math.max(all, file.dbf.records) : all;
    const cut = total > all ? `${all.toLocaleString('en-US')} of ` : '';
    const parts = [`${cut}${count(total, 'row')} × ${count(cols, 'column')}`];
    if (file.dbf) {
      const from = /** @type {Record<string, string>} */ ({ chosen: 'chosen', cpg: 'from the .cpg file', header: 'from the file', guess: 'guessed' })[file.dbf.encodingSource];
      parts.push(file.dbf.format, `${file.dbf.encodingLabel}${from ? ` (${from})` : ''}`);
      if (file.dbf.deleted) {
        parts.push(`${count(file.dbf.deleted, 'deleted record')} left out`);
      }
    } else if (csv) {
      parts.push(`${DELIMITERS[file.delimiter] ?? file.delimiter}-separated${file.detected ? ' (detected)' : ''}`, file.encoding);
    } else if (kind === 'jsonl') {
      parts.push('JSON Lines', file.encoding);
    } else if (file.parquet) {
      parts.push(`Parquet, ${file.parquet.codecs.map((/** @type {string} */ codec) => CODECS[codec] ?? codec).join(' + ') || 'no data'}`, count(file.parquet.rowGroups, 'row group'));
    } else {
      parts.push(count(file.sheets.length, 'sheet'));
    }
    parts.push(formatSize(file.size));
    $('info').textContent = parts.join('  ·  ');
    $('info').title = file.parquet?.createdBy ? `Written by ${file.parquet.createdBy}` : '';
    const some = filtered();
    $('matches').textContent = some ? `${shown().toLocaleString('en-US')} of ${count(all, 'row')}` : '';
    $('clearFilters').hidden = !some;
    if ($('reapply')) {
      $('reapply').hidden = !stale;
    }
    countSelection();
    showSelection();
  }

  function select(/** @type {number} */ d, /** @type {number} */ c, extend = false, scroll = true) {
    if (!loaded || !shown() || !cols) {
      return;
    }
    active = { row: Math.max(0, Math.min(shown() - 1, d)), col: Math.max(0, Math.min(cols - 1, c)) };
    if (!extend || !anchor) {
      anchor = active;
    }
    // The panel changes the height of the grid, so it comes before the scrolling.
    updateDetail();
    if (scroll) {
      reveal(active.row, active.col);
    }
    updateStatus();
    draw();
  }

  // ---- Copying ------------------------------------------------------------

  /** One field of a line that goes to the clipboard, quoted the way spreadsheets expect when it holds a tab or a line break. */
  function tsvField(/** @type {string} */ value) {
    return /[\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  /** One field of a CSV line, quoted only when it has to be (the rule of `csvField()` in csv.ts). */
  function csvField(/** @type {string} */ value) {
    return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  /**
   * One cell of a Markdown table. A pipe would end the cell and a line break the row; the other
   * characters are escaped where Markdown would read them as markup rather than show them.
   */
  function markdownCell(/** @type {string} */ value) {
    return value
      .replace(/[\\|*`[<]|&(?=#?\w+;)/g, '\\$&')
      // An underscore inside a word is just an underscore, so names like user_id stay readable.
      .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_')
      .replace(/\r\n?|\n/g, '<br>')
      .trim();
  }

  /** The names of the selected columns as keys of an object: none empty, none twice. */
  function uniqueNames(/** @type {number} */ c1, /** @type {number} */ c2) {
    const taken = new Set();
    const keys = [];
    for (let c = c1; c <= c2; c++) {
      const name = label(c) || `Column ${columnName(c)}`;
      let key = name;
      for (let n = 2; taken.has(key); n++) {
        key = `${name}_${n}`;
      }
      taken.add(key);
      keys.push(key);
    }
    return keys;
  }

  /**
   * The selection as text in one of the formats of "Copy as…", or null when there is nothing to
   * copy or too much. A single cell copied plainly is its text as it is.
   */
  function selectionText(format = 'tsv') {
    const selected = range();
    if (!selected) {
      return null;
    }
    const { r1, r2, c1, c2 } = selected;
    const cells = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (cells === 1 && format === 'tsv') {
      const value = cellText(fileRow(r1), c1);
      lastCopy = { text: value, rows: [[value]] };
      return { text: value, what: 'cell' };
    }
    if (cells > MAX_COPY_CELLS) {
      // A text of this size would have to pass through the extension to the clipboard in one piece.
      selectionNote = `Too much to copy: the limit is ${MAX_COPY_CELLS.toLocaleString('en-US')} cells`;
      showSelection();
      return null;
    }
    const what = `${cells === 1 ? 'cell' : `${cells.toLocaleString('en-US')} cells`}${FORMATS[format]}`;
    /** Every selected row as the list of its fields, each passed through `field`. */
    const rows = (/** @type {(value: string, i: number, c: number) => string} */ field) => {
      const out = [];
      for (let d = r1; d <= r2; d++) {
        const r = fileRow(d);
        const fields = [];
        for (let c = c1; c <= c2; c++) {
          const i = cellIndex(r, c);
          fields.push(field(i < 0 ? '' : text.slice(i ? ends[i - 1] : 0, ends[i]), i, c));
        }
        out.push(fields);
      }
      return out;
    };
    const named = !!names || headerOn;

    if (format === 'csv') {
      const out = rows(csvField).map((fields) => fields.join(','));
      // The names come along when the table has them; without a header row the selection is all there is.
      if (named) {
        const header = [];
        for (let c = c1; c <= c2; c++) {
          header.push(csvField(label(c)));
        }
        out.unshift(header.join(','));
      }
      return { text: out.join('\n'), what };
    }

    if (format === 'markdown') {
      // A column of numbers is aligned to the right, as it is in the grid.
      const number = new Uint8Array(c2 - c1 + 1);
      const other = new Uint8Array(c2 - c1 + 1);
      const body = rows((value, i, c) => {
        if (value !== '') {
          (isNumber(i, c) ? number : other)[c - c1] = 1;
        }
        return markdownCell(value);
      });
      const header = [];
      const rule = [];
      for (let c = c1; c <= c2; c++) {
        header.push(markdownCell(label(c) || columnName(c)));
        rule.push(number[c - c1] && !other[c - c1] ? '---:' : '---');
      }
      return { text: [header, rule, ...body].map((fields) => `| ${fields.join(' | ')} |`).join('\n'), what };
    }

    if (format === 'json') {
      const keys = uniqueNames(c1, c2).map((key) => JSON.stringify(key));
      // A number is written with the digits it has in the cell; an empty cell is null; the rest are strings.
      const objects = rows((value, i, c) => `${keys[c - c1]}: ${value === '' ? 'null' : JSON_NUMBER.test(value) && isNumber(i, c) ? value : JSON.stringify(value)}`);
      return { text: `[\n${objects.map((fields) => `  {${fields.join(', ')}}`).join(',\n')}\n]`, what };
    }

    const copied = rows(tsvField).map((fields) => fields.join('\t')).join('\n');
    // Text on the clipboard can't say whether a cell's quotes are its own, so a paste of this very text takes the cells as they are.
    lastCopy = cells <= 100_000 ? { text: copied, rows: rows((value) => value) } : null;
    return { text: copied, what };
  }

  /** The clipboard of a webview isn't always writable from the page, so the extension writes it. */
  function copy(format = 'tsv') {
    const copied = selectionText(format);
    if (copied) {
      vscode.postMessage({ type: 'copy', ...copied });
    }
    return !!copied;
  }

  /** True when the user is copying something else: text in a field, or text marked in the panel. */
  function nativeCopy(/** @type {EventTarget | null} */ target) {
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(/** @type {HTMLElement} */ (target).tagName) || !!String(getSelection());
  }

  // ---- Editing ------------------------------------------------------------

  /**
   * An edit is a list of steps, and a step is one of three things done to rows of the table (see
   * `Op` in csvEdit.ts): `set` gives rows new cells (all of them, or with `at` in the place of
   * cells from that column on), `insert` adds rows, `delete` takes rows out. Rows are numbered as
   * in the table at that moment, rising. A step is applied by building
   * `text`, `ends` and `rowEnds` anew in one pass, so everything that reads them stays as it is,
   * and applying it yields the step that takes it back. The provider keeps both for undo and redo
   * and for writing the file; this page only ever applies steps.
   */

  /** Rows as a text and its two indexes, which is how a step carries them. */
  function flat(/** @type {string[][]} */ rows) {
    let cells = 0;
    for (const row of rows) {
      cells += row.length;
    }
    const cellEnds = new Uint32Array(cells);
    const ends2 = new Uint32Array(rows.length);
    const parts = [];
    let length = 0;
    let o = 0;
    rows.forEach((row, k) => {
      for (const value of row) {
        parts.push(value);
        length += value.length;
        cellEnds[o++] = length;
      }
      ends2[k] = o;
    });
    return { text: parts.join(''), ends: cellEnds, rowEnds: ends2 };
  }

  function rowCells(/** @type {number} */ r) {
    const cells = [];
    for (let i = r ? rowEnds[r - 1] : 0; i < rowEnds[r]; i++) {
      cells.push(text.slice(i ? ends[i - 1] : 0, ends[i]));
    }
    return cells;
  }

  /**
   * Rebuilds the table with rows taken out and put in, and returns the rows that were taken out.
   * `rows` are the rows to replace ('set') or to remove ('delete'), or the numbers the rows of
   * `p` will have ('insert').
   * @param {Uint32Array} rows
   * @param {string} type
   * @param {{text: string, ends: Uint32Array, rowEnds: Uint32Array} | undefined} p
   */
  function spliceRows(rows, type, p) {
    const n = rows.length;
    const put = type !== 'delete' && p;
    const take = type !== 'insert';
    if (put && take && n === rowCount) {
      // Every row at once, as when a column goes in or out: the new table is the one that came.
      const old = { text, ends, rowEnds };
      ({ text, ends, rowEnds } = put);
      return old;
    }
    let gone = 0;
    if (take) {
      for (let k = 0; k < n; k++) {
        gone += rowEnds[rows[k]] - (rows[k] ? rowEnds[rows[k] - 1] : 0);
      }
    }
    const nextEnds = new Uint32Array(ends.length - gone + (put ? put.ends.length : 0));
    const nextRowEnds = new Uint32Array(rowCount + (put ? n : 0) - (take ? n : 0));
    const parts = [];
    const out = take ? { parts: /** @type {string[]} */ ([]), ends: new Uint32Array(gone), rowEnds: new Uint32Array(n), cells: 0, length: 0 } : null;
    /** The next row of the table to carry over, and how much is written: cells, rows, text. */
    let src = 0;
    let o = 0;
    let q = 0;
    let length = 0;
    const carry = (/** @type {number} */ to) => {
      if (to <= src) {
        return;
      }
      const ca = src ? rowEnds[src - 1] : 0;
      const cb = rowEnds[to - 1];
      const ta = ca ? ends[ca - 1] : 0;
      const tb = cb ? ends[cb - 1] : 0;
      parts.push(text.slice(ta, tb));
      const shift = length - ta;
      if (!shift && o === ca) {
        nextEnds.set(ends.subarray(ca, cb), o);
      } else {
        for (let i = ca; i < cb; i++) {
          nextEnds[o + i - ca] = ends[i] + shift;
        }
      }
      o += cb - ca;
      for (let r = src; r < to; r++) {
        nextRowEnds[q++] = rowEnds[r] + o - cb;
      }
      length += tb - ta;
      src = to;
    };
    for (let k = 0; k < n; k++) {
      const at = take ? rows[k] : rows[k] - k;
      carry(at);
      if (out) {
        const ca = at ? rowEnds[at - 1] : 0;
        const cb = rowEnds[at];
        const ta = ca ? ends[ca - 1] : 0;
        const tb = cb ? ends[cb - 1] : 0;
        out.parts.push(text.slice(ta, tb));
        for (let i = ca; i < cb; i++) {
          out.ends[out.cells++] = ends[i] - ta + out.length;
        }
        out.rowEnds[k] = out.cells;
        out.length += tb - ta;
        src = at + 1;
      }
      if (put) {
        const ca = k ? put.rowEnds[k - 1] : 0;
        const cb = put.rowEnds[k];
        const ta = ca ? put.ends[ca - 1] : 0;
        const tb = cb ? put.ends[cb - 1] : 0;
        parts.push(put.text.slice(ta, tb));
        for (let i = ca; i < cb; i++) {
          nextEnds[o++] = put.ends[i] - ta + length;
        }
        nextRowEnds[q++] = o;
        length += tb - ta;
      }
    }
    carry(rowCount);
    text = parts.join('');
    ends = nextEnds;
    rowEnds = nextRowEnds;
    return out ? { text: out.parts.join(''), ends: out.ends, rowEnds: out.rowEnds } : undefined;
  }

  /**
   * Rebuilds the table with other cells in the place of some: in row `rows[k]`, from column `at`
   * on, the cells of row `k` of `p` replace as many cells, or, with `widths`, `widths[k]` of them.
   * Returns the cells that were replaced, as a table like `p`.
   * @param {Uint32Array} rows
   * @param {number} at
   * @param {{text: string, ends: Uint32Array, rowEnds: Uint32Array}} p
   * @param {Uint32Array} [widths]
   */
  function spliceCells(rows, at, p, widths) {
    const n = rows.length;
    let gone = p.ends.length;
    if (widths) {
      gone = 0;
      for (let k = 0; k < n; k++) {
        gone += widths[k];
      }
    }
    const nextEnds = new Uint32Array(ends.length - gone + p.ends.length);
    const parts = [];
    const out = { parts: /** @type {string[]} */ ([]), ends: new Uint32Array(gone), rowEnds: new Uint32Array(n), cells: 0, length: 0 };
    /** The next cell of the table to carry over, and how much is written: cells and text. */
    let src = 0;
    let o = 0;
    let length = 0;
    const carry = (/** @type {number} */ to) => {
      const ta = src ? ends[src - 1] : 0;
      const tb = to ? ends[to - 1] : 0;
      parts.push(text.slice(ta, tb));
      const shift = length - ta;
      if (!shift && o === src) {
        nextEnds.set(ends.subarray(src, to), o);
      } else {
        for (let i = src; i < to; i++) {
          nextEnds[o + i - src] = ends[i] + shift;
        }
      }
      o += to - src;
      length += tb - ta;
      src = to;
    };
    for (let k = 0; k < n; k++) {
      const pa = k ? p.rowEnds[k - 1] : 0;
      const pb = p.rowEnds[k];
      const a = (rows[k] ? rowEnds[rows[k] - 1] : 0) + at;
      const b = a + (widths ? widths[k] : pb - pa);
      carry(a);
      const from = a ? ends[a - 1] : 0;
      const to = b ? ends[b - 1] : 0;
      out.parts.push(text.slice(from, to));
      for (let i = a; i < b; i++) {
        out.ends[out.cells++] = ends[i] - from + out.length;
      }
      out.rowEnds[k] = out.cells;
      out.length += to - from;
      const start = pa ? p.ends[pa - 1] : 0;
      const stop = pb ? p.ends[pb - 1] : 0;
      parts.push(p.text.slice(start, stop));
      for (let i = pa; i < pb; i++) {
        nextEnds[o++] = p.ends[i] - start + length;
      }
      length += stop - start;
      src = b;
    }
    carry(ends.length);
    if (widths) {
      // Rows became longer or shorter, so every row behind the first of them ends elsewhere.
      const nextRowEnds = new Uint32Array(rowCount);
      for (let r = 0, k = 0, moved = 0; r < rowCount; r++) {
        if (k < n && rows[k] === r) {
          moved += p.rowEnds[k] - (k ? p.rowEnds[k - 1] : 0) - widths[k];
          k++;
        }
        nextRowEnds[r] = rowEnds[r] + moved;
      }
      rowEnds = nextRowEnds;
    }
    text = parts.join('');
    ends = nextEnds;
    return { text: out.parts.join(''), ends: out.ends, rowEnds: out.rowEnds };
  }

  /** How many of the rising numbers in `list` are below `value`. */
  function countBelow(/** @type {Uint32Array} */ list, /** @type {number} */ value) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Fits new rows into the rows as shown, while those are filtered or sorted. `before` says, for
   * every new row, which shown row it goes in front of. Without it (an undo, or an edit made in
   * another editor of the file) a row is shown below the row it follows in the file.
   * @param {Uint32Array} rows
   * @param {ArrayLike<number>} [before]
   */
  function orderInsert(rows, before) {
    if (!order) {
      return;
    }
    const n = rows.length;
    // The rows that were there move down by the number of new rows that land in front of them.
    const gaps = rows.map((row, k) => row - k);
    const moved = order.map((row) => row + countBelow(gaps, row + 1));
    let places = before;
    if (!places) {
      const shownAt = new Int32Array(rowCount).fill(-1);
      moved.forEach((row, d) => (shownAt[row] = d));
      const found = new Int32Array(n);
      for (let k = 0; k < n; k++) {
        // A run of new rows stays together, behind the row in front of the first of them.
        found[k] = k && rows[k - 1] === rows[k] - 1 ? found[k - 1] : rows[k] ? shownAt[rows[k] - 1] + 1 : 0;
      }
      places = found;
    }
    const next = new Uint32Array(moved.length + n);
    const byPlace = Array.from({ length: n }, (_, k) => k).sort((a, b) => places[a] - places[b] || a - b);
    let k = 0;
    let o = 0;
    for (let d = 0; d <= moved.length; d++) {
      while (k < n && places[byPlace[k]] <= d) {
        next[o++] = rows[byPlace[k++]];
      }
      if (d < moved.length) {
        next[o++] = moved[d];
      }
    }
    order = next;
  }

  function orderDelete(/** @type {Uint32Array} */ rows) {
    if (!order) {
      return;
    }
    const next = new Uint32Array(order.length);
    let o = 0;
    for (const row of order) {
      const below = countBelow(rows, row);
      if (rows[below] !== row) {
        next[o++] = row - below;
      }
    }
    order = next.slice(0, o);
  }

  /** Moves what is kept by column (widths, filters, the sort, the selection) when columns go in or out. `map` names the old column of every new one. */
  function moveColumns(/** @type {number[]} */ map) {
    const was = widths;
    widths = map.map((from) => (from >= 0 && was[from] !== undefined ? was[from] : NEW_WIDTH));
    const to = (/** @type {number} */ col) => map.indexOf(col);
    const kept = [...filters].map(([col, filter]) => /** @type {[number, {op: string, value: string}]} */ ([to(col), filter])).filter(([col]) => col >= 0);
    filters.clear();
    kept.forEach(([col, filter]) => filters.set(col, filter));
    if (sort) {
      sort = to(sort.col) < 0 ? null : { col: to(sort.col), desc: sort.desc };
    }
    for (const cell of [active, anchor]) {
      if (cell && to(cell.col) >= 0) {
        cell.col = to(cell.col);
      }
    }
  }

  /**
   * Applies one step and returns the step that takes it back.
   * @param {any} op
   */
  function applyOp(op) {
    if (op.type === 'set' && op.at !== undefined) {
      // What took the place of the cells makes way for them again: as many cells as each row was given.
      const given = op.widths && op.table.rowEnds.map((/** @type {number} */ end, /** @type {number} */ k) => end - (k ? op.table.rowEnds[k - 1] : 0));
      const taken = spliceCells(op.rows, op.at, op.table, op.widths);
      if (op.map) {
        moveColumns(op.map);
      }
      return { type: 'set', rows: op.rows, at: op.at, table: taken, widths: given, map: op.unmap, unmap: op.map };
    }
    const taken = spliceRows(op.rows, op.type, op.table);
    rowCount = rowEnds.length;
    if (op.type === 'insert') {
      orderInsert(op.rows, op.before);
      return { type: 'delete', rows: op.rows };
    }
    if (op.type === 'delete') {
      orderDelete(op.rows);
      return { type: 'insert', rows: op.rows, table: taken };
    }
    if (op.map) {
      moveColumns(op.map);
    }
    return { type: 'set', rows: op.rows, table: taken, map: op.unmap, unmap: op.map };
  }

  /** Brings everything that depends on the table in line with it after steps were applied. */
  function afterEdit() {
    cols = 0;
    for (let r = 0; r < rowCount; r++) {
      cols = Math.max(cols, rowEnds[r] - (r ? rowEnds[r - 1] : 0));
    }
    while (widths.length < cols) {
      widths.push(NEW_WIDTH);
    }
    widths.length = cols;
    for (const col of [...filters.keys()]) {
      if (col >= cols) {
        filters.delete(col);
      }
    }
    // Rows stay where they are when an edit would sort them elsewhere or filter them out: nothing moves under the hands.
    stale = !!order;
    const last = shown() - 1;
    if (last < 0 || !cols) {
      active = anchor = null;
    } else {
      for (const cell of [active, anchor]) {
        if (cell) {
          cell.row = Math.min(cell.row, last);
          cell.col = Math.min(cell.col, cols - 1);
        }
      }
    }
    pinned = null;
    layout();
    updateDetail();
    updateStatus();
    showNotice();
    const nothing = !rowCount ? 'The file is empty.' : !shown() ? (filtered() ? 'No rows match the filter.' : 'No rows after the header.') : '';
    showMessage(nothing);
    draw();
  }

  const encoder = new TextEncoder();

  /** A step as it is sent: the text of its rows as UTF-8 bytes, which travel as they are. */
  function wire(/** @type {any} */ op) {
    return { type: op.type, rows: op.rows, at: op.at, widths: op.widths, map: op.map, table: op.table && { text: encoder.encode(op.table.text), ends: op.table.ends, rowEnds: op.table.rowEnds } };
  }

  function unwire(/** @type {any} */ op) {
    const table = op.table && { text: new TextDecoder().decode(typed(op.table.text, Uint8Array)), ends: typed(op.table.ends, Uint32Array), rowEnds: typed(op.table.rowEnds, Uint32Array) };
    return { type: op.type, rows: typed(op.rows, Uint32Array), at: op.at ?? undefined, widths: op.widths ? typed(op.widths, Uint32Array) : undefined, map: op.map ?? undefined, table };
  }

  /** @type {Set<string> | null} */
  let latin = null;

  /** The first character of a text that the encoding of the file can't hold, or an empty string. Only Windows-1252 has such. */
  function firstUnwritable(/** @type {string} */ value) {
    if (file.encoding !== 'Windows-1252') {
      return '';
    }
    // What the decoder makes of the 256 bytes is all that can be written.
    latin ||= new Set(new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i)));
    for (const char of value) {
      if (!latin.has(char)) {
        return char;
      }
    }
    return '';
  }

  /**
   * Makes an edit: applies its steps here, and hands them to the provider with the steps that
   * take them back. VS Code then knows the document as changed, and undo and redo come from there.
   */
  function commit(/** @type {any[]} */ ops, /** @type {string} */ label) {
    const inverse = [];
    for (const op of ops) {
      // Columns that move carry no new text.
      if (op.table && !op.map) {
        unwritable ||= firstUnwritable(op.table.text);
      }
      inverse.unshift(applyOp(op));
    }
    vscode.postMessage({ type: 'edit', version: version++, label, ops: ops.map(wire), inverse: inverse.map(wire) });
    docState.dirty = true;
    afterEdit();
  }

  /** Where a row of the table is shown, or -1. */
  function shownAt(/** @type {number} */ r) {
    return order ? order.indexOf(r) : r >= first() && r < rowCount ? r - first() : -1;
  }

  /** Steps from the provider: an undo, a redo, or an edit made in another editor of the same file. */
  function onOps(/** @type {any} */ msg) {
    if (msg.from !== version) {
      // This page and the provider no longer agree on the table; the provider sends it whole.
      vscode.postMessage({ type: 'reload' });
      return;
    }
    closeEditor(false);
    version = msg.from + 1;
    /** @type {{row: number, col: number} | null} */
    let changed = null;
    for (const raw of msg.ops) {
      const op = unwire(raw);
      const back = applyOp(op);
      if (!changed) {
        let col = active ? active.col : 0;
        if (op.type === 'set' && back.table && !op.map) {
          // The first cell of the first row that differs is where the eye should go.
          const a = rowsOf(op.table, 0);
          const b = rowsOf(back.table, 0);
          col = 0;
          while (col < Math.min(a.length, b.length) - 1 && a[col] === b[col]) {
            col++;
          }
          col += op.at ?? 0;
        }
        changed = { row: op.rows[0], col };
      }
    }
    afterEdit();
    // After an undo or a redo the cell it changed is selected, when it is among the rows shown.
    const d = changed && msg.step ? shownAt(Math.min(changed.row, rowCount - 1)) : -1;
    if (changed && d >= 0) {
      select(d, changed.col);
    }
  }

  function rowsOf(/** @type {{text: string, ends: Uint32Array, rowEnds: Uint32Array}} */ table, /** @type {number} */ k) {
    const cells = [];
    for (let i = k ? table.rowEnds[k - 1] : 0; i < table.rowEnds[k]; i++) {
      cells.push(table.text.slice(i ? table.ends[i - 1] : 0, table.ends[i]));
    }
    return cells;
  }

  /** Text from outside may hold half a surrogate pair, which no encoding can write. */
  function wellFormed(/** @type {string} */ value) {
    return /** @type {any} */ (value).toWellFormed ? /** @type {any} */ (value).toWellFormed() : value;
  }

  /**
   * Gives cells new texts in one edit. `list` holds, in any order, a row of the table and its new
   * cells from column `at` on. Where every row has those cells already, only they change hands;
   * a row that ends before them is made longer, and then whole rows do.
   */
  function setCells(/** @type {[number, string[]][]} */ list, /** @type {number} */ at, /** @type {string} */ label, /** @type {any[]} */ more = []) {
    list.sort((a, b) => a[0] - b[0]);
    const ops = [];
    if (list.length) {
      const rows = Uint32Array.from(list, ([r]) => r);
      if (list.every(([r, values]) => rowEnds[r] - (r ? rowEnds[r - 1] : 0) >= at + values.length)) {
        ops.push({ type: 'set', rows, at, table: flat(list.map(([, values]) => values)) });
      } else {
        const whole = list.map(([r, values]) => {
          const cells = rowCells(r);
          values.forEach((value, j) => {
            // An empty cell isn't added to a row that ends before it.
            if (at + j < cells.length || value !== '') {
              while (cells.length < at + j) {
                cells.push('');
              }
              cells[at + j] = value;
            }
          });
          return cells;
        });
        ops.push({ type: 'set', rows, table: flat(whole) });
      }
    }
    if (ops.length || more.length) {
      commit([...ops, ...more], label);
    }
  }

  /** True when the selection is more than can be changed in one go; says so in the status line. */
  function tooMany(/** @type {number} */ cells) {
    if (cells <= MAX_COPY_CELLS) {
      return false;
    }
    selectionNote = `Too much to change at once: the limit is ${MAX_COPY_CELLS.toLocaleString('en-US')} cells`;
    showSelection();
    return true;
  }

  /** Empties the selected cells. Cells a row doesn't have are left alone. */
  function clearCells() {
    const selected = range();
    if (!editable || !selected || tooMany((selected.r2 - selected.r1 + 1) * (selected.c2 - selected.c1 + 1))) {
      return;
    }
    /** @type {[number, string[]][]} */
    const list = [];
    for (let d = selected.r1; d <= selected.r2; d++) {
      const r = fileRow(d);
      const a = r ? rowEnds[r - 1] : 0;
      const from = a + selected.c1;
      const to = Math.min(a + selected.c2, rowEnds[r] - 1);
      // The lengths are in the index, so a row with nothing to clear costs nothing.
      if (to >= from && ends[to] > (from ? ends[from - 1] : 0)) {
        list.push([r, new Array(to - from + 1).fill('')]);
      }
    }
    setCells(list, selected.c1, 'Clear Cells');
  }

  /** What was copied from this table last: the text that went to the clipboard, and the cells behind it. @type {{text: string, rows: string[][]} | null} */
  let lastCopy = null;

  /**
   * Cells from the clipboard as spreadsheets put them there: rows on lines, cells between tabs,
   * and a cell with a tab or a line break in it in quotes, with quotes inside doubled.
   */
  function parseClipboard(/** @type {string} */ clip) {
    /** @type {string[][]} */
    const rows = [];
    /** @type {string[]} */
    let row = [];
    const n = clip.length;
    const stops = (/** @type {number} */ i) => i >= n || clip[i] === '\t' || clip[i] === '\n' || clip[i] === '\r';
    for (let i = 0; i < n; ) {
      let value;
      if (clip[i] === '"') {
        let out = '';
        for (let j = i + 1; ; ) {
          const close = clip.indexOf('"', j);
          if (close < 0) {
            break;
          }
          out += clip.slice(j, close);
          if (clip[close + 1] === '"') {
            out += '"';
            j = close + 2;
          } else {
            // Quotes that don't close right before the end of the cell are just quotes.
            if (stops(close + 1)) {
              value = out;
              i = close + 1;
            }
            break;
          }
        }
      }
      if (value === undefined) {
        let j = i;
        while (!stops(j)) {
          j++;
        }
        value = clip.slice(i, j);
        i = j;
      }
      row.push(value);
      if (i < n && clip[i] === '\t') {
        i++;
        // A tab at the very end is followed by one more, empty cell.
        if (i >= n) {
          row.push('');
        }
        continue;
      }
      rows.push(row);
      row = [];
      i += clip[i] === '\r' && clip[i + 1] === '\n' ? 2 : 1;
    }
    if (row.length) {
      rows.push(row);
    }
    return rows;
  }

  /**
   * Pastes a block of cells at the selection: one cell fills the whole selection, a block starts
   * at its first cell. Rows are those shown, in the order shown; a block that reaches below the
   * last of them adds rows at the end of the file, and one that reaches beyond the last column
   * makes the rows longer.
   */
  function pasteText(/** @type {string} */ clip) {
    const selected = range();
    if (!editable || !loaded || !selected || !clip) {
      return;
    }
    const block = lastCopy && lastCopy.text === clip ? lastCopy.rows : parseClipboard(wellFormed(clip));
    if (!block.length) {
      return;
    }
    const single = block.length === 1 && block[0].length === 1;
    const height = single ? selected.r2 - selected.r1 + 1 : block.length;
    let width = single ? selected.c2 - selected.c1 + 1 : 0;
    for (const row of single ? [] : block) {
      width = Math.max(width, row.length);
    }
    if (tooMany(height * width)) {
      return;
    }
    const total = shown();
    /** @type {[number, string[]][]} */
    const list = [];
    /** @type {string[][]} */
    const added = [];
    for (let k = 0; k < height; k++) {
      const values = single ? null : block[k];
      const count = values ? values.length : width;
      if (selected.r1 + k >= total) {
        const cells = new Array(selected.c1).fill('').concat(/** @type {string[]} */ (values));
        while (cells.length < cols) {
          cells.push('');
        }
        added.push(cells);
        continue;
      }
      const r = fileRow(selected.r1 + k);
      const next = values ?? new Array(count).fill(block[0][0]);
      // A row that already holds what is pasted into it is not part of the edit.
      if (next.some((value, j) => cellText(r, selected.c1 + j) !== value)) {
        list.push([r, next]);
      }
    }
    const more = added.length ? [{ type: 'insert', rows: Uint32Array.from(added, (_, k) => rowCount + k), table: flat(added), before: added.map(() => total) }] : [];
    setCells(list, selected.c1, 'Paste', more);
    anchor = { row: selected.r1, col: selected.c1 };
    select(selected.r1 + height - 1, selected.c1 + width - 1, true, false);
  }

  /**
   * Ctrl/Cmd+V is answered by VS Code with a `paste` event. Should none come, the clipboard is
   * asked for through the extension (`asked`), and a `paste` event for the same key that turns up
   * late, within a second of the answer (`pastedAt`), is not done again.
   */
  let pasteTimer = 0;
  let asked = false;
  let pastedAt = 0;

  /** Adds an empty row above or below the selection, or at the end of the file when nothing is selected. */
  function insertRow(/** @type {'above' | 'below'} */ where) {
    if (!editable || !loaded) {
      return;
    }
    if (!rowCount && headerOn) {
      // The first row of an empty file is one to type into, not the names of columns that aren't there.
      headerOn = $('header').checked = false;
      saveState();
    }
    const selected = range();
    const total = shown();
    // The row is shown where it was asked for, and lies in the file next to the row it was added at.
    const d = !selected || !total ? total : where === 'above' ? selected.r1 : selected.r2 + 1;
    const r = !selected || !total ? rowCount : where === 'above' ? fileRow(selected.r1) : fileRow(selected.r2) + 1;
    const col = active ? active.col : 0;
    commit([{ type: 'insert', rows: Uint32Array.of(r), table: flat([new Array(Math.max(cols, 1)).fill('')]), before: [d] }], 'Insert Row');
    select(d, col);
  }

  function deleteRows() {
    const selected = range();
    if (!editable || !selected) {
      return;
    }
    const rows = new Uint32Array(selected.r2 - selected.r1 + 1);
    for (let d = selected.r1; d <= selected.r2; d++) {
      rows[d - selected.r1] = fileRow(d);
    }
    rows.sort();
    const col = active ? active.col : 0;
    commit([{ type: 'delete', rows }], rows.length === 1 ? 'Delete Row' : 'Delete Rows');
    if (shown()) {
      select(Math.min(selected.r1, shown() - 1), col);
    }
  }

  /**
   * Puts an empty column in at `at`, or takes the column there out, in every row that reaches
   * it. Only the cells of that column change hands: an empty one in the place of none, or none in
   * the place of one. A row that would be left without a cell keeps an empty one.
   */
  function changeColumn(/** @type {number} */ at, /** @type {boolean} */ insert) {
    if (!editable || !loaded || (!insert && cols < 2)) {
      return;
    }
    const rows = new Uint32Array(rowCount);
    const given = new Uint32Array(rowCount);
    let n = 0;
    let cells = 0;
    for (let r = 0; r < rowCount; r++) {
      const length = rowEnds[r] - (r ? rowEnds[r - 1] : 0);
      if (insert ? length >= at : length > at) {
        rows[n] = r;
        cells += insert || length === 1 ? 1 : 0;
        given[n++] = cells;
      }
    }
    if (!n) {
      return;
    }
    // The cells that go in are all empty: no text, and every one of them ends where it begins.
    const table = { text: '', ends: new Uint32Array(cells), rowEnds: given.slice(0, n) };
    const map = Array.from({ length: cols + (insert ? 1 : -1) }, (_, c) => (c < at ? c : insert ? (c === at ? -1 : c - 1) : c + 1));
    const unmap = Array.from({ length: cols }, (_, c) => (c < at ? c : insert ? c + 1 : c === at ? -1 : c - 1));
    closeColumnFilter();
    commit([{ type: 'set', rows: rows.slice(0, n), at, widths: new Uint32Array(n).fill(insert ? 0 : 1), table, map, unmap }], insert ? 'Insert Column' : 'Delete Column');
  }

  // ---- The cell editor ----------------------------------------------------

  const editor = /** @type {HTMLTextAreaElement | null} */ ($('editor'));
  /** The cell that is being edited: its row in the table and its column, where it is shown (-1: it is a column name), and its text before. @type {{r: number, col: number, d: number, was: string} | null} */
  let editing = null;

  /** Opens the editor on a cell as shown, or on a column name with `d` of -1. `typed` starts it empty, for the key that opened it. */
  function openEditor(/** @type {number} */ d, /** @type {number} */ col, typedOver = false) {
    if (!editor || !editable || !loaded || col < 0 || col >= cols || (d < 0 ? !first() : d >= shown())) {
      return;
    }
    closeEditor(true);
    closeMenu();
    closeColumnMenu();
    closeColumnFilter();
    const r = d < 0 ? 0 : fileRow(d);
    if (d >= 0) {
      reveal(d, col);
    }
    editing = { r, col, d, was: cellText(r, col) };
    // A text field knows one kind of line break; the one the cell has is put back when it is closed.
    editor.value = typedOver ? '' : editing.was.replace(/\r\n?/g, '\n');
    editor.hidden = false;
    editor.classList.toggle('name', d < 0);
    editor.classList.toggle('num', d >= 0 && isNumber(cellIndex(r, col), col));
    placeEditor();
    editor.focus({ preventScroll: true });
    // A name is usually replaced, a cell more often added to.
    editor.setSelectionRange(d < 0 ? 0 : editor.value.length, editor.value.length);
  }

  /** Keeps the editor over its cell, and as large as its text needs. */
  function placeEditor() {
    if (!editor || !editing) {
      return;
    }
    const lines = editor.value.split('\n');
    const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
    const width = Math.max(widths[editing.col], Math.min(MAX_EDITOR_WIDTH, measure([[longest, '']])[0] + CELL_EXTRA + 4));
    const height = (editing.d < 0 ? HEAD : ROW) + (Math.min(lines.length, MAX_EDITOR_LINES) - 1) * (ROW - 1);
    editor.style.left = `${gutter + lefts[editing.col]}px`;
    // A column name sits in the header, which stays at the top of the window.
    editor.style.top = `${editing.d < 0 ? wrap.scrollTop : HEAD + wrap.scrollTop - virtualTop() + editing.d * ROW}px`;
    editor.style.width = `${width}px`;
    editor.style.height = `${height}px`;
  }

  /** Closes the editor, and with `save` makes an edit of its text when that differs from the cell's. */
  function closeEditor(/** @type {boolean} */ save) {
    const cell = editing;
    if (!editor || !cell) {
      return;
    }
    editing = null;
    const focused = document.activeElement === editor;
    editor.hidden = true;
    if (focused) {
      wrap.focus({ preventScroll: true });
    }
    let value = wellFormed(editor.value);
    if (save && value !== cell.was.replace(/\r\n?/g, '\n')) {
      // A cell whose lines ended with CR LF goes on having such lines.
      if (/\r\n/.test(cell.was) && !/(^|[^\r])\n/.test(cell.was)) {
        value = value.replace(/\n/g, '\r\n');
      }
      setCells([[cell.r, [value]]], cell.col, cell.d < 0 ? 'Rename Column' : 'Edit Cell');
    }
  }

  if (editor) {
    editor.addEventListener('input', placeEditor);
    // A click elsewhere, or leaving the tab, keeps what was typed.
    editor.addEventListener('blur', () => closeEditor(true));
    editor.addEventListener('keydown', (e) => {
      const command = e.metaKey || e.ctrlKey;
      const cell = editing;
      if (e.isComposing || !cell) {
        return;
      }
      if (e.key === 'Enter' && (e.altKey || command)) {
        // A line break inside the cell. Inserted as typing, so that the text field can undo it.
        e.preventDefault();
        e.stopPropagation();
        document.execCommand('insertText', false, '\n');
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        closeEditor(true);
        if (cell.d >= 0) {
          const step = e.shiftKey ? -1 : 1;
          select(cell.d + (e.key === 'Enter' ? step : 0), cell.col + (e.key === 'Tab' ? step : 0));
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeEditor(false);
      } else if (command && ['z', 'y'].includes(e.key.toLowerCase())) {
        // The text field undoes its own typing. VS Code must not hear of the key, or it would undo the last edit of the table.
        e.stopPropagation();
      } else if (command && e.key.toLowerCase() === 's') {
        // What was typed is part of what is saved.
        closeEditor(true);
      }
    });
  }

  // ---- Menu and column filter ---------------------------------------------

  /** The funnel in a column header, drawn once and copied into each. */
  const FUNNEL = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  FUNNEL.setAttribute('viewBox', '0 0 12 12');
  FUNNEL.append(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
  /** @type {Element} */ (FUNNEL.firstChild).setAttribute('d', 'M1 1.5h10L7.2 6.3v3.6L4.8 11V6.3z');

  const OPERATORS = /** @type {Record<string, string>} */ ({
    contains: 'contains',
    notContains: 'does not contain',
    equals: 'equals',
    starts: 'starts with',
    ends: 'ends with',
    eq: '=',
    ne: '≠',
    gt: '>',
    ge: '≥',
    lt: '<',
    le: '≤',
    empty: 'is empty',
    notEmpty: 'is not empty',
  });

  function describe(/** @type {{op: string, value: string}} */ filter) {
    return filter.op === 'empty' || filter.op === 'notEmpty' ? OPERATORS[filter.op] : `${OPERATORS[filter.op]} ${filter.value}`;
  }

  /** Puts a popup at a point of the window, moved back inside when it would stick out. */
  function place(/** @type {HTMLElement} */ popup, /** @type {number} */ x, /** @type {number} */ y) {
    popup.hidden = false;
    popup.style.left = `${Math.max(4, Math.min(x, window.innerWidth - popup.offsetWidth - 4))}px`;
    popup.style.top = `${Math.max(4, Math.min(y, window.innerHeight - popup.offsetHeight - 4))}px`;
  }

  /** The cell a menu was opened on with the right button, for the entry that filters by its value. @type {{row: number, col: number} | null} */
  let menuCell = null;

  function openMenu(/** @type {number} */ x, /** @type {number} */ y, /** @type {{row: number, col: number} | null} */ cell = null) {
    closeColumnFilter();
    closeColumnMenu();
    menuCell = cell;
    $('menuFilter').hidden = !cell;
    for (const item of $('copyMenu').querySelectorAll('[data-edit]')) {
      item.hidden = !editable;
    }
    place($('copyMenu'), x, y);
    $('copyMenu').querySelector('button').focus();
  }

  function closeMenu(focusGrid = false) {
    if (!$('copyMenu').hidden) {
      $('copyMenu').hidden = true;
      if (focusGrid) {
        wrap.focus({ preventScroll: true });
      }
    }
  }

  /** The column whose menu is open (delimited text only: rename, insert, delete), or -1. */
  let menuCol = -1;

  function openColumnMenu(/** @type {number} */ col, /** @type {number} */ x, /** @type {number} */ y) {
    closeMenu();
    closeColumnFilter();
    closeEditor(true);
    menuCol = col;
    const menu = $('columnMenu');
    menu.querySelector('[data-column=rename]').disabled = !first();
    menu.querySelector('[data-column=rename]').title = first() ? '' : 'The names of the columns are the first row of the file: switch "First row is header" on to edit them here';
    menu.querySelector('[data-column=delete]').disabled = cols < 2;
    place(menu, x, y);
    menu.querySelector('button:not(:disabled)').focus();
  }

  function closeColumnMenu(focusGrid = false) {
    if (menuCol >= 0) {
      menuCol = -1;
      $('columnMenu').hidden = true;
      if (focusGrid) {
        wrap.focus({ preventScroll: true });
      }
    }
  }

  /** The keys of a menu: the arrows walk through its entries, Escape and Tab close it. */
  function menuKeys(/** @type {HTMLElement} */ menu, /** @type {() => void} */ close) {
    menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      const items = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('button:not([hidden]):not(:disabled)')]);
      const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
  }

  /** The column whose filter is open in the popup, or -1. */
  let filterCol = -1;
  let columnTimer = 0;

  function openColumnFilter(/** @type {number} */ col) {
    closeMenu();
    closeColumnMenu();
    filterCol = col;
    const filter = filters.get(col);
    $('columnFilterTitle').textContent = label(col) || `Column ${columnName(col)}`;
    // A column of numbers is more often compared than searched.
    $('filterOp').value = filter?.op ?? (numeric?.[col] ? 'eq' : 'contains');
    $('filterValue').value = filter?.value ?? '';
    showFilterValue();
    const box = wrap.getBoundingClientRect();
    // The scroll listener closes the popup when the columns move; the place it opens at is where they are now.
    scrolledLeft = wrap.scrollLeft;
    place($('columnFilter'), box.left + gutter + lefts[col] - wrap.scrollLeft, box.top + HEAD + 2);
    ($('filterValue').hidden ? $('filterOp') : $('filterValue')).focus();
    $('filterValue').select();
  }

  function closeColumnFilter(focusGrid = false) {
    if (filterCol < 0) {
      return;
    }
    // What was typed in the last moment still counts.
    applyColumnFilter();
    filterCol = -1;
    $('columnFilter').hidden = true;
    if (focusGrid) {
      wrap.focus({ preventScroll: true });
    }
  }

  /** The value field goes away for the tests that need none, and turns red while a comparison has no number to compare with. */
  function showFilterValue() {
    const op = $('filterOp').value;
    const filter = { op, value: $('filterValue').value };
    $('filterValue').hidden = op === 'empty' || op === 'notEmpty';
    $('filterValue').placeholder = ['eq', 'ne', 'gt', 'ge', 'lt', 'le'].includes(op) ? 'Number' : 'Text';
    $('filterValue').classList.toggle('invalid', filter.value !== '' && !isComplete(filter));
  }

  /** Takes the filter over from the popup, and works out the rows again if that changes which ones pass. */
  function applyColumnFilter() {
    clearTimeout(columnTimer);
    if (filterCol < 0) {
      return;
    }
    const before = filters.get(filterCol);
    const next = { op: $('filterOp').value, value: $('filterValue').value };
    const was = before && isComplete(before) ? describe(before) : '';
    filters.set(filterCol, next);
    if ((isComplete(next) ? describe(next) : '') !== was) {
      rebuild();
    }
  }

  function clearFilters() {
    closeColumnFilter();
    const some = filtered();
    filters.clear();
    needle = '';
    $('filter').value = '';
    if (some) {
      rebuild();
    }
  }

  // ---- Loading ------------------------------------------------------------

  /** Typed arrays arrive as such from VS Code; anything else that holds the same bytes is accepted too. */
  function typed(/** @type {any} */ value, /** @type {any} */ Type) {
    if (value instanceof Type) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Type(value);
    }
    return new Type(value.buffer, value.byteOffset, value.byteLength / Type.BYTES_PER_ELEMENT);
  }

  function clearTable() {
    closeMenu();
    closeColumnMenu();
    closeColumnFilter();
    closeEditor(false);
    text = '';
    ends = rowEnds = new Uint32Array(0);
    nums = merges = lines = numeric = null;
    names = types = details = null;
    rowCount = cols = 0;
    loaded = false;
    order = null;
    active = anchor = null;
    draw();
    updateDetail();
    updateStatus();
  }

  function renderSheets() {
    const tabs = file.sheets.map((/** @type {any} */ sheet, /** @type {number} */ i) => {
      const tab = el('button', sheet.hidden ? 'sheet hiddenSheet' : 'sheet', sheet.name);
      tab.classList.toggle('active', i === sheetIndex);
      tab.title = `${sheet.name}${sheet.hidden ? ' (hidden in the workbook)' : ''}\n${count(sheet.rows, 'row')} × ${count(sheet.cols, 'column')}`;
      if (sheet.hidden) {
        tab.append(el('span', 'badge', 'hidden'));
      }
      tab.addEventListener('click', () => openSheet(i));
      return tab;
    });
    $('sheets').replaceChildren(...tabs);
    $('sheets').hidden = !sheet;
  }

  function openSheet(/** @type {number} */ index) {
    if (index === sheetIndex && loaded) {
      return;
    }
    sheetIndex = index;
    sheetName = file.sheets[index].name;
    saveState();
    clearTable();
    renderSheets();
    showMessage('Loading…');
    vscode.postMessage({ type: 'sheet', load: file.load, index });
  }

  /** What the file had that the table doesn't show: broken lines, rows beyond the limit, columns that could not be read. */
  function showNotice() {
    const parts = [];
    if (file?.broken) {
      const listed = /** @type {{line: number, message: string}[]} */ (file.firstBroken);
      parts.push(`${count(file.broken, 'line')} ${file.broken === 1 ? "isn't" : "aren't"} valid JSON and ${file.broken === 1 ? 'is' : 'are'} left out:`);
      for (const { line, message } of listed) {
        const link = el('button', 'link', `line ${line.toLocaleString('en-US')}`);
        link.title = `${message}\nClick to open the file at this line`;
        link.addEventListener('click', () => vscode.postMessage({ type: 'openSource', line }));
        parts.push(link);
      }
      if (file.broken > listed.length) {
        parts.push(`and ${(file.broken - listed.length).toLocaleString('en-US')} more.`);
      }
    }
    if (file?.parquet && loaded && file.parquet.totalRows > file.parquet.rows) {
      parts.push(`This file has ${count(file.parquet.totalRows, 'row')}; the first ${file.parquet.rows.toLocaleString('en-US')} are shown.`);
    }
    if (file?.parquet?.warning) {
      parts.push(file.parquet.warning);
    }
    if (file?.dbf && loaded) {
      if (file.dbf.memo === 'missing') {
        parts.push('The memo file of this table (.dbt or .fpt) is not next to it, so memo fields show (memo) instead of their text.');
      }
      if (file.dbf.warning) {
        parts.push(file.dbf.warning);
      }
    }
    if (editable && loaded) {
      if (docState.changedOnDisk) {
        const revert = el('button', 'link', 'Load the file from disk');
        revert.title = 'Drops the changes made here, as "File: Revert File" does';
        revert.addEventListener('click', () => vscode.postMessage({ type: 'revert' }));
        parts.push('The file has changed on disk. Your unsaved changes are kept, and saving asks before it replaces the newer file.', revert);
      }
      if (docState.textDirty) {
        parts.push('This file has unsaved changes in a text editor, which the table does not show.');
      }
      if (unwritable && docState.dirty) {
        parts.push(`This file is ${file.encoding}, which has no “${unwritable}”. Saving will offer to write the file as UTF-8 instead.`);
      }
    }
    $('notice').replaceChildren(...parts.flatMap((part) => [part, ' ']));
    $('notice').hidden = !parts.length;
  }

  function onFile(/** @type {any} */ msg) {
    file = msg;
    editable = !!msg.editable;
    if ($('addRow')) {
      $('addRow').hidden = !editable;
    }
    if (msg.state) {
      setDocState(msg.state);
    }
    if (dbf && msg.encodings) {
      const select = $('encoding');
      if (select.options.length === 1) {
        for (const { id, label } of msg.encodings) {
          const option = el('option', '', label);
          /** @type {HTMLOptionElement} */ (option).value = id;
          select.append(option);
        }
      }
      select.value = msg.chosen || '';
    }
    showNotice();
    if (msg.error) {
      sheetIndex = -1;
      $('sheets').hidden = true;
      clearTable();
      showMessage(msg.error);
      return;
    }
    if (!sheet) {
      // The table follows right behind, without being asked for.
      if (csv) {
        $('delimiter').value = msg.detected ? '' : msg.delimiter;
      }
      sheetIndex = 0;
      return;
    }
    // The sheet that was on screen stays there, under its name; otherwise the first one that isn't hidden.
    const sheets = /** @type {any[]} */ (msg.sheets);
    let index = sheets.findIndex((sheet) => sheet.name === sheetName);
    if (index < 0) {
      index = Math.max(0, sheets.findIndex((sheet) => !sheet.hidden));
    }
    sheetIndex = index;
    renderSheets();
    if (!sheets.length) {
      clearTable();
      showMessage('The workbook has no sheets.');
      return;
    }
    if (!loaded) {
      showMessage('Loading…');
    }
    // While the new version is on its way, the old one stays on screen.
    vscode.postMessage({ type: 'sheet', load: msg.load, index });
  }

  /** Takes over what the provider says about the document. The delimiter can't be changed under edits that were made with another. */
  function setDocState(/** @type {typeof docState} */ state) {
    docState = { dirty: !!state.dirty, changedOnDisk: !!state.changedOnDisk, textDirty: !!state.textDirty };
    if (!docState.dirty) {
      unwritable = '';
    }
    $('delimiter').disabled = docState.dirty;
    $('delimiter').title = docState.dirty ? 'Save or revert the changes to the table before choosing another delimiter' : 'The character that separates the fields';
  }

  function onTable(/** @type {any} */ msg) {
    if (!file || msg.load !== file.load || msg.index !== sheetIndex) {
      return;
    }
    const name = file.sheets[sheetIndex].name;
    const previous = { name: loaded ? sheetName : null, cols, top: wrap.scrollTop, left: wrap.scrollLeft };
    closeMenu();
    closeColumnMenu();
    closeColumnFilter();
    closeEditor(false);
    version = msg.version ?? 0;
    text = new TextDecoder().decode(msg.text);
    ends = typed(msg.ends, Uint32Array);
    rowEnds = typed(msg.rowEnds, Uint32Array);
    nums = msg.nums ? typed(msg.nums, Float64Array) : null;
    merges = msg.merges?.length ? typed(msg.merges, Uint32Array) : null;
    names = msg.names ?? null;
    lines = msg.lines ? typed(msg.lines, Uint32Array) : null;
    types = msg.types ?? null;
    details = msg.details ?? null;
    numeric = msg.numeric ? typed(msg.numeric, Uint8Array) : null;
    rowCount = rowEnds.length;
    cols = names ? names.length : 0;
    if (!names) {
      for (let r = 0; r < rowCount; r++) {
        cols = Math.max(cols, rowEnds[r] - (r ? rowEnds[r - 1] : 0));
      }
    }
    loaded = true;
    sheetName = name;
    saveState();
    showNotice();
    // A new version of the table that was on screen keeps its widths, sort, column filters and place.
    const same = previous.name === name && previous.cols === cols;
    if (!same) {
      sort = null;
      filters.clear();
      fitColumns();
    }
    rebuild();
    if (same) {
      wrap.scrollTop = previous.top;
      wrap.scrollLeft = previous.left;
    } else {
      wrap.scrollLeft = 0;
    }
    draw();
  }

  // ---- Events -------------------------------------------------------------

  /** @param {EventTarget | null} target */
  function cellOf(target) {
    const node = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (target).closest?.('.cell, .gutter'));
    return node ? { row: Number(node.dataset.row), col: node.dataset.col === undefined ? -1 : Number(node.dataset.col) } : null;
  }

  /** What the pointer is doing between a press and its release. @type {'cells' | 'rows' | {col: number, x: number, width: number} | null} */
  let drag = null;

  $('rows').addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
    const at = cellOf(e.target);
    if (!at || e.button !== 0) {
      return;
    }
    e.preventDefault();
    wrap.focus({ preventScroll: true });
    getSelection()?.removeAllRanges();
    if (at.col < 0) {
      // A row number selects the row.
      drag = 'rows';
      if (!e.shiftKey || !anchor) {
        anchor = { row: at.row, col: 0 };
      }
      select(at.row, cols - 1, true, false);
    } else {
      drag = 'cells';
      // A click must not scroll: the cell under the pointer would move away from it.
      select(at.row, at.col, e.shiftKey, false);
      // The second press of a double click. A `dblclick` event would not name the cell: the first press has drawn the rows anew.
      if (e.detail === 2 && editable && !e.shiftKey) {
        drag = null;
        openEditor(at.row, at.col);
      }
    }
  });

  // The right button opens the copy menu on the selection, or on the cell under it when that lies outside.
  $('rows').addEventListener('contextmenu', (/** @type {MouseEvent} */ e) => {
    const at = cellOf(e.target);
    if (!at) {
      return;
    }
    e.preventDefault();
    wrap.focus({ preventScroll: true });
    const selected = range();
    const inside = selected && at.row >= selected.r1 && at.row <= selected.r2 && (at.col < 0 || (at.col >= selected.c1 && at.col <= selected.c2));
    if (!inside) {
      if (at.col < 0) {
        anchor = { row: at.row, col: 0 };
        select(at.row, cols - 1, true, false);
      } else {
        select(at.row, at.col, false, false);
      }
    }
    openMenu(e.clientX, e.clientY, at.col < 0 ? null : at);
  });

  // On a column name of a file that is edited, the right button opens the menu of the column.
  $('head').addEventListener('contextmenu', (/** @type {MouseEvent} */ e) => {
    const th = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.th'));
    if (th && editable && $('columnMenu')) {
      e.preventDefault();
      openColumnMenu(Number(th.dataset.col), e.clientX, e.clientY);
    }
  });

  $('head').addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const th = /** @type {HTMLElement | null} */ (target.closest('.th'));
    if (target.classList.contains('resize') && th && e.button === 0) {
      e.preventDefault();
      const col = Number(th.dataset.col);
      drag = { col, x: e.clientX, width: widths[col] };
      document.body.classList.add('resizing');
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag) {
      return;
    }
    if (typeof drag === 'object') {
      widths[drag.col] = Math.max(MIN_WIDTH, Math.round(drag.width + e.clientX - drag.x));
      layout();
      schedule();
      return;
    }
    const at = cellOf(e.target);
    if (at && active && (at.row !== active.row || (drag === 'cells' && at.col >= 0 && at.col !== active.col))) {
      select(at.row, drag === 'rows' ? cols - 1 : at.col < 0 ? active.col : at.col, true, false);
    }
  });

  document.addEventListener('mouseup', () => {
    if (drag && typeof drag === 'object') {
      document.body.classList.remove('resizing');
      updateDetail();
    }
    drag = null;
  });

  // A press anywhere else puts the popups away. The header is left out: its funnel opens and closes the filter itself.
  document.addEventListener(
    'mousedown',
    (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (!target.closest('#copyMenu, #copyAs')) {
        closeMenu();
      }
      if (!target.closest('#columnMenu')) {
        closeColumnMenu();
      }
      if (!target.closest('#columnFilter, .funnel')) {
        closeColumnFilter();
      }
    },
    true,
  );

  $('head').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    // A redraw between the press and the release puts new elements under the pointer, and the click is then
    // reported for the header as a whole. What lies under the pointer now is what was clicked.
    const target = /** @type {HTMLElement} */ (e.target === $('head') ? (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) : e.target);
    if (target.classList.contains('resize')) {
      return;
    }
    if (target.closest('.corner')) {
      anchor = { row: 0, col: 0 };
      select(shown() - 1, cols - 1, true, false);
      return;
    }
    const th = /** @type {HTMLElement | null} */ (target.closest('.th'));
    if (!th) {
      return;
    }
    const col = Number(th.dataset.col);
    if (target.closest('.funnel')) {
      if (filterCol === col) {
        closeColumnFilter(true);
      } else {
        closeColumnFilter();
        openColumnFilter(col);
      }
      return;
    }
    // Ascending, descending, then back to the order of the file.
    sort = sort?.col !== col ? { col, desc: false } : sort.desc ? null : { col, desc: true };
    rebuild();
  });

  $('head').addEventListener('dblclick', (/** @type {MouseEvent} */ e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const th = /** @type {HTMLElement | null} */ (target.closest('.th'));
    if (!target.classList.contains('resize') || !th) {
      return;
    }
    closeEditor(true);
    // Fits the column to the rows around the window.
    const col = Number(th.dataset.col);
    const from = Math.max(0, Math.floor(virtualTop() / ROW) - 500);
    let longest = -1;
    let length = 0;
    for (let d = from; d < Math.min(shown(), from + 2000); d++) {
      const i = cellIndex(fileRow(d), col);
      if (i >= 0 && ends[i] - (i ? ends[i - 1] : 0) > length) {
        length = ends[i] - (i ? ends[i - 1] : 0);
        longest = i;
      }
    }
    const [header, type, cell] = measure(columnTexts(col, longest));
    widths[col] = columnWidth(header, type, cell, 1200);
    layout();
    updateDetail();
    draw();
  });

  let scrolledLeft = 0;
  wrap.addEventListener('scroll', () => {
    // The popup of a column filter hangs under its header, which has just moved away.
    if (wrap.scrollLeft !== scrolledLeft) {
      scrolledLeft = wrap.scrollLeft;
      closeColumnFilter();
    }
    schedule();
  });
  new ResizeObserver(schedule).observe(wrap);

  let filterTimer = 0;
  $('filter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      const next = $('filter').value.toLowerCase();
      if (next !== needle) {
        needle = next;
        rebuild();
      }
    }, 200);
  });

  $('clearFilters').addEventListener('click', () => {
    clearFilters();
    wrap.focus({ preventScroll: true });
  });

  $('filterOp').addEventListener('change', () => {
    showFilterValue();
    applyColumnFilter();
    if (!$('filterValue').hidden) {
      $('filterValue').focus();
    }
  });
  $('filterValue').addEventListener('input', () => {
    showFilterValue();
    clearTimeout(columnTimer);
    columnTimer = setTimeout(applyColumnFilter, 200);
  });
  $('filterRemove').addEventListener('click', () => {
    const col = filterCol;
    const before = filters.get(col);
    clearTimeout(columnTimer);
    filterCol = -1;
    $('columnFilter').hidden = true;
    filters.delete(col);
    wrap.focus({ preventScroll: true });
    if (before && isComplete(before)) {
      rebuild();
    } else {
      draw();
    }
  });
  $('filterClose').addEventListener('click', () => closeColumnFilter(true));
  $('columnFilter').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && /** @type {HTMLElement} */ (e.target).tagName !== 'BUTTON')) {
      e.preventDefault();
      e.stopPropagation();
      closeColumnFilter(true);
    }
  });

  $('copyAs').addEventListener('click', () => {
    if (!$('copyMenu').hidden) {
      closeMenu(true);
      return;
    }
    const box = $('copyAs').getBoundingClientRect();
    openMenu(box.left, box.bottom + 2);
  });
  $('copyMenu').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button'));
    if (!item) {
      return;
    }
    closeMenu(true);
    if (item.dataset.format) {
      copy(item.dataset.format);
    } else if (item.dataset.edit) {
      editFromMenu(item.dataset.edit);
    } else if (menuCell) {
      // Keeps the rows that have, in this column, what the cell has.
      const value = cellText(fileRow(menuCell.row), menuCell.col);
      filters.set(menuCell.col, value === '' ? { op: 'empty', value: '' } : { op: 'equals', value });
      rebuild();
    }
  });
  menuKeys($('copyMenu'), () => closeMenu(true));

  /** The entries of the menu that change the table. */
  function editFromMenu(/** @type {string} */ what) {
    if (what === 'cut') {
      if (copy()) {
        clearCells();
      }
    } else if (what === 'paste') {
      // A page can't read the clipboard by itself, so the extension does.
      vscode.postMessage({ type: 'readClipboard' });
    } else if (what === 'clear') {
      clearCells();
    } else if (what === 'deleteRows') {
      deleteRows();
    } else {
      insertRow(what === 'above' ? 'above' : 'below');
    }
  }

  if ($('columnMenu')) {
    menuKeys($('columnMenu'), () => closeColumnMenu(true));
    $('columnMenu').addEventListener('click', (/** @type {MouseEvent} */ e) => {
      const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button'));
      const col = menuCol;
      if (!item || col < 0) {
        return;
      }
      closeColumnMenu(true);
      if (item.dataset.column === 'rename') {
        wrap.scrollLeft = Math.min(wrap.scrollLeft, lefts[col]);
        openEditor(-1, col);
      } else {
        changeColumn(item.dataset.column === 'right' ? col + 1 : col, item.dataset.column !== 'delete');
      }
    });
  }
  $('addRow')?.addEventListener('click', () => {
    wrap.focus({ preventScroll: true });
    insertRow('below');
  });
  $('reapply')?.addEventListener('click', () => {
    wrap.focus({ preventScroll: true });
    rebuild();
  });

  if ($('header')) {
    $('header').checked = headerOn;
    $('header').addEventListener('change', () => {
      headerOn = $('header').checked;
      saveState();
      // Back to the grid, so that the arrow keys move through the cells again.
      wrap.focus({ preventScroll: true });
      if (loaded) {
        fitColumns();
        rebuild();
      }
    });
  }

  if (dbf) {
    $('encoding').addEventListener('change', () => {
      saveState();
      $('info').textContent = 'Loading…';
      vscode.postMessage({ type: 'encoding', value: $('encoding').value });
    });
  }
  if (csv) {
    $('delimiter').value = saved.delimiter || '';
    $('delimiter').addEventListener('change', () => {
      saveState();
      $('info').textContent = 'Loading…';
      vscode.postMessage({ type: 'delimiter', value: $('delimiter').value });
    });
  }
  $('openSource')?.addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));
  $('export')?.addEventListener('click', () => {
    if (loaded) {
      $('export').disabled = true;
      vscode.postMessage({ type: 'export', index: sheetIndex });
    }
  });

  document.addEventListener('copy', (e) => {
    const copied = nativeCopy(e.target) ? null : selectionText();
    if (copied && e.clipboardData) {
      e.clipboardData.setData('text/plain', copied.text);
      e.preventDefault();
    }
  });

  document.addEventListener('cut', (e) => {
    const copied = !editable || nativeCopy(e.target) ? null : selectionText();
    if (copied && e.clipboardData) {
      e.clipboardData.setData('text/plain', copied.text);
      e.preventDefault();
      clearCells();
    }
  });

  document.addEventListener('paste', (e) => {
    if (!editable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(/** @type {HTMLElement} */ (e.target).tagName)) {
      return;
    }
    e.preventDefault();
    clearTimeout(pasteTimer);
    // The provider was asked for the clipboard a moment ago, and that paste is done.
    if (Date.now() - pastedAt > 1000) {
      pasteText(e.clipboardData?.getData('text/plain') ?? '');
    }
  });

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const command = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (command && key === 'f') {
      e.preventDefault();
      closeMenu();
      closeColumnFilter();
      $('filter').focus();
      $('filter').select();
      return;
    }
    if (target === $('filter') && (key === 'Escape' || key === 'Enter' || key === 'ArrowDown')) {
      e.preventDefault();
      if (key === 'Escape' && $('filter').value) {
        $('filter').value = '';
        needle = '';
        rebuild();
      }
      wrap.focus({ preventScroll: true });
      if (key !== 'Escape' && !active) {
        select(0, 0);
      }
      return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || !loaded || !cols) {
      return;
    }
    // As in a spreadsheet: Alt with the down arrow opens the filter of the column the selection is in.
    if (e.altKey && key === 'ArrowDown' && active) {
      e.preventDefault();
      reveal(active.row, active.col);
      openColumnFilter(active.col);
      return;
    }
    // As in the text editor: Ctrl/Cmd+Enter adds a line below, with Shift above, and Ctrl/Cmd+Shift+K deletes lines.
    if (editable && command && !e.altKey && key === 'Enter') {
      e.preventDefault();
      insertRow(e.shiftKey ? 'above' : 'below');
      return;
    }
    if (e.altKey || !shown()) {
      return;
    }
    if (command && key === 'c') {
      if (!nativeCopy(target) && copy()) {
        e.preventDefault();
      }
      return;
    }
    if (editable && command && e.shiftKey && key === 'k') {
      e.preventDefault();
      deleteRows();
      return;
    }
    if (editable && command && key === 'x') {
      // The `cut` event does the same where it arrives; the second clearing finds nothing to clear.
      if (!nativeCopy(target) && copy()) {
        clearCells();
      }
      return;
    }
    if (editable && command && key === 'v') {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        asked = true;
        vscode.postMessage({ type: 'readClipboard' });
      }, 150);
      return;
    }
    if (editable && active && !command) {
      if (key === 'Enter' || key === 'F2') {
        e.preventDefault();
        openEditor(active.row, active.col);
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        e.preventDefault();
        clearCells();
        return;
      }
      // Typing starts over in the cell; the key itself lands in the editor, which has the focus by then.
      if (e.key.length === 1 || e.key === 'Process' || e.key === 'Dead') {
        openEditor(active.row, active.col, true);
        return;
      }
    }
    if (command && key === 'a') {
      e.preventDefault();
      anchor = { row: 0, col: 0 };
      select(shown() - 1, cols - 1, true, false);
      return;
    }
    const lastRow = shown() - 1;
    const lastCol = cols - 1;
    const row = active ? active.row : 0;
    const col = active ? active.col : 0;
    const page = Math.max(1, Math.floor(viewHeight() / ROW) - 1);
    /** @type {[number, number] | null} */
    let to = null;
    switch (key) {
      case 'ArrowUp':
        to = [command ? 0 : row - 1, col];
        break;
      case 'ArrowDown':
        to = [command ? lastRow : row + 1, col];
        break;
      case 'ArrowLeft':
        to = [row, command ? 0 : col - 1];
        break;
      case 'ArrowRight':
        to = [row, command ? lastCol : col + 1];
        break;
      case 'PageUp':
        to = [row - page, col];
        break;
      case 'PageDown':
        to = [row + page, col];
        break;
      case 'Home':
        to = [command ? 0 : row, 0];
        break;
      case 'End':
        to = [command ? lastRow : row, lastCol];
        break;
      case 'Tab':
        to = [row, col + (e.shiftKey ? -1 : 1)];
        break;
      case 'Escape':
        if (active) {
          e.preventDefault();
          select(row, col);
        }
        return;
    }
    if (to) {
      e.preventDefault();
      // The first key press lands on the first cell rather than next to it.
      select(active ? to[0] : 0, active ? to[1] : 0, e.shiftKey && key !== 'Tab');
    }
  });

  // ---- Messages -----------------------------------------------------------

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'file':
        onFile(msg);
        break;
      case 'table':
        onTable(msg);
        break;
      case 'exported':
        $('export').disabled = false;
        break;
      case 'ops':
        onOps(msg);
        break;
      case 'state':
        setDocState(msg);
        showNotice();
        break;
      case 'saved':
        // The file was written: its size, and sometimes its encoding, are other than before.
        if (file) {
          Object.assign(file, { size: msg.size, encoding: msg.encoding ?? file.encoding, delimiter: msg.delimiter ?? file.delimiter, detected: msg.detected ?? file.detected });
          $('delimiter').value = file.detected ? '' : file.delimiter;
          saveState();
          updateStatus();
        }
        break;
      case 'clipboard':
        pastedAt = asked ? Date.now() : 0;
        asked = false;
        pasteText(String(msg.text ?? ''));
        break;
    }
  });

  vscode.postMessage({ type: 'ready', delimiter: saved.delimiter || '', encoding: saved.encoding || '' });
})();
