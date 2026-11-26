// Resumen limpio para el cliente: ver, compartir (nativo) o descargar.
import * as api from '../api.js';
import { html, toast, $ } from '../ui.js';
import { icons } from '../icons.js';
import { money, time, dateLong, dayKey, METHOD_LABEL } from '../format.js';
import { store, appbar } from '../store.js';

export function mount(root, { params }) {
  const id = Number(params[0]);
  let d = null;

  root.innerHTML = html`${appbar({ title: 'Resumen para el cliente', back: `#/cuenta/${id}` })}
    <main class="view no-nav" id="content"><div class="empty"><div class="spinner" style="margin:auto"></div></div></main>
    <div class="dock no-nav no-print" id="dock"></div>`.s;
  const content = $('#content', root);

  function schedule(a) {
    const end = a.closedAt ?? Date.now();
    const sameDay = dayKey(a.openedAt) === dayKey(end);
    return {
      date: dateLong(a.openedAt),
      hours: `${time(a.openedAt)} a ${a.closedAt ? time(a.closedAt) : 'ahora'}${sameDay ? '' : ' (día siguiente)'}`,
    };
  }

  function render() {
    const { account: a, totals: t } = d;
    const sch = schedule(a);
    const pays = d.payments.filter((p) => !p.voided);
    content.innerHTML = html`<div class="ticket" id="ticket">
      <h2>${store.settings.businessName}</h2>
      <p class="center">Resumen de consumos</p>
      <hr>
      <div class="tline"><span class="d"><strong>${a.name}</strong></span><span class="s">${a.table ? `Mesa ${a.table}` : ''}</span></div>
      <div class="note">${sch.date}</div>
      <div class="note">Horario: ${sch.hours}</div>
      <hr>
      ${d.summary.length ? d.summary.map((g) => html`<div class="tline"><span class="d">${g.quantity} × ${g.productName} <span class="note">(${money(g.unitPriceCents)})</span></span><span class="s">${money(g.subtotalCents)}</span></div>`)
        : html`<p class="note">Sin consumos.</p>`}
      <hr>
      <div class="tline big"><span>Total consumido</span><span class="s">${money(t.consumedCents)}</span></div>
      ${pays.map((p) => html`<div class="tline"><span class="d">Pago ${METHOD_LABEL[p.method].toLowerCase()} · ${time(p.createdAt)}</span><span class="s">− ${money(p.amountCents)}</span></div>`)}
      <div class="tline big"><span>${balanceLabel(t.balanceCents)}</span><span class="s">${money(Math.abs(t.balanceCents))}</span></div>
      <hr>
      <p class="center">${a.status === 'closed' ? '¡Gracias por venir!' : 'Cuenta abierta: puede tener más consumos.'}</p>
    </div>`.s;

    const canShare = typeof navigator.share === 'function';
    content.classList.toggle('two-row', canShare); // la barra inferior ocupa dos filas
    document.body.classList.toggle('two-row-dock', canShare);
    $('#dock', root).innerHTML = html`<div class="dock-inner" style="flex-direction:column">
      ${canShare ? html`<button class="btn btn-primary btn-lg btn-block" data-s="share">${icons.share} Compartir</button>` : ''}
      <div style="display:flex;gap:8px">
        <button class="btn ${canShare ? '' : 'btn-primary'} btn-block" data-s="download">${icons.download} Descargar</button>
        <button class="btn btn-block" data-s="copy">${icons.copy} Copiar texto</button>
      </div></div>`.s;
  }

  function asText() {
    const { account: a, totals: t } = d;
    const sch = schedule(a);
    const lines = [
      `*${store.settings.businessName}* — Resumen de consumos`,
      `${a.name}${a.table ? ` · Mesa ${a.table}` : ''}`,
      `${sch.date} · ${sch.hours}`,
      '',
      ...d.summary.map((g) => `${g.quantity} × ${g.productName} (${money(g.unitPriceCents)}) = ${money(g.subtotalCents)}`),
      '',
      `Total consumido: ${money(t.consumedCents)}`,
      ...d.payments.filter((p) => !p.voided).map((p) => `Pago ${METHOD_LABEL[p.method].toLowerCase()} ${time(p.createdAt)}: −${money(p.amountCents)}`),
      `${balanceLabel(t.balanceCents)}: ${money(Math.abs(t.balanceCents))}`,
    ];
    return lines.join('\n');
  }

  function fileName() {
    const safe = d.account.name.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cuenta';
    return `resumen-${safe}-${dayKey(d.account.openedAt)}.png`;
  }

  async function toBlob() {
    const canvas = drawTicket(d, schedule(d.account), store.settings.businessName);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  function download(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-s]')?.dataset.s;
    if (!act || !d) return;
    try {
      if (act === 'download') {
        download(await toBlob());
        toast('Imagen descargada');
      } else if (act === 'copy') {
        await navigator.clipboard.writeText(asText());
        toast('Texto copiado: pegalo en el chat que quieras');
      } else if (act === 'share') {
        const blob = await toBlob();
        const file = new File([blob], fileName(), { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: `Resumen · ${d.account.name}`, text: `Resumen de ${d.account.name}` });
        } else {
          await navigator.share({ title: `Resumen · ${d.account.name}`, text: asText() });
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') return; // el usuario canceló
      if (act === 'copy') toast('No se pudo copiar. Probá con “Descargar imagen”.', { type: 'error' });
      else toast('No se pudo compartir. Probá con “Descargar imagen”.', { type: 'error' });
    }
  });

  api.get(`/accounts/${id}`).then((r) => { d = r; render(); }).catch((e) => {
    content.innerHTML = html`<div class="empty">${icons.alert}<p class="big">No se pudo cargar el resumen</p><p>${e.message}</p></div>`.s;
  });
}

function balanceLabel(c) {
  if (c > 0) return 'Saldo pendiente';
  if (c < 0) return 'Saldo a favor del cliente';
  return 'Saldo';
}

/** Dibuja el resumen en un canvas (imagen para compartir). */
export function drawTicket(d, sch, businessName) {
  const W = 720; const pad = 48; const scale = 1;
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const rows = [];
  const add = (type, left, right = '', extra = {}) => rows.push({ type, left, right, ...extra });

  add('title', businessName);
  add('center', 'Resumen de consumos');
  add('hr');
  add('bold', d.account.name, d.account.table ? `Mesa ${d.account.table}` : '');
  add('note', sch.date);
  add('note', `Horario: ${sch.hours}`);
  add('hr');
  if (!d.summary.length) add('note', 'Sin consumos.');
  d.summary.forEach((g) => add('line', `${g.quantity} × ${g.productName}`, money(g.subtotalCents), { sub: `${money(g.unitPriceCents)} c/u` }));
  add('hr');
  add('big', 'Total consumido', money(d.totals.consumedCents));
  d.payments.filter((p) => !p.voided).forEach((p) => add('line', `Pago ${METHOD_LABEL[p.method].toLowerCase()} · ${time(p.createdAt)}`, `− ${money(p.amountCents)}`));
  add('big', balanceLabel(d.totals.balanceCents), money(Math.abs(d.totals.balanceCents)));
  add('hr');
  add('center', d.account.status === 'closed' ? '¡Gracias por venir!' : 'Cuenta abierta: puede tener más consumos.');

  const H_OF = { title: 56, center: 36, hr: 30, bold: 40, note: 30, line: 58, big: 46 };
  const height = pad * 2 + rows.reduce((s, r) => s + (r.type === 'line' && !r.sub ? 40 : H_OF[r.type]), 0);
  const canvas = document.createElement('canvas');
  const dpr = 2;
  canvas.width = W * dpr * scale; canvas.height = height * dpr * scale;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = '#fbfaf6'; c.fillRect(0, 0, W, height);
  c.fillStyle = '#1e7a4a'; c.fillRect(0, 0, W, 10);
  let y = pad;
  const fitText = (text, maxW) => {
    if (c.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  };
  for (const r of rows) {
    c.textBaseline = 'alphabetic';
    if (r.type === 'title') { c.font = font(800, 34); c.fillStyle = '#111'; c.textAlign = 'center'; c.fillText(fitText(r.left, W - pad * 2), W / 2, y + 36); y += H_OF.title; continue; }
    if (r.type === 'center') { c.font = font(500, 22); c.fillStyle = '#555'; c.textAlign = 'center'; c.fillText(fitText(r.left, W - pad * 2), W / 2, y + 24); y += H_OF.center; continue; }
    if (r.type === 'hr') {
      c.strokeStyle = '#b9bdb8'; c.setLineDash([6, 6]); c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(pad, y + 15); c.lineTo(W - pad, y + 15); c.stroke(); c.setLineDash([]);
      y += H_OF.hr; continue;
    }
    const isBig = r.type === 'big' || r.type === 'bold';
    c.font = font(isBig ? 800 : r.type === 'note' ? 400 : 500, r.type === 'big' ? 28 : r.type === 'note' ? 20 : 24);
    c.fillStyle = r.type === 'note' ? '#555' : '#111';
    c.textAlign = 'right';
    const rw = r.right ? c.measureText(r.right).width : 0;
    if (r.right) c.fillText(r.right, W - pad, y + 28);
    c.textAlign = 'left';
    c.fillText(fitText(r.left, W - pad * 2 - rw - 16), pad, y + 28);
    if (r.sub) { c.font = font(400, 19); c.fillStyle = '#666'; c.fillText(r.sub, pad, y + 52); }
    y += r.type === 'line' && !r.sub ? 40 : H_OF[r.type];
  }
  return canvas;
}
