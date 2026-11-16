import assert from 'node:assert/strict';
import test from 'node:test';
import { createSonos, didl, lanAddress, parseDeviceDescription, parseZoneGroups } from '../server/sonos.js';

const LOCATION = 'http://192.168.1.20:1400/xml/device_description.xml';
const DESCRIPTION = `<?xml version="1.0"?>
<root><device>
  <roomName>Kitchen</roomName>
  <UDN>uuid:RINCON_000E5812345601400</UDN>
  <serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/MediaRenderer/AVTransport/Control</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/MediaRenderer/RenderingControl/Control</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:ZoneGroupTopology:1</serviceType><controlURL>/ZoneGroupTopology/Control</controlURL></service>
  </serviceList>
</device></root>`;

test('a speaker description and a grouped room keep the visible rooms', () => {
  const player = parseDeviceDescription(DESCRIPTION, LOCATION);
  assert.equal(player.id, 'RINCON_000E5812345601400');
  assert.equal(player.name, 'Kitchen');
  assert.equal(player.avTransport, 'http://192.168.1.20:1400/MediaRenderer/AVTransport/Control');
  const groups = parseZoneGroups(`<ZoneGroupState>&lt;ZoneGroup Coordinator="RINCON_000E5812345601400"&gt;&lt;ZoneGroupMember ZoneName="Kitchen" UUID="RINCON_000E5812345601400" Invisible="0"/&gt;&lt;ZoneGroupMember ZoneName="Sub" UUID="RINCON_SUB" Invisible="1"/&gt;&lt;/ZoneGroup&gt;</ZoneGroupState>`);
  assert.equal(groups[0].coordinator, 'RINCON_000E5812345601400');
  assert.deepEqual(groups[0].members.map((member) => member.name), ['Kitchen', 'Sub']);
  assert.equal(groups[0].members[1].invisible, true);
});

test('track details are escaped for the speaker', () => {
  const meta = didl({ title: 'A & B', artist: 'Adele', album: '21', mime: 'audio/mpeg', url: 'http://192.168.1.5:8083/api/sonos/stream/abc', art: '' });
  assert.match(meta, /A &amp; B/);
  assert.match(meta, /protocolInfo="http-get:\*:audio\/mpeg:\*"/);
  assert.doesNotMatch(meta, /<dc:title>A & B</);
});

test('the address given to a speaker is a private network address', () => {
  const address = lanAddress({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.40' }],
  }, 8083, '');
  assert.equal(address, 'http://192.168.1.40:8083');
});

test('the current queue is handed to the speaker without the login cookie', async () => {
  const calls = [];
  const speakers = createSonos({
    advertise: () => 'http://192.168.1.40:8083',
    discover: async () => [LOCATION],
    async resolve(spec) {
      assert.equal(spec.id, 'track1');
      return { kind: 'library', id: 'track1', filePath: '/music/a.mp3', mime: 'audio/mpeg', title: 'A & B', artist: 'Adele', album: '21', albumId: 'album1' };
    },
    async fetchImpl(url, options = {}) {
      calls.push({ url, method: options.method || 'GET', body: options.body || '', action: options.headers?.SOAPACTION || '' });
      if (!options.method || options.method === 'GET') return { ok: true, text: async () => DESCRIPTION };
      return { ok: true, status: 200, text: async () => '<s:Envelope></s:Envelope>' };
    },
  });
  const result = await speakers.play('RINCON_000E5812345601400', [{ id: 'track1' }]);
  assert.deepEqual(result, { room: 'Kitchen', count: 1 });
  const actions = calls.map((call) => call.action);
  assert.ok(actions.includes('"urn:schemas-upnp-org:service:AVTransport:1#RemoveAllTracksFromQueue"'));
  assert.ok(actions.includes('"urn:schemas-upnp-org:service:AVTransport:1#AddURIToQueue"'));
  assert.ok(actions.includes('"urn:schemas-upnp-org:service:AVTransport:1#Play"'));
  const queued = calls.find((call) => call.action.includes('AddURIToQueue')).body;
  assert.match(queued, /http:\/\/192\.168\.1\.40:8083\/api\/sonos\/stream\/[a-f0-9]{48}/);
  assert.match(queued, /A &amp;amp; B/);
  const token = queued.match(/stream\/([a-f0-9]{48})/)[1];
  assert.equal(speakers.recall(token).id, 'track1');
  assert.equal(speakers.recall('../etc/passwd'), null);
  await speakers.transport('RINCON_000E5812345601400', 'stop');
  assert.ok(calls.some((call) => call.action.includes('#Stop"')));
});

test('speaker state follows playing, pausing, and a track change', async () => {
  let transportState = 'PLAYING';
  const speakers = createSonos({
    advertise: () => 'http://192.168.1.40:8083',
    discover: async () => [LOCATION],
    async fetchImpl(url, options = {}) {
      if (!options.method || options.method === 'GET') return { ok: true, text: async () => DESCRIPTION };
      const action = options.headers?.SOAPACTION || '';
      if (action.includes('GetTransportInfo')) {
        return { ok: true, status: 200, text: async () => `<CurrentTransportState>${transportState}</CurrentTransportState>` };
      }
      if (action.includes('GetVolume')) {
        return { ok: true, status: 200, text: async () => '<CurrentVolume>18</CurrentVolume>' };
      }
      return { ok: true, status: 200, text: async () => '<s:Envelope></s:Envelope>' };
    },
  });
  await speakers.rooms();
  const playing = await speakers.state('RINCON_000E5812345601400');
  assert.equal(playing.playing, true);
  assert.equal(playing.volume, 18);
  transportState = 'PAUSED_PLAYBACK';
  assert.equal((await speakers.state('RINCON_000E5812345601400')).playing, false);
  transportState = 'STOPPED';
  assert.equal((await speakers.state('RINCON_000E5812345601400')).playing, false);
  transportState = 'TRANSITIONING';
  assert.equal((await speakers.state('RINCON_000E5812345601400')).playing, true);
});
