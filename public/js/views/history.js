// Historial de cuentas cerradas: búsqueda por nombre, fecha y turno.
import * as api from '../api.js';
import { html, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, range, plural } from '../format.js';
import { appbar } from '../store.js';
import { countsText } from './shared.js';

const saved = { q: '', date: '', shift: '' };

export function mount(root, { query }) {
  if (query.get('turno')) { saved.shift = query.get('turno'); saved.q = ''; saved.date = ''; }
  let seq = 0;

  root.innerHTML = html`${appbar({ title: 'Historial', sub: 'Cuentas cerradas' })}
    <main class="view plain">
      <div class="search" role="search">${icons.search}
        <input class="input" id="hq" type="search" placeholder="Buscar por nombre o mesa" autocomplete="off" enterkeyhint="search" aria-label="Buscar por nombre o mesa" value="${saved.q}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <label class="field" style="margin:0"><span>Fecha</span><input class="input" id="hdate" type="date" value="${saved.date}"></label>
        <label class="field" style="margin:0"><span>Turno</span><select class="input" id="hshift"><option value="">Todos</option></select></label>
      </div>
      <div id="hlist" aria-live="polite"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div>
    </main>`.s;

  const listEl = $('#hlist', root);
  const qEl = $('#hq', root); const dateEl = $('#hdate', root); const shiftEl = $('#hshift', root);

  async function search() {
    const my = ++seq;
    const p = new URLSearchParams();
    if (saved.q.trim()) p.set('q', saved.q.trim());
    if (saved.date) p.set('date', saved.date);
    if (saved.shift) p.set('shift', saved.shift);
    try {
      const r = await api.get(`/history?${p}`);
      if (my !== seq) return;
      render(r.accounts);
    } catch (e) {
      if (my !== seq) return;
      listEl.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudo buscar</p><p>${e.message}</p></div>`.s;
    }
  }

  function render(accounts) {
    const filtered = saved.q || saved.date || saved.shift;
    if (!accounts.length) {
      listEl.innerHTML = html`<div class="empty">${icons.history}<p class="big">${filtered ? 'Sin resultados' : 'Todavía no hay cuentas cerradas'}</p>
        <p>${filtered ? 'Probá cambiar los filtros.' : 'Las cuentas que cierres van a aparecer acá.'}</p></div>`.s;
      return;
    }
    listEl.innerHTML = html`<p class="muted small" style="margin:0 4px 8px">${plural(accounts.length, 'cuenta', 'cuentas')}${accounts.length >= 60 ? ' (mostrando las 60 más recientes)' : ''}</p>
      <div class="list grid-2">${accounts.map((a) => html`<a class="card acc-main" href="#/cuenta/${a.id}">
        <div class="acc-top"><span class="acc-name">${a.name}</span>${a.table ? html`<span class="chip chip-table">Mesa ${a.table}</span>` : ''}</div>
        <div class="acc-meta">${range(a.openedAt, a.closedAt)}</div>
        <div class="acc-money"><div class="tot">${countsText(a)}</div>
          <div class="balance"><span class="lbl muted">Total</span><span class="amt">${money(a.consumedCents)}</span></div></div>
      </a>`)}</div>`.s;
  }

  let t;
  qEl.addEventListener('input', () => { saved.q = qEl.value; clearTimeout(t); t = setTimeout(search, 300); });
  dateEl.addEventListener('change', () => { saved.date = dateEl.value; search(); });
  shiftEl.addEventListener('change', () => { saved.shift = shiftEl.value; search(); });

  api.get('/shifts').then(({ shifts }) => {
    const opts = shifts.map((s) => html`<option value="${s.id}">${range(s.openedAt, s.closedAt)}</option>`);
    // Si se pidió un turno más viejo que los listados, agregarlo para que el filtro se vea.
    if (saved.shift && !shifts.some((s) => String(s.id) === String(saved.shift))) opts.push(html`<option value="${saved.shift}">Turno n.º ${saved.shift}</option>`);
    shiftEl.innerHTML = html`<option value="">Todos</option>${opts}`.s;
    shiftEl.value = saved.shift;
  }).catch(() => { /* el filtro de turno queda en "Todos" */ });

  search();
  return () => clearTimeout(t);
}
