/**
 * Subtitle files for the video player: which files in a folder belong to a video, what their
 * bytes say, and the same text as WebVTT, the one format a `<track>` reads. No `vscode` import,
 * so all of it can be exercised from Node.
 */
import { textDecoder } from './textDecoding';

export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'];

/** The extensions the video editor is registered for; a subtitle file goes to the video whose name it continues furthest. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'wmv', 'flv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp']);

/** Larger files are not subtitles; the limit keeps a wrong pick in the open dialog from being read into memory. */
export const MAX_SUBTITLE_BYTES = 32 * 1024 * 1024;

export interface Sidecar {
  /** The file name inside the video's folder. */
  name: string;
  /** What the menu shows: the language when the name states one, otherwise the file name. */
  label: string;
  /** BCP 47 code, when the name states a language. */
  language?: string;
  /** True for `movie.srt`, the file that carries no tag at all. */
  exact: boolean;
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() } : { stem: name, ext: '' };
}

/** ISO 639-2 has a second, "bibliographic" code for these languages, and release names use both. */
const BIBLIOGRAPHIC: Record<string, string> = {
  alb: 'sq', arm: 'hy', baq: 'eu', bur: 'my', chi: 'zh', cze: 'cs', dut: 'nl', fre: 'fr', geo: 'ka', ger: 'de',
  gre: 'el', ice: 'is', mac: 'mk', mao: 'mi', may: 'ms', per: 'fa', rum: 'ro', slo: 'sk', tib: 'bo', wel: 'cy',
};

/** Words that describe a track rather than name a language. `sdh` is also the code of Southern Kurdish, which it never means here. */
const FLAGS = new Set(['forced', 'sdh', 'cc', 'default', 'full', 'signs', 'songs', 'commentary']);

let languageNames: Intl.DisplayNames | undefined;

/** Reads a language tag as written in file names and containers: `en`, `eng`, `pt-BR`, `ger`. */
export function languageOf(tag: string): { code: string; name: string } | undefined {
  const lower = tag.toLowerCase().replace(/_/g, '-');
  if (FLAGS.has(lower) || lower === 'und' || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(lower)) {
    return undefined;
  }
  try {
    // Canonicalizing also turns the three-letter codes into the usual two-letter ones.
    const [code] = Intl.getCanonicalLocales(BIBLIOGRAPHIC[lower] ?? lower);
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    const name = languageNames.of(code);
    return name ? { code, name } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The subtitle files among `names` (the files of one folder) that belong to `video`:
 * `movie.srt`, and `movie.<tags>.srt` such as `movie.en.srt` or `movie.pt-BR.forced.vtt`.
 * A file that continues the name of another video in the folder further belongs to that one.
 */
export function findSidecars(names: string[], video: string): Sidecar[] {
  const own = splitName(video).stem.toLowerCase();
  const stems = new Set([own]);
  for (const name of names) {
    const { stem, ext } = splitName(name);
    if (VIDEO_EXTENSIONS.has(ext)) {
      stems.add(stem.toLowerCase());
    }
  }
  const found: Sidecar[] = [];
  for (const name of names) {
    const { stem, ext } = splitName(name);
    if (!SUBTITLE_EXTENSIONS.includes(ext)) {
      continue;
    }
    // The owner is the longest video name the file name starts with, so it is looked for from the full name down, dot by dot.
    let owner = stem.toLowerCase();
    while (owner && !stems.has(owner)) {
      owner = owner.slice(0, Math.max(0, owner.lastIndexOf('.')));
    }
    if (owner !== own) {
      continue;
    }
    const tags = stem.slice(own.length + 1).split('.').filter(Boolean);
    let language: { code: string; name: string } | undefined;
    const rest: string[] = [];
    for (const tag of tags) {
      const read = language ? undefined : languageOf(tag);
      if (read) {
        language = read;
      } else {
        rest.push(FLAGS.has(tag.toLowerCase()) ? tag.toLowerCase() : tag);
      }
    }
    const label = language ? language.name + (rest.length ? ` (${rest.join(', ')})` : '') : name;
    found.push({ name, label, language: language?.code, exact: tags.length === 0 });
  }
  // The file named exactly like the video comes first, then the languages by name, then whatever else there is.
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const rank = (sidecar: Sidecar) => (sidecar.exact ? 0 : sidecar.language ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b) || collator.compare(a.label, b.label) || collator.compare(a.name, b.name));
}

// ---- Text encoding ----------------------------------------------------------

/**
 * The code page a language was written in before UTF-8, for a file that names its language and isn't UTF-8.
 * The Western languages are listed although their page is also what the guess falls back on: a language
 * that is missing here is left to the guess, and Portuguese "ção" or French "éé" look Cyrillic to it.
 */
const CODE_PAGES: [string, string[]][] = [
  ['windows-1252', ['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'sv', 'da', 'no', 'nb', 'nn', 'fi', 'is', 'fo', 'ca', 'gl', 'eu', 'oc', 'co', 'br', 'ga', 'gd', 'lb', 'rm', 'fy', 'af', 'id', 'ms', 'tl', 'fil', 'sw', 'la']],
  ['windows-1251', ['ru', 'uk', 'be', 'bg', 'mk', 'sr', 'kk', 'ky', 'tg', 'mn']],
  ['windows-1250', ['pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl', 'bs', 'sq']],
  ['windows-1253', ['el']],
  ['windows-1254', ['tr', 'az']],
  ['windows-1255', ['he']],
  ['windows-1256', ['ar', 'fa', 'ur']],
  ['windows-1257', ['lt', 'lv', 'et']],
  ['windows-1258', ['vi']],
  ['windows-874', ['th']],
  ['shift_jis', ['ja']],
  ['euc-kr', ['ko']],
  ['gb18030', ['zh']],
];

function codePageOf(language: string | undefined): string | undefined {
  if (!language) {
    return undefined;
  }
  const lower = language.toLowerCase();
  if (/^zh-(hant|tw|hk|mo)\b/.test(lower)) {
    return 'big5';
  }
  const primary = lower.split('-')[0];
  const page = CODE_PAGES.find(([, languages]) => languages.includes(primary))?.[0];
  // A script in the tag outweighs the language's usual one: `az-Cyrl` is Cyrillic, and `sr-Latn` is not. Serbian
  // in Latin letters is Central European; for the other languages of the Cyrillic page the bytes have to say.
  if (/-cyrl\b/.test(lower)) {
    return 'windows-1251';
  }
  if (page === 'windows-1251' && /-latn\b/.test(lower)) {
    return primary === 'sr' ? 'windows-1250' : undefined;
  }
  return page;
}

/**
 * Tells Windows-1251 from Windows-1252 in bytes that are neither UTF-8 nor UTF-16. Cyrillic text
 * is written in runs of letters from the upper half; in Western European text an accented letter
 * stands between plain ones.
 */
function looksCyrillic(bytes: Uint8Array): boolean {
  const isLetter = (byte: number) => byte >= 0xc0 || byte === 0xa8 || byte === 0xb8;
  let letters = 0;
  let inRuns = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (isLetter(bytes[i])) {
      letters++;
      if ((i > 0 && isLetter(bytes[i - 1])) || (i + 1 < bytes.length && isLetter(bytes[i + 1]))) {
        inRuns++;
      }
    }
  }
  return letters > 0 && inRuns * 2 > letters;
}

/** UTF-16 without a byte order mark gives itself away through the zero half of every ASCII character, and timing lines are all ASCII. */
function utf16Order(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  const length = Math.min(bytes.length & ~1, 4096);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < length; i += 2) {
    even += bytes[i] === 0 ? 1 : 0;
    odd += bytes[i + 1] === 0 ? 1 : 0;
  }
  const pairs = length / 2;
  if (pairs < 8) {
    return undefined;
  }
  if (odd > pairs * 0.3 && even < pairs * 0.02) {
    return 'utf-16le';
  }
  return even > pairs * 0.3 && odd < pairs * 0.02 ? 'utf-16be' : undefined;
}

function decodeAs(encoding: string, bytes: Uint8Array): string | undefined {
  try {
    return textDecoder(encoding).decode(bytes);
  } catch {
    return undefined; // a runtime without this code page
  }
}

/**
 * Decodes a subtitle file: UTF-8 and UTF-16 by byte order mark, UTF-16 without one, then UTF-8
 * if the bytes are valid as such. What is left is an old one-byte or East Asian code page, which
 * the bytes don't name: the language from the file name decides, and without it the choice is
 * between Windows-1251 and Windows-1252.
 */
export function decodeSubtitles(bytes: Uint8Array, language?: string): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16 LE' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16 BE' };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8' };
  }
  const order = utf16Order(bytes);
  if (order) {
    return { text: new TextDecoder(order).decode(bytes), encoding: order === 'utf-16le' ? 'UTF-16 LE' : 'UTF-16 BE' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    // Not UTF-8.
  }
  const encoding = codePageOf(language) ?? (looksCyrillic(bytes) ? 'windows-1251' : 'windows-1252');
  const text = decodeAs(encoding, bytes);
  return text === undefined
    ? { text: textDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' }
    : { text, encoding: encoding.replace(/^windows/, 'Windows') };
}

// ---- Conversion to WebVTT ---------------------------------------------------

interface Cue {
  start: number;
  end: number;
  text: string;
  top: boolean;
}

/** Milliseconds as a WebVTT timestamp, which always has two-digit hours and three-digit milliseconds here. */
function timestamp(ms: number): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

function serialize(cues: Cue[]): string {
  // A cue in the upper half says so with `line:0`; the page draws such cues at the top of the picture.
  // WebVTT ends a cue at a line with `-->` in it, so an arrow in the text is spelled out. That is done here, on
  // the text as it is written: tags and override blocks are gone by now, and dropping one can put an arrow
  // together (`--<font>>`, `--{\fs20}>`) that wasn't there for a pass before it.
  const block = (cue: Cue) => `${timestamp(cue.start)} --> ${timestamp(cue.end)}${cue.top ? ' line:0' : ''}\n${cue.text.replace(/-->/g, '--&gt;')}\n`;
  return `WEBVTT\n\n${cues.map(block).join('\n')}`;
}

/** `\an7` to `\an9` put a line at the top of the picture, in ASS and in the SRT files that borrow its tags. */
const TOP = /\\an[789]/;

/**
 * Replaces every `{…}` block of a line with what `replace` makes of its content. One pass with
 * indexOf rather than a regular expression: a line of unclosed braces would send `\{[^}]*\}` over
 * the rest of the line once per brace, and these files come from anywhere.
 */
function mapBlocks(line: string, replace: (content: string) => string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = line.indexOf('{', at);
    const close = open < 0 ? -1 : line.indexOf('}', open + 1);
    if (close < 0) {
      return out + line.slice(at);
    }
    out += line.slice(at, open) + replace(line.slice(open + 1, close));
    at = close + 1;
  }
}

/** WebVTT reads `<` as the start of a tag, so it is spelled out. (`-->` is seen to in `serialize()`.) */
const escapeText = (text: string) => text.replace(/</g, '&lt;');

const SRT_TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?`;
const SRT_TIMING = new RegExp(String.raw`^\s*${SRT_TIME}\s*-+>\s*${SRT_TIME}`);

const srtMs = (h: string | undefined, m: string, s: string, fraction: string | undefined) =>
  (Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number((fraction ?? '').padEnd(3, '0'));

/**
 * Keeps the three styles WebVTT knows (`<i>`, `<b>`, `<u>`, also written `{i}`), drops `<font>` and
 * ASS overrides, and escapes the rest. `top` reports an override that puts the line at the top.
 */
function srtLine(line: string): { text: string; top: boolean } {
  let top = false;
  const text = mapBlocks(line, (content) => {
    if (content.startsWith('\\')) {
      top ||= TOP.test(content);
      return '';
    }
    return /^\/?[ibu]$/i.test(content) ? `<${content}>` : `{${content}}`;
  }).replace(/<(\/?)([ibu])\s*>|<\/?font\b[^<>]*>|</gi, (all: string, slash: string | undefined, tag: string | undefined) =>
    tag ? `<${slash}${tag.toLowerCase()}>` : all === '<' ? '&lt;' : '',
  );
  return { text, top };
}

/**
 * SubRip as it is found: the counter may be missing, a cue may contain an empty line, and the
 * last cue may not end with one. So a cue runs from its timing line to the next timing line, and
 * the counter of the following cue is taken off its end.
 */
function parseSrt(lines: string[]): Cue[] {
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length && !SRT_TIMING.test(lines[i])) {
    i++;
  }
  while (i < lines.length) {
    const m = SRT_TIMING.exec(lines[i]) as RegExpExecArray;
    let next = i + 1;
    while (next < lines.length && !SRT_TIMING.test(lines[next])) {
      next++;
    }
    let last = next;
    if (next < lines.length && last > i + 1 && /^\s*\d+\s*$/.test(lines[last - 1])) {
      last--;
    }
    const read = lines.slice(i + 1, last).map(srtLine);
    const text = read
      .map((line) => line.text)
      .filter((line) => line.trim() !== '')
      .join('\n');
    const start = srtMs(m[1], m[2], m[3], m[4]);
    const end = srtMs(m[5], m[6], m[7], m[8]);
    if (text && end > start) {
      cues.push({ start, end, text, top: read.some((line) => line.top) });
    }
    i = next;
  }
  return cues;
}

/** Only the text of an ASS or SSA script survives: fonts, colors, positions and drawings are not carried over. */
function parseAss(lines: string[]): Cue[] {
  const cues: Cue[] = [];
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let inEvents = false;
  for (const line of lines) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inEvents = section[1].toLowerCase() === 'events';
      continue;
    }
    const entry = inEvents ? /^\s*(Format|Dialogue):\s*(.*)$/i.exec(line) : null;
    if (!entry) {
      continue;
    }
    if (entry[1].toLowerCase() === 'format') {
      fields = entry[2].split(',').map((field) => field.trim().toLowerCase());
      continue;
    }
    // The text is the last field and the only one that may contain commas.
    const values = entry[2].split(',');
    const value = (field: string) => values[fields.indexOf(field)]?.trim() ?? '';
    const raw = values.slice(fields.length - 1).join(',');
    const time = (text: string) => {
      const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(text);
      return m ? srtMs(m[1], m[2], m[3], m[4]) : NaN;
    };
    const start = time(value('start'));
    const end = time(value('end'));
    let top = false;
    let drawing = false;
    const text = mapBlocks(escapeText(raw), (tags) => {
      top ||= TOP.test(tags);
      // \p1 switches to vector drawing: what follows are coordinates, not words.
      drawing ||= /\\p[1-9]/.test(tags);
      return [...tags.matchAll(/\\([ib])([01])(?![0-9])/g)].map(([, tag, on]) => (on === '1' ? `<${tag}>` : `</${tag}>`)).join('');
    })
      .replace(/\\h/g, ' ')
      .split(/\\[Nn]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n');
    if (text && end > start && !drawing) {
      cues.push({ start, end, text, top });
    }
  }
  // Scripts are often ordered by layer or by speaker; WebVTT wants cues in the order they start.
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Turns the text of a subtitle file into WebVTT. The format is told from the content, since a
 * `.vtt` extension on SubRip text and the reverse both occur; `extension` only breaks the tie for
 * ASS. `cues` is the number of cues written, or undefined for a file that already was WebVTT.
 */
export function toWebVtt(source: string, extension = ''): { vtt: string; cues?: number } {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
  if (/^WEBVTT(?:[ \t\n]|$)/.test(text)) {
    return { vtt: text };
  }
  const lines = text.split('\n');
  const ext = extension.toLowerCase();
  const ass = ext === 'ass' || ext === 'ssa' || /^\s*\[Script Info\]/im.test(text.slice(0, 2000));
  const cues = ass ? parseAss(lines) : parseSrt(lines);
  return { vtt: serialize(cues), cues: cues.length };
}
