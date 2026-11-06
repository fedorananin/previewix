import { createHash } from 'crypto';
import { crc32 } from './common';
import { filterInput, filterProblem } from './filters';
import { lzma2Input } from './lzma';
import { ByteReader, Input } from './stream';

// The .xz container, after the format description of XZ Utils (xz-file-format.txt): streams of
// blocks, each a chain of filters ending in LZMA2 and followed by a checksum of its content.

const DAMAGED = 'The xz data is damaged';
const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

let crc64Low: Uint32Array | undefined;
let crc64High: Uint32Array | undefined;

/** CRC-64/XZ, the usual check of an .xz file, kept as two halves because bitwise operators stop at 32 bits. */
class Crc64 {
  private low = 0xffffffff;
  private high = 0xffffffff;

  constructor() {
    if (!crc64Low || !crc64High) {
      crc64Low = new Uint32Array(256);
      crc64High = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = BigInt(n);
        for (let k = 0; k < 8; k++) {
          c = c & 1n ? (c >> 1n) ^ 0xc96c5795d7870f42n : c >> 1n;
        }
        crc64Low[n] = Number(c & 0xffffffffn);
        crc64High[n] = Number(c >> 32n);
      }
    }
  }

  update(data: Uint8Array): void {
    const lowTable = crc64Low as Uint32Array;
    const highTable = crc64High as Uint32Array;
    let { low, high } = this;
    for (let i = 0; i < data.length; i++) {
      const index = (low ^ data[i]) & 0xff;
      low = ((low >>> 8) | (high << 24)) ^ lowTable[index];
      high = (high >>> 8) ^ highTable[index];
    }
    this.low = low;
    this.high = high;
  }

  matches(stored: Buffer): boolean {
    return stored.readUInt32LE(0) === ~this.low >>> 0 && stored.readUInt32LE(4) === ~this.high >>> 0;
  }
}

interface Check {
  update(data: Uint8Array): void;
  matches(stored: Buffer): boolean;
}

function checkOf(type: number): Check {
  if (type === 1) {
    let crc = 0;
    return { update: (data) => void (crc = crc32(data, crc)), matches: (stored) => stored.readUInt32LE(0) === crc };
  }
  if (type === 4) {
    return new Crc64();
  }
  if (type === 10) {
    const hash = createHash('sha256');
    return { update: (data) => void hash.update(data), matches: (stored) => hash.digest().equals(stored) };
  }
  // No check, or one of the kinds the format reserves and nothing writes.
  return { update: () => undefined, matches: () => true };
}

/** How many bytes a check of this type takes. */
function checkSize(type: number): number {
  return type === 0 ? 0 : 4 << Math.floor((type - 1) / 3);
}

/** The unpacked content of an .xz file: all of its streams, one after the other. */
export function xzInput(input: Input): Input {
  const rd = new ByteReader(input);
  let checkType = 0;
  let streamFlags: Buffer = Buffer.alloc(2);
  /** Unpadded and unpacked size of every block of the stream, to hold against its index. */
  let blocks: number[] = [];
  let inStream = false;
  let first = true;
  let done = false;

  let block: Input | undefined;
  let check: Check | undefined;
  let headerSize = 0;
  let dataStart = 0;
  let unpacked = 0;
  let declaredUnpacked: number | undefined;
  let declaredPacked: number | undefined;

  /** A number of up to 63 bits in groups of seven, as the format writes its sizes. */
  const varint = (from: () => number): number => {
    let value = 0;
    for (let i = 0; i < 9; i++) {
      const byte = from();
      value += (byte & 0x7f) * 2 ** (7 * i);
      if (!(byte & 0x80)) {
        if (byte === 0 && i > 0) {
          break;
        }
        return value;
      }
    }
    throw new Error(DAMAGED);
  };

  const streamHeader = () => {
    const header = rd.bytes(12);
    if (MAGIC.some((byte, i) => header[i] !== byte) || header[6] !== 0 || header[7] & 0xf0 || crc32(header.subarray(6, 8)) !== header.readUInt32LE(8)) {
      throw new Error(first ? 'This is not an xz file' : DAMAGED);
    }
    streamFlags = header.subarray(6, 8);
    checkType = header[7];
    blocks = [];
    inStream = true;
    first = false;
  };

  const blockHeader = (sizeByte: number) => {
    headerSize = (sizeByte + 1) * 4;
    const header = Buffer.concat([Buffer.from([sizeByte]), rd.bytes(headerSize - 1)]);
    if (crc32(header.subarray(0, headerSize - 4)) !== header.readUInt32LE(headerSize - 4)) {
      throw new Error(DAMAGED);
    }
    const flags = header[1];
    if (flags & 0x3c) {
      throw new Error(DAMAGED);
    }
    let at = 2;
    const next = () => {
      if (at >= headerSize - 4) {
        throw new Error(DAMAGED);
      }
      return header[at++];
    };
    declaredPacked = flags & 0x40 ? varint(next) : undefined;
    declaredUnpacked = flags & 0x80 ? varint(next) : undefined;
    const filters: { id: number; props: Buffer }[] = [];
    for (let i = (flags & 3) + 1; i > 0; i--) {
      const id = varint(next);
      const length = varint(next);
      if (at + length > headerSize - 4) {
        throw new Error(DAMAGED);
      }
      filters.push({ id, props: header.subarray(at, at + length) });
      at += length;
    }
    if (header.subarray(at, headerSize - 4).some((byte) => byte !== 0)) {
      throw new Error(DAMAGED);
    }
    const last = filters.pop() as { id: number; props: Buffer };
    if (last.id !== 0x21 || last.props.length !== 1) {
      throw new Error(DAMAGED);
    }
    for (const filter of filters) {
      const problem = filterProblem(filter.id);
      if (problem) {
        throw new Error(`The xz data uses ${problem}, which Previewix can't undo`);
      }
    }
    dataStart = rd.consumed;
    unpacked = 0;
    check = checkOf(checkType);
    block = lzma2Input(rd, last.props[0], declaredUnpacked);
    // The filters are listed in the order they were applied, so they are undone from the last one back.
    for (let i = filters.length - 1; i >= 0; i--) {
      block = filterInput(filters[i].id, filters[i].props, block);
    }
  };

  const blockEnd = () => {
    const packed = rd.consumed - dataStart;
    if ((declaredPacked !== undefined && declaredPacked !== packed) || (declaredUnpacked !== undefined && declaredUnpacked !== unpacked)) {
      throw new Error(DAMAGED);
    }
    for (let padding = (4 - (packed % 4)) % 4; padding > 0; padding--) {
      if (rd.byte() !== 0) {
        throw new Error(DAMAGED);
      }
    }
    if (!(check as Check).matches(rd.bytes(checkSize(checkType)))) {
      throw new Error('The checksum of the xz data does not match: the data is damaged');
    }
    blocks.push(headerSize + packed + checkSize(checkType), unpacked);
    block = undefined;
  };

  const indexAndFooter = () => {
    // The indicator byte, already read, is part of what the index's checksum covers.
    let crc = crc32(Buffer.from([0]));
    let size = 1;
    const next = () => {
      const byte = rd.byte();
      crc = crc32(Buffer.from([byte]), crc);
      size++;
      return byte;
    };
    if (varint(next) !== blocks.length / 2) {
      throw new Error(DAMAGED);
    }
    for (const expected of blocks) {
      if (varint(next) !== expected) {
        throw new Error(DAMAGED);
      }
    }
    while (size % 4) {
      if (next() !== 0) {
        throw new Error(DAMAGED);
      }
    }
    const footer = rd.bytes(16);
    if (
      footer.readUInt32LE(0) !== crc ||
      crc32(footer.subarray(8, 14)) !== footer.readUInt32LE(4) ||
      (footer.readUInt32LE(8) + 1) * 4 !== size + 4 ||
      !footer.subarray(12, 14).equals(streamFlags) ||
      footer[14] !== 0x59 ||
      footer[15] !== 0x5a
    ) {
      throw new Error(DAMAGED);
    }
    inStream = false;
  };

  return {
    read() {
      for (;;) {
        if (done) {
          return undefined;
        }
        if (block) {
          const piece = block.read();
          if (piece) {
            unpacked += piece.length;
            (check as Check).update(piece);
            return piece;
          }
          blockEnd();
          continue;
        }
        if (!inStream) {
          // Streams may be separated by zero bytes, four at a time.
          let padding = 0;
          while (rd.fill() && rd.buf[rd.pos] === 0) {
            rd.pos++;
            padding++;
          }
          if (!rd.fill() && !first) {
            done = true;
            if (padding % 4) {
              throw new Error(DAMAGED);
            }
            return undefined;
          }
          streamHeader();
          continue;
        }
        const sizeByte = rd.byte();
        if (sizeByte === 0) {
          indexAndFooter();
        } else {
          blockHeader(sizeByte);
        }
      }
    },
  };
}
