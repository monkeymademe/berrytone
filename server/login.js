export const SESSION_COOKIE = 'berrytone_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

export function safeNext(value) {
  if (typeof value !== 'string') return '/';
  const path = value.split('?')[0];
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('\n')) return '/';
  if (path === '/login' || path.startsWith('/login/') || path.startsWith('/rest/')) return '/';
  return path.slice(0, 200);
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const split = part.trim().indexOf('=');
    if (split < 1) continue;
    const key = part.trim().slice(0, split);
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.trim().slice(split + 1));
    } catch {
      return '';
    }
  }
  return '';
}

export function sessionCookie(id, { secure = false } = {}) {
  const secureFlag = secure ? '; Secure' : '';
  if (!id) return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`;
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secureFlag}`;
}

export function createLimiter({ limit = 8, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    blocked(ip, now = Date.now()) {
      const row = hits.get(ip);
      return Boolean(row && row.resetAt > now && row.count >= limit);
    },
    fail(ip, now = Date.now()) {
      const row = hits.get(ip);
      if (!row || row.resetAt <= now) {
        hits.set(ip, { count: 1, resetAt: now + windowMs });
        return;
      }
      row.count += 1;
    },
    clear(ip) {
      hits.delete(ip);
    },
  };
}
