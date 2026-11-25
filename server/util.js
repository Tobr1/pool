import crypto from 'node:crypto';

export const TZ = 'America/Argentina/Tucuman';
export const MAX_CENTS = 100_000_000_00; // $100.000.000 como tope de seguridad

export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const now = () => Date.now();

export function normText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanText(v, { field, max = 60, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${field}: formato inválido`, 'validation');
  const s = v.replace(/\s+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `${field} es obligatorio`, 'validation');
  if (s.length > max) throw new HttpError(400, `${field}: máximo ${max} caracteres`, 'validation');
  return s;
}

export function cents(v, { field = 'Importe', min = 0, max = MAX_CENTS } = {}) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new HttpError(400, `${field}: debe ser un importe válido`, 'validation');
  }
  if (v < min) throw new HttpError(400, `${field}: el mínimo es ${min / 100}`, 'validation');
  if (v > max) throw new HttpError(400, `${field}: importe demasiado alto`, 'validation');
  return v;
}

export function intParam(v, { field, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field}: valor inválido`, 'validation');
  }
  return n;
}

export function requestId(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(v)) {
    throw new HttpError(400, 'Falta el identificador de operación', 'validation');
  }
  return v;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Desfasaje (ms) de la zona horaria respecto de UTC en un instante dado. */
function tzOffset(ts, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Inicio (incl.) y fin (excl.) en ms UTC de un día calendario local "YYYY-MM-DD". */
export function zonedDayRange(dateStr, tz = TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) throw new HttpError(400, 'Fecha inválida', 'validation');
  const startOf = (y, mo, d) => {
    const guess = Date.UTC(y, mo - 1, d);
    let ts = guess - tzOffset(guess, tz);
    ts = guess - tzOffset(ts, tz);
    return ts;
  };
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return [startOf(y, mo, d), startOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())];
}

export function fmtMoney(c) {
  const opts = c % 100 === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 2 };
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', ...opts }).format(c / 100);
}
