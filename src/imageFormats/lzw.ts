import { DecodeError } from './common';

const CLEAR = 256;
const END = 257;

/**
 * Unpacks TIFF's LZW: codes of 9 to 12 bits, most significant bit first, the width growing one code early.
 * Writes at most `stop − to` bytes into `out` and returns how many it wrote; fewer than asked means the stream
 * ended early or went wrong, and the rest is left as it was.
 *
 * It can't run away, whatever the bytes are: every pass of the loop consumes at least nine bits of input, an
 * entry of the table only ever points at an earlier one, so a string is as long as its entry says, and a code
 * the table doesn't have yet ends the stream instead of being followed.
 */
export function unpackLzw(b: Uint8Array, at: number, end: number, out: Uint8Array, to: number, stop: number): number {
  // The LZW of TIFF 5 and older counts bits from the other end and starts with a clear code that reads 00 01.
  if (end - at >= 2 && b[at] === 0 && (b[at + 1] & 1) === 1) {
    throw new DecodeError("This TIFF can't be shown: the old-style LZW compression of early TIFF writers is not supported.");
  }
  const start = to;
  stop = Math.min(stop, out.length);
  // An entry is the string of `prefix` with `last` added; `first` and `length` save walking it to find them.
  const prefix = new Uint16Array(4096);
  const last = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    last[i] = first[i] = i;
    length[i] = 1;
  }
  let next = 258;
  let width = 9;
  let previous = -1;
  let bits = 0;
  let held = 0;
  while (to < stop) {
    while (held < width && at < end) {
      bits = ((bits << 8) | b[at++]) & 0xffffff;
      held += 8;
    }
    if (held < width) {
      break;
    }
    held -= width;
    const code = (bits >>> held) & ((1 << width) - 1);
    if (code === END) {
      break;
    }
    if (code === CLEAR) {
      next = 258;
      width = 9;
      previous = -1;
      continue;
    }
    if (previous < 0) {
      // Right after a clear code only a plain byte can follow.
      if (code > 255) {
        break;
      }
      out[to++] = code;
      previous = code;
      continue;
    }
    // A code one past the table is the string before it with its own first byte repeated; anything further is damage.
    if (code > next || (code === next && next >= 4096)) {
      break;
    }
    const known = code < next;
    const string = known ? code : previous;
    const count = length[string] + (known ? 0 : 1);
    if (!known && to + count - 1 < stop) {
      out[to + count - 1] = first[previous];
    }
    for (let entry = string, place = to + length[string] - 1; place >= to; place--, entry = prefix[entry]) {
      if (place < stop) {
        out[place] = last[entry];
      }
    }
    to = Math.min(stop, to + count);
    if (next < 4096) {
      prefix[next] = previous;
      last[next] = first[string];
      first[next] = first[previous];
      length[next] = length[previous] + 1;
      next++;
      // "Early change": the codes get wider one entry before the table needs it.
      if (next + 1 === 1 << width && width < 12) {
        width++;
      }
    }
    previous = code;
  }
  return to - start;
}
