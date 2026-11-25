// Pantalla 3: caja del turno.
import * as api from '../api.js';
import { html, openSheet, toast, moneyField, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, range, duration, plural, parseMoney, when } from '../format.js';
import { appbar, poll } from '../store.js';

/** Métricas de un turno (se reutiliza en el detalle de turnos anteriores). */
export function reportBlocks(r, { live }) {
  return html`
    <section class="card metric-hero">
      <div class="lbl">Dinero cobrado en el turno</div>
      <div class="val">${money(r.collectedCents)}</div>
      <div class="muted small">${plural(r.paymentsCount, 'pago registrado', 'pagos registrados')}${r.voidedPayments ? ` · ${plural(r.voidedPayments, 'pago anulado', 'pagos anulados')}` : ''}</div>
    </section>
    <div class="metrics">
      <div class="card metric"><div class="lbl">${icons.cash} Efectivo</div><div class="val">${money(r.cashCents)}</div></div>
      <div class="card metric"><div class="lbl">${icons.pay} Transferencia</div><div class="val">${money(r.transferCents)}</div></div>
      <div class="card metric"><div class="lbl">${icons.ball} Fichas vendidas</div><div class="val">${r.fichas}</div></div>
      <div class="card metric"><div class="lbl">${icons.drink} Bebidas vendidas</div><div class="val">${r.bebidas}</div></div>
      <div class="card metric"><div class="lbl">${icons.accounts} ${live ? 'Cuentas abiertas' : 'Abiertas al cierre'}</div><div class="val">${r.openAccounts.count}</div></div>
      <div class="card metric ${r.openAccounts.pendingCents > 0 ? 'warn' : ''}"><div class="lbl">${icons.clock} Saldo pendiente</div><div class="val">${money(r.openAccounts.pendingCents)}</div></div>
    </div>
    <section class="card" style="margin-bottom:10px">
      <div class="rows">
        <div class="row"><div class="grow">Efectivo esperado en caja<div class="sub">Efectivo inicial + cobros en efectivo</div></div><div class="amount">${money(r.expectedCashCents)}</div></div>
        <div class="row"><div class="grow">Consumo cargado en el turno<div class="sub">Incluye lo que todavía no se cobró</div></div><div class="amount">${money(r.consumedCents)}</div></div>
        ${r.otros ? html`<div class="row"><div class="grow">Otros consumos vendidos</div><div class="amount">${r.otros}</div></div>` : ''}
        <div class="row"><div class="grow">Cuentas abiertas / cerradas en el turno</div><div class="amount">${r.accountsOpened} / ${r.accountsClosed}</div></div>
      </div>
    </section>`;
}

export function mount(root) {
  let data = null;
  let shifts = [];
  let err = null;

  root.innerHTML = html`${appbar({ title: 'Caja del turno' })}
    <main class="view" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>
    <div id="dock"></div>`.s;
  const content = $('#content', root);

  async function load() {
    try {
      const [cur, list] = await Promise.all([api.get('/shifts/current'), api.get('/shifts')]);
      data = cur; shifts = list.shifts; err = null;
    } catch (e) { err = e.message; }
    render();
  }

  function render() {
    if (!data) {
      content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudo cargar la caja</p><p>${err ?? ''}</p>
        <p style="margin-top:12px"><button class="btn" data-c="reload">${icons.refresh} Reintentar</button></p></div>`.s;
      return;
    }
    const { shift, report } = data;
    const past = shifts.filter((x) => !x.isOpen).slice(0, 15);
    content.innerHTML = html`
      ${shift ? html`
        <p class="muted small" style="margin:0 4px 10px">Turno abierto ${range(shift.openedAt, null).replace(' → en curso', '')} por ${shift.openedByName} · hace ${duration(shift.openedAt)}${shift.autoOpened ? ' · abierto automáticamente' : ''}</p>
        ${reportBlocks(report, { live: true })}`
      : html`<section class="card" style="padding:18px;margin-bottom:12px">
          <p class="big" style="font-weight:700;font-size:1.1rem;margin-bottom:6px">No hay un turno abierto</p>
          <p class="muted">Abrí el turno al empezar a atender. Si te olvidás, se abre solo al registrar la primera carga o cobro.</p>
          ${data.openAccounts.count ? html`<p class="form-warn" style="margin:12px 0 0">Hay ${plural(data.openAccounts.count, 'cuenta abierta', 'cuentas abiertas')} del turno anterior con ${money(data.openAccounts.pendingCents)} pendiente. Siguen disponibles.</p>` : ''}
        </section>`}
      <h2 class="section-title">Turnos anteriores</h2>
      ${past.length ? html`<div class="card"><div class="rows">${past.map((x) => html`
        <a class="row row-btn" href="#/caja/turno/${x.id}" style="text-decoration:none">
          <div class="grow"><div class="title">${range(x.openedAt, x.closedAt)}</div><div class="sub">Abrió ${x.openedByName} · cerró ${x.closedByName}</div></div>
          <div class="amount">${money(x.collectedCents)}</div></a>`)}</div></div>`
        : html`<p class="muted" style="margin:0 4px">Todavía no hay turnos cerrados.</p>`}`.s;

    $('#dock', root).innerHTML = html`<div class="dock"><div class="dock-inner">
      ${shift ? html`<button class="btn btn-lg btn-block" data-c="close">${icons.lock} Cerrar turno</button>`
        : html`<button class="btn btn-primary btn-lg btn-block" data-c="open">${icons.plus} Abrir turno</button>`}
    </div></div>`.s;
  }

  function openShift() {
    const s = openSheet({ title: 'Abrir turno' });
    const requestId = api.newRequestId();
    s.setBody(html`<form id="os-form" autocomplete="off">
      <div class="form-error" hidden></div>
      <label class="field"><span>Efectivo inicial en caja <span class="muted">(opcional)</span></span>
        <div class="input-wrap"><span class="prefix">$</span><input class="input input-money" name="cash" inputmode="decimal" placeholder="0" enterkeyhint="done"></div></label>
      <p class="hint">Sirve para calcular cuánto efectivo debería haber al cerrar.</p>
      <button type="submit" hidden></button></form>`);
    s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-ok>Abrir turno</button>`);
    const form = $('#os-form', s.body);
    moneyField(form.cash);
    const errEl = $('.form-error', s.body);
    let lastBody = null; let key = requestId;
    const submit = async () => {
      const cents = form.cash.value.trim() ? parseMoney(form.cash.value) : 0;
      if (cents === null) { errEl.textContent = 'Revisá el importe.'; errEl.hidden = false; return; }
      if (lastBody !== null && lastBody !== cents) key = api.newRequestId();
      lastBody = cents;
      const btn = $('[data-ok]', s.foot);
      btn.setAttribute('aria-busy', 'true');
      try {
        await api.post('/shifts', { requestId: key, openingCashCents: cents });
        await s.close();
        toast('Turno abierto');
        load();
      } catch (e) {
        errEl.textContent = e.message; errEl.hidden = false;
        if (e.code === 'shift_open') load();
      } finally { btn.removeAttribute('aria-busy'); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    $('[data-ok]', s.foot).addEventListener('click', submit);
  }

  function closeShift() {
    const { shift, report } = data;
    const requestId = api.newRequestId();
    const s = openSheet({ title: 'Cerrar turno', sub: `Desde ${when(shift.openedAt)}` });
    const open = report.openAccounts;
    s.setBody(html`
      <div class="form-error" hidden></div>
      ${open.count ? html`<div class="form-warn"><strong>Quedan ${plural(open.count, 'cuenta abierta', 'cuentas abiertas')} con ${money(open.pendingCents)} pendiente.</strong><br>
        No se borran ni se marcan como pagadas: siguen disponibles para el turno siguiente.</div>` : ''}
      <div class="pay-summary">
        <div class="line strong"><span>Cobrado</span><span>${money(report.collectedCents)}</span></div>
        <div class="line"><span>Efectivo</span><span>${money(report.cashCents)}</span></div>
        <div class="line"><span>Transferencia</span><span>${money(report.transferCents)}</span></div>
        <div class="line"><span>Efectivo esperado en caja</span><strong>${money(report.expectedCashCents)}</strong></div>
        <div class="line"><span>Fichas / bebidas</span><span>${report.fichas} / ${report.bebidas}</span></div>
      </div>
      <p class="hint" style="margin-top:12px">Los cobros que se registren después irán al próximo turno.</p>`);
    s.setFoot(html`<div class="row2"><button class="btn" data-close>Cancelar</button>
      <button class="btn btn-primary" data-ok>${open.count ? 'Cerrar igual' : 'Cerrar turno'}</button></div>`);
    const errEl = $('.form-error', s.body);
    $('[data-ok]', s.foot).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.setAttribute('aria-busy', 'true');
      try {
        await api.post(`/shifts/${shift.id}/close`, { requestId, acknowledgeOpenAccounts: true });
        await s.close();
        toast(open.count ? `Turno cerrado. ${plural(open.count, 'cuenta sigue abierta', 'cuentas siguen abiertas')}.` : 'Turno cerrado');
        load();
      } catch (e2) {
        errEl.textContent = e2.message; errEl.hidden = false;
      } finally { btn.removeAttribute('aria-busy'); }
    });
  }

  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'reload') load();
    if (c === 'open') openShift();
    if (c === 'close' && data?.shift) closeShift();
  });

  load();
  return poll(load, 15000);
}
