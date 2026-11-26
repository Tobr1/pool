import { tx, setMeta } from './db.js';
import { hashPassword } from './auth.js';
import { normText } from './util.js';

/**
 * Carga datos de demostración. Solo se usa con DEMO=1, que trabaja sobre
 * data/demo.sqlite (un archivo distinto del de datos reales).
 * Devuelve true si sembró datos.
 */
export function seedDemo(db) {
  if (db.q('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  const t = Date.now();
  const min = 60_000;
  tx(db, () => {
    setMeta(db, 'business_name', 'Pool Demo');
    const pw = hashPassword('demo1234');
    const rocio = db.q(`INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES ('rocio','Rocío','admin',?,?)`).run(pw, t).lastInsertRowid;
    const emp = db.q(`INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES ('empleado','Martín (empleado)','employee',?,?)`).run(pw, t).lastInsertRowid;

    const prod = (name, category, pesos, favorite = 0, isDefault = 0) =>
      db.q(`INSERT INTO products (name, category, price_cents, active, favorite, is_default_ficha, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(name, category, pesos * 100, 1, favorite, isDefault, t, t).lastInsertRowid;
    const ficha = prod('Ficha de pool', 'ficha', 1500, 1, 1);
    const cerveza = prod('Cerveza 1 L', 'bebida', 4500, 1);
    const gaseosa = prod('Gaseosa 500 ml', 'bebida', 2200, 1);
    prod('Agua 500 ml', 'bebida', 1500, 1);
    const fernet = prod('Fernet con cola', 'bebida', 5000, 1);
    prod('Cerveza lata', 'bebida', 2800);
    prod('Vino (copa)', 'bebida', 3000);
    prod('Café', 'bebida', 1800);
    prod('Papas fritas', 'otro', 2500);
    prod('Maní', 'otro', 1200);

    const shift = db.q('INSERT INTO shifts (opened_at, opened_by, opening_cash_cents) VALUES (?,?,?)').run(t - 180 * min, rocio, 20000 * 100).lastInsertRowid;

    const account = (name, table, openedAgo, by) =>
      db.q(`INSERT INTO accounts (name, name_search, table_label, table_search, opened_at, opened_by, opened_shift_id) VALUES (?,?,?,?,?,?,?)`)
        .run(name, normText(name), table, normText(table), t - openedAgo * min, by, shift).lastInsertRowid;
    const item = (acc, productId, qty, ago, by) => {
      const p = db.q('SELECT * FROM products WHERE id = ?').get(productId);
      db.q(`INSERT INTO items (account_id, product_id, product_name, category, unit_price_cents, quantity, created_at, created_by, shift_id) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(acc, p.id, p.name, p.category, p.price_cents, qty, t - ago * min, by, shift);
    };
    const pay = (acc, pesos, method, ago, by) =>
      db.q(`INSERT INTO payments (account_id, amount_cents, method, created_at, created_by, shift_id, group_key) VALUES (?,?,?,?,?,?,?)`)
        .run(acc, pesos * 100, method, t - ago * min, by, shift, `demo-${acc}-${ago}`);

    const a1 = account('Agustín y amigos', '3', 95, rocio);
    item(a1, ficha, 1, 95, rocio); item(a1, ficha, 1, 60, rocio); item(a1, cerveza, 2, 55, emp); item(a1, ficha, 1, 20, emp);

    const a2 = account('Lucía', '1', 70, emp);
    item(a2, ficha, 1, 70, emp); pay(a2, 1500, 'efectivo', 70, emp); item(a2, gaseosa, 1, 40, emp);

    const a3 = account('Grupo de la camiseta roja', '', 30, rocio);
    item(a3, fernet, 3, 25, rocio);

    const a4 = account('Pablo', '2', 160, rocio);
    item(a4, ficha, 2, 160, rocio); item(a4, cerveza, 1, 130, rocio);
    pay(a4, 3000, 'efectivo', 100, rocio); pay(a4, 4500, 'transferencia', 100, rocio);
    db.q(`UPDATE accounts SET status = 'closed', closed_at = ?, closed_by = ?, closed_shift_id = ? WHERE id = ?`).run(t - 99 * min, rocio, shift, a4);
  });
  return true;
}
