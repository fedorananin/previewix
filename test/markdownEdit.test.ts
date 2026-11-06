import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planEdit, toggleTask, type BlockEdit, type EditPlan } from '../src/markdownEdit';
import { splitLines } from '../src/markdownRender';
import { random, type Random } from './helpers';

/**
 * What VS Code does with a plan: `workspace.applyEdit` replaces the range in the document, writes the new
 * text with the document's own line endings, and reads a range that ends one line past the last as ending
 * at the end of the document. Every other position has to exist, so a plan that names a place the document
 * doesn't have fails the test here instead of being clamped silently. A document of a single line doesn't
 * show its line ending, which is why it can be given.
 */
function apply(text: string, plan: EditPlan, eol = text.includes('\r\n') ? '\r\n' : '\n'): string {
  const starts = [0];
  const lengths: number[] = [];
  const breaks = /\r?\n/g;
  let at = 0;
  for (let found = breaks.exec(text); found; found = breaks.exec(text)) {
    lengths.push(found.index - at);
    at = found.index + found[0].length;
    starts.push(at);
  }
  lengths.push(text.length - at);
  const offsetOf = ([line, character]: [number, number]): number => {
    if (line === starts.length && character === 0) {
      return text.length;
    }
    assert.ok(Number.isInteger(line) && line >= 0 && line < starts.length, `line ${line} in a document of ${starts.length}`);
    assert.ok(Number.isInteger(character) && character >= 0 && character <= lengths[line], `character ${character} in line ${line}`);
    return starts[line] + character;
  };
  const from = offsetOf(plan.from);
  const to = offsetOf(plan.to);
  assert.ok(from <= to, 'the range runs forward');
  return text.slice(0, from) + plan.text.replace(/\r?\n/g, eol) + text.slice(to);
}

/** Plans the edit the way the provider does, and applies it. */
function edit(text: string, change: BlockEdit, eol?: string): { text: string; plan: EditPlan } {
  const plan = planEdit(splitLines(text), change);
  return { text: apply(text, plan, eol), plan };
}

/** The lines the plan says the block has afterwards. */
const blockOf = (result: { text: string; plan: EditPlan }) => splitLines(result.text).slice(result.plan.start, result.plan.end);

const crlf = (text: string) => text.replace(/\n/g, '\r\n');

// ---- Replacing a block --------------------------------------------------------------------------------------

test('an edited block replaces exactly its own lines', () => {
  const text = '# Title\n\nFirst paragraph\nsecond line\n\n- a list\n';
  const result = edit(text, { start: 2, end: 4, text: 'Rewritten' });
  assert.equal(result.text, '# Title\n\nRewritten\n\n- a list\n');
  assert.deepEqual(blockOf(result), ['Rewritten']);
});

test('a block may grow, and the plan says where it is afterwards', () => {
  const result = edit('one\n\ntwo\n\nthree\n', { start: 2, end: 3, text: 'two\nand a half\n\nstill the same block' });
  assert.equal(result.text, 'one\n\ntwo\nand a half\n\nstill the same block\n\nthree\n');
  assert.deepEqual([result.plan.start, result.plan.end], [2, 6]);
  assert.deepEqual(blockOf(result), ['two', 'and a half', '', 'still the same block']);
});

test('writing a block back unchanged changes nothing', () => {
  const text = '  indented \n\n\ttabs\tand trailing spaces  \n\n\n\nlast';
  assert.equal(edit(text, { start: 2, end: 3, text: '\ttabs\tand trailing spaces  ' }).text, text);
  assert.equal(edit(text, { start: 0, end: 1, text: '  indented ' }).text, text);
  assert.equal(edit(text, { start: 6, end: 7, text: 'last' }).text, text);
});

test('the first and the last block keep what is around them', () => {
  assert.equal(edit('first\n\nlast', { start: 0, end: 1, text: 'FIRST' }).text, 'FIRST\n\nlast');
  // A final newline is neither added nor taken away.
  assert.equal(edit('first\n\nlast', { start: 2, end: 3, text: 'LAST' }).text, 'first\n\nLAST');
  assert.equal(edit('first\n\nlast\n', { start: 2, end: 3, text: 'LAST' }).text, 'first\n\nLAST\n');
  assert.equal(edit('first\n\nlast\n\n\n', { start: 2, end: 3, text: 'LAST' }).text, 'first\n\nLAST\n\n\n');
});

test('a block emptied without `remove` leaves an empty line', () => {
  const result = edit('one\n\ntwo\n\nthree', { start: 2, end: 3, text: '' });
  assert.equal(result.text, 'one\n\n\n\nthree');
  assert.deepEqual([result.plan.start, result.plan.end], [2, 3]);
});

test('a document with CRLF keeps its line endings, outside the block and inside it', () => {
  const text = crlf('# Title\n\nFirst\nsecond\n\nlast\n');
  const result = edit(text, { start: 2, end: 4, text: 'One\nTwo\nThree' });
  assert.equal(result.text, crlf('# Title\n\nOne\nTwo\nThree\n\nlast\n'));
  assert.deepEqual(blockOf(result), ['One', 'Two', 'Three']);
});

test('lines with other line endings than the rest are left as they are', () => {
  const text = 'unix\n\nwindows\r\n\r\nedited\r\n\nunix again';
  assert.equal(edit(text, { start: 4, end: 5, text: 'changed' }).text, 'unix\n\nwindows\r\n\r\nchanged\r\n\nunix again');
});

// ---- A new block at the end ---------------------------------------------------------------------------------

test('a new block in an empty document is the whole document', () => {
  for (const text of ['', '\n', '\n\n\n', '  \n\t\n']) {
    const result = edit(text, { start: 0, end: 0, text: '# New\ntext' });
    assert.equal(result.text, '# New\ntext', JSON.stringify(text));
    assert.deepEqual(blockOf(result), ['# New', 'text']);
  }
});

test('a new block is set off from the last one by one blank line', () => {
  for (const text of ['# Title\n\nlast', '# Title\n\nlast\n', '# Title\n\nlast\n\n']) {
    // The webview names the line after the last one; any empty range means "at the end".
    const at = splitLines(text).length;
    const result = edit(text, { start: at, end: at, text: 'new\nblock' });
    assert.equal(result.text, '# Title\n\nlast\n\nnew\nblock', JSON.stringify(text));
    assert.deepEqual(blockOf(result), ['new', 'block']);
  }
});

test('a new block never rewrites what is already there', () => {
  const text = 'last\n\n\n\n';
  const result = edit(text, { start: 9, end: 9, text: 'new' });
  assert.equal(result.text, 'last\n\n\n\nnew');
  assert.deepEqual(blockOf(result), ['new']);
});

test('a new block in a CRLF document is set off with CRLF', () => {
  const result = edit('last\r\n', { start: 2, end: 2, text: 'new\nblock' });
  assert.equal(result.text, 'last\r\n\r\nnew\r\nblock');
  assert.deepEqual(blockOf(result), ['new', 'block']);
});

// ---- Removing a block ---------------------------------------------------------------------------------------

const THREE = 'first\n\nmiddle\nsecond line\n\nlast\n';

test('removing the first block takes the blank line after it', () => {
  const result = edit(THREE, { start: 0, end: 1, text: '', remove: true });
  assert.equal(result.text, 'middle\nsecond line\n\nlast\n');
  assert.deepEqual([result.plan.start, result.plan.end], [0, 0]);
});

test('removing a block in the middle leaves one blank line, not two', () => {
  const result = edit(THREE, { start: 2, end: 4, text: '', remove: true });
  assert.equal(result.text, 'first\n\nlast\n');
  assert.deepEqual([result.plan.start, result.plan.end], [2, 2]);
});

test('removing the last block takes the blank line before it', () => {
  const result = edit(THREE, { start: 5, end: 6, text: '', remove: true });
  assert.equal(result.text, 'first\n\nmiddle\nsecond line\n');
  assert.deepEqual([result.plan.start, result.plan.end], [5, 5]);
  // Without a final newline the blank line's own break is what ends the file now.
  assert.equal(edit('first\n\nlast', { start: 2, end: 3, text: '', remove: true }).text, 'first\n');
  assert.equal(edit('first\nlast', { start: 1, end: 2, text: '', remove: true }).text, 'first');
});

test('removing the only block empties the document', () => {
  for (const text of ['only', 'only\n', 'only\nblock\n']) {
    assert.equal(edit(text, { start: 0, end: splitLines(text.trimEnd()).length, text: '', remove: true }).text, '', JSON.stringify(text));
  }
});

test('removing a block that touches its neighbour takes only its own lines', () => {
  const text = '# Heading\ntext under it\n\nmore\n';
  assert.equal(edit(text, { start: 0, end: 1, text: '', remove: true }).text, 'text under it\n\nmore\n');
  assert.equal(edit(text, { start: 1, end: 2, text: '', remove: true }).text, '# Heading\n\nmore\n');
  // Blank before, none after: the gap in front of the block is the one that stays.
  assert.equal(edit('one\n\ntwo\nthree\n', { start: 2, end: 3, text: '', remove: true }).text, 'one\n\nthree\n');
});

test('removing from a CRLF document leaves only CRLF', () => {
  assert.equal(edit(crlf(THREE), { start: 2, end: 4, text: '', remove: true }).text, crlf('first\n\nlast\n'));
  assert.equal(edit(crlf(THREE), { start: 5, end: 6, text: '', remove: true }).text, crlf('first\n\nmiddle\nsecond line\n'));
  assert.equal(edit(crlf(THREE), { start: 0, end: 1, text: '', remove: true }).text, crlf('middle\nsecond line\n\nlast\n'));
});

test('the text of a removal is ignored', () => {
  assert.equal(edit(THREE, { start: 2, end: 4, text: 'left over', remove: true }).text, 'first\n\nlast\n');
});

// ---- Random documents ---------------------------------------------------------------------------------------

const WORDS = ['alpha', 'beta  ', '\tgamma', '  - item', '> quote', '# head', 'ünïcödé', '漢字', '😀 emoji', 'a | b', '`code`', 'x  ', '[ ] box', '$5'];

interface Sample {
  text: string;
  eol: string;
  lines: string[];
  /** Line ranges `[start, end)` of the blocks. */
  blocks: [number, number][];
  /** Where each line starts in `text`. */
  offsets: number[];
}

/** A document of one to six blocks. A tidy one has at most one blank line between blocks and no blank line at either end. */
function sample(rnd: Random, tidy: boolean): Sample {
  const eol = rnd.pick(['\n', '\r\n']);
  const lines: string[] = [];
  const blocks: [number, number][] = [];
  const blank = (count: number) => lines.push(...Array<string>(count).fill(''));
  if (!tidy) {
    blank(rnd.int(3));
  }
  const count = 1 + rnd.int(6);
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      blank(tidy ? rnd.int(2) : rnd.int(4));
    }
    const start = lines.length;
    for (let n = 1 + rnd.int(4); n > 0; n--) {
      lines.push(`${rnd.pick(WORDS)} ${rnd.pick(WORDS)}`);
    }
    blocks.push([start, lines.length]);
  }
  blank(tidy ? rnd.int(2) : rnd.int(4));
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + eol.length;
  }
  return { text: lines.join(eol), eol, lines, blocks, offsets };
}

/** One to four lines for a block; a line in the middle may be empty, as in a loose list. */
function newText(rnd: Random): string {
  const count = 1 + rnd.int(4);
  return Array.from({ length: count }, (_, i) => (i > 0 && i < count - 1 && rnd.int(4) === 0 ? '' : rnd.pick(WORDS))).join('\n');
}

/** No line of the document ends in another way than the document does. */
function assertOneLineEnding(text: string, eol: string): void {
  assert.ok(eol === '\r\n' ? !/(^|[^\r])\n/.test(text) : !text.includes('\r'), `mixed line endings in ${JSON.stringify(text)}`);
}

test('random edits: every byte outside the edited block stays', () => {
  const rnd = random(20261008);
  for (let round = 0; round < 300; round++) {
    const doc = sample(rnd, round % 2 === 0);
    const [start, end] = rnd.pick(doc.blocks);
    const text = newText(rnd);
    const result = edit(doc.text, { start, end, text }, doc.eol);
    const before = doc.text.slice(0, doc.offsets[start]);
    const after = doc.text.slice(doc.offsets[end - 1] + doc.lines[end - 1].length);
    assert.equal(result.text, before + text.replace(/\n/g, doc.eol) + after, `round ${round}`);
    assert.deepEqual(blockOf(result), text.split('\n'), `round ${round}`);
  }
});

test('random removals: the other lines stay, and at most one blank line next to the block goes', () => {
  const rnd = random(4242);
  for (let round = 0; round < 300; round++) {
    const tidy = round % 2 === 0;
    const doc = sample(rnd, tidy);
    const [start, end] = rnd.pick(doc.blocks);
    const result = edit(doc.text, { start, end, text: '', remove: true }, doc.eol);
    const before = doc.lines.slice(0, start);
    const after = doc.lines.slice(end);
    const allowed = [[...before, ...after]];
    if (before.at(-1) === '') {
      allowed.push([...before.slice(0, -1), ...after]);
    }
    if (after[0] === '') {
      allowed.push([...before, ...after.slice(1)]);
    }
    const message = `round ${round}: ${JSON.stringify(doc.text)} without [${start}, ${end}) became ${JSON.stringify(result.text)}`;
    assert.ok(allowed.some((lines) => lines.join(doc.eol) === result.text), message);
    assert.deepEqual([result.plan.start, result.plan.end], [start, start], message);
    assertOneLineEnding(result.text, doc.eol);
    if (tidy) {
      // A tidy document stays tidy: no gap of two blank lines, none at the top, none dangling at the end.
      const tripled = doc.eol.repeat(3);
      assert.ok(!result.text.includes(tripled) && !result.text.startsWith(doc.eol) && !result.text.endsWith(doc.eol.repeat(2)), message);
    }
  }
});

test('random additions: the document stays as it is and the new block follows after a blank line', () => {
  const rnd = random(777);
  for (let round = 0; round < 200; round++) {
    const doc = sample(rnd, round % 2 === 0);
    const text = newText(rnd);
    const at = doc.lines.length + rnd.int(3);
    const result = edit(doc.text, { start: at, end: at, text }, doc.eol);
    const message = `round ${round}: ${JSON.stringify(doc.text)} became ${JSON.stringify(result.text)}`;
    assert.ok(result.text.startsWith(doc.text), message);
    assert.deepEqual(blockOf(result), text.split('\n'), message);
    assert.equal(result.plan.end, splitLines(result.text).length, message);
    assertOneLineEnding(result.text, doc.eol);
    // One blank line between the last block and the new one, or as many as there already were.
    const lastText = doc.blocks[doc.blocks.length - 1][1] - 1;
    const gap = splitLines(result.text).slice(lastText + 1, result.plan.start);
    const emptyLinesAtEnd = doc.lines.length - 1 - lastText;
    assert.ok(gap.every((line) => line === ''), message);
    assert.equal(gap.length, Math.max(1, emptyLinesAtEnd - 1), message);
  }
});

// ---- Task checkboxes ----------------------------------------------------------------------------------------

test('toggleTask checks an open box and opens a checked one', () => {
  assert.equal(toggleTask('- [ ] buy milk'), '- [x] buy milk');
  assert.equal(toggleTask('- [x] buy milk'), '- [ ] buy milk');
  assert.equal(toggleTask('* [X] shouted'), '* [ ] shouted');
  assert.equal(toggleTask('12. [ ] numbered'), '12. [x] numbered');
});

test('toggleTask changes nothing else on the line', () => {
  assert.equal(toggleTask('\t  - [ ] indented, with trailing spaces  '), '\t  - [x] indented, with trailing spaces  ');
  assert.equal(toggleTask('> - [x] quoted'), '> - [ ] quoted');
  // Only the first box is the item's own; one further on is part of its text.
  assert.equal(toggleTask('- [ ] mentions [x] and [ ] later'), '- [x] mentions [x] and [ ] later');
  assert.equal(toggleTask('- [x] mentions [ ] later'), '- [ ] mentions [ ] later');
});

test('toggleTask answers undefined for a line without a box', () => {
  for (const line of ['', 'plain text', '- item', '- [link](target)', '- [  ] two spaces', '- [y] another letter', '- [] empty']) {
    assert.equal(toggleTask(line), undefined, JSON.stringify(line));
  }
});

test('toggling twice gives the line back', () => {
  for (const line of ['- [ ] a', '  1. [x] b', '- [ ] c [x] d']) {
    assert.equal(toggleTask(toggleTask(line) as string), line);
  }
});
