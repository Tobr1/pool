// Pantalla 1: cuentas abiertas (pantalla inicial).
import * as api from '../api.js';
import { html, openSheet, toast, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, when, norm, plural, duration } from '../format.js';
import { store, appbar, poll, isAdmin } from '../store.js';
import { balanceInfo, addFicha, undoItems, countsText } from './shared.js';

let lastQuery = '';

export function mount(root, { navigate }) {
  let accounts = null;
  let shift = null;
  let error = null;
  const inFlight = new Set(); // cuentas con un "+ Ficha" esperando respuesta

  root.innerHTML = html`
    ${appbar({ title: 'Cuentas abiertas', sub: store.settings.businessName })}
    <main class="view">
      <div id="shift-banner"></div>
      <div class="search" role="search">
        ${icons.search}
        <input class="input" id="q" type="search" placeholder="Buscar por nombre o mesa" autocomplete="off" enterkeyhint="search" aria-label="Buscar cuenta por nombre o mesa" value="${lastQuery}">
      </div>
      <div id="list" class="list grid-2" aria-live="polite"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div>
    </main>
    <div class="dock"><div class="dock-inner">
      <button class="btn btn-primary btn-lg btn-block" id="new-acc">${icons.plus} Nueva cuenta</button>
    </div></div>`.s;

  const listEl = $('#list', root);
  const qEl = $('#q', root);

  function render() {
    const bannerEl = $('#shift-banner', root);
    bannerEl.innerHTML = !shift && accounts ? html`<div class="banner warn">${icons.clock}
      <div class="grow">No hay turno abierto. Se abrirá solo con la primera carga, cobro o cierre de cuenta.</div>
      <a class="btn" href="#/caja">Abrir</a></div>`.s : '';
    if (accounts && (!store.ficha || store.ficha.priceCents === 0)) {
      const problem = store.ficha ? 'La ficha tiene precio $0: se cargaría gratis.' : 'No hay una ficha activa.';
      bannerEl.innerHTML += isAdmin()
        ? html`<div class="banner warn">${icons.alert}<div class="grow">${problem} Configurala antes de empezar.</div>
            <a class="btn" href="#/productos">Productos</a></div>`.s
        : html`<div class="banner warn">${icons.alert}<div class="grow">${problem} Avisale a la administradora.</div></div>`.s;
    }

    if (error && !accounts) {
      listEl.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudieron cargar las cuentas</p>
        <p>${error}</p><p style="margin-top:14px"><button class="btn" id="reload">${icons.refresh} Reintentar</button></p></div>`.s;
      return;
    }
    if (!accounts) return;
    if (accounts.length === 0) {
      listEl.innerHTML = html`<div class="empty">${icons.ball}
        <p class="big">No hay cuentas abiertas</p>
        <p>Cuando llegue alguien, tocá <strong>Nueva cuenta</strong>: alcanza con un nombre.</p></div>`.s;
      return;
    }
    const q = norm(qEl.value);
    const shown = q ? accounts.filter((a) => norm(a.name).includes(q) || norm(a.table).includes(q) || norm(`mesa ${a.table}`).includes(q)) : accounts;
    if (shown.length === 0) {
      listEl.innerHTML = html`<div class="empty"><p class="big">Sin resultados para “${qEl.value}”</p>
        <p>Probá con otro nombre o número de mesa.</p></div>`.s;
      return;
    }
    listEl.innerHTML = shown.map(card).join('');
  }

  function card(a) {
    const b = balanceInfo(a.balanceCents, a.consumedCents);
    return html`<article class="card acc-card">
      <a class="acc-main" href="#/cuenta/${a.id}">
        <div class="acc-top"><span class="acc-name">${a.name}</span>
          ${a.table ? html`<span class="chip chip-table">Mesa ${a.table}</span>` : ''}</div>
        <div class="acc-meta">
          <span>Desde ${when(a.openedAt)} · <span data-since="${a.openedAt}">${duration(a.openedAt)}</span></span>
        </div>
        <div class="acc-money">
          <div class="tot">
            <div>${countsText(a)}</div>
            <div>Total <strong class="num">${money(a.consumedCents)}</strong>${a.paidCents ? html` · Pagó <span class="num">${money(a.paidCents)}</span>` : ''}</div>
          </div>
          <div class="balance ${b.cls}"><span class="lbl">${b.label}</span><span class="amt">${b.amount}</span></div>
        </div>
      </a>
      <button class="acc-quick" data-ficha="${a.id}" aria-label="Agregar una ficha a ${a.name}" ${inFlight.has(a.id) ? 'aria-busy="true"' : ''}>${icons.plus}<span>Ficha</span></button>
    </article>`.s;
  }

  let lastJson = '';
  let seq = 0;
  async function load() {
    const my = ++seq;
    try {
      const r = await api.get('/accounts');
      if (my !== seq) return; // llegó tarde: hay un pedido más nuevo
      const json = JSON.stringify([r.accounts.map(({ lastActivity, ...x }) => x), r.shift, r.ficha]);
      if (json === lastJson && !error) { // sin cambios: solo actualizar los minutos
        listEl.querySelectorAll('[data-since]').forEach((el) => { el.textContent = duration(Number(el.dataset.since)); });
        return;
      }
      lastJson = json;
      accounts = r.accounts;
      shift = r.shift;
      store.ficha = r.ficha;
      error = null;
    } catch (e) {
      if (my !== seq) return;
      error = e.message;
    }
    render();
  }

  function applyDetail(detail) {
    if (!accounts) return;
    const i = accounts.findIndex((a) => a.id === detail.account.id);
    if (i < 0) { load(); return; }
    const a = accounts[i];
    accounts[i] = {
      ...a, ...detail.totals, version: detail.account.version,
      bebidas: detail.items.filter((x) => !x.voided && x.category === 'bebida').reduce((s, x) => s + x.quantity, 0),
      otros: detail.items.filter((x) => !x.voided && x.category === 'otro').reduce((s, x) => s + x.quantity, 0),
    };
    render();
  }

  qEl.addEventListener('input', () => { lastQuery = qEl.value; render(); });
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ficha]');
    if (btn && !btn.hasAttribute('aria-busy')) {
      const a = accounts.find((x) => x.id === Number(btn.dataset.ficha));
      inFlight.add(a.id);
      addFicha(a, { button: btn, onSaved: (d) => { applyDetail(d); load(); } }).finally(() => {
        inFlight.delete(a.id);
        listEl.querySelector(`[data-ficha="${a.id}"]`)?.removeAttribute('aria-busy');
      });
    }
    if (e.target.closest('#reload')) load();
  });
  $('#new-acc', root).addEventListener('click', () => openNewAccount({ accounts: accounts ?? [], navigate }));

  const onChanged = () => load();
  window.addEventListener('accounts-changed', onChanged);
  load();
  const stop = poll(load, 10000);
  return () => { stop(); window.removeEventListener('accounts-changed', onChanged); };
}

/** Panel "Nueva cuenta": solo nombre (obligatorio) y mesa (opcional). */
export function openNewAccount({ accounts, navigate }) {
  const s = openSheet({ title: 'Nueva cuenta' });
  let requestId = api.newRequestId();
  // Tras un envío sin confirmar se fija lo enviado (nombre, mesa y si llevaba ficha):
  // solo se puede reintentar exactamente lo mismo, que no se duplica.
  let pending = null; // { name, table, withFicha }
  const fichaPrice = store.ficha ? money(store.ficha.priceCents) : null;
  s.setBody(html`<form id="na-form" autocomplete="off">
    <div class="form-error" hidden></div>
    <label class="field"><span>Nombre o referencia</span>
      <input class="input" name="name" maxlength="40" placeholder="Ej.: Agustín, los de la gorra" enterkeyhint="next" autocapitalize="words" autofocus required></label>
    <div class="form-warn" id="dup" hidden></div>
    <label class="field"><span>Mesa <span class="muted">(opcional)</span></span>
      <input class="input" name="table" maxlength="20" placeholder="Ej.: 3" enterkeyhint="done"></label>
    <button type="submit" hidden></button>
  </form>`);
  const normalFoot = html`
    ${store.ficha ? html`<button class="btn btn-primary btn-lg btn-block" data-go="ficha">${icons.plus} Abrir y agregar ficha${fichaPrice ? ` (${fichaPrice})` : ''}</button>` : ''}
    <button class="btn ${store.ficha ? '' : 'btn-primary btn-lg'} btn-block" data-go="plain">Abrir sin consumos</button>`;
  s.setFoot(normalFoot);

  const form = $('#na-form', s.body);
  const err = $('.form-error', s.body);
  const dup = $('#dup', s.body);

  form.addEventListener('input', () => {
    if (pending) return;
    requestId = api.newRequestId();
    const n = norm(form.name.value);
    const same = n ? accounts.find((a) => norm(a.name) === n) : null;
    dup.hidden = !same;
    if (same) {
      dup.innerHTML = html`Ya hay una cuenta abierta “${same.name}”${same.table ? ` (mesa ${same.table})` : ''}.
        <a href="#/cuenta/${same.id}" style="color:inherit;font-weight:700">Ir a esa cuenta</a>`.s;
    }
  });
  form.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); form.table.focus(); } });

  function lock(body) {
    pending = body;
    form.name.readOnly = true;
    form.table.readOnly = true;
    s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-go="retry">${icons.refresh} Reintentar</button>
      <button class="btn btn-block" data-go="review">Salir y revisar las cuentas</button>`);
  }

  let sending = false;
  const submit = async (withFicha, btn) => {
    if (sending) return;
    const body = pending ?? { name: form.name.value.trim(), table: form.table.value.trim(), withFicha };
    if (!body.name) { err.textContent = 'Escribí un nombre o una referencia.'; err.hidden = false; form.name.focus(); return; }
    err.hidden = true;
    sending = true;
    const buttons = [...s.foot.querySelectorAll('button')];
    buttons.forEach((b) => { if (b !== btn) b.disabled = true; });
    btn?.setAttribute('aria-busy', 'true');
    try {
      const r = await api.post('/accounts', { requestId, ...body });
      await s.close();
      navigate(`#/cuenta/${r.accountId}`);
      if (body.withFicha && r.itemIds.length) {
        toast('Cuenta abierta con 1 ficha', {
          action: 'Deshacer ficha', duration: 8000,
          onAction: () => undoItems(r.itemIds, { onSaved: () => window.dispatchEvent(new CustomEvent('account-changed')) }),
        });
      } else {
        toast(r.replayed ? 'La cuenta ya estaba abierta' : 'Cuenta abierta');
      }
    } catch (e) {
      if (e.retryable) {
        lock(body);
        err.textContent = `No se confirmó. ${e.message} Tocá "Reintentar" (no se duplica) o salí a revisar si la cuenta ya aparece.`;
      } else if (e.code === 'idempotency_mismatch') {
        err.textContent = 'Es probable que la cuenta ya se haya creado. Revisá la lista antes de abrir otra.';
        lock(body);
      } else {
        err.textContent = e.message;
      }
      err.hidden = false;
    } finally {
      sending = false;
      s.foot.querySelectorAll('button').forEach((b) => { b.disabled = false; b.removeAttribute('aria-busy'); });
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(pending ? pending.withFicha : !!store.ficha, s.foot.querySelector('[data-go]'));
  });
  s.foot.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-go]');
    if (!btn) return;
    const go = btn.dataset.go;
    if (go === 'review') {
      await s.close();
      window.dispatchEvent(new CustomEvent('accounts-changed'));
      return;
    }
    submit(go === 'retry' ? pending.withFicha : go === 'ficha', btn);
  });
}
