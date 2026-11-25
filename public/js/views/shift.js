// Detalle de un turno (cerrado o en curso).
import * as api from '../api.js';
import { html, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, range } from '../format.js';
import { appbar } from '../store.js';
import { reportBlocks } from './cash.js';

export function mount(root, { params }) {
  const id = Number(params[0]);
  root.innerHTML = html`${appbar({ title: 'Turno', back: '#/caja' })}
    <main class="view plain" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>`.s;
  const content = $('#content', root);

  api.get(`/shifts/${id}`).then(({ shift, report }) => {
    const changed = report.atClose && report.atClose.collectedCents !== report.collectedCents;
    content.innerHTML = html`
      <p class="muted small" style="margin:0 4px 10px">${range(shift.openedAt, shift.closedAt)}<br>
        Abrió ${shift.openedByName}${shift.closedByName ? ` · cerró ${shift.closedByName}` : ''}${shift.openingCashCents ? ` · efectivo inicial ${money(shift.openingCashCents)}` : ''}</p>
      ${changed ? html`<div class="form-warn">Hubo correcciones de pagos después del cierre. Al cerrar se registraron ${money(report.atClose.collectedCents)} cobrados; hoy figuran ${money(report.collectedCents)}.</div>` : ''}
      ${reportBlocks(report, { live: shift.isOpen })}
      <a class="btn btn-block" href="#/historial?turno=${shift.id}">${icons.history} Ver cuentas cerradas de este turno</a>`.s;
  }).catch((e) => {
    content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudo cargar el turno</p><p>${e.message}</p></div>`.s;
  });
}
