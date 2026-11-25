// Registro de actividad (solo administradora).
import * as api from '../api.js';
import { html, $ } from '../ui.js';
import { icons } from '../icons.js';
import { when } from '../format.js';
import { appbar } from '../store.js';

export function mount(root) {
  let entries = [];
  let done = false;
  root.innerHTML = html`${appbar({ title: 'Registro de actividad', back: '#/' })}
    <main class="view no-nav" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>`.s;
  const content = $('#content', root);

  async function more() {
    try {
      const before = entries.length ? entries[entries.length - 1].id : '';
      const r = await api.get(`/audit${before ? `?before=${before}` : ''}`);
      entries = entries.concat(r.entries);
      done = r.entries.length < 100;
      render();
    } catch (e) {
      content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudo cargar</p><p>${e.message}</p></div>`.s;
    }
  }

  function render() {
    content.innerHTML = html`<p class="hint" style="margin:0 4px 10px">Quién hizo cada operación importante. No se puede editar.</p>
      <div class="card"><div class="rows">${entries.map((e) => html`<${e.entity === 'account' ? 'a' : 'div'} class="row" ${e.entity === 'account' ? html`href="#/cuenta/${e.entityId}" style="color:inherit;text-decoration:none"` : ''}>
        <div class="grow"><div class="title" style="font-weight:500">${e.summary || e.action}</div>
        <div class="sub">${when(e.at)} · ${e.userName || 'Sistema'}</div></div></${e.entity === 'account' ? 'a' : 'div'}>`)}</div></div>
      ${done ? '' : html`<p style="margin-top:12px"><button class="btn btn-block" id="more">Ver más</button></p>`}`.s;
    $('#more', content)?.addEventListener('click', more);
  }

  more();
}
