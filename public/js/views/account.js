// Pantalla 2: detalle de una cuenta.
import * as api from '../api.js';
import { html, openSheet, toast, confirmSheet, runOp, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, time, when, plural, METHOD_LABEL, dateShort } from '../format.js';
import { appbar, poll, isAdmin } from '../store.js';
import { balanceInfo, addFicha, openVoidSheet } from './shared.js';
import { openCatalog } from './catalog.js';
import { openPayment } from './payment.js';

const tabByAccount = new Map();

export function mount(root, { params, navigate }) {
  const id = Number(params[0]);
  let d = null;
  let tab = tabByAccount.get(id) ?? 'resumen';
  let loadError = null;

  root.innerHTML = html`<div id="bar">${appbar({ title: 'Cuenta', back: '#/' })}</div>
    <main class="view no-nav" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>
    <div id="dock"></div>`.s;

  const content = $('#content', root);

  function set(detail) {
    if (!detail || detail.account.id !== id) return;
    if (d && detail.account.version < d.account.version) return; // respuesta vieja
    // Sin cambios: no redibujar (evita perder un toque a mitad de la pulsación).
    if (d && detail.account.version === d.account.version && detail.account.status === d.account.status) return;
    d = detail;
    render();
  }

  async function load() {
    try {
      set(await api.get(`/accounts/${id}`));
      loadError = null;
    } catch (e) {
      loadError = e;
      if (!d) render();
    }
  }

  function render() {
    if (!d) {
      content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">${loadError?.status === 404 ? 'La cuenta no existe' : 'No se pudo cargar la cuenta'}</p>
        <p>${loadError?.message ?? ''}</p><p style="margin-top:14px"><button class="btn" data-a="reload">${icons.refresh} Reintentar</button></p></div>`.s;
      return;
    }
    const { account: a, totals: t } = d;
    const open = a.status === 'open';
    const b = balanceInfo(t.balanceCents, t.consumedCents);

    $('#bar', root).innerHTML = appbar({
      title: a.name,
      sub: open ? `Abierta ${when(a.openedAt)} · por ${a.openedByName}` : `Cerrada ${dateShort(a.closedAt)} ${time(a.closedAt)}`,
      back: open ? '#/' : '#/historial',
      right: html`<button class="icon-btn" data-a="more" aria-label="Más acciones de la cuenta">${icons.edit}</button>`,
    }).s;

    content.innerHTML = html`
      ${!open ? html`<div class="closed-banner">${icons.lock}<div>Cuenta cerrada por ${a.closedByName}. Solo consulta${isAdmin() ? ': podés reabrirla desde el lápiz si hay que corregir algo' : ''}.</div></div>` : ''}
      <section class="card hero" aria-label="Totales de la cuenta">
        <div class="hero-row">
          ${open ? html`<button class="table-btn ${a.table ? 'has' : ''}" data-a="edit-table">${icons.table} ${a.table ? `Mesa ${a.table}` : 'Sin mesa · asignar'}</button>`
            : (a.table ? html`<span class="chip chip-table">Mesa ${a.table}</span>` : '')}
          <span class="chip">🎱 ${plural(t.fichas, 'ficha', 'fichas')}</span>
        </div>
        <div class="hero-balance ${b.cls}" aria-live="polite">
          <div class="lbl">${b.label}</div>
          <div class="amt">${b.amount}</div>
        </div>
        <div class="totals">
          <div><div class="lbl">Total consumido</div><div class="val">${money(t.consumedCents)}</div></div>
          <div><div class="lbl">Pagado</div><div class="val">${money(t.paidCents)}</div></div>
        </div>
      </section>
      ${open && t.balanceCents === 0 && t.consumedCents > 0 ? html`<div class="banner ok">
          ${icons.check}<div class="grow">Cuenta saldada. Puede seguir abierta para nuevos consumos.</div>
          <button class="btn" data-a="close">Cerrar cuenta</button></div>` : ''}
      ${t.balanceCents < 0 ? html`<div class="form-error">${icons.alert} Se cobró ${money(-t.balanceCents)} de más (por una anulación posterior al pago). La administradora debe corregir el pago para poder cerrar.</div>` : ''}
      <div class="tabs" role="tablist">
        ${tabBtn('resumen', 'Consumos')}${tabBtn('movimientos', 'Movimientos')}${tabBtn('pagos', `Pagos${d.payments.length ? ` (${d.payments.filter((p) => !p.voided).length})` : ''}`)}
      </div>
      <section class="card" role="tabpanel">${tab === 'resumen' ? summaryPanel() : tab === 'movimientos' ? itemsPanel() : paymentsPanel()}</section>
      ${!open ? html`<p style="margin-top:14px"><a class="btn btn-block" href="#/cuenta/${a.id}/resumen">${icons.receipt} Resumen para el cliente</a></p>` : ''}`.s;

    $('#dock', root).innerHTML = open ? html`<div class="dock no-nav"><div class="dock-inner">
        <button class="btn btn-primary btn-lg" style="flex:1.3 1 0" data-a="ficha">${icons.plus} Ficha</button>
        <button class="btn btn-lg" data-a="drink">${icons.drink} Bebida</button>
        <button class="btn btn-lg" data-a="pay" ${t.balanceCents > 0 ? '' : 'aria-disabled="true"'}>${icons.pay} Cobrar</button>
      </div></div>`.s : html`<div class="dock no-nav"><div class="dock-inner">
        <a class="btn btn-primary btn-lg btn-block" href="#/cuenta/${a.id}/resumen">${icons.share} Compartir resumen</a></div></div>`.s;
  }

  const tabBtn = (key, label) => html`<button role="tab" aria-selected="${tab === key}" data-tab="${key}">${label}</button>`;

  function summaryPanel() {
    if (!d.summary.length) {
      return html`<div class="empty" style="padding:28px 16px"><p class="big">Sin consumos todavía</p>
        <p>${d.account.status === 'open' ? 'Tocá + Ficha o Bebida para empezar.' : ''}</p></div>`;
    }
    return html`<div class="rows">${d.summary.map((g) => html`<div class="row">
        <span class="qty-badge" aria-label="${g.quantity} unidades">${g.quantity}×</span>
        <div class="grow"><div class="title">${g.productName}</div><div class="sub">${money(g.unitPriceCents)} c/u</div></div>
        <div class="amount">${money(g.subtotalCents)}</div></div>`)}
      </div><div class="total-line"><span>Total consumido</span><span class="num">${money(d.totals.consumedCents)}</span></div>`;
  }

  function itemsPanel() {
    if (!d.items.length) return html`<div class="empty" style="padding:28px 16px"><p>No hay movimientos.</p></div>`;
    const open = d.account.status === 'open';
    return html`<div class="rows">${[...d.items].reverse().map((i) => html`
      <button class="row row-btn ${i.voided ? 'voided' : ''}" data-item="${i.id}" ${open && !i.voided ? '' : 'aria-disabled="true"'}>
        <span class="qty-badge">${i.quantity}×</span>
        <div class="grow"><div class="title">${i.productName}</div>
          <div class="sub">${when(i.createdAt)} · ${money(i.unitPriceCents)} c/u · ${i.createdByName}</div>
          ${i.voided ? html`<div class="sub" style="color:#ffb3b3">ANULADO ${when(i.voidedAt)} por ${i.voidedByName}: ${i.voidReason}</div>` : ''}
        </div>
        <div class="amount">${money(i.subtotalCents)}</div>
      </button>`)}</div>
      ${open ? html`<p class="hint" style="padding:10px 14px">Tocá un movimiento para anularlo.</p>` : ''}`;
  }

  function paymentsPanel() {
    if (!d.payments.length) return html`<div class="empty" style="padding:28px 16px"><p>Todavía no se registraron pagos.</p></div>`;
    const groups = new Map();
    d.payments.forEach((p) => groups.set(p.groupKey, (groups.get(p.groupKey) ?? 0) + 1));
    const canFix = isAdmin() && d.account.status === 'open';
    return html`<div class="rows">${[...d.payments].reverse().map((p) => html`
      <button class="row row-btn ${p.voided ? 'voided' : ''}" data-payment="${p.id}" ${canFix && !p.voided ? '' : 'aria-disabled="true"'}>
        <span class="chip ${p.method === 'efectivo' ? 'chip-ok' : 'chip-table'}">${METHOD_LABEL[p.method]}</span>
        <div class="grow"><div class="sub" style="margin:0">${when(p.createdAt)} · ${p.createdByName}${groups.get(p.groupKey) > 1 ? ' · cobro dividido' : ''}</div>
          ${p.voided ? html`<div class="sub" style="color:#ffb3b3">ANULADO ${when(p.voidedAt)} por ${p.voidedByName}: ${p.voidReason}</div>` : ''}
        </div>
        <div class="amount">${money(p.amountCents)}</div>
      </button>`)}</div>
      <div class="total-line"><span>Total pagado</span><span class="num">${money(d.totals.paidCents)}</span></div>
      ${canFix ? html`<p class="hint" style="padding:0 14px 12px">Para corregir un pago, tocalo y anulalo con un motivo; después registrá el cobro correcto.</p>`
        : (isAdmin() ? '' : html`<p class="hint" style="padding:0 14px 12px">Las correcciones de pagos las hace la administradora.</p>`)}`;
  }

  // ---------- Acciones ----------

  function openItem(itemId) {
    const it = d.items.find((i) => i.id === itemId);
    if (!it || it.voided || d.account.status !== 'open') return;
    openVoidSheet({
      title: 'Anular consumo',
      description: html`<div class="card" style="padding:12px 14px"><strong>${it.quantity}× ${it.productName}</strong>
        <div class="muted small">${money(it.unitPriceCents)} c/u · ${money(it.subtotalCents)} · cargado ${when(it.createdAt)} por ${it.createdByName}</div></div>`,
      confirmLabel: 'Anular consumo',
      path: `/items/${it.id}/void`,
      onSaved: set,
    });
  }

  function openPaymentFix(paymentId) {
    const p = d.payments.find((x) => x.id === paymentId);
    if (!p || p.voided || !isAdmin() || d.account.status !== 'open') return;
    openVoidSheet({
      title: 'Corregir pago',
      description: html`<div class="card" style="padding:12px 14px"><strong>${money(p.amountCents)} · ${METHOD_LABEL[p.method]}</strong>
        <div class="muted small">Registrado ${when(p.createdAt)} por ${p.createdByName}</div></div>
        <p class="hint" style="margin-top:10px">El pago queda anulado (no se borra) y el saldo vuelve a quedar pendiente. Si correspondía otro importe o medio, registrá el cobro correcto después.</p>`,
      confirmLabel: 'Anular pago',
      path: `/payments/${p.id}/void`,
      reasons: ['Importe equivocado', 'Medio de pago equivocado', 'Cuenta equivocada', 'Devolución al cliente'],
      onSaved: set,
    });
  }

  function openEdit(focus = 'name') {
    const a = d.account;
    const s = openSheet({ title: 'Editar cuenta' });
    s.setBody(html`<form id="ed-form" autocomplete="off">
      <div class="form-error" hidden></div>
      <label class="field"><span>Nombre o referencia</span><input class="input" name="name" maxlength="40" value="${a.name}" required ${focus === 'name' ? 'autofocus' : ''}></label>
      <label class="field"><span>Mesa <span class="muted">(opcional; podés cambiarla sin perder consumos)</span></span>
        <input class="input" name="table" maxlength="20" value="${a.table}" placeholder="Sin mesa" enterkeyhint="done" ${focus === 'table' ? 'autofocus' : ''}></label>
      ${a.table ? html`<button type="button" class="btn btn-ghost" data-clear>Quitar mesa</button>` : ''}
      <button type="submit" hidden></button></form>`);
    s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-save>Guardar</button>`);
    const form = $('#ed-form', s.body);
    const err = $('.form-error', s.body);
    $('[data-clear]', s.body)?.addEventListener('click', () => { form.table.value = ''; form.table.focus(); });
    const save = async () => {
      const btn = $('[data-save]', s.foot);
      btn.setAttribute('aria-busy', 'true');
      err.hidden = true;
      try {
        const r = await api.patch(`/accounts/${a.id}`, { name: form.name.value, table: form.table.value, version: d.account.version });
        set(r.detail);
        await s.close();
        toast('Cuenta actualizada');
      } catch (e) {
        if (e.data?.detail) {
          set(e.data.detail);
          form.name.value = d.account.name;
          form.table.value = d.account.table;
        }
        err.textContent = e.message;
        err.hidden = false;
      } finally { btn.removeAttribute('aria-busy'); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    $('[data-save]', s.foot).addEventListener('click', save);
  }

  function openMore() {
    const a = d.account;
    const open = a.status === 'open';
    const s = openSheet({ title: a.name, sub: 'Acciones de la cuenta' });
    s.setBody(html`<div class="menu-list">
      ${open ? html`<button data-m="edit">${icons.edit} Editar nombre o mesa</button>` : ''}
      <a href="#/cuenta/${a.id}/resumen">${icons.receipt} Resumen para el cliente</a>
      ${open ? html`<button data-m="close">${icons.lock} Cerrar cuenta</button>` : ''}
      ${!open && isAdmin() ? html`<button data-m="reopen">${icons.undo} Reabrir cuenta (administradora)</button>` : ''}
    </div>`);
    s.body.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      await s.close();
      if (m === 'edit') openEdit();
      if (m === 'close') closeAccount();
      if (m === 'reopen') reopen();
    });
  }

  async function closeAccount() {
    const { totals: t, account: a } = d;
    if (t.balanceCents > 0) {
      toast(`No se puede cerrar: queda ${money(t.balanceCents)} pendiente. Cobrá primero.`, { type: 'error', action: 'Cobrar', onAction: pay, duration: 7000 });
      return;
    }
    if (t.balanceCents < 0) {
      toast('Hay un pago de más: la administradora debe corregirlo antes de cerrar.', { type: 'error', duration: 7000 });
      return;
    }
    const version = a.version;
    const ok = await confirmSheet({
      title: `Cerrar la cuenta de ${a.name}`,
      message: html`<div class="pay-summary">
        <div class="line"><span>Total consumido</span><strong>${money(t.consumedCents)}</strong></div>
        <div class="line"><span>Pagado</span><strong>${money(t.paidCents)}</strong></div>
        <div class="line strong"><span>Saldo</span><span>${money(0)}</span></div></div>
        <p class="hint" style="margin-top:12px">La cuenta pasa al historial y ya no se le pueden cargar consumos.</p>`,
      confirmLabel: 'Cerrar cuenta',
    });
    if (!ok) return;
    const requestId = api.newRequestId();
    await runOp({
      failMsg: 'No se pudo cerrar la cuenta',
      exec: () => api.post(`/accounts/${a.id}/close`, { requestId, version }),
      onSuccess: () => {
        navigate('#/');
        toast(`Cuenta de ${a.name} cerrada`, { action: 'Ver resumen', onAction: () => navigate(`#/cuenta/${a.id}/resumen`), duration: 6000 });
      },
    }).then(() => load());
  }

  function reopen() {
    openVoidSheet({
      title: 'Reabrir cuenta',
      description: html`<p>La cuenta vuelve a “Cuentas abiertas” y se podrán corregir consumos o pagos. Queda registrado quién la reabrió y por qué.</p>`,
      confirmLabel: 'Reabrir',
      path: `/accounts/${d.account.id}/reopen`,
      reasons: ['Corregir un pago', 'Corregir un consumo', 'Se cerró por error'],
      onSaved: set,
    });
  }

  function pay(presetCents) {
    if (d.totals.balanceCents <= 0) { toast('Esta cuenta no tiene saldo pendiente.'); return; }
    openPayment(d, {
      presetCents,
      onSaved: set,
      onCloseAccount: () => closeAccount(),
    });
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-a], [data-tab], [data-item], [data-payment]');
    if (!t || !d && t.dataset.a !== 'reload') return;
    if (t.dataset.tab) { tab = t.dataset.tab; tabByAccount.set(id, tab); render(); return; }
    if (t.dataset.item) { openItem(Number(t.dataset.item)); return; }
    if (t.dataset.payment) { openPaymentFix(Number(t.dataset.payment)); return; }
    switch (t.dataset.a) {
      case 'reload': load(); break;
      case 'ficha':
        addFicha(d.account, {
          button: t,
          onSaved: set,
          // Ofrece cobrar la ficha al momento, sin frenar la carga.
          onCharge: (cents) => pay(cents),
        });
        break;
      case 'drink': openCatalog(d.account, { onSaved: set }); break;
      case 'pay': pay(); break;
      case 'close': closeAccount(); break;
      case 'edit-table': openEdit('table'); break;
      case 'more': openMore(); break;
      default:
    }
  });

  const onChanged = () => load();
  window.addEventListener('account-changed', onChanged);
  load();
  const stop = poll(load, 8000);
  return () => { stop(); window.removeEventListener('account-changed', onChanged); };
}
