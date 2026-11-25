import { audit } from './db.js';
import { HttpError, now } from './util.js';

const CAT_ORDER = { ficha: 0, bebida: 1, otro: 2 };

// ---------- Turnos ----------

export function currentShift(db) {
  return db.q('SELECT * FROM shifts WHERE closed_at IS NULL').get() ?? null;
}

/** Devuelve el turno abierto; si no hay, abre uno automáticamente. */
export function ensureShift(db, user) {
  const s = currentShift(db);
  if (s) return s;
  const r = db.q('INSERT INTO shifts (opened_at, opened_by, opening_cash_cents, auto_opened) VALUES (?,?,0,1)').run(now(), user.id);
  audit(db, user, 'shift.auto_open', 'shift', r.lastInsertRowid, 'Turno abierto automáticamente al registrar una operación');
  return db.q('SELECT * FROM shifts WHERE id = ?').get(r.lastInsertRowid);
}

export function shiftDto(db, s) {
  if (!s) return null;
  const by = (id) => (id ? db.q('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name ?? '' : '');
  return {
    id: s.id,
    openedAt: s.opened_at,
    openedByName: by(s.opened_by),
    openingCashCents: s.opening_cash_cents,
    autoOpened: !!s.auto_opened,
    closedAt: s.closed_at,
    closedByName: by(s.closed_by),
    isOpen: s.closed_at == null,
  };
}

export function openAccountsPending(db) {
  const rows = listOpenAccounts(db);
  return {
    count: rows.length,
    pendingCents: rows.reduce((acc, a) => acc + Math.max(0, a.balanceCents), 0),
  };
}

export function shiftReport(db, s) {
  const pay = db.q(`SELECT method, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total
                    FROM payments WHERE shift_id = ? AND voided_at IS NULL GROUP BY method`).all(s.id);
  const items = db.q(`SELECT category, COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(quantity * unit_price_cents),0) AS amount
                      FROM items WHERE shift_id = ? AND voided_at IS NULL GROUP BY category`).all(s.id);
  const m = (k) => pay.find((p) => p.method === k)?.total ?? 0;
  const c = (k) => items.find((i) => i.category === k) ?? { qty: 0, amount: 0 };
  const cash = m('efectivo');
  const transfer = m('transferencia');
  const report = {
    collectedCents: cash + transfer,
    cashCents: cash,
    transferCents: transfer,
    paymentsCount: pay.reduce((a, p) => a + p.n, 0),
    expectedCashCents: s.opening_cash_cents + cash,
    fichas: c('ficha').qty,
    bebidas: c('bebida').qty,
    otros: c('otro').qty,
    consumedCents: items.reduce((a, i) => a + i.amount, 0),
    accountsOpened: db.q('SELECT COUNT(*) AS n FROM accounts WHERE opened_shift_id = ?').get(s.id).n,
    accountsClosed: db.q('SELECT COUNT(*) AS n FROM accounts WHERE closed_shift_id = ?').get(s.id).n,
    voidedPayments: db.q('SELECT COUNT(*) AS n FROM payments WHERE shift_id = ? AND voided_at IS NOT NULL').get(s.id).n,
    voidedItems: db.q('SELECT COUNT(*) AS n FROM items WHERE shift_id = ? AND voided_at IS NOT NULL').get(s.id).n,
  };
  if (s.closed_at == null) {
    report.openAccounts = openAccountsPending(db);
    report.atClose = null;
  } else {
    const snap = s.close_snapshot ? JSON.parse(s.close_snapshot) : null;
    report.openAccounts = snap?.openAccounts ?? { count: 0, pendingCents: 0 };
    report.atClose = snap;
  }
  return report;
}

// ---------- Productos ----------

export function productDto(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    priceCents: p.price_cents,
    active: !!p.active,
    favorite: !!p.favorite,
    isDefaultFicha: !!p.is_default_ficha,
  };
}

export function defaultFicha(db) {
  return db.q(`SELECT * FROM products WHERE category = 'ficha' AND active = 1
               ORDER BY is_default_ficha DESC, id LIMIT 1`).get() ?? null;
}

// ---------- Cuentas ----------

export function getAccount(db, id) {
  const a = db.q('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!a) throw new HttpError(404, 'La cuenta no existe', 'not_found');
  return a;
}

export function requireOpen(a) {
  if (a.status !== 'open') {
    throw new HttpError(409, 'La cuenta está cerrada. Solo la administradora puede reabrirla.', 'account_closed');
  }
}

export function bumpVersion(db, accountId) {
  db.q('UPDATE accounts SET version = version + 1 WHERE id = ?').run(accountId);
}

export function totalsFor(db, accountId) {
  const consumed = db.q('SELECT COALESCE(SUM(quantity * unit_price_cents),0) AS v FROM items WHERE account_id = ? AND voided_at IS NULL').get(accountId).v;
  const paid = db.q('SELECT COALESCE(SUM(amount_cents),0) AS v FROM payments WHERE account_id = ? AND voided_at IS NULL').get(accountId).v;
  return { consumedCents: consumed, paidCents: paid, balanceCents: consumed - paid };
}

const LIST_SQL = `
  SELECT a.*,
    COALESCE((SELECT SUM(quantity * unit_price_cents) FROM items i WHERE i.account_id = a.id AND i.voided_at IS NULL), 0) AS consumed,
    COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.account_id = a.id AND p.voided_at IS NULL), 0) AS paid,
    COALESCE((SELECT SUM(quantity) FROM items i WHERE i.account_id = a.id AND i.voided_at IS NULL AND i.category = 'ficha'), 0) AS fichas,
    COALESCE((SELECT SUM(quantity) FROM items i WHERE i.account_id = a.id AND i.voided_at IS NULL AND i.category = 'bebida'), 0) AS bebidas,
    COALESCE((SELECT SUM(quantity) FROM items i WHERE i.account_id = a.id AND i.voided_at IS NULL AND i.category = 'otro'), 0) AS otros,
    MAX(a.opened_at,
        COALESCE((SELECT MAX(created_at) FROM items i WHERE i.account_id = a.id), 0),
        COALESCE((SELECT MAX(created_at) FROM payments p WHERE p.account_id = a.id), 0)) AS last_activity
  FROM accounts a`;

function listDto(a) {
  return {
    id: a.id,
    name: a.name,
    table: a.table_label,
    status: a.status,
    openedAt: a.opened_at,
    closedAt: a.closed_at,
    version: a.version,
    fichas: a.fichas,
    bebidas: a.bebidas,
    otros: a.otros,
    consumedCents: a.consumed,
    paidCents: a.paid,
    balanceCents: a.consumed - a.paid,
    lastActivity: a.last_activity,
  };
}

export function listOpenAccounts(db) {
  return db.q(`${LIST_SQL} WHERE a.status = 'open' ORDER BY a.opened_at DESC, a.id DESC`).all().map(listDto);
}

export function searchClosedAccounts(db, { q, from, to, shiftId, limit = 60 }) {
  const where = [`a.status = 'closed'`];
  const params = [];
  if (q) { where.push('(a.name_search LIKE ? OR a.table_label LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (from != null) { where.push('a.opened_at < ? AND a.closed_at >= ?'); params.push(to, from); }
  if (shiftId) {
    where.push(`(a.closed_shift_id = ? OR a.opened_shift_id = ?
      OR EXISTS (SELECT 1 FROM payments p WHERE p.account_id = a.id AND p.shift_id = ?)
      OR EXISTS (SELECT 1 FROM items i WHERE i.account_id = a.id AND i.shift_id = ?))`);
    params.push(shiftId, shiftId, shiftId, shiftId);
  }
  params.push(limit);
  return db.q(`${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY a.closed_at DESC, a.id DESC LIMIT ?`).all(...params).map(listDto);
}

export function accountDetail(db, id) {
  const a = db.q(`SELECT a.*, uo.display_name AS opened_by_name, uc.display_name AS closed_by_name
                  FROM accounts a JOIN users uo ON uo.id = a.opened_by LEFT JOIN users uc ON uc.id = a.closed_by
                  WHERE a.id = ?`).get(id);
  if (!a) throw new HttpError(404, 'La cuenta no existe', 'not_found');

  const items = db.q(`SELECT i.*, u.display_name AS by_name, v.display_name AS voided_by_name
                      FROM items i JOIN users u ON u.id = i.created_by LEFT JOIN users v ON v.id = i.voided_by
                      WHERE i.account_id = ? ORDER BY i.created_at, i.id`).all(id).map((i) => ({
    id: i.id,
    productId: i.product_id,
    productName: i.product_name,
    category: i.category,
    unitPriceCents: i.unit_price_cents,
    quantity: i.quantity,
    subtotalCents: i.unit_price_cents * i.quantity,
    createdAt: i.created_at,
    createdByName: i.by_name,
    voided: i.voided_at != null,
    voidedAt: i.voided_at,
    voidedByName: i.voided_by_name ?? '',
    voidReason: i.void_reason ?? '',
  }));

  const payments = db.q(`SELECT p.*, u.display_name AS by_name, v.display_name AS voided_by_name
                         FROM payments p JOIN users u ON u.id = p.created_by LEFT JOIN users v ON v.id = p.voided_by
                         WHERE p.account_id = ? ORDER BY p.created_at, p.id`).all(id).map((p) => ({
    id: p.id,
    amountCents: p.amount_cents,
    method: p.method,
    createdAt: p.created_at,
    createdByName: p.by_name,
    groupKey: p.group_key,
    shiftId: p.shift_id,
    voided: p.voided_at != null,
    voidedAt: p.voided_at,
    voidedByName: p.voided_by_name ?? '',
    voidReason: p.void_reason ?? '',
  }));

  // Resumen agrupado por producto y precio aplicado.
  const groups = new Map();
  for (const it of items) {
    if (it.voided) continue;
    const key = `${it.productId ?? it.productName}|${it.unitPriceCents}`;
    const g = groups.get(key) ?? { productName: it.productName, category: it.category, unitPriceCents: it.unitPriceCents, quantity: 0, subtotalCents: 0 };
    g.quantity += it.quantity;
    g.subtotalCents += it.subtotalCents;
    groups.set(key, g);
  }
  const summary = [...groups.values()].sort((x, y) =>
    (CAT_ORDER[x.category] - CAT_ORDER[y.category]) || x.productName.localeCompare(y.productName, 'es') || x.unitPriceCents - y.unitPriceCents);

  const consumed = items.filter((i) => !i.voided).reduce((s, i) => s + i.subtotalCents, 0);
  const paid = payments.filter((p) => !p.voided).reduce((s, p) => s + p.amountCents, 0);

  return {
    account: {
      id: a.id,
      name: a.name,
      table: a.table_label,
      status: a.status,
      openedAt: a.opened_at,
      openedByName: a.opened_by_name,
      closedAt: a.closed_at,
      closedByName: a.closed_by_name ?? '',
      version: a.version,
    },
    totals: {
      consumedCents: consumed,
      paidCents: paid,
      balanceCents: consumed - paid,
      fichas: items.filter((i) => !i.voided && i.category === 'ficha').reduce((s, i) => s + i.quantity, 0),
    },
    summary,
    items,
    payments,
  };
}
