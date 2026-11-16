import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDb } from '../server/db.js';
import { createLimiter, readCookie, safeNext, sessionCookie } from '../server/login.js';

test('a sign-in session is remembered and can be cleared', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'berrytone-login-'));
  try {
    const db = openLibraryDb(dir);
    const id = db.createSession(Date.now() + 60_000);
    assert.equal(db.validSession(id), true);
    assert.equal(db.validSession('nope'), false);
    db.deleteSession(id);
    assert.equal(db.validSession(id), false);
    assert.equal(db.validSession(db.createSession(Date.now() - 1000)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the sign-in cookie stays on this site and the next page stays local', () => {
  const cookie = sessionCookie('a'.repeat(64));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(sessionCookie('a'.repeat(64), { secure: true }), /Secure/);
  assert.match(sessionCookie(''), /Max-Age=0/);
  assert.equal(readCookie(`other=1; berrytone_session=${'ab'.repeat(32)}`, 'berrytone_session'), 'ab'.repeat(32));
  assert.equal(safeNext('/album/abcdef0123456789'), '/album/abcdef0123456789');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('/login'), '/');
});

test('repeated wrong passwords pause new tries', () => {
  const limiter = createLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.blocked('1.2.3.4', 0), false);
  limiter.fail('1.2.3.4', 0);
  limiter.fail('1.2.3.4', 10);
  assert.equal(limiter.blocked('1.2.3.4', 20), true);
  limiter.clear('1.2.3.4');
  assert.equal(limiter.blocked('1.2.3.4', 20), false);
});
