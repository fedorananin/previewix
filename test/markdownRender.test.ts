import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toggleTask } from '../src/markdownEdit';
import { renderDocument, splitLines } from '../src/markdownRender';
import { random } from './helpers';

// The assertions look at structure (line ranges, ids, classes, which text is where) and never at a whole
// piece of HTML, which markdown-it, highlight.js and KaTeX are free to change.

const rangesOf = (text: string) => renderDocument(text).blocks.map((block) => [block.start, block.end]);
const htmlOf = (text: string) =>
  renderDocument(text)
    .blocks.map((block) => block.html)
    .join('');

const unescape = (html: string) =>
  html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** What a piece of HTML says once its tags are gone. */
const textOf = (html: string) => unescape(html.replace(/<[^>]*>/g, ''));

const count = (html: string, needle: string) => html.split(needle).length - 1;

/** The TeX of every formula KaTeX drew: it keeps the source in an annotation next to the picture. */
const formulasOf = (html: string) =>
  [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map((found) => unescape(found[1]).trim());

const headingIds = (html: string) => [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((found) => found[1]);

/** The task checkboxes of a page with the line each one names. */
function checkboxesOf(html: string): { line: number; checked: boolean }[] {
  return [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => {
    assert.match(tag, /class="task"/);
    const line = /\bdata-line="(\d+)"/.exec(tag);
    assert.ok(line, `no data-line in ${tag}`);
    return { line: Number(line[1]), checked: /\schecked\b/.test(tag) };
  });
}

// ---- Blocks and their line ranges ---------------------------------------------------------------------------

test('every top-level element is one block with its source lines', () => {
  const text = [
    '# Title', // 0
    '',
    'A paragraph', // 2
    'of two lines.',
    '',
    '- a list', // 5
    '  - with a nested item',
    '- and a second item',
    '',
    '```js', // 9
    'const a = 1;',
    '',
    'const b = 2;',
    '```',
    '',
    '| a | b |', // 15
    '|---|---|',
    '| 1 | 2 |',
    '',
    '> a quote', // 19
    '> of two lines',
    '',
    '***', // 22
    '',
  ].join('\n');
  const { blocks } = renderDocument(text);
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end, /^<(\w+)/.exec(block.html)?.[1]]),
    [
      [0, 1, 'h1'],
      [2, 4, 'p'],
      [5, 8, 'ul'],
      [9, 14, 'pre'],
      [15, 18, 'table'],
      [19, 21, 'blockquote'],
      [22, 23, 'hr'],
    ],
  );
});

test('a heading directly above a paragraph is a block of its own', () => {
  assert.deepEqual(rangesOf('# Title\ntext under it\nsecond line\n'), [
    [0, 1],
    [1, 3],
  ]);
});

test('the blank lines after a list are not part of its block', () => {
  assert.deepEqual(rangesOf('- one\n- two\n\n\n\nparagraph\n'), [
    [0, 2],
    [5, 6],
  ]);
  // The blank line inside a loose list is.
  assert.deepEqual(rangesOf('- one\n\n- two\n\n\n'), [[0, 3]]);
});

test('an empty document has no blocks and no outline', () => {
  for (const text of ['', '\n', '\n\n\n', '   \n']) {
    assert.deepEqual(renderDocument(text), { blocks: [], outline: [] }, JSON.stringify(text));
  }
});

test('a document with CRLF renders exactly like the same document with LF', () => {
  const text = '---\na: 1\n---\n# Title\n\ntext\nmore\n\n- [ ] task\n- [x] done\n\n$$\nx\n\ny\n$$\n\n[^n]: note\n\n> [!NOTE]\n> body\n';
  assert.deepEqual(renderDocument(text.replace(/\n/g, '\r\n')), renderDocument(text));
});

test('front matter is a block of its own and the lines after it keep their numbers', () => {
  const { blocks, outline } = renderDocument('---\ntitle: Document\ntags: [a, b]\n---\n# Heading\n\ntext\n');
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end]),
    [
      [0, 4],
      [4, 5],
      [6, 7],
    ],
  );
  assert.match(blocks[0].html, /class="frontmatter"/);
  assert.equal(textOf(blocks[0].html), 'title: Document\ntags: [a, b]');
  // The YAML is not Markdown: `title:` above `---` must not come out as a heading.
  assert.deepEqual(outline, [{ level: 1, text: 'Heading', id: 'heading' }]);
});

test('front matter alone, and an opening line that is never closed', () => {
  assert.deepEqual(rangesOf('---\na: 1\n---\n'), [[0, 3]]);
  const open = renderDocument('---\n\nJust a rule above this text.\n');
  assert.ok(!open.blocks.some((block) => block.html.includes('frontmatter')));
  assert.equal(textOf(open.blocks[open.blocks.length - 1].html).trim(), 'Just a rule above this text.');
});

test('only the very first line opens front matter', () => {
  const { blocks } = renderDocument('text\n\n---\na: 1\n---\n');
  assert.ok(!blocks.some((block) => block.html.includes('frontmatter')));
});

test('what the renderer wraps itself is escaped: front matter, code, diagrams, formulas that fail', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const text = [
    '---',
    `title: ${hostile}`,
    '---',
    '```js',
    hostile,
    '```',
    '',
    '```unknown-language',
    hostile,
    '```',
    '',
    '```mermaid',
    hostile,
    '```',
    '',
    '```math',
    `\\nosuchmacro ${hostile}`,
    '```',
    '',
    `Inline \`${hostile}\` code.`,
  ].join('\n');
  const { blocks } = renderDocument(text);
  assert.equal(blocks.length, 6);
  for (const block of blocks) {
    assert.ok(!/<script|<img/i.test(block.html), block.html);
    assert.ok(textOf(block.html).includes('alert(1)'), 'the text is still shown');
  }
});

test('raw HTML of the document passes through; scripts are left to the page policy', () => {
  // AGENTS.md: the page's policy allows inline styles "for raw HTML in documents" and scripts only by nonce.
  const { blocks } = renderDocument('<div style="color: red" align="center">raw <b>html</b></div>\n\nPress <kbd>Ctrl</kbd> now.\n');
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].html.includes('<div style="color: red" align="center">raw <b>html</b></div>'));
  assert.ok(blocks[1].html.includes('<kbd>Ctrl</kbd>'));
});

// Documents put together from pieces that are each one block, so the expected ranges are known without
// asking the renderer. Two lists never follow each other: Markdown would read them as one.
const PIECES: { lines: string[]; opens: RegExp; list?: boolean }[] = [
  { lines: ['# A heading'], opens: /^<h1 / },
  { lines: ['Setext heading', '--------------'], opens: /^<h2 / },
  { lines: ['A paragraph', 'of two lines, with $5 and $10 in it.'], opens: /^<p>/ },
  { lines: ['- one', '- two', '  - nested', '- three'], opens: /^<ul>/, list: true },
  { lines: ['1. first', '2. second'], opens: /^<ol>/, list: true },
  { lines: ['- [ ] open', '- [x] done'], opens: /^<ul>/, list: true },
  { lines: ['- loose', '', '- list'], opens: /^<ul>/, list: true },
  { lines: ['```js', 'let a = 1;', '', 'let b = 2;', '```'], opens: /^<pre/ },
  { lines: ['```mermaid', 'graph TD', '  A --> B', '```'], opens: /^<div class="diagram">/ },
  { lines: ['$$', 'a = b', '', 'c = d', '$$'], opens: /^<div class="math">/ },
  { lines: ['$$ x^2 $$'], opens: /^<div class="math">/ },
  { lines: ['[^note]: A footnote', '    that goes on.', '', '    And has a second paragraph.'], opens: /^<div class="footnote/ },
  { lines: ['> [!NOTE]', '> The body of an alert.'], opens: /^<div class="alert alert-note">/ },
  { lines: ['> A quote', '> of two lines.'], opens: /^<blockquote>/ },
  { lines: ['| a | b |', '|---|---|', '| 1 | 2 |'], opens: /^<table>/ },
  { lines: ['<div align="center">', 'raw', '</div>'], opens: /^<div align/ },
  { lines: ['<!-- a comment -->'], opens: /^<!--/ },
  { lines: ['***'], opens: /^<hr/ },
];

test('random documents: one block per piece, at exactly its lines', () => {
  const rnd = random(5150);
  for (let round = 0; round < 150; round++) {
    const lines: string[] = [];
    const expected: { start: number; end: number; opens: RegExp }[] = [];
    if (rnd.int(3) === 0) {
      lines.push('---', 'title: Random', 'tags: [x]', '---');
      expected.push({ start: 0, end: 4, opens: /^<pre class="frontmatter">/ });
    } else {
      lines.push(...Array<string>(rnd.int(3)).fill(''));
    }
    let wasList = false;
    for (let n = 1 + rnd.int(10); n > 0; n--) {
      let piece = rnd.pick(PIECES);
      while (wasList && piece.list) {
        piece = rnd.pick(PIECES);
      }
      wasList = !!piece.list;
      if (expected.length) {
        lines.push(...Array<string>(1 + rnd.int(3)).fill(''));
      }
      expected.push({ start: lines.length, end: lines.length + piece.lines.length, opens: piece.opens });
      lines.push(...piece.lines);
    }
    lines.push(...Array<string>(rnd.int(4)).fill(''));
    const text = lines.join(rnd.pick(['\n', '\r\n']));

    const { blocks } = renderDocument(text);
    assert.deepEqual(
      blocks.map((block) => [block.start, block.end]),
      expected.map((piece) => [piece.start, piece.end]),
      `round ${round}: ${JSON.stringify(text)}`,
    );
    blocks.forEach((block, i) => assert.match(block.html, expected[i].opens, `round ${round}, block ${i}`));
  }
});

test('a link reference definition is a block too', { todo: 'markdown-it leaves no token for `[label]: url`, so the line is on no block and cannot be edited in the rendered view' }, () => {
  assert.deepEqual(rangesOf('See [the site][site].\n\n[site]: https://example.com\n'), [
    [0, 1],
    [2, 3],
  ]);
});

// ---- Task lists ---------------------------------------------------------------------------------------------

const TASKS = [
  '---', // 0
  'title: Tasks',
  '---',
  '# List',
  '',
  '- [ ] open', // 5
  '- [x] done',
  '  - [X] nested, shouted', // 7
  '- not a task',
  '',
  '1. [ ] numbered', // 10
  '',
  '> - [x] quoted', // 12
  '',
].join('\n');

test('every task checkbox carries the line it was written on', () => {
  assert.deepEqual(checkboxesOf(htmlOf(TASKS)), [
    { line: 5, checked: false },
    { line: 6, checked: true },
    { line: 7, checked: true },
    { line: 10, checked: false },
    { line: 12, checked: true },
  ]);
  assert.equal(count(htmlOf(TASKS), 'task-item'), 5);
  // The marker is replaced by the box, not shown next to it.
  assert.ok(!/\[[ xX]\]/.test(textOf(htmlOf(TASKS))));
});

test('toggling the line a checkbox names flips that checkbox and no other', () => {
  const lines = splitLines(TASKS);
  const before = checkboxesOf(htmlOf(TASKS));
  before.forEach((box, i) => {
    const toggled = toggleTask(lines[box.line]);
    assert.ok(toggled !== undefined, `line ${box.line} has a box`);
    const after = checkboxesOf(htmlOf(lines.map((line, n) => (n === box.line ? toggled : line)).join('\n')));
    assert.deepEqual(
      after,
      before.map((other, n) => (n === i ? { line: other.line, checked: !other.checked } : other)),
    );
  });
});

test('brackets that are not a task marker get no checkbox', () => {
  const html = htmlOf('- [ ]no space after it\n- [link](target)\n- [y] another letter\n- text first, [ ] later\n\n[ ] not in a list\n');
  assert.equal(count(html, '<input'), 0);
  assert.equal(count(html, 'task-item'), 0);
});

// ---- Heading ids and the outline ----------------------------------------------------------------------------

test('heading ids are the ones GitHub gives', () => {
  // The right-hand sides are what github.com makes of these headings.
  const cases: [string, string][] = [
    ['Hello, World!', 'hello-world'],
    ['Getting Started', 'getting-started'],
    ['1. Install the tool', '1-install-the-tool'],
    ['snake_case and kebab-case', 'snake_case-and-kebab-case'],
    ['C++ & C#', 'c--c'],
    ['Привет, мир', 'привет-мир'],
    ['Größe und Maße', 'größe-und-maße'],
    ['日本語の見出し', '日本語の見出し'],
    ['What?! Really...', 'what-really'],
  ];
  for (const [heading, id] of cases) {
    assert.deepEqual(headingIds(htmlOf(`## ${heading}\n`)), [id], heading);
  }
});

test('a heading id is made from the text without its markup', () => {
  assert.deepEqual(headingIds(htmlOf('## `code`, *emphasis* and a [link](https://example.com/page)\n')), ['code-emphasis-and-a-link']);
  assert.deepEqual(headingIds(htmlOf('## **Bold** start\n')), ['bold-start']);
});

test('repeated headings get -1, -2', () => {
  const html = htmlOf('# Notes\n\n## Notes\n\n### Notes\n\n## Other\n\n## Other\n');
  assert.deepEqual(headingIds(html), ['notes', 'notes-1', 'notes-2', 'other', 'other-1']);
});

test('a numbered repeat never takes an id that is in use', () => {
  // GitHub does the same: the third heading would be "notes-1" by its text, which the second one has.
  const ids = headingIds(htmlOf('## Notes\n\n## Notes\n\n## Notes 1\n\n## Notes\n'));
  assert.deepEqual(ids, ['notes', 'notes-1', 'notes-1-1', 'notes-2']);
});

test('every heading has an id, and no two share one', () => {
  const ids = headingIds(htmlOf('# A\n## A\n## ???\n## !!!\n> ## A\n\n- ## A\n\nA\n=\n\n## a\n'));
  assert.equal(ids.length, 8);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, ids.length);
});

test('the outline lists the top-level headings in order, with level, plain text and id', () => {
  const text = '# Title\n\nintro\n\n## First *part*\n\nSetext\n------\n\n#### Deep `code`\n\n## First part\n';
  const { blocks, outline } = renderDocument(text);
  assert.deepEqual(outline, [
    { level: 1, text: 'Title', id: 'title' },
    { level: 2, text: 'First part', id: 'first-part' },
    { level: 2, text: 'Setext', id: 'setext' },
    { level: 4, text: 'Deep code', id: 'deep-code' },
    { level: 2, text: 'First part', id: 'first-part-1' },
  ]);
  // Every entry leads to a heading that is on the page under that id.
  const html = blocks.map((block) => block.html).join('');
  for (const entry of outline) {
    assert.ok(html.includes(`<h${entry.level} id="${entry.id}"`), entry.id);
  }
});

test('headings inside a quote or a list are not in the outline but still take their id', () => {
  const { blocks, outline } = renderDocument('> ## Quoted\n\n- ## Listed\n\n## Quoted\n');
  assert.deepEqual(outline, [{ level: 2, text: 'Quoted', id: 'quoted-1' }]);
  assert.deepEqual(headingIds(blocks.map((block) => block.html).join('')), ['quoted', 'listed', 'quoted-1']);
});

// ---- Math ---------------------------------------------------------------------------------------------------

test('dollar amounts stay text', () => {
  const money = [
    'It costs $5 and $10.',
    'US$5 and A$10 today',
    'between $5-$10 a month',
    '20$ and 30$',
    '$HOME/bin:$PATH',
    'a $ b $ c',
    'the $n$th time',
    // One rule each: no opening after a letter, none before a space, no closing after a space.
    'pay US$5, get 5$ back',
    'from $ 5 up to 5$',
    'It is $5 or $ 6.',
  ];
  for (const text of money) {
    const html = htmlOf(text);
    assert.ok(!html.includes('katex'), text);
    assert.equal(textOf(html).trim(), text);
  }
});

test('a formula between single dollars is drawn inline', () => {
  const html = htmlOf('Euler wrote $e^{i\\pi}+1=0$, and ($x$) too.\n');
  assert.deepEqual(formulasOf(html), ['e^{i\\pi}+1=0', 'x']);
  assert.match(html, /^<p>/);
  assert.ok(!html.includes('katex-display'));
  assert.ok(!html.includes('math-error'));
});

test('$$…$$ inside a paragraph is a display formula in that paragraph', () => {
  const { blocks } = renderDocument('Before $$x^2$$ after.\n');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].html, /^<p>Before /);
  assert.deepEqual(formulasOf(blocks[0].html), ['x^2']);
  assert.ok(blocks[0].html.includes('katex-display'));
});

test('two $$…$$ formulas on one line are a paragraph, not a formula block', () => {
  const { blocks } = renderDocument('$$a$$ and $$b$$\n\n$$\nc\n$$ and text after it\n');
  assert.match(blocks[0].html, /^<p>/);
  assert.deepEqual(formulasOf(blocks[0].html), ['a', 'b']);
  assert.ok(textOf(blocks[0].html).includes(' and '));
  // Text behind the closing line: not a block either, and nothing of it is lost.
  const rest = blocks.slice(1).map((block) => block.html).join('');
  assert.ok(!rest.includes('class="math"'));
  assert.ok(textOf(rest).includes('and text after it'));
});

test('GitHub’s $`…`$ lets a formula touch the words around it', () => {
  const html = htmlOf('touch$`x^2`$ing\n');
  assert.deepEqual(formulasOf(html), ['x^2']);
  assert.ok(!html.includes('<code'));
});

test('an escaped dollar and a dollar in code are not math', () => {
  assert.ok(!htmlOf('escaped \\$x$ here').includes('katex'));
  const code = htmlOf('code `$x$` stays');
  assert.ok(!code.includes('katex'));
  assert.ok(code.includes('<code>$x$</code>'));
  // Inside a formula the escaped dollar is a dollar sign, not its end.
  assert.deepEqual(formulasOf(htmlOf('$a \\$ b$')), ['a \\$ b']);
});

test('a formula between $$ lines is one block, blank lines inside included', () => {
  const { blocks } = renderDocument('Text before\n$$\na = b\n\nc = d\n$$\nafter\n');
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end]),
    [
      [0, 1],
      [1, 6],
      [6, 7],
    ],
  );
  assert.match(blocks[1].html, /^<div class="math">/);
  const [tex] = formulasOf(blocks[1].html);
  assert.equal(formulasOf(blocks[1].html).length, 1);
  assert.deepEqual(tex.split(/\n+/), ['a = b', 'c = d']);
  assert.ok(!blocks[0].html.includes('katex') && !blocks[2].html.includes('katex'));
});

test('$$ … $$ on one line and a math fence are formula blocks', () => {
  const { blocks } = renderDocument('$$ x^2 $$\n\n```math\n\\int_0^1 x\n```\n');
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end]),
    [
      [0, 1],
      [2, 5],
    ],
  );
  assert.deepEqual(blocks.map((block) => formulasOf(block.html)), [['x^2'], ['\\int_0^1 x']]);
  blocks.forEach((block) => assert.match(block.html, /^<div class="math">/));
});

test('a $$ that is never closed does not swallow the document', () => {
  const { blocks, outline } = renderDocument('Before\n\n$$\nx = 1\n\n# Still a heading\n\nStill a paragraph.\n\n- still a list\n');
  const html = blocks.map((block) => block.html).join('');
  assert.ok(!html.includes('katex') && !html.includes('class="math'));
  assert.deepEqual(outline, [{ level: 1, text: 'Still a heading', id: 'still-a-heading' }]);
  assert.deepEqual(
    blocks.slice(-3).map((block) => [block.start, block.end, /^<(\w+)/.exec(block.html)?.[1]]),
    [
      [5, 6, 'h1'],
      [7, 8, 'p'],
      [9, 10, 'ul'],
    ],
  );
  assert.ok(textOf(html).includes('$$'), 'the stray marker is shown as text');
});

test('a formula in a list item stays inside the list block', () => {
  const { blocks } = renderDocument('- item\n  $$\n  y = 1\n  $$\n- other\n');
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end]),
    [[0, 5]],
  );
  assert.match(blocks[0].html, /^<ul>/);
  assert.deepEqual(formulasOf(blocks[0].html), ['y = 1']);
});

test('a formula KaTeX cannot read shows its source and the error, and the rest renders', () => {
  const { blocks } = renderDocument('Bad $\\frac{1}{$ here, good $x$.\n\n$$\n\\begin{matrix} a & b\n$$\n\nAfter.\n');
  assert.equal(blocks.length, 3);

  const inline = /<code class="math-error" title="([^"]+)">([^<]*)<\/code>/.exec(blocks[0].html);
  assert.ok(inline, blocks[0].html);
  assert.equal(unescape(inline[2]), '\\frac{1}{');
  assert.ok(inline[1].length > 0, 'the message is there');
  assert.deepEqual(formulasOf(blocks[0].html), ['x'], 'the good formula next to it is drawn');

  assert.deepEqual([blocks[1].start, blocks[1].end], [2, 5]);
  assert.match(blocks[1].html, /^<div class="math math-error">/);
  assert.ok(textOf(blocks[1].html).includes('\\begin{matrix} a & b'));
  assert.ok(!blocks[1].html.includes('class="katex"'));

  assert.equal(textOf(blocks[2].html).trim(), 'After.');
});

test('the source of a failed formula is escaped', () => {
  const html = htmlOf('$\\nosuchmacro<img src=x>$\n\n$$\n\\nosuchmacro<img src=y>\n$$\n');
  assert.equal(count(html, 'math-error'), 2);
  assert.ok(!html.includes('<img'));
  assert.ok(textOf(html).includes('\\nosuchmacro<img src=x>'));
});

test('KaTeX is not trusted: a formula cannot make a link', () => {
  const html = htmlOf('$\\href{https://example.com/}{link}$ and $\\url{https://example.com/}$\n\n$$\n\\href{javascript:alert(1)}{x}\n$$\n');
  assert.ok(!/<a\b/.test(html));
  assert.ok(!/href\s*=/.test(html));
});

// ---- Footnotes ----------------------------------------------------------------------------------------------

/** The numbers shown at the references, in the order of the text. */
const refNumbers = (html: string) => [...html.matchAll(/<sup class="footnote-ref">(.*?)<\/sup>/g)].map((found) => textOf(found[1]));
const noteMarks = (html: string) => [...html.matchAll(/<span class="footnote-mark">([^<]*)<\/span>/g)].map((found) => unescape(found[1]));

test('a footnote definition stays a block where it is written', () => {
  const { blocks } = renderDocument('Text[^a].\n\n[^a]: The note.\n\nAfter the note.\n');
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end]),
    [
      [0, 1],
      [2, 3],
      [4, 5],
    ],
  );
  assert.match(blocks[1].html, /^<div class="footnote" id="fn-a">/);
  assert.ok(textOf(blocks[1].html).includes('The note.'));
  assert.equal(textOf(blocks[2].html).trim(), 'After the note.');
});

test('footnotes are numbered in the order the text first refers to them', () => {
  const { blocks } = renderDocument('One[^x], two[^y], one again[^x], three[^z].\n\n[^z]: Z\n[^y]: Y\n[^x]: X\n');
  assert.deepEqual(refNumbers(blocks[0].html), ['1', '2', '1', '3']);
  // The definitions are in the order of the file, each under the number of its references.
  assert.deepEqual(
    blocks.slice(1).map((block) => [block.start, block.end, noteMarks(block.html)[0], /id="([^"]*)"/.exec(block.html)?.[1]]),
    [
      [2, 3, '3.', 'fn-z'],
      [3, 4, '2.', 'fn-y'],
      [4, 5, '1.', 'fn-x'],
    ],
  );
});

test('every reference leads to its note and every note back to each of its references', () => {
  const html = htmlOf('One[^x], two[^y], one again[^x].\n\n[^y]: Y\n[^x]: X\n\n    with a second paragraph\n');
  const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((found) => unescape(found[1]));
  assert.deepEqual(ids, ['fnref-x', 'fnref-y', 'fnref-x-2', 'fn-y', 'fn-x']);
  const targets = [...html.matchAll(/href="#([^"]*)"/g)].map((found) => decodeURIComponent(found[1]));
  assert.deepEqual(targets, ['fn-x', 'fn-y', 'fn-x', 'fnref-y', 'fnref-x', 'fnref-x-2']);
  assert.equal(count(html, 'class="footnote-back"'), 3);
});

test('a definition with continuation lines is one block', () => {
  const text = 'Text[^a].\n\n[^a]: First\n    continued.\n\n    Second paragraph:\n\n        code\n\nA paragraph that is not indented.\n';
  const { blocks } = renderDocument(text);
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end]),
    [
      [0, 1],
      [2, 8],
      [9, 10],
    ],
  );
  assert.equal(count(blocks[1].html, 'class="footnote"'), 1);
  for (const part of ['First', 'continued.', 'Second paragraph:', 'code']) {
    assert.ok(textOf(blocks[1].html).includes(part), part);
  }
});

test('a reference without a definition stays text', () => {
  const html = htmlOf('Defined[^a], undefined[^zz].\n\n[^a]: note\n');
  assert.deepEqual(refNumbers(html), ['1']);
  assert.ok(textOf(html).includes('undefined[^zz].'));
});

test('a definition nothing refers to is kept on the page, marked as unused', () => {
  const { blocks } = renderDocument('No references here.\n\n[^lonely]: Still shown.\n');
  assert.deepEqual([blocks[1].start, blocks[1].end], [2, 3]);
  assert.match(blocks[1].html, /^<div class="footnote unused"/);
  assert.deepEqual(noteMarks(blocks[1].html), ['[^lonely]']);
  assert.ok(textOf(blocks[1].html).includes('Still shown.'));
  assert.equal(count(blocks[1].html, 'footnote-back'), 0);
});

test('of two definitions with one label the first counts and the second is shown as unused', () => {
  const { blocks } = renderDocument('Text[^a].\n\n[^a]: First.\n[^a]: Second.\n');
  assert.match(blocks[1].html, /^<div class="footnote" id="fn-a">/);
  assert.match(blocks[2].html, /^<div class="footnote unused"/);
  assert.ok(textOf(blocks[2].html).includes('Second.'));
  assert.equal(count(blocks.map((block) => block.html).join(''), 'id="fn-a"'), 1);
});

test('a footnote label cannot break out of the attributes it is written into', () => {
  const html = htmlOf('Ref[^x"onmouseover="y] and[^<b>].\n\n[^x"onmouseover="y]: one\n[^<b>]: two\n');
  assert.deepEqual(refNumbers(html), ['1', '2']);
  assert.ok(!html.includes('onmouseover="'));
  assert.ok(!html.includes('<b>'));
});

test('a footnote label with half a surrogate pair does not stop the rendering', () => {
  // encodeURIComponent() throws on half a pair, and the link is made with it.
  for (const half of ['\ud83d', '\ude00', 'a\ud83db', '\ude00\ud83d']) {
    const { blocks } = renderDocument(`Ref[^${half}] and again[^${half}].\n\n[^${half}]: note\n`);
    assert.equal(blocks.length, 2, JSON.stringify(half));
    // Both ways the link names the id that is on the page: every href, decoded as the page does it, is an id.
    const html = blocks.map((block) => block.html).join('');
    const ids = [...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);
    const links = [...html.matchAll(/ href="#([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
    assert.equal(new Set(ids).size, 3, JSON.stringify(half));
    assert.deepEqual([...new Set(links)].sort(), [...ids].sort(), JSON.stringify(half));
    assert.ok(!/\p{Cs}/u.test(ids.join('')), JSON.stringify(half));
  }
  // A whole pair is a character like any other.
  assert.match(htmlOf('Ref[^\ud83d\ude00].\n\n[^\ud83d\ude00]: note\n'), / id="fn-\ud83d\ude00"/);
});

test('half a surrogate pair anywhere in the text does not stop the rendering', () => {
  const sources = [
    '# Heading X\n\n[to it](#heading-X)\n',
    '[link](http://example.com/X?q=X#X "title X")\n',
    '![image X](pictures/X.png)\n',
    '<http://example.com/X>\n\nhttp://example.com/X and www.example.com/X and mail@exampleX.com\n',
    '[ref X][X]\n\n[X]: http://example.com/X "X"\n',
    '```X\ncode X\n```\n\n```js X\nconst a = "X";\n```\n\n```mermaid\ngraph X\n```\n\n```math\nX\n```\n',
    '$a_X$ and $$X$$\n\n$$\nX\n$$\n',
    '> [!NOTE] X\n> X\n\n- [ ] task X\n- [x] X\n',
    '<div title="X">X</div>\n\n<!-- X -->\n\n&X; &#xD83D; `X`\n',
    '| X | b |\n| - | - |\n| c | X |\n',
    '---\ntitle: X\n---\n\nX\n',
    'Ref[^X-1].\n\n[^X-1]: note\n[^X-1]: again\n[^unused-X]: X\n',
  ];
  for (const half of ['\ud83d', '\ude00']) {
    for (const source of sources) {
      const text = source.replaceAll('X', half);
      const { blocks, outline } = renderDocument(text);
      assert.ok(blocks.length > 0 && Array.isArray(outline), JSON.stringify(text));
    }
  }
});

// ---- Alerts -------------------------------------------------------------------------------------------------

test('a quote that begins with an alert line becomes an alert of that kind', () => {
  for (const [marker, title] of [
    ['NOTE', 'Note'],
    ['TIP', 'Tip'],
    ['IMPORTANT', 'Important'],
    ['WARNING', 'Warning'],
    ['CAUTION', 'Caution'],
  ]) {
    const { blocks } = renderDocument(`> [!${marker}]\n> The body of it.\n`);
    assert.equal(blocks.length, 1);
    assert.deepEqual([blocks[0].start, blocks[0].end], [0, 2]);
    const html = blocks[0].html;
    assert.ok(html.startsWith(`<div class="alert alert-${marker.toLowerCase()}">`), html);
    assert.equal(textOf(/<p class="alert-title">(.*?)<\/p>/.exec(html)?.[1] ?? ''), title);
    assert.ok(textOf(html).includes('The body of it.'));
    assert.ok(!html.includes('[!') && !html.includes('<blockquote'));
  }
});

test('an alert keeps all of its paragraphs', () => {
  const { blocks } = renderDocument('> [!WARNING]\n>\n> Paragraph one.\n>\n> Paragraph two.\n');
  assert.deepEqual(
    blocks.map((block) => [block.start, block.end]),
    [[0, 5]],
  );
  assert.match(blocks[0].html, /^<div class="alert alert-warning">/);
  assert.ok(textOf(blocks[0].html).includes('Paragraph one.') && textOf(blocks[0].html).includes('Paragraph two.'));
});

test('an alert with nothing but its marker shows the title alone', () => {
  const html = htmlOf('> [!CAUTION]\n');
  assert.match(html, /^<div class="alert alert-caution">/);
  assert.equal(textOf(html).trim(), 'Caution');
});

test('the marker has to be a known one, on a line of its own, at the start of a quote', () => {
  for (const text of ['> [!TIP] text on the same line', '> [!NOTE]**bold** right behind it', '> [!SOMETHING]\n> else', '> A plain quote', '> First line\n> [!NOTE]']) {
    const html = htmlOf(text);
    assert.match(html, /^<blockquote>/, text);
    assert.ok(!html.includes('alert'), text);
  }
  const outside = htmlOf('[!NOTE]\nnot in a quote\n');
  assert.ok(!outside.includes('alert'));
  assert.ok(textOf(outside).includes('[!NOTE]'));
});

test('an alert inside a list item is drawn as one', () => {
  const { blocks } = renderDocument('- > [!IMPORTANT]\n  > nested\n');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].html, /^<ul>/);
  assert.ok(blocks[0].html.includes('<div class="alert alert-important">'));
});

// ---- Diagrams and code --------------------------------------------------------------------------------------

test('a mermaid fence leaves as its source, for the page to draw', () => {
  const source = 'graph TD\n  A["<b>bold</b> & more"] --> B\n  B --> C';
  const { blocks } = renderDocument(`Intro\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`);
  assert.deepEqual([blocks[1].start, blocks[1].end], [2, 7]);
  const html = blocks[1].html;
  assert.ok(html.startsWith('<div class="diagram"><pre><code>'), html);
  assert.ok(html.trimEnd().endsWith('</code></pre></div>'));
  assert.equal(count(html, '<'), 6, 'nothing but the three wrappers is markup');
  assert.equal(textOf(html), `${source}\n\n`);
});

test('other fences are code, highlighted when the language is known', () => {
  const { blocks } = renderDocument('```js\nconst answer = 42;\n```\n\n```\nplain <text>\n```\n\n```mermaidish\nnot a diagram\n```\n');
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    assert.match(block.html, /^<pre/);
    assert.ok(!block.html.includes('class="diagram"'));
  }
  assert.ok(blocks[0].html.includes('hljs'));
  assert.equal(textOf(blocks[0].html).trim(), 'const answer = 42;');
  assert.equal(textOf(blocks[1].html).trim(), 'plain <text>');
});
