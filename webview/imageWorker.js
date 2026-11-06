import { decodePsd, readPsd } from '../src/imageFormats/psd';
import { listTiff } from '../src/imageFormats/tiff';
import { decodeTiff } from '../src/imageFormats/tiffDecode';
import { serve } from './imageDeliver.js';

// The worker that decodes TIFF and PSD: plain JavaScript, but too slow for a large file to run on the page's own thread.
serve(({ format, bytes, page }, announce) => {
  if (format === 'psd') {
    const { width, height } = readPsd(bytes);
    announce(width, height);
    const raster = decodePsd(bytes);
    return { raster, pages: [{ label: `${raster.width} × ${raster.height}`, width: raster.width, height: raster.height }], page: 0 };
  }
  const pages = listTiff(bytes).map(({ label, width, height }) => ({ label, width, height }));
  const index = page >= 0 && page < pages.length ? page : 0;
  announce(pages[index].width, pages[index].height);
  try {
    return { raster: decodeTiff(bytes, index), pages, page: index };
  } catch (error) {
    // One page that can't be shown doesn't take the others with it.
    throw Object.assign(error, { pages, page: index });
  }
});
