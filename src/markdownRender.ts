import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import MarkdownIt from 'markdown-it';

type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];

/** A top-level piece of the document: its source lines `[start, end)` and their rendered HTML. */
export interface Block {
  start: number;
  end: number;
  html: string;
}

/** A top-level heading, for the outline. `id` is the id of its element. */
export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface Rendered {
  blocks: Block[];
  outline: Heading[];
}

interface Footnote {
  /** Position among the footnotes in the order the text first refers to them; 0 while nothing does. */
  number: number;
  refs: number;
}

interface RenderEnv {
  /** Lines taken by front matter, which is cut off before parsing. */
  lineOffset: number;
  slugs: Set<string>;
  outline: Heading[];
  /** Footnotes that have a definition, by label. */
  footnotes: Map<string, Footnote>;
  /** How many of them the text has referred to so far. */
  numbered: number;
  [key: string | symbol]: unknown;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      return `<pre class="hljs"><code>${html}</code></pre>`;
    }
    return '';
  },
});

// ---- Math ---------------------------------------------------------------

// The whole document is rendered again on every change, and nearly all of its formulas are the same as before.
const mathCache = new Map<string, string>();

function renderMath(tex: string, display: boolean, block = false): string {
  const key = `${display ? (block ? 'b' : 'd') : 'i'}${tex}`;
  let html = mathCache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore', maxSize: 100 });
      html = block ? `<div class="math">${html}</div>\n` : html;
    } catch (e) {
      const message = escapeHtml((e instanceof Error ? e.message : String(e)).replace(/^KaTeX parse error: /, ''));
      const source = escapeHtml(tex.trim());
      html = block
        ? `<div class="math math-error"><pre><code>${source}</code></pre><p>${message}</p></div>\n`
        : `<code class="math-error" title="${message}">${source}</code>`;
    }
    if (mathCache.size >= 2000) {
      mathCache.clear();
    }
    mathCache.set(key, html);
  }
  return html;
}

const isWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
const isBlank = (char: string | undefined) => char === undefined || /\s/.test(char);

/** The next `mark` that no backslash escapes, or -1. */
function findUnescaped(src: string, mark: string, from: number): number {
  for (let at = src.indexOf(mark, from); at >= 0; at = src.indexOf(mark, at + 1)) {
    let slashes = 0;
    while (src[at - 1 - slashes] === '\\') {
      slashes++;
    }
    if (slashes % 2 === 0) {
      return at;
    }
  }
  return -1;
}

// `$…$` and, inside a paragraph, `$$…$$`. The rules for a single dollar are strict, because it is far more often
// money than math: it opens only in front of a non-space and not right after a letter or digit, and the next
// dollar has to close it, which it does only right after a non-space and not in front of a letter or digit.
// "$5 and $10", "US$5", "$5-$10" and "20$" all stay text.
md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  const { src, pos: start, posMax } = state;
  if (src.charCodeAt(start) !== 0x24 /* $ */) {
    return false;
  }
  const mark = src.charCodeAt(start + 1) === 0x24 ? '$$' : '$';
  let from = start + mark.length;
  let to: number;
  let end: number;
  if (mark === '$' && src[from] === '`') {
    // GitHub's $`…`$, for a formula that touches the words around it.
    to = src.indexOf('`$', ++from);
    end = to + 2;
  } else {
    if (mark === '$' && (isWord(src[start - 1]) || isBlank(src[from]))) {
      return false;
    }
    to = findUnescaped(src, mark, from);
    end = to + mark.length;
    if (mark === '$' && to >= 0 && (isBlank(src[to - 1]) || (end < posMax && isWord(src[end])))) {
      return false;
    }
  }
  if (to < 0 || end > posMax || src.slice(from, to).trim() === '') {
    return false;
  }
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.markup = mark;
    token.content = src.slice(from, to);
  }
  state.pos = end;
  return true;
});

// A block between `$$` lines, or `$$ … $$` on a line of its own. Blank lines inside don't end it, so it is one
// block of the document however it is laid out. Without the closing `$$` it is not math: a stray `$$` would
// otherwise swallow the rest of the document.
md.block.ruler.before(
  'fence',
  'math_block',
  (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) {
      return false;
    }
    const lineAt = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    const first = lineAt(startLine);
    if (!first.startsWith('$$')) {
      return false;
    }
    // Text after the closing `$$` makes it a paragraph with formulas in it, which the inline rule handles.
    const closes = (line: string, at: number) => at >= 0 && line.slice(at + 2).trim() === '';
    let head = first.slice(2);
    let tail = '';
    let last = startLine;
    const close = head.indexOf('$$');
    if (close >= 0) {
      if (!closes(head, close) || head.slice(0, close).trim() === '') {
        return false;
      }
      head = head.slice(0, close);
    } else {
      for (last = startLine + 1; ; last++) {
        // Never closed, or the list item or quote it is in ends first.
        if (last >= endLine || (state.sCount[last] < state.blkIndent && !state.isEmpty(last))) {
          return false;
        }
        const line = lineAt(last);
        const at = line.indexOf('$$');
        if (at >= 0) {
          if (!closes(line, at)) {
            return false;
          }
          tail = line.slice(0, at);
          break;
        }
      }
    }
    if (silent) {
      return true;
    }
    const middle = last > startLine + 1 ? state.getLines(startLine + 1, last, state.sCount[startLine], true) : '';
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.markup = '$$';
    token.content = `${head}\n${middle}${tail}`;
    token.map = [startLine, last + 1];
    state.line = last + 1;
    return true;
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);

md.renderer.rules.math_inline = (tokens, i) => renderMath(tokens[i].content, tokens[i].markup === '$$');
md.renderer.rules.math_block = (tokens, i) => renderMath(tokens[i].content, true, true);

// ---- Diagrams -----------------------------------------------------------

// Mermaid needs a DOM, so a diagram leaves here as its source and is drawn by the page (see media/markdown.js).
const renderFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, i, options, env, self) => {
  const token = tokens[i];
  const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
  if (lang === 'mermaid') {
    return `<div class="diagram"><pre><code>${escapeHtml(token.content)}</code></pre></div>\n`;
  }
  if (lang === 'math') {
    return renderMath(token.content, true, true);
  }
  return renderFence(tokens, i, options, env, self);
};

// ---- Footnotes ----------------------------------------------------------

// Unlike the usual footnote plugins, a definition is not moved to the end of the page: it stays a block of its
// own where it is written, so it can be edited like any other. Numbers follow the order of the first reference.

// A label is whatever stands between the brackets, half a surrogate pair included, and encodeURIComponent()
// throws on that. An id is made of whole characters, so that the link and its target still say the same.
const whole = (label: string) => label.replace(/\p{Cs}/gu, '\ufffd');
const noteId = (label: string) => `fn-${whole(label)}`;
const refId = (label: string, nth: number) => (nth > 1 ? `fnref-${whole(label)}-${nth}` : `fnref-${whole(label)}`);
const hrefTo = (id: string) => `#${encodeURIComponent(id)}`;

// `[^label]: text`, continued by indented lines. Follows markdown-it-footnote (MIT).
md.block.ruler.before(
  'reference',
  'footnote_def',
  (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4 || !state.src.startsWith('[^', start)) {
      return false;
    }
    let pos = start + 2;
    while (pos < max && state.src.charCodeAt(pos) !== 0x5d /* ] */) {
      if (state.src.charCodeAt(pos) === 0x20) {
        return false;
      }
      pos++;
    }
    if (pos === start + 2 || state.src.charCodeAt(pos + 1) !== 0x3a /* : */ || pos + 1 >= max) {
      return false;
    }
    if (silent) {
      return true;
    }
    const label = state.src.slice(start + 2, pos);
    pos += 2;

    const notes = (state.env as RenderEnv).footnotes;
    const open = state.push('footnote_open', 'div', 1);
    open.block = true;
    // Only the first definition of a label counts.
    open.meta = { label, duplicate: notes.has(label) };
    if (!notes.has(label)) {
      notes.set(label, { number: 0, refs: 0 });
    }

    // The text after the colon is parsed as a block of its own, indented by four like a list item's content.
    const saved = {
      bMark: state.bMarks[startLine],
      tShift: state.tShift[startLine],
      sCount: state.sCount[startLine],
      parentType: state.parentType,
    };
    const colon = pos;
    const initial = state.sCount[startLine] + pos - start;
    let offset = initial;
    for (; pos < max; pos++) {
      const char = state.src.charCodeAt(pos);
      if (char === 0x09) {
        offset += 4 - (offset % 4);
      } else if (char === 0x20) {
        offset++;
      } else {
        break;
      }
    }
    state.tShift[startLine] = pos - colon;
    state.sCount[startLine] = offset - initial;
    state.bMarks[startLine] = colon;
    state.blkIndent += 4;
    (state as { parentType: string }).parentType = 'footnote';
    if (state.sCount[startLine] < state.blkIndent) {
      state.sCount[startLine] += state.blkIndent;
    }

    state.md.block.tokenize(state, startLine, endLine);

    state.parentType = saved.parentType;
    state.blkIndent -= 4;
    state.tShift[startLine] = saved.tShift;
    state.sCount[startLine] = saved.sCount;
    state.bMarks[startLine] = saved.bMark;

    open.map = [startLine, state.line];
    state.push('footnote_close', 'div', -1).block = true;
    return true;
  },
  { alt: ['paragraph', 'reference'] },
);

// `[^label]` where a definition with that label exists; anything else stays as written.
md.inline.ruler.after('image', 'footnote_ref', (state, silent) => {
  const { src, pos: start, posMax } = state;
  if (!src.startsWith('[^', start)) {
    return false;
  }
  let pos = start + 2;
  while (pos < posMax && src.charCodeAt(pos) !== 0x5d /* ] */) {
    if (src.charCodeAt(pos) === 0x20 || src.charCodeAt(pos) === 0x0a) {
      return false;
    }
    pos++;
  }
  if (pos === start + 2 || pos >= posMax) {
    return false;
  }
  const label = src.slice(start + 2, pos);
  const note = (state.env as RenderEnv).footnotes.get(label);
  if (!note) {
    return false;
  }
  if (!silent) {
    note.number ||= ++(state.env as RenderEnv).numbered;
    note.refs++;
    state.push('footnote_ref', '', 0).meta = { label, number: note.number, nth: note.refs };
  }
  state.pos = pos + 1;
  return true;
});

// Links back to every place the text refers to a footnote from. They can only be written once the whole text
// has been read, and go to the end of the footnote's last paragraph.
md.core.ruler.push('previewix_footnotes', (state) => {
  const notes = (state.env as RenderEnv).footnotes;
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'footnote_open') {
      continue;
    }
    const { label, duplicate } = tokens[i].meta as { label: string; duplicate: boolean };
    const note = notes.get(label);
    if (duplicate || !note?.refs) {
      continue;
    }
    let close = i;
    for (let depth = 1; depth > 0; ) {
      depth += tokens[++close].nesting;
    }
    let html = '';
    for (let nth = 1; nth <= note.refs; nth++) {
      const mark = nth > 1 ? `↩<sup>${nth}</sup>` : '↩';
      html += ` <a class="footnote-back" href="${hrefTo(refId(label, nth))}" title="Back to the text">${mark}</a>`;
    }
    const last = tokens[close - 2];
    if (tokens[close - 1].type === 'paragraph_close' && last?.type === 'inline' && last.children) {
      const back = new state.Token('html_inline', '', 0);
      back.content = html;
      last.children.push(back);
    } else {
      tokens[close].meta = { back: html };
    }
  }
});

md.renderer.rules.footnote_ref = (tokens, i) => {
  const { label, number, nth } = tokens[i].meta as { label: string; number: number; nth: number };
  const id = escapeHtml(refId(label, nth));
  return `<sup class="footnote-ref"><a href="${hrefTo(noteId(label))}" id="${id}">${number}</a></sup>`;
};

md.renderer.rules.footnote_open = (tokens, i, _options, env) => {
  const { label, duplicate } = tokens[i].meta as { label: string; duplicate: boolean };
  const note = (env as RenderEnv).footnotes.get(label);
  if (duplicate || !note?.number) {
    // Shown rather than dropped, since a block that isn't on the page can't be edited.
    const why = duplicate ? 'Another footnote has this label' : 'Nothing in the text refers to this footnote';
    return `<div class="footnote unused" title="${why}"><span class="footnote-mark">[^${escapeHtml(label)}]</span><div class="footnote-text">`;
  }
  return `<div class="footnote" id="${escapeHtml(noteId(label))}"><span class="footnote-mark">${note.number}.</span><div class="footnote-text">`;
};

md.renderer.rules.footnote_close = (tokens, i) => {
  const back = (tokens[i].meta as { back?: string } | null)?.back;
  return `${back ? `<p>${back}</p>` : ''}</div></div>\n`;
};

// ---- Alerts -------------------------------------------------------------

const ALERTS: Record<string, [title: string, icon: string]> = {
  note: ['Note', '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.5V11M8 5v.01"/>'],
  tip: ['Tip', '<path d="M6.25 13.75h3.5M6.25 11.5c0-1.4-1.75-2.1-1.75-4.5a3.5 3.5 0 0 1 7 0c0 2.4-1.75 3.1-1.75 4.5z"/>'],
  important: ['Important', '<path d="M2.25 2.75h11.5v8.5h-5.5l-3 2.5v-2.5h-3z"/><path d="M8 5v2.75M8 9.25v.01"/>'],
  warning: ['Warning', '<path d="M8 2.25 14.5 13.5h-13z"/><path d="M8 6.5v3.25M8 11.5v.01"/>'],
  caution: ['Caution', '<path d="M5.5 1.75h5l3.75 3.75v5l-3.75 3.75h-5L1.75 10.5v-5z"/><path d="M8 4.75V8.5M8 11v.01"/>'],
};

// GitHub alerts: a quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`.
md.core.ruler.push('previewix_alerts', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const inline = tokens[i + 2];
    if (tokens[i].type !== 'blockquote_open' || tokens[i + 1].type !== 'paragraph_open' || inline.type !== 'inline') {
      continue;
    }
    const children = inline.children ?? [];
    const match = children[0]?.type === 'text' && /^\[!(note|tip|important|warning|caution)\]\s*$/i.exec(children[0].content);
    // The marker has its line to itself.
    if (!match || (children.length > 1 && !/^(soft|hard)break$/.test(children[1].type))) {
      continue;
    }
    const kind = match[1].toLowerCase();
    const [title, icon] = ALERTS[kind];

    let close = i;
    for (let depth = 1; depth > 0; ) {
      depth += tokens[++close].nesting;
    }
    tokens[i].tag = tokens[close].tag = 'div';
    tokens[i].attrJoin('class', `alert alert-${kind}`);

    const head = new state.Token('html_block', '', 0);
    head.content = `<p class="alert-title"><svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg>${title}</p>\n`;
    children.splice(0, 2);
    if (children.length) {
      tokens.splice(i + 1, 0, head);
    } else {
      // Nothing but the marker in the first paragraph: the title takes its place.
      tokens.splice(i + 1, 3, head);
    }
  }
});

// ---- Task lists and headings --------------------------------------------

// GitHub-style task lists. Each checkbox remembers its source line so a click can toggle it in the file.
md.core.ruler.push('previewix_tasks', (state) => {
  const tokens = state.tokens;
  const offset = (state.env as RenderEnv).lineOffset ?? 0;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') {
      continue;
    }
    const first = inline.children?.[0];
    const match = /^\[([ xX])\][  ]/.exec(inline.content);
    if (!match || first?.type !== 'text' || !first.content.startsWith(match[0])) {
      continue;
    }
    first.content = first.content.slice(match[0].length);
    const box = new state.Token('html_inline', '', 0);
    const checked = match[1] === ' ' ? '' : ' checked';
    box.content = `<input type="checkbox" class="task" data-line="${(inline.map?.[0] ?? 0) + offset}"${checked}> `;
    inline.children!.unshift(box);
    tokens[i - 2].attrJoin('class', 'task-item');
  }
});

/** What a heading says, without its markup. */
function plainText(tokens: Token[]): string {
  let text = '';
  for (const token of tokens) {
    if (token.children) {
      text += plainText(token.children);
    } else if (token.type === 'text' || token.type === 'code_inline' || token.type === 'math_inline') {
      text += token.content;
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      text += ' ';
    }
  }
  return text;
}

// Heading ids, so that in-document links like [x](#section) have a target, and the outline.
// The ids are the ones GitHub gives: lower case, punctuation dropped, a hyphen for every space, and "-1", "-2"
// for a repeated heading.
md.core.ruler.push('previewix_heading_ids', (state) => {
  const { slugs, outline } = state.env as RenderEnv;
  state.tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') {
      return;
    }
    const text = plainText(state.tokens[i + 1].children ?? []).trim();
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, '')
        .replace(/\s/g, '-') || 'section';
    let id = base;
    for (let n = 1; slugs.has(id); n++) {
      id = `${base}-${n}`;
    }
    slugs.add(id);
    token.attrSet('id', id);
    if (token.level === 0) {
      outline.push({ level: Number(token.tag.slice(1)), text, id });
    }
  });
});

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function renderDocument(text: string): Rendered {
  const lines = splitLines(text);
  const blocks: Block[] = [];

  let offset = 0;
  if (lines[0] === '---') {
    const close = lines.findIndex((line, i) => i > 0 && (line === '---' || line === '...'));
    if (close > 0) {
      offset = close + 1;
      const yaml = escapeHtml(lines.slice(1, close).join('\n'));
      blocks.push({ start: 0, end: offset, html: `<pre class="frontmatter"><code>${yaml}</code></pre>` });
    }
  }

  const env: RenderEnv = { lineOffset: offset, slugs: new Set(), outline: [], footnotes: new Map(), numbered: 0 };
  const tokens = md.parse(lines.slice(offset).join('\n'), env);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let last = i;
    if (token.nesting === 1) {
      for (let depth = 1; depth > 0; ) {
        depth += tokens[++last].nesting;
      }
    }
    if (token.map) {
      const start = token.map[0] + offset;
      let end = token.map[1] + offset;
      // Some blocks (lists, for one) claim the blank lines that follow them.
      while (end > start + 1 && lines[end - 1].trim() === '') {
        end--;
      }
      blocks.push({ start, end, html: md.renderer.render(tokens.slice(i, last + 1), md.options, env) });
    }
    i = last;
  }
  return { blocks, outline: env.outline };
}
