// Panel "Agregar bebida": favoritas primero, búsqueda, cantidades y subtotal.
import * as api from '../api.js';
import { html, openSheet, toast, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, norm, CATEGORY_LABEL } from '../format.js';
import { store, loadProducts } from '../store.js';
import { undoItems } from './shared.js';

export function openCatalog(account, { onSaved }) {
  const s = openSheet({ title: 'Agregar consumo', sub: account.name, tall: true });
  const qty = new Map(); // productId -> cantidad
  let products = store.products;
  let filter = null;
  let query = '';
  let requestId = api.newRequestId();
  let loadErr = null;

  s.setBody(html`
    <div class="search" role="search" style="margin-bottom:10px">${icons.search}
      <input class="input" id="cq" type="search" placeholder="Buscar producto" autocomplete="off" enterkeyhint="search" aria-label="Buscar producto"></div>
    <div class="cat-chips" id="chips" role="group" aria-label="Categorías"></div>
    <div id="plist"></div>`);
  s.setFoot(html`<div class="form-error" id="cerr" hidden></div>
    <button class="btn btn-primary btn-lg btn-block" id="cadd" disabled>Elegí productos</button>`);

  const plist = $('#plist', s.body);
  const chips = $('#chips', s.body);
  const addBtn = $('#cadd', s.foot);
  const errEl = $('#cerr', s.foot);

  const hasFav = () => products?.some((p) => p.favorite && p.category !== 'ficha');

  function visible() {
    if (!products) return [];
    if (query) return products.filter((p) => norm(p.name).includes(query));
    if (filter === 'fav') return products.filter((p) => p.favorite && p.category !== 'ficha');
    if (filter === 'all') return products;
    return products.filter((p) => p.category === filter);
  }

  function renderChips() {
    const opts = [];
    if (hasFav()) opts.push(['fav', '★ Favoritas']);
    for (const c of ['bebida', 'otro', 'ficha']) if (products?.some((p) => p.category === c)) opts.push([c, CATEGORY_LABEL[c]]);
    opts.push(['all', 'Todo']);
    if (!filter || !opts.some(([k]) => k === filter)) filter = opts[0][0];
    chips.innerHTML = opts.map(([k, l]) => html`<button type="button" data-cat="${k}" aria-pressed="${!query && filter === k}">${l}</button>`).join('');
  }

  function renderList() {
    if (!products) {
      plist.innerHTML = loadErr
        ? html`<div class="empty"><p class="big">No se pudo cargar el catálogo</p><p>${loadErr}</p>
            <p style="margin-top:12px"><button class="btn" data-reload>${icons.refresh} Reintentar</button></p></div>`.s
        : '<div class="empty"><div class="spinner" style="margin:auto"></div></div>';
      return;
    }
    const list = visible();
    if (!list.length) {
      plist.innerHTML = html`<div class="empty"><p>${query ? 'No hay productos con ese nombre.' : 'No hay productos en esta categoría.'}</p></div>`.s;
      return;
    }
    plist.innerHTML = list.map((p) => {
      const q = qty.get(p.id) ?? 0;
      return html`<div class="prod ${q ? 'selected' : ''}">
        <button type="button" class="grow" data-inc="${p.id}" style="background:none;border:0;text-align:left;padding:6px 0;min-height:48px">
          <div class="name">${p.favorite ? html`<span class="star" aria-label="Favorito">★</span> ` : ''}${p.name}</div>
          <div class="price">${money(p.priceCents)}${q ? html` · <strong>${money(p.priceCents * q)}</strong>` : ''}</div>
        </button>
        <div class="stepper">
          <button type="button" data-dec="${p.id}" aria-label="Quitar uno de ${p.name}" ${q ? '' : 'disabled'}>−</button>
          <span class="q" aria-live="polite" aria-label="Cantidad de ${p.name}">${q}</span>
          <button type="button" class="plus" data-inc="${p.id}" aria-label="Sumar uno de ${p.name}">+</button>
        </div></div>`.s;
    }).join('');
  }

  function renderFoot() {
    let units = 0; let total = 0;
    for (const [id, q] of qty) {
      const p = products?.find((x) => x.id === id);
      if (p) { units += q; total += p.priceCents * q; }
    }
    addBtn.disabled = units === 0;
    addBtn.innerHTML = units ? html`${icons.check} Agregar ${units} ${units === 1 ? 'producto' : 'productos'} · ${money(total)}`.s : 'Elegí productos';
  }

  function change(id, delta) {
    const q = Math.max(0, Math.min(99, (qty.get(id) ?? 0) + delta));
    if (q) qty.set(id, q); else qty.delete(id);
    requestId = api.newRequestId(); // la selección cambió: es otra operación
    errEl.hidden = true;
    renderList(); renderFoot();
  }

  s.body.addEventListener('click', (e) => {
    const inc = e.target.closest('[data-inc]');
    const dec = e.target.closest('[data-dec]');
    const cat = e.target.closest('[data-cat]');
    if (inc) change(Number(inc.dataset.inc), +1);
    else if (dec) change(Number(dec.dataset.dec), -1);
    else if (cat) {
      filter = cat.dataset.cat;
      query = ''; $('#cq', s.body).value = '';
      renderChips(); renderList();
    } else if (e.target.closest('[data-reload]')) refresh();
  });
  $('#cq', s.body).addEventListener('input', (e) => { query = norm(e.target.value); renderChips(); renderList(); });

  addBtn.addEventListener('click', async () => {
    const lines = [...qty].map(([productId, quantity]) => ({ productId, quantity }));
    if (!lines.length) return;
    addBtn.setAttribute('aria-busy', 'true');
    errEl.hidden = true;
    try {
      const r = await api.post(`/accounts/${account.id}/items`, { requestId, lines });
      const names = lines.map((l) => `${l.quantity} ${products.find((p) => p.id === l.productId)?.name ?? ''}`).join(', ');
      await s.close();
      onSaved?.(r.detail);
      toast(`Agregado: ${names}`, { action: 'Deshacer', duration: 8000, onAction: () => undoItems(r.itemIds, { onSaved }) });
    } catch (e) {
      errEl.textContent = e.retryable ? `No se guardó. ${e.message}` : e.message;
      errEl.hidden = false;
      if (e.code === 'product_inactive') refresh();
    } finally {
      addBtn.removeAttribute('aria-busy');
    }
  });

  async function refresh() {
    try {
      products = await loadProducts();
      loadErr = null;
      for (const id of [...qty.keys()]) if (!products.some((p) => p.id === id)) qty.delete(id);
    } catch (e) {
      loadErr = e.message;
    }
    if (!s.closed) { renderChips(); renderList(); renderFoot(); }
  }

  if (products) { renderChips(); renderList(); }
  else renderList();
  refresh(); // siempre trae precios vigentes
}
