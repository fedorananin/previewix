import { DecodeError } from '../src/imageFormats/common';
import { decodeIcns, listIcns } from '../src/imageFormats/icns';
import { icoPicture, listIco } from '../src/imageFormats/ico';
import { FORMAT_NAMES, sniffFormat } from '../src/imageFormats/sniff';

// Turns the bytes of an image file into an ImageBitmap, whatever the format. A page loads this file as a
// module script and calls `previewixImages.decode()`; see "Image decoding" in AGENTS.md for what the page
// has to allow in its Content Security Policy.

/** The folder this script is served from (dist/webview/). The workers and libheif are found relative to it. */
const here = new URL('.', import.meta.url).href;

const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };

/** Formats that are decoded in a worker, and the script of that worker. */
const WORKERS = { tiff: 'imageWorker.js', psd: 'imageWorker.js', heic: 'heicWorker.js' };

/** Every file is fetched once per page: a second picture of the same kind starts decoding at once. */
const fetched = new Map();
function load(path, binary) {
  if (!fetched.has(path)) {
    const request = fetch(here + path).then((response) => {
      if (!response.ok) {
        throw new Error(`${path}: ${response.status}`);
      }
      return binary ? response.arrayBuffer() : response.text();
    });
    // A failed download is tried again next time.
    request.catch(() => fetched.delete(path));
    fetched.set(path, request);
  }
  return fetched.get(path);
}

const plain = (pages) => pages.map(({ label, width, height }) => ({ label, width, height }));
const pick = (page, count, fallback) => (Number.isInteger(page) && page >= 0 && page < count ? page : fallback);

async function native(bytes, type) {
  try {
    return await createImageBitmap(new Blob([bytes], type ? { type } : undefined));
  } catch {
    throw new DecodeError('This image could not be decoded.');
  }
}

/** An error for the user that still says which pictures the file holds, when that much could be read. */
const failure = (message, pages, page) => Object.assign(new DecodeError(message), pages?.length ? { pages, page } : {});

const fromRaster = (raster) =>
  createImageBitmap(new ImageData(new Uint8ClampedArray(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength), raster.width, raster.height));

/**
 * How long a worker may take, in seconds: to say how large the picture is, and then to decode it. About twenty
 * times what the slowest decoder needs on a fast machine. A decoder caught in a damaged file can't be stopped
 * from inside its own thread, so this is the bound that holds whatever a decoder does.
 */
const PATIENCE = { start: 30, decode: 15, perMegapixel: 1 };

/**
 * A worker can't be started from the extension's files, which are another origin for a webview, so its code
 * is fetched and started from a blob. Each picture gets a worker of its own, which is ended afterwards:
 * that is what gives the decoder's memory back, and what makes a decode that is no longer wanted stop.
 */
async function inWorker(format, bytes, page, signal, onBusy) {
  let parts;
  let wasm;
  try {
    if (format === 'heic') {
      const [library, code, binary] = await Promise.all([load('../libheif/libheif.js'), load(WORKERS.heic), load('../libheif/libheif.wasm', true)]);
      parts = [library, '\n', code];
      wasm = binary;
    } else {
      parts = [await load(WORKERS[format])];
    }
  } catch (error) {
    throw new DecodeError(`The ${FORMAT_NAMES[format]} decoder could not be loaded (${error?.message ?? error}).`);
  }
  signal?.throwIfAborted();
  onBusy?.(FORMAT_NAMES[format]);
  const url = URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
  const worker = new Worker(url);
  let deadline;
  try {
    return await new Promise((resolve, reject) => {
      const allow = (seconds) => {
        clearTimeout(deadline);
        deadline = setTimeout(
          () => reject(new DecodeError(`The ${FORMAT_NAMES[format]} decoder did not finish within ${Math.round(seconds)} seconds and was stopped: the file is damaged, or too large for this machine.`)),
          seconds * 1000,
        );
      };
      allow(PATIENCE.start);
      worker.onmessage = ({ data }) => {
        if (data.size) {
          allow(PATIENCE.decode + (data.size[0] * data.size[1] * PATIENCE.perMegapixel) / 1e6);
        } else if (data.error) {
          reject(failure(data.error, data.pages, data.page));
        } else {
          resolve(data);
        }
      };
      worker.onerror = (event) => reject(new DecodeError(`The ${FORMAT_NAMES[format]} decoder stopped unexpectedly${event.message ? ` (${event.message})` : ''}.`));
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      // The bytes are copied, not handed over: the page needs them again to show another page of the file.
      worker.postMessage({ format, bytes, page, wasm });
    });
  } finally {
    clearTimeout(deadline);
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes an image file.
 *
 * @param {Uint8Array} bytes The whole file.
 * @param {{ page?: number, mime?: string, signal?: AbortSignal, onBusy?: (format: string) => void }} [options]
 *   `page`: which picture of a file that holds several (see `pages` in the result); the default is the one a
 *   viewer would normally show. `mime`: a hint for a file whose content isn't recognised. `signal`: stops a
 *   decode that is no longer wanted. `onBusy`: called when a decoder that can take seconds has started.
 * @returns {Promise<{
 *   bitmap: ImageBitmap,
 *   format: string,
 *   pages: { label: string, width: number, height: number }[],
 *   page: number,
 *   notes: [string, string][],
 *   warning?: string,
 * }>} `bitmap` is upright (orientation applied) and tagged with its color space, so drawing it on a canvas
 *   gives sRGB; the caller closes it. `pages` lists the pictures in the file (sizes of an icon, pages of a
 *   TIFF) and `page` the one decoded. `notes` are rows for an info panel about what was done to the picture,
 *   `warning` something to tell the user at once. The promise is rejected with an Error whose message is
 *   written for the user, or with the signal's reason. When one picture of several can't be decoded, the
 *   error has `pages` and `page` like a result, so the others can still be offered.
 */
async function decode(bytes, options = {}) {
  const { page, mime, signal, onBusy } = options;
  if (!bytes.length) {
    throw new DecodeError('This file is empty.');
  }
  const format = sniffFormat(bytes);
  const result = { format: FORMAT_NAMES[format], notes: [] };

  if (WORKERS[format]) {
    return { ...result, ...(await inWorker(format, bytes, page, signal, onBusy)) };
  }
  if (format === 'icns') {
    const entries = listIcns(bytes);
    if (!entries.length) {
      throw new DecodeError('This icon file contains no picture that can be shown.');
    }
    if (entries.every((entry) => entry.kind === 'jp2')) {
      throw new DecodeError('Every picture of this icon is stored as JPEG 2000, an old format that is not supported.');
    }
    // The largest picture that can be decoded: old icons keep their big sizes in JPEG 2000.
    const index = pick(page, entries.length, Math.max(0, entries.findIndex((entry) => entry.kind !== 'jp2')));
    try {
      const picture = decodeIcns(bytes, entries[index]);
      const bitmap = 'png' in picture ? await native(picture.png, 'image/png') : await fromRaster(picture.raster);
      return { ...result, bitmap, pages: plain(entries), page: index };
    } catch (error) {
      throw failure(error.message, plain(entries), index);
    }
  }
  if (format === 'ico') {
    let entries = [];
    try {
      entries = listIco(bytes);
    } catch {
      // Left to the browser below.
    }
    if (entries.length) {
      const index = pick(page, entries.length, 0);
      const picture = icoPicture(bytes, entries[index]);
      try {
        return { ...result, bitmap: await native(picture.bytes, picture.mime), pages: plain(entries), page: index };
      } catch (error) {
        throw failure(error.message, plain(entries), index);
      }
    }
  }
  const bitmap = await native(bytes, MIME[format] || mime);
  return { ...result, bitmap, pages: [{ label: `${bitmap.width} × ${bitmap.height}`, width: bitmap.width, height: bitmap.height }], page: 0 };
}

globalThis.previewixImages = { decode, formatOf: (bytes) => FORMAT_NAMES[sniffFormat(bytes)] };
