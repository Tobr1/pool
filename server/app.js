import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { COOKIE, userFromToken } from './auth.js';
import { registerRoutes } from './routes.js';
import { HttpError } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function createRouter() {
  const routes = [];
  const add = (method) => (pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, opts, handler });
  };
  return {
    get: add('GET'), post: add('POST'), patch: add('PATCH'),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { route: r, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Solicitud demasiado grande', 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // rutas de la SPA
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // Siempre revalidar: así una actualización llega sin limpiar caché.
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/**
 * Crea el servidor HTTP de la aplicación.
 * @param {{dbFile: string, demo?: boolean, log?: (msg: string) => void, trustProxy?: boolean}} opts
 */
export function createApp({ dbFile, demo = false, log = console.log, trustProxy = false }) {
  const db = openDb(dbFile);
  const ctx = { db, demo, setupCode: null };
  if (db.q('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    ctx.setupCode = String(crypto.randomInt(100000, 1000000));
  }
  const router = createRouter();
  registerRoutes(router, ctx);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      serveStatic(req, res, pathname);
      return;
    }
    try {
      const found = router.match(req.method, pathname);
      if (!found) throw new HttpError(404, 'Ruta inexistente', 'not_found');
      if (found.methodNotAllowed) throw new HttpError(405, 'Método no permitido', 'method');
      const { route, params } = found;

      let body = {};
      if (req.method !== 'GET') {
        // Defensa CSRF: solo aceptamos JSON con un encabezado propio de la app.
        if (req.headers['x-requested-with'] !== 'pool-app' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(403, 'Solicitud no permitida', 'csrf');
        }
        const raw = await readBody(req);
        if (raw) {
          try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'JSON inválido', 'bad_json'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON inválido', 'bad_json');
        }
      }

      const token = parseCookies(req.headers.cookie)[COOKIE];
      const user = userFromToken(db, token);
      if (route.opts.auth !== 'none' && !user) throw new HttpError(401, 'Tu sesión terminó. Volvé a ingresar.', 'unauthenticated');
      if (route.opts.auth === 'admin' && user.role !== 'admin') {
        throw new HttpError(403, 'Esta acción es solo para la administradora', 'forbidden');
      }
      const forwardedProto = trustProxy ? req.headers['x-forwarded-proto'] : undefined;
      const result = await route.handler({
        req, res, params, body, user, token,
        query: url.searchParams,
        ip: (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '',
        secure: forwardedProto === 'https' || !!req.socket.encrypted,
      });
      sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { code: e.code, message: e.message, ...(e.extra ?? {}) });
      } else {
        log(`[error] ${req.method} ${pathname}: ${e?.stack || e}`);
        sendJson(res, 500, { code: 'internal', message: 'Error interno del servidor. Podés reintentar: la operación no se duplicará.' });
      }
    }
  });

  server.on('close', () => db.close());
  return { server, db, ctx };
}
