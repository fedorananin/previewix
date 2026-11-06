import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvField, csvLine, decodeText, decodeWithEncoding, detectDelimiter, flatRows, parseCsv, parseCsvFlat, parseCsvSpans, toCsv } from '../src/csv';
import { random } from './helpers';

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * A reader of delimited text written for these tests alone, one character at a time, to have something
 * to hold the three parsers of csv.ts against. `unclosed` says that the text ends inside a quoted field.
 */
function reference(text: string, delimiter: string): { rows: string[][]; unclosed: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  // 'start': nothing of the field was read yet, which is the only place where a quote opens a quoted field.
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        state = 'closed';
      }
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      state = 'start';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      state = 'start';
    } else if (ch === '"' && state === 'start') {
      state = 'quoted';
    } else {
      field += ch;
      state = state === 'start' ? 'plain' : state;
    }
  }
  // A last line without a line break is a row when anything is on it, an empty pair of quotes included.
  if (state !== 'start' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, unclosed: state === 'quoted' };
}

// ---- Decoding ---------------------------------------------------------------------------------

test('UTF-8 is read as it is, and its byte order mark is dropped', () => {
  const text = 'name,price\nZoë,5 €\n日本語,😀\n';
  assert.deepEqual(decodeWithEncoding(Buffer.from(text, 'utf8')), { text, encoding: 'UTF-8' });
  assert.deepEqual(decodeWithEncoding(Buffer.from(`﻿${text}`, 'utf8')), { text, encoding: 'UTF-8 with BOM' });
});

test('UTF-16 is recognised by its byte order mark, in both byte orders', () => {
  const text = 'name;price\r\nZoë;5 €\r\n日本語;😀';
  const little = Buffer.from(`﻿${text}`, 'utf16le');
  assert.deepEqual(decodeWithEncoding(little), { text, encoding: 'UTF-16 LE' });
  assert.deepEqual(decodeWithEncoding(Buffer.from(little).swap16()), { text, encoding: 'UTF-16 BE' });
});

test('bytes that are not UTF-8 are read as Windows-1252', () => {
  // café, the euro sign and curly quotes, which ISO 8859-1 doesn't have at these places.
  const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80, 0x2c, 0x93, 0x78, 0x94]);
  assert.deepEqual(decodeWithEncoding(bytes), { text: 'café,€,“x”', encoding: 'Windows-1252' });
});

test('an empty file is empty text, and decodeText gives the same text as decodeWithEncoding', () => {
  assert.deepEqual(decodeWithEncoding(new Uint8Array(0)), { text: '', encoding: 'UTF-8' });
  assert.equal(decodeText(Buffer.from('﻿a,b', 'utf16le')), 'a,b');
  assert.equal(decodeText(Uint8Array.from([0xe9])), 'é');
  assert.equal(decodeText(Buffer.from('﻿ü', 'utf8')), 'ü');
});

// ---- Delimiter --------------------------------------------------------------------------------

test('the delimiter is the one that splits the first lines alike', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3\n'), '|');
});

test('a delimiter that splits the lines unevenly loses to one that splits them alike', () => {
  // Decimal commas in a file of semicolons.
  assert.equal(detectDelimiter('name;price;count\nx;1,5;2\ny;2,25;3\n'), ';');
  // Commas in a text of a tab-separated file, more of them than there are tabs.
  assert.equal(detectDelimiter('id\ttext\n1\ta, b, c, d\n2\tplain\n'), '\t');
});

test('among the delimiters that split alike, the one giving more fields wins', () => {
  assert.equal(detectDelimiter('a,b;c;d\n1,2;3;4\n'), ';');
  assert.equal(detectDelimiter('a,b,c;d\n1,2,3;4\n'), ',');
});

test('a delimiter inside quotes does not count', () => {
  assert.equal(detectDelimiter('"a,b,c,d";x\n"1,2,3,4";y\n'), ';');
});

test('text of one column, and no text at all, is taken as comma-separated', () => {
  assert.equal(detectDelimiter('one\ntwo\nthree\n'), ',');
  assert.equal(detectDelimiter(''), ',');
});

test('only the first lines decide the delimiter', () => {
  // Fifty lines that the semicolon splits in three and the comma in two, then lines without a semicolon:
  // looked at as well, those would leave the comma as the only delimiter that splits every line alike.
  const first = Array.from({ length: 50 }, (_, i) => `a${i},b;c;d`);
  const later = Array.from({ length: 50 }, (_, i) => `x${i},y`);
  assert.equal(detectDelimiter([...first, ...later].join('\n')), ';');
});

test('the line that the 64 KB sample cuts in two is not held against a delimiter', () => {
  // Every line splits in three at the semicolons and in two at the comma. The sample ends inside the
  // seventh line, before its second semicolon: counted, that line would hand the win to the comma.
  const line = `a,b;${'x'.repeat(6000)};${'y'.repeat(4000)}\n`;
  const sample = 64 * 1024;
  assert.ok(sample % line.length > 4 && sample % line.length < 6004);
  assert.equal(detectDelimiter(line.repeat(10)), ';');
});

// ---- Parsing ----------------------------------------------------------------------------------

test('plain fields, with each of the delimiters', () => {
  for (const delimiter of DELIMITERS) {
    const text = ['a', 'b', 'c'].join(delimiter) + '\n' + ['1', '', '3'].join(delimiter) + '\n';
    assert.deepEqual(parseCsv(text, delimiter), [
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  }
  // The comma is the delimiter when none is named, and another delimiter is then text.
  assert.deepEqual(parseCsv('a;b,c'), [['a;b', 'c']]);
});

test('a quoted field holds delimiters, line breaks and doubled quotes', () => {
  assert.deepEqual(parseCsv('"a,b","say ""hi""","line 1\r\nline 2\nline 3"\n"",x\n'), [
    ['a,b', 'say "hi"', 'line 1\r\nline 2\nline 3'],
    ['', 'x'],
  ]);
});

test('text behind a closing quote is kept as written', () => {
  assert.deepEqual(parseCsv('"ab"cd,"e" ,"f"g"h"\n'), [['abcd', 'e ', 'fg"h"']]);
});

test('a quote opens a quoted field only at the start of a field', () => {
  assert.deepEqual(parseCsv('a"b,5" pipe, "c"\n'), [['a"b', '5" pipe', ' "c"']]);
});

test('a quote that is never closed takes the rest of the text', () => {
  assert.deepEqual(parseCsv('a,"b,c\nd,e\n'), [['a', 'b,c\nd,e\n']]);
  assert.deepEqual(parseCsv('a\n"'), [['a'], ['']]);
});

test('lines end with CRLF, LF or CR, also mixed in one file', () => {
  const rows = [
    ['a', 'b'],
    ['c', 'd'],
    ['e', 'f'],
  ];
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\ne,f\r\n'), rows);
  assert.deepEqual(parseCsv('a,b\nc,d\ne,f\n'), rows);
  assert.deepEqual(parseCsv('a,b\rc,d\re,f\r'), rows);
  assert.deepEqual(parseCsv('a,b\rc,d\r\ne,f\n'), rows);
});

test('a final line break does not make a row, and its absence loses none', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.deepEqual(parseCsv('a,b\nc,d\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.deepEqual(parseCsv('a,b\nc,d\r\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('an empty line is a row of one empty field', () => {
  assert.deepEqual(parseCsv('a\n\nb\n'), [['a'], [''], ['b']]);
  assert.deepEqual(parseCsv('a\n\n'), [['a'], ['']]);
  assert.deepEqual(parseCsv('\n'), [['']]);
});

test('a last line without a line break is a row when it holds a delimiter or an empty pair of quotes', () => {
  assert.deepEqual(parseCsv('a,b\n,'), [
    ['a', 'b'],
    ['', ''],
  ]);
  assert.deepEqual(parseCsv('a\n""'), [['a'], ['']]);
  assert.deepEqual(parseCsv('a,'), [['a', '']]);
});

test('an empty file has no rows', () => {
  assert.deepEqual(parseCsv(''), []);
  const flat = parseCsvFlat('');
  assert.deepEqual([flat.text, flat.ends.length, flat.rowEnds.length], ['', 0, 0]);
  const spans = parseCsvSpans('');
  assert.deepEqual([spans.text, spans.ends.length, spans.rowEnds.length, spans.rawEnds.length, spans.lineEnds.length, spans.unclosed], ['', 0, 0, 0, 0, false]);
});

test('rows keep their own number of fields', () => {
  assert.deepEqual(parseCsv('a,b,c\nd\ne,f,g,h\n,\n'), [['a', 'b', 'c'], ['d'], ['e', 'f', 'g', 'h'], ['', '']]);
});

test('reading stops after the rows asked for', () => {
  const text = 'a,b\n"c\nc",d\ne,f\ng,h';
  assert.deepEqual(parseCsv(text, ',', 2), [
    ['a', 'b'],
    ['c\nc', 'd'],
  ]);
  assert.deepEqual(parseCsv(text, ',', 0), []);
  assert.equal(parseCsv(text, ',', 4).length, 4);
  assert.equal(parseCsv(text, ',', 9).length, 4);
});

// ---- The flat table and the places of the fields ----------------------------------------------

test('a flat table is the text of all cells, the end of every cell and the cells up to the end of every row', () => {
  const flat = parseCsvFlat('ab,c\n,\n"d,e",,f\n');
  assert.equal(flat.text, 'abcd,ef');
  assert.deepEqual(Array.from(flat.ends), [2, 3, 3, 3, 6, 6, 7]);
  assert.deepEqual(Array.from(flat.rowEnds), [2, 4, 7]);
  assert.deepEqual(flatRows(flat), [
    ['ab', 'c'],
    ['', ''],
    ['d,e', '', 'f'],
  ]);
});

test('the place of every field: where its raw text ends, and where the line of every row ends', () => {
  //            0         1         2
  //            012345678901234 5 6 7 8 901 23
  const text = 'ab,"c,""d"" e"x\r\n,\n"f\ng"';
  const spans = parseCsvSpans(text);
  assert.deepEqual(flatRows(spans), [['ab', 'c,"d" ex'], ['', ''], ['f\ng']]);
  assert.deepEqual(Array.from(spans.rawEnds), [2, 15, 17, 18, 24]);
  assert.deepEqual(Array.from(spans.lineEnds), [17, 19, 24]);
  assert.equal(spans.unclosed, false);
});

test('a quoted field that is never closed is reported', () => {
  const spans = parseCsvSpans('a,"bc\nd');
  assert.deepEqual(flatRows(spans), [['a', 'bc\nd']]);
  assert.deepEqual(Array.from(spans.rawEnds), [1, 7]);
  assert.deepEqual(Array.from(spans.lineEnds), [7]);
  assert.equal(spans.unclosed, true);
  assert.equal(parseCsvSpans('a,"bc"\n"d"').unclosed, false);
});

test('a table larger than the first sizes of the indexes comes out whole', () => {
  // 12,000 cells in 300 rows: past the 8,192 pieces joined at a time, the 1,024 cell ends and the 256 row ends.
  const rows = Array.from({ length: 300 }, (_, r) => Array.from({ length: 40 }, (_, c) => (c % 7 === 3 ? '' : `r${r}c${c}`)));
  const text = rows.map((row) => row.join(';')).join('\n');
  assert.deepEqual(flatRows(parseCsvFlat(text, ';')), rows);
  const spans = parseCsvSpans(text, ';');
  assert.deepEqual(flatRows(spans), rows);
  assert.equal(spans.rawEnds.length, 12000);
  assert.equal(spans.lineEnds.length, 300);
  // Nothing is quoted here, so a field is its raw text.
  let cell = 0;
  let start = 0;
  rows.forEach((row, r) => {
    for (const field of row) {
      assert.equal(text.slice(start, spans.rawEnds[cell]), field);
      start = spans.rawEnds[cell++] + 1;
    }
    assert.equal(spans.lineEnds[r], Math.min(start, text.length));
  });
});

test('the three parsers agree with each other and with a reader of the test, on generated text', () => {
  const rand = random(20240229);
  for (let n = 0; n < 800; n++) {
    const delimiter = DELIMITERS[n % 4];
    const pieces = ['a', 'b', 'cd', ' ', '"', '"', '""', '\n', '\n', '\r', '\r\n', 'é', '😀', delimiter, delimiter, delimiter, `"x${delimiter}y"`, '"line\nbreak"', '"q""q"', '""'];
    const text = Array.from({ length: rand.int(24) }, () => rand.pick(pieces)).join('');
    const where = `in ${JSON.stringify(text)} split at ${JSON.stringify(delimiter)}`;
    const expected = reference(text, delimiter);

    assert.deepEqual(parseCsv(text, delimiter), expected.rows, where);
    assert.deepEqual(flatRows(parseCsvFlat(text, delimiter)), expected.rows, where);
    const spans = parseCsvSpans(text, delimiter);
    assert.deepEqual(flatRows(spans), expected.rows, where);
    assert.equal(spans.unclosed, expected.unclosed, where);
    const limit = rand.int(4);
    assert.deepEqual(parseCsv(text, delimiter, limit), expected.rows.slice(0, limit), where);

    // The raw text of every field, read on its own, is that field; a delimiter stands between the
    // fields of a row, and a line break or the end of the text behind the last of them.
    assert.equal(spans.rawEnds.length, spans.ends.length, where);
    assert.equal(spans.lineEnds.length, expected.rows.length, where);
    let cell = 0;
    let start = 0;
    expected.rows.forEach((row, r) => {
      row.forEach((field, c) => {
        const end = spans.rawEnds[cell++];
        const raw = text.slice(start, end);
        const alone = reference(raw, delimiter);
        assert.deepEqual(alone.rows, raw === '' ? [] : [[field]], `${where}: field ${c} of row ${r} is ${JSON.stringify(raw)}`);
        assert.ok(raw !== '' || field === '', where);
        if (c < row.length - 1) {
          assert.equal(text[end], delimiter, where);
          start = end + 1;
        } else {
          const lineEnd = spans.lineEnds[r];
          assert.ok(['', '\n', '\r', '\r\n'].includes(text.slice(end, lineEnd)), `${where}: row ${r} ends with ${JSON.stringify(text.slice(end, lineEnd))}`);
          // Only the last row may do without a line break.
          assert.ok(lineEnd > end || r === expected.rows.length - 1, where);
          start = lineEnd;
        }
      });
    });
    assert.equal(start, text.length, where);
  }
});

// ---- Writing ----------------------------------------------------------------------------------

test('a field is quoted only when it has to be', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(''), '');
  assert.equal(csvField('two words'), 'two words');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line 1\nline 2'), '"line 1\nline 2"');
  assert.equal(csvField('a\rb'), '"a\rb"');
  // Spaces at either end would be taken for padding by many readers.
  assert.equal(csvField(' lead'), '" lead"');
  assert.equal(csvField('trail\t'), '"trail\t"');
});

test('what has to be quoted depends on the delimiter', () => {
  assert.equal(csvField('a;b'), 'a;b');
  assert.equal(csvField('a;b', ';'), '"a;b"');
  assert.equal(csvField('a,b', ';'), 'a,b');
  assert.equal(csvField('a\tb', '\t'), '"a\tb"');
  assert.equal(csvField('a|b', '|'), '"a|b"');
});

test('lines are joined with the delimiter, and a file with CRLF and a final line break', () => {
  assert.equal(csvLine(['a', 'b c', 'd,e', '']), 'a,b c,"d,e",');
  assert.equal(csvLine(['a', 'b;c'], ';'), 'a;"b;c"');
  assert.equal(
    toCsv([
      ['a', 'b'],
      ['1', 'x"y'],
    ]),
    'a,b\r\n1,"x""y"\r\n',
  );
  assert.equal(toCsv([['a', 'b']], '\t'), 'a\tb\r\n');
});

test('what is written reads back as the same rows', () => {
  const rand = random(7);
  for (let n = 0; n < 300; n++) {
    const delimiter = DELIMITERS[n % 4];
    const pieces = ['a', 'B', 'é', '😀', ' ', '\t', '"', '""', '\n', '\r', '\r\n', ',', ';', '|', '0', '-1.5'];
    const rows = Array.from({ length: 1 + rand.int(6) }, () => Array.from({ length: 1 + rand.int(5) }, () => Array.from({ length: rand.int(5) }, () => rand.pick(pieces)).join('')));
    const text = toCsv(rows, delimiter);
    assert.deepEqual(parseCsv(text, delimiter), rows, JSON.stringify(text));
    assert.deepEqual(reference(text, delimiter).rows, rows, JSON.stringify(text));
  }
});
