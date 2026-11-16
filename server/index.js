import { createReadStream } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createAccounts } from './accounts.js';
import { createDownloads } from './downloads.js';
import { createSonos, lanAddress } from './sonos.js';
import { absFromRel, createLibrary, dropPrivileges, prepareDataDir } from './library.js';
import { playlistViews, subsonic } from './subsonic.js';
import { createLimiter, readCookie, safeNext, SESSION_COOKIE, SESSION_SECONDS, sessionCookie } from './login.js';

const gzipAsync = promisify(gzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const musicDir = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, '..', 'music'));
const downloadsDir = process.env.DOWNLOADS_DIR ? path.resolve(process.env.DOWNLOADS_DIR) : '';
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const concurrency = Math.max(1, Number(process.env.SCAN_CONCURRENCY || 3) || 3);

const authUser = process.env.BERRYTONE_USER || '';
const authPassword = process.env.BERRYTONE_PASSWORD || '';
const loginLimiter = createLimiter();
let accounts = null;

function authOn() {
  return Boolean(accounts?.enabled());
}

const STATIC = {
  '/styles.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/login.js': 'text/javascript; charset=utf-8',
  '/favicon.svg': 'image/svg+xml',
  '/manifest.webmanifest': 'application/manifest+json',
  '/fonts/plus-jakarta-sans-latin.woff2': 'font/woff2',
  '/fonts/plus-jakarta-sans-latin-ext.woff2': 'font/woff2',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

const CSP =
  "default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer from 1 to 65535');
  process.exit(1);
}

if ((authUser || authPassword) && !(authUser && authPassword)) {
  console.warn('Set both BERRYTONE_USER and BERRYTONE_PASSWORD to require a login. Starting without one.');
}

const library = createLibrary({ musicDir, dataDir, concurrency });
const downloads = createDownloads(downloadsDir);
const speakers = createSonos({ resolve: resolveSonos, advertise: () => lanAddress() });

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      sendJson(req, res, 500, { error: 'Something went wrong' }).catch(() => res.destroy());
    } else {
      res.destroy();
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 10_000;
server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

await main();

async function main() {
  try {
    await prepareDataDir(dataDir);
    dropPrivileges(dataDir);
    await access(dataDir, constants.W_OK);
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
  await library.load();
  accounts = createAccounts(library.store(), dataDir);
  accounts.ensureAdmin(authUser, authPassword);
  try {
    await access(musicDir, constants.R_OK);
  } catch {
    console.warn(`Music folder is not readable yet: ${musicDir}`);
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use` : error.message);
    process.exit(1);
  }
  console.log(`berrytone listening on port ${port}`);
  console.log(`music folder: ${musicDir}`);
  console.log(`data folder: ${dataDir}`);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  if (pathname.startsWith('/rest/')) {
    await handleRest(req, res, url);
    return;
  }

  const sonosStream = /^\/api\/sonos\/stream\/([a-f0-9]{48})$/.exec(pathname);
  if (sonosStream && (req.method === 'GET' || req.method === 'HEAD')) {
    const grant = speakers.recall(sonosStream[1]);
    if (!grant) return sendJson(req, res, 404, { error: 'Track not found' });
    if (grant.kind === 'download') {
      const file = await downloads.open(grant.relPath);
      if (!file) return sendJson(req, res, 404, { error: 'Track not found' });
      return sendFile(req, res, file.filePath, file.mime);
    }
    return sendAudio(req, res, grant.id);
  }
  const sonosArt = /^\/api\/sonos\/art\/([a-f0-9]{48})$/.exec(pathname);
  if (sonosArt && (req.method === 'GET' || req.method === 'HEAD')) {
    const grant = speakers.recall(sonosArt[1]);
    if (!grant?.albumId) return sendJson(req, res, 404, { error: 'No artwork' });
    return sendArt(req, res, grant.albumId);
  }

  if (pathname === '/api/health') {
    await sendJson(req, res, 200, { ok: true });
    return;
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    await handleLogin(req, res);
    return;
  }
  if (pathname === '/login' && req.method === 'GET') {
    if (!authOn() || identify(req)) {
      redirect(res, '/');
      return;
    }
    await sendStatic(req, res, '/login.html');
    return;
  }
  if ((pathname === '/login.js' || pathname === '/styles.css' || pathname === '/favicon.svg' || STATIC[pathname]?.startsWith('font/')) && req.method === 'GET') {
    await sendStatic(req, res, pathname);
    return;
  }

  const actor = identify(req);
  if (!actor) {
    deny(req, res, url);
    return;
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    library.store().deleteSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    await sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', { secure: secureRequest(req) }) });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    await sendJson(req, res, 405, { error: 'Method not allowed' });
    return;
  }
  if (req.method === 'POST' && !postAllowed(pathname)) {
    await sendJson(req, res, 405, { error: 'Method not allowed' });
    return;
  }
  if (req.method === 'DELETE' && !/^\/api\/playlists\/[a-f0-9]{16}$/.test(pathname) && !/^\/api\/finds\/[a-f0-9]{16}$/.test(pathname) && !/^\/api\/tracks\/[a-f0-9]{16}$/.test(pathname) && !/^\/api\/admin\/users\/[a-f0-9]{16}$/.test(pathname)) {
    await sendJson(req, res, 405, { error: 'Method not allowed' });
    return;
  }

  const blocked = blockedFeature(pathname);
  if (blocked && !allows(actor, blocked)) {
    await sendJson(req, res, 403, { error: 'That feature is turned off' });
    return;
  }
  if (pathname === '/api/status') {
    await sendJson(req, res, 200, {
      ...library.getStatus(),
      auth: authOn(),
      username: actor.username || '',
      userId: actor.id || '',
      role: authOn() ? actor.role : '',
      features: actor.features,
    });
    return;
  }
  if (pathname === '/api/admin' && req.method === 'GET') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    await sendJson(req, res, 200, accounts.list());
    return;
  }
  if (pathname === '/api/admin/users' && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const created = accounts.createUser({ username: body?.username, password: body?.password, role: body?.role });
    if (created.error) return sendJson(req, res, 400, created);
    return sendJson(req, res, 201, created);
  }
  if (pathname === '/api/admin/settings' && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const saved = accounts.setFanartKey(body?.fanartApiKey);
    if (saved.error) return sendJson(req, res, 400, saved);
    return sendJson(req, res, 200, saved);
  }
  if (pathname === '/api/admin/features' && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const saved = accounts.setFeature(body?.key, body?.enabled === true);
    if (saved.error) return sendJson(req, res, 400, saved);
    return sendJson(req, res, 200, saved);
  }
  const adminUserMatch = /^\/api\/admin\/users\/([a-f0-9]{16})$/.exec(pathname);
  if (adminUserMatch && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const saved = accounts.updateUser(adminUserMatch[1], { password: body?.password, role: body?.role });
    if (saved.error) return sendJson(req, res, 400, saved);
    return sendJson(req, res, 200, saved);
  }
  if (adminUserMatch && req.method === 'DELETE') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const removed = accounts.deleteUser(adminUserMatch[1]);
    if (removed.error) return sendJson(req, res, 400, removed);
    return sendJson(req, res, 200, removed);
  }
  if (pathname === '/api/sonos/rooms' && req.method === 'GET') {
    try {
      await sendJson(req, res, 200, { rooms: await speakers.rooms({ refresh: url.searchParams.get('refresh') === '1' }) });
    } catch (error) {
      await sendJson(req, res, 502, { error: error.message || 'The speakers could not be found' });
    }
    return;
  }
  if (pathname === '/api/sonos/state' && req.method === 'GET') {
    try {
      const result = await speakers.state(url.searchParams.get('room') || '');
      if (result.error) return sendJson(req, res, result.status || 400, result);
      await sendJson(req, res, 200, result);
    } catch (error) {
      await sendJson(req, res, 502, { error: error.message || 'The speaker did not answer' });
    }
    return;
  }
  if (pathname === '/api/sonos/play' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await speakers.play(typeof body?.roomId === 'string' ? body.roomId : '', body?.tracks);
      if (result.error) return sendJson(req, res, result.status || 400, result);
      await sendJson(req, res, 200, result);
    } catch (error) {
      await sendJson(req, res, 502, { error: error.message || 'The speaker could not play that' });
    }
    return;
  }
  if (pathname === '/api/sonos/transport' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await speakers.transport(body?.roomId, body?.action);
      if (result.error) return sendJson(req, res, result.status || 400, result);
      await sendJson(req, res, 200, result);
    } catch (error) {
      await sendJson(req, res, 502, { error: error.message || 'The speaker did not answer' });
    }
    return;
  }
  if (pathname === '/api/sonos/volume' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await speakers.volume(body?.roomId, body?.volume);
      if (result.error) return sendJson(req, res, result.status || 400, result);
      await sendJson(req, res, 200, result);
    } catch (error) {
      await sendJson(req, res, 502, { error: error.message || 'The speaker did not answer' });
    }
    return;
  }
  if (pathname === '/api/rescan' && req.method === 'POST') {
    const body = await readJson(req);
    const job = library.rescan({
      musicbrainz: false,
      albumId: typeof body?.albumId === 'string' ? body.albumId : '',
      artistId: typeof body?.artistId === 'string' ? body.artistId : '',
    });
    if (!job) return sendJson(req, res, 409, { error: 'A scan is already running' });
    if (job.error) return sendJson(req, res, job.status || 400, { error: job.error });
    await sendJson(req, res, 202, library.getStatus());
    return;
  }
  if (pathname === '/api/musicbrainz' && req.method === 'POST') {
    if (!library.matchAlbums()) return sendJson(req, res, 409, { error: 'A scan is already running' });
    await sendJson(req, res, 202, library.getStatus());
    return;
  }
  if (pathname === '/api/albums') {
    await sendJson(req, res, 200, { albums: library.listAlbums() });
    return;
  }
  if (pathname === '/api/artists') {
    await sendJson(req, res, 200, { artists: library.listArtists() });
    return;
  }
  const trackDeleteMatch = /^\/api\/tracks\/([a-f0-9]{16})$/.exec(pathname);
  if (trackDeleteMatch && req.method === 'DELETE') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const saved = await library.deleteTrack(trackDeleteMatch[1]);
    if (!saved) return sendJson(req, res, 404, { error: 'Track not found' });
    if (saved.error) return sendJson(req, res, saved.status || 400, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }
  const trackInfoMatch = /^\/api\/tracks\/([a-f0-9]{16})\/info$/.exec(pathname);
  if (trackInfoMatch && req.method === 'GET') {
    const info = await library.trackDetails(trackInfoMatch[1]);
    if (!info) return sendJson(req, res, 404, { error: 'Track not found' });
    return sendJson(req, res, 200, info);
  }
  if (pathname === '/api/tracks') {
    await sendJson(
      req,
      res,
      200,
      library.listTracks({ offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') }),
    );
    return;
  }
  if (pathname === '/api/search') {
    const found = library.search(url.searchParams.get('q') || '');
    if (!allows(actor, 'artists')) found.artists = [];
    if (!allows(actor, 'albums')) found.albums = [];
    if (!allows(actor, 'albums') && !allows(actor, 'tracks')) found.tracks = [];
    await sendJson(req, res, 200, found);
    return;
  }
  if (pathname === '/api/folders' && req.method === 'GET') {
    const page = library.folder(null);
    page.download = allows(actor, 'downloads') && await downloads.enabled();
    await sendJson(req, res, 200, page);
    return;
  }
  if (pathname === '/api/downloads/cover' && req.method === 'GET') {
    const image = await downloads.cover(url.searchParams.get('path') || '');
    if (!image) return sendJson(req, res, 404, { error: 'No artwork' });
    return sendFile(req, res, image.filePath, image.mime);
  }
  if (pathname === '/api/downloads/info' && req.method === 'GET') {
    const info = await downloads.details(url.searchParams.get('path') || '');
    if (!info) return sendJson(req, res, 404, { error: 'Track not found' });
    return sendJson(req, res, 200, info);
  }
  if (pathname === '/api/downloads/import' && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const file = await downloads.audioFile(typeof body?.path === 'string' ? body.path : '');
    if (!file) return sendJson(req, res, 404, { error: 'Song not found' });
    const saved = await library.importDownloads([file]);
    if (saved.error) return sendJson(req, res, saved.status || 400, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }
  if (pathname === '/api/downloads/album' && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const rel = typeof body?.path === 'string' ? body.path : '';
    const files = await downloads.audioFiles(rel);
    if (!files) return sendJson(req, res, 404, { error: 'Folder not found' });
    const album = rel.split('/').filter(Boolean).at(-1) || '';
    const saved = await library.importDownloadAlbum(files, album);
    if (saved.error) return sendJson(req, res, saved.status || 400, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }
  if (pathname === '/api/downloads' && req.method === 'GET') {
    const page = await downloads.list(url.searchParams.get('path') || '', {
      offset: url.searchParams.get('offset'),
      limit: url.searchParams.get('limit'),
    });
    if (!page) return sendJson(req, res, 404, { error: 'Folder not found' });
    return sendJson(req, res, 200, page);
  }
  if (pathname === '/api/downloads/tracks' && req.method === 'GET') {
    const tracks = await downloads.collect(url.searchParams.get('path') || '');
    if (!tracks) return sendJson(req, res, 404, { error: 'Folder not found' });
    return sendJson(req, res, 200, { tracks });
  }
  if (pathname.startsWith('/api/downloads/stream/') && req.method === 'GET') {
    const rel = pathname.slice('/api/downloads/stream/'.length).split('/').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    }).join('/');
    const file = await downloads.open(rel);
    if (!file) return sendJson(req, res, 404, { error: 'Track not found' });
    return sendFile(req, res, file.filePath, file.mime);
  }
  if (pathname === '/api/folders/tracks' && req.method === 'GET') {
    await sendJson(req, res, 200, { tracks: library.folderTracks(null) });
    return;
  }
  const folderTracksMatch = /^\/api\/folders\/([a-f0-9]{16})\/tracks$/.exec(pathname);
  if (folderTracksMatch && req.method === 'GET') {
    const tracks = library.folderTracks(folderTracksMatch[1]);
    if (!tracks) return sendJson(req, res, 404, { error: 'Folder not found' });
    return sendJson(req, res, 200, { tracks });
  }
  const folderMatch = /^\/api\/folders\/([a-f0-9]{16})$/.exec(pathname);
  if (folderMatch && req.method === 'GET') {
    const folder = library.folder(folderMatch[1]);
    if (!folder) return sendJson(req, res, 404, { error: 'Folder not found' });
    return sendJson(req, res, 200, folder);
  }
  if (pathname === '/api/finds' && req.method === 'GET') {
    await sendJson(req, res, 200, { items: library.listFinds() });
    return;
  }
  if (pathname === '/api/finds' && req.method === 'POST') {
    const body = await readJson(req);
    const albumId = typeof body?.albumId === 'string' ? body.albumId : '';
    const slotId = typeof body?.slotId === 'string' ? body.slotId : '';
    const saved = library.addToFindList(albumId, slotId);
    if (!saved) return sendJson(req, res, 400, { error: 'That missing song could not be added' });
    return sendJson(req, res, 200, saved);
  }
  if (pathname === '/api/finds/search-all' && req.method === 'POST') {
    const found = await library.searchAllFinds();
    return sendJson(req, res, 200, found);
  }
  if (pathname === '/api/finds/playlist' && req.method === 'POST') {
    const body = await readJson(req);
    const preview = await library.previewPlaylist(typeof body?.url === 'string' ? body.url : '');
    if (preview.error) return sendJson(req, res, preview.status || 502, { error: preview.error });
    return sendJson(req, res, 200, preview);
  }
  if (pathname === '/api/finds/playlist/download' && req.method === 'POST') {
    const body = await readJson(req);
    const saved = await library.downloadPlaylistTrack({
      albumId: typeof body?.albumId === 'string' ? body.albumId : '',
      artist: typeof body?.artist === 'string' ? body.artist : '',
      album: typeof body?.album === 'string' ? body.album : '',
      url: typeof body?.url === 'string' ? body.url : '',
      title: typeof body?.title === 'string' ? body.title : '',
      track: body?.track,
    });
    if (saved.error) return sendJson(req, res, saved.status || 502, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }
  const findLinkMatch = /^\/api\/finds\/([a-f0-9]{16})\/link$/.exec(pathname);
  if (findLinkMatch && req.method === 'POST') {
    const body = await readJson(req);
    const saved = library.addFindLink(findLinkMatch[1], typeof body?.url === 'string' ? body.url : '');
    if (!saved) return sendJson(req, res, 404, { error: 'That song is not on the find list' });
    if (saved.error) return sendJson(req, res, saved.status || 400, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }
  const findSearchMatch = /^\/api\/finds\/([a-f0-9]{16})\/search$/.exec(pathname);
  if (findSearchMatch && req.method === 'POST') {
    const found = await library.searchFind(findSearchMatch[1]);
    if (!found) return sendJson(req, res, 404, { error: 'That song is not on the find list' });
    if (found.error) return sendJson(req, res, 502, found);
    return sendJson(req, res, 200, found);
  }
  const findDownloadMatch = /^\/api\/finds\/([a-f0-9]{16})\/download$/.exec(pathname);
  if (findDownloadMatch && req.method === 'POST') {
    const body = await readJson(req);
    const saved = await library.downloadFind(findDownloadMatch[1], typeof body?.url === 'string' ? body.url : '');
    if (!saved) return sendJson(req, res, 404, { error: 'That song is not on the find list' });
    if (saved.error) return sendJson(req, res, saved.status || 502, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }
  const findMatch = /^\/api\/finds\/([a-f0-9]{16})$/.exec(pathname);
  if (findMatch && req.method === 'DELETE') {
    if (!library.removeFind(findMatch[1])) return sendJson(req, res, 404, { error: 'That song is not on the find list' });
    return sendJson(req, res, 200, { ok: true });
  }
  if (pathname === '/api/favourites' && req.method === 'GET') {
    await sendJson(req, res, 200, library.favourites());
    return;
  }
  if (pathname === '/api/favourites' && req.method === 'POST') {
    const body = await readJson(req);
    const saved = library.setFavourite(body?.kind, body?.id, body?.on === true);
    if (!saved) return sendJson(req, res, 400, { error: 'That favourite could not be saved' });
    return sendJson(req, res, 200, saved);
  }
  if (pathname === '/api/playlists' && req.method === 'GET') {
    await sendJson(req, res, 200, { playlists: playlistViews(library).list() });
    return;
  }
  if (pathname === '/api/playlists' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(req, res, 400, { error: 'Playlist needs a name and songs' });
    const created = playlistViews(library).create(body.name, body.trackIds);
    if (created.error) return sendJson(req, res, 400, created);
    return sendJson(req, res, 201, created);
  }
  const playlistMatch = /^\/api\/playlists\/([a-f0-9]{16})$/.exec(pathname);
  if (playlistMatch && req.method === 'GET') {
    const playlist = playlistViews(library).get(playlistMatch[1]);
    if (!playlist) return sendJson(req, res, 404, { error: 'Playlist not found' });
    return sendJson(req, res, 200, playlist);
  }
  if (playlistMatch && req.method === 'DELETE') {
    if (!playlistViews(library).remove(playlistMatch[1])) return sendJson(req, res, 404, { error: 'Playlist not found' });
    return sendJson(req, res, 200, { ok: true });
  }

  const mergeMatch = /^\/api\/albums\/([a-f0-9]{16})\/merge$/.exec(pathname);
  if (mergeMatch && req.method === 'GET') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const albums = library.mergeCandidates(mergeMatch[1]);
    if (!albums) return sendJson(req, res, 404, { error: 'Album not found' });
    return sendJson(req, res, 200, { albums });
  }
  if (mergeMatch && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const saved = library.mergeAlbums(mergeMatch[1], typeof body?.albumId === 'string' ? body.albumId : '');
    if (!saved) return sendJson(req, res, 404, { error: 'Album not found' });
    if (saved.error) return sendJson(req, res, saved.status || 400, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }
  const separateMatch = /^\/api\/albums\/([a-f0-9]{16})\/separate$/.exec(pathname);
  if (separateMatch && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const body = await readJson(req);
    const saved = library.separateAlbum(separateMatch[1], typeof body?.title === 'string' ? body.title : '');
    if (!saved) return sendJson(req, res, 404, { error: 'Album not found' });
    if (saved.error) return sendJson(req, res, saved.status || 400, { error: saved.error });
    return sendJson(req, res, 200, saved);
  }

  const albumMatch = /^\/api\/albums\/([a-f0-9]{16})$/.exec(pathname);
  if (albumMatch) {
    const album = library.getAlbum(albumMatch[1]);
    if (!album) return sendJson(req, res, 404, { error: 'Album not found' });
    return sendJson(req, res, 200, album);
  }
  const artistMatch = /^\/api\/artists\/([a-f0-9]{16})$/.exec(pathname);
  if (artistMatch) {
    const artist = library.getArtist(artistMatch[1]);
    if (!artist) return sendJson(req, res, 404, { error: 'Artist not found' });
    return sendJson(req, res, 200, artist);
  }
  const artMatch = /^\/api\/art\/([a-f0-9]{16})$/.exec(pathname);
  if (artMatch) return sendArt(req, res, artMatch[1]);
  const artistArtMatch = /^\/api\/artist-art\/([a-f0-9]{16})$/.exec(pathname);
  if (artistArtMatch) return sendArtistArt(req, res, artistArtMatch[1]);
  if (pathname === '/api/artist-photos' && req.method === 'POST') {
    if (actor.role !== 'admin') return sendJson(req, res, 403, { error: 'That feature is turned off' });
    const key = accounts.fanartKey();
    if (!key) return sendJson(req, res, 400, { error: 'Add a Fanart key in Settings' });
    const started = library.findArtistPhotos(key);
    if (started === false) return sendJson(req, res, 409, { error: 'A scan is already running' });
    if (started === 'none') return sendJson(req, res, 200, { ok: true, pending: 0 });
    return sendJson(req, res, 202, library.getStatus());
  }
  const streamMatch = /^\/api\/stream\/([a-f0-9]{16})$/.exec(pathname);
  if (streamMatch) return sendAudio(req, res, streamMatch[1]);

  if (pathname.startsWith('/api/')) {
    await sendJson(req, res, 404, { error: 'Not found' });
    return;
  }
  if (req.method !== 'GET') {
    await sendJson(req, res, 405, { error: 'Method not allowed' });
    return;
  }
  if (STATIC[pathname]) {
    await sendStatic(req, res, pathname);
    return;
  }
  await sendStatic(req, res, '/index.html');
}

async function handleRest(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
    sendXml(res, 405, '<?xml version="1.0" encoding="UTF-8"?><subsonic-response status="failed" version="1.16.1"><error code="0" message="Method not allowed"/></subsonic-response>');
    return;
  }
  const match = /^\/rest\/([A-Za-z0-9]+)\.view$/.exec(url.pathname);
  if (!match) {
    sendXml(res, 200, '<?xml version="1.0" encoding="UTF-8"?><subsonic-response status="failed" version="1.16.1"><error code="70" message="Unknown method"/></subsonic-response>');
    return;
  }
  let params = url.searchParams;
  if (req.method === 'POST') {
    const raw = await readBody(req);
    if (!raw) {
      sendXml(res, 200, '<?xml version="1.0" encoding="UTF-8"?><subsonic-response status="failed" version="1.16.1"><error code="10" message="Missing request"/></subsonic-response>');
      return;
    }
    params = new URLSearchParams(url.search);
    const posted = new URLSearchParams(raw.toString('utf8'));
    for (const [key, value] of posted) params.append(key, value);
  }
  const result = subsonic({
    library,
    params,
    action: match[1].toLowerCase(),
    authUser,
    authPassword,
    accounts,
  });
  if (result.stream) return sendAudio(req, res, result.stream);
  if (result.art) return sendArt(req, res, result.art);
  if (result.missingArt || result.missingMedia) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
    res.end('Not found');
    return;
  }
  sendXml(res, 200, result.body);
}

function sendXml(res, status, xml) {
  const body = Buffer.from(xml);
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...SECURITY,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        resolve(null);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return null;
  try {
    const body = JSON.parse(raw.toString('utf8'));
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

async function handleLogin(req, res) {
  if (!authOn()) {
    redirect(res, '/');
    return;
  }
  const ip = req.socket?.remoteAddress || 'unknown';
  if (loginLimiter.blocked(ip)) {
    await sendJson(req, res, 429, { error: 'Too many tries. Wait a few minutes.' });
    return;
  }
  const body = await readJson(req);
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const user = accounts.authenticate(username, password);
  if (!user) {
    loginLimiter.fail(ip);
    await sendJson(req, res, 401, { error: 'That username or password is wrong.' });
    return;
  }
  loginLimiter.clear(ip);
  const id = library.store().createSession(Date.now() + SESSION_SECONDS * 1000, user.id);
  await sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(id, { secure: secureRequest(req) }) });
}

function deny(req, res, url) {
  const accept = String(req.headers.accept || '');
  if (req.method === 'GET' && accept.includes('text/html')) {
    const next = safeNext(url.pathname);
    redirect(res, next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`);
    return;
  }
  sendJson(req, res, 401, { error: 'Sign in required' }).catch(() => res.destroy());
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...SECURITY });
  res.end();
}

function identify(req) {
  if (!authOn()) return accounts.guest();
  const sessionActor = accounts.actorFromSession(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (sessionActor) return sessionActor;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const split = decoded.indexOf(':');
  if (split < 0) return null;
  return accounts.authenticate(decoded.slice(0, split), decoded.slice(split + 1));
}

function allows(actor, feature) {
  if (feature === 'admin') return actor?.role === 'admin';
  if (feature === 'play') return ['albums', 'tracks', 'folders', 'playlists', 'favourites'].some((key) => accounts.allows(actor, key));
  if (feature === 'search') return ['albums', 'artists', 'tracks'].some((key) => accounts.allows(actor, key));
  if (feature === 'art') return ['albums', 'artists', 'favourites', 'playlists'].some((key) => accounts.allows(actor, key));
  return accounts.allows(actor, feature);
}

function blockedFeature(pathname) {
  if (pathname === '/api/status' || pathname === '/api/logout' || pathname.startsWith('/api/admin')) return null;
  if (pathname === '/api/rescan') return 'rescan';
  if (pathname === '/api/musicbrainz') return 'match';
  if (pathname === '/api/search') return 'search';
  if (pathname === '/api/albums' || pathname.startsWith('/api/albums/')) return 'albums';
  if (pathname === '/api/artists' || pathname.startsWith('/api/artists/')) return 'artists';
  if (pathname.startsWith('/api/folders')) return 'folders';
  if (pathname.startsWith('/api/downloads')) return 'downloads';
  if (/^\/api\/tracks\/[a-f0-9]{16}\/info$/.test(pathname)) return 'play';
  if (pathname === '/api/tracks') return 'tracks';
  if (pathname.startsWith('/api/favourites')) return 'favourites';
  if (pathname.startsWith('/api/playlists')) return 'playlists';
  if (pathname.startsWith('/api/finds')) return 'find';
  if (pathname.startsWith('/api/sonos/')) return 'sonos';
  if (pathname.startsWith('/api/art/') || pathname.startsWith('/api/artist-art/')) return 'art';
  if (pathname.startsWith('/api/stream/')) return 'play';
  return null;
}

function postAllowed(pathname) {
  return pathname === '/api/rescan'
    || pathname === '/api/musicbrainz'
    || pathname === '/api/playlists'
    || pathname === '/api/logout'
    || pathname === '/api/favourites'
    || pathname === '/api/finds'
    || pathname === '/api/admin/users'
    || pathname === '/api/admin/features'
    || pathname === '/api/admin/settings'
    || pathname === '/api/artist-photos'
    || pathname === '/api/sonos/play'
    || pathname === '/api/sonos/transport'
    || pathname === '/api/sonos/volume'
    || pathname === '/api/finds/search-all'
    || pathname === '/api/finds/playlist'
    || pathname === '/api/finds/playlist/download'
    || pathname === '/api/downloads/import'
    || pathname === '/api/downloads/album'
    || /^\/api\/finds\/[a-f0-9]{16}\/link$/.test(pathname)
    || /^\/api\/finds\/[a-f0-9]{16}\/search$/.test(pathname)
    || /^\/api\/finds\/[a-f0-9]{16}\/download$/.test(pathname)
    || /^\/api\/albums\/[a-f0-9]{16}\/merge$/.test(pathname)
    || /^\/api\/albums\/[a-f0-9]{16}\/separate$/.test(pathname)
    || /^\/api\/admin\/users\/[a-f0-9]{16}$/.test(pathname);
}

function secureRequest(req) {
  return Boolean(req.socket?.encrypted) || String(req.headers['x-forwarded-proto'] || '').includes('https');
}

async function sendStatic(req, res, pathname) {
  const name = pathname === '/index.html' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(publicDir, name);
  let body;
  try {
    body = await readFile(filePath);
  } catch {
    await sendJson(req, res, 404, { error: 'Not found' });
    return;
  }
  const type = pathname === '/index.html' || pathname === '/login.html' ? 'text/html; charset=utf-8' : STATIC[pathname];
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    ...SECURITY,
  };
  if (pathname === '/index.html' || pathname === '/login.html') headers['Content-Security-Policy'] = CSP;
  await endBody(req, res, 200, body, headers);
}

async function sendArtistArt(req, res, id) {
  const image = await library.artistArt(id);
  if (!image) {
    await sendJson(req, res, 404, { error: 'No artwork' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': image.mime,
    'Content-Length': image.size,
    'Cache-Control': 'public, max-age=86400',
    ...SECURITY,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(image.filePath), res).catch(ignoreDisconnect);
}

async function sendArt(req, res, id) {
  const image = await library.art(id);
  if (!image) {
    await sendJson(req, res, 404, { error: 'No artwork' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': image.mime,
    'Content-Length': image.size,
    'Cache-Control': 'public, max-age=86400',
    ...SECURITY,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(image.filePath), res).catch(ignoreDisconnect);
}

async function resolveSonos(spec) {
  if (spec?.source === 'download') {
    const relPath = typeof spec.relPath === 'string' ? spec.relPath : '';
    const file = await downloads.open(relPath);
    if (!file) return null;
    return {
      kind: 'download',
      relPath,
      filePath: file.filePath,
      mime: file.mime,
      title: sonosLabel(spec.title, 'download'),
      artist: 'download',
      album: 'download',
    };
  }
  const id = typeof spec?.id === 'string' ? spec.id : '';
  const file = library.playable(id);
  const track = library.trackById(id);
  if (!file || !track?.playable) return null;
  const filePath = absFromRel(musicDir, file.relPath);
  if (!filePath) return null;
  return {
    kind: 'library',
    id,
    filePath,
    mime: file.mime,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    albumId: track.hasArt ? track.albumId : '',
  };
}

function sonosLabel(value, fallback) {
  const text = String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 180);
  return text || fallback;
}

async function sendAudio(req, res, id) {
  const track = library.playable(id);
  const abs = track ? absFromRel(musicDir, track.relPath) : null;
  if (!abs) {
    await sendJson(req, res, 404, { error: 'Track not found' });
    return;
  }
  let filePath;
  try {
    const rootReal = await realpath(musicDir);
    filePath = await realpath(abs);
    if (filePath !== rootReal && !filePath.startsWith(rootReal + path.sep)) {
      await sendJson(req, res, 404, { error: 'Track not found' });
      return;
    }
  } catch {
    await sendJson(req, res, 404, { error: 'Track not found' });
    return;
  }
  return sendFile(req, res, filePath, track.mime);
}

async function sendFile(req, res, filePath, mime) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    await sendJson(req, res, 404, { error: 'Track not found' });
    return;
  }
  const size = info.size;
  const range = parseRange(req.headers.range, size);
  if (range?.invalid) {
    res.writeHead(416, {
      'Content-Range': `bytes */${size}`,
      'Accept-Ranges': 'bytes',
      ...SECURITY,
    });
    res.end();
    return;
  }
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ...SECURITY,
  };
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(filePath), res).catch(ignoreDisconnect);
    return;
  }
  res.writeHead(206, {
    ...headers,
    'Content-Length': range.end - range.start + 1,
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
  });
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(filePath, { start: range.start, end: range.end }), res).catch(ignoreDisconnect);
}

function parseRange(header, size) {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return { invalid: true };
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return { invalid: true };
  }
  if (start < 0 || start >= size || end < start) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

function ignoreDisconnect(error) {
  if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || error?.code === 'ECONNRESET' || error?.code === 'EPIPE') return;
  console.warn(`stream closed: ${error.message}`);
}

function sendJson(req, res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  return endBody(req, res, status, body, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY,
    ...extra,
  });
}

async function endBody(req, res, status, body, headers) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (body.length > 1024 && /\bgzip\b/.test(accept)) {
    const encoded = await gzipAsync(body);
    res.writeHead(status, {
      ...headers,
      'Content-Encoding': 'gzip',
      'Content-Length': encoded.length,
      Vary: 'Accept-Encoding',
    });
    res.end(encoded);
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Length': body.length });
  res.end(body);
}
