import assert from 'node:assert/strict';
import { fork } from 'child_process';
import * as fs from 'fs';
import { test as nodeTest } from 'node:test';
import * as path from 'path';
import * as zlib from 'zlib';
import { flatRows } from '../src/csv';
import { lz4Block, lz4Hadoop, MAX_ROWS, readParquet, snappy, type ParquetTable } from '../src/parquetRead';
import { fixture, needs, python, random, run, scratch } from './helpers';

// The fixtures in test/fixtures/parquet/ are written by make.py there (pyarrow 25.0.1 and lz4 4.4.5):
//
//   python3 test/fixtures/parquet/make.py test/fixtures/parquet
//
// The expected texts of types.parquet are what pyarrow reads back from it, which make.py prints. The
// other files hold rows that follow a formula, which `expectedRows()` repeats here.

// ---- The process that reads damaged files -----------------------------------------------------

// A reader that never returns can only be stopped from outside, and one that runs out of memory takes
// its process along. So the damaged files are read in a process of their own, which is this bundle
// again: started with PREVIEWIX_READS_DAMAGED, it reads the files it is sent, answers for each (see
// `elsewhere()`), and declares no tests.
const answering = process.env.PREVIEWIX_READS_DAMAGED === '1';
const test = (answering ? () => undefined : nodeTest) as typeof nodeTest;

if (answering) {
  let stray = '';
  process.on('unhandledRejection', (e) => {
    stray = e instanceof Error ? e.message : String(e);
  });
  process.once('message', (files: Uint8Array[]) => {
    void (async () => {
      for (const bytes of files) {
        let answer: string;
        try {
          answer = (await readParquet({ bytes: new Uint8Array(bytes) })).warning ? 'table, with a warning' : 'table';
        } catch (e) {
          answer = e instanceof Error ? e.message : `threw ${typeof e}`;
        }
        // A promise that failed with nobody waiting for it is reported once the event loop turns.
        await new Promise((resolve) => setImmediate(resolve));
        process.send?.(stray ? `a promise was left to fail on its own (${stray})` : answer);
        stray = '';
      }
    })();
  });
}

/**
 * Reads files in another process and gives the answer to each: 'table', 'table, with a warning', the
 * message of the error, or what went wrong with the reading itself. The list ends with the first
 * answer that is not `answered()`. That process gets little memory, so that a reader that runs away
 * is stopped early, and what it prints is dropped.
 */
function elsewhere(files: Uint8Array[], patience = 1500): Promise<string[]> {
  return new Promise((resolve) => {
    const answers: string[] = [];
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const child = fork(__filename, [], {
      env: { ...env, PREVIEWIX_READS_DAMAGED: '1' },
      execArgv: ['--max-old-space-size=256'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let timer: NodeJS.Timeout | undefined;
    let ended = false;
    const end = (last?: string) => {
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(timer);
      if (last) {
        answers.push(last);
      }
      child.kill('SIGKILL');
      resolve(answers);
    };
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => end(`no answer within ${patience} ms`), patience);
    };
    child.on('message', (answer: string) => {
      answers.push(answer);
      if (answers.length === files.length || !answered(answer)) {
        end();
      } else {
        wait();
      }
    });
    child.on('error', (e) => end(`the reader could not be started (${e.message})`));
    child.on('exit', (code, signal) => end(`the reader died (${signal ?? `exit code ${code}`})`));
    child.send(files);
    wait();
  });
}

// ---- Helpers ----------------------------------------------------------------------------------

const file = (name: string): string => fixture(`parquet/${name}.parquet`);
const bytesOf = (name: string): Buffer => fs.readFileSync(file(name));
/** The same bytes as an array of their own, which is what the provider hands to the reader (and see the test of a Buffer below). */
const plain = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);
const dir = answering ? '' : scratch();
const pyarrow = answering ? undefined : python('pyarrow');
/** Zstandard is in the zlib of Node.js 22.15 and later. */
const zstd = typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function';

/** The rows of a table, which end at their last value. */
const rowsOf = (table: ParquetTable): string[][] => flatRows({ text: new TextDecoder().decode(table.text), ends: table.ends, rowEnds: table.rowEnds });

/** A row as the reader gives it: without the empty cells at its end. */
function ended(row: string[]): string[] {
  let last = row.length;
  while (last > 0 && row[last - 1] === '') {
    last--;
  }
  return row.slice(0, last);
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'Ωmega'];
/** The rows that `rows()` of make.py writes: id, word, ratio, note, tags. */
function expectedRows(count: number, columns = 5): string[][] {
  return Array.from({ length: count }, (_, i) =>
    ended([String(i), `${WORDS[i % 5]}-${i}`, String(i / 8), i % 3 ? `note ${i}` : '', i % 4 ? JSON.stringify([WORDS[i % 5], WORDS[(i + 1) % 5]]) : '[]'].slice(0, columns)),
  );
}

/** The sentences of the reader's own refusals. Anything else it lets out is wrapped in `DAMAGED`. */
const REFUSALS = {
  empty: 'the file is empty.',
  notParquet: 'this is not a Parquet file.',
  encrypted: 'the file is encrypted.',
  cut: 'the file is cut off: its end, where Parquet keeps the description of the data, is missing.',
  lzo: 'the file is compressed with LZO, which Previewix does not read.',
  zstd: 'the file is compressed with Zstandard, which needs VS Code 1.101 or later.',
  ended: 'the file ended before the data it describes.',
};
const DAMAGED = /^the file is damaged, or written in a way Previewix does not read \(.+\)\.$/s;

/** An answer that a damaged file may get: a table, a refusal in the reader's own words, or the sentence for damage. */
function answered(answer: string): boolean {
  return answer === 'table' || answer === 'table, with a warning' || Object.values(REFUSALS).includes(answer) || DAMAGED.test(answer);
}

async function refusal(source: Parameters<typeof readParquet>[0]): Promise<string> {
  try {
    await readParquet(source);
  } catch (e) {
    assert.ok(e instanceof Error);
    return e.message;
  }
  return 'a table';
}

// ---- Types ------------------------------------------------------------------------------------

const HEX_OF_64 = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, '0')).join('');

/** types.parquet: name, type in the header, type written out, whether the cells are numbers, and the six cells. */
const TYPES: [name: string, type: string, detail: string, numeric: 0 | 1, cells: string[]][] = [
  ['bool', 'boolean', 'boolean', 0, ['true', 'false', '', 'true', 'false', 'true']],
  ['int8', 'int8', 'int8', 1, ['-128', '127', '', '0', '1', '-1']],
  ['int16', 'int16', 'int16', 1, ['-32768', '32767', '', '0', '1', '-1']],
  ['int32', 'int32', 'int32', 1, ['-2147483648', '2147483647', '', '0', '1', '-1']],
  // 9007199254740993 is 2^53 + 1, which no double holds.
  ['int64', 'int64', 'int64', 1, ['-9223372036854775808', '9223372036854775807', '', '9007199254740993', '1', '-1']],
  ['uint8', 'uint8', 'uint8', 1, ['0', '255', '', '1', '2', '3']],
  ['uint16', 'uint16', 'uint16', 1, ['0', '65535', '', '1', '2', '3']],
  ['uint32', 'uint32', 'uint32', 1, ['0', '4294967295', '', '1', '2', '3']],
  ['uint64', 'uint64', 'uint64', 1, ['0', '18446744073709551615', '', '1', '2', '3']],
  // The shortest digits that give the same 32-bit float; as a double the first is 0.10000000149011612.
  ['float32', 'float', 'float', 1, ['0.1', '-1.5', '', '3.4028235e+38', '1e-10', '16777216']],
  ['float64', 'double', 'double', 1, ['0.1', '-1.5', '', '1.7976931348623157e+308', '5e-324', '123456789.12345679']],
  ['float_special', 'double', 'double', 1, ['NaN', 'Infinity', '-Infinity', '0', '0', '']],
  // Decimals keep every digit and their scale; none of them goes through a float.
  ['dec_10_2', 'decimal(10, 2)', 'decimal(10, 2)', 1, ['1.10', '-0.57', '', '99999999.99', '0.00', '-12345.60']],
  ['dec_38_10', 'decimal(38, 10)', 'decimal(38, 10)', 1, ['1234567890123456789012345678.0123456789', '-0.0000000001', '', '0.0000000000', '1.0000000000', '-99999999999999999999.5000000000']],
  ['dec_9_0', 'decimal(9, 0)', 'decimal(9, 0)', 1, ['123456789', '-1', '', '0', '7', '42']],
  ['string', 'string', 'string', 0, ['plain', '', '', 'Юникод 日本語 🎉', 'line1\nline2', ' spaces  ']],
  ['large_string', 'string', 'string', 0, ['a', 'b', '', 'c|d', '"quoted"', 'x,y']],
  // Binary without an annotation: text when the bytes are text, hex when they are not,
  ['binary_text', 'binary', 'binary', 0, ['old writer', 'no annotation', '', 'текст', '', 'ok']],
  ['binary_raw', 'binary', 'binary', 0, ['89504e470d0a1a0a', '000102', '', 'fffe', '', `${HEX_OF_64}… (100 bytes)`]],
  // and hex for the rest of a column once one value was not text.
  ['binary_mixed', 'binary', 'binary', 0, ['text first', 'ff00', '', '7465787420616761696e', '', '656e64']],
  ['fixed4', 'binary[4]', 'binary[4]', 0, ['00010203', '61626364', '', 'ffffffff', '7778797a', '10203040']],
  ['date32', 'date', 'date', 0, ['1970-01-01', '2024-02-29', '', '0001-01-01', '9999-12-31', '1969-12-31']],
  ['time_ms', 'time[ms]', 'time[ms]', 0, ['00:00:00', '23:59:59.999', '', '12:30:00', '01:02:03.004', '06:00:00']],
  // A fraction is written with three, six or nine digits, whichever it needs.
  ['time_us', 'time[us]', 'time[us]', 0, ['00:00:00', '23:59:59.999999', '', '12:30:00.250', '01:02:03.000004', '06:00:00']],
  ['ts_ms', 'timestamp[ms]', 'timestamp[ms]', 0, ['1970-01-01 00:00:00', '2024-02-29 12:34:56.789', '', '1969-12-31 23:59:59', '2001-09-09 01:46:40', '0001-01-01 00:00:00']],
  ['ts_us_utc', 'timestamp[us, UTC]', 'timestamp[us, UTC]', 0, ['1970-01-01 00:00:00', '2024-02-29 12:34:56.789012', '', '1969-12-31 23:59:59.999999', '2001-09-09 01:46:40.500', '9999-12-31 23:59:59']],
  ['ts_ns', 'timestamp[ns]', 'timestamp[ns]', 0, ['1970-01-01 00:00:00', '2024-02-29 12:34:56.789012345', '', '1969-12-31 23:59:59.999999999', '2001-09-09 01:46:40.123456', '1970-01-01 00:00:00.000000001']],
  // Parquet has no duration: Arrow keeps it as the count it is.
  ['duration', 'int64', 'int64', 1, ['0', '1500', '', '-1', '86400000', '1']],
  ['list_int', 'list', 'list<int64>', 0, ['[1,2,3]', '[]', '', '[null,5]', '[9007199254740993]', '[0]']],
  ['list_str', 'list', 'list<string>', 0, ['["a","b"]', '["x \\"y\\""]', '', '[]', '[null]', '["é"]']],
  ['struct', 'struct', 'struct<a: int32, b: string>', 0, ['{"a":1,"b":"x"}', '{"a":null,"b":"y"}', '', '{"a":3,"b":null}', '{"a":4,"b":"z"}', '{"a":5,"b":""}']],
  ['map', 'map', 'map<string, int32>', 0, ['{"k1":1,"k2":2}', '{}', '', '{"k":null}', '{"a":1}', '{"b":2}']],
  ['list_struct', 'list', 'list<struct<t: timestamp[ms], v: double>>', 0, ['[{"t":"2020-01-01 00:00:00","v":1.5}]', '[]', '', '[{"t":null,"v":null}]', '[{"t":"2020-01-02 03:04:05","v":2},{"t":"2021-01-01 00:00:00","v":-1}]', '[]']],
  ['dict_str', 'string', 'string', 0, ['red', 'green', '', 'red', 'blue', 'green']],
  ['', 'int32', 'int32', 1, ['1', '2', '3', '4', '5', '6']],
  ['required', 'int64', 'int64, required', 1, ['10', '20', '30', '40', '50', '60']],
  ['all_null', 'string', 'string', 0, ['', '', '', '', '', '']],
  ['null_type', 'null', 'null', 0, ['', '', '', '', '', '']],
];

test('every type is shown as pyarrow reads it', async () => {
  const table = await readParquet({ path: file('types') });
  const rows = rowsOf(table);
  assert.deepEqual(table.names, TYPES.map((column) => column[0]));
  TYPES.forEach(([name, , , , cells], c) => {
    assert.deepEqual(
      rows.map((row) => row[c] ?? ''),
      cells,
      `column ${name}`,
    );
  });
});

test('the type of every column, short and written out, and which columns are numbers', async () => {
  const table = await readParquet({ path: file('types') });
  const named = <T>(values: ArrayLike<T>): Record<string, T> => Object.fromEntries(TYPES.map((column, c) => [column[0], values[c]]));
  assert.deepEqual(named(table.types), Object.fromEntries(TYPES.map((column) => [column[0], column[1]])));
  assert.deepEqual(named(table.details), Object.fromEntries(TYPES.map((column) => [column[0], column[2]])));
  assert.deepEqual(named(table.numeric), Object.fromEntries(TYPES.map((column) => [column[0], column[3]])));
});

test('rows end at their last value, and the file says what wrote it', async () => {
  const table = await readParquet({ path: file('types') });
  // The last two columns are empty in every row.
  assert.deepEqual(Array.from(table.rowEnds), [36, 72, 108, 144, 180, 216]);
  assert.deepEqual([table.rows, table.totalRows, table.rowGroups, table.codecs, table.warning], [6, 6, 1, ['SNAPPY'], '']);
  assert.match(table.createdBy, /^parquet-cpp-arrow version \d+/);
});

test('decimals kept in integers come out with their digits and their scale', async () => {
  const table = await readParquet({ path: file('decimal_int') });
  assert.deepEqual(table.types, ['decimal(9, 2)', 'decimal(18, 4)']);
  assert.deepEqual(rowsOf(table), [['1.10', '12345678901234.5678'], ['-0.57', '-0.0001'], [], ['9999999.99', '0.0000']]);
});

test('timestamps of 96 bits, as old writers store them', async () => {
  const table = await readParquet({ path: file('int96') });
  assert.deepEqual(table.types, ['timestamp[ns]']);
  assert.deepEqual(rowsOf(table), [['1970-01-01 00:00:00'], ['2024-02-29 12:34:56.789012345'], [], ['1969-12-31 23:59:59.999999999']]);
});

// ---- Compression ------------------------------------------------------------------------------

for (const [name, codec, available] of [
  ['none', 'UNCOMPRESSED', true],
  ['snappy', 'SNAPPY', true],
  ['gzip', 'GZIP', true],
  ['brotli', 'BROTLI', true],
  ['lz4', 'LZ4_RAW', true],
  ['zstd', 'ZSTD', zstd],
] as const) {
  test(`pages compressed with ${codec}`, { skip: available ? false : 'the zlib of this runtime has no Zstandard (Node.js before 22.15)' }, async () => {
    const table = await readParquet({ path: file(`codec_${name}`) });
    assert.deepEqual([table.codecs, table.rows, table.warning], [[codec], 40, '']);
    assert.deepEqual(rowsOf(table), expectedRows(40));
  });
}

test('pages in the framing of the older LZ4 codec, and bare blocks under its name', async () => {
  for (const name of ['lz4_hadoop', 'lz4_hadoop_bare']) {
    const table = await readParquet({ path: file(name) });
    assert.deepEqual([table.codecs, table.rows, table.warning], [['LZ4'], 40, ''], name);
    assert.deepEqual(table.details, ['int32, required', 'string, required'], name);
    assert.deepEqual(rowsOf(table), expectedRows(40, 2), name);
  }
});

test('without Zstandard in the runtime, such a file is refused in words', async () => {
  // What a VS Code before 1.101 has: the function is hidden from the reader for this one read.
  const real = require('zlib') as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(real, 'zstdDecompressSync');
  Object.defineProperty(real, 'zstdDecompressSync', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(await refusal({ path: file('codec_zstd') }), REFUSALS.zstd);
  } finally {
    if (descriptor) {
      Object.defineProperty(real, 'zstdDecompressSync', descriptor);
    } else {
      delete real.zstdDecompressSync;
    }
  }
});

test('a file compressed with LZO is refused in words', async () => {
  assert.equal(await refusal({ path: file('lzo') }), REFUSALS.lzo);
});

// LZ4 blocks made by the reference library (python: lz4.block.compress(data, store_size=False), lz4 4.4.5),
// of data that is easy to make again here.
const LZ4_BLOCKS: [name: string, data: Buffer, block: string][] = [
  // Three literals, then a match that overlaps what it writes.
  ['a pattern repeated', Buffer.from('abc'.repeat(300)), 'P2FiYwMA////bFBiY2FiYw=='],
  // A match length of many bytes.
  ['zeros', Buffer.alloc(20000), `HwABAP${'/'.repeat(103)}1VQAAAAAAA=`],
  ['words', Buffer.from(`${'alpha beta gamma delta '.repeat(20)}tail`), '/whhbHBoYSBiZXRhIGdhbW1hIGRlbHRhIBcA/6JQIHRhaWw='],
  ['three bytes', Buffer.from('abc'), 'MGFiYw=='],
  ['nothing', Buffer.alloc(0), 'AA=='],
];
// 256 literals in front of the first match, so a literal length of two bytes.
const SQUARES = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * i + 3 * i) % 256));
const SQUARES_HEAD = '//EABAoSHCg2Rlhsgpq00O4OMFR6osz4JlaIvPIqZKDeHmCk6jJ8yBZmuAxiuhRwzi6Q9FrCLJgGduhc0krEQL4+wETKUtxo9oYYrELadBCuTvCUOuKMOOaWSPyyaiTgnl4g5KpyPAjWpnhMIvrUsI5uUDQaAuzYxraonJKKhIB+foCEipKcqLbG2OwCGjRQbo6w1PoiTHim1gg8cqrkIF6e4CRqsvxIluY4jOI6lPBOrhB02kKsGIb2aNxSykTAPr5AxErSXOh2Bpgswlr0kC7OcBS6Ygy4ZhbIfDLqpGAe3qBkKvK8iFYm+MyielQwDu7QtJqCbFhGNigcEgoEAP7+AAH/QVDijDjmlg==';
LZ4_BLOCKS.push(['more literals than one length byte counts', SQUARES, SQUARES_HEAD]);

test('LZ4 blocks of the reference library are decoded', () => {
  for (const [name, data, base64] of LZ4_BLOCKS) {
    const block = Buffer.from(base64, 'base64');
    const output = new Uint8Array(data.length);
    assert.equal(lz4Block(block, 0, block.length, output, 0), data.length, name);
    assert.ok(data.equals(output), name);
    // In the middle of a larger buffer, and behind what the output already holds.
    const padded = Buffer.concat([Buffer.from([0xff, 0xff]), block, Buffer.from([0xff])]);
    const behind = new Uint8Array(5 + data.length).fill(7);
    assert.equal(lz4Block(padded, 2, 2 + block.length, behind, 5), 5 + data.length, name);
    assert.deepEqual([...behind.subarray(0, 5)], [7, 7, 7, 7, 7], name);
    assert.ok(data.equals(behind.subarray(5)), name);
  }
});

test('LZ4 in the framing of Hadoop: blocks, each behind its decoded and its encoded length', () => {
  const frame = (data: Buffer, base64: string): Buffer => {
    const block = Buffer.from(base64, 'base64');
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(data.length, 0);
    lengths.writeUInt32BE(block.length, 4);
    return Buffer.concat([lengths, block]);
  };
  for (const [name, data, base64] of LZ4_BLOCKS) {
    assert.ok(data.equals(lz4Hadoop(frame(data, base64), data.length)), name);
    // A bare block where the framing is expected, as some writers put it.
    assert.ok(data.equals(lz4Hadoop(Buffer.from(base64, 'base64'), data.length)), `${name}, bare`);
  }
  // Several frames, one behind the other.
  const [first, second, third] = LZ4_BLOCKS;
  const all = Buffer.concat([first[1], second[1], third[1]]);
  assert.ok(all.equals(lz4Hadoop(Buffer.concat([frame(first[1], first[2]), frame(second[1], second[2]), frame(third[1], third[2])]), all.length)));
});

test('damaged LZ4 data is refused instead of read past its end', () => {
  const output = (): Uint8Array => new Uint8Array(16);
  const refused = { message: 'the LZ4 data is damaged.' };
  // A match that reaches back before the start of the output: offset 9 after one literal.
  assert.throws(() => lz4Block(Uint8Array.from([0x10, 0x61, 0x09, 0x00, 0x00]), 0, 5, output(), 0), refused);
  // An offset of zero, which no match has.
  assert.throws(() => lz4Block(Uint8Array.from([0x10, 0x61, 0x00, 0x00, 0x00]), 0, 5, output(), 0), refused);
  // More literals than the block holds, and more than the output takes.
  assert.throws(() => lz4Block(Uint8Array.from([0x50, 0x61, 0x62]), 0, 3, output(), 0), refused);
  assert.throws(() => lz4Block(Buffer.concat([Buffer.from([0xf0, 0x05]), Buffer.alloc(20, 0x61)]), 0, 22, output(), 0), refused);
  // A match longer than the output: one literal repeated 4 + 15 + 200 times.
  assert.throws(() => lz4Block(Uint8Array.from([0x1f, 0x61, 0x01, 0x00, 0xc8, 0x00]), 0, 6, output(), 0), refused);
  // The block decodes, but not to the length that the page announces.
  const [, data, base64] = LZ4_BLOCKS[0];
  assert.throws(() => lz4Hadoop(Buffer.from(base64, 'base64'), data.length + 1), refused);
  assert.throws(() => lz4Hadoop(Buffer.from(base64, 'base64'), data.length - 1), refused);
  // A frame that announces three bytes more than its block gives.
  const block = Buffer.from(base64, 'base64');
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32BE(data.length + 3, 0);
  lengths.writeUInt32BE(block.length, 4);
  assert.throws(() => lz4Hadoop(Buffer.concat([lengths, block]), data.length + 3), refused);
});

test('Snappy: literals, copies, and a copy that repeats what it has just written', () => {
  const text = (bytes: number[], length: number): string => Buffer.from(snappy(Uint8Array.from(bytes), length)).toString('latin1');
  // The size in front, then: four bytes as they are (tag 0x0c), and eight from four back (0x11: one byte of offset, 4 + 4).
  assert.equal(text([12, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x11, 0x04], 12), 'abcdabcdabcd');
  // One byte, and seven from one back: the copy runs over its own output.
  assert.equal(text([8, 0x00, 0x7a, 0x0d, 0x01], 8), 'zzzzzzzz');
  // Offsets of two and of four bytes (tags 0x0e and 0x0f: four bytes each), and an empty page.
  assert.equal(text([12, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x0e, 0x04, 0x00, 0x0f, 0x08, 0x00, 0x00, 0x00], 12), 'abcdabcdabcd');
  assert.equal(text([0], 0), '');
  // Sixty and more bytes as they are have their number behind the tag: 0xf0 with one byte, 0xf4 with two.
  const long = Array.from({ length: 300 }, (_, i) => 0x30 + (i % 10));
  assert.deepEqual([...snappy(Uint8Array.from([70, 0xf0, 69, ...long.slice(0, 70)]), 70)], long.slice(0, 70));
  assert.deepEqual([...snappy(Uint8Array.from([0xac, 0x02, 0xf4, 0x2b, 0x01, ...long]), 300)], long);
});

test('damaged Snappy data is refused at once', () => {
  const refused = { message: 'the Snappy data is damaged.' };
  const read = (bytes: number[], length: number) => () => snappy(Uint8Array.from(bytes), length);
  // A length of four bytes with the highest bit set. hyparquet's own decoder takes it for a number below
  // zero and steps back in its input, round and round: two such files of 18 KB took it 3 and 6 seconds.
  assert.throws(read([40, 0xfc, 0xff, 0xff, 0xff, 0xff, 0x61, 0x62, 0x63, 0x0c, 0x61, 0x62, 0x63, 0x64], 40), refused);
  assert.throws(read([40, 0xfc, 0x00, 0x00, 0x00, 0x80, 0x61, 0x62, 0x63], 40), refused);
  // A copy from before the start, a copy from no distance, and one that runs past the size of the page.
  assert.throws(read([12, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x11, 0x05], 12), refused);
  assert.throws(read([12, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x11, 0x00], 12), refused);
  assert.throws(read([8, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x11, 0x04], 8), refused);
  // More bytes than the data holds, data that ends inside a tag, and nothing at all.
  assert.throws(read([12, 0x2c, 0x61, 0x62, 0x63, 0x64], 12), refused);
  assert.throws(read([12, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x0e, 0x04], 12), refused);
  assert.throws(read([], 0), refused);
  // A page that is not as long as its header says, either way, and a size that never ends.
  assert.throws(read([12, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x11, 0x04], 13), refused);
  assert.throws(read([4, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x11, 0x04], 4), refused);
  assert.throws(read([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00], 0), refused);
});

// ---- Layouts ----------------------------------------------------------------------------------

test('data pages of version 2', async () => {
  const table = await readParquet({ path: file('page_v2') });
  assert.deepEqual([table.codecs, table.rows, table.warning], [['GZIP'], 40, '']);
  assert.deepEqual(rowsOf(table), expectedRows(40));
});

test('the delta encodings and the split byte streams of version 2', async () => {
  const table = await readParquet({ path: file('page_v2_delta') });
  assert.deepEqual([table.names, table.rows, table.warning], [['id', 'word', 'ratio', 'note'], 40, '']);
  assert.deepEqual(rowsOf(table), expectedRows(40, 4));
});

test('several row groups are read one after the other', async () => {
  const table = await readParquet({ path: file('row_groups') });
  assert.deepEqual([table.rowGroups, table.rows, table.totalRows, table.warning], [3, 40, 40, '']);
  assert.deepEqual(rowsOf(table), expectedRows(40));
});

test('a file without rows still has its columns, and a file without columns is an empty table', async () => {
  const empty = await readParquet({ path: file('no_rows') });
  assert.deepEqual([empty.names, empty.types, empty.rows, empty.totalRows, empty.rowEnds.length, empty.text.length], [['id', 'word', 'ratio', 'note', 'tags'], ['int64', 'string', 'double', 'string', 'list'], 0, 0, 0, 0]);
  assert.deepEqual(Array.from(empty.numeric), [1, 0, 1, 0, 0]);
  const none = await readParquet({ path: file('no_columns') });
  assert.deepEqual([none.names, none.types, none.rows, none.totalRows, none.warning], [[], [], 0, 0, '']);
});

test('a column in an encoding the reader does not know is left empty and named, and the others are read', async () => {
  // DELTA_BYTE_ARRAY in a data page of version 1.
  const table = await readParquet({ path: file('unread_column') });
  assert.deepEqual([table.names, table.rows], [['id', 'word'], 40]);
  assert.deepEqual(
    rowsOf(table),
    Array.from({ length: 40 }, (_, i) => [String(i)]),
  );
  assert.match(table.warning, /^A column could not be read and is left empty: word \(.+\)\.$/);
});

test('the same table comes from a file on disk and from its bytes', async () => {
  for (const name of ['types', 'row_groups', 'codec_gzip', 'unread_column']) {
    const disk = await readParquet({ path: file(name) });
    const memory = await readParquet({ bytes: plain(bytesOf(name)) });
    assert.deepEqual(memory, disk, name);
  }
  // Bytes that start somewhere inside their buffer.
  const bytes = bytesOf('codec_snappy');
  const shifted = new Uint8Array(bytes.length + 3).subarray(3);
  shifted.set(bytes);
  assert.deepEqual(rowsOf(await readParquet({ bytes: shifted })), expectedRows(40));
});

test('bytes that come as a Buffer of Node.js are read like any other', async () => {
  // A Buffer is a window on memory it shares with others, and its slice() is another window, not a copy.
  // The provider never hands one over: its bytes reach the reader through `workerData`, which makes a plain array of them.
  assert.deepEqual(rowsOf(await readParquet({ bytes: bytesOf('codec_snappy') })), expectedRows(40));
  // A small one lies in the pool that Node.js keeps for them, among other data.
  const pooled = Buffer.allocUnsafe(bytesOf('codec_none').length);
  bytesOf('codec_none').copy(pooled);
  assert.deepEqual(rowsOf(await readParquet({ bytes: pooled })), expectedRows(40));
  assert.deepEqual(await readParquet({ bytes: bytesOf('types') }), await readParquet({ path: file('types') }));
});

test('a file of more rows than the viewer shows is cut at the limit', async () => {
  // 1,000,001 rows of the same small number, which Parquet stores in a few bytes.
  const table = await readParquet({ path: file('rows_over') });
  assert.deepEqual([table.rows, table.totalRows, table.rowEnds.length, table.ends.length], [MAX_ROWS, MAX_ROWS + 1, MAX_ROWS, MAX_ROWS]);
  assert.equal(table.text.length, MAX_ROWS);
  assert.ok(table.text.every((byte) => byte === 0x37));
});

// ---- What is not a Parquet file, or not a whole one --------------------------------------------

test('what is not a Parquet file is refused in words', async () => {
  assert.equal(await refusal({ bytes: new Uint8Array(0) }), REFUSALS.empty);
  assert.equal(await refusal({ bytes: plain(Buffer.from('PAR')) }), REFUSALS.notParquet);
  assert.equal(await refusal({ bytes: plain(Buffer.from('this is not a parquet file at all\n'.repeat(10))) }), REFUSALS.notParquet);
  // An encrypted file ends with PARE where a plain one has PAR1.
  assert.equal(await refusal({ bytes: plain(Buffer.concat([bytesOf('codec_none').subarray(0, -4), Buffer.from('PARE')])) }), REFUSALS.encrypted);
});

test('a file cut at any length is refused in words', async () => {
  const bytes = bytesOf('codec_snappy');
  for (let length = 0; length < bytes.length; length++) {
    const answer = await refusal({ bytes: plain(bytes.subarray(0, length)) });
    if (length === 4) {
      // The four bytes that a Parquet file begins with are also the four it ends with.
      assert.match(answer, DAMAGED);
    } else {
      assert.equal(answer, length === 0 ? REFUSALS.empty : length < 4 ? REFUSALS.notParquet : REFUSALS.cut, `cut at ${length}`);
    }
  }
  const half = path.join(dir, 'half.parquet');
  fs.writeFileSync(half, bytes.subarray(0, bytes.length >> 1));
  assert.equal(await refusal({ path: half }), REFUSALS.cut);
});

test('a description of the data that makes no sense is reported as damage, with the reason', async () => {
  const bytes = bytesOf('codec_snappy');
  // The footer lies in front of its length and the last four bytes.
  const footer = bytes.readUInt32LE(bytes.length - 8);
  bytes.fill(0xff, bytes.length - 8 - footer, bytes.length - 8);
  assert.match(await refusal({ bytes: plain(bytes) }), DAMAGED);
});

test('a file on disk that is shorter than the data it describes is refused in words', async () => {
  // The description of a whole file, and none of the pages it points to.
  const bytes = bytesOf('codec_none');
  const footer = bytes.readUInt32LE(bytes.length - 8);
  const hollow = path.join(dir, 'hollow.parquet');
  fs.writeFileSync(hollow, Buffer.concat([bytes.subarray(0, 4), bytes.subarray(bytes.length - 8 - footer)]));
  assert.equal(await refusal({ path: hollow }), REFUSALS.ended);
});

// ---- Damage -----------------------------------------------------------------------------------

/** Copies of a file, each damaged in one of five ways, with a word on what was done. */
function damage(original: Buffer, seed: number, count: number): { bytes: Buffer; what: string }[] {
  const rand = random(seed);
  return Array.from({ length: count }, (_, n) => {
    let bytes = Buffer.from(original);
    let what: string;
    switch (n % 5) {
      case 0: {
        const flips = Array.from({ length: 1 + rand.int(3) }, () => [rand.int(bytes.length), rand.int(8)]);
        flips.forEach(([at, bit]) => (bytes[at] ^= 1 << bit));
        what = `bits flipped: ${flips.map(([at, bit]) => `${bit} of byte ${at}`).join(', ')}`;
        break;
      }
      case 1: {
        const length = rand.int(bytes.length);
        bytes = bytes.subarray(0, length);
        what = `cut at ${length}`;
        break;
      }
      case 2: {
        const from = rand.int(bytes.length - 16);
        bytes.fill(0xff, from);
        what = `FF from ${from} on`;
        break;
      }
      case 3: {
        // In the description of the data, at the end of the file.
        const at = bytes.length - 8 - rand.int(Math.min(600, bytes.length - 8));
        const values = [rand.int(256), rand.int(256)];
        bytes.set(values, at);
        what = `bytes ${at} and ${at + 1} set to ${values.join(' and ')}`;
        break;
      }
      default: {
        const at = rand.int(bytes.length - 8);
        const value = rand.int(0x7fffffff);
        bytes.writeUInt32LE(value, at);
        what = `four bytes at ${at} set to ${value}`;
      }
    }
    return { bytes, what };
  });
}

// hyparquet trusts the file, and each of the three files below is one way in which it fails on its
// own: found by the damage at random of the last test and then written by hand (make.py), so that
// the reason is plain to see. The checks of parquetGuard.ts stand in front of it. Every file is read
// in another process first, because a reader that has lost its checks may not answer, and only then
// here, for what it says. They run side by side.
test('damage', { concurrency: true }, async (t) => {
  await Promise.all([
    // hyparquet never returns from markGeoColumns() when a column has a negative num_children.
    t.test('a column that claims a negative number of children is damage, in words', async () => {
      const [answer] = await elsewhere([bytesOf('damaged_children')]);
      assert.ok(answered(answer), answer);
      assert.equal(answer, 'the file is damaged, or written in a way Previewix does not read (the column id has -1 children).');
    }),

    // hyparquet writes out a run of any length (readRle): these 830 bytes cost it 2.5 s and 3.9 GB of memory.
    t.test('a run of levels far longer than its page costs its column, and nothing else', async () => {
      const [answer] = await elsewhere([bytesOf('damaged_run')]);
      assert.equal(answer, 'table, with a warning');
      const table = await readParquet({ bytes: plain(bytesOf('damaged_run')) });
      assert.equal(table.warning, 'A column could not be read and is left empty: id (a run of 2147483632 values in a page of 40).');
      assert.deepEqual(
        rowsOf(table),
        expectedRows(40, 2).map(([, word]) => ['', word]),
      );
    }),

    // hyparquet has started reading the first column when the second one makes it throw, and nobody
    // waits for that read: a promise that fails on its own, of which a worker thread dies.
    t.test('two columns that fail in different ways leave no promise to fail on its own', async () => {
      const [answer] = await elsewhere([bytesOf('damaged_twice')]);
      assert.ok(answered(answer), answer);
      assert.equal(answer, 'the file is damaged, or written in a way Previewix does not read (row group 1 has a column that the schema does not: nope).');
    }),

    // hyparquet makes a list as long as the file claims, and reads structures past the end of the bytes as
    // empty ones without a word: 134 million objects from these 22 bytes, or as many as the memory takes.
    t.test('a list of more structures than the file has bytes is damage, in words', async () => {
      // A description of the data that is one field: a list (0x19) of structures (0xfc: their number follows) and nothing else.
      const footer = Buffer.from([0x19, 0xfc, 0x80, 0x80, 0x80, 0x40]);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(footer.length);
      const [answer] = await elsewhere([Buffer.concat([Buffer.from('PAR1'), footer, length, Buffer.from('PAR1')])]);
      assert.equal(answer, 'the file is damaged, or written in a way Previewix does not read (a list of 134217728 entries in 0 bytes).');
    }),

    t.test('damage at random gets an answer: a table, a refusal or the sentence for damage', async () => {
      const cases = [...damage(bytesOf('page_v2'), 2024, 300), ...damage(bytesOf('codec_none'), 7, 300), ...damage(bytesOf('page_v2_delta'), 31, 300), ...damage(bytesOf('types'), 5, 300)];
      const answers = await elsewhere(cases.map((item) => item.bytes));
      const last = answers.length - 1;
      assert.ok(answered(answers[last]), `file ${last} (${cases[last].what}): ${answers[last]}`);
      assert.equal(answers.length, cases.length);
    }),
  ]);
});

// ---- Against pyarrow --------------------------------------------------------------------------

// Writes a file of 300 rows of random values and prints what pyarrow reads back from it, as the texts
// that the viewer is to show. Arguments: the file to write, a seed, the codecs to pick from.
// PREVIEWIX_TEST_PYTHON names a Python that has pyarrow, when `python3` has not.
const PYARROW = `
import sys, json, random, datetime, decimal
import pyarrow as pa, pyarrow.parquet as pq
out, seed, codecs = sys.argv[1], int(sys.argv[2]), sys.argv[3].split(',')
rnd = random.Random(seed)
n = 300
def maybe(make):
    return [None if rnd.random() < 0.2 else make() for _ in range(n)]
letters = 'abc xyz,;"\\n\\tÄö日本語😀'
table = pa.table({
    'int': pa.array(maybe(lambda: rnd.choice([rnd.randint(-2**63, 2**63 - 1), rnd.randint(-1000, 1000)])), pa.int64()),
    'float': pa.array(maybe(lambda: rnd.choice([rnd.uniform(-1e6, 1e6), rnd.random() * 10.0 ** rnd.randint(-300, 300), float(rnd.randint(-5, 5))])), pa.float64()),
    'text': pa.array(maybe(lambda: ''.join(rnd.choice(letters) for _ in range(rnd.randint(0, 12)))), pa.string()),
    'flag': pa.array(maybe(lambda: rnd.random() < 0.5), pa.bool_()),
    'decimal': pa.array(maybe(lambda: decimal.Decimal(rnd.randint(-10**19, 10**19)).scaleb(-6)), pa.decimal128(20, 6)),
    'day': pa.array(maybe(lambda: rnd.randint(-719162, 2932896)), pa.date32()),
    'stamp': pa.array(maybe(lambda: rnd.randint(-62135596800 * 10**6, 253402300799 * 10**6)), pa.timestamp('us')),
    'raw': pa.array(maybe(lambda: b'\\xff' + rnd.randbytes(rnd.randint(0, 15))), pa.binary()),
    'list': pa.array(maybe(lambda: [rnd.choice([None, rnd.randint(-2**31, 2**31 - 1)]) for _ in range(rnd.randint(0, 4))]), pa.list_(pa.int32())),
    'last': pa.array(range(n), pa.int32()),
})
version, dictionary = rnd.choice([('1.0', True), ('1.0', False), ('2.0', True)])
pq.write_table(table, out, compression=rnd.choice(codecs), row_group_size=rnd.choice([50, 120, 1000]), data_page_version=version, use_dictionary=dictionary)

def day(value):
    date = datetime.date.fromordinal(value + 719163)
    return f'{date.year:04d}-{date.month:02d}-{date.day:02d}'
def stamp(value):
    seconds, micros = divmod(value, 10**6)
    at = datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=seconds)
    fraction = '' if not micros else '.' + (f'{micros:06d}'[:3] if micros % 1000 == 0 else f'{micros:06d}')
    return f'{day((at.date() - datetime.date(1970, 1, 1)).days)} {at.hour:02d}:{at.minute:02d}:{at.second:02d}{fraction}'
back = pq.read_table(out)
texts = {
    'int': str, 'float': lambda v: v, 'text': lambda v: v, 'flag': lambda v: 'true' if v else 'false', 'decimal': lambda v: format(v, 'f'),
    'day': day, 'stamp': stamp, 'raw': lambda v: v.hex(), 'list': lambda v: json.dumps(v, separators=(',', ':')), 'last': str,
}
columns = []
for name, text in texts.items():
    column = back.column(name)
    if name in ('day', 'stamp'):
        column = column.cast(pa.int32() if name == 'day' else pa.int64())
    columns.append([None if value is None else text(value) for value in column.to_pylist()])
json.dump({'names': back.schema.names, 'columns': columns}, sys.stdout)
`;

test('a file of random values, written on the spot, reads as pyarrow reads it', { skip: needs(pyarrow, 'Python with pyarrow') }, async () => {
  const codecs = ['none', 'snappy', 'gzip', 'brotli', 'lz4', ...(zstd ? ['zstd'] : [])];
  for (const seed of [1, 2, 3]) {
    const written = path.join(dir, `random${seed}.parquet`);
    const expected = JSON.parse(run(pyarrow!, ['-c', PYARROW, written, String(seed), codecs.join(',')]).toString('utf8')) as { names: string[]; columns: (string | number | null)[][] };
    const table = await readParquet({ path: written });
    const where = `seed ${seed} (${table.codecs.join(', ')}, ${table.rowGroups} row groups)`;
    assert.deepEqual([table.names, table.rows, table.warning], [expected.names, 300, ''], where);
    const rows = rowsOf(table);
    expected.columns.forEach((cells, c) => {
      cells.forEach((cell, r) => {
        const shown = rows[r][c];
        if (typeof cell === 'number') {
          // The digits of a double may be written in more than one way; the number they give must be the same.
          assert.ok(shown !== '' && Number(shown) === cell, `${where}, ${expected.names[c]} of row ${r}: ${shown} for ${cell}`);
        } else {
          assert.equal(shown, cell ?? '', `${where}, ${expected.names[c]} of row ${r}`);
        }
      });
    });
  }
});
