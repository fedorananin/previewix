import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatRows } from '../src/csv';
import { DBF_ENCODINGS, MAX_CELLS, MAX_ROWS, readDbf, type DbfOptions, type DbfTable } from '../src/dbf';
import { random } from './helpers';

// ---- A writer of dBase files, as small as the tests need it ------------------------------------

interface FieldSpec {
  name: string | Uint8Array;
  type: string;
  /** Bytes of the field in a record. A character field may be longer than 255. */
  length: number;
  decimals?: number;
  /** Visual FoxPro: 2 for a field that may be null, 4 for a binary one. */
  flags?: number;
}

interface TableSpec {
  /** The version byte: 0x03 dBase III, 0x83 with a memo file, 0x8b dBase IV, 0xf5 FoxPro, 0x30 Visual FoxPro. */
  version?: number;
  fields: FieldSpec[];
  /** One item per field, each as long as the field. */
  records: Uint8Array[][];
  /** The language driver byte. */
  driver?: number;
  /** The record count of the header, when it is to differ from the records written. */
  count?: number;
  deleted?: number[];
  /** Without the end marker behind the records when false. */
  end?: boolean;
  /** Bytes behind the end marker. */
  tail?: Uint8Array;
}

const latin = (text: string): Buffer => Buffer.from(text, 'latin1');

/** A table with the 32-byte header and 32-byte field descriptors of dBase III, IV, FoxPro and Visual FoxPro. */
function dbase(spec: TableSpec): Buffer {
  const version = spec.version ?? 0x03;
  // Visual FoxPro keeps 263 bytes for the name of a database behind the descriptors.
  const headerLength = 32 + 32 * spec.fields.length + 1 + (version >= 0x30 && version <= 0x32 ? 263 : 0);
  const recordLength = 1 + spec.fields.reduce((sum, field) => sum + field.length, 0);
  const header = Buffer.alloc(headerLength);
  header[0] = version;
  // Last update: October 8 of 2026, the year counted from 1900.
  header.set([126, 10, 8], 1);
  header.writeUInt32LE(spec.count ?? spec.records.length, 4);
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);
  header[29] = spec.driver ?? 0;
  let offset = 1;
  spec.fields.forEach((field, i) => {
    const at = 32 + 32 * i;
    header.set(typeof field.name === 'string' ? latin(field.name) : field.name, at);
    header[at + 11] = field.type.charCodeAt(0);
    header.writeUInt32LE(offset, at + 12);
    header[at + 16] = field.length & 0xff;
    // A character field keeps the high byte of its length where the others have their decimals.
    header[at + 17] = field.type === 'C' ? field.length >> 8 : (field.decimals ?? 0);
    header[at + 18] = field.flags ?? 0;
    offset += field.length;
  });
  header[32 + 32 * spec.fields.length] = 0x0d;
  return Buffer.concat([header, ...records(spec.records, recordLength, spec.deleted), ...(spec.end === false ? [] : [Buffer.from([0x1a])]), ...(spec.tail ? [spec.tail] : [])]);
}

function records(rows: Uint8Array[][], recordLength: number, deleted: number[] = []): Buffer[] {
  return rows.map((row, r) => {
    const record = Buffer.concat([Buffer.from(deleted.includes(r) ? '*' : ' '), ...row]);
    assert.equal(record.length, recordLength, `record ${r} of the fixture has the length of its fields`);
    return record;
  });
}

/** A table of dBase 7: a header of 68 bytes with the name of the language driver, and descriptors of 48 bytes. */
function dbase7(spec: { version?: number; driverName: string; fields: FieldSpec[]; records: Uint8Array[][]; deleted?: number[] }): Buffer {
  const headerLength = 68 + 48 * spec.fields.length + 1;
  const recordLength = 1 + spec.fields.reduce((sum, field) => sum + field.length, 0);
  const header = Buffer.alloc(headerLength);
  header[0] = spec.version ?? 0x8c;
  header.set([126, 10, 8], 1);
  header.writeUInt32LE(spec.records.length, 4);
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);
  header.write(spec.driverName, 32, 'latin1');
  spec.fields.forEach((field, i) => {
    const at = 68 + 48 * i;
    header.set(typeof field.name === 'string' ? latin(field.name) : field.name, at);
    header[at + 32] = field.type.charCodeAt(0);
    header[at + 33] = field.length;
    header[at + 34] = field.decimals ?? 0;
  });
  header[headerLength - 1] = 0x0d;
  return Buffer.concat([header, ...records(spec.records, recordLength, spec.deleted), Buffer.from([0x1a])]);
}

// Values of fields

/** Text in a field: at the left, filled up with spaces. */
function chars(text: string | Uint8Array, length: number): Buffer {
  const raw = typeof text === 'string' ? latin(text) : text;
  assert.ok(raw.length <= length, 'the text of the fixture fits its field');
  return Buffer.concat([raw, Buffer.alloc(length - raw.length, 0x20)]);
}

/** A number in a field: its digits at the right. */
const digits = (text: string, length: number): Buffer => latin(text.padStart(length));

/** The block number of a memo as dBase writes it: ten digits, or spaces for "no memo". */
const pointer = (block: number): Buffer => latin(block ? String(block).padStart(10) : ' '.repeat(10));

function int32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function int64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

function float64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return bytes;
}

/** A date and time of Visual FoxPro: the Julian day number and the milliseconds of that day. */
const stamp = (day: number, milliseconds: number): Buffer => Buffer.concat([uint32(day), uint32(milliseconds)]);

// Julian day numbers, from the tables of the astronomers rather than from the reader's arithmetic.
const JULIAN = { '0001-01-01': 1721426, '2000-01-01': 2451545, '2023-02-24': 2460000, '2024-02-29': 2460370, '9999-12-31': 5373484 };

// Code pages, written out from their tables: the reader has its own, and TextDecoder.

/** Russian text in CP866 (А-Я at 80, а-п at A0, р-я at E0, Ё F0, ё F1) or Windows-1251 (А-я at C0, Ё A8, ё B8). */
function cyrillic(text: string, page: 866 | 1251): Buffer {
  return Buffer.from(
    Array.from(text, (ch) => {
      const code = ch.charCodeAt(0);
      if (code < 0x80) {
        return code;
      }
      if (ch === 'Ё' || ch === 'ё') {
        return page === 866 ? (ch === 'Ё' ? 0xf0 : 0xf1) : ch === 'Ё' ? 0xa8 : 0xb8;
      }
      assert.ok(code >= 0x410 && code <= 0x44f, `${ch} is a Russian letter`);
      const letter = code - 0x410;
      return page === 1251 ? 0xc0 + letter : letter < 48 ? 0x80 + letter : 0xe0 + letter - 48;
    }),
  );
}

// Memo files

/** A memo file of dBase III: blocks of 512 bytes, the first of them the header, every text up to two bytes 0x1A. */
function memoFile3(texts: Uint8Array[]): { file: Buffer; blocks: number[] } {
  const parts: Buffer[] = [Buffer.alloc(512)];
  const blocks: number[] = [];
  let next = 1;
  for (const text of texts) {
    const size = Math.ceil((text.length + 2) / 512) * 512;
    // What follows the end marker in a block is whatever was there before, and must not be shown.
    const block = Buffer.alloc(size, 0x4a);
    block.set(text);
    block.set([0x1a, 0x1a], text.length);
    parts.push(block);
    blocks.push(next);
    next += size / 512;
  }
  parts[0].writeUInt32LE(next, 0);
  return { file: Buffer.concat(parts), blocks };
}

/** A memo file of dBase IV: the block size at offset 20, and every memo behind FF FF 08 00 and its length, these eight bytes included. */
function memoFile4(blockSize: number, texts: Uint8Array[]): { file: Buffer; blocks: number[] } {
  const header = Buffer.alloc(blockSize);
  header.writeUInt16LE(blockSize, 20);
  const parts: Buffer[] = [header];
  const blocks: number[] = [];
  let next = 1;
  for (const text of texts) {
    const size = Math.ceil((text.length + 8) / blockSize) * blockSize;
    const block = Buffer.alloc(size, 0x4a);
    block.set([0xff, 0xff, 0x08, 0x00]);
    block.writeUInt32LE(text.length + 8, 4);
    block.set(text, 8);
    parts.push(block);
    blocks.push(next);
    next += size / blockSize;
  }
  header.writeUInt32LE(next, 0);
  return { file: Buffer.concat(parts), blocks };
}

/** A memo file of FoxPro (.fpt): numbers with the most significant byte first, a header of 512 bytes, and every memo behind its type (1 is text) and its length. */
function memoFileFox(blockSize: number, memos: { type: number; data: Uint8Array; declared?: number }[]): { file: Buffer; blocks: number[] } {
  const first = Math.ceil(512 / blockSize);
  const header = Buffer.alloc(first * blockSize);
  header.writeUInt16BE(blockSize, 6);
  const parts: Buffer[] = [header];
  const blocks: number[] = [];
  let next = first;
  for (const memo of memos) {
    const size = Math.ceil((memo.data.length + 8) / blockSize) * blockSize;
    const block = Buffer.alloc(size);
    block.writeUInt32BE(memo.type, 0);
    block.writeUInt32BE(memo.declared ?? memo.data.length, 4);
    block.set(memo.data, 8);
    parts.push(block);
    blocks.push(next);
    next += size / blockSize;
  }
  header.writeUInt32BE(next, 0);
  return { file: Buffer.concat(parts), blocks };
}

const rowsOf = (table: DbfTable): string[][] => flatRows(table);

// ---- A plain table ----------------------------------------------------------------------------

const PLAIN_FIELDS: FieldSpec[] = [
  { name: 'NAME', type: 'C', length: 20 },
  { name: 'CITY', type: 'C', length: 12 },
  { name: 'QTY', type: 'N', length: 6 },
  { name: 'PRICE', type: 'N', length: 10, decimals: 2 },
  { name: 'BORN', type: 'D', length: 8 },
  { name: 'OK', type: 'L', length: 1 },
];
const PLAIN_ROWS = [
  ['Иванов Иван', 'Москва', '5', '12.50', '1987-03-01', 'true'],
  ['Пётр "Первый"', 'Санкт-Пет.', '-3', '1000000.00', '2024-02-29', 'false'],
  ['Ёжик', 'Нигде', '1', '1.00', '2000-01-01', 'true'],
  ['', '', '', '', '', ''],
  ['Latin only', 'Koln', '0', '0.00', '1999-12-31', 'true'],
];
const PLAIN_RECORDS = PLAIN_ROWS.map((row) => [
  chars(cyrillic(row[0], 866), 20),
  chars(cyrillic(row[1], 866), 12),
  digits(row[2], 6),
  digits(row[3], 10),
  latin(row[4].replace(/-/g, '').padEnd(8)),
  latin(row[5] === 'true' ? 'T' : row[5] === 'false' ? 'F' : '?'),
]);
const PLAIN_HEADER = 32 + 32 * 6 + 1;
const PLAIN_RECORD = 58;
/** dBase III, CP866 named by the language driver 0x26. */
const plain = (spec: Partial<TableSpec> = {}): Buffer => dbase({ fields: PLAIN_FIELDS, records: PLAIN_RECORDS, driver: 0x26, ...spec });

test('a dBase III table: names, types, rows and what the header says', () => {
  const table = readDbf(plain());
  assert.deepEqual(table.names, ['NAME', 'CITY', 'QTY', 'PRICE', 'BORN', 'OK']);
  assert.deepEqual(table.types, ['C(20)', 'C(12)', 'N(6)', 'N(10,2)', 'D', 'L']);
  assert.deepEqual(Array.from(table.numeric), [0, 0, 1, 1, 0, 0]);
  assert.equal(table.details.length, 6);
  assert.ok(table.details.every((detail) => detail.length > 0));
  assert.deepEqual(rowsOf(table), PLAIN_ROWS);
  assert.deepEqual(table.info, {
    format: 'dBase III',
    records: 5,
    deleted: 0,
    encoding: 'cp866',
    encodingLabel: 'DOS Cyrillic (CP866)',
    encodingSource: 'header',
    updated: '2026-10-08',
    memo: 'none',
    warning: undefined,
  });
});

test('every row has every column, also an empty record', () => {
  const table = readDbf(plain());
  assert.deepEqual(Array.from(table.rowEnds), [6, 12, 18, 24, 30]);
});

test('the bytes may start anywhere in their buffer', () => {
  const whole = readDbf(plain());
  const bytes = plain();
  const shifted = new Uint8Array(bytes.length + 3).subarray(3);
  shifted.set(bytes);
  assert.deepEqual(rowsOf(readDbf(shifted)), rowsOf(whole));
});

// ---- Values -----------------------------------------------------------------------------------

/** One record of a table with these fields, and the row it is to give. */
function oneRow(fields: FieldSpec[], record: Uint8Array[], options: DbfOptions = {}, version = 0x03): string[] {
  const rows = rowsOf(readDbf(dbase({ version, fields, records: [record] }), options));
  assert.equal(rows.length, 1);
  return rows[0];
}

test('numbers are the digits that are stored, never a float of them', () => {
  const fields: FieldSpec[] = [
    { name: 'BIG', type: 'N', length: 20 },
    { name: 'NUM', type: 'N', length: 12, decimals: 2 },
    { name: 'FLT', type: 'F', length: 12, decimals: 4 },
  ];
  const row = (big: string, num: string, float: string) => oneRow(fields, [latin(big.padStart(20)), latin(num.padStart(12)), latin(float.padStart(12))]);
  assert.deepEqual(row('12345678901234567890', '123456789.12', '-0.0001'), ['12345678901234567890', '123456789.12', '-0.0001']);
  assert.deepEqual(row('-9223372036854775808', '0.10', '1.5000'), ['-9223372036854775808', '0.10', '1.5000']);
  assert.deepEqual(row('7', '-123456.78', '1.23457E+17'), ['7', '-123456.78', '1.23457E+17']);
  // At the left of the field, as some writers put them.
  assert.deepEqual(oneRow(fields, [latin('42'.padEnd(20)), latin('1.5'.padEnd(12)), latin('2'.padEnd(12))]), ['42', '1.5', '2']);
});

test('a number field without a number is empty', () => {
  const fields: FieldSpec[] = [
    { name: 'A', type: 'N', length: 8, decimals: 2 },
    { name: 'B', type: 'F', length: 8 },
  ];
  assert.deepEqual(oneRow(fields, [latin('        '), Buffer.alloc(8)]), ['', '']);
  // A lone point or minus is what is left of a number format without a number.
  assert.deepEqual(oneRow(fields, [latin('       .'), latin('       -')]), ['', '']);
  // Asterisks are what dBase writes when a number did not fit.
  assert.deepEqual(oneRow(fields, [latin('********'), latin('     ***')]), ['', '']);
});

test('dates are shown as ISO dates, and a date that is not set is empty', () => {
  const fields: FieldSpec[] = [{ name: 'DAY', type: 'D', length: 8 }];
  assert.deepEqual(oneRow(fields, [latin('19870301')]), ['1987-03-01']);
  assert.deepEqual(oneRow(fields, [latin('99991231')]), ['9999-12-31']);
  assert.deepEqual(oneRow(fields, [latin('        ')]), ['']);
  assert.deepEqual(oneRow(fields, [latin('00000000')]), ['']);
  assert.deepEqual(oneRow(fields, [Buffer.alloc(8)]), ['']);
});

test('logical values are true, false or nothing', () => {
  const fields: FieldSpec[] = [{ name: 'YES', type: 'L', length: 1 }];
  for (const letter of ['T', 't', 'Y', 'y']) {
    assert.deepEqual(oneRow(fields, [latin(letter)]), ['true'], letter);
  }
  for (const letter of ['F', 'f', 'N', 'n']) {
    assert.deepEqual(oneRow(fields, [latin(letter)]), ['false'], letter);
  }
  for (const letter of ['?', ' ', '\0']) {
    assert.deepEqual(oneRow(fields, [latin(letter)]), [''], JSON.stringify(letter));
  }
});

test('text loses the spaces and zero bytes that fill its field, and nothing else', () => {
  const fields: FieldSpec[] = [
    { name: 'A', type: 'C', length: 8 },
    { name: 'B', type: 'C', length: 8 },
    { name: 'C', type: 'C', length: 8 },
  ];
  assert.deepEqual(oneRow(fields, [latin('  lead  '), latin('abc\0\0\0\0\0'), latin('a  b\tc  ')]), ['  lead', 'abc', 'a  b\tc']);
  assert.deepEqual(oneRow(fields, [latin('12345678'), latin('        '), Buffer.alloc(8)]), ['12345678', '', '']);
});

test('a character field longer than 255 bytes', () => {
  const text = 'long text '.repeat(30).slice(0, 295);
  const fields: FieldSpec[] = [
    { name: 'LONG', type: 'C', length: 300 },
    { name: 'AFTER', type: 'N', length: 3 },
  ];
  const table = readDbf(dbase({ fields, records: [[chars(text, 300), latin(' 42')]] }));
  assert.deepEqual(table.types, ['C(300)', 'N(3)']);
  assert.deepEqual(rowsOf(table), [[text.trimEnd(), '42']]);
});

test('field names are kept as they are: twice the same, empty, of the full eleven bytes, in the code page', () => {
  const fields: FieldSpec[] = [
    { name: 'A', type: 'C', length: 2 },
    { name: 'A', type: 'C', length: 2 },
    { name: '', type: 'C', length: 2 },
    { name: 'ABCDEFGHIJK', type: 'C', length: 2 },
    { name: cyrillic('ЦЕНА', 866), type: 'N', length: 2 },
  ];
  const table = readDbf(dbase({ fields, records: [[latin('a1'), latin('a2'), latin('e '), latin('k '), latin('12')]], driver: 0x26 }));
  assert.deepEqual(table.names, ['A', 'A', '', 'ABCDEFGHIJK', 'ЦЕНА']);
  assert.deepEqual(rowsOf(table), [['a1', 'a2', 'e', 'k', '12']]);
});

test('a field of a type the reader does not know is shown as the text it holds', () => {
  const fields: FieldSpec[] = [
    { name: 'ODD', type: 'X', length: 5 },
    // The binary types have one size each; of another size they are something else.
    { name: 'TINY', type: 'I', length: 2 },
    { name: 'WIDE', type: 'D', length: 10 },
  ];
  const table = readDbf(dbase({ fields, records: [[latin('ab c '), latin('xy'), latin('2024-02-29')]] }));
  assert.deepEqual(table.types, ['X(5)', 'I(2)', 'D(10)']);
  assert.deepEqual(Array.from(table.numeric), [0, 0, 0]);
  assert.deepEqual(rowsOf(table), [['ab c', 'xy', '2024-02-29']]);
});

// ---- Memo files -------------------------------------------------------------------------------

const MEMO_FIELDS: FieldSpec[] = [
  { name: 'NAME', type: 'C', length: 6 },
  { name: 'NOTE', type: 'M', length: 10 },
];

test('memos of dBase III: text up to the end marker, over as many blocks as it takes', () => {
  const first = cyrillic('первый\r\nвторая строка', 866);
  const memo = memoFile3([first, latin('x'.repeat(600)), latin('last')]);
  const bytes = dbase({
    version: 0x83,
    driver: 0x26,
    fields: MEMO_FIELDS,
    records: [
      [chars('one', 6), pointer(memo.blocks[0])],
      [chars('two', 6), pointer(memo.blocks[1])],
      [chars('none', 6), pointer(0)],
      [chars('last', 6), pointer(memo.blocks[2])],
      [chars('zeros', 6), latin('0000000000')],
    ],
  });
  const table = readDbf(bytes, { memo: memo.file });
  assert.deepEqual(table.types, ['C(6)', 'M']);
  assert.deepEqual(rowsOf(table), [
    ['one', 'первый\r\nвторая строка'],
    ['two', 'x'.repeat(600)],
    ['none', ''],
    ['last', 'last'],
    ['zeros', ''],
  ]);
  assert.equal(table.info.memo, 'read');
  assert.equal(table.info.warning, undefined);

  // The last memo of a file that lost its end runs to the end of the file.
  const cut = memo.file.subarray(0, memo.blocks[2] * 512 + 3);
  assert.equal(rowsOf(readDbf(bytes, { memo: cut }))[3][1], 'las');
});

test('without the memo file, a memo is shown as a placeholder and none as nothing', () => {
  const bytes = dbase({
    version: 0x83,
    fields: MEMO_FIELDS,
    records: [
      [chars('one', 6), pointer(1)],
      [chars('none', 6), pointer(0)],
    ],
  });
  const table = readDbf(bytes);
  assert.deepEqual(rowsOf(table), [
    ['one', '(memo)'],
    ['none', ''],
  ]);
  assert.equal(table.info.memo, 'missing');
  assert.equal(table.info.warning, undefined);
});

test('a memo that points outside the memo file is empty, and the user is told', () => {
  const memo = memoFile3([latin('here')]);
  const bytes = dbase({
    version: 0x83,
    fields: MEMO_FIELDS,
    records: [
      [chars('one', 6), pointer(1)],
      [chars('far', 6), pointer(50)],
    ],
  });
  const table = readDbf(bytes, { memo: memo.file });
  assert.deepEqual(rowsOf(table), [
    ['one', 'here'],
    ['far', ''],
  ]);
  assert.match(table.info.warning ?? '', /One memo points outside the memo file/);
});

test('a file that cannot be a memo file is not used, and the user is told', () => {
  const bytes = dbase({ version: 0x83, fields: MEMO_FIELDS, records: [[chars('one', 6), pointer(1)]] });
  const table = readDbf(bytes, { memo: Uint8Array.from([1, 0, 0, 0]) });
  assert.deepEqual(rowsOf(table), [['one', '(memo)']]);
  assert.equal(table.info.memo, 'missing');
  assert.match(table.info.warning ?? '', /memo file next to the table is not one that belongs to it/);
});

test('memos of dBase IV: blocks of the size the memo file names, each memo with its length', () => {
  const long = Array.from({ length: 80 }, (_, i) => `Line ${i}: the quick brown fox.\r\n`).join('');
  const memo = memoFile4(1024, [latin('first memo'), latin(long), latin('')]);
  // A memo in the older way, without the length, inside the same file.
  const old = Buffer.alloc(1024, 0x4a);
  old.set(latin('old way\x1a\x1a'));
  const file = Buffer.concat([memo.file, old]);
  const fields: FieldSpec[] = [...MEMO_FIELDS, { name: 'DATA', type: 'B', length: 10 }, { name: 'OLE', type: 'G', length: 10 }, { name: 'QTY', type: 'N', length: 3 }];
  const bytes = dbase({
    version: 0x8b,
    fields,
    records: [
      [chars('one', 6), pointer(memo.blocks[0]), pointer(0), pointer(0), digits('1', 3)],
      [chars('two', 6), pointer(memo.blocks[1]), pointer(memo.blocks[0]), pointer(0), digits('2', 3)],
      [chars('three', 6), pointer(memo.blocks[2]), pointer(0), pointer(memo.blocks[0]), digits('3', 3)],
      [chars('four', 6), pointer(memo.file.length / 1024), pointer(0), pointer(0), digits('4', 3)],
    ],
  });
  const table = readDbf(bytes, { memo: file });
  assert.deepEqual(table.types, ['C(6)', 'M', 'B', 'G', 'N(3)']);
  assert.deepEqual(Array.from(table.numeric), [0, 0, 0, 0, 1]);
  assert.deepEqual(rowsOf(table), [
    ['one', 'first memo', '', '', '1'],
    ['two', long, '(binary)', '', '2'],
    ['three', '', '', '(binary)', '3'],
    ['four', 'old way', '', '', '4'],
  ]);
  assert.deepEqual([table.info.format, table.info.memo, table.info.warning], ['dBase IV', 'read', undefined]);
});

test('memos of FoxPro: an .fpt file, where a memo that is not text is named as binary', () => {
  const memo = memoFileFox(33, [
    { type: 1, data: cyrillic('мемо FoxPro', 866) },
    { type: 2, data: latin('\x00\x01object') },
  ]);
  const bytes = dbase({
    version: 0xf5,
    driver: 0x26,
    fields: MEMO_FIELDS,
    records: [
      [chars('one', 6), pointer(memo.blocks[0])],
      [chars('obj', 6), pointer(memo.blocks[1])],
      [chars('none', 6), pointer(0)],
    ],
  });
  const table = readDbf(bytes, { memo: memo.file });
  assert.deepEqual(rowsOf(table), [
    ['one', 'мемо FoxPro'],
    ['obj', '(binary)'],
    ['none', ''],
  ]);
  assert.deepEqual([table.info.format, table.info.memo, table.info.warning], ['FoxPro', 'read', undefined]);

  // A block size of zero is what no memo file has.
  const zero = readDbf(bytes, { memo: Buffer.alloc(512) });
  assert.equal(zero.info.memo, 'missing');
  assert.deepEqual(rowsOf(zero)[0], ['one', '(memo)']);
});

test('a memo longer than 1 MB is shown in part, and the user is told', () => {
  const memo = memoFileFox(64, [{ type: 1, data: Buffer.alloc(1024 * 1024 + 10, 0x61) }]);
  const bytes = dbase({ version: 0xf5, fields: MEMO_FIELDS, records: [[chars('one', 6), pointer(memo.blocks[0])]] });
  const table = readDbf(bytes, { memo: memo.file });
  const cell = rowsOf(table)[0][1];
  assert.equal(cell.length, 1024 * 1024 + 1);
  assert.ok(cell.endsWith('a…'));
  assert.match(table.info.warning ?? '', /One memo is longer than 1 MB/);
});

// ---- Visual FoxPro ----------------------------------------------------------------------------

/** A varchar value: one that is shorter than its field keeps its length in the last byte, and a bit in `_NullFlags` says so. */
function varchar(text: string, length: number): { bytes: Buffer; short: number } {
  const raw = latin(text);
  if (raw.length === length) {
    return { bytes: raw, short: 0 };
  }
  return { bytes: Buffer.concat([raw, Buffer.alloc(length - 1 - raw.length, 0x20), Buffer.from([raw.length])]), short: 1 };
}

const FOX_FIELDS: FieldSpec[] = [
  { name: 'ID', type: 'I', length: 4 },
  { name: 'AMOUNT', type: 'Y', length: 8, decimals: 4 },
  { name: 'WHEN', type: 'T', length: 8 },
  { name: 'RATIO', type: 'B', length: 8, decimals: 2 },
  { name: 'VNAME', type: 'V', length: 20 },
  { name: 'VNULL', type: 'V', length: 10, flags: 2 },
  { name: 'CNULL', type: 'C', length: 6, flags: 2 },
  { name: 'BIN', type: 'Q', length: 8, flags: 4 },
  { name: 'PIC', type: 'G', length: 4 },
  { name: 'NOTE', type: 'M', length: 4 },
  { name: '_NullFlags', type: '0', length: 1, flags: 5 },
];

interface FoxRow {
  id: number;
  amount: bigint;
  when: Buffer;
  ratio: number;
  vname: string;
  vnull: string | null;
  cnull: string | null;
  bin: Uint8Array;
  pic: number;
  note: number;
}

/**
 * The bits of `_NullFlags` go to the fields in their order: one to every varchar and varbinary field
 * (the value is shorter than the field), and one to every field that may be null (it is null).
 * Here: VNAME short 0, VNULL short 1, VNULL null 2, CNULL null 3, BIN short 4.
 */
function foxRecord(row: FoxRow): Buffer[] {
  let bits = 0;
  const vname = varchar(row.vname, 20);
  bits |= vname.short << 0;
  const vnull = varchar(row.vnull ?? '', 10);
  bits |= row.vnull === null ? 1 << 2 : vnull.short << 1;
  bits |= row.cnull === null ? 1 << 3 : 0;
  const bin = row.bin.length === 8 ? Buffer.from(row.bin) : Buffer.concat([row.bin, Buffer.alloc(7 - row.bin.length), Buffer.from([row.bin.length])]);
  bits |= row.bin.length === 8 ? 0 : 1 << 4;
  return [
    int32(row.id),
    int64(row.amount),
    row.when,
    float64(row.ratio),
    vname.bytes,
    row.vnull === null ? Buffer.alloc(10, 0x20) : vnull.bytes,
    chars(row.cnull ?? '', 6),
    bin,
    uint32(row.pic),
    uint32(row.note),
    Buffer.from([bits]),
  ];
}

const FOX_MEMO = memoFileFox(64, [
  // In Windows-1252: an accented letter and curly quotes.
  { type: 1, data: latin('Memo text \xe9\r\nline 2 \x93quoted\x94') },
  { type: 0, data: latin('\x89PNG\r\n\x1a\n') },
  { type: 1, data: latin('long '.repeat(200)) },
]);
const FOX_ROWS: FoxRow[] = [
  // 43,199,999 ms is what Visual FoxPro makes of 12:00:00, one millisecond short.
  { id: 1, amount: 123456n, when: stamp(JULIAN['2024-02-29'], 43_199_999), ratio: 1.5, vname: 'short', vnull: 'abcdefghij', cnull: 'hello', bin: Uint8Array.from([1, 2, 3]), pic: FOX_MEMO.blocks[1], note: FOX_MEMO.blocks[0] },
  // One millisecond before midnight is the midnight of the next day.
  { id: -2147483648, amount: -9223372036854775808n, when: stamp(JULIAN['2023-02-24'], 86_399_999), ratio: -0, vname: '', vnull: null, cnull: null, bin: new Uint8Array(0), pic: 0, note: FOX_MEMO.blocks[1] },
  { id: 2147483647, amount: 1n, when: Buffer.alloc(8), ratio: 1e21, vname: 'x'.repeat(20), vnull: 'x', cnull: '', bin: latin('12345678'), pic: 0, note: 9999 },
  { id: 7, amount: 7n, when: stamp(JULIAN['2000-01-01'], 0), ratio: 7, vname: 'deleted', vnull: 'deleted', cnull: 'del', bin: new Uint8Array(0), pic: 0, note: 0 },
  { id: 0, amount: 0n, when: Buffer.alloc(8, 0x20), ratio: 123456789.125, vname: 'Zo\xeb \xe9', vnull: '', cnull: 'a  b', bin: Uint8Array.from([0xff]), pic: 0, note: 0 },
  { id: 5, amount: 9223372036854775807n, when: stamp(JULIAN['0001-01-01'], 1000), ratio: 0.1, vname: 'full', vnull: 'y'.repeat(10), cnull: 'zzzzzz', bin: new Uint8Array(0), pic: 0, note: 0 },
  { id: 6, amount: -1n, when: stamp(JULIAN['9999-12-31'], 86_399_000), ratio: -1e-7, vname: 'last', vnull: 'row', cnull: 'ok', bin: new Uint8Array(0), pic: 0, note: FOX_MEMO.blocks[2] },
];
/** Visual FoxPro with Windows-1252 named by the language driver, and its fourth record deleted. */
const foxTable = (): Buffer => dbase({ version: 0x30, driver: 0x03, fields: FOX_FIELDS, records: FOX_ROWS.map(foxRecord), deleted: [3] });

// One of its memos holds typographic quotes in Windows-1252.
test('Visual FoxPro: integers, exact currency, date and time, doubles, varchar and nulls', () => {
  const table = readDbf(foxTable(), { memo: FOX_MEMO.file });
  // `_NullFlags` is not a column.
  assert.deepEqual(table.names, ['ID', 'AMOUNT', 'WHEN', 'RATIO', 'VNAME', 'VNULL', 'CNULL', 'BIN', 'PIC', 'NOTE']);
  assert.deepEqual(table.types, ['I', 'Y', 'T', 'B', 'V(20)', 'V(10)', 'C(6)', 'Q(8)', 'G', 'M']);
  assert.deepEqual(Array.from(table.numeric), [1, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rowsOf(table), [
    ['1', '12.3456', '2024-02-29 12:00:00', '1.5', 'short', 'abcdefghij', 'hello', '(binary)', '(binary)', 'Memo text é\r\nline 2 “quoted”'],
    ['-2147483648', '-922337203685477.5808', '2023-02-25 00:00:00', '0', '', '', '', '', '', '(binary)'],
    ['2147483647', '0.0001', '', '1e+21', 'x'.repeat(20), 'x', '', '(binary)', '', ''],
    ['0', '0.0000', '', '123456789.125', 'Zoë é', '', 'a  b', '(binary)', '', ''],
    ['5', '922337203685477.5807', '0001-01-01 00:00:01', '0.1', 'full', 'y'.repeat(10), 'zzzzzz', '', '', ''],
    ['6', '-0.0001', '9999-12-31 23:59:59', '-1e-7', 'last', 'row', 'ok', '', '', 'long '.repeat(200)],
  ]);
  assert.deepEqual(
    { ...table.info, warning: undefined },
    { format: 'Visual FoxPro', records: 6, deleted: 1, encoding: 'windows-1252', encodingLabel: 'Western European (Windows-1252)', encodingSource: 'header', updated: '2026-10-08', memo: 'read', warning: undefined },
  );
  // The memo of the third record is block 9999.
  assert.match(table.info.warning ?? '', /One memo points outside the memo file/);
});

test('Visual FoxPro: a memo whose length says more than the file holds is shown as far as it goes', () => {
  const memo = memoFileFox(64, [{ type: 1, data: latin('cut off memo, the length says more'), declared: 5000 }]);
  const file = memo.file.subarray(0, memo.blocks[0] * 64 + 8 + 20);
  const fields: FieldSpec[] = [{ name: 'NOTE', type: 'M', length: 4 }];
  const table = readDbf(dbase({ version: 0x30, fields, records: [[uint32(memo.blocks[0])]] }), { memo: file });
  assert.deepEqual(rowsOf(table), [['cut off memo, the le']]);
  assert.match(table.info.warning ?? '', /One memo points outside the memo file/);
});

// ---- dBase 7 ----------------------------------------------------------------------------------

/** An integer of dBase 7: most significant byte first and the sign bit turned over, so that the bytes sort like the numbers. */
function sortableInt(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE((value + 0x80000000) >>> 0);
  return bytes;
}

/** A double of dBase 7: most significant byte first, the sign bit of a positive number turned over, and every bit of a negative one. */
function sortableDouble(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  if (bytes[0] & 0x80) {
    return Buffer.from(bytes.map((byte) => byte ^ 0xff));
  }
  bytes[0] ^= 0x80;
  return bytes;
}

/** A timestamp of dBase 7: milliseconds as such a double, where day 1 is January 1 of the year 1. */
const sortableStamp = (julian: number, seconds: number): Buffer => sortableDouble((julian - JULIAN['0001-01-01'] + 1) * 86_400_000 + seconds * 1000);

const SEVEN_FIELDS: FieldSpec[] = [
  { name: 'ID', type: '+', length: 4 },
  { name: 'Long name of a field', type: 'I', length: 4 },
  { name: 'VAL', type: 'O', length: 8 },
  { name: 'TS', type: '@', length: 8 },
  { name: 'NAME', type: 'C', length: 12 },
  { name: 'QTY', type: 'N', length: 8, decimals: 2 },
  { name: 'BORN', type: 'D', length: 8 },
  { name: 'OK', type: 'L', length: 1 },
];
const SEVEN_RECORDS = [
  // Clown ░▒▓ é in CP437.
  [sortableInt(1), sortableInt(-5), sortableDouble(1.5), sortableStamp(JULIAN['2024-02-29'], 12 * 3600 + 34 * 60 + 56), chars('Clown \xb0\xb1\xb2 \x82', 12), digits('100.25', 8), latin('20240229'), latin('T')],
  [sortableInt(2), sortableInt(0), sortableDouble(-1.5), sortableStamp(JULIAN['0001-01-01'], 0), chars('second', 12), digits('-0.50', 8), latin('        '), latin('F')],
  // Zero bytes are the empty value of the binary types.
  [sortableInt(3), Buffer.alloc(4), Buffer.alloc(8), Buffer.alloc(8), chars('', 12), digits('', 8), latin('19991231'), latin('?')],
  [sortableInt(4), sortableInt(2147483647), sortableDouble(-1e300), sortableStamp(JULIAN['2000-01-01'], 1), chars('deleted', 12), digits('1', 8), latin('20000101'), latin('T')],
  [sortableInt(2147483647), sortableInt(-2147483647), sortableDouble(5e-324), sortableStamp(JULIAN['9999-12-31'], 86399), chars('last', 12), digits('2', 8), latin('20000101'), latin('y')],
];
const sevenTable = (): Buffer => dbase7({ driverName: 'DB437US0', fields: SEVEN_FIELDS, records: SEVEN_RECORDS, deleted: [3] });

test('dBase 7: the longer header and descriptors, and binary values that sort as bytes', () => {
  const table = readDbf(sevenTable());
  assert.deepEqual(table.names, ['ID', 'Long name of a field', 'VAL', 'TS', 'NAME', 'QTY', 'BORN', 'OK']);
  assert.deepEqual(table.types, ['+', 'I', 'O', '@', 'C(12)', 'N(8,2)', 'D', 'L']);
  assert.deepEqual(Array.from(table.numeric), [1, 1, 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(rowsOf(table), [
    ['1', '-5', '1.5', '2024-02-29 12:34:56', 'Clown ░▒▓ é', '100.25', '2024-02-29', 'true'],
    ['2', '0', '-1.5', '0001-01-01 00:00:00', 'second', '-0.50', '', 'false'],
    ['3', '', '', '', '', '', '1999-12-31', ''],
    ['2147483647', '-2147483647', '5e-324', '9999-12-31 23:59:59', 'last', '2', '2000-01-01', 'true'],
  ]);
  // The name of the driver carries the number of its code page.
  assert.deepEqual(
    [table.info.format, table.info.records, table.info.deleted, table.info.encoding, table.info.encodingSource, table.info.memo, table.info.warning],
    ['dBase 7', 4, 1, 'cp437', 'header', 'none', undefined],
  );
});

// ---- Records: deleted, counted wrongly, cut off -----------------------------------------------

test('deleted records are left out and counted', () => {
  const table = readDbf(plain({ deleted: [0, 3] }));
  assert.deepEqual(rowsOf(table), [PLAIN_ROWS[1], PLAIN_ROWS[2], PLAIN_ROWS[4]]);
  assert.deepEqual([table.info.records, table.info.deleted, table.info.warning], [3, 2, undefined]);

  const none = readDbf(plain({ deleted: [0, 1, 2, 3, 4] }));
  assert.deepEqual([rowsOf(none), none.info.records, none.info.deleted], [[], 0, 5]);
  assert.deepEqual(none.names, ['NAME', 'CITY', 'QTY', 'PRICE', 'BORN', 'OK']);
});

test('a table without records, with and without its end marker', () => {
  for (const end of [true, false]) {
    const table = readDbf(plain({ records: [], end }));
    assert.deepEqual([table.names.length, rowsOf(table), table.info.records, table.info.warning], [6, [], 0, undefined]);
  }
});

test('the records are what the file holds, whatever count the header gives', () => {
  for (const count of [0, 2, 5]) {
    const table = readDbf(plain({ count }));
    assert.deepEqual(rowsOf(table), PLAIN_ROWS, `count ${count}`);
    assert.deepEqual([table.info.records, table.info.warning], [5, undefined], `count ${count}`);
  }
});

test('a header that announces more records than there are: the table is shown, with a warning', () => {
  const table = readDbf(plain({ count: 100 }));
  assert.deepEqual(rowsOf(table), PLAIN_ROWS);
  assert.equal(table.info.records, 5);
  assert.match(table.info.warning ?? '', /announces 100 records, and 5 of them are there/);
});

test('the end marker ends the table, whatever follows it', () => {
  const rand = random(7);
  const tail = Buffer.from(Array.from({ length: 1000 }, () => rand.pick([0x20, 0x20, 0x2a, 0x61, 0x00, 0x1a, 0xff, 0x30])));
  assert.deepEqual(rowsOf(readDbf(plain({ tail }))), PLAIN_ROWS);
  // The count of the header says nothing here, so only the marker can end the table,
  assert.deepEqual(rowsOf(readDbf(plain({ tail, count: 0 }))), PLAIN_ROWS);
  // and here it promises records that the bytes behind the marker are not.
  const promised = readDbf(plain({ tail, count: 20 }));
  assert.deepEqual(rowsOf(promised), PLAIN_ROWS);
  assert.match(promised.info.warning ?? '', /announces 20 records, and 5 of them are there/);
});

test('a file without an end marker', () => {
  assert.deepEqual(rowsOf(readDbf(plain({ end: false }))), PLAIN_ROWS);
  // Zero bytes behind the records are not records, although whole ones would fit.
  const padded = readDbf(plain({ end: false, tail: Buffer.alloc(700) }));
  assert.deepEqual([rowsOf(padded), padded.info.warning], [PLAIN_ROWS, undefined]);
});

test('a file cut off inside a record shows the records before it, with a warning', () => {
  const table = readDbf(plain().subarray(0, PLAIN_HEADER + 3 * PLAIN_RECORD + 17));
  assert.deepEqual(rowsOf(table), PLAIN_ROWS.slice(0, 3));
  assert.equal(table.info.records, 3);
  assert.match(table.info.warning ?? '', /cut off: its header announces 5 records, and 3 of them are there/);

  const one = readDbf(plain().subarray(0, PLAIN_HEADER + PLAIN_RECORD));
  assert.deepEqual(rowsOf(one), PLAIN_ROWS.slice(0, 1));
  assert.match(one.info.warning ?? '', /and 1 of them is there/);
});

test('a file cut off right behind its header is a table without rows', () => {
  const table = readDbf(plain().subarray(0, PLAIN_HEADER));
  assert.deepEqual([table.names.length, rowsOf(table)], [6, []]);
  assert.match(table.info.warning ?? '', /cut off/);
});

// ---- Refusals ---------------------------------------------------------------------------------

const REFUSALS = {
  empty: 'The file is empty.',
  headerCut: 'The file ends inside its header, before all the fields are described.',
  notDbase: 'This is not a dBase table, or its header is damaged.',
  dbase2: 'This is a dBase II table, which Previewix does not read.',
};

test('what cannot be read is refused in words', () => {
  assert.throws(() => readDbf(new Uint8Array(0)), { message: REFUSALS.empty });
  assert.throws(() => readDbf(plain().subarray(0, 20)), { message: REFUSALS.headerCut });
  assert.throws(() => readDbf(plain().subarray(0, 32 + 32 * 3 + 5)), { message: REFUSALS.headerCut });
  assert.throws(() => readDbf(Buffer.from('1,2\r\n'.repeat(100))), { message: REFUSALS.notDbase });
  assert.throws(() => readDbf(Buffer.alloc(600)), { message: REFUSALS.notDbase });
});

test('a dBase II table is refused', () => {
  // The version byte 2 says it; the header of 521 bytes behind it has a layout of its own.
  const bytes = Buffer.alloc(521 + 20, 0x20);
  bytes[0] = 0x02;
  assert.throws(() => readDbf(bytes), { message: REFUSALS.dbase2 });
  assert.throws(() => readDbf(Uint8Array.from([0x02])), { message: REFUSALS.dbase2 });
});

// ---- Code pages -------------------------------------------------------------------------------

const TEXT_FIELDS: FieldSpec[] = [
  { name: 'TEXT', type: 'C', length: 40 },
  { name: 'N', type: 'N', length: 4 },
];
/** A table of one text field, holding these bytes. */
const textTable = (texts: Uint8Array[], driver = 0): Buffer => dbase({ fields: TEXT_FIELDS, driver, records: texts.map((text, i) => [chars(text, 40), digits(String(i), 4)]) });
/** What was read: the code page, where it came from, and the texts. */
function textsOf(bytes: Uint8Array, options: DbfOptions = {}): [string, string, string[]] {
  const table = readDbf(bytes, options);
  return [table.info.encoding, table.info.encodingSource, rowsOf(table).map((row) => row[0])];
}

const RUSSIAN = ['Иванов Иван Иванович', 'Съешь ещё этих булок', 'ЗАГЛАВНЫЕ БУКВЫ', 'mixed латиница'];
// "Güell ¢¥ ░ é" as CP437 reads these bytes; CP850 has ø and Ø where CP437 has the cent and the yen.
const DOS_BYTES = latin('G\x81ell \x9b\x9d \xb0 \x82');
const DOS_437 = 'Güell ¢¥ ░ é';
const DOS_850 = 'Güell øØ ░ é';

test('the language driver of the header names the code page', () => {
  assert.deepEqual(textsOf(textTable(RUSSIAN.map((text) => cyrillic(text, 866)), 0x26)), ['cp866', 'header', RUSSIAN]);
  assert.deepEqual(textsOf(textTable(RUSSIAN.map((text) => cyrillic(text, 866)), 0x65)), ['cp866', 'header', RUSSIAN]);
  assert.deepEqual(textsOf(textTable(RUSSIAN.map((text) => cyrillic(text, 1251)), 0xc9)), ['windows-1251', 'header', RUSSIAN]);
  assert.deepEqual(textsOf(textTable([DOS_BYTES], 0x01)), ['cp437', 'header', [DOS_437]]);
  assert.deepEqual(textsOf(textTable([DOS_BYTES], 0x02)), ['cp850', 'header', [DOS_850]]);
  assert.deepEqual(textsOf(textTable([latin('Zo\xeb')], 0x03)), ['windows-1252', 'header', ['Zoë']]);
});

test('Windows-1252 is more than Latin-1: the euro sign and the curly quotes', () => {
  assert.deepEqual(textsOf(textTable([latin('\x80 5 \x93q\x94 Zo\xeb')], 0x03)), ['windows-1252', 'header', ['€ 5 “q” Zoë']]);
});

test('the .cpg file wins over the language driver', () => {
  const bytes = textTable(RUSSIAN.map((text) => cyrillic(text, 1251)), 0x26);
  assert.deepEqual(textsOf(bytes, { cpg: '1251' }), ['windows-1251', 'cpg', RUSSIAN]);
  assert.equal(textsOf(bytes)[0], 'cp866');
});

test('the choice of the user wins over the .cpg file and the language driver', () => {
  const bytes = textTable([DOS_BYTES], 0x26);
  const table = readDbf(bytes, { cpg: '1251', encoding: 'cp437' });
  assert.deepEqual([table.info.encoding, table.info.encodingLabel, table.info.encodingSource, rowsOf(table)[0][0]], ['cp437', 'DOS US (CP437)', 'chosen', DOS_437]);
  assert.deepEqual(textsOf(bytes, { cpg: '1251', encoding: 'cp850' }), ['cp850', 'chosen', [DOS_850]]);
});

test('a choice that is not in the list is no choice', () => {
  const bytes = textTable(RUSSIAN.map((text) => cyrillic(text, 1251)), 0x26);
  for (const encoding of ['', 'klingon', 'CP866', 'utf8']) {
    assert.deepEqual(textsOf(bytes, { cpg: '1251', encoding }), ['windows-1251', 'cpg', RUSSIAN], JSON.stringify(encoding));
  }
});

test('the ways a .cpg file names a code page', () => {
  const bytes = textTable([latin('abc')]);
  const names: [string, string][] = [
    ['UTF-8\r\n', 'utf-8'],
    ['utf8', 'utf-8'],
    ['﻿1251\n', 'windows-1251'],
    ['CP1251', 'windows-1251'],
    [' ansi 1251 ', 'windows-1251'],
    ['Windows-1250', 'windows-1250'],
    ['OEM 866', 'cp866'],
    ['IBM437', 'cp437'],
    ['850', 'cp850'],
    // The number of a language driver, here 0x65.
    ['LDID/101', 'cp866'],
    // As Esri writes ISO 8859-1, which is read as the Windows page that extends it.
    ['88591', 'windows-1252'],
    ['ISO-8859-2', 'iso-8859-2'],
    ['SJIS', 'shift_jis'],
    ['BIG5', 'big5'],
  ];
  for (const [cpg, encoding] of names) {
    const table = readDbf(bytes, { cpg });
    assert.deepEqual([table.info.encoding, table.info.encodingSource, table.info.warning], [encoding, 'cpg', undefined], JSON.stringify(cpg));
  }
});

test('a code page the reader does not know: the next source is asked, and a guess is said to be one', () => {
  const russian = RUSSIAN.map((text) => cyrillic(text, 866));
  // An unknown name in the .cpg file, a known language driver.
  const driver = readDbf(textTable(russian, 0x26), { cpg: 'KLINGON-1' });
  assert.deepEqual([driver.info.encoding, driver.info.encodingSource, driver.info.warning], ['cp866', 'header', undefined]);
  // Neither is known: Mazovia is a language driver without a table here.
  const neither = readDbf(textTable(russian, 0x69), { cpg: 'KLINGON-1' });
  assert.deepEqual([neither.info.encoding, neither.info.encodingSource], ['cp866', 'guess']);
  assert.match(neither.info.warning ?? '', /"KLINGON-1" in the \.cpg file/);
  const kamenicky = readDbf(textTable([latin('caf\xe9')], 0x68));
  assert.deepEqual([kamenicky.info.encoding, kamenicky.info.encodingSource], ['windows-1252', 'guess']);
  assert.match(kamenicky.info.warning ?? '', /language driver 0x68 \(Kamenický\)/);
});

test('without any of these the code page is guessed from the text', () => {
  assert.deepEqual(textsOf(textTable(RUSSIAN.map((text) => cyrillic(text, 866)))), ['cp866', 'guess', RUSSIAN]);
  assert.deepEqual(textsOf(textTable(RUSSIAN.map((text) => cyrillic(text, 1251)))), ['windows-1251', 'guess', RUSSIAN]);
  // Lower case alone: in CP866 the letters а-п and р-я lie apart, in Windows-1251 they are one run.
  assert.deepEqual(textsOf(textTable([cyrillic('мама мыла раму', 866), cyrillic('папа', 866)])), ['cp866', 'guess', ['мама мыла раму', 'папа']]);
  assert.deepEqual(textsOf(textTable([cyrillic('мама', 1251), cyrillic('рама', 1251)])), ['windows-1251', 'guess', ['мама', 'рама']]);

  const unicode = ['Иванов Иван', 'Zoë Müller €', '日本語のテキスト', 'emoji 😀 done', 'plain ascii'];
  assert.deepEqual(textsOf(textTable(unicode.map((text) => Buffer.from(text, 'utf8')))), ['utf-8', 'guess', unicode]);

  // Accented letters between ASCII letters are Western text.
  assert.deepEqual(textsOf(textTable([latin('Zo\xeb M\xfcller, Stra\xdfe 5'), latin('caf\xe9 d\xe9j\xe0 vu'), latin('plain')])), ['windows-1252', 'guess', ['Zoë Müller, Straße 5', 'café déjà vu', 'plain']]);
  // The byte 0x81 is ü in the DOS pages and nothing in Windows-1252, so this is text from DOS.
  assert.deepEqual(textsOf(textTable([DOS_BYTES])), ['cp850', 'guess', [DOS_850]]);
  assert.deepEqual(textsOf(textTable([latin('plain'), latin('ascii only')])), ['windows-1252', 'guess', ['plain', 'ascii only']]);
});

test('a page with characters of several bytes: Shift JIS by its language driver', () => {
  // 日本語 in Shift JIS, then the half-width katakana ｶﾅ, which are one byte each.
  const bytes = textTable([Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x20, 0xb6, 0xc5]), latin('ascii \\ yen')], 0x7b);
  assert.deepEqual(textsOf(bytes), ['shift_jis', 'header', ['日本語 ｶﾅ', 'ascii \\ yen']]);
  assert.deepEqual(rowsOf(readDbf(bytes)).map((row) => row[1]), ['0', '1']);
});

test('UTF-8 text that fills its field up to the middle of a character loses the half character', () => {
  const fields: FieldSpec[] = [
    { name: 'TEXT', type: 'C', length: 10 },
    { name: 'N', type: 'N', length: 2 },
  ];
  const cut = (text: string) => Buffer.from(text, 'utf8').subarray(0, 10);
  const records = [
    [cut('ааааа'), digits('0', 2)],
    [cut('aааааа'), digits('1', 2)],
    [cut('ab日本語'), digits('2', 2)],
    [cut('x😀😀😀'), digits('3', 2)],
    [chars(Buffer.from('ok €', 'utf8'), 10), digits('4', 2)],
  ];
  const expected = ['ааааа', 'aаааа', 'ab日本', 'x😀😀', 'ok €'];
  assert.deepEqual(textsOf(dbase({ fields, records }), { cpg: 'utf8' }), ['utf-8', 'cpg', expected]);
  assert.deepEqual(textsOf(dbase({ fields, records })), ['utf-8', 'guess', expected]);
});

test('the DOS and Mac pages that TextDecoder does not have are read from tables of the reader', () => {
  // A few letters of each, at the places that the code page charts give them (and Python's codecs: bytes([0x80]).decode('cp437')).
  const pages: [id: string, bytes: number[], text: string][] = [
    ['cp437', [0x80, 0x9b, 0x9d, 0xe1, 0xb0, 0xfe], 'Ç¢¥ß░■'],
    ['cp850', [0x80, 0x9b, 0x9d, 0xb5, 0xe1, 0xfe], 'ÇøØÁß■'],
    ['cp852', [0x88, 0x9d, 0xa5, 0xfe], 'łŁą■'],
    ['cp855', [0x80, 0x81, 0xef], 'ђЂ№'],
    ['cp857', [0x8d, 0x98, 0x9e, 0x9f, 0xa6, 0xa7], 'ıİŞşĞğ'],
    ['cp860', [0x84, 0x86, 0xe1], 'ãÁß'],
    ['cp861', [0x8b, 0x8c, 0x8d, 0xe1], 'ÐðÞß'],
    ['cp862', [0x80, 0x9a, 0xe1], 'אתß'],
    ['cp863', [0x84, 0x86, 0xe1], 'Â¶ß'],
    ['cp865', [0x9b, 0x9d, 0xaf, 0xe1], 'øØ¤ß'],
    ['cp737', [0x80, 0x98, 0xea], 'ΑαΆ'],
    ['cp775', [0x80, 0x9b, 0x9d, 0xe1], 'ĆøØß'],
    ['mac-latin2', [0x80, 0x81, 0x84, 0x88, 0x89], 'ÄĀĄąČ'],
    ['mac-greek', [0x80, 0xa1, 0xa2, 0xa3], 'ÄΓΔΘ'],
  ];
  for (const [id, bytes, text] of pages) {
    // Between ASCII letters, which every page has at the same places.
    assert.deepEqual(textsOf(textTable([Buffer.from([0x61, ...bytes, 0x7a])]), { encoding: id }), [id, 'chosen', [`a${text}z`]], id);
  }
});

/** Node.js 22 has no decoder for ISO 8859-16; later versions have one, and so has the runtime of a current VS Code. */
const decodes = (label: string): boolean => {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
};

test('every code page of the list can be chosen', () => {
  assert.equal(new Set(DBF_ENCODINGS.map((item) => item.id)).size, DBF_ENCODINGS.length);
  // 14 pages are tables of the reader; the others are there when the runtime has them, which only ISO 8859-16 may fail.
  const ids = DBF_ENCODINGS.map((item) => item.id);
  assert.equal(ids.length, decodes('iso-8859-16') ? 47 : 46);
  assert.equal(ids.includes('iso-8859-16'), decodes('iso-8859-16'));
  assert.deepEqual(ids.slice(0, 4), ['utf-8', 'windows-1252', 'cp437', 'cp850']);
  const bytes = textTable([latin('abc \xe9\xff\x80')]);
  const failed: string[] = [];
  for (const { id, label } of DBF_ENCODINGS) {
    try {
      const table = readDbf(bytes, { encoding: id });
      assert.deepEqual([table.info.encoding, table.info.encodingLabel, table.info.encodingSource], [id, label, 'chosen'], id);
      assert.ok(rowsOf(table)[0][0].startsWith('abc '), id);
    } catch (e) {
      failed.push(`${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  assert.deepEqual(failed, []);
});

test('a page the runtime cannot decode is asked for in vain, by any of its names, and the file is still read', () => {
  // "ţară şi Ță" in ISO 8859-16, which has the Romanian letters with a comma below.
  const bytes = textTable([Buffer.from([0xfe, 0x61, 0x72, 0xe3, 0x20, 0xba, 0x69, 0x20, 0xde, 0xe3])]);
  const have = decodes('iso-8859-16');
  for (const cpg of ['ISO-8859-16', 'iso8859_16', '885916', '28606', 'CP28606']) {
    const table = readDbf(bytes, { cpg });
    if (have) {
      assert.deepEqual([table.info.encoding, table.info.encodingSource, rowsOf(table)[0][0], table.info.warning], ['iso-8859-16', 'cpg', 'țară și Ță', undefined], cpg);
    } else {
      // Read by the guess, and the note says which name was of no use.
      assert.deepEqual([table.info.encoding, table.info.encodingSource], ['windows-1252', 'guess'], cpg);
      assert.match(table.info.warning ?? '', new RegExp(`"${cpg}" in the \\.cpg file`), cpg);
    }
  }
  // A choice kept from a session on another runtime is no choice here.
  const chosen = readDbf(bytes, { encoding: 'iso-8859-16' });
  assert.deepEqual([chosen.info.encoding, chosen.info.encodingSource], have ? ['iso-8859-16', 'chosen'] : ['windows-1252', 'guess']);
  // A language driver and a .cpg file of pages that every runtime has are found as before.
  assert.deepEqual(textsOf(textTable([latin('abc')], 0x26)).slice(0, 2), ['cp866', 'header']);
  assert.deepEqual(textsOf(textTable([latin('abc')]), { cpg: 'LATIN2' }).slice(0, 2), ['iso-8859-2', 'cpg']);
});

// ---- Limits -----------------------------------------------------------------------------------

/** A table of number fields of one digit, put together in one buffer: these tables are megabytes. The records are spaces. */
function digitTable(columns: number, count: number): Buffer {
  const headerLength = 32 + 32 * columns + 1;
  const recordLength = 1 + columns;
  const bytes = Buffer.alloc(headerLength + count * recordLength + 1, 0x20);
  bytes.fill(0, 0, headerLength);
  bytes[0] = 0x03;
  bytes.writeUInt32LE(count, 4);
  bytes.writeUInt16LE(headerLength, 8);
  bytes.writeUInt16LE(recordLength, 10);
  for (let c = 0; c < columns; c++) {
    bytes.write(`F${c}`, 32 + 32 * c, 'latin1');
    bytes[32 + 32 * c + 11] = 0x4e;
    bytes[32 + 32 * c + 16] = 1;
  }
  bytes[headerLength - 1] = 0x0d;
  bytes[bytes.length - 1] = 0x1a;
  return bytes;
}

test('a table of more rows than the viewer shows is cut, and the user is told', () => {
  // One record more than the limit besides three deleted ones, of one digit each: two megabytes.
  const count = MAX_ROWS + 4;
  const bytes = digitTable(1, count);
  for (let r = 0; r < count; r++) {
    bytes[65 + r * 2 + 1] = 0x30 + (r % 10);
  }
  // Records past the limit are still counted, the deleted one among them too.
  for (const r of [0, 5, count - 1]) {
    bytes[65 + r * 2] = 0x2a;
  }

  const table = readDbf(bytes);
  assert.equal(table.rowEnds.length, MAX_ROWS);
  assert.equal(table.ends.length, MAX_ROWS);
  assert.deepEqual([table.info.records, table.info.deleted], [MAX_ROWS + 1, 3]);
  assert.equal(table.info.warning, 'Only the first 1,000,000 of 1,000,001 records are shown.');
  assert.equal(table.text.slice(0, 12), '123467890123');
  // The last row shown is record 1,000,001 of the file, counted from 0.
  assert.equal(table.text.length, MAX_ROWS);
  assert.equal(table.text.at(-1), '1');
});

test('a table of more cells than the viewer shows is cut at the last row that fits', () => {
  // 250 columns leave room for 40,000 rows; the table has one more.
  const rows = MAX_CELLS / 250;
  const table = readDbf(digitTable(250, rows + 1));
  assert.equal(table.rowEnds.length, rows);
  assert.equal(table.ends.length, MAX_CELLS);
  assert.equal(table.info.records, rows + 1);
  assert.equal(table.info.warning, 'Only the first 40,000 of 40,001 records are shown.');
});

// ---- Damage -----------------------------------------------------------------------------------

/** Reads, and lets nothing pass but a table that holds together or one of the reader's own refusals. */
function attempt(bytes: Uint8Array, options: DbfOptions, what: string): DbfTable | undefined {
  let table: DbfTable;
  try {
    table = readDbf(bytes, options);
  } catch (e) {
    assert.ok(e instanceof Error && Object.values(REFUSALS).includes(e.message), `${what}: ${e instanceof Error ? e.message : `threw ${typeof e}`}`);
    return undefined;
  }
  const cells = table.ends.length;
  assert.equal(table.rowEnds.length ? table.rowEnds[table.rowEnds.length - 1] : 0, cells, what);
  assert.equal(cells ? table.ends[cells - 1] : 0, table.text.length, what);
  assert.deepEqual([table.types.length, table.details.length, table.numeric.length], [table.names.length, table.names.length, table.names.length], what);
  return table;
}

const SWEPT: [string, () => Buffer, DbfOptions][] = [
  ['dBase III', plain, {}],
  ['Visual FoxPro', foxTable, { memo: FOX_MEMO.file }],
  ['dBase 7', sevenTable, {}],
];

test('a file cut at any length is refused in words or shows the first rows of the whole file', () => {
  for (const [name, make, options] of SWEPT) {
    const bytes = make();
    const whole = rowsOf(readDbf(bytes, options));
    for (let length = 0; length < bytes.length; length++) {
      const table = attempt(bytes.subarray(0, length), options, `${name} cut at ${length}`);
      if (table) {
        assert.deepEqual(rowsOf(table), whole.slice(0, table.rowEnds.length), `${name} cut at ${length}`);
      }
    }
  }
});

test('a memo file cut at any length never breaks the reading of the table', () => {
  const bytes = foxTable();
  const rand = random(3);
  for (let length = 0; length < FOX_MEMO.file.length; length += 1 + rand.int(7)) {
    const table = attempt(bytes, { memo: FOX_MEMO.file.subarray(0, length) }, `memo cut at ${length}`);
    assert.equal(table?.rowEnds.length, 6, `memo cut at ${length}`);
  }
});

test('damaged bytes are refused in words or read as some table', () => {
  const rand = random(12345);
  for (const [name, make, options] of SWEPT) {
    const bytes = make();
    const headerLength = bytes.readUInt16LE(8);
    for (let n = 0; n < 400; n++) {
      const damaged = Buffer.from(bytes);
      // One to four bytes, half of them in the header, where every byte means something.
      for (let k = 1 + rand.int(4); k > 0; k--) {
        damaged[rand.int(2) ? rand.int(headerLength) : rand.int(damaged.length)] = rand.int(4) ? rand.int(256) : rand.pick([0, 0xff, 0x0d, 0x1a, 0x20, 0x2a]);
      }
      attempt(damaged, options, `${name}, damage ${n}`);
      if (options.memo && n % 4 === 0) {
        const memo = Buffer.from(options.memo);
        for (let k = 1 + rand.int(8); k > 0; k--) {
          memo[rand.int(memo.length)] = rand.int(256);
        }
        attempt(bytes, { memo }, `${name}, memo damage ${n}`);
      }
    }
  }
});

test('what is no table at all is refused in words or read as some table', () => {
  const rand = random(99);
  const kinds: [string, () => Uint8Array][] = [
    ['random bytes', () => rand.bytes(1 + rand.int(2000))],
    ['zero bytes', () => new Uint8Array(rand.int(2000))],
    ['spaces', () => new Uint8Array(rand.int(2000)).fill(0x20)],
    ['text', () => Buffer.from(Array.from({ length: rand.int(60) }, (_, i) => `${i},"name ${i}",${i * 1.5}\r\n`).join(''))],
  ];
  for (const [name, make] of kinds) {
    for (let n = 0; n < 150; n++) {
      attempt(make(), {}, `${name} ${n}`);
    }
  }
});
