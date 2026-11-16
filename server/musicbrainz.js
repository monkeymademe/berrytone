import { isGenericArtist, foldTitle } from './catalog.js';

const USER_AGENT = 'berrytone/1.0 (local music player on robin.local)';
const BASE = 'https://musicbrainz.org/ws/2';

export function createMusicBrainz({ fetchImpl = fetch } = {}) {
  let nextAt = 0;

  async function request(url, { json = true } = {}) {
    const wait = Math.max(0, nextAt - Date.now());
    nextAt = Date.now() + wait + 1100;
    if (wait) await delay(wait);
    let response;
    let attempt = 0;
    for (;;) {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: json ? 'application/json' : '*/*' },
        redirect: 'follow',
      });
      if (response.status !== 503 || attempt >= 2) break;
      attempt += 1;
      const retry = Number(response.headers.get('retry-after')) || 2;
      await delay(Math.min(retry, 10) * 1000);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`MusicBrainz returned ${response.status}`);
    if (!json) return Buffer.from(await response.arrayBuffer());
    return response.json();
  }

  async function resolve(group) {
    if (group.releaseMbid) return lookup(group.releaseMbid);
    const artist = isGenericArtist(group.artist) ? 'Various Artists' : group.artist;
    const chosen = await searchAndChoose(group.title, artist, group);
    if (chosen) return lookup(chosen.id);
    if (!isGenericArtist(group.artist)) return null;
    const broad = await searchAndChoose(group.title, null, { ...group, artist: 'Various Artists' });
    return broad ? lookup(broad.id) : null;
  }

  async function searchAndChoose(title, artist, group) {
    const releases = await search(title, artist);
    return chooseRelease(releases, group);
  }

  async function search(title, artist) {
    const parts = [`release:"${escapeLucene(title)}"`];
    if (artist) parts.push(`artist:"${escapeLucene(artist)}"`);
    const query = encodeURIComponent(parts.join(' AND '));
    const body = await request(`${BASE}/release?query=${query}&fmt=json&limit=10`);
    return body?.releases || [];
  }

  async function lookup(releaseMbid) {
    const body = await request(`${BASE}/release/${releaseMbid}?inc=recordings+artist-credits+release-groups&fmt=json`);
    if (!body?.id) return null;
    return releaseFromLookup(body);
  }

  async function cover(releaseMbid) {
    const wait = Math.max(0, nextAt - Date.now());
    nextAt = Date.now() + wait + 1100;
    if (wait) await delay(wait);
    const response = await fetchImpl(`https://coverartarchive.org/release/${releaseMbid}/front`, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cover Art Archive returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null;
    const type = String(response.headers.get('content-type') || '');
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
    return { bytes, ext };
  }

  return { resolve, cover };
}

export function chooseRelease(releases, group) {
  const wantedTitle = foldTitle(group.title);
  const wantedArtist = foldTitle(isGenericArtist(group.artist) ? 'various artists' : group.artist);
  const generic = isGenericArtist(group.artist) || wantedArtist === 'various artists';
  const viable = [];
  for (const release of releases || []) {
    if (foldTitle(release.title) !== wantedTitle) continue;
    const credit = foldTitle(artistCredit(release['artist-credit']));
    const types = release['release-group']?.['secondary-types'] || [];
    const compilation = types.includes('Compilation') || credit === 'various artists';
    const artistOk = generic
      ? compilation || credit === 'various artists' || isGenericArtist(credit)
      : namesClose(credit, wantedArtist);
    if (!artistOk) continue;
    viable.push(release);
  }
  viable.sort((left, right) => scoreRelease(right, group, wantedArtist, generic) - scoreRelease(left, group, wantedArtist, generic));
  return viable[0] || null;
}

export function releaseFromLookup(body) {
  const tracks = [];
  for (const medium of body.media || []) {
    const disc = positive(medium.position) || 1;
    for (const track of medium.tracks || []) {
      const recording = track.recording || {};
      tracks.push({
        disc,
        track: positive(track.position) || positive(Number(track.number)) || tracks.length + 1,
        title: text(track.title || recording.title) || 'Untitled',
        artist: text(artistCredit(recording['artist-credit'] || track['artist-credit'])) || 'Unknown artist',
        duration: milliseconds(track.length || recording.length),
        recordingMbid: uuid(recording.id),
        artistMbid: uuid(recording['artist-credit']?.[0]?.artist?.id || track['artist-credit']?.[0]?.artist?.id),
      });
    }
  }
  if (!tracks.length) return null;
  return {
    releaseMbid: uuid(body.id),
    releaseGroupMbid: uuid(body['release-group']?.id),
    albumArtistMbid: uuid(body['artist-credit']?.[0]?.artist?.id),
    title: text(body.title) || 'Unknown album',
    artist: text(artistCredit(body['artist-credit'])) || 'Unknown artist',
    year: yearFrom(body.date),
    country: text(body.country) || null,
    disambiguation: text(body.disambiguation) || null,
    tracks,
  };
}

export function artistCredit(credits) {
  if (!Array.isArray(credits) || !credits.length) return '';
  return credits.map((credit) => `${credit.name || credit.artist?.name || ''}${credit.joinphrase || ''}`).join('').trim();
}

function scoreRelease(release, group, wantedArtist, generic) {
  let score = Number(release.score) || 0;
  if (release.status === 'Official') score += 20;
  const credit = foldTitle(artistCredit(release['artist-credit']));
  if (credit === wantedArtist) score += 30;
  const compilation = (release['release-group']?.['secondary-types'] || []).includes('Compilation');
  if (generic && compilation) score += 25;
  if (!generic && compilation) score -= 15;
  const count = Number(release['track-count']) || 0;
  if (group.fileCount && count) score -= Math.min(20, Math.abs(count - group.fileCount));
  return score;
}

function namesClose(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 5) return false;
  return longer.startsWith(`${shorter} `) || longer.includes(` ${shorter}`);
}

function escapeLucene(value) {
  return String(value).replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

function milliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number / 100) / 10;
}

function yearFrom(date) {
  const match = /^(\d{4})/.exec(String(date || ''));
  const year = match ? Number(match[1]) : null;
  return year >= 1000 && year <= 9999 ? year : null;
}

function positive(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function uuid(value) {
  const text = String(value || '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text) ? text : null;
}

function text(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
