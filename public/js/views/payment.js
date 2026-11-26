// Panel de cobro: saldo completo o parcial, efectivo, transferencia o dividido.
import * as api from '../api.js';
import { html, openSheet, toast, moneyField, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, moneyInput, parseMoney } from '../format.js';

export function openPayment(detail, { presetCents, onSaved, onCloseAccount }) {
  let d = detail;
  let balance = d.totals.balanceCents;
  let mode = 'efectivo';
  let requestId = api.newRequestId();
  const initial = presetCents && presetCents > 0 && presetCents < balance ? presetCents : balance;

  const s = openSheet({ title: 'Cobrar', sub: d.account.name });
  s.setBody(html`<form id="pay-form" autocomplete="off" novalidate>
    <div class="form-error" id="perr" hidden></div>
    <div class="form-warn" id="pwarn" hidden></div>
    <div class="pay-summary" style="margin-bottom:14px">
      <div class="line"><span>Total consumido</span><span id="p-cons">${money(d.totals.consumedCents)}</span></div>
      <div class="line"><span>Ya pagado</span><span id="p-paid">${money(d.totals.paidCents)}</span></div>
      <div class="line strong"><span>Saldo pendiente</span><span id="p-bal" style="color:var(--warn)">${money(balance)}</span></div>
    </div>
    <div class="label" style="margin-bottom:6px">Medio de pago</div>
    <div class="seg" id="modes" role="group" aria-label="Medio de pago" style="margin-bottom:14px">
      <button type="button" data-mode="efectivo" aria-pressed="true">Efectivo</button>
      <button type="button" data-mode="transferencia" aria-pressed="false">Transfer.</button>
      <button type="button" data-mode="dividir" aria-pressed="false">Dividir</button>
    </div>
    <label class="field"><span>Importe a cobrar</span>
      <div class="input-wrap"><span class="prefix">$</span>
      <input class="input input-money" id="p-amount" inputmode="decimal" enterkeyhint="done" value="${moneyInput(initial)}" aria-describedby="p-amount-hint"></div></label>
    <div class="quick-amounts" id="quick"></div>
    <div id="split" hidden>
      <label class="field"><span>De eso, en efectivo</span>
        <div class="input-wrap"><span class="prefix">$</span>
        <input class="input input-money" id="p-cash" inputmode="decimal" enterkeyhint="done" placeholder="0"></div></label>
      <p class="hint" style="margin:-6px 0 14px">El resto se registra como transferencia.</p>
    </div>
    <div class="pay-summary" id="p-sum" aria-live="polite"></div>
    <button type="submit" hidden></button>
  </form>`);
  s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" id="p-ok">Confirmar cobro</button>`);

  const amountEl = $('#p-amount', s.body);
  const cashEl = $('#p-cash', s.body);
  const errEl = $('#perr', s.body);
  const warnEl = $('#pwarn', s.body);
  const okBtn = $('#p-ok', s.foot);

  function parts() {
    const total = parseMoney(amountEl.value);
    if (total === null || total <= 0) return { error: 'Ingresá un importe válido.' };
    if (total > balance) return { error: `El importe supera el saldo pendiente (${money(balance)}).`, total };
    if (mode !== 'dividir') return { total, parts: [{ method: mode, amountCents: total }] };
    const cash = parseMoney(cashEl.value || '0');
    if (cash === null) return { error: 'Revisá el importe en efectivo.', total };
    if (cash <= 0 || cash >= total) return { error: 'Para dividir, el efectivo tiene que ser mayor a $0 y menor al total.', total };
    return { total, parts: [{ method: 'efectivo', amountCents: cash }, { method: 'transferencia', amountCents: total - cash }] };
  }

  function update({ fromInput = true } = {}) {
    if (fromInput) requestId = api.newRequestId(); // datos distintos: operación distinta
    const r = parts();
    const sum = $('#p-sum', s.body);
    $('#quick', s.body).innerHTML = html`
      <button type="button" data-q="${balance}">Saldo completo ${money(balance)}</button>
      ${presetCents && presetCents < balance ? html`<button type="button" data-q="${presetCents}">Solo la ficha ${money(presetCents)}</button>` : ''}`.s;
    if (r.error) {
      sum.innerHTML = html`<div class="line"><span style="color:#ffb3b3">${r.error}</span></div>`.s;
      okBtn.disabled = true;
      okBtn.textContent = 'Confirmar cobro';
      return;
    }
    const remaining = balance - r.total;
    sum.innerHTML = html`
      ${r.parts.map((p) => html`<div class="line"><span>${p.method === 'efectivo' ? 'Efectivo' : 'Transferencia'}</span><strong>${money(p.amountCents)}</strong></div>`)}
      <div class="line strong"><span>Cobrás</span><span>${money(r.total)}</span></div>
      <div class="line"><span>${remaining > 0 ? 'Queda pendiente (pago parcial)' : 'Queda pendiente'}</span>
        <strong style="color:${remaining > 0 ? 'var(--warn)' : 'var(--accent-strong)'}">${remaining > 0 ? money(remaining) : '✓ $0 — cuenta saldada'}</strong></div>`.s;
    okBtn.disabled = false;
    okBtn.textContent = `Confirmar cobro de ${money(r.total)}`;
  }

  function setMode(m) {
    mode = m;
    s.body.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('#split', s.body).hidden = m !== 'dividir';
    update();
    if (m === 'dividir') cashEl.focus();
  }

  moneyField(amountEl, update);
  moneyField(cashEl, update);
  s.body.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) setMode(m);
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q) { amountEl.value = moneyInput(Number(q)); update(); }
  });

  let sending = false;
  async function submit() {
    if (sending) return; // Enter/"Listo" del teclado mientras ya se está enviando
    const r = parts();
    if (r.error) { errEl.textContent = r.error; errEl.hidden = false; return; }
    errEl.hidden = true;
    sending = true;
    okBtn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post(`/accounts/${d.account.id}/payments`, { requestId, parts: r.parts, expectedBalanceCents: balance });
      onSaved?.(res.detail);
      const left = res.detail.totals.balanceCents;
      if (left === 0) {
        showSettled(res.detail, r);
      } else {
        await s.close();
        toast(`Cobro de ${money(r.total)} registrado · queda ${money(left)}`);
      }
    } catch (e) {
      if (e.code === 'balance_changed' && e.data?.detail) {
        d = e.data.detail;
        onSaved?.(d);
        balance = d.totals.balanceCents;
        $('#p-cons', s.body).textContent = money(d.totals.consumedCents);
        $('#p-paid', s.body).textContent = money(d.totals.paidCents);
        $('#p-bal', s.body).textContent = money(balance);
        warnEl.textContent = e.message;
        warnEl.hidden = false;
        if (balance > 0) amountEl.value = moneyInput(balance);
        update();
      } else {
        errEl.textContent = e.retryable ? `No se confirmó el cobro. ${e.message} Tocá "Reintentar cobro" sin cambiar nada: no se duplica.` : e.message;
        errEl.hidden = false;
        if (e.retryable) okBtn.textContent = 'Reintentar cobro';
      }
    } finally {
      sending = false;
      okBtn.removeAttribute('aria-busy');
    }
  }

  function showSettled(det, r) {
    s.setTitle('Cobro registrado', det.account.name);
    s.setBody(html`<div class="empty" style="padding:16px 0">
      <div style="color:var(--accent-strong)">${icons.check}</div>
      <p class="big">Cobraste ${money(r.total)}</p>
      <p>${r.parts.map((p) => `${p.method === 'efectivo' ? 'Efectivo' : 'Transferencia'} ${money(p.amountCents)}`).join(' + ')}</p>
      <p style="margin-top:8px"><strong>La cuenta quedó saldada.</strong> ¿La cerrás o la dejás abierta para más consumos?</p></div>`);
    s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-x="close">${icons.lock} Cerrar cuenta</button>
      <button class="btn btn-block" data-x="keep">Dejar abierta</button>`);
    s.foot.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (!x) return;
      await s.close();
      if (x === 'close') onCloseAccount?.();
    });
  }

  $('#pay-form', s.body).addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  okBtn.addEventListener('click', submit);
  update({ fromInput: false });
}
