import { createHash } from 'node:crypto';

const GENERIC_ARTISTS = new Set([
  'various',
  'various artists',
  'va',
  'compilations',
  'compilation',
  'soundtrack',
  'soundtracks',
  'unknown artist',
]);

export function groupFiles(files) {
  for (const file of files) {
    file.tagAlbum = file.tagAlbum || file.album;
    file.tagAlbumArtist = file.tagAlbumArtist || file.albumArtist;
  }
  const groups = new Map();
  for (const file of files) {
    const album = file.tagAlbum;
    const albumArtist = file.tagAlbumArtist;
    const key = file.releaseMbid ? `mbid:${file.releaseMbid}` : `name:${normKey(albumArtist)}\0${normKey(album)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        releaseMbid: file.releaseMbid || null,
        title: album || 'Unknown album',
        artist: albumArtist || 'Unknown artist',
        files: [],
      };
      groups.set(key, group);
    }
    group.files.push(file);
  }
  for (const group of groups.values()) {
    group.title = mostCommon(group.files.map((file) => file.tagAlbum)) || group.title;
    group.artist = mostCommon(group.files.map((file) => file.tagAlbumArtist)) || group.artist;
    group.fileCount = group.files.length;
  }
  return [...groups.values()];
}

export function buildCatalog(files, releaseForGroup, merges = []) {
  const groups = groupFiles(files);
  const buckets = new Map();
  for (const group of groups) {
    const cached = releaseForGroup(group);
    const release = cached?.matched ? cached.release : null;
    const id = release?.releaseMbid
      ? stableId('release', release.releaseMbid)
      : stableId('album', normKey(group.artist), normKey(group.title));
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = {
        id,
        release,
        title: release?.title || group.title,
        artist: release?.artist || group.artist,
        year: release?.year || null,
        files: [],
      };
      buckets.set(id, bucket);
    }
    if (release) rememberRelease(bucket, release);
    for (const file of group.files) {
      file.bucketId = id;
      bucket.files.push(file);
    }
  }

  const albums = [];
  const homeByFile = new Map();
  const merged = collapseEditions([...buckets.values()]);
  for (const bucket of merged) {
    for (const file of bucket.files) file.bucketId = bucket.id;
  }
  const index = indexFiles(files);
  for (const bucket of merged) {
    const artistId = stableId('artist', normKey(bucket.artist));
    const year = bucket.year || mostYear(bucket.files);
    for (const file of bucket.files) {
      file.albumId = bucket.id;
      file.artistId = artistId;
      file.album = bucket.title;
      file.albumArtist = bucket.artist;
      homeByFile.set(file.id, bucket.title);
    }
    const slots = bucket.release ? slotsFromRelease(bucket, index) : slotsFromFiles(bucket);
    const found = slots.filter((slot) => slot.link !== 'missing');
    albums.push({
      id: bucket.id,
      title: bucket.title,
      artist: bucket.artist,
      artistId,
      year,
      release: bucket.release || null,
      releaseMbid: bucket.release?.releaseMbid || null,
      edition: bucket.release?.disambiguation || null,
      source: bucket.release ? 'musicbrainz' : 'local',
      trackCount: slots.length,
      foundCount: found.length,
      missingCount: slots.filter((slot) => slot.link === 'missing').length,
      linkedCount: slots.filter((slot) => slot.link === 'linked').length,
      duration: sumDuration(slots),
      slots,
      homeFiles: bucket.files,
    });
  }
  return { albums: applyAlbumMerges(albums, merges), homeByFile };
}

export function applyAlbumMerges(albums, merges = []) {
  const gone = new Set();
  for (const merge of merges || []) {
    const into = albums.find((album) => !gone.has(album) && sameAlbum(album, merge.intoArtist, merge.intoTitle));
    const from = albums.find((album) => album !== into && !gone.has(album) && sameAlbum(album, merge.fromArtist, merge.fromTitle));
    if (!into || !from) continue;
    const brought = from.homeFiles || [];
    for (const file of brought) file.mergedAlbum = from.title;
    into.homeFiles = [...(into.homeFiles || []), ...brought];
    for (const file of into.homeFiles) {
      file.bucketId = into.id;
      file.albumId = into.id;
      file.artistId = into.artistId;
      file.album = into.title;
      file.albumArtist = into.artist;
    }
    const bucket = {
      id: into.id,
      title: into.title,
      artist: into.artist,
      release: into.release,
      files: into.homeFiles,
    };
    let slots = into.release ? slotsFromRelease(bucket, indexFiles(into.homeFiles)) : slotsFromFiles(bucket);
    if (into.release) {
      const used = new Set(slots.map((slot) => slot.fileId).filter(Boolean));
      for (const file of brought) {
        if (used.has(file.id)) continue;
        slots.push(fileSlot(file));
      }
    }
    into.slots = slots;
    const found = slots.filter((slot) => slot.link !== 'missing');
    into.trackCount = slots.length;
    into.foundCount = found.length;
    into.missingCount = slots.filter((slot) => slot.link === 'missing').length;
    into.linkedCount = slots.filter((slot) => slot.link === 'linked').length;
    into.duration = sumDuration(slots);
    into.merged = [...(into.merged || []), { artist: from.artist, title: from.title }];
    gone.add(from);
  }
  return albums.filter((album) => !gone.has(album));
}

function sameAlbum(album, artist, title) {
  return foldTitle(album.artist) === foldTitle(artist) && foldTitle(album.title) === foldTitle(title);
}

function rememberRelease(bucket, release) {
  bucket.releases = bucket.releases || [];
  if (!bucket.release) {
    bucket.release = release;
    bucket.title = release.title || bucket.title;
    bucket.artist = release.artist || bucket.artist;
    bucket.year = release.year || bucket.year;
  }
  if (release.releaseMbid && bucket.releases.some((item) => item.releaseMbid === release.releaseMbid)) return;
  bucket.releases.push(release);
}

function collapseEditions(buckets) {
  const byGroup = new Map();
  const loose = [];
  for (const bucket of buckets) {
    const groupId = bucket.release?.releaseGroupMbid || soleReleaseGroup(bucket.files);
    if (!groupId) {
      loose.push(bucket);
      continue;
    }
    const existing = byGroup.get(groupId);
    if (!existing) {
      bucket.releaseGroupMbid = groupId;
      byGroup.set(groupId, bucket);
      continue;
    }
    addFiles(existing, bucket.files);
    for (const release of bucket.releases || []) rememberRelease(existing, release);
  }
  const kept = [...byGroup.values()];
  for (const bucket of loose) {
    const title = foldTitle(bucket.title);
    const artist = foldTitle(bucket.artist);
    const matches = kept.filter((item) => item.release && foldTitle(item.title) === title && foldTitle(item.artist) === artist);
    if (matches.length === 1) {
      addFiles(matches[0], bucket.files);
      continue;
    }
    kept.push(bucket);
  }
  for (const bucket of kept) {
    const chosen = chooseEdition(bucket.releases || [], bucket.files);
    if (!chosen) continue;
    bucket.release = chosen;
    bucket.title = chosen.title || bucket.title;
    bucket.artist = chosen.artist || bucket.artist;
    bucket.year = chosen.year || bucket.year;
    bucket.id = stableId('release', chosen.releaseMbid);
  }
  return kept;
}

function addFiles(bucket, files) {
  const seen = new Set(bucket.files.map((file) => file.id));
  for (const file of files) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    bucket.files.push(file);
  }
}

function soleReleaseGroup(files) {
  const ids = new Set(files.map((file) => file.releaseGroupMbid).filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

export function chooseEdition(releases, files) {
  const unique = [];
  const seen = new Set();
  for (const release of releases) {
    if (!release?.releaseMbid || seen.has(release.releaseMbid)) continue;
    seen.add(release.releaseMbid);
    unique.push(release);
  }
  if (unique.length <= 1) return unique[0] || null;
  const tagged = new Map();
  for (const file of files) {
    if (!file.releaseMbid) continue;
    tagged.set(file.releaseMbid, (tagged.get(file.releaseMbid) || 0) + 1);
  }
  unique.sort((left, right) => editionScore(right, files) - editionScore(left, files) || (tagged.get(right.releaseMbid) || 0) - (tagged.get(left.releaseMbid) || 0));
  return unique[0];
}

function editionScore(release, files) {
  const used = new Set();
  let matched = 0;
  for (const expected of release.tracks || []) {
    const file = files.find((item) => !used.has(item.id) && sameRecording(expected, item, false));
    if (!file) continue;
    used.add(file.id);
    matched += 1;
  }
  const missing = (release.tracks?.length || 0) - matched;
  const spare = Math.max(0, files.length - matched);
  return matched * 1000 - missing * 15 - spare * 3;
}

function indexFiles(files) {
  const byRecording = new Map();
  const byTitle = new Map();
  for (const file of files) {
    file.foldedTitle = foldTitle(file.title);
    file.foldedArtist = foldTitle(file.artist);
    if (file.recordingMbid) pushIndex(byRecording, file.recordingMbid, file);
    if (file.foldedTitle) pushIndex(byTitle, file.foldedTitle, file);
  }
  return { byRecording, byTitle };
}

function pushIndex(map, key, file) {
  const list = map.get(key);
  if (list) list.push(file);
  else map.set(key, [file]);
}

function slotsFromRelease(bucket, index) {
  const used = new Set();
  return bucket.release.tracks.map((expected, position) => {
    const file = pickFile(expected, index, bucket, used);
    if (!file) {
      return {
        id: stableId('slot', bucket.id, String(expected.disc || 1), String(expected.track || position + 1), expected.title),
        fileId: null,
        title: expected.title,
        artist: expected.artist,
        track: expected.track || null,
        disc: expected.disc || null,
        duration: expected.duration,
        format: null,
        genre: null,
        link: 'missing',
        sourceAlbum: null,
        recordingMbid: expected.recordingMbid || null,
      };
    }
    used.add(file.id);
    const brought = Boolean(file.mergedAlbum);
    const linked = brought || file.bucketId !== bucket.id;
    return {
      id: file.id,
      fileId: file.id,
      title: expected.title || file.title,
      artist: expected.artist || file.artist,
      track: expected.track || file.track || null,
      disc: expected.disc || file.disc || null,
      duration: expected.duration || file.duration,
      format: file.format,
      genre: file.genre,
      link: linked ? 'linked' : 'home',
      sourceAlbum: brought ? file.mergedAlbum : (linked ? file.tagAlbum || file.album : null),
      recordingMbid: expected.recordingMbid || file.recordingMbid || null,
    };
  });
}

function slotsFromFiles(bucket) {
  const ordered = bucket.files.slice().sort(compareFiles);
  return ordered.map((file) => ({
    id: file.id,
    fileId: file.id,
    title: file.title,
    artist: file.artist,
    track: file.track,
    disc: file.disc,
    duration: file.duration,
    format: file.format,
    genre: file.genre,
      link: file.mergedAlbum ? 'linked' : 'home',
      sourceAlbum: file.mergedAlbum || null,
    recordingMbid: file.recordingMbid || null,
  }));
}

function pickFile(expected, index, bucket, used) {
  const seen = new Set();
  const matches = [];
  const consider = (file) => {
    if (!file || used.has(file.id) || seen.has(file.id)) return;
    seen.add(file.id);
    if (sameRecording(expected, file, file.bucketId === bucket.id)) matches.push(file);
  };
  if (expected.recordingMbid) {
    for (const file of index.byRecording.get(expected.recordingMbid) || []) consider(file);
  }
  const title = foldTitle(expected.title);
  for (const file of index.byTitle.get(title) || []) consider(file);
  if (!matches.length) return null;
  matches.sort((left, right) => fileRank(right, bucket) - fileRank(left, bucket));
  return matches[0];
}

function sameRecording(expected, file, home) {
  if (expected.recordingMbid && file.recordingMbid) return expected.recordingMbid === file.recordingMbid;
  const wantedTitle = foldTitle(expected.title);
  if (!wantedTitle || wantedTitle !== (file.foldedTitle || foldTitle(file.title))) return false;
  const artistOk = namesMatch(foldTitle(expected.artist), file.foldedArtist || foldTitle(file.artist)) || (home && isGenericArtist(file.artist));
  if (!artistOk) return false;
  if (file.mergedAlbum) return true;
  return durationClose(expected.duration, file.duration);
}

function fileRank(file, bucket) {
  let rank = 0;
  if (file.bucketId === bucket.id) rank += 50;
  if (bucket.release?.releaseMbid && file.releaseMbid === bucket.release.releaseMbid) rank += 40;
  if (titlesMatch(file.album, bucket.title)) rank += 10;
  return rank;
}

function titlesMatch(left, right) {
  const a = foldTitle(left);
  const b = foldTitle(right);
  return Boolean(a && b && a === b);
}

function namesMatch(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 5) return false;
  return longer === shorter || longer.startsWith(`${shorter} `) || longer.includes(` ${shorter} `) || longer.startsWith(`${shorter} feat`);
}

function durationClose(expected, actual) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected <= 0 || actual <= 0) return true;
  const delta = Math.abs(expected - actual);
  return delta <= 5 || delta / expected <= 0.1;
}

function fileSlot(file) {
  return {
    id: file.id,
    fileId: file.id,
    title: file.title,
    artist: file.artist,
    track: file.track,
    disc: file.disc,
    duration: file.duration,
    format: file.format,
    genre: file.genre,
    link: 'linked',
    sourceAlbum: file.mergedAlbum || file.tagAlbum || null,
    recordingMbid: file.recordingMbid || null,
  };
}

function compareFiles(left, right) {
  return (left.disc || 0) - (right.disc || 0) || (left.track || 0) - (right.track || 0) || foldTitle(left.title).localeCompare(foldTitle(right.title));
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = values.find(Boolean) || '';
  let count = 0;
  for (const [value, total] of counts) {
    if (total > count) {
      best = value;
      count = total;
    }
  }
  return best;
}

function mostYear(files) {
  return mostCommon(files.map((file) => file.year).filter(Boolean)) || null;
}

function sumDuration(slots) {
  let total = 0;
  let known = false;
  for (const slot of slots) {
    if (Number.isFinite(slot.duration)) {
      total += slot.duration;
      known = true;
    }
  }
  return known ? Math.round(total * 10) / 10 : null;
}

export function stableId(...parts) {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);
}

export function normKey(value) {
  return clean(value).toLocaleLowerCase();
}

export function foldTitle(value) {
  return normKey(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGenericArtist(value) {
  return GENERIC_ARTISTS.has(foldTitle(value));
}

function clean(value) {
  if (value == null) return '';
  return String(value).replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}
