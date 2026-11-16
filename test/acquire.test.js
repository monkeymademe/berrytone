import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireAudio, readDownloadProgress } from '../server/acquire.js';

test('download progress reads the percent and the prepare step', () => {
  assert.deepEqual(
    readDownloadProgress('[download]  45.2% of 3.50MiB at 1.20MiB/s ETA 00:02'),
    { phase: 'download', percent: 45.2 },
  );
  assert.deepEqual(readDownloadProgress('[ExtractAudio] Destination: song.mp3'), { phase: 'prepare', percent: null });
  assert.equal(readDownloadProgress('ERROR: Video unavailable'), null);
});

test('a download takes one video and tags it as the library song', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'berrytone-acquire-'));
  const seen = [];
  try {
    const saved = await acquireAudio({
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      workDir: work,
      tags: {
        title: 'Absent',
        artist: 'Beyoncé',
        albumArtist: 'Beyoncé',
        album: "B'Day",
        track: 2,
        trackTotal: 2,
        disc: 1,
        discTotal: 1,
        year: 2006,
        recordingMbid: '33333333-3333-4333-8333-333333333333',
        releaseMbid: '11111111-1111-4111-8111-111111111111',
        releaseGroupMbid: '22222222-2222-4222-8222-222222222222',
        artistMbid: '44444444-4444-4444-8444-444444444444',
        albumArtistMbid: '55555555-5555-4555-8555-555555555555',
      },
      tagImpl(_file, patch) {
        seen.push(patch);
      },
      spawnImpl(command, args) {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(async () => {
          if (command === 'yt-dlp') {
            assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=abcdefghijk');
            assert.equal(args.includes('--no-playlist'), true);
            await writeFile(path.join(work, 'source.mp3'), Buffer.from('audio'));
          } else {
            await writeFile(args.at(-1), Buffer.from('mp3'));
          }
          child.emit('close', 0);
        });
        return child;
      },
    });
    assert.equal(path.basename(saved), 'song.mp3');
    assert.equal((await stat(saved)).isFile(), true);
    assert.equal(seen[0].title, 'Absent');
    assert.equal(seen[0].album, "B'Day");
    assert.equal(seen[0].albumartist, 'Beyoncé');
    assert.deepEqual(seen[0].track, { no: 2, of: 2 });
    assert.deepEqual(seen[0].disk, { no: 1, of: 1 });
    assert.equal(seen[0].year, 2006);
    assert.equal(seen[0].musicbrainz_recordingid, '33333333-3333-4333-8333-333333333333');
    assert.equal(seen[0].musicbrainz_albumid, '11111111-1111-4111-8111-111111111111');
    assert.equal(seen[0].musicbrainz_releasegroupid, '22222222-2222-4222-8222-222222222222');
    assert.equal(seen[0].musicbrainz_artistid, '44444444-4444-4444-8444-444444444444');
    assert.equal(seen[0].musicbrainz_albumartistid, '55555555-5555-4555-8555-555555555555');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
