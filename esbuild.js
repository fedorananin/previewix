const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const extension = {
  ...common,
  // The SQLite worker, the spreadsheet, Parquet, JSON Lines and dBase readers and the CSV writer are files of their own because they are started as worker threads.
  entryPoints: ['src/extension.ts', 'src/sqliteWorker.ts', 'src/xlsxRead.ts', 'src/parquetRead.ts', 'src/jsonl.ts', 'src/dbf.ts', 'src/csvEdit.ts', 'src/archiveWorker.ts'],
  outdir: 'dist',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // The ESM builds of mediainfo.js rely on import.meta, which doesn't survive a CJS bundle.
  alias: { 'mediainfo.js': './node_modules/mediainfo.js/dist/cjs/index.cjs' },
};

// Webview scripts that depend on npm packages. The simpler ones in media/ are shipped as written.
const webviews = {
  ...common,
  entryPoints: ['webview/pdf.js', 'webview/docx.js', 'webview/model.js', 'webview/imageDecode.js', 'webview/imageWorker.js', 'webview/heicWorker.js'],
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'esm',
  target: 'chrome122',
};

// Mermaid, for diagrams in Markdown. Split into chunks, so a page loads only the diagram types it draws.
// Always minified and without source maps: it is well over 3 MB of someone else's code even so.
const mermaid = {
  ...webviews,
  entryPoints: ['webview/mermaid.js'],
  outdir: 'dist/mermaid',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
  metafile: true,
  plugins: [
    {
      name: 'mermaid-chunks',
      setup(build) {
        // Chunk names carry a hash, so the old ones would pile up.
        build.onStart(() => fs.rmSync('dist/mermaid', { recursive: true, force: true }));
        // Mermaid 11 has no ELK layouts in it and draws a diagram that asks for one with dagre. Mermaid 12
        // bundles elkjs (1.5 MB, EPL-2.0) and makes it the default layout: moving to it is a decision about
        // that licence, not a version bump, so the build stops rather than ship it unnoticed.
        build.onEnd((result) => {
          const elk = Object.keys(result.metafile?.inputs ?? {}).some((file) => file.includes('node_modules/elkjs/'));
          return elk ? { errors: [{ text: 'elkjs (EPL-2.0) is in the Mermaid bundle; see the note in esbuild.js' }] } : null;
        });
      },
    },
  ],
};

function copyAssets() {
  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync(
    path.join('node_modules', 'mediainfo.js', 'dist', 'MediaInfoModule.wasm'),
    path.join('dist', 'MediaInfoModule.wasm'),
  );
  // UnRAR, which the archive worker loads for RAR archives.
  fs.copyFileSync(path.join('node_modules', 'node-unrar-js', 'dist', 'js', 'unrar.wasm'), path.join('dist', 'unrar.wasm'));

  // Everything pdf.js fetches at runtime: its worker, viewer styles, and data for fonts and image decoders.
  const pdfjs = path.join('node_modules', 'pdfjs-dist');
  const out = path.join('dist', 'pdfjs');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(pdfjs, 'build', 'pdf.worker.min.mjs'), path.join(out, 'pdf.worker.min.mjs'));
  fs.copyFileSync(path.join(pdfjs, 'web', 'pdf_viewer.css'), path.join(out, 'pdf_viewer.css'));
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    fs.cpSync(path.join(pdfjs, dir), path.join(out, dir), { recursive: true });
  }
  fs.cpSync(path.join(pdfjs, 'web', 'images'), path.join(out, 'images'), { recursive: true });

  // KaTeX's stylesheet for math in Markdown, with its fonts in the one format Chromium picks from it.
  const katex = path.join('node_modules', 'katex', 'dist');
  const katexOut = path.join('dist', 'katex');
  fs.rmSync(katexOut, { recursive: true, force: true });
  fs.mkdirSync(path.join(katexOut, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(katex, 'katex.min.css'), path.join(katexOut, 'katex.min.css'));
  for (const font of fs.readdirSync(path.join(katex, 'fonts')).filter((name) => name.endsWith('.woff2'))) {
    fs.copyFileSync(path.join(katex, 'fonts', font), path.join(katexOut, 'fonts', font));
  }

  // The Draco decoder for compressed glTF models, in its smaller glTF-only build. The model page fetches it on demand.
  const draco = path.join('node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
  const dracoOut = path.join('dist', 'model', 'draco');
  fs.rmSync(path.join('dist', 'model'), { recursive: true, force: true });
  fs.mkdirSync(dracoOut, { recursive: true });
  for (const file of ['draco_wasm_wrapper.js', 'draco_decoder.wasm']) {
    fs.copyFileSync(path.join(draco, file), path.join(dracoOut, file));
  }

  // libheif, the HEIC decoder (with libde265 inside), is under the LGPL: it is shipped as the library's own
  // unchanged files next to its licence and loaded at run time, never bundled into Previewix's code.
  const libheif = path.join('node_modules', 'libheif-js', 'libheif-wasm');
  const libheifOut = path.join('dist', 'libheif');
  fs.rmSync(libheifOut, { recursive: true, force: true });
  fs.mkdirSync(libheifOut, { recursive: true });
  for (const file of ['libheif.js', 'libheif.wasm', 'LICENSE']) {
    fs.copyFileSync(path.join(libheif, file), path.join(libheifOut, file));
  }
}

(async () => {
  copyAssets();
  if (watch) {
    await Promise.all([extension, webviews, mermaid].map(async (options) => (await esbuild.context(options)).watch()));
  } else {
    await Promise.all([esbuild.build(extension), esbuild.build(webviews), esbuild.build(mermaid)]);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
