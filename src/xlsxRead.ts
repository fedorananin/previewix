/**
 * Reading of spreadsheet files (xlsx, xlsm, xlsb, xls, ods, numbers) with SheetJS into flat tables of
 * display-ready text. No vscode import, so it can be exercised outside VS Code.
 *
 * Bundled as a file of its own, this module is also a worker thread entry: started with
 * `workerData.previewixSheets`, it reads the workbook passed along and posts the result.
 */
import { isMainThread, parentPort, workerData } from 'worker_threads';
import * as XLSX from 'xlsx';
import { FlatBuilder, type FlatTable } from './csv';

export interface Sheet {
  name: string;
  /** 0 for a visible sheet, 1 for a hidden one, 2 for one that only a macro can unhide. */
  hidden: number;
  /** Number of rows up to the last one that has a value. */
  rows: number;
  /** Width of the widest row. */
  cols: number;
  /** The cells as Excel displays them, starting at A1. Rows end at their last value. */
  table: FlatTable;
  /** The number behind every cell of `table` (a date is its serial number), NaN where the cell isn't numeric. */
  nums: Float64Array;
  /** Merged ranges as [first row, first column, last row, last column], four numbers each. */
  merges: Uint32Array;
}

/** Past this many, the merged ranges of a sheet are left out and its cells are shown unmerged. */
const MAX_MERGES = 50_000;

export function readWorkbook(bytes: Uint8Array): Sheet[] {
  // `dense` keeps a sheet as arrays of rows, which takes a fraction of the memory of the default object of addresses.
  const workbook = XLSX.read(bytes, { type: 'array', dense: true, cellHTML: false });
  const info = workbook.Workbook?.Sheets ?? [];
  const text = workbook.bookType === 'numbers' ? numbersText : cellText;
  return workbook.SheetNames.map((name, index) => {
    const sheet = readSheet(workbook.Sheets[name], text);
    // Drops the parsed cells of this sheet before the next one is converted.
    delete workbook.Sheets[name];
    return { name, hidden: info[index]?.Hidden ?? 0, ...sheet };
  });
}

function readSheet(sheet: XLSX.WorkSheet | undefined, cellText: (cell: XLSX.CellObject | undefined) => string): Omit<Sheet, 'name' | 'hidden'> {
  const data: (XLSX.CellObject | undefined)[][] = sheet?.['!data'] ?? [];
  const builder = new FlatBuilder();
  let nums = new Float64Array(1024);
  let cells = 0;
  let rows = 0;
  let cols = 0;
  let emptyRows = 0;
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    let last = (row?.length ?? 0) - 1;
    while (last >= 0 && cellText(row[last]) === '') {
      last--;
    }
    if (last < 0) {
      emptyRows++;
      continue;
    }
    // Empty rows are written only once a row with a value follows, which drops the ones at the end.
    for (; emptyRows; emptyRows--) {
      builder.endRow();
    }
    if (cells + last + 1 > nums.length) {
      const bigger = new Float64Array(Math.max(nums.length * 2, cells + last + 1));
      bigger.set(nums);
      nums = bigger;
    }
    for (let c = 0; c <= last; c++) {
      const cell = row[c];
      builder.cell(cellText(cell));
      nums[cells++] = cell?.t === 'n' && typeof cell.v === 'number' ? cell.v : cell?.t === 'd' && cell.v instanceof Date ? cell.v.getTime() : NaN;
    }
    builder.endRow();
    rows = r + 1;
    cols = Math.max(cols, last + 1);
  }

  const ranges = sheet?.['!merges'] ?? [];
  const merges = new Uint32Array(ranges.length <= MAX_MERGES ? ranges.length * 4 : 0);
  if (merges.length) {
    ranges.forEach((range, i) => merges.set([range.s.r, range.s.c, range.e.r, range.e.c], i * 4));
  }
  return { rows, cols, table: builder.finish(), nums: nums.slice(0, cells), merges };
}

/** The text Excel shows in the cell: the value in its number format. */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.t === 'z') {
    return '';
  }
  if (cell.w !== undefined) {
    return cell.w;
  }
  if (cell.v === undefined || cell.v === null) {
    // A formula that was never calculated, as some generators write them.
    return cell.f ? `=${cell.f}` : '';
  }
  return XLSX.utils.format_cell(cell);
}

/**
 * The same for a Numbers file. SheetJS reads its values but not its number formats: a date arrives
 * as a count of days from 1904 without the format to show it in, and a number as it is stored.
 * Formatted as in Excel, the first would be a date four years off and the second would lose digits.
 */
function numbersText(cell: XLSX.CellObject | undefined): string {
  if (cell?.t !== 'n' || typeof cell.v !== 'number' || cell.w !== undefined) {
    return cellText(cell);
  }
  if (cell.z === undefined) {
    return String(Number(cell.v.toPrecision(15)));
  }
  const date = new Date(Date.UTC(1904, 0, 1) + Math.round(cell.v * 86_400_000));
  if (Number.isNaN(date.getTime())) {
    return String(cell.v);
  }
  const [day, time] = date.toISOString().replace(/(\.000)?Z$/, '').split('T');
  return time === '00:00:00' ? day : `${day} ${time}`;
}

if (!isMainThread && workerData?.previewixSheets) {
  try {
    const sheets = readWorkbook(workerData.previewixSheets as Uint8Array);
    parentPort?.postMessage(
      { sheets },
      sheets.flatMap((sheet) => [sheet.table.ends.buffer, sheet.table.rowEnds.buffer, sheet.nums.buffer, sheet.merges.buffer] as ArrayBuffer[]),
    );
  } catch (e) {
    parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
}
