import * as api from './api.js';
import { html, raw, toast, closeAllSheets, openSheet, runOp, $ } from './ui.js';
import { icons } from './icons.js';
import { store } from './store.js';
import * as accountsView from './views/accounts.js';
import * as accountView from './views/account.js';
import * as summaryView from './views/summary.js';
import * as cashView from './views/cash.js';
import * as shiftView from './views/shift.js';
import * as historyView from './views/history.js';
import * as productsView from './views/products.js';
import * as usersView from './views/users.js';
import * as auditView from './views/audit.js';
import { renderLogin, renderSetup } from './views/auth.js';

const app = document.getElementById('app');

const ROUTES = [
  { re: /^\/$/, view: accountsView, nav: 'cuentas' },
  { re: /^\/cuenta\/(\d+)$/, view: accountView, nav: null, cls: 'route-detail' },
  { re: /^\/cuenta\/(\d+)\/resumen$/, view: summaryView, nav: null, cls: 'route-detail' },
  { re: /^\/caja$/, view: cashView, nav: 'caja' },
  { re: /^\/caja\/turno\/(\d+)$/, view: shiftView, nav: 'caja' },
  { re: /^\/historial$/, view: historyView, nav: 'historial' },
  { re: /^\/productos$/, view: productsView, nav: null, admin: true, cls: 'route-detail' },
  { re: /^\/usuarios$/, view: usersView, nav: null, admin: true, cls: 'route-detail' },
  { re: /^\/actividad$/, view: auditView, nav: null, admin: true, cls: 'route-detail' },
];

let cleanup = null;

export function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function navBar(active) {
  const item = (key, href, icon, label) => html`<a href="${href}" ${active === key ? raw('aria-current="page"') : ''}>
    <span class="nav-ico">${icon}</span><span>${label}</span></a>`;
  return html`<nav class="bottom-nav" aria-label="Secciones">
    ${item('cuentas', '#/', icons.accounts, 'Cuentas')}
    ${item('caja', '#/caja', icons.cash, 'Caja')}
    ${item('historial', '#/historial', icons.history, 'Historial')}
  </nav>`;
}

function route() {
  closeAllSheets();
  const full = location.hash.slice(1) || '/';
  const [path, qs = ''] = full.split('?');
  let match = null; let params = [];
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) { match = r; params = m.slice(1); break; }
  }
  if (!match || (match.admin && store.user.role !== 'admin')) {
    navigate('#/', { replace: true });
    return;
  }
  try { cleanup?.(); } catch { /* vista anterior */ }
  cleanup = null;
  document.body.className = match.cls ?? '';
  app.innerHTML = html`${store.demo ? html`<div class="demo-ribbon" role="note">MODO DEMO · datos de prueba, separados de los reales</div>` : ''}
    <div id="view-root"></div>
    ${match.nav !== null ? navBar(match.nav) : ''}`.s;
  window.scrollTo(0, 0);
  const root = $('#view-root');
  cleanup = match.view.mount(root, { params, query: new URLSearchParams(qs), navigate }) ?? null;
}

// ---------- Menú secundario ----------

export function openMenu() {
  const u = store.user;
  const admin = u.role === 'admin';
  const s = openSheet({ title: 'Menú' });
  s.setBody(html`
    <div class="user-box">
      <div class="avatar" aria-hidden="true">${(u.displayName || '?').charAt(0).toUpperCase()}</div>
      <div><div style="font-weight:700">${u.displayName}</div>
      <div class="muted small">${admin ? 'Administradora' : 'Empleado'} · ${u.username}</div></div>
    </div>
    <div class="menu-list">
      ${admin ? html`
        <a href="#/productos">${icons.box} Productos y precios</a>
        <a href="#/usuarios">${icons.users} Usuarios</a>
        <a href="#/actividad">${icons.list} Registro de actividad</a>
        <button data-m="settings">${icons.settings} Datos del local</button>` : ''}
      <button data-m="password">${icons.key} Cambiar mi contraseña</button>
      <button data-m="logout">${icons.logout} Cerrar sesión</button>
    </div>
    <p class="muted small" style="margin-top:14px">${store.settings.businessName} · horario de Tucumán</p>`);
  s.body.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m) return;
    if (m === 'logout') {
      await s.close();
      try { await api.post('/logout'); } catch { /* igual salimos */ }
      location.hash = '#/';
      location.reload();
    }
    if (m === 'password') { await s.close(); openPasswordSheet(); }
    if (m === 'settings') { await s.close(); openSettingsSheet(); }
  });
}

function openPasswordSheet() {
  const s = openSheet({ title: 'Cambiar mi contraseña' });
  s.setBody(html`<form id="pw-form">
    <div class="form-error" hidden></div>
    <label class="field"><span>Contraseña actual</span><input class="input" type="password" name="current" autocomplete="current-password" required autofocus></label>
    <label class="field"><span>Nueva contraseña</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="6" required></label>
    <p class="hint">Mínimo 6 caracteres.</p>
    <button type="submit" hidden></button></form>`);
  s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-save>Guardar</button>`);
  const form = $('#pw-form', s.body);
  const save = async () => {
    const err = $('.form-error', s.body);
    err.hidden = true;
    const btn = $('[data-save]', s.foot);
    btn.setAttribute('aria-busy', 'true');
    try {
      await api.post('/me/password', { current: form.current.value, password: form.password.value });
      await s.close();
      toast('Contraseña actualizada');
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
    } finally { btn.removeAttribute('aria-busy'); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('[data-save]', s.foot).addEventListener('click', save);
}

function openSettingsSheet() {
  const s = openSheet({ title: 'Datos del local' });
  s.setBody(html`<form id="st-form">
    <label class="field"><span>Nombre del local</span>
      <input class="input" name="businessName" maxlength="40" value="${store.settings.businessName}" required autofocus></label>
    <p class="hint">Aparece en el resumen que se comparte con los clientes.</p>
    <button type="submit" hidden></button></form>`);
  s.setFoot(html`<button class="btn btn-primary btn-lg btn-block" data-save>Guardar</button>`);
  const form = $('#st-form', s.body);
  const save = () => runOp({
    button: $('[data-save]', s.foot),
    exec: () => api.patch('/settings', { businessName: form.businessName.value }),
    onSuccess: async (r) => { store.settings = r.settings; await s.close(); toast('Datos guardados'); },
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('[data-save]', s.foot).addEventListener('click', save);
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-global="menu"]')) openMenu();
});

// ---------- Conexión ----------

const netBanner = document.getElementById('net-banner');
api.on('online', (ok) => {
  netBanner.hidden = ok;
  netBanner.textContent = ok ? '' : 'Sin conexión con el servidor. Lo que cargues no se guarda hasta reconectar.';
});
api.on('unauthorized', () => {
  if (!store.user) return;
  store.user = null;
  closeAllSheets();
  toast('Tu sesión terminó. Volvé a ingresar.', { type: 'error' });
  renderLogin(app, onLoggedIn);
});

function onLoggedIn(user) {
  store.user = user;
  start();
}

function start() {
  window.removeEventListener('hashchange', route);
  window.addEventListener('hashchange', route);
  route();
}

async function boot() {
  try {
    const b = await api.get('/bootstrap');
    store.demo = b.demo;
    store.settings = b.settings;
    store.ficha = b.ficha;
    document.title = `${b.settings.businessName} · Cuentas`;
    if (b.needsSetup) { renderSetup(app, onLoggedIn); return; }
    if (!b.user) { renderLogin(app, onLoggedIn); return; }
    store.user = b.user;
    start();
  } catch (e) {
    app.innerHTML = html`<div class="auth"><h1>No se pudo conectar</h1>
      <p class="lead">${e.message}</p>
      <button class="btn btn-primary btn-lg" id="retry">Reintentar</button></div>`.s;
    $('#retry').addEventListener('click', () => { app.innerHTML = '<div class="boot"><div class="spinner"></div></div>'; boot(); });
  }
}

boot();
