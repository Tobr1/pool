import crypto from 'node:crypto';
import { HttpError, now, sha256 } from './util.js';

const SESSION_DAYS = 30;
export const COOKIE = 'pool_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres', 'validation');
  if (pw.length > 200) throw new HttpError(400, 'Contraseña demasiado larga', 'validation');
  return pw;
}

export function validateUsername(u) {
  const s = typeof u === 'string' ? u.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,30}$/.test(s)) {
    throw new HttpError(400, 'Usuario: de 3 a 30 caracteres (letras, números, punto o guion)', 'validation');
  }
  return s;
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, t, t + SESSION_DAYS * 86400_000);
  return token;
}

export function destroySession(db, token) {
  if (token) db.q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.q(`
    SELECT u.id, u.username, u.display_name, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now());
  if (!row || !row.active) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export function sessionCookie(token, { secure }) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------- Límite de intentos fallidos (en memoria) ----------
// Tres contadores: por IP+usuario (8), por IP (30, frena el "password spraying")
// y por usuario desde cualquier IP (20, frena la rotación de IPs). Ventana: 10 min.
const WINDOW = 10 * 60_000;
const LIMITS = { pair: 8, ip: 30, user: 20 };
const failures = new Map();

function prune() {
  const t = now();
  for (const [k, f] of failures) if (t - f.first > WINDOW) failures.delete(k);
}
setInterval(prune, WINDOW).unref();

const keysFor = (ip, username) => [[`p|${ip}|${username}`, LIMITS.pair], [`i|${ip}`, LIMITS.ip], [`u|${username}`, LIMITS.user]];

export function checkLoginRate(ip, username) {
  const t = now();
  for (const [k, max] of keysFor(ip, username)) {
    const f = failures.get(k);
    if (f && f.count >= max && t - f.first < WINDOW) {
      throw new HttpError(429, 'Demasiados intentos. Esperá unos minutos.', 'rate_limited');
    }
  }
}

export function registerLoginFailure(ip, username) {
  if (failures.size > 50_000) prune();
  const t = now();
  for (const [k] of keysFor(ip, username)) {
    const f = failures.get(k);
    if (!f || t - f.first > WINDOW) failures.set(k, { count: 1, first: t });
    else f.count++;
  }
}

export function clearLoginFailures(ip, username) {
  failures.delete(`p|${ip}|${username}`);
}

/** Hash fijo para gastar el mismo tiempo cuando el usuario no existe (evita enumerar usuarios). */
export const DUMMY_HASH = hashPassword('usuario-inexistente');
