import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { flatRows } from '../src/csv';
import { readWorkbook, type Sheet } from '../src/xlsxRead';

// The workbooks are written here with SheetJS, which is also what reads them. So these tests hold
// what the reader makes of a workbook (texts, numbers, rows, merges), not SheetJS's reading of files
// that Excel wrote.

type Cells = Record<string, XLSX.CellObject>;

/** A sheet of the cells at these addresses. */
function sheetOf(cells: Cells, merges?: string[]): XLSX.WorkSheet {
  const range = { s: { r: Infinity, c: Infinity }, e: { r: 0, c: 0 } };
  for (const address of Object.keys(cells)) {
    const { r, c } = XLSX.utils.decode_cell(address);
    range.s = { r: Math.min(range.s.r, r), c: Math.min(range.s.c, c) };
    range.e = { r: Math.max(range.e.r, r), c: Math.max(range.e.c, c) };
  }
  const sheet: XLSX.WorkSheet = { ...cells };
  if (Object.keys(cells).length) {
    sheet['!ref'] = XLSX.utils.encode_range(range);
  }
  if (merges) {
    sheet['!merges'] = merges.map((merge) => XLSX.utils.decode_range(merge));
  }
  return sheet;
}

/** A workbook of these sheets, in this order. `hidden`: 1 for a hidden sheet, 2 for one that only a macro can unhide. */
function bookOf(sheets: Record<string, XLSX.WorkSheet>, hidden: number[] = []): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  for (const [name, sheet] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  if (hidden.length) {
    book.Workbook = { Sheets: hidden.map((Hidden) => ({ Hidden: Hidden as 0 | 1 | 2 })) };
  }
  return book;
}

function write(book: XLSX.WorkBook, bookType: XLSX.BookType = 'xlsx', options: XLSX.WritingOptions = {}): Uint8Array {
  return XLSX.write(book, { ...options, type: 'buffer', bookType }) as Buffer;
}

const text = (value: string): XLSX.CellObject => ({ t: 's', v: value });
const number = (value: number, format?: string): XLSX.CellObject => (format ? { t: 'n', v: value, z: format } : { t: 'n', v: value });

/** The numbers behind the cells, with null where a cell has none. */
const numsOf = (sheet: Sheet): (number | null)[] => Array.from(sheet.nums, (value) => (Number.isNaN(value) ? null : value));

/** The serial number Excel keeps for a date: days since December 30 of 1899. */
const serial = (year: number, month: number, day: number): number => (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;

// ---- Cells ------------------------------------------------------------------------------------

/** Texts, numbers in number formats, dates, and one merged range. */
function dataSheet(): XLSX.WorkSheet {
  return sheetOf(
    {
      A1: text('Item'),
      B1: text('Share'),
      C1: text('Price'),
      D1: text('When'),
      E1: text('Code'),
      A2: text('apple'),
      B2: number(0.25, '0%'),
      C2: number(1234.5, '#,##0.00'),
      D2: number(serial(2024, 2, 29), 'yyyy-mm-dd'),
      E2: text('007'),
      A3: text('pear'),
      B3: number(0.125, '0.0%'),
      C3: number(-3.75, '#,##0.00'),
      D3: number(serial(2024, 2, 29) + 0.5, 'yyyy-mm-dd hh:mm'),
      E3: number(12),
      A4: text('merged across'),
    },
    ['A4:C4'],
  );
}
const DATA_ROWS = [['Item', 'Share', 'Price', 'When', 'Code'], ['apple', '25%', '1,234.50', '2024-02-29', '007'], ['pear', '12.5%', '-3.75', '2024-02-29 12:00', '12'], ['merged across']];
const DATA_NUMS = [null, null, null, null, null, null, 0.25, 1234.5, 45351, null, null, 0.125, -3.75, 45351.5, 12, null];

test('a cell is the text Excel shows, and the number behind it is kept beside it', () => {
  const [sheet] = readWorkbook(write(bookOf({ Data: dataSheet() })));
  assert.deepEqual(flatRows(sheet.table), DATA_ROWS);
  // A date is its serial number, and a text that looks like a number has none.
  assert.deepEqual(numsOf(sheet), DATA_NUMS);
  assert.equal(serial(2024, 2, 29), 45351);
  assert.deepEqual([sheet.name, sheet.hidden, sheet.rows, sheet.cols], ['Data', 0, 4, 5]);
});

test('booleans, errors and formulas', () => {
  const cells: Cells = {
    A1: { t: 'b', v: true },
    B1: { t: 'b', v: false },
    C1: { t: 'e', v: 0x07 },
    A2: { t: 'n', v: 3, f: 'SUM(1,2)' },
    B2: { t: 's', v: 'ab', f: 'CONCAT("a","b")' },
    // A formula that was never calculated, as some generators write them.
    C2: { t: 'n', f: 'A2+1' } as XLSX.CellObject,
  };
  const [sheet] = readWorkbook(write(bookOf({ Sheet: sheetOf(cells) })));
  assert.deepEqual(flatRows(sheet.table), [
    ['TRUE', 'FALSE', '#DIV/0!'],
    ['3', 'ab', '=A2+1'],
  ]);
  assert.deepEqual(numsOf(sheet), [null, null, null, 3, null, null]);
});

test('merged ranges are given as first row, first column, last row, last column', () => {
  const sheet = sheetOf({ A1: text('wide'), A3: text('tall'), C3: text('block') }, ['A1:D1', 'A3:A5', 'C3:E6']);
  const [read] = readWorkbook(write(bookOf({ Sheet: sheet })));
  assert.deepEqual(Array.from(read.merges), [0, 0, 0, 3, 2, 0, 4, 0, 2, 2, 5, 4]);
  // The cells under a merged range hold nothing, so the rows still end at their last value.
  assert.deepEqual(flatRows(read.table), [['wide'], [], ['tall', '', 'block']]);
});

test('past 50,000 merged ranges they are left out, and the cells are still read', () => {
  const sheet = sheetOf({ A1: text('x') });
  sheet['!merges'] = Array.from({ length: 50_001 }, (_, i) => ({ s: { r: i * 2 + 1, c: 0 }, e: { r: i * 2 + 1, c: 1 } }));
  const [read] = readWorkbook(write(bookOf({ Sheet: sheet })));
  assert.equal(read.merges.length, 0);
  assert.deepEqual(flatRows(read.table), [['x']]);
});

// ---- Sheets -----------------------------------------------------------------------------------

test('every sheet is read, in the order of the workbook, with its name and whether it is hidden', () => {
  const book = bookOf(
    {
      First: sheetOf({ A1: number(1), B1: number(2), A2: number(3) }),
      'Второй лист': sheetOf({ A1: text('текст') }),
      Hidden: sheetOf({ A1: text('secret') }),
      'Very hidden': sheetOf({ B2: text('deep') }),
    },
    [0, 0, 1, 2],
  );
  const sheets = readWorkbook(write(book));
  assert.deepEqual(
    sheets.map((sheet) => [sheet.name, sheet.hidden, sheet.rows, sheet.cols, flatRows(sheet.table)]),
    [
      ['First', 0, 2, 2, [['1', '2'], ['3']]],
      ['Второй лист', 0, 1, 1, [['текст']]],
      ['Hidden', 1, 1, 1, [['secret']]],
      ['Very hidden', 2, 2, 2, [[], ['', 'deep']]],
    ],
  );
  assert.deepEqual(numsOf(sheets[0]), [1, 2, 3]);
});

test('a sheet without cells is a table without rows', () => {
  const sheets = readWorkbook(write(bookOf({ Empty: sheetOf({}), Full: sheetOf({ A1: text('x') }) })));
  const [empty, full] = sheets;
  assert.deepEqual([empty.name, empty.rows, empty.cols, empty.table.text, empty.table.ends.length, empty.table.rowEnds.length, empty.nums.length, empty.merges.length], ['Empty', 0, 0, '', 0, 0, 0, 0]);
  assert.deepEqual(flatRows(full.table), [['x']]);
});

// ---- Rows -------------------------------------------------------------------------------------

test('a row ends at its last value, empty rows in between are kept, and empty rows at the end are dropped', () => {
  const cells: Cells = {
    A1: text('a'),
    B1: text('b'),
    C1: text('c'),
    A2: number(1),
    // Cells that hold an empty text are as good as none: behind the value of a row, and far below the table.
    C2: text(''),
    B4: number(2),
    A6: text(''),
    Z500: text(''),
  };
  const [sheet] = readWorkbook(write(bookOf({ Sheet: sheetOf(cells) })));
  assert.deepEqual(flatRows(sheet.table), [['a', 'b', 'c'], ['1'], [], ['', '2']]);
  assert.deepEqual([sheet.rows, sheet.cols], [4, 3]);
  assert.deepEqual(numsOf(sheet), [null, null, null, 1, null, 2]);
});

test('one stray value far out makes long rows of nothing, not a huge table', () => {
  const [sheet] = readWorkbook(write(bookOf({ Sheet: sheetOf({ A1: text('a'), B1: text('b'), A2: number(1), B2: number(2), AD1000: text('stray') }) })));
  assert.deepEqual([sheet.rows, sheet.cols], [1000, 30]);
  assert.equal(sheet.table.rowEnds.length, 1000);
  // Two rows of two cells, 997 rows without any, and the row of the stray value, which is its thirtieth cell.
  assert.equal(sheet.table.ends.length, 2 + 2 + 30);
  assert.equal(sheet.nums.length, 34);
  const rows = flatRows(sheet.table);
  assert.deepEqual(rows.slice(0, 3), [['a', 'b'], ['1', '2'], []]);
  assert.deepEqual(rows[999], [...Array.from({ length: 29 }, () => ''), 'stray']);
});

test('a sheet of more cells than the first size of the number index', () => {
  // 1,800 cells; the index starts at 1,024.
  const cells: Cells = {};
  for (let r = 0; r < 60; r++) {
    for (let c = 0; c < 30; c++) {
      cells[XLSX.utils.encode_cell({ r, c })] = c % 3 ? number(r * 100 + c) : text(`t${r}`);
    }
  }
  const [sheet] = readWorkbook(write(bookOf({ Sheet: sheetOf(cells) })));
  assert.equal(sheet.nums.length, 1800);
  assert.deepEqual(
    numsOf(sheet),
    Array.from({ length: 1800 }, (_, i) => (i % 30 % 3 ? Math.floor(i / 30) * 100 + (i % 30) : null)),
  );
  assert.deepEqual(flatRows(sheet.table)[59].slice(0, 3), ['t59', '5901', '5902']);
});

// ---- Other formats ----------------------------------------------------------------------------

test('the older Excel format (.xls) gives the same table', () => {
  const sheets = readWorkbook(write(bookOf({ Data: dataSheet(), Second: sheetOf({ A1: number(1) }), Hidden: sheetOf({ A1: text('secret') }) }, [0, 0, 1]), 'biff8'));
  assert.deepEqual(
    sheets.map((sheet) => [sheet.name, sheet.hidden]),
    [
      ['Data', 0],
      ['Second', 0],
      ['Hidden', 1],
    ],
  );
  assert.deepEqual(flatRows(sheets[0].table), DATA_ROWS);
  assert.deepEqual(numsOf(sheets[0]), DATA_NUMS);
  assert.deepEqual(Array.from(sheets[0].merges), [3, 0, 3, 2]);
});

test('the binary Excel format (.xlsb) gives the same table', () => {
  const [sheet] = readWorkbook(write(bookOf({ Data: dataSheet() }), 'xlsb'));
  assert.deepEqual(flatRows(sheet.table), DATA_ROWS);
  assert.deepEqual(numsOf(sheet), DATA_NUMS);
  assert.deepEqual(Array.from(sheet.merges), [3, 0, 3, 2]);
});

test('an OpenDocument spreadsheet (.ods): texts, numbers, sheets and merged ranges', () => {
  const first = sheetOf({ A1: text('Item'), B1: text('Count'), A2: text('apple'), B2: number(1234.5), A3: text('Zoë 日本語'), B3: number(-3), C3: { t: 'b', v: true }, A5: text('merged across') }, ['A5:C5']);
  const sheets = readWorkbook(write(bookOf({ Data: first, Second: sheetOf({ A1: number(1), B1: number(2), A2: number(3) }) }), 'ods'));
  assert.deepEqual(
    sheets.map((sheet) => [sheet.name, sheet.rows, sheet.cols]),
    [
      ['Data', 5, 3],
      ['Second', 2, 2],
    ],
  );
  assert.deepEqual(flatRows(sheets[0].table), [['Item', 'Count'], ['apple', '1234.5'], ['Zoë 日本語', '-3', 'TRUE'], [], ['merged across']]);
  assert.deepEqual(numsOf(sheets[0]), [null, null, null, 1234.5, null, -3, null, null]);
  assert.deepEqual(Array.from(sheets[0].merges), [4, 0, 4, 2]);
  assert.deepEqual(flatRows(sheets[1].table), [['1', '2'], ['3']]);
});

// ---- Numbers ----------------------------------------------------------------------------------

test('a Numbers file: dates as ISO dates, numbers with their own digits', () => {
  // SheetJS writes a Numbers file into a template that ships with it; there is no smaller way to get one.
  const template: string = require('xlsx/dist/xlsx.zahl');
  const date = (...parts: [number, number, number, number?, number?, number?]): XLSX.CellObject => {
    const [year, month, day, hours = 0, minutes = 0, seconds = 0] = parts;
    return { t: 'd', v: new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds)) };
  };
  const first = sheetOf({
    A1: text('Day'),
    B1: text('Amount'),
    C1: text('Code'),
    D1: text('Paid'),
    A2: date(2024, 2, 29),
    B2: number(2021.5),
    C2: text('007'),
    D2: { t: 'b', v: true },
    A3: date(2020, 5, 1, 13, 45, 10),
    B3: number(1234567.891),
    C3: text('x'),
    D3: { t: 'b', v: false },
    // Before the day that Excel counts from, and before the one that Numbers does.
    A4: date(1899, 12, 31),
    // The nearest double is 0.30000000000000004, which is not what was typed.
    B4: number(0.1 + 0.2),
  });
  const bytes = write(bookOf({ Statement: first, Second: sheetOf({ A1: number(1), B1: number(2), A2: number(3) }) }), 'numbers', { numbers: template });
  const sheets = readWorkbook(bytes);
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ['Statement', 'Second'],
  );
  assert.deepEqual(flatRows(sheets[0].table), [
    ['Day', 'Amount', 'Code', 'Paid'],
    ['2024-02-29', '2021.5', '007', 'TRUE'],
    ['2020-05-01 13:45:10', '1234567.891', 'x', 'FALSE'],
    ['1899-12-31', '0.3'],
  ]);
  assert.deepEqual(numsOf(sheets[0]).filter((_, i) => i % 4 === 1), [null, 2021.5, 1234567.891, 0.1 + 0.2]);
  assert.deepEqual(flatRows(sheets[1].table), [['1', '2'], ['3']]);
});

// ---- Damage -----------------------------------------------------------------------------------

test('a damaged workbook is an error, not a table', () => {
  const bytes = write(bookOf({ Data: dataSheet() }));
  assert.throws(() => readWorkbook(bytes.subarray(0, bytes.length >> 1)), Error);
  assert.throws(() => readWorkbook(bytes.subarray(0, bytes.length - 30)), Error);
  // The start of a ZIP archive and nothing of what it announces.
  assert.throws(() => readWorkbook(Uint8Array.from([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9, 9, 9])), Error);
  const flipped = Buffer.from(bytes);
  for (let i = 40; i < flipped.length; i += 97) {
    flipped[i] ^= 0xff;
  }
  assert.throws(() => readWorkbook(flipped), Error);
});
