import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDb } from '../server/db.js';

test('photo lookup only returns artists that have not been checked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-photos-'));
  try {
    const db = openLibraryDb(root);
    db.replaceCatalog({
      scannedAt: '2026-11-15T00:00:00.000Z',
      albums: [],
      files: [
        file('aaaaaaaaaaaaaaaa', 'Checked'),
        file('bbbbbbbbbbbbbbbb', 'New'),
      ],
    });
    db.saveArtistPhoto({ artistId: 'aaaaaaaaaaaaaaaa', mbid: '', checked: true, hasArt: false });
    assert.deepEqual(db.uncheckedArtists().map((row) => row.name), ['New']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function file(artistId, name) {
  return {
    id: artistId,
    relPath: `${name}/song.mp3`,
    ext: '.mp3',
    format: 'MP3',
    size: 1,
    mtimeMs: 1,
    title: 'Song',
    artist: name,
    album: 'Album',
    albumArtist: name,
    albumId: 'cccccccccccccccc',
    artistId,
    year: null,
    track: 1,
    disc: 1,
    duration: 1,
    genre: '',
    recordingMbid: '',
    releaseMbid: '',
    releaseGroupMbid: '',
  };
}
