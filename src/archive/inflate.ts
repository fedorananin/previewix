import { Arena, ByteReader, CHUNK, ENDS_EARLY, Input } from './stream';

// Deflate (RFC 1951) and Deflate64, pulled synchronously. Node's zlib unpacks plain Deflate much
// faster and is what ZIP entries normally go through; this decoder is for what zlib can't do:
// Deflate64, which Windows writes into ZIP archives for files over 2 GB, and Deflate as a coder
// in the middle of a 7z chain.

const DAMAGED = 'The Deflate data is damaged';

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153,
];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];
const LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A Huffman code as a lookup by the next `bits` bits: code length in the high half, symbol in the low. */
interface Table {
  map: Uint32Array;
  bits: number;
}

function build(lengths: Uint8Array): Table {
  const count = new Uint16Array(16);
  let bits = 0;
  for (const length of lengths) {
    if (length) {
      count[length]++;
      bits = Math.max(bits, length);
    }
  }
  const next = new Uint16Array(16);
  let code = 0;
  let room = 1;
  for (let length = 1; length <= 15; length++) {
    room = room * 2 - count[length];
    if (room < 0) {
      throw new Error(DAMAGED);
    }
    next[length] = code;
    code = (code + count[length]) << 1;
  }
  bits = Math.max(1, bits);
  const map = new Uint32Array(1 << bits);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (!length) {
      continue;
    }
    // Codes are defined from the top bit down but arrive from the bottom bit up.
    let reversed = 0;
    for (let i = 0, c = next[length]++; i < length; i++, c >>= 1) {
      reversed = (reversed << 1) | (c & 1);
    }
    for (let i = reversed; i < map.length; i += 1 << length) {
      map[i] = (length << 16) | symbol;
    }
  }
  return { map, bits };
}

let fixedLiterals: Table | undefined;
let fixedDistances: Table | undefined;

/** The unpacked content of a raw Deflate stream, or with `wide` of a Deflate64 one. */
export function inflateInput(src: Input, wide: boolean, arena?: Arena): Input {
  const rd = new ByteReader(src);
  const windowSize = wide ? 65536 : 32768;
  /** The window, the piece being made, and room for the one match that may run past it. */
  const bufSize = windowSize + CHUNK + 65540;
  const buf = arena ? new Uint8Array(arena.take(bufSize), 0, bufSize) : new Uint8Array(bufSize);
  let pos = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let last = false;
  let done = false;
  /** 0: between blocks, 1: in a stored block, 2: in a packed one. */
  let mode = 0;
  let stored = 0;
  let literals: Table | undefined;
  let distances: Table | undefined;

  const bits = (count: number): number => {
    while (bitCount < count) {
      bitBuffer |= rd.byte() << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << count) - 1);
    bitBuffer >>>= count;
    bitCount -= count;
    return value;
  };

  const symbol = (table: Table): number => {
    // The last code of the data may be shorter than the lookup is wide, so running out of input here is fine.
    while (bitCount < table.bits && (rd.pos < rd.end || rd.fill())) {
      bitBuffer |= rd.buf[rd.pos++] << bitCount;
      bitCount += 8;
    }
    const entry = table.map[bitBuffer & (table.map.length - 1)];
    const length = entry >>> 16;
    if (!length) {
      throw new Error(DAMAGED);
    }
    if (length > bitCount) {
      throw new Error(ENDS_EARLY);
    }
    bitBuffer >>>= length;
    bitCount -= length;
    return entry & 0xffff;
  };

  const blockHeader = () => {
    last = bits(1) === 1;
    const type = bits(2);
    if (type === 0) {
      bits(bitCount & 7);
      stored = bits(16);
      if ((stored ^ bits(16)) !== 0xffff) {
        throw new Error(DAMAGED);
      }
      mode = 1;
    } else if (type === 1) {
      if (!fixedLiterals || !fixedDistances) {
        const lengths = new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280);
        fixedLiterals = build(lengths);
        fixedDistances = build(new Uint8Array(32).fill(5));
      }
      literals = fixedLiterals;
      distances = fixedDistances;
      mode = 2;
    } else if (type === 2) {
      const literalCount = bits(5) + 257;
      const distanceCount = bits(5) + 1;
      const lengthCount = bits(4) + 4;
      if (literalCount > 286 || distanceCount > (wide ? 32 : 30)) {
        throw new Error(DAMAGED);
      }
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < lengthCount; i++) {
        codeLengths[LENGTH_ORDER[i]] = bits(3);
      }
      const lengthTable = build(codeLengths);
      const lengths = new Uint8Array(literalCount + distanceCount);
      for (let i = 0; i < lengths.length; ) {
        const code = symbol(lengthTable);
        if (code < 16) {
          lengths[i++] = code;
          continue;
        }
        let repeat: number;
        let value = 0;
        if (code === 16) {
          if (!i) {
            throw new Error(DAMAGED);
          }
          value = lengths[i - 1];
          repeat = 3 + bits(2);
        } else {
          repeat = code === 17 ? 3 + bits(3) : 11 + bits(7);
        }
        if (i + repeat > lengths.length) {
          throw new Error(DAMAGED);
        }
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
      if (!lengths[256]) {
        throw new Error(DAMAGED);
      }
      literals = build(lengths.subarray(0, literalCount));
      distances = build(lengths.subarray(literalCount));
      mode = 2;
    } else {
      throw new Error(DAMAGED);
    }
  };

  return {
    read() {
      if (done) {
        return undefined;
      }
      if (pos > windowSize) {
        buf.copyWithin(0, pos - windowSize, pos);
        pos = windowSize;
      }
      const start = pos;
      const limit = pos + CHUNK;
      while (pos < limit) {
        if (mode === 0) {
          if (last) {
            done = true;
            break;
          }
          blockHeader();
        } else if (mode === 1) {
          const take = Math.min(stored, limit - pos);
          let got = 0;
          // A stored block starts on a byte, but whole bytes may already wait in the bit buffer.
          while (got < take && bitCount) {
            buf[pos + got++] = bits(8);
          }
          while (got < take) {
            const piece = rd.some(take - got);
            if (!piece) {
              throw new Error(ENDS_EARLY);
            }
            buf.set(piece, pos + got);
            got += piece.length;
          }
          pos += take;
          stored -= take;
          if (!stored) {
            mode = 0;
          }
        } else {
          const code = symbol(literals as Table);
          if (code < 256) {
            buf[pos++] = code;
            continue;
          }
          if (code === 256) {
            mode = 0;
            continue;
          }
          const index = code - 257;
          if (index >= 29) {
            throw new Error(DAMAGED);
          }
          // Deflate64 turns the code for the longest match into one with 16 more bits of length.
          const length = wide && index === 28 ? 3 + bits(16) : LENGTH_BASE[index] + bits(LENGTH_EXTRA[index]);
          const slot = symbol(distances as Table);
          if (slot >= (wide ? 32 : 30)) {
            throw new Error(DAMAGED);
          }
          const distance = DISTANCE_BASE[slot] + bits(DISTANCE_EXTRA[slot]);
          if (distance > pos) {
            throw new Error(DAMAGED);
          }
          if (distance >= length) {
            buf.copyWithin(pos, pos - distance, pos - distance + length);
            pos += length;
          } else {
            for (let i = 0; i < length; i++, pos++) {
              buf[pos] = buf[pos - distance];
            }
          }
        }
      }
      if (pos === start) {
        return undefined;
      }
      const out = Buffer.allocUnsafeSlow(pos - start);
      out.set(buf.subarray(start, pos));
      return out;
    },
  };
}
