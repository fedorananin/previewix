import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import type { CoverChange, Fields } from '../src/tags/common';
import { readTagReport, saveTags } from '../src/tags/index';
import { FLAC, fields, flacAudio, flacBlocks, flacFile, flacPictureBlock, id3Tag, id3TextFrame, jpeg, png, streamInfo, vorbisComment, vorbisEntries, type FlacBlock } from './audio';
import { random, scratch } from './helpers';

// FLAC: the metadata blocks in front of the audio frames (src/tags/flac.ts). The files are hand-built
// blocks followed by noise; a saved file is taken apart again with the block reader in audio.ts.

const dir = scratch();
const rand = random(0xf1ac);
const KEEP: CoverChange = { action: 'keep' };

let count = 0;
function put(bytes: Buffer, name = 'song.flac'): string {
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
const comments = (entries: string[], vendor = 'reference libFLAC 1.4.3 20230623'): FlacBlock => ({ type: FLAC.VORBIS_COMMENT, data: vorbisComment(vendor, entries) });
const entriesOf = (file: string) => vorbisEntries(flacBlocks(fs.readFileSync(file)).blocks.find((b) => b.type === FLAC.VORBIS_COMMENT)!.data);
const types = (file: string) => flacBlocks(fs.readFileSync(file)).blocks.map((b) => b.type);

// ---- Reading --------------------------------------------------------------------

test('reads the fields whatever case and alias their names are written in', async () => {
  const file = put(
    flacFile(
      [
        streamInfo(rand),
        comments([
          'TITLE=Заголовок', 'artist=Artist', 'Album=Album', 'ALBUM ARTIST=Various', 'YEAR=2019', 'TRACKNUMBER=3', 'DISCNUMBER=1',
          'GENRE=Rock', 'COMPOSER=Composer', 'DESCRIPTION=A comment', 'UNSYNCEDLYRICS=Line one\nLine two',
        ]),
      ],
      flacAudio(rand, 300),
    ),
  );
  assert.deepEqual((await read(file)).fields, fields({
    title: 'Заголовок', artist: 'Artist', album: 'Album', album_artist: 'Various', date: '2019', track: '3', disc: '1',
    genre: 'Rock', composer: 'Composer', comment: 'A comment', lyrics: 'Line one\nLine two',
  }));
});

test('a field stored as several comments is shown joined, and the other comments are listed', async () => {
  const file = put(
    flacFile(
      [streamInfo(rand), comments(['ARTIST=First', 'REPLAYGAIN_TRACK_GAIN=-6.50 dB', 'ARTIST=Second', 'METADATA_BLOCK_PICTURE=AAAA', 'ISRC=XX1230000001', 'KEY=a=b'])],
      flacAudio(rand, 300),
    ),
  );
  const report = await read(file);
  assert.equal(report.fields.artist, 'First; Second');
  // A picture kept as a comment is not a tag to show. A value may hold an equals sign.
  assert.deepEqual(report.other, [['REPLAYGAIN_TRACK_GAIN', '-6.50 dB'], ['ISRC', 'XX1230000001'], ['KEY', 'a=b']]);
});

test('the cover is the front cover, wherever it stands; without one, the first picture', async () => {
  const [back, front] = [jpeg(1, 1, rand.bytes(40)), png(2, 2)];
  const both = put(
    flacFile([streamInfo(rand), { type: FLAC.PICTURE, data: flacPictureBlock(4, back) }, { type: FLAC.PICTURE, data: flacPictureBlock(3, front, 'image/png', 'обложка') }], flacAudio(rand, 300)),
  );
  assert.deepEqual(Buffer.from((await read(both)).cover!), front);
  const one = put(flacFile([streamInfo(rand), { type: FLAC.PICTURE, data: flacPictureBlock(4, back) }], flacAudio(rand, 300)));
  assert.deepEqual(Buffer.from((await read(one)).cover!), back);
});

// ---- Writing --------------------------------------------------------------------

test('a save rewrites the comments and keeps the audio, the stream information and every other block', async () => {
  const info = streamInfo(rand);
  const seek: FlacBlock = { type: FLAC.SEEKTABLE, data: rand.bytes(36) };
  const app: FlacBlock = { type: FLAC.APPLICATION, data: Buffer.concat([Buffer.from('riff'), rand.bytes(60)]) };
  const cue: FlacBlock = { type: 5, data: rand.bytes(80) };
  const audio = flacAudio(rand, 4000);
  // The comment block in front of the stream information is not valid FLAC order, and a save puts that right.
  const file = put(flacFile([info, seek, comments(['TITLE=Old', 'ARTIST=Artist']), app, { type: FLAC.PADDING, data: Buffer.alloc(500) }, cue], audio));

  await edit(file, { title: 'New' });
  const written = flacBlocks(fs.readFileSync(file));
  assert.deepEqual(written.audio, audio);
  assert.equal(written.blocks[0].type, FLAC.STREAMINFO);
  assert.deepEqual(written.blocks[0].data, info.data);
  for (const block of [seek, app, cue]) {
    assert.deepEqual(written.blocks.filter((b) => b.type === block.type).map((b) => b.data), [block.data]);
  }
  assert.equal(written.blocks.filter((b) => b.type === FLAC.VORBIS_COMMENT).length, 1);
  // One padding block, at the end, so that the next tagger has room.
  assert.deepEqual(written.blocks.map((b) => b.type).filter((type) => type === FLAC.PADDING), [FLAC.PADDING]);
  assert.equal(written.blocks.at(-1)!.type, FLAC.PADDING);
  assert.ok(written.blocks.at(-1)!.data.every((byte) => byte === 0));
  assert.deepEqual(entriesOf(file).entries, ['TITLE=New', 'ARTIST=Artist']);
});

test('the stream information stays the first block even when the file had it elsewhere', async () => {
  const info = streamInfo(rand);
  const file = put(flacFile([{ type: FLAC.SEEKTABLE, data: rand.bytes(18) }, comments(['TITLE=Old']), info, { type: FLAC.APPLICATION, data: rand.bytes(20) }], flacAudio(rand, 300)));
  await edit(file, { title: 'New' });
  assert.deepEqual(types(file), [FLAC.STREAMINFO, FLAC.SEEKTABLE, FLAC.APPLICATION, FLAC.VORBIS_COMMENT, FLAC.PADDING]);
  assert.deepEqual(flacBlocks(fs.readFileSync(file)).blocks[0].data, info.data);
});

test('changing one field keeps the vendor string and every other comment, in name, case, order and number', async () => {
  const before = ['artist=First', 'Title=Old', 'ARTIST=Second', 'REPLAYGAIN_TRACK_GAIN=-6.50 dB', 'Comment=c', 'MUSICBRAINZ_TRACKID=f4a7', 'GENRE=Rock', 'GENRE=Pop'];
  const file = put(flacFile([streamInfo(rand), comments(before, 'Lavf61.7.100')], flacAudio(rand, 300)));
  await edit(file, { title: 'New ✓' });
  const after = entriesOf(file);
  assert.equal(after.vendor, 'Lavf61.7.100');
  // The new value takes the place, and the name, of the comment it replaces.
  assert.deepEqual(after.entries, before.map((entry) => (entry === 'Title=Old' ? 'Title=New ✓' : entry)));
});

test('a changed field that was stored as several comments becomes one, in the place of the first', async () => {
  const file = put(flacFile([streamInfo(rand), comments(['ARTIST=First', 'TITLE=T', 'ARTIST=Second', 'DATE=1999'])], flacAudio(rand, 300)));
  await edit(file, { artist: 'Only' });
  assert.deepEqual(entriesOf(file).entries, ['ARTIST=Only', 'TITLE=T', 'DATE=1999']);
});

test('clearing a field removes its comments; a new field is added under its usual name', async () => {
  const file = put(flacFile([streamInfo(rand), comments(['TITLE=T', 'DESCRIPTION=c', 'YEAR=1999'])], flacAudio(rand, 300)));
  await edit(file, { comment: '', date: '', album_artist: 'Various', lyrics: 'la' });
  assert.deepEqual(entriesOf(file).entries, ['TITLE=T', 'ALBUMARTIST=Various', 'LYRICS=la']);
});

test('a file without a comment block gets one', async () => {
  const audio = flacAudio(rand, 300);
  const file = put(flacFile([streamInfo(rand)], audio));
  assert.deepEqual((await read(file)).fields, fields());
  await edit(file, { title: 'T' });
  assert.deepEqual(types(file), [FLAC.STREAMINFO, FLAC.VORBIS_COMMENT, FLAC.PADDING]);
  assert.deepEqual(entriesOf(file).entries, ['TITLE=T']);
  assert.deepEqual(flacBlocks(fs.readFileSync(file)).audio, audio);
});

// ---- The cover --------------------------------------------------------------------

test('replacing the cover swaps the front cover and keeps the other pictures; removing it removes them all', async () => {
  const [back, front] = [flacPictureBlock(4, jpeg(1, 1, rand.bytes(30))), flacPictureBlock(3, jpeg(2, 2, rand.bytes(30)))];
  const audio = flacAudio(rand, 900);
  const file = put(flacFile([streamInfo(rand), { type: FLAC.PICTURE, data: back }, { type: FLAC.PICTURE, data: front }, comments(['TITLE=T'])], audio));
  const image = png(7, 5);
  const picture = path.join(dir, 'new-cover.png');
  fs.writeFileSync(picture, image);

  await edit(file, {}, { action: 'replace', path: picture });
  let written = flacBlocks(fs.readFileSync(file));
  const pictures = written.blocks.filter((b) => b.type === FLAC.PICTURE).map((b) => b.data);
  assert.equal(pictures.length, 2);
  assert.deepEqual(pictures[0], back);
  // Type 3 (front cover), the MIME type, no description, the size read from the image, 24 bits, no palette.
  const expected = Buffer.alloc(32 + 'image/png'.length);
  expected.writeUInt32BE(3, 0);
  expected.writeUInt32BE(9, 4);
  expected.write('image/png', 8, 'latin1');
  expected.writeUInt32BE(7, 21);
  expected.writeUInt32BE(5, 25);
  expected.writeUInt32BE(24, 29);
  expected.writeUInt32BE(image.length, 37);
  assert.deepEqual(pictures[1], Buffer.concat([expected, image]));
  assert.deepEqual(Buffer.from((await read(file)).cover!), image);
  assert.deepEqual(written.audio, audio);
  assert.deepEqual(entriesOf(file).entries, ['TITLE=T']);

  await edit(file, {}, { action: 'remove' });
  written = flacBlocks(fs.readFileSync(file));
  assert.equal(written.blocks.some((b) => b.type === FLAC.PICTURE), false);
  assert.deepEqual(written.audio, audio);
});

// ---- What is not rewritten --------------------------------------------------------

test('a FLAC file that starts with an ID3 tag is not rewritten', async () => {
  const bytes = Buffer.concat([id3Tag(3, [id3TextFrame(3, 'TIT2', 'T')]), flacFile([streamInfo(rand), comments(['TITLE=T'])], flacAudio(rand, 300))]);
  const file = put(bytes);
  assert.equal((await read(file)).writable, false);
  await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /left untouched/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

const CUT = flacFile([streamInfo(rand), comments(['TITLE=T']), { type: FLAC.SEEKTABLE, data: rand.bytes(180) }], flacAudio(rand, 300));
const SEEKTABLE_AT = CUT.length - 300 - 180;

async function refusesCut(length: number): Promise<void> {
  const bytes = CUT.subarray(0, length);
  const file = put(bytes, `cut-${length}.flac`);
  const report = await read(file);
  assert.equal(report.writable, false, `a file cut at ${length} is offered for editing`);
  // Without the signature it is no FLAC file at all; with it, the form gives way to the reason.
  assert.deepEqual([report.unavailable, report.note], length < 4 ? [true, undefined] : [undefined, "This file ends inside its metadata (it is incomplete or damaged), so its tags can't be edited."], `cut at ${length}`);
  await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), length < 4 ? /left untouched/ : /ends inside its metadata/, `a save of a file cut at ${length} went through`);
  assert.deepEqual(fs.readFileSync(file), bytes, `cut at ${length}`);
}

test('a file cut in front of its last metadata block is not rewritten', async () => {
  for (const length of [3, 4, 20, 42, 60, SEEKTABLE_AT - 4, SEEKTABLE_AT - 1]) {
    await refusesCut(length);
  }
});

// Taken for a whole block, the shortened one was written out with its new length, and the file looked complete without any audio.
test('a file cut inside its last metadata block is not rewritten', async () => {
  for (const length of [SEEKTABLE_AT, SEEKTABLE_AT + 1, SEEKTABLE_AT + 100, SEEKTABLE_AT + 179]) {
    await refusesCut(length);
  }
});

test('a file cut behind its metadata is rewritten with the audio that is left', async () => {
  for (const left of [0, 1, 150]) {
    const bytes = CUT.subarray(0, CUT.length - 300 + left);
    const file = put(bytes, `audio-${left}.flac`);
    await edit(file, { title: 'X' });
    const [before, after] = [flacBlocks(bytes), flacBlocks(fs.readFileSync(file))];
    assert.deepEqual(after.audio, before.audio, `${left} bytes of audio`);
    assert.equal(after.audio.length, left);
    assert.deepEqual(after.blocks.find((b) => b.type === FLAC.SEEKTABLE)!.data, before.blocks[2].data);
    assert.deepEqual(entriesOf(file).entries, ['TITLE=X']);
  }
});

test('blocks without end get an answer soon: a file of zeros behind the signature is not read as a million empty blocks', async () => {
  const bytes = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(4 << 20)]);
  const file = put(bytes, 'zeros.flac');
  const started = performance.now();
  const report = await read(file);
  assert.deepEqual([report.writable, report.unavailable], [false, undefined]);
  assert.match(report.note ?? '', /incomplete or damaged/);
  await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /incomplete or damaged/);
  const took = performance.now() - started;
  assert.ok(took < 2000, `took ${Math.round(took)} ms`);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
