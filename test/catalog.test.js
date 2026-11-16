import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseFile, updateFile } from 'music-metadata';
import { buildCatalog, stableId } from '../server/catalog.js';
import { createLibrary } from '../server/library.js';
import { chooseRelease, releaseFromLookup } from '../server/musicbrainz.js';

const NOW = '11111111-1111-4111-8111-111111111111';

test('a compilation links a song from another album and keeps the gap', () => {
  const beyonce = track({
    title: 'Crazy in Love',
    artist: 'Beyoncé',
    album: "B'Day",
    albumArtist: 'Beyoncé',
    relPath: "Beyoncé/B'Day/01 Crazy in Love.wav",
  });
  const local = track({
    title: 'Song B',
    artist: 'Someone',
    album: 'Now 50',
    albumArtist: 'Various Artists',
    relPath: 'Various Artists/Now 50/01 Song B.wav',
  });
  const { albums } = buildCatalog([beyonce, local], (group) =>
    group.title === 'Now 50' ? { matched: true, release: nowRelease() } : { matched: false, release: null },
  );
  const now = albums.find((album) => album.title === 'Now 50');
  const day = albums.find((album) => album.title === "B'Day");

  assert.equal(now.slots[0].link, 'home');
  assert.equal(now.slots[0].id, local.id);
  assert.equal(now.slots[1].link, 'linked');
  assert.equal(now.slots[1].id, beyonce.id);
  assert.equal(now.slots[1].sourceAlbum, "B'Day");
  assert.equal(now.slots[2].link, 'missing');
  assert.equal(now.slots[2].title, 'Absent');
  assert.equal(now.slots[2].fileId, null);
  assert.equal(day.slots.length, 1);
  assert.equal(day.slots[0].link, 'home');
  assert.equal(day.slots[0].id, beyonce.id);
  assert.equal(now.missingCount, 1);
  assert.equal(now.linkedCount, 1);
});

test('a merged album accepts a spelling difference even when the length does not match', () => {
  const release = {
    releaseMbid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    title: '10 000 Hz Legend',
    artist: 'Air',
    year: 2001,
    tracks: [
      { disc: 1, track: 1, title: 'Radian', artist: 'Air', duration: 457, recordingMbid: null },
      { disc: 1, track: 2, title: 'Caramel Prisoner', artist: 'Air', duration: 298, recordingMbid: null },
    ],
  };
  const home = track({
    title: 'How Does It Make You Feel?',
    artist: 'Air',
    album: '10 000 Hz Legend',
    albumArtist: 'Air',
    duration: 180,
    relPath: 'Air/10 000 Hz Legend/01 How Does It Make You Feel.mp3',
    releaseMbid: release.releaseMbid,
  });
  const radian = track({
    title: 'Radian',
    artist: 'Air',
    album: '10000 Hz Legend',
    albumArtist: 'Air',
    duration: 305,
    relPath: 'Air/10000 Hz Legend/05 Radian.mp3',
  });
  const split = buildCatalog([home, radian], (group) => (
    group.title === '10 000 Hz Legend' ? { matched: true, release } : { matched: false, release: null }
  ));
  assert.equal(split.albums.length, 2);
  const legend = split.albums.find((album) => album.title === '10 000 Hz Legend');
  assert.equal(legend.slots.find((slot) => slot.title === 'Radian').link, 'missing');
  const { albums } = buildCatalog([home, radian], (group) => (
    group.title === '10 000 Hz Legend' ? { matched: true, release } : { matched: false, release: null }
  ), [{ fromArtist: 'Air', fromTitle: '10000 Hz Legend', intoArtist: 'Air', intoTitle: '10 000 Hz Legend' }]);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].title, '10 000 Hz Legend');
  const slot = albums[0].slots.find((item) => item.title === 'Radian');
  assert.equal(slot.fileId, radian.id);
  assert.equal(slot.sourceAlbum, '10000 Hz Legend');
  assert.equal(albums[0].missingCount, 1);
  assert.equal(albums[0].merged[0].title, '10000 Hz Legend');
});

test('pressings of one album collapse to the release that fits the files', () => {
  const group = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const standardId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const deluxeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const songs = ['Rolling in the Deep', 'Rumour Has It'];
  const files = songs.map((title, index) => track({
    title,
    artist: 'Adele',
    album: '21',
    albumArtist: 'Adele',
    relPath: `Adele/21/0${index + 1} ${title}.mp3`,
    releaseMbid: index === 0 ? standardId : deluxeId,
  }));
  const standard = edition(standardId, group, songs);
  const deluxe = edition(deluxeId, group, [...songs, 'Someone Like You', 'Set Fire to the Rain', 'Turning Tables']);
  const { albums } = buildCatalog(files, (item) => {
    const release = item.releaseMbid === deluxeId ? deluxe : standard;
    return { matched: true, release };
  });
  assert.equal(albums.length, 1);
  assert.equal(albums[0].title, '21');
  assert.equal(albums[0].releaseMbid, standardId);
  assert.equal(albums[0].trackCount, 2);
  assert.equal(albums[0].missingCount, 0);
});

test('duration and recording id keep a lookalike from filling the slot', () => {
  const wrongTake = track({
    title: 'Crazy in Love',
    artist: 'Beyoncé',
    album: "B'Day",
    albumArtist: 'Beyoncé',
    duration: 200,
    recordingMbid: '33333333-3333-4333-8333-333333333333',
    relPath: "Beyoncé/B'Day/01 Crazy in Love.wav",
  });
  const release = nowRelease();
  release.tracks[1].duration = 30;
  release.tracks[1].recordingMbid = '44444444-4444-4444-8444-444444444444';
  const { albums } = buildCatalog([wrongTake], () => ({ matched: true, release }));
  const now = albums.find((album) => album.title === 'Now 50');
  assert.equal(now.slots[1].link, 'missing');
});

test('chooseRelease keeps the title and prefers the matching artist', () => {
  const compilation = chooseRelease(
    [
      releaseHit({ id: 'later', title: 'Now 51', score: 100 }),
      releaseHit({ id: 'other', title: 'Now 50', artist: 'Beyoncé', compilation: false, score: 99 }),
      releaseHit({ id: 'now', title: 'Now 50', score: 80, tracks: 40 }),
    ],
    { title: 'Now 50', artist: 'Various Artists', fileCount: 2 },
  );
  assert.equal(compilation.id, 'now');

  const album = chooseRelease(
    [
      releaseHit({ id: 'various', title: "B'Day", score: 100 }),
      releaseHit({ id: 'beyonce', title: "B'Day", artist: 'Beyoncé', compilation: false, score: 70, tracks: 14 }),
    ],
    { title: "B'Day", artist: 'Beyoncé', fileCount: 14 },
  );
  assert.equal(album.id, 'beyonce');
});

test('lookup tracklists keep disc, duration, and recording id', () => {
  const release = releaseFromLookup({
    id: NOW,
    title: 'Now 50',
    date: '2001-11-19',
    'artist-credit': [{ name: 'Various Artists', joinphrase: '' }],
    'release-group': { id: '22222222-2222-4222-8222-222222222222' },
    media: [
      {
        position: 1,
        tracks: [
          {
            position: 1,
            number: '1',
            title: 'Song B',
            length: 180000,
            recording: {
              id: '33333333-3333-4333-8333-333333333333',
              title: 'Song B',
              length: 180000,
              'artist-credit': [{ name: 'Someone', joinphrase: '' }],
            },
          },
        ],
      },
    ],
  });
  assert.equal(release.year, 2001);
  assert.equal(release.artist, 'Various Artists');
  assert.equal(release.tracks[0].duration, 180);
  assert.equal(release.tracks[0].recordingMbid, '33333333-3333-4333-8333-333333333333');
});

test('the library points at the other file and does not retry a saved match', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(path.join(music, 'Beyoncé', "B'Day"), { recursive: true });
  await mkdir(path.join(music, 'Various Artists', 'Now 50'), { recursive: true });
  await writeFile(path.join(music, 'Beyoncé', "B'Day", '01 Crazy in Love.wav'), wav());
  await writeFile(path.join(music, 'Various Artists', 'Now 50', '01 Song B.wav'), wav());
  const calls = [];
  const musicbrainz = {
    async resolve(group) {
      calls.push(group.title);
      return group.title === 'Now 50' ? nowRelease() : null;
    },
    async cover() {
      return null;
    },
  };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    await library.rescan({ refresh: true });
    const now = library.listAlbums().find((album) => album.title === 'Now 50');
    const day = library.listAlbums().find((album) => album.title === "B'Day");
    const album = library.getAlbum(now.id);
    assert.equal(album.missingCount, 1);
    assert.equal(album.tracks[1].linked, true);
    assert.equal(album.tracks[1].sourceAlbum, "B'Day");
    assert.equal(album.tracks[1].playable, true);
    assert.equal(album.tracks[2].missing, true);
    assert.equal(album.tracks[2].playable, false);
    assert.equal(library.playable(album.tracks[1].id)?.relPath, "Beyoncé/B'Day/01 Crazy in Love.wav");
    assert.equal(library.playable(album.tracks[2].id), null);
    assert.equal(library.getAlbum(day.id).tracks.length, 1);
    assert.equal(library.listTracks().total, 2);
    assert.deepEqual(calls.slice().sort(), ["B'Day", 'Now 50']);

    calls.length = 0;
    const again = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await again.load();
    await again.rescan();
    assert.deepEqual(calls, []);
    assert.equal(again.getAlbum(now.id).tracks[1].linked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('network failures are not cached and the lookup stops after five', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  for (let index = 1; index <= 6; index += 1) {
    await mkdir(path.join(music, 'Artist', `Album ${index}`), { recursive: true });
    await writeFile(path.join(music, 'Artist', `Album ${index}`, '01 Song.wav'), wav());
  }
  let calls = 0;
  const musicbrainz = {
    async resolve() {
      calls += 1;
      throw new Error('down');
    },
    async cover() {
      return null;
    },
  };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    await library.rescan({ musicbrainz: false });
    assert.equal(calls, 0);
    assert.equal(library.listTracks().total, 6);
    await library.rescan();
    assert.equal(calls, 5);
    assert.match(library.getStatus().error, /MusicBrainz/);
    assert.equal(library.listTracks().total, 6);
    calls = 0;
    await library.rescan();
    assert.equal(calls, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('merging a misspelled album keeps both songs after a restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(path.join(music, 'Air', '10 000 Hz Legend'), { recursive: true });
  await mkdir(path.join(music, 'Air', '10000 Hz Legend'), { recursive: true });
  await writeFile(path.join(music, 'Air', '10 000 Hz Legend', '01 How Does It Make You Feel.wav'), wav());
  await writeFile(path.join(music, 'Air', '10000 Hz Legend', '05 Radian.wav'), wav());
  const musicbrainz = { async resolve() { return null; }, async cover() { return null; } };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    await library.rescan({ musicbrainz: false });
    const albums = library.listAlbums();
    assert.equal(albums.length, 2);
    const into = albums.find((album) => album.title === '10 000 Hz Legend');
    const from = albums.find((album) => album.title === '10000 Hz Legend');
    const candidates = library.mergeCandidates(into.id);
    assert.equal(candidates[0].id, from.id);
    assert.equal(candidates[0].score, 100);
    const merged = library.mergeAlbums(into.id, from.id);
    assert.equal(merged.tracks.length, 2);
    assert.equal(merged.tracks.find((track) => track.title === 'Radian').sourceAlbum, '10000 Hz Legend');
    assert.equal(library.listAlbums().length, 1);

    const again = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await again.load();
    assert.equal(again.listAlbums().length, 1);
    const kept = again.getAlbum(into.id);
    assert.equal(kept.tracks.length, 2);
    assert.equal(kept.merged[0].title, '10000 Hz Legend');
    const split = again.separateAlbum(into.id, '10000 Hz Legend');
    assert.equal(split.tracks.length, 1);
    assert.equal(again.listAlbums().length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deleting a song removes the file and keeps it out after a restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(path.join(music, 'Air', 'Moon Safari'), { recursive: true });
  const radian = path.join(music, 'Air', 'Moon Safari', '01 Radian.wav');
  const caramel = path.join(music, 'Air', 'Moon Safari', '02 Caramel.wav');
  await writeFile(radian, wav());
  await writeFile(caramel, wav());
  const musicbrainz = { async resolve() { return null; }, async cover() { return null; } };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    await library.rescan({ musicbrainz: false });
    const before = library.listTracks();
    assert.equal(before.total, 2);
    const gone = before.tracks.find((track) => track.title === 'Radian');
    const saved = await library.deleteTrack(gone.id);
    assert.equal(saved.ok, true);
    await assert.rejects(access(radian));
    const after = library.listTracks();
    assert.equal(after.total, 1);
    assert.equal(after.tracks[0].title, 'Caramel');
    const again = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await again.load();
    assert.equal(again.listTracks().total, 1);
    assert.equal(again.listTracks().tracks[0].title, 'Caramel');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('importing a download moves a tagged song and leaves one without an album', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(music, { recursive: true });
  const tagged = path.join(root, 'tagged.wav');
  const bare = path.join(root, 'bare.wav');
  await writeFile(tagged, wav());
  await writeFile(bare, wav());
  const musicbrainz = { async resolve() { return null; }, async cover() { return null; } };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    const saved = await library.importDownloads([
      { filePath: tagged, name: 'song.wav' },
      { filePath: bare, name: 'bare.wav' },
    ], async (filePath) => (filePath === tagged
      ? { common: { artist: 'Air', album: 'Moon Safari', title: 'La Femme d Argent', track: { no: 1 } } }
      : { common: { title: 'Bare' } }));
    assert.equal(saved.moved.length, 1);
    assert.equal(saved.moved[0].path, 'Air/Moon Safari/01 La Femme d Argent.wav');
    assert.equal(saved.skipped[0].reason, 'missing');
    await assert.rejects(access(tagged));
    await access(bare);
    await access(path.join(music, 'Air', 'Moon Safari', '01 La Femme d Argent.wav'));
    const album = library.listAlbums().find((item) => item.title === 'Moon Safari');
    assert.equal(album.artist, 'Air');
    const again = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await again.load();
    assert.equal(again.listTracks().total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a download folder becomes one compilation album and the songs keep that album', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(music, { recursive: true });
  const gold = path.join(root, 'Goldfinger.wav');
  const sky = path.join(root, 'Skyfall.wav');
  const junk = path.join(root, 'notes.wav');
  await writeFile(gold, wav());
  await writeFile(sky, wav());
  await writeFile(junk, Buffer.from('not audio'));
  await updateFile(gold, {
    title: 'Goldfinger',
    artist: 'Shirley Bassey',
    albumartist: 'Shirley Bassey',
    album: 'Goldfinger',
    musicbrainz_albumid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  await updateFile(sky, {
    title: 'Skyfall',
    artist: 'Adele',
    albumartist: 'Adele',
    album: 'Skyfall',
    musicbrainz_albumid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  const musicbrainz = { async resolve() { return null; }, async cover() { return null; } };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    const saved = await library.importDownloadAlbum([
      { filePath: gold, name: 'Goldfinger.wav' },
      { filePath: sky, name: 'Skyfall.wav' },
      { filePath: junk, name: 'notes.wav' },
    ], 'James Bond Themes');
    assert.equal(saved.album, 'James Bond Themes');
    assert.equal(saved.artist, 'Various Artists');
    assert.equal(saved.moved.length, 2);
    assert.equal(saved.moved[0].path, 'Various Artists/James Bond Themes/01 Goldfinger.wav');
    assert.equal(saved.moved[1].path, 'Various Artists/James Bond Themes/02 Skyfall.wav');
    assert.equal(saved.skipped[0].reason, 'tags');
    await access(junk);
    await assert.rejects(access(gold));
    const stored = path.join(music, 'Various Artists', 'James Bond Themes', '01 Goldfinger.wav');
    const tags = await parseFile(stored, { skipCovers: true, duration: false });
    assert.equal(tags.common.album, 'James Bond Themes');
    assert.equal(tags.common.albumartist, 'Various Artists');
    assert.equal(tags.common.artist, 'Shirley Bassey');
    assert.equal(tags.common.musicbrainz_albumid, undefined);
    const album = library.listAlbums().find((item) => item.title === 'James Bond Themes');
    assert.equal(album.artist, 'Various Artists');
    assert.equal(album.trackCount, 2);
    const again = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await again.load();
    assert.equal(again.listAlbums().length, 1);
    assert.equal(again.listTracks().tracks.find((item) => item.title === 'Skyfall').artist, 'Adele');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rescanning an artist folder adds new songs and leaves other artists alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(path.join(music, 'Air', 'Moon Safari'), { recursive: true });
  await mkdir(path.join(music, 'Beyoncé', "B'Day"), { recursive: true });
  await writeFile(path.join(music, 'Air', 'Moon Safari', '01 Radian.wav'), wav());
  await writeFile(path.join(music, 'Beyoncé', "B'Day", '01 Crazy.wav'), wav());
  const musicbrainz = { async resolve() { return null; }, async cover() { return null; } };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    await library.rescan({ musicbrainz: false });
    const air = library.listAlbums().find((item) => item.title === 'Moon Safari');
    await mkdir(path.join(music, 'Air', 'Talkie Walkie'), { recursive: true });
    await writeFile(path.join(music, 'Air', 'Talkie Walkie', '01 Venus.wav'), wav());
    await writeFile(path.join(music, 'Air', 'Moon Safari', '02 Sexy Boy.wav'), wav());
    const job = library.rescan({ musicbrainz: false, albumId: air.id });
    assert.equal(typeof job.then, 'function');
    await job;
    const titles = library.listAlbums().map((item) => item.title).sort();
    assert.deepEqual(titles, ["B'Day", 'Moon Safari', 'Talkie Walkie']);
    assert.equal(library.listAlbums().find((item) => item.title === 'Moon Safari').trackCount, 2);
    assert.equal(library.listAlbums().find((item) => item.title === "B'Day").trackCount, 1);
    const again = library.rescan({ musicbrainz: false, artistId: air.artistId });
    await again;
    assert.equal(library.listAlbums().length, 3);
    const missing = library.rescan({ albumId: '0123456789abcdef' });
    assert.equal(missing.status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rescanning two spellings of one folder keeps each song once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(path.join(music, 'Air', 'Moon Safari'), { recursive: true });
  await mkdir(path.join(music, 'Air', 'Talkie Walkie'), { recursive: true });
  await writeFile(path.join(music, 'Air', 'Moon Safari', '01 Radian.wav'), wav());
  await writeFile(path.join(music, 'Air', 'Talkie Walkie', '01 Venus.wav'), wav());
  const musicbrainz = { async resolve() { return null; }, async cover() { return null; } };
  try {
    const library = createLibrary({ musicDir: music, dataDir: data, musicbrainz });
    await library.load();
    await library.rescan({ musicbrainz: false });
    const db = new DatabaseSync(path.join(data, 'library.db'));
    db.prepare("UPDATE files SET rel_path = 'air/Talkie Walkie/01 Venus.wav' WHERE rel_path = 'Air/Talkie Walkie/01 Venus.wav'").run();
    db.close();
    await library.load();
    const air = library.listArtists().find((item) => item.name === 'Air');
    assert.equal(air.trackCount, 2);
    await library.rescan({ musicbrainz: false, artistId: air.id });
    const again = library.listArtists().find((item) => item.id === air.id);
    assert.equal(again.trackCount, 2);
    assert.equal(library.listAlbums().length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function edition(releaseMbid, releaseGroupMbid, titles) {
  return {
    releaseMbid,
    releaseGroupMbid,
    title: '21',
    artist: 'Adele',
    year: 2011,
    tracks: titles.map((title, index) => ({
      disc: 1,
      track: index + 1,
      title,
      artist: 'Adele',
      duration: 200,
      recordingMbid: null,
    })),
  };
}

function nowRelease() {
  return {
    releaseMbid: NOW,
    title: 'Now 50',
    artist: 'Various Artists',
    year: 2001,
    tracks: [
      { disc: 1, track: 1, title: 'Song B', artist: 'Someone', duration: null, recordingMbid: null },
      { disc: 1, track: 2, title: 'Crazy in Love', artist: 'Beyoncé', duration: null, recordingMbid: null },
      { disc: 1, track: 3, title: 'Absent', artist: 'Nobody', duration: null, recordingMbid: null },
    ],
  };
}

function track(fields) {
  return {
    id: stableId('track', fields.relPath),
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    albumArtist: fields.albumArtist,
    year: null,
    track: 1,
    disc: 1,
    duration: fields.duration ?? null,
    genre: null,
    format: 'WAV',
    relPath: fields.relPath,
    ext: '.wav',
    size: 1,
    mtimeMs: 1,
    recordingMbid: fields.recordingMbid || null,
    releaseMbid: fields.releaseMbid || null,
    releaseGroupMbid: fields.releaseGroupMbid || null,
  };
}

function releaseHit({ id, title, artist = 'Various Artists', compilation = true, score = 80, tracks = 20 }) {
  return {
    id,
    title,
    score,
    status: 'Official',
    'track-count': tracks,
    'artist-credit': [{ name: artist, joinphrase: '' }],
    'release-group': { 'secondary-types': compilation ? ['Compilation'] : [] },
  };
}

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
