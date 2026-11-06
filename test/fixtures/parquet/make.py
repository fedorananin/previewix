# Writes the Parquet fixtures of test/parquet.test.ts. Needs pyarrow and lz4 (pip install pyarrow lz4):
#
#   python3 test/fixtures/parquet/make.py test/fixtures/parquet
#
# It prints what pyarrow reads back from types.parquet, column by column. The expected texts in the
# test are those values, written the way the viewer shows them. The other files hold rows that follow
# a formula (`rows()` here, `expectedRows()` in the test), so the test computes what to expect.
import datetime
import decimal
import os
import struct
import sys

import lz4.block
import pyarrow as pa
import pyarrow.parquet as pq

out = sys.argv[1]
D = decimal.Decimal
dt = datetime.datetime
utc = datetime.timezone.utc


def path_of(name):
    return os.path.join(out, name)


# ---------------------------------------------------------------- every type: six rows, the third of them null
types = pa.table({
    'bool': pa.array([True, False, None, True, False, True]),
    'int8': pa.array([-128, 127, None, 0, 1, -1], pa.int8()),
    'int16': pa.array([-32768, 32767, None, 0, 1, -1], pa.int16()),
    'int32': pa.array([-2147483648, 2147483647, None, 0, 1, -1], pa.int32()),
    'int64': pa.array([-9223372036854775808, 9223372036854775807, None, 9007199254740993, 1, -1], pa.int64()),
    'uint8': pa.array([0, 255, None, 1, 2, 3], pa.uint8()),
    'uint16': pa.array([0, 65535, None, 1, 2, 3], pa.uint16()),
    'uint32': pa.array([0, 4294967295, None, 1, 2, 3], pa.uint32()),
    'uint64': pa.array([0, 18446744073709551615, None, 1, 2, 3], pa.uint64()),
    'float32': pa.array([0.1, -1.5, None, 3.4028235e38, 1e-10, 16777216.0], pa.float32()),
    'float64': pa.array([0.1, -1.5, None, 1.7976931348623157e308, 5e-324, 123456789.123456789], pa.float64()),
    'float_special': pa.array([float('nan'), float('inf'), float('-inf'), -0.0, 0.0, None], pa.float64()),
    'dec_10_2': pa.array([D('1.10'), D('-0.57'), None, D('99999999.99'), D('0.00'), D('-12345.60')], pa.decimal128(10, 2)),
    'dec_38_10': pa.array([D('1234567890123456789012345678.0123456789'), D('-0.0000000001'), None, D('0'), D('1'), D('-99999999999999999999.5')], pa.decimal128(38, 10)),
    'dec_9_0': pa.array([D('123456789'), D('-1'), None, D('0'), D('7'), D('42')], pa.decimal128(9, 0)),
    'string': pa.array(['plain', '', None, 'Юникод 日本語 🎉', 'line1\nline2', ' spaces  ']),
    'large_string': pa.array(['a', 'b', None, 'c|d', '"quoted"', 'x,y'], pa.large_string()),
    'binary_text': pa.array([b'old writer', b'no annotation', None, 'текст'.encode(), b'', b'ok'], pa.binary()),
    'binary_raw': pa.array([b'\x89PNG\r\n\x1a\n', b'\x00\x01\x02', None, b'\xff\xfe', b'', bytes(range(100))], pa.binary()),
    'binary_mixed': pa.array([b'text first', b'\xff\x00', None, b'text again', b'', b'end'], pa.binary()),
    'fixed4': pa.array([b'\x00\x01\x02\x03', b'abcd', None, b'\xff\xff\xff\xff', b'wxyz', b'\x10\x20\x30\x40'], pa.binary(4)),
    'date32': pa.array([datetime.date(1970, 1, 1), datetime.date(2024, 2, 29), None, datetime.date(1, 1, 1), datetime.date(9999, 12, 31), datetime.date(1969, 12, 31)], pa.date32()),
    'time_ms': pa.array([datetime.time(0, 0, 0), datetime.time(23, 59, 59, 999000), None, datetime.time(12, 30), datetime.time(1, 2, 3, 4000), datetime.time(6)], pa.time32('ms')),
    'time_us': pa.array([datetime.time(0, 0, 0), datetime.time(23, 59, 59, 999999), None, datetime.time(12, 30, 0, 250000), datetime.time(1, 2, 3, 4), datetime.time(6)], pa.time64('us')),
    'ts_ms': pa.array([dt(1970, 1, 1), dt(2024, 2, 29, 12, 34, 56, 789000), None, dt(1969, 12, 31, 23, 59, 59), dt(2001, 9, 9, 1, 46, 40), dt(1, 1, 1)], pa.timestamp('ms')),
    'ts_us_utc': pa.array([dt(1970, 1, 1, tzinfo=utc), dt(2024, 2, 29, 12, 34, 56, 789012, tzinfo=utc), None, dt(1969, 12, 31, 23, 59, 59, 999999, tzinfo=utc), dt(2001, 9, 9, 1, 46, 40, 500000, tzinfo=utc), dt(9999, 12, 31, 23, 59, 59, tzinfo=utc)], pa.timestamp('us', tz='UTC')),
    'ts_ns': pa.array([0, 1709210096789012345, None, -1, 1000000000123456000, 1], pa.timestamp('ns')),
    'duration': pa.array([0, 1500, None, -1, 86400000, 1], pa.duration('ms')),
    'list_int': pa.array([[1, 2, 3], [], None, [None, 5], [9007199254740993], [0]], pa.list_(pa.int64())),
    'list_str': pa.array([['a', 'b'], ['x "y"'], None, [], [None], ['é']], pa.list_(pa.string())),
    'struct': pa.array([{'a': 1, 'b': 'x'}, {'a': None, 'b': 'y'}, None, {'a': 3, 'b': None}, {'a': 4, 'b': 'z'}, {'a': 5, 'b': ''}], pa.struct([('a', pa.int32()), ('b', pa.string())])),
    'map': pa.array([[('k1', 1), ('k2', 2)], [], None, [('k', None)], [('a', 1)], [('b', 2)]], pa.map_(pa.string(), pa.int32())),
    'list_struct': pa.array([[{'t': dt(2020, 1, 1), 'v': 1.5}], [], None, [{'t': None, 'v': None}], [{'t': dt(2020, 1, 2, 3, 4, 5), 'v': 2.0}, {'t': dt(2021, 1, 1), 'v': -1.0}], []], pa.list_(pa.struct([('t', pa.timestamp('ms')), ('v', pa.float64())]))),
    'dict_str': pa.array(['red', 'green', None, 'red', 'blue', 'green']).dictionary_encode(),
    '': pa.array([1, 2, 3, 4, 5, 6], pa.int32()),
    'required': pa.array([10, 20, 30, 40, 50, 60], pa.int64()),
    # The last columns are empty in every row, so every row ends before them.
    'all_null': pa.array([None] * 6, pa.string()),
    'null_type': pa.nulls(6),
})
at = types.schema.get_field_index('required')
types = types.set_column(at, pa.field('required', pa.int64(), nullable=False), types.column(at))
# Without statistics the footer is half the size.
pq.write_table(types, path_of('types.parquet'), compression='snappy', write_statistics=False)

# ---------------------------------------------------------------- rows by a formula, in every codec and layout
WORDS = ['alpha', 'beta', 'gamma', 'delta', 'Ωmega']


def rows(n, nested=True):
    columns = {
        'id': pa.array(range(n), pa.int64()),
        'word': pa.array([f'{WORDS[i % 5]}-{i}' for i in range(n)], pa.string()),
        'ratio': pa.array([i / 8 for i in range(n)], pa.float64()),
        'note': pa.array([None if i % 3 == 0 else f'note {i}' for i in range(n)], pa.string()),
    }
    if nested:
        columns['tags'] = pa.array([[WORDS[i % 5], WORDS[(i + 1) % 5]] if i % 4 else [] for i in range(n)], pa.list_(pa.string()))
    return pa.table(columns)


# Without a dictionary the texts are in the data pages, where the codec has something to do.
for codec in ['none', 'snappy', 'gzip', 'brotli', 'zstd', 'lz4']:
    pq.write_table(rows(40), path_of(f'codec_{codec}.parquet'), compression=codec, use_dictionary=False, write_statistics=False)
pq.write_table(rows(40), path_of('page_v2.parquet'), compression='gzip', data_page_version='2.0', write_statistics=False)
pq.write_table(rows(40, nested=False), path_of('page_v2_delta.parquet'), compression='snappy', data_page_version='2.0', use_dictionary=False, write_statistics=False,
               column_encoding={'id': 'DELTA_BINARY_PACKED', 'word': 'DELTA_BYTE_ARRAY', 'ratio': 'BYTE_STREAM_SPLIT', 'note': 'DELTA_LENGTH_BYTE_ARRAY'})
pq.write_table(rows(40), path_of('row_groups.parquet'), compression='snappy', row_group_size=15, write_statistics=False)
pq.write_table(rows(0), path_of('no_rows.parquet'), write_statistics=False)
pq.write_table(pa.table({}), path_of('no_columns.parquet'))
# An encoding the reader doesn't know in a data page of version 1: the column is left empty, the other one is read.
pq.write_table(rows(40).select(['id', 'word']), path_of('unread_column.parquet'), compression='none', use_dictionary=False, write_statistics=False,
               column_encoding={'word': 'DELTA_BYTE_ARRAY'})

# Timestamps as the 96-bit integers of old writers, and decimals kept in integers instead of bytes.
pq.write_table(pa.table({'ts': pa.array([0, 1709210096789012345, None, -1], pa.timestamp('ns'))}), path_of('int96.parquet'), use_deprecated_int96_timestamps=True, write_statistics=False)
pq.write_table(pa.table({
    'in_int32': pa.array([D('1.10'), D('-0.57'), None, D('9999999.99')], pa.decimal128(9, 2)),
    'in_int64': pa.array([D('12345678901234.5678'), D('-0.0001'), None, D('0')], pa.decimal128(18, 4)),
}), path_of('decimal_int.parquet'), store_decimal_as_integer=True, write_statistics=False)

# One row more than the viewer shows. The same value a million times takes a few bytes.
pq.write_table(pa.table({'n': pa.array([7] * 1_000_001, pa.int8())}), path_of('rows_over.parquet'), compression='snappy', write_statistics=False)


# ---------------------------------------------------------------- written by hand: what pyarrow doesn't write
# pyarrow writes LZ4 as bare blocks only (the codec LZ4_RAW). The older codec LZ4 is Hadoop's framing:
# blocks, each after its decoded and its encoded length. So that file is put together here, in Thrift's
# compact protocol, and pyarrow reads it back below to show that it is a Parquet file.
def varint(value):
    data = bytearray()
    while value >= 0x80:
        data.append(value & 0x7f | 0x80)
        value >>= 7
    data.append(value)
    return bytes(data)


def zigzag(value):
    return varint((value << 1) ^ (value >> 63))


def record(*fields):
    """A Thrift struct: fields as (id, type, bytes), in rising order of their ids."""
    data = b''
    last = 0
    for number, kind, body in fields:
        data += bytes([(number - last) << 4 | kind]) + body
        last = number
    return data + b'\0'


def i32(number, value):
    return (number, 5, zigzag(value))


def i64(number, value):
    return (number, 6, zigzag(value))


def text(number, value):
    return (number, 8, varint(len(value)) + value)


def items(number, kind, values):
    return (number, 9, bytes([len(values) << 4 | kind]) + b''.join(values))


def inner(number, body):
    return (number, 12, body)


INT32, BYTE_ARRAY = 1, 6
UNCOMPRESSED, LZO, LZ4 = 0, 3, 5


def by_hand(name, codec, pack, n=40, children=None, levels=b'', encoding=0, path=None):
    """
    The columns `id` and `word` of rows(), each in one plain data page packed by `pack`. The other
    arguments are for the damaged files: a number of children for the column `id`, levels in front of
    its values (which makes it an optional column), the encoding its page names, and the path that the
    chunk of the column `word` gives for its place in the schema.
    """
    numbers = b''.join(struct.pack('<i', i) for i in range(n))
    if levels:
        numbers = struct.pack('<I', len(levels)) + levels + numbers
    pages = [
        (b'id', INT32, numbers, None),
        (b'word', BYTE_ARRAY, b''.join(struct.pack('<I', len(w)) + w for w in (f'{WORDS[i % 5]}-{i}'.encode() for i in range(n))), 0),
    ]
    data = b'PAR1'
    schema = [record(text(4, b'schema'), i32(5, len(pages)))]
    chunks = []
    for column, kind, values, converted in pages:
        first = column == b'id'
        packed = pack(values)
        header = record(i32(1, 0), i32(2, len(values)), i32(3, len(packed)), inner(5, record(i32(1, n), i32(2, encoding if first else 0), i32(3, 3), i32(4, 3))))
        place = column if first or path is None else path
        chunks.append(record(i64(2, len(data)), inner(3, record(
            i32(1, kind), items(2, 5, [zigzag(0)]), items(3, 8, [varint(len(place)) + place]), i32(4, codec), i64(5, n),
            i64(6, len(header) + len(values)), i64(7, len(header) + len(packed)), i64(9, len(data))))))
        schema.append(record(
            i32(1, kind), i32(3, 1 if first and levels else 0), text(4, column),
            *([i32(5, children)] if first and children is not None else []), *([i32(6, converted)] if converted is not None else [])))
        data += header + packed
    group = record(items(1, 12, chunks), i64(2, len(data) - 4), i64(3, n))
    footer = record(i32(1, 1), items(2, 12, schema), i64(3, n), items(4, 12, [group]), text(6, b'make.py of the Previewix tests'))
    with open(path_of(name), 'wb') as file:
        file.write(data + footer + struct.pack('<I', len(footer)) + b'PAR1')


def block(values):
    return lz4.block.compress(values, store_size=False)


def hadoop(values):
    # Two frames to a page, as a writer makes them of a large buffer.
    half = len(values) // 2
    return b''.join(struct.pack('>II', len(part), len(block(part))) + block(part) for part in (values[:half], values[half:]))


def plain(values):
    return values


by_hand('lz4_hadoop.parquet', LZ4, hadoop)
# Some writers name the old codec and put a bare block there.
by_hand('lz4_hadoop_bare.parquet', LZ4, block)
# A codec the viewer refuses in words. The pages are not LZO: nothing gets as far as reading them.
by_hand('lzo.parquet', LZO, plain)

for name in ['lz4_hadoop.parquet', 'lz4_hadoop_bare.parquet']:
    back = pq.read_table(path_of(name))
    assert back.column('id').to_pylist() == list(range(40)) and back.column('word').to_pylist() == rows(40).column('word').to_pylist(), name

# Damage of three kinds, each of which the reader has to answer with words instead of working on forever
# or dying (see "Damage" in the test):
# a column that claims to have -1 children,
by_hand('damaged_children.parquet', UNCOMPRESSED, plain, children=-1)
# levels that begin with a run of 2,147,483,632 repeated values, in a page of 40 (E0 FF FF FF 0F is that
# number, doubled, as a varint; 01 is the value),
by_hand('damaged_run.parquet', UNCOMPRESSED, plain, levels=bytes([0xe0, 0xff, 0xff, 0xff, 0x0f, 0x01]))
# and two columns that fail in different ways: a page in an encoding that does not exist, and a chunk
# that names a column the schema does not have.
by_hand('damaged_twice.parquet', UNCOMPRESSED, plain, encoding=99, path=b'nope')

# ---------------------------------------------------------------- what pyarrow reads back
for name in sorted(os.listdir(out)):
    if name.endswith('.parquet') and name != 'lzo.parquet' and not name.startswith('damaged_'):
        file = pq.ParquetFile(path_of(name))
        meta = file.metadata
        codecs = sorted({meta.row_group(g).column(c).compression for g in range(meta.num_row_groups) for c in range(meta.num_columns)})
        print(f'{name}: {os.path.getsize(path_of(name))} bytes, {meta.num_rows} rows, {meta.num_row_groups} row groups, {", ".join(codecs)}')
print()
back = pq.read_table(path_of('types.parquet'))
for field in back.schema:
    column = back.column(field.name)
    kind = field.type
    if pa.types.is_dictionary(kind):
        column = column.cast(kind.value_type)
    # As integers, so that nothing is lost to the range of Python's own dates and times.
    if pa.types.is_timestamp(kind) or pa.types.is_time64(kind) or pa.types.is_duration(kind):
        column = column.cast(pa.int64())
    elif pa.types.is_time32(kind):
        column = column.cast(pa.int32())
    print(f'{field.name!r} [{field.type}{"" if field.nullable else " not null"}]: {column.to_pylist()!r}')
