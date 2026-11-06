// @ts-check
// The arithmetic of the image comparison, off the page's thread. The page reads both pictures strip by strip
// and hands the pixels over; what is kept here is one byte per pixel, the difference, with smaller copies of
// it for looking at the whole from afar. compare.js starts this file from a blob.

/** Level 0 is the difference of every pixel; each further level halves it, keeping the largest of four. @type {{w: number, h: number, data: Uint8Array}[]} */
let levels = [];
/** How many pixels have each difference, 0 to 255. */
let histogram = new Uint32Array(256);

/**
 * How far two pixels are apart: the largest difference in red, green, blue or alpha, 0 to 255. Colors are
 * weighted by their alpha first, as they are on screen, so what hides behind full transparency counts for
 * nothing and a faint pixel can't differ by much.
 */
function compareRows(a, b, out, at) {
  const a32 = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
  const b32 = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
  const count = a32.length;
  let same = 0;
  for (let i = 0; i < count; i++) {
    if (a32[i] === b32[i]) {
      same++;
      continue;
    }
    const j = i << 2;
    const alphaA = a[j + 3];
    const alphaB = b[j + 3];
    let d = 0;
    if (alphaA === 255 && alphaB === 255) {
      for (let c = 0; c < 3; c++) {
        const diff = a[j + c] - b[j + c];
        d = Math.max(d, diff < 0 ? -diff : diff);
      }
    } else {
      d = alphaA > alphaB ? alphaA - alphaB : alphaB - alphaA;
      for (let c = 0; c < 3; c++) {
        // Rounded to the nearest whole, like the canvas does when it stores a pixel.
        const diff = (((a[j + c] * alphaA + 127) / 255) | 0) - (((b[j + c] * alphaB + 127) / 255) | 0);
        d = Math.max(d, diff < 0 ? -diff : diff);
      }
    }
    out[at + i] = d;
    histogram[d]++;
  }
  histogram[0] += same;
}

function buildLevels() {
  let { w, h, data } = levels[0];
  while (w > 1 || h > 1) {
    const nw = (w + 1) >> 1;
    const nh = (h + 1) >> 1;
    const next = new Uint8Array(nw * nh);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const to = (y >> 1) * nw;
      for (let x = 0; x < w; x++) {
        const v = data[row + x];
        if (v > next[to + (x >> 1)]) {
          next[to + (x >> 1)] = v;
        }
      }
    }
    levels.push({ w: nw, h: nh, data: next });
    w = nw;
    h = nh;
    data = next;
  }
}

/** The smallest rectangle that holds every pixel differing by more than `tolerance`, or null when there is none. */
function findBox(tolerance) {
  // A coarse level says which blocks of 8 × 8 pixels to look into; only the rim of the box is read pixel by pixel.
  const coarse = Math.min(3, levels.length - 1);
  const { w, h, data } = levels[coarse];
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x] > tolerance) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = y;
      }
    }
  }
  if (x1 < 0) {
    return null;
  }
  const full = levels[0];
  const block = 1 << coarse;
  let left = x0 * block;
  let top = y0 * block;
  let right = Math.min(full.w, (x1 + 1) * block) - 1;
  let bottom = Math.min(full.h, (y1 + 1) * block) - 1;
  const inRow = (y) => {
    for (let x = left; x <= right; x++) {
      if (full.data[y * full.w + x] > tolerance) {
        return true;
      }
    }
    return false;
  };
  const inColumn = (x) => {
    for (let y = top; y <= bottom; y++) {
      if (full.data[y * full.w + x] > tolerance) {
        return true;
      }
    }
    return false;
  };
  while (!inRow(top)) top++;
  while (!inRow(bottom)) bottom--;
  while (!inColumn(left)) left++;
  while (!inColumn(right)) right--;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/**
 * The marks of an area as a picture of `outWidth` × `outHeight`: the color where a pixel differs by more than
 * the tolerance, nothing elsewhere. Zoomed out, one pixel of the result stands for many of the pictures and is
 * marked when any of them differs, so a single changed pixel in a large photograph stays visible. The area is
 * given in pixels of the compared area and need not be whole numbers, nor lie inside it.
 */
function render({ x, y, w, h, outWidth, outHeight, tolerance, color }) {
  const out = new Uint32Array(outWidth * outHeight);
  // Little-endian RGBA, which is every machine a webview runs on.
  const mark = (255 << 24) | (color[2] << 16) | (color[1] << 8) | color[0];
  const stepX = w / outWidth;
  const stepY = h / outHeight;
  const level = Math.max(0, Math.min(levels.length - 1, Math.floor(Math.log2(Math.max(1, Math.min(stepX, stepY))))));
  const { w: lw, h: lh, data } = levels[level];
  const size = 1 << level;
  // The first and last cell of the level under every column and row of the result.
  const spans = (from, step, count, limit) => {
    const first = new Int32Array(count);
    const last = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const start = from + i * step;
      const cell = Math.floor(start / size);
      // A column that lies outside the compared area gets an empty span.
      first[i] = Math.max(0, cell);
      last[i] = Math.min(limit - 1, Math.max(cell, Math.ceil((start + step) / size) - 1));
    }
    return [first, last];
  };
  const [xFirst, xLast] = spans(x, stepX, outWidth, lw);
  const [yFirst, yLast] = spans(y, stepY, outHeight, lh);
  for (let oy = 0; oy < outHeight; oy++) {
    const row = oy * outWidth;
    for (let ox = 0; ox < outWidth; ox++) {
      let hit = false;
      for (let cy = yFirst[oy]; cy <= yLast[oy] && !hit; cy++) {
        const base = cy * lw;
        for (let cx = xFirst[ox]; cx <= xLast[ox]; cx++) {
          if (data[base + cx] > tolerance) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        out[row + ox] = mark;
      }
    }
  }
  return createImageBitmap(new ImageData(new Uint8ClampedArray(out.buffer), outWidth, outHeight));
}

self.onmessage = async ({ data: msg }) => {
  switch (msg.type) {
    case 'begin':
      levels = [{ w: msg.width, h: msg.height, data: new Uint8Array(msg.width * msg.height) }];
      histogram = new Uint32Array(256);
      break;
    case 'rows':
      compareRows(new Uint8Array(msg.a), new Uint8Array(msg.b), levels[0].data, msg.y * levels[0].w);
      self.postMessage({ type: 'rows', y: msg.y + msg.rows });
      break;
    case 'end':
      buildLevels();
      self.postMessage({ type: 'done', histogram });
      break;
    case 'box':
      self.postMessage({ type: 'box', tolerance: msg.tolerance, box: findBox(msg.tolerance) });
      break;
    case 'render': {
      const bitmap = await render(msg);
      // @ts-ignore: the worker's postMessage takes a transfer list.
      self.postMessage({ type: 'rendered', seq: msg.seq, bitmap }, [bitmap]);
      break;
    }
  }
};
