import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatRows } from '../src/csv';
import { parseJsonLines, readJsonLines } from '../src/jsonl';

/** The table of a text: column names and rows, which end at their last value. */
function table(text: string): { names: string[]; rows: string[][] } {
  const read = parseJsonLines(text);
  return { names: read.names, rows: flatRows(read.table) };
}

// ---- Columns ----------------------------------------------------------------------------------

test('the keys of the objects are the columns, in order of first appearance', () => {
  assert.deepEqual(table('{"id": 1, "name": "Alice"}\n{"name": "Bob", "score": 3.5, "id": 2}\n{"late": true, "id": 3}\n'), {
    names: ['id', 'name', 'score', 'late'],
    rows: [
      ['1', 'Alice'],
      ['2', 'Bob', '3.5'],
      ['3', '', '', 'true'],
    ],
  });
});

test('keys that look like numbers keep their place among the other keys', () => {
  // JSON.parse lists such keys of an object first and in order of their value, wherever they were written.
  assert.deepEqual(table('{"b": 1, "2": 2}\n'), { names: ['b', '2'], rows: [['1', '2']] });
  assert.deepEqual(table('{"3": "c", "1": "a", "2": "b"}\n{"10": "j", "name": "n", "0": "z"}\n'), {
    names: ['3', '1', '2', '10', 'name', '0'],
    rows: [
      ['c', 'a', 'b'],
      ['', '', '', 'j', 'n', 'z'],
    ],
  });
  // Only the keys of the object itself count: not those of the objects in it, and not what a text happens to hold.
  assert.deepEqual(table(' { "b" : {"9": 1, "a": [{"7": 2}]} , "10" : "x, \\"5\\": {y" , "a\\"q" : [ "4", {"1": 2} ] , "1" : null , "\\u0038" : true }\n'), {
    names: ['b', '10', 'a"q', '1', '8'],
    rows: [['{"9":1,"a":[{"7":2}]}', 'x, "5": {y', '["4",{"1":2}]', '', 'true']],
  });
  // A key written twice has the place of the first and the value of the last, as in any object.
  assert.deepEqual(table('{"1": "first", "x": 0, "1": "again"}\n'), { names: ['1', 'x'], rows: [['again', '0']] });
  // Numbers too long for a double keep their digits on this path as well.
  assert.deepEqual(table('{"id": 12345678901234567890, "7": 9007199254740993}\n').rows, [['12345678901234567890', '9007199254740993']]);
});

test('a row ends at its last value, and a key without a value leaves its cell empty', () => {
  assert.deepEqual(table('{"a": 1, "b": 2, "c": 3}\n{"a": 4}\n{"b": 5}\n{"a": null, "b": "", "c": null}\n').rows, [['1', '2', '3'], ['4'], ['', '5'], []]);
});

test('an array fills the columns 1, 2, … and any other value the column "value"', () => {
  assert.deepEqual(table('[1, "two", null, 4]\n42\n"just a string"\ntrue\n[5]\n'), {
    names: ['1', '2', '3', '4', 'value'],
    rows: [['1', 'two', '', '4'], ['', '', '', '', '42'], ['', '', '', '', 'just a string'], ['', '', '', '', 'true'], ['5']],
  });
});

test('a line that is null is a row without values', () => {
  const read = parseJsonLines('{"a": 1}\nnull\n{"a": 2}\n');
  assert.deepEqual(flatRows(read.table), [['1'], [], ['2']]);
  assert.equal(read.broken, 0);
  assert.equal(read.lines, undefined);
});

// ---- Values -----------------------------------------------------------------------------------

test('strings are shown as they are, numbers and booleans as written out, null as nothing', () => {
  assert.deepEqual(table('{"s": "line1\\nline2 \\"q\\" Zoë 日本語 🎉", "n": -1.5, "e": 1e3, "t": true, "f": false, "z": null, "x": 0}\n').rows, [['line1\nline2 "q" Zoë 日本語 🎉', '-1.5', '1000', 'true', 'false', '', '0']]);
});

test('nested values are shown as compact JSON', () => {
  assert.deepEqual(table('{"tags": ["a", "b"], "address": {"city": "Paris", "zip": null, "geo": [48.85, 2.35]}, "none": [], "empty": {}}\n').rows, [
    ['["a","b"]', '{"city":"Paris","zip":null,"geo":[48.85,2.35]}', '[]', '{}'],
  ]);
});

test('integers beyond 2^53 keep their digits', () => {
  // As doubles these would read 12345678901234567000, 9007199254740992 and -9223372036854776000.
  assert.deepEqual(table('{"id": 12345678901234567890, "next": 9007199254740993, "min": -9223372036854775808}\n').rows, [['12345678901234567890', '9007199254740993', '-9223372036854775808']]);
});

test('they keep them inside nested values, in arrays and as a line of their own', () => {
  assert.deepEqual(table('{"big": {"n": 9007199254740993, "list": [18446744073709551615, 1.5]}}\n[9007199254740993, 2]\n12345678901234567890\n'), {
    names: ['big', '1', '2', 'value'],
    rows: [['{"n":9007199254740993,"list":[18446744073709551615,1.5]}'], ['', '9007199254740993', '2'], ['', '', '', '12345678901234567890']],
  });
});

test('long digits that are not an integer stay what they are', () => {
  // A float is rounded as a float is, a string of digits is a string, and safe integers are untouched.
  assert.deepEqual(table('{"float": 0.1234567890123456789, "text": "1234567890123456789012", "safe": 9007199254740991, "exp": 1e21}\n').rows, [['0.12345678901234568', '1234567890123456789012', '9007199254740991', '1e+21']]);
});

test('keys named like the properties of every object are columns like any other', () => {
  assert.deepEqual(table('{"__proto__": "p", "constructor": "c", "toString": 1}\n{"constructor": "d"}\n'), {
    names: ['__proto__', 'constructor', 'toString'],
    rows: [
      ['p', 'c', '1'],
      ['', 'd'],
    ],
  });
});

// ---- Lines ------------------------------------------------------------------------------------

test('empty lines and lines of spaces are skipped, and the rows then say which line they are', () => {
  const read = parseJsonLines('{"a": 1}\n\n   \n{"a": 2}\n\t\n{"a": 3}\n');
  assert.deepEqual(flatRows(read.table), [['1'], ['2'], ['3']]);
  assert.deepEqual(Array.from(read.lines ?? []), [1, 4, 6]);
  assert.equal(read.broken, 0);
});

test('without a skipped line the rows are the lines, and no line numbers are given', () => {
  assert.equal(parseJsonLines('{"a": 1}\n{"a": 2}\n').lines, undefined);
  // Lines skipped behind the last row don't shift any row.
  assert.equal(parseJsonLines('{"a": 1}\n{"a": 2}\n\n{oops\n\n').lines, undefined);
});

test('Windows line ends and a missing final line break', () => {
  const read = parseJsonLines('{"a": "x"}\r\n{"a": "y"}\r\n\r\n{"a": "z"}');
  assert.deepEqual(flatRows(read.table), [['x'], ['y'], ['z']]);
  assert.deepEqual(Array.from(read.lines ?? []), [1, 2, 4]);
  assert.equal(read.broken, 0);
});

test('an empty file and a file of empty lines have no rows and no columns', () => {
  for (const text of ['', '\n', '\n\n  \r\n']) {
    const read = parseJsonLines(text);
    assert.deepEqual([read.names, read.table.rowEnds.length, read.table.ends.length, read.table.text, read.broken, read.firstBroken, read.lines], [[], 0, 0, '', 0, [], undefined]);
  }
});

test('a line that is not JSON is left out, counted and named with its line number', () => {
  const read = parseJsonLines(['{"id": 1}', '{"id": 2, "score": }', "{'id': 3}", '{"id": 4}', '{"id": 5, "name": "cut off in the midd'].join('\n'));
  assert.deepEqual(flatRows(read.table), [['1'], ['4']]);
  assert.deepEqual(Array.from(read.lines ?? []), [1, 4]);
  assert.equal(read.broken, 3);
  assert.deepEqual(
    read.firstBroken.map((item) => item.line),
    [2, 3, 5],
  );
  assert.ok(read.firstBroken.every((item) => item.message.length > 0));
});

test('a broken line brings no column, and a broken line with a long integer is still only broken', () => {
  const read = parseJsonLines('{"lost": 1, }\n{"id": 12345678901234567890,}\n{"kept": 2}\n');
  assert.deepEqual(read.names, ['kept']);
  assert.equal(read.broken, 2);
  assert.deepEqual(Array.from(read.lines ?? []), [3]);
});

test('all broken lines are counted, and the first twenty are named', () => {
  // Every second line of a hundred is broken; empty lines in between count as lines.
  const lines = Array.from({ length: 100 }, (_, i) => (i % 2 ? '{oops' : `{"i": ${i}}`));
  const read = parseJsonLines(`\n${lines.join('\n\n')}\n`);
  assert.equal(read.table.rowEnds.length, 50);
  assert.equal(read.broken, 50);
  assert.deepEqual(
    read.firstBroken.map((item) => item.line),
    // Line 1 is empty, the values are on the even lines 2, 6, 10, … and the broken ones on 4, 8, 12, …
    Array.from({ length: 20 }, (_, i) => 4 + i * 4),
  );
  assert.deepEqual(
    Array.from(read.lines ?? []),
    Array.from({ length: 50 }, (_, i) => 2 + i * 4),
  );
});

test('more rows than the first size of the line index', () => {
  // Past 1,024 rows, with one line skipped at the start so that the line numbers are kept.
  const read = parseJsonLines(`\n${Array.from({ length: 3000 }, (_, i) => `{"i": ${i}}`).join('\n')}`);
  assert.equal(read.table.rowEnds.length, 3000);
  assert.deepEqual(
    Array.from(read.lines ?? []),
    Array.from({ length: 3000 }, (_, i) => i + 2),
  );
  assert.deepEqual(flatRows(read.table)[2999], ['2999']);
});

// ---- Files ------------------------------------------------------------------------------------

test('a file is decoded like delimited text: UTF-8 with or without its mark, UTF-16, Windows-1252', () => {
  const text = '{"k": "юникод ü"}\n{"k": 2}\n';
  const rows = [['юникод ü'], ['2']];
  const plain = readJsonLines(Buffer.from(text, 'utf8'));
  assert.deepEqual([plain.encoding, plain.names, flatRows(plain.table), plain.broken], ['UTF-8', ['k'], rows, 0]);
  // The mark must not end up in front of the first line, which would break it.
  const marked = readJsonLines(Buffer.from(`﻿${text}`, 'utf8'));
  assert.deepEqual([marked.encoding, flatRows(marked.table), marked.broken], ['UTF-8 with BOM', rows, 0]);
  const little = readJsonLines(Buffer.from(`﻿${text}`, 'utf16le'));
  assert.deepEqual([little.encoding, flatRows(little.table), little.broken], ['UTF-16 LE', rows, 0]);
  const big = readJsonLines(Buffer.from(`﻿${text}`, 'utf16le').swap16());
  assert.deepEqual([big.encoding, flatRows(big.table), big.broken], ['UTF-16 BE', rows, 0]);
  const latin = readJsonLines(Buffer.from('{"k": "caf\xe9"}\n', 'latin1'));
  assert.deepEqual([latin.encoding, flatRows(latin.table), latin.broken], ['Windows-1252', [['café']], 0]);
});

test('Windows-1252 is more than Latin-1: 0x80 is the euro sign', () => {
  const latin = readJsonLines(Buffer.from('{"k": "caf\xe9 \x80"}\n', 'latin1'));
  assert.deepEqual([latin.encoding, flatRows(latin.table), latin.broken], ['Windows-1252', [['café €']], 0]);
});
