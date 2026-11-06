import { Arena, ByteReader, CHUNK, ENDS_EARLY, Input } from './stream';

// LZMA and LZMA2 decoding, after the format description in the LZMA SDK (lzma-specification.txt).
// Used for 7z, xz and the LZMA method of ZIP.

const DAMAGED = 'The LZMA data is damaged';
/** A dictionary is one block of memory; 7-Zip's largest preset asks for 1.5 GB. */
const MAX_WINDOW = 1536 * 1024 * 1024;

// Where each group of probabilities starts in the one array that holds them all.
const IS_MATCH = 0;
const IS_REP = 192;
const IS_REP_G0 = 204;
const IS_REP_G1 = 216;
const IS_REP_G2 = 228;
const IS_REP0_LONG = 240;
const POS_SLOT = 432;
const POS_SPEC = 688;
const ALIGN = 803;
const LEN = 819;
const REP_LEN = 1333;
const LITERAL = 1847;

/** The dictionary: the last `size` bytes of output, written in a circle. */
class Window {
  readonly buf: Uint8Array;
  pos = 0;
  /** How many bytes behind `pos` a match may reach, at most `size`. */
  filled = 0;

  constructor(
    readonly size: number,
    arena?: Arena,
  ) {
    if (size > MAX_WINDOW) {
      throw new Error(`The data needs a dictionary of ${Math.ceil(size / 1048576).toLocaleString('en-US')} MB, which is more than Previewix allows`);
    }
    try {
      // Stale content does no harm: a match never reaches behind what was written since the last reset.
      this.buf = arena ? new Uint8Array(arena.take(size), 0, size) : new Uint8Array(size);
    } catch {
      throw new Error(`Not enough memory for a dictionary of ${Math.ceil(size / 1048576).toLocaleString('en-US')} MB`);
    }
  }
}

class Lzma {
  private probs = new Uint16Array(0);
  private lc = 0;
  private lpMask = 0;
  private pbMask = 0;
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  /** What is left of a match that didn't fit into the last `decode` call. */
  private pending = 0;
  private range = 0;
  private code = 0;
  /** Bytes produced since the dictionary was last reset; only its low bits matter. */
  processed = 0;

  constructor(
    private readonly rd: ByteReader,
    private readonly win: Window,
    private readonly arena?: Arena,
  ) {}

  setProps(byte: number, lzma2: boolean): void {
    if (byte >= 225) {
      throw new Error(DAMAGED);
    }
    const lc = byte % 9;
    const lp = Math.floor(byte / 9) % 5;
    const pb = Math.floor(byte / 45);
    if (lzma2 && lc + lp > 4) {
      throw new Error(DAMAGED);
    }
    this.lc = lc;
    this.lpMask = (1 << lp) - 1;
    this.pbMask = (1 << pb) - 1;
    const count = LITERAL + (0x300 << (lc + lp));
    if (this.probs.length !== count) {
      this.probs = this.arena ? new Uint16Array(this.arena.take(count * 2), 0, count) : new Uint16Array(count);
    }
    this.resetState();
  }

  resetState(): void {
    this.probs.fill(1024);
    this.state = this.rep0 = this.rep1 = this.rep2 = this.rep3 = this.pending = 0;
  }

  /** Starts the range decoder, which every LZMA stream and every LZMA2 chunk begins with. */
  start(): void {
    const { rd } = this;
    if (rd.byte() !== 0) {
      throw new Error(DAMAGED);
    }
    this.code = ((rd.byte() << 24) | (rd.byte() << 16) | (rd.byte() << 8) | rd.byte()) >>> 0;
    this.range = 0xffffffff;
  }

  private bit(index: number): number {
    const { probs } = this;
    const prob = probs[index];
    const bound = (this.range >>> 11) * prob;
    let result: number;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = prob + ((2048 - prob) >>> 5);
      result = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[index] = prob - (prob >>> 5);
      result = 1;
    }
    if (this.range < 0x1000000) {
      const { rd } = this;
      this.range *= 256;
      this.code = this.code * 256 + (rd.pos < rd.end ? rd.buf[rd.pos++] : rd.byte());
    }
    return result;
  }

  private tree(base: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) {
      m = (m << 1) | this.bit(base + m);
    }
    return m - (1 << bits);
  }

  private reverseTree(base: number, bits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i++) {
      const bit = this.bit(base + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }

  private direct(bits: number): number {
    let result = 0;
    const { rd } = this;
    for (let i = 0; i < bits; i++) {
      this.range = Math.floor(this.range / 2);
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      if (this.range < 0x1000000) {
        this.range *= 256;
        this.code = this.code * 256 + (rd.pos < rd.end ? rd.buf[rd.pos++] : rd.byte());
      }
      result = result * 2 + bit;
    }
    return result;
  }

  private length(base: number, posState: number): number {
    if (this.bit(base) === 0) {
      return this.tree(base + 2 + (posState << 3), 3);
    }
    if (this.bit(base + 1) === 0) {
      return 8 + this.tree(base + 130 + (posState << 3), 3);
    }
    return 16 + this.tree(base + 258, 8);
  }

  /**
   * Decodes `count` bytes into the window, which must have that much room before its end.
   * Returns how many were produced: fewer than asked only when the end marker was met.
   */
  decode(count: number): number {
    const { win } = this;
    const { buf, size } = win;
    const start = win.pos;
    const end = start + count;
    let pos = start;
    /** `filledBase + pos` is how far back a match may reach at `pos`, until the window is full. */
    const filledBase = win.filled - start;
    const full = win.filled >= size;
    const phase = (this.processed - start) % 16;
    let { state, rep0, rep1, rep2, rep3, pending } = this;

    while (pos < end) {
      if (pending) {
        let from = pos - rep0 - 1;
        if (from < 0) {
          from += size;
        }
        const run = Math.min(pending, end - pos);
        pending -= run;
        if (rep0 >= run && from + run <= size) {
          buf.copyWithin(pos, from, from + run);
          pos += run;
        } else {
          for (let i = 0; i < run; i++) {
            buf[pos++] = buf[from++];
            if (from === size) {
              from = 0;
            }
          }
        }
        continue;
      }

      const posState = (phase + pos) & this.pbMask;
      const reach = full ? size : filledBase + pos;
      if (this.bit(IS_MATCH + (state << 4) + posState) === 0) {
        const previous = reach ? buf[pos ? pos - 1 : size - 1] : 0;
        const base = LITERAL + 0x300 * ((((phase + pos) & this.lpMask) << this.lc) + (previous >> (8 - this.lc)));
        let symbol = 1;
        if (state >= 7) {
          let from = pos - rep0 - 1;
          if (from < 0) {
            from += size;
          }
          let matchByte = buf[from];
          do {
            const matchBit = (matchByte >> 7) & 1;
            matchByte <<= 1;
            const bit = this.bit(base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) {
              break;
            }
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) {
          symbol = (symbol << 1) | this.bit(base + symbol);
        }
        buf[pos++] = symbol;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }

      let length: number;
      if (this.bit(IS_REP + state) === 0) {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        length = this.length(LEN, posState);
        state = state < 7 ? 7 : 10;
        const slot = this.tree(POS_SLOT + (Math.min(length, 3) << 6), 6);
        if (slot < 4) {
          rep0 = slot;
        } else {
          const directBits = (slot >> 1) - 1;
          rep0 = ((2 | (slot & 1)) << directBits) >>> 0;
          if (slot < 14) {
            rep0 += this.reverseTree(POS_SPEC + rep0 - slot, directBits);
          } else {
            rep0 += this.direct(directBits - 4) * 16;
            rep0 += this.reverseTree(ALIGN, 4);
            if (rep0 === 0xffffffff) {
              // The end marker: the loop ends short of what was asked for.
              break;
            }
          }
        }
      } else {
        if (!reach) {
          throw new Error(DAMAGED);
        }
        if (this.bit(IS_REP_G0 + state) === 0) {
          if (this.bit(IS_REP0_LONG + (state << 4) + posState) === 0) {
            state = state < 7 ? 9 : 11;
            pending = 1;
            if (rep0 >= reach) {
              throw new Error(DAMAGED);
            }
            continue;
          }
        } else {
          let distance: number;
          if (this.bit(IS_REP_G1 + state) === 0) {
            distance = rep1;
          } else {
            if (this.bit(IS_REP_G2 + state) === 0) {
              distance = rep2;
            } else {
              distance = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = distance;
        }
        length = this.length(REP_LEN, posState);
        state = state < 7 ? 8 : 11;
      }
      if (rep0 >= reach) {
        throw new Error(DAMAGED);
      }
      pending = length + 2;
    }

    this.state = state;
    this.rep0 = rep0;
    this.rep1 = rep1;
    this.rep2 = rep2;
    this.rep3 = rep3;
    this.pending = pending;
    const produced = pos - start;
    win.pos = pos;
    win.filled = Math.min(size, win.filled + produced);
    this.processed += produced;
    return produced;
  }
}

function copyOf(buf: Uint8Array, start: number, end: number): Buffer {
  const out = Buffer.allocUnsafeSlow(end - start);
  out.set(buf.subarray(start, end));
  return out;
}

/**
 * The output of a plain LZMA stream: `props` are the five bytes that describe it (settings and
 * dictionary size). With `size` the stream is that long; without, it runs up to its end marker.
 */
export function lzmaInput(rd: ByteReader, props: Uint8Array, size: number | undefined, arena?: Arena): Input {
  if (props.length < 5) {
    throw new Error(DAMAGED);
  }
  const dictSize = Math.max(4096, (props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0);
  // Output shorter than the dictionary never wraps around, so it needs no more room than itself.
  const win = new Window(Math.max(1, size === undefined ? dictSize : Math.min(dictSize, size)), arena);
  const lzma = new Lzma(rd, win, arena);
  lzma.setProps(props[0], false);
  let left = size ?? Infinity;
  let started = false;
  let done = false;
  return {
    read() {
      if (done) {
        return undefined;
      }
      if (left === 0) {
        done = true;
        return undefined;
      }
      if (!started) {
        started = true;
        lzma.start();
      }
      if (win.pos === win.size) {
        win.pos = 0;
      }
      const from = win.pos;
      const want = Math.min(CHUNK, win.size - from, left);
      const got = lzma.decode(want);
      left -= got;
      if (got < want) {
        // The end marker. A stream of known length has to reach that length first.
        done = true;
        if (size !== undefined) {
          throw new Error(ENDS_EARLY);
        }
      }
      return got ? copyOf(win.buf, from, from + got) : undefined;
    },
  };
}

export function lzma2DictSize(prop: number): number {
  if (prop > 40) {
    throw new Error(DAMAGED);
  }
  return prop === 40 ? 0xffffffff : ((2 | (prop & 1)) << ((prop >> 1) + 11)) >>> 0;
}

/**
 * The output of an LZMA2 stream, which is a run of chunks, packed or not, up to a zero byte.
 * Reading stops right after that byte, so the caller can go on with what follows in `rd`.
 * `sizeHint` is the most the stream may produce, when that is known.
 */
export function lzma2Input(rd: ByteReader, dictProp: number, sizeHint?: number, arena?: Arena): Input {
  const dictSize = lzma2DictSize(dictProp);
  const win = new Window(Math.max(1, sizeHint === undefined ? dictSize : Math.min(dictSize, sizeHint)), arena);
  const lzma = new Lzma(rd, win, arena);
  let left = 0;
  let packed = false;
  let packEnd = 0;
  let needDict = true;
  let needProps = true;
  let done = false;

  const resetDict = () => {
    win.filled = 0;
    lzma.processed = 0;
    needDict = false;
  };

  return {
    read() {
      if (done) {
        return undefined;
      }
      if (!left) {
        const control = rd.byte();
        if (control === 0) {
          done = true;
          return undefined;
        }
        if (control >= 0x80) {
          left = ((control & 0x1f) << 16) + (rd.byte() << 8) + rd.byte() + 1;
          const packSize = (rd.byte() << 8) + rd.byte() + 1;
          const mode = (control >> 5) & 3;
          if (mode === 3) {
            resetDict();
          }
          if (mode >= 2) {
            lzma.setProps(rd.byte(), true);
            needProps = false;
          } else if (mode === 1) {
            lzma.resetState();
          }
          if (needDict || needProps) {
            throw new Error(DAMAGED);
          }
          packed = true;
          packEnd = rd.consumed + packSize;
          lzma.start();
        } else if (control <= 2) {
          if (control === 1) {
            resetDict();
            // What follows a fresh dictionary has to bring its own settings.
            needProps = true;
          } else if (needDict) {
            throw new Error(DAMAGED);
          }
          left = (rd.byte() << 8) + rd.byte() + 1;
          packed = false;
        } else {
          throw new Error(DAMAGED);
        }
      }

      if (win.pos === win.size) {
        win.pos = 0;
      }
      const from = win.pos;
      const want = Math.min(CHUNK, win.size - from, left);
      if (packed) {
        if (lzma.decode(want) < want) {
          throw new Error(DAMAGED);
        }
      } else {
        for (let done = 0; done < want; ) {
          const piece = rd.some(want - done);
          if (!piece) {
            throw new Error(ENDS_EARLY);
          }
          win.buf.set(piece, from + done);
          done += piece.length;
        }
        win.pos = from + want;
        win.filled = Math.min(win.size, win.filled + want);
        lzma.processed += want;
      }
      left -= want;
      // A chunk says how many bytes it takes; a decoder that used another number has lost its way.
      if (!left && packed && rd.consumed !== packEnd) {
        throw new Error(DAMAGED);
      }
      return copyOf(win.buf, from, from + want);
    },
  };
}
