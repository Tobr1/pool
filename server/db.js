import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, now, sha256 } from './util.js';

const MIGRATIONS = [
  // v1: esquema inicial
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin','employee')),
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE products (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL,
    category         TEXT NOT NULL CHECK (category IN ('ficha','bebida','otro')),
    price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
    active           INTEGER NOT NULL DEFAULT 1,
    favorite         INTEGER NOT NULL DEFAULT 0,
    is_default_ficha INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE shifts (
    id                 INTEGER PRIMARY KEY,
    opened_at          INTEGER NOT NULL,
    opened_by          INTEGER NOT NULL REFERENCES users(id),
    opening_cash_cents INTEGER NOT NULL DEFAULT 0,
    auto_opened        INTEGER NOT NULL DEFAULT 0,
    closed_at          INTEGER,
    closed_by          INTEGER REFERENCES users(id),
    close_snapshot     TEXT
  );
  -- Solo puede haber un turno abierto a la vez.
  CREATE UNIQUE INDEX shifts_one_open ON shifts ((closed_at IS NULL)) WHERE closed_at IS NULL;

  CREATE TABLE accounts (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    name_search     TEXT NOT NULL,
    table_label     TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    opened_at       INTEGER NOT NULL,
    opened_by       INTEGER NOT NULL REFERENCES users(id),
    opened_shift_id INTEGER REFERENCES shifts(id),
    closed_at       INTEGER,
    closed_by       INTEGER REFERENCES users(id),
    closed_shift_id INTEGER REFERENCES shifts(id),
    version         INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX accounts_status ON accounts (status, opened_at);
  CREATE INDEX accounts_closed ON accounts (closed_at);

  -- Consumos: conservan nombre y precio del momento. Nunca se borran; se anulan.
  CREATE TABLE items (
    id               INTEGER PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(id),
    product_id       INTEGER REFERENCES products(id),
    product_name     TEXT NOT NULL,
    category         TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    created_at       INTEGER NOT NULL,
    created_by       INTEGER NOT NULL REFERENCES users(id),
    shift_id         INTEGER REFERENCES shifts(id),
    request_id       TEXT,
    voided_at        INTEGER,
    voided_by        INTEGER REFERENCES users(id),
    void_reason      TEXT
  );
  CREATE INDEX items_account ON items (account_id);
  CREATE INDEX items_shift ON items (shift_id);

  -- Pagos: un cobro dividido genera dos filas con el mismo group_key.
  CREATE TABLE payments (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id),
    amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
    method          TEXT NOT NULL CHECK (method IN ('efectivo','transferencia')),
    created_at      INTEGER NOT NULL,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    shift_id        INTEGER REFERENCES shifts(id),
    group_key       TEXT,
    voided_at       INTEGER,
    voided_by       INTEGER REFERENCES users(id),
    void_reason     TEXT,
    voided_shift_id INTEGER REFERENCES shifts(id)
  );
  CREATE INDEX payments_account ON payments (account_id);
  CREATE INDEX payments_shift ON payments (shift_id);

  -- Operaciones ya procesadas, para que un reintento no duplique nada.
  CREATE TABLE idempotency (
    key          TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    scope        TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response     TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY,
    at        INTEGER NOT NULL,
    user_id   INTEGER REFERENCES users(id),
    action    TEXT NOT NULL,
    entity    TEXT,
    entity_id INTEGER,
    summary   TEXT NOT NULL DEFAULT '',
    details   TEXT
  );
  CREATE INDEX audit_at ON audit_log (at);
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  const cache = new Map();
  /** Sentencia preparada (cacheada). */
  db.q = (sql) => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql); cache.set(sql, st); }
    return st;
  };
  // Limpieza de datos efímeros
  db.q('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.q('DELETE FROM idempotency WHERE created_at < ?').run(now() - 30 * 86400_000);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

let depth = 0;
/** Ejecuta fn dentro de una transacción (BEGIN IMMEDIATE). Anidable. */
export function tx(db, fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
    throw e;
  } finally {
    depth--;
  }
}

/**
 * Ejecuta una operación de escritura una sola vez por requestId.
 * Si el cliente reintenta (p. ej. tras un corte de conexión), devuelve el
 * resultado ya guardado en lugar de repetir la operación.
 */
export function idempotent(db, user, key, scope, body, fn) {
  const hash = sha256(JSON.stringify(body ?? {}));
  return tx(db, () => {
    const row = db.q('SELECT user_id, scope, request_hash, response FROM idempotency WHERE key = ?').get(key);
    if (row) {
      if (row.user_id !== user.id || row.scope !== scope || row.request_hash !== hash) {
        throw new HttpError(409, 'Esta operación ya se usó con otros datos. Volvé a intentarlo.', 'idempotency_mismatch');
      }
      return { ...JSON.parse(row.response), replayed: true };
    }
    const result = fn() ?? {};
    db.q('INSERT INTO idempotency (key, user_id, scope, request_hash, response, created_at) VALUES (?,?,?,?,?,?)')
      .run(key, user.id, scope, hash, JSON.stringify(result), now());
    return result;
  });
}

export function audit(db, user, action, entity, entityId, summary, details) {
  db.q('INSERT INTO audit_log (at, user_id, action, entity, entity_id, summary, details) VALUES (?,?,?,?,?,?,?)')
    .run(now(), user?.id ?? null, action, entity ?? null, entityId ?? null, summary ?? '', details ? JSON.stringify(details) : null);
}

export function getMeta(db, key, fallback = null) {
  const row = db.q('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
