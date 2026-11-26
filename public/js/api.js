// Cliente de la API. Nunca da por guardada una operación sin respuesta del servidor.

export class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
  /** Error de red o del servidor: es seguro reintentar con el mismo requestId. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

const listeners = { unauthorized: [], online: [] };
export const on = (ev, fn) => listeners[ev].push(fn);
let online = true;

function setOnline(v) {
  if (online === v) return;
  online = v;
  listeners.online.forEach((fn) => fn(v));
}
export const isOnline = () => online;

/** Identificador único por intención del usuario (funciona también sin HTTPS). */
export function newRequestId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function api(method, path, body, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-Requested-With': 'pool-app' } : { 'X-Requested-With': 'pool-app' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    setOnline(false);
    throw new ApiError(0, 'network', 'Sin conexión con el servidor: no sabemos si se guardó.');
  } finally {
    clearTimeout(timer);
  }
  setOnline(true);
  let data = null;
  try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    if (res.status === 401 && data?.code === 'unauthenticated') listeners.unauthorized.forEach((fn) => fn());
    throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? `Error del servidor (${res.status})`, data);
  }
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body = {}) => api('PATCH', path, body);

window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
