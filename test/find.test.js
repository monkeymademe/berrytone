import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLibrary } from '../server/library.js';
import { albumFromPlaylistTitle, canonicalWatchUrl, fetchYouTubeVideo, parseYouTubePlaylist, parseYouTubeResults, safeYouTubeUrl } from '../server/youtube.js';

test('a missing song can be listed and matched to a YouTube page', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-find-'));
  const music = path.join(root, 'music');
  await mkdir(path.join(music, 'Beyoncé', "B'Day"), { recursive: true });
  await writeFile(path.join(music, 'Beyoncé', "B'Day", '01 Crazy in Love.wav'), wav());
  const library = createLibrary({
    musicDir: music,
    dataDir: path.join(root, 'data'),
    musicbrainz: {
      async resolve() {
        return {
          releaseMbid: '11111111-1111-4111-8111-111111111111',
          title: "B'Day",
          artist: 'Beyoncé',
          year: 2006,
          tracks: [
            { disc: 1, track: 1, title: 'Crazy in Love', artist: 'Beyoncé', duration: null, recordingMbid: null },
            { disc: 1, track: 2, title: 'Absent', artist: 'Beyoncé', duration: null, recordingMbid: null },
          ],
        };
      },
      async cover() {
        return null;
      },
    },
  });
  try {
    await library.load();
    await library.rescan({ refresh: true });
    const album = library.listAlbums().find((item) => item.title === "B'Day");
    const tracks = library.getAlbum(album.id).tracks;
    const missing = tracks.find((track) => track.missing);
    const present = tracks.find((track) => !track.missing);
    assert.equal(missing.title, 'Absent');
    assert.equal(library.addToFindList(album.id, present.id), null);

    const saved = library.addToFindList(album.id, missing.id);
    assert.equal(saved.added, 1);
    assert.equal(library.getAlbum(album.id).tracks.find((track) => track.missing).wanted, true);
    const again = library.addToFindList(album.id, missing.id);
    assert.equal(again.added, 0);
    assert.equal(library.listFinds().length, 1);

    library.store().addFind({
      slotId: present.id,
      albumId: album.id,
      title: present.title,
      artist: 'Beyoncé',
      album: "B'Day",
    });
    assert.equal(library.listFinds().some((item) => item.slotId === present.id), false);
    assert.equal(library.listFinds().length, 1);

    const found = await library.searchFind(saved.items[0].id, async () => [
      { url: 'javascript:alert(1)', label: 'nope' },
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgVcQ', label: 'Absent · Beyoncé' },
    ]);
    assert.equal(found.links.length, 1);
    assert.equal(found.links[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgVcQ');
    const linked = library.addFindLink(found.id, 'https://youtu.be/zzzzzzzzzzz');
    assert.equal(linked.links.some((link) => link.url === 'https://www.youtube.com/watch?v=zzzzzzzzzzz'), true);
    const kept = await library.searchFind(found.id, async () => [
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgVcQ', label: 'Absent · Beyoncé' },
    ]);
    assert.equal(kept.links.filter((link) => link.url.endsWith('zzzzzzzzzzz')).length, 1);
    const preview = await library.previewPlaylist('https://www.youtube.com/playlist?list=PLabcdefghijk1', async () => ({
      title: "B'Day",
      author: 'Beyoncé',
      videos: [
        { videoId: 'aaaaaaaaaaa', title: 'Beyoncé - Crazy in Love' },
        { videoId: 'bbbbbbbbbbb', title: 'Absent (Official Audio)' },
      ],
    }));
    assert.equal(preview.matches[0].title, "B'Day");
    assert.deepEqual(preview.matches[0].missing, ['https://www.youtube.com/watch?v=bbbbbbbbbbb']);
    const url = found.links[0].url;
    const refused = await library.downloadFind(found.id, url, async () => {
      throw new Error('YouTube refused the video');
    });
    assert.equal(refused.error, 'YouTube refused the video');
    assert.equal(library.listFinds()[0].status, 'YouTube refused the video');
    assert.equal((await library.downloadFind(found.id, 'https://www.youtube.com/watch?v=abcdefghijk')).error, 'Choose one of the saved videos');
    assert.equal(library.listFinds()[0].status, 'Choose one of the saved videos');
    let tagged = null;
    const placed = await library.downloadFind(found.id, url, async (request) => {
      tagged = request.tags;
      const file = path.join(request.workDir, 'song.wav');
      await writeFile(file, wav());
      return file;
    });
    assert.equal(placed.ok, true);
    assert.equal(placed.path, "Beyoncé/B'Day/02 Absent.mp3");
    assert.equal(tagged.title, 'Absent');
    assert.equal(tagged.album, "B'Day");
    assert.equal(tagged.albumArtist, 'Beyoncé');
    assert.equal(tagged.track, 2);
    assert.equal(tagged.trackTotal, 2);
    assert.equal(tagged.year, 2006);
    assert.equal(tagged.releaseMbid, '11111111-1111-4111-8111-111111111111');
    assert.equal(library.getAlbum(album.id).tracks.find((track) => track.title === 'Absent').missing, false);
    assert.equal(library.listFinds().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a playlist video can start a new album', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-playlist-'));
  const music = path.join(root, 'music');
  await mkdir(music, { recursive: true });
  const library = createLibrary({ musicDir: music, dataDir: path.join(root, 'data') });
  try {
    await library.load();
    const preview = await library.previewPlaylist('https://www.youtube.com/playlist?list=PLabcdefghijk1', async () => ({
      title: 'Fresh',
      author: 'New Artist',
      videos: [{ videoId: 'ccccccccccc', title: 'New Artist - First Song' }],
    }));
    assert.equal(preview.matches.length, 0);
    assert.equal(preview.artist, 'New Artist');
    assert.equal(preview.album, 'Fresh');
    assert.equal(preview.videos[0].title, 'First Song');
    const saved = await library.downloadPlaylistTrack({
      artist: 'New Artist',
      album: 'Fresh',
      url: preview.videos[0].url,
      title: preview.videos[0].title,
      track: 1,
    }, async ({ workDir }) => {
      const file = path.join(workDir, 'song.wav');
      await writeFile(file, wav());
      return file;
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.path, 'New Artist/Fresh/01 First Song.mp3');
    assert.equal(library.listAlbums().some((item) => item.title === 'Fresh'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('YouTube results keep watch pages and reject other links', () => {
  const videos = parseYouTubeResults({
    contents: {
      videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'Absent' }] }, ownerText: { simpleText: 'Beyoncé' } },
    },
  });
  assert.deepEqual(videos, [{ url: 'https://www.youtube.com/watch?v=abcdefghijk', label: 'Absent · Beyoncé' }]);
  assert.equal(safeYouTubeUrl('https://www.youtube.com/watch?v=abcdefghijk'), true);
  assert.equal(safeYouTubeUrl('https://example.com/watch?v=abcdefghijk'), false);
  assert.equal(safeYouTubeUrl('https://www.youtube.com/results?search_query=Absent'), true);
  assert.equal(canonicalWatchUrl('https://youtu.be/abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(canonicalWatchUrl('https://www.youtube.com/shorts/abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
  const classic = parseYouTubePlaylist({
    header: { playlistHeaderRenderer: { title: { simpleText: "B'Day" }, ownerText: { simpleText: 'Beyoncé' } } },
    contents: { playlistVideoRenderer: { videoId: 'abcdefghijk', title: { simpleText: 'Absent' } } },
  });
  assert.equal(classic.videos[0].videoId, 'abcdefghijk');
  const current = parseYouTubePlaylist({
    metadata: { playlistMetadataRenderer: { title: "B'Day" } },
    sidebar: { playlistSidebarSecondaryInfoRenderer: { videoOwner: { videoOwnerRenderer: { title: { simpleText: 'Beyoncé' } } } } },
    contents: {
      lockupViewModel: {
        contentId: 'bbbbbbbbbbb',
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        metadata: { lockupMetadataViewModel: { title: { content: 'Absent (Official Audio)' } } },
      },
    },
  });
  assert.equal(current.title, "B'Day");
  assert.equal(current.author, 'Beyoncé');
  assert.equal(current.videos[0].videoId, 'bbbbbbbbbbb');
  assert.equal(current.videos[0].title, 'Absent (Official Audio)');
  assert.deepEqual(albumFromPlaylistTitle('Florence + The Machine - Dance Fever (Full Album)', 'Revive Music'), {
    artist: 'Florence + The Machine',
    album: 'Dance Fever',
  });
});

test('a playlist named for one album is not offered a compilation that only shares a word', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-playlist-match-'));
  const music = path.join(root, 'music');
  await mkdir(path.join(music, 'Florence + the Machine', 'Dance Fever'), { recursive: true });
  await mkdir(path.join(music, 'Various Artists', 'The Best Dance Album in the World Ever Part 13'), { recursive: true });
  await writeFile(path.join(music, 'Florence + the Machine', 'Dance Fever', '02 Free.wav'), wav());
  await writeFile(path.join(music, 'Various Artists', 'The Best Dance Album in the World Ever Part 13', '01 Round Round.wav'), wav());
  const library = createLibrary({ musicDir: music, dataDir: path.join(root, 'data'), musicbrainz: { async resolve() { return null; }, async cover() { return null; } } });
  try {
    await library.load();
    await library.rescan({ musicbrainz: false });
    const preview = await library.previewPlaylist('https://www.youtube.com/playlist?list=PLabcdefghijk1', async () => ({
      title: 'Florence + The Machine - Dance Fever (Full Album)',
      author: 'Revive Music',
      videos: [
        { videoId: 'aaaaaaaaaaa', title: 'King' },
        { videoId: 'bbbbbbbbbbb', title: 'Free' },
      ],
    }));
    assert.equal(preview.artist, 'Florence + The Machine');
    assert.equal(preview.album, 'Dance Fever');
    assert.equal(preview.matches[0].title, 'Dance Fever');
    assert.equal(preview.matches.some((item) => item.title.includes('Best Dance Album')), false);
    let playlistReads = 0;
    const song = await library.previewPlaylist('https://youtu.be/ccccccccccc', async () => {
      playlistReads += 1;
      return null;
    }, async () => ({
      title: 'Florence + The Machine - King (Official Audio)',
      author: 'Revive Music',
      videos: [{ videoId: 'ccccccccccc', title: 'Florence + The Machine - King (Official Audio)' }],
    }));
    assert.equal(playlistReads, 0);
    assert.equal(song.single, true);
    assert.equal(song.title, 'King');
    assert.equal(song.artist, 'Florence + The Machine');
    assert.equal(song.album, '');
    assert.equal(song.videos.length, 1);
    assert.equal(song.matches[0].title, 'Dance Fever');
    const listed = await library.previewPlaylist('https://www.youtube.com/watch?v=ccccccccccc&list=PLabcdefghijk1', async () => ({
      title: 'Florence + The Machine - Dance Fever (Full Album)',
      author: 'Revive Music',
      videos: [{ videoId: 'ccccccccccc', title: 'King' }],
    }));
    assert.equal(listed.single, false);
    assert.equal(listed.album, 'Dance Fever');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a song link reads the video title', async () => {
  const video = await fetchYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk', async () => ({
    ok: true,
    async json() {
      return { title: 'King (Official Audio)', author_name: 'Florence + the Machine' };
    },
  }));
  assert.equal(video.single, true);
  assert.equal(video.title, 'King (Official Audio)');
  assert.equal(video.author, 'Florence + the Machine');
  assert.equal(video.videos[0].videoId, 'abcdefghijk');
  assert.equal(await fetchYouTubeVideo('https://example.com/watch?v=abcdefghijk', async () => {
    throw new Error('should not fetch');
  }), null);
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
