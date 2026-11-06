import exifr from 'exifr';
import * as zlib from 'zlib';
import { iccName } from './imageFormats/common';
import { readHeif } from './imageFormats/heif';
import { listIcns } from './imageFormats/icns';
import { listIco } from './imageFormats/ico';
import { PSD_MODES, readPsd } from './imageFormats/psd';
import { TIFF_COMPRESSIONS, TIFF_PHOTOMETRICS, listTiff } from './imageFormats/tiff';

export interface InfoSection {
  title: string;
  rows: [string, string][];
}

export interface ImageMeta {
  sections: InfoSection[];
  /** Decimal degrees, present when the file says where it was taken. */
  gps?: { lat: number; lon: number };
}

type Tags = Record<string, unknown>;

/** What the container itself says about the picture, read without decoding it. */
interface Header {
  format: string;
  width?: number;
  height?: number;
  depth?: string;
  color?: string;
  dpi?: [number, number];
  notes: [string, string][];
  /** Texts stored outside EXIF (PNG text chunks), by lower-case keyword. */
  texts: Record<string, string>;
  /** Raw TIFF and ICC payloads of containers exifr doesn't open (WebP, PSD). */
  exif?: Uint8Array;
  icc?: Uint8Array;
  /** The file is a container exifr can't be given: only `exif` is. */
  closed?: boolean;
  /**
   * How the container itself says the picture is turned (HEIF, AVIF). When set, the sizes above are already
   * those of the upright picture and the EXIF orientation is not applied, as decoders don't apply it either.
   */
  orientation?: string;
}

// ---- Container headers ------------------------------------------------------

const ascii = (b: Uint8Array, start: number, length: number) => String.fromCharCode(...b.subarray(start, start + length));
const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** The keywords of PNG text chunks that have a row in the panel, in lower case. */
const PNG_TEXTS = new Set(['title', 'author', 'description', 'copyright', 'software', 'creation time', 'comment']);

/** The most a compressed text chunk may unpack to. */
const MAX_TEXT = 1 << 20;

function inflated(data: Uint8Array): Uint8Array | undefined {
  try {
    return zlib.inflateSync(data, { maxOutputLength: MAX_TEXT });
  } catch {
    // Not a zlib stream, or one that grows past the limit: the chunk is passed over like any other damage.
    return undefined;
  }
}

function readPng(b: Uint8Array, h: Header): void {
  const v = viewOf(b);
  h.format = 'PNG';
  const colors: Record<number, [string, number]> = {
    0: ['Grayscale', 1],
    2: ['RGB', 3],
    3: ['Palette', 1],
    4: ['Grayscale with alpha', 2],
    6: ['RGB with alpha', 4],
  };
  for (let pos = 8; pos + 12 <= b.length; ) {
    const length = v.getUint32(pos);
    const type = ascii(b, pos + 4, 4);
    const data = pos + 8;
    if (data + length > b.length) {
      break;
    }
    if (type === 'IHDR') {
      h.width = v.getUint32(data);
      h.height = v.getUint32(data + 4);
      const bits = b[data + 8];
      const [name, channels] = colors[b[data + 9]] ?? ['', 1];
      h.color = name;
      h.depth = b[data + 9] === 3 ? `${bits}-bit palette` : `${bits} bits per channel${channels > 1 ? ` (${bits * channels} per pixel)` : ''}`;
      if (b[data + 12]) {
        h.notes.push(['Interlacing', 'Adam7']);
      }
    } else if (type === 'pHYs' && b[data + 8] === 1) {
      // Stored as pixels per metre.
      h.dpi = [v.getUint32(data) * 0.0254, v.getUint32(data + 4) * 0.0254];
    } else if (type === 'acTL') {
      h.notes.push(['Animation', `${v.getUint32(data)} frames (APNG)`]);
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const chunk = b.subarray(data, data + length);
      const split = chunk.indexOf(0);
      const key = split > 0 && split <= 79 ? ascii(chunk, 0, split).toLowerCase() : '';
      // tEXt: the text. zTXt: a method byte, then the text deflated. iTXt: a flag for "deflated", the method,
      // language\0, translated keyword\0, then the text. Only tEXt and zTXt are Latin-1.
      let text: Uint8Array | undefined;
      let packed = false;
      if (type === 'tEXt') {
        text = chunk.subarray(split + 1);
      } else if (type === 'zTXt') {
        packed = true;
        text = chunk.subarray(split + 2);
      } else {
        const language = chunk.indexOf(0, split + 3);
        const translated = language < 0 ? -1 : chunk.indexOf(0, language + 1);
        packed = chunk[split + 1] === 1;
        text = translated > 0 && chunk[split + 1] <= 1 ? chunk.subarray(translated + 1) : undefined;
      }
      if (key && text && packed) {
        // Only the keywords the panel shows are worth unpacking, and none of them is a megabyte of text:
        // the limit is what keeps a few bytes from unpacking into gigabytes.
        text = PNG_TEXTS.has(key) && chunk[split + 1 + (type === 'iTXt' ? 1 : 0)] === 0 ? inflated(text) : undefined;
      }
      if (key && text) {
        h.texts[key] = Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString(type === 'iTXt' ? 'utf8' : 'latin1');
      }
    }
    pos = data + length + 4;
  }
}

function readJpeg(b: Uint8Array, h: Header): void {
  const v = viewOf(b);
  h.format = 'JPEG';
  for (let pos = 2; pos + 4 <= b.length; ) {
    if (b[pos] !== 0xff) {
      break;
    }
    const marker = b[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    const length = v.getUint16(pos + 2);
    const data = pos + 4;
    if (marker === 0xe0 && ascii(b, data, 4) === 'JFIF' && b[data + 7] > 0) {
      const perInch = b[data + 7] === 1 ? 1 : 2.54;
      h.dpi = [v.getUint16(data + 8) * perInch, v.getUint16(data + 10) * perInch];
    }
    // Start of frame, except the markers in that range that mean something else.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      h.height = v.getUint16(data + 1);
      h.width = v.getUint16(data + 3);
      const components = b[data + 5];
      h.depth = `${b[data]} bits per channel`;
      h.color = ({ 1: 'Grayscale', 3: 'YCbCr', 4: 'CMYK' } as Record<number, string>)[components] ?? `${components} components`;
      const kinds: Record<number, string> = { 0xc0: 'Baseline', 0xc1: 'Extended sequential', 0xc2: 'Progressive', 0xc3: 'Lossless' };
      h.notes.push(['Compression', kinds[marker] ?? 'Arithmetic coding']);
      return;
    }
    if (marker === 0xda) {
      return;
    }
    pos = data + length - 2;
  }
}

function readWebp(b: Uint8Array, h: Header): void {
  const v = viewOf(b);
  let kind = '';
  let animated = false;
  for (let pos = 12; pos + 8 <= b.length; ) {
    const type = ascii(b, pos, 4);
    const length = v.getUint32(pos + 4, true);
    const data = pos + 8;
    if (type === 'VP8X') {
      animated = (b[data] & 0x02) !== 0;
      h.color = b[data] & 0x10 ? 'RGB with alpha' : 'RGB';
      h.width = (v.getUint32(data + 4, true) & 0xffffff) + 1;
      h.height = (v.getUint32(data + 7, true) & 0xffffff) + 1;
    } else if (type === 'VP8 ' && !kind) {
      kind = 'lossy';
      h.width ??= v.getUint16(data + 6, true) & 0x3fff;
      h.height ??= v.getUint16(data + 8, true) & 0x3fff;
      h.color ??= 'RGB';
    } else if (type === 'VP8L' && !kind) {
      kind = 'lossless';
      const bits = v.getUint32(data + 1, true);
      h.width ??= (bits & 0x3fff) + 1;
      h.height ??= ((bits >>> 14) & 0x3fff) + 1;
      h.color ??= bits & 0x10000000 ? 'RGB with alpha' : 'RGB';
    } else if (type === 'EXIF') {
      // Some writers keep the JPEG-style "Exif\0\0" prefix in front of the TIFF data.
      const start = ascii(b, data, 4) === 'Exif' ? data + 6 : data;
      h.exif = b.subarray(start, data + length);
    } else if (type === 'ICCP') {
      h.icc = b.subarray(data, data + length);
    } else if (type === 'ANMF' && !kind) {
      // The frames of an animation carry their own bitstream chunks.
      const inner = ascii(b, data + 16, 4);
      kind = inner === 'VP8L' ? 'lossless' : inner === 'VP8 ' ? 'lossy' : '';
    }
    pos = data + length + (length & 1);
  }
  h.format = `WebP${kind ? ` (${kind})` : ''}`;
  h.closed = true;
  h.depth = '8 bits per channel';
  if (animated) {
    h.notes.push(['Animation', 'Yes']);
  }
}

function readGif(b: Uint8Array, h: Header): void {
  const v = viewOf(b);
  h.format = `GIF (${ascii(b, 3, 3)})`;
  h.width = v.getUint16(6, true);
  h.height = v.getUint16(8, true);
  h.color = 'Palette';
  if (b[10] & 0x80) {
    h.depth = `${(b[10] & 7) + 1}-bit palette`;
  }
}

function readBmp(b: Uint8Array, h: Header): void {
  const v = viewOf(b);
  h.format = 'BMP';
  if (v.getUint32(14, true) < 40) {
    return;
  }
  h.width = Math.abs(v.getInt32(18, true));
  h.height = Math.abs(v.getInt32(22, true));
  const bits = v.getUint16(28, true);
  h.depth = bits <= 8 ? `${bits}-bit palette` : `${bits} bits per pixel`;
  h.color = bits <= 8 ? 'Palette' : bits === 32 ? 'RGB with alpha' : 'RGB';
  const [x, y] = [v.getInt32(38, true), v.getInt32(42, true)];
  if (x > 0 && y > 0) {
    h.dpi = [x * 0.0254, y * 0.0254];
  }
}

function readIco(b: Uint8Array, h: Header): void {
  const v = viewOf(b);
  h.format = v.getUint16(2, true) === 2 ? 'Cursor (CUR)' : 'Icon (ICO)';
  h.closed = true;
  // Largest first, which is also the one the editor opens on.
  const entries = listIco(b);
  if (entries.length) {
    h.width = entries[0].width;
    h.height = entries[0].height;
    h.depth = `${entries[0].bits} bits per pixel`;
  }
  if (entries.length > 1) {
    h.notes.push(['Sizes', entries.map((entry) => entry.label).join(', ')]);
  }
}

function readIcns(b: Uint8Array, h: Header): void {
  h.format = 'Apple icon (ICNS)';
  h.closed = true;
  const entries = listIcns(b);
  const shown = entries.find((entry) => entry.kind !== 'jp2') ?? entries[0];
  if (shown) {
    h.width = shown.width;
    h.height = shown.height;
  }
  const own = entries.filter((entry) => !entry.variant);
  if (own.length > 1) {
    h.notes.push(['Sizes', own.map((entry) => entry.label).join(', ')]);
  }
  const variants = [...new Set(entries.map((entry) => entry.variant).filter(Boolean))];
  if (variants.length) {
    h.notes.push(['Variants', variants.join('; ')]);
  }
}

function readTiff(b: Uint8Array, h: Header): void {
  h.format = b[2] === 43 || b[3] === 43 ? 'BigTIFF' : 'TIFF';
  const pages = listTiff(b);
  const page = pages[0];
  h.width = page.width;
  h.height = page.height;
  const total = page.bits * page.samples;
  h.depth = page.samples > 1 ? `${page.bits} bits per channel (${total} per pixel)` : `${page.bits} bit${page.bits === 1 ? '' : 's'} per pixel`;
  const extra = page.samples > 1 && (page.extra?.[0] === 1 || page.extra?.[0] === 2);
  h.color = `${TIFF_PHOTOMETRICS[page.photometric] ?? `Type ${page.photometric}`}${extra ? ' with alpha' : ''}`;
  h.dpi = page.dpi;
  h.icc = page.icc;
  h.notes.push(['Compression', TIFF_COMPRESSIONS[page.compression] ?? `Type ${page.compression}`]);
  if (page.tiled) {
    h.notes.push(['Layout', 'Tiles']);
  }
  if (pages.length > 1) {
    const sizes = new Set(pages.map((other) => `${other.width} × ${other.height}`));
    h.notes.push(['Pages', sizes.size > 1 ? `${pages.length} (${[...sizes].join(', ')})` : String(pages.length)]);
  }
}

function readPsdHeader(b: Uint8Array, h: Header): void {
  h.format = b[5] === 2 ? 'Photoshop large document (PSB)' : 'Photoshop (PSD)';
  h.closed = true;
  const psd = readPsd(b);
  h.width = psd.width;
  h.height = psd.height;
  h.depth = psd.depth === 1 ? '1 bit per pixel' : `${psd.depth} bits per channel`;
  h.color = `${PSD_MODES[psd.mode] ?? `Mode ${psd.mode}`}${psd.transparent ? ' with transparency' : ''}`;
  h.dpi = psd.dpi;
  h.exif = psd.exif;
  h.icc = psd.icc;
  h.notes.push(['Channels', String(psd.channels)]);
  if (psd.layers !== undefined) {
    h.notes.push(['Layers', `${psd.layers} (the flattened picture is shown)`]);
  }
  if (psd.composite === false) {
    h.notes.push(['Flattened picture', 'Not saved (Maximize Compatibility off)']);
  }
}

/** The EXIF orientations 1 to 8, as exifr words them. */
const HEIF_ORIENTATIONS = [
  'Normal',
  'Mirror horizontal',
  'Rotate 180',
  'Mirror vertical',
  'Mirror horizontal and rotate 270 CW',
  'Rotate 90 CW',
  'Mirror horizontal and rotate 90 CW',
  'Rotate 270 CW',
];

/** Names of the color primaries that are worth telling apart (ITU-T H.273). */
const PRIMARIES: Record<number, string> = { 1: 'BT.709 / sRGB', 9: 'BT.2020', 11: 'DCI-P3', 12: 'Display P3' };

function readHeifHeader(b: Uint8Array, h: Header): void {
  const heif = readHeif(b);
  if (!heif?.width || !heif.height) {
    // Boxes that can't be followed: the old way finds the size at least.
    readAvif(b, h);
    return;
  }
  const avif = heif.brands.some((brand) => brand === 'avif' || brand === 'avis');
  const coded = heif.codec === 'grid' ? ', tiled' : heif.codec === 'hvc1' || heif.codec === 'hev1' ? ', HEVC' : '';
  h.format = avif ? 'AVIF' : `HEIF (${heif.brands[0].trim()}${coded})`;
  const turned = heif.turns % 2 === 1;
  h.width = turned ? heif.height : heif.width;
  h.height = turned ? heif.width : heif.height;
  if (heif.bits) {
    h.depth = `${heif.bits} bits per channel`;
  }
  h.icc = heif.icc;
  // In the words EXIF has for the same eight cases, so a HEIC and the JPEG it was made from read alike.
  h.orientation = HEIF_ORIENTATIONS[heif.orientation - 1];
  if (!heif.icc && heif.nclx && PRIMARIES[heif.nclx.primaries]) {
    const hdr = heif.nclx.transfer === 16 ? ', PQ (HDR)' : heif.nclx.transfer === 18 ? ', HLG (HDR)' : '';
    h.notes.push(['Color primaries', PRIMARIES[heif.nclx.primaries] + hdr]);
  }
  if (heif.sequence) {
    h.notes.push(['Sequence', 'Yes']);
  }
}

function readAvif(b: Uint8Array, h: Header): void {
  h.format = ascii(b, 8, 4).startsWith('avi') ? 'AVIF' : 'HEIF';
  // The properties sit in the `meta` box near the start. Searching for their names
  // spares a walk through the box tree; the largest `ispe` is the main picture.
  const v = viewOf(b);
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 1 << 18)));
  for (let at = head.indexOf('ispe'); at >= 0 && at + 16 <= head.length; at = head.indexOf('ispe', at + 4)) {
    const width = v.getUint32(at + 8);
    const height = v.getUint32(at + 12);
    if (width * height > (h.width ?? 0) * (h.height ?? 0)) {
      h.width = width;
      h.height = height;
    }
  }
  const pixi = head.indexOf('pixi');
  if (pixi >= 0 && pixi + 10 <= head.length) {
    const channels = b[pixi + 8];
    if (channels >= 1 && channels <= 4) {
      h.depth = `${b[pixi + 9]} bits per channel`;
    }
  }
}

function readHeader(b: Uint8Array): Header {
  const h: Header = { format: '', notes: [], texts: {} };
  try {
    if (b.length < 12) {
      return h;
    }
    const start = ascii(b, 0, 12);
    if (start.startsWith('\x89PNG')) {
      readPng(b, h);
    } else if (b[0] === 0xff && b[1] === 0xd8) {
      readJpeg(b, h);
    } else if (start.startsWith('RIFF') && start.endsWith('WEBP')) {
      readWebp(b, h);
    } else if (start.startsWith('GIF8')) {
      readGif(b, h);
    } else if (start.startsWith('BM') && b.length >= 54) {
      readBmp(b, h);
    } else if (start.slice(4, 8) === 'ftyp') {
      readHeifHeader(b, h);
    } else if (start.startsWith('8BPS')) {
      readPsdHeader(b, h);
    } else if (start.startsWith('icns')) {
      readIcns(b, h);
    } else if (/^(II[*+]\0|MM\0[*+])/.test(start)) {
      readTiff(b, h);
    } else if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) {
      readIco(b, h);
    }
  } catch {
    // A truncated or damaged file keeps whatever was read before the trouble.
  }
  return h;
}

// ---- Formatting -------------------------------------------------------------

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Up to `digits` decimals, without trailing zeros. */
const trim = (value: number, digits = 1) => String(Number(value.toFixed(digits)));

function str(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    // Fixed-size EXIF fields are often padded with spaces or NULs.
    return value.replace(/\0+/g, ' ').trim();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(str).filter(Boolean).join(', ');
  }
  if (typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof Date)) {
    // XMP language alternatives arrive as { lang, value }.
    return str((value as Tags).value);
  }
  return '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  const short = kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(2)} MB`;
  return `${short} (${bytes.toLocaleString('en-US')} bytes)`;
}

function formatShutter(seconds: number): string {
  if (seconds <= 0) {
    return '';
  }
  // 0.3 s and longer are written as decimals on cameras too.
  return seconds < 0.3 ? `1/${Math.round(1 / seconds)} s` : `${trim(seconds)} s`;
}

function formatDate(value: unknown, offset?: unknown): string {
  let text = '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // exifr builds the date from the file's wall-clock digits in local time, so local getters give them back unchanged.
    const p = (n: number) => String(n).padStart(2, '0');
    text = `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  } else {
    text = str(value).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  }
  const zone = str(offset);
  return text && zone ? `${text} ${zone}` : text;
}

function formatCoordinate(value: number, positive: string, negative: string): string {
  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  let minutes = Math.floor((abs - degrees) * 60);
  let seconds = Number(((abs - degrees - minutes / 60) * 3600).toFixed(1));
  // Rounding may land on a full minute or degree.
  if (seconds >= 60) {
    seconds = 0;
    minutes++;
  }
  if (minutes >= 60) {
    minutes = 0;
    degrees++;
  }
  return `${degrees}°${String(minutes).padStart(2, '0')}′${seconds.toFixed(1).padStart(4, '0')}″ ${value < 0 ? negative : positive}`;
}

function push(rows: [string, string][], label: string, value: unknown): void {
  const text = typeof value === 'string' ? value.trim() : str(value);
  if (text && !rows.some(([existing]) => existing === label)) {
    rows.push([label, text]);
  }
}

// ---- Reading ----------------------------------------------------------------

const EXIFR_OPTIONS = {
  tiff: true,
  ifd0: true,
  exif: true,
  gps: true,
  interop: false,
  ifd1: false,
  makerNote: false,
  userComment: true,
  xmp: true,
  icc: true,
  iptc: true,
  jfif: false,
  ihdr: false,
  mergeOutput: false,
  translateValues: true,
  reviveValues: true,
  sanitize: true,
};

async function readTags(bytes: Uint8Array, header: Header): Promise<Record<string, Tags>> {
  try {
    // exifr doesn't open WebP or PSD, but the EXIF block in them is a plain TIFF structure, which it does.
    const input = header.closed ? header.exif : bytes;
    if (!input?.length) {
      return {};
    }
    return ((await exifr.parse(Buffer.from(input.buffer, input.byteOffset, input.byteLength), EXIFR_OPTIONS as never)) as Record<string, Tags>) ?? {};
  } catch {
    // No metadata, or a kind exifr can't read: the header still gives the file section.
    return {};
  }
}

/** Reads what an image file says about itself, as sections that are ready to be shown. */
export async function readImageMeta(bytes: Uint8Array): Promise<ImageMeta> {
  const header = readHeader(bytes);
  const tags = await readTags(bytes, header);
  const ifd0 = tags.ifd0 ?? {};
  const exif = tags.exif ?? {};
  const gps = tags.gps ?? {};
  const xmp = tags.xmp ?? {};
  const iptc = tags.iptc ?? {};
  const icc = tags.icc ?? {};
  const sections: InfoSection[] = [];
  const add = (title: string, rows: [string, string][]) => {
    if (rows.length) {
      sections.push({ title, rows });
    }
  };

  // ---- File
  const file: [string, string][] = [];
  push(file, 'Format', header.format);
  push(file, 'Size', formatSize(bytes.byteLength));
  // A HEIF container turns the picture itself; what EXIF says about it is then only a copy, and not always a true one.
  const orientation = header.orientation ?? str(ifd0.Orientation);
  let width = header.width ?? num(exif.ExifImageWidth);
  let height = header.height ?? num(exif.ExifImageHeight);
  if (width && height) {
    // The page shows the picture the way the orientation tag asks for, so the sides are named accordingly.
    if (header.orientation === undefined && /\b(90|270)\b/.test(orientation)) {
      [width, height] = [height, width];
    }
    const megapixels = (width * height) / 1e6;
    push(file, 'Dimensions', `${width} × ${height} px${megapixels >= 0.1 ? ` (${trim(megapixels)} MP)` : ''}`);
  }
  push(file, 'Bit depth', header.depth);
  push(file, 'Color type', header.color);
  let dpi = header.dpi;
  const [xRes, yRes] = [num(ifd0.XResolution), num(ifd0.YResolution)];
  if (xRes && yRes) {
    const perInch = /cm|centi/i.test(str(ifd0.ResolutionUnit)) || ifd0.ResolutionUnit === 3 ? 2.54 : 1;
    dpi = [xRes * perInch, yRes * perInch];
  }
  if (dpi && dpi[0] > 0 && dpi[1] > 0) {
    const [x, y] = [Math.round(dpi[0]), Math.round(dpi[1])];
    push(file, 'Resolution', x === y ? `${x} DPI` : `${x} × ${y} DPI`);
  }
  if (orientation && !/normal/i.test(orientation) && orientation !== '1') {
    push(file, 'Orientation', orientation);
  }
  for (const [label, value] of header.notes) {
    push(file, label, value);
  }
  add('File', file);

  // ---- Camera
  const camera: [string, string][] = [];
  push(camera, 'Make', ifd0.Make);
  push(camera, 'Model', ifd0.Model);
  push(camera, 'Lens', [str(exif.LensMake), str(exif.LensModel) || str(xmp.Lens)].filter(Boolean).join(' '));
  push(camera, 'Software', str(ifd0.Software) || str(xmp.CreatorTool) || header.texts.software);
  add('Camera', camera);

  // ---- Exposure
  const exposure: [string, string][] = [];
  const shutter = num(exif.ExposureTime);
  push(exposure, 'Shutter', shutter === undefined ? '' : formatShutter(shutter));
  const aperture = num(exif.FNumber);
  push(exposure, 'Aperture', aperture ? `f/${trim(aperture)}` : '');
  push(exposure, 'ISO', Array.isArray(exif.ISO) ? exif.ISO[0] : exif.ISO);
  const focal = num(exif.FocalLength);
  const focal35 = num(exif.FocalLengthIn35mmFormat);
  if (focal) {
    push(exposure, 'Focal length', `${trim(focal)} mm${focal35 && Math.round(focal35) !== Math.round(focal) ? ` (${trim(focal35, 0)} mm in 35 mm equivalent)` : ''}`);
  }
  const bias = num(exif.ExposureCompensation);
  if (bias) {
    push(exposure, 'Compensation', `${bias > 0 ? '+' : '−'}${trim(Math.abs(bias), 2)} EV`);
  }
  push(exposure, 'Flash', exif.Flash);
  push(exposure, 'Program', /^(not defined|unknown)?$/i.test(str(exif.ExposureProgram)) ? '' : exif.ExposureProgram);
  push(exposure, 'Metering', /^(unknown)?$/i.test(str(exif.MeteringMode)) ? '' : exif.MeteringMode);
  push(exposure, 'White balance', exif.WhiteBalance);
  add('Exposure', exposure);

  // ---- Dates
  const dates: [string, string][] = [];
  push(dates, 'Taken', formatDate(exif.DateTimeOriginal, exif.OffsetTimeOriginal));
  push(dates, 'Digitized', formatDate(exif.CreateDate, exif.OffsetTimeDigitized));
  push(dates, 'Modified', formatDate(ifd0.ModifyDate, exif.OffsetTime));
  if (!dates.length) {
    push(dates, 'Created', formatDate(xmp.CreateDate) || header.texts['creation time']);
    push(dates, 'Modified', formatDate(xmp.ModifyDate));
  }
  // The same moment three times over says nothing more than once.
  add('Dates', dates.filter(([, value], i) => i === 0 || value !== dates[0][1]));

  // ---- GPS
  const place: [string, string][] = [];
  const lat = num(gps.latitude);
  const lon = num(gps.longitude);
  // 0, 0 is what devices write when they had no fix.
  const located = lat !== undefined && lon !== undefined && (lat !== 0 || lon !== 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (located) {
    push(place, 'Coordinates', `${formatCoordinate(lat, 'N', 'S')}, ${formatCoordinate(lon, 'E', 'W')}`);
    push(place, 'Decimal', `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  }
  const altitude = num(gps.GPSAltitude);
  // Phones without a height reading write 0.
  if (altitude) {
    const ref = gps.GPSAltitudeRef;
    const below = ref === 1 || (ref instanceof Uint8Array && ref[0] === 1) || /below/i.test(str(ref));
    push(place, 'Altitude', `${trim(altitude)} m ${below ? 'below' : 'above'} sea level`);
  }
  const direction = num(gps.GPSImgDirection);
  if (direction !== undefined && located) {
    push(place, 'Direction', `${trim(direction, 0)}°`);
  }
  add('GPS', place);

  // ---- Color
  const color: [string, string][] = [];
  push(color, 'Profile', str(icc.ProfileDescription) || (header.icc ? iccName(header.icc) : ''));
  const space = str(exif.ColorSpace);
  push(color, 'Color space', space === '1' ? 'sRGB' : /^(65535|uncalibrated)$/i.test(space) ? 'Uncalibrated' : space);
  add('Color', color);

  // ---- Everything else worth a look
  const other: [string, string][] = [];
  push(other, 'Title', str(xmp.title) || str(iptc.ObjectName) || str(iptc.Headline) || header.texts.title);
  push(other, 'Description', str(ifd0.ImageDescription) || str(xmp.description) || str(iptc.Caption) || header.texts.description);
  push(other, 'Author', str(ifd0.Artist) || str(xmp.creator) || str(iptc.Byline) || header.texts.author);
  push(other, 'Copyright', str(ifd0.Copyright) || str(xmp.rights) || str(iptc.CopyrightNotice) || header.texts.copyright);
  push(other, 'Keywords', str(xmp.subject) || str(iptc.Keywords));
  push(other, 'Comment', str(exif.UserComment) || header.texts.comment);
  push(other, 'Rating', num(xmp.Rating) ? `${xmp.Rating} / 5` : '');
  add('Other', other);

  return { sections, gps: located ? { lat, lon } : undefined };
}
