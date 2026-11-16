import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { describeFile } from './details.js';

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

const PLAY_LIMIT = 1000;
const IMAGE = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const COVER_RANK = new Map([
  ['cover', 0],
  ['folder', 1],
  ['front', 2],
  ['albumart', 3],
  ['album', 4],
  ['artwork', 5],
]);

export function createDownloads(root) {
  const tagCache = new Map();
  async function enabled() {
    if (!root) return false;
    try {
      const info = await stat(root);
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  async function list(rel, { offset = 0, limit = 200 } = {}) {
    const read = await readFolder(rel);
    if (!read) return null;
    const start = clamp(offset == null || offset === '' ? 0 : offset, 0, 100_000);
    const size = clamp(limit == null || limit === '' ? 200 : limit, 1, 200);
    const tracks = await enrichAll(read.tracks.slice(start, start + size));
    tracks.sort(byTrack);
    return {
      ...read,
      tracks,
      total: read.tracks.length,
      offset: start,
    };
  }

  async function collect(rel) {
    const read = await readFolder(rel);
    if (!read) return null;
    return read.tracks.slice(0, PLAY_LIMIT);
  }

  async function readFolder(rel) {
    if (!(await enabled())) return null;
    const safe = safeRelative(rel);
    if (safe == null) return null;
    const dir = await directory(safe);
    if (!dir) return null;
    let entries;
    try {
      entries = await readdir(dir.filePath, { withFileTypes: true });
    } catch {
      return null;
    }
    const folders = [];
    const tracks = [];
    for (const entry of entries) {
      const name = entry.name;
      if (!name || name.startsWith('.') || entry.isSymbolicLink()) continue;
      const childRel = safe ? `${safe}/${name}` : name;
      if (entry.isDirectory()) {
        const summary = await folderSummary(childRel);
        folders.push({ name, path: childRel, trackCount: summary.trackCount, hasArt: summary.hasArt });
        continue;
      }
      if (!entry.isFile()) continue;
      const mime = AUDIO.get(path.extname(name).toLowerCase());
      if (!mime) continue;
      tracks.push(describe(childRel, null, mime));
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    tracks.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    return {
      name: safe ? safe.split('/').at(-1) : 'Downloads',
      path: safe,
      crumbs: crumbs(safe),
      hasArt: Boolean(pickCover(entries, dir.filePath)),
      folders,
      tracks,
    };
  }

  async function cover(rel) {
    if (!(await enabled())) return null;
    const safe = safeRelative(rel);
    if (safe == null) return null;
    const dir = await directory(safe);
    if (!dir) return null;
    let entries;
    try {
      entries = await readdir(dir.filePath, { withFileTypes: true });
    } catch {
      return null;
    }
    const image = pickCover(entries, dir.filePath);
    if (!image) return null;
    const filePath = await insideRoot(image.filePath);
    return filePath ? { filePath, mime: image.mime } : null;
  }

  async function open(rel) {
    if (!(await enabled())) return null;
    const safe = safeRelative(rel);
    if (!safe) return null;
    const mime = AUDIO.get(path.extname(safe).toLowerCase());
    if (!mime) return null;
    const filePath = await insideRoot(path.join(root, ...safe.split('/')));
    if (!filePath) return null;
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) return null;
    return { filePath, mime };
  }

  async function directory(rel) {
    const filePath = await insideRoot(rel ? path.join(root, ...rel.split('/')) : root);
    if (!filePath) return null;
    const info = await stat(filePath).catch(() => null);
    if (!info?.isDirectory()) return null;
    return { filePath };
  }

  async function insideRoot(target) {
    let rootReal;
    let fileReal;
    try {
      await access(root, constants.R_OK);
      rootReal = await realpath(root);
      fileReal = await realpath(target);
    } catch {
      return null;
    }
    if (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep)) return null;
    return fileReal;
  }

  async function folderSummary(rel) {
    const dir = await directory(rel);
    if (!dir) return { trackCount: 0, hasArt: false };
    let entries = [];
    try {
      entries = await readdir(dir.filePath, { withFileTypes: true });
    } catch {
      return { trackCount: 0, hasArt: false };
    }
    let trackCount = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      if (AUDIO.has(path.extname(entry.name).toLowerCase())) trackCount += 1;
    }
    return { trackCount, hasArt: Boolean(pickCover(entries, dir.filePath)) };
  }

  async function enrichAll(tracks) {
    const out = new Array(tracks.length);
    let cursor = 0;
    async function worker() {
      while (cursor < tracks.length) {
        const index = cursor;
        cursor += 1;
        out[index] = await enrich(tracks[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, () => worker()));
    return out;
  }

  async function enrich(track) {
    const filePath = await insideRoot(path.join(root, ...track.relPath.split('/')));
    if (!filePath) return track;
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) return track;
    const key = `${track.relPath}\0${info.mtimeMs}\0${info.size}`;
    if (!tagCache.has(key)) tagCache.set(key, await readTags(filePath));
    const tags = tagCache.get(key);
    if (!tags) return track;
    return {
      ...track,
      title: tags.title || track.title,
      artist: tags.artist || track.artist,
      album: tags.album || track.album,
      track: tags.track || track.track,
      duration: tags.duration,
      year: tags.year,
    };
  }

  async function audioFiles(rel) {
    const read = await readFolder(rel);
    if (!read) return null;
    const files = [];
    for (const track of read.tracks) {
      const opened = await open(track.relPath);
      if (!opened) continue;
      files.push({ filePath: opened.filePath, name: path.basename(track.relPath) });
    }
    return files;
  }

  async function details(rel) {
    const file = await open(rel);
    if (!file) return null;
    const info = await stat(file.filePath).catch(() => null);
    if (!info?.isFile()) return null;
    let metadata = null;
    try {
      metadata = await parseFile(file.filePath, { duration: true, skipCovers: true });
    } catch (error) {
      console.warn(`download info ${rel}: ${error.message}`);
    }
    return describeFile({
      metadata,
      path: rel,
      size: info.size,
      modified: info.mtime,
      place: 'Downloads',
      fallback: { title: path.basename(rel, path.extname(rel)) },
    });
  }

  async function audioFile(rel) {
    const opened = await open(rel);
    if (!opened) return null;
    return { filePath: opened.filePath, name: path.basename(rel) };
  }

  return { enabled, list, collect, open, cover, details, audioFiles, audioFile };
}

function describe(rel, size, mime) {
  const parts = rel.split('/');
  const filename = parts.at(-1);
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  const numbered = /^(\d{1,3})[\s.\-]+(.+)$/.exec(base.trim());
  return {
    id: createHash('sha1').update(`download\0${rel}`).digest('hex').slice(0, 16),
    source: 'download',
    relPath: rel,
    title: (numbered?.[2] || base).trim() || filename,
    artist: parts.length >= 3 ? parts.at(-3) : '',
    album: parts.length >= 2 ? parts.at(-2) : 'download',
    track: numbered ? Number(numbered[1]) : null,
    duration: null,
    format: ext.slice(1).toUpperCase(),
    size,
    mime,
    playable: true,
    missing: false,
  };
}

function byTrack(a, b) {
  const left = a.track || Number.MAX_SAFE_INTEGER;
  const right = b.track || Number.MAX_SAFE_INTEGER;
  return left - right || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
}

function pickCover(entries, dirPath) {
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const mime = IMAGE.get(ext);
    if (!mime) continue;
    const stem = path.basename(entry.name, ext).toLowerCase().replace(/[\s_-]+/g, '');
    if (!COVER_RANK.has(stem)) continue;
    const rank = COVER_RANK.get(stem);
    if (!best || rank < best.rank) best = { rank, mime, filePath: path.join(dirPath, entry.name) };
  }
  return best;
}

async function readTags(filePath) {
  try {
    const metadata = await parseFile(filePath, { skipCovers: true, duration: true });
    const common = metadata.common || {};
    const listed = Array.isArray(common.artists) ? common.artists.find(Boolean) : '';
    return {
      title: text(common.title),
      artist: text(common.artist) || text(listed),
      album: text(common.album),
      track: positive(common.track?.no),
      duration: rounded(metadata.format?.duration),
      year: positive(common.year),
    };
  } catch {
    return null;
  }
}

function text(value) {
  if (value == null) return '';
  return String(value).replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function positive(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function rounded(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const value = Math.round(duration * 10) / 10;
  return value > 0 ? value : null;
}

function crumbs(rel) {
  if (!rel) return [];
  const parts = rel.split('/');
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/'),
  }));
}

function safeRelative(rel) {
  if (rel == null || rel === '') return '';
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\')) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return min;
  return Math.min(max, Math.max(min, number));
}
