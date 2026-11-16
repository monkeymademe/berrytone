import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const FEATURES = [
  { key: 'albums', label: 'Albums', detail: 'Browse and play every album', fallback: true },
  { key: 'artists', label: 'Artists', detail: 'Browse artists and their albums', fallback: false },
  { key: 'folders', label: 'Folders', detail: 'Browse the folders on disk', fallback: false },
  { key: 'tracks', label: 'Tracks', detail: 'Browse every track in one list', fallback: false },
  { key: 'favourites', label: 'Favourites', detail: 'Hearts, shared with Amperfy', fallback: false },
  { key: 'playlists', label: 'Playlists', detail: 'Playlists shared by everyone', fallback: false },
  { key: 'find', label: 'Find music', detail: 'Save missing songs and YouTube pages', fallback: false },
  { key: 'downloads', label: 'Downloads', detail: 'Play the downloads folder', fallback: false },
  { key: 'rescan', label: 'Rescan', detail: 'Read the music folder for new files', fallback: false },
  { key: 'match', label: 'Match albums', detail: 'Ask MusicBrainz to fill in albums', fallback: false },
  { key: 'sonos', label: 'Sonos', detail: 'Play the queue on a speaker in the house', fallback: false },
];

const FEATURE_KEYS = new Set(FEATURES.map((feature) => feature.key));
const DUMMY_HASH = hashPassword('berrytone-unused-password');

export function createAccounts(store, dataDir) {
  for (const feature of FEATURES) store.ensureFeature(feature.key, feature.fallback);
  const secret = loadSecret(path.join(dataDir, 'auth.key'));

  function fanartView() {
    const key = store.getSetting('fanartApiKey') || '';
    return { set: key.length > 0, hint: key ? key.slice(-4) : '' };
  }

  function flags() {
    const saved = new Map(store.featureRows().map((row) => [row.key, Boolean(row.enabled)]));
    return Object.fromEntries(FEATURES.map((feature) => [feature.key, saved.get(feature.key) ?? feature.fallback]));
  }

  function present(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.created_at,
    };
  }

  function featuresFor(user) {
    if (!enabled() || user?.role === 'admin') return Object.fromEntries(FEATURES.map((feature) => [feature.key, true]));
    return flags();
  }

  function actor(user) {
    return { ...present(user), features: featuresFor(user) };
  }

  function enabled() {
    return store.userCount() > 0;
  }

  return {
    enabled,
    guest() {
      return { id: '', username: '', role: 'admin', features: featuresFor({ role: 'admin' }) };
    },
    ensureAdmin(username, password) {
      if (enabled()) return;
      const name = cleanUsername(username);
      if (!name || typeof password !== 'string' || !password) return;
      store.insertUser(record(name, password, 'admin', secret));
      console.log(`admin account ready: ${name}`);
    },
    actorFromSession(sessionId) {
      if (!enabled()) return this.guest();
      const userId = store.sessionUser(sessionId);
      if (!userId) return null;
      const user = store.userById(userId);
      return user ? actor(user) : null;
    },
    authenticate(username, password) {
      const user = store.userByName(cleanUsername(username) || '\0');
      const matches = passwordMatches(password, user?.password_hash || DUMMY_HASH);
      if (!user || !matches) return null;
      return actor(user);
    },
    fromSubsonic(params) {
      const username = params.get('u') || '';
      const user = store.userByName(username);
      const stored = user ? openSeal(secret, user.password_seal) : null;
      const token = params.get('t');
      const salt = params.get('s');
      let matches = false;
      if (user && stored != null && token && salt != null) {
        const expected = createHash('md5').update(`${stored}${salt}`).digest('hex');
        matches = safeEqual(token.toLowerCase(), expected);
      } else if (user && params.get('p') != null) {
        matches = passwordMatches(decodePassword(params.get('p')), user.password_hash);
      } else if (!user) {
        passwordMatches('nope', DUMMY_HASH);
      }
      if (!user || !matches) return null;
      return actor(user);
    },
    allows(user, key) {
      if (!enabled()) return true;
      return Boolean(user?.features?.[key]);
    },
    list() {
      return {
        users: store.listUsers().map((user) => present(user)),
        features: FEATURES.map((feature) => ({ ...feature, enabled: flags()[feature.key] })),
        fanart: fanartView(),
      };
    },
    fanartKey() {
      return store.getSetting('fanartApiKey') || '';
    },
    setFanartKey(value) {
      const key = String(value ?? '').trim();
      if (!key) {
        store.setSetting('fanartApiKey', '');
        return { fanart: fanartView() };
      }
      if (!/^[A-Za-z0-9]{16,80}$/.test(key)) return { error: 'Paste the Fanart personal API key' };
      store.setSetting('fanartApiKey', key);
      return { fanart: fanartView() };
    },
    createUser({ username, password, role }) {
      const name = cleanUsername(username);
      if (!name) return { error: 'Use letters, numbers, dots, or dashes in the username' };
      if (!acceptablePassword(password)) return { error: 'Use a password of at least 8 characters' };
      const nextRole = role === 'admin' ? 'admin' : 'user';
      if (store.userByName(name)) return { error: 'That username is already in use' };
      const user = record(name, password, nextRole, secret);
      try {
        store.insertUser(user);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) return { error: 'That username is already in use' };
        throw error;
      }
      return { user: present({ ...user, created_at: user.createdAt }) };
    },
    updateUser(id, { password, role }) {
      const user = store.userById(id);
      if (!user) return { error: 'That person is not here' };
      if ((role === 'admin' || role === 'user') && user.role === 'admin' && role === 'user' && store.adminCount() <= 1) {
        return { error: 'Keep at least one admin' };
      }
      if (password) {
        if (!acceptablePassword(password)) return { error: 'Use a password of at least 8 characters' };
        store.updateUser(id, { passwordHash: hashPassword(password), passwordSeal: seal(secret, password) });
        store.deleteSessions(id);
      }
      if (role === 'admin' || role === 'user') store.updateUser(id, { role });
      return { user: present(store.userById(id)) };
    },
    deleteUser(id) {
      const user = store.userById(id);
      if (!user) return { error: 'That person is not here' };
      if (user.role === 'admin' && store.adminCount() <= 1) return { error: 'Keep at least one admin' };
      store.deleteUser(id);
      return { ok: true };
    },
    setFeature(key, enabled) {
      if (!FEATURE_KEYS.has(key)) return { error: 'Unknown feature' };
      store.setFeature(key, Boolean(enabled));
      return { features: FEATURES.map((feature) => ({ ...feature, enabled: flags()[feature.key] })) };
    },
  };
}

function record(username, password, role, secret) {
  return {
    id: randomBytes(8).toString('hex'),
    username,
    passwordHash: hashPassword(password),
    passwordSeal: seal(secret, password),
    role,
    createdAt: new Date().toISOString(),
  };
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function passwordMatches(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length !== 16 || expected.length !== 32) return false;
  const key = scryptSync(String(password), salt, 32);
  return timingSafeEqual(key, expected);
}

export function cleanUsername(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) return '';
  return name;
}

function acceptablePassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

function loadSecret(file) {
  try {
    const saved = readFileSync(file);
    if (saved.length === 32) return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const created = randomBytes(32);
  writeFileSync(file, created, { mode: 0o600 });
  return created;
}

function seal(secret, password) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const data = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64url');
}

function openSeal(secret, payload) {
  try {
    const buf = Buffer.from(String(payload || ''), 'base64url');
    if (buf.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', secret, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function decodePassword(value) {
  const text = String(value || '');
  if (text.startsWith('enc:')) {
    const hex = text.slice(4);
    if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) return '';
    return Buffer.from(hex, 'hex').toString('utf8');
  }
  return text;
}

function safeEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest();
  const b = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(a, b);
}
