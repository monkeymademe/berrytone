import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDownloads } from '../server/downloads.js';
import { createLibrary } from '../server/library.js';

test('downloads can be played without joining the library', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-dl-'));
  const music = path.join(root, 'music', 'Adele', '21');
  const downloads = path.join(root, 'downloads', 'Shows');
  await mkdir(music, { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(music, '01 Rolling.wav'), wav());
  await writeFile(path.join(downloads, '01 Theme.mp3'), Buffer.from('not-audio'));
  await writeFile(path.join(root, 'downloads', 'Loose song.mp3'), Buffer.from('not-audio'));
  await writeFile(path.join(root, 'downloads', 'cover.jpg'), Buffer.from('image'));
  await symlink('/etc/passwd', path.join(root, 'downloads', 'escape.mp3'));
  const source = createDownloads(path.join(root, 'downloads'));
  const library = createLibrary({
    musicDir: path.join(root, 'music'),
    dataDir: path.join(root, 'data'),
    musicbrainz: { async resolve() { return null; }, async cover() { return null; } },
  });
  try {
    await library.load();
    await library.rescan({ refresh: true });
    assert.equal(library.listTracks().total, 1);
    assert.equal(library.listTracks().tracks[0].title.includes('Theme'), false);

    const page = await source.list('');
    assert.equal(page.name, 'Downloads');
    assert.equal(page.hasArt, true);
    assert.equal(page.folders[0].trackCount, 1);
    assert.equal(page.folders[0].hasArt, false);
    assert.equal((await source.cover(''))?.mime, 'image/jpeg');
    assert.equal(await source.cover('../music'), null);
    assert.equal(page.folders.map((folder) => folder.name).join(), 'Shows');
    assert.deepEqual(page.tracks.map((track) => track.title), ['Loose song']);
    assert.equal(page.tracks[0].source, 'download');
    assert.equal(await source.open('../music/Adele/21/01 Rolling.wav'), null);
    assert.equal(await source.open('escape.mp3'), null);
    await writeFile(path.join(downloads, '02 Credits.mp3'), Buffer.from('not-audio'));
    const nested = await source.list('Shows', { limit: null });
    assert.deepEqual(nested.tracks.map((track) => track.title), ['Theme', 'Credits']);
    assert.equal(nested.total, 2);
    const playable = await source.collect('Shows');
    assert.equal(playable.length, 2);
    assert.equal((await source.open(playable[0].relPath))?.mime, 'audio/mpeg');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function wav() {
  const data = Buffer.alloc(100);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
