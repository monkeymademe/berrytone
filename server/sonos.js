import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

const AV = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDER = 'urn:schemas-upnp-org:service:RenderingControl:1';
const TOPOLOGY = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1';
const QUEUE_LIMIT = 40;
const GRANT_MS = 24 * 60 * 60 * 1000;

const PROTOCOLS = {
  'audio/mpeg': 'http-get:*:audio/mpeg:*',
  'audio/mp4': 'http-get:*:audio/mp4:*',
  'audio/aac': 'http-get:*:audio/aac:*',
  'audio/flac': 'http-get:*:audio/flac:*',
  'audio/wav': 'http-get:*:audio/wav:*',
  'audio/aiff': 'http-get:*:audio/aiff:*',
  'audio/ogg': 'http-get:*:audio/ogg:*',
  'audio/webm': 'http-get:*:audio/webm:*',
  'audio/x-ms-wma': 'http-get:*:audio/x-ms-wma:*',
};

export function createSonos({ resolve, advertise = lanAddress, discover = discoverPlayers, fetchImpl = fetch } = {}) {
  const grants = new Map();
  let roomsCache = [];
  let cachedAt = 0;

  function remember(track) {
    const token = randomBytes(24).toString('hex');
    const now = Date.now();
    for (const [key, grant] of grants) {
      if (grant.expires <= now) grants.delete(key);
    }
    grants.set(token, { ...track, expires: now + GRANT_MS });
    return token;
  }

  function recall(token) {
    if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
    const grant = grants.get(token);
    if (!grant || grant.expires <= Date.now()) {
      grants.delete(token);
      return null;
    }
    return grant;
  }

  async function rooms({ refresh = false } = {}) {
    if (!refresh && roomsCache.length && Date.now() - cachedAt < 30_000) return roomsCache.map(publicRoom);
    const locations = await discover().catch(() => []);
    const players = [];
    for (const location of locations) {
      const xml = await readText(fetchImpl, location);
      const player = parseDeviceDescription(xml, location);
      if (player) players.push(player);
    }
    const grouped = await groupPlayers(players, fetchImpl);
    roomsCache = grouped.length ? grouped : players.map(singleRoom);
    cachedAt = Date.now();
    return roomsCache.map(publicRoom).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async function play(roomId, specs) {
    const room = await roomById(roomId);
    if (!room) return { error: 'That speaker is not on the network', status: 404 };
    const base = advertise();
    if (!base) return { error: 'Berrytone could not find an address the speaker can reach', status: 500 };
    const tracks = [];
    for (const spec of (Array.isArray(specs) ? specs : []).slice(0, QUEUE_LIMIT)) {
      const track = await resolve(spec);
      if (track?.filePath && track.mime) tracks.push(track);
    }
    if (!tracks.length) return { error: 'Choose a song the speaker can play', status: 400 };
    const control = room.avTransport;
    await call(fetchImpl, control, AV, 'RemoveAllTracksFromQueue', '<InstanceID>0</InstanceID>');
    for (const track of tracks) {
      const token = remember(track);
      const url = `${base}/api/sonos/stream/${token}`;
      const art = track.albumId ? `${base}/api/sonos/art/${token}` : '';
      await call(fetchImpl, control, AV, 'AddURIToQueue', [
        '<InstanceID>0</InstanceID>',
        `<EnqueuedURI>${xml(url)}</EnqueuedURI>`,
        `<EnqueuedURIMetaData>${xml(didl({ ...track, url, art }))}</EnqueuedURIMetaData>`,
        '<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>',
        '<EnqueueAsNext>0</EnqueueAsNext>',
      ].join(''));
    }
    await call(fetchImpl, control, AV, 'SetAVTransportURI', [
      '<InstanceID>0</InstanceID>',
      `<CurrentURI>${xml(`x-rincon-queue:${room.id}#0`)}</CurrentURI>`,
      '<CurrentURIMetaData></CurrentURIMetaData>',
    ].join(''));
    await call(fetchImpl, control, AV, 'Seek', '<InstanceID>0</InstanceID><Unit>TRACK_NR</Unit><Target>1</Target>');
    await call(fetchImpl, control, AV, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
    return { room: room.name, count: tracks.length };
  }

  async function transport(roomId, action) {
    const room = await roomById(roomId);
    if (!room) return { error: 'That speaker is not on the network', status: 404 };
    const command = { play: 'Play', pause: 'Pause', stop: 'Stop', next: 'Next', previous: 'Previous' }[action];
    if (!command) return { error: 'That speaker command is not available', status: 400 };
    const extra = command === 'Play' ? '<Speed>1</Speed>' : '';
    await call(fetchImpl, room.avTransport, AV, command, `<InstanceID>0</InstanceID>${extra}`);
    return { ok: true };
  }

  async function volume(roomId, level) {
    const room = await roomById(roomId);
    if (!room) return { error: 'That speaker is not on the network', status: 404 };
    const desired = Math.max(0, Math.min(100, Math.round(Number(level))));
    if (!Number.isInteger(desired)) return { error: 'Volume needs a number from 0 to 100', status: 400 };
    await call(
      fetchImpl,
      room.rendering,
      RENDER,
      'SetVolume',
      `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${desired}</DesiredVolume>`,
    );
    return { volume: desired };
  }

  async function state(roomId) {
    const room = await roomById(roomId);
    if (!room) return { error: 'That speaker is not on the network', status: 404 };
    const transportInfo = await call(fetchImpl, room.avTransport, AV, 'GetTransportInfo', '<InstanceID>0</InstanceID>');
    const volumeInfo = await call(
      fetchImpl,
      room.rendering,
      RENDER,
      'GetVolume',
      '<InstanceID>0</InstanceID><Channel>Master</Channel>',
    );
    const transportState = transportInfo.match(/<CurrentTransportState>\s*([A-Z_]+)\s*</)?.[1] || '';
    const playing = transportState === 'PLAYING' || transportState === 'TRANSITIONING';
    const volumeMatch = volumeInfo.match(/<CurrentVolume>\s*(\d+)\s*</);
    return { name: room.name, playing, volume: volumeMatch ? Number(volumeMatch[1]) : null };
  }

  async function roomById(roomId) {
    if (!roomsCache.some((room) => room.id === roomId)) await rooms({ refresh: true });
    return roomsCache.find((room) => room.id === roomId) || null;
  }

  return { rooms, play, transport, volume, state, recall };
}

export function lanAddress(interfaces = networkInterfaces(), port = process.env.PORT || 8083, prefer = process.env.BERRYTONE_ADVERTISE || '') {
  const chosen = String(prefer || '').trim();
  if (/^https?:\/\//i.test(chosen)) return chosen.replace(/\/$/, '');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(chosen)) return `http://${chosen}:${port}`;
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (/^(docker|br-|veth|lo)/.test(name)) continue;
    for (const entry of entries || []) {
      const family = entry.family === 'IPv4' || entry.family === 4;
      if (!family || entry.internal || !privateAddress(entry.address)) continue;
      addresses.push(entry.address);
    }
  }
  return addresses[0] ? `http://${addresses[0]}:${port}` : '';
}

export function parseDeviceDescription(xml, location) {
  const text = String(xml || '');
  const udn = text.match(/<UDN>\s*uuid:([^<\s]+)\s*<\/UDN>/i)?.[1] || '';
  if (!udn.startsWith('RINCON_')) return null;
  const name = decodeXml(text.match(/<roomName>([^<]*)<\/roomName>/i)?.[1] || text.match(/<friendlyName>([^<]*)<\/friendlyName>/i)?.[1] || 'Sonos');
  let host;
  try {
    host = new URL(location);
  } catch {
    return null;
  }
  return {
    id: udn,
    name: name || 'Sonos',
    location,
    avTransport: serviceUrl(text, host, AV),
    rendering: serviceUrl(text, host, RENDER),
    topology: serviceUrl(text, host, TOPOLOGY),
  };
}

export function parseZoneGroups(xml) {
  const decoded = decodeXml(String(xml || ''));
  const groups = [];
  for (const block of decoded.matchAll(/<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const coordinator = block[1].match(/\bCoordinator="([^"]+)"/)?.[1]?.replace(/^uuid:/, '') || '';
    const members = [...block[2].matchAll(/<ZoneGroupMember\b([^>]*)\/?>/g)].map((match) => ({
      name: decodeXml(match[1].match(/\bZoneName="([^"]*)"/)?.[1] || ''),
      id: (match[1].match(/\bUUID="([^"]+)"/)?.[1] || '').replace(/^uuid:/, ''),
      invisible: /Invisible="1"/.test(match[1]),
    })).filter((member) => member.id);
    if (coordinator) groups.push({ coordinator, members });
  }
  return groups;
}

export function didl(track) {
  const protocol = PROTOCOLS[track.mime] || 'http-get:*:audio/mpeg:*';
  const art = track.art ? `<upnp:albumArtURI>${xml(track.art)}</upnp:albumArtURI>` : '';
  return [
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">',
    '<item id="0" parentID="-1" restricted="true">',
    `<dc:title>${xml(track.title || 'Unknown')}</dc:title>`,
    `<dc:creator>${xml(track.artist || '')}</dc:creator>`,
    `<upnp:album>${xml(track.album || '')}</upnp:album>`,
    art,
    `<res protocolInfo="${protocol}"${clock(track.duration)}>${xml(track.url)}</res>`,
    '</item></DIDL-Lite>',
  ].join('');
}

export function discoverPlayers(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Set();
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      if (extra) found.add(extra);
      resolve([...found]);
    };
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('error', () => finish());
    socket.on('message', (message) => {
      const location = message.toString('utf8').match(/LOCATION:\s*(http:\/\/[^\r\n]+)/i)?.[1]?.trim();
      if (location) found.add(location);
    });
    const packet = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 1',
      'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
      '',
      '',
    ].join('\r\n'));
    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(2);
        socket.send(packet, 0, packet.length, 1900, '239.255.255.250');
      } catch {
        finish();
      }
    });
  });
}

function publicRoom(room) {
  return { id: room.id, name: room.name };
}

function singleRoom(player) {
  return player;
}

async function groupPlayers(players, fetchImpl) {
  const byId = new Map(players.map((player) => [player.id, player]));
  const source = players.find((player) => player.topology);
  if (!source) return [];
  const body = await call(fetchImpl, source.topology, TOPOLOGY, 'GetZoneGroupState', '').catch(() => '');
  const groups = parseZoneGroups(body);
  return groups.map((group) => {
    const coordinator = byId.get(group.coordinator) || players.find((player) => player.id === group.coordinator);
    if (!coordinator) return null;
    const visible = group.members.filter((member) => !member.invisible && member.name);
    const name = visible.map((member) => member.name).join(' + ') || coordinator.name;
    return { ...coordinator, id: group.coordinator, name };
  }).filter(Boolean);
}

async function readText(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  }
}

async function call(fetchImpl, url, service, action, body) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>
<u:${action} xmlns:u="${service}">${body}</u:${action}>
</s:Body></s:Envelope>`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"${service}#${action}"`,
      },
      body: envelope,
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'The speaker did not answer' : 'The speaker could not be reached');
  }
  const text = await response.text();
  if (!response.ok || /<(?:[^:>]+:)?Fault\b/.test(text)) {
    const message = text.match(/<(?:[^:>]+:)?faultstring>([^<]*)</i)?.[1];
    throw new Error(decodeXml(message || `The speaker returned ${response.status}`));
  }
  return text;
}

function serviceUrl(xmlText, host, service) {
  const pattern = new RegExp(`<serviceType>\\s*${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</serviceType>[\\s\\S]*?<controlURL>\\s*([^<\\s]+)\\s*</controlURL>`, 'i');
  const control = xmlText.match(pattern)?.[1];
  if (!control) return '';
  try {
    return new URL(control, host).toString();
  } catch {
    return '';
  }
}

function clock(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isInteger(total) || total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remain = total % 60;
  return ` duration="${hours}:${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}"`;
}

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function privateAddress(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}
