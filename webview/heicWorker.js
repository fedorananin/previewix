import { decodeHeic } from '../src/imageFormats/heicDecode';
import { serve } from './imageDeliver.js';

// The worker that decodes HEIC. libheif itself is not part of this bundle: the page puts the library's own
// script (dist/libheif/libheif.js, shipped unchanged) in front of this one, which defines `libheif`, and
// sends the WebAssembly binary along with the request.
serve(async ({ bytes, page, wasm }, announce) => {
  const lib = await new Promise((resolve, reject) => {
    // The object handed to the factory becomes the library. With the binary at hand it may be ready before the call returns.
    const module = {
      wasmBinary: wasm,
      print: () => undefined,
      printErr: () => undefined,
      onRuntimeInitialized: () => resolve(module),
      onAbort: (reason) => reject(new Error(String(reason))),
    };
    self.libheif(module);
  });
  return decodeHeic(lib, bytes, page, announce);
});
