import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { updateFile } from 'music-metadata';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wav']);

export async function acquireAudio({ url, workDir, tags, tagImpl = updateFile, spawnImpl = spawn, onProgress }) {
  const downloaded = path.join(workDir, 'source.%(ext)s');
  onProgress?.({ phase: 'download', percent: 0 });
  const fetched = await run(spawnImpl, 'yt-dlp', [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--restrict-filenames',
    '--max-filesize', '40M',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '2',
    '-o', downloaded,
    '--',
    url,
  ], 180_000, onProgress);
  if (fetched.code !== 0) {
    const missing = fetched.error?.code === 'ENOENT';
    throw new Error(missing ? 'The YouTube downloader is not installed.' : failureText(fetched.stderr, 'YouTube did not return that song.'));
  }
  const source = await firstAudio(workDir);
  if (!source) throw new Error('YouTube did not return an audio file.');
  onProgress?.({ phase: 'prepare', percent: null });
  const dest = path.join(workDir, 'song.mp3');
  const tagged = await run(spawnImpl, 'ffmpeg', [
    '-y',
    '-i', source,
    '-map_metadata', '-1',
    '-c:a', 'libmp3lame',
    '-q:a', '2',
    dest,
  ], 120_000);
  if (tagged.code !== 0) {
    const missing = tagged.error?.code === 'ENOENT';
    throw new Error(missing ? 'Audio tools are not installed.' : failureText(tagged.stderr, 'The song could not be prepared.'));
  }
  if (tags) await tagImpl(dest, tagPatch(tags));
  return dest;
}

export function tagPatch(tags) {
  const patch = {
    title: tags.title,
    artist: tags.artist,
    albumartist: tags.albumArtist,
    album: tags.album,
  };
  if (tags.track) patch.track = tags.trackTotal ? { no: tags.track, of: tags.trackTotal } : { no: tags.track };
  if (tags.disc) patch.disk = tags.discTotal ? { no: tags.disc, of: tags.discTotal } : { no: tags.disc };
  if (tags.year) patch.year = tags.year;
  if (tags.recordingMbid) patch.musicbrainz_recordingid = tags.recordingMbid;
  if (tags.releaseMbid) patch.musicbrainz_albumid = tags.releaseMbid;
  if (tags.releaseGroupMbid) patch.musicbrainz_releasegroupid = tags.releaseGroupMbid;
  if (tags.artistMbid) patch.musicbrainz_artistid = tags.artistMbid;
  if (tags.albumArtistMbid) patch.musicbrainz_albumartistid = tags.albumArtistMbid;
  return patch;
}

async function firstAudio(dir) {
  const names = await readdir(dir).catch(() => []);
  const audio = names.find((name) => AUDIO_EXT.has(path.extname(name).toLowerCase()) && name !== 'song.mp3');
  return audio ? path.join(dir, audio) : null;
}

export function readDownloadProgress(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  if (text.includes('[download]')) {
    const percent = text.match(/(\d{1,3}(?:\.\d+)?)%/);
    if (!percent) return { phase: 'download', percent: null };
    return { phase: 'download', percent: Math.max(0, Math.min(100, Number(percent[1]))) };
  }
  if (/ExtractAudio|Merger|\[ffmpeg\]/.test(text)) return { phase: 'prepare', percent: null };
  return null;
}

function run(spawnImpl, command, args, timeoutMs, onProgress) {
  return new Promise((resolve) => {
    let child;
    let stderr = '';
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      finish({ code: 1, stderr: '', error });
      return;
    }
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r|\n/)) {
        const progress = readDownloadProgress(line);
        if (progress) onProgress?.(progress);
      }
      if (!text.includes('[download]')) stderr = `${stderr}${text}`.slice(-2000);
    });
    child.on('error', (error) => finish({ code: 1, stderr, error }));
    child.on('close', (code) => finish({ code: code ?? 1, stderr }));
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: 1, stderr: 'The download took too long.' });
    }, timeoutMs);
  });
}

function failureText(stderr, fallback) {
  const line = String(stderr || '').split('\n').map((item) => item.trim()).filter(Boolean).at(-1) || '';
  return line.replace(/\s+/g, ' ').slice(0, 180) || fallback;
}
