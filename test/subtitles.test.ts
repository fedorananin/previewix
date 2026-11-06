import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSubtitles, findSidecars, toWebVtt } from '../src/subtitles';
import { random } from './helpers';

// ---- Which files belong to a video --------------------------------------------------------------------------

const namesOf = (names: string[], video: string) => findSidecars(names, video).map((sidecar) => sidecar.name);

test('the subtitle files that continue the name of the video are its own', () => {
  const folder = ['movie.mp4', 'movie.srt', 'movie.en.srt', 'movie.pt-BR.forced.vtt', 'movie.ass', 'movie.ssa', 'notes.txt', 'poster.jpg'];
  assert.deepEqual(namesOf(folder, 'movie.mp4').sort(), ['movie.ass', 'movie.en.srt', 'movie.pt-BR.forced.vtt', 'movie.srt', 'movie.ssa']);
});

test('names that only look alike are left out', () => {
  const folder = [
    'movie.mkv',
    'movie 2.srt', // another name
    'movies.srt',
    'moviesrt',
    'other.srt',
    'movie.srt.bak', // not a subtitle file
    'movie.txt',
    'movie.sub',
    'movie',
    '.srt',
    'srt',
  ];
  assert.deepEqual(namesOf(folder, 'movie.mkv'), []);
});

test('upper and lower case make no difference, in the name or in the extension', () => {
  const folder = ['Movie.MKV', 'movie.SRT', 'MOVIE.En.Srt', 'mOvIe.vtt'];
  assert.deepEqual(namesOf(folder, 'Movie.MKV').sort(), ['MOVIE.En.Srt', 'mOvIe.vtt', 'movie.SRT']);
  assert.deepEqual(namesOf(folder, 'MOVIE.mkv').sort(), ['MOVIE.En.Srt', 'mOvIe.vtt', 'movie.SRT']);
});

test('a file that continues another video’s name further belongs to that one', () => {
  const folder = ['clip.mp4', 'clip.part2.webm', 'clip.srt', 'clip.en.srt', 'clip.part2.srt', 'clip.part2.en.srt', 'clip.part2.extra.de.srt'];
  assert.deepEqual(namesOf(folder, 'clip.mp4').sort(), ['clip.en.srt', 'clip.srt']);
  assert.deepEqual(namesOf(folder, 'clip.part2.webm').sort(), ['clip.part2.en.srt', 'clip.part2.extra.de.srt', 'clip.part2.srt']);
});

test('only another video takes a file away: a tag that no video is named after stays with this one', () => {
  const folder = ['clip.mp4', 'clip.part2.txt', 'clip.part2.srt', 'clip.part2.en.srt'];
  assert.deepEqual(namesOf(folder, 'clip.mp4').sort(), ['clip.part2.en.srt', 'clip.part2.srt']);
});

test('the video does not have to be in the list, and a dotted video name is taken whole', () => {
  assert.deepEqual(namesOf(['show.s01e02.srt', 'show.srt', 'show.s01e02.en.srt'], 'show.s01e02.mkv').sort(), ['show.s01e02.en.srt', 'show.s01e02.srt']);
});

test('a language in the name is read: two letters, three letters, with a region', () => {
  const folder = ['m.en.srt', 'm.eng.srt', 'm.ger.srt', 'm.fre.srt', 'm.chi.srt', 'm.pt-BR.srt', 'm.pt_BR.vtt', 'm.zh-Hant.ass', 'm.RU.srt'];
  const languages = Object.fromEntries(findSidecars(folder, 'm.mp4').map((sidecar) => [sidecar.name, sidecar.language]));
  assert.deepEqual(languages, {
    'm.en.srt': 'en',
    'm.eng.srt': 'en',
    'm.ger.srt': 'de',
    'm.fre.srt': 'fr',
    'm.chi.srt': 'zh',
    'm.pt-BR.srt': 'pt-BR',
    'm.pt_BR.vtt': 'pt-BR',
    'm.zh-Hant.ass': 'zh-Hant',
    'm.RU.srt': 'ru',
  });
});

test('words that describe a track are not languages', () => {
  const found = findSidecars(['m.forced.srt', 'm.sdh.srt', 'm.und.srt', 'm.cc.srt', 'm.2.srt', 'm.director.srt'], 'm.mp4');
  assert.equal(found.length, 6);
  for (const sidecar of found) {
    assert.equal(sidecar.language, undefined, sidecar.name);
    // Without a language the menu can only show the file name.
    assert.equal(sidecar.label, sidecar.name);
    assert.equal(sidecar.exact, false);
  }
});

test('the label is the language, with the other tags in brackets', () => {
  const label = (name: string) => findSidecars([name], 'movie.mp4')[0].label;
  assert.equal(label('movie.en.srt'), 'English');
  assert.equal(label('movie.eng.forced.srt'), 'English (forced)');
  assert.equal(label('movie.de.SDH.srt'), 'German (sdh)');
  assert.equal(label('movie.srt'), 'movie.srt');
});

test('the file named exactly like the video comes first, then the languages by name, then the rest', () => {
  const folder = ['movie.zzz-notes.srt', 'movie.ru.srt', 'movie.de.srt', 'movie.vtt', 'movie.en.srt', 'movie.10.srt', 'movie.9.srt'];
  const found = findSidecars(folder, 'movie.mp4');
  assert.deepEqual(
    found.map((sidecar) => sidecar.name),
    // English, German, Russian; then the names, numbers by value.
    ['movie.vtt', 'movie.en.srt', 'movie.de.srt', 'movie.ru.srt', 'movie.9.srt', 'movie.10.srt', 'movie.zzz-notes.srt'],
  );
  assert.deepEqual(
    found.map((sidecar) => sidecar.exact),
    [true, false, false, false, false, false, false],
  );
});

// ---- Text encoding ------------------------------------------------------------------------------------------

const SCRIPT = '1\n00:00:01,000 --> 00:00:04,000\n';
const ascii = (text: string) => Buffer.from(text, 'latin1');

/** Windows-1251, written out by its table: the alphabet runs from 0xC0, the two forms of Ё stand apart. */
function cp1251(text: string): Buffer {
  return Buffer.from(
    [...text].map((char) => {
      const code = char.codePointAt(0) as number;
      if (code < 0x80) {
        return code;
      }
      if (code >= 0x410 && code <= 0x44f) {
        return code - 0x410 + 0xc0;
      }
      const other = { Ё: 0xa8, ё: 0xb8, '—': 0x97 }[char];
      assert.ok(other, `no byte for ${char}`);
      return other;
    }),
  );
}

/** The `skip` option for a test that needs a code page some builds of Node (those with small ICU) don't have. */
function page(encoding: string): string | false {
  try {
    new TextDecoder(encoding);
    return false;
  } catch {
    return `this runtime cannot decode ${encoding}`;
  }
}

test('UTF-8 is read as UTF-8, with and without a byte order mark', () => {
  const text = `${SCRIPT}Grüße — “quotes”, Привет, こんにちは\n`;
  assert.deepEqual(decodeSubtitles(Buffer.from(text, 'utf8')), { text, encoding: 'UTF-8' });
  assert.deepEqual(decodeSubtitles(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), { text, encoding: 'UTF-8' });
  assert.deepEqual(decodeSubtitles(ascii(`${SCRIPT}plain\n`)), { text: `${SCRIPT}plain\n`, encoding: 'UTF-8' });
});

test('a UTF-8 byte order mark decides, even when a byte further on is wrong', () => {
  const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${SCRIPT}Привет `, 'utf8'), Buffer.from([0xe9]), ascii(' x\n')]);
  assert.deepEqual(decodeSubtitles(file, 'ru'), { text: `${SCRIPT}Привет \ufffd x\n`, encoding: 'UTF-8' });
});

test('UTF-16 is read by its byte order mark', () => {
  const text = `${SCRIPT}Größe, Привіт, 世界\n`;
  const le = Buffer.from(`﻿${text}`, 'utf16le');
  assert.deepEqual(decodeSubtitles(le), { text, encoding: 'UTF-16 LE' });
  assert.deepEqual(decodeSubtitles(Buffer.from(le).swap16()), { text, encoding: 'UTF-16 BE' });
});

test('UTF-16 without a byte order mark is recognised by its zero bytes', () => {
  const text = `${SCRIPT}Привіт, світе\n\n2\n00:00:05,000 --> 00:00:08,000\nЇжак і ґанок\n`;
  const le = Buffer.from(text, 'utf16le');
  assert.deepEqual(decodeSubtitles(le), { text, encoding: 'UTF-16 LE' });
  assert.deepEqual(decodeSubtitles(Buffer.from(le).swap16()), { text, encoding: 'UTF-16 BE' });
});

test('an empty file is empty text', () => {
  assert.equal(decodeSubtitles(new Uint8Array(0)).text, '');
});

// The bytes are written out from the code page tables, so the test doesn't lean on the decoder it checks.
const CODE_PAGES: [language: string, encoding: string, bytes: number[], text: string][] = [
  ['pl', 'windows-1250', [0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6, 0x20, 0x67, 0xea, 0x9c, 0x6c, 0xb9, 0x20, 0x6a, 0x61, 0x9f, 0xf1], 'Zażółć gęślą jaźń'],
  ['cs', 'windows-1250', [0xf8, 0x65, 0xf8, 0x69, 0x63, 0x68, 0x61], 'řeřicha'],
  ['uk', 'windows-1251', [0xaf, 0xe6, 0xe0, 0xea, 0x20, 0xb3, 0x20, 0xb4, 0xe0, 0xed, 0xee, 0xea], 'Їжак і ґанок'],
  ['el', 'windows-1253', [0xca, 0xe1, 0xeb, 0xe7, 0xec, 0xdd, 0xf1, 0xe1], 'Καλημέρα'],
  ['tr', 'windows-1254', [0x44, 0x65, 0xf0, 0x69, 0xfe, 0x69, 0x6d, 0x20, 0xdd, 0xfd], 'Değişim İı'],
  ['he', 'windows-1255', [0xf9, 0xec, 0xe5, 0xed], 'שלום'],
  ['ja', 'shift_jis', [0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd], 'こんにちは'],
  ['ko', 'euc-kr', [0xc7, 0xd1, 0xb1, 0xdb], '한글'],
  ['zh', 'gb18030', [0xd6, 0xd0, 0xce, 0xc4], '中文'],
  ['zh-CN', 'gb18030', [0xd6, 0xd0, 0xce, 0xc4], '中文'],
  ['zh-Hant', 'big5', [0xa4, 0xa4, 0xa4, 0xe5], '中文'],
  ['zh-TW', 'big5', [0xa4, 0xa4, 0xa4, 0xe5], '中文'],
];

for (const [language, encoding, bytes, text] of CODE_PAGES) {
  test(`a file tagged ${language} that is not UTF-8 is read as ${encoding}`, { skip: page(encoding) }, () => {
    const file = Buffer.concat([ascii(SCRIPT), Buffer.from(bytes), ascii('\n')]);
    assert.equal(decodeSubtitles(file, language).text, `${SCRIPT}${text}\n`);
  });
}

test('valid UTF-8 is UTF-8 whatever the language tag says', () => {
  const text = `${SCRIPT}Привет, мир\n`;
  assert.deepEqual(decodeSubtitles(Buffer.from(text, 'utf8'), 'ru'), { text, encoding: 'UTF-8' });
  assert.deepEqual(decodeSubtitles(Buffer.from(text, 'utf8'), 'ja'), { text, encoding: 'UTF-8' });
});

test('without a language, runs of upper-half letters are read as Cyrillic', { skip: page('windows-1251') }, () => {
  const text = `${SCRIPT}Привет, мир! Это проверка кодировки.\n\n2\n00:00:05,000 --> 00:00:08,000\n— Ёлки-палки, съешь ещё этих булок.\n`;
  assert.deepEqual(decodeSubtitles(cp1251(text)), { text, encoding: 'Windows-1251' });
});

test('without a language, accented letters among plain ones are read as Windows-1252', () => {
  for (const line of ['Ça va très bien, déjà vu à Noël', 'Grüße aus München, schöne Straße', 'El niño está aquí, ¿verdad?']) {
    const text = `${SCRIPT}${line}\n`;
    assert.deepEqual(decodeSubtitles(Buffer.from(text, 'latin1')), { text, encoding: 'Windows-1252' }, line);
  }
});

test('Windows-1252 is more than Latin-1: 0x9C is "œ" and 0x97 a dash', () => {
  const file = Buffer.concat([ascii(`${SCRIPT}Le c`), Buffer.from([0x9c]), ascii('ur a ses raisons '), Buffer.from([0x97]), ascii(' voil'), Buffer.from([0xe0])]);
  assert.equal(decodeSubtitles(file).text, `${SCRIPT}Le cœur a ses raisons — voilà`);
});

test('a language without a code page of its own falls back to the guess', { skip: page('windows-1251') }, () => {
  // Georgian and Hindi never had a page among those a browser decodes, so the bytes decide, as they do without a tag.
  const western = `${SCRIPT}Olá, mundo. Está tudo bem?\n`;
  const cyrillic = `${SCRIPT}Привет, мир! Это проверка кодировки.\n`;
  for (const language of ['ka', 'hi', 'x-unknown']) {
    assert.deepEqual(decodeSubtitles(Buffer.from(western, 'latin1'), language), { text: western, encoding: 'Windows-1252' }, language);
    assert.deepEqual(decodeSubtitles(cp1251(cyrillic), language), { text: cyrillic, encoding: 'Windows-1251' }, language);
  }
});

test('a file tagged with a Western language is not read as Cyrillic', () => {
  // Runs of upper-half letters, which is what the guess takes for Cyrillic: "çã", "çõ", "éé", "äö", "íó".
  const lines: [language: string, line: string][] = [
    ['pt-BR', 'Olá, coração'],
    ['pt', 'Não há informações sobre a situação.'],
    ['fr', 'Créée, agréée, réélue'],
    ['de', 'Ä, Ö, Ü: ÄÖÜ'],
    ['es-419', 'Ñ, ÁÉÍÓÚ'],
    ['fi', 'Yöäänestys, hääyöaie'],
    ['is', 'Þú átt það, æðis'],
    ['en', 'NAÏVE CAFÉ: ÀÉ'],
    ['nb', 'ÆØÅ'],
  ];
  for (const [language, line] of lines) {
    const text = `${SCRIPT}${line}\n`;
    assert.deepEqual(decodeSubtitles(Buffer.from(text, 'latin1'), language), { text, encoding: 'Windows-1252' }, `${language}: ${line}`);
  }
});

test('a script in the tag outweighs the usual script of the language', { skip: page('windows-1250') || page('windows-1251') }, () => {
  // "Čaša, žeđ, šuma" in Windows-1250, which read as Windows-1251 is "Иaљa, ћeр, љuma".
  const latin = [0xc8, 0x61, 0x9a, 0x61, 0x2c, 0x20, 0x9e, 0x65, 0xf0, 0x2c, 0x20, 0x9a, 0x75, 0x6d, 0x61];
  const file = Buffer.concat([ascii(SCRIPT), Buffer.from(latin)]);
  assert.deepEqual(decodeSubtitles(file, 'sr-Latn'), { text: `${SCRIPT}Čaša, žeđ, šuma`, encoding: 'Windows-1250' });
  assert.deepEqual(decodeSubtitles(file, 'sr-Latn-RS'), { text: `${SCRIPT}Čaša, žeđ, šuma`, encoding: 'Windows-1250' });
  assert.equal(decodeSubtitles(file, 'sr').encoding, 'Windows-1251');
  // And the other way round: Azerbaijani is Latin by default, in the Turkish page.
  const cyrillic = `${SCRIPT}Салам, дунйа\n`;
  assert.deepEqual(decodeSubtitles(cp1251(cyrillic), 'az-Cyrl'), { text: cyrillic, encoding: 'Windows-1251' });
  assert.equal(decodeSubtitles(cp1251(cyrillic), 'az').encoding, 'Windows-1254');
});

test('bytes that are no text at all still decode to something', () => {
  const rnd = random(31);
  for (const size of [1, 2, 3, 7, 64, 4096]) {
    const { text } = decodeSubtitles(rnd.bytes(size), size === 7 ? 'ja' : undefined);
    assert.equal(typeof text, 'string');
    assert.deepEqual(cuesOf(toWebVtt(text, 'srt').vtt), []);
  }
});

// ---- Conversion to WebVTT -----------------------------------------------------------------------------------

interface Cue {
  start: number;
  end: number;
  top: boolean;
  text: string;
}

/**
 * Reads the WebVTT that toWebVtt() writes, by the rules a browser reads it with, and fails on what a browser
 * would trip over: a block that doesn't start with a timing line, a cue without text, and "-->" in the text,
 * which ends the cue there and makes the browser look for a new one.
 */
function cuesOf(vtt: string): Cue[] {
  assert.ok(!/[\r\0]/.test(vtt), 'no carriage returns or zero bytes');
  const lines = vtt.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['WEBVTT', '']);
  const ms = (h: string, m: string, s: string, fraction: string) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(fraction);
  const cues: Cue[] = [];
  for (let i = 2; i < lines.length; ) {
    if (lines[i] === '') {
      i++;
      continue;
    }
    const timing = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})( line:0)?$/.exec(lines[i]);
    assert.ok(timing, `a cue has to start with a timing line: ${JSON.stringify(lines[i].slice(0, 80))}`);
    const text: string[] = [];
    for (i++; i < lines.length && lines[i] !== ''; i++) {
      assert.ok(!lines[i].includes('-->'), `"-->" in the text of a cue: ${JSON.stringify(lines[i].slice(0, 80))}`);
      text.push(lines[i]);
    }
    assert.ok(text.length > 0, 'a cue has text');
    cues.push({
      start: ms(timing[1], timing[2], timing[3], timing[4]),
      end: ms(timing[5], timing[6], timing[7], timing[8]),
      top: !!timing[9],
      text: text.join('\n'),
    });
  }
  return cues;
}

/** The cues of a conversion, after checking that the count it reports is the count it wrote. */
function convert(source: string, extension = 'srt'): Cue[] {
  const result = toWebVtt(source, extension);
  const cues = cuesOf(result.vtt);
  assert.equal(result.cues, cues.length);
  return cues;
}

/** `<` may only open one of the three styles WebVTT shares with SubRip. Everything else has to be spelled out. */
function assertOnlyStyleTags(cues: Cue[]): void {
  for (const cue of cues) {
    assert.ok(!cue.text.replace(/<\/?[ibu]>/g, '').includes('<'), `markup in ${JSON.stringify(cue.text)}`);
  }
}

const cue = (start: number, end: number, text: string, top = false): Cue => ({ start, end, top, text });

test('SubRip: counters go, commas become dots, the text stays', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nFirst line\nsecond line of the first cue\n\n2\n01:02:03,450 --> 01:02:05,000\nSecond & last\n';
  assert.deepEqual(convert(srt), [cue(1000, 4000, 'First line\nsecond line of the first cue'), cue(3723450, 3725000, 'Second & last')]);
  assert.equal(toWebVtt(srt, 'srt').vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nFirst line\nsecond line of the first cue\n\n01:02:03.450 --> 01:02:05.000\nSecond & last\n');
});

test('SubRip without counters', () => {
  const srt = '00:00:01,000 --> 00:00:02,000\none\n\n00:00:03,000 --> 00:00:04,000\ntwo\n';
  assert.deepEqual(convert(srt), [cue(1000, 2000, 'one'), cue(3000, 4000, 'two')]);
});

test('SubRip with an empty line inside a cue', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nLine before a gap\n\nline after it\n\n2\n00:00:03,000 --> 00:00:04,000\ntwo\n';
  assert.deepEqual(convert(srt), [cue(1000, 2000, 'Line before a gap\nline after it'), cue(3000, 4000, 'two')]);
});

test('SubRip without the empty line between two cues', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\none\n2\n00:00:03,000 --> 00:00:04,000\ntwo\n3\n00:00:05,000 --> 00:00:06,000\nthree';
  assert.deepEqual(convert(srt), [cue(1000, 2000, 'one'), cue(3000, 4000, 'two'), cue(5000, 6000, 'three')]);
});

test('SubRip without a final newline, and with text in front of the first cue', () => {
  assert.deepEqual(convert('1\n00:00:25,000 --> 00:00:29,500\nLast cue without a newline at the end'), [cue(25000, 29500, 'Last cue without a newline at the end')]);
  assert.deepEqual(convert('Ripped by somebody\n\n1\n00:00:01,000 --> 00:00:02,000\none\n'), [cue(1000, 2000, 'one')]);
});

test('SubRip: a number is only a counter in front of the next timing line', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n1999\n\n2\n00:00:03,000 --> 00:00:04,000\nThe answer is\n42';
  assert.deepEqual(convert(srt), [cue(1000, 2000, '1999'), cue(3000, 4000, 'The answer is\n42')]);
  assert.deepEqual(convert(`${srt}\n`), [cue(1000, 2000, '1999'), cue(3000, 4000, 'The answer is\n42')]);
});

test('SubRip: a cue without text or with an end before its start is left out', () => {
  const srt = [
    '1\n00:00:01,000 --> 00:00:02,000\nkept',
    '2\n00:00:20,000 --> 00:00:19,000\nends before it starts',
    '3\n00:00:21,000 --> 00:00:21,000\nno length',
    '4\n00:00:22,000 --> 00:00:23,000\n',
    '5\n00:00:24,000 --> 00:00:25,000\n{\\an8}',
    '6\n00:00:26,000 --> 00:00:27,000\nkept too',
  ].join('\n\n');
  assert.deepEqual(convert(srt), [cue(1000, 2000, 'kept'), cue(26000, 27000, 'kept too')]);
});

test('SubRip: {\\an7} to {\\an9} put the cue at the top with line:0', () => {
  const at = (tag: string) => convert(`1\n00:00:01,000 --> 00:00:02,000\n${tag}Text\nsecond line\n`)[0];
  for (const tag of ['{\\an7}', '{\\an8}', '{\\an9}', '{\\fs20\\an8}']) {
    assert.deepEqual(at(tag), cue(1000, 2000, 'Text\nsecond line', true), tag);
  }
  for (const tag of ['', '{\\an1}', '{\\an2}', '{\\an5}', '{\\pos(10,10)}']) {
    assert.deepEqual(at(tag), cue(1000, 2000, 'Text\nsecond line', false), tag);
  }
  assert.ok(toWebVtt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Top\n').vtt.includes('00:00:01.000 --> 00:00:02.000 line:0\nTop\n'));
  // The tag may stand on any line of the cue.
  assert.deepEqual(convert('1\n00:00:01,000 --> 00:00:02,000\nText\n{\\an8}second line\n'), [cue(1000, 2000, 'Text\nsecond line', true)]);
});

test('SubRip: italic, bold and underline are kept, font tags are dropped', () => {
  const text = (line: string) => convert(`1\n00:00:01,000 --> 00:00:02,000\n${line}\n`)[0].text;
  assert.equal(text('<i>Italic</i>, <b>bold</b> and <u>underlined</u>'), '<i>Italic</i>, <b>bold</b> and <u>underlined</u>');
  assert.equal(text('<I>Upper</I> <B >spaced</B >'), '<i>Upper</i> <b>spaced</b>');
  assert.equal(text('{i}Braces{/i} and {b}bold{/b}'), '<i>Braces</i> and <b>bold</b>');
  assert.equal(text('<font color="#ff0000" size=3>Red</font> text'), 'Red text');
  assert.equal(text('{\\i1}Override{\\i0} tags {\\pos(1,2)}go'), 'Override tags go');
});

test('line endings, a byte order mark and zero bytes in the source do not reach the cues', () => {
  const expected = [cue(1000, 4000, 'English — “quotes” and café'), cue(5000, 8000, 'Second cue\nsecond line')];
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nEnglish — “quotes” and café\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond cue\nsecond line\n';
  assert.deepEqual(convert(srt), expected);
  assert.deepEqual(convert(`﻿${srt.replace(/\n/g, '\r\n')}`), expected);
  assert.deepEqual(convert(srt.replace(/\n/g, '\r')), expected);
  assert.deepEqual(convert(srt.replace(/cue/, 'c\0ue')), expected);
});

test('a file without cues gives the header alone', () => {
  for (const source of ['', '\n\n\n', 'just some text\nwithout a timing line\n']) {
    assert.deepEqual(toWebVtt(source, 'srt'), { vtt: 'WEBVTT\n\n', cues: 0 });
  }
});

const ASS = [
  '﻿[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 640',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,0,0,2,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Привет, {\\i1}мир{\\i0}\\Nвторая строка',
  'Dialogue: 0,0:00:06.00,0:00:09.00,Default,,0,0,0,,{\\an8}Сверху',
  'Dialogue: 0,1:00:22.00,1:00:25.25,Default,,0,0,0,,Hard\\hspace',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\b1}Early{\\b0} line, with a comma, or two',
  'Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
  'Dialogue: 0,0:00:13.00,0:00:12.00,Default,,0,0,0,,ends before it starts',
  'Dialogue: 0,0:00:14.00,0:00:15.00,Default,,0,0,0,,{\\fad(100,100)}',
  'Comment: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,a comment',
  '',
].join('\r\n');

test('ASS: the text of the dialogue lines, in the order they start', () => {
  const expected = [
    cue(1000, 3500, '<b>Early</b> line, with a comma, or two'),
    cue(2000, 4000, 'Привет, <i>мир</i>\nвторая строка'),
    cue(6000, 9000, 'Сверху', true),
    cue(3622000, 3625250, 'Hard space'),
  ];
  assert.deepEqual(convert(ASS, 'ass'), expected);
  // The content says what it is: the extension may be missing or wrong.
  assert.deepEqual(convert(ASS, ''), expected);
  assert.deepEqual(convert(ASS, 'srt'), expected);
});

test('ASS: the Format line says where the fields are', () => {
  const ssa = '[Script Info]\n\n[Events]\nFormat: Marked, End, Start, Text\nDialogue: Marked=0,0:00:02.00,0:00:01.00,Hello, world\n';
  assert.deepEqual(convert(ssa, 'ssa'), [cue(1000, 2000, 'Hello, world')]);
});

test('ASS: a script without its header is read by the extension, and only inside [Events]', () => {
  const body = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,inside\n';
  assert.deepEqual(convert(`[Events]\n${body}`, 'ass'), [cue(1000, 2000, 'inside')]);
  assert.deepEqual(convert(`[Events]\n${body}`, 'ssa'), [cue(1000, 2000, 'inside')]);
  assert.deepEqual(convert(`[Fonts]\n${body.replace('inside', 'outside')}[Events]\n${body}`, 'ass'), [cue(1000, 2000, 'inside')]);
});

test('WebVTT passes through untouched', () => {
  const vtt = [
    'WEBVTT - with a header text',
    '',
    'NOTE a comment',
    'that spans lines',
    '',
    'STYLE',
    '::cue { color: lime; }',
    '',
    'intro',
    '00:01.000 --> 00:04.000 line:10% align:start',
    '<v Roger>Voice of Roger</v>',
    '<c.loud>classed</c> and <i>italic</i>',
    '',
    '00:00:05.000 --> 00:00:08.000',
    'Olá, <b>mundo</b>! 1 &lt; 2 &amp; 3 &gt; 2',
    '',
  ].join('\n');
  for (const extension of ['vtt', 'srt', 'ass', '']) {
    assert.deepEqual(toWebVtt(vtt, extension), { vtt }, extension);
  }
  assert.deepEqual(toWebVtt('WEBVTT\n', 'vtt'), { vtt: 'WEBVTT\n' });
  assert.deepEqual(toWebVtt('WEBVTT', 'vtt'), { vtt: 'WEBVTT' });
});

test('WebVTT behind a byte order mark and with CRLF is still WebVTT', () => {
  // Only what a browser's own reader drops as well is taken off: the mark and the carriage returns.
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:04.000 align:start\n<v Roger>Voice</v>\n';
  assert.deepEqual(toWebVtt(`\ufeff${vtt.replace(/\n/g, '\r\n')}`, 'vtt'), { vtt });
});

test('the content decides, not the extension: SubRip text in a .vtt file is converted', () => {
  assert.deepEqual(convert('1\n00:00:01,000 --> 00:00:02,000\none\n', 'vtt'), [cue(1000, 2000, 'one')]);
  // A word that merely starts with the header is not the header.
  assert.deepEqual(convert('WEBVTTS\n\n00:00:01,000 --> 00:00:02,000\none\n', 'vtt'), [cue(1000, 2000, 'one')]);
});

// ---- Hostile files ------------------------------------------------------------------------------------------

const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<v Evil>a voice</v> <c.red.bg_blue>a class</c> <lang en>a language</lang>',
  '<ruby>base<rt>text</rt></ruby> <00:00:05.000>a timestamp',
  'a < b > c <',
  '<<i>>',
  'an --> arrow',
  '-->',
  '--->',
  '00:00:09.000 --> 00:00:10.000 line:0 text with it',
  'NOTE not a comment',
  'STYLE',
  'WEBVTT',
  '{unclosed',
  'closed} only',
  '<font',
  '</font',
];

test('SubRip: markup and arrows in the text come out as text', () => {
  const srt = HOSTILE.map((line, i) => `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i + 1).padStart(2, '0')},000\nbefore ${line} after\n`).join('\n');
  const cues = convert(srt);
  assert.equal(cues.length, HOSTILE.length);
  assertOnlyStyleTags(cues);
  assert.equal(cues[0].text, 'before &lt;script>alert(1)&lt;/script> after');
  assert.equal(cues[6].text, 'before an --&gt; arrow after');
  // Timings in the middle of a line are text.
  assert.equal(cues[9].text, 'before 00:00:09.000 --&gt; 00:00:10.000 line:0 text with it after');
});

test('ASS: markup and arrows in the text come out as text', () => {
  const ass = `[Script Info]\n\n[Events]\n${HOSTILE.map((line, i) => `Dialogue: 0,0:00:${String(i).padStart(2, '0')}.00,0:00:${String(i + 1).padStart(2, '0')}.00,Default,,0,0,0,,before ${line} after`).join('\n')}\n`;
  const cues = convert(ass, 'ass');
  assert.equal(cues.length, HOSTILE.length);
  assertOnlyStyleTags(cues);
  assert.equal(cues[0].text, 'before &lt;script>alert(1)&lt;/script> after');
  assert.equal(cues[9].text, 'before 00:00:09.000 --&gt; 00:00:10.000 line:0 text with it after');
});

test('ASS: a line break in the text cannot start a block of its own', () => {
  const ass = '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,one\\N\\N\\N00:00:05.000 --> 00:00:09.000\\Ninjected\\N \\N<v X>two\n';
  assert.deepEqual(convert(ass, 'ass'), [cue(1000, 2000, 'one\n00:00:05.000 --&gt; 00:00:09.000\ninjected\n&lt;v X>two')]);
});

// What is dropped from a line can leave an arrow behind that no pass before the dropping saw. cuesOf() fails on one.
const ASSEMBLED = ['--<font color="red">>', '-<font>-></font>', '-<font>-<font>>', '--</font>>', '--{\\fs20}>', '-{\\an8}-{\\b0}>', '--{\\an8}<font>>', '--<font>{\\an8}>', '--<{\\i1}font>>', '--{\\i1}{\\i0}>'];

test('SubRip: an arrow put together by a dropped font tag or override block is still spelled out', () => {
  const cues = convert('1\n00:00:01,000 --> 00:00:02,000\nbefore --<font color="red">> after\nsecond line\n');
  assert.deepEqual(cues, [cue(1000, 2000, 'before --&gt; after\nsecond line')]);
  // A whole timing line written that way is text of the cue it stands in.
  assert.deepEqual(convert('1\n00:00:01,000 --> 00:00:02,000\none\n00:00:05.000 --<font>> 00:00:09.000\ninjected\n'), [cue(1000, 2000, 'one\n00:00:05.000 --&gt; 00:00:09.000\ninjected')]);
  for (const arrow of ASSEMBLED) {
    const [only] = convert(`1\n00:00:01,000 --> 00:00:02,000\nbefore ${arrow} after\nsecond line\n`);
    assert.equal(only.text.split('\n').length, 2, arrow);
    assertOnlyStyleTags([only]);
  }
});

test('ASS: an arrow put together by a dropped override block is still spelled out', () => {
  const cues = convert('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,one\\N00:00:05.000 --{\\fs20}> 00:00:09.000\\Ninjected\n', 'ass');
  assert.deepEqual(cues, [cue(1000, 2000, 'one\n00:00:05.000 --&gt; 00:00:09.000\ninjected')]);
  for (const arrow of [...ASSEMBLED, '-\\h->', '--\\N>', '-{\\fs1}\\{\\fs1}h->']) {
    const [only] = convert(`[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,before ${arrow} after\\Nsecond line\n`, 'ass');
    assert.ok(only.text.endsWith('after\nsecond line'), arrow);
    assertOnlyStyleTags([only]);
  }
});

test('a line of unclosed braces or tags is read in one pass', () => {
  // 40,000 openers: a pass per opener over the rest of the line would take many seconds, one pass takes
  // about a millisecond. The limit is far from both.
  const head = '1\n00:00:01,000 --> 00:00:02,000\n';
  const lines: [string, string][] = [
    ['srt', head + '{\\an8'.repeat(40000)],
    ['srt', head + '<font'.repeat(40000)],
    ['srt', head + '{\\i1}x'.repeat(40000)],
    ['ass', `[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${'{\\i1'.repeat(40000)}`],
  ];
  for (const [extension, source] of lines) {
    const started = performance.now();
    const cues = convert(source, extension);
    assert.ok(performance.now() - started < 1500, `${source.slice(-12)} took ${Math.round(performance.now() - started)} ms`);
    assert.equal(cues.length, 1);
    assertOnlyStyleTags(cues);
  }
});
