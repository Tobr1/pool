// Productos y precios (solo administradora).
import * as api from '../api.js';
import { html, openSheet, toast, moneyField, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, moneyInput, parseMoney, CATEGORY_LABEL, CATEGORY_ONE } from '../format.js';
import { appbar, store } from '../store.js';

export function mount(root) {
  let products = null;

  root.innerHTML = html`${appbar({ title: 'Productos y precios', back: '#/' })}
    <main class="view no-nav" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>
    <div class="dock no-nav"><div class="dock-inner"><button class="btn btn-primary btn-lg btn-block" id="newp">${icons.plus} Nuevo producto</button></div></div>`.s;
  const content = $('#content', root);

  async function load() {
    try {
      products = (await api.get('/products?all=1')).products;
      render();
    } catch (e) {
      content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudieron cargar los productos</p><p>${e.message}</p></div>`.s;
    }
  }

  function render() {
    const groups = ['ficha', 'bebida', 'otro'].map((c) => [c, products.filter((p) => p.category === c)]);
    content.innerHTML = html`<p class="hint" style="margin:0 4px 6px">Cambiar un precio solo afecta lo que se cargue de ahora en adelante. Los consumos ya cargados conservan su precio.</p>
      ${groups.map(([c, list]) => html`<h2 class="section-title">${CATEGORY_LABEL[c]}</h2>
        ${list.length ? html`<div class="card"><div class="rows">${list.map((p) => html`
          <button class="row row-btn" data-p="${p.id}">
            <div class="grow"><div class="title">${p.favorite ? html`<span class="star" aria-label="Favorito">★</span> ` : ''}${p.name}</div>
              <div class="sub">${!p.active ? 'Inactivo · no aparece al cargar' : p.isDefaultFicha ? 'Se usa en el botón “+ Ficha”' : p.favorite ? 'Favorito' : 'Activo'}</div></div>
            ${!p.active ? html`<span class="chip">Inactivo</span>` : ''}
            <div class="amount">${money(p.priceCents)}</div></button>`)}</div></div>`
          : html`<p class="muted small" style="margin:0 4px">Sin productos.</p>`}`)}`.s;
  }

  function edit(p) {
    const isNew = !p;
    let cur = p ?? { name: '', category: 'bebida', priceCents: 0, active: true, favorite: false, isDefaultFicha: false };
    let category = cur.category;
    const requestId = api.newRequestId(); // alta: un reintento no crea otro producto
    let zeroConfirmed = false;
    const s = openSheet({ title: isNew ? 'Nuevo producto' : 'Editar producto', sub: isNew ? '' : cur.name });
    s.setBody(html`<form id="pf" autocomplete="off" novalidate>
      <div class="form-error" hidden></div>
      <label class="field"><span>Nombre</span><input class="input" name="name" maxlength="40" value="${cur.name}" required ${isNew ? 'autofocus' : ''}></label>
      <div class="label" style="margin-bottom:6px">Categoría</div>
      <div class="seg" id="cats" role="group" aria-label="Categoría" style="margin-bottom:14px">
        ${['ficha', 'bebida', 'otro'].map((c) => html`<button type="button" data-c="${c}" aria-pressed="${c === category}">${CATEGORY_ONE[c]}</button>`)}
      </div>
      <label class="field"><span>Precio</span>
        <div class="input-wrap"><span class="prefix">$</span><input class="input input-money" name="price" inputmode="decimal" value="${isNew ? '' : moneyInput(cur.priceCents)}" placeholder="0" enterkeyhint="done"></div></label>
      ${!isNew ? html`<p class="hint" style="margin:-6px 0 14px">Precio actual: ${money(cur.priceCents)}. Los consumos anteriores no cambian.</p>` : ''}
      <label class="switch-row"><span>★ Favorito (aparece primero)</span><input type="checkbox" name="favorite" ${cur.favorite ? 'checked' : ''}></label>
      <label class="switch-row"><span>Activo (disponible para cargar)</span><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}></label>
      <label class="switch-row" id="deff" ${category === 'ficha' ? '' : 'hidden'}><span>Usar en el botón “+ Ficha”</span><input type="checkbox" name="isDefaultFicha" ${cur.isDefaultFicha ? 'checked' : ''}></label>
      <button type="submit" hidden></button></form>`);
    s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-ok>${isNew ? 'Crear producto' : 'Guardar cambios'}</button>`);
    const form = $('#pf', s.body);
    const errEl = $('.form-error', s.body);
    moneyField(form.price);
    $('#cats', s.body).addEventListener('click', (e) => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (!c) return;
      category = c;
      s.body.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === c)));
      $('#deff', s.body).hidden = c !== 'ficha';
    });
    const submit = async () => {
      const priceCents = parseMoney(form.price.value || '0');
      if (!form.name.value.trim()) { errEl.textContent = 'Escribí un nombre.'; errEl.hidden = false; return; }
      if (priceCents === null) { errEl.textContent = 'Revisá el precio.'; errEl.hidden = false; return; }
      if (priceCents === 0 && form.active.checked && !zeroConfirmed) {
        zeroConfirmed = true;
        errEl.textContent = 'El precio es $0: se va a cargar gratis. Si es correcto, tocá el botón de nuevo para confirmar.';
        errEl.hidden = false;
        return;
      }
      const body = {
        name: form.name.value, category, priceCents,
        favorite: form.favorite.checked, active: form.active.checked,
        isDefaultFicha: category === 'ficha' && form.isDefaultFicha.checked,
      };
      const btn = $('[data-ok]', s.foot);
      if (btn.hasAttribute('aria-busy')) return;
      btn.setAttribute('aria-busy', 'true');
      errEl.hidden = true;
      try {
        const r = isNew
          ? await api.post('/products', { ...body, requestId })
          : await api.patch(`/products/${cur.id}`, { ...body, version: cur.version });
        await s.close();
        const priceChanged = !isNew && r.product.priceCents !== cur.priceCents;
        toast(isNew ? 'Producto creado' : priceChanged ? `Precio actualizado: ${money(cur.priceCents)} → ${money(r.product.priceCents)}` : 'Producto guardado');
        store.products = null;
        load();
      } catch (e) {
        if (e.code === 'version_conflict' && e.data?.product) {
          // Otro dispositivo cambió el producto: mostrar lo actual para no pisarlo.
          cur = e.data.product;
          category = cur.category;
          form.name.value = cur.name;
          form.price.value = moneyInput(cur.priceCents);
          form.favorite.checked = cur.favorite;
          form.active.checked = cur.active;
          form.isDefaultFicha.checked = cur.isDefaultFicha;
          s.body.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === category)));
          $('#deff', s.body).hidden = category !== 'ficha';
          errEl.textContent = `${e.message} Si querés, volvé a hacer tu cambio y guardá.`;
        } else if (e.retryable) {
          errEl.textContent = isNew
            ? `No se confirmó. ${e.message} Tocá "Crear producto" de nuevo: no se duplica.`
            : `No se confirmó. ${e.message} Si al reintentar aparece un aviso de cambio, revisá los datos.`;
        } else if (e.code === 'idempotency_mismatch') {
          errEl.textContent = 'Puede que el producto ya se haya creado. Cerrá este panel y revisá la lista.';
        } else {
          errEl.textContent = e.message;
        }
        errEl.hidden = false;
      } finally { btn.removeAttribute('aria-busy'); }
    };
    form.addEventListener('input', () => { if (parseMoney(form.price.value || '0') !== 0) zeroConfirmed = false; });
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    $('[data-ok]', s.foot).addEventListener('click', submit);
  }

  content.addEventListener('click', (e) => {
    const id = e.target.closest('[data-p]')?.dataset.p;
    if (id) edit(products.find((p) => p.id === Number(id)));
  });
  $('#newp', root).addEventListener('click', () => edit(null));
  load();
}
