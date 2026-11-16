const LABELS = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['artists', 'Artists'],
  ['albumartist', 'Album artist'],
  ['album', 'Album'],
  ['year', 'Year'],
  ['date', 'Date'],
  ['originalyear', 'Original year'],
  ['originalartist', 'Original artist'],
  ['originalalbum', 'Original album'],
  ['track', 'Track'],
  ['disk', 'Disc'],
  ['genre', 'Genre'],
  ['composer', 'Composer'],
  ['lyricist', 'Lyricist'],
  ['writer', 'Writer'],
  ['conductor', 'Conductor'],
  ['remixer', 'Remixer'],
  ['comment', 'Comment'],
  ['grouping', 'Grouping'],
  ['bpm', 'BPM'],
  ['mood', 'Mood'],
  ['label', 'Label'],
  ['copyright', 'Copyright'],
  ['isrc', 'ISRC'],
  ['barcode', 'Barcode'],
  ['catalognumber', 'Catalog number'],
  ['media', 'Media'],
  ['movement', 'Movement'],
  ['work', 'Work'],
  ['key', 'Key'],
  ['releasestatus', 'Release status'],
  ['releasetype', 'Release type'],
  ['lyrics', 'Lyrics'],
  ['musicbrainz_recordingid', 'MusicBrainz recording'],
  ['musicbrainz_albumid', 'MusicBrainz release'],
  ['musicbrainz_releasegroupid', 'MusicBrainz release group'],
  ['musicbrainz_trackid', 'MusicBrainz track'],
  ['musicbrainz_artistid', 'MusicBrainz artist'],
  ['musicbrainz_albumartistid', 'MusicBrainz album artist'],
];

export function describeFile({ metadata, path: filePath = '', size, modified, fallback = {}, place = 'Music library' } = {}) {
  const common = metadata?.common || {};
  const format = metadata?.format || {};
  const fields = [];
  const used = new Set();
  const push = (label, value, key) => {
    const text = present(value);
    if (!text) return;
    if (key) used.add(key);
    fields.push({ label, value: text });
  };
  for (const [key, label] of LABELS) push(label, common[key], key);
  for (const [key, value] of Object.entries(common)) {
    if (used.has(key) || key === 'picture') continue;
    push(labelize(key), value, key);
  }
  push('Duration', clock(format.duration || fallback.duration));
  push('Format', String(format.container || fallback.format || '').toUpperCase());
  push('Codec', format.codec);
  push('Bitrate', format.bitrate ? `${Math.round(format.bitrate / 1000)} kbps` : '');
  push('Sample rate', format.sampleRate ? `${Math.round(format.sampleRate)} Hz` : '');
  push('Channels', format.numberOfChannels);
  push('Bits per sample', format.bitsPerSample);
  push('Size', formatBytes(size ?? fallback.size));
  push('Modified', stamp(modified));
  return {
    title: present(common.title) || present(fallback.title) || 'Song',
    place,
    path: filePath || '',
    fields,
  };
}

function present(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return value.replace(/\0/g, '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 4000);
  if (Array.isArray(value)) return value.map(present).filter(Boolean).join(', ').slice(0, 4000);
  if (typeof value === 'object') {
    if (Number.isInteger(value.no) && value.no > 0) return value.of ? `${value.no} of ${value.of}` : String(value.no);
    if (typeof value.text === 'string') return present(value.text);
  }
  return '';
}

function labelize(key) {
  const words = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function clock(duration) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stamp(modified) {
  const date = modified instanceof Date ? modified : modified ? new Date(modified) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}
