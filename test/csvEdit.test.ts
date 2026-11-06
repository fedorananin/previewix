import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWithEncoding, flatRows, parseCsv } from '../src/csv';
import { Unencodable, editedTable, fingerprint, packBackup, readOps, render, rowsAfter, runRender, unpackBackup, type Op, type WireTable } from '../src/csvEdit';
import { random, type Random } from './helpers';

// Writing edits back into a delimited text file (src/csvEdit.ts). The promise: a save changes the fields
// that were edited and nothing else. Every other field, every line break and the byte order mark keep the
// bytes they had, in the file's own encoding. The named cases spell the expected file out; the randomised
// pass at the end checks the same promise with a tokenizer and a model of the table that are the test's own.

// ---- Building edits ---------------------------------------------------------------

function wire(rows: string[][]): WireTable {
  const ends: number[] = [];
  const rowEnds: number[] = [];
  let text = '';
  for (const row of rows) {
    for (const cell of row) {
      text += cell;
      ends.push(text.length);
    }
    rowEnds.push(ends.length);
  }
  return { text: new Uint8Array(Buffer.from(text, 'utf8')), ends: Uint32Array.from(ends), rowEnds: Uint32Array.from(rowEnds) };
}

/** Whole rows get new cells. */
const setRows = (rows: Record<number, string[]>): Op => ({ type: 'set', rows: Uint32Array.from(Object.keys(rows).map(Number)), table: wire(Object.values(rows)) });
/** One cell gets a new text. */
const setCell = (row: number, column: number, text: string): Op => ({ type: 'set', rows: Uint32Array.of(row), at: column, table: wire([[text]]) });
const insertRows = (rows: Record<number, string[]>): Op => ({ type: 'insert', rows: Uint32Array.from(Object.keys(rows).map(Number)), table: wire(Object.values(rows)) });
const deleteRows = (...rows: number[]): Op => ({ type: 'delete', rows: Uint32Array.from(rows) });
/** A column goes in: every row named gets one empty cell at `at` in the place of none. */
const insertColumn = (at: number, rows: number[]): Op => ({ type: 'set', rows: Uint32Array.from(rows), at, widths: new Uint32Array(rows.length).fill(0), table: wire(rows.map(() => [''])) });
/** A column goes out: no cell in the place of one. */
const deleteColumn = (at: number, rows: number[]): Op => ({ type: 'set', rows: Uint32Array.from(rows), at, widths: new Uint32Array(rows.length).fill(1), table: wire(rows.map(() => [])) });

/** The file after the edits, read as Latin-1 so that every byte shows. Always with the check that reads the result back. */
function saved(file: string | Buffer, ops: Op[], delimiter = ',', eol = '\n'): string {
  const bytes = typeof file === 'string' ? Buffer.from(file, 'latin1') : file;
  return Buffer.from(render(bytes, ops, { delimiter, eol, verify: true }).bytes).toString('latin1');
}

// ---- Fields ---------------------------------------------------------------------------

// Quoted without need, a quote inside, a line break inside, CRLF, and no line break at the end.
const BASIC = 'id,name,"note"\r\n1,"Ann","said ""hi"""\r\n2,Bob,"two\r\nlines"\r\n3,Cy,plain\r\n4,"Dee, Jr.",';

test('an edit that changes nothing gives back the file, byte for byte', () => {
  assert.equal(saved(BASIC, []), BASIC);
  // Cells that are given the text they have are not edits, however the file wrote them.
  assert.equal(saved(BASIC, [setCell(1, 1, 'Ann'), setCell(2, 2, 'two\r\nlines'), setRows({ 4: ['4', 'Dee, Jr.', ''] })]), BASIC);
});

test('a changed cell is the only thing that changes', () => {
  assert.equal(saved(BASIC, [setCell(3, 1, 'Cyrus')]), BASIC.replace('3,Cy,plain', '3,Cyrus,plain'));
});

test('new text is quoted when it holds the delimiter, a quote or a line break, and not otherwise', () => {
  const file = 'a,b\n1,2\n';
  assert.equal(saved(file, [setCell(1, 0, 'x, y')]), 'a,b\n"x, y",2\n');
  assert.equal(saved(file, [setCell(1, 0, 'say "hi"')]), 'a,b\n"say ""hi""",2\n');
  assert.equal(saved(file, [setCell(1, 0, 'two\nlines')]), 'a,b\n"two\nlines",2\n');
  assert.equal(saved(file, [setCell(1, 0, 'one\rtwo')]), 'a,b\n"one\rtwo",2\n');
  assert.equal(saved(file, [setCell(1, 0, ' spaces kept ')]), 'a,b\n spaces kept ,2\n');
  assert.equal(saved(file, [setCell(1, 0, 'x;y')]), 'a,b\nx;y,2\n');
  // The delimiter of the file decides, not the comma.
  assert.equal(saved('a;b\n1;2\n', [setCell(1, 0, 'x;y'), setCell(1, 1, 'p,q')], ';'), 'a;b\n"x;y";p,q\n');
});

test('a field that was quoted without need stays quoted when it gets a new text', () => {
  assert.equal(saved(BASIC, [setCell(1, 1, 'Anna')]), BASIC.replace('"Ann"', '"Anna"'));
  // One that needed its quotes loses them with the need.
  assert.equal(saved(BASIC, [setCell(4, 1, 'Dee')]), BASIC.replace('"Dee, Jr."', 'Dee'));
});

test('in a file whose every field is quoted, new fields and new rows are quoted too', () => {
  const file = '"a","b"\n"1","2"\n';
  assert.equal(saved(file, [setCell(1, 0, 'x'), insertRows({ 2: ['p', ''] })]), '"a","b"\n"x","2"\n"p",""\n');
});

test('text behind a closing quote is part of the field and is copied as it stands', () => {
  const file = '"a"b,c\n1,2\n';
  assert.deepEqual(parseCsv(file), [['ab', 'c'], ['1', '2']]);
  assert.equal(saved(file, [setCell(0, 1, 'C')]), '"a"b,C\n1,2\n');
});

// ---- Rows and line breaks ----------------------------------------------------------------

test('rows keep the line break they have; a new row gets the one most rows have', () => {
  const file = 'a,b\r\n1,2\n3,4\r\n5,6\r';
  assert.equal(saved(file, [setCell(1, 0, 'x'), insertRows({ 2: ['new', 'row'] })]), 'a,b\r\nx,2\nnew,row\r\n3,4\r\n5,6\r');
});

test('a file that ends without a line break goes on ending without one, also when the last row is new', () => {
  assert.equal(saved('a,b\n1,2', [setCell(1, 1, 'x')]), 'a,b\n1,x');
  assert.equal(saved('a,b\n1,2', [insertRows({ 2: ['3', '4'] })]), 'a,b\n1,2\n3,4');
  assert.equal(saved('a,b\n1,2', [deleteRows(1)]), 'a,b');
  assert.equal(saved('a,b\n1,2\n', [insertRows({ 2: ['3', '4'] })]), 'a,b\n1,2\n3,4\n');
});

test('a file without any line break takes the one it is given for new rows', () => {
  assert.equal(saved('a,b', [insertRows({ 0: ['x', 'y'] })], ',', '\r\n'), 'x,y\r\na,b');
  assert.equal(saved('', [insertRows({ 0: ['first', 'second'] })], ',', '\r\n'), 'first,second\r\n');
});

test('rows are inserted and deleted by their number at that moment', () => {
  const file = 'h\na\nb\nc\nd\n';
  assert.equal(saved(file, [deleteRows(1, 3)]), 'h\nb\nd\n');
  assert.equal(saved(file, [insertRows({ 0: ['top'], 2: ['mid'], 7: ['end'] })]), 'top\nh\nmid\na\nb\nc\nd\nend\n');
  // The second step counts rows as the first left them.
  assert.equal(saved(file, [deleteRows(1), setCell(1, 0, 'B'), insertRows({ 1: ['new'] }), deleteRows(4)]), 'h\nnew\nB\nc\n');
});

test('a column goes in and out without touching the cells around it', () => {
  const file = 'id,"name",note\r\n1,"Ann",x\r\n2\r\n3,"Cy",\r\n';
  // Rows that don't reach the column are left alone.
  assert.equal(saved(file, [insertColumn(1, [0, 1, 3])]), 'id,,"name",note\r\n1,,"Ann",x\r\n2\r\n3,,"Cy",\r\n');
  assert.equal(saved(file, [deleteColumn(1, [0, 1, 3])]), 'id,note\r\n1,x\r\n2\r\n3,\r\n');
  assert.equal(saved(file, [insertColumn(3, [0, 1, 3])]), 'id,"name",note,\r\n1,"Ann",x,\r\n2\r\n3,"Cy",,\r\n');
});

test('ragged rows stay ragged, and a row can grow or shrink', () => {
  const file = 'a,b,c\n1\n2,3\n';
  assert.equal(saved(file, [setRows({ 1: ['1', 'new'], 2: ['2'] })]), 'a,b,c\n1,new\n2\n');
});

// ---- The places where a field can't be copied as it is --------------------------------------

test('a row of one empty cell is written as "" where an empty line would vanish', () => {
  // At the end of a file without a final line break.
  assert.equal(saved('a\nb', [setCell(1, 0, '')]), 'a\n""');
  assert.deepEqual(parseCsv('a\n""'), [['a'], ['']]);
  // Between a lone carriage return and a line feed, which would read as one line break.
  assert.equal(saved('a\rb\nc\n', [setCell(1, 0, '')]), 'a\r""\nc\n');
  // Anywhere else an empty line is a row.
  assert.equal(saved('a\nb\nc\n', [setCell(1, 0, '')]), 'a\n\nc\n');
});

test('a quoted field that is never closed is copied only at the very end, and closed anywhere else', () => {
  const file = 'a,b\n1,"open, to the end\nof the file';
  assert.deepEqual(parseCsv(file), [['a', 'b'], ['1', 'open, to the end\nof the file']]);
  assert.equal(saved(file, [setCell(1, 0, 'x')]), 'a,b\nx,"open, to the end\nof the file');
  // A row behind it: left open, it would swallow that row.
  assert.equal(saved(file, [insertRows({ 2: ['p', 'q'] })]), 'a,b\n1,"open, to the end\nof the file"\np,q');
  // Moved to another place in its row.
  assert.equal(saved(file, [setRows({ 1: ['1', 'open, to the end\nof the file', 'more'] })]), 'a,b\n1,"open, to the end\nof the file",more');
});

// ---- Encodings ---------------------------------------------------------------------------

const utf16 = (text: string, big = false) => {
  const body = Buffer.from(text, 'utf16le');
  return Buffer.concat([Buffer.from(big ? [0xfe, 0xff] : [0xff, 0xfe]), big ? body.swap16() : body]);
};

test('UTF-8: the byte order mark stays, and offsets count bytes, not characters', () => {
  const text = 'имя,値\r\nАнна,😀 one\r\nБорис,two\r\n';
  for (const mark of [Buffer.alloc(0), Buffer.from([0xef, 0xbb, 0xbf])]) {
    const out = render(Buffer.concat([mark, Buffer.from(text, 'utf8')]), [setCell(2, 1, 'três')], { delimiter: ',', verify: true });
    assert.deepEqual(Buffer.from(out.bytes), Buffer.concat([mark, Buffer.from(text.replace('two', 'três'), 'utf8')]));
    assert.equal(out.encoding, mark.length ? 'UTF-8 with BOM' : 'UTF-8');
  }
});

test('UTF-16: new text is written in the byte order of the file', () => {
  const text = 'name,note\r\nАнна,"quoted"\r\n';
  for (const big of [false, true]) {
    const out = render(utf16(text, big), [setCell(1, 0, 'Ω😀'), insertRows({ 2: ['new', 'row'] })], { delimiter: ',', verify: true });
    assert.deepEqual(Buffer.from(out.bytes), utf16('name,note\r\nΩ😀,"quoted"\r\nnew,row\r\n', big));
    assert.equal(out.encoding, big ? 'UTF-16 BE' : 'UTF-16 LE');
  }
});

test('UTF-16: half a character at the end of the file stays at the end', () => {
  const file = Buffer.concat([utf16('a,b\n1,2'), Buffer.from([0x41])]);
  const out = Buffer.from(render(file, [setCell(0, 0, 'A')], { delimiter: ',', verify: true }).bytes);
  assert.deepEqual(out, Buffer.concat([utf16('A,b\n1,2'), Buffer.from([0x41])]));
});

test('Windows-1252 is read as that code page: 0x80 is the euro sign, 0x93 and 0x94 are quotes', () => {
  const file = Buffer.from('caf\xe9,\x80 5,\x93ok\x94\n', 'latin1');
  assert.deepEqual(decodeWithEncoding(file), { text: 'café,€ 5,“ok”\n', encoding: 'Windows-1252' });
});

test('Windows-1252: untouched bytes stay, new text is written in the code page', () => {
  // é and € in Windows-1252; the lone 0xE9 is what keeps the file from being read as UTF-8.
  const file = Buffer.from('caf\xe9,\x80 5\r\nna\xefve,x\r\n', 'latin1');
  assert.equal(decodeWithEncoding(file).encoding, 'Windows-1252');
  const out = render(file, [setCell(1, 1, 'œuvre – “ok” €')], { delimiter: ',', verify: true });
  assert.equal(Buffer.from(out.bytes).toString('latin1'), 'caf\xe9,\x80 5\r\nna\xefve,\x9cuvre \x96 \x93ok\x94 \x80\r\n');
  assert.equal(out.encoding, 'Windows-1252');
});

test('Windows-1252: text the code page has no place for is refused, with the characters named', () => {
  const file = Buffer.from('caf\xe9,x\r\n', 'latin1');
  assert.throws(
    () => render(file, [setCell(0, 1, 'Привет 😀 ok')], { delimiter: ',', verify: true }),
    (e) => e instanceof Unencodable && e.encoding === 'Windows-1252' && e.chars.join('') === 'Привет😀',
  );
  // The worker entry hands the same over as a result, since an error class doesn't cross threads.
  assert.deepEqual(runRender({ bytes: file, ops: [setCell(0, 1, 'Ω')], options: { delimiter: ',', verify: true } }), { unencodable: { encoding: 'Windows-1252', chars: ['Ω'] } });
});

test('a file that can\'t hold an edit can be written whole as UTF-8, with or without a byte order mark', () => {
  const file = Buffer.from('caf\xe9,x\r\n', 'latin1');
  const plain = render(file, [setCell(0, 1, 'Привет')], { delimiter: ',', verify: true, convert: 'UTF-8' });
  assert.deepEqual(Buffer.from(plain.bytes), Buffer.from('café,Привет\r\n', 'utf8'));
  assert.equal(plain.encoding, 'UTF-8');
  const marked = render(file, [setCell(0, 1, 'Привет')], { delimiter: ',', verify: true, convert: 'UTF-8 with BOM' });
  assert.deepEqual(Buffer.from(marked.bytes), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café,Привет\r\n', 'utf8')]));
  assert.equal(marked.encoding, 'UTF-8 with BOM');
});

test('an edit after which the bytes would read as UTF-8 and mean something else is refused', () => {
  // C3 A9 is "Ã©" in Windows-1252 and "é" in UTF-8. The lone E9 in the second row is all that says which.
  const file = Buffer.from('\xc3\xa9,1\n\xe9,2\n', 'latin1');
  assert.deepEqual(parseCsv(decodeWithEncoding(file).text), [['Ã©', '1'], ['é', '2']]);
  assert.throws(() => render(file, [deleteRows(1)], { delimiter: ',', verify: true }), (e) => e instanceof Unencodable && e.chars.length === 0);
  // Written as UTF-8, the text stays what the table showed.
  assert.deepEqual(Buffer.from(render(file, [deleteRows(1)], { delimiter: ',', verify: true, convert: 'UTF-8' }).bytes), Buffer.from('Ã©,1\n', 'utf8'));
});

// ---- What a save reports ----------------------------------------------------------------------

test('a verified save says what a reader will find in the file: the encoding and the delimiter', () => {
  const out = render(Buffer.from('a;b\n1;2\n'), [setCell(1, 0, 'x')], { delimiter: ';', verify: true });
  assert.equal(out.encoding, 'UTF-8');
  assert.equal(out.detected, ';');
});

test('the table a page is given is the table a save writes', () => {
  const ops = [setCell(1, 1, 'Anna'), insertRows({ 2: ['new', 'row', ''] }), deleteRows(4), insertColumn(0, [0, 1, 2, 3, 4])];
  const shown = editedTable(Buffer.from(BASIC, 'latin1'), ops, ',');
  assert.deepEqual(flatRows(shown.table), parseCsv(saved(BASIC, ops)));
  assert.deepEqual(flatRows(shown.table), [['', 'id', 'name', 'note'], ['', '1', 'Anna', 'said "hi"'], ['', 'new', 'row', ''], ['', '2', 'Bob', 'two\r\nlines'], ['', '4', 'Dee, Jr.', '']]);
  assert.equal(shown.encoding, 'UTF-8');
  assert.equal(shown.detected, false);
  // Without a delimiter the one the file seems to use is taken.
  const guessed = editedTable(Buffer.from('a;b\n1;2\n'), [], '');
  assert.deepEqual([guessed.delimiter, guessed.detected], [';', true]);
});

// ---- Edits that don't fit ------------------------------------------------------------------------

test('a step that names a row or a cell that is not there is an error, not a guess', () => {
  const file = Buffer.from('a,b\n1,2\n');
  const options = { delimiter: ',', verify: true };
  assert.throws(() => render(file, [deleteRows(2)], options), /not there/);
  assert.throws(() => render(file, [setCell(2, 0, 'x')], options), /not there/);
  assert.throws(() => render(file, [setCell(1, 2, 'x')], options), /not there/);
  assert.throws(() => render(file, [insertRows({ 5: ['x'] })], options), /beyond the end/);
  assert.equal(rowsAfter([insertRows({ 2: ['x'], 3: ['y'] }), deleteRows(0)], 2), 3);
  assert.throws(() => rowsAfter([deleteRows(2)], 2), /not there/);
  assert.throws(() => rowsAfter([insertRows({ 3: ['x'] })], 2), /not there/);
  assert.throws(() => rowsAfter([setCell(2, 0, 'x')], 2), /not there/);
});

test('steps that come from a page are checked: kind, order of rows, rows against cells', () => {
  const good = { type: 'set', rows: [0, 2], table: { text: [97, 98], ends: [1, 2], rowEnds: [1, 2] } };
  const [op] = readOps([good]);
  // Plain arrays, as a message may bring them, become typed arrays.
  assert.ok(op.rows instanceof Uint32Array && op.table!.text instanceof Uint8Array && op.table!.ends instanceof Uint32Array);
  assert.deepEqual([...op.rows], [0, 2]);
  assert.throws(() => readOps('set'), /not a list/);
  assert.throws(() => readOps([{ ...good, type: 'drop' }]), /unknown kind/);
  assert.throws(() => readOps([{ ...good, rows: [2, 0] }]), /not in order/);
  assert.throws(() => readOps([{ ...good, rows: [1, 1] }]), /not in order/);
  assert.throws(() => readOps([{ ...good, rows: [0] }]), /do not match/);
  assert.throws(() => readOps([{ ...good, table: { ...good.table, ends: [1] } }]), /do not match/);
  assert.throws(() => readOps([{ ...good, at: -1 }]), /column/);
  assert.throws(() => readOps([{ ...good, at: 0, widths: [1] }]), /do not match/);
  assert.equal(readOps([{ type: 'delete', rows: [1] }])[0].table, undefined);
});

// ---- Backups ---------------------------------------------------------------------------------------

test('a backup gives back the file and the steps, and a damaged one gives nothing', () => {
  const file = Buffer.from(BASIC, 'latin1');
  const ops = [setCell(1, 1, 'Anna'), insertRows({ 2: ['new', 'row', 'Привет'] }), deleteRows(4), insertColumn(0, [0, 1])];
  const packed = packBackup(';', file, ops);
  const back = unpackBackup(packed);
  assert.ok(back);
  assert.equal(back.delimiter, ';');
  assert.deepEqual(Buffer.from(back.bytes), file);
  assert.deepEqual(render(back.bytes, back.ops, { delimiter: ',' }).bytes, render(file, ops, { delimiter: ',' }).bytes);
  assert.deepEqual(back.ops.map((op) => [op.type, [...op.rows], op.at, op.widths && [...op.widths]]), ops.map((op) => [op.type, [...op.rows], op.at, op.widths && [...op.widths]]));

  assert.equal(unpackBackup(packed.subarray(0, packed.length - 1)), undefined);
  assert.equal(unpackBackup(packed.subarray(0, 40)), undefined);
  assert.equal(unpackBackup(Buffer.from('a,b\n1,2\n')), undefined);
  assert.equal(unpackBackup(new Uint8Array(0)), undefined);
});

test('the fingerprint of a file is the SHA-256 of its bytes', () => {
  assert.equal(fingerprint(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ---- A randomised pass --------------------------------------------------------------------------------
//
// Files as programs write them (four delimiters; CRLF, LF, CR and mixed; with and without a final line
// break; five encodings; needless quotes, text behind a closing quote, a quote that is never closed, ragged
// rows, an empty file, half a UTF-16 character at the end) with random steps of every kind. For each: the
// result reads back as the edited table, and every field, line break and byte order mark that was not edited
// has its bytes. The seed is fixed, so a failure can be run again.

const ENCODINGS = ['UTF-8', 'UTF-8 with BOM', 'UTF-16 LE', 'UTF-16 BE', 'Windows-1252'];
const DELIMITERS = [',', ';', '\t', '|'];
const LATIN = 'éüßñÀ€“”…ÿ£';
const WIDE = 'Привет→日本😀éß€';
const WINDOWS: Record<string, number> = { '€': 0x80, '“': 0x93, '”': 0x94, '…': 0x85 };

function toBytes(text: string, encoding: string): Buffer {
  switch (encoding) {
    case 'UTF-8':
      return Buffer.from(text, 'utf8');
    case 'UTF-8 with BOM':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'UTF-16 LE':
      return utf16(text);
    case 'UTF-16 BE':
      return utf16(text, true);
    default:
      return Buffer.from([...text].map((char) => WINDOWS[char] ?? char.charCodeAt(0)));
  }
}

/** Every unit of the file as one character, so that a raw field can be compared as a string without the decoder under test. */
function units(bytes: Buffer, encoding: string): string {
  if (encoding.startsWith('UTF-16')) {
    // Half a character at the end stands as a unit of its own.
    const even = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)));
    return (encoding === 'UTF-16 BE' ? even.swap16() : even).toString('utf16le') + (bytes.length % 2 ? '' : '');
  }
  return bytes.subarray(encoding === 'UTF-8 with BOM' ? 3 : 0).toString('latin1');
}

interface RawRow {
  fields: string[];
  /** The line break behind the row, or nothing. */
  term: string;
}

/** The raw fields and line breaks of a file, by a tokenizer of the test's own. */
function rawRows(text: string, delimiter: string): RawRow[] {
  const rows: RawRow[] = [];
  let fields: string[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] === '"' && i === start) {
      i++;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close < 0) {
          i = text.length;
          break;
        }
        i = close + 1;
        if (text[i] !== '"') {
          break;
        }
        i++;
      }
      continue;
    }
    const char = text[i];
    if (char === delimiter) {
      fields.push(text.slice(start, i));
      start = ++i;
    } else if (char === '\n' || char === '\r') {
      fields.push(text.slice(start, i));
      const end = i + (char === '\r' && text[i + 1] === '\n' ? 2 : 1);
      rows.push({ fields, term: text.slice(i, end) });
      fields = [];
      start = i = end;
    } else {
      i++;
    }
  }
  if (start < text.length || fields.length) {
    fields.push(text.slice(start));
    rows.push({ fields, term: '' });
  }
  return rows;
}

type Special = '' | 'empty' | 'header' | 'junk' | 'unclosed' | 'odd';

function value(rand: Random, encoding: string): string {
  const letters = [...(encoding === 'Windows-1252' ? LATIN : WIDE)];
  const word = () => Array.from({ length: 1 + rand.int(6) }, () => (rand() < 0.2 ? rand.pick(letters) : String.fromCharCode(97 + rand.int(26)))).join('');
  switch (rand.int(12)) {
    case 0:
      return '';
    case 1:
      return String(rand.int(100000) / rand.pick([1, 10, 100]));
    case 2:
      return ` ${word()} `;
    case 3:
      return `${word()}"${word()}`;
    case 4:
      return `${word()}\n${word()}`;
    case 5:
      return `${word()}\r\n${word()}`;
    case 6:
      return `${word()},${word()};${word()}\t${word()}|${word()}`;
    case 7:
      return `"${word()}"`;
    default:
      return word();
  }
}

function makeFile(rand: Random, special: Special) {
  const encoding = rand.pick(ENCODINGS);
  const delimiter = rand.pick(DELIMITERS);
  const eols = rand.pick([['\r\n'], ['\n'], ['\r\n', '\n', '\r'], ['\r']]);
  const finalBreak = rand() < 0.5;
  const rows = special === 'empty' ? 0 : special === 'header' ? 1 : 1 + rand.int(12);
  const columns = 1 + rand.int(6);
  const ragged = rand() < 0.3;
  let text = '';
  let before = '';
  for (let r = 0; r < rows; r++) {
    const cells = Array.from({ length: ragged ? 1 + rand.int(columns + 2) : columns }, () => value(rand, encoding));
    // A field as some program might have written it: quoted when it must be, and sometimes without need.
    let line = cells.map((cell) => (cell.includes(delimiter) || /["\r\n]/.test(cell) || rand() < 0.15 ? `"${cell.replace(/"/g, '""')}"` : cell)).join(delimiter);
    if (special === 'junk' && r === 0) {
      line = `"a"b${delimiter}${line}`;
    }
    const last = r === rows - 1;
    // A line that is one empty unquoted field can't be the last line of a file without a line break.
    if (line === '' && last && !finalBreak) {
      line = '""';
    }
    // An empty line between a lone carriage return and a line feed would not be a line.
    const term = last && !finalBreak ? '' : line === '' && before === '\r' ? '\r' : rand.pick(eols);
    before = term;
    text += line + term;
  }
  if (special === 'unclosed' && rows) {
    text = `${text.replace(/(\r\n|\n|\r)$/, '')}${text ? delimiter : ''}"open${delimiter}line\nmore ${rand.int(1000)}`;
  }
  let bytes = toBytes(text, encoding);
  if (special === 'odd' && encoding.startsWith('UTF-16')) {
    bytes = Buffer.concat([bytes, Buffer.from([0x41])]);
  }
  return { encoding, delimiter, bytes };
}

/** A cell of the model: its text, and the field of the file (row, column) it still is, if it is one. */
interface Cell {
  text: string;
  raw: [number, number] | null;
}

interface Row {
  /** The row of the file this one came from, or -1 for a new one. */
  origin: number;
  cells: Cell[];
}

/** `n` distinct numbers below `max`, rising. */
function some(rand: Random, n: number, max: number): number[] {
  const set = new Set<number>();
  while (set.size < Math.min(n, max)) {
    set.add(rand.int(max));
  }
  return [...set].sort((a, b) => a - b);
}

/** Random steps, applied to the model `ref` as they are made. Returns the model after them. */
function randomSteps(rand: Random, start: Row[], encoding: string, ops: Op[]): Row[] {
  let ref = start;
  const fresh = (): Cell => ({ text: value(rand, encoding), raw: null });
  for (let step = rand.int(5); step >= 0; step--) {
    const kind = rand.int(12);
    if (kind >= 10 && ref.length) {
      // Some cells of rows that have them, from a column on: the way a cell edit, a clear and a paste arrive.
      const at = rand.int(Math.max(...ref.map((row) => row.cells.length)));
      const rows = some(rand, 1 + rand.int(4), ref.length).filter((r) => ref[r].cells.length > at);
      if (!rows.length) {
        continue;
      }
      const next = rows.map((r) => Array.from({ length: 1 + rand.int(ref[r].cells.length - at) }, (_, j) => (rand() < 0.25 ? ref[r].cells[at + j].text : value(rand, encoding))));
      rows.forEach((r, k) => {
        const cells = ref[r].cells.slice();
        next[k].forEach((text, j) => {
          if (cells[at + j].text !== text) {
            cells[at + j] = { text, raw: null };
          }
        });
        ref[r] = { origin: ref[r].origin, cells };
      });
      ops.push({ type: 'set', rows: Uint32Array.from(rows), at, table: wire(next) });
    } else if (kind < 5 && ref.length) {
      // Whole rows, which may grow or shrink.
      const rows = some(rand, 1 + rand.int(3), ref.length);
      const next = rows.map((r) => {
        const cells = ref[r].cells.map((cell) => (rand() < 0.4 ? { text: rand() < 0.2 ? cell.text : value(rand, encoding), raw: null } : cell));
        if (rand() < 0.2) {
          cells.push(fresh());
        }
        if (rand() < 0.1 && cells.length > 1) {
          cells.pop();
        }
        // A cell that is given the text it has is not an edit.
        return cells.map((cell, c) => (ref[r].cells[c]?.text === cell.text ? ref[r].cells[c] : cell));
      });
      rows.forEach((r, k) => (ref[r] = { origin: ref[r].origin, cells: next[k] }));
      ops.push({ type: 'set', rows: Uint32Array.from(rows), table: wire(next.map((cells) => cells.map((cell) => cell.text))) });
    } else if (kind < 7) {
      const count = 1 + rand.int(3);
      const rows = some(rand, count, ref.length + count);
      const added = rows.map(() => Array.from({ length: 1 + rand.int(4) }, fresh));
      const out: Row[] = [];
      let from = 0;
      let k = 0;
      // Positions beyond the end would leave a gap; they are pulled in.
      for (let r = 0; from < ref.length || k < rows.length; r++) {
        if (k < rows.length && (rows[k] === r || from >= ref.length)) {
          rows[k] = r;
          out.push({ origin: -1, cells: added[k++] });
        } else {
          out.push(ref[from++]);
        }
      }
      ref = out;
      ops.push({ type: 'insert', rows: Uint32Array.from(rows), table: wire(added.map((cells) => cells.map((cell) => cell.text))) });
    } else if (kind < 9 && ref.length) {
      const rows = some(rand, 1 + rand.int(3), ref.length);
      ref = ref.filter((_, r) => !rows.includes(r));
      ops.push({ type: 'delete', rows: Uint32Array.from(rows) });
    } else if (ref.length) {
      // A column goes in or out, as the page does it: one `set` of every row that reaches it.
      const insert = rand() < 0.5;
      const at = rand.int(Math.max(...ref.map((row) => row.cells.length)) + (insert ? 1 : 0));
      const rows: number[] = [];
      const given: string[][] = [];
      ref.forEach((row, r) => {
        if (insert ? row.cells.length < at : row.cells.length <= at) {
          return;
        }
        const cells = row.cells.slice();
        // One empty cell goes in for none, or none for one; a row is never left without a cell.
        const put: Cell[] = insert || cells.length === 1 ? [{ text: '', raw: null }] : [];
        cells.splice(at, insert ? 0 : 1, ...put);
        rows.push(r);
        given.push(put.map((cell) => cell.text));
        ref[r] = { origin: row.origin, cells };
      });
      if (rows.length) {
        ops.push({ type: 'set', rows: Uint32Array.from(rows), at, widths: new Uint32Array(rows.length).fill(insert ? 0 : 1), table: wire(given) });
      }
    }
  }
  return ref;
}

test('random edits of random files: the result reads back as the edited table, and what was not edited has its bytes', () => {
  const rand = random(4242);
  const counts = { cases: 0, kept: 0, changed: 0, unchanged: 0, refused: 0 };
  for (let n = 0; n < 3000; n++) {
    const special = rand.pick<Special>(['', '', '', '', 'empty', 'header', 'junk', 'unclosed', 'odd']);
    const file = makeFile(rand, special);
    // A Windows-1252 file without a byte that breaks UTF-8 is a UTF-8 file to every reader.
    const encoding = decodeWithEncoding(file.bytes).encoding;
    assert.ok(encoding === file.encoding || file.encoding === 'Windows-1252');
    const parsed = parseCsv(decodeWithEncoding(file.bytes).text, file.delimiter);
    const original = rawRows(units(file.bytes, encoding), file.delimiter);
    assert.equal(original.length, parsed.length, 'the tokenizer of the test and the parser disagree on the rows');
    const odd = special === 'odd' && encoding.startsWith('UTF-16');
    /** The field that can't be copied anywhere but to the very end. */
    const pinned = (special === 'unclosed' || odd) && parsed.length ? [parsed.length - 1, parsed[parsed.length - 1].length - 1] : null;

    const ops: Op[] = [];
    const ref = randomSteps(rand, parsed.map((cells, r) => ({ origin: r, cells: cells.map((text, c): Cell => ({ text, raw: [r, c] })) })), encoding, ops);
    const context = `case ${n} (${encoding}${special ? `, ${special}` : ''}, delimiter ${JSON.stringify(file.delimiter)})`;
    const want = ref.map((row) => row.cells.map((cell) => cell.text));

    // The steps pass through the reader that checks what a page sends.
    const checked = readOps(ops);
    let out: Buffer;
    try {
      out = Buffer.from(render(file.bytes, checked, { delimiter: file.delimiter, eol: '\n', verify: true }).bytes);
    } catch (e) {
      // An edit can turn bytes that weren't UTF-8 into bytes that are; that is refused, and counted.
      assert.ok(e instanceof Unencodable && !e.chars.length && encoding === 'Windows-1252', `${context}: ${e}`);
      counts.refused++;
      continue;
    }
    counts.cases++;

    // 1. The result reads back as the edited table, in the encoding the file had.
    const back = decodeWithEncoding(out);
    assert.deepEqual(parseCsv(back.text, file.delimiter), want, context);
    // eslint-disable-next-line no-control-regex
    assert.ok(back.encoding === encoding || !/[^\x00-\x7f]/.test(back.text), `${context}: the encoding changed to ${back.encoding}`);
    assert.deepEqual(flatRows(editedTable(file.bytes, checked, file.delimiter).table), want, `${context}: the table for the page`);

    // 2. Edits that change nothing change nothing.
    const same = ref.length === original.length && ref.every((row, r) => row.origin === r && row.cells.length === parsed[r].length && row.cells.every((cell, c) => cell.raw?.[0] === r && cell.raw[1] === c));
    if (same) {
      counts.unchanged++;
      assert.ok(out.equals(file.bytes), `${context}: edits that change nothing changed the file`);
    }

    // 3. The byte order mark.
    const mark = encoding.startsWith('UTF-16') ? 2 : encoding === 'UTF-8 with BOM' ? 3 : 0;
    assert.deepEqual(out.subarray(0, mark), file.bytes.subarray(0, mark), context);

    // 4. Every field that is still a field of the file has its bytes, and every row of the file its line break.
    const result = rawRows(units(out, encoding), file.delimiter);
    assert.equal(result.length, ref.length, context);
    const hadFinal = !original.length || original[original.length - 1].term !== '';
    const breaks = original.map((row) => row.term).filter(Boolean);
    const common = ['\r\n', '\n', '\r'].map((eol): [string, number] => [eol, breaks.filter((b) => b === eol).length]).sort((a, b) => b[1] - a[1])[0];
    const eol = common[1] ? common[0] : '\n';
    ref.forEach((row, q) => {
      const last = q === ref.length - 1;
      assert.equal(result[q].fields.length, row.cells.length, `${context}, row ${q}`);
      row.cells.forEach((cell, c) => {
        if (!cell.raw) {
          counts.changed++;
          return;
        }
        const [r, oc] = cell.raw;
        if (pinned && pinned[0] === r && pinned[1] === oc && !(last && c === row.cells.length - 1 && !hadFinal)) {
          return;
        }
        // A row that is one empty field has to be written as "" at the end of the file and behind a lone carriage return.
        if (original[r].fields[oc] === '' && result[q].fields[c] === '""' && row.cells.length === 1 && (last || (q && result[q - 1].term === '\r' && result[q].term === '\n'))) {
          return;
        }
        assert.equal(result[q].fields[c], original[r].fields[oc], `${context}: the untouched field ${c} of row ${q} changed`);
        counts.kept++;
      });
      const own = row.origin >= 0 ? original[row.origin].term : '';
      assert.equal(result[q].term, last && !hadFinal ? '' : own || eol, `${context}: the line break of row ${q}`);
    });

    // 5. Half a character at the end of a UTF-16 file stays where it is.
    const tail = ref.at(-1)?.cells.at(-1)?.raw;
    if (odd && tail && pinned && tail[0] === pinned[0] && tail[1] === pinned[1]) {
      assert.equal(out[out.length - 1], 0x41, context);
    }

    // 6. A backup of the same steps writes the same file.
    if (n % 10 === 0) {
      const kept = unpackBackup(packBackup(file.delimiter, file.bytes, checked));
      assert.ok(kept && Buffer.from(render(kept.bytes, kept.ops, { delimiter: kept.delimiter, eol: '\n' }).bytes).equals(out), `${context}: the backup`);
    }
  }
  // The pass is only worth its name if it did all of this many times.
  assert.ok(counts.cases > 2900 && counts.kept > 30000 && counts.changed > 15000 && counts.unchanged > 100, JSON.stringify(counts));
});
