import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAccounts } from '../server/accounts.js';
import { createLibrary } from '../server/library.js';
import { subsonic } from '../server/subsonic.js';

test('users start with albums and an admin can switch every other feature', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'berrytone-people-'));
  const library = createLibrary({ musicDir: path.join(root, 'music'), dataDir: path.join(root, 'data') });
  try {
    await library.load();
    const accounts = createAccounts(library.store(), path.join(root, 'data'));
    accounts.ensureAdmin('ada', 'admin-pass-word');
    accounts.ensureAdmin('other', 'should-not-replace');
    assert.equal(accounts.authenticate('ada', 'admin-pass-word')?.role, 'admin');
    assert.equal(accounts.authenticate('other', 'should-not-replace'), null);
    assert.equal(accounts.authenticate('ada', 'wrong-password'), null);

    const created = accounts.createUser({ username: 'sam', password: 'listener-pass', role: 'user' });
    assert.equal(created.user.role, 'user');
    const sam = accounts.authenticate('sam', 'listener-pass');
    assert.equal(sam.features.albums, true);
    assert.equal(sam.features.artists, false);
    assert.equal(sam.features.playlists, false);
    assert.equal(sam.features.downloads, false);
    assert.equal(accounts.authenticate('ada', 'admin-pass-word').features.downloads, true);
    assert.equal(accounts.createUser({ username: 'sam', password: 'listener-pass', role: 'user' }).error, 'That username is already in use');

    library.store().createPlaylist('Evening', []);
    const hidden = ask(library, accounts, 'getplaylists', { u: 'sam', p: 'listener-pass' });
    assert.match(hidden, /<playlists\/>/);
    assert.doesNotMatch(hidden, /Evening/);
    accounts.setFeature('playlists', true);
    const shown = ask(library, accounts, 'getplaylists', { u: 'sam', p: 'listener-pass' });
    assert.match(shown, /Evening/);

    const salt = 'salty';
    const token = createHash('md5').update(`listener-pass${salt}`).digest('hex');
    const authed = ask(library, accounts, 'ping', { u: 'sam', t: token, s: salt });
    assert.match(authed, /status="ok"/);
    const rejected = subsonic({
      library,
      params: new URLSearchParams({ u: 'sam', p: 'nope' }),
      action: 'ping',
      accounts,
    });
    assert.match(rejected.body, /code="40"/);

    assert.equal(accounts.deleteUser(accounts.authenticate('ada', 'admin-pass-word').id).error, 'Keep at least one admin');
    accounts.updateUser(sam.id, { password: 'fresh-password' });
    assert.equal(accounts.authenticate('sam', 'listener-pass'), null);
    assert.equal(accounts.authenticate('sam', 'fresh-password')?.username, 'sam');

    assert.deepEqual(accounts.list().fanart, { set: false, hint: '' });
    assert.equal(accounts.setFanartKey('short').error, 'Paste the Fanart personal API key');
    const saved = accounts.setFanartKey('abc123def456ghi7');
    assert.deepEqual(saved.fanart, { set: true, hint: 'ghi7' });
    assert.equal(accounts.fanartKey(), 'abc123def456ghi7');
    assert.equal(JSON.stringify(accounts.list()).includes('abc123def456ghi7'), false);
    assert.deepEqual(accounts.setFanartKey('').fanart, { set: false, hint: '' });
    assert.equal(accounts.fanartKey(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function ask(library, accounts, action, values) {
  const result = subsonic({
    library,
    params: new URLSearchParams(values),
    action,
    accounts,
  });
  assert.equal(typeof result.body, 'string', action);
  return result.body;
}
