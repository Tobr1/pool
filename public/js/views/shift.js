// Detalle de un turno (cerrado o en curso).
import * as api from '../api.js';
import { html, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, range } from '../format.js';
import { appbar } from '../store.js';
import { reportBlocks } from './cash.js';

const FIELD_LABEL = {
  collectedCents: ['Cobrado', money],
  cashCents: ['Efectivo', money],
  transferCents: ['Transferencia', money],
  fichas: ['Fichas', String],
  bebidas: ['Bebidas', String],
  otros: ['Otros', String],
  consumedCents: ['Consumo cargado', money],
  accountsClosed: ['Cuentas cerradas', String],
};

export function mount(root, { params }) {
  const id = Number(params[0]);
  root.innerHTML = html`${appbar({ title: 'Turno', back: '#/caja' })}
    <main class="view plain" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>`.s;
  const content = $('#content', root);

  api.get(`/shifts/${id}`).then(({ shift, report }) => {
    const changes = report.changedAfterClose ?? [];
    content.innerHTML = html`
      <p class="muted small" style="margin:0 4px 10px">${range(shift.openedAt, shift.closedAt)}<br>
        Abrió ${shift.openedByName}${shift.closedByName ? ` · cerró ${shift.closedByName}` : ''}${shift.openingCashCents ? ` · efectivo inicial ${money(shift.openingCashCents)}` : ''}</p>
      ${report.official === 'snapshot' ? html`<p class="hint" style="margin:0 4px 10px">${icons.lock} Cifras oficiales guardadas al cerrar el turno.</p>` : ''}
      ${changes.length ? html`<div class="form-warn">Hubo cambios posteriores al cierre (por ejemplo, una cuenta reabierta). Las cifras oficiales no cambian; hoy el cálculo daría:
        <ul style="margin:6px 0 0;padding-left:18px">${changes.map((c) => {
          const [label, fmt] = FIELD_LABEL[c.field] ?? [c.field, String];
          return html`<li>${label}: ${fmt(c.atClose)} al cierre → ${fmt(c.now)} ahora</li>`;
        })}</ul></div>` : ''}
      ${reportBlocks(report, { live: shift.isOpen })}
      <a class="btn btn-block" href="#/historial?turno=${shift.id}">${icons.history} Ver cuentas cerradas de este turno</a>`.s;
  }).catch((e) => {
    content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudo cargar el turno</p><p>${e.message}</p></div>`.s;
  });
}
