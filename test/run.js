// Builds the tests and runs them with Node's own test runner.
//
//   node test/run.js                     every test/*.test.ts
//   node test/run.js tags csvEdit        only the files whose name contains one of the words
//   node test/run.js --test-name-pattern=symbolic   options are passed on to `node --test`
//
// A test imports the modules of src/ directly. esbuild makes one bundle per test file in a temporary
// folder, next to the worker entries and the UnRAR module that the archive code looks for beside its
// own bundle (as in dist/), so nothing here needs `npm run build` and nothing is left in the tree.

const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith('-'));
const words = args.filter((arg) => !arg.startsWith('-'));

const tests = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => !words.length || words.some((word) => name.toLowerCase().includes(word.toLowerCase())))
  .sort();
if (!tests.length) {
  console.error(`No test file matches: ${words.join(', ')}`);
  process.exit(1);
}

const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'previewix-test-'));
let status = 1;
try {
  esbuild.buildSync({
    absWorkingDir: root,
    entryPoints: {
      ...Object.fromEntries(tests.map((name) => [name.slice(0, -3), path.join('test', name)])),
      // Started as worker threads by the code under test.
      archiveWorker: 'src/archiveWorker.ts',
      sqliteWorker: 'src/sqliteWorker.ts',
    },
    outdir: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: 'inline',
    // Some modules import vscode for their command or provider half. The stand-in is empty, so their pure
    // functions can be loaded and anything that really needs VS Code fails at once.
    alias: { vscode: './test/vscode.ts' },
    logLevel: 'warning',
    // What the stand-in for vscode doesn't export.
    logOverride: { 'import-is-undefined': 'silent' },
  });
  fs.copyFileSync(path.join(root, 'node_modules', 'node-unrar-js', 'dist', 'js', 'unrar.wasm'), path.join(out, 'unrar.wasm'));

  const run = spawnSync(
    process.execPath,
    ['--enable-source-maps', '--test', '--test-reporter=spec', ...options, ...tests.map((name) => path.join(out, `${name.slice(0, -3)}.js`))],
    { stdio: 'inherit', env: { ...process.env, PREVIEWIX_ROOT: root } },
  );
  status = run.status ?? 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
process.exit(status);
