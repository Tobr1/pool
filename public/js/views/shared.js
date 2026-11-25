// Acciones y fragmentos compartidos entre pantallas.
import * as api from '../api.js';
import { html, toast, runOp, openSheet, $ } from '../ui.js';
import { money, plural } from '../format.js';

/** Bloque de saldo: el estado se comunica con texto, no solo con color. */
export function balanceInfo(balanceCents, consumedCents) {
  if (balanceCents > 0) return { cls: 'due', label: 'Saldo pendiente', amount: money(balanceCents) };
  if (balanceCents < 0) return { cls: 'credit', label: 'Cobrado de más', amount: money(-balanceCents) };
  if (consumedCents > 0) return { cls: 'paid', label: '✓ Pagado', amount: money(0) };
  return { cls: 'paid', label: 'Sin consumos', amount: money(0) };
}

/** Texto corto de cantidades: '3 fichas · 2 bebidas · 1 otro'. */
export function countsText(a) {
  const parts = [plural(a.fichas, 'ficha', 'fichas')];
  if (a.bebidas) parts.push(plural(a.bebidas, 'bebida', 'bebidas'));
  if (a.otros) parts.push(plural(a.otros, 'otro', 'otros'));
  return parts.join(' · ');
}

/** "+ Ficha" con un toque. Confirma solo cuando el servidor respondió. */
export function addFicha(account, { button, onSaved, onCharge }) {
  const requestId = api.newRequestId(); // mismo id en cada reintento
  return runOp({
    button,
    failMsg: 'No se pudo agregar la ficha',
    exec: () => api.post(`/accounts/${account.id}/ficha`, { requestId }),
    onSuccess: (r) => {
      onSaved?.(r.detail);
      const it = r.detail.items.find((i) => i.id === r.itemIds[0]);
      toast(`+1 ficha${it ? ` (${money(it.unitPriceCents)})` : ''} · ${r.detail.account.name} · ${plural(r.detail.totals.fichas, 'ficha', 'fichas')} en total`, {
        action: 'Deshacer',
        duration: 8000,
        onAction: () => undoItems(r.itemIds, { onSaved }),
        actions: onCharge && it ? [{ label: 'Cobrar', onAction: () => onCharge(it.unitPriceCents) }] : [],
      });
    },
  });
}

/** Deshace una carga accidental anulándola (queda registrada). */
export async function undoItems(itemIds, { onSaved }) {
  const ids = [...itemIds];
  const keys = ids.map(() => api.newRequestId());
  return runOp({
    failMsg: 'No se pudo deshacer',
    exec: async () => {
      let last = null;
      for (let i = 0; i < ids.length; i++) {
        try {
          last = await api.post(`/items/${ids[i]}/void`, { requestId: keys[i], reason: 'Carga accidental (deshacer)' });
        } catch (e) {
          if (e.code !== 'already_voided') throw e;
        }
      }
      return last;
    },
    onSuccess: (r) => {
      if (r) onSaved?.(r.detail);
      toast('Carga deshecha');
    },
  });
}

const QUICK_REASONS = ['Cargado por error', 'Cantidad equivocada', 'Producto equivocado', 'Cuenta equivocada', 'Devuelto'];

/** Panel para anular un consumo o un pago con motivo obligatorio. */
export function openVoidSheet({ title, description, confirmLabel, path, onSaved, reasons = QUICK_REASONS }) {
  const s = openSheet({ title });
  let requestId = api.newRequestId();
  s.setBody(html`
    <div class="form-error" hidden></div>
    <div style="margin-bottom:14px">${description}</div>
    <p class="hint" style="margin-bottom:12px">No se borra: queda registrado como anulado, con tu nombre, la hora y el motivo.</p>
    <label class="field"><span>Motivo (obligatorio)</span>
      <input class="input" name="reason" maxlength="200" autocomplete="off" enterkeyhint="done" placeholder="Ej.: cargado por error" autofocus></label>
    <div class="quick-amounts">${reasons.map((r) => html`<button type="button" data-reason="${r}">${r}</button>`)}</div>`);
  s.setFoot(html`<div class="row2"><button class="btn" data-close>Volver</button>
    <button class="btn btn-danger" data-ok>${confirmLabel}</button></div>`);
  const input = $('input', s.body);
  const err = $('.form-error', s.body);
  input.addEventListener('input', () => { requestId = api.newRequestId(); });
  s.body.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reason]')?.dataset.reason;
    if (r) { input.value = r; requestId = api.newRequestId(); }
  });
  const submit = async () => {
    const reason = input.value.trim();
    if (reason.length < 3) { err.textContent = 'Escribí o elegí un motivo.'; err.hidden = false; input.focus(); return; }
    err.hidden = true;
    const btn = $('[data-ok]', s.foot);
    btn.setAttribute('aria-busy', 'true');
    try {
      const r = await api.post(path, { requestId, reason });
      await s.close();
      onSaved?.(r.detail);
      toast('Anulación registrada');
    } catch (e) {
      err.textContent = e.retryable ? `${e.message}` : e.message;
      err.hidden = false;
      if (e.data?.detail) onSaved?.(e.data.detail);
    } finally { btn.removeAttribute('aria-busy'); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  $('[data-ok]', s.foot).addEventListener('click', submit);
}
