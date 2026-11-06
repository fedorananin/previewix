import * as fs from 'fs';

/**
 * A run of bytes that is pulled synchronously: `read` returns the next piece, never an empty one,
 * and undefined at the end. The decoders written here (LZMA, xz, bzip2, the 7z coders) are chains
 * of these, which is why they run in a worker thread: nothing in a chain can wait for I/O.
 */
export interface Input {
  read(): Uint8Array | undefined;
}

export const ENDS_EARLY = 'The data ends too early';

/**
 * Working memory that the decoders of one job hand on to each other. An archive of 70,000 small
 * files starts 70,000 decoders, each with tables and a window of its own, and the garbage
 * collector is in no hurry with memory that lies outside its heap: without this, a gigabyte piles
 * up. Whoever starts decoders in a row passes them an arena and calls `release` between two of them.
 */
export class Arena {
  private free: ArrayBuffer[] = [];
  private lent: ArrayBuffer[] = [];

  /** At least `bytes` bytes. Their content is whatever the last user left there. */
  take(bytes: number): ArrayBuffer {
    let best = -1;
    for (let i = 0; i < this.free.length; i++) {
      const size = this.free[i].byteLength;
      // A much larger block is left for someone who needs it.
      if (size >= bytes && size <= bytes * 4 + 65536 && (best < 0 || size < this.free[best].byteLength)) {
        best = i;
      }
    }
    const block = best < 0 ? new ArrayBuffer(bytes) : this.free.splice(best, 1)[0];
    this.lent.push(block);
    return block;
  }

  /** Everything taken since the last call may be taken again. */
  release(): void {
    this.free.push(...this.lent);
    this.lent = [];
    // Nothing unpacks with more than a handful of decoders at once; what is beyond that is from a folder of another shape.
    while (this.free.length > 16) {
      this.free.shift();
    }
  }
}

/** Size of the pieces the decoders hand out. */
export const CHUNK = 256 * 1024;

/** Reads single bytes and small fields from an `Input`. Several decoders can share one reader and take turns. */
export class ByteReader {
  buf: Uint8Array = new Uint8Array(0);
  pos = 0;
  end = 0;
  /** Bytes of the pieces that came before the current one. */
  private before = 0;

  constructor(private readonly input: Input) {}

  /** Bytes taken so far. */
  get consumed(): number {
    return this.before + this.pos;
  }

  /** Makes sure a byte is available; false at the end of the data. */
  fill(): boolean {
    while (this.pos >= this.end) {
      const next = this.input.read();
      if (!next) {
        return false;
      }
      this.before += this.end;
      this.buf = next;
      this.pos = 0;
      this.end = next.length;
    }
    return true;
  }

  byte(): number {
    if (this.pos >= this.end && !this.fill()) {
      throw new Error(ENDS_EARLY);
    }
    return this.buf[this.pos++];
  }

  /** Exactly `length` bytes, in a buffer of their own. */
  bytes(length: number): Buffer {
    const out = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      if (this.pos >= this.end && !this.fill()) {
        throw new Error(ENDS_EARLY);
      }
      const take = Math.min(length - done, this.end - this.pos);
      out.set(this.buf.subarray(this.pos, this.pos + take), done);
      this.pos += take;
      done += take;
    }
    return out;
  }

  /** Up to `max` bytes of what is at hand, without copying; undefined at the end. */
  some(max: number): Uint8Array | undefined {
    if (this.pos >= this.end && !this.fill()) {
      return undefined;
    }
    const take = Math.min(max, this.end - this.pos);
    const out = this.buf.subarray(this.pos, this.pos + take);
    this.pos += take;
    return out;
  }
}

/** `length` bytes of an open file from `start` on. Throws when the file ends before that. */
export function fileInput(fd: number, start: number, length: number): Input {
  let position = start;
  let left = length;
  return {
    read() {
      if (left <= 0) {
        return undefined;
      }
      const buffer = Buffer.allocUnsafe(Math.min(left, CHUNK));
      const got = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!got) {
        throw new Error('The archive ends in the middle of the data');
      }
      position += got;
      left -= got;
      return got === buffer.length ? buffer : buffer.subarray(0, got);
    },
  };
}

/** The whole of an open file from `start` on, however long it is. */
export function restOfFile(fd: number, start = 0): Input {
  let position = start;
  return {
    read() {
      const buffer = Buffer.allocUnsafe(CHUNK);
      const got = fs.readSync(fd, buffer, 0, buffer.length, position);
      position += got;
      return got ? buffer.subarray(0, got) : undefined;
    },
  };
}

export function bufferInput(data: Uint8Array): Input {
  let done = data.length === 0;
  return {
    read() {
      if (done) {
        return undefined;
      }
      done = true;
      return data;
    },
  };
}

/** At most `length` bytes of `input`; throws when it has fewer. What follows in `input` is left unread. */
export function limited(reader: ByteReader, length: number): Input {
  let left = length;
  return {
    read() {
      if (left <= 0) {
        return undefined;
      }
      const piece = reader.some(Math.min(left, CHUNK));
      if (!piece) {
        throw new Error(ENDS_EARLY);
      }
      left -= piece.length;
      return piece;
    },
  };
}

/** Collects everything `input` has, refusing more than `max` bytes. */
export function readAll(input: Input, max: number): Buffer {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let piece = input.read(); piece; piece = input.read()) {
    size += piece.length;
    if (size > max) {
      throw new Error('The data is larger than the archive says');
    }
    parts.push(piece);
  }
  return Buffer.concat(parts, size);
}
