import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import type { CoverChange, Fields } from '../src/tags/common';
import { readTagReport, saveTags } from '../src/tags/index';
import { Mp4Refusal, readMp4, writeMp4 } from '../src/tags/mp4';
import {
  MDIR, box, boxes, coverItem, dataBox, fields, freeformItem, jpeg, mp4Audio, mp4Chunks, mp4File, mp4Tags, numberItem, pairItem, png, textItem, track, u16, u32, udta, within,
  type Mp4, type TagAtoms, type Track,
} from './audio';
import { random, scratch } from './helpers';

// MP4 (M4A, M4B): the iTunes item list in moov/udta/meta/ilst (src/tags/mp4.ts). A save here can move the
// audio, so every test that writes compares the file before and after with the readers in audio.ts, which
// share no code with the writer: every chunk of every track read through the chunk offsets and sample tables,
// the payload of mdat, and the bytes of every item that was not edited.

const dir = scratch();
const rand = random(0x4d34);
const KEEP: CoverChange = { action: 'keep' };
const C = '\xa9';

let count = 0;
function put(bytes: Buffer, name = 'song.m4a'): string {
  const file = path.join(dir, `${++count}-${name}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** What the form does: it shows the stored values and sends all of them back, with the edited ones changed. */
async function edit(file: string, values: Partial<Fields>, cover: CoverChange = KEEP): Promise<void> {
  const report = await readTagReport(file, undefined);
  assert.equal(report.writable, true, `the file should be offered for editing (${report.note})`);
  await saveTags(file, { ...report.fields, ...values }, cover, undefined);
}

const read = (file: string) => readTagReport(file, undefined);

const NORM = ' 00000A2B 00000B1C 00004E20 00005DC0 00000000 00000000 00007FFF 00007FFF 00000000 00000000';
const BLOB = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

/** The items the form does not edit. They have to survive every save byte for byte. */
const others = (): Buffer[] => [
  freeformItem('com.apple.iTunes', 'iTunNORM', Buffer.from(NORM)),
  freeformItem('org.example', 'Binary Blob', BLOB, 0),
  textItem('soar', 'Sort Artist'),
  numberItem('cpil', 1),
  numberItem('tmpo', 128, 2),
  textItem('cprt', '℗ 2019 Example'),
  box('----', box('mean', u32(0), Buffer.from('com.apple.iTunes')), box('name', u32(0), Buffer.from('MULTI')), dataBox(1, Buffer.from('one')), dataBox(1, Buffer.from('two'))),
];

const COVER = jpeg(3, 3, rand.bytes(300));

/** A list with every field of the form, the other items in between, and a cover. */
const fullItems = (): Buffer[] => {
  const [norm, blob, ...rest] = others();
  return [
    textItem(`${C}nam`, 'Заголовок 標題 🎵'), norm, textItem(`${C}ART`, 'Исполнитель'), textItem(`${C}alb`, 'Альбом'), textItem('aART', 'Various Artists'), blob,
    textItem(`${C}day`, '2019-05-17'), pairItem('trkn', 7, 12), pairItem('disk', 1, 2), textItem(`${C}gen`, 'Синти-поп'), textItem(`${C}wrt`, 'Композитор'),
    textItem(`${C}cmt`, 'Комментарий\nв две строки'), textItem(`${C}lyr`, 'Первая строка\nВторая строка\n歌詞'), ...rest, coverItem(COVER),
  ];
};

const FULL = fields({
  title: 'Заголовок 標題 🎵', artist: 'Исполнитель', album: 'Альбом', album_artist: 'Various Artists', date: '2019-05-17', track: '7/12', disc: '1/2',
  genre: 'Синти-поп', composer: 'Композитор', comment: 'Комментарий\nв две строки', lyrics: 'Первая строка\nВторая строка\n歌詞',
});

/** A file with one track of twelve chunks and the given tag atoms. */
const file = (front: boolean, tags: TagAtoms | undefined, more: Partial<Mp4> = {}): Buffer =>
  mp4File({ front, tracks: [track(rand, 12)], udta: tags && udta(tags), ...more });

const MANAGED = new Set([`${C}nam`, `${C}ART`, `${C}alb`, 'aART', `${C}day`, `${C}wrt`, `${C}cmt`, `${C}lyr`, 'trkn', 'disk', `${C}gen`, 'gnre', 'covr']);

/**
 * What no save may change: the audio of every chunk, the payload of mdat, the items the form does not edit,
 * and the first atom. Returns how far the audio moved. `after` is read whole by boxes(), so a size that
 * doesn't add up anywhere on the way to the chunks and the items fails here too.
 */
function assertIntact(before: Buffer, after: Buffer): number {
  const [was, now] = [mp4Chunks(before), mp4Chunks(after)];
  assert.equal(now.length, was.length, 'the number of chunks');
  const [wasAudio, nowAudio] = [mp4Audio(before), mp4Audio(after)];
  assert.equal(nowAudio.length, wasAudio.length);
  nowAudio.forEach((audio, i) => assert.ok(audio.data.equals(wasAudio[i].data), 'the payload of mdat changed'));
  // There is one mdat, and every chunk lies in it: a chunk has moved exactly as far as mdat has.
  const shift = nowAudio[0].start - wasAudio[0].start;
  now.forEach((chunk, i) => {
    assert.equal(chunk.track, was[i].track);
    assert.ok(chunk.data.equals(was[i].data), `chunk ${i} no longer holds its audio`);
    assert.equal(chunk.offset, was[i].offset + shift, `the offset of chunk ${i}`);
  });
  const kept = (bytes: Buffer) => mp4Tags(bytes).items.filter((item) => !MANAGED.has(item.type)).map((item) => item.raw);
  assert.deepEqual(kept(after), kept(before), 'an item the form does not edit changed');
  const ftyp = boxes(before)[0];
  assert.ok(after.subarray(0, ftyp.end).equals(before.subarray(0, ftyp.end)));
  return shift;
}

const itemTypes = (bytes: Buffer) => mp4Tags(bytes).items.map((item) => item.type);
const item = (bytes: Buffer, type: string) => mp4Tags(bytes).items.find((entry) => entry.type === type)?.raw;

// ---- Reading --------------------------------------------------------------------

test('reads every field, the cover and the other items', async () => {
  const report = await read(put(file(true, { items: fullItems(), pad: 512 })));
  assert.deepEqual(report.fields, FULL);
  assert.deepEqual(Buffer.from(report.cover!), COVER);
  assert.equal(report.writable, true);
  assert.equal(report.coverWritable, true);
  const other = new Map(report.other);
  assert.deepEqual([...other.keys()], ['iTunNORM', 'org.example:Binary Blob', 'Artist sort', 'Compilation', 'BPM', 'Copyright', 'MULTI']);
  assert.equal(other.get('iTunNORM'), NORM);
  assert.equal(other.get('Artist sort'), 'Sort Artist');
  assert.equal(other.get('Compilation'), 'Yes');
  assert.equal(other.get('BPM'), '128');
  assert.equal(other.get('Copyright'), '℗ 2019 Example');
  assert.equal(other.get('MULTI'), 'one; two');
});

test('a numeric genre is a number into the ID3v1 list plus one; one outside the list is shown among the other tags', async () => {
  const gnre = (n: number) => box('gnre', dataBox(0, u16(n)));
  assert.equal((await read(put(file(true, { items: [gnre(18)] })))).fields.genre, 'Rock');
  assert.equal((await read(put(file(true, { items: [gnre(1)] })))).fields.genre, 'Blues');
  const unknown = await read(put(file(true, { items: [gnre(900)] })));
  assert.equal(unknown.fields.genre, '');
  assert.deepEqual(unknown.other, [['Genre number', '900']]);
});

test('text in UTF-16, text without a type, several values, and track numbers without a total are read', async () => {
  const report = await read(
    put(
      file(true, {
        items: [
          box(`${C}nam`, dataBox(2, Buffer.from('Заголовок', 'utf16le').swap16())),
          box(`${C}alb`, dataBox(0, Buffer.from('caf\xe9', 'latin1'))),
          textItem(`${C}ART`, 'First Artist', 'Second Artist'),
          pairItem('trkn', 5, 0),
        ],
      }),
    ),
  );
  assert.equal(report.fields.title, 'Заголовок');
  assert.equal(report.fields.album, 'café');
  assert.equal(report.fields.artist, 'First Artist; Second Artist');
  assert.equal(report.fields.track, '5');
});

test('a second cover is listed among the other tags, and the first one is the cover', async () => {
  const second = png(2, 2);
  const report = await read(put(file(true, { items: [coverItem(COVER, second)] })));
  assert.deepEqual(Buffer.from(report.cover!), COVER);
  assert.deepEqual(report.other.map(([key]) => key), ['Additional picture']);
});

// ---- Saving without moving anything -----------------------------------------------

test('a save that changes nothing writes nothing', async () => {
  const bytes = file(true, { items: [...fullItems(), textItem(`${C}grp`, 'g')], pad: 300 });
  const target = put(bytes);
  const before = fs.statSync(target);
  // The form trims its values and gives line ends as \n; "07/12" is the track the file has.
  await saveTags(target, { ...FULL, title: `  ${FULL.title}\r\n`, track: '07/12', comment: 'Комментарий\r\nв две строки' }, KEEP, undefined);
  const after = fs.statSync(target);
  // A rename would have given the name to another file.
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.ok(fs.readFileSync(target).equals(bytes));
});

test('a stored value that only differs from the form by outer spaces and line ends is not rewritten when another field changes', async () => {
  const stored = [textItem(`${C}cmt`, '  padded  '), textItem(`${C}lyr`, 'one\r\ntwo\r\n'), textItem(`${C}nam`, 'Old')];
  const target = put(file(true, { items: stored, pad: 200 }));
  await saveTags(target, fields({ comment: 'padded', lyrics: 'one\ntwo', title: 'New' }), KEEP, undefined);
  const after = fs.readFileSync(target);
  assert.deepEqual(item(after, `${C}cmt`), stored[0]);
  assert.deepEqual(item(after, `${C}lyr`), stored[1]);
  assert.deepEqual(item(after, `${C}nam`), textItem(`${C}nam`, 'New'));
});

test('an edit that fits into the padding behind the list moves nothing: the file keeps its size', async () => {
  const before = file(true, { items: fullItems(), pad: 1024 });
  const target = put(before);
  await edit(target, { title: 'A longer title than before, by a good many bytes', album: '' });
  const after = fs.readFileSync(target);
  assert.equal(after.length, before.length);
  assert.equal(assertIntact(before, after), 0);
  assert.deepEqual((await read(target)).fields, { ...FULL, title: 'A longer title than before, by a good many bytes', album: '' });
  // The difference went into the free atom behind the list, which is still there.
  const growth = mp4Tags(after).ilst!.end - mp4Tags(after).ilst!.start - (mp4Tags(before).ilst!.end - mp4Tags(before).ilst!.start);
  const pad = mp4Tags(after).parts.at(-1)!;
  assert.equal(pad.type, 'free');
  assert.equal(pad.end - pad.start, 1024 - growth);
});

test('a free atom right behind moov (the iTunes layout) takes the difference, and the audio stays where it is', async () => {
  const before = file(true, { items: fullItems() }, { behindMoov: [box('free', Buffer.alloc(4096 - 8))] });
  const target = put(before);
  await edit(target, { lyrics: 'x'.repeat(1500) });
  const after = fs.readFileSync(target);
  assert.equal(after.length, before.length);
  assert.equal(mp4Audio(after)[0].start, mp4Audio(before)[0].start);
  assertIntact(before, after);
  const [moovWas, moovNow] = [before, after].map((bytes) => boxes(bytes).find((entry) => entry.type === 'moov')!);
  const free = boxes(after).find((entry) => entry.type === 'free')!;
  assert.equal(free.start, moovNow.end);
  assert.equal(free.end - free.start, 4096 - (moovNow.end - moovWas.end));
  assert.equal((await read(target)).fields.lyrics, 'x'.repeat(1500));
});

// ---- Saving when the audio has to move ---------------------------------------------

test('without padding and with moov in front, the audio moves and every chunk offset follows', async () => {
  const before = file(true, { items: fullItems() });
  const target = put(before);
  await edit(target, { title: 'A title that is longer than the one before it' });
  const after = fs.readFileSync(target);
  const shift = assertIntact(before, after);
  assert.ok(shift > 0);
  assert.equal(after.length, before.length + shift);
  assert.equal((await read(target)).fields.title, 'A title that is longer than the one before it');

  // The move left padding behind, so the next edits move nothing.
  await edit(target, { title: 'A title that is longer than the one before it, and longer again', lyrics: `${FULL.lyrics}\nand one more line` });
  const third = fs.readFileSync(target);
  assert.equal(third.length, after.length);
  assert.equal(assertIntact(after, third), 0);
});

test('padding that would shrink to less than an atom header can hold is not used: the audio moves instead', async () => {
  // 100 bytes of padding. A title 100 bytes longer uses it up exactly; one 96 bytes longer would leave 4, which no atom can be.
  for (const [growth, moves] of [[100, false], [96, true], [93, true], [92, false]] as const) {
    const before = file(true, { items: [textItem(`${C}nam`, 'T'), ...others()], pad: 100 });
    const target = put(before);
    await edit(target, { title: `T${'x'.repeat(growth)}` });
    const after = fs.readFileSync(target);
    const shift = assertIntact(before, after);
    assert.equal(shift !== 0, moves, `a title ${growth} bytes longer`);
    assert.equal((await read(target)).fields.title, `T${'x'.repeat(growth)}`);
  }
});

test('every track is corrected: 32-bit and 64-bit offset tables, compact sample sizes', async () => {
  const tracks: Track[] = [track(rand, 9), track(rand, 14, { wide: true }), track(rand, 5, { compact: 8 }), track(rand, 4, { compact: 16 })];
  for (const front of [true, false]) {
    const before = mp4File({ front, tracks, udta: udta({ items: fullItems() }) });
    const target = put(before);
    await edit(target, { lyrics: 'la '.repeat(300) });
    const after = fs.readFileSync(target);
    const shift = assertIntact(before, after);
    assert.equal(new Set(mp4Chunks(after).map((chunk) => chunk.track)).size, 4);
    assert.equal(shift > 0, front);
  }
});

test('with moov behind the audio nothing in front of it moves, whatever the size of the tags', async () => {
  const before = file(false, { items: fullItems() });
  const target = put(before);
  await edit(target, { lyrics: 'x'.repeat(5000) });
  const after = fs.readFileSync(target);
  assertIntact(before, after);
  const moov = boxes(before).find((entry) => entry.type === 'moov')!;
  assert.ok(after.subarray(0, moov.start).equals(before.subarray(0, moov.start)));
  assert.deepEqual(mp4Chunks(after).map((chunk) => chunk.offset), mp4Chunks(before).map((chunk) => chunk.offset));
});

test('an mdat that runs to the end of the file, and one with a 64-bit size, are moved like any other', async () => {
  for (const mdat of ['open', 'wide'] as const) {
    for (const front of [true, false]) {
      // Only the last atom of a file can run to its end.
      if (mdat === 'open' && !front) {
        continue;
      }
      const before = file(front, { items: fullItems() }, { mdat });
      const target = put(before);
      await edit(target, { comment: 'c'.repeat(700) });
      const after = fs.readFileSync(target);
      assertIntact(before, after);
      const [was, now] = [before, after].map((bytes) => boxes(bytes).find((entry) => entry.type === 'mdat')!);
      assert.deepEqual(after.subarray(now.start, now.content), before.subarray(was.start, was.content), 'the header of mdat');
    }
  }
});

test('removing a large cover makes the file smaller; removing a small one leaves padding', async () => {
  const large = png(4, 4, 80_000);
  const before = file(true, { items: [textItem(`${C}nam`, 'T'), coverItem(large), ...others()] });
  const target = put(before);
  await edit(target, {}, { action: 'remove' });
  const after = fs.readFileSync(target);
  const shift = assertIntact(before, after);
  assert.ok(shift < -70_000, `the audio moved by ${shift}`);
  assert.equal(after.length, before.length + shift);
  assert.equal((await read(target)).cover, undefined);

  const small = file(true, { items: [textItem(`${C}nam`, 'T'), coverItem(COVER)] });
  const second = put(small);
  await edit(second, {}, { action: 'remove' });
  assert.equal(fs.readFileSync(second).length, small.length);
  assert.equal(assertIntact(small, fs.readFileSync(second)), 0);
});

// ---- Tag atoms that are not there yet -----------------------------------------------

test('a file without udta gets udta, meta with the iTunes handler, and the list', async () => {
  for (const front of [true, false]) {
    const before = file(front, undefined);
    const target = put(before);
    assert.deepEqual((await read(target)).fields, fields());
    await edit(target, { title: 'First tag', track: '1/9' });
    const after = fs.readFileSync(target);
    assertIntact(before, after);
    const tags = mp4Tags(after);
    assert.equal(tags.full, true);
    assert.deepEqual(tags.parts.map((part) => part.type).slice(0, 2), ['hdlr', 'ilst']);
    assert.equal(after.toString('latin1', tags.parts[0].content + 8, tags.parts[0].content + 12), 'mdir');
    assert.deepEqual(tags.items.map((entry) => entry.raw), [textItem(`${C}nam`, 'First tag'), pairItem('trkn', 1, 9)]);
    assert.deepEqual((await read(target)).fields, fields({ title: 'First tag', track: '1/9' }));
  }
});

test('in a udta that ends in four zero bytes, meta goes in front of them', async () => {
  const name = box('name', Buffer.from('Test'));
  const before = mp4File({ front: true, tracks: [track(rand, 6)], udta: udta({ before: [name], terminated: true }, { noMeta: true }) });
  const target = put(before);
  await edit(target, { title: 'T' });
  const after = fs.readFileSync(target);
  assertIntact(before, after);
  const tags = mp4Tags(after);
  assert.deepEqual(within(after, tags.udta!, 0, true).map((part) => part.type), ['name', 'meta']);
  assert.deepEqual(after.subarray(tags.udta!.end - 4, tags.udta!.end), Buffer.alloc(4));
  assert.equal(tags.meta!.end, tags.udta!.end - 4);
  assert.equal((await read(target)).fields.title, 'T');
});

test('a meta atom that has its handler and no list yet gets the list behind the handler', async () => {
  const before = file(true, {});
  const target = put(before);
  await edit(target, { artist: 'A' });
  const after = fs.readFileSync(target);
  assertIntact(before, after);
  assert.deepEqual(mp4Tags(after).parts.map((part) => part.type).slice(0, 2), ['hdlr', 'ilst']);
  assert.deepEqual(mp4Tags(after).items.map((entry) => entry.raw), [textItem(`${C}ART`, 'A')]);
});

test('a meta atom without version and flags (the QuickTime form) is read and stays in its form', async () => {
  const before = file(false, { items: fullItems(), plain: true });
  const target = put(before);
  assert.deepEqual((await read(target)).fields, FULL);
  await edit(target, { title: 'Changed' });
  const after = fs.readFileSync(target);
  assertIntact(before, after);
  assert.equal(mp4Tags(after).full, false);
  assert.equal((await read(target)).fields.title, 'Changed');
});

// ---- The items ----------------------------------------------------------------------

test('changing one field rebuilds its item in place and keeps every other item as it was', async () => {
  const items = fullItems();
  const before = file(true, { items, pad: 600 });
  const target = put(before);
  await edit(target, { title: 'Новое название ✓ 新しい' });
  const after = mp4Tags(fs.readFileSync(target)).items;
  assert.equal(after.length, items.length);
  after.forEach((entry, i) => assert.deepEqual(entry.raw, i === 0 ? textItem(`${C}nam`, 'Новое название ✓ 新しい') : items[i], `item ${i} (${entry.type})`));
});

test('clearing a field removes its item; a new field is added at the end, as UTF-8 text', async () => {
  const before = file(true, { items: [textItem(`${C}nam`, 'T'), textItem(`${C}cmt`, 'c'), textItem('soar', 's'), textItem(`${C}day`, '1999')], pad: 600 });
  const target = put(before);
  await edit(target, { comment: '', date: '', album_artist: 'Сборник', composer: 'J. S. Bach' });
  assert.deepEqual(mp4Tags(fs.readFileSync(target)).items.map((entry) => entry.raw), [
    textItem(`${C}nam`, 'T'), textItem('soar', 's'), textItem('aART', 'Сборник'), textItem(`${C}wrt`, 'J. S. Bach'),
  ]);
});

test('track and disc are stored as binary pairs of number and total', async () => {
  const target = put(file(true, { items: [], pad: 600 }));
  const stored = async (track: string, disc: string) => {
    await saveTags(target, fields({ title: 'T', track, disc }), KEEP, undefined);
    const bytes = fs.readFileSync(target);
    return [item(bytes, 'trkn'), item(bytes, 'disk')];
  };
  assert.deepEqual(await stored('11/20', '2/3'), [pairItem('trkn', 11, 20), pairItem('disk', 2, 3)]);
  assert.deepEqual(await stored('03', ' 4 / 15 '), [pairItem('trkn', 3, 0), pairItem('disk', 4, 15)]);
  assert.deepEqual(await stored('/9', '65535/65535'), [pairItem('trkn', 0, 9), pairItem('disk', 65535, 65535)]);
  assert.deepEqual(await stored('0', ''), [undefined, undefined]);
});

test('a track or disc that is not a number fails the save and leaves the file as it was', async () => {
  const bytes = file(true, { items: [textItem(`${C}nam`, 'T'), pairItem('trkn', 1, 2)], pad: 600 });
  const target = put(bytes);
  for (const [field, value] of [['track', 'A1'], ['track', '3/x'], ['disc', '70000'], ['track', '1/2/3'], ['disc', '-1']] as const) {
    await assert.rejects(saveTags(target, fields({ title: 'Other', track: '1/2', [field]: value }), KEEP, undefined), /has to be a number/, `${field} = ${value}`);
    assert.ok(fs.readFileSync(target).equals(bytes));
  }
});

test('a numeric genre stays a number until the genre is edited, and is then written as text', async () => {
  const gnre = box('gnre', dataBox(0, u16(18)));
  const target = put(file(true, { items: [gnre, textItem(`${C}nam`, 'T')], pad: 600 }));
  await edit(target, { title: 'Changed' });
  assert.deepEqual(item(fs.readFileSync(target), 'gnre'), gnre);
  await edit(target, { genre: 'Пост-рок' });
  const after = fs.readFileSync(target);
  // The number can't name a genre outside its list, and the two together would contradict each other.
  assert.deepEqual(itemTypes(after), [`${C}gen`, `${C}nam`]);
  assert.deepEqual(item(after, `${C}gen`), textItem(`${C}gen`, 'Пост-рок'));
});

test('a field stored as several values, or in UTF-16, keeps its bytes until that field is edited', async () => {
  const artists = textItem(`${C}ART`, 'First Artist', 'Second Artist');
  const title = box(`${C}nam`, dataBox(2, Buffer.from('Заголовок', 'utf16le').swap16()));
  const target = put(file(true, { items: [artists, title], pad: 600 }));
  await edit(target, { album: 'A' });
  let after = fs.readFileSync(target);
  assert.deepEqual(item(after, `${C}ART`), artists);
  assert.deepEqual(item(after, `${C}nam`), title);
  await edit(target, { artist: 'One Artist' });
  after = fs.readFileSync(target);
  assert.deepEqual(item(after, `${C}ART`), textItem(`${C}ART`, 'One Artist'));
  assert.deepEqual(item(after, `${C}nam`), title);
});

// ---- The cover ------------------------------------------------------------------------

test('a first cover is added with its type: 13 for JPEG, 14 for PNG', async () => {
  for (const image of [jpeg(4, 4, rand.bytes(500)), png(5, 5)]) {
    const before = file(true, { items: [textItem(`${C}nam`, 'T')] });
    const target = put(before);
    const picture = path.join(dir, `cover-${count}`);
    fs.writeFileSync(picture, image);
    await edit(target, {}, { action: 'replace', path: picture });
    const after = fs.readFileSync(target);
    assertIntact(before, after);
    assert.deepEqual(item(after, 'covr'), box('covr', dataBox(image[0] === 0x89 ? 14 : 13, image)));
    assert.deepEqual(Buffer.from((await read(target)).cover!), image);
  }
});

test('replacing the cover swaps the first picture and keeps the second; removing it removes every picture', async () => {
  const second = png(2, 2, 400);
  const before = file(true, { items: [textItem(`${C}nam`, 'T'), coverItem(COVER, second), ...others()], pad: 100 });
  const target = put(before);
  const image = png(6, 6, 900);
  const picture = path.join(dir, 'replacement.png');
  fs.writeFileSync(picture, image);

  await edit(target, {}, { action: 'replace', path: picture });
  let after = fs.readFileSync(target);
  assertIntact(before, after);
  assert.deepEqual(item(after, 'covr'), coverItem(image, second));
  assert.deepEqual(itemTypes(after), itemTypes(before));

  await edit(target, {}, { action: 'remove' });
  after = fs.readFileSync(target);
  assertIntact(before, after);
  assert.equal(item(after, 'covr'), undefined);
  assert.equal((await read(target)).other.some(([key]) => key === 'Additional picture'), false);
});

test('an empty or missing cover file fails the save and leaves the file as it was', async () => {
  const bytes = file(true, { items: [textItem(`${C}nam`, 'T')], pad: 300 });
  const target = put(bytes);
  const empty = path.join(dir, 'empty.png');
  fs.writeFileSync(empty, '');
  await assert.rejects(saveTags(target, fields({ title: 'Other' }), { action: 'replace', path: empty }, undefined), /empty/);
  await assert.rejects(saveTags(target, fields({ title: 'Other' }), { action: 'replace', path: path.join(dir, 'no-such.png') }, undefined));
  assert.ok(fs.readFileSync(target).equals(bytes));
});

// ---- Files that are not rewritten --------------------------------------------------------

/** Overwrites four bytes at `at` with a 32-bit number. */
function patched(bytes: Buffer, at: number, value: number): Buffer {
  const copy = Buffer.from(bytes);
  copy.writeUInt32BE(value, at);
  return copy;
}

/** The chunk offset table of the first track. */
function offsetTable(bytes: Buffer) {
  const moov = boxes(bytes).find((entry) => entry.type === 'moov')!;
  let at = within(bytes, moov).find((entry) => entry.type === 'trak')!;
  for (const type of ['mdia', 'minf', 'stbl', 'stco']) {
    at = within(bytes, at).find((entry) => entry.type === type)!;
  }
  return at;
}

const plain = (more: Partial<Mp4> = {}, tags: TagAtoms = { items: fullItems(), pad: 400 }) => file(false, tags, more);
const QUICKTIME = box('hdlr', Buffer.alloc(8), Buffer.from('mdta'), Buffer.alloc(13));

const REFUSED: [name: string, kind: 'unsupported' | 'damaged', bytes: () => Buffer][] = [
  ['a fragmented file (moof)', 'unsupported', () => plain({ tail: [box('moof', box('mfhd', Buffer.alloc(8)))] })],
  ['a fragmented file (mvex in moov)', 'unsupported', () => plain({ inMoov: [box('mvex', box('mehd', Buffer.alloc(8)))] })],
  ['an unknown top-level atom', 'unsupported', () => plain({ tail: [box('uuid', Buffer.alloc(16), Buffer.from('whatever'))] })],
  ['bytes behind the last atom', 'unsupported', () => Buffer.concat([plain(), Buffer.from([0, 1, 2])])],
  ['two moov atoms', 'unsupported', () => {
    const bytes = plain();
    const moov = boxes(bytes).find((entry) => entry.type === 'moov')!;
    return Buffer.concat([bytes, bytes.subarray(moov.start, moov.end)]);
  }],
  ['two udta atoms', 'unsupported', () => plain({ inMoov: [udta({ items: [] })] })],
  ['two item lists', 'unsupported', () => plain({}, { items: [textItem(`${C}nam`, 'T')], inMeta: [box('ilst')] })],
  ['QuickTime metadata (a keys atom, an mdta handler)', 'unsupported', () => plain({}, { handler: QUICKTIME, inMeta: [box('keys', u32(0), u32(0))], items: [] })],
  ['a handler other than mdir', 'unsupported', () => plain({}, { handler: QUICKTIME, items: [] })],
  ['a meta atom without a handler', 'unsupported', () => plain({}, { handler: Buffer.alloc(0), items: [textItem(`${C}nam`, 'T')] })],
  ['a meta atom directly in moov', 'unsupported', () => plain({ inMoov: [box('meta', u32(0), MDIR)] })],
  ['a compressed moov', 'unsupported', () => plain({ inMoov: [box('cmov', Buffer.alloc(8))] })],
  ['an atom in the sample table that may hold file offsets (saio)', 'unsupported', () => mp4File({ front: false, tracks: [track(rand, 5, { inTable: [box('saio', u32(0), u32(1), u32(1234))] })], udta: udta({ items: [] }) })],
  ['two chunk offset tables in a track', 'unsupported', () => mp4File({ front: false, tracks: [track(rand, 5, { inTable: [box('stco', u32(0), u32(0))] })], udta: udta({ items: [] }) })],
  ['a data reference outside the file', 'unsupported', () => mp4File({ front: false, tracks: [track(rand, 5, { reference: 0 })], udta: udta({ items: [] }) })],
  ['a chunk in front of the audio data', 'unsupported', () => {
    const bytes = plain();
    return patched(bytes, offsetTable(bytes).content + 8, boxes(bytes).find((entry) => entry.type === 'mdat')!.start + 4);
  }],
  ['a chunk that ends behind the file', 'damaged', () => {
    const bytes = plain();
    return patched(bytes, offsetTable(bytes).content + 8, bytes.length - 10);
  }],
  ['an item list whose sizes do not add up', 'damaged', () => {
    const bytes = plain();
    return patched(bytes, mp4Tags(bytes).ilst!.content, 0x7fffffff);
  }],
  ['a chunk offset table that is shorter than it says', 'damaged', () => {
    const bytes = plain();
    return patched(bytes, offsetTable(bytes).content + 4, 500);
  }],
  ['no moov at all', 'damaged', () => {
    const bytes = plain();
    return bytes.subarray(0, boxes(bytes).find((entry) => entry.type === 'moov')!.start);
  }],
  ['an atom that ends behind the file', 'damaged', () => {
    const bytes = file(true, { items: fullItems() });
    return bytes.subarray(0, bytes.length - 50);
  }],
  ['an open mdat that has lost its end', 'damaged', () => {
    const bytes = file(true, { items: fullItems() }, { mdat: 'open' });
    return bytes.subarray(0, bytes.length - 50);
  }],
];

// Stands in for ffmpeg: it leaves a mark when it is run, and fails.
const marker = path.join(dir, 'ffmpeg-was-run');
const fakeFfmpeg = path.join(dir, 'fake-ffmpeg');
fs.writeFileSync(fakeFfmpeg, `#!/bin/sh\necho run >> "${marker}"\nexit 1\n`, { mode: 0o755 });

for (const [name, kind, build] of REFUSED) {
  test(`refused as ${kind}: ${name}`, async () => {
    const bytes = build();
    const target = put(bytes, 'refused.m4a');
    const unchanged = () => assert.ok(fs.readFileSync(target).equals(bytes), 'the file changed');

    assert.equal((await readMp4(target))?.refusal?.kind, kind);
    await assert.rejects(writeMp4(target, fields({ title: 'X' }), KEEP), (e) => e instanceof Mp4Refusal && e.kind === kind);
    unchanged();

    // Without ffmpeg the file is shown read-only with the reason, and a save fails.
    const report = await readTagReport(target, undefined);
    assert.equal(report.writable, false);
    assert.equal(report.coverWritable, false);
    assert.ok(report.note, 'a note that says why');
    assert.equal(/ffmpeg/.test(report.note), kind === 'unsupported');
    await assert.rejects(saveTags(target, fields({ title: 'X' }), KEEP, undefined), Mp4Refusal);
    unchanged();
  });
}

test('with ffmpeg at hand, an unusual file is handed to it and a damaged one is not', { skip: process.platform === 'win32' && 'the stand-in for ffmpeg is a shell script' }, async () => {
  const unusual = put(REFUSED[2][2](), 'unusual.m4a');
  fs.rmSync(marker, { force: true });
  await assert.rejects(saveTags(unusual, fields({ title: 'X' }), KEEP, fakeFfmpeg));
  assert.ok(fs.existsSync(marker), 'ffmpeg was not asked');

  const bytes = REFUSED.find(([, kind]) => kind === 'damaged')![2]();
  const damaged = put(bytes, 'damaged.m4a');
  fs.rmSync(marker, { force: true });
  const report = await readTagReport(damaged, fakeFfmpeg);
  assert.equal(report.writable, false);
  await assert.rejects(saveTags(damaged, fields({ title: 'X' }), KEEP, fakeFfmpeg), (e) => e instanceof Mp4Refusal && e.kind === 'damaged');
  assert.equal(fs.existsSync(marker), false, 'ffmpeg was run on a damaged file');
  assert.ok(fs.readFileSync(damaged).equals(bytes));
});

test('a file that is not MP4, whatever its name says, is none of this module\'s business', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), rand.bytes(300), box('moov', Buffer.alloc(20))]) {
    const target = put(bytes, 'foreign.m4a');
    assert.equal(await readMp4(target), undefined);
    await assert.rejects(writeMp4(target, fields({ title: 'X' }), KEEP), (e) => e instanceof Mp4Refusal && e.kind === 'foreign');
    const report = await readTagReport(target, undefined);
    assert.equal(report.writable, false);
    await assert.rejects(saveTags(target, fields({ title: 'X' }), KEEP, undefined), /ffmpeg is needed/);
    assert.ok(fs.readFileSync(target).equals(bytes));
  }
});

test('a file cut at any length is read-only, and a save fails with the file as it was', async () => {
  const cuts = random(20261008);
  const layouts = [
    file(true, { items: fullItems(), pad: 500 }),
    file(false, { items: fullItems(), pad: 500 }),
    file(true, { items: fullItems() }, { mdat: 'open' }),
    mp4File({ front: true, tracks: [track(rand, 7), track(rand, 9, { wide: true })], udta: udta({ items: [] }), behindMoov: [box('free', Buffer.alloc(200))] }),
  ];
  for (const [n, whole] of layouts.entries()) {
    const moov = boxes(whole).find((entry) => entry.type === 'moov')!;
    const lengths = new Set<number>([1, 7, 8, whole.length - 1]);
    // Every atom boundary of the file and of moov, and the bytes around each.
    for (const edge of [...boxes(whole), ...within(whole, moov)].flatMap((entry) => [entry.start, entry.end])) {
      [edge - 1, edge, edge + 1, edge + 9].forEach((length) => lengths.add(length));
    }
    for (let i = 0; i < 40; i++) {
      lengths.add(1 + cuts.int(whole.length - 1));
    }
    for (let i = 0; i < 25; i++) {
      lengths.add(moov.start + cuts.int(moov.end - moov.start));
    }
    for (const length of [...lengths].filter((value) => value > 0 && value < whole.length)) {
      const bytes = whole.subarray(0, length);
      const target = path.join(dir, `cut-${n}.m4a`);
      fs.writeFileSync(target, bytes);
      const report = await readTagReport(target, undefined);
      assert.equal(report.writable, false, `layout ${n} cut at ${length} of ${whole.length} is offered for editing`);
      await assert.rejects(saveTags(target, fields({ title: 'X' }), KEEP, undefined), `layout ${n} cut at ${length}: the save went through`);
      assert.ok(fs.readFileSync(target).equals(bytes), `layout ${n} cut at ${length}: the file changed`);
    }
  }
});

// ---- The file itself --------------------------------------------------------------------

test('a save keeps the mode of the file and leaves nothing else in the folder', { skip: process.platform === 'win32' && 'no file modes on Windows' }, async () => {
  const folder = path.join(dir, 'alone');
  fs.mkdirSync(folder);
  const target = path.join(folder, 'song.m4a');
  fs.writeFileSync(target, file(true, { items: fullItems() }), { mode: 0o640 });
  fs.chmodSync(target, 0o640);
  await edit(target, { title: 'Moved the audio' });
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(folder), ['song.m4a']);
  // And after a save that fails.
  await assert.rejects(saveTags(target, fields({ track: 'x' }), KEEP, undefined));
  assert.deepEqual(fs.readdirSync(folder), ['song.m4a']);
});
