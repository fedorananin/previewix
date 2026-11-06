import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import type { CoverChange, Fields, Tag } from '../src/tags/common';
import { parseMetadata, serializeMetadata } from '../src/tags/ffmpeg';
import { readTagReport, saveTags } from '../src/tags/index';
import {
  FLAC, WAV_FORMAT, fields, flacAudio, flacBlocks, flacFile, id3Frames, id3Tag, id3TextFrame, jpeg, mp4Chunks, mp4File, mpegAudio, png, riffChunks, streamInfo, textItem, track, udta,
  vorbisComment, wavFile,
} from './audio';
import { needs, python, random, run, scratch, which } from './helpers';

// What src/tags/index.ts decides (which backend, what happens without ffmpeg, symbolic links), and the checks
// against other programs: ffmpeg, ffprobe and mutagen read what the native writers wrote. Those skip when
// the program is missing; the tests of each format (tagsMp3, tagsFlac, tagsWav, tagsMp4) need none of them.

const dir = scratch();
const rand = random(0x7a65);
const KEEP: CoverChange = { action: 'keep' };

const ffmpeg = which('ffmpeg');
const ffprobe = which('ffprobe');
const mutagen = python('mutagen');

/** One small file of each natively written format, with a title. */
const SAMPLES: Record<string, () => Buffer> = {
  mp3: () => Buffer.concat([id3Tag(3, [id3TextFrame(3, 'TIT2', 'Old')]), mpegAudio(rand, 600)]),
  flac: () => flacFile([streamInfo(rand), { type: FLAC.VORBIS_COMMENT, data: vorbisComment('test', ['TITLE=Old']) }], flacAudio(rand, 600)),
  wav: () => wavFile([['fmt ', WAV_FORMAT], ['data', rand.bytes(600)]]),
  m4a: () => mp4File({ front: true, tracks: [track(rand, 6)], udta: udta({ items: [textItem('\xa9nam', 'Old')] }) }),
};

/** The audio of a sample, found without src/tags. */
function audioOf(ext: string, bytes: Buffer): Buffer[] {
  switch (ext) {
    case 'mp3':
      return [bytes.subarray(id3Frames(bytes).length)];
    case 'flac':
      return [flacBlocks(bytes).audio];
    case 'wav':
      return [riffChunks(bytes).find(([id]) => id === 'data')![1]];
    default:
      return mp4Chunks(bytes).map((chunk) => chunk.data);
  }
}

// ---- Which backend ----------------------------------------------------------------

test('MP3, FLAC, WAV and M4A are read and written without ffmpeg', async () => {
  for (const [ext, build] of Object.entries(SAMPLES)) {
    const before = build();
    const file = path.join(dir, `native.${ext}`);
    fs.writeFileSync(file, before);
    const report = await readTagReport(file, undefined);
    assert.equal(report.writable, true, ext);
    assert.equal(report.coverWritable, true, ext);
    assert.equal(report.unavailable, undefined, ext);
    await saveTags(file, { ...report.fields, title: 'New', artist: 'Artist' }, KEEP, undefined);
    const after = await readTagReport(file, undefined);
    assert.equal(after.fields.title, 'New', ext);
    assert.equal(after.fields.artist, 'Artist', ext);
    assert.deepEqual(audioOf(ext, fs.readFileSync(file)), audioOf(ext, before), `the audio of the ${ext} file`);
  }
});

test('the extension decides, in any case: .MP3, .Flac, .M4B', async () => {
  for (const [name, ext] of [['UPPER.MP3', 'mp3'], ['Mixed.Flac', 'flac'], ['book.M4B', 'm4a']] as const) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, SAMPLES[ext]());
    assert.equal((await readTagReport(file, undefined)).fields.title, 'Old', name);
    await saveTags(file, fields({ title: 'New' }), KEEP, undefined);
    assert.equal((await readTagReport(file, undefined)).fields.title, 'New', name);
  }
});

test('without ffmpeg, the formats that need it have no tag section, and a save fails with the file as it was', async () => {
  for (const ext of ['ogg', 'opus', 'aiff', 'wma']) {
    const bytes = rand.bytes(300);
    const file = path.join(dir, `needs-ffmpeg.${ext}`);
    fs.writeFileSync(file, bytes);
    const report = await readTagReport(file, undefined);
    assert.equal(report.unavailable, true, ext);
    assert.equal(report.writable, false, ext);
    await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /ffmpeg is needed/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

// ---- Symbolic links ---------------------------------------------------------------

const NO_LINKS = process.platform === 'win32' && 'symbolic links need a privilege on Windows';

test('a save through a symbolic link updates the file it points to and leaves the link a link', { skip: NO_LINKS }, async () => {
  for (const [ext, build] of Object.entries(SAMPLES)) {
    const music = path.join(dir, `music-${ext}`);
    const links = path.join(dir, `links-${ext}`);
    fs.mkdirSync(music);
    fs.mkdirSync(links);
    const real = path.join(music, `real.${ext}`);
    const link = path.join(links, `link.${ext}`);
    const before = build();
    fs.writeFileSync(real, before);
    fs.symlinkSync(real, link);

    await saveTags(link, fields({ title: 'Through the link' }), KEEP, undefined);

    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${ext}: the link was replaced by a file`);
    assert.equal(fs.readlinkSync(link), real);
    assert.ok(fs.lstatSync(real).isFile());
    assert.equal((await readTagReport(real, undefined)).fields.title, 'Through the link', ext);
    assert.deepEqual(audioOf(ext, fs.readFileSync(real)), audioOf(ext, before));
    // Nothing is left behind next to either of them.
    assert.deepEqual(fs.readdirSync(music), [`real.${ext}`]);
    assert.deepEqual(fs.readdirSync(links), [`link.${ext}`]);
  }
});

test('a relative link and a link to a link are followed to the file as well', { skip: NO_LINKS }, async () => {
  const folder = path.join(dir, 'chain');
  fs.mkdirSync(path.join(folder, 'deep'), { recursive: true });
  const real = path.join(folder, 'deep', 'real.mp3');
  fs.writeFileSync(real, SAMPLES.mp3());
  fs.symlinkSync(path.join('deep', 'real.mp3'), path.join(folder, 'first.mp3'));
  fs.symlinkSync('first.mp3', path.join(folder, 'second.mp3'));

  await saveTags(path.join(folder, 'second.mp3'), fields({ title: 'Two links away' }), KEEP, undefined);

  assert.equal(fs.readlinkSync(path.join(folder, 'second.mp3')), 'first.mp3');
  assert.equal(fs.readlinkSync(path.join(folder, 'first.mp3')), path.join('deep', 'real.mp3'));
  assert.ok(fs.lstatSync(real).isFile());
  assert.equal((await readTagReport(real, undefined)).fields.title, 'Two links away');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['deep', 'first.mp3', 'second.mp3']);
});

// ---- The file itself --------------------------------------------------------------

test('every native writer keeps the mode of the file and leaves nothing else in the folder', { skip: process.platform === 'win32' && 'no file modes on Windows' }, async () => {
  for (const [ext, build] of Object.entries(SAMPLES)) {
    const folder = path.join(dir, `mode-${ext}`);
    fs.mkdirSync(folder);
    const file = path.join(folder, `song.${ext}`);
    fs.writeFileSync(file, build());
    fs.chmodSync(file, 0o640);
    await saveTags(file, fields({ title: 'New', lyrics: 'la '.repeat(2000) }), KEEP, undefined);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, ext);
    assert.deepEqual(fs.readdirSync(folder), [`song.${ext}`]);
  }
});

test('the original is never written into: another name of the same file keeps the old bytes', async (t) => {
  for (const [ext, build] of Object.entries(SAMPLES)) {
    const folder = path.join(dir, `hard-${ext}`);
    fs.mkdirSync(folder);
    const file = path.join(folder, `song.${ext}`);
    const twin = path.join(folder, `twin.${ext}`);
    const before = build();
    fs.writeFileSync(file, before);
    try {
      fs.linkSync(file, twin);
    } catch {
      t.skip('this file system has no hard links');
      return;
    }
    await saveTags(file, fields({ title: 'New', lyrics: 'la '.repeat(500) }), KEEP, undefined);
    // A save builds a new file and renames it over the name. Had it written into the old one, the twin would show it.
    assert.deepEqual(fs.readFileSync(twin), before, ext);
    assert.notDeepEqual(fs.readFileSync(file), before, ext);
  }
});

// ---- ffmetadata, the form tags travel to ffmpeg in -----------------------------------

test('ffmetadata: what is written is read back, with every special character escaped', () => {
  const tags: Tag[] = [
    ['title', 'a=b; c#d \\ e'],
    ['comment', 'line one\nline two\n'],
    ['key=with;odd#chars', 'value'],
    ['lyrics-eng', '[CHAPTER] is not a section here'],
    ['empty', ''],
    ['unicode', 'Заголовок 標題 🎵'],
  ];
  const text = serializeMetadata(tags);
  assert.ok(text.startsWith(';FFMETADATA1\n'));
  assert.deepEqual(parseMetadata(text), tags);
  // Line ends of the form become the one kind ffmpeg knows.
  assert.deepEqual(parseMetadata(serializeMetadata([['comment', 'a\r\nb\rc']])), [['comment', 'a\nb\nc']]);
});

test('ffmetadata: comment lines are skipped and the global tags end at the first section', () => {
  const dump = ';FFMETADATA1\n# a comment\ntitle=T\n; another\nartist=A\\\nB\n[CHAPTER]\nTIMEBASE=1/1000\ntitle=Chapter\n[STREAM]\ntitle=Stream\n';
  assert.deepEqual(parseMetadata(dump), [['title', 'T'], ['artist', 'A\nB']]);
});

test('ffmetadata: random tags survive the round trip', () => {
  const pick = random(77);
  const alphabet = ['a', 'B', ' ', '=', ';', '#', '\\', '\n', '[', ']', 'é', '標', '🎵'];
  for (let round = 0; round < 300; round++) {
    const text = () => Array.from({ length: pick.int(12) }, () => pick.pick(alphabet)).join('');
    // ffmpeg itself never writes an empty key, and a key can't start a line with what would be a comment or a section.
    const tags: Tag[] = Array.from({ length: 1 + pick.int(4) }, () => [`k${text()}`, text()]);
    assert.deepEqual(parseMetadata(serializeMetadata(tags)), tags, JSON.stringify(tags));
  }
});

// ---- Against ffmpeg, ffprobe and mutagen ----------------------------------------------

/** MD5 of the decoded audio, which is what the listener gets. */
const decodedDigest = (file: string) => run(ffmpeg!, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a', '-f', 'md5', '-']).toString().trim();
/** MD5 of the audio packets as stored. */
const packetDigest = (file: string) => run(ffmpeg!, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).toString().trim();

/** The tags ffprobe finds, with lower-case names, and what it printed as errors. */
function probe(file: string): { tags: Record<string, string>; streams: number } {
  const out = JSON.parse(run(ffprobe!, ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', file]).toString()) as {
    format: { tags?: Record<string, string> };
    streams: { tags?: Record<string, string> }[];
  };
  const tags = { ...(out.streams[0]?.tags ?? {}), ...(out.format.tags ?? {}) };
  return { tags: Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value])), streams: out.streams.length };
}

const SOUND = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-f', 'lavfi', '-i', 'anoisesrc=d=2:c=pink:a=0.2:seed=7', '-filter_complex', '[0:a][1:a]amix=inputs=2[a]', '-map', '[a]'];
const TAGGED = ['-metadata', 'title=Original', '-metadata', 'artist=Tester', '-metadata', 'track=3/9', '-metadata', 'genre=Rock'];

/** Encodes two seconds of sound; undefined when this ffmpeg has no encoder for the format. */
function encode(name: string, options: string[]): string | undefined {
  const file = path.join(dir, name);
  try {
    run(ffmpeg!, ['-v', 'error', '-nostdin', '-y', ...SOUND, ...options, ...TAGGED, file]);
    return file;
  } catch {
    return undefined;
  }
}

const EDIT: Partial<Fields> = {
  title: 'Новое название ✓ 新しい', artist: 'Ärtist Ωmega', album: 'Альбом №2', album_artist: 'Сборник', date: '2024', track: '11/20', disc: '2/3',
  genre: 'Пост-рок', composer: 'J. S. Bach', comment: 'A comment', lyrics: 'la '.repeat(1500).trim(),
};

const REAL: [name: string, options: string[]][] = [
  ['real.mp3', ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3']],
  ['real-v24.mp3', ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '4']],
  ['real.flac', ['-c:a', 'flac']],
  ['real.wav', ['-c:a', 'pcm_s16le']],
  ['real-end.m4a', ['-c:a', 'aac', '-b:a', '64k']],
  ['real-front.m4a', ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']],
  ['real-alac.m4a', ['-c:a', 'alac', '-movflags', '+faststart']],
];

test('files written by ffmpeg: after a full edit and a new cover the decoded audio is the same and ffprobe reads the new tags', { skip: needs(ffmpeg, 'ffmpeg') || needs(ffprobe, 'ffprobe') }, async (t) => {
  const cover = path.join(dir, 'probe-cover.png');
  fs.writeFileSync(cover, png(16, 16));
  let checked = 0;
  for (const [name, options] of REAL) {
    const file = encode(name, options);
    if (!file) {
      t.diagnostic(`${name}: this ffmpeg has no encoder for it`);
      continue;
    }
    const before = decodedDigest(file);
    const report = await readTagReport(file, undefined);
    assert.equal(report.writable, true, `${name}: ${report.note}`);
    assert.equal(report.fields.title, 'Original', name);
    assert.equal(report.fields.track, '3/9', name);

    await saveTags(file, { ...report.fields, ...EDIT }, { action: 'replace', path: cover }, undefined);

    assert.equal(decodedDigest(file), before, `${name}: the decoded audio changed`);
    const { tags } = probe(file);
    assert.equal(tags.title, EDIT.title, name);
    assert.equal(tags.artist, EDIT.artist, name);
    assert.equal(tags.album, EDIT.album, name);
    // WAV: ffprobe reads the INFO list, which has no place for the total.
    assert.ok(tags.track === '11/20' || (name.endsWith('.wav') && tags.track?.startsWith('11')), `${name}: track ${tags.track}`);
    checked++;
  }
  assert.ok(checked >= 4, 'FLAC, WAV and AAC are encoders every ffmpeg has');
});

test('files written by ffmpeg in the formats that go through it: tags and cover are written, the audio packets stay the same', { skip: needs(ffmpeg, 'ffmpeg') }, async (t) => {
  const cover = path.join(dir, 'ogg-cover.jpg');
  // ffmpeg reads the size of the picture from it, so this one is drawn by ffmpeg.
  run(ffmpeg!, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64', '-frames:v', '1', cover]);
  const formats: [name: string, options: string[], covers: boolean][] = [
    // Without the ID3 chunk an AIFF file has room for a title and little else.
    ['real.aiff', ['-c:a', 'pcm_s16be', '-write_id3v2', '1'], false],
    ['real.ogg', ['-c:a', 'libvorbis'], true],
    ['real.opus', ['-c:a', 'libopus'], true],
  ];
  for (const [name, options, covers] of formats) {
    const file = encode(name, options);
    if (!file) {
      t.diagnostic(`${name}: this ffmpeg has no encoder for it`);
      continue;
    }
    const before = packetDigest(file);
    const report = await readTagReport(file, ffmpeg);
    assert.equal(report.writable, true, name);
    assert.equal(report.coverWritable, covers, name);
    assert.equal(report.fields.title, 'Original', name);

    const edit = { ...report.fields, title: 'Новое название', artist: 'Ärtist', lyrics: '', genre: '' };
    await saveTags(file, edit, covers ? { action: 'replace', path: cover } : KEEP, ffmpeg);

    assert.equal(packetDigest(file), before, `${name}: the audio packets changed`);
    const after = await readTagReport(file, ffmpeg);
    assert.equal(after.fields.title, 'Новое название', name);
    assert.equal(after.fields.artist, 'Ärtist', name);
    assert.equal(after.fields.genre, '', name);
    assert.equal(after.fields.track, '3/9', name);
    if (covers) {
      assert.deepEqual(Buffer.from(after.cover!), fs.readFileSync(cover), name);
      await saveTags(file, edit, { action: 'remove' }, ffmpeg);
      assert.equal((await readTagReport(file, ffmpeg)).cover, undefined, name);
      assert.equal(packetDigest(file), before, name);
    }
    assert.deepEqual(fs.readdirSync(dir).filter((entry) => entry.includes('previewix')), [], 'a temporary file was left behind');
  }
});

/** Prints, for every file named, what mutagen reads from it: the fields the test compares, in one shape for all formats. */
const MUTAGEN_READ = `
import json, sys
from mutagen import File
out = {}
for path in sys.argv[1:]:
    f = File(path)
    t = f.tags
    kind = type(f).__name__
    if kind == 'MP4':
        out[path] = {
            'title': t['\\xa9nam'][0], 'artist': t['\\xa9ART'][0], 'track': '%d/%d' % t['trkn'][0], 'disc': '%d/%d' % t['disk'][0], 'genre': t['\\xa9gen'][0],
            'lyrics': t['\\xa9lyr'][0], 'cover': len(t['covr'][0]), 'pictures': len(t['covr']),
            'kept': [bytes(v).decode() for v in t.get('----:com.apple.iTunes:iTunNORM', [])] + [str(v) for v in t.get('soar', [])],
        }
    elif kind in ('MP3', 'WAVE'):
        out[path] = {
            'title': str(t['TIT2']), 'artist': str(t['TPE1']), 'track': str(t['TRCK']), 'disc': str(t['TPOS']), 'genre': str(t['TCON']),
            'lyrics': t.getall('USLT')[0].text, 'cover': len(t.getall('APIC')[0].data), 'pictures': len(t.getall('APIC')),
            'kept': [str(v) for v in t.getall('TXXX:kept')],
        }
    else:
        out[path] = {
            'title': t['TITLE'][0], 'artist': t['ARTIST'][0], 'track': t['TRACKNUMBER'][0], 'disc': t['DISCNUMBER'][0], 'genre': t['GENRE'][0],
            'lyrics': t['LYRICS'][0], 'cover': len(f.pictures[0].data), 'pictures': len(f.pictures),
            'kept': t.get('KEPT', []),
        }
print(json.dumps(out))
`;

/** Gives a file tags the form does not edit, with mutagen, before Previewix edits the rest. */
const MUTAGEN_TAG = `
import sys
from mutagen import File
from mutagen.id3 import TXXX
from mutagen.mp4 import MP4FreeForm
for path in sys.argv[1:]:
    f = File(path)
    kind = type(f).__name__
    if f.tags is None:
        f.add_tags()
    if kind == 'MP4':
        f.tags['----:com.apple.iTunes:iTunNORM'] = [MP4FreeForm(b' 00000A2B 00000B1C')]
        f.tags['soar'] = ['Sort Artist']
    elif kind in ('MP3', 'WAVE'):
        f.tags.add(TXXX(encoding=3, desc='kept', text=['as it was']))
    else:
        f.tags['KEPT'] = ['as it was']
    f.save()
`;

test('mutagen reads what the native writers wrote, and finds the tags it wrote itself still there', { skip: needs(ffmpeg, 'ffmpeg') || needs(mutagen, 'Python with mutagen') }, async (t) => {
  const cover = path.join(dir, 'mutagen-cover.png');
  const image = png(16, 16, 3000);
  fs.writeFileSync(cover, image);
  const files = REAL.map(([name, options]) => encode(`mutagen-${name}`, options)).filter((file): file is string => !!file);
  run(mutagen!, ['-c', MUTAGEN_TAG, ...files]);
  const digests = files.map(decodedDigest);
  for (const file of files) {
    const report = await readTagReport(file, undefined);
    assert.equal(report.writable, true, `${path.basename(file)}: ${report.note}`);
    await saveTags(file, { ...report.fields, ...EDIT }, { action: 'replace', path: cover }, undefined);
  }
  const read = JSON.parse(run(mutagen!, ['-c', MUTAGEN_READ, ...files]).toString()) as Record<string, Record<string, unknown>>;
  files.forEach((file, i) => {
    const name = path.basename(file);
    const tags = read[file];
    assert.equal(tags.title, EDIT.title, name);
    assert.equal(tags.artist, EDIT.artist, name);
    assert.equal(tags.track, '11/20', name);
    assert.equal(tags.disc, '2/3', name);
    assert.equal(tags.genre, EDIT.genre, name);
    assert.equal(tags.lyrics, EDIT.lyrics, name);
    assert.equal(tags.cover, image.length, name);
    assert.equal(tags.pictures, 1, name);
    assert.deepEqual(tags.kept, name.endsWith('.m4a') ? [' 00000A2B 00000B1C', 'Sort Artist'] : ['as it was'], name);
    assert.equal(decodedDigest(file), digests[i], `${name}: the decoded audio changed`);
  });
  t.diagnostic(`${files.length} files`);
});
