import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseArtistImage, createFanart } from '../server/fanart.js';

test('the best liked portrait is chosen, and a wide image is the fallback', () => {
  const portrait = chooseArtistImage({
    artistthumb: [
      { url: 'https://assets.fanart.tv/a.jpg', likes: '1' },
      { url: 'https://assets.fanart.tv/b.jpg', likes: '9' },
    ],
  });
  assert.equal(portrait, 'https://assets.fanart.tv/b.jpg');
  const wide = chooseArtistImage({
    artistbackground: [{ url: 'https://assets.fanart.tv/wide.jpg', likes: '2' }],
  });
  assert.equal(wide, 'https://assets.fanart.tv/wide.jpg');
  assert.equal(chooseArtistImage({ artistthumb: [{ url: 'https://example.com/a.jpg', likes: '4' }] }), null);
});

test('an artist portrait is downloaded from the picture Fanart names', async () => {
  const calls = [];
  const fanart = createFanart({
    key: 'abc123def456ghi7',
    async fetchImpl(url) {
      calls.push(url);
      if (url.includes('/v3/music/')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ artistthumb: [{ url: 'https://assets.fanart.tv/portrait.jpg', likes: '3' }] }) };
      }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    },
  });
  const image = await fanart.artistImage('4967c0a1-b9f3-465e-8440-4598fd9fc33c');
  assert.equal(image.ext, 'jpg');
  assert.equal(image.bytes.length, 3);
  assert.match(calls[0], /client_key=abc123def456ghi7/);
  assert.equal(calls[1], 'https://assets.fanart.tv/portrait.jpg');
  assert.equal(await fanart.artistImage('not-an-id'), null);
});
