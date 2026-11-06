import { ascii } from './common';

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'ico' | 'heic' | 'tiff' | 'psd' | 'icns' | '';

/** How each format is named to the user. */
export const FORMAT_NAMES: Record<ImageFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  bmp: 'BMP',
  avif: 'AVIF',
  ico: 'ICO',
  heic: 'HEIC',
  tiff: 'TIFF',
  psd: 'PSD',
  icns: 'ICNS',
  '': 'image',
};

/** The brands of an ISO media file: the major one first, then the compatible ones. */
export function brandsOf(b: Uint8Array): string[] {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') {
    return [];
  }
  const end = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  const brands = [ascii(b, 8, 4)];
  for (let at = 16; at + 4 <= end; at += 4) {
    brands.push(ascii(b, at, 4));
  }
  return brands;
}

/** Tells the format from the content. The file extension is never asked: a renamed file still opens. */
export function sniffFormat(b: Uint8Array): ImageFormat {
  if (b.length < 12) {
    return '';
  }
  const start = ascii(b, 0, 12);
  if (start.startsWith('\x89PNG')) {
    return 'png';
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    return 'jpeg';
  }
  if (start.startsWith('GIF8')) {
    return 'gif';
  }
  if (start.startsWith('RIFF') && start.endsWith('WEBP')) {
    return 'webp';
  }
  if (start.startsWith('8BPS')) {
    return 'psd';
  }
  if (start.startsWith('icns')) {
    return 'icns';
  }
  if (/^(II[*+]\0|MM\0[*+])/.test(start)) {
    return 'tiff';
  }
  if (start.slice(4, 8) === 'ftyp') {
    // An AVIF picture is Chromium's to decode. Everything else in this container is HEVC or something libheif may know.
    return brandsOf(b).some((brand) => brand === 'avif' || brand === 'avis') ? 'avif' : 'heic';
  }
  if (start.startsWith('BM')) {
    return 'bmp';
  }
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) {
    return 'ico';
  }
  return '';
}
