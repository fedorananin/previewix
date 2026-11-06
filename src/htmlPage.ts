import { textDecoder } from './textDecoding';

/** How far a browser looks for a `<meta charset>` before it settles on an encoding. */
const PRESCAN = 1024;

const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Decodes an HTML file the way a browser does: by its byte order mark, then by the charset its head declares,
 * else as UTF-8, and as Windows-1252 when the bytes are not valid UTF-8.
 */
export function decodeHtml(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder().decode(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  const start = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, PRESCAN)).toString('latin1').replace(COMMENTS, '');
  const declared = /<meta\s[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(start)?.[1].toLowerCase();
  if (declared === 'utf-8' || declared === 'utf8') {
    return new TextDecoder().decode(bytes);
  }
  // A declaration that could be read as ASCII can't be true about UTF-16, so browsers ignore that one.
  if (declared && !declared.startsWith('utf-16')) {
    try {
      return textDecoder(declared === 'x-user-defined' ? 'windows-1252' : declared).decode(bytes);
    } catch {
      // A name no decoder knows is no declaration.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return textDecoder('windows-1252').decode(bytes);
  }
}

/** A start tag, with whatever its quoted attribute values hold. */
const tag = (name: string, flags: string) => new RegExp(`<${name}(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, flags);

/** The attributes of a start tag, names in lower case; the first of a name counts, as in a browser. */
function attributes(startTag: string): Map<string, string> {
  const found = new Map<string, string>();
  const body = startTag.replace(/^<[^\s/>]+/, '').replace(/>$/, '');
  for (const match of body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!found.has(name)) {
      found.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return found;
}

/**
 * Where the first element of the head can be written: behind the doctype, the `<html>` and the `<head>` tag
 * the file begins with, as far as they are there. Anything put in front of the doctype would switch the page
 * to quirks mode, and anything behind the first element of the head would come too late to apply to it.
 */
export function headStart(html: string): number {
  let at = 0;
  const skip = (pattern: RegExp) => {
    pattern.lastIndex = at;
    if (pattern.test(html)) {
      at = pattern.lastIndex;
    }
  };
  const between = /(?:\s+|<!--[\s\S]*?-->)*/y;
  skip(between);
  skip(/<!doctype[^>]*>/iy);
  skip(between);
  skip(tag('html', 'iy'));
  skip(between);
  skip(tag('head', 'iy'));
  return at;
}

/**
 * What the previewed page may load: the files VS Code serves to it (`source`) and the web, as when the file is
 * opened in a browser. Without `scripts` nothing in the page runs.
 */
export function pagePolicy(source: string, scripts: boolean): string {
  const anywhere = `${source} https: http: data: blob:`;
  return [
    `default-src ${anywhere} 'unsafe-inline'${scripts ? " 'unsafe-eval'" : ''}`,
    `connect-src ${anywhere} wss: ws:`,
    ...(scripts ? [] : ["script-src 'none'"]),
  ].join('; ');
}

/** Elements whose content is text, whatever it looks like. */
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'noscript']);

/** The address relative URLs of the page are resolved against: its folder, or what its own `<base>` makes of that. */
export function baseOf(html: string, folder: string): string {
  // A base counts only in front of the content.
  const body = /<body[\s>]/i.exec(html);
  const head = (body ? html.slice(0, body.index) : html).replace(COMMENTS, '');
  // Tag by tag, so that a "<base" quoted in an attribute or written in a script is not taken for one.
  const tags = tag('([a-z][^\\s/>]*)', 'gi');
  const lower = head.toLowerCase();
  for (let match = tags.exec(head); match; match = tags.exec(head)) {
    const name = match[1].toLowerCase();
    if (RAW_TEXT.has(name)) {
      const end = lower.indexOf(`</${name}`, tags.lastIndex);
      if (end < 0) {
        break;
      }
      tags.lastIndex = end;
    }
    const href = name === 'base' ? attributes(match[0]).get('href') : undefined;
    if (href !== undefined) {
      try {
        return new URL(href.trim(), folder).href;
      } catch {
        return folder;
      }
    }
  }
  return folder;
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export interface PageFrame {
  /** The policy the page is shown under, see `pagePolicy()`. */
  policy: string;
  /** The address of the file's folder as the preview sees it, ending in a slash. */
  folder: string;
  /** The origin the files of the folder are served from, as a policy names it. */
  source: string;
}

/**
 * The file as it is written into the preview: with the policy and a `<base>` as the first things in its head,
 * so that relative addresses lead to the files next to it.
 */
export function preparePage(html: string, frame: PageFrame): string {
  const at = headStart(html);
  const head = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frame.policy)}"><base href="${escapeAttribute(baseOf(html, frame.folder))}">`;
  // A policy of the page's own means the file's folder by 'self'. In the preview the page is not served from
  // there, so that word would shut out every file next to it; the folder is named beside it.
  const rest = html.slice(at).replace(tag('meta', 'gi'), (meta) =>
    attributes(meta).get('http-equiv')?.trim().toLowerCase() === 'content-security-policy' ? meta.replace(/'self'/gi, `'self' ${frame.source}`) : meta,
  );
  return html.slice(0, at) + head + rest;
}
