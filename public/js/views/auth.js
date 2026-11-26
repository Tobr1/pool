// Ingreso y configuración inicial.
import * as api from '../api.js';
import { html, $ } from '../ui.js';
import { store } from '../store.js';
import { parseMoney } from '../format.js';

const logo = html`<img class="logo" src="/icon.svg" alt="">`;

export function renderLogin(app, onDone) {
  app.innerHTML = html`${store.demo ? html`<div class="demo-ribbon">MODO DEMO · usuarios: rocio / demo1234 · empleado / demo1234</div>` : ''}
    <main class="auth">
      ${logo}
      <h1>${store.settings.businessName}</h1>
      <p class="lead">Ingresá para ver las cuentas.</p>
      <form id="login" novalidate>
        <div class="form-error" hidden></div>
        <label class="field"><span>Usuario</span><input class="input" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required></label>
        <label class="field"><span>Contraseña</span><input class="input" name="password" type="password" autocomplete="current-password" enterkeyhint="go" required></label>
        <button class="btn btn-primary btn-lg btn-block" type="submit">Ingresar</button>
      </form>
    </main>`.s;
  const form = $('#login', app);
  const err = $('.form-error', form);
  form.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.setAttribute('aria-busy', 'true');
    err.hidden = true;
    try {
      const r = await api.post('/login', { username: form.username.value, password: form.password.value });
      onDone(r.user);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      form.password.select();
    } finally { btn.removeAttribute('aria-busy'); }
  });
}

export function renderSetup(app, onDone) {
  app.innerHTML = html`<main class="auth">
      ${logo}
      <h1>Configuración inicial</h1>
      <p class="lead">Creá el usuario de la administradora. Después vas a poder sumar empleados y cargar los productos.</p>
      <form id="setup" novalidate autocomplete="off">
        <div class="form-error" hidden></div>
        <label class="field"><span>Código de configuración</span>
          <input class="input" name="setupCode" inputmode="numeric" maxlength="8" placeholder="8 dígitos, en la consola del servidor" required></label>
        <label class="field"><span>Nombre del local</span><input class="input" name="businessName" maxlength="40" placeholder="Ej.: Pool Rocío"></label>
        <label class="field"><span>Precio de la ficha</span>
          <div class="input-wrap"><span class="prefix">$</span><input class="input input-money" name="fichaPrice" inputmode="decimal" placeholder="Ej.: 1.500" required></div></label>
        <label class="field"><span>Tu nombre</span><input class="input" name="displayName" maxlength="40" placeholder="Ej.: Rocío" required></label>
        <label class="field"><span>Usuario para ingresar</span><input class="input" name="username" maxlength="30" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Ej.: rocio" required></label>
        <label class="field"><span>Contraseña</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="6" placeholder="Mínimo 6 caracteres" required></label>
        <button class="btn btn-primary btn-lg btn-block" type="submit">Crear y entrar</button>
      </form>
    </main>`.s;
  const form = $('#setup', app);
  const err = $('.form-error', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.setAttribute('aria-busy', 'true');
    err.hidden = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      const fichaPriceCents = parseMoney(body.fichaPrice);
      delete body.fichaPrice;
      if (fichaPriceCents === null || fichaPriceCents <= 0) throw new Error('Ingresá el precio de la ficha.');
      const r = await api.post('/setup', { ...body, fichaPriceCents });
      if (body.businessName) store.settings.businessName = body.businessName.trim();
      onDone(r.user);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    } finally { btn.removeAttribute('aria-busy'); }
  });
}
