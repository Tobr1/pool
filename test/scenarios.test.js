// Escenarios de validación de punta a punta contra la API real (servidor + SQLite).
// Ejecutar: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { zonedDayRange } from '../server/util.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
const dbFile = path.join(dir, 'test.sqlite');
let app; let base;

function startServer() {
  app = createApp({ dbFile, log: () => {} });
  return new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${app.server.address().port}`;
    resolve();
  }));
}
const stopServer = () => new Promise((resolve) => app.server.close(resolve));

let rid = 0;
const newId = () => `test-${Date.now()}-${++rid}`;

function client() {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pool-app', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json();
    return { status: res.status, data };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
  };
}

const owner = client();
const employee = client();

/** Edita un producto como administradora, enviando su versión actual. */
async function patchProduct(id, changes, who = owner) {
  const p = (await owner.get('/products?all=1')).data.products.find((x) => x.id === id);
  return who.patch(`/products/${id}`, { ...changes, version: p.version });
}
let fichaId; let cervezaId; let gaseosaId;

before(async () => {
  await startServer();
  const setupCode = app.ctx.setupCode;
  const r = await owner.post('/setup', { setupCode, displayName: 'Rocío', username: 'rocio', password: 'secreto1', businessName: 'Pool Test' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Precio de ficha y bebidas
  const prods = (await owner.get('/products?all=1')).data.products;
  fichaId = prods.find((p) => p.category === 'ficha').id;
  assert.equal((await patchProduct(fichaId, { priceCents: 150000 })).status, 200);
  cervezaId = (await owner.post('/products', { requestId: newId(), name: 'Cerveza', category: 'bebida', priceCents: 450000, favorite: true })).data.product.id;
  gaseosaId = (await owner.post('/products', { requestId: newId(), name: 'Gaseosa', category: 'bebida', priceCents: 220050 })).data.product.id;
  assert.equal((await owner.post('/users', { requestId: newId(), displayName: 'Martín', username: 'martin', password: 'clave12', role: 'employee' })).status, 200);
  assert.equal((await employee.post('/login', { username: 'martin', password: 'clave12' })).status, 200);
});

after(async () => {
  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

let accId;

test('1. Crear una cuenta con nombre y mesa', async () => {
  const r = await employee.post('/accounts', { requestId: newId(), name: 'Agustín', table: '3' });
  assert.equal(r.status, 200);
  accId = r.data.accountId;
  assert.equal(r.data.detail.account.name, 'Agustín');
  assert.equal(r.data.detail.account.table, '3');
  assert.equal(r.data.detail.totals.consumedCents, 0);
  const list = (await employee.get('/accounts')).data.accounts;
  assert.ok(list.some((a) => a.id === accId));
  // Se abrió un turno automáticamente
  assert.ok((await employee.get('/shifts/current')).data.shift);
});

test('1b. Crear cuenta y agregar la primera ficha en la misma operación', async () => {
  const r = await employee.post('/accounts', { requestId: newId(), name: 'Lucía', withFicha: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.detail.totals.fichas, 1);
  assert.equal(r.data.detail.totals.consumedCents, 150000);
});

test('1c. Validaciones: nombre obligatorio', async () => {
  const r = await employee.post('/accounts', { requestId: newId(), name: '   ' });
  assert.equal(r.status, 400);
});

test('2. Agregar tres fichas en momentos diferentes', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await employee.post(`/accounts/${accId}/ficha`, { requestId: newId() });
    assert.equal(r.status, 200);
  }
  const d = (await employee.get(`/accounts/${accId}`)).data;
  assert.equal(d.totals.fichas, 3);
  assert.equal(d.items.length, 3);
  assert.equal(d.totals.consumedCents, 450000);
  assert.equal(d.items[0].createdByName, 'Martín');
});

test('3. Sumar varias bebidas y cantidades', async () => {
  const r = await employee.post(`/accounts/${accId}/items`, {
    requestId: newId(), lines: [{ productId: cervezaId, quantity: 2 }, { productId: gaseosaId, quantity: 3 }],
  });
  assert.equal(r.status, 200);
  // 3 fichas 4500 + 2×4500 + 3×2200,50 = 4500 + 9000 + 6601,50 = 20101,50
  assert.equal(r.data.detail.totals.consumedCents, 450000 + 900000 + 660150);
  const g = r.data.detail.summary.find((x) => x.productName === 'Gaseosa');
  assert.equal(g.quantity, 3);
  assert.equal(g.subtotalCents, 660150);
});

test('4. Anular un consumo con motivo, conservando el movimiento', async () => {
  let d = (await employee.get(`/accounts/${accId}`)).data;
  const gas = d.items.find((i) => i.productName === 'Gaseosa');
  const noReason = await employee.post(`/items/${gas.id}/void`, { requestId: newId(), reason: '' });
  assert.equal(noReason.status, 400);
  const r = await employee.post(`/items/${gas.id}/void`, { requestId: newId(), reason: 'Cargado por error' });
  assert.equal(r.status, 200);
  d = r.data.detail;
  const v = d.items.find((i) => i.id === gas.id);
  assert.equal(v.voided, true);
  assert.equal(v.voidReason, 'Cargado por error');
  assert.equal(v.voidedByName, 'Martín');
  assert.equal(d.totals.consumedCents, 450000 + 900000);
  assert.ok(!d.summary.some((x) => x.productName === 'Gaseosa'));
  // Segunda anulación del mismo consumo: rechazada
  assert.equal((await employee.post(`/items/${gas.id}/void`, { requestId: newId(), reason: 'otra vez' })).status, 409);
});

test('5. Cambiar un precio sin alterar consumos anteriores', async () => {
  const before = (await employee.get(`/accounts/${accId}`)).data.totals.consumedCents;
  // El empleado no puede cambiar precios
  assert.equal((await patchProduct(fichaId, { priceCents: 999 }, employee)).status, 403);
  assert.equal((await patchProduct(fichaId, { priceCents: 200000 })).status, 200);
  const d1 = (await employee.get(`/accounts/${accId}`)).data;
  assert.equal(d1.totals.consumedCents, before, 'los consumos anteriores conservan su precio');
  const r = await employee.post(`/accounts/${accId}/ficha`, { requestId: newId() });
  const d = r.data.detail;
  assert.equal(d.totals.fichas, 4);
  const fichaLines = d.summary.filter((x) => x.category === 'ficha');
  assert.equal(fichaLines.length, 2, 'mismo producto con precios distintos va en líneas separadas');
  assert.deepEqual(fichaLines.map((x) => [x.quantity, x.unitPriceCents]).sort(), [[1, 200000], [3, 150000]].sort());
  // El cambio quedó auditado
  const log = (await owner.get('/audit')).data.entries;
  assert.ok(log.some((e) => e.action === 'product.price' && e.summary.includes('→')));
});

let total;
test('6. Pago parcial y luego el resto', async () => {
  let d = (await employee.get(`/accounts/${accId}`)).data;
  total = d.totals.consumedCents; // 4500 + 9000 + 2000 = 15500
  assert.equal(total, 1550000);
  const r1 = await employee.post(`/accounts/${accId}/payments`, {
    requestId: newId(), expectedBalanceCents: total, parts: [{ method: 'efectivo', amountCents: 500000 }],
  });
  assert.equal(r1.status, 200);
  d = r1.data.detail;
  assert.equal(d.totals.paidCents, 500000);
  assert.equal(d.totals.balanceCents, 1050000);
  // No se puede cerrar con saldo pendiente
  const c = await employee.post(`/accounts/${accId}/close`, { requestId: newId(), version: d.account.version });
  assert.equal(c.status, 409);
  assert.equal(c.data.code, 'pending_balance');
  // No se puede cobrar más que el saldo
  const over = await employee.post(`/accounts/${accId}/payments`, {
    requestId: newId(), expectedBalanceCents: 1050000, parts: [{ method: 'efectivo', amountCents: 1050001 }],
  });
  assert.equal(over.status, 400);
  assert.equal(over.data.code, 'over_balance');
  // Saldo esperado desactualizado: rechazado
  const stale = await employee.post(`/accounts/${accId}/payments`, {
    requestId: newId(), expectedBalanceCents: total, parts: [{ method: 'efectivo', amountCents: 100 }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'balance_changed');
});

test('7. Cobrar el resto dividido entre efectivo y transferencia', async () => {
  const r = await employee.post(`/accounts/${accId}/payments`, {
    requestId: newId(), expectedBalanceCents: 1050000,
    parts: [{ method: 'efectivo', amountCents: 300000 }, { method: 'transferencia', amountCents: 750000 }],
  });
  assert.equal(r.status, 200);
  const d = r.data.detail;
  assert.equal(d.totals.balanceCents, 0);
  assert.equal(d.payments.length, 3);
  assert.equal(d.payments.filter((p) => p.groupKey === d.payments[2].groupKey).length, 2);
  const shift = (await employee.get('/shifts/current')).data.report;
  assert.equal(shift.cashCents, 800000);
  assert.equal(shift.transferCents, 750000);
  assert.equal(shift.collectedCents, 1550000);
});

test('8. Cuenta pagada sigue abierta y admite otro consumo', async () => {
  const list = (await employee.get('/accounts')).data.accounts;
  assert.equal(list.find((a) => a.id === accId).status, 'open');
  const r = await employee.post(`/accounts/${accId}/items`, { requestId: newId(), lines: [{ productId: cervezaId, quantity: 1 }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.detail.totals.balanceCents, 450000);
  const p = await employee.post(`/accounts/${accId}/payments`, {
    requestId: newId(), expectedBalanceCents: 450000, parts: [{ method: 'transferencia', amountCents: 450000 }],
  });
  assert.equal(p.data.detail.totals.balanceCents, 0);
});

test('9. Cerrar la cuenta y consultar su resumen en el historial', async () => {
  const d = (await employee.get(`/accounts/${accId}`)).data;
  // Versión vieja: rechazado para no pisar cambios
  const old = await employee.post(`/accounts/${accId}/close`, { requestId: newId(), version: d.account.version - 1 });
  assert.equal(old.status, 409);
  const r = await employee.post(`/accounts/${accId}/close`, { requestId: newId(), version: d.account.version });
  assert.equal(r.status, 200);
  assert.equal(r.data.detail.account.status, 'closed');
  // Cuenta cerrada: no admite cambios
  assert.equal((await employee.post(`/accounts/${accId}/ficha`, { requestId: newId() })).status, 409);
  assert.equal((await employee.patch(`/accounts/${accId}`, { table: '9', version: r.data.detail.account.version })).status, 409);
  // Historial: por nombre (sin tilde), por fecha y por turno
  const byName = (await employee.get('/history?q=agustin')).data.accounts;
  assert.ok(byName.some((a) => a.id === accId));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Tucuman' }).format(new Date());
  assert.ok((await employee.get(`/history?date=${today}`)).data.accounts.some((a) => a.id === accId));
  assert.ok(!(await employee.get('/history?date=2020-01-01')).data.accounts.some((a) => a.id === accId));
  const shiftId = (await employee.get('/shifts/current')).data.shift.id;
  assert.ok((await employee.get(`/history?shift=${shiftId}`)).data.accounts.some((a) => a.id === accId));
  // Resumen completo
  const det = (await employee.get(`/accounts/${accId}`)).data;
  assert.equal(det.totals.consumedCents, 2000000);
  assert.equal(det.totals.paidCents, 2000000);
  assert.ok(det.summary.length >= 3);
});

test('10. Persistencia: reiniciar el servidor conserva todo', async () => {
  const before = (await owner.get(`/accounts/${accId}`)).data;
  await stopServer();
  await startServer();
  const r = await owner.get(`/accounts/${accId}`); // la sesión sigue válida (cookie + base)
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.totals, before.totals);
  assert.equal(r.data.items.length, before.items.length);
});

test('11. Reintentar una operación no duplica consumos ni pagos', async () => {
  const acc = (await employee.post('/accounts', { requestId: newId(), name: 'Reintentos' })).data.accountId;
  const key = newId();
  const a = await employee.post(`/accounts/${acc}/ficha`, { requestId: key });
  const b = await employee.post(`/accounts/${acc}/ficha`, { requestId: key });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.data.replayed, true);
  assert.deepEqual(a.data.itemIds, b.data.itemIds);
  assert.equal(b.data.detail.totals.fichas, 1);

  // Reintentos simultáneos
  const k2 = newId();
  const body = { requestId: k2, lines: [{ productId: cervezaId, quantity: 2 }] };
  const rs = await Promise.all([1, 2, 3].map(() => employee.post(`/accounts/${acc}/items`, body)));
  assert.ok(rs.every((x) => x.status === 200));
  const d = (await employee.get(`/accounts/${acc}`)).data;
  assert.equal(d.items.length, 2);
  assert.equal(d.totals.consumedCents, 200000 + 900000);

  const pk = newId();
  const pay = { requestId: pk, expectedBalanceCents: d.totals.balanceCents, parts: [{ method: 'efectivo', amountCents: 100000 }] };
  const p1 = await employee.post(`/accounts/${acc}/payments`, pay);
  const p2 = await employee.post(`/accounts/${acc}/payments`, pay);
  assert.equal(p1.status, 200); assert.equal(p2.status, 200);
  assert.equal(p2.data.detail.payments.length, 1);
  assert.equal(p2.data.detail.totals.paidCents, 100000);

  // Mismo id con datos distintos: rechazado
  const bad = await employee.post(`/accounts/${acc}/payments`, { ...pay, parts: [{ method: 'efectivo', amountCents: 5 }] });
  assert.equal(bad.status, 409);

  // Dos dispositivos cobran el saldo completo a la vez: solo uno pasa
  const bal = p2.data.detail.totals.balanceCents;
  const both = await Promise.all([owner, employee].map((c) => c.post(`/accounts/${acc}/payments`, {
    requestId: newId(), expectedBalanceCents: bal, parts: [{ method: 'efectivo', amountCents: bal }],
  })));
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  assert.equal((await employee.get(`/accounts/${acc}`)).data.totals.balanceCents, 0);

  // Edición concurrente de la mesa: la segunda con versión vieja no pisa
  const v = (await employee.get(`/accounts/${acc}`)).data.account.version;
  assert.equal((await owner.patch(`/accounts/${acc}`, { table: '5', version: v })).status, 200);
  const conflict = await employee.patch(`/accounts/${acc}`, { table: '7', version: v });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.detail.account.table, '5');
});

test('12. Cerrar un turno que cruza medianoche conserva las cuentas pendientes', async () => {
  // Cerramos el turno actual y simulamos uno abierto ayer a las 22:00 (hora de Tucumán).
  const cur = (await owner.get('/shifts/current')).data.shift;
  await owner.post(`/shifts/${cur.id}/close`, { requestId: newId(), acknowledgeOpenAccounts: true });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Tucuman' }).format(new Date());
  const [todayStart] = zonedDayRange(today);
  const opened = todayStart - 2 * 3600_000; // ayer 22:00
  const shiftId = app.db.q('INSERT INTO shifts (opened_at, opened_by, opening_cash_cents) VALUES (?,?,?)').run(opened, 1, 1000000).lastInsertRowid;

  // Cuenta abierta antes de medianoche, con un pago antes y otro después
  const accRes = await employee.post('/accounts', { requestId: newId(), name: 'Noche larga', withFicha: true });
  const acc = accRes.data.accountId;
  app.db.q('UPDATE accounts SET opened_at = ? WHERE id = ?').run(opened + 30 * 60_000, acc);
  await employee.post(`/accounts/${acc}/ficha`, { requestId: newId() });
  const det = (await employee.get(`/accounts/${acc}`)).data;
  await employee.post(`/accounts/${acc}/payments`, { requestId: newId(), expectedBalanceCents: det.totals.balanceCents, parts: [{ method: 'efectivo', amountCents: 200000 }] });

  // Cerrar sin confirmar con cuentas abiertas: advierte
  const warn = await employee.post(`/shifts/${shiftId}/close`, { requestId: newId() });
  assert.equal(warn.status, 409);
  assert.equal(warn.data.code, 'open_accounts');
  assert.ok(warn.data.openAccounts.count >= 1);

  const closed = await employee.post(`/shifts/${shiftId}/close`, { requestId: newId(), acknowledgeOpenAccounts: true });
  assert.equal(closed.status, 200);
  const rep = closed.data.report;
  assert.equal(rep.collectedCents, 200000);
  assert.equal(rep.fichas, 2);
  assert.ok(rep.openAccounts.pendingCents >= 200000);
  assert.ok(closed.data.shift.closedAt > todayStart, 'cerró después de medianoche');
  assert.ok(closed.data.shift.openedAt < todayStart, 'abrió antes de medianoche');

  // La cuenta sigue abierta, con su deuda intacta
  const after = (await employee.get(`/accounts/${acc}`)).data;
  assert.equal(after.account.status, 'open');
  assert.equal(after.totals.balanceCents, 200000);
  assert.equal((await employee.get('/shifts/current')).data.shift, null);

  // El pago siguiente va al turno nuevo (se abre automáticamente)
  await employee.post(`/accounts/${acc}/payments`, { requestId: newId(), expectedBalanceCents: 200000, parts: [{ method: 'transferencia', amountCents: 200000 }] });
  const next = (await employee.get('/shifts/current')).data;
  assert.ok(next.shift && next.shift.id !== shiftId);
  assert.equal(next.report.collectedCents, 200000);
  assert.equal((await employee.get(`/shifts/${shiftId}`)).data.report.collectedCents, 200000, 'el turno cerrado no cambia');
});

test('13. Permisos entre administradora y empleado', async () => {
  // Rutas solo para la administradora
  assert.equal((await employee.get('/users')).status, 403);
  assert.equal((await employee.post('/users', { displayName: 'X', username: 'xx1', password: 'secreto1' })).status, 403);
  assert.equal((await employee.post('/products', { name: 'X', category: 'bebida', priceCents: 1 })).status, 403);
  assert.equal((await employee.get('/audit')).status, 403);
  assert.equal((await employee.patch('/settings', { businessName: 'X' })).status, 403);

  // Corrección de pago: solo administradora, con motivo, sin borrar
  const acc = (await employee.post('/accounts', { requestId: newId(), name: 'Corrección', withFicha: true })).data.accountId;
  const pay = await employee.post(`/accounts/${acc}/payments`, { requestId: newId(), expectedBalanceCents: 200000, parts: [{ method: 'efectivo', amountCents: 200000 }] });
  const pid = pay.data.paymentIds[0];
  assert.equal((await employee.post(`/payments/${pid}/void`, { requestId: newId(), reason: 'Error' })).status, 403);
  const v = await owner.post(`/payments/${pid}/void`, { requestId: newId(), reason: 'Medio equivocado' });
  assert.equal(v.status, 200);
  assert.equal(v.data.detail.payments[0].voided, true);
  assert.equal(v.data.detail.payments[0].voidedByName, 'Rocío');
  assert.equal(v.data.detail.totals.balanceCents, 200000);

  // Reabrir cuenta cerrada: solo administradora
  assert.equal((await employee.post(`/accounts/${accId}/reopen`, { requestId: newId(), reason: 'Corregir' })).status, 403);
  const re = await owner.post(`/accounts/${accId}/reopen`, { requestId: newId(), reason: 'Corregir pago' });
  assert.equal(re.status, 200);
  assert.equal(re.data.detail.account.status, 'open');

  // Sin sesión: nada
  const anon = client();
  assert.equal((await anon.get('/accounts')).status, 401);
  // Sin el encabezado de la app (CSRF): rechazado
  const raw = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 403);

  // Usuario desactivado pierde el acceso
  const users = (await owner.get('/users')).data.users;
  const martin = users.find((u) => u.username === 'martin');
  await owner.patch(`/users/${martin.id}`, { active: false });
  assert.equal((await employee.get('/accounts')).status, 401);
  // No se puede dejar el sistema sin administradora
  const rocio = users.find((u) => u.username === 'rocio');
  assert.equal((await owner.patch(`/users/${rocio.id}`, { role: 'employee' })).status, 409);
  await owner.patch(`/users/${martin.id}`, { active: true });
});

// ---------- Correcciones de la revisión ----------

test('R1. Direcciones mal formadas no tiran el servidor', async () => {
  // La prueba 13 desactivó y reactivó al empleado (eso cierra sus sesiones): vuelve a ingresar.
  assert.equal((await employee.post('/login', { username: 'martin', password: 'clave12' })).status, 200);
  for (const p of ['/%E0', '/a%00.js', '/%2e%2e%2fpackage.json']) {
    const r = await fetch(base + p);
    assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
  }
  const api = await employee.get('/accounts/%E0');
  assert.equal(api.status, 400);
  assert.equal((await fetch(base + '/')).status, 200, 'el servidor sigue respondiendo');
});

test('R2. Alta de producto idempotente y edición con versión', async () => {
  const key = newId();
  const body = { requestId: key, name: 'Agua tónica', category: 'bebida', priceCents: 180000 };
  const a = await owner.post('/products', body);
  const b = await owner.post('/products', body);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.product.id, b.data.product.id);
  const all = (await owner.get('/products?all=1')).data.products.filter((p) => p.name === 'Agua tónica');
  assert.equal(all.length, 1);
  const v = a.data.product.version;
  assert.equal((await owner.patch(`/products/${a.data.product.id}`, { priceCents: 190000, version: v })).status, 200);
  const stale = await owner.patch(`/products/${a.data.product.id}`, { active: false, version: v });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.product.priceCents, 190000);
  // Usuarios: alta idempotente
  const uk = newId();
  const u1 = await owner.post('/users', { requestId: uk, displayName: 'Ana', username: 'ana', password: 'secreto1' });
  const u2 = await owner.post('/users', { requestId: uk, displayName: 'Ana', username: 'ana', password: 'secreto1' });
  assert.equal(u1.status, 200); assert.equal(u2.status, 200);
  assert.equal(u1.data.user.id, u2.data.user.id);
});

test('R3. Anular un pago después del cierre no cambia el turno cerrado y descuenta del turno actual', async () => {
  const acc = (await employee.post('/accounts', { requestId: newId(), name: 'Devolución', withFicha: true })).data.accountId;
  const bal = (await employee.get(`/accounts/${acc}`)).data.totals.balanceCents;
  const pay = await employee.post(`/accounts/${acc}/payments`, { requestId: newId(), expectedBalanceCents: bal, parts: [{ method: 'efectivo', amountCents: bal }] });
  const s1 = (await owner.get('/shifts/current')).data;
  const closed = await owner.post(`/shifts/${s1.shift.id}/close`, { requestId: newId(), acknowledgeOpenAccounts: true });
  const officialBefore = closed.data.report.collectedCents;
  // Nuevo turno con efectivo inicial; la administradora anula el pago del turno anterior
  const opened = await owner.post('/shifts', { requestId: newId(), openingCashCents: 500000 });
  const v = await owner.post(`/payments/${pay.data.paymentIds[0]}/void`, { requestId: newId(), reason: 'Importe equivocado' });
  assert.equal(v.status, 200);
  const old = (await owner.get(`/shifts/${s1.shift.id}`)).data.report;
  assert.equal(old.collectedCents, officialBefore, 'el turno cerrado conserva sus cifras');
  assert.equal(old.changedAfterClose.length, 0);
  const cur = (await owner.get('/shifts/current')).data.report;
  assert.equal(cur.refundsCents, bal);
  assert.equal(cur.cashCents, -bal);
  assert.equal(cur.expectedCashCents, 500000 - bal, 'el efectivo esperado descuenta la devolución');
  const list = (await owner.get('/shifts')).data.shifts;
  assert.equal(list.find((x) => x.id === s1.shift.id).collectedCents, officialBefore);
  assert.equal(opened.data.shift.id, cur && (await owner.get('/shifts/current')).data.shift.id);
});

test('R4. Cierre de turno con cifras desactualizadas: pide revisar', async () => {
  const cur = (await owner.get('/shifts/current')).data;
  const r = await owner.post(`/shifts/${cur.shift.id}/close`, {
    requestId: newId(), acknowledgeOpenAccounts: true,
    expected: { collectedCents: cur.report.collectedCents + 1, openAccounts: cur.report.openAccounts.count },
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'shift_changed');
  assert.equal(r.data.report.collectedCents, cur.report.collectedCents);
  const ok = await owner.post(`/shifts/${cur.shift.id}/close`, {
    requestId: newId(), acknowledgeOpenAccounts: true,
    expected: { collectedCents: cur.report.collectedCents, openAccounts: cur.report.openAccounts.count },
  });
  assert.equal(ok.status, 200);
});

test('R5. Efectivo inicial de un turno abierto automáticamente', async () => {
  assert.equal((await owner.get('/shifts/current')).data.shift, null);
  // Cerrar una cuenta sin turno abierto también abre turno (la cuenta queda asignada)
  const acc = (await employee.post('/accounts', { requestId: newId(), name: 'Vacía' })).data.accountId;
  const cur = (await employee.get('/shifts/current')).data.shift;
  assert.ok(cur.autoOpened);
  const p1 = await employee.patch(`/shifts/${cur.id}`, { openingCashCents: 300000 });
  assert.equal(p1.status, 200);
  assert.equal(p1.data.report.expectedCashCents, 300000);
  assert.equal((await employee.patch(`/shifts/${cur.id}`, { openingCashCents: 1 })).status, 403, 'una sola vez para el empleado');
  assert.equal((await owner.patch(`/shifts/${cur.id}`, { openingCashCents: 350000 })).status, 200);
  await owner.post(`/shifts/${cur.id}/close`, { requestId: newId(), acknowledgeOpenAccounts: true });
  const d = (await employee.get(`/accounts/${acc}`)).data;
  const closed = await employee.post(`/accounts/${acc}/close`, { requestId: newId(), version: d.account.version });
  assert.equal(closed.status, 200);
  const row = app.db.q('SELECT closed_shift_id FROM accounts WHERE id = ?').get(acc);
  assert.ok(row.closed_shift_id, 'la cuenta cerrada queda asignada a un turno');
});

test('R6. Seguridad: bootstrap sin sesión, contraseña y búsqueda', async () => {
  const anon = client();
  const b = (await anon.get('/bootstrap')).data;
  assert.equal(b.shift, undefined);
  assert.equal(b.ficha, undefined);
  assert.equal(b.needsSetup, false);

  // Cambiar la contraseña cierra las demás sesiones
  const other = client();
  assert.equal((await other.post('/login', { username: 'ana', password: 'secreto1' })).status, 200);
  const me = client();
  await me.post('/login', { username: 'ana', password: 'secreto1' });
  assert.equal((await me.post('/me/password', { current: 'secreto1', password: 'nueva123' })).status, 200);
  assert.equal((await me.get('/accounts')).status, 200, 'la sesión actual sigue');
  assert.equal((await other.get('/accounts')).status, 401, 'las otras se cierran');

  // Búsqueda del historial: comodines escapados y "mesa N"
  const a = (await employee.post('/accounts', { requestId: newId(), name: '100% fichas', table: '7' })).data;
  await employee.post(`/accounts/${a.accountId}/close`, { requestId: newId(), version: a.detail.account.version });
  const pct = (await employee.get('/history?q=' + encodeURIComponent('100%'))).data.accounts;
  assert.ok(pct.some((x) => x.id === a.accountId));
  const under = (await employee.get('/history?q=' + encodeURIComponent('_'))).data.accounts;
  assert.ok(!under.some((x) => x.name === 'Agustín'), '"_" no funciona como comodín');
  const mesa = (await employee.get('/history?q=' + encodeURIComponent('mesa 7'))).data.accounts;
  assert.ok(mesa.some((x) => x.id === a.accountId));
});

test('R7. El código de configuración se renueva tras 5 intentos fallidos', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-setup-'));
  const logs = [];
  const fresh = createApp({ dbFile: path.join(d2, 's.sqlite'), log: (m) => logs.push(m) });
  await new Promise((r) => fresh.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${fresh.server.address().port}/api/setup`;
  const first = fresh.ctx.setupCode;
  assert.equal(first.length, 8);
  const post = (code) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pool-app' },
    body: JSON.stringify({ setupCode: code, displayName: 'X', username: 'xxx', password: 'secreto1' }) });
  for (let i = 0; i < 5; i++) assert.equal((await post('00000000')).status, 403);
  assert.notEqual(fresh.ctx.setupCode, first, 'el código cambió');
  assert.equal((await post(first)).status, 403, 'el código viejo ya no sirve');
  assert.ok(logs.some((m) => m.includes(fresh.ctx.setupCode)), 'el nuevo código se muestra en la consola');
  assert.equal((await post(fresh.ctx.setupCode)).status, 200);
  await new Promise((r) => fresh.server.close(r));
  fs.rmSync(d2, { recursive: true, force: true });
});

test('Fechas: el día local de Tucumán empieza a las 03:00 UTC', () => {
  const [from, to] = zonedDayRange('2026-11-25');
  assert.equal(new Date(from).toISOString(), '2026-11-25T03:00:00.000Z');
  assert.equal(to - from, 86400_000);
});
