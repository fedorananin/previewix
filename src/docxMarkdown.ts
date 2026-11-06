import { gfm } from '@joplin/turndown-plugin-gfm';
import mammoth from 'mammoth';
import TurndownService from 'turndown';

export interface MarkdownExport {
  markdown: string;
  /** Files to be written into the image folder the Markdown refers to. */
  images: { name: string; data: Uint8Array }[];
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
};

/**
 * Converts a Word document to Markdown: mammoth maps Word styles to semantic HTML,
 * turndown writes that out as Markdown. `imageDir` is the folder name, relative to
 * the Markdown file, that embedded pictures will be saved in.
 */
export async function docxToMarkdown(data: Uint8Array, imageDir: string): Promise<MarkdownExport> {
  const images: MarkdownExport['images'] = [];
  const { value: html } = await mammoth.convertToHtml(
    { buffer: Buffer.from(data) },
    {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        // mammoth drops page and column breaks, which would glue the text around them together.
        "br[type='page'] => br",
        "br[type='column'] => br",
      ],
      convertImage: mammoth.images.imgElement(async (image) => {
        const extension = IMAGE_EXTENSIONS[image.contentType] ?? 'bin';
        const name = `image${images.length + 1}.${extension}`;
        images.push({ name, data: await image.readAsBuffer() });
        return { src: encodeURI(`${imageDir}/${name}`) };
      }),
    },
  );

  // Word tables rarely mark a header row, but a Markdown table can't do without one: use the first row.
  const withHeaders = html.replace(/<table>[\s\S]*?<\/table>/g, (table) =>
    table.includes('<th')
      ? table
      : table.replace(/<tr>[\s\S]*?<\/tr>/, (row) => row.replace(/<(\/?)td(?=[\s>])/g, '<$1th')),
  );

  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  turndown.use(gfm);
  // In Word one bold or italic run can span several lines. Markdown emphasis can't:
  // the markers have to hug the text on every line, or they show up as literal asterisks.
  const emphasis = (tags: string[], delimiter: string) =>
    turndown.addRule(`emphasis-${tags[0]}`, {
      filter: (node) => tags.includes(node.nodeName.toLowerCase()),
      replacement: (content) =>
        content
          .split(/( {2}\n|\n)/)
          .map((part) => {
            const [, lead, text, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part)!;
            return text ? `${lead}${delimiter}${text}${delimiter}${trail}` : part;
          })
          .join(''),
    });
  emphasis(['strong', 'b'], '**');
  emphasis(['em', 'i'], '*');
  emphasis(['del', 's', 'strike'], '~~');

  // mammoth marks bookmark targets with empty anchors, which would otherwise show up as stray links.
  turndown.addRule('bookmarks', {
    filter: (node) => node.nodeName === 'A' && !node.getAttribute('href'),
    replacement: (content) => content,
  });

  const markdown = turndown
    .turndown(withHeaders)
    // turndown pads list markers to four columns; one space is the common style.
    .replace(/^(\s*(?:[-*+]|\d+\.)) {2,3}(?=\S)/gm, '$1 ')
    // Empty lines made with line breaks become a paragraph break, and a break before one is redundant.
    .replace(/ {2}\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
  return { markdown: markdown + '\n', images };
}
