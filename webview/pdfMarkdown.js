/**
 * Rebuilds Markdown from the text of a PDF. A PDF only stores positioned runs of text,
 * so structure is inferred: larger type becomes headings, vertical gaps and indents
 * separate paragraphs, bullet characters start list items. Tables, images and
 * bold/italic are not recovered.
 */

const BULLET = /^[•‣◦▪●○∙·■□➢✓]\s*(.+)$/;
const NUMBERED = /^(\d{1,3})[.)]\s+(.+)$/;
const SENTENCE_END = /[.!?:;…»”")\]]$/;

/** Groups the text runs of one page (pdf.js `getTextContent().items`) into lines. */
export function pageLines(items) {
  const lines = [];
  let line = null;
  let newLine = true;
  for (const item of items) {
    if (!item.str) {
      newLine ||= item.hasEOL;
      continue;
    }
    const [, , c, d, x, y] = item.transform;
    const size = item.height || Math.hypot(c, d);
    if (!line || newLine || Math.abs(y - line.y) > size * 0.5) {
      line = { x, y, size, right: x, text: '' };
      lines.push(line);
    } else if (x - line.right > size * 0.2 && !line.text.endsWith(' ')) {
      line.text += ' ';
    }
    line.text += item.str;
    line.size = Math.max(line.size, size);
    line.right = x + item.width;
    newLine = item.hasEOL;
  }
  for (const l of lines) {
    l.text = l.text.replace(/\s+/g, ' ').trim();
  }
  return lines.filter((l) => l.text);
}

const roundSize = (size) => Math.round(size * 2) / 2;

function escapeText(text) {
  return text.replace(/([\\`*_<])/g, '\\$1').replace(/^(#{1,6}\s|>|[+-]\s|\d+[.)]\s)/, '\\$1');
}

/** @param {ReturnType<typeof pageLines>[]} pages lines of every page, in order */
export function linesToMarkdown(pages) {
  // The size most of the text is set in is the body size; anything clearly larger is a heading.
  const weight = new Map();
  for (const lines of pages) {
    for (const line of lines) {
      const size = roundSize(line.size);
      weight.set(size, (weight.get(size) ?? 0) + line.text.length);
    }
  }
  const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const headingSizes = [...weight.keys()].filter((size) => size > body * 1.15).sort((a, b) => b - a);
  const headingLevel = (line) => {
    const rank = headingSizes.indexOf(roundSize(line.size));
    return rank >= 0 && line.text.length < 200 ? Math.min(rank + 1, 3) : 0;
  };

  /** @type {{type: 'heading' | 'item' | 'text', level?: number, marker?: string, text: string}[]} */
  const blocks = [];
  let previous = null;
  /** Left edge of the marker of the list item being built. */
  let itemX = 0;

  const append = (block, text) => {
    // A word hyphenated across lines is put back together.
    if (/\p{L}-$/u.test(block.text) && /^\p{Ll}/u.test(text)) {
      block.text = block.text.slice(0, -1) + text;
    } else {
      block.text += ` ${text}`;
    }
  };

  pages.forEach((lines, pageIndex) => {
    const pageRight = Math.max(0, ...lines.map((l) => l.right));
    const pageWidth = pageRight - Math.min(pageRight, ...lines.map((l) => l.x));
    lines.forEach((line, i) => {
      // Page numbers in the header or footer.
      if ((i === 0 || i === lines.length - 1) && /^\d{1,4}$/.test(line.text)) {
        return;
      }
      const last = blocks[blocks.length - 1];
      const samePage = previous?.page === pageIndex;
      const gap = samePage ? previous.line.y - line.y : 0;
      const adjacent = samePage && gap > 0 && gap < Math.max(line.size, previous.line.size) * 1.8;
      const level = headingLevel(line);
      const bullet = BULLET.exec(line.text);
      const numbered = NUMBERED.exec(line.text);

      if (level) {
        // A title wrapped over several lines stays one heading.
        if (last?.type === 'heading' && last.level === level && adjacent) {
          append(last, line.text);
        } else {
          blocks.push({ type: 'heading', level, text: line.text });
        }
      } else if (bullet || numbered) {
        itemX = line.x;
        blocks.push(
          bullet
            ? { type: 'item', marker: '-', text: bullet[1] }
            : { type: 'item', marker: `${numbered[1]}.`, text: numbered[2] },
        );
      } else if (last?.type === 'item' && adjacent && line.x > itemX + line.size * 0.5) {
        // An indented line under a list item continues it.
        append(last, line.text);
      } else {
        const prev = previous?.line;
        // A line that stops well before the right margin ends its paragraph: clearly so when it
        // leaves a third of the width empty, otherwise only if it also ends like a sentence.
        const slack = prev ? pageRight - prev.right : 0;
        const prevShort = slack > pageWidth * 0.3 || (slack > (prev?.size ?? 0) * 4 && SENTENCE_END.test(prev.text));
        const indented = prev && line.x > prev.x + line.size * 0.8;
        const continues =
          last?.type === 'text' &&
          (samePage ? adjacent && !prevShort && !indented : !SENTENCE_END.test(last.text));
        if (continues) {
          append(last, line.text);
        } else {
          blocks.push({ type: 'text', text: line.text });
        }
      }
      previous = { page: pageIndex, line };
    });
  });

  let markdown = '';
  blocks.forEach((block, i) => {
    const before = blocks[i - 1];
    if (before) {
      markdown += before.type === 'item' && block.type === 'item' ? '\n' : '\n\n';
    }
    const text = escapeText(block.text);
    if (block.type === 'heading') {
      markdown += `${'#'.repeat(block.level)} ${text}`;
    } else if (block.type === 'item') {
      markdown += `${block.marker} ${text}`;
    } else {
      markdown += text;
    }
  });
  return markdown ? `${markdown}\n` : '';
}
