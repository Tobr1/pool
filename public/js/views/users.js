// Usuarios (solo administradora).
import * as api from '../api.js';
import { html, openSheet, toast, $ } from '../ui.js';
import { icons } from '../icons.js';
import { appbar, store } from '../store.js';

const ROLE = { admin: 'Administradora', employee: 'Empleado' };

export function mount(root) {
  let users = null;
  root.innerHTML = html`${appbar({ title: 'Usuarios', back: '#/' })}
    <main class="view no-nav" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>
    <div class="dock no-nav"><div class="dock-inner"><button class="btn btn-primary btn-lg btn-block" id="newu">${icons.plus} Nuevo usuario</button></div></div>`.s;
  const content = $('#content', root);

  async function load() {
    try {
      users = (await api.get('/users')).users;
      content.innerHTML = html`<p class="hint" style="margin:0 4px 10px">Empleado: abre cuentas, carga consumos y cobra. Administradora: además gestiona usuarios, precios y correcciones de pagos.</p>
        <div class="card"><div class="rows">${users.map((u) => html`
        <button class="row row-btn" data-u="${u.id}">
          <div class="avatar" aria-hidden="true">${u.displayName.charAt(0).toUpperCase()}</div>
          <div class="grow"><div class="title">${u.displayName}${u.id === store.user.id ? ' (vos)' : ''}</div><div class="sub">${u.username} · ${ROLE[u.role]}</div></div>
          ${u.active ? '' : html`<span class="chip">Inactivo</span>`}
        </button>`)}</div></div>`.s;
    } catch (e) {
      content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudieron cargar los usuarios</p><p>${e.message}</p></div>`.s;
    }
  }

  function edit(u) {
    const isNew = !u;
    let role = u?.role ?? 'employee';
    const requestId = api.newRequestId(); // alta: un reintento no crea otro usuario
    const s = openSheet({ title: isNew ? 'Nuevo usuario' : 'Editar usuario', sub: u?.username ?? '' });
    s.setBody(html`<form id="uf" autocomplete="off" novalidate>
      <div class="form-error" hidden></div>
      <label class="field"><span>Nombre</span><input class="input" name="displayName" maxlength="40" value="${u?.displayName ?? ''}" ${isNew ? 'autofocus' : ''}></label>
      ${isNew ? html`<label class="field"><span>Usuario para ingresar</span><input class="input" name="username" maxlength="30" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="ej.: martin"></label>` : ''}
      <div class="label" style="margin-bottom:6px">Rol</div>
      <div class="seg" id="roles" role="group" aria-label="Rol" style="margin-bottom:14px">
        <button type="button" data-r="employee" aria-pressed="${role === 'employee'}">Empleado</button>
        <button type="button" data-r="admin" aria-pressed="${role === 'admin'}">Administradora</button>
      </div>
      <label class="field"><span>${isNew ? 'Contraseña' : 'Nueva contraseña (opcional)'}</span>
        <input class="input" name="password" type="password" autocomplete="new-password" minlength="6" placeholder="${isNew ? 'Mínimo 6 caracteres' : 'Dejar vacío para no cambiarla'}"></label>
      ${!isNew ? html`<label class="switch-row"><span>Activo (puede ingresar)</span><input type="checkbox" name="active" ${u.active ? 'checked' : ''}></label>` : ''}
      <button type="submit" hidden></button></form>`);
    s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-ok>${isNew ? 'Crear usuario' : 'Guardar'}</button>`);
    const form = $('#uf', s.body);
    const errEl = $('.form-error', s.body);
    $('#roles', s.body).addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (!r) return;
      role = r;
      s.body.querySelectorAll('[data-r]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === r)));
    });
    const submit = async () => {
      const body = { displayName: form.displayName.value, role };
      if (isNew) { body.username = form.username.value; body.password = form.password.value; body.requestId = requestId; }
      else {
        body.active = form.active.checked;
        if (form.password.value) body.password = form.password.value;
      }
      const btn = $('[data-ok]', s.foot);
      if (btn.hasAttribute('aria-busy')) return;
      btn.setAttribute('aria-busy', 'true');
      errEl.hidden = true;
      try {
        if (isNew) await api.post('/users', body); else await api.patch(`/users/${u.id}`, body);
        await s.close();
        toast(isNew ? 'Usuario creado' : 'Usuario actualizado');
        load();
      } catch (e) {
        errEl.textContent = e.retryable && isNew ? `No se confirmó. ${e.message} Tocá "Crear usuario" de nuevo: no se duplica.`
          : e.code === 'idempotency_mismatch' ? 'Puede que el usuario ya se haya creado. Cerrá este panel y revisá la lista.'
            : e.message;
        errEl.hidden = false;
      } finally { btn.removeAttribute('aria-busy'); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    $('[data-ok]', s.foot).addEventListener('click', submit);
  }

  content.addEventListener('click', (e) => {
    const id = e.target.closest('[data-u]')?.dataset.u;
    if (id) edit(users.find((u) => u.id === Number(id)));
  });
  $('#newu', root).addEventListener('click', () => edit(null));
  load();
}
