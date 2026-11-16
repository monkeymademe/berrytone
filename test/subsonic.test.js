import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLibrary } from '../server/library.js';
import { subsonic } from '../server/subsonic.js';

const NOW = '11111111-1111-4111-8111-111111111111';

test('Amperfy can browse, skip missing songs, and keep a playlist', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-sub-'));
  const music = path.join(root, 'music');
  const data = path.join(root, 'data');
  await mkdir(path.join(music, 'Beyoncé', "B'Day"), { recursive: true });
  await mkdir(path.join(music, 'Various Artists', 'Now 50'), { recursive: true });
  await writeFile(path.join(music, 'Beyoncé', "B'Day", '01 Crazy in Love.wav'), wav());
  await writeFile(path.join(music, 'Various Artists', 'Now 50', '01 Song B.wav'), wav());
  const library = createLibrary({
    musicDir: music,
    dataDir: data,
    musicbrainz: {
      async resolve(group) {
        return group.title === 'Now 50' ? nowRelease() : null;
      },
      async cover() {
        return null;
      },
    },
  });
  try {
    await library.load();
    await library.rescan({ refresh: true });
    const now = library.listAlbums().find((album) => album.title === 'Now 50');
    const day = library.listAlbums().find((album) => album.title === "B'Day");
    const album = ask(library, 'getAlbum', { id: now.id });
    assert.match(album, /status="ok"/);
    assert.match(album, /songCount="2"/);
    assert.match(album, /isDir="false"/);
    assert.doesNotMatch(album, /Absent/);
    assert.match(album, new RegExp(`id="${library.getAlbum(day.id).tracks[0].id}"`));

    const missing = library.getAlbum(now.id).tracks.find((track) => track.missing);
    const hidden = subsonic({
      library,
      params: new URLSearchParams({ id: missing.id }),
      action: 'getsong',
      authUser: '',
      authPassword: '',
    });
    assert.equal(hidden.body.includes('Absent'), false);
    assert.match(hidden.body, /status="failed"/);

    const probe = subsonic({
      library,
      params: new URLSearchParams(),
      action: 'ping',
      authUser: 'berry',
      authPassword: 'secret',
    });
    assert.match(probe.body, /status="ok"/);
    assert.match(probe.body, /version="1.16.1"/);
    const salt = 'salty-salt-1234';
    const token = createHash('md5').update(`secret${salt}`).digest('hex');
    const authed = subsonic({
      library,
      params: new URLSearchParams({ u: 'berry', t: token, s: salt, v: '1.16.1', c: 'Amperfy' }),
      action: 'getArtists',
      authUser: 'berry',
      authPassword: 'secret',
    });
    assert.match(authed.body, /status="ok"/);
    assert.match(authed.body, /Beyoncé/);
    const denied = subsonic({
      library,
      params: new URLSearchParams({ u: 'berry', p: 'nope', v: '1.16.1', c: 'Amperfy' }),
      action: 'getArtists',
      authUser: 'berry',
      authPassword: 'secret',
    });
    assert.match(denied.body, /code="40"/);

    const beyonce = library.browseFolder('1').folders.find((folder) => folder.name === 'Beyoncé');
    const indexes = ask(library, 'getIndexes');
    assert.match(indexes, new RegExp(`artist id="${beyonce.id}" name="Beyoncé"`));
    assert.match(indexes, /name="Various Artists"/);
    const artistDir = ask(library, 'getMusicDirectory', { id: beyonce.id });
    assert.match(artistDir, /isDir="true"/);
    assert.match(artistDir, /title="B'Day"/);
    const dayFolder = library.browseFolder(beyonce.id).folders.find((folder) => folder.name === "B'Day");
    const folderSongs = ask(library, 'getMusicDirectory', { id: dayFolder.id });
    assert.match(folderSongs, /isDir="false"/);
    assert.match(folderSongs, /Crazy in Love/);
    assert.doesNotMatch(folderSongs, /Absent/);
    assert.match(ask(library, 'getArtists'), /name="Beyoncé"/);
    const folderPage = library.folder(beyonce.id);
    assert.equal(folderPage.folders[0].name, "B'Day");
    assert.equal(folderPage.crumbs.at(-1).name, 'Beyoncé');
    assert.equal(library.folderTracks(beyonce.id)[0].title, 'Crazy in Love');

    const songId = library.getAlbum(day.id).tracks[0].id;
    const created = ask(library, 'createPlaylist', { name: 'Road', songId });
    const playlistId = /playlist id="([a-f0-9]{16})"/.exec(created)[1];
    const added = library.listTracks().tracks.find((track) => track.album === 'Now 50').id;
    ask(library, 'updatePlaylist', { playlistId, songIdToAdd: added });
    const playlist = ask(library, 'getPlaylist', { id: playlistId });
    assert.match(playlist, /name="Road"/);
    assert.match(playlist, /songCount="2"/);
    assert.match(playlist, new RegExp(`entry id="${songId}"`));
    assert.match(playlist, new RegExp(`entry id="${added}"`));

    ask(library, 'star', { id: songId });
    library.setFavourite('album', day.id, true);
    ask(library, 'setRating', { id: songId, rating: '5' });
    const song = ask(library, 'getSong', { id: songId });
    assert.match(song, /starred="/);
    assert.match(song, /userRating="5"/);
    const favourites = ask(library, 'getStarred2');
    assert.match(favourites, new RegExp(`song id="${songId}"`));
    assert.match(favourites, new RegExp(`album id="${day.id}"`));
    assert.equal(library.favourites().tracks.some((track) => track.id === songId && track.starred), true);
    library.setFavourite('song', songId, false);
    assert.equal(library.favourites().tracks.some((track) => track.id === songId), false);
    assert.equal(library.setFavourite('song', missing.id, true), null);

    ask(library, 'scrobble', { id: songId, submission: 'true' });
    const recent = ask(library, 'getAlbumList2', { type: 'recent', size: '10' });
    assert.match(recent, /name="B'Day"/);

    const page = ask(library, 'search3', { query: '', artistCount: '0', albumCount: '0', songCount: '10', songOffset: '0' });
    assert.match(page, /isDir="false"/);
    assert.doesNotMatch(page, /Absent/);

    await library.rescan();
    const kept = ask(library, 'getPlaylists');
    assert.match(kept, /name="Road"/);
    ask(library, 'deletePlaylist', { id: playlistId });
    assert.doesNotMatch(ask(library, 'getPlaylists'), /Road/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function ask(library, action, values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else params.set(key, value);
  }
  const result = subsonic({ library, params, action: action.toLowerCase(), authUser: '', authPassword: '' });
  assert.equal(typeof result.body, 'string', action);
  return result.body;
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
