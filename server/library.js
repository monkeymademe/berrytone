import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFile, selectCover, updateFile } from 'music-metadata';
import { buildCatalog, foldTitle, groupFiles, isGenericArtist } from './catalog.js';
import { describeFile } from './details.js';
import { openLibraryDb } from './db.js';
import { createFanart } from './fanart.js';
import { createMusicBrainz } from './musicbrainz.js';
import { acquireAudio } from './acquire.js';
import { albumFromPlaylistTitle, canonicalWatchUrl, cleanVideoTitle, fetchYouTubePlaylist, fetchYouTubeVideo, playlistIdFrom, safeYouTubeUrl, searchYouTube } from './youtube.js';

const AUDIO = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.m4b', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.wave', 'audio/wav'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.wma', 'audio/x-ms-wma'],
  ['.webm', 'audio/webm'],
]);

const ART_EXT = ['jpg', 'png', 'webp', 'gif'];
const ART_MIME = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};
const IMAGE_EXT = new Map([
  ['.jpg', 'jpg'],
  ['.jpeg', 'jpg'],
  ['.png', 'png'],
  ['.webp', 'webp'],
  ['.gif', 'gif'],
]);
const COVER_RANK = new Map([
  ['cover', 0],
  ['folder', 1],
  ['front', 2],
  ['albumart', 3],
  ['album', 4],
  ['artwork', 5],
]);
const SKIP_DIRS = new Set([
  '@eadir',
  '#recycle',
  '$recycle.bin',
  'system volume information',
  'lost+found',
  '__macosx',
]);

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function createLibrary({ musicDir, dataDir, concurrency = 3, musicbrainz = null }) {
  const artDir = path.join(dataDir, 'art');
  const artistArtDir = path.join(dataDir, 'artist-art');
  const indexPath = path.join(dataDir, 'library.json');
  let db = null;
  let mbMemory = null;
  const brain = musicbrainz || createMusicBrainz();
  const database = () => {
    if (!db) db = openLibraryDb(dataDir);
    return db;
  };
  let current = emptyModel();
  let tracksById = new Map();
  let albumsById = new Map();
  let artistsById = new Map();
  let folderRoot = emptyFolder();
  let foldersById = new Map();
  let scanPromise = null;
  let downloadBusy = false;
  const status = {
    scanning: false,
    enriching: false,
    photos: false,
    photosFound: 0,
    detail: null,
    scannedAt: null,
    processed: 0,
    total: 0,
    skipped: 0,
    error: null,
    download: null,
  };

  function adopt(model) {
    const tracks = (model.tracks || []).filter(isSafeTrack).sort(compareTracks);
    const albums = (model.albums || []).filter(isSafeAlbum).sort(compareAlbums);
    const artists = (model.artists || []).filter(isSafeArtist).sort((a, b) => cmpText(a.name, b.name));
    current = {
      version: 1,
      scannedAt: typeof model.scannedAt === 'string' ? model.scannedAt : null,
      tracks,
      albums,
      artists,
    };
    tracksById = new Map(tracks.map((track) => [track.id, track]));
    albumsById = new Map(albums.map((album) => [album.id, album]));
    artistsById = new Map(artists.map((artist) => [artist.id, artist]));
    const photos = database().artistPhotoMap();
    for (const artist of artists) {
      const photo = photos.get(artist.id);
      artist.hasArt = Boolean(photo?.hasArt);
      artist.artExt = photo?.ext || null;
      artist.artVersion = photo?.version || null;
    }
    const indexed = indexFolders(tracks);
    folderRoot = indexed.root;
    foldersById = indexed.byId;
    status.scannedAt = current.scannedAt;
  }

  function catalogFrom(files) {
    return buildCatalog(files, (group) => mbMap().get(group.key) || null, database().albumMerges());
  }

  async function load() {
    await mkdir(artDir, { recursive: true });
    await mkdir(artistArtDir, { recursive: true });
    const saved = database().loadCatalog();
    const files = database().loadFiles();
    if (files.length) {
      const catalog = catalogFrom(files);
      const previous = new Map(saved.albums.map((album) => [album.id, album]));
      for (const album of catalog.albums) {
        const older = previous.get(album.id);
        if (!older?.hasArt) continue;
        album.hasArt = true;
        album.artExt = older.artExt;
        album.artVersion = older.artVersion;
      }
      adopt(modelFrom(files, catalog.albums, saved.scannedAt));
    } else {
      try {
        const raw = JSON.parse(await readFile(indexPath, 'utf8'));
        if (raw?.version !== 1) throw new Error('unexpected library version');
        adopt(raw);
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`starting from an empty library (${error.message})`);
        adopt(emptyModel());
      }
    }
    if (current.tracks.length) console.log(`loaded library: ${current.tracks.length} tracks`);
  }

  function rescan(options = {}) {
    if (scanPromise) return null;
    if (options.albumId || options.artistId) {
      const roots = options.albumId ? foldersForAlbum(options.albumId) : foldersForArtist(options.artistId);
      if (!roots) return { error: 'That is no longer in the library', status: 404 };
      if (!roots.length) return { error: 'There is no folder to scan', status: 400 };
      scanPromise = runFolderScan(roots);
      return scanPromise;
    }
    scanPromise = runScan(options);
    return scanPromise;
  }

  function matchAlbums() {
    if (scanPromise) return false;
    scanPromise = runMatch();
    return true;
  }

  function findArtistPhotos(key) {
    if (scanPromise) return false;
    const pending = database().uncheckedArtists();
    if (!pending.length) return 'none';
    scanPromise = runArtistPhotos(key, pending);
    return true;
  }

  async function runMatch() {
    status.error = null;
    status.detail = null;
    try {
      await enrich(current.tracks.slice(), { refresh: true });
    } catch (error) {
      status.error = error.message || 'MusicBrainz failed';
      console.error(`musicbrainz failed: ${status.error}`);
    } finally {
      status.enriching = false;
      status.detail = null;
      scanPromise = null;
    }
  }

  async function runScan({ refresh = false, musicbrainz = true } = {}) {
    status.scanning = true;
    status.enriching = false;
    status.detail = null;
    status.error = null;
    status.processed = 0;
    status.total = 0;
    status.skipped = 0;
    const started = Date.now();
    try {
      const files = await readFiles();
      const local = catalogFrom(files);
      await attachArt(local.albums, { allowRemote: false });
      for (const file of files) file.fresh = false;
      await publish(files, local.albums);
      console.log(
        `scan complete: ${current.tracks.length} tracks, ${current.albums.length} albums, ${current.artists.length} artists in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      status.scanning = false;
      if (musicbrainz) await enrich(files, { refresh });
    } catch (error) {
      status.error = error.message || 'Scan failed';
      console.error(`scan failed: ${status.error}`);
    } finally {
      status.scanning = false;
      status.enriching = false;
      status.detail = null;
      scanPromise = null;
    }
  }

  async function runFolderScan(roots) {
    status.scanning = true;
    status.enriching = false;
    status.detail = `Looking through ${roots.map((rel) => rel.split('/').at(-1)).join(', ')}`;
    status.error = null;
    status.processed = 0;
    status.total = 0;
    status.skipped = 0;
    try {
      const rootReal = await realpathOf(musicDir);
      const directories = [];
      for (const rel of roots) {
        const abs = absFromRel(musicDir, rel);
        if (!abs) continue;
        const real = await realpathOf(abs).catch(() => null);
        if (!real || !isInside(rootReal, real)) continue;
        const info = await stat(abs).catch(() => null);
        if (!info?.isDirectory()) continue;
        directories.push(abs);
      }
      if (!directories.length) {
        status.error = 'That folder is not in the music library';
        return;
      }
      const found = [];
      const seen = new Set();
      for (const dir of directories) await walk(dir, rootReal, found, seen);
      status.total = found.length;
      const previous = new Map(database().loadFiles().map((file) => [file.relPath, file]));
      const tracks = await mapPool(found, concurrency, async (full) => {
        const track = await readTrack(full, musicDir, previous);
        status.processed += 1;
        if (status.processed === found.length || status.processed % 250 === 0) {
          console.log(`scan ${status.detail} ${status.processed}/${found.length}`);
        }
        return track;
      });
      const fresh = tracks.filter(Boolean);
      status.skipped = fresh.filter((track) => track.tagError).length;
      const inside = (relPath) => roots.some((prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`));
      const foldedRoots = roots.map((rel) => rel.toLocaleLowerCase('en'));
      const sameSpelling = (relPath) => {
        const folded = String(relPath).toLocaleLowerCase('en');
        return foldedRoots.some((prefix) => folded === prefix || folded.startsWith(`${prefix}/`));
      };
      const freshInodes = new Set();
      for (const full of found) {
        const info = await stat(full).catch(() => null);
        if (info) freshInodes.add(`${info.dev}:${info.ino}`);
      }
      const kept = [];
      for (const file of database().loadFiles()) {
        if (!file.relPath || inside(file.relPath)) continue;
        if (sameSpelling(file.relPath)) {
          const abs = absFromRel(musicDir, file.relPath);
          const info = abs ? await stat(abs).catch(() => null) : null;
          if (info && freshInodes.has(`${info.dev}:${info.ino}`)) continue;
        }
        kept.push(file);
      }
      const byPath = new Map(fresh.map((file) => [file.relPath, file]));
      const files = [...kept, ...byPath.values()];
      const catalog = catalogFrom(files);
      await attachArt(catalog.albums, { allowRemote: false });
      for (const file of files) file.fresh = false;
      await publish(files, catalog.albums);
      console.log(`folder scan complete: ${fresh.length} tracks in ${roots.join(', ')}`);
    } catch (error) {
      status.error = error.message || 'Scan failed';
      console.error(`scan failed: ${status.error}`);
    } finally {
      status.scanning = false;
      status.enriching = false;
      status.detail = null;
      scanPromise = null;
    }
  }

  async function readFiles() {
    const musicStat = await stat(musicDir).catch((error) => {
      throw new Error(`Cannot open the music folder (${error.code || error.message}). Check MUSIC_PATH and that the container can read it.`);
    });
    if (!musicStat.isDirectory()) throw new Error('MUSIC_DIR is not a folder');
    let rootReal;
    try {
      rootReal = await realpathOf(musicDir);
      await access(musicDir, constants.R_OK);
    } catch (error) {
      throw new Error(`Cannot read the music folder (${error.code || error.message}). Check PUID and PGID.`);
    }

    const found = [];
    await walk(musicDir, rootReal, found);
    status.total = found.length;
    const previous = new Map(database().loadFiles().map((file) => [file.relPath, file]));
    const tracks = await mapPool(found, concurrency, async (full) => {
      const track = await readTrack(full, musicDir, previous);
      status.processed += 1;
      if (status.processed === found.length || status.processed % 250 === 0) {
        console.log(`scan ${status.processed}/${found.length}`);
      }
      return track;
    });
    const playable = tracks.filter(Boolean);
    status.skipped = playable.filter((track) => track.tagError).length;
    return playable;
  }

  async function enrich(files, { refresh }) {
    const pending = groupFiles(files).filter((group) => {
      const cached = mbMap().get(group.key);
      if (!cached) return true;
      return refresh && !cached.matched;
    });
    if (!pending.length) return;
    status.enriching = true;
    let failures = 0;
    let looked = 0;
    for (const group of pending) {
      status.detail = `Checking MusicBrainz ${looked + 1} of ${pending.length}`;
      try {
        const release = await brain.resolve(group);
        saveMatch(group.key, Boolean(release), release);
        failures = 0;
      } catch (error) {
        failures += 1;
        console.warn(`musicbrainz ${group.title}: ${error.message}`);
        if (failures >= 5) {
          status.error = 'MusicBrainz is not responding. The local catalog is still available.';
          break;
        }
      }
      looked += 1;
      if (looked % 40 === 0) await republish(files, { persist: looked % 120 === 0 });
    }
    await republish(files, { persist: true, announce: true });
  }

  function mbMap() {
    if (!mbMemory) mbMemory = database().loadCache();
    return mbMemory;
  }

  function saveMatch(key, matched, release) {
    const value = { matched: Boolean(matched), release: matched ? release : null };
    mbMap().set(key, value);
    database().writeCache(key, value.matched, value.release);
  }

  async function republish(files, { persist = false, announce = false } = {}) {
    const catalog = catalogFrom(files);
    await attachArt(catalog.albums, { allowRemote: true });
    for (const file of files) file.fresh = false;
    const scannedAt = announce || !status.scannedAt ? new Date().toISOString() : status.scannedAt;
    if (persist) {
      await new Promise((resolve) => setImmediate(resolve));
      database().replaceCatalog({ scannedAt, files, albums: catalog.albums });
    }
    adopt(modelFrom(files, catalog.albums, scannedAt));
    if (persist) await pruneArt();
  }

  async function attachArt(albums, { allowRemote }) {
    for (const album of albums) {
      const home = album.homeFiles || [];
      const dirty = home.some((track) => track.fresh);
      const previous = albumsById.get(album.id);
      if (previous && !dirty) {
        album.hasArt = Boolean(previous.hasArt);
        album.artExt = previous.artExt || null;
        album.artVersion = previous.artVersion ?? null;
        if (album.hasArt || !allowRemote || !album.releaseMbid || database().coverChecked(album.id)) continue;
      } else {
        album.tracks = album.release
          ? home.filter((track) => foldTitle(track.tagAlbum) === foldTitle(album.title))
          : home;
        album.dirty = dirty;
        await resolveArt(album, musicDir);
      }
      if (album.hasArt || !allowRemote || !album.releaseMbid) continue;
      if (database().coverChecked(album.id)) continue;
      try {
        const cover = await brain.cover(album.releaseMbid);
        database().markCoverChecked(album.id);
        if (cover) await storeArt(album, cover.ext, cover.bytes);
      } catch (error) {
        console.warn(`cover ${album.title}: ${error.message}`);
      }
    }
  }

  async function publish(files, albums) {
    const scannedAt = new Date().toISOString();
    database().replaceCatalog({ scannedAt, files, albums });
    adopt(modelFrom(files, albums, scannedAt));
    await pruneArt();
  }


  async function resolveArt(album, root) {
    const existing = await existingArt(album.id);
    if (existing && !album.dirty) {
      album.hasArt = true;
      album.artExt = existing.ext;
      album.artVersion = existing.version;
      return;
    }
    const folderImage = await findFolderImage(root, dominantDir(album.tracks));
    if (folderImage) {
      await storeArt(album, folderImage.ext, folderImage.abs);
      return;
    }
    for (const track of album.tracks.slice(0, 4)) {
      try {
        const metadata = await parseFile(absFromRel(root, track.relPath), { duration: false, skipCovers: false });
        const picture = selectCover(metadata.common?.picture);
        const bytes = picture?.data;
        if (!bytes?.byteLength || bytes.byteLength > 20 * 1024 * 1024) continue;
        await storeArt(album, extForMime(picture.format), Buffer.from(bytes));
        return;
      } catch {
        // Try another track in the album. Some files have no embedded art.
      }
    }
    if (existing) {
      album.hasArt = true;
      album.artExt = existing.ext;
      album.artVersion = existing.version;
      return;
    }
    album.hasArt = false;
    album.artExt = null;
    album.artVersion = null;
  }

  async function storeArt(album, ext, source) {
    const dest = path.join(artDir, `${album.id}.${ext}`);
    if (typeof source === 'string') await copyFile(source, dest);
    else await writeFile(dest, source);
    const info = await stat(dest);
    album.hasArt = true;
    album.artExt = ext;
    album.artVersion = Math.round(info.mtimeMs);
  }

  async function existingArt(albumId) {
    for (const ext of ART_EXT) {
      const filePath = path.join(artDir, `${albumId}.${ext}`);
      try {
        const info = await stat(filePath);
        if (info.isFile() && info.size > 0 && info.size < 20 * 1024 * 1024) {
          return { ext, version: Math.round(info.mtimeMs), filePath };
        }
      } catch {
        // This extension is not the one we stored.
      }
    }
    return null;
  }

  async function pruneArt() {
    const keep = new Set(
      current.albums.filter((album) => album.hasArt && album.artExt).map((album) => `${album.id}.${album.artExt}`),
    );
    const names = await readdir(artDir).catch(() => []);
    await Promise.all(
      names.filter((name) => !keep.has(name)).map((name) => unlink(path.join(artDir, name)).catch(() => {})),
    );
  }


  function getStatus() {
    return {
      ok: true,
      scanning: status.scanning,
      enriching: status.enriching,
      photos: status.photos,
      photosFound: status.photosFound,
      detail: status.detail,
      scannedAt: status.scannedAt,
      processed: status.processed,
      total: status.total,
      skipped: status.skipped,
      download: status.download ? { ...status.download } : null,
      tracks: current.tracks.length,
      albums: current.albums.length,
      artists: current.artists.length,
      error: status.error,
    };
  }

  function listAlbums() {
    const sets = marks();
    return current.albums.map((album) => withStar(publishAlbum(album), 'album', sets));
  }

  function mergeCandidates(id) {
    const album = albumsById.get(id);
    if (!album) return null;
    const artist = foldTitle(album.artist);
    return current.albums
      .filter((item) => item.id !== album.id && foldTitle(item.artist) === artist)
      .map((item) => ({
        id: item.id,
        title: item.title,
        year: item.year,
        trackCount: item.foundCount ?? item.trackCount,
        score: albumLikeness(album.title, item.title),
      }))
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, 40);
  }

  function mergeAlbums(intoId, fromId) {
    if (scanPromise) return { error: 'A scan is already running', status: 409 };
    const into = albumsById.get(intoId);
    const from = albumsById.get(fromId);
    if (!into || !from) return null;
    if (into.id === from.id) return { error: 'Choose a different album', status: 400 };
    if (foldTitle(into.artist) !== foldTitle(from.artist)) return { error: 'Those albums are by different artists', status: 400 };
    database().addAlbumMerge({
      fromArtist: from.artist,
      fromTitle: from.title,
      intoArtist: into.artist,
      intoTitle: into.title,
    });
    rebuildFromStore();
    return getAlbum(into.id);
  }

  function separateAlbum(intoId, title) {
    if (scanPromise) return { error: 'A scan is already running', status: 409 };
    const into = albumsById.get(intoId);
    if (!into) return null;
    const merge = (into.merged || []).find((item) => foldTitle(item.title) === foldTitle(title));
    if (!merge) return { error: 'That album is not combined here', status: 404 };
    database().removeAlbumMerge({ fromArtist: merge.artist, fromTitle: merge.title });
    rebuildFromStore();
    return getAlbum(into.id);
  }

  function rebuildFromStore() {
    const files = database().loadFiles();
    const catalog = catalogFrom(files);
    const previous = new Map(current.albums.map((album) => [album.id, album]));
    for (const album of catalog.albums) {
      const older = previous.get(album.id);
      if (!older?.hasArt) continue;
      album.hasArt = true;
      album.artExt = older.artExt;
      album.artVersion = older.artVersion;
    }
    const scannedAt = current.scannedAt || new Date().toISOString();
    database().replaceCatalog({ scannedAt, files, albums: catalog.albums });
    adopt(modelFrom(files, catalog.albums, scannedAt));
  }

  function getAlbum(id) {
    const album = albumsById.get(id);
    if (!album) return null;
    const slots = album.slots?.length
      ? album.slots
      : current.tracks
          .filter((track) => track.albumId === id)
          .sort(compareAlbumTracks)
          .map((track) => ({ ...track, fileId: track.id, link: 'home', sourceAlbum: null }));
    const sets = marks();
    const wanted = new Set(database().listFinds().map((item) => item.slotId));
    const tracks = slots.map((slot) => {
      const published = withStar(publishTrack({
        ...slot,
        albumId: album.id,
        artistId: album.artistId,
        album: album.title,
        albumArtist: album.artist,
        year: album.year,
      }), 'song', sets);
      if (published.missing) published.wanted = wanted.has(published.id);
      return published;
    });
    return { ...withStar(publishAlbum(album), 'album', sets), tracks };
  }

  function listArtists() {
    const sets = marks();
    return current.artists.map((artist) => withStar(publishArtist(artist), 'artist', sets));
  }

  function getArtist(id) {
    const artist = artistsById.get(id);
    if (!artist) return null;
    const sets = marks();
    const albums = current.albums.filter((album) => album.artistId === id).sort(compareAlbums);
    return {
      ...withStar(publishArtist(artist), 'artist', sets),
      albums: albums.map((album) => withStar(publishAlbum(album), 'album', sets)),
    };
  }

  function listTracks({ offset, limit } = {}) {
    const start = clampInt(offset == null || offset === '' ? 0 : offset, 0, 1_000_000);
    const size = clampInt(limit == null || limit === '' ? 200 : limit, 1, 200);
    const sets = marks();
    return {
      total: current.tracks.length,
      offset: start,
      tracks: current.tracks.slice(start, start + size).map((track) => withStar(publishTrack(track), 'song', sets)),
    };
  }

  function search(query) {
    const needle = fold(query).slice(0, 200);
    if (!needle) return { artists: [], albums: [], tracks: [] };
    const artists = rank(current.artists, (artist) => score(artist.name, needle)).slice(0, 6);
    const albums = rank(current.albums, (album) =>
      Math.max(weighted(score(album.title, needle), 5), score(album.artist, needle)),
    ).slice(0, 8);
    const tracks = rank(current.tracks, (track) =>
      Math.max(
        weighted(score(track.title, needle), 8),
        score(track.artist, needle),
        score(track.albumArtist, needle),
        score(track.album, needle),
        weighted(score(track.genre || '', needle), -4),
      ),
    ).slice(0, 25);
    const sets = marks();
    return {
      artists: artists.map((artist) => withStar(publishArtist(artist), 'artist', sets)),
      albums: albums.map((album) => withStar(publishAlbum(album), 'album', sets)),
      tracks: tracks.map((track) => withStar(publishTrack(track), 'song', sets)),
    };
  }

  function favourites() {
    const sets = marks();
    const artists = [...sets.artist.keys()].map((id) => artistsById.get(id)).filter(Boolean).map((artist) => withStar(publishArtist(artist), 'artist', sets));
    const albums = [...sets.album.keys()].map((id) => albumsById.get(id)).filter(Boolean).map((album) => withStar(publishAlbum(album), 'album', sets));
    const tracks = [...sets.song.keys()].map((id) => tracksById.get(id)).filter(Boolean).map((track) => withStar(publishTrack(track), 'song', sets));
    return { artists, albums, tracks };
  }

  function listFinds() {
    const items = [];
    for (const row of database().listFinds()) {
      const item = publishFind(row);
      if (item.inLibrary) {
        database().deleteFind(item.id);
        continue;
      }
      items.push(item);
    }
    return items;
  }

  function addToFindList(albumId, slotId) {
    const album = albumsById.get(albumId);
    if (!album || (slotId && !/^[a-f0-9]{16}$/.test(slotId))) return null;
    const missing = (album.slots || []).filter((slot) => slot.link === 'missing' && (!slotId || slot.id === slotId));
    if (slotId && !missing.length) return null;
    let added = 0;
    for (const slot of missing) {
      if (!database().findBySlot(slot.id)) added += 1;
      database().addFind({
        slotId: slot.id,
        albumId: album.id,
        title: slot.title,
        artist: slot.artist,
        album: album.title,
      });
    }
    return { added, items: listFinds().filter((item) => item.albumId === album.id && (!slotId || item.slotId === slotId)) };
  }

  async function searchFind(id, search = searchYouTube) {
    if (!/^[a-f0-9]{16}$/.test(id || '')) return null;
    const row = database().getFind(id);
    if (!row) return null;
    const album = row.album && foldTitle(row.album) !== foldTitle(row.title) ? row.album : '';
    const query = [row.artist, row.title, album].filter(Boolean).join(' ').trim() || row.title;
    const links = (await search(query)).filter((link) => safeYouTubeUrl(link?.url)).slice(0, 5);
    if (!links.length) return { error: 'YouTube did not return a page for that song' };
    database().replaceFindLinks(id, links);
    return publishFind(database().getFind(id));
  }

  function addFindLink(id, url) {
    if (!/^[a-f0-9]{16}$/.test(id || '')) return null;
    const watch = canonicalWatchUrl(url);
    if (!watch) return { error: 'Use a YouTube video link', status: 400 };
    if (!database().addFindLink(id, watch)) return null;
    return publishFind(database().getFind(id));
  }

  async function searchAllFinds(search = searchYouTube) {
    const waiting = listFinds();
    let found = 0;
    let failed = 0;
    for (const item of waiting) {
      const result = await searchFind(item.id, search);
      if (!result || result.error) failed += 1;
      else found += 1;
    }
    return { found, failed, items: listFinds() };
  }

  async function previewPlaylist(url, load = fetchYouTubePlaylist, loadVideo = fetchYouTubeVideo) {
    if (!playlistIdFrom(url)) {
      const watch = canonicalWatchUrl(url);
      if (!watch) return { error: 'Use a YouTube song or playlist link', status: 400 };
      let video;
      try {
        video = await loadVideo(watch);
      } catch (error) {
        return { error: error.message || 'That YouTube song could not be read', status: 502 };
      }
      if (!video?.videos?.length) return { error: 'Use a YouTube song or playlist link', status: 400 };
      return previewFrom({ ...video, single: true });
    }
    let playlist;
    try {
      playlist = await load(url);
    } catch (error) {
      return { error: error.message || 'That YouTube playlist could not be read', status: 502 };
    }
    if (!playlist) return { error: 'Use a YouTube song or playlist link', status: 400 };
    return previewFrom(playlist);
  }

  function previewFrom(playlist) {
    const single = Boolean(playlist.single);
    const hinted = single
      ? singleSongNames(playlist.videos[0]?.title || playlist.title, playlist.author)
      : albumFromPlaylistTitle(playlist.title, playlist.author);
    const videos = playlist.videos.map((video, index) => ({
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      label: video.title,
      title: single && index === 0 ? hinted.title : (cleanVideoTitle(video.title, playlist.title, playlist.author) || video.title),
      track: index + 1,
    }));
    const named = {
      ...playlist,
      title: single ? hinted.title : playlist.title,
      artist: hinted.artist,
      album: hinted.album,
      single,
      videos,
    };
    return {
      title: named.title,
      author: playlist.author,
      artist: hinted.artist,
      album: hinted.album,
      single,
      truncated: Boolean(playlist.truncated),
      videos,
      matches: matchPlaylist(named),
    };
  }

  function singleSongNames(title, author) {
    const cleaned = cleanVideoTitle(title, '', author);
    const parts = cleaned.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      return { title: parts.slice(1).join(' - ').trim() || cleaned, artist: parts[0].trim(), album: '' };
    }
    return { title: cleaned, artist: String(author || '').trim(), album: '' };
  }

  function matchPlaylist(playlist) {
    const hinted = playlist.single
      ? { artist: playlist.artist || playlist.author || '', album: playlist.album || '' }
      : albumFromPlaylistTitle(playlist.title, playlist.author);
    const ranked = [];
    for (const album of current.albums) {
      const present = presentTitles(album);
      const missing = playlist.videos.filter((video) => !present.some((title) => titlesClose(video.title, title))).map((video) => video.url);
      const overlap = playlist.videos.length - missing.length;
      const score = Math.max(titleScore(playlist.title, album.title), titleScore(hinted.album, album.title))
        + Math.max(titleScore(playlist.author, album.artist), titleScore(hinted.artist, album.artist))
        + overlap * 8;
      if (score <= 0) continue;
      ranked.push({
        id: album.id,
        title: album.title,
        artist: album.artist,
        score,
        overlap,
        missing,
      });
    }
    ranked.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
    const overlapNeeded = playlist.single ? 1 : 3;
    return ranked.filter((item) => item.score >= 40 || item.overlap >= overlapNeeded).slice(0, 8);
  }

  function presentTitles(album) {
    const titles = [];
    for (const slot of album.slots || []) {
      if (slot.link !== 'missing') titles.push(slot.title);
    }
    if (!titles.length) {
      for (const track of current.tracks) {
        if (track.albumId === album.id) titles.push(track.title);
      }
    }
    return titles;
  }

  function titlesClose(videoTitle, trackTitle) {
    const video = foldTitle(videoTitle);
    const track = foldTitle(trackTitle);
    if (!video || !track) return false;
    if (video === track) return true;
    return track.length >= 10 && (video.includes(track) || track.includes(video));
  }

  function titleScore(left, right) {
    const a = foldTitle(left);
    const b = foldTitle(right);
    if (!a || !b) return 0;
    if (a === b) return 80;
    if (a.includes(b) || b.includes(a)) return 40;
    const skip = new Set(['the', 'and', 'full', 'album', 'vol', 'volume', 'part']);
    const words = new Set(a.split(' ').filter((word) => word.length > 2 && !skip.has(word)));
    const shared = new Set(b.split(' ').filter((word) => words.has(word)));
    return shared.size * 12;
  }

  async function downloadPlaylistTrack({ albumId, artist, album, url, title, track } = {}, acquire = acquireAudio) {
    const watch = canonicalWatchUrl(url);
    if (!watch) return { error: 'Use a YouTube video link', status: 400 };
    const song = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!song) return { error: 'That video needs a title', status: 400 };
    reportDownload({ title: song, album: String(album || '').trim(), phase: 'match', percent: null });
    try {
      const number = Number.isInteger(Number(track)) && Number(track) > 0 ? Number(track) : null;
      let target = /^[a-f0-9]{16}$/.test(albumId || '') ? albumsById.get(albumId) : null;
      if (albumId && albumId !== 'new' && !target) return { error: 'That album is no longer in the library', status: 404 };
      if (target && presentTitles(target).some((item) => titlesClose(song, item))) {
        return { ok: true, skipped: true, title: song, album: target.title, albumId: target.id };
      }
      const folder = target
        ? albumFolder(target)
        : `${fileStem(artist) || ''}/${fileStem(album) || ''}`;
      if (!target && (!fileStem(artist) || !fileStem(album))) {
        return { error: 'A new album needs an artist and a name', status: 400 };
      }
      const tags = target
        ? await musicbrainzTags(target, target.slots?.find((slot) => foldTitle(slot.title) === foldTitle(song)) || null, { title: song, artist: artist || target.artist })
        : { title: song, artist: String(artist || '').trim(), albumArtist: String(artist || '').trim(), album: String(album || '').trim(), track: number, disc: 1 };
      if (!tags.title) tags.title = song;
      if (!tags.track) tags.track = number;
      reportDownload({ title: tags.title, album: tags.album, phase: 'match', percent: null });
      const relative = `${folder}/${libraryFileName(tags.track, tags.title)}`;
      const saved = await saveDownloaded({ key: hash('playlist', watch, relative), url: watch, tags, relative, acquire });
      if (!saved.ok) return saved;
      const placed = current.tracks.find((item) => item.relPath === saved.path);
      return { ...saved, albumId: placed?.albumId || target?.id || '', album: target?.title || tags.album, title: tags.title };
    } finally {
      status.download = null;
    }
  }

  function reportDownload(patch) {
    status.download = { title: '', album: '', phase: 'download', percent: null, ...(status.download || {}), ...patch };
  }

  function removeFind(id) {
    if (!/^[a-f0-9]{16}$/.test(id || '')) return false;
    return database().deleteFind(id);
  }

  async function downloadFind(id, url, acquire = acquireAudio) {
    if (!/^[a-f0-9]{16}$/.test(id || '')) return null;
    const row = database().getFind(id);
    if (!row) return null;
    const fail = (error, status) => {
      database().setFindStatus(id, error);
      return { error, status };
    };
    if (downloadBusy || scanPromise) return fail('A download is already running', 409);
    if (!isWatchPage(url) || !row.links.some((link) => link.url === url)) {
      return fail('Choose one of the saved videos', 400);
    }
    const album = row.albumId ? albumsById.get(row.albumId) : null;
    if (!album) return fail('That album is no longer in the library', 404);
    const published = publishFind(row);
    if (published.inLibrary) {
      database().deleteFind(id);
      return { ok: true, removed: true, title: row.title, album: album.title };
    }
    const slot = album.slots?.find((item) => item.id === row.slotId) || null;
    downloadBusy = true;
    database().setFindStatus(id, '');
    reportDownload({ title: row.title, album: album.title, phase: 'match', percent: null });
    try {
      const tags = await musicbrainzTags(album, slot, row);
      const relative = `${albumFolder(album)}/${libraryFileName(tags.track, tags.title)}`;
      const saved = await saveDownloaded({ key: id, url, tags, relative, acquire, holdBusy: true });
      if (saved.error) {
        database().setFindStatus(id, saved.error);
        return saved;
      }
      database().deleteFind(id);
      return { ...saved, title: row.title, album: album.title };
    } catch (error) {
      console.warn(`download: ${error.message}`);
      return fail(error.message || 'The song could not be downloaded', 502);
    } finally {
      downloadBusy = false;
      status.download = null;
    }
  }

  async function saveDownloaded({ key, url, tags, relative, acquire, holdBusy = false }) {
    if (!holdBusy && (downloadBusy || scanPromise)) return { error: 'A download is already running', status: 409 };
    const destination = absFromRel(musicDir, relative);
    if (!destination) return { error: 'The album folder is not inside the music library', status: 400 };
    if (!holdBusy) downloadBusy = true;
    reportDownload({ title: tags.title, album: tags.album, phase: 'download', percent: 0 });
    const work = path.join(dataDir, 'incoming', key);
    try {
      await mkdir(work, { recursive: true });
      const audio = await acquire({
        url,
        workDir: work,
        tags,
        onProgress(event) {
          reportDownload({ phase: event.phase, percent: event.percent });
        },
      });
      reportDownload({ phase: 'save', percent: null });
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await placeNewFile(audio, destination);
      } catch (error) {
        if (error.code === 'EEXIST') return { error: 'A file with that name is already in the album folder', status: 409 };
        if (error.code === 'ENOSPC') return { error: 'The music drive is full', status: 507 };
        if (error.code === 'EROFS' || error.code === 'EACCES' || error.code === 'EPERM') {
          return { error: 'The music folder is not writable', status: 500 };
        }
        throw error;
      }
      const placed = await realpathOf(destination);
      const rootReal = await realpathOf(musicDir);
      if (!placed || !isInside(rootReal, placed)) {
        await unlink(destination).catch(() => {});
        return { error: 'The song would have been saved outside the music folder', status: 400 };
      }
      await includeDownloaded(destination);
      return { ok: true, title: tags.title, album: tags.album, path: toRel(musicDir, destination) };
    } catch (error) {
      console.warn(`download: ${error.message}`);
      if (error.code === 'ENOSPC') return { error: 'The music drive is full', status: 507 };
      return { error: error.message || 'The song could not be downloaded', status: 502 };
    } finally {
      if (!holdBusy) {
        downloadBusy = false;
        status.download = null;
      }
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function musicbrainzTags(album, slot, row) {
    const release = await releaseForDownload(album, slot, row);
    const expected = trackOnRelease(release, slot, row);
    const disc = expected?.disc || slot?.disc || 1;
    const onDisc = release?.tracks?.filter((item) => (item.disc || 1) === disc) || [];
    const discs = release?.tracks ? new Set(release.tracks.map((item) => item.disc || 1)).size : null;
    return {
      title: expected?.title || slot?.title || row.title,
      artist: expected?.artist || row.artist || album.artist,
      album: release && expected ? release.title : album.title,
      albumArtist: release && expected ? release.artist : album.artist,
      track: expected?.track || slot?.track || null,
      trackTotal: onDisc.length || null,
      disc,
      discTotal: discs,
      year: (release && expected ? release.year : album.year) || null,
      recordingMbid: expected?.recordingMbid || '',
      releaseMbid: release && expected ? release.releaseMbid || '' : '',
      releaseGroupMbid: release && expected ? release.releaseGroupMbid || '' : '',
      artistMbid: expected?.artistMbid || '',
      albumArtistMbid: release && expected ? release.albumArtistMbid || '' : '',
    };
  }

  async function releaseForDownload(album, slot, row) {
    const candidates = [];
    if (album.releaseMbid) {
      try {
        const fresh = await brain.resolve({
          releaseMbid: album.releaseMbid,
          title: album.title,
          artist: album.artist,
          fileCount: album.trackCount,
        });
        if (fresh?.releaseMbid) candidates.push(fresh);
      } catch (error) {
        console.warn(`musicbrainz download tags: ${error.message}`);
      }
      for (const entry of mbMap().values()) {
        if (entry?.release?.releaseMbid === album.releaseMbid) candidates.push(entry.release);
      }
    }
    return candidates.find((release) => trackOnRelease(release, slot, row)) || null;
  }

  function trackOnRelease(release, slot, row) {
    const tracks = release?.tracks || [];
    if (slot?.recordingMbid) {
      const byId = tracks.find((item) => item.recordingMbid === slot.recordingMbid);
      if (byId) return byId;
    }
    const title = foldTitle(slot?.title || row.title);
    return tracks.find((item) => foldTitle(item.title) === title) || null;
  }

  function artistScope(dir) {
    if (!dir || dir === '.') return '';
    const parent = path.posix.dirname(dir);
    return parent && parent !== '.' ? parent : dir;
  }

  function foldersForAlbum(id) {
    const album = albumsById.get(id);
    if (!album) return null;
    const scope = artistScope(albumFolder(album));
    return scope ? [scope] : [];
  }

  function foldersForArtist(id) {
    if (!artistsById.has(id)) return null;
    const scopes = new Set();
    for (const album of current.albums) {
      if (album.artistId !== id) continue;
      const scope = artistScope(albumFolder(album));
      if (scope) scopes.add(scope);
    }
    return [...scopes];
  }

  function albumFolder(album) {
    const counts = new Map();
    for (const track of current.tracks) {
      if (track.albumId !== album.id || !track.relPath?.includes('/')) continue;
      const dir = path.posix.dirname(track.relPath);
      counts.set(dir, (counts.get(dir) || 0) + 1);
    }
    let best = '';
    let count = 0;
    for (const [dir, total] of counts) {
      if (total > count) {
        best = dir;
        count = total;
      }
    }
    if (best && best !== '.') return best;
    return `${fileStem(album.artist) || 'Unknown artist'}/${fileStem(album.title) || 'Unknown album'}`;
  }

  async function includeDownloaded(full) {
    const track = await readTrack(full, musicDir, new Map());
    if (!track) throw new Error('The downloaded song could not be read');
    const files = current.tracks.filter((item) => item.relPath !== track.relPath);
    files.push(track);
    const catalog = catalogFrom(files);
    const previous = new Map(current.albums.map((item) => [item.id, item]));
    for (const next of catalog.albums) {
      const older = previous.get(next.id);
      if (!older?.hasArt) continue;
      next.hasArt = true;
      next.artExt = older.artExt;
      next.artVersion = older.artVersion;
    }
    await publish(files, catalog.albums);
  }

  function publishFind(row) {
    const album = row.albumId ? albumsById.get(row.albumId) : null;
    const match = album?.slots?.find((slot) => slot.link !== 'missing' && foldTitle(slot.title) === foldTitle(row.title));
    return {
      id: row.id,
      slotId: row.slotId,
      albumId: row.albumId,
      title: row.title,
      artist: row.artist,
      album: row.album || album?.title || '',
      addedAt: row.addedAt,
      links: row.links,
      status: row.status || '',
      inLibrary: Boolean(match),
      trackId: match?.fileId || match?.id || null,
    };
  }

  function setFavourite(kind, id, on) {
    if (!['song', 'album', 'artist'].includes(kind) || !/^[a-f0-9]{16}$/.test(id || '')) return null;
    const found = kind === 'song' ? tracksById.has(id) : kind === 'album' ? albumsById.has(id) : artistsById.has(id);
    if (!found) return null;
    if (on) database().star(kind, [id]);
    else database().unstar(kind, [id]);
    return { kind, id, starred: Boolean(on) };
  }

  function playable(id) {
    const track = tracksById.get(id);
    if (!track) return null;
    return {
      relPath: track.relPath,
      mime: AUDIO.get(track.ext) || 'application/octet-stream',
    };
  }

  async function trackDetails(id) {
    if (!/^[a-f0-9]{16}$/.test(id || '')) return null;
    const file = tracksById.get(id);
    if (file) return readDetails(file);
    for (const album of albumsById.values()) {
      const slot = album.slots?.find((item) => item.id === id);
      if (!slot) continue;
      return describeFile({
        place: slot.link === 'missing' ? 'Not in the library' : 'Music library',
        fallback: {
          title: slot.title,
          duration: slot.duration,
          format: slot.format,
        },
        metadata: {
          common: {
            title: slot.title,
            artist: slot.artist,
            album: album.title,
            albumartist: album.artist,
            year: album.year,
            track: slot.track ? { no: slot.track } : null,
            disk: slot.disc ? { no: slot.disc } : null,
            genre: slot.genre,
            musicbrainz_recordingid: slot.recordingMbid,
            musicbrainz_albumid: album.releaseMbid,
          },
        },
      });
    }
    return null;
  }

  async function readDetails(file) {
    const full = absFromRel(musicDir, file.relPath);
    if (!full) return null;
    let metadata = null;
    let info = null;
    try {
      info = await stat(full);
    } catch (error) {
      console.warn(`track info ${file.relPath}: ${error.message}`);
    }
    if (info) {
      try {
        metadata = await parseFile(full, { duration: true, skipCovers: true });
      } catch (error) {
        console.warn(`track info ${file.relPath}: ${error.message}`);
      }
    }
    return {
      ...describeFile({
        metadata,
        path: file.relPath,
        size: info?.size ?? file.size,
        modified: info?.mtime,
        fallback: file,
      }),
      id: file.id,
      deletable: true,
    };
  }

  async function deleteTrack(id) {
    if (scanPromise) return { error: 'A scan is already running', status: 409 };
    if (!/^[a-f0-9]{16}$/.test(id || '')) return null;
    const file = tracksById.get(id);
    if (!file) return null;
    const full = absFromRel(musicDir, file.relPath);
    if (!full) return { error: 'That song is not a library file', status: 400 };
    const root = await realpath(musicDir);
    let target = full;
    try {
      target = await realpath(full);
    } catch (error) {
      if (error.code !== 'ENOENT') return { error: 'That file could not be deleted', status: 500 };
    }
    const inside = isInside(root, target) || isInside(path.resolve(musicDir), path.resolve(target));
    if (!inside) return { error: 'That song is outside the music folder', status: 400 };
    try {
      const info = await stat(target);
      if (!info.isFile()) return { error: 'That song is not a file', status: 400 };
      await unlink(target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const denied = error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EROFS';
        return {
          error: denied ? 'That file could not be deleted' : (error.message || 'That file could not be deleted'),
          status: denied ? 403 : 500,
        };
      }
    }
    database().forgetSong(id);
    const files = database().loadFiles().filter((item) => item.id !== id);
    const catalog = catalogFrom(files);
    const previous = new Map(current.albums.map((album) => [album.id, album]));
    for (const album of catalog.albums) {
      const older = previous.get(album.id);
      if (!older?.hasArt) continue;
      album.hasArt = true;
      album.artExt = older.artExt;
      album.artVersion = older.artVersion;
    }
    const scannedAt = current.scannedAt || new Date().toISOString();
    database().replaceCatalog({ scannedAt, files, albums: catalog.albums });
    adopt(modelFrom(files, catalog.albums, scannedAt));
    return { ok: true, id, title: file.title };
  }

  async function importDownloads(files, readMetadata = parseFile) {
    if (scanPromise || downloadBusy) return { error: 'A scan is already running', status: 409 };
    if (!Array.isArray(files)) return { error: 'Nothing to import', status: 400 };
    downloadBusy = true;
    const moved = [];
    const skipped = [];
    const placed = [];
    try {
      for (const file of files) {
        const outcome = await importOneDownload(file, readMetadata);
        if (outcome.moved) {
          moved.push(outcome.moved);
          placed.push(outcome.full);
        } else if (outcome.skipped) skipped.push(outcome.skipped);
      }
      if (placed.length) await adoptImported(placed);
    } finally {
      downloadBusy = false;
    }
    return { moved, skipped };
  }

  async function importDownloadAlbum(files, albumTitle, readMetadata = parseFile, writeTags = updateFile) {
    if (scanPromise || downloadBusy) return { error: 'A scan is already running', status: 409 };
    const album = clean(albumTitle);
    if (!album || !fileStem(album)) return { error: 'This folder needs a name', status: 400 };
    if (!Array.isArray(files)) return { error: 'Nothing to import', status: 400 };
    downloadBusy = true;
    const moved = [];
    const skipped = [];
    const placed = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const outcome = await importOneCompilation(files[index], album, index + 1, files.length, readMetadata, writeTags);
        if (outcome.moved) {
          moved.push(outcome.moved);
          placed.push(outcome.full);
        } else if (outcome.skipped) skipped.push(outcome.skipped);
      }
      if (placed.length) await adoptImported(placed);
    } finally {
      downloadBusy = false;
    }
    return { album, artist: 'Various Artists', moved, skipped };
  }

  async function importOneDownload(file, readMetadata) {
    const name = file?.name || path.basename(String(file?.filePath || 'song'));
    const source = file?.filePath;
    if (!source) return { skipped: { name, reason: 'missing' } };
    const common = await readCommon(source, name, readMetadata);
    const artist = clean(common.albumartist) || clean(common.artist) || joinList(common.artists);
    const album = clean(common.album);
    if (!artist || !album) return { skipped: { name, reason: 'missing' } };
    const song = songName(name, common);
    if (!song.title || !fileStem(artist) || !fileStem(album) || !fileStem(song.title)) {
      return { skipped: { name, reason: 'missing' } };
    }
    const track = positiveInt(common.track?.no) || song.numbered;
    const relative = `${folderForImport(artist, album)}/${libraryFileName(track, song.title, song.ext)}`;
    const destination = absFromRel(musicDir, relative);
    if (!destination) return { skipped: { name, reason: 'path' } };
    const staged = await stageDownload(source, destination);
    if (!staged.ok) return { skipped: { name, reason: staged.reason } };
    const released = await releaseDownload(source, destination);
    if (released) return { skipped: { name, reason: released } };
    return {
      moved: { name, title: song.title, artist, album, path: toRel(musicDir, destination) },
      full: destination,
    };
  }

  async function importOneCompilation(file, album, trackNo, total, readMetadata, writeTags) {
    const name = file?.name || path.basename(String(file?.filePath || 'song'));
    const source = file?.filePath;
    if (!source) return { skipped: { name, reason: 'missing' } };
    const common = await readCommon(source, name, readMetadata);
    const song = songName(name, common);
    const artist = clean(common.artist) || joinList(common.artists) || clean(common.albumartist) || 'Unknown artist';
    if (!song.title || !fileStem(song.title) || !fileStem(artist)) return { skipped: { name, reason: 'missing' } };
    const relative = `${folderForImport('Various Artists', album)}/${libraryFileName(trackNo, song.title, song.ext)}`;
    const destination = absFromRel(musicDir, relative);
    if (!destination) return { skipped: { name, reason: 'path' } };
    const staged = await stageDownload(source, destination);
    if (!staged.ok) return { skipped: { name, reason: staged.reason } };
    try {
      await writeCompilationTags(destination, {
        title: song.title,
        artist,
        album,
        track: trackNo,
        total,
        year: yearOf(common.year),
        genre: joinList(common.genre),
      }, writeTags);
    } catch (error) {
      await unlink(destination).catch(() => {});
      console.warn(`album tags ${name}: ${error.message}`);
      return { skipped: { name, reason: 'tags' } };
    }
    const released = await releaseDownload(source, destination);
    if (released) return { skipped: { name, reason: released } };
    return {
      moved: { name, title: song.title, artist, album, path: toRel(musicDir, destination) },
      full: destination,
    };
  }

  function folderForImport(artist, album) {
    const wantedArtist = foldTitle(artist);
    const wantedAlbum = foldTitle(album);
    const match = current.albums.find((item) => foldTitle(item.artist) === wantedArtist && foldTitle(item.title) === wantedAlbum);
    if (match) return albumFolder(match);
    return `${fileStem(artist)}/${fileStem(album)}`;
  }

  async function readCommon(source, name, readMetadata) {
    try {
      const metadata = await readMetadata(source, { skipCovers: true, duration: false });
      return metadata?.common || {};
    } catch (error) {
      console.warn(`import ${name}: ${error.message}`);
      return {};
    }
  }

  async function stageDownload(source, destination) {
    try {
      const existing = await stat(destination);
      if (existing.isFile()) return { reason: 'already' };
    } catch (error) {
      if (error.code !== 'ENOENT') return { reason: 'failed' };
    }
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await placeNewFile(source, destination);
    } catch (error) {
      if (error.code === 'EEXIST') return { reason: 'already' };
      if (error.code === 'ENOSPC') return { reason: 'full' };
      throw error;
    }
    const stored = await realpathOf(destination);
    const rootReal = await realpathOf(musicDir);
    if (!stored || !isInside(rootReal, stored)) {
      await unlink(destination).catch(() => {});
      return { reason: 'path' };
    }
    return { ok: true };
  }

  async function releaseDownload(source, destination) {
    try {
      await unlink(source);
      return null;
    } catch (error) {
      await unlink(destination).catch(() => {});
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EROFS') return 'locked';
      throw error;
    }
  }

  async function adoptImported(paths) {
    const files = database().loadFiles();
    for (const full of paths) {
      const track = await readTrack(full, musicDir, new Map());
      if (track) files.push(track);
    }
    const catalog = catalogFrom(files);
    const previous = new Map(current.albums.map((album) => [album.id, album]));
    for (const album of catalog.albums) {
      const older = previous.get(album.id);
      if (!older?.hasArt) continue;
      album.hasArt = true;
      album.artExt = older.artExt;
      album.artVersion = older.artVersion;
    }
    await publish(files, catalog.albums);
  }

  async function art(albumId) {
    const album = albumsById.get(albumId);
    if (!album?.hasArt || !ART_MIME[album.artExt]) return null;
    const filePath = path.join(artDir, `${album.id}.${album.artExt}`);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return null;
      return { filePath, mime: ART_MIME[album.artExt], size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async function artistArt(artistId) {
    const artist = artistsById.get(artistId);
    if (!artist?.hasArt || !ART_MIME[artist.artExt]) return null;
    const filePath = path.join(artistArtDir, `${artist.id}.${artist.artExt}`);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return null;
      return { filePath, mime: ART_MIME[artist.artExt], size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async function runArtistPhotos(key, names) {
    status.photos = true;
    status.photosFound = current.artists.filter((artist) => artist.hasArt).length;
    status.error = null;
    status.detail = 'Looking up unchecked artists…';
    const fanart = createFanart({ key });
    let failures = 0;
    try {
      const queue = [];
      for (const row of names) {
        const name = String(row.name || '').trim();
        const artistId = String(row.artistId || '');
        if (!/^[a-f0-9]{16}$/.test(artistId)) continue;
        if (!name || isGenericArtist(name)) {
          database().saveArtistPhoto({ artistId, mbid: '', checked: true, hasArt: false });
          continue;
        }
        queue.push({ ...row, name, artistId });
      }
      status.total = queue.length;
      status.processed = 0;
      status.detail = queue.length ? `Checking 0 of ${queue.length} unchecked artists` : null;
      for (const row of queue) {
        status.processed += 1;
        status.detail = `Checking ${status.processed} of ${queue.length} unchecked artists`;
        const { name, artistId } = row;
        let mbid = '';
        try {
          mbid = await artistMbid(row.relPath);
        } catch (error) {
          console.warn(`artist tags ${name}: ${error.message}`);
        }
        if (!mbid) {
          database().saveArtistPhoto({ artistId, mbid: '', checked: true, hasArt: false });
          continue;
        }
        try {
          const image = await fanart.artistImage(mbid);
          failures = 0;
          if (image) await storeArtistArt(artistId, mbid, image);
          else database().saveArtistPhoto({ artistId, mbid, checked: true, hasArt: false });
        } catch (error) {
          failures += 1;
          const wait = Number(error.retryAfter) || 0;
          console.warn(`artist photo ${name}: ${error.message}`);
          if (wait) await delay(Math.min(wait, 20) * 1000);
          if (failures >= 8) {
            status.error = 'Fanart is not responding. Photos already saved stay available.';
            break;
          }
          continue;
        }
        await delay(120);
      }
    } catch (error) {
      status.error = error.message || 'Artist photos failed';
      console.error(`artist photos failed: ${status.error}`);
    } finally {
      status.photos = false;
      status.detail = null;
      scanPromise = null;
    }
  }

  async function artistMbid(relPath) {
    const full = absFromRel(musicDir, relPath);
    if (!full) return '';
    const metadata = await parseFile(full, { skipCovers: true, duration: false });
    const common = metadata.common || {};
    return uuidOf(firstValue(common.musicbrainz_albumartistid) || firstValue(common.musicbrainz_artistid));
  }

  async function storeArtistArt(artistId, mbid, image) {
    await mkdir(artistArtDir, { recursive: true });
    for (const ext of ART_EXT) {
      if (ext === image.ext) continue;
      await unlink(path.join(artistArtDir, `${artistId}.${ext}`)).catch(() => {});
    }
    const dest = path.join(artistArtDir, `${artistId}.${image.ext}`);
    await writeFile(dest, image.bytes);
    const info = await stat(dest);
    const version = Math.round(info.mtimeMs);
    database().saveArtistPhoto({ artistId, mbid, checked: true, hasArt: true, ext: image.ext, version });
    const artist = artistsById.get(artistId);
    if (artist) {
      artist.hasArt = true;
      artist.artExt = image.ext;
      artist.artVersion = version;
    }
    status.photosFound += 1;
  }

  function publishTrack(track) {
    const album = albumsById.get(track.albumId);
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      albumArtist: track.albumArtist,
      album: track.album,
      albumId: track.albumId,
      artistId: track.artistId,
      year: track.year,
      track: track.track,
      disc: track.disc,
      duration: track.duration,
      genre: track.genre,
      format: track.format,
      missing: track.link === 'missing',
      linked: track.link === 'linked',
      sourceAlbum: track.sourceAlbum || null,
      playable: track.link !== 'missing',
      hasArt: Boolean(album?.hasArt),
      artVersion: album?.artVersion ?? null,
    };
  }

  function snapshot() {
    return current;
  }

  function folder(id) {
    const node = id ? foldersById.get(id) : folderRoot;
    if (!node || (id && node === folderRoot)) return null;
    const sets = marks();
    return {
      id: node.id,
      name: node.name,
      trackCount: node.count,
      crumbs: folderCrumbs(node),
      folders: [...node.children.values()].sort(byFolderName).map((child) => ({
        id: child.id,
        name: child.name,
        trackCount: child.count,
        coverAlbumId: folderCover(child),
      })),
      tracks: node.tracks.map((track) => withStar(publishTrack(track), 'song', sets)),
    };
  }

  function folderTracks(id) {
    const node = id ? foldersById.get(id) : folderRoot;
    if (!node || (id && node === folderRoot)) return null;
    const sets = marks();
    const tracks = [];
    collectFolderTracks(node, tracks);
    return tracks.map((track) => withStar(publishTrack(track), 'song', sets));
  }

  function browseFolder(id) {
    const node = !id || id === '1' ? folderRoot : foldersById.get(id);
    if (!node) return null;
    const here = node === folderRoot ? '1' : node.id;
    return {
      id: here,
      name: node.name,
      parentId: node === folderRoot ? null : (node.parentId || '1'),
      folders: [...node.children.values()].sort(byFolderName).map((child) => ({
        id: child.id,
        name: child.name,
        coverArt: folderCover(child),
      })),
      tracks: node.tracks,
    };
  }

  function folderCrumbs(node) {
    const crumbs = [];
    let current = node;
    while (current && current !== folderRoot) {
      crumbs.push({ id: current.id, name: current.name });
      current = current.parent || null;
    }
    return crumbs.reverse();
  }

  function folderCover(node) {
    const album = node.albumId ? albumsById.get(node.albumId) : null;
    return album?.hasArt ? album.id : null;
  }

  function trackById(id) {
    const track = tracksById.get(id);
    if (!track) return null;
    return withStar(publishTrack(track), 'song', marks());
  }

  function tracksFor(ids) {
    const sets = marks();
    return ids.map((id) => {
      const track = tracksById.get(id);
      return track ? withStar(publishTrack(track), 'song', sets) : null;
    }).filter(Boolean);
  }

  function marks() {
    return database().taste().stars;
  }

  function withStar(item, kind, sets) {
    return { ...item, starred: sets[kind].has(item.id) };
  }

  return {
    load,
    rescan,
    matchAlbums,
    findArtistPhotos,
    getStatus,
    listAlbums,
    getAlbum,
    mergeCandidates,
    mergeAlbums,
    separateAlbum,
    listArtists,
    getArtist,
    listTracks,
    search,
    playable,
    trackDetails,
    deleteTrack,
    importDownloads,
    importDownloadAlbum,
    art,
    artistArt,
    musicDir,
    snapshot,
    trackById,
    tracksFor,
    favourites,
    setFavourite,
    listFinds,
    addToFindList,
    searchFind,
    searchAllFinds,
    addFindLink,
    previewPlaylist,
    downloadPlaylistTrack,
    downloadFind,
    removeFind,
    folder,
    folderTracks,
    browseFolder,
    store: database,
  };
}

export function prepareDataDir(dataDir) {
  return mkdir(path.join(dataDir, 'art'), { recursive: true });
}

export function dropPrivileges(dataDir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const uid = idFromEnv('PUID', 1000);
  const gid = idFromEnv('PGID', 1000);
  const result = spawnSync('chown', ['-R', `${uid}:${gid}`, dataDir], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('Could not set ownership on the data folder');
  }
  if (uid === 0) {
    console.warn('PUID is 0, so berrytone is staying root');
    return;
  }
  process.setgid(gid);
  process.setuid(uid);
  console.log(`running as uid ${uid}, gid ${gid}`);
}

function songName(name, common) {
  const ext = path.extname(name).toLowerCase() || '.mp3';
  const base = path.basename(name, path.extname(name));
  const numbered = /^(\d{1,3})[\s.\-]+(.*)$/.exec(base.trim());
  const title = clean(common.title) || clean(numbered?.[2]) || clean(base);
  return { ext, title, numbered: numbered ? positiveInt(Number(numbered[1])) : null };
}

async function writeCompilationTags(destination, tags, writeTags) {
  const patch = {
    title: tags.title,
    artist: tags.artist,
    albumartist: 'Various Artists',
    album: tags.album,
    compilation: true,
    releasetype: 'compilation',
    track: { no: tags.track, of: tags.total },
    disk: { no: 1 },
    musicbrainz_albumid: null,
    musicbrainz_releasegroupid: null,
    musicbrainz_albumartistid: null,
  };
  if (tags.year) patch.year = tags.year;
  if (tags.genre) patch.genre = tags.genre;
  try {
    await writeTags(destination, patch);
  } catch (error) {
    if (!oldTagError(error)) throw error;
    await writeTags(destination, patch, { replaceId3: true });
  }
}

function oldTagError(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return /ID3v2\.4|ID3 version|ID3 tag flags|extended headers/.test(message);
}

async function placeNewFile(source, destination) {
  const input = await open(source, 'r');
  let output;
  try {
    output = await open(destination, 'wx');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, position);
        if (!bytesWritten) throw new Error('The song could not be saved');
        offset += bytesWritten;
        position += bytesWritten;
      }
    }
  } catch (error) {
    if (output) await unlink(destination).catch(() => {});
    throw error;
  } finally {
    await input.close();
    await output?.close();
  }
}

async function walk(dir, rootReal, files, seen = new Set()) {
  async function visit(current) {
    let real;
    try {
      real = await realpathOf(current);
    } catch {
      return;
    }
    if (!isInside(rootReal, real) || seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const full = path.join(current, entry.name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await visit(full);
      } else if (info.isFile() && AUDIO.has(path.extname(entry.name).toLowerCase())) {
        let fileReal;
        try {
          fileReal = await realpathOf(full);
        } catch {
          continue;
        }
        if (!isInside(rootReal, fileReal)) continue;
        files.push(full);
      }
    }
  }
  await visit(dir);
}

async function readTrack(full, root, previous) {
  const rel = toRel(root, full);
  if (!rel) return null;
  let info;
  try {
    info = await stat(full);
  } catch {
    return null;
  }
  const ext = path.extname(full).toLowerCase();
  const mtimeMs = Math.round(info.mtimeMs);
  const cached = previous.get(rel);
  if (cached && cached.size === info.size && cached.mtimeMs === mtimeMs && cached.ext === ext) {
    return { ...cached, format: cached.format || ext.slice(1).toUpperCase(), fresh: false };
  }
  let common = {};
  let duration = null;
  let tagError = false;
  try {
    const metadata = await parseFile(full, { duration: true, skipCovers: true });
    common = metadata.common || {};
    if (Number.isFinite(metadata.format?.duration)) duration = metadata.format.duration;
  } catch (error) {
    console.warn(`unreadable tags ${rel}: ${error.message}`);
    tagError = true;
  }
  const identity = identityFrom(rel, common, duration);
  return {
    ...identity,
    id: hash('track', rel),
    relPath: rel,
    ext,
    format: ext.slice(1).toUpperCase(),
    size: info.size,
    mtimeMs,
    fresh: true,
    tagError,
  };
}

function identityFrom(rel, common, duration) {
  const parts = rel.split('/');
  const filename = parts[parts.length - 1] || 'Untitled';
  const base = filename.replace(/\.[^.]+$/, '');
  const folderAlbum = parts.length >= 2 ? clean(parts[parts.length - 2]) : '';
  const folderArtist = parts.length >= 3 ? clean(parts[parts.length - 3]) : '';
  const artist = clean(common.artist) || joinList(common.artists) || folderArtist || 'Unknown artist';
  const albumArtist = clean(common.albumartist) || folderArtist || artist;
  const album = clean(common.album) || folderAlbum || 'Unknown album';
  const numbered = /^(\d{1,3})[\s.\-]+(.*)$/.exec(base.trim());
  const title = clean(common.title) || clean(numbered?.[2]) || clean(base) || 'Untitled';
  const dateYear = /^(\d{4})/.exec(String(common.date || common.releasedate || ''));
  return {
    title,
    artist,
    albumArtist,
    album,
    year: yearOf(common.year) || yearOf(common.originalyear) || (dateYear ? yearOf(Number(dateYear[1])) : null),
    track: positiveInt(common.track?.no) || (numbered ? positiveInt(Number(numbered[1])) : null),
    disc: positiveInt(common.disk?.no),
    duration: roundedDuration(duration),
    genre: joinList(common.genre) || null,
    format: null,
    recordingMbid: mbid(common.musicbrainz_recordingid),
    releaseMbid: mbid(common.musicbrainz_albumid),
    releaseGroupMbid: mbid(common.musicbrainz_releasegroupid),
    tagAlbum: album,
    tagAlbumArtist: albumArtist,
  };
}

function roundedDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const rounded = Math.round(duration * 10) / 10;
  return rounded > 0 ? rounded : null;
}

function mbid(value) {
  const text = String(value || '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text) ? text : null;
}

async function findFolderImage(root, relDir) {
  const found = await folderImageIn(root, relDir);
  if (found || !relDir || relDir === '.') return found;
  return folderImageIn(root, path.posix.dirname(relDir));
}

async function folderImageIn(root, relDir) {
  if (!relDir || relDir === '.') return null;
  const abs = absFromRel(root, relDir);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const ext = IMAGE_EXT.get(path.extname(entry.name).toLowerCase());
    if (!ext) continue;
    const stem = path.basename(entry.name, path.extname(entry.name)).toLowerCase().replace(/[\s_-]+/g, '');
    if (!COVER_RANK.has(stem)) continue;
    const rank = COVER_RANK.get(stem);
    if (!best || rank < best.rank) best = { rank, ext, abs: path.join(abs, entry.name) };
  }
  if (!best) return null;
  try {
    const info = await stat(best.abs);
    if (!info.isFile() || info.size <= 0 || info.size > 20 * 1024 * 1024) return null;
  } catch {
    return null;
  }
  return best;
}

function dominantDir(tracks) {
  const counts = new Map();
  for (const track of tracks) {
    const dir = path.posix.dirname(track.relPath);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best = '.';
  let count = -1;
  for (const [dir, total] of counts) {
    if (total > count) {
      best = dir;
      count = total;
    }
  }
  return best;
}

function extForMime(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('png')) return 'png';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  return 'jpg';
}

function publishAlbum(album) {
  return {
    id: album.id,
    title: album.title,
    artist: album.artist,
    artistId: album.artistId,
    year: album.year,
    trackCount: album.trackCount,
    foundCount: album.foundCount ?? album.trackCount,
    missingCount: album.missingCount || 0,
    linkedCount: album.linkedCount || 0,
    source: album.source || 'local',
    edition: album.edition || null,
    merged: album.merged || [],
    duration: album.duration,
    hasArt: Boolean(album.hasArt),
    artVersion: album.artVersion ?? null,
  };
}

function publishArtist(artist) {
  return {
    id: artist.id,
    name: artist.name,
    albumCount: artist.albumCount,
    trackCount: artist.trackCount,
    hasArt: Boolean(artist.hasArt),
    artVersion: artist.artVersion ?? null,
  };
}

function isWatchPage(url) {
  if (!safeYouTubeUrl(url)) return false;
  try {
    return new URL(url).pathname === '/watch';
  } catch {
    return false;
  }
}

function libraryFileName(trackNumber, title, ext = '.mp3') {
  const number = Number.isInteger(trackNumber) && trackNumber > 0 ? `${String(trackNumber).padStart(2, '0')} ` : '';
  const suffix = String(ext || '.mp3').toLowerCase();
  return `${number}${fileStem(title) || 'track'}${suffix.startsWith('.') ? suffix : `.${suffix}`}`;
}

function fileStem(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
}

function firstValue(value) {
  if (Array.isArray(value)) return value.find(Boolean) || '';
  return value || '';
}

function uuidOf(value) {
  const text = String(value || '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text) ? text : '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyModel() {
  return { version: 1, scannedAt: null, tracks: [], albums: [], artists: [] };
}

function emptyFolder() {
  return { id: null, name: 'Music', parent: null, parentId: null, children: new Map(), tracks: [], count: 0, albumId: null, mixed: false };
}

function indexFolders(tracks) {
  const root = emptyFolder();
  const byId = new Map();
  for (const track of tracks) {
    const parts = track.relPath.split('/');
    let node = root;
    let rel = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      rel = rel ? `${rel}/${name}` : name;
      let child = node.children.get(name);
      if (!child) {
        child = {
          id: hash('folder', rel),
          name,
          parent: node,
          parentId: node.id,
          children: new Map(),
          tracks: [],
          count: 0,
          albumId: null,
          mixed: false,
        };
        node.children.set(name, child);
        byId.set(child.id, child);
      }
      node = child;
    }
    node.tracks.push(track);
    let cursor = node;
    while (cursor) {
      cursor.count += 1;
      if (!cursor.mixed) {
        if (!cursor.albumId) cursor.albumId = track.albumId;
        else if (cursor.albumId !== track.albumId) {
          cursor.albumId = null;
          cursor.mixed = true;
        }
      }
      cursor = cursor.parent;
    }
  }
  sortFolder(root);
  return { root, byId };
}

function sortFolder(node) {
  node.tracks.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: 'base' }));
  for (const child of node.children.values()) sortFolder(child);
}

function byFolderName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function collectFolderTracks(node, tracks) {
  tracks.push(...node.tracks);
  for (const child of [...node.children.values()].sort(byFolderName)) collectFolderTracks(child, tracks);
}

function albumLikeness(left, right) {
  const a = foldTitle(left).replace(/ /g, '');
  const b = foldTitle(right).replace(/ /g, '');
  if (!a || !b) return 0;
  if (a === b) return 100;
  const words = new Set(foldTitle(left).split(' ').filter((word) => word.length > 2));
  return foldTitle(right).split(' ').filter((word) => words.has(word)).length;
}

function modelFrom(files, albums, scannedAt) {
  return {
    version: 1,
    scannedAt,
    tracks: files,
    albums,
    artists: artistsFrom(files),
  };
}

function artistsFrom(files) {
  const buckets = new Map();
  for (const file of files) {
    if (!file.artistId) continue;
    let bucket = buckets.get(file.artistId);
    if (!bucket) {
      bucket = { id: file.artistId, names: [], albums: new Set(), trackCount: 0 };
      buckets.set(file.artistId, bucket);
    }
    bucket.names.push(file.albumArtist);
    bucket.albums.add(file.albumId);
    bucket.trackCount += 1;
  }
  return [...buckets.values()].map((bucket) => ({
    id: bucket.id,
    name: mostCommon(bucket.names),
    albumCount: bucket.albums.size,
    trackCount: bucket.trackCount,
  }));
}

function isSafeTrack(track) {
  return Boolean(
    track &&
      hexId(track.id) &&
      hexId(track.albumId) &&
      hexId(track.artistId) &&
      typeof track.relPath === 'string' &&
      safeRel(track.relPath) &&
      typeof track.title === 'string',
  );
}

function isSafeAlbum(album) {
  return Boolean(album && hexId(album.id) && hexId(album.artistId) && typeof album.title === 'string');
}

function isSafeArtist(artist) {
  return Boolean(artist && hexId(artist.id) && typeof artist.name === 'string');
}

function hexId(value) {
  return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
}

function safeRel(rel) {
  if (!rel || rel.includes('\0')) return false;
  const parts = rel.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

export function absFromRel(root, rel) {
  if (!safeRel(rel)) return null;
  return path.join(root, ...rel.split('/'));
}

function toRel(root, full) {
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const normalized = rel.split(path.sep).join('/');
  return safeRel(normalized) ? normalized : null;
}

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function realpathOf(target) {
  return realpath(target);
}

function hash(...parts) {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function clean(value) {
  if (value == null) return '';
  return String(value).replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function joinList(value) {
  if (Array.isArray(value)) return clean(value.slice(0, 4).join(', '));
  return clean(value);
}

function normKey(value) {
  return clean(value).toLocaleLowerCase();
}

function fold(value) {
  return normKey(value).normalize('NFD').replace(/\p{M}/gu, '');
}

function weighted(value, extra) {
  return value > 0 ? value + extra : 0;
}

function score(text, needle) {
  const value = fold(text);
  if (!value || !needle) return 0;
  if (value === needle) return 100;
  if (value.startsWith(needle)) return 80;
  if (value.includes(needle)) return 50;
  return 0;
}

function rank(items, scoreOf) {
  return items
    .map((item) => ({ item, score: scoreOf(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || cmpText(a.item.title || a.item.name, b.item.title || b.item.name))
    .map((entry) => entry.item);
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best = values[0];
  let count = 0;
  for (const [value, total] of counts) {
    if (total > count) {
      best = value;
      count = total;
    }
  }
  return best;
}

function albumYear(tracks) {
  const counts = new Map();
  for (const track of tracks) {
    if (track.year) counts.set(track.year, (counts.get(track.year) || 0) + 1);
  }
  let best = null;
  let count = 0;
  for (const [year, total] of counts) {
    if (total > count || (total === count && year > best)) {
      best = year;
      count = total;
    }
  }
  return best;
}

function sumDuration(tracks) {
  let total = 0;
  let known = false;
  for (const track of tracks) {
    if (Number.isFinite(track.duration)) {
      total += track.duration;
      known = true;
    }
  }
  return known ? Math.round(total * 10) / 10 : null;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 && value < 10000 ? value : null;
}

function yearOf(value) {
  return Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : null;
}

function cmpText(a, b) {
  return collator.compare(a || '', b || '');
}

function cmpNum(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function compareTracks(a, b) {
  return (
    cmpText(a.albumArtist, b.albumArtist) ||
    cmpText(a.album, b.album) ||
    cmpNum(a.disc, b.disc) ||
    cmpNum(a.track, b.track) ||
    cmpText(a.title, b.title) ||
    cmpText(a.relPath, b.relPath)
  );
}

function compareAlbumTracks(a, b) {
  return cmpNum(a.disc, b.disc) || cmpNum(a.track, b.track) || cmpText(a.title, b.title) || cmpText(a.relPath, b.relPath);
}

function compareAlbums(a, b) {
  return cmpText(a.artist, b.artist) || cmpYearDesc(a.year, b.year) || cmpText(a.title, b.title);
}

function cmpYearDesc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function idFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`${name} must be an integer from 0 to 65535`);
  }
  return number;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  if (items.length === 0) return out;
  async function run() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, run));
  return out;
}

