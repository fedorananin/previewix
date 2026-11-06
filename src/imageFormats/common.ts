/** A decoded picture: straight (not premultiplied) RGBA, 8 bits per channel, top row first. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
  /** The ICC profile the RGB values are in, when the file carries one. */
  icc?: Uint8Array;
  /** Set when the file names its color space by code points instead of a profile. */
  colorSpace?: 'display-p3';
  /** What happened to the picture on the way to 8-bit sRGB, as rows for the info panel. */
  notes: [string, string][];
  /** Something the user has to know before trusting the colors. */
  warning?: string;
}

/** One of the pictures a file holds: a size of an icon, a page of a TIFF. */
export interface PageInfo {
  width: number;
  height: number;
  label: string;
}

/** A file, or a kind of file, that can't be shown. The message is written for the user. */
export class DecodeError extends Error {}

/** The largest area a canvas takes in Chromium (16384 × 16384), and its longest side. */
const MAX_PIXELS = 268_435_456;
const MAX_SIDE = 32_767;

export function checkSize(width: number, height: number): void {
  if (!(width > 0 && height > 0)) {
    throw new DecodeError('The file does not state a valid picture size.');
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new DecodeError(`The picture is ${width} × ${height} px, which is more than the editor can hold.`);
  }
}

export const ascii = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length));
export const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
export const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
export const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
export const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (b: Uint8Array, at = 0) => at + 24 <= b.length && PNG_MAGIC.every((byte, i) => b[at + i] === byte);

/** Rounds a 16-bit sample to 8 bits (65535 becomes 255, and the halves round rather than truncate). */
export const to8 = (value: number) => (value * 255 + 32767) >>> 16;

// ---- Colors that need arithmetic ----------------------------------------------

/** sRGB encoding of a linear value, by table: `Math.pow` per sample is too slow for a large picture. */
const GAMMA = (() => {
  const table = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) {
    const x = i / 4096;
    table[i] = Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
  }
  return table;
})();

export const encodeSrgb = (linear: number) => GAMMA[linear <= 0 ? 0 : linear >= 1 ? 4096 : (linear * 4096 + 0.5) | 0];

/**
 * CIE L*a*b* (D50, as Photoshop and TIFF store it) to sRGB, written into `out` at `at`.
 * Colors outside sRGB are clipped.
 */
export function labToSrgb(L: number, a: number, b: number, out: Uint8Array, at: number): void {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inverse = (f: number) => (f > 6 / 29 ? f * f * f : (f - 16 / 116) * 3 * (6 / 29) * (6 / 29));
  const x = 0.9642 * inverse(fx);
  const y = inverse(fy);
  const z = 0.8249 * inverse(fz);
  // XYZ relative to D50 into linear sRGB (the Bradford-adapted matrix).
  out[at] = encodeSrgb(3.1338561 * x - 1.6168667 * y - 0.4906146 * z);
  out[at + 1] = encodeSrgb(-0.9787684 * x + 1.9161415 * y + 0.033454 * z);
  out[at + 2] = encodeSrgb(0.0719453 * x - 0.2289914 * y + 1.4052427 * z);
}

/**
 * CMYK ink amounts (0 none, 255 full) to sRGB, written into `out` at `at`. The file's own profile is not used:
 * this is the polynomial fit of a common press profile (US Web Coated SWOP) that pdf.js uses for unmanaged CMYK,
 * which is far closer to print than the textbook (1 − C)(1 − K).
 */
export function cmykToSrgb(cyan: number, magenta: number, yellow: number, black: number, out: Uint8Array, at: number): void {
  const c = cyan / 255;
  const m = magenta / 255;
  const y = yellow / 255;
  const k = black / 255;
  // A Uint8Array rounds on its own but wraps around instead of clamping.
  const clamp = (value: number) => (value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value));
  out[at] = clamp(
    255 +
      c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k - 285.2331026137004) +
      m * (1.7149763477362134 * m - 5.6096736904047315 * y - 17.873870861415444 * k - 5.497006427196366) +
      y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
      k * (-21.86122147463605 * k - 189.48180835922747),
  );
  out[at + 1] = clamp(
    255 +
      c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k - 79.2970844816548) +
      m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) +
      y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
      k * (-20.737325471181034 * k - 187.80453709719578),
  );
  out[at + 2] = clamp(
    255 +
      c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k - 14.183576799673286) +
      m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) +
      y * (0.03296041114873217 * y + 115.60384449646641 * k - 193.58209356861505) +
      k * (-22.33816807309886 * k - 180.12613974708367),
  );
}

export const CMYK_WARNING = 'CMYK picture: shown through a generic conversion instead of its own color profile, so the colors are approximate.';
export const CMYK_NOTE: [string, string] = ['Color', 'CMYK, converted to sRGB with a generic press profile (approximate)'];

/** Turns colors that were stored multiplied by their alpha back into straight ones. */
export function unpremultiply(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha > 0 && alpha < 255) {
      const k = 255 / alpha;
      data[i] = Math.min(255, Math.round(data[i] * k));
      data[i + 1] = Math.min(255, Math.round(data[i + 1] * k));
      data[i + 2] = Math.min(255, Math.round(data[i + 2] * k));
    }
  }
}

/**
 * Turns a raster the way the TIFF/EXIF orientation tag (1 to 8) asks for.
 * Values 5 to 8 swap the sides.
 */
export function orient(raster: Raster, orientation: number): Raster {
  if (!(orientation >= 2 && orientation <= 8)) {
    return raster;
  }
  const { width: w, height: h } = raster;
  const swap = orientation >= 5;
  const [outW, outH] = swap ? [h, w] : [w, h];
  const source = new Uint32Array(raster.data.buffer, raster.data.byteOffset, w * h);
  const data = new Uint8Array(w * h * 4);
  const target = new Uint32Array(data.buffer);
  // For every orientation: where the stored pixel (x, y) lands in the upright picture.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let tx: number;
      let ty: number;
      switch (orientation) {
        case 2: tx = w - 1 - x; ty = y; break;
        case 3: tx = w - 1 - x; ty = h - 1 - y; break;
        case 4: tx = x; ty = h - 1 - y; break;
        case 5: tx = y; ty = x; break;
        case 6: tx = h - 1 - y; ty = x; break;
        case 7: tx = h - 1 - y; ty = w - 1 - x; break;
        default: tx = y; ty = w - 1 - x;
      }
      target[ty * outW + tx] = source[y * w + x];
    }
  }
  return { ...raster, width: outW, height: outH, data };
}

/** The name an ICC profile gives itself (its `desc` tag), or an empty string. */
export function iccName(icc: Uint8Array): string {
  try {
    const count = u32be(icc, 128);
    for (let i = 0; i < count && 132 + (i + 1) * 12 <= icc.length; i++) {
      const entry = 132 + i * 12;
      if (ascii(icc, entry, 4) !== 'desc') {
        continue;
      }
      const at = u32be(icc, entry + 4);
      const type = ascii(icc, at, 4);
      if (type === 'desc') {
        return ascii(icc, at + 12, Math.min(u32be(icc, at + 8) - 1, 200)).trim();
      }
      if (type === 'mluc' && u32be(icc, at + 8) > 0) {
        // The first record: its text is UTF-16, big-endian.
        const length = Math.min(u32be(icc, at + 20), 400);
        const start = at + u32be(icc, at + 24);
        let name = '';
        for (let p = start; p + 1 < start + length && p + 1 < icc.length; p += 2) {
          name += String.fromCharCode(u16be(icc, p));
        }
        return name.replace(/\0+$/, '').trim();
      }
    }
  } catch {
    // An unreadable profile simply has no name.
  }
  return '';
}
