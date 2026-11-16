const WATCH = /^[\w-]{11}$/;

export async function searchYouTube(query, fetchImpl = globalThis.fetch) {
  const text = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!text) return [];
  const searchPage = [{ url: `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`, label: 'YouTube search' }];
  try {
    const response = await fetchImpl('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept-language': 'en',
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20241120.01.00', hl: 'en', gl: 'US' } },
        query: text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return searchPage;
    const videos = parseYouTubeResults(await response.json());
    return videos.length ? videos : searchPage;
  } catch {
    return searchPage;
  }
}

export function parseYouTubeResults(payload) {
  const found = [];
  collectVideos(payload, found);
  return found.slice(0, 5);
}

export function canonicalWatchUrl(input) {
  try {
    const parsed = new URL(String(input || '').trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    const host = parsed.hostname.replace(/^www\./, '');
    let id = '';
    if ((host === 'youtube.com' || host === 'music.youtube.com' || host === 'm.youtube.com') && parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v') || '';
    } else if ((host === 'youtube.com' || host === 'm.youtube.com') && parsed.pathname.startsWith('/shorts/')) {
      id = parsed.pathname.split('/')[2] || '';
    } else if (host === 'youtu.be') {
      id = parsed.pathname.slice(1).split('/')[0];
    }
    return WATCH.test(id) ? `https://www.youtube.com/watch?v=${id}` : '';
  } catch {
    return '';
  }
}

export function playlistIdFrom(input) {
  try {
    const parsed = new URL(String(input || '').trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    const host = parsed.hostname.replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'music.youtube.com' && host !== 'm.youtube.com') return '';
    const id = parsed.searchParams.get('list') || '';
    return /^[\w-]{12,80}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

export async function fetchYouTubeVideo(url, fetchImpl = globalThis.fetch) {
  const watch = canonicalWatchUrl(url);
  if (!watch) return null;
  const response = await fetchImpl(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('YouTube did not return that song');
  const data = await response.json();
  const title = String(data.title || 'YouTube').replace(/\s+/g, ' ').trim().slice(0, 180) || 'YouTube';
  const author = String(data.author_name || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return {
    title,
    author,
    single: true,
    videos: [{ videoId: new URL(watch).searchParams.get('v'), title, author }],
  };
}

export async function fetchYouTubePlaylist(url, fetchImpl = globalThis.fetch) {
  const id = playlistIdFrom(url);
  if (!id) return null;
  const seen = new Set();
  let body = { browseId: `VL${id}` };
  let playlist = null;
  for (let page = 0; page < 5; page += 1) {
    const response = await fetchImpl('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept-language': 'en',
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20241120.01.00', hl: 'en', gl: 'US' } },
        ...body,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('YouTube did not return that playlist');
    const next = parseYouTubePlaylist(await response.json());
    if (!playlist) playlist = next;
    else {
      if (!playlist.title || playlist.title === 'YouTube playlist') playlist.title = next.title;
      playlist.author = playlist.author || next.author;
      for (const video of next.videos) {
        if (!playlist.videos.some((item) => item.videoId === video.videoId)) playlist.videos.push(video);
      }
      playlist.continuation = next.continuation;
      playlist.truncated = playlist.truncated || next.truncated;
    }
    if (playlist.videos.length >= 100 || !playlist.continuation || seen.has(playlist.continuation)) break;
    seen.add(playlist.continuation);
    body = { continuation: playlist.continuation };
  }
  playlist.videos = playlist.videos.slice(0, 100);
  playlist.truncated = playlist.truncated || Boolean(playlist.continuation && playlist.videos.length >= 100);
  delete playlist.continuation;
  if (!playlist.videos.length) throw new Error('That playlist has no videos');
  return playlist;
}

export function parseYouTubePlaylist(payload) {
  const header = { title: '', author: '' };
  const videos = [];
  const state = { continuation: '', truncated: false };
  walkPlaylist(payload, header, videos, state);
  return {
    title: header.title || 'YouTube playlist',
    author: header.author || '',
    videos: videos.slice(0, 100),
    continuation: state.continuation,
    truncated: state.truncated || videos.length > 100,
  };
}

export function albumFromPlaylistTitle(title, author = '') {
  let text = String(title || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/\s*[([].*?(full album|official|complete|hd).*?[)\]]/gi, '').trim();
  const parts = text.split(/\s+[-–—]\s+/);
  const album = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : text;
  const artist = parts.length >= 2 ? parts[0].trim() : String(author || '').trim();
  return { artist, album: album || text };
}

export function cleanVideoTitle(title, playlistTitle = '', author = '') {
  let text = String(title || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/\s*[([【].*?(official|audio|video|lyric|hd|remaster|topic|visualizer).*?[)\]】]/gi, '');
  text = text.replace(/^\d{1,3}[\s.\-]+/, '');
  const parts = text.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const left = foldLoose(parts[0]);
    const right = parts.slice(1).join(' - ').trim();
    if (left && (left === foldLoose(author) || left === foldLoose(playlistTitle))) text = right;
  }
  text = text.replace(/\s+/g, ' ').trim().slice(0, 180);
  return text || String(title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function foldLoose(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function walkPlaylist(node, header, videos, state) {
  if (node == null) return;
  if (videos.length >= 100) {
    state.truncated = true;
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkPlaylist(item, header, videos, state);
    return;
  }
  if (typeof node !== 'object') return;
  const token = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    || node.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token
    || '';
  if (token) state.continuation = state.continuation || token;
  const headerNode = node.playlistHeaderRenderer;
  if (headerNode) {
    header.title = header.title || textOf(headerNode.title);
    header.author = header.author || textOf(headerNode.ownerText || headerNode.subtitle);
  }
  const pageTitle = node.pageHeaderViewModel?.title?.dynamicTextViewModel?.text?.content
    || node.playlistMetadataRenderer?.title;
  if (pageTitle) header.title = header.title || String(pageTitle).replace(/\s+/g, ' ').trim();
  const owner = plainText(node.videoOwnerRenderer?.title);
  if (owner) header.author = header.author || owner;
  const video = node.playlistVideoRenderer;
  if (video?.videoId && WATCH.test(video.videoId) && !videos.some((item) => item.videoId === video.videoId)) {
    videos.push({ videoId: video.videoId, title: textOf(video.title), author: textOf(video.shortBylineText) });
  }
  const lockup = node.lockupViewModel;
  if (lockup?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && WATCH.test(lockup.contentId || '') && !videos.some((item) => item.videoId === lockup.contentId)) {
    const title = plainText(lockup.metadata?.lockupMetadataViewModel?.title) || 'YouTube';
    const author = plainText(lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text);
    videos.push({ videoId: lockup.contentId, title, author });
  }
  for (const value of Object.values(node)) walkPlaylist(value, header, videos, state);
}

function plainText(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, 180);
  const runs = value?.runs?.map((run) => run.text).join('');
  return String(runs || value?.simpleText || value?.content || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function safeYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    if (host !== 'www.youtube.com' && host !== 'youtube.com' && host !== 'music.youtube.com') return false;
    if (parsed.pathname === '/watch') return WATCH.test(parsed.searchParams.get('v') || '');
    if (parsed.pathname === '/results') return Boolean(parsed.searchParams.get('search_query'));
    return false;
  } catch {
    return false;
  }
}

function collectVideos(node, found) {
  if (found.length >= 5 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideos(item, found);
    return;
  }
  if (typeof node !== 'object') return;
  const video = node.videoRenderer;
  if (video?.videoId && WATCH.test(video.videoId)) {
    const title = textOf(video.title);
    const channel = textOf(video.ownerText);
    const url = `https://www.youtube.com/watch?v=${video.videoId}`;
    if (!found.some((item) => item.url === url)) {
      found.push({ url, label: channel ? `${title} · ${channel}` : title });
    }
  }
  for (const value of Object.values(node)) collectVideos(value, found);
}

function textOf(value) {
  const runs = value?.runs?.map((run) => run.text).join('');
  const text = (runs || value?.simpleText || 'YouTube').replace(/\s+/g, ' ').trim();
  return text.slice(0, 180) || 'YouTube';
}
