import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFile } from '../server/details.js';

test('song details keep the tags and the file location', () => {
  const info = describeFile({
    path: "Beyoncé/B'Day/02 Absent.mp3",
    size: 3_200_000,
    modified: new Date('2006-09-04T12:00:00Z'),
    metadata: {
      common: {
        title: 'Absent',
        artist: 'Beyoncé',
        album: "B'Day",
        albumartist: 'Beyoncé',
        track: { no: 2, of: 13 },
        disk: { no: 1, of: 1 },
        year: 2006,
        genre: ['Pop'],
        comment: [{ text: 'Deluxe' }],
        picture: [{ format: 'image/jpeg', data: Buffer.from('nope') }],
        musicbrainz_recordingid: '33333333-3333-4333-8333-333333333333',
        musicbrainz_albumid: '11111111-1111-4111-8111-111111111111',
      },
      format: { container: 'MPEG', codec: 'MP3', bitrate: 192000, sampleRate: 44100, numberOfChannels: 2, duration: 214 },
    },
  });
  assert.equal(info.title, 'Absent');
  assert.equal(info.place, 'Music library');
  assert.equal(info.path, "Beyoncé/B'Day/02 Absent.mp3");
  const value = (label) => info.fields.find((field) => field.label === label)?.value;
  assert.equal(value('Track'), '2 of 13');
  assert.equal(value('Disc'), '1 of 1');
  assert.equal(value('Comment'), 'Deluxe');
  assert.equal(value('MusicBrainz recording'), '33333333-3333-4333-8333-333333333333');
  assert.equal(value('Duration'), '3:34');
  assert.equal(value('Bitrate'), '192 kbps');
  assert.equal(value('Size'), '3.1 MB');
  assert.equal(info.fields.some((field) => field.label === 'Picture'), false);
});
