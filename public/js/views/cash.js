// Pantalla 3: caja del turno.
import * as api from '../api.js';
import { html, openSheet, toast, moneyField, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, moneyInput, range, duration, plural, parseMoney, when } from '../format.js';
import { appbar, poll, isAdmin } from '../store.js';

/** Métricas de un turno (se reutiliza en el detalle de turnos anteriores). */
export function reportBlocks(r, { live, canEditOpening = false }) {
  return html`
    <section class="card metric-hero">
      <div class="lbl">Dinero cobrado en el turno</div>
      <div class="val">${money(r.collectedCents)}</div>
      <div class="muted small">${plural(r.paymentsCount, 'pago registrado', 'pagos registrados')}${r.refundsCount ? ` · ${plural(r.refundsCount, 'devolución', 'devoluciones')} (${money(r.refundsCents)})` : ''}</div>
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
        <div class="row"><div class="grow">Efectivo esperado en caja<div class="sub">Inicial ${money(r.openingCashCents ?? 0)} + cobros en efectivo${r.refundsCents ? ' − devoluciones' : ''}</div></div><div class="amount">${money(r.expectedCashCents)}</div></div>
        ${canEditOpening ? html`<button class="row row-btn" data-c="opening"><div class="grow">Efectivo inicial<div class="sub">Tocá para cargarlo o corregirlo</div></div><div class="amount">${money(r.openingCashCents ?? 0)} ${icons.edit}</div></button>` : ''}
        ${r.refundsCents ? html`<div class="row"><div class="grow">Devoluciones de turnos anteriores<div class="sub">Pagos anulados en este turno</div></div><div class="amount">− ${money(r.refundsCents)}</div></div>` : ''}
        <div class="row"><div class="grow">Consumo cargado en el turno<div class="sub">Incluye lo que todavía no se cobró</div></div><div class="amount">${money(r.consumedCents)}</div></div>
        ${r.otros ? html`<div class="row"><div class="grow">Otros consumos vendidos</div><div class="amount">${r.otros}</div></div>` : ''}
        <div class="row"><div class="grow">Cuentas abiertas / cerradas en el turno</div><div class="amount">${r.accountsOpened} / ${r.accountsClosed}</div></div>
      </div>
    </section>`;
}

export function mount(root) {
  let data = null;
  let shifts = [];
  let hasMore = false;
  let err = null;
  let seq = 0;

  root.innerHTML = html`${appbar({ title: 'Caja del turno' })}
    <main class="view" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>
    <div id="dock"></div>`.s;
  const content = $('#content', root);

  async function load() {
    const my = ++seq;
    try {
      const [cur, list] = await Promise.all([api.get('/shifts/current'), api.get('/shifts')]);
      if (my !== seq) return; // respuesta vieja
      data = cur; shifts = list.shifts; hasMore = list.hasMore; err = null;
    } catch (e) {
      if (my !== seq) return;
      err = e.message;
    }
    render();
  }

  async function loadMore(btn) {
    const last = shifts[shifts.length - 1];
    btn.setAttribute('aria-busy', 'true');
    try {
      const r = await api.get(`/shifts?before=${last.openedAt}`);
      shifts = shifts.concat(r.shifts);
      hasMore = r.hasMore;
      render();
    } catch (e) {
      toast(e.message, { type: 'error' });
      btn.removeAttribute('aria-busy');
    }
  }

  // El empleado puede cargar el efectivo inicial una vez si el turno se abrió solo; la administradora siempre.
  const canEditOpening = (shift) => shift && (isAdmin() || (shift.autoOpened && shift.openingCashCents === 0));

  function render() {
    if (!data) {
      content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudo cargar la caja</p><p>${err ?? ''}</p>
        <p style="margin-top:12px"><button class="btn" data-c="reload">${icons.refresh} Reintentar</button></p></div>`.s;
      return;
    }
    const { shift, report } = data;
    const past = shifts.filter((x) => !x.isOpen);
    content.innerHTML = html`
      ${shift ? html`
        <p class="muted small" style="margin:0 4px 10px">Turno abierto ${when(shift.openedAt)} por ${shift.openedByName} · hace ${duration(shift.openedAt)}${shift.autoOpened ? ' · abierto automáticamente' : ''}</p>
        ${shift.autoOpened && shift.openingCashCents === 0 ? html`<div class="banner warn">${icons.cash}<div class="grow">Este turno se abrió solo. Si había efectivo en la caja, cargalo para que cuadre el efectivo esperado.</div>
          <button class="btn" data-c="opening">Cargar</button></div>` : ''}
        ${reportBlocks(report, { live: true, canEditOpening: canEditOpening(shift) })}`
      : html`<section class="card" style="padding:18px;margin-bottom:12px">
          <p class="big" style="font-weight:700;font-size:1.1rem;margin-bottom:6px">No hay un turno abierto</p>
          <p class="muted">Abrí el turno al empezar a atender. Si te olvidás, se abre solo con la primera carga, cobro o cierre de cuenta.</p>
          ${data.openAccounts.count ? html`<p class="form-warn" style="margin:12px 0 0">Hay ${plural(data.openAccounts.count, 'cuenta abierta', 'cuentas abiertas')} del turno anterior con ${money(data.openAccounts.pendingCents)} pendiente. Siguen disponibles.</p>` : ''}
        </section>`}
      <h2 class="section-title">Turnos anteriores</h2>
      ${past.length ? html`<div class="card"><div class="rows">${past.map((x) => html`
        <a class="row row-btn" href="#/caja/turno/${x.id}" style="text-decoration:none">
          <div class="grow"><div class="title">${range(x.openedAt, x.closedAt)}</div><div class="sub">Abrió ${x.openedByName} · cerró ${x.closedByName}</div></div>
          <div class="amount">${money(x.collectedCents)}</div></a>`)}</div></div>
          ${hasMore ? html`<p style="margin-top:10px"><button class="btn btn-block" data-c="more">Ver turnos más viejos</button></p>` : ''}`
        : html`<p class="muted" style="margin:0 4px">Todavía no hay turnos cerrados.</p>`}`.s;

    $('#dock', root).innerHTML = html`<div class="dock"><div class="dock-inner">
      ${shift ? html`<button class="btn btn-lg btn-block" data-c="close">${icons.lock} Cerrar turno</button>`
        : html`<button class="btn btn-primary btn-lg btn-block" data-c="open">${icons.plus} Abrir turno</button>`}
    </div></div>`.s;
  }

  /** Panel con un importe (abrir turno o corregir el efectivo inicial). */
  function cashSheet({ title, label, hint, initial = '', confirm, send }) {
    const s = openSheet({ title });
    s.setBody(html`<form autocomplete="off">
      <div class="form-error" hidden></div>
      <label class="field"><span>${label}</span>
        <div class="input-wrap"><span class="prefix">$</span><input class="input input-money" name="cash" inputmode="decimal" placeholder="0" enterkeyhint="done" value="${initial}" autofocus></div></label>
      <p class="hint">${hint}</p>
      <button type="submit" hidden></button></form>`);
    s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-ok>${confirm}</button>`);
    const form = $('form', s.body);
    moneyField(form.cash);
    const errEl = $('.form-error', s.body);
    const btn = $('[data-ok]', s.foot);
    const submit = async () => {
      if (btn.hasAttribute('aria-busy')) return;
      const cents = form.cash.value.trim() ? parseMoney(form.cash.value) : 0;
      if (cents === null) { errEl.textContent = 'Revisá el importe.'; errEl.hidden = false; return; }
      btn.setAttribute('aria-busy', 'true');
      try {
        await send(cents);
        await s.close();
        load();
      } catch (e) {
        errEl.textContent = e.message; errEl.hidden = false;
        if (e.code === 'shift_open' || e.code === 'shift_closed') load();
      } finally { btn.removeAttribute('aria-busy'); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    btn.addEventListener('click', submit);
  }

  function openShift() {
    let key = api.newRequestId();
    let lastCents = null;
    cashSheet({
      title: 'Abrir turno',
      label: 'Efectivo inicial en caja (opcional)',
      hint: 'Sirve para calcular cuánto efectivo debería haber al cerrar.',
      confirm: 'Abrir turno',
      send: async (cents) => {
        if (lastCents !== null && lastCents !== cents) key = api.newRequestId();
        lastCents = cents;
        await api.post('/shifts', { requestId: key, openingCashCents: cents });
        toast('Turno abierto');
      },
    });
  }

  function editOpening() {
    const { shift } = data;
    cashSheet({
      title: 'Efectivo inicial',
      label: 'Efectivo que había en la caja al empezar',
      hint: isAdmin() ? 'El cambio queda registrado en la actividad.' : 'Lo podés cargar una sola vez; después solo lo corrige la administradora.',
      initial: shift.openingCashCents ? moneyInput(shift.openingCashCents) : '',
      confirm: 'Guardar',
      send: async (cents) => {
        await api.patch(`/shifts/${shift.id}`, { openingCashCents: cents });
        toast(`Efectivo inicial: ${money(cents)}`);
      },
    });
  }

  async function closeShift() {
    const requestId = api.newRequestId();
    const s = openSheet({ title: 'Cerrar turno', sub: `Desde ${when(data.shift.openedAt)}` });
    s.setBody(html`<div class="empty" style="padding:20px 0"><div class="spinner" style="margin:auto"></div><p style="margin-top:10px">Actualizando cifras…</p></div>`);
    s.setFoot(html`<div class="row2"><button class="btn" data-close>Cancelar</button>
      <button class="btn btn-primary" data-ok disabled>Cerrar turno</button></div>`);
    let shown = null; // cifras que el usuario está viendo y va a confirmar

    const show = (shift, report, warning = '') => {
      shown = { shift, report };
      const open = report.openAccounts;
      s.setBody(html`
        <div class="form-error" hidden></div>
        ${warning ? html`<div class="form-warn">${warning}</div>` : ''}
        ${open.count ? html`<div class="form-warn"><strong>Quedan ${plural(open.count, 'cuenta abierta', 'cuentas abiertas')} con ${money(open.pendingCents)} pendiente.</strong><br>
          No se borran ni se marcan como pagadas: siguen disponibles para el turno siguiente.</div>` : ''}
        <div class="pay-summary">
          <div class="line strong"><span>Cobrado</span><span>${money(report.collectedCents)}</span></div>
          <div class="line"><span>Efectivo</span><span>${money(report.cashCents)}</span></div>
          <div class="line"><span>Transferencia</span><span>${money(report.transferCents)}</span></div>
          ${report.refundsCents ? html`<div class="line"><span>Devoluciones</span><span>− ${money(report.refundsCents)}</span></div>` : ''}
          <div class="line"><span>Efectivo esperado en caja</span><strong>${money(report.expectedCashCents)}</strong></div>
          <div class="line"><span>Fichas / bebidas</span><span>${report.fichas} / ${report.bebidas}</span></div>
        </div>
        <p class="hint" style="margin-top:12px">Estas son las cifras que quedan guardadas como oficiales del turno. Los cobros que se registren después irán al próximo turno.</p>`);
      const ok = $('[data-ok]', s.foot);
      ok.disabled = false;
      ok.textContent = open.count ? 'Cerrar igual' : 'Cerrar turno';
    };

    // Siempre confirmar sobre cifras recién traídas del servidor.
    try {
      const cur = await api.get('/shifts/current');
      if (s.closed) return;
      if (!cur.shift) { await s.close(); toast('El turno ya estaba cerrado'); load(); return; }
      show(cur.shift, cur.report);
    } catch (e) {
      if (!s.closed) s.setBody(html`<div class="form-error">${e.message}</div>`);
      return;
    }

    $('[data-ok]', s.foot).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.hasAttribute('aria-busy') || !shown) return;
      btn.setAttribute('aria-busy', 'true');
      const errEl = $('.form-error', s.body);
      try {
        await api.post(`/shifts/${shown.shift.id}/close`, {
          requestId,
          acknowledgeOpenAccounts: true,
          expected: { collectedCents: shown.report.collectedCents, openAccounts: shown.report.openAccounts.count },
        });
        await s.close();
        const n = shown.report.openAccounts.count;
        toast(n ? `Turno cerrado. ${plural(n, 'cuenta sigue abierta', 'cuentas siguen abiertas')}.` : 'Turno cerrado');
        load();
      } catch (e2) {
        if (e2.code === 'shift_changed' && e2.data?.report) {
          show(e2.data.shift, e2.data.report, 'Hubo movimientos mientras confirmabas. Estas son las cifras actualizadas: revisalas y confirmá de nuevo.');
        } else if (errEl) {
          errEl.textContent = e2.retryable ? `No se confirmó. ${e2.message} Tocá de nuevo: no se duplica.` : e2.message;
          errEl.hidden = false;
        }
      } finally { btn.removeAttribute('aria-busy'); }
    });
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-c]');
    const c = t?.dataset.c;
    if (c === 'reload') load();
    if (c === 'open') openShift();
    if (c === 'close' && data?.shift) closeShift();
    if (c === 'opening' && data?.shift) editOpening();
    if (c === 'more') loadMore(t);
  });

  load();
  return poll(load, 15000);
}
