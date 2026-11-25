// Formato de moneda, horas y textos. Todos los importes viajan en centavos (enteros).

export const TZ = 'America/Argentina/Tucuman';

const moneyInt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const moneyDec = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(cents) {
  const c = Number(cents) || 0;
  return (c % 100 === 0 ? moneyInt : moneyDec).format(c / 100);
}

/** Importe para mostrar dentro de un campo de texto (sin símbolo). */
export function moneyInput(cents) {
  const c = Math.max(0, Number(cents) || 0);
  const pesos = Math.trunc(c / 100);
  const dec = c % 100;
  const intPart = pesos.toLocaleString('es-AR');
  return dec ? `${intPart},${String(dec).padStart(2, '0')}` : intPart;
}

/**
 * Interpreta un importe escrito en formato argentino y devuelve centavos.
 * Acepta "12500", "12.500", "12.500,50", "12500,5", "$ 1.500". Devuelve null si no es válido.
 * No usa coma flotante: trabaja con los dígitos.
 */
export function parseMoney(text) {
  let s = String(text ?? '').replace(/[\s$]/g, '');
  if (!s) return null;
  let intPart; let decPart = '';
  if (s.includes(',')) {
    const [i, d, ...rest] = s.split(',');
    if (rest.length) return null;
    intPart = i.replace(/\./g, '');
    decPart = d;
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    intPart = s.replace(/\./g, '');
  } else if (/^\d+\.\d{1,2}$/.test(s)) {
    [intPart, decPart] = s.split('.');
  } else {
    intPart = s;
  }
  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(decPart)) return null;
  if (intPart.length > 10) return null;
  return Number(intPart) * 100 + Number(decPart.padEnd(2, '0') || 0);
}

const timeFmt = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFmt = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
const dateLongFmt = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const time = (ts) => (ts ? timeFmt.format(ts) : '');
export const dayKey = (ts) => dayKeyFmt.format(ts);
export function dateShort(ts) {
  const p = Object.fromEntries(dateFmt.formatToParts(ts).map((x) => [x.type, x.value]));
  return `${cap(p.weekday.replace('.', ''))} ${p.day}/${p.month}`;
}
export const dateLong = (ts) => cap(dateLongFmt.format(ts));

/** "20:15" si es hoy, "Lun 24/11 20:15" si es otro día. */
export function when(ts) {
  if (!ts) return '';
  return dayKey(ts) === dayKey(Date.now()) ? time(ts) : `${dateShort(ts)} ${time(ts)}`;
}

/** Rango "Lun 24/11 20:00 → Mar 25/11 02:30" (muestra la fecha de fin solo si cambia). */
export function range(from, to) {
  const start = `${dateShort(from)} ${time(from)}`;
  if (!to) return `${start} → en curso`;
  return dayKey(from) === dayKey(to) ? `${start} → ${time(to)}` : `${start} → ${dateShort(to)} ${time(to)}`;
}

export function duration(from, to = Date.now()) {
  const m = Math.max(0, Math.round((to - from) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export const METHOD_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia' };
export const CATEGORY_LABEL = { ficha: 'Fichas', bebida: 'Bebidas', otro: 'Otros' };
export const CATEGORY_ONE = { ficha: 'Ficha', bebida: 'Bebida', otro: 'Otro' };
