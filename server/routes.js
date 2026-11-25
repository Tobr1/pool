import { audit, getMeta, idempotent, setMeta, tx } from './db.js';
import {
  checkLoginRate, clearCookie, clearLoginFailures, createSession, destroySession, hashPassword,
  registerLoginFailure, sessionCookie, validatePassword, validateUsername, verifyPassword,
} from './auth.js';
import {
  accountDetail, bumpVersion, currentShift, defaultFicha, ensureShift, getAccount, listOpenAccounts,
  openAccountsPending, productDto, requireOpen, searchClosedAccounts, shiftDto, shiftReport, totalsFor,
} from './domain.js';
import { HttpError, cents, cleanText, fmtMoney, intParam, normText, now, requestId, zonedDayRange } from './util.js';

const CATEGORIES = ['ficha', 'bebida', 'otro'];
const METHODS = ['efectivo', 'transferencia'];

function bool(v, field) {
  if (typeof v !== 'boolean') throw new HttpError(400, `${field}: valor inválido`, 'validation');
  return v;
}

function reasonText(v) {
  const r = cleanText(v, { field: 'Motivo', max: 200, required: true });
  if (r.length < 3) throw new HttpError(400, 'Escribí un motivo (mínimo 3 caracteres)', 'validation');
  return r;
}

export function registerRoutes(r, ctx) {
  const { db } = ctx;

  // ---------- Acceso ----------

  r.get('/api/bootstrap', { auth: 'none' }, ({ user }) => {
    const ficha = defaultFicha(db);
    return {
      needsSetup: db.q('SELECT COUNT(*) AS n FROM users').get().n === 0,
      demo: ctx.demo,
      user,
      settings: { businessName: getMeta(db, 'business_name', 'Pool') },
      ficha: ficha ? productDto(ficha) : null,
      shift: shiftDto(db, currentShift(db)),
      serverTime: now(),
    };
  });

  r.post('/api/setup', { auth: 'none' }, ({ body, res, secure }) => {
    if (db.q('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new HttpError(409, 'La configuración inicial ya se realizó', 'already_setup');
    if (!ctx.setupCode || body.setupCode?.trim() !== ctx.setupCode) {
      throw new HttpError(403, 'Código de configuración incorrecto. Está en la consola del servidor.', 'bad_setup_code');
    }
    const displayName = cleanText(body.displayName, { field: 'Nombre', max: 40, required: true });
    const username = validateUsername(body.username);
    const password = validatePassword(body.password);
    const businessName = cleanText(body.businessName ?? '', { field: 'Nombre del local', max: 40 });
    const user = tx(db, () => {
      const t = now();
      const id = db.q('INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?)')
        .run(username, displayName, 'admin', hashPassword(password), t).lastInsertRowid;
      if (businessName) setMeta(db, 'business_name', businessName);
      if (db.q('SELECT COUNT(*) AS n FROM products').get().n === 0) {
        db.q(`INSERT INTO products (name, category, price_cents, active, favorite, is_default_ficha, created_at, updated_at)
              VALUES ('Ficha de pool', 'ficha', 0, 1, 1, 1, ?, ?)`).run(t, t);
      }
      const u = { id, username, displayName, role: 'admin' };
      audit(db, u, 'setup', 'user', id, `Configuración inicial: administradora ${displayName}`);
      return u;
    });
    ctx.setupCode = null;
    res.setHeader('Set-Cookie', sessionCookie(createSession(db, user.id), { secure }));
    return { user };
  });

  r.post('/api/login', { auth: 'none' }, ({ body, res, ip, secure }) => {
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${ip}|${username}`;
    checkLoginRate(key);
    const row = db.q('SELECT * FROM users WHERE username = ?').get(username);
    if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
      registerLoginFailure(key);
      throw new HttpError(401, 'Usuario o contraseña incorrectos', 'bad_credentials');
    }
    clearLoginFailures(key);
    const user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
    audit(db, user, 'login', 'user', user.id, 'Inicio de sesión');
    res.setHeader('Set-Cookie', sessionCookie(createSession(db, user.id), { secure }));
    return { user };
  });

  r.post('/api/logout', { auth: 'none' }, ({ token, res }) => {
    destroySession(db, token);
    res.setHeader('Set-Cookie', clearCookie());
    return { ok: true };
  });

  r.post('/api/me/password', { auth: 'user' }, ({ user, body }) => {
    const row = db.q('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(body.current ?? ''), row.password_hash)) throw new HttpError(400, 'La contraseña actual no es correcta', 'validation');
    const pw = validatePassword(body.password);
    tx(db, () => {
      db.q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), user.id);
      audit(db, user, 'user.password', 'user', user.id, 'Cambió su contraseña');
    });
    return { ok: true };
  });

  // ---------- Cuentas ----------

  r.get('/api/accounts', { auth: 'user' }, () => {
    const ficha = defaultFicha(db);
    return {
      accounts: listOpenAccounts(db),
      shift: shiftDto(db, currentShift(db)),
      ficha: ficha ? productDto(ficha) : null,
    };
  });

  r.post('/api/accounts', { auth: 'user' }, ({ user, body }) => {
    const key = requestId(body.requestId);
    const name = cleanText(body.name, { field: 'Nombre o referencia', max: 40, required: true });
    const table = cleanText(body.table ?? '', { field: 'Mesa', max: 20 });
    const withFicha = body.withFicha === true;
    const result = idempotent(db, user, key, 'account.create', { name, table, withFicha }, () => {
      const shift = ensureShift(db, user);
      const t = now();
      const id = db.q(`INSERT INTO accounts (name, name_search, table_label, opened_at, opened_by, opened_shift_id)
                       VALUES (?,?,?,?,?,?)`).run(name, normText(name), table, t, user.id, shift.id).lastInsertRowid;
      audit(db, user, 'account.open', 'account', id, `Abrió la cuenta "${name}"${table ? ` (mesa ${table})` : ''}`);
      let itemIds = [];
      if (withFicha) {
        const f = defaultFicha(db);
        if (!f) throw new HttpError(400, 'No hay una ficha activa en el catálogo', 'no_ficha');
        const itemId = db.q(`INSERT INTO items (account_id, product_id, product_name, category, unit_price_cents, quantity, created_at, created_by, shift_id, request_id)
                             VALUES (?,?,?,?,?,1,?,?,?,?)`).run(id, f.id, f.name, f.category, f.price_cents, t, user.id, shift.id, key).lastInsertRowid;
        itemIds = [itemId];
        audit(db, user, 'item.add', 'account', id, `+1 ${f.name} (${fmtMoney(f.price_cents)})`);
      }
      return { accountId: id, itemIds };
    });
    return { ...result, detail: accountDetail(db, result.accountId) };
  });

  r.get('/api/accounts/:id', { auth: 'user' }, ({ params }) => accountDetail(db, intParam(params.id, { field: 'Cuenta' })));

  r.patch('/api/accounts/:id', { auth: 'user' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Cuenta' });
    const version = intParam(body.version, { field: 'Versión' });
    tx(db, () => {
      const a = getAccount(db, id);
      requireOpen(a);
      if (a.version !== version) {
        throw new HttpError(409, 'Otra persona modificó esta cuenta. Revisá los datos actualizados.', 'version_conflict', { detail: accountDetail(db, id) });
      }
      const name = body.name !== undefined ? cleanText(body.name, { field: 'Nombre o referencia', max: 40, required: true }) : a.name;
      const table = body.table !== undefined ? cleanText(body.table, { field: 'Mesa', max: 20 }) : a.table_label;
      if (name === a.name && table === a.table_label) return;
      db.q('UPDATE accounts SET name = ?, name_search = ?, table_label = ?, version = version + 1 WHERE id = ?').run(name, normText(name), table, id);
      const changes = [];
      if (name !== a.name) changes.push(`nombre "${a.name}" → "${name}"`);
      if (table !== a.table_label) changes.push(`mesa "${a.table_label || '—'}" → "${table || '—'}"`);
      audit(db, user, 'account.edit', 'account', id, `Editó la cuenta: ${changes.join(', ')}`);
    });
    return { detail: accountDetail(db, id) };
  });

  function insertItems(user, accountId, lines, key) {
    const a = getAccount(db, accountId);
    requireOpen(a);
    const shift = ensureShift(db, user);
    const t = now();
    const ids = [];
    for (const l of lines) {
      const p = db.q('SELECT * FROM products WHERE id = ?').get(l.productId);
      if (!p) throw new HttpError(400, 'Producto inexistente', 'validation');
      if (!p.active) throw new HttpError(409, `"${p.name}" ya no está disponible. Actualizá el catálogo.`, 'product_inactive');
      ids.push(db.q(`INSERT INTO items (account_id, product_id, product_name, category, unit_price_cents, quantity, created_at, created_by, shift_id, request_id)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`).run(accountId, p.id, p.name, p.category, p.price_cents, l.quantity, t, user.id, shift.id, key).lastInsertRowid);
      audit(db, user, 'item.add', 'account', accountId, `+${l.quantity} ${p.name} (${fmtMoney(p.price_cents)} c/u)`);
    }
    bumpVersion(db, accountId);
    return ids;
  }

  r.post('/api/accounts/:id/ficha', { auth: 'user' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Cuenta' });
    const key = requestId(body.requestId);
    const result = idempotent(db, user, key, `ficha:${id}`, {}, () => {
      const f = defaultFicha(db);
      if (!f) throw new HttpError(400, 'No hay una ficha activa en el catálogo', 'no_ficha');
      return { itemIds: insertItems(user, id, [{ productId: f.id, quantity: 1 }], key) };
    });
    return { ...result, detail: accountDetail(db, id) };
  });

  r.post('/api/accounts/:id/items', { auth: 'user' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Cuenta' });
    const key = requestId(body.requestId);
    if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 30) {
      throw new HttpError(400, 'Elegí al menos un producto', 'validation');
    }
    const lines = body.lines.map((l) => ({
      productId: intParam(l?.productId, { field: 'Producto' }),
      quantity: intParam(l?.quantity, { field: 'Cantidad', min: 1, max: 99 }),
    }));
    const result = idempotent(db, user, key, `items:${id}`, lines, () => ({ itemIds: insertItems(user, id, lines, key) }));
    return { ...result, detail: accountDetail(db, id) };
  });

  r.post('/api/items/:id/void', { auth: 'user' }, ({ user, params, body }) => {
    const itemId = intParam(params.id, { field: 'Consumo' });
    const key = requestId(body.requestId);
    const reason = reasonText(body.reason);
    let accountId;
    const result = idempotent(db, user, key, `item.void:${itemId}`, { reason }, () => {
      const it = db.q('SELECT * FROM items WHERE id = ?').get(itemId);
      if (!it) throw new HttpError(404, 'El consumo no existe', 'not_found');
      requireOpen(getAccount(db, it.account_id));
      if (it.voided_at) throw new HttpError(409, 'Ese consumo ya estaba anulado', 'already_voided');
      db.q('UPDATE items SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?').run(now(), user.id, reason, itemId);
      bumpVersion(db, it.account_id);
      audit(db, user, 'item.void', 'account', it.account_id, `Anuló ${it.quantity} ${it.product_name} (${fmtMoney(it.unit_price_cents)} c/u). Motivo: ${reason}`, { itemId });
      return { accountId: it.account_id };
    });
    accountId = result.accountId;
    return { ...result, detail: accountDetail(db, accountId) };
  });

  r.post('/api/accounts/:id/payments', { auth: 'user' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Cuenta' });
    const key = requestId(body.requestId);
    if (!Array.isArray(body.parts) || body.parts.length < 1 || body.parts.length > 2) {
      throw new HttpError(400, 'Indicá el importe a cobrar', 'validation');
    }
    const parts = body.parts.map((p) => {
      if (!METHODS.includes(p?.method)) throw new HttpError(400, 'Medio de pago inválido', 'validation');
      return { method: p.method, amountCents: cents(p.amountCents, { field: 'Importe', min: 1 }) };
    });
    if (new Set(parts.map((p) => p.method)).size !== parts.length) throw new HttpError(400, 'Medio de pago repetido', 'validation');
    const expected = cents(body.expectedBalanceCents, { field: 'Saldo esperado', min: -Infinity });
    const total = parts.reduce((s, p) => s + p.amountCents, 0);

    const result = idempotent(db, user, key, `payment:${id}`, { parts, expected }, () => {
      const a = getAccount(db, id);
      requireOpen(a);
      const { balanceCents } = totalsFor(db, id);
      if (balanceCents !== expected) {
        throw new HttpError(409, `El saldo cambió mientras cobrabas: ahora es ${fmtMoney(balanceCents)}. Revisá antes de confirmar.`, 'balance_changed', { detail: accountDetail(db, id) });
      }
      if (balanceCents <= 0) throw new HttpError(409, 'Esta cuenta no tiene saldo pendiente', 'no_balance');
      if (total > balanceCents) {
        throw new HttpError(400, `El importe (${fmtMoney(total)}) supera el saldo pendiente (${fmtMoney(balanceCents)})`, 'over_balance');
      }
      const shift = ensureShift(db, user);
      const t = now();
      const ids = parts.map((p) => db.q(`INSERT INTO payments (account_id, amount_cents, method, created_at, created_by, shift_id, group_key)
                                         VALUES (?,?,?,?,?,?,?)`).run(id, p.amountCents, p.method, t, user.id, shift.id, key).lastInsertRowid);
      bumpVersion(db, id);
      audit(db, user, 'payment.add', 'account', id,
        `Cobró ${parts.map((p) => `${fmtMoney(p.amountCents)} en ${p.method}`).join(' + ')}`, { paymentIds: ids });
      return { paymentIds: ids };
    });
    return { ...result, detail: accountDetail(db, id) };
  });

  r.post('/api/payments/:id/void', { auth: 'admin' }, ({ user, params, body }) => {
    const paymentId = intParam(params.id, { field: 'Pago' });
    const key = requestId(body.requestId);
    const reason = reasonText(body.reason);
    const result = idempotent(db, user, key, `payment.void:${paymentId}`, { reason }, () => {
      const p = db.q('SELECT * FROM payments WHERE id = ?').get(paymentId);
      if (!p) throw new HttpError(404, 'El pago no existe', 'not_found');
      const a = getAccount(db, p.account_id);
      if (a.status !== 'open') throw new HttpError(409, 'Reabrí la cuenta antes de corregir un pago', 'account_closed');
      if (p.voided_at) throw new HttpError(409, 'Ese pago ya estaba anulado', 'already_voided');
      const shift = currentShift(db);
      db.q('UPDATE payments SET voided_at = ?, voided_by = ?, void_reason = ?, voided_shift_id = ? WHERE id = ?')
        .run(now(), user.id, reason, shift?.id ?? null, paymentId);
      bumpVersion(db, p.account_id);
      audit(db, user, 'payment.void', 'account', p.account_id, `Anuló el pago de ${fmtMoney(p.amount_cents)} en ${p.method}. Motivo: ${reason}`, { paymentId });
      return { accountId: p.account_id };
    });
    return { ...result, detail: accountDetail(db, result.accountId) };
  });

  r.post('/api/accounts/:id/close', { auth: 'user' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Cuenta' });
    const key = requestId(body.requestId);
    const version = intParam(body.version, { field: 'Versión' });
    const result = idempotent(db, user, key, `account.close:${id}`, { version }, () => {
      const a = getAccount(db, id);
      requireOpen(a);
      if (a.version !== version) {
        throw new HttpError(409, 'La cuenta cambió hace un momento. Revisá el resumen antes de cerrarla.', 'version_conflict', { detail: accountDetail(db, id) });
      }
      const { balanceCents } = totalsFor(db, id);
      if (balanceCents > 0) throw new HttpError(409, `No se puede cerrar: queda un saldo pendiente de ${fmtMoney(balanceCents)}`, 'pending_balance');
      if (balanceCents < 0) throw new HttpError(409, `No se puede cerrar: hay ${fmtMoney(-balanceCents)} cobrados de más. La administradora debe corregir el pago.`, 'credit_balance');
      const shift = currentShift(db);
      db.q(`UPDATE accounts SET status = 'closed', closed_at = ?, closed_by = ?, closed_shift_id = ?, version = version + 1 WHERE id = ?`)
        .run(now(), user.id, shift?.id ?? null, id);
      audit(db, user, 'account.close', 'account', id, `Cerró la cuenta "${a.name}"`);
      return { accountId: id };
    });
    return { ...result, detail: accountDetail(db, id) };
  });

  r.post('/api/accounts/:id/reopen', { auth: 'admin' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Cuenta' });
    const key = requestId(body.requestId);
    const reason = reasonText(body.reason);
    const result = idempotent(db, user, key, `account.reopen:${id}`, { reason }, () => {
      const a = getAccount(db, id);
      if (a.status !== 'closed') throw new HttpError(409, 'La cuenta ya está abierta', 'already_open');
      db.q(`UPDATE accounts SET status = 'open', closed_at = NULL, closed_by = NULL, closed_shift_id = NULL, version = version + 1 WHERE id = ?`).run(id);
      audit(db, user, 'account.reopen', 'account', id, `Reabrió la cuenta "${a.name}". Motivo: ${reason}`);
      return { accountId: id };
    });
    return { ...result, detail: accountDetail(db, id) };
  });

  // ---------- Historial ----------

  r.get('/api/history', { auth: 'user' }, ({ query }) => {
    const q = normText(query.get('q') ?? '').slice(0, 40);
    const date = query.get('date');
    const shiftId = query.get('shift') ? intParam(query.get('shift'), { field: 'Turno' }) : null;
    let from = null; let to = null;
    if (date) [from, to] = zonedDayRange(date);
    return { accounts: searchClosedAccounts(db, { q, from, to, shiftId }) };
  });

  // ---------- Turnos ----------

  r.get('/api/shifts/current', { auth: 'user' }, () => {
    const s = currentShift(db);
    return { shift: shiftDto(db, s), report: s ? shiftReport(db, s) : null, openAccounts: openAccountsPending(db) };
  });

  r.get('/api/shifts', { auth: 'user' }, () => {
    const rows = db.q('SELECT * FROM shifts ORDER BY opened_at DESC LIMIT 60').all();
    return {
      shifts: rows.map((s) => ({
        ...shiftDto(db, s),
        collectedCents: db.q('SELECT COALESCE(SUM(amount_cents),0) AS v FROM payments WHERE shift_id = ? AND voided_at IS NULL').get(s.id).v,
      })),
    };
  });

  r.get('/api/shifts/:id', { auth: 'user' }, ({ params }) => {
    const s = db.q('SELECT * FROM shifts WHERE id = ?').get(intParam(params.id, { field: 'Turno' }));
    if (!s) throw new HttpError(404, 'El turno no existe', 'not_found');
    return { shift: shiftDto(db, s), report: shiftReport(db, s) };
  });

  r.post('/api/shifts', { auth: 'user' }, ({ user, body }) => {
    const key = requestId(body.requestId);
    const opening = cents(body.openingCashCents ?? 0, { field: 'Efectivo inicial' });
    const result = idempotent(db, user, key, 'shift.open', { opening }, () => {
      if (currentShift(db)) throw new HttpError(409, 'Ya hay un turno abierto', 'shift_open');
      const id = db.q('INSERT INTO shifts (opened_at, opened_by, opening_cash_cents) VALUES (?,?,?)').run(now(), user.id, opening).lastInsertRowid;
      audit(db, user, 'shift.open', 'shift', id, `Abrió turno con ${fmtMoney(opening)} de efectivo inicial`);
      return { shiftId: id };
    });
    const s = db.q('SELECT * FROM shifts WHERE id = ?').get(result.shiftId);
    return { ...result, shift: shiftDto(db, s), report: shiftReport(db, s) };
  });

  r.post('/api/shifts/:id/close', { auth: 'user' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Turno' });
    const key = requestId(body.requestId);
    const ack = body.acknowledgeOpenAccounts === true;
    const result = idempotent(db, user, key, `shift.close:${id}`, { ack }, () => {
      const s = db.q('SELECT * FROM shifts WHERE id = ?').get(id);
      if (!s) throw new HttpError(404, 'El turno no existe', 'not_found');
      if (s.closed_at) throw new HttpError(409, 'El turno ya estaba cerrado', 'shift_closed');
      const open = openAccountsPending(db);
      if (open.count > 0 && !ack) {
        throw new HttpError(409, `Quedan ${open.count} cuentas abiertas`, 'open_accounts', { openAccounts: open });
      }
      const t = now();
      const snapshot = { ...shiftReport(db, s), openAccounts: open, closedAt: t };
      delete snapshot.atClose;
      db.q('UPDATE shifts SET closed_at = ?, closed_by = ?, close_snapshot = ? WHERE id = ?').run(t, user.id, JSON.stringify(snapshot), id);
      audit(db, user, 'shift.close', 'shift', id,
        `Cerró el turno. Cobrado ${fmtMoney(snapshot.collectedCents)}; ${open.count} cuentas siguen abiertas (${fmtMoney(open.pendingCents)} pendiente)`);
      return { shiftId: id };
    });
    const s = db.q('SELECT * FROM shifts WHERE id = ?').get(result.shiftId);
    return { ...result, shift: shiftDto(db, s), report: shiftReport(db, s) };
  });

  // ---------- Productos ----------

  r.get('/api/products', { auth: 'user' }, ({ user, query }) => {
    const all = query.get('all') === '1' && user.role === 'admin';
    const rows = db.q(`SELECT * FROM products ${all ? '' : 'WHERE active = 1'}
                       ORDER BY CASE category WHEN 'ficha' THEN 0 WHEN 'bebida' THEN 1 ELSE 2 END, name COLLATE NOCASE`).all();
    return { products: rows.map(productDto) };
  });

  function productInput(body, existing) {
    const out = {
      name: body.name !== undefined ? cleanText(body.name, { field: 'Nombre', max: 40, required: true }) : existing.name,
      category: body.category !== undefined ? body.category : existing.category,
      price: body.priceCents !== undefined ? cents(body.priceCents, { field: 'Precio' }) : existing.price_cents,
      active: body.active !== undefined ? bool(body.active, 'Activo') : !!existing.active,
      favorite: body.favorite !== undefined ? bool(body.favorite, 'Favorito') : !!existing.favorite,
      isDefaultFicha: body.isDefaultFicha !== undefined ? bool(body.isDefaultFicha, 'Ficha principal') : !!existing.is_default_ficha,
    };
    if (!CATEGORIES.includes(out.category)) throw new HttpError(400, 'Categoría inválida', 'validation');
    if (out.category !== 'ficha') out.isDefaultFicha = false;
    return out;
  }

  function applyDefaultFicha(id, isDefault) {
    if (isDefault) db.q('UPDATE products SET is_default_ficha = 0 WHERE id <> ?').run(id);
  }

  r.post('/api/products', { auth: 'admin' }, ({ user, body }) => {
    const p = productInput(body, { name: '', category: 'bebida', price_cents: 0, active: 1, favorite: 0, is_default_ficha: 0 });
    const id = tx(db, () => {
      const t = now();
      const newId = db.q(`INSERT INTO products (name, category, price_cents, active, favorite, is_default_ficha, created_at, updated_at)
                          VALUES (?,?,?,?,?,?,?,?)`).run(p.name, p.category, p.price, p.active ? 1 : 0, p.favorite ? 1 : 0, p.isDefaultFicha ? 1 : 0, t, t).lastInsertRowid;
      applyDefaultFicha(newId, p.isDefaultFicha);
      audit(db, user, 'product.create', 'product', newId, `Creó "${p.name}" a ${fmtMoney(p.price)}`);
      return newId;
    });
    return { product: productDto(db.q('SELECT * FROM products WHERE id = ?').get(id)) };
  });

  r.patch('/api/products/:id', { auth: 'admin' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Producto' });
    tx(db, () => {
      const old = db.q('SELECT * FROM products WHERE id = ?').get(id);
      if (!old) throw new HttpError(404, 'El producto no existe', 'not_found');
      const p = productInput(body, old);
      db.q(`UPDATE products SET name = ?, category = ?, price_cents = ?, active = ?, favorite = ?, is_default_ficha = ?, updated_at = ? WHERE id = ?`)
        .run(p.name, p.category, p.price, p.active ? 1 : 0, p.favorite ? 1 : 0, p.isDefaultFicha ? 1 : 0, now(), id);
      applyDefaultFicha(id, p.isDefaultFicha);
      const changes = [];
      if (p.name !== old.name) changes.push(`nombre "${old.name}" → "${p.name}"`);
      if (p.category !== old.category) changes.push(`categoría ${old.category} → ${p.category}`);
      if (p.price !== old.price_cents) changes.push(`precio ${fmtMoney(old.price_cents)} → ${fmtMoney(p.price)}`);
      if (p.active !== !!old.active) changes.push(p.active ? 'activado' : 'desactivado');
      if (p.favorite !== !!old.favorite) changes.push(p.favorite ? 'marcado favorito' : 'quitado de favoritos');
      if (p.isDefaultFicha !== !!old.is_default_ficha) changes.push(p.isDefaultFicha ? 'ficha principal' : 'ya no es ficha principal');
      if (changes.length) {
        audit(db, user, p.price !== old.price_cents ? 'product.price' : 'product.edit', 'product', id, `"${p.name}": ${changes.join(', ')}`);
      }
    });
    return { product: productDto(db.q('SELECT * FROM products WHERE id = ?').get(id)) };
  });

  // ---------- Usuarios y ajustes (solo administradora) ----------

  const userDto = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: !!u.active, createdAt: u.created_at });

  r.get('/api/users', { auth: 'admin' }, () => ({
    users: db.q('SELECT * FROM users ORDER BY active DESC, role, display_name COLLATE NOCASE').all().map(userDto),
  }));

  r.post('/api/users', { auth: 'admin' }, ({ user, body }) => {
    const displayName = cleanText(body.displayName, { field: 'Nombre', max: 40, required: true });
    const username = validateUsername(body.username);
    const password = validatePassword(body.password);
    const role = body.role === 'admin' ? 'admin' : 'employee';
    const id = tx(db, () => {
      if (db.q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Ese nombre de usuario ya existe', 'duplicate');
      const newId = db.q('INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?)')
        .run(username, displayName, role, hashPassword(password), now()).lastInsertRowid;
      audit(db, user, 'user.create', 'user', newId, `Creó el usuario ${username} (${role === 'admin' ? 'administradora' : 'empleado'})`);
      return newId;
    });
    return { user: userDto(db.q('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  r.patch('/api/users/:id', { auth: 'admin' }, ({ user, params, body }) => {
    const id = intParam(params.id, { field: 'Usuario' });
    tx(db, () => {
      const old = db.q('SELECT * FROM users WHERE id = ?').get(id);
      if (!old) throw new HttpError(404, 'El usuario no existe', 'not_found');
      const displayName = body.displayName !== undefined ? cleanText(body.displayName, { field: 'Nombre', max: 40, required: true }) : old.display_name;
      const role = body.role !== undefined ? (body.role === 'admin' ? 'admin' : 'employee') : old.role;
      const active = body.active !== undefined ? bool(body.active, 'Activo') : !!old.active;
      const losingAdmin = old.role === 'admin' && old.active && (role !== 'admin' || !active);
      if (losingAdmin) {
        const admins = db.q(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).get().n;
        if (admins <= 1) throw new HttpError(409, 'Debe quedar al menos una administradora activa', 'last_admin');
      }
      if (id === user.id && !active) throw new HttpError(409, 'No podés desactivar tu propio usuario', 'self');
      db.q('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?').run(displayName, role, active ? 1 : 0, id);
      const changes = [];
      if (displayName !== old.display_name) changes.push(`nombre → ${displayName}`);
      if (role !== old.role) changes.push(`rol → ${role === 'admin' ? 'administradora' : 'empleado'}`);
      if (active !== !!old.active) changes.push(active ? 'activado' : 'desactivado');
      if (body.password) {
        db.q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validatePassword(body.password)), id);
        db.q('DELETE FROM sessions WHERE user_id = ?').run(id);
        changes.push('contraseña restablecida');
      }
      if (!active) db.q('DELETE FROM sessions WHERE user_id = ?').run(id);
      if (changes.length) audit(db, user, 'user.edit', 'user', id, `Usuario ${old.username}: ${changes.join(', ')}`);
    });
    return { user: userDto(db.q('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  r.patch('/api/settings', { auth: 'admin' }, ({ user, body }) => {
    const businessName = cleanText(body.businessName, { field: 'Nombre del local', max: 40, required: true });
    tx(db, () => {
      setMeta(db, 'business_name', businessName);
      audit(db, user, 'settings.edit', 'settings', null, `Nombre del local → ${businessName}`);
    });
    return { settings: { businessName } };
  });

  r.get('/api/audit', { auth: 'admin' }, ({ query }) => {
    const before = query.get('before') ? intParam(query.get('before'), { field: 'Desde' }) : Number.MAX_SAFE_INTEGER;
    const rows = db.q(`SELECT l.*, u.display_name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
                       WHERE l.id < ? ORDER BY l.id DESC LIMIT 100`).all(before);
    return {
      entries: rows.map((l) => ({ id: l.id, at: l.at, userName: l.user_name ?? '', action: l.action, entity: l.entity, entityId: l.entity_id, summary: l.summary })),
    };
  });
}
