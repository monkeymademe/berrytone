'use strict';

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l12-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h2.2v12H6zM19.5 6.4 9.2 12l10.3 5.6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.8 6h2.2v12h-2.2zM4.5 6.4 14.8 12 4.5 17.6z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M16 4h4v4M4 8h3.2c2.4 0 3.5 2.4 5 4.6L15 16.2c.8 1.1 1.7 1.8 3.2 1.8H20M16 20h4v-4M4 16h3.2c1.5 0 2.4-.7 3.2-1.8"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M17 2.8 20.2 6 17 9.2M20.2 6H8.2A4.2 4.2 0 0 0 4 10.2V12M7 21.2 3.8 18 7 14.8M3.8 18h12a4.2 4.2 0 0 0 4.2-4.2V12"/></svg>',
  queue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 7h11M4 12h11M4 17h7M17 10v8M13.5 14H21"/></svg>',
  sonos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5 10v4M9 7v10M13 4.5v15M17 8v8M20.5 11v2"/></svg>',
};

const view = document.querySelector('#view');
const searchForm = document.querySelector('#search-form');
const searchInput = document.querySelector('#search');
const libraryStat = document.querySelector('#library-stat');
const logoutButton = document.querySelector('#logout');
const accountButton = document.querySelector('#account');
const accountMenu = document.querySelector('#account-menu');
const accountName = document.querySelector('#account-name');
const accountRole = document.querySelector('#account-role');
const accountMark = document.querySelector('#account-mark');
const accountPeople = document.querySelector('#account-people');
const scanProgress = document.querySelector('#scan-progress');
const rescanBtn = document.querySelector('#rescan');
const matchBtn = document.querySelector('#match');
const hostEl = document.querySelector('#host');
const nowCover = document.querySelector('#now-cover');
const nowTitle = document.querySelector('#now-title');
const nowArtist = document.querySelector('#now-artist');
const shuffleBtn = document.querySelector('#shuffle');
const prevBtn = document.querySelector('#prev');
const playBtn = document.querySelector('#play');
const nextBtn = document.querySelector('#next');
const repeatBtn = document.querySelector('#repeat');
const timeCurrent = document.querySelector('#time-current');
const timeTotal = document.querySelector('#time-total');
const scrubber = document.querySelector('#scrubber');
const volumeInput = document.querySelector('#volume');
const queueToggle = document.querySelector('#queue-toggle');
const queuePanel = document.querySelector('#queue');
const sonosToggle = document.querySelector('#sonos-toggle');
const sonosPanel = document.querySelector('#sonos');
const sonosBody = document.querySelector('#sonos-body');
const sonosControls = document.querySelector('#sonos-controls');
const sonosRefresh = document.querySelector('#sonos-refresh');
const sonosClose = document.querySelector('#sonos-close');
const queueList = document.querySelector('#queue-list');
const queueClear = document.querySelector('#queue-clear');
const toastEl = document.querySelector('#toast');

const audio = new Audio();
audio.preload = 'none';

const saved = loadSaved();
const queue = {
  items: saved.items,
  index: clampIndex(saved.index, saved.items.length),
  shuffle: saved.shuffle,
  repeat: saved.repeat,
  volume: saved.volume,
};
const playHistory = [];
const known = new Map();
const cache = { albums: null, artists: null };
let latestStatus = null;
let shownScan;
let renderToken = 0;
let currentList = [];
let trackPage = { items: [], total: 0 };
let downloadPage = { path: '', items: [], total: 0 };
let downloadPlace = null;
let collection = null;
let gridObserver = null;
let queueOpen = false;
let sonosOpen = false;
let sonosRoom = '';
let sonosPlaying = false;
let sonosRooms = [];
let sonosTimer = 0;
let scrubbing = false;
let expectAudio = false;
let paintedId = null;
let searchTimer = 0;
let composing = false;
let toastTimer = 0;
let playlistPreview = null;

hostEl.textContent = location.host;
shuffleBtn.innerHTML = ICONS.shuffle;
prevBtn.innerHTML = ICONS.prev;
nextBtn.innerHTML = ICONS.next;
repeatBtn.innerHTML = ICONS.repeat;
queueToggle.innerHTML = ICONS.queue;
sonosToggle.innerHTML = ICONS.sonos;
audio.volume = queue.volume;
volumeInput.value = String(queue.volume);
paintRange(volumeInput, queue.volume);
registerSession();
restorePlayer();

const initial = parseRoute();
if (initial.name === 'search') searchInput.value = initial.q;
view.innerHTML = '<p class="loading">Loading…</p>';
poll();

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/');
});
searchInput.addEventListener('compositionstart', () => {
  composing = true;
});
searchInput.addEventListener('compositionend', () => {
  composing = false;
  scheduleSearch();
});
searchInput.addEventListener('input', () => {
  if (!composing) scheduleSearch();
});
rescanBtn.addEventListener('click', async () => {
  rescanBtn.disabled = true;
  const response = await fetch('/api/rescan', { method: 'POST' });
  if (!response.ok) toast('Could not start a rescan');
});
matchBtn?.addEventListener('click', async () => {
  matchBtn.disabled = true;
  const response = await fetch('/api/musicbrainz', { method: 'POST' });
  if (!response.ok) toast('Could not start matching');
});
playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', previous);
nextBtn.addEventListener('click', () => goNext(false));
shuffleBtn.addEventListener('click', () => {
  queue.shuffle = !queue.shuffle;
  persist();
  paintModes();
});
repeatBtn.addEventListener('click', () => {
  queue.repeat = queue.repeat === 'off' ? 'all' : queue.repeat === 'all' ? 'one' : 'off';
  persist();
  paintModes();
});
queueToggle.addEventListener('click', () => {
  queueOpen = !queueOpen;
  if (queueOpen) closeSonos();
  renderQueue();
});
sonosToggle.addEventListener('click', () => {
  if (sonosOpen) closeSonos();
  else {
    queueOpen = false;
    renderQueue();
    loadSonos(false);
  }
});
sonosRefresh?.addEventListener('click', () => loadSonos(true));
sonosClose?.addEventListener('click', closeSonos);
queueClear.addEventListener('click', clearQueue);
scrubber.addEventListener('input', () => {
  scrubbing = true;
  const duration = usableDuration();
  paintRange(scrubber, Number(scrubber.value) / 1000);
  timeCurrent.textContent = formatTime((Number(scrubber.value) / 1000) * duration);
});
scrubber.addEventListener('change', () => {
  const duration = usableDuration();
  if (duration && audio.src) audio.currentTime = (Number(scrubber.value) / 1000) * duration;
  scrubbing = false;
});
scrubber.addEventListener('pointerup', () => {
  scrubbing = false;
});
volumeInput.addEventListener('input', () => {
  queue.volume = Number(volumeInput.value);
  audio.volume = queue.volume;
  paintRange(volumeInput, queue.volume);
  persist();
});
audio.addEventListener('timeupdate', updatePlayer);
audio.addEventListener('loadedmetadata', updatePlayer);
audio.addEventListener('play', updatePlayer);
audio.addEventListener('pause', updatePlayer);
audio.addEventListener('ended', () => {
  if (queue.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  goNext(true);
});
audio.addEventListener('error', () => {
  if (!expectAudio) return;
  toast('This browser can’t play that file. MP3 and M4A are the safest choices.');
});
window.addEventListener('popstate', () => {
  const route = parseRoute();
  searchInput.value = route.name === 'search' ? route.q : '';
  show(route);
});
document.addEventListener('submit', (event) => {
  if (event.target.matches('#fanart-form')) {
    event.preventDefault();
    saveFanart(event.target);
    return;
  }
  if (event.target.matches('#people-form')) {
    event.preventDefault();
    addPerson(event.target);
    return;
  }
  if (!event.target.matches('.playlist-save')) return;
  event.preventDefault();
  const button = event.target.querySelector('[data-action="save-queue"]');
  if (button) onAction(button);
});
document.addEventListener('change', async (event) => {
  if (event.target.id === 'sonos-volume' && sonosRoom) {
    api('/api/sonos/volume', { method: 'POST', body: { roomId: sonosRoom, volume: Number(event.target.value) } }).catch((error) => toast(error.message));
    return;
  }
  const feature = event.target.closest('[data-feature]');
  if (feature) {
    feature.disabled = true;
    try {
      await api('/api/admin/features', { method: 'POST', body: { key: feature.dataset.feature, enabled: feature.checked } });
    } catch (error) {
      feature.checked = !feature.checked;
      toast(error.message);
    } finally {
      feature.disabled = false;
    }
    return;
  }
  const role = event.target.closest('[data-role]');
  if (event.target.name === 'playlist-album' && playlistPreview) {
    playlistPreview.albumId = event.target.value;
    const host = document.querySelector('#playlist-match');
    if (host) host.innerHTML = playlistMatchHtml();
    return;
  }
  if (!role) return;
  const previous = role.dataset.current;
  role.disabled = true;
  try {
    await api(`/api/admin/users/${role.dataset.role}`, { method: 'POST', body: { role: role.value } });
    role.dataset.current = role.value;
    if (role.dataset.role === latestStatus?.userId && role.value !== 'admin') location.reload();
  } catch (error) {
    role.value = previous;
    toast(error.message);
  } finally {
    role.disabled = false;
  }
});
accountButton?.addEventListener('click', () => {
  const open = accountMenu.hidden;
  accountMenu.hidden = !open;
  accountButton.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.querySelector('#track-info')?.addEventListener('click', (event) => {
  const dialog = event.currentTarget;
  if (event.target === dialog) dialog.close();
});
document.querySelector('#confirm')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close('cancel');
});
document.querySelector('#merge')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close('cancel');
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#account')) closeAccount();
  if (!event.target.closest('.more-wrap')) closeAlbumMenus();
  const action = event.target.closest('[data-action]');
  if (action) {
    event.preventDefault();
    onAction(action);
    return;
  }
  const link = event.target.closest('a[href]');
  if (!link || link.target === '_blank' || link.origin !== location.origin) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(`${link.pathname}${link.search}`);
});
window.addEventListener('keydown', (event) => {
  const typing = event.target.closest('input, textarea');
  if (event.key === '/' && !typing) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (event.key === ' ' && !typing && event.target === document.body) {
    event.preventDefault();
    togglePlay();
  } else if (event.key === 'Escape' && accountMenu && !accountMenu.hidden) {
    closeAccount();
  } else if (event.key === 'Escape' && sonosOpen) {
    closeSonos();
  } else if (event.key === 'Escape' && queueOpen) {
    queueOpen = false;
    renderQueue();
  }
});

function parseRoute() {
  const parts = location.pathname.split('/').filter(Boolean).map(pathPart);
  const params = new URLSearchParams(location.search);
  if (parts.length === 0) return { name: 'albums' };
  if (parts[0] === 'artists' && parts.length === 1) return { name: 'artists' };
  if (parts[0] === 'artist' && isId(parts[1])) return { name: 'artist', id: parts[1] };
  if (parts[0] === 'album' && isId(parts[1])) return { name: 'album', id: parts[1] };
  if (parts[0] === 'tracks') return { name: 'tracks' };
  if (parts[0] === 'folders' && parts.length === 1) return { name: 'folders' };
  if (parts[0] === 'downloads') return { name: 'downloads', path: parts.slice(1).join('/') };
  if (parts[0] === 'folder' && isId(parts[1]) && parts.length === 2) return { name: 'folder', id: parts[1] };
  if (parts[0] === 'favourites' && parts.length === 1) return { name: 'favourites' };
  if (parts[0] === 'playlists' && parts.length === 1) return { name: 'playlists' };
  if (parts[0] === 'find' && parts.length === 1) return { name: 'find' };
  if (parts[0] === 'playlist' && isId(parts[1])) return { name: 'playlist', id: parts[1] };
  if (parts[0] === 'search') return { name: 'search', q: params.get('q') || '' };
  if (parts[0] === 'admin' && parts.length === 1) return { name: 'admin' };
  return { name: 'missing' };
}

function pathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function allowed(key) {
  return latestStatus?.features?.[key] === true;
}

function routeFeature(route) {
  const features = {
    albums: 'albums',
    album: 'albums',
    artists: 'artists',
    artist: 'artists',
    tracks: 'tracks',
    folders: 'folders',
    folder: 'folders',
    downloads: 'downloads',
    favourites: 'favourites',
    playlists: 'playlists',
    playlist: 'playlists',
    find: 'find',
  };
  return features[route.name] || '';
}

function routeOpen(route, status = latestStatus) {
  if (!status?.features) return true;
  if (route.name === 'admin') return status.role === 'admin';
  if (route.name === 'search') return status.features.albums || status.features.artists || status.features.tracks;
  const feature = routeFeature(route);
  return !feature || status.features[feature] === true;
}

function navigate(url) {
  const next = new URL(url, location.origin);
  const same = next.pathname === location.pathname && next.search === location.search;
  if (!same) window.history.pushState(null, '', next.pathname + next.search);
  const route = parseRoute();
  if (route.name !== 'search') searchInput.value = '';
  show(route);
  window.scrollTo(0, 0);
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = searchInput.value.trim();
    const url = query ? `/search?q=${encodeURIComponent(query)}` : '/';
    if (parseRoute().name === 'search' || !query) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    show(parseRoute());
  }, 180);
}

async function show(route) {
  const token = ++renderToken;
  syncNav(route.name);
  if (!routeOpen(route)) {
    currentList = [];
    view.innerHTML = '<div class="empty"><h1>This part is turned off</h1><p><a href="/">Back to albums</a></p></div>';
    setPageTitle('berrytone');
    return;
  }
  try {
    if (route.name === 'albums') await showAlbums(token);
    else if (route.name === 'artists') await showArtists(token);
    else if (route.name === 'artist') await showArtist(route.id, token);
    else if (route.name === 'album') await showAlbum(route.id, token);
    else if (route.name === 'tracks') await showTracks(token);
    else if (route.name === 'folders') await showFolder(null, token);
    else if (route.name === 'folder') await showFolder(route.id, token);
    else if (route.name === 'downloads') await showDownloads(route.path, token);
    else if (route.name === 'favourites') await showFavourites(token);
    else if (route.name === 'playlists') await showPlaylists(token);
    else if (route.name === 'find') await showFind(token);
    else if (route.name === 'playlist') await showPlaylist(route.id, token);
    else if (route.name === 'search') await showSearch(route.q, token);
    else if (route.name === 'admin') await showAdmin(token);
    else {
      currentList = [];
      view.innerHTML = '<div class="empty"><h1>That page isn’t here</h1><p><a href="/">Back to albums</a></p></div>';
      setPageTitle('berrytone');
    }
  } catch (error) {
    if (token !== renderToken) return;
    view.innerHTML = `<div class="empty"><h1>Something went wrong</h1><p>${esc(error.message)}</p></div>`;
  }
  if (token === renderToken) markCurrent();
}

async function showAlbums(token) {
  if (!cache.albums) view.innerHTML = '<p class="loading">Loading albums…</p>';
  const albums = await ensureAlbums();
  if (token !== renderToken) return;
  currentList = [];
  if (!albums.length) {
    clearGrid();
    view.innerHTML = emptyLibrary();
    setPageTitle('berrytone');
    return;
  }
  mountGrid({
    heading: `<header class="page-head"><div><h1>Albums</h1><p>${albums.length} in the library</p></div></header>`,
    items: albums,
    card: albumCard,
  });
  setPageTitle('Albums — berrytone');
}

async function showArtists(token) {
  if (!cache.artists) view.innerHTML = '<p class="loading">Loading artists…</p>';
  const artists = await ensureArtists();
  if (token !== renderToken) return;
  currentList = [];
  if (!artists.length) {
    clearGrid();
    view.innerHTML = emptyLibrary();
    setPageTitle('berrytone');
    return;
  }
  mountGrid({
    heading: `<header class="page-head"><div><h1>Artists</h1><p>${artists.length} in the library</p></div></header>`,
    items: artists,
    card: artistCard,
  });
  setPageTitle('Artists — berrytone');
}

async function showArtist(id, token) {
  view.innerHTML = '<p class="loading">Loading artist…</p>';
  const artist = await api(`/api/artists/${id}`);
  if (token !== renderToken) return;
  currentList = [];
  const portrait = artist.hasArt
    ? `<img alt="" src="/api/artist-art/${esc(artist.id)}?v=${Number(artist.artVersion) || 0}">`
    : '';
  const rescan = allowed('rescan')
    ? `<button type="button" class="ghost" data-action="rescan-folder" data-kind="artist" data-id="${esc(artist.id)}">Rescan folder</button>`
    : '';
  mountGrid({
    heading: `<header class="hero"><div class="cover" style="--h:${hueOf(artist.id)}">${portrait}<span class="fallback">${esc(monogram(artist.name))}</span></div><div class="hero-copy"><p class="kicker">Artist</p><h1>${esc(artist.name)}</h1><p>${artist.albumCount} albums · ${artist.trackCount} tracks</p><div class="actions">${rescan}${favButton('artist', artist.id, artist.starred)}</div></div></header>`,
    items: artist.albums,
    card: albumCard,
  });
  setPageTitle(`${artist.name} — berrytone`);
}

async function showAlbum(id, token) {
  view.innerHTML = '<p class="loading">Loading album…</p>';
  const album = await api(`/api/albums/${id}`);
  if (token !== renderToken) return;
  const playable = album.tracks.filter((track) => !track.missing);
  remember(playable);
  currentList = playable;
  const length = album.duration ? ` · ${formatTime(album.duration)}` : '';
  const missing = album.missingCount ? ` · ${album.missingCount} missing` : '';
  view.innerHTML = `
    <article class="hero">
      ${coverHtml(album.id, album.hasArt, album.artVersion, album.title)}
      <div class="hero-copy">
        <p class="kicker">Album</p>
        <h1>${esc(album.title)}</h1>
        <p>${allowed('artists') ? `<a href="/artist/${esc(album.artistId)}">${esc(album.artist)}</a>` : esc(album.artist)}${album.year ? ` · ${album.year}` : ''}${album.edition ? ` · ${esc(album.edition)}` : ''} · ${album.trackCount} tracks${missing}${length}</p>
        <div class="actions">
          <button type="button" class="primary" data-action="play-album">Play</button>
          <button type="button" class="ghost" data-action="shuffle-album">Shuffle</button>
          <button type="button" class="ghost" data-action="queue-album">Add to queue</button>
          ${allowed('playlists') ? `<button type="button" class="ghost" data-action="save-album" data-name="${esc(album.title)}">Save as playlist</button>` : ''}
          ${allowed('rescan') ? `<button type="button" class="ghost" data-action="rescan-folder" data-kind="album" data-id="${esc(album.id)}">Rescan folder</button>` : ''}
          ${album.missingCount && allowed('find') ? `<button type="button" class="ghost" data-action="add-find-album" data-album="${esc(album.id)}">Add missing to find list</button>` : ''}
          ${favButton('album', album.id, album.starred)}
          ${!latestStatus?.auth || latestStatus?.role === 'admin' ? `<div class="more-wrap">
            <button type="button" class="more-btn" data-action="album-menu" aria-label="Album actions" aria-haspopup="menu" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>
            </button>
            <div class="more-menu" role="menu" hidden>
              <button type="button" role="menuitem" data-action="merge-album" data-id="${esc(album.id)}" data-title="${esc(album.title)}">Merge another album</button>
            </div>
          </div>` : ''}
        </div>
        ${(album.merged || []).map((item) => `<div class="note">Includes songs from ${esc(item.title)}. <button type="button" class="linkish" data-action="separate-album" data-id="${esc(album.id)}" data-title="${esc(item.title)}">Separate</button></div>`).join('')}
      </div>
    </article>
    <div class="track-list">${trackRows(album.tracks, { compact: true, find: true })}</div>`;
  setPageTitle(`${album.title} — berrytone`);
}

async function showFolder(id, token) {
  view.innerHTML = '<p class="loading">Loading folder…</p>';
  const data = await api(id ? `/api/folders/${id}` : '/api/folders');
  if (token !== renderToken) return;
  remember(data.tracks);
  currentList = data.tracks.filter((track) => !track.missing);
  if (!data.folders.length && !data.tracks.length && (id || !data.download)) {
    view.innerHTML = '<div class="empty"><h1>This folder is empty</h1><p>Songs show up here in the same folders they have on disk.</p></div>';
    setPageTitle('Folders — berrytone');
    return;
  }
  const play = data.trackCount
    ? `<div class="actions"><button type="button" class="primary" data-action="play-folder" data-id="${esc(data.id || '')}">Play</button><button type="button" class="ghost" data-action="shuffle-folder" data-id="${esc(data.id || '')}">Shuffle</button></div>`
    : '';
  const folders = data.folders.length ? `<div class="folder-list">${data.folders.map(folderRow).join('')}</div>` : '';
  const tracks = data.tracks.length ? `<div class="track-list">${trackRows(data.tracks, { showAlbum: true })}</div>` : '';
  const download = !id && data.download && allowed('downloads')
    ? `<section class="section"><h2>Download</h2><div class="folder-list"><a class="folder" href="/downloads"><span class="folder-mark" aria-hidden="true"></span><span class="stack"><span class="title">download</span><span class="sub">Played here, kept out of the library</span></span></a></div></section>`
    : '';
  const libraryHead = !id && data.download && (data.folders.length || data.tracks.length) ? '<h2>Library</h2>' : '';
  view.innerHTML = `
    ${folderCrumbs(data)}
    <header class="page-head"><div><h1>${esc(data.name)}</h1><p>${data.trackCount} ${data.trackCount === 1 ? 'track' : 'tracks'}</p></div></header>
    ${download}${libraryHead}${play}${folders}${tracks}`;
  setPageTitle(id ? `${data.name} — berrytone` : 'Folders — berrytone');
}

function folderCrumbs(data) {
  if (!data.crumbs?.length) return '';
  const parts = ['<a href="/folders">Music</a>'];
  for (const crumb of data.crumbs) {
    const here = crumb.id === data.id;
    parts.push(here ? `<span>${esc(crumb.name)}</span>` : `<a href="/folder/${esc(crumb.id)}">${esc(crumb.name)}</a>`);
  }
  return `<nav class="crumbs" aria-label="Folder">${parts.join('<span class="crumb-sep" aria-hidden="true">/</span>')}</nav>`;
}

async function showDownloads(rel, token) {
  view.innerHTML = '<p class="loading">Loading download…</p>';
  const data = await api(downloadQuery(rel));
  if (token !== renderToken) return;
  remember(data.tracks);
  downloadPage = { path: data.path, items: data.tracks.slice(), total: data.total };
  currentList = downloadPage.items;
  paintDownloads(data);
  setPageTitle(rel ? `${data.name} — berrytone` : 'Downloads — berrytone');
}

function paintDownloads(data) {
  if (data.path) paintDownloadAlbum(data);
  else paintDownloadLibrary(data);
  markCurrent();
}

function paintDownloadLibrary(data) {
  const albums = data.folders.length
    ? `<div class="cards">${data.folders.map(downloadCard).join('')}</div>`
    : '';
  const songs = downloadPage.total ? downloadTrackSection('Songs') : '';
  const empty = !data.folders.length && !downloadPage.total
    ? '<div class="empty"><h1>Nothing downloaded</h1><p>Songs saved to the download folder show up here.</p></div>'
    : '';
  const count = data.folders.length ? `${data.folders.length} ${data.folders.length === 1 ? 'album' : 'albums'}` : '';
  const loose = downloadPage.total ? `${downloadPage.total} ${downloadPage.total === 1 ? 'song' : 'songs'}` : '';
  view.innerHTML = `
    <header class="page-head"><div><h1>Downloads</h1><p>${[count, loose].filter(Boolean).join(' · ') || 'Kept out of the library'}</p></div></header>
    ${albums}${songs}${empty}`;
}

function paintDownloadAlbum(data) {
  const more = downloadPage.items.length < downloadPage.total
    ? '<button type="button" class="more" data-action="load-more-downloads">Show more</button>'
    : '';
  const artist = downloadArtist(downloadPage.items);
  const length = downloadPage.items.length === downloadPage.total ? downloadLength(downloadPage.items) : '';
  const nested = data.folders.length ? `<div class="cards">${data.folders.map(downloadCard).join('')}</div>` : '';
  const tracks = downloadPage.items.length ? `<div class="track-list">${trackRows(downloadPage.items, { compact: true })}</div>` : '';
  const empty = !data.folders.length && !downloadPage.total ? '<p class="note">Nothing to play in this folder.</p>' : '';
  const play = `<div class="actions">
          ${downloadPage.total ? '<button type="button" class="primary" data-action="play-album">Play</button><button type="button" class="ghost" data-action="shuffle-album">Shuffle</button><button type="button" class="ghost" data-action="queue-album">Add to queue</button>' : ''}
          ${downloadMenu(data.path, data.name)}
        </div>`;
  view.innerHTML = `
    ${downloadCrumbs(data)}
    <article class="hero">
      ${downloadCover(data.name, data.path, data.hasArt)}
      <div class="hero-copy">
        <p class="kicker">Download</p>
        <h1>${esc(data.name)}</h1>
        <p>${artist ? `${esc(artist)} · ` : ''}${downloadPage.total} ${downloadPage.total === 1 ? 'track' : 'tracks'}${length}</p>
        ${play}
      </div>
    </article>
    ${nested}${tracks}${more}${empty}`;
}

function downloadMenu(folderPath, folderName) {
  if (latestStatus?.auth && latestStatus.role !== 'admin') return '';
  return `<div class="more-wrap">
    <button type="button" class="more-btn" data-action="album-menu" aria-label="Download actions" aria-haspopup="menu" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>
    </button>
    <div class="more-menu" role="menu" hidden>
      <button type="button" role="menuitem" data-action="album-download" data-path="${esc(folderPath || '')}" data-title="${esc(folderName || '')}">Make this folder an album</button>
    </div>
  </div>`;
}

function importSummary(saved) {
  const moved = saved.moved?.length || 0;
  const missing = (saved.skipped || []).filter((item) => item.reason === 'missing').length;
  const already = (saved.skipped || []).filter((item) => item.reason === 'already').length;
  const locked = (saved.skipped || []).some((item) => item.reason === 'locked');
  if (moved) return `${saved.moved[0].title || 'The song'} is in the library.`;
  if (missing) return 'This song stays in downloads because it has no artist or album.';
  if (already) return 'This song is already in the library.';
  if (locked) return 'The downloads folder could not be changed.';
  return 'This song could not be imported.';
}

function albumSummary(saved) {
  const moved = saved.moved?.length || 0;
  const title = saved.album || 'This album';
  const tags = (saved.skipped || []).filter((item) => item.reason === 'tags').length;
  const missing = (saved.skipped || []).filter((item) => item.reason === 'missing').length;
  const already = (saved.skipped || []).filter((item) => item.reason === 'already').length;
  const locked = (saved.skipped || []).some((item) => item.reason === 'locked');
  const parts = [];
  if (moved) parts.push(`Moved ${moved} ${moved === 1 ? 'song' : 'songs'} into ${title}`);
  if (tags) parts.push(`${tags} ${tags === 1 ? 'song stays' : 'songs stay'} in downloads because the tags could not be updated`);
  if (missing) parts.push(`${missing} ${missing === 1 ? 'song stays' : 'songs stay'} in downloads because ${missing === 1 ? 'it has' : 'they have'} no title`);
  if (already) parts.push(`${already} ${already === 1 ? 'song is' : 'songs are'} already in the library`);
  if (locked) parts.push('The downloads folder could not be changed');
  if (!parts.length) return 'Nothing in this folder could be made into an album';
  return `${parts.join('. ')}.`;
}

function downloadTrackSection(title) {
  const more = downloadPage.items.length < downloadPage.total
    ? '<button type="button" class="more" data-action="load-more-downloads">Show more</button>'
    : '';
  const play = `<div class="actions"><button type="button" class="primary" data-action="play-album">Play</button><button type="button" class="ghost" data-action="shuffle-album">Shuffle</button><button type="button" class="ghost" data-action="queue-album">Add to queue</button></div>`;
  return `<section class="section"><h2>${esc(title)}</h2>${play}<div class="track-list">${trackRows(downloadPage.items, { compact: true })}</div>${more}</section>`;
}

function downloadCard(folder) {
  const count = folder.trackCount === 1 ? '1 track' : `${Number(folder.trackCount) || 0} tracks`;
  return `<div class="card-wrap"><a class="card" href="${esc(downloadHref(folder.path))}">${downloadCover(folder.name, folder.path, folder.hasArt)}<span class="card-title">${esc(folder.name)}</span><span class="card-sub">${count}</span></a></div>`;
}

function downloadCover(name, rel, hasArt) {
  const hue = hueOf(rel || name);
  const img = hasArt ? `<img alt="" loading="lazy" decoding="async" src="/api/downloads/cover?path=${encodeURIComponent(rel || '')}">` : '';
  return `<div class="cover" style="--h:${hue}">${img}<span class="fallback">${esc(monogram(name))}</span></div>`;
}

function downloadArtist(tracks) {
  const names = [...new Set(tracks.map((track) => track.artist).filter(Boolean))];
  if (names.length === 1) return names[0];
  if (names.length > 1) return 'Various artists';
  return '';
}

function downloadLength(tracks) {
  const seconds = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  return seconds > 0 ? ` · ${formatTime(seconds)}` : '';
}

function downloadQuery(rel, extra = {}) {
  const params = new URLSearchParams();
  if (rel) params.set('path', rel);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return `/api/downloads${query ? `?${query}` : ''}`;
}

function downloadHref(rel) {
  if (!rel) return '/downloads';
  return `/downloads/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function downloadCrumbs(data) {
  const parts = ['<a href="/downloads">Downloads</a>'];
  for (const crumb of data.crumbs || []) {
    const here = crumb.path === data.path;
    parts.push(here ? `<span>${esc(crumb.name)}</span>` : `<a href="${esc(downloadHref(crumb.path))}">${esc(crumb.name)}</a>`);
  }
  return `<nav class="crumbs" aria-label="Folder">${parts.join('<span class="crumb-sep" aria-hidden="true">/</span>')}</nav>`;
}

function folderRow(folder) {
  const count = folder.trackCount === 1 ? '1 track' : `${folder.trackCount} tracks`;
  return `<a class="folder" href="/folder/${esc(folder.id)}"><span class="folder-mark" aria-hidden="true"></span><span class="stack"><span class="title">${esc(folder.name)}</span><span class="sub">${count}</span></span></a>`;
}

async function showTracks(token) {
  view.innerHTML = '<p class="loading">Loading tracks…</p>';
  const page = await api('/api/tracks?offset=0&limit=200');
  if (token !== renderToken) return;
  remember(page.tracks);
  trackPage = { items: page.tracks.slice(), total: page.total };
  currentList = trackPage.items;
  paintTracks();
  setPageTitle('Tracks — berrytone');
}

function paintTracks() {
  const more = trackPage.items.length < trackPage.total
    ? `<button type="button" class="more" data-action="load-more">Show more</button>`
    : '';
  view.innerHTML = `<header class="page-head"><div><h1>Tracks</h1><p>${trackPage.total} in the library</p></div></header><div class="track-list">${trackRows(trackPage.items, { showAlbum: true })}</div>${more}`;
  markCurrent();
}

async function showSearch(query, token) {
  if (!query) {
    navigate('/');
    return;
  }
  view.innerHTML = '<p class="loading">Searching…</p>';
  const result = await api(`/api/search?q=${encodeURIComponent(query)}`);
  if (token !== renderToken) return;
  remember(result.tracks);
  currentList = result.tracks;
  if (!result.artists.length && !result.albums.length && !result.tracks.length) {
    view.innerHTML = `<div class="empty"><h1>No matches</h1><p>Nothing in the library matches “${esc(query)}”.</p></div>`;
    setPageTitle('Search — berrytone');
    return;
  }
  const artists = result.artists.length ? `<section class="section"><h2>Artists</h2><div class="cards">${result.artists.map(artistCard).join('')}</div></section>` : '';
  const albums = result.albums.length ? `<section class="section"><h2>Albums</h2><div class="cards">${result.albums.map(albumCard).join('')}</div></section>` : '';
  const tracks = result.tracks.length ? `<section class="section"><h2>Tracks</h2><div class="track-list">${trackRows(result.tracks, { showAlbum: true })}</div></section>` : '';
  view.innerHTML = `<header class="page-head"><div><h1>Search</h1><p>Results for “${esc(query)}”</p></div></header>${artists}${albums}${tracks}`;
  setPageTitle(`Search — berrytone`);
}

async function addPerson(form) {
  const body = {
    username: form.username.value,
    password: form.password.value,
    role: form.role.value,
  };
  try {
    await api('/api/admin/users', { method: 'POST', body });
    form.reset();
    show(parseRoute());
  } catch (error) {
    toast(error.message);
  }
}

async function saveFanart(form) {
  const key = form.fanart.value.trim();
  if (!key) {
    toast('Paste a Fanart key first');
    return;
  }
  try {
    await api('/api/admin/settings', { method: 'POST', body: { fanartApiKey: key } });
    form.reset();
    toast('Fanart key saved');
    show(parseRoute());
  } catch (error) {
    toast(error.message);
  }
}

async function showAdmin(token) {
  view.innerHTML = '<p class="loading">Loading settings…</p>';
  const data = await api('/api/admin');
  if (token !== renderToken) return;
  const fanart = data.fanart || { set: false, hint: '' };
  const people = data.users.map((user) => `
    <form class="person">
      <strong>${esc(user.username)}</strong>
      <select data-role="${esc(user.id)}" data-current="${esc(user.role)}" aria-label="Role for ${esc(user.username)}">
        <option value="user"${user.role === 'user' ? ' selected' : ''}>User</option>
        <option value="admin"${user.role === 'admin' ? ' selected' : ''}>Admin</option>
      </select>
      <input data-password="${esc(user.id)}" type="password" autocomplete="new-password" placeholder="New password" maxlength="200" aria-label="New password for ${esc(user.username)}">
      <button type="button" class="ghost" data-action="save-password" data-id="${esc(user.id)}">Save password</button>
      <button type="button" class="ghost" data-action="delete-person" data-id="${esc(user.id)}">Remove</button>
    </form>`).join('');
  const features = data.features.map((feature) => `
    <label class="feature-row">
      <span><strong>${esc(feature.label)}</strong><small>${esc(feature.detail)}</small></span>
      <input type="checkbox" data-feature="${esc(feature.key)}"${feature.enabled ? ' checked' : ''} aria-label="${esc(feature.label)}">
    </label>`).join('');
  view.innerHTML = `
    <header class="page-head"><div><h1>Settings</h1><p>People, what they can use, and keys for outside services. Admins keep every feature. The switches apply to everyone else.</p></div></header>
    <section class="section">
      <h2>Fanart.tv</h2>
      <p class="note">${fanart.set ? `A key is saved, ending in ${esc(fanart.hint)}. Paste a new one to replace it.` : 'No key saved. A personal key is free from fanart.tv and unlocks artist pictures.'}</p>
      <p class="note">Find photos looks up artists that have not been checked, then it stops. Artists already checked stay as they are.</p>
      <form id="fanart-form" class="settings-key">
        <input name="fanart" type="password" maxlength="80" autocomplete="off" spellcheck="false" placeholder="Personal API key" aria-label="Fanart.tv API key">
        <button class="primary" type="submit">Save key</button>
        ${fanart.set ? '<button type="button" class="ghost" data-action="clear-fanart">Clear key</button>' : ''}
        <button type="button" class="ghost" data-action="find-photos"${fanart.set ? '' : ' disabled'}>Find photos</button>
      </form>
    </section>
    <section class="section">
      <h2>People</h2>
      <p class="note">These names sign in here and in Amperfy. Favourites and playlists are shared.</p>
      <form id="people-form" class="people-form">
        <input name="username" required maxlength="40" placeholder="Username" autocomplete="off" aria-label="Username">
        <input name="password" required minlength="8" maxlength="200" type="password" placeholder="Password" autocomplete="new-password" aria-label="Password">
        <select name="role" aria-label="Role"><option value="user">User</option><option value="admin">Admin</option></select>
        <button class="primary" type="submit">Add person</button>
      </form>
      <div class="people">${people}</div>
    </section>
    <section class="section">
      <h2>Features for users</h2>
      <div class="feature-list">${features}</div>
    </section>`;
  setPageTitle('Settings — berrytone');
}

async function loadSonos(refresh) {
  sonosOpen = true;
  sonosPanel.hidden = false;
  sonosToggle.setAttribute('aria-expanded', 'true');
  sonosBody.innerHTML = '<p class="note">Looking for speakers…</p>';
  if (sonosControls) sonosControls.hidden = true;
  try {
    const data = await api(`/api/sonos/rooms${refresh ? '?refresh=1' : ''}`);
    sonosRooms = data.rooms || [];
    paintSonos();
  } catch (error) {
    sonosBody.innerHTML = `<p class="note">${esc(error.message)}</p>`;
  }
}

function paintSonos() {
  if (!sonosOpen) return;
  sonosBody.innerHTML = sonosRooms.length
    ? `<div class="sonos-list">${sonosRooms.map((room) => {
        const on = room.id === sonosRoom;
        return `<button type="button" class="ghost${on ? ' is-on' : ''}" data-action="sonos-play" data-room="${esc(room.id)}" aria-pressed="${on}">${esc(room.name)}</button>`;
      }).join('')}</div>`
    : '<p class="note">No Sonos speakers answered. They need to be on this network.</p>';
  if (sonosControls) {
    sonosControls.hidden = !sonosRoom;
    sonosControls.innerHTML = sonosRoom
      ? `<button type="button" class="icon-btn" data-action="sonos-prev" aria-label="Previous on Sonos">${ICONS.prev}</button>
        <button type="button" class="icon-btn sonos-play" data-action="sonos-toggle" aria-pressed="false" aria-label="Play on Sonos">${ICONS.play}</button>
        <button type="button" class="icon-btn" data-action="sonos-stop" aria-label="Stop Sonos">${ICONS.stop}</button>
        <button type="button" class="icon-btn" data-action="sonos-next" aria-label="Next on Sonos">${ICONS.next}</button>
        <input id="sonos-volume" class="sonos-volume" type="range" min="0" max="100" value="20" aria-label="Sonos volume">`
      : '';
    paintSonosToggle();
  }
  if (sonosRoom) refreshSonosState();
}

function paintSonosToggle() {
  const toggle = sonosControls?.querySelector('[data-action="sonos-toggle"]');
  if (!toggle) return;
  toggle.innerHTML = sonosPlaying ? ICONS.pause : ICONS.play;
  toggle.setAttribute('aria-label', sonosPlaying ? 'Pause Sonos' : 'Play on Sonos');
  toggle.setAttribute('aria-pressed', String(sonosPlaying));
}

function closeSonos() {
  sonosOpen = false;
  if (sonosPanel) sonosPanel.hidden = true;
  sonosToggle?.setAttribute('aria-expanded', 'false');
  clearTimeout(sonosTimer);
}

async function playOnSonos(roomId, button) {
  const tracks = queue.items.slice(Math.max(0, queue.index), Math.max(0, queue.index) + 40).map((track) => ({
    id: track.id,
    source: track.source || '',
    relPath: track.relPath || '',
    title: track.title || '',
  }));
  if (!tracks.length) {
    toast('Play a song here first, then send it to the speaker');
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await api('/api/sonos/play', { method: 'POST', body: { roomId, tracks } });
    audio.pause();
    updatePlayer();
    sonosRoom = roomId;
    sonosPlaying = true;
    toast(`Playing ${result.count} ${result.count === 1 ? 'song' : 'songs'} on ${result.room}`);
    paintSonos();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshSonosState() {
  clearTimeout(sonosTimer);
  if (!sonosOpen || !sonosRoom) return;
  try {
    const state = await api(`/api/sonos/state?room=${encodeURIComponent(sonosRoom)}`);
    sonosPlaying = Boolean(state.playing);
    paintSonosToggle();
    const slider = document.querySelector('#sonos-volume');
    if (slider && document.activeElement !== slider && state.volume != null) slider.value = String(state.volume);
  } catch {
    /* The room list already says when a speaker cannot be found. */
  }
  sonosTimer = window.setTimeout(refreshSonosState, 4000);
}

async function onAction(button) {
  const action = button.dataset.action;
  if (action === 'sonos-play') {
    await playOnSonos(button.dataset.room, button);
    return;
  }
  if (action === 'sonos-toggle' || action === 'sonos-stop' || action === 'sonos-next' || action === 'sonos-prev') {
    const command = action === 'sonos-toggle'
      ? (sonosPlaying ? 'pause' : 'play')
      : { 'sonos-stop': 'stop', 'sonos-next': 'next', 'sonos-prev': 'previous' }[action];
    if (action === 'sonos-toggle') sonosPlaying = !sonosPlaying;
    if (action === 'sonos-stop') sonosPlaying = false;
    paintSonosToggle();
    try {
      await api('/api/sonos/transport', { method: 'POST', body: { roomId: sonosRoom, action: command } });
      refreshSonosState();
    } catch (error) {
      toast(error.message);
      refreshSonosState();
    }
    return;
  }
  if (action === 'find-photos') {
    button.disabled = true;
    try {
      const result = await api('/api/artist-photos', { method: 'POST' });
      if (result.pending === 0) button.disabled = false;
      toast(result.pending === 0 ? 'No unchecked artists' : 'Looking up artists that have not been checked');
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
    return;
  }
  if (action === 'clear-fanart') {
    try {
      await api('/api/admin/settings', { method: 'POST', body: { fanartApiKey: '' } });
      toast('Fanart key cleared');
      show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'save-password') {
    const input = document.querySelector(`[data-password="${button.dataset.id}"]`);
    try {
      await api(`/api/admin/users/${button.dataset.id}`, { method: 'POST', body: { password: input?.value || '' } });
      if (input) input.value = '';
      toast('Password saved');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'delete-person') {
    const ok = await askConfirm({ title: 'Remove this person?', message: 'They will no longer be able to sign in.', confirm: 'Remove' });
    if (!ok) return;
    try {
      await api(`/api/admin/users/${button.dataset.id}`, { method: 'DELETE' });
      show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'play-track') {
    const index = currentList.findIndex((track) => track.id === button.dataset.id);
    if (index >= 0) setQueue(currentList, index);
    else if (known.has(button.dataset.id)) setQueue([known.get(button.dataset.id)], 0);
    return;
  }
  if (action === 'delete-track') {
    const yes = await askConfirm({
      title: 'Delete this song?',
      message: `${button.dataset.title} is removed from the music folder and leaves the library.`,
      confirm: 'Delete',
    });
    if (!yes) return;
    try {
      await api(`/api/tracks/${button.dataset.id}`, { method: 'DELETE' });
      document.querySelector('#track-info')?.close();
      dropTrack(button.dataset.id);
      toast(`${button.dataset.title} was deleted`);
      show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'track-info') {
    button.disabled = true;
    try {
      const info = button.dataset.source === 'download'
        ? await api(`/api/downloads/info?path=${encodeURIComponent(button.dataset.path || '')}`)
        : await api(`/api/tracks/${button.dataset.id}/info`);
      openTrackInfo(info);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (action === 'play-album') {
    if (currentList.length) setQueue(currentList, 0);
    return;
  }
  if (action === 'shuffle-album') {
    if (!currentList.length) return;
    queue.shuffle = true;
    setQueue(currentList, 0, { shuffle: true });
    return;
  }
  if (action === 'queue-album') {
    addToQueue(currentList);
    return;
  }
  if (action === 'show-more') {
    revealMore();
    return;
  }
  if (action === 'load-more-downloads') {
    button.disabled = true;
    const route = parseRoute();
    const page = await api(downloadQuery(route.path, { offset: String(downloadPage.items.length), limit: '200' }));
    if (parseRoute().name !== 'downloads') return;
    remember(page.tracks);
    downloadPage.items.push(...page.tracks);
    downloadPage.total = page.total;
    currentList = downloadPage.items;
    paintDownloads(page);
    return;
  }
  if (action === 'load-more') {
    button.disabled = true;
    const page = await api(`/api/tracks?offset=${trackPage.items.length}&limit=200`);
    if (parseRoute().name !== 'tracks') return;
    remember(page.tracks);
    trackPage.items.push(...page.tracks);
    trackPage.total = page.total;
    currentList = trackPage.items;
    paintTracks();
    return;
  }
  if (action === 'queue-play') {
    playIndex(Number(button.dataset.index), { remember: true });
    return;
  }
  if (action === 'queue-remove') removeFromQueue(Number(button.dataset.index));
  if (action === 'star') {
    const on = button.getAttribute('aria-pressed') !== 'true';
    const saved = await api('/api/favourites', { method: 'POST', body: { kind: button.dataset.kind, id: button.dataset.id, on } });
    paintFav(button, saved.starred);
    rememberStar(saved.kind, saved.id, saved.starred);
    toast(saved.starred ? 'Added to favourites' : 'Removed from favourites');
    if (parseRoute().name === 'favourites') show(parseRoute());
    return;
  }
  if (action === 'play-folder' || action === 'shuffle-folder') {
    const data = button.dataset.source === 'download'
      ? await api(`/api/downloads/tracks${button.dataset.path ? `?path=${encodeURIComponent(button.dataset.path)}` : ''}`)
      : await api(button.dataset.id ? `/api/folders/${button.dataset.id}/tracks` : '/api/folders/tracks');
    remember(data.tracks);
    if (action === 'shuffle-folder') queue.shuffle = true;
    if (data.tracks.length) setQueue(data.tracks, 0, { shuffle: action === 'shuffle-folder' });
    return;
  }
  if (action === 'separate-album') {
    const yes = await askConfirm({
      title: 'Separate this album?',
      message: `${button.dataset.title} goes back to its own album. The files stay where they are.`,
      confirm: 'Separate',
    });
    if (!yes) return;
    try {
      await api(`/api/albums/${button.dataset.id}/separate`, { method: 'POST', body: { title: button.dataset.title } });
      toast(`${button.dataset.title} is its own album again`);
      if (parseRoute().name === 'album') show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'album-menu') {
    const menu = button.parentElement?.querySelector('.more-menu');
    if (!menu) return;
    const open = menu.hidden;
    closeAlbumMenus();
    menu.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    return;
  }
  if (action === 'import-download') {
    const title = button.dataset.title || 'This song';
    const yes = await askConfirm({
      title: 'Import into the library?',
      message: `${title} is moved into the music folder when it has an artist and an album. The file is named from its tags.`,
      confirm: 'Import',
    });
    if (!yes) return;
    try {
      const saved = await api('/api/downloads/import', { method: 'POST', body: { path: button.dataset.path || '' } });
      toast(importSummary(saved));
      document.querySelector('#track-info')?.close();
      if (saved.moved?.length) dropDownload(button.dataset.path || '');
      if (parseRoute().name === 'downloads') show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'album-download') {
    closeAlbumMenus();
    const title = button.dataset.title || 'This folder';
    const yes = await askConfirm({
      title: 'Make this folder an album?',
      message: `${title} becomes a compilation in the library. Each song is tagged with this album and Various Artists, then moved into the music folder so the songs stay together.`,
      confirm: 'Make album',
    });
    if (!yes) return;
    try {
      const saved = await api('/api/downloads/album', { method: 'POST', body: { path: button.dataset.path || '' } });
      toast(albumSummary(saved));
      if (saved.moved?.length) dropDownloadFolder(button.dataset.path || '');
      if (parseRoute().name === 'downloads') show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'merge-album') {
    closeAlbumMenus();
    let choices;
    try {
      choices = await api(`/api/albums/${button.dataset.id}/merge`);
    } catch (error) {
      toast(error.message);
      return;
    }
    if (!choices.albums.length) {
      toast('This artist has no other album to merge');
      return;
    }
    const picked = await askMerge({ title: button.dataset.title, albums: choices.albums });
    if (!picked) return;
    const other = choices.albums.find((item) => item.id === picked);
    const yes = await askConfirm({
      title: 'Merge these albums?',
      message: `Add the songs from ${other?.title || 'that album'} to ${button.dataset.title}. ${other?.title || 'That album'} leaves the album list. The files stay in their folders and the tags are left as they are.`,
      confirm: 'Merge',
    });
    if (!yes) return;
    try {
      await api(`/api/albums/${button.dataset.id}/merge`, { method: 'POST', body: { albumId: picked } });
      toast(`Songs from ${other?.title || 'that album'} are now on ${button.dataset.title}`);
      if (parseRoute().name === 'album') show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'add-find' || action === 'add-find-album') {
    const saved = await api('/api/finds', {
      method: 'POST',
      body: { albumId: button.dataset.album, ...(button.dataset.id ? { slotId: button.dataset.id } : {}) },
    });
    toast(saved.added ? `Added ${saved.added} ${saved.added === 1 ? 'song' : 'songs'} to find music` : 'Already on the find list');
    if (parseRoute().name === 'album') show(parseRoute());
    return;
  }
  if (action === 'search-find') {
    button.disabled = true;
    button.textContent = 'Finding…';
    try {
      await api(`/api/finds/${button.dataset.id}/search`, { method: 'POST', body: {} });
      toast('YouTube pages saved');
      if (parseRoute().name === 'find') show(parseRoute());
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Find';
      toast(error.message);
    }
    return;
  }
  if (action === 'search-all-finds') {
    button.disabled = true;
    button.textContent = 'Finding…';
    try {
      const saved = await api('/api/finds/search-all', { method: 'POST', body: {} });
      const host = document.querySelector('#find-results');
      if (host && parseRoute().name === 'find') {
        host.innerHTML = saved.items.length
          ? `<div class="find-list">${saved.items.map(findItem).join('')}</div>`
          : '<p class="note">No songs are waiting.</p>';
      }
      const problem = saved.failed ? ` ${saved.failed} could not be searched.` : '';
      toast(`Found links for ${saved.found} ${saved.found === 1 ? 'song' : 'songs'}.${problem}`);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Find all';
    }
    return;
  }
  if (action === 'add-find-link') {
    const input = document.querySelector(`[data-find-url="${CSS.escape(button.dataset.id)}"]`);
    button.disabled = true;
    try {
      const saved = await api(`/api/finds/${button.dataset.id}/link`, { method: 'POST', body: { url: input?.value || '' } });
      const article = button.closest('.find-item');
      if (article) article.outerHTML = findItem(saved);
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
    return;
  }
  if (action === 'preview-playlist') {
    const input = document.querySelector('#playlist-url');
    button.disabled = true;
    button.textContent = 'Matching…';
    try {
      playlistPreview = await api('/api/finds/playlist', { method: 'POST', body: { url: input?.value || '' } });
      playlistPreview.source = input?.value || '';
      playlistPreview.albumId = playlistPreview.matches[0]?.id || 'new';
      const host = document.querySelector('#playlist-match');
      if (host) host.innerHTML = playlistMatchHtml();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Match album';
    }
    return;
  }
  if (action === 'clear-playlist') {
    playlistPreview = null;
    const host = document.querySelector('#playlist-match');
    if (host) host.replaceChildren();
    const input = document.querySelector('#playlist-url');
    if (input) input.value = '';
    return;
  }
  if (action === 'download-playlist') {
    const boxes = [...document.querySelectorAll('[data-playlist-video]:checked')];
    if (!boxes.length) {
      toast('Choose the songs to download');
      return;
    }
    let albumId = document.querySelector('input[name="playlist-album"]:checked')?.value || 'new';
    const startedNew = albumId === 'new';
    const artist = document.querySelector('#playlist-artist')?.value || (startedNew ? (playlistPreview?.artist || playlistPreview?.author || '') : '');
    const albumName = document.querySelector('#playlist-name')?.value || (startedNew ? (playlistPreview?.album || playlistPreview?.title || '') : '');
    button.disabled = true;
    const finished = [];
    for (const [index, box] of boxes.entries()) {
      const row = box.closest('.playlist-row');
      const state = row?.querySelector('.playlist-state');
      row?.classList.add('is-downloading');
      if (state) state.innerHTML = '<span class="download-label">Starting</span><span class="download-bar is-busy"><span></span></span>';
      downloadPlace = { index: index + 1, total: boxes.length };
      paintDownload({ title: box.dataset.title || 'This song', album: '', phase: 'download', percent: 0 });
      try {
        const saved = await api('/api/finds/playlist/download', {
          method: 'POST',
          body: {
            albumId: albumId === 'new' ? '' : albumId,
            artist,
            album: albumName,
            url: box.dataset.url,
            title: box.dataset.title,
            track: Number(box.dataset.track),
          },
        });
        if (saved.albumId && albumId === 'new') albumId = saved.albumId;
        row?.classList.remove('is-downloading');
        if (state) state.textContent = saved.skipped ? 'Already in the library' : 'Saved';
        box.checked = false;
        box.disabled = true;
        finished.push(box.dataset.url);
      } catch (error) {
        row?.classList.remove('is-downloading');
        if (state) state.textContent = error.message;
      }
    }
    downloadPlace = null;
    paintDownload(null);
    if (playlistPreview && finished.length) {
      if (startedNew) {
        playlistPreview.finished = [...new Set([...(playlistPreview.finished || []), ...finished])];
      } else {
        const match = playlistPreview.matches?.find((item) => item.id === albumId);
        if (match) match.missing = match.missing.filter((url) => !finished.includes(url));
        for (const url of finished) {
          const done = [...document.querySelectorAll('[data-playlist-video]')].find((item) => item.dataset.url === url);
          done?.closest('.playlist-row')?.remove();
        }
        const songs = document.querySelector('.playlist-songs');
        if (songs && !songs.querySelector('.playlist-row')) {
          songs.innerHTML = `<p class="note">${playlistPreview?.single ? 'This song is already on that album.' : 'Every song in this playlist is already on that album.'}</p>`;
        }
      }
    }
    if (!document.querySelector('[data-playlist-video]:checked')) button.remove();
    else button.disabled = false;
    toast('Playlist download finished');
    return;
  }
  if (action === 'download-find') {
    const article = button.closest('.find-item');
    button.disabled = true;
    button.textContent = 'Downloading…';
    article?.classList.add('is-downloading');
    downloadPlace = { index: 1, total: 1 };
    paintFindStatus(article, 'Starting the download', 'pending');
    paintDownload({ title: article?.querySelector('h2')?.textContent || 'This song', album: '', phase: 'download', percent: 0 });
    try {
      const saved = await api(`/api/finds/${button.dataset.id}/download`, { method: 'POST', body: { url: button.dataset.url } });
      article?.remove();
      if (parseRoute().name === 'find' && !view.querySelector('.find-item')) {
        const host = document.querySelector('#find-results');
        if (host) host.innerHTML = '<p class="note">No songs are waiting.</p>';
      }
      toast(saved.path ? `Saved ${saved.title} into ${saved.album}` : `${saved.title} is already in the library`);
    } catch (error) {
      if (article?.isConnected) {
        article.classList.remove('is-downloading');
        paintFindStatus(article, error.message, 'error');
        button.disabled = false;
        button.textContent = 'Download';
      }
    } finally {
      downloadPlace = null;
      paintDownload(latestStatus?.download || null);
    }
    return;
  }
  if (action === 'rescan-folder') {
    button.disabled = true;
    const body = button.dataset.kind === 'artist'
      ? { artistId: button.dataset.id }
      : { albumId: button.dataset.id };
    try {
      await api('/api/rescan', { method: 'POST', body });
      toast('Looking through the artist folder');
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
    return;
  }
  if (action === 'remove-find') {
    const article = button.closest('.find-item');
    try {
      await api(`/api/finds/${button.dataset.id}`, { method: 'DELETE' });
      article?.remove();
      if (parseRoute().name === 'find' && !view.querySelector('.find-item')) {
        const host = document.querySelector('#find-results');
        if (host) host.innerHTML = '<p class="note">No songs are waiting.</p>';
      }
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'play-favourites') {
    if (currentList.length) setQueue(currentList, 0);
    return;
  }
  if (action === 'save-album') {
    await savePlaylist(button.dataset.name || 'Playlist', currentList.map((track) => track.id));
    return;
  }
  if (action === 'save-queue') {
    const name = document.querySelector('#playlist-name')?.value || '';
    await savePlaylist(name, queue.items.map((track) => track.id));
    return;
  }
  if (action === 'play-playlist') {
    const playlist = await api(`/api/playlists/${button.dataset.id}`);
    remember(playlist.tracks);
    if (playlist.tracks.length) setQueue(playlist.tracks, 0);
    return;
  }
  if (action === 'delete-playlist') {
    const ok = await askConfirm({ title: 'Delete this playlist?', message: 'The songs stay in the library.', confirm: 'Delete' });
    if (!ok) return;
    try {
      await api(`/api/playlists/${button.dataset.id}`, { method: 'DELETE' });
      toast('Playlist deleted');
      if (parseRoute().name === 'playlist') navigate('/playlists');
      else show(parseRoute());
    } catch (error) {
      toast(error.message);
    }
  }
}

async function showFavourites(token) {
  view.innerHTML = '<p class="loading">Loading favourites…</p>';
  const data = await api('/api/favourites');
  if (token !== renderToken) return;
  remember(data.tracks);
  currentList = data.tracks.filter((track) => !track.missing);
  if (!data.artists.length && !data.albums.length && !data.tracks.length) {
    view.innerHTML = '<div class="empty"><h1>No favourites yet</h1><p>Hearts you tap here show up as favourites in Amperfy, and hearts you tap there show up here.</p></div>';
    setPageTitle('Favourites — berrytone');
    return;
  }
  const artists = data.artists.length ? `<section class="section"><h2>Artists</h2><div class="cards">${data.artists.map(artistCard).join('')}</div></section>` : '';
  const albums = data.albums.length ? `<section class="section"><h2>Albums</h2><div class="cards">${data.albums.map(albumCard).join('')}</div></section>` : '';
  const tracks = data.tracks.length ? `<section class="section"><h2>Tracks</h2><div class="track-list">${trackRows(data.tracks, { showAlbum: true })}</div></section>` : '';
  view.innerHTML = `
    <header class="page-head"><div><h1>Favourites</h1><p>Shared with Amperfy</p></div></header>
    <div class="actions"><button type="button" class="primary" data-action="play-favourites">Play tracks</button></div>
    ${artists}${albums}${tracks}`;
  setPageTitle('Favourites — berrytone');
}

async function showFind(token) {
  view.innerHTML = '<p class="loading">Loading find music…</p>';
  const data = await api('/api/finds');
  if (token !== renderToken) return;
  currentList = [];
  const results = data.items.length
    ? `<div class="find-list">${data.items.map(findItem).join('')}</div>`
    : '<p class="note">No songs are waiting. Add a missing song from an album, or paste a YouTube song or playlist link.</p>';
  view.innerHTML = `
    <header class="page-head">
      <div><h1>Find music</h1><p>Find searches YouTube. Download saves that video into the album folder. Paste a single song or a playlist link, then choose the album to save it on.</p></div>
      <button type="button" class="primary" data-action="search-all-finds"${data.items.length ? '' : ' disabled'}>Find all</button>
    </header>
    <div id="find-progress" class="download-card" hidden>
      <div>
        <strong class="download-title"></strong>
        <p class="download-detail"></p>
      </div>
      <div class="download-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Download progress"><span></span></div>
    </div>
    <section class="find-tools">
      <div class="playlist-bar">
        <label class="sr" for="playlist-url">YouTube song or playlist</label>
        <input id="playlist-url" type="url" placeholder="YouTube song or playlist link" value="${esc(playlistPreview?.source || '')}">
        <button type="button" class="ghost" data-action="preview-playlist">Match album</button>
      </div>
      <div id="playlist-match">${playlistMatchHtml()}</div>
    </section>
    <div id="find-results">${results}</div>`;
  paintDownload(latestStatus?.download || null);
  setPageTitle('Find music — berrytone');
}

function playlistMatchHtml() {
  const preview = playlistPreview;
  if (!preview?.videos) return '';
  const selected = preview.albumId || preview.matches?.[0]?.id || 'new';
  const choices = [
    ...(preview.matches || []).map((match) => ({ id: match.id, label: `${match.artist} — ${match.title}` })),
    { id: 'new', label: 'New album' },
  ].map((choice) => `
    <label class="playlist-album">
      <span>${esc(choice.label)}</span>
      <input type="radio" name="playlist-album" value="${esc(choice.id)}"${choice.id === selected ? ' checked' : ''}>
    </label>`).join('');
  const match = (preview.matches || []).find((item) => item.id === selected);
  const missing = new Set(selected === 'new' ? preview.videos.map((video) => video.url) : (match?.missing || []));
  const done = new Set(selected === 'new' ? (preview.finished || []) : []);
  const rows = preview.videos.filter((video) => missing.has(video.url)).map((video) => {
    const extra = video.label && video.label !== video.title ? `<span class="sub">${esc(video.label)}</span>` : '';
    const saved = done.has(video.url);
    return `
    <label class="playlist-row">
      <span class="stack"><span class="title">${esc(video.title)}</span>${extra}</span>
      <span class="playlist-state">${saved ? 'Saved' : ''}</span>
      <input type="checkbox" data-playlist-video ${saved ? 'disabled' : 'checked'} data-url="${esc(video.url)}" data-title="${esc(video.title)}" data-track="${video.track}">
    </label>`;
  }).join('');
  const pending = preview.videos.some((video) => missing.has(video.url) && !done.has(video.url));
  const fresh = selected === 'new'
    ? `<div class="playlist-new"><label>Artist<input id="playlist-artist" value="${esc(preview.artist || preview.author || '')}"></label><label>Album<input id="playlist-name" value="${esc(preview.album || preview.title || '')}"></label></div>`
    : '';
  const note = preview.single
    ? '<p class="note">One song. Choose an album, or name a new one.</p>'
    : (preview.truncated ? '<p class="note">Showing the first 100 videos from the playlist.</p>' : '');
  const doneNote = preview.single ? 'This song is already on that album.' : 'Every song in this playlist is already on that album.';
  return `
    <div class="playlist-match">
      <div class="playlist-head">
        <p><strong>${esc(preview.title || (preview.single ? 'Song' : 'Playlist'))}</strong>${preview.author ? ` · ${esc(preview.author)}` : ''}</p>
        <button type="button" class="ghost" data-action="clear-playlist">Remove</button>
      </div>
      <div class="playlist-albums" role="radiogroup" aria-label="Album">${choices}</div>
      ${fresh}
      ${note}
      <div class="playlist-songs">${rows || `<p class="note">${doneNote}</p>`}</div>
      ${pending ? '<button type="button" class="primary" data-action="download-playlist">Download selected</button>' : ''}
    </div>`;
}

function closeAlbumMenus() {
  for (const menu of document.querySelectorAll('.more-menu')) {
    menu.hidden = true;
    menu.parentElement?.querySelector('.more-btn')?.setAttribute('aria-expanded', 'false');
  }
}

function askMerge({ title, albums }) {
  const dialog = document.querySelector('#merge');
  document.querySelector('#merge-title').textContent = 'Merge another album';
  document.querySelector('#merge-note').textContent = `Pick an album by the same artist. Its songs are added to ${title}.`;
  document.querySelector('#merge-list').innerHTML = albums.map((album, index) => `
    <label class="merge-row">
      <span><strong>${esc(album.title)}</strong><small>${album.year ? `${album.year} · ` : ''}${album.trackCount} in the library</small></span>
      <input type="radio" name="merge-album" value="${esc(album.id)}"${index === 0 ? ' checked' : ''}>
    </label>`).join('');
  return new Promise((resolve) => {
    const finish = () => {
      dialog.removeEventListener('close', finish);
      const chosen = dialog.returnValue === 'ok'
        ? document.querySelector('#merge-list input:checked')?.value || ''
        : '';
      resolve(chosen);
    };
    dialog.addEventListener('close', finish);
    dialog.showModal();
  });
}

function askConfirm({ title, message, confirm }) {
  const dialog = document.querySelector('#confirm');
  document.querySelector('#confirm-title').textContent = title;
  document.querySelector('#confirm-message').textContent = message;
  const ok = document.querySelector('#confirm-ok');
  ok.textContent = confirm;
  return new Promise((resolve) => {
    const finish = () => {
      dialog.removeEventListener('close', finish);
      resolve(dialog.returnValue === 'ok');
    };
    dialog.addEventListener('close', finish);
    dialog.showModal();
  });
}

function findItem(item) {
  const album = item.albumId ? `<a href="/album/${esc(item.albumId)}">${esc(item.album)}</a>` : esc(item.album);
  const links = item.links.length
    ? `<div class="find-links">${item.links.map((link) => findLink(item, link)).join('')}</div>`
    : '<p class="note">No YouTube pages saved yet.</p>';
  const library = item.inLibrary ? '<p class="found-note">This song is in the library now.</p>' : '';
  const status = item.status ? `<p class="find-status">${esc(item.status)}</p>` : '';
  return `<article class="find-item">
    <div class="find-head">
      <div><h2>${esc(item.title)}</h2><p>${esc(item.artist)} · ${album}</p>${library}${status}</div>
      <div class="actions">
        <button type="button" class="primary" data-action="search-find" data-id="${esc(item.id)}">Find</button>
        <button type="button" class="ghost" data-action="remove-find" data-id="${esc(item.id)}">Remove</button>
      </div>
    </div>
    ${links}
    <div class="find-url">
      <label class="sr" for="find-url-${esc(item.id)}">YouTube link for ${esc(item.title)}</label>
      <input id="find-url-${esc(item.id)}" data-find-url="${esc(item.id)}" type="url" placeholder="Paste a YouTube link" inputmode="url">
      <button type="button" class="ghost" data-action="add-find-link" data-id="${esc(item.id)}">Add link</button>
    </div>
  </article>`;
}

function paintFindStatus(article, message, kind) {
  if (!article) return;
  let note = article.querySelector('.find-status');
  if (!note) {
    note = document.createElement('p');
    article.querySelector('.find-head div')?.append(note);
  }
  note.className = `find-status is-${kind}`;
  note.textContent = message;
  let bar = article.querySelector(':scope > .download-bar');
  if (kind === 'pending') {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'download-bar is-busy';
      bar.innerHTML = '<span></span>';
      article.append(bar);
    }
  } else {
    bar?.remove();
  }
}

function downloadLine(job, place) {
  const name = job?.title || 'This song';
  const count = place?.total > 1 ? `${place.index} of ${place.total} · ` : '';
  if (job?.phase === 'match') return `${count}Checking album details for ${name}`;
  if (job?.phase === 'prepare') return `${count}Preparing ${name}`;
  if (job?.phase === 'save') return `${count}Saving ${name}${job.album ? ` into ${job.album}` : ''}`;
  if (job?.percent > 0) return `${count}Downloading ${name} · ${Math.round(job.percent)}%`;
  return `${count}Starting ${name}`;
}

function paintDownload(job) {
  const host = document.querySelector('#find-progress');
  const line = job ? downloadLine(job, downloadPlace) : '';
  if (host) {
    host.hidden = !job;
    if (job) {
      host.querySelector('.download-title').textContent = job.title || 'Download';
      host.querySelector('.download-detail').textContent = line;
      const bar = host.querySelector('.download-bar');
      const fill = bar?.querySelector('span');
      const measured = job.phase === 'download' && job.percent > 0;
      bar?.classList.toggle('is-busy', !measured);
      bar?.setAttribute('aria-valuenow', measured ? String(Math.round(job.percent)) : '0');
      if (fill) fill.style.width = measured ? `${job.percent}%` : '';
    }
  }
  const note = document.querySelector('.find-item.is-downloading .find-status');
  if (note && job) note.textContent = line;
  const itemBar = document.querySelector('.find-item.is-downloading > .download-bar');
  const row = document.querySelector('.playlist-row.is-downloading');
  for (const bar of [itemBar, row?.querySelector('.download-bar')].filter(Boolean)) {
    const measured = job?.phase === 'download' && job.percent > 0;
    bar.classList.toggle('is-busy', !measured);
    const fill = bar.querySelector('span');
    if (fill) fill.style.width = measured ? `${job.percent}%` : '';
  }
  const label = row?.querySelector('.download-label');
  if (label && job) {
    label.textContent = job.phase === 'prepare' ? 'Preparing' : job.phase === 'save' ? 'Saving' : job.percent > 0 ? `${Math.round(job.percent)}%` : 'Starting';
  }
  if (!host && job && scanProgress) {
    scanProgress.hidden = false;
    scanProgress.textContent = line;
  }
}

function findLink(item, link) {
  const watch = isWatchLink(link.url);
  const button = watch
    ? `<button type="button" class="ghost" data-action="download-find" data-id="${esc(item.id)}" data-url="${esc(link.url)}">Download</button>`
    : '';
  return `<div class="find-link"><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label || link.url)}</a>${button}</div>`;
}

function isWatchLink(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === 'www.youtube.com' || parsed.hostname === 'youtube.com' || parsed.hostname === 'music.youtube.com')
      && parsed.pathname === '/watch'
      && /^[\w-]{11}$/.test(parsed.searchParams.get('v') || '');
  } catch {
    return false;
  }
}

async function showPlaylists(token) {
  view.innerHTML = '<p class="loading">Loading playlists…</p>';
  const data = await api('/api/playlists');
  if (token !== renderToken) return;
  currentList = [];
  const rows = data.playlists.length
    ? data.playlists.map((playlist) => `
        <div class="playlist-row">
          <a href="/playlist/${esc(playlist.id)}">${esc(playlist.name)}</a>
          <span>${playlist.songCount} ${playlist.songCount === 1 ? 'track' : 'tracks'}</span>
          <button type="button" class="ghost" data-action="delete-playlist" data-id="${esc(playlist.id)}">Delete</button>
        </div>`).join('')
    : '<p class="note">No playlists yet. Save an album, or name the queue and save it.</p>';
  view.innerHTML = `
    <header class="page-head"><div><h1>Playlists</h1><p>Saved here and in Amperfy</p></div></header>
    <form class="playlist-save">
      <label class="sr" for="playlist-name">Playlist name</label>
      <input id="playlist-name" maxlength="120" placeholder="Name the queue" autocomplete="off">
      <button type="button" class="primary" data-action="save-queue">Save queue</button>
    </form>
    <div>${rows}</div>`;
  setPageTitle('Playlists — berrytone');
}

async function showPlaylist(id, token) {
  view.innerHTML = '<p class="loading">Loading playlist…</p>';
  const playlist = await api(`/api/playlists/${id}`);
  if (token !== renderToken) return;
  remember(playlist.tracks);
  currentList = playlist.tracks;
  view.innerHTML = `
    <header class="page-head">
      <div>
        <p class="kicker">Playlist</p>
        <h1>${esc(playlist.name)}</h1>
        <p>${playlist.songCount} tracks${playlist.duration ? ` · ${formatTime(playlist.duration)}` : ''}</p>
      </div>
    </header>
    <div class="actions">
      <button type="button" class="primary" data-action="play-album">Play</button>
      <button type="button" class="ghost" data-action="shuffle-album">Shuffle</button>
      <button type="button" class="ghost" data-action="delete-playlist" data-id="${esc(playlist.id)}">Delete</button>
    </div>
    <div class="track-list">${trackRows(playlist.tracks, { showAlbum: true })}</div>`;
  setPageTitle(`${playlist.name} — berrytone`);
}

async function savePlaylist(name, trackIds) {
  if (!trackIds.length) {
    toast('Nothing playable to save');
    return;
  }
  try {
    const playlist = await api('/api/playlists', { method: 'POST', body: { name, trackIds } });
    toast(`Saved “${playlist.name}”`);
    if (parseRoute().name === 'playlists' || parseRoute().name === 'playlist') show(parseRoute());
  } catch (error) {
    toast(error.message);
  }
}

function setQueue(tracks, start, { shuffle = false } = {}) {
  const items = tracks.filter((track) => track && !track.missing);
  if (!items.length) return;
  playHistory.length = 0;
  let queued = items.slice();
  let index = start;
  if (shuffle && queued.length > 1) {
    const chosen = queued[start] || queued[0];
    const rest = queued.filter((track) => track !== chosen);
    shuffleArray(rest);
    queued = [chosen, ...rest];
    index = 0;
  }
  queue.items = queued;
  playIndex(index, { remember: false });
}

function addToQueue(tracks) {
  const playable = tracks.filter((track) => track && !track.missing);
  if (!playable.length) return;
  const wasEmpty = queue.items.length === 0;
  queue.items.push(...playable);
  if (wasEmpty) playIndex(0, { remember: false });
  else {
    toast(`Added ${playable.length} ${playable.length === 1 ? 'track' : 'tracks'} to the queue`);
    persist();
    renderQueue();
  }
}

function playIndex(index, { remember = true } = {}) {
  if (!queue.items.length) return;
  const next = Math.min(queue.items.length - 1, Math.max(0, index));
  if (remember && queue.items[queue.index] && queue.index !== next) {
    playHistory.push(queue.index);
    if (playHistory.length > 300) playHistory.shift();
  }
  queue.index = next;
  expectAudio = true;
  audio.src = mediaUrl(queue.items[next]);
  audio.play().catch(() => toast('Press play to start listening'));
  paintedId = null;
  persist();
  updatePlayer();
  renderQueue();
}

function togglePlay() {
  const track = current();
  if (!track) {
    toast('Pick a song first');
    return;
  }
  if (!playingTrack(track)) {
    playIndex(queue.index, { remember: false });
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function previous() {
  if ((audio.currentTime || 0) > 3) {
    audio.currentTime = 0;
    return;
  }
  if (queue.shuffle && playHistory.length) {
    playIndex(playHistory.pop(), { remember: false });
    return;
  }
  if (queue.index > 0) playIndex(queue.index - 1, { remember: false });
  else if (audio.src) audio.currentTime = 0;
}

function goNext(fromEnded) {
  const index = followingIndex();
  if (index == null) {
    if (fromEnded) updatePlayer();
    return;
  }
  playIndex(index);
}

function followingIndex() {
  if (!queue.items.length) return null;
  if (queue.shuffle) {
    if (queue.items.length === 1) return queue.repeat === 'all' ? 0 : null;
    let pick = queue.index;
    while (pick === queue.index) pick = Math.floor(Math.random() * queue.items.length);
    return pick;
  }
  if (queue.index + 1 < queue.items.length) return queue.index + 1;
  if (queue.repeat === 'all') return 0;
  return null;
}

function dropDownload(relPath) {
  const id = [...queue.items, ...currentList].find((track) => track?.source === 'download' && track.relPath === relPath)?.id;
  if (id) dropTrack(id);
}

function dropDownloadFolder(folderPath) {
  const prefix = `${folderPath}/`;
  const ids = queue.items.filter((track) => track?.source === 'download' && typeof track.relPath === 'string' && track.relPath.startsWith(prefix) && !track.relPath.slice(prefix.length).includes('/')).map((track) => track.id);
  for (const id of ids) dropTrack(id);
}

function dropTrack(id) {
  const wasCurrent = current()?.id === id;
  const wasPlaying = wasCurrent && !audio.paused;
  let removedBefore = 0;
  queue.items = queue.items.filter((track, index) => {
    if (track.id !== id) return true;
    if (index < queue.index) removedBefore += 1;
    return false;
  });
  queue.index = Math.max(0, queue.index - removedBefore);
  if (queue.index >= queue.items.length) queue.index = Math.max(0, queue.items.length - 1);
  known.delete(id);
  currentList = currentList.filter((track) => track.id !== id);
  if (!queue.items.length) {
    queue.index = 0;
    stopAudio();
  } else if (wasPlaying) {
    playIndex(queue.index, { remember: false });
    return;
  } else if (wasCurrent) {
    stopAudio();
  }
  persist();
  updatePlayer();
  renderQueue();
}

function removeFromQueue(index) {
  if (!queue.items[index]) return;
  const removingCurrent = index === queue.index;
  queue.items.splice(index, 1);
  if (queue.index > index) queue.index -= 1;
  if (!queue.items.length) {
    queue.index = 0;
    stopAudio();
    paintedId = null;
    persist();
    updatePlayer();
    renderQueue();
    return;
  }
  if (removingCurrent) {
    queue.index = Math.min(queue.index, queue.items.length - 1);
    playIndex(queue.index, { remember: false });
    return;
  }
  persist();
  updatePlayer();
  renderQueue();
}

function clearQueue() {
  queue.items = [];
  queue.index = 0;
  playHistory.length = 0;
  stopAudio();
  paintedId = null;
  persist();
  updatePlayer();
  renderQueue();
}

function stopAudio() {
  expectAudio = false;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function updatePlayer() {
  const track = current();
  const id = track ? track.id : '';
  if (paintedId !== id) {
    paintedId = id;
    paintNow(track);
  }
  const duration = usableDuration();
  if (!scrubbing) {
    const ratio = duration ? (audio.currentTime || 0) / duration : 0;
    scrubber.value = String(Math.round(ratio * 1000));
    paintRange(scrubber, ratio);
    timeCurrent.textContent = formatTime(audio.currentTime || 0);
  }
  timeTotal.textContent = formatTime(duration);
  paintModes();
  markCurrent();
  document.body.classList.toggle('is-playing', Boolean(track) && !audio.paused);
  if (track) document.title = `${track.title} — berrytone`;
  updateSession();
}

function paintNow(track) {
  if (!track) {
    nowCover.style.setProperty('--h', '340');
    nowCover.innerHTML = '<span class="fallback">♪</span>';
    nowTitle.textContent = 'Nothing playing';
    nowTitle.removeAttribute('href');
    nowArtist.textContent = 'Pick a song to start';
    nowArtist.removeAttribute('href');
    return;
  }
  const label = track.album || track.title;
  nowCover.style.setProperty('--h', String(hueOf(track.albumId || label)));
  nowCover.innerHTML = `${track.hasArt ? `<img alt="" src="/api/art/${esc(track.albumId)}?v=${Number(track.artVersion) || 0}">` : ''}<span class="fallback">${esc(monogram(label))}</span>`;
  nowTitle.textContent = track.title;
  if (track.source === 'download') nowTitle.href = downloadHref(track.relPath.split('/').slice(0, -1).join('/'));
  else if (isId(track.albumId)) nowTitle.href = `/album/${track.albumId}`;
  else nowTitle.removeAttribute('href');
  nowArtist.textContent = track.artist || 'download';
  if (isId(track.artistId)) nowArtist.href = `/artist/${track.artistId}`;
  else nowArtist.removeAttribute('href');
}

function paintModes() {
  shuffleBtn.classList.toggle('is-on', queue.shuffle);
  shuffleBtn.setAttribute('aria-pressed', String(queue.shuffle));
  repeatBtn.classList.toggle('is-on', queue.repeat !== 'off');
  repeatBtn.classList.toggle('is-one', queue.repeat === 'one');
  repeatBtn.setAttribute('aria-pressed', String(queue.repeat !== 'off'));
  repeatBtn.setAttribute('aria-label', queue.repeat === 'one' ? 'Repeat one' : queue.repeat === 'all' ? 'Repeat all' : 'Repeat off');
  const paused = audio.paused || !current();
  playBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
  playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
}

function renderQueue() {
  queuePanel.hidden = !queueOpen;
  queueToggle.setAttribute('aria-expanded', queueOpen ? 'true' : 'false');
  queueToggle.setAttribute('aria-label', `Queue, ${queue.items.length} ${queue.items.length === 1 ? 'track' : 'tracks'}`);
  if (!queue.items.length) {
    queueList.innerHTML = '<li class="queue-empty">Queue is empty. Play an album to fill it.</li>';
    return;
  }
  queueList.innerHTML = queue.items
    .map((track, index) => {
      const currentClass = index === queue.index ? ' is-current' : '';
      return `<li class="queue-item${currentClass}" data-id="${esc(track.id)}">
        <button type="button" class="queue-play" data-action="queue-play" data-index="${index}">
          <span class="title">${esc(track.title)}</span>
          <span class="sub">${esc(track.artist)}</span>
        </button>
        <button type="button" class="queue-remove" data-action="queue-remove" data-index="${index}" aria-label="Remove ${esc(track.title)}">×</button>
      </li>`;
    })
    .join('');
}

function markCurrent() {
  const id = current()?.id;
  for (const row of document.querySelectorAll('[data-id]')) {
    row.classList.toggle('is-current', row.dataset.id === id);
  }
}

function restorePlayer() {
  remember(queue.items);
  renderQueue();
  updatePlayer();
}

logoutButton?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: { Accept: 'application/json' } });
  location.assign('/login');
});

async function poll() {
  try {
    const status = await api('/api/status');
    applyStatus(status);
  } catch (error) {
    if (error.message === 'Sign in required') return;
    libraryStat.textContent = 'Can’t reach berrytone';
  }
  const busy = latestStatus?.scanning || latestStatus?.enriching || latestStatus?.photos || latestStatus?.download;
  window.setTimeout(poll, busy ? (latestStatus?.download ? 500 : 1000) : 8000);
}

function applyStatus(status) {
  const previous = latestStatus;
  latestStatus = status;
  const bits = [];
  if (status.tracks) bits.push(`${status.tracks} ${status.tracks === 1 ? 'track' : 'tracks'}`);
  if (status.albums) bits.push(`${status.albums} ${status.albums === 1 ? 'album' : 'albums'}`);
  libraryStat.textContent = bits.join(' · ') || 'No music yet';
  if (logoutButton) logoutButton.hidden = !status.auth;
  paintAccount(status);
  paintAccess(status);
  const busy = status.scanning || status.enriching || status.photos;
  rescanBtn.disabled = busy || !allowed('rescan');
  rescanBtn.hidden = !allowed('rescan');
  rescanBtn.textContent = status.scanning ? 'Scanning…' : 'Rescan';
  if (matchBtn) {
    matchBtn.disabled = busy || !allowed('match');
    matchBtn.hidden = !allowed('match');
    matchBtn.textContent = status.enriching ? 'Matching…' : 'Match albums';
  }
  const route = parseRoute();
  if (previous && routeOpen(route, previous) && !routeOpen(route, status)) {
    show(route);
    return;
  }
  paintDownload(status.download);
  if (status.download) {
    scanProgress.hidden = false;
    scanProgress.textContent = downloadLine(status.download, downloadPlace);
  } else if (status.scanning) {
    scanProgress.hidden = false;
    const count = status.total ? `Reading ${status.processed} of ${status.total}` : 'Looking through the music folder…';
    scanProgress.textContent = status.detail ? `${status.detail}. ${count}` : count;
  } else if (status.enriching) {
    scanProgress.hidden = false;
    scanProgress.textContent = status.detail || 'Checking MusicBrainz…';
  } else if (status.photos) {
    scanProgress.hidden = false;
    scanProgress.textContent = status.detail || 'Looking up artist photos…';
  } else if (status.error) {
    scanProgress.hidden = false;
    scanProgress.textContent = status.error;
  } else if (status.skipped) {
    scanProgress.hidden = false;
    scanProgress.textContent = `${status.skipped} ${status.skipped === 1 ? 'file had' : 'files had'} unreadable tags. The file name is used instead.`;
  } else {
    scanProgress.hidden = true;
  }
  const photosBtn = document.querySelector('[data-action="find-photos"]');
  if (photosBtn) {
    photosBtn.disabled = busy;
    photosBtn.textContent = status.photos ? 'Checking…' : 'Find photos';
  }
  const routeNow = parseRoute();
  const photosFinished = previous?.photos && !status.photos;
  if (photosFinished && window.scrollY < 280 && (routeNow.name === 'artists' || routeNow.name === 'artist')) {
    cache.artists = null;
    show(routeNow);
    return;
  }
  if (status.scanning || status.photos || (status.enriching && shownScan) || status.scannedAt === shownScan) return;
  shownScan = status.scannedAt;
  cache.albums = null;
  cache.artists = null;
  show(parseRoute());
}

async function ensureAlbums() {
  if (!cache.albums) cache.albums = (await api('/api/albums')).albums;
  return cache.albums;
}

async function ensureArtists() {
  if (!cache.artists) cache.artists = (await api('/api/artists')).artists;
  return cache.artists;
}

function clearGrid() {
  if (gridObserver) gridObserver.disconnect();
  gridObserver = null;
  collection = null;
}

function mountGrid({ heading, items, card }) {
  clearGrid();
  collection = { heading, items, card, shown: 0, token: renderToken };
  view.innerHTML = `${heading}<div class="cards" id="card-grid"></div><div id="grid-sentinel" hidden></div>`;
  revealMore();
}

function revealMore() {
  if (!collection || collection.token !== renderToken) return;
  const grid = document.querySelector('#card-grid');
  const sentinel = document.querySelector('#grid-sentinel');
  if (!grid || !sentinel) return;
  if (collection.shown >= collection.items.length) {
    sentinel.hidden = true;
    sentinel.replaceChildren();
    return;
  }
  const next = Math.min(collection.items.length, collection.shown + 48);
  grid.insertAdjacentHTML('beforeend', collection.items.slice(collection.shown, next).map(collection.card).join(''));
  collection.shown = next;
  if (collection.shown >= collection.items.length) {
    sentinel.hidden = true;
    sentinel.replaceChildren();
    if (gridObserver) gridObserver.disconnect();
    return;
  }
  sentinel.hidden = false;
  if (!sentinel.querySelector('[data-action="show-more"]')) {
    sentinel.innerHTML = '<button type="button" class="more" data-action="show-more">Show more</button>';
  }
  watchGrid(sentinel);
  if (collection.shown <= 96) {
    requestAnimationFrame(() => {
      const node = document.querySelector('#grid-sentinel');
      if (!node || node.hidden || !collection || collection.token !== renderToken) return;
      if (node.getBoundingClientRect().top < window.innerHeight - 24) revealMore();
    });
  }
}

function watchGrid(sentinel) {
  if (gridObserver) gridObserver.disconnect();
  let armed = false;
  gridObserver = new IntersectionObserver((entries) => {
    const visible = entries.some((entry) => entry.isIntersecting);
    if (!visible) {
      armed = true;
      return;
    }
    if (!armed) return;
    armed = false;
    revealMore();
  }, { rootMargin: '400px' });
  gridObserver.observe(sentinel);
}

function albumCard(album) {
  const year = album.year ? ` · ${album.year}` : '';
  const edition = album.edition ? ` · ${album.edition}` : '';
  const missing = album.missingCount ? ` · ${album.missingCount} missing` : '';
  return `<div class="card-wrap"><a class="card" href="/album/${esc(album.id)}">${coverHtml(album.id, album.hasArt, album.artVersion, album.title)}<span class="card-title">${esc(album.title)}</span><span class="card-sub">${esc(album.artist)}${year}${edition}${missing}</span></a>${favButton('album', album.id, album.starred)}</div>`;
}

function artistCard(artist) {
  const hue = hueOf(artist.id);
  const img = artist.hasArt ? `<img alt="" loading="lazy" decoding="async" src="/api/artist-art/${esc(artist.id)}?v=${Number(artist.artVersion) || 0}">` : '';
  return `<div class="card-wrap"><a class="card" href="/artist/${esc(artist.id)}"><div class="cover" style="--h:${hue}">${img}<span class="fallback">${esc(monogram(artist.name))}</span></div><span class="card-title">${esc(artist.name)}</span><span class="card-sub">${artist.albumCount} albums</span></a>${favButton('artist', artist.id, artist.starred)}</div>`;
}

function closeAccount() {
  if (!accountMenu || accountMenu.hidden) return;
  accountMenu.hidden = true;
  accountButton?.setAttribute('aria-expanded', 'false');
}

function initials(name) {
  const parts = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return '♪';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function paintAccount(status) {
  if (!accountButton) return;
  const name = status.auth ? status.username || 'Account' : 'Listening room';
  if (accountName) accountName.textContent = name;
  if (accountMark) accountMark.textContent = status.auth ? initials(status.username) : '♪';
  if (accountRole) {
    accountRole.hidden = !status.auth;
    accountRole.textContent = status.role === 'admin' ? 'Admin' : 'User';
  }
  if (accountPeople) accountPeople.hidden = status.role !== 'admin';
  accountButton.setAttribute('aria-label', status.auth ? `Account, ${name}` : 'Account');
}

function paintAccess(status) {
  const features = status.features || {};
  for (const link of document.querySelectorAll('[data-nav]')) {
    const key = link.dataset.nav;
    if (key === 'folders') {
      link.hidden = features.folders !== true && features.downloads !== true;
      link.href = features.folders === true ? '/folders' : '/downloads';
    } else link.hidden = features[key] !== true;
  }
  searchForm.hidden = !(features.albums || features.artists || features.tracks);
  const save = document.querySelector('#queue-save');
  if (save) save.hidden = features.playlists !== true;
  if (sonosToggle) sonosToggle.hidden = features.sonos !== true;
  if (features.sonos !== true) closeSonos();
}

function favButton(kind, id, starred) {
  if (!allowed('favourites')) return '';
  const on = Boolean(starred);
  const label = on ? 'Remove from favourites' : 'Add to favourites';
  return `<button type="button" class="fav${on ? ' is-on' : ''}" data-action="star" data-kind="${kind}" data-id="${esc(id)}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${label}">${on ? '♥' : '♡'}</button>`;
}

function paintFav(button, starred) {
  button.classList.toggle('is-on', starred);
  button.setAttribute('aria-pressed', starred ? 'true' : 'false');
  button.setAttribute('aria-label', starred ? 'Remove from favourites' : 'Add to favourites');
  button.textContent = starred ? '♥' : '♡';
}

function rememberStar(kind, id, starred) {
  const lists = kind === 'album' ? [cache.albums] : kind === 'artist' ? [cache.artists] : [currentList, queue.items];
  for (const list of lists) {
    const item = list?.find((entry) => entry.id === id);
    if (item) item.starred = starred;
  }
}

function trackRows(tracks, { showAlbum = false, compact = false, find = false } = {}) {
  const multi = tracks.some((track) => (track.disc || 1) > 1);
  let lastDisc = null;
  const rows = [];
  for (const track of tracks) {
    const disc = track.disc || 1;
    if (multi && disc !== lastDisc) {
      rows.push(`<h3 class="disc">Disc ${disc}</h3>`);
      lastDisc = disc;
    }
    const album = showAlbum ? `<a class="row-album" href="/album/${esc(track.albumId)}">${esc(track.album)}</a>` : '';
    const rowClass = `track-row${compact && !showAlbum ? ' compact' : ''}${track.missing ? ' is-missing' : ''}`;
    const subtitle = track.missing ? 'missing' : track.linked && track.sourceAlbum ? `from ${track.sourceAlbum}` : track.artist;
    const main = track.missing
      ? `<div class="track-play"><span class="n">${track.track || '•'}</span><span class="stack"><span class="title">${esc(track.title)}</span><span class="sub">${esc(subtitle)}</span></span></div>`
      : `<button type="button" class="track-play" data-action="play-track" data-id="${esc(track.id)}"><span class="n">${track.track || '•'}</span><span class="stack"><span class="title">${esc(track.title)}</span><span class="sub">${esc(subtitle)}</span></span></button>`;
    const heart = track.source === 'download'
      ? '<span class="fav-space"></span>'
      : track.missing
      ? (find && allowed('find')
        ? (track.wanted
          ? '<a class="find-state" href="/find">On list</a>'
          : `<button type="button" class="find-add" data-action="add-find" data-id="${esc(track.id)}" data-album="${esc(track.albumId)}" aria-label="Add ${esc(track.title)} to find list">Add</button>`)
        : '<span class="fav-space"></span>')
      : favButton('song', track.id, track.starred);
    const source = track.source === 'download' ? ` data-source="download" data-path="${esc(track.relPath || '')}"` : '';
    const info = `<button type="button" class="info-btn" data-action="track-info" data-id="${esc(track.id)}"${source} aria-label="Information for ${esc(track.title)}">i</button>`;
    rows.push(`<div class="${rowClass}" data-id="${esc(track.id)}">
      ${main}
      ${album}
      <span class="meta">${esc(track.format || '')}</span>
      <span class="time">${formatTime(track.duration)}</span>
      <div class="row-end">${info}${heart}</div>
    </div>`);
  }
  return rows.join('');
}

function openTrackInfo(info) {
  const dialog = document.querySelector('#track-info');
  const title = document.querySelector('#track-info-title');
  const body = document.querySelector('#track-info-body');
  if (!dialog || !title || !body) return;
  title.textContent = info.title || 'Song';
  const location = info.path
    ? `<div class="info-path"><span>${esc(info.place || 'File')}</span><code>${esc(info.path)}</code></div>`
    : `<div class="info-path"><span>File</span><code>This song is not in the library</code></div>`;
  const rows = (info.fields || []).map((field) => `<div class="info-row"><span>${esc(field.label)}</span><p>${esc(field.value)}</p></div>`).join('');
  const admin = !latestStatus?.auth || latestStatus.role === 'admin';
  const canDelete = info.deletable && info.id && admin;
  const canImport = info.place === 'Downloads' && info.path && admin;
  const remove = canDelete
    ? `<div class="info-actions"><button type="button" class="danger" data-action="delete-track" data-id="${esc(info.id)}" data-title="${esc(info.title || 'This song')}">Delete song</button></div>`
    : '';
  const bring = canImport
    ? `<div class="info-actions"><button type="button" class="ghost" data-action="import-download" data-path="${esc(info.path)}" data-title="${esc(info.title || 'This song')}">Import to media library</button></div>`
    : '';
  body.innerHTML = location + rows + bring + remove;
  if (!dialog.open) dialog.showModal();
}

function coverHtml(id, hasArt, artVersion, label, size = '') {
  const hue = hueOf(id || label);
  const img = hasArt ? `<img alt="" loading="lazy" decoding="async" src="/api/art/${esc(id)}?v=${Number(artVersion) || 0}">` : '';
  const sizeClass = size ? ` ${size}` : '';
  return `<div class="cover${sizeClass}" style="--h:${hue}">${img}<span class="fallback">${esc(monogram(label))}</span></div>`;
}

function emptyLibrary() {
  const detail = latestStatus?.error
    ? esc(latestStatus.error)
    : 'Add audio files to the music folder on robin, then press Rescan.';
  return `<div class="empty"><span class="mark lg" aria-hidden="true"></span><h1>Nothing in the library yet</h1><p>${detail}</p></div>`;
}

function remember(tracks) {
  for (const track of tracks || []) {
    if (track && isId(track.id)) known.set(track.id, track);
  }
}

function current() {
  return queue.items[queue.index] || null;
}

function usableDuration() {
  if (Number.isFinite(audio.duration) && audio.duration > 0 && audio.duration !== Infinity) return audio.duration;
  const track = current();
  return track && Number.isFinite(track.duration) ? track.duration : 0;
}

function persist() {
  try {
    localStorage.setItem(
      'berrytone.player',
      JSON.stringify({
        items: queue.items.map(snapshot),
        index: queue.index,
        shuffle: queue.shuffle,
        repeat: queue.repeat,
        volume: queue.volume,
      }),
    );
  } catch {
    // Private browsing can refuse storage. Playback still works for this visit.
  }
}

function loadSaved() {
  try {
    const data = JSON.parse(localStorage.getItem('berrytone.player') || '{}');
    return {
      items: Array.isArray(data.items) ? data.items.filter(isSavedTrack) : [],
      index: Number.isInteger(data.index) ? data.index : 0,
      shuffle: Boolean(data.shuffle),
      repeat: data.repeat === 'all' || data.repeat === 'one' ? data.repeat : 'off',
      volume: Number.isFinite(data.volume) ? Math.min(1, Math.max(0, data.volume)) : 0.9,
    };
  } catch {
    return { items: [], index: 0, shuffle: false, repeat: 'off', volume: 0.9 };
  }
}

function snapshot(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumId: track.albumId,
    artistId: track.artistId,
    duration: track.duration,
    hasArt: Boolean(track.hasArt),
    artVersion: track.artVersion ?? null,
    format: track.format || '',
    source: track.source === 'download' ? 'download' : undefined,
    relPath: track.source === 'download' ? track.relPath : undefined,
  };
}

function isSavedTrack(track) {
  if (track?.source === 'download') {
    return Boolean(isId(track.id) && typeof track.relPath === 'string' && !track.relPath.split('/').some((part) => !part || part === '.' || part === '..') && typeof track.title === 'string');
  }
  return Boolean(track && isId(track.id) && isId(track.albumId) && isId(track.artistId) && typeof track.title === 'string');
}

function mediaUrl(track) {
  if (track?.source === 'download' && typeof track.relPath === 'string') {
    return `/api/downloads/stream/${track.relPath.split('/').map(encodeURIComponent).join('/')}`;
  }
  return `/api/stream/${track.id}`;
}

function playingTrack(track) {
  if (!audio.src || !track) return false;
  try {
    return decodeURIComponent(new URL(audio.src).pathname) === decodeURIComponent(mediaUrl(track));
  } catch {
    return false;
  }
}

function syncNav(name) {
  const currentName = name === 'album' ? 'albums' : name === 'artist' ? 'artists' : name === 'playlist' ? 'playlists' : name === 'folder' ? 'folders' : name;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === currentName) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setPageTitle(title) {
  if (!current()) document.title = title;
}

function registerSession() {
  if (!('mediaSession' in navigator)) return;
  const actions = {
    play: () => {
      if (audio.paused) togglePlay();
    },
    pause: () => {
      if (!audio.paused) audio.pause();
    },
    previoustrack: previous,
    nexttrack: () => goNext(false),
    seekbackward: (details) => seekBy(-(details.seekOffset || 10)),
    seekforward: (details) => seekBy(details.seekOffset || 10),
    seekto: (details) => {
      if (Number.isFinite(details.seekTime) && audio.src) audio.currentTime = details.seekTime;
    },
  };
  for (const [name, handler] of Object.entries(actions)) {
    try {
      navigator.mediaSession.setActionHandler(name, handler);
    } catch {
      // This browser does not support the action.
    }
  }
}

function updateSession() {
  if (!('mediaSession' in navigator)) return;
  const track = current();
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const artwork = [];
  if (track.hasArt) {
    artwork.push({
      src: new URL(`/api/art/${track.albumId}?v=${track.artVersion || 0}`, location.origin).href,
      sizes: '512x512',
    });
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork,
  });
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, duration),
      });
    } catch {
      // Ignore a position update that arrives before the browser is ready.
    }
  }
}

function seekBy(seconds) {
  if (!audio.src || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.min(audio.duration, Math.max(0, (audio.currentTime || 0) + seconds));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const next = `${location.pathname}${location.search}`;
    location.assign(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`);
    throw new Error('Sign in required');
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function paintRange(input, ratio) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 1000) / 10));
  input.style.background = `linear-gradient(90deg, var(--berry) ${pct}%, rgba(255,255,255,0.16) ${pct}%)`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const whole = seconds < 1 ? 1 : Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function monogram(label) {
  const words = String(label || '')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !/^(the|a|an)$/i.test(word));
  const first = words[0] || '?';
  const second = words[1] ? words[1][0] : '';
  return `${first[0] || '?'}${second}`.toLocaleUpperCase();
}

function hueOf(input) {
  let hash = 2166136261;
  for (const char of String(input || '')) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return Math.abs(hash) % 360;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function isId(value) {
  return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
}

function clampIndex(index, length) {
  if (!length) return 0;
  return Math.min(length - 1, Math.max(0, index));
}

function shuffleArray(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}
