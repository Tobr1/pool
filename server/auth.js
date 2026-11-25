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

/** Limita intentos fallidos de login por IP+usuario (en memoria). */
const failures = new Map();
export function checkLoginRate(key) {
  const f = failures.get(key);
  if (f && f.count >= 8 && now() - f.first < 10 * 60_000) {
    throw new HttpError(429, 'Demasiados intentos. Esperá unos minutos.', 'rate_limited');
  }
}
export function registerLoginFailure(key) {
  const f = failures.get(key);
  if (!f || now() - f.first > 10 * 60_000) failures.set(key, { count: 1, first: now() });
  else f.count++;
}
export function clearLoginFailures(key) {
  failures.delete(key);
}
