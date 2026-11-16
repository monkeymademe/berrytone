const FANART = 'https://webservice.fanart.tv/v3/music/';
const ASSETS = 'https://assets.fanart.tv/';

export function createFanart({ key = '', fetchImpl = fetch } = {}) {
  async function artistImage(mbid) {
    if (!uuid(mbid)) return null;
    if (!key) throw new Error('Add a Fanart key in Settings');
    const body = await readJson(fetchImpl, `${FANART}${mbid}?client_key=${encodeURIComponent(key)}`);
    const url = chooseArtistImage(body);
    if (!url) return null;
    return download(fetchImpl, url);
  }

  return { artistImage };
}

export function chooseArtistImage(body) {
  const thumb = liked(body?.artistthumb);
  const background = liked(body?.artistbackground);
  const chosen = thumb || background;
  if (!chosen?.url || !chosen.url.startsWith(ASSETS)) return null;
  return chosen.url;
}

function liked(list) {
  return [...(Array.isArray(list) ? list : [])].sort((left, right) => Number(right?.likes) - Number(left?.likes))[0] || null;
}

async function readJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'follow' });
  if (response.status === 404) return null;
  if (response.status === 429) {
    const error = new Error('Fanart is busy');
    error.retryAfter = Number(response.headers.get('retry-after')) || 2;
    throw error;
  }
  if (!response.ok) throw new Error(`Fanart returned ${response.status}`);
  return response.json();
}

async function download(fetchImpl, url) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Fanart image returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return null;
  const type = String(response.headers.get('content-type') || '');
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
  return { bytes, ext };
}

function uuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}
