import { bmpWithProfile, isRgbProfile } from '../src/imageFormats/bmp';
import { DecodeError, iccName } from '../src/imageFormats/common';

/**
 * Makes the bitmap the page will draw. The raster's values are in the color space of its file, and the
 * canvas of the page is sRGB: tagging the bitmap with that color space lets Chromium convert on drawing,
 * as it does for a PNG or JPEG with a profile.
 */
async function toBitmap(raster) {
  const { width, height, data, icc } = raster;
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const name = icc ? iccName(icc) || 'Embedded' : '';
  if (icc && isRgbProfile(icc)) {
    try {
      const bitmap = await createImageBitmap(new Blob(bmpWithProfile(raster, icc), { type: 'image/bmp' }));
      // Saying so for plain sRGB would only be noise.
      if (!/^sRGB\b/i.test(name)) {
        raster.notes.unshift(['Color', `${name} profile, converted to sRGB for display and export`]);
      }
      return bitmap;
    } catch {
      raster.notes.unshift(['Color', `${name} profile could not be applied; the values are shown as sRGB`]);
    }
  } else if (icc) {
    raster.notes.unshift(['Color', `${name} profile is not an RGB profile and was not applied`]);
  }
  if (raster.colorSpace === 'display-p3') {
    try {
      const bitmap = await createImageBitmap(new ImageData(pixels, width, height, { colorSpace: 'display-p3' }));
      raster.notes.unshift(['Color', 'Display P3, converted to sRGB for display and export']);
      return bitmap;
    } catch {
      raster.notes.unshift(['Color', 'Display P3 could not be converted; the values are shown as sRGB']);
    }
  }
  return createImageBitmap(new ImageData(pixels, width, height));
}

/** What went wrong, in words for the user. Decoders throw `DecodeError` for what they refuse on purpose. */
function describe(error) {
  if (error instanceof DecodeError) {
    return error.message;
  }
  const text = String(error?.message ?? error);
  if (error instanceof RangeError || /out of memory|allocation failed|enlarge memory|\bOOM\b/i.test(text)) {
    return 'There is not enough memory to decode this picture.';
  }
  return `This picture could not be decoded (${text}).`;
}

/**
 * Runs `decode` for the one request a decoding worker gets and posts the answer: the bitmap with the list
 * of pictures in the file, or the reason why there is none. `decode` returns `{ raster, pages, page }`;
 * an error it throws may carry `pages` and `page` as well. It is handed a function to call with the size
 * of the picture as soon as that is known: the page waits for the answer in proportion to it.
 */
export function serve(decode) {
  self.onmessage = async (event) => {
    try {
      const { raster, pages, page } = await decode(event.data, (width, height) => self.postMessage({ size: [width, height] }));
      const bitmap = await toBitmap(raster);
      self.postMessage({ bitmap, pages, page, notes: raster.notes, warning: raster.warning }, [bitmap]);
    } catch (error) {
      // A decoder that got as far as the list of pictures passes it on, so another one can still be chosen.
      self.postMessage({ error: describe(error), pages: error?.pages, page: error?.page });
    }
  };
}
