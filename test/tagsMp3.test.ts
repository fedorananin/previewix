import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import type { CoverChange, Fields } from '../src/tags/common';
import { readTagReport, saveTags } from '../src/tags/index';
import { fields, id3Described, id3Frame, id3Frames, id3Picture, id3Tag, id3Text, id3TextFrame, id3UserText, id3v1, jpeg, mpegAudio, png, type Id3Frame } from './audio';
import { random, scratch } from './helpers';

// MP3: the ID3v2 tag in front of the audio (src/tags/id3.ts). The files are a hand-built tag followed by
// noise, and what a save wrote is read back with the frame reader in audio.ts, not with id3.ts.

const dir = scratch();
const rand = random(0x1d3);
const KEEP: CoverChange = { action: 'keep' };

let count = 0;
function put(bytes: Buffer, name = 'song.mp3'): string {
  const file = path.join(dir, `${++count}-${name}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** What the form does: it shows the stored values and sends all of them back, with the edited ones changed. */
async function edit(file: string, values: Partial<Fields>, cover: CoverChange = KEEP): Promise<void> {
  const report = await readTagReport(file, undefined);
  assert.equal(report.writable, true, 'the file should be offered for editing');
  await saveTags(file, { ...report.fields, ...values }, cover, undefined);
}

const read = async (file: string) => readTagReport(file, undefined);

/** Text of a text frame, decoded here. */
function textOf(frame: Id3Frame): string {
  const body = frame.data.subarray(1);
  switch (frame.data[0]) {
    case 0:
      return body.toString('latin1');
    case 1:
      assert.deepEqual([...body.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 text needs a byte order mark');
      return body.subarray(2).toString('utf16le');
    case 3:
      return body.toString('utf8');
    default:
      throw new Error(`encoding ${frame.data[0]}`);
  }
}

const frame = (frames: Id3Frame[], id: string) => frames.find((f) => f.id === id);
const ids = (frames: Id3Frame[]) => frames.map((f) => f.id);

// ---- Reading --------------------------------------------------------------------

test('reads every field of an ID3v2.3 tag', async () => {
  const cover = jpeg(3, 2, rand.bytes(200));
  const file = put(
    Buffer.concat([
      id3Tag(3, [
        id3TextFrame(3, 'TIT2', 'Title'),
        id3TextFrame(3, 'TPE1', 'Исполнитель', 1),
        id3TextFrame(3, 'TALB', 'Album'),
        id3TextFrame(3, 'TPE2', 'Various'),
        id3TextFrame(3, 'TYER', '2019'),
        id3TextFrame(3, 'TRCK', '3/12'),
        id3TextFrame(3, 'TPOS', '1/2'),
        id3TextFrame(3, 'TCON', '(17)'),
        id3TextFrame(3, 'TCOM', 'Composer'),
        id3Described(3, 'COMM', 'eng', '', 'A comment'),
        id3Described(3, 'USLT', 'eng', '', 'Line one\nLine two', 1),
        id3Picture(3, 3, cover),
      ], 100),
      mpegAudio(rand, 500),
    ]),
  );
  const report = await read(file);
  assert.deepEqual(report.fields, fields({
    title: 'Title', artist: 'Исполнитель', album: 'Album', album_artist: 'Various', date: '2019', track: '3/12', disc: '1/2',
    genre: 'Rock', composer: 'Composer', comment: 'A comment', lyrics: 'Line one\nLine two',
  }));
  assert.deepEqual(Buffer.from(report.cover!), cover);
  assert.equal(report.writable, true);
  assert.equal(report.coverWritable, true);
});

test('reads an ID3v2.4 tag: UTF-8, UTF-16BE, syncsafe frame sizes, several values in a frame', async () => {
  const lyrics = 'la '.repeat(200).trim(); // more than 127 bytes: a size that reads differently when it isn't taken as syncsafe
  const file = put(
    Buffer.concat([
      id3Tag(4, [
        id3Described(4, 'USLT', 'deu', '', lyrics, 3),
        id3TextFrame(4, 'TIT2', 'Größe 標題', 3),
        id3TextFrame(4, 'TPE1', 'First\0Second', 3),
        id3TextFrame(4, 'TALB', 'Альбом', 2),
        id3TextFrame(4, 'TDRC', '2019-05-17', 3),
      ]),
      mpegAudio(rand, 300),
    ]),
  );
  const report = await read(file);
  assert.equal(report.fields.lyrics, lyrics);
  assert.equal(report.fields.title, 'Größe 標題');
  assert.equal(report.fields.artist, 'First; Second');
  assert.equal(report.fields.album, 'Альбом');
  assert.equal(report.fields.date, '2019-05-17');
});

test('the comment is the one without a description, not the technical ones iTunes stores as comments', async () => {
  const file = put(
    Buffer.concat([
      id3Tag(3, [id3Described(3, 'COMM', 'eng', 'iTunNORM', ' 00000A2B 00000B1C'), id3Described(3, 'COMM', 'eng', '', 'Mine')]),
      mpegAudio(rand, 200),
    ]),
  );
  assert.equal((await read(file)).fields.comment, 'Mine');
  const technical = put(Buffer.concat([id3Tag(3, [id3Described(3, 'COMM', 'eng', 'iTunNORM', ' 00000A2B')]), mpegAudio(rand, 200)]));
  assert.equal((await read(technical)).fields.comment, '');
});

test('the cover is the front cover, wherever it stands; without one, the first picture', async () => {
  const [back, front] = [jpeg(1, 1, rand.bytes(50)), png(2, 2)];
  const both = put(Buffer.concat([id3Tag(3, [id3Picture(3, 4, back), id3Picture(3, 3, front, 'image/png')]), mpegAudio(rand, 200)]));
  assert.deepEqual(Buffer.from((await read(both)).cover!), front);
  const one = put(Buffer.concat([id3Tag(3, [id3Picture(3, 4, back)]), mpegAudio(rand, 200)]));
  assert.deepEqual(Buffer.from((await read(one)).cover!), back);
});

test('tags outside the form are listed: user text frames and the other text frames', async () => {
  const file = put(
    Buffer.concat([id3Tag(3, [id3UserText(3, 'replaygain_track_gain', '-6.5 dB'), id3TextFrame(3, 'TBPM', '128'), id3TextFrame(3, 'TIT2', 'T')]), mpegAudio(rand, 200)]),
  );
  assert.deepEqual((await read(file)).other, [['replaygain_track_gain', '-6.5 dB'], ['BPM', '128']]);
});

test('a v2.3 tag with unsynchronisation and an extended header is read, and written back plain', async () => {
  // The cover holds FF E0 and FF 00, the byte pairs unsynchronisation exists for.
  const cover = jpeg(2, 2, Buffer.from([0xff, 0x00, 0x12, 0xff, 0xe3, 0xff]));
  const extended = Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.alloc(6)]);
  const plain = Buffer.concat([extended, id3TextFrame(3, 'TIT2', 'Unsync'), id3Picture(3, 3, cover)]);
  const bytes: number[] = [];
  plain.forEach((byte, i) => {
    bytes.push(byte);
    if (byte === 0xff && (i + 1 === plain.length || plain[i + 1] >= 0xe0 || plain[i + 1] === 0)) {
      bytes.push(0);
    }
  });
  assert.ok(bytes.length > plain.length);
  const audio = mpegAudio(rand, 400);
  const file = put(Buffer.concat([id3Tag(3, [Buffer.from(bytes)], 0, 0x80 | 0x40), audio]));

  const report = await read(file);
  assert.equal(report.fields.title, 'Unsync');
  assert.deepEqual(Buffer.from(report.cover!), cover);

  await edit(file, { artist: 'Someone' });
  const written = fs.readFileSync(file);
  const tag = id3Frames(written);
  assert.equal(tag.flags, 0);
  assert.deepEqual(ids(tag.frames), ['TIT2', 'APIC', 'TPE1']);
  assert.deepEqual(written.subarray(tag.length), audio);
  assert.deepEqual(Buffer.from((await read(file)).cover!), cover);
});

// ---- Writing: the audio ---------------------------------------------------------

test('a file without a tag gets one, and the audio follows it unchanged', async () => {
  const audio = mpegAudio(rand, 3000);
  const file = put(audio);
  assert.deepEqual((await read(file)).fields, fields());

  await edit(file, { title: 'New', track: '2' });
  const written = fs.readFileSync(file);
  const tag = id3Frames(written);
  assert.equal(tag.version, 3);
  assert.deepEqual(ids(tag.frames), ['TIT2', 'TRCK']);
  assert.deepEqual(written.subarray(tag.length), audio);
  assert.ok(tag.padding.length >= 512 && tag.padding.every((byte) => byte === 0), 'padding of zeros behind the frames');
});

test('a save keeps the audio byte for byte and drops the ID3v1 trailer', async () => {
  const audio = mpegAudio(rand, 5000);
  const file = put(Buffer.concat([id3Tag(4, [id3TextFrame(4, 'TIT2', 'Old', 3)], 300), audio, id3v1('Old')]));
  await edit(file, { title: 'New' });
  const written = fs.readFileSync(file);
  // The trailer would keep showing the old title in players that read it.
  assert.deepEqual(written.subarray(id3Frames(written).length), audio);
});

test('the footer of a v2.4 tag is part of the tag, not of the audio', async () => {
  const audio = mpegAudio(rand, 800);
  const tag = id3Tag(4, [id3TextFrame(4, 'TIT2', 'Footer', 3)], 0, 0x10);
  const footer = Buffer.concat([Buffer.from('3DI'), tag.subarray(3, 10)]);
  const file = put(Buffer.concat([tag, footer, audio]));
  await edit(file, { title: 'Changed' });
  const written = fs.readFileSync(file);
  assert.deepEqual(written.subarray(id3Frames(written).length), audio);
});

// ---- Writing: the frames ----------------------------------------------------------

test('changing one field rebuilds its frame and leaves every other frame as it was', async () => {
  const frames = [
    id3TextFrame(3, 'TPE1', 'Artist'),
    id3Frame(3, 'PRIV', Buffer.concat([Buffer.from('com.example\0'), rand.bytes(40)])),
    id3TextFrame(3, 'TIT2', 'Old title'),
    id3Frame(3, 'POPM', Buffer.concat([Buffer.from('someone@example.com\0'), Buffer.from([196, 0, 0, 0, 7])])),
    id3UserText(3, 'MusicBrainz Album Id', 'f4a7e1c2-0000-4000-8000-123456789abc'),
    id3Frame(3, 'GEOB', rand.bytes(120)),
    // A compressed frame can't be read here; it has to be carried along all the same.
    id3Frame(3, 'TENC', rand.bytes(30), 0x0080),
    id3Described(3, 'COMM', 'eng', 'iTunSMPB', ' 00000000 00000840 000001C0'),
    id3Picture(3, 4, jpeg(1, 1, rand.bytes(64))),
    id3TextFrame(3, 'TSOP', 'Сортировка', 1),
  ];
  const audio = mpegAudio(rand, 1500);
  const file = put(Buffer.concat([id3Tag(3, frames, 64), audio]));

  await edit(file, { title: 'New title' });
  const written = fs.readFileSync(file);
  const tag = id3Frames(written);
  assert.equal(tag.frames.length, frames.length);
  tag.frames.forEach((written, i) => {
    if (i === 2) {
      assert.equal(written.id, 'TIT2');
      assert.equal(textOf(written), 'New title');
    } else {
      assert.deepEqual(written.raw, frames[i], `frame ${i} (${written.id}) changed`);
    }
  });
  assert.deepEqual(written.subarray(tag.length), audio);
});

test('a save that changes nothing keeps every frame as it was', async () => {
  const frames = [id3TextFrame(4, 'TIT2', 'T', 3), id3TextFrame(4, 'TPE1', 'A\0B', 3), id3TextFrame(4, 'TDRC', '2001-02-03', 3), id3Described(4, 'COMM', 'fra', 'note', 'c', 3), id3TextFrame(4, 'TCON', '17', 3)];
  const file = put(Buffer.concat([id3Tag(4, frames), mpegAudio(rand, 300)]));
  await edit(file, {});
  assert.deepEqual(id3Frames(fs.readFileSync(file)).frames.map((f) => f.raw), frames);
});

test('a v2.3 tag stays v2.3: text outside ASCII as UTF-16 with a byte order mark, the date as a year in TYER', async () => {
  const file = put(Buffer.concat([id3Tag(3, [id3TextFrame(3, 'TIT2', 'Old')]), mpegAudio(rand, 300)]));
  await edit(file, { title: 'Заголовок 標題', artist: 'Plain', date: '2024-11-30' });
  const tag = id3Frames(fs.readFileSync(file));
  assert.equal(tag.version, 3);
  assert.equal(frame(tag.frames, 'TIT2')!.data[0], 1);
  assert.equal(textOf(frame(tag.frames, 'TIT2')!), 'Заголовок 標題');
  assert.equal(frame(tag.frames, 'TPE1')!.data[0], 0);
  assert.equal(textOf(frame(tag.frames, 'TYER')!), '2024');
  assert.equal(frame(tag.frames, 'TDRC'), undefined);
});

test('a v2.4 tag stays v2.4: UTF-8, syncsafe sizes, the whole date in TDRC', async () => {
  const file = put(Buffer.concat([id3Tag(4, [id3TextFrame(4, 'TIT2', 'Old', 3)]), mpegAudio(rand, 300)]));
  const lyrics = 'ля '.repeat(150).trim();
  await edit(file, { title: 'Заголовок', date: '2024-11-30', lyrics });
  const tag = id3Frames(fs.readFileSync(file));
  assert.equal(tag.version, 4);
  assert.equal(frame(tag.frames, 'TIT2')!.data[0], 3);
  assert.equal(textOf(frame(tag.frames, 'TIT2')!), 'Заголовок');
  assert.equal(textOf(frame(tag.frames, 'TDRC')!), '2024-11-30');
  // id3Frames() read the sizes as syncsafe; had they been written plain, the frames behind the lyrics would be lost.
  assert.deepEqual(ids(tag.frames), ['TIT2', 'TDRC', 'USLT']);
  assert.deepEqual(frame(tag.frames, 'USLT')!.data, Buffer.concat([Buffer.from([3]), Buffer.from('eng\0' + lyrics, 'utf8')]));
});

test('clearing a field removes its frame, and only that one', async () => {
  const file = put(
    Buffer.concat([
      id3Tag(3, [id3TextFrame(3, 'TIT2', 'T'), id3TextFrame(3, 'TALB', 'Album'), id3Described(3, 'COMM', 'eng', '', 'c'), id3TextFrame(3, 'TYER', '1999'), id3Described(3, 'USLT', 'eng', '', 'l')]),
      mpegAudio(rand, 300),
    ]),
  );
  await edit(file, { album: '', comment: '', date: '', lyrics: '' });
  assert.deepEqual(ids(id3Frames(fs.readFileSync(file)).frames), ['TIT2']);
  assert.deepEqual((await read(file)).fields, fields({ title: 'T' }));
});

test('a new comment takes the place, the language and the description of the one it replaces', async () => {
  const technical = id3Described(3, 'COMM', 'eng', 'iTunNORM', ' 00000A2B');
  const file = put(
    Buffer.concat([id3Tag(3, [technical, id3Described(3, 'COMM', 'deu', '', 'alt'), id3Described(3, 'USLT', 'fra', 'paroles', 'vieux')]), mpegAudio(rand, 300)]),
  );
  await edit(file, { comment: 'neu', lyrics: 'nouveau' });
  const { frames } = id3Frames(fs.readFileSync(file));
  assert.deepEqual(ids(frames), ['COMM', 'COMM', 'USLT']);
  assert.deepEqual(frames[0].raw, technical);
  assert.deepEqual(frames[1].data, Buffer.concat([Buffer.from([0]), Buffer.from('deu\0neu', 'latin1')]));
  assert.deepEqual(frames[2].data, Buffer.concat([Buffer.from([0]), Buffer.from('fraparoles\0nouveau', 'latin1')]));
});

test('a comment outside ASCII in a v2.3 tag: description and text both in UTF-16, each with its byte order mark', async () => {
  const file = put(Buffer.concat([id3Tag(3, []), mpegAudio(rand, 300)]));
  await edit(file, { comment: 'Комментарий' });
  const comment = frame(id3Frames(fs.readFileSync(file)).frames, 'COMM')!;
  assert.deepEqual(comment.data, Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), id3Text(1, ''), Buffer.alloc(2), id3Text(1, 'Комментарий')]));
  assert.equal((await read(file)).fields.comment, 'Комментарий');
});

// ---- Writing: the cover -----------------------------------------------------------

test('replacing the cover swaps the front cover and keeps the other pictures; removing it removes them all', async () => {
  const [back, front, artist] = [jpeg(1, 1, rand.bytes(30)), jpeg(2, 2, rand.bytes(30)), jpeg(3, 3, rand.bytes(30))];
  const frames = [id3Picture(3, 4, back), id3TextFrame(3, 'TIT2', 'T'), id3Picture(3, 3, front), id3Picture(3, 8, artist)];
  const audio = mpegAudio(rand, 700);
  const file = put(Buffer.concat([id3Tag(3, frames), audio]));
  const image = png(4, 4);
  const picture = path.join(dir, 'new-cover.png');
  fs.writeFileSync(picture, image);

  await edit(file, {}, { action: 'replace', path: picture });
  let written = fs.readFileSync(file);
  let tag = id3Frames(written);
  assert.deepEqual(ids(tag.frames), ['APIC', 'TIT2', 'APIC', 'APIC']);
  assert.deepEqual(tag.frames[0].raw, frames[0]);
  assert.deepEqual(tag.frames[3].raw, frames[3]);
  // Encoding, MIME type, picture type 3 (front cover), an empty description, the image.
  assert.deepEqual(tag.frames[2].data, Buffer.concat([Buffer.from('\0image/png\0\x03\0', 'latin1'), image]));
  assert.deepEqual(Buffer.from((await read(file)).cover!), image);
  assert.deepEqual(written.subarray(tag.length), audio);

  await edit(file, {}, { action: 'remove' });
  written = fs.readFileSync(file);
  tag = id3Frames(written);
  assert.deepEqual(ids(tag.frames), ['TIT2']);
  assert.equal((await read(file)).cover, undefined);
  assert.deepEqual(written.subarray(tag.length), audio);
});

test('a first cover is added as a front cover, as JPEG when it is one', async () => {
  const file = put(Buffer.concat([id3Tag(4, [id3TextFrame(4, 'TIT2', 'T', 3)]), mpegAudio(rand, 300)]));
  const image = jpeg(5, 5, rand.bytes(100));
  const picture = path.join(dir, 'first-cover.jpg');
  fs.writeFileSync(picture, image);
  await edit(file, {}, { action: 'replace', path: picture });
  const apic = frame(id3Frames(fs.readFileSync(file)).frames, 'APIC')!;
  assert.deepEqual(apic.data, Buffer.concat([Buffer.from('\0image/jpeg\0\x03\0', 'latin1'), image]));
});

// ---- What is not rewritten --------------------------------------------------------

test('an ID3v2.2 tag is not rewritten: without ffmpeg there is nothing to show, and a save fails with the file as it was', async () => {
  // v2.2 frames have three-letter names and three-byte sizes.
  const v22 = Buffer.concat([Buffer.from('TT2'), Buffer.from([0, 0, 6]), Buffer.from('\0Title', 'latin1')]);
  const bytes = Buffer.concat([id3Tag(2, [v22]), mpegAudio(rand, 400)]);
  const file = put(bytes);
  const report = await read(file);
  assert.equal(report.writable, false);
  assert.equal(report.unavailable, true);
  await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /ID3v2\.2/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a file that ends inside its tag is not rewritten; one that ends behind it keeps the audio that is left', async () => {
  // Saved as it came, the file was a tag of the frames that were whole and no audio.
  const tag = id3Tag(3, [id3TextFrame(3, 'TIT2', 'T'), id3Picture(3, 3, jpeg(1, 1, rand.bytes(200))), id3TextFrame(3, 'TALB', 'A')], 64);
  const whole = Buffer.concat([tag, mpegAudio(rand, 400)]);
  for (const length of [5, 10, 11, 30, 150, tag.length - 65, tag.length - 1]) {
    const bytes = whole.subarray(0, length);
    const file = put(bytes, `cut-${length}.mp3`);
    const report = await read(file);
    assert.deepEqual([report.writable, report.unavailable, report.note], [false, undefined, "This file ends inside its ID3 tag (it is incomplete or damaged), so its tags can't be edited."], `cut at ${length}`);
    await assert.rejects(saveTags(file, fields({ title: 'X' }), KEEP, undefined), /ends inside its ID3 tag/, `cut at ${length}`);
    assert.deepEqual(fs.readFileSync(file), bytes, `cut at ${length}`);
  }
  // The footer of a v2.4 tag belongs to it.
  const footed = Buffer.concat([id3Tag(4, [id3TextFrame(4, 'TIT2', 'T')], 0, 0x10), Buffer.alloc(10, 1), mpegAudio(rand, 400)]);
  const short = put(footed.subarray(0, footed.length - 400 - 3), 'cut-footer.mp3');
  await assert.rejects(saveTags(short, fields({ title: 'X' }), KEEP, undefined), /incomplete or damaged/);

  for (const left of [0, 1, 150]) {
    const file = put(whole.subarray(0, tag.length + left), `audio-${left}.mp3`);
    await edit(file, { title: 'X' });
    const written = fs.readFileSync(file);
    const parsed = id3Frames(written);
    assert.deepEqual(written.subarray(parsed.length), whole.subarray(tag.length, tag.length + left), `${left} bytes of audio`);
    assert.deepEqual(ids(parsed.frames), ['TIT2', 'APIC', 'TALB']);
  }
});

test('a cover file that is missing fails the save and leaves the file as it was', async () => {
  const bytes = Buffer.concat([id3Tag(3, [id3TextFrame(3, 'TIT2', 'T')]), mpegAudio(rand, 400)]);
  const file = put(bytes);
  await assert.rejects(saveTags(file, fields({ title: 'Other' }), { action: 'replace', path: path.join(dir, 'no-such.png') }, undefined));
  assert.deepEqual(fs.readFileSync(file), bytes);
});
