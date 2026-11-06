import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import { extensionsOf, isOn, viewersOf, withChoice, type Viewer } from '../src/associations';
import { root } from './helpers';

// Only the pure half of the module is covered: the command itself needs VS Code's settings and its picker.

const viewer = (viewType: string, ...extensions: string[]): Viewer => ({ viewType, name: viewType, extensions });

const IMAGE = viewer('previewix.image', 'png', 'jpg', 'heic', 'psd');
const VIDEO = viewer('previewix.video', 'mp4', 'webm', 'mkv');
const AUDIO = viewer('previewix.audio', 'mp3', 'ogg', 'flac');
const MARKDOWN = viewer('previewix.markdown', 'md', 'markdown');
const TABLE = viewer('previewix.csv', 'csv', 'tsv');
const ALL = [IMAGE, VIDEO, AUDIO, MARKDOWN, TABLE];
const all = (...except: Viewer[]) => new Set(ALL.filter((item) => !except.includes(item)).map((item) => item.viewType));

// ---- Patterns -----------------------------------------------------------------------------------------------

test('extensionsOf reads a group of extensions, in lower case', () => {
  assert.deepEqual(extensionsOf('*.{md,markdown}'), ['md', 'markdown']);
  assert.deepEqual([...new Set(extensionsOf('*.{png,PNG,Jpg,jpg}'))], ['png', 'jpg']);
  assert.deepEqual(extensionsOf('*.{tar.gz,tgz}'), ['tar.gz', 'tgz']);
  assert.deepEqual(extensionsOf('*.{ca-bundle}'), ['ca-bundle']);
});

test('extensionsOf reads a single extension, also one with a dot in it', () => {
  assert.deepEqual(extensionsOf('*.pdf'), ['pdf']);
  assert.deepEqual(extensionsOf('*.PDF'), ['pdf']);
  assert.deepEqual(extensionsOf('*.tar.gz'), ['tar.gz']);
});

test('a pattern of another shape has no association to write', () => {
  for (const pattern of ['', '*', '*.', 'Makefile', 'README.md', '**/*.png', 'src/*.md', '*.p?g', '*.[ch]', '*.*', '*.{a,b}.gz', 'img.{png,jpg}', '*.{}']) {
    assert.deepEqual(extensionsOf(pattern), [], pattern);
  }
});

test('viewersOf lists each viewer with the extensions of all its patterns, each once', () => {
  const viewers = viewersOf([
    { viewType: 'previewix.image', displayName: 'Previewix Image', selector: [{ filenamePattern: '*.{png,PNG,jpg,JPG}' }, { filenamePattern: '*.jpg' }, { filenamePattern: '*.heic' }] },
    { viewType: 'previewix.model', displayName: 'Previewix 3D Model', selector: [{ filenamePattern: '*.{glb,GLB}' }] },
    { viewType: 'other.viewer', displayName: 'Something Else', selector: [{}, { filenamePattern: '**/special/*' }] },
  ]);
  assert.deepEqual(viewers, [
    { viewType: 'previewix.image', name: 'Image', extensions: ['png', 'jpg', 'heic'] },
    { viewType: 'previewix.model', name: '3D Model', extensions: ['glb'] },
    { viewType: 'other.viewer', name: 'Something Else', extensions: [] },
  ]);
});

// ---- Whether a viewer is on ---------------------------------------------------------------------------------

test('a viewer is on when nothing has been associated', () => {
  assert.equal(isOn(TABLE, {}), true);
  assert.equal(isOn(TABLE, { '*.md': 'default', '*.txt': 'default' }), true);
});

test('a viewer is off only when every one of its extensions has another editor', () => {
  assert.equal(isOn(TABLE, { '*.csv': 'default', '*.tsv': 'some.other.editor' }), false);
  // One entry made by hand leaves it on.
  assert.equal(isOn(TABLE, { '*.csv': 'default' }), true);
  assert.equal(isOn(TABLE, { '*.tsv': 'default' }), true);
});

test('an association with the viewer itself counts as on', () => {
  assert.equal(isOn(TABLE, { '*.csv': 'previewix.csv', '*.tsv': 'default' }), true);
  assert.equal(isOn(TABLE, { '*.csv': 'previewix.xlsx', '*.tsv': 'default' }), false);
});

// ---- Applying a choice --------------------------------------------------------------------------------------

test('switching a viewer off gives each extension to VS Code’s own viewer where it has one, else to the text editor', () => {
  assert.deepEqual(withChoice(ALL, {}, all(IMAGE)), {
    '*.png': 'imagePreview.previewEditor',
    '*.jpg': 'imagePreview.previewEditor',
    '*.heic': 'default',
    '*.psd': 'default',
  });
  assert.deepEqual(withChoice(ALL, {}, all(VIDEO)), { '*.mp4': 'vscode.videoPreview', '*.webm': 'vscode.videoPreview', '*.mkv': 'default' });
  assert.deepEqual(withChoice(ALL, {}, all(AUDIO)), { '*.mp3': 'vscode.audioPreview', '*.ogg': 'vscode.audioPreview', '*.flac': 'default' });
  assert.deepEqual(withChoice(ALL, {}, all(MARKDOWN)), { '*.md': 'default', '*.markdown': 'default' });
});

test('VS Code’s viewers get only the extensions of their own kind', () => {
  // An audio viewer that also claimed "png" must not hand it to the audio preview.
  const odd = viewer('previewix.audio', 'mp3', 'png', 'mp4');
  assert.deepEqual(withChoice([odd], {}, new Set()), { '*.mp3': 'vscode.audioPreview', '*.png': 'default', '*.mp4': 'default' });
});

test('switching a viewer on again removes its entries, whatever editor they named', () => {
  const off = { '*.md': 'vscode.markdown.preview.editor', '*.markdown': 'default', '*.txt': 'default' };
  assert.equal(isOn(MARKDOWN, off), false);
  assert.deepEqual(withChoice(ALL, off, all()), { '*.txt': 'default' });
});

test('a viewer whose state does not change is not touched', () => {
  const before = {
    '*.csv': 'default', // made by hand: the Table viewer is still on, for .tsv
    '*.png': 'some.other.editor',
    '*.txt': 'default',
    '*.md': 'default',
    '*.markdown': 'default', // Markdown is off
  };
  // Table and Image stay on, Markdown stays off.
  assert.deepEqual(withChoice(ALL, before, all(MARKDOWN)), before);
  // Switching Audio off leaves all of that alone as well.
  assert.deepEqual(withChoice(ALL, before, all(MARKDOWN, AUDIO)), {
    ...before,
    '*.mp3': 'vscode.audioPreview',
    '*.ogg': 'vscode.audioPreview',
    '*.flac': 'default',
  });
});

test('the associations passed in are not changed', () => {
  const before = { '*.md': 'default', '*.markdown': 'default', '*.txt': 'default' };
  const copy = { ...before };
  withChoice(ALL, before, all());
  withChoice(ALL, before, new Set());
  assert.deepEqual(before, copy);
});

test('everything off and on again gives back what was there', () => {
  for (const before of [{}, { '*.txt': 'default', '*.log': 'some.editor' }] as Record<string, string>[]) {
    const off = withChoice(ALL, before, new Set());
    assert.ok(ALL.every((item) => !isOn(item, off)));
    assert.equal(Object.keys(off).length, Object.keys(before).length + ALL.reduce((sum, item) => sum + item.extensions.length, 0));
    assert.deepEqual(withChoice(ALL, off, all()), before);
  }
});

// ---- The real package.json ----------------------------------------------------------------------------------

interface Manifest {
  contributes: { customEditors: { viewType: string; displayName: string; selector: { filenamePattern?: string }[] }[] };
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const editors = manifest.contributes.customEditors;
const viewers = viewersOf(editors);

test('package.json: every custom editor has a name and patterns that all yield extensions', () => {
  assert.ok(editors.length > 0);
  assert.equal(viewers.length, editors.length);
  editors.forEach((editor, i) => {
    assert.ok(viewers[i].name.length > 0 && !viewers[i].name.startsWith('Previewix'), editor.viewType);
    assert.ok(viewers[i].extensions.length > 0, `${editor.viewType} has no extensions`);
    for (const entry of editor.selector) {
      // A pattern the command can't read would leave that file type with Previewix when the viewer is switched off.
      assert.ok(extensionsOf(entry.filenamePattern ?? '').length > 0, `${editor.viewType}: ${entry.filenamePattern}`);
    }
  });
});

test('package.json: the extensions are the ones in the patterns, lower case, each with one viewer', () => {
  const owner = new Map<string, string>();
  editors.forEach((editor, i) => {
    // The patterns taken apart without the module: everything between the braces, or after "*.".
    const written = editor.selector.flatMap((entry) => (entry.filenamePattern ?? '').replace(/^\*\.\{?|\}$/g, '').split(','));
    assert.deepEqual([...viewers[i].extensions].sort(), [...new Set(written.map((ext) => ext.toLowerCase()))].sort(), editor.viewType);
    for (const ext of viewers[i].extensions) {
      assert.match(ext, /^[a-z0-9][a-z0-9.-]*$/, `${editor.viewType}: ${ext}`);
      // Two viewers on one extension could not be switched separately: the setting has one editor per pattern.
      assert.equal(owner.get(ext), undefined, `*.${ext} is claimed by ${owner.get(ext)} and ${editor.viewType}`);
      owner.set(ext, editor.viewType);
    }
  });
});

test('package.json: every viewer off and on again returns the original associations', () => {
  const everything = new Set(viewers.map((item) => item.viewType));
  for (const before of [{}, { '*.txt': 'default', '*.unknown-to-previewix': 'some.editor' }] as Record<string, string>[]) {
    const off = withChoice(viewers, before, new Set());
    for (const item of viewers) {
      assert.equal(isOn(item, off), false, item.viewType);
      for (const ext of item.extensions) {
        assert.ok(off[`*.${ext}`] && off[`*.${ext}`] !== item.viewType, `*.${ext}`);
      }
    }
    assert.deepEqual(withChoice(viewers, off, everything), before);
    // And one at a time.
    for (const item of viewers) {
      const without = withChoice(viewers, before, new Set([...everything].filter((viewType) => viewType !== item.viewType)));
      assert.equal(isOn(item, without), false, item.viewType);
      assert.deepEqual(viewers.filter((other) => !isOn(other, without)), [item]);
      assert.deepEqual(withChoice(viewers, without, everything), before, item.viewType);
    }
  }
});

test('package.json: the viewers VS Code has a counterpart for are registered under the names the module knows', () => {
  const off = withChoice(viewers, {}, new Set());
  assert.equal(off['*.png'], 'imagePreview.previewEditor');
  assert.equal(off['*.jpg'], 'imagePreview.previewEditor');
  assert.equal(off['*.mp4'], 'vscode.videoPreview');
  assert.equal(off['*.mp3'], 'vscode.audioPreview');
  assert.equal(off['*.md'], 'default');
  assert.equal(off['*.csv'], 'default');
});
