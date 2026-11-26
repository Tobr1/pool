// Utilidades de interfaz: avisos, paneles inferiores, estados de carga y teclado.
import { html, raw } from './html.js';
import { icons } from './icons.js';

export { html, raw };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function setBusy(el, busy, label) {
  if (!el) return;
  if (busy) {
    el.setAttribute('aria-busy', 'true');
    if (label) { el.dataset.label = el.innerHTML; el.textContent = label; }
  } else {
    el.removeAttribute('aria-busy');
    if (el.dataset.label) { el.innerHTML = el.dataset.label; delete el.dataset.label; }
  }
}

// ---------- Avisos (toasts) ----------

export function toast(message, { type = 'ok', action, onAction, actions = [], duration = 4000 } = {}) {
  const acts = action ? [{ label: action, onAction }, ...actions] : actions;
  const box = document.getElementById('toasts');
  while (box.children.length >= 2) box.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = html`<div class="t-main">${type === 'error' ? icons.alert : icons.check}
      <div class="msg">${message}</div>
      <button class="icon-btn" data-act="close" aria-label="Cerrar aviso">${icons.close}</button></div>
    ${acts.length ? html`<div class="t-actions">${acts.map((a, i) => html`<button class="btn ${i === 0 ? 'btn-ghost' : ''}" data-act="action" data-i="${i}">${a.label}</button>`)}</div>` : ''}`.s;
  let timer;
  const dismiss = () => { clearTimeout(timer); el.remove(); };
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') dismiss();
    if (act === 'action') { dismiss(); acts[Number(e.target.closest('[data-act]').dataset.i)]?.onAction?.(); }
  });
  box.appendChild(el);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return { dismiss };
}

/**
 * Ejecuta una operación contra el servidor mostrando el estado.
 * `exec` debe reutilizar siempre el mismo requestId para que "Reintentar" no duplique.
 */
export async function runOp({ button, exec, onSuccess, failMsg = 'No se pudo guardar' }) {
  setBusy(button, true);
  try {
    const data = await exec();
    await onSuccess?.(data);
    return data;
  } catch (e) {
    if (e?.retryable) {
      toast(`${failMsg}. ${e.message} Tocá Reintentar: no se duplica.`, {
        type: 'error', duration: 0, action: 'Reintentar',
        onAction: () => runOp({ button, exec, onSuccess, failMsg }),
      });
    } else {
      toast(e?.message || String(e), { type: 'error', duration: 7000 });
    }
    return null;
  } finally {
    setBusy(button, false);
  }
}

// ---------- Paneles inferiores (bottom sheets) ----------

const stack = [];
let ignorePops = 0;
let popResolvers = [];

window.addEventListener('popstate', () => {
  if (ignorePops > 0) {
    ignorePops--;
    const r = popResolvers.shift();
    r?.();
    return;
  }
  const top = stack[stack.length - 1];
  if (top) top.close({ fromPop: true });
});

let sheetSeq = 0;

/**
 * Abre un panel inferior. Devuelve { el, body, foot, close, setTitle }.
 * El botón "atrás" del celular lo cierra.
 */
export function openSheet({ title, sub = '', tall = false, onClose, closeLabel = 'Cerrar' } = {}) {
  const id = `sheet-${++sheetSeq}`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html`<div class="sheet-backdrop" data-close></div>
    <div class="sheet ${tall ? 'tall' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}-t">
      <div class="sheet-head">
        <h2 id="${id}-t"><span class="t">${title}</span><span class="sub">${sub}</span></h2>
        <button type="button" class="icon-btn" data-close aria-label="${closeLabel}">${icons.close}</button>
      </div>
      <div class="sheet-body"></div>
      <div class="sheet-foot" hidden></div>
    </div>`.s;
  document.getElementById('sheet-root').appendChild(wrap);
  const el = wrap.querySelector('.sheet');
  const prevFocus = document.activeElement;
  const entry = { closed: false };

  const close = ({ fromPop = false } = {}) => {
    if (entry.closed) return Promise.resolve();
    entry.closed = true;
    wrap.remove();
    stack.splice(stack.indexOf(entry), 1);
    document.body.classList.toggle('sheet-open', stack.length > 0);
    onClose?.();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    if (fromPop) return Promise.resolve();
    return new Promise((resolve) => {
      ignorePops++;
      popResolvers.push(resolve);
      history.back();
      setTimeout(resolve, 400); // por si el navegador no emite popstate
    });
  };
  entry.close = close;
  stack.push(entry);
  history.pushState({ sheet: id }, '');
  document.body.classList.add('sheet-open');

  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { close(); return; }
    // Un enlace dentro del panel: primero cerrar el panel (quita su entrada del historial) y después navegar.
    const link = e.target.closest('a[href^="#"]');
    if (link) {
      e.preventDefault();
      const href = link.getAttribute('href');
      close().then(() => { location.hash = href; });
    }
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  el.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea, select')) {
      setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    }
  });

  const body = el.querySelector('.sheet-body');
  const foot = el.querySelector('.sheet-foot');
  setTimeout(() => {
    const first = el.querySelector('[autofocus]') || el.querySelector('.sheet-head .icon-btn');
    first?.focus({ preventScroll: true });
  }, 30);

  return {
    el, body, foot, close,
    setBody(content) { body.innerHTML = String(content); },
    setFoot(content) { foot.innerHTML = String(content); foot.hidden = !content; },
    setTitle(t, s = '') { el.querySelector('.sheet-head .t').textContent = t; el.querySelector('.sheet-head .sub').textContent = s; },
    get closed() { return entry.closed; },
  };
}

export function closeAllSheets() {
  // Cierre silencioso (se usa al cambiar de pantalla).
  while (stack.length) {
    const top = stack[stack.length - 1];
    top.close({ fromPop: true });
  }
}

/** Confirmación simple. Devuelve true/false. */
export function confirmSheet({ title, message, confirmLabel = 'Confirmar', danger = false, cancelLabel = 'Cancelar' }) {
  return new Promise((resolve) => {
    let decided = false;
    const s = openSheet({ title, onClose: () => { if (!decided) resolve(false); } });
    s.setBody(html`<div>${message}</div>`);
    s.setFoot(html`<div class="row2">
      <button class="btn" data-close>${cancelLabel}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok autofocus>${confirmLabel}</button></div>`);
    s.foot.querySelector('[data-ok]').addEventListener('click', () => { decided = true; resolve(true); s.close(); });
  });
}

// ---------- Teclado y área visible ----------

let maxInnerH = window.innerHeight;
function updateViewport() {
  const vv = window.visualViewport;
  const rootStyle = document.documentElement.style;
  if (window.innerHeight > maxInnerH) maxInnerH = window.innerHeight;
  const vvh = vv ? vv.height : window.innerHeight;
  const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  rootStyle.setProperty('--vvh', `${Math.round(vvh)}px`);
  rootStyle.setProperty('--kb', `${kb}px`);
  const typing = document.activeElement?.matches?.('input:not([type=checkbox]):not([type=radio]), textarea');
  const kbOpen = kb > 80 || (typing && window.innerHeight < maxInnerH - 120);
  document.body.classList.toggle('kb-open', !!kbOpen);
}
window.visualViewport?.addEventListener('resize', updateViewport);
window.visualViewport?.addEventListener('scroll', updateViewport);
window.addEventListener('resize', updateViewport);
window.addEventListener('orientationchange', () => { maxInnerH = 0; setTimeout(updateViewport, 300); });
document.addEventListener('focusin', () => setTimeout(updateViewport, 350));
document.addEventListener('focusout', () => setTimeout(updateViewport, 350));
updateViewport();

/** Vincula un campo de importe para que acepte solo dígitos, punto y coma. */
export function moneyField(input, onChange) {
  input.addEventListener('input', () => {
    const cleaned = input.value.replace(/[^\d.,]/g, '');
    if (cleaned !== input.value) input.value = cleaned;
    onChange?.();
  });
  input.addEventListener('focus', () => setTimeout(() => input.select(), 0));
}
