import { Arena, ByteReader, CHUNK, ENDS_EARLY, Input } from './stream';

// bzip2 decoding: Huffman-coded, move-to-front-coded output of a Burrows-Wheeler transform,
// one block of up to 900 KB at a time.

const DAMAGED = 'The bzip2 data is damaged';
const MAX_GROUPS = 6;
const MAX_CODE_LENGTH = 20;
const MAX_SELECTORS = 18002;

let crcTable: Int32Array | undefined;

/** bzip2's CRC-32 runs from the top bit down, unlike the one of ZIP and gzip. */
function table(): Int32Array {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n << 24;
      for (let k = 0; k < 8; k++) {
        c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      }
      crcTable[n] = c;
    }
  }
  return crcTable;
}

/** The unpacked content of a .bz2 file: all of its streams, one after the other. */
export function bzip2Input(input: Input, arena?: Arena): Input {
  const rd = new ByteReader(input);
  const crcs = table();
  let bitBuffer = 0;
  let bitCount = 0;

  const bits = (count: number): number => {
    while (bitCount < count) {
      bitBuffer = ((bitBuffer << 8) | (rd.pos < rd.end ? rd.buf[rd.pos++] : rd.byte())) >>> 0;
      bitCount += 8;
      if (bitCount > 32) {
        // Never reached: at most 24 bits are asked for, with fewer than 8 left over.
        throw new Error(DAMAGED);
      }
    }
    bitCount -= count;
    return (bitBuffer >>> bitCount) & ((1 << count) - 1);
  };
  const bit = (): number => {
    if (!bitCount) {
      bitBuffer = rd.pos < rd.end ? rd.buf[rd.pos++] : rd.byte();
      bitCount = 8;
    }
    return (bitBuffer >>> --bitCount) & 1;
  };

  /** Block size of the stream in bytes; 0 before the first stream header. */
  let blockSize = 0;
  let tt = new Uint32Array(0);
  let streamCrc = 0;
  let first = true;
  let done = false;

  // The block that was read last: how many of its bytes are still to come, and where the next one is in `tt`.
  let left = 0;
  let tPos = 0;
  let storedCrc = 0;

  const limit = new Int32Array(MAX_GROUPS * (MAX_CODE_LENGTH + 2));
  const base = new Int32Array(MAX_GROUPS * (MAX_CODE_LENGTH + 2));
  const perm = new Int32Array(MAX_GROUPS * 258);
  const minLength = new Int32Array(MAX_GROUPS);
  const lengths = new Uint8Array(MAX_GROUPS * 258);
  const selectors = new Uint8Array(MAX_SELECTORS);
  const counts = new Int32Array(256);
  const symbols = new Uint8Array(256);
  const mtf = new Uint8Array(256);

  const streamHeader = (): boolean => {
    // Streams are whole bytes, so what is left of the last byte of the one before is dropped.
    bitCount = 0;
    if (!rd.fill()) {
      if (first) {
        throw new Error(ENDS_EARLY);
      }
      return false;
    }
    const magic = [rd.byte(), rd.fill() ? rd.byte() : 0, rd.fill() ? rd.byte() : 0, rd.fill() ? rd.byte() : 0];
    if (magic[0] !== 0x42 || magic[1] !== 0x5a || magic[2] !== 0x68 || magic[3] < 0x31 || magic[3] > 0x39) {
      if (first) {
        throw new Error('This is not a bzip2 file');
      }
      // Something else after the last stream: bzip2 itself ignores it.
      return false;
    }
    blockSize = (magic[3] - 0x30) * 100000;
    if (tt.length < blockSize) {
      tt = arena ? new Uint32Array(arena.take(blockSize * 4), 0, blockSize) : new Uint32Array(blockSize);
    }
    streamCrc = 0;
    first = false;
    return true;
  };

  /** Reads the next block into `tt`. Returns false at the end of the stream. */
  const readBlock = (): boolean => {
    const magicHigh = bits(24);
    const magicLow = bits(24);
    if (magicHigh === 0x177245 && magicLow === 0x385090) {
      const combined = (bits(16) * 65536 + bits(16)) >>> 0;
      if (combined !== streamCrc >>> 0) {
        throw new Error('The checksum of the bzip2 data does not match: the data is damaged');
      }
      return false;
    }
    if (magicHigh !== 0x314159 || magicLow !== 0x265359) {
      throw new Error(DAMAGED);
    }
    storedCrc = (bits(16) * 65536 + bits(16)) >>> 0;
    if (bit()) {
      throw new Error("The bzip2 data uses the randomised mode of very old versions, which Previewix can't unpack");
    }
    const origin = bits(24);

    // Which byte values occur, as a map in two levels.
    const used = bits(16);
    let inUse = 0;
    for (let i = 0; i < 16; i++) {
      if (used & (0x8000 >> i)) {
        const row = bits(16);
        for (let j = 0; j < 16; j++) {
          if (row & (0x8000 >> j)) {
            symbols[inUse++] = i * 16 + j;
          }
        }
      }
    }
    if (!inUse) {
      throw new Error(DAMAGED);
    }
    const alphabet = inUse + 2;

    const groups = bits(3);
    const selectorCount = bits(15);
    if (groups < 2 || groups > MAX_GROUPS || !selectorCount) {
      throw new Error(DAMAGED);
    }
    const order = [0, 1, 2, 3, 4, 5];
    for (let i = 0; i < selectorCount; i++) {
      let j = 0;
      while (bit()) {
        if (++j >= groups) {
          throw new Error(DAMAGED);
        }
      }
      const group = order[j];
      order.splice(j, 1);
      order.unshift(group);
      // Some encoders wrote more selectors than a block can use; the extra ones are read and dropped.
      if (i < MAX_SELECTORS) {
        selectors[i] = group;
      }
    }

    for (let g = 0; g < groups; g++) {
      let length = bits(5);
      for (let i = 0; i < alphabet; i++) {
        for (;;) {
          if (length < 1 || length > MAX_CODE_LENGTH) {
            throw new Error(DAMAGED);
          }
          if (!bit()) {
            break;
          }
          length += bit() ? -1 : 1;
        }
        lengths[g * 258 + i] = length;
      }
    }

    // Canonical Huffman tables: for every length the largest code and what to subtract from a code to get its place in `perm`.
    for (let g = 0; g < groups; g++) {
      const l = g * (MAX_CODE_LENGTH + 2);
      let min = MAX_CODE_LENGTH;
      let max = 1;
      for (let i = 0; i < alphabet; i++) {
        const length = lengths[g * 258 + i];
        min = Math.min(min, length);
        max = Math.max(max, length);
      }
      minLength[g] = min;
      let p = 0;
      for (let length = min; length <= max; length++) {
        for (let i = 0; i < alphabet; i++) {
          if (lengths[g * 258 + i] === length) {
            perm[g * 258 + p++] = i;
          }
        }
      }
      let code = 0;
      let index = 0;
      for (let length = 1; length <= MAX_CODE_LENGTH + 1; length++) {
        let count = 0;
        if (length >= min && length <= max) {
          for (let i = 0; i < alphabet; i++) {
            if (lengths[g * 258 + i] === length) {
              count++;
            }
          }
        }
        base[l + length] = index - code;
        code += count;
        index += count;
        limit[l + length] = length >= min && length <= max ? code - 1 : -1;
        code <<= 1;
      }
    }

    // The symbols: runs of the front byte, positions in the move-to-front list, and the end mark.
    counts.fill(0);
    for (let i = 0; i < 256; i++) {
      mtf[i] = i;
    }
    const endOfBlock = inUse + 1;
    let count = 0;
    let runLength = 0;
    let runWeight = 1;
    let group = 0;
    let groupLeft = 0;
    let selector = 0;
    for (;;) {
      if (!groupLeft) {
        if (selector >= selectorCount || selector >= MAX_SELECTORS) {
          throw new Error(DAMAGED);
        }
        group = selectors[selector++];
        groupLeft = 50;
      }
      groupLeft--;
      const l = group * (MAX_CODE_LENGTH + 2);
      let length = minLength[group];
      let code = bits(length);
      while (code > limit[l + length]) {
        if (++length > MAX_CODE_LENGTH) {
          throw new Error(DAMAGED);
        }
        code = (code << 1) | bit();
      }
      const place = code + base[l + length];
      if (place < 0 || place >= 258) {
        throw new Error(DAMAGED);
      }
      const symbol = perm[group * 258 + place];

      if (symbol <= 1) {
        // Run lengths are written in a base-2 system with the digits 1 and 2.
        runLength += runWeight << symbol;
        runWeight <<= 1;
        if (runLength > blockSize) {
          throw new Error(DAMAGED);
        }
        continue;
      }
      if (runLength) {
        const byte = symbols[mtf[0]];
        if (count + runLength > blockSize) {
          throw new Error(DAMAGED);
        }
        counts[byte] += runLength;
        tt.fill(byte, count, count + runLength);
        count += runLength;
        runLength = 0;
        runWeight = 1;
      }
      if (symbol === endOfBlock) {
        break;
      }
      if (count >= blockSize) {
        throw new Error(DAMAGED);
      }
      const front = mtf[symbol - 1];
      mtf.copyWithin(1, 0, symbol - 1);
      mtf[0] = front;
      const byte = symbols[front];
      counts[byte]++;
      tt[count++] = byte;
    }
    if (origin >= count) {
      throw new Error(DAMAGED);
    }

    // Undo the transform: every byte gets a link to the one that follows it in the text.
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = counts[i];
      counts[i] = sum;
      sum += c;
    }
    for (let i = 0; i < count; i++) {
      tt[counts[tt[i] & 0xff]++] |= i << 8;
    }
    tPos = tt[origin] >>> 8;
    left = count;
    return true;
  };

  /**
   * Turns the block in `tt` into its bytes, undoing the run-length layer on top. The pieces are
   * handed out only after the block's checksum has held, so nothing from a damaged block gets out.
   * (One block is 900 KB, or up to 46 MB when it is nothing but the longest runs.)
   */
  const expand = (): Buffer[] => {
    const pieces: Buffer[] = [];
    let crc = -1;
    /** The last byte, how often it came in a row, and copies of it still to write. */
    let last = -1;
    let run = 0;
    let repeat = 0;
    while (left || repeat) {
      const out = Buffer.allocUnsafeSlow(CHUNK);
      let at = 0;
      while (at < CHUNK) {
        if (repeat) {
          const n = Math.min(repeat, CHUNK - at);
          out.fill(last, at, at + n);
          for (let i = 0; i < n; i++) {
            crc = (crc << 8) ^ crcs[((crc >>> 24) ^ last) & 0xff];
          }
          at += n;
          repeat -= n;
          continue;
        }
        if (!left) {
          break;
        }
        const entry = tt[tPos];
        const byte = entry & 0xff;
        tPos = entry >>> 8;
        left--;
        if (run === 4) {
          // After four equal bytes comes a count of how many more follow.
          repeat = byte;
          run = 0;
          continue;
        }
        run = byte === last ? run + 1 : 1;
        last = byte;
        out[at++] = byte;
        crc = (crc << 8) ^ crcs[((crc >>> 24) ^ byte) & 0xff];
      }
      if (at) {
        pieces.push(at === CHUNK ? out : out.subarray(0, at));
      }
    }
    if (~crc >>> 0 !== storedCrc) {
      throw new Error('The checksum of the bzip2 data does not match: the data is damaged');
    }
    streamCrc = ((streamCrc << 1) | (streamCrc >>> 31)) ^ storedCrc;
    return pieces;
  };

  let pieces: Buffer[] = [];
  let next = 0;
  return {
    read() {
      for (;;) {
        if (next < pieces.length) {
          return pieces[next++];
        }
        if (done) {
          return undefined;
        }
        pieces = [];
        next = 0;
        if (!blockSize && !streamHeader()) {
          done = true;
          return undefined;
        }
        if (!readBlock()) {
          // The end of a stream; another one may follow.
          blockSize = 0;
          continue;
        }
        pieces = expand();
      }
    },
  };
}
