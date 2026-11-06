import { Raster } from './common';

/**
 * Wraps a raster and its ICC profile as a BMP file, as the parts of a `Blob`. This is how a profile from a
 * TIFF, PSD or HEIC file reaches Chromium's color management: its decoder honors the profile embedded in a
 * version 5 bitmap exactly as it does in a PNG or JPEG, and BMP is the one such format that needs no
 * compression and no checksum, so the pixels go in as they are.
 */
export function bmpWithProfile(raster: Raster, icc: Uint8Array): Uint8Array[] {
  const header = new Uint8Array(14 + 124);
  const view = new DataView(header.buffer);
  const pixels = raster.width * raster.height * 4;
  header[0] = 0x42;
  header[1] = 0x4d;
  view.setUint32(2, header.length + pixels + icc.length, true);
  view.setUint32(10, header.length, true);
  // BITMAPV5HEADER
  view.setUint32(14, 124, true);
  view.setInt32(18, raster.width, true);
  // A negative height: the top row comes first.
  view.setInt32(22, -raster.height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  // Bit fields, with masks that describe R, G, B, A in memory order, so nothing has to be reordered.
  view.setUint32(30, 3, true);
  view.setUint32(34, pixels, true);
  view.setUint32(54, 0x000000ff, true);
  view.setUint32(58, 0x0000ff00, true);
  view.setUint32(62, 0x00ff0000, true);
  view.setUint32(66, 0xff000000, true);
  // 'MBED': the color space is the embedded profile, found at an offset counted from the start of this header.
  view.setUint32(70, 0x4d424544, true);
  view.setUint32(122, 4, true);
  view.setUint32(126, 124 + pixels, true);
  view.setUint32(130, icc.length, true);
  return [header, raster.data, icc];
}

/** Whether a profile describes RGB data, which is the only kind a bitmap can carry. */
export function isRgbProfile(icc: Uint8Array): boolean {
  return icc.length > 132 && String.fromCharCode(icc[16], icc[17], icc[18], icc[19]) === 'RGB ' && String.fromCharCode(icc[36], icc[37], icc[38], icc[39]) === 'acsp';
}
