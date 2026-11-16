import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  rel_path TEXT UNIQUE NOT NULL,
  ext TEXT,
  format TEXT,
  size INTEGER,
  mtime_ms INTEGER,
  title TEXT,
  artist TEXT,
  album TEXT,
  album_artist TEXT,
  tag_album TEXT,
  tag_album_artist TEXT,
  album_id TEXT,
  artist_id TEXT,
  year INTEGER,
  track_no INTEGER,
  disc_no INTEGER,
  duration REAL,
  genre TEXT,
  recording_mbid TEXT,
  release_mbid TEXT,
  release_group_mbid TEXT
);
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  title TEXT,
  artist TEXT,
  artist_id TEXT,
  year INTEGER,
  release_mbid TEXT,
  source TEXT,
  track_count INTEGER,
  found_count INTEGER,
  missing_count INTEGER,
  linked_count INTEGER,
  duration REAL,
  has_art INTEGER,
  art_ext TEXT,
  art_version INTEGER
);
CREATE TABLE IF NOT EXISTS slots (
  album_id TEXT,
  position INTEGER,
  id TEXT,
  file_id TEXT,
  title TEXT,
  artist TEXT,
  track_no INTEGER,
  disc_no INTEGER,
  duration REAL,
  format TEXT,
  genre TEXT,
  link TEXT,
  source_album TEXT,
  recording_mbid TEXT
);
CREATE TABLE IF NOT EXISTS mb_cache (
  key TEXT PRIMARY KEY,
  matched INTEGER NOT NULL,
  payload TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cover_attempts (
  album_id TEXT PRIMARY KEY,
  checked_at TEXT
);
CREATE TABLE IF NOT EXISTS album_merges (
  from_artist TEXT NOT NULL,
  from_title TEXT NOT NULL,
  into_artist TEXT NOT NULL,
  into_title TEXT NOT NULL,
  PRIMARY KEY (from_artist, from_title)
);
CREATE TABLE IF NOT EXISTS stars (
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  starred_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
CREATE TABLE IF NOT EXISTS ratings (
  item_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plays (
  item_id TEXT PRIMARY KEY,
  play_count INTEGER NOT NULL,
  last_played TEXT
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  song_id TEXT NOT NULL,
  PRIMARY KEY (playlist_id, position)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  user_id TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_seal TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS features (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artist_photos (
  artist_id TEXT PRIMARY KEY,
  mbid TEXT,
  checked INTEGER NOT NULL,
  has_art INTEGER NOT NULL,
  ext TEXT,
  version INTEGER
);
CREATE TABLE IF NOT EXISTS finds (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL UNIQUE,
  album_id TEXT,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS find_links (
  find_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (find_id, position)
);
`;

export function openLibraryDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'library.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all();
  if (!sessionColumns.some((column) => column.name === 'user_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT');
  }
  const findColumns = db.prepare('PRAGMA table_info(finds)').all();
  if (findColumns.length && !findColumns.some((column) => column.name === 'status')) {
    db.exec('ALTER TABLE finds ADD COLUMN status TEXT');
  }
  const linkColumns = db.prepare('PRAGMA table_info(find_links)').all();
  if (linkColumns.length && !linkColumns.some((column) => column.name === 'source')) {
    db.exec('ALTER TABLE find_links ADD COLUMN source TEXT');
  }
  return {
    loadCache() {
      const entries = new Map();
      for (const row of db.prepare('SELECT key, matched, payload FROM mb_cache').all()) {
        entries.set(row.key, {
          matched: Boolean(row.matched),
          release: row.matched && row.payload ? JSON.parse(row.payload) : null,
        });
      }
      return entries;
    },
    readCache(key) {
      const row = db.prepare('SELECT matched, payload FROM mb_cache WHERE key = ?').get(key);
      if (!row) return null;
      return {
        matched: Boolean(row.matched),
        release: row.matched ? JSON.parse(row.payload) : null,
      };
    },
    writeCache(key, matched, release) {
      db.prepare(
        `INSERT INTO mb_cache (key, matched, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET matched = excluded.matched, payload = excluded.payload, updated_at = excluded.updated_at`,
      ).run(key, matched ? 1 : 0, release ? JSON.stringify(release) : null, new Date().toISOString());
    },
    coverChecked(albumId) {
      return Boolean(db.prepare('SELECT album_id FROM cover_attempts WHERE album_id = ?').get(albumId));
    },
    markCoverChecked(albumId) {
      db.prepare(
        `INSERT INTO cover_attempts (album_id, checked_at) VALUES (?, ?)
         ON CONFLICT(album_id) DO UPDATE SET checked_at = excluded.checked_at`,
      ).run(albumId, new Date().toISOString());
    },
    albumMerges() {
      return db.prepare('SELECT from_artist, from_title, into_artist, into_title FROM album_merges').all().map((row) => ({
        fromArtist: row.from_artist,
        fromTitle: row.from_title,
        intoArtist: row.into_artist,
        intoTitle: row.into_title,
      }));
    },
    addAlbumMerge({ fromArtist, fromTitle, intoArtist, intoTitle }) {
      db.prepare(
        `INSERT INTO album_merges (from_artist, from_title, into_artist, into_title) VALUES (?, ?, ?, ?)
         ON CONFLICT(from_artist, from_title) DO UPDATE SET into_artist = excluded.into_artist, into_title = excluded.into_title`,
      ).run(fromArtist, fromTitle, intoArtist, intoTitle);
      db.prepare(
        `UPDATE album_merges SET into_artist = ?, into_title = ?
         WHERE into_artist = ? AND into_title = ? AND NOT (from_artist = ? AND from_title = ?)`,
      ).run(intoArtist, intoTitle, fromArtist, fromTitle, fromArtist, fromTitle);
    },
    removeAlbumMerge({ fromArtist, fromTitle }) {
      db.prepare('DELETE FROM album_merges WHERE from_artist = ? AND from_title = ?').run(fromArtist, fromTitle);
    },
    replaceCatalog({ scannedAt, files, albums }) {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM slots');
        db.exec('DELETE FROM albums');
        db.exec('DELETE FROM files');
        const insertFile = db.prepare(
          `INSERT INTO files (
            id, rel_path, ext, format, size, mtime_ms, title, artist, album, album_artist, tag_album, tag_album_artist, album_id, artist_id,
            year, track_no, disc_no, duration, genre, recording_mbid, release_mbid, release_group_mbid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const file of files) {
          insertFile.run(
            file.id,
            file.relPath,
            file.ext,
            file.format,
            file.size,
            file.mtimeMs,
            file.title,
            file.artist,
            file.album,
            file.albumArtist,
            file.tagAlbum || file.album,
            file.tagAlbumArtist || file.albumArtist,
            file.albumId,
            file.artistId,
            file.year,
            file.track,
            file.disc,
            file.duration,
            file.genre,
            file.recordingMbid,
            file.releaseMbid,
            file.releaseGroupMbid,
          );
        }
        const insertAlbum = db.prepare(
          `INSERT INTO albums (
            id, title, artist, artist_id, year, release_mbid, source, track_count, found_count, missing_count,
            linked_count, duration, has_art, art_ext, art_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertSlot = db.prepare(
          `INSERT INTO slots (
            album_id, position, id, file_id, title, artist, track_no, disc_no, duration, format, genre, link, source_album, recording_mbid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const album of albums) {
          insertAlbum.run(
            album.id,
            album.title,
            album.artist,
            album.artistId,
            album.year,
            album.releaseMbid,
            album.source,
            album.trackCount,
            album.foundCount,
            album.missingCount,
            album.linkedCount,
            album.duration,
            album.hasArt ? 1 : 0,
            album.artExt || null,
            album.artVersion || null,
          );
          album.slots.forEach((slot, position) => {
            insertSlot.run(
              album.id,
              position,
              slot.id,
              slot.fileId,
              slot.title,
              slot.artist,
              slot.track,
              slot.disc,
              slot.duration,
              slot.format,
              slot.genre,
              slot.link,
              slot.sourceAlbum,
              slot.recordingMbid,
            );
          });
        }
        db.prepare(
          `INSERT INTO meta (key, value) VALUES ('scanned_at', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(scannedAt);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    loadFiles() {
      return db.prepare('SELECT * FROM files').all().map(fileFromRow);
    },
    loadCatalog() {
      const scannedAt = db.prepare(`SELECT value FROM meta WHERE key = 'scanned_at'`).get()?.value || null;
      const albums = db.prepare('SELECT * FROM albums').all().map((row) => ({
        id: row.id,
        title: row.title,
        artist: row.artist,
        artistId: row.artist_id,
        year: row.year,
        releaseMbid: row.release_mbid,
        source: row.source,
        trackCount: row.track_count,
        foundCount: row.found_count,
        missingCount: row.missing_count,
        linkedCount: row.linked_count,
        duration: row.duration,
        hasArt: Boolean(row.has_art),
        artExt: row.art_ext,
        artVersion: row.art_version,
        slots: [],
      }));
      const byId = new Map(albums.map((album) => [album.id, album]));
      for (const row of db.prepare('SELECT * FROM slots ORDER BY album_id, position').all()) {
        const album = byId.get(row.album_id);
        if (!album) continue;
        album.slots.push({
          id: row.id,
          fileId: row.file_id,
          title: row.title,
          artist: row.artist,
          track: row.track_no,
          disc: row.disc_no,
          duration: row.duration,
          format: row.format,
          genre: row.genre,
          link: row.link,
          sourceAlbum: row.source_album,
          recordingMbid: row.recording_mbid,
        });
      }
      return { scannedAt, albums };
    },
    taste() {
      const stars = { song: new Map(), album: new Map(), artist: new Map() };
      for (const row of db.prepare('SELECT kind, item_id, starred_at FROM stars').all()) {
        stars[row.kind]?.set(row.item_id, row.starred_at);
      }
      const ratings = new Map();
      for (const row of db.prepare('SELECT item_id, rating FROM ratings').all()) ratings.set(row.item_id, row.rating);
      const plays = new Map();
      for (const row of db.prepare('SELECT item_id, play_count, last_played FROM plays').all()) {
        plays.set(row.item_id, { count: row.play_count, lastPlayed: row.last_played });
      }
      return { stars, ratings, plays };
    },
    star(kind, ids) {
      if (kind !== 'song' && kind !== 'album' && kind !== 'artist') return;
      const now = new Date().toISOString();
      const stmt = db.prepare(
        `INSERT INTO stars (kind, item_id, starred_at) VALUES (?, ?, ?)
         ON CONFLICT(kind, item_id) DO UPDATE SET starred_at = excluded.starred_at`,
      );
      change(() => {
        for (const id of ids) stmt.run(kind, id, now);
      });
    },
    unstar(kind, ids) {
      const stmt = db.prepare('DELETE FROM stars WHERE kind = ? AND item_id = ?');
      change(() => {
        for (const id of ids) stmt.run(kind, id);
      });
    },
    setRating(id, rating) {
      if (!rating) db.prepare('DELETE FROM ratings WHERE item_id = ?').run(id);
      else {
        db.prepare(
          `INSERT INTO ratings (item_id, rating) VALUES (?, ?)
           ON CONFLICT(item_id) DO UPDATE SET rating = excluded.rating`,
        ).run(id, rating);
      }
    },
    scrobble(id, when) {
      const played = when || new Date().toISOString();
      db.prepare(
        `INSERT INTO plays (item_id, play_count, last_played) VALUES (?, 1, ?)
         ON CONFLICT(item_id) DO UPDATE SET play_count = play_count + 1, last_played = excluded.last_played`,
      ).run(id, played);
    },
    listPlaylists() {
      return db.prepare('SELECT * FROM playlists ORDER BY name COLLATE NOCASE, id').all().map(playlistFromRow);
    },
    getPlaylist(id) {
      const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
      if (!row) return null;
      return { ...playlistFromRow(row), songIds: songIds(id) };
    },
    createPlaylist(name, songIdsToAdd) {
      const id = randomBytes(8).toString('hex');
      const now = new Date().toISOString();
      change(() => {
        db.prepare('INSERT INTO playlists (id, name, comment, created_at, changed_at) VALUES (?, ?, ?, ?, ?)').run(id, name, '', now, now);
        writeSongs(id, songIdsToAdd);
      });
      return this.getPlaylist(id);
    },
    updatePlaylist(id, { name, removeIndexes = [], addIds = [] } = {}) {
      const existing = db.prepare('SELECT id FROM playlists WHERE id = ?').get(id);
      if (!existing) return null;
      const songs = songIds(id);
      const indexes = [...new Set(removeIndexes.map((value) => Number(value)))]
        .filter((value) => Number.isInteger(value) && value >= 0 && value < songs.length)
        .sort((a, b) => b - a);
      for (const index of indexes) songs.splice(index, 1);
      songs.push(...addIds);
      change(() => {
        if (name) db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, id);
        writeSongs(id, songs);
      });
      return this.getPlaylist(id);
    },
    deletePlaylist(id) {
      const existing = db.prepare('SELECT id FROM playlists WHERE id = ?').get(id);
      if (!existing) return false;
      change(() => {
        db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(id);
        db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
      });
      return true;
    },
    createSession(expiresAt, userId = null) {
      const id = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      db.prepare('INSERT INTO sessions (id, expires_at, user_id) VALUES (?, ?, ?)').run(id, expiresAt, userId);
      return id;
    },
    validSession(id) {
      return Boolean(this.sessionRow(id));
    },
    sessionUser(id) {
      return this.sessionRow(id)?.user_id || null;
    },
    sessionRow(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
      const row = db.prepare('SELECT expires_at, user_id FROM sessions WHERE id = ?').get(id);
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        return null;
      }
      return row;
    },
    deleteSession(id) {
      if (typeof id !== 'string') return;
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    },
    userCount() {
      return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    },
    adminCount() {
      return db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`).get().count;
    },
    listUsers() {
      return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY username COLLATE NOCASE').all();
    },
    userById(id) {
      return db.prepare('SELECT id, username, password_hash, password_seal, role, created_at FROM users WHERE id = ?').get(id) || null;
    },
    userByName(username) {
      return db.prepare('SELECT id, username, password_hash, password_seal, role, created_at FROM users WHERE username = ? COLLATE NOCASE').get(username) || null;
    },
    insertUser(user) {
      db.prepare(
        'INSERT INTO users (id, username, password_hash, password_seal, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(user.id, user.username, user.passwordHash, user.passwordSeal, user.role, user.createdAt);
    },
    updateUser(id, fields) {
      if (fields.passwordHash) {
        db.prepare('UPDATE users SET password_hash = ?, password_seal = ? WHERE id = ?').run(fields.passwordHash, fields.passwordSeal, id);
      }
      if (fields.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(fields.role, id);
    },
    deleteUser(id) {
      this.deleteSessions(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },
    deleteSessions(userId) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    },
    featureRows() {
      return db.prepare('SELECT key, enabled FROM features').all();
    },
    ensureFeature(key, enabled) {
      db.prepare('INSERT OR IGNORE INTO features (key, enabled) VALUES (?, ?)').run(key, enabled ? 1 : 0);
    },
    setFeature(key, enabled) {
      db.prepare('UPDATE features SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, key);
    },
    getSetting(key) {
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
    },
    uncheckedArtists() {
      return db.prepare(`
        SELECT f.artist_id AS artistId, MIN(f.album_artist) AS name, MIN(f.rel_path) AS relPath
        FROM files f
        LEFT JOIN artist_photos p ON p.artist_id = f.artist_id AND p.checked = 1
        WHERE f.artist_id IS NOT NULL AND f.artist_id != '' AND p.artist_id IS NULL
        GROUP BY f.artist_id
        ORDER BY name
      `).all();
    },
    artistPhotoMap() {
      const photos = new Map();
      for (const row of db.prepare('SELECT artist_id, mbid, checked, has_art, ext, version FROM artist_photos').all()) {
        photos.set(row.artist_id, {
          mbid: row.mbid || '',
          checked: Boolean(row.checked),
          hasArt: Boolean(row.has_art),
          ext: row.ext || null,
          version: row.version || null,
        });
      }
      return photos;
    },
    saveArtistPhoto(photo) {
      db.prepare(
        `INSERT INTO artist_photos (artist_id, mbid, checked, has_art, ext, version) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(artist_id) DO UPDATE SET
           mbid = excluded.mbid, checked = excluded.checked, has_art = excluded.has_art, ext = excluded.ext, version = excluded.version`,
      ).run(photo.artistId, photo.mbid || null, photo.checked ? 1 : 0, photo.hasArt ? 1 : 0, photo.ext || null, photo.version || null);
    },
    setSetting(key, value) {
      if (!value) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        return;
      }
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    listFinds() {
      const links = new Map();
      for (const row of db.prepare('SELECT find_id, url, label FROM find_links ORDER BY position').all()) {
        const list = links.get(row.find_id) || [];
        list.push({ url: row.url, label: row.label || '' });
        links.set(row.find_id, list);
      }
      return db.prepare('SELECT * FROM finds ORDER BY added_at, id').all().map((row) => findFromRow(row, links.get(row.id) || []));
    },
    getFind(id) {
      const row = db.prepare('SELECT * FROM finds WHERE id = ?').get(id);
      if (!row) return null;
      const links = db.prepare('SELECT url, label FROM find_links WHERE find_id = ? ORDER BY position').all(id);
      return findFromRow(row, links.map((link) => ({ url: link.url, label: link.label || '' })));
    },
    findBySlot(slotId) {
      const row = db.prepare('SELECT id FROM finds WHERE slot_id = ?').get(slotId);
      return row ? this.getFind(row.id) : null;
    },
    addFind({ slotId, albumId, title, artist, album }) {
      const existing = db.prepare('SELECT id FROM finds WHERE slot_id = ?').get(slotId);
      if (existing) return existing.id;
      const id = randomBytes(8).toString('hex');
      db.prepare(
        'INSERT INTO finds (id, slot_id, album_id, title, artist, album, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, slotId, albumId || '', title, artist || '', album || '', new Date().toISOString());
      return id;
    },
    setFindStatus(id, status) {
      const existing = db.prepare('SELECT id FROM finds WHERE id = ?').get(id);
      if (!existing) return false;
      db.prepare('UPDATE finds SET status = ? WHERE id = ?').run(status || null, id);
      return true;
    },
    addFindLink(id, url, label = '') {
      const existing = db.prepare('SELECT id FROM finds WHERE id = ?').get(id);
      if (!existing) return false;
      const duplicate = db.prepare('SELECT url FROM find_links WHERE find_id = ? AND url = ?').get(id, url);
      if (duplicate) return true;
      const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM find_links WHERE find_id = ?').get(id).next;
      db.prepare(
        'INSERT INTO find_links (find_id, position, url, label, source) VALUES (?, ?, ?, ?, ?)',
      ).run(id, position, url, label || 'Your link', 'custom');
      return true;
    },
    replaceFindLinks(id, links) {
      const existing = db.prepare('SELECT id FROM finds WHERE id = ?').get(id);
      if (!existing) return false;
      change(() => {
        db.prepare("DELETE FROM find_links WHERE find_id = ? AND (source IS NULL OR source != 'custom')").run(id);
        const kept = new Set(db.prepare('SELECT url FROM find_links WHERE find_id = ?').all(id).map((row) => row.url));
        const insert = db.prepare('INSERT INTO find_links (find_id, position, url, label, source) VALUES (?, ?, ?, ?, ?)');
        let position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM find_links WHERE find_id = ?').get(id).next;
        for (const link of links) {
          if (!link?.url || kept.has(link.url)) continue;
          insert.run(id, position, link.url, link.label || '', 'search');
          position += 1;
        }
      });
      return true;
    },
    deleteFind(id) {
      const existing = db.prepare('SELECT id FROM finds WHERE id = ?').get(id);
      if (!existing) return false;
      change(() => {
        db.prepare('DELETE FROM find_links WHERE find_id = ?').run(id);
        db.prepare('DELETE FROM finds WHERE id = ?').run(id);
      });
      return true;
    },
    forgetSong(id) {
      change(() => {
        const finds = db.prepare('SELECT id FROM finds WHERE slot_id = ?').all(id);
        for (const row of finds) {
          db.prepare('DELETE FROM find_links WHERE find_id = ?').run(row.id);
          db.prepare('DELETE FROM finds WHERE id = ?').run(row.id);
        }
        db.prepare('DELETE FROM playlist_songs WHERE song_id = ?').run(id);
        db.prepare('DELETE FROM stars WHERE kind = ? AND item_id = ?').run('song', id);
        db.prepare('DELETE FROM ratings WHERE item_id = ?').run(id);
        db.prepare('DELETE FROM plays WHERE item_id = ?').run(id);
      });
    },
  };

  function songIds(id) {
    return db.prepare('SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position').all(id).map((row) => row.song_id);
  }

  function writeSongs(id, ids) {
    db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(id);
    const insert = db.prepare('INSERT INTO playlist_songs (playlist_id, position, song_id) VALUES (?, ?, ?)');
    ids.forEach((songId, position) => insert.run(id, position, songId));
    db.prepare('UPDATE playlists SET changed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  function change(work) {
    db.exec('BEGIN');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function findFromRow(row, links) {
  return {
    id: row.id,
    slotId: row.slot_id,
    albumId: row.album_id || '',
    title: row.title,
    artist: row.artist || '',
    album: row.album || '',
    addedAt: row.added_at,
    status: row.status || '',
    links,
  };
}

function playlistFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    comment: row.comment || '',
    createdAt: row.created_at,
    changedAt: row.changed_at,
  };
}

function fileFromRow(row) {
  return {
    id: row.id,
    relPath: row.rel_path,
    ext: row.ext,
    format: row.format,
    size: row.size,
    mtimeMs: row.mtime_ms,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.album_artist,
    tagAlbum: row.tag_album || row.album,
    tagAlbumArtist: row.tag_album_artist || row.album_artist,
    albumId: row.album_id,
    artistId: row.artist_id,
    year: row.year,
    track: row.track_no,
    disc: row.disc_no,
    duration: row.duration,
    genre: row.genre,
    recordingMbid: row.recording_mbid,
    releaseMbid: row.release_mbid,
    releaseGroupMbid: row.release_group_mbid,
  };
}
