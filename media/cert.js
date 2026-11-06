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

  const DAY = 86400000;
  /** A certificate that ends within this time is flagged. */
  const SOON = 30 * DAY;
  /** 9999-12-31 23:59:59 UTC, which stands for "never expires". */
  const NO_EXPIRY = 253402300799000;
  /** With more blocks than this the page starts collapsed and offers a filter. */
  const MANY = 8;

  const saved = vscode.getState() || {};

  /** What the provider sent last. @type {any} */
  let file = null;
  /** Indexes of the blocks shown in full. @type {Set<number>} */
  let open = new Set();
  let filter = '';
  /** One entry per block: its elements, and the text the filter searches. @type {{card: HTMLElement, body: HTMLElement, pill: HTMLElement | null, statusRow: HTMLElement | null, text: string}[]} */
  let cards = [];

  function saveState() {
    vscode.setState({ name: file?.name, count: file?.blocks.length, open: [...open], filter });
  }

  function formatSize(/** @type {number} */ bytes) {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  const plural = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

  function copy(/** @type {string} */ text, /** @type {string} */ what) {
    vscode.postMessage({ type: 'copy', text, what });
  }

  // ---- Validity -------------------------------------------------------------

  /** A length of time in the unit that says the most: minutes, hours, days, and years past two of them. */
  function span(/** @type {number} */ ms) {
    if (ms < 60000) {
      return 'less than a minute';
    }
    if (ms < 2 * 3600000) {
      return plural(Math.floor(ms / 60000), 'minute');
    }
    if (ms < 2 * DAY) {
      return plural(Math.floor(ms / 3600000), 'hour');
    }
    const days = Math.floor(ms / DAY);
    return days < 731 ? plural(days, 'day') : `${Math.floor((days / 365.25) * 10) / 10} years`;
  }

  /** Where the certificate stands today. The clock is the one of this machine. */
  function statusOf(/** @type {{from?: number, to?: number}} */ validity, now = Date.now()) {
    const { from, to } = validity;
    if (from !== undefined && now < from) {
      return { state: 'future', text: `Not valid yet · starts in ${span(from - now)}` };
    }
    if (to === undefined) {
      return { state: 'unknown', text: from === undefined ? '' : 'End date unreadable' };
    }
    if (now > to) {
      return { state: 'expired', text: `Expired ${span(now - to)} ago` };
    }
    if (to === NO_EXPIRY) {
      return { state: 'valid', text: 'Valid · no expiry date' };
    }
    return to - now < SOON ? { state: 'soon', text: `Expires in ${span(to - now)}` } : { state: 'valid', text: `Valid · ${span(to - now)} left` };
  }

  // ---- Report ---------------------------------------------------------------

  const label = (/** @type {number} */ index) => `${index + 1}. ${file.blocks[index].title || file.blocks[index].type}`;

  /** Who issued a certificate, as far as this file tells. */
  function issuerText(/** @type {any} */ block) {
    if (block.selfSigned) {
      return block.issuer.checked ? 'Self-signed' : 'Self-signed (signature not checked)';
    }
    if (block.issuer.index === undefined) {
      return `${block.issuer.name}${file.blocks.length > 1 ? ' (not in this file)' : ''}`;
    }
    return `${label(block.issuer.index)}${block.issuer.checked ? ' (signature verified)' : ' (by name; signature not checked)'}`;
  }

  /** The rows of a section, with the status on top of the validity. */
  function rowsOf(/** @type {any} */ block, /** @type {any} */ section) {
    const status = section.validity && block.validity ? statusOf(block.validity).text : '';
    return status ? [{ label: 'Status', value: status }, ...section.rows] : section.rows;
  }

  function blockReport(/** @type {any} */ block, /** @type {number} */ index) {
    const lines = [`${index + 1}. ${block.type}${block.title ? `: ${block.title}` : ''}${block.tags.length ? ` [${block.tags.join(', ')}]` : ''}`];
    if (block.issuer) {
      lines.push(`   Issued by: ${issuerText(block)}`);
    }
    for (const link of block.links) {
      lines.push(`   ${link.label}: ${label(link.index)}`);
    }
    for (const problem of block.problems) {
      lines.push(`   Problem: ${problem}`);
    }
    for (const note of block.notes) {
      lines.push(`   Note: ${note}`);
    }
    for (const section of block.sections) {
      lines.push('', `   ${section.title}`);
      for (const row of rowsOf(block, section)) {
        lines.push(`     ${row.label}: ${row.value.replace(/\n/g, `\n     ${' '.repeat(row.label.length + 2)}`)}`);
      }
    }
    return lines.join('\n');
  }

  function fileReport() {
    const head = [file.name, $('summary').textContent];
    if (file.chain) {
      head.push(file.chain.text);
    }
    head.push(...file.notes);
    return [head.join('\n'), ...file.blocks.map(blockReport)].join('\n\n') + '\n';
  }

  // ---- Blocks ---------------------------------------------------------------

  /** A reference to another block that takes the reader there. */
  function jump(/** @type {number} */ index) {
    const link = el('button', 'jump', label(index));
    link.title = 'Show this block';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      reveal(index);
    });
    return link;
  }

  /** Opens a block and brings it into view, clearing a filter that hides it. */
  function reveal(/** @type {number} */ index) {
    if (cards[index].card.hidden) {
      filter = '';
      $('filter').value = '';
      applyFilter();
    }
    setOpen(index, true);
    cards[index].card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    /** @type {HTMLElement} */ (cards[index].card.querySelector('.blockHead')).focus({ preventScroll: true });
  }

  function renderBody(/** @type {any} */ block, /** @type {number} */ index) {
    const entry = cards[index];
    const body = entry.body;
    body.textContent = '';
    for (const problem of block.problems) {
      body.append(el('p', 'problem', problem));
    }
    for (const note of block.notes) {
      body.append(el('p', 'note', note));
    }

    if (block.issuer || block.links.length) {
      const relations = el('dl', 'relations');
      if (block.issuer) {
        const value = el('dd');
        if (block.selfSigned || block.issuer.index === undefined) {
          value.textContent = issuerText(block);
        } else {
          value.append(jump(block.issuer.index), el('span', 'aside', block.issuer.checked ? 'signature verified' : 'by name; signature not checked'));
        }
        relations.append(el('dt', '', 'Issued by'), value);
      }
      for (const link of block.links) {
        const value = el('dd');
        value.append(jump(link.index));
        relations.append(el('dt', '', link.label), value);
      }
      body.append(relations);
    }

    for (const section of block.sections) {
      const list = el('dl');
      for (const row of rowsOf(block, section)) {
        const value = el('dd', row.mono ? 'mono' : '');
        const text = el('span', 'value', row.value);
        if (row.mono && /^[0-9A-F:]+$/.test(row.value)) {
          // A long fingerprint wraps between its bytes, not inside one. The text stays the same for selecting and copying.
          text.replaceChildren(...row.value.split(/(?<=:)/).flatMap((/** @type {string} */ piece) => [piece, document.createElement('wbr')]));
        }
        value.append(text);
        if (row.label === 'Status' && section.validity) {
          entry.statusRow = text;
          text.classList.add('state', statusOf(block.validity).state);
        }
        if (row.copy) {
          const button = el('button', 'copy', 'Copy');
          button.title = `Copy: ${row.label}`;
          button.addEventListener('click', () => copy(row.value, row.label));
          value.append(button);
        }
        list.append(el('dt', '', row.label), value);
      }
      body.append(el('h3', '', section.title), list);
    }

    const actions = el('div', 'actions');
    if (block.pem) {
      const pem = el('button', '', 'Copy PEM');
      pem.title = 'Copy this block alone, as PEM text';
      pem.addEventListener('click', () => copy(block.pem, 'PEM'));
      actions.append(pem);
    }
    const details = el('button', '', 'Copy details');
    details.title = 'Copy what is shown for this block as text';
    details.addEventListener('click', () => copy(`${blockReport(block, index)}\n`, 'details'));
    actions.append(details);
    body.append(actions);
  }

  function setOpen(/** @type {number} */ index, /** @type {boolean} */ on) {
    const { card, body } = cards[index];
    if (on) {
      open.add(index);
      // Built on first use: a trust bundle has hundreds of blocks and nobody reads them all.
      if (!body.childElementCount) {
        renderBody(file.blocks[index], index);
      }
    } else {
      open.delete(index);
    }
    card.classList.toggle('open', on);
    body.hidden = !on;
    /** @type {HTMLElement} */ (card.querySelector('.blockHead')).setAttribute('aria-expanded', String(on));
    saveState();
  }

  function renderBlocks() {
    cards = file.blocks.map((/** @type {any} */ block, /** @type {number} */ index) => {
      const card = el('article', `block ${block.kind}`);
      const head = el('button', 'blockHead');
      // Spans, since the head is a button.
      const first = el('span', 'line');
      first.append(el('span', 'index', String(index + 1)), el('span', 'type', block.type), el('span', 'title', block.title));
      for (const tag of block.tags) {
        first.append(el('span', `tag ${tag === 'Encrypted' ? 'locked' : tag === 'Not encrypted' ? 'unlocked' : ''}`, tag));
      }
      if (block.problems.length) {
        first.append(el('span', 'tag damaged', 'Damaged'));
      }
      let pill = null;
      if (block.validity) {
        pill = el('span', 'pill');
        first.append(pill);
      }
      head.append(first);

      const facts = [];
      if (block.issuer) {
        facts.push(block.selfSigned ? 'Self-signed' : `Issued by ${block.issuer.name}`);
      }
      if (block.key) {
        facts.push(block.key);
      }
      for (const link of block.links) {
        facts.push(`${link.label} ${link.index + 1}`);
      }
      if (facts.length) {
        head.append(el('span', 'facts', facts.join(' · ')));
      }

      const body = el('div', 'blockBody');
      body.hidden = true;
      head.addEventListener('click', () => setOpen(index, !open.has(index)));
      card.append(head, body);
      const text = [block.type, block.title, ...block.tags, ...facts, ...block.sections.flatMap((/** @type {any} */ s) => s.rows.map((/** @type {any} */ r) => r.value))].join('\n').toLowerCase();
      return { card, body, pill, statusRow: null, text };
    });
    $('blocks').replaceChildren(...cards.map((entry) => entry.card));
    for (const index of open) {
      setOpen(index, true);
    }
  }

  // ---- Chain ----------------------------------------------------------------

  /** Who issued whom, drawn as a tree with the issuers on top. Shown when at least one certificate has its issuer in the file. */
  function renderChain() {
    const { blocks, chain } = file;
    $('chain').hidden = !chain;
    if (!chain) {
      return;
    }
    $('chain').className = chain.state;
    $('chainText').textContent = chain.text;

    /** @type {Map<number | string, number[]>} */
    const below = new Map();
    const tops = [];
    let linked = false;
    blocks.forEach((/** @type {any} */ block, /** @type {number} */ index) => {
      if (!block.issuer) {
        return;
      }
      // An issuer outside the file still groups the certificates it issued.
      const parent = block.selfSigned ? undefined : (block.issuer.index ?? `out:${block.issuer.name}`);
      if (parent === undefined) {
        tops.push(index);
        return;
      }
      linked ||= typeof parent === 'number';
      if (!below.has(parent)) {
        below.set(parent, []);
        if (typeof parent === 'string') {
          tops.push(parent);
        }
      }
      /** @type {number[]} */ (below.get(parent)).push(index);
    });
    $('tree').hidden = !linked;
    if (!linked) {
      $('tree').textContent = '';
      return;
    }

    const rows = [];
    const seen = new Set();
    const add = (/** @type {number | string} */ node, /** @type {number} */ depth) => {
      // Two certificates that name each other must not send this in circles.
      if (seen.has(node)) {
        return;
      }
      seen.add(node);
      const row = el('div', 'node');
      row.style.paddingLeft = `${depth * 22}px`;
      if (depth) {
        row.append(el('span', 'branch', '└'));
      }
      if (typeof node === 'string') {
        row.append(el('span', 'outside', `${node.slice(4)} (not in this file)`));
      } else {
        const block = blocks[node];
        row.append(jump(node));
        for (const tag of block.tags) {
          row.append(el('span', 'tag', tag));
        }
        const status = statusOf(block.validity);
        if (status.state !== 'valid' && status.text) {
          row.append(el('span', `state ${status.state}`, status.text));
        }
      }
      rows.push(row);
      for (const child of below.get(node) ?? []) {
        add(child, depth + 1);
      }
    };
    tops.forEach((top) => add(top, 0));
    $('tree').replaceChildren(...rows);
  }

  // ---- Page -----------------------------------------------------------------

  /** Everything that depends on the clock: the pills, the status rows of the open blocks, and the count in the summary. */
  function renderStatus() {
    const counts = { expired: 0, soon: 0, future: 0 };
    file.blocks.forEach((/** @type {any} */ block, /** @type {number} */ index) => {
      if (!block.validity) {
        return;
      }
      const status = statusOf(block.validity);
      const { pill, statusRow } = cards[index];
      if (pill) {
        pill.className = `pill state ${status.state}`;
        pill.textContent = status.text;
        pill.hidden = !status.text;
      }
      if (statusRow) {
        statusRow.className = `value state ${status.state}`;
        statusRow.textContent = status.text;
      }
      if (status.state in counts) {
        counts[/** @type {'expired'} */ (status.state)]++;
      }
    });

    const kinds = [
      ['certificate', 'certificate'],
      ['request', 'certificate request'],
      ['private', 'private key'],
      ['public', 'public key'],
      ['crl', 'revocation list'],
      ['other', 'other block'],
    ];
    const parts = kinds
      .map(([kind, name]) => [file.blocks.filter((/** @type {any} */ b) => b.kind === kind).length, name])
      .filter(([count]) => count)
      .map(([count, name]) => plural(/** @type {number} */ (count), /** @type {string} */ (name)));
    const summary = $('summary');
    summary.replaceChildren([file.format, parts.join(', '), file.size === undefined ? '' : formatSize(file.size)].filter(Boolean).join(' · '));
    // On a page with one certificate its own pill says it already.
    if (file.blocks.length > 1) {
      const alerts = [
        [counts.expired, 'expired', 'expired'],
        [counts.soon, 'soon', counts.soon === 1 ? 'expires within 30 days' : 'expire within 30 days'],
        [counts.future, 'future', 'not valid yet'],
      ];
      for (const [count, state, text] of alerts) {
        if (count) {
          summary.append(' · ', el('span', `state ${state}`, `${count} ${text}`));
        }
      }
    }
  }

  function applyFilter() {
    const needle = filter.trim().toLowerCase();
    let shown = 0;
    for (const { card, text } of cards) {
      card.hidden = !!needle && !text.includes(needle);
      shown += card.hidden ? 0 : 1;
    }
    $('matches').textContent = needle ? `${shown} of ${cards.length}` : '';
  }

  function show(/** @type {any} */ msg) {
    // The same file again (it changed on disk, or the tab came back) keeps what was open.
    const same = file ? file.name === msg.name && file.blocks.length === msg.blocks.length : saved.name === msg.name && saved.count === msg.blocks.length;
    if (!file && same) {
      open = new Set(saved.open);
      filter = saved.filter || '';
    } else if (!same) {
      // One block is shown in full, a few start with the first one, and a bundle starts as a list.
      open = new Set(msg.blocks.length && msg.blocks.length <= MANY ? [0] : []);
      filter = '';
    }
    file = msg;

    $('name').textContent = msg.name;
    $('message').textContent = msg.message || '';
    $('message').hidden = !msg.message;
    $('notes').replaceChildren(...msg.notes.map((/** @type {string} */ note) => el('p', 'note', note)));
    // DER has no text to show. A file that is nothing at all gets the button too, as the way out of this page.
    $('openSource').hidden = !msg.text && msg.blocks.length > 0;
    $('copyReport').hidden = !msg.blocks.length;
    $('tools').hidden = msg.blocks.length <= MANY;
    $('filter').value = filter;

    renderBlocks();
    renderChain();
    renderStatus();
    applyFilter();
    saveState();
  }

  // ---- Events ---------------------------------------------------------------

  $('openSource').addEventListener('click', (/** @type {MouseEvent} */ e) => vscode.postMessage({ type: 'openSource', beside: e.altKey }));
  $('copyReport').addEventListener('click', () => copy(fileReport(), 'report'));
  $('filter').addEventListener('input', () => {
    filter = $('filter').value;
    applyFilter();
    saveState();
  });
  $('expandAll').addEventListener('click', () => cards.forEach(({ card }, index) => !card.hidden && setOpen(index, true)));
  $('collapseAll').addEventListener('click', () => cards.forEach((_, index) => setOpen(index, false)));

  // "89 days left" turns into "88" on its own, and a certificate that runs out while the tab is open is shown as expired.
  setInterval(() => {
    if (file?.blocks.length) {
      renderStatus();
    }
  }, 60000);

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'file':
        show(msg);
        break;
      case 'error':
        show({ name: msg.name, format: '', text: true, blocks: [], notes: [], message: msg.message });
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
