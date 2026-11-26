// Estado compartido mínimo (la fuente de verdad es siempre el servidor).
import * as api from './api.js';
import { html } from './html.js';
import { icons } from './icons.js';

export const store = {
  user: null,
  demo: false,
  settings: { businessName: 'Pool' },
  ficha: null,
  products: null,
};

export const isAdmin = () => store.user?.role === 'admin';

export async function loadProducts() {
  const r = await api.get('/products');
  store.products = r.products;
  store.ficha = r.products.find((p) => p.category === 'ficha' && p.isDefaultFicha) ?? r.products.find((p) => p.category === 'ficha') ?? null;
  return r.products;
}

/** Vuelve a la pantalla anterior de la app; si no hay, reemplaza la actual por `fallback`. */
export function goBack(fallback = '#/') {
  if ((history.state?.idx ?? 1) > 1) history.back();
  else location.replace(fallback);
}

/** Barra superior. `back`: hash al que vuelve; `right`: acciones extra. */
export function appbar({ title, sub = '', back = null, right = '', menu = true }) {
  return html`<header class="appbar">
    ${back ? html`<button class="icon-btn" data-back="${back}" aria-label="Volver">${icons.back}</button>` : ''}
    <h1>${title}${sub ? html`<span class="sub">${sub}</span>` : ''}</h1>
    ${right}
    ${menu ? html`<button class="icon-btn" data-global="menu" aria-label="Menú">${icons.menu}</button>` : ''}
  </header>`;
}

/** Ejecuta fn cada `ms` mientras la pestaña esté visible. Devuelve la función para detener. */
export function poll(fn, ms) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running || document.visibilityState !== 'visible') return;
    running = true;
    try { await fn(); } catch { /* el aviso de conexión ya lo muestra */ } finally { running = false; }
  };
  const id = setInterval(tick, ms);
  const onVis = () => { if (document.visibilityState === 'visible') tick(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { stopped = true; clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
}
