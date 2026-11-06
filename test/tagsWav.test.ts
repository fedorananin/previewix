import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import type { CoverChange, Fields } from '../src/tags/common';
import { readTagReport, saveTags } from '../src/tags/index';
import { WAV_FORMAT, fields, id3Frames, id3Picture, id3Tag, id3TextFrame, id3UserText, infoList, jpeg, png, riffChunks, subChunks, u32le, wavFile, type RiffChunk } from './audio';
import { random, scratch } from './helpers';

// WAV: the LIST INFO chunk and the "id3 " chunk (src/tags/wav.ts). The files are hand-built chunks around
// noise; a saved file is taken apart again with the chunk reader in audio.ts, which insists that every size adds up.

const dir = scratch();
const rand = random(0x3a7);
const KEEP: CoverChange = { action: 'keep' };

let count = 0;
function put(bytes: Buffer, name = 'take.wav'): string {
  const file = path.join(dir, `${++count}-${name}`);
  fs.writeFileSync(file, bytes);
  return file;
}

async function edit(file: string, values: Partial<Fields>, cover: CoverChange = KEEP): Promise<void> {
  const report = await readTagReport(file, undefined);
  assert.equal(report.writable, true, 'the file should be offered for editing');
  await saveTags(file, { ...report.fields, ...values }, cover, undefined);
}

const read = (file: string) => readTagReport(file, undefined);
const chunksOf = (file: string) => riffChunks(fs.readFileSync(file));
const idsOf = (file: string) => chunksOf(file).map(([id]) => id);
const chunk = (chunks: RiffChunk[], id: string) => chunks.find(([name]) => name === id)?.[1];
/** The entries of the INFO list, with the terminating zero taken off. */
function infoOf(file: string): [string, string][] {
  const list = chunksOf(file).filter(([id, data]) => id === 'LIST' && data.toString('latin1', 0, 4) === 'INFO');
  assert.equal(list.length, 1, 'one INFO list');
  return subChunks(list[0][1].subarray(4)).map(([id, data]) => {
    assert.equal(data.at(-1), 0, 'INFO values end in a zero byte');
    return [id, data.subarray(0, -1).toString('utf8')];
  });
}

// ---- Reading --------------------------------------------------------------------

test('reads the INFO list, with the track number under either of its names', async () => {
  const info = infoList([['INAM', 'Title'], ['IART', 'Artist'], ['IPRD', 'Album'], ['ICRD', '2019'], ['IGNR', 'Rock'], ['ICMT', 'A comment'], ['IPRT', '3'], ['ISFT', 'Lavf61.7.100'], ['IZZZ', 'x']]);
  const file = put(wavFile([['fmt ', WAV_FORMAT], ['LIST', info], ['data', rand.bytes(400)]]));
  const report = await read(file);
  assert.deepEqual(report.fields, fields({ title: 'Title', artist: 'Artist', album: 'Album', date: '2019', genre: 'Rock', comment: 'A comment', track: '3' }));
  assert.deepEqual(report.other, [['Software', 'Lavf61.7.100'], ['IZZZ', 'x']]);
});

test('the ID3 chunk wins over the INFO list, which fills in what the tag lacks', async () => {
  const cover = jpeg(2, 2, rand.bytes(60));
  const tag = id3Tag(3, [id3TextFrame(3, 'TIT2', 'From ID3'), id3TextFrame(3, 'TCOM', 'Composer'), id3UserText(3, 'key', 'value'), id3Picture(3, 3, cover)]);
  const info = infoList([['INAM', 'From INFO'], ['IART', 'Artist from INFO']]);
  for (const id of ['id3 ', 'ID3 ']) {
    const file = put(wavFile([['fmt ', WAV_FORMAT], ['data', rand.bytes(400)], ['LIST', info], [id, tag]]));
    const report = await read(file);
    assert.equal(report.fields.title, 'From ID3');
    assert.equal(report.fields.artist, 'Artist from INFO');
    assert.equal(report.fields.composer, 'Composer');
    assert.deepEqual(report.other, [['key', 'value']]);
    assert.deepEqual(Buffer.from(report.cover!), cover);
  }
});

test('INFO text that is not UTF-8 is read as Latin-1', async () => {
  const info = Buffer.concat([Buffer.from('INFOINAM'), u32le(5), Buffer.from('caf\xe9\0', 'latin1'), Buffer.alloc(1)]);
  const file = put(wavFile([['fmt ', WAV_FORMAT], ['data', rand.bytes(100)], ['LIST', info]]));
  assert.equal((await read(file)).fields.title, 'café');
});

// ---- Writing --------------------------------------------------------------------

test('a save keeps the format, the audio and every unknown chunk, and puts the tags behind them', async () => {
  const audio = rand.bytes(3001); // an odd length: the chunk is followed by a padding byte
  const bext = rand.bytes(602);
  const cue = rand.bytes(27);
  const labels = Buffer.concat([Buffer.from('adtl'), rand.bytes(40)]);
  const file = put(
    wavFile([['fmt ', WAV_FORMAT], ['bext', bext], ['LIST', infoList([['INAM', 'Old'], ['IENG', 'Engineer']])], ['data', audio], ['cue ', cue], ['LIST', labels]]),
  );

  await edit(file, { title: 'New', artist: 'Исполнитель', composer: 'Composer' });
  const chunks = chunksOf(file); // also checks the RIFF size and that every chunk fits
  assert.deepEqual(chunks.map(([id]) => id), ['fmt ', 'bext', 'data', 'cue ', 'LIST', 'LIST', 'id3 ']);
  assert.deepEqual(chunk(chunks, 'fmt '), WAV_FORMAT);
  assert.deepEqual(chunk(chunks, 'bext'), bext);
  assert.deepEqual(chunk(chunks, 'data'), audio);
  assert.deepEqual(chunk(chunks, 'cue '), cue);
  // A LIST of another kind is not the tag list and stays as it is.
  assert.deepEqual(chunks[4][1], labels);
  // The fields INFO has a name for, and what else was in the list. Composer has none.
  assert.deepEqual(infoOf(file), [['IENG', 'Engineer'], ['INAM', 'New'], ['IART', 'Исполнитель']]);
  // The ID3 tag holds everything.
  const tag = id3Frames(chunk(chunks, 'id3 ')!);
  assert.deepEqual(tag.frames.map((f) => f.id), ['TIT2', 'TPE1', 'TCOM']);
  assert.deepEqual((await read(file)).fields, fields({ title: 'New', artist: 'Исполнитель', composer: 'Composer' }));
  assert.deepEqual((await read(file)).other, [['Engineer', 'Engineer']]);
});

test('a file without tags gets both chunks; one whose fields are all empty gets no INFO list', async () => {
  const audio = rand.bytes(800);
  const file = put(wavFile([['fmt ', WAV_FORMAT], ['data', audio]]));
  assert.deepEqual((await read(file)).fields, fields());
  await edit(file, { title: 'T', lyrics: 'la' });
  assert.deepEqual(idsOf(file), ['fmt ', 'data', 'LIST', 'id3 ']);
  assert.deepEqual(infoOf(file), [['INAM', 'T']]);
  assert.deepEqual(chunk(chunksOf(file), 'data'), audio);

  await edit(file, { title: '', lyrics: '' });
  assert.deepEqual(idsOf(file), ['fmt ', 'data', 'id3 ']);
  assert.deepEqual(chunk(chunksOf(file), 'data'), audio);
  assert.deepEqual((await read(file)).fields, fields());
});

test('the frames of an existing ID3 chunk that the form does not edit are kept as they were', async () => {
  const kept = [id3UserText(3, 'replaygain_track_gain', '-6.5 dB'), id3Picture(3, 4, jpeg(1, 1, rand.bytes(30)))];
  const tag = id3Tag(3, [id3TextFrame(3, 'TIT2', 'Old'), ...kept]);
  const file = put(wavFile([['fmt ', WAV_FORMAT], ['data', rand.bytes(300)], ['id3 ', tag]]));
  await edit(file, { title: 'New' });
  const frames = id3Frames(chunk(chunksOf(file), 'id3 ')!).frames;
  assert.deepEqual(frames.slice(1).map((f) => f.raw), kept);
});

test('the track number is written as ITRK and the IPRT it was read from goes', async () => {
  const file = put(wavFile([['fmt ', WAV_FORMAT], ['data', rand.bytes(300)], ['LIST', infoList([['IPRT', '3'], ['INAM', 'T']])]]));
  await edit(file, { track: '4' });
  assert.deepEqual(infoOf(file), [['INAM', 'T'], ['ITRK', '4']]);
});

test('the cover goes into the ID3 chunk, and comes out again', async () => {
  const audio = rand.bytes(500);
  const file = put(wavFile([['fmt ', WAV_FORMAT], ['data', audio]]));
  const image = png(3, 3);
  const picture = path.join(dir, 'cover.png');
  fs.writeFileSync(picture, image);
  await edit(file, { title: 'T' }, { action: 'replace', path: picture });
  assert.deepEqual(Buffer.from((await read(file)).cover!), image);
  assert.deepEqual(chunk(chunksOf(file), 'data'), audio);
  await edit(file, {}, { action: 'remove' });
  assert.equal((await read(file)).cover, undefined);
  assert.deepEqual(chunk(chunksOf(file), 'data'), audio);
});

test('a recording that was cut off (a data chunk of size zero, or longer than the file) keeps all of its audio', async () => {
  const audio = rand.bytes(1000);
  for (const declared of [0, 0xffffffff, 5000]) {
    const bytes = Buffer.concat([Buffer.from('RIFF'), u32le(declared ? Math.min(declared + 36, 0xffffffff) : 0), Buffer.from('WAVE'), Buffer.from('fmt '), u32le(16), WAV_FORMAT, Buffer.from('data'), u32le(declared), audio]);
    const file = put(bytes, `cut-${declared}.wav`);
    await edit(file, { title: 'T' });
    const chunks = chunksOf(file);
    assert.deepEqual(chunks.map(([id]) => id), ['fmt ', 'data', 'LIST', 'id3 ']);
    assert.deepEqual(chunk(chunks, 'data'), audio);
  }
});

test('an ID3v2.2 tag in the chunk is replaced by a new tag', async () => {
  const v22 = id3Tag(2, [Buffer.concat([Buffer.from('TT2'), Buffer.from([0, 0, 4]), Buffer.from('\0Old', 'latin1')])]);
  const file = put(wavFile([['fmt ', WAV_FORMAT], ['data', rand.bytes(300)], ['id3 ', v22]]));
  await edit(file, { title: 'New' });
  const tag = id3Frames(chunk(chunksOf(file), 'id3 ')!);
  assert.equal(tag.version, 3);
  assert.deepEqual(tag.frames.map((f) => f.id), ['TIT2']);
});

// ---- What is not rewritten --------------------------------------------------------

test('RF64 and other files that are not RIFF WAVE are not rewritten', async () => {
  const wave = wavFile([['fmt ', WAV_FORMAT], ['data', rand.bytes(300)]]);
  for (const [name, change] of [['rf64', (b: Buffer) => b.write('RF64', 0, 'latin1')], ['avi', (b: Buffer) => b.write('AVI ', 8, 'latin1')]] as const) {
    const bytes = Buffer.from(wave);
    change(bytes);
    const file = put(bytes, `${name}.wav`);
    assert.equal((await read(file)).writable, false);
    await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /left untouched/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

test('a file that ends inside a chunk other than the audio is not rewritten', async () => {
  // Saved as it came, the chunk was written out shortened to fit: a file that looks complete, and without audio when the cut is in front of it.
  const notes = rand.bytes(60);
  const whole = wavFile([['fmt ', WAV_FORMAT], ['bext', notes], ['data', rand.bytes(300)], ['LIST', infoList([['INAM', 'T']])], ['id3 ', id3Tag(3, [id3TextFrame(3, 'TIT2', 'T')])]]);
  const [bext, data] = [12 + 8 + WAV_FORMAT.length, 12 + 8 + WAV_FORMAT.length + 8 + notes.length];
  const refused = [12 + 8, 12 + 8 + 5, bext - 1, bext + 8, bext + 8 + 59, data + 8 + 300 + 8, data + 8 + 300 + 8 + 9, whole.length - 1];
  for (const length of refused) {
    const bytes = whole.subarray(0, length);
    const file = put(bytes, `cut-${length}.wav`);
    const report = await read(file);
    assert.deepEqual([report.writable, report.unavailable, report.note], [false, undefined, "This file ends inside one of its chunks (it is incomplete or damaged), so its tags can't be edited."], `cut at ${length}`);
    await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /ends inside one of its chunks/, `cut at ${length}`);
    assert.deepEqual(fs.readFileSync(file), bytes, `cut at ${length}`);
  }
  // Between two chunks nothing is missing that the file says it has, and a cut in the audio is the recorder's case.
  for (const length of [bext, data, data + 8 + 100, data + 8 + 300]) {
    const bytes = whole.subarray(0, length);
    const file = put(bytes, `left-${length}.wav`);
    await edit(file, { title: 'X' });
    const chunks = chunksOf(file);
    assert.deepEqual(chunk(chunks, 'fmt '), WAV_FORMAT);
    assert.deepEqual(chunk(chunks, 'bext'), length > bext ? notes : undefined);
    assert.deepEqual(chunk(chunks, 'data'), length > data ? bytes.subarray(data + 8) : undefined, `cut at ${length}`);
  }
});

test('chunks without end get an answer soon: a file of zeros behind the header is not read as a million empty chunks', async () => {
  const bytes = Buffer.concat([wavFile([]), Buffer.alloc(4 << 20)]);
  const file = put(bytes, 'zeros.wav');
  const started = performance.now();
  assert.equal((await read(file)).writable, false);
  await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /left untouched/);
  const took = performance.now() - started;
  assert.ok(took < 2000, `took ${Math.round(took)} ms`);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
