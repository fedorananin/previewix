import { ByteReader, CHUNK, ENDS_EARLY, Input } from './stream';

// The filters that xz and 7z put in front of a compressor. A branch filter turns the relative
// addresses in machine code into absolute ones, which repeat and so pack better; these functions
// turn them back. They follow the public-domain decoders of XZ Embedded and the LZMA SDK.

/** Converts the start of `buf` in place and returns how many bytes are final; the rest is offered again with more data. */
type Convert = (buf: Uint8Array, position: number) => number;

function zeroOrFull(byte: number): boolean {
  return byte === 0x00 || byte === 0xff;
}

const X86_ALLOWED = [true, true, true, false, true, false, false, false];
const X86_BIT = [0, 1, 2, 2, 3, 3, 3, 3];

function x86(): Convert {
  let prevMask = 0;
  return (buf, position) => {
    if (buf.length <= 4) {
      return 0;
    }
    const size = buf.length - 4;
    let prevPos = -1;
    let i = 0;
    for (; i < size; i++) {
      if ((buf[i] & 0xfe) !== 0xe8) {
        continue;
      }
      prevPos = i - prevPos;
      if (prevPos > 3) {
        prevMask = 0;
      } else {
        prevMask = (prevMask << (prevPos - 1)) & 7;
        if (prevMask !== 0) {
          const byte = buf[i + 4 - X86_BIT[prevMask]];
          if (!X86_ALLOWED[prevMask] || zeroOrFull(byte)) {
            prevPos = i;
            prevMask = (prevMask << 1) | 1;
            continue;
          }
        }
      }
      prevPos = i;
      if (zeroOrFull(buf[i + 4])) {
        let src = (buf[i + 1] | (buf[i + 2] << 8) | (buf[i + 3] << 16) | (buf[i + 4] << 24)) >>> 0;
        let dest: number;
        for (;;) {
          dest = (src - (position + i + 5)) >>> 0;
          if (prevMask === 0) {
            break;
          }
          const shift = X86_BIT[prevMask] * 8;
          if (!zeroOrFull((dest >>> (24 - shift)) & 0xff)) {
            break;
          }
          src = (dest ^ ((2 ** (32 - shift) - 1) >>> 0)) >>> 0;
        }
        dest &= 0x01ffffff;
        dest = (dest | (0 - (dest & 0x01000000))) >>> 0;
        buf[i + 1] = dest;
        buf[i + 2] = dest >>> 8;
        buf[i + 3] = dest >>> 16;
        buf[i + 4] = dest >>> 24;
        i += 4;
      } else {
        prevMask = (prevMask << 1) | 1;
      }
    }
    prevPos = i - prevPos;
    prevMask = prevPos > 3 ? 0 : prevMask << (prevPos - 1);
    return i;
  };
}

function arm(): Convert {
  return (buf, position) => {
    let i = 0;
    for (; i + 4 <= buf.length; i += 4) {
      if (buf[i + 3] === 0xeb) {
        let address = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)) << 2;
        address = (address - (position + i + 8)) >>> 2;
        buf[i] = address;
        buf[i + 1] = address >>> 8;
        buf[i + 2] = address >>> 16;
      }
    }
    return i;
  };
}

function armThumb(): Convert {
  return (buf, position) => {
    let i = 0;
    for (; i + 4 <= buf.length; i += 2) {
      if ((buf[i + 1] & 0xf8) === 0xf0 && (buf[i + 3] & 0xf8) === 0xf8) {
        let address = ((buf[i + 1] & 7) << 19) | (buf[i] << 11) | ((buf[i + 3] & 7) << 8) | buf[i + 2];
        address = ((address << 1) - (position + i + 4)) >>> 1;
        buf[i + 1] = 0xf0 | ((address >>> 19) & 7);
        buf[i] = address >>> 11;
        buf[i + 3] = 0xf8 | ((address >>> 8) & 7);
        buf[i + 2] = address;
        i += 2;
      }
    }
    return i;
  };
}

function arm64(): Convert {
  return (buf, position) => {
    let i = 0;
    for (; i + 4 <= buf.length; i += 4) {
      let instruction = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0;
      const pc = (position + i) >>> 0;
      if ((instruction & 0xfc000000) >>> 0 === 0x94000000) {
        // BL: a 26-bit distance in instructions.
        instruction = (0x94000000 | ((instruction - (pc >>> 2)) & 0x03ffffff)) >>> 0;
      } else if ((instruction & 0x9f000000) >>> 0 === 0x90000000) {
        // ADRP: a distance in 4 KB pages. Only those within ±2 GB were converted.
        const src = ((instruction >>> 29) & 3) | ((instruction >>> 3) & 0x001ffffc);
        if ((src + 0x00020000) & 0x001c0000) {
          continue;
        }
        const dest = (src - (pc >>> 12)) >>> 0;
        instruction = ((instruction & 0x9000001f) | ((dest & 3) << 29) | ((dest & 0x0003fffc) << 3) | ((0 - (dest & 0x00020000)) & 0x00e00000)) >>> 0;
      } else {
        continue;
      }
      buf[i] = instruction;
      buf[i + 1] = instruction >>> 8;
      buf[i + 2] = instruction >>> 16;
      buf[i + 3] = instruction >>> 24;
    }
    return i;
  };
}

function powerpc(): Convert {
  return (buf, position) => {
    let i = 0;
    for (; i + 4 <= buf.length; i += 4) {
      if (buf[i] >> 2 === 0x12 && (buf[i + 3] & 3) === 1) {
        const src = (((buf[i] & 3) << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | (buf[i + 3] & 0xfc)) >>> 0;
        const dest = (src - (position + i)) >>> 0;
        buf[i] = 0x48 | ((dest >>> 24) & 3);
        buf[i + 1] = dest >>> 16;
        buf[i + 2] = dest >>> 8;
        buf[i + 3] = (buf[i + 3] & 3) | (dest & 0xfc);
      }
    }
    return i;
  };
}

function sparc(): Convert {
  return (buf, position) => {
    let i = 0;
    for (; i + 4 <= buf.length; i += 4) {
      if ((buf[i] === 0x40 && (buf[i + 1] & 0xc0) === 0) || (buf[i] === 0x7f && (buf[i + 1] & 0xc0) === 0xc0)) {
        const src = (((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) << 2) >>> 0;
        let dest = ((src - (position + i)) >>> 0) >>> 2;
        dest = ((((0 - ((dest >>> 22) & 1)) << 22) & 0x3fffffff) | (dest & 0x3fffff) | 0x40000000) >>> 0;
        buf[i] = dest >>> 24;
        buf[i + 1] = dest >>> 16;
        buf[i + 2] = dest >>> 8;
        buf[i + 3] = dest;
      }
    }
    return i;
  };
}

function delta(distance: number): Convert {
  const history = new Uint8Array(256);
  let at = 0;
  return (buf) => {
    for (let i = 0; i < buf.length; i++) {
      const byte = (buf[i] + history[(at + distance) & 0xff]) & 0xff;
      buf[i] = byte;
      history[at] = byte;
      at = (at - 1) & 0xff;
    }
    return buf.length;
  };
}

/** The filters by the number xz gives them; 7z uses the same numbers and some older ones (see sevenZip.ts). */
const FILTERS: Record<number, { name: string; make?: () => Convert }> = {
  0x04: { name: 'x86', make: x86 },
  0x05: { name: 'PowerPC', make: powerpc },
  0x06: { name: 'IA-64' },
  0x07: { name: 'ARM', make: arm },
  0x08: { name: 'ARM Thumb', make: armThumb },
  0x09: { name: 'SPARC', make: sparc },
  0x0a: { name: 'ARM64', make: arm64 },
  0x0b: { name: 'RISC-V' },
};

/** Why this filter can't be undone, or undefined when it can. */
export function filterProblem(id: number): string | undefined {
  if (id === 0x03) {
    return undefined;
  }
  const filter = FILTERS[id];
  return filter?.make ? undefined : `the ${filter?.name ?? `0x${id.toString(16)}`} filter`;
}

/** `src` with the filter undone. `props` are the filter's settings as stored. */
export function filterInput(id: number, props: Uint8Array, src: Input): Input {
  let convert: Convert;
  let position = 0;
  if (id === 0x03) {
    convert = delta((props[0] ?? 0) + 1);
  } else {
    const make = FILTERS[id]?.make;
    if (!make) {
      throw new Error(`Packed with ${filterProblem(id)}, which Previewix can't undo`);
    }
    convert = make();
    // Optional: the address the code was meant to be loaded at.
    position = props.length >= 4 ? (props[0] | (props[1] << 8) | (props[2] << 16) | (props[3] << 24)) >>> 0 : 0;
  }
  let held: Uint8Array = new Uint8Array(0);
  let ended = false;
  return {
    read() {
      while (!ended) {
        const piece = src.read();
        if (!piece) {
          ended = true;
          // What no instruction could be completed from is passed on as it is.
          return held.length ? held : undefined;
        }
        // Always a copy: the conversion is done in place, and the piece may belong to someone else.
        const work = Buffer.concat([held, piece]);
        const final = convert(work, position);
        position = (position + final) >>> 0;
        held = Buffer.from(work.subarray(final));
        if (final) {
          return work.subarray(0, final);
        }
      }
      return undefined;
    },
  };
}

/**
 * BCJ2, 7-Zip's filter for x86 code. The addresses of calls and jumps travel in streams of their
 * own, and a fourth, range-coded stream says which E8/E9/0F 8x bytes in the main stream have one.
 */
export function bcj2Input(main: Input, calls: Input, jumps: Input, flags: Input, size: number): Input {
  const mainRd = new ByteReader(main);
  const callRd = new ByteReader(calls);
  const jumpRd = new ByteReader(jumps);
  const rc = new ByteReader(flags);
  const probs = new Uint16Array(258).fill(1024);
  let range = 0xffffffff;
  let code = 0;
  let started = false;
  let previous = 0;
  let written = 0;

  return {
    read() {
      if (written >= size) {
        return undefined;
      }
      if (!started) {
        started = true;
        for (let i = 0; i < 5; i++) {
          code = (code * 256 + rc.byte()) % 0x100000000;
        }
      }
      const out = Buffer.allocUnsafeSlow(Math.min(CHUNK, size - written));
      let at = 0;
      while (at < out.length) {
        if (mainRd.pos >= mainRd.end && !mainRd.fill()) {
          throw new Error(ENDS_EARLY);
        }
        const byte = mainRd.buf[mainRd.pos++];
        out[at++] = byte;
        if ((byte & 0xfe) !== 0xe8 && !(previous === 0x0f && (byte & 0xf0) === 0x80)) {
          previous = byte;
          continue;
        }
        if (written + at >= size) {
          // The last byte of the output carries no flag.
          break;
        }
        const index = byte === 0xe8 ? previous : byte === 0xe9 ? 256 : 257;
        const prob = probs[index];
        const bound = (range >>> 11) * prob;
        let hit: boolean;
        if (code < bound) {
          range = bound;
          probs[index] = prob + ((2048 - prob) >>> 5);
          hit = false;
        } else {
          range -= bound;
          code -= bound;
          probs[index] = prob - (prob >>> 5);
          hit = true;
        }
        if (range < 0x1000000) {
          range *= 256;
          code = code * 256 + rc.byte();
        }
        if (!hit) {
          previous = byte;
          continue;
        }
        if (written + at + 4 > size) {
          throw new Error('The BCJ2 data is damaged');
        }
        if (at + 4 > out.length) {
          // No room for the address in this piece, which is made longer rather than split there.
          const rd = byte === 0xe8 ? callRd : jumpRd;
          const address = ((rd.byte() << 24) | (rd.byte() << 16) | (rd.byte() << 8) | rd.byte()) >>> 0;
          const dest = (address - (written + at + 4)) >>> 0;
          previous = dest >>> 24;
          written += at + 4;
          return Buffer.concat([out.subarray(0, at), Buffer.from([dest & 0xff, (dest >>> 8) & 0xff, (dest >>> 16) & 0xff, dest >>> 24])]);
        }
        const rd = byte === 0xe8 ? callRd : jumpRd;
        const address = ((rd.byte() << 24) | (rd.byte() << 16) | (rd.byte() << 8) | rd.byte()) >>> 0;
        const dest = (address - (written + at + 4)) >>> 0;
        out[at++] = dest;
        out[at++] = dest >>> 8;
        out[at++] = dest >>> 16;
        out[at++] = dest >>> 24;
        previous = dest >>> 24;
      }
      written += at;
      return out;
    },
  };
}
