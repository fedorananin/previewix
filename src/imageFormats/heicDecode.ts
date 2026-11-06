import { DecodeError, PageInfo, Raster, checkSize, unpremultiply } from './common';

/** The part of libheif (an Emscripten build) that is used here: its C functions and its memory. */
export interface LibHeif {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _heif_get_version(): number;
  _heif_context_alloc(): number;
  _heif_context_free(context: number): void;
  _heif_context_read_from_memory_without_copy(error: number, context: number, data: number, size: number, options: number): void;
  _heif_context_get_number_of_top_level_images(context: number): number;
  _heif_context_get_list_of_top_level_image_IDs(context: number, ids: number, count: number): number;
  _heif_context_get_primary_image_ID(error: number, context: number, id: number): void;
  _heif_context_get_image_handle(error: number, context: number, id: number, handle: number): void;
  _heif_context_has_sequence(context: number): number;
  _heif_image_handle_release(handle: number): void;
  _heif_image_handle_get_width(handle: number): number;
  _heif_image_handle_get_height(handle: number): number;
  _heif_image_handle_get_luma_bits_per_pixel(handle: number): number;
  _heif_image_handle_get_color_profile_type(handle: number): number;
  _heif_image_handle_get_raw_color_profile_size(handle: number): number;
  _heif_image_handle_get_raw_color_profile(error: number, handle: number, out: number): void;
  _heif_image_handle_get_nclx_color_profile(error: number, handle: number, out: number): void;
  _heif_nclx_color_profile_free(profile: number): void;
  _heif_decode_image(error: number, handle: number, image: number, colorspace: number, chroma: number, options: number): void;
  _heif_image_get_width(image: number, channel: number): number;
  _heif_image_get_height(image: number, channel: number): number;
  _heif_image_get_plane_readonly(image: number, channel: number, stride: number): number;
  _heif_image_is_premultiplied_alpha(image: number): number;
  _heif_image_get_decoding_warnings(image: number, first: number, warnings: number, max: number): number;
  _heif_image_release(image: number): void;
}

// Values of libheif's enums (heif.h).
const COLORSPACE_RGB = 1;
const CHROMA_INTERLEAVED_RGBA = 11;
const CHANNEL_INTERLEAVED = 10;
const ERROR_UNSUPPORTED_FILETYPE = 3;
const ERROR_UNSUPPORTED_FEATURE = 4;
const ERROR_MEMORY = 6;
const ERROR_NO_DECODER = 11;

const fourcc = (text: string) => ((text.charCodeAt(0) << 24) | (text.charCodeAt(1) << 16) | (text.charCodeAt(2) << 8) | text.charCodeAt(3)) >>> 0;

export interface HeicResult {
  raster: Raster;
  /** The top-level pictures of the file. Almost always one. */
  pages: PageInfo[];
  /** Which of them was decoded. */
  page: number;
}

/**
 * Decodes one picture of a HEIC/HEIF file with libheif. Without `index` it is the primary one.
 * Rotation, mirroring and cropping stored in the file are applied by libheif, so the raster is upright.
 * `onSize` is told the size of the picture before the decoding starts, which is the slow part.
 */
export function decodeHeic(lib: LibHeif, b: Uint8Array, index?: number, onSize?: (width: number, height: number) => void): HeicResult {
  // 12 bytes for an error (code, subcode, message), then room for two values a function hands back.
  const scratch = lib._malloc(32);
  const out = scratch + 16;
  const file = lib._malloc(b.length);
  const context = lib._heif_context_alloc();
  let handle = 0;
  let image = 0;
  // The views are replaced whenever the memory grows, so they are fetched anew for every read.
  const u32 = (at: number) => lib.HEAPU32[at >> 2];
  const text = (at: number) => {
    let end = at;
    while (at && lib.HEAPU8[end]) {
      end++;
    }
    return String.fromCharCode(...lib.HEAPU8.subarray(at, end));
  };
  /** Turns the error a libheif call left in the scratch area into an exception. */
  const check = () => {
    const code = lib.HEAP32[scratch >> 2];
    if (!code) {
      return;
    }
    const detail = text(u32(scratch + 8)).replace(/\s+/g, ' ').trim();
    const said = detail ? ` (libheif: ${detail})` : '';
    if (code === ERROR_UNSUPPORTED_FILETYPE || code === ERROR_UNSUPPORTED_FEATURE || code === ERROR_NO_DECODER) {
      throw new DecodeError(`This HEIF file uses a codec or a feature that is not supported${said}.`);
    }
    if (code === ERROR_MEMORY) {
      throw new DecodeError(`There is not enough memory to decode this picture${said}.`);
    }
    throw new DecodeError(`This HEIF file is damaged or cut short${said}.`);
  };
  const openHandle = (id: number) => {
    lib._heif_context_get_image_handle(scratch, context, id, out);
    check();
    return u32(out);
  };

  try {
    if (!file || !context) {
      throw new DecodeError('There is not enough memory to decode this picture.');
    }
    lib.HEAPU8.set(b, file);
    lib._heif_context_read_from_memory_without_copy(scratch, context, file, b.length, 0);
    check();
    const count = lib._heif_context_get_number_of_top_level_images(context);
    const sequence = lib._heif_context_has_sequence(context) !== 0;
    if (count < 1) {
      throw new DecodeError(
        sequence
          ? 'This file is an HEIF image sequence (an animation or a burst) without a still picture, which is not supported.'
          : 'This HEIF file contains no picture.',
      );
    }
    const idsAt = lib._malloc(count * 4);
    lib._heif_context_get_list_of_top_level_image_IDs(context, idsAt, count);
    const ids = Array.from(lib.HEAPU32.subarray(idsAt >> 2, (idsAt >> 2) + count));
    lib._free(idsAt);
    lib._heif_context_get_primary_image_ID(scratch, context, out);
    const primary = lib.HEAP32[scratch >> 2] ? 0 : Math.max(0, ids.indexOf(u32(out)));
    const page = index !== undefined && index >= 0 && index < count ? index : primary;

    const pages: PageInfo[] = [];
    for (let i = 0; i < count; i++) {
      if (count === 1) {
        break;
      }
      const other = openHandle(ids[i]);
      const [w, h] = [lib._heif_image_handle_get_width(other), lib._heif_image_handle_get_height(other)];
      lib._heif_image_handle_release(other);
      pages.push({ width: w, height: h, label: `Picture ${i + 1} · ${w} × ${h}${i === primary ? ' (main)' : ''}` });
    }

    handle = openHandle(ids[page]);
    checkSize(lib._heif_image_handle_get_width(handle), lib._heif_image_handle_get_height(handle));
    onSize?.(lib._heif_image_handle_get_width(handle), lib._heif_image_handle_get_height(handle));
    // With no options libheif takes its fast path for the usual 4:2:0 pictures. Forcing its bilinear chroma filter
    // was tried: it doubles the memory (600 MB instead of 300 MB for 48 megapixels) for a difference at pixel level.
    lib._heif_decode_image(scratch, handle, out, COLORSPACE_RGB, CHROMA_INTERLEAVED_RGBA, 0);
    check();
    image = u32(out);
    const width = lib._heif_image_get_width(image, CHANNEL_INTERLEAVED);
    const height = lib._heif_image_get_height(image, CHANNEL_INTERLEAVED);
    const plane = lib._heif_image_get_plane_readonly(image, CHANNEL_INTERLEAVED, out);
    const stride = lib.HEAP32[out >> 2];
    if (!plane || width < 1 || height < 1 || stride < width * 4) {
      throw new DecodeError('This HEIF file could not be decoded: the decoder returned no picture.');
    }
    const data = new Uint8Array(width * height * 4);
    const heap = lib.HEAPU8;
    if (stride === width * 4) {
      data.set(heap.subarray(plane, plane + data.length));
    } else {
      for (let y = 0; y < height; y++) {
        data.set(heap.subarray(plane + y * stride, plane + y * stride + width * 4), y * width * 4);
      }
    }
    if (lib._heif_image_is_premultiplied_alpha(image)) {
      unpremultiply(data);
    }
    // The HEVC decoder conceals damage instead of failing; it does say that it had to.
    const damaged = lib._heif_image_get_decoding_warnings(image, 0, out, 1) > 0;
    // The decoded planes are of no more use, and the caller is about to need as much memory again.
    lib._heif_image_release(image);
    image = 0;

    const raster: Raster = { width, height, data, notes: [] };
    if (damaged) {
      raster.warning = 'The picture data of this file is damaged: parts of the picture may be wrong.';
      raster.notes.push(['Damage', 'The decoder reported errors in the picture data']);
    }
    if (pages.length) {
      pages[page] = { ...pages[page], width, height };
    } else {
      pages.push({ width, height, label: `${width} × ${height}` });
    }
    const bits = lib._heif_image_handle_get_luma_bits_per_pixel(handle);
    if (bits > 8) {
      raster.notes.push(['Depth', `${bits} bits per channel, shown with 8`]);
    }
    if (sequence) {
      raster.notes.push(['Sequence', 'The file is an image sequence; only its still picture is shown']);
    }

    // The color space: a profile is passed on, code points are named when they need saying.
    const type = lib._heif_image_handle_get_color_profile_type(handle) >>> 0;
    if (type === fourcc('prof') || type === fourcc('rICC')) {
      const size = lib._heif_image_handle_get_raw_color_profile_size(handle);
      const at = size > 0 ? lib._malloc(size) : 0;
      if (at) {
        lib._heif_image_handle_get_raw_color_profile(scratch, handle, at);
        if (!lib.HEAP32[scratch >> 2]) {
          raster.icc = lib.HEAPU8.slice(at, at + size);
        }
        lib._free(at);
      }
    } else if (type === fourcc('nclx')) {
      lib._heif_image_handle_get_nclx_color_profile(scratch, handle, out);
      const profile = lib.HEAP32[scratch >> 2] ? 0 : u32(out);
      if (profile) {
        // struct heif_color_profile_nclx: version, then primaries, transfer and matrix as 32-bit enums (ITU-T H.273 code points).
        const primaries = u32(profile + 4);
        const transfer = u32(profile + 8);
        lib._heif_nclx_color_profile_free(profile);
        const hdr = transfer === 16 ? 'PQ' : transfer === 18 ? 'HLG' : '';
        if (hdr) {
          raster.warning = `HDR picture (${hdr}): shown without tone mapping, so brightness and colors are off.`;
          raster.notes.push(['Color', `HDR (${hdr}), shown without tone mapping`]);
        } else if (primaries === 12 && transfer === 13) {
          raster.colorSpace = 'display-p3';
        } else if (primaries === 9 || primaries === 11 || primaries === 12) {
          const name = primaries === 9 ? 'BT.2020' : 'P3';
          raster.warning = `Wide-gamut picture (${name}): shown without conversion, so the colors are less saturated than they should be.`;
          raster.notes.push(['Color', `${name} primaries, shown as sRGB without conversion`]);
        }
      }
    }
    raster.notes.push(['Decoder', `libheif ${text(lib._heif_get_version())}`]);
    return { raster, pages, page };
  } finally {
    if (image) {
      lib._heif_image_release(image);
    }
    if (handle) {
      lib._heif_image_handle_release(handle);
    }
    if (context) {
      lib._heif_context_free(context);
    }
    lib._free(file);
    lib._free(scratch);
  }
}
