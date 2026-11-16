import { createHash, timingSafeEqual } from 'node:crypto';

const VERSION = '1.16.1';
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

export function subsonic({ library, params, action, authUser, authPassword, accounts = null }) {
  action = String(action || '').toLowerCase();
  const actor = resolveActor(params, action, authUser, authPassword, accounts);
  if (!actor) return xml(failed(40, 'Wrong username or password'));
  const body = dispatch(action, library, params, actor);
  if (body == null) return xml(failed(70, `Method ${action} is not available`));
  if (typeof body === 'string') return xml(body);
  return body;
}

export function playlistViews(library) {
  const store = library.store();
  return {
    list() {
      return store.listPlaylists().map((playlist) => summarize(library, { ...playlist, songIds: store.getPlaylist(playlist.id).songIds }));
    },
    get(id) {
      const playlist = store.getPlaylist(id);
      if (!playlist) return null;
      const tracks = library.tracksFor(playlist.songIds);
      return { ...summarize(library, playlist), tracks };
    },
    create(name, trackIds) {
      const title = cleanName(name);
      if (!title) return { error: 'Give the playlist a name' };
      const songIds = knownSongs(library, trackIds);
      if (!songIds.length) return { error: 'Add at least one playable song' };
      const playlist = store.createPlaylist(title, songIds);
      return this.get(playlist.id);
    },
    remove(id) {
      return store.deletePlaylist(id);
    },
  };
}

const ACTION_FEATURE = {
  getmusicfolders: 'folders',
  getindexes: 'folders',
  getmusicdirectory: 'folders',
  getartists: 'artists',
  getartist: 'artists',
  getalbum: 'albums',
  getalbumlist2: 'albums',
  getsong: 'play',
  getrandomsongs: 'albums',
  search3: 'play',
  getgenres: 'albums',
  getcoverart: 'play',
  stream: 'play',
  download: 'play',
  getplaylists: 'playlists',
  getplaylist: 'playlists',
  createplaylist: 'playlists',
  updateplaylist: 'playlists',
  deleteplaylist: 'playlists',
  star: 'favourites',
  unstar: 'favourites',
  getstarred2: 'favourites',
  setrating: 'albums',
  scrobble: 'albums',
};

function dispatch(action, library, params, actor) {
  const catalog = library.snapshot();
  const files = new Map(catalog.tracks.map((track) => [track.id, track]));
  const albums = new Map(catalog.albums.map((album) => [album.id, album]));
  const artists = new Map(catalog.artists.map((artist) => [artist.id, artist]));
  const taste = library.store().taste();
  const ctx = {
    library,
    catalog,
    files,
    albums,
    artists,
    taste,
    params,
    features: actor.features,
    owner: actor.username || params.get('u') || 'berrytone',
  };
  if (!featureAllowed(ctx, ACTION_FEATURE[action])) return denied(action);
  const routes = {
    ping: () => '',
    getlicenses: () => tag('license', { valid: 'true', email: 'berrytone@localhost', licenseExpires: 'never' }),
    getopensubsonicextensions: () => tag('openSubsonicExtensions'),
    getmusicfolders: () => tag('musicFolders', {}, tag('musicFolder', { id: '1', name: 'Music' })),
    getindexes: () => indexes(ctx),
    getmusicdirectory: () => directory(ctx),
    getartists: () => artistsIndex(ctx),
    getartist: () => artistView(ctx),
    getalbum: () => albumView(ctx),
    getalbumlist2: () => albumList(ctx),
    getsong: () => songView(ctx),
    getrandomsongs: () => randomSongs(ctx),
    search3: () => search(ctx),
    getgenres: () => genres(ctx),
    getcoverart: () => cover(ctx),
    stream: () => media(ctx),
    download: () => media(ctx),
    getplaylists: () => playlists(ctx),
    getplaylist: () => playlist(ctx),
    createplaylist: () => createPlaylist(ctx),
    updateplaylist: () => updatePlaylist(ctx),
    deleteplaylist: () => deletePlaylist(ctx),
    star: () => setStar(ctx, true),
    unstar: () => setStar(ctx, false),
    getstarred2: () => starred(ctx),
    setrating: () => rating(ctx),
    scrobble: () => scrobble(ctx),
    getsimilarsongs2: () => tag('similarSongs2'),
    getlyricsbysongid: () => tag('lyricsList'),
    getpodcasts: () => tag('podcasts'),
    getnewestpodcasts: () => tag('newestPodcasts'),
    deletepodcastepisode: () => '',
    getinternetradiostations: () => tag('internetRadioStations'),
  };
  return routes[action] ? routes[action]() : null;
}

function resolveActor(params, action, authUser, authPassword, accounts) {
  if (accounts?.enabled()) {
    if (action === 'ping' && !params.get('u')) return { username: '', role: 'admin', features: null };
    return accounts.fromSubsonic(params);
  }
  if (action !== 'ping' && !credentialsMatch(params, authUser, authPassword)) return null;
  if (action === 'ping' && params.get('u') && !credentialsMatch(params, authUser, authPassword)) return null;
  return { username: params.get('u') || authUser || 'berrytone', role: 'admin', features: null };
}

function featureAllowed(ctx, feature) {
  if (!feature || !ctx.features) return true;
  if (feature === 'play') return ctx.features.albums || ctx.features.tracks || ctx.features.folders || ctx.features.playlists || ctx.features.favourites;
  return Boolean(ctx.features[feature]);
}

function denied(action) {
  const empty = {
    getmusicfolders: tag('musicFolders'),
    getindexes: tag('indexes'),
    getartists: tag('artists'),
    getalbumlist2: tag('albumList2'),
    getplaylists: tag('playlists'),
    getstarred2: tag('starred2'),
    search3: tag('searchResult3'),
    getrandomsongs: tag('randomSongs'),
    getgenres: tag('genres'),
  };
  return empty[action] || failed(50, 'That feature is turned off');
}

function credentialsMatch(params, authUser, authPassword) {
  if (!authUser || !authPassword) return true;
  if ((params.get('u') || '') !== authUser) return false;
  const token = params.get('t');
  const salt = params.get('s');
  if (token && salt != null) {
    const expected = createHash('md5').update(`${authPassword}${salt}`).digest('hex');
    return safeEqual(token.toLowerCase(), expected);
  }
  if (params.get('p') == null) return false;
  return safeEqual(decodePassword(params.get('p')), authPassword);
}

function decodePassword(value) {
  if (value.startsWith('enc:')) {
    const hex = value.slice(4);
    if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) return '';
    return Buffer.from(hex, 'hex').toString('utf8');
  }
  return value;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function indexes(ctx) {
  const musicFolderId = ctx.params.get('musicFolderId');
  if (musicFolderId && musicFolderId !== '1') return tag('indexes', { lastModified: modified(ctx) });
  const listing = ctx.library.browseFolder('1');
  const groups = new Map();
  for (const folder of listing.folders) {
    const letter = indexLetter(folder.name);
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(folder);
  }
  const children = [...groups.entries()]
    .sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a < b ? -1 : 1))
    .map(([letter, list]) => tag('index', { name: letter }, list.map((folder) => tag('artist', { id: folder.id, name: folder.name })).join('')));
  return tag('indexes', { lastModified: modified(ctx) }, children.join(''));
}

function artistsIndex(ctx) {
  const groups = groupArtists(ctx.catalog.artists);
  const children = [...groups.entries()].map(([letter, list]) =>
    tag('index', { name: letter }, list.map((artist) => artistTag(ctx, artist)).join('')),
  );
  return tag('artists', {}, children.join(''));
}

function artistView(ctx) {
  const artist = ctx.artists.get(paramsId(ctx));
  if (!artist) return failed(70, 'Artist not found');
  const albums = ctx.catalog.albums
    .filter((album) => album.artistId === artist.id)
    .sort(byTitle)
    .map((album) => albumTag(ctx, album))
    .join('');
  return tag('artist', artistAttrs(ctx, artist), albums);
}

function albumView(ctx) {
  const album = ctx.albums.get(paramsId(ctx));
  if (!album) return failed(70, 'Album not found');
  const songs = albumSongs(album, ctx.files).map((song) => songTag(ctx, song, 'song')).join('');
  return tag('album', albumAttrs(ctx, album), songs);
}

function albumList(ctx) {
  const type = ctx.params.get('type') || 'newest';
  const size = count(ctx.params, 'size', 10, 500);
  const offset = count(ctx.params, 'offset', 0, 100_000);
  let albums = ctx.catalog.albums.slice();
  if (type === 'alphabeticalByName') albums.sort(byTitle);
  else if (type === 'alphabeticalByArtist') albums.sort((a, b) => cmp(a.artist, b.artist) || byTitle(a, b));
  else if (type === 'recent') albums.sort((a, b) => (playedAt(ctx, b) - playedAt(ctx, a)) || (createdAt(b, ctx.files) - createdAt(a, ctx.files)));
  else if (type === 'frequent') albums.sort((a, b) => playCount(ctx, b) - playCount(ctx, a) || byTitle(a, b));
  else if (type === 'starred') albums = albums.filter((album) => ctx.taste.stars.album.has(album.id)).sort(byTitle);
  else if (type === 'random') albums = shuffle(albums);
  else if (type === 'byGenre') {
    const genre = fold(ctx.params.get('genre'));
    albums = albums.filter((album) => albumSongs(album, ctx.files).some((song) => fold(song.file.genre) === genre)).sort(byTitle);
  } else if (type === 'byYear') {
    const from = Number(ctx.params.get('fromYear'));
    const to = Number(ctx.params.get('toYear'));
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    albums = albums.filter((album) => album.year >= low && album.year <= high).sort((a, b) => (to >= from ? b.year - a.year : a.year - b.year));
  } else albums.sort((a, b) => createdAt(b, ctx.files) - createdAt(a, ctx.files) || byTitle(a, b));
  return tag('albumList2', {}, albums.slice(offset, offset + size).map((album) => albumTag(ctx, album)).join(''));
}

function songView(ctx) {
  const song = songFromId(ctx, paramsId(ctx));
  if (!song) return failed(70, 'Song not found');
  return songTag(ctx, song, 'song');
}

function randomSongs(ctx) {
  const size = count(ctx.params, 'size', 10, 500);
  const genre = fold(ctx.params.get('genre'));
  let songs = ctx.catalog.tracks.filter((file) => !genre || fold(file.genre) === genre);
  songs = shuffle(songs).slice(0, size);
  return tag('randomSongs', {}, songs.map((file) => songTag(ctx, songFromFile(ctx, file), 'song')).join(''));
}

function search(ctx) {
  const query = fold(ctx.params.get('query')).slice(0, 200);
  const artistCount = count(ctx.params, 'artistCount', 20, 500);
  const artistOffset = count(ctx.params, 'artistOffset', 0, 100_000);
  const albumCount = count(ctx.params, 'albumCount', 20, 500);
  const albumOffset = count(ctx.params, 'albumOffset', 0, 100_000);
  const songCount = count(ctx.params, 'songCount', 20, 500);
  const songOffset = count(ctx.params, 'songOffset', 0, 1_000_000);
  const allowArtists = !ctx.features || ctx.features.artists !== false;
  const allowAlbums = !ctx.features || ctx.features.albums !== false;
  const allowSongs = !ctx.features || ctx.features.albums || ctx.features.tracks || ctx.features.folders || ctx.features.playlists;
  const artists = allowArtists && query
    ? ctx.catalog.artists.filter((artist) => fold(artist.name).includes(query))
    : [];
  const albums = allowAlbums && query
    ? ctx.catalog.albums.filter((album) => fold(album.title).includes(query) || fold(album.artist).includes(query))
    : [];
  const tracks = allowSongs
    ? (query ? ctx.catalog.tracks.filter((file) => fold(file.title).includes(query) || fold(file.artist).includes(query) || fold(file.album).includes(query)) : ctx.catalog.tracks.slice().sort((a, b) => (a.id < b.id ? -1 : 1)))
    : [];
  const body = [
    artists.slice(artistOffset, artistOffset + artistCount).map((artist) => artistTag(ctx, artist)).join(''),
    albums.slice(albumOffset, albumOffset + albumCount).map((album) => albumTag(ctx, album)).join(''),
    tracks.slice(songOffset, songOffset + songCount).map((file) => songTag(ctx, songFromFile(ctx, file), 'song')).join(''),
  ].join('');
  return tag('searchResult3', {}, body);
}

function genres(ctx) {
  const songs = new Map();
  const albums = new Map();
  for (const file of ctx.catalog.tracks) {
    const name = (file.genre || '').trim();
    if (!name) continue;
    songs.set(name, (songs.get(name) || 0) + 1);
  }
  for (const album of ctx.catalog.albums) {
    const names = new Set(albumSongs(album, ctx.files).map((song) => (song.file.genre || '').trim()).filter(Boolean));
    for (const name of names) albums.set(name, (albums.get(name) || 0) + 1);
  }
  const body = [...songs.keys()].sort((a, b) => cmp(a, b)).map((name) =>
    tag('genre', { songCount: songs.get(name) || 0, albumCount: albums.get(name) || 0 }, esc(name)),
  ).join('');
  return tag('genres', {}, body);
}

function cover(ctx) {
  const id = paramsId(ctx);
  const album = ctx.albums.get(id);
  if (album?.hasArt) return { art: album.id };
  const file = ctx.files.get(id);
  const parent = file ? ctx.albums.get(file.albumId) : null;
  if (parent?.hasArt) return { art: parent.id };
  return { missingArt: true };
}

function media(ctx) {
  const id = paramsId(ctx);
  if (!ctx.files.has(id)) return { missingMedia: true };
  return { stream: id };
}

function playlists(ctx) {
  const body = ctx.library.store().listPlaylists().map((playlist) => {
    const full = ctx.library.store().getPlaylist(playlist.id);
    return playlistTag(ctx, full);
  }).join('');
  return tag('playlists', {}, body);
}

function playlist(ctx) {
  const full = ctx.library.store().getPlaylist(paramsId(ctx));
  if (!full) return failed(70, 'Playlist not found');
  return playlistTag(ctx, full, true);
}

function createPlaylist(ctx) {
  const name = cleanName(ctx.params.get('name'));
  if (!name) return failed(10, 'Missing playlist name');
  const songIds = knownSongs(ctx.library, ctx.params.getAll('songId'));
  const created = ctx.library.store().createPlaylist(name, songIds);
  return playlistTag(ctx, created, true);
}

function updatePlaylist(ctx) {
  const id = ctx.params.get('playlistId') || paramsId(ctx);
  const name = cleanName(ctx.params.get('name'));
  const updated = ctx.library.store().updatePlaylist(id, {
    name,
    removeIndexes: ctx.params.getAll('songIndexToRemove'),
    addIds: knownSongs(ctx.library, ctx.params.getAll('songIdToAdd')),
  });
  if (!updated) return failed(70, 'Playlist not found');
  return '';
}

function deletePlaylist(ctx) {
  if (!ctx.library.store().deletePlaylist(paramsId(ctx))) return failed(70, 'Playlist not found');
  return '';
}

function setStar(ctx, on) {
  const store = ctx.library.store();
  const songs = ctx.params.getAll('id').filter((id) => ctx.files.has(id));
  const albums = ctx.params.getAll('albumId').filter((id) => ctx.albums.has(id));
  const artists = ctx.params.getAll('artistId').filter((id) => ctx.artists.has(id));
  if (on) {
    store.star('song', songs);
    store.star('album', albums);
    store.star('artist', artists);
  } else {
    store.unstar('song', songs);
    store.unstar('album', albums);
    store.unstar('artist', artists);
  }
  return '';
}

function starred(ctx) {
  const fresh = ctx.library.store().taste();
  ctx.taste = fresh;
  const songs = [...fresh.stars.song.keys()].map((id) => songFromId(ctx, id)).filter(Boolean).map((song) => songTag(ctx, song, 'song'));
  const albums = [...fresh.stars.album.keys()].map((id) => ctx.albums.get(id)).filter(Boolean).map((album) => albumTag(ctx, album));
  const artists = [...fresh.stars.artist.keys()].map((id) => ctx.artists.get(id)).filter(Boolean).map((artist) => artistTag(ctx, artist));
  return tag('starred2', {}, `${artists.join('')}${albums.join('')}${songs.join('')}`);
}

function rating(ctx) {
  const id = paramsId(ctx);
  const value = Number(ctx.params.get('rating'));
  if (!ctx.files.has(id) && !ctx.albums.has(id) && !ctx.artists.has(id)) return failed(70, 'Item not found');
  if (!Number.isInteger(value) || value < 0 || value > 5) return failed(10, 'Rating must be from 0 to 5');
  ctx.library.store().setRating(id, value);
  return '';
}

function scrobble(ctx) {
  const id = paramsId(ctx);
  if (!ctx.files.has(id)) return failed(70, 'Song not found');
  if (ctx.params.get('submission') === 'false') return '';
  const time = Number(ctx.params.get('time'));
  const when = Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : new Date().toISOString();
  ctx.library.store().scrobble(id, when);
  return '';
}

function directory(ctx) {
  const id = paramsId(ctx);
  const listing = ctx.library.browseFolder(id || '1');
  if (listing && (!id || id === '1' || listing.id === id)) {
    const folders = listing.folders.map((folder) => tag('child', {
      id: folder.id,
      parent: listing.id,
      isDir: 'true',
      title: folder.name,
      artist: folder.name,
      coverArt: folder.coverArt,
    })).join('');
    const songs = listing.tracks.map((file) => songTag(ctx, songFromFile(ctx, file), 'child', listing.id)).join('');
    return tag('directory', { id: listing.id, parent: listing.parentId, name: listing.name }, `${folders}${songs}`);
  }
  const artist = ctx.artists.get(id);
  if (artist) {
    const children = ctx.catalog.albums
      .filter((album) => album.artistId === artist.id)
      .sort(byTitle)
      .map((album) => directoryAlbum(ctx, album))
      .join('');
    return tag('directory', { id: artist.id, parent: '1', name: artist.name }, children);
  }
  const album = ctx.albums.get(id);
  if (album) {
    const children = albumSongs(album, ctx.files).map((song) => songTag(ctx, song, 'child')).join('');
    return tag('directory', { id: album.id, parent: album.artistId, name: album.title }, children);
  }
  return failed(70, 'Directory not found');
}

function directoryAlbum(ctx, album) {
  return tag('child', {
    id: album.id,
    parent: album.artistId,
    isDir: 'true',
    title: album.title,
    album: album.title,
    artist: album.artist,
    coverArt: album.hasArt ? album.id : null,
    year: album.year || null,
  });
}

function artistTag(ctx, artist) {
  return tag('artist', artistAttrs(ctx, artist));
}

function artistAttrs(ctx, artist) {
  return {
    id: artist.id,
    name: artist.name,
    albumCount: artist.albumCount,
    coverArt: artistCover(ctx, artist),
    starred: ctx.taste.stars.artist.get(artist.id) || null,
    userRating: ctx.taste.ratings.get(artist.id) || null,
  };
}

function artistCover(ctx, artist) {
  const album = ctx.catalog.albums.find((item) => item.artistId === artist.id && item.hasArt);
  return album ? album.id : null;
}

function albumTag(ctx, album) {
  return tag('album', albumAttrs(ctx, album));
}

function albumAttrs(ctx, album) {
  const songs = albumSongs(album, ctx.files);
  const created = createdAt(album, ctx.files);
  return {
    id: album.id,
    name: album.title,
    artist: album.artist,
    artistId: album.artistId,
    coverArt: album.hasArt ? album.id : null,
    songCount: songs.length,
    duration: songs.reduce((sum, song) => sum + seconds(song.slot.duration ?? song.file.duration), 0),
    year: album.year || null,
    created: created ? new Date(created).toISOString() : null,
    starred: ctx.taste.stars.album.get(album.id) || null,
    userRating: ctx.taste.ratings.get(album.id) || null,
  };
}

function songTag(ctx, song, element, parentId) {
  const { file, slot, album } = song;
  const sameArtist = fold(file.artist) === fold(file.albumArtist);
  const duration = seconds(slot?.duration ?? file.duration);
  const bitrate = duration > 0 && file.size ? Math.max(1, Math.round((file.size * 8) / duration / 1000)) : null;
  return tag(element, {
    id: file.id,
    parent: parentId || album?.id || file.albumId,
    isDir: 'false',
    title: slot?.title || file.title,
    album: album?.title || file.album,
    artist: slot?.artist || file.artist,
    track: slot?.track || file.track || null,
    year: file.year || album?.year || null,
    genre: file.genre || null,
    coverArt: album?.hasArt ? album.id : null,
    size: file.size || null,
    contentType: AUDIO.get(file.ext) || 'application/octet-stream',
    suffix: String(file.ext || '').replace(/^\./, ''),
    duration,
    bitRate: bitrate,
    path: file.relPath,
    albumId: album?.id || file.albumId,
    artistId: sameArtist ? file.artistId : null,
    type: 'music',
    discNumber: slot?.disc || file.disc || null,
    created: file.mtimeMs ? new Date(file.mtimeMs).toISOString() : null,
    starred: ctx.taste.stars.song.get(file.id) || null,
    userRating: ctx.taste.ratings.get(file.id) || null,
  });
}

function playlistTag(ctx, playlist, withSongs = false) {
  const songs = playlist.songIds.map((id) => songFromId(ctx, id)).filter(Boolean);
  const coverArt = songs.find((song) => song.album?.hasArt)?.album.id || null;
  const attrs = {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment || null,
    owner: ctx.owner,
    public: 'true',
    songCount: songs.length,
    duration: songs.reduce((sum, song) => sum + seconds(song.file.duration), 0),
    created: playlist.createdAt,
    changed: playlist.changedAt,
    coverArt,
  };
  const children = withSongs ? songs.map((song) => songTag(ctx, song, 'entry')).join('') : '';
  return tag('playlist', attrs, children);
}

function songFromId(ctx, id) {
  const file = ctx.files.get(id);
  return file ? songFromFile(ctx, file) : null;
}

function songFromFile(ctx, file) {
  const album = ctx.albums.get(file.albumId) || null;
  const slot = album?.slots?.find((item) => item.fileId === file.id && item.link !== 'missing') || null;
  return { file, album, slot };
}

function albumSongs(album, files) {
  const slots = album.slots?.length ? album.slots : [];
  const songs = [];
  for (const slot of slots) {
    if (slot.link === 'missing' || !slot.fileId) continue;
    const file = files.get(slot.fileId);
    if (!file) continue;
    songs.push({ slot, file, album });
  }
  if (songs.length || slots.length) return songs;
  return [...files.values()].filter((file) => file.albumId === album.id).map((file) => ({ file, album, slot: null }));
}

function createdAt(album, files) {
  let latest = 0;
  for (const song of albumSongs(album, files)) latest = Math.max(latest, song.file.mtimeMs || 0);
  return latest;
}

function playedAt(ctx, album) {
  let latest = 0;
  for (const song of albumSongs(album, ctx.files)) {
    const played = Date.parse(ctx.taste.plays.get(song.file.id)?.lastPlayed || '');
    if (Number.isFinite(played)) latest = Math.max(latest, played);
  }
  return latest;
}

function playCount(ctx, album) {
  let total = 0;
  for (const song of albumSongs(album, ctx.files)) total += ctx.taste.plays.get(song.file.id)?.count || 0;
  return total;
}

function summarize(library, playlist) {
  const tracks = library.tracksFor(playlist.songIds);
  const cover = tracks.find((track) => track.hasArt);
  return {
    id: playlist.id,
    name: playlist.name,
    songCount: tracks.length,
    duration: tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0),
    coverAlbumId: cover?.albumId || null,
    hasArt: Boolean(cover),
    artVersion: cover?.artVersion ?? null,
  };
}

function knownSongs(library, ids) {
  const songs = [];
  for (const id of ids || []) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) continue;
    if (!library.trackById(id)) continue;
    songs.push(id);
    if (songs.length >= 2000) break;
  }
  return songs;
}

function groupArtists(artists) {
  const groups = new Map();
  for (const artist of artists) {
    const letter = indexLetter(artist.name);
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(artist);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a < b ? -1 : 1)));
}

function indexLetter(name) {
  const folded = String(name || '').normalize('NFD').replace(/\p{M}/gu, '').trim();
  const letter = folded.charAt(0).toUpperCase();
  return letter >= 'A' && letter <= 'Z' ? letter : '#';
}

function modified(ctx) {
  const scanned = Date.parse(ctx.library.getStatus().scannedAt || '');
  return Number.isFinite(scanned) ? scanned : 0;
}

function paramsId(ctx) {
  return ctx.params.get('id') || '';
}

function count(params, name, fallback, max) {
  const raw = params.get(name);
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function seconds(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

function fold(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function cmp(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
}

function byTitle(a, b) {
  return cmp(a.title, b.title);
}

function shuffle(items) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function xml(body) {
  return { body: `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="${body.startsWith('<error ') ? 'failed' : 'ok'}" version="${VERSION}" type="berrytone" serverVersion="1.0.0">${body}</subsonic-response>` };
}

function failed(code, message) {
  return tag('error', { code, message });
}

function tag(name, attrs = {}, children = null) {
  const body = Object.entries(attrs)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => ` ${key}="${esc(value)}"`)
    .join('');
  if (children == null || children === '') return `<${name}${body}/>`;
  return `<${name}${body}>${children}</${name}>`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
