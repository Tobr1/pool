import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { seedDemo } from './seed-demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');
const PORT = Number(process.env.PORT || (DEMO ? 3001 : 3000));
const HOST = process.env.HOST || '0.0.0.0';
// Los datos de demostración viven en un archivo distinto: nunca se mezclan con los reales.
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', DEMO ? 'demo.sqlite' : 'pool.sqlite');

const { server, db, ctx } = createApp({ dbFile: DB_FILE, demo: DEMO, trustProxy: process.env.TRUST_PROXY === '1' });

if (DEMO) {
  const seeded = seedDemo(db);
  if (seeded) ctx.setupCode = null;
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Pool · cuentas del local ${DEMO ? '— MODO DEMO (datos de prueba)' : ''}`);
  console.log(`  Base de datos: ${DB_FILE}`);
  console.log(`  Local:      http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  En la red:  http://${a.address}:${PORT}`);
    }
  }
  if (ctx.setupCode) {
    console.log(`\n  Primer acceso: abrí la app y usá este código de configuración: ${ctx.setupCode}`);
  }
  if (DEMO) console.log('\n  Usuarios demo: rocio / demo1234 (administradora) · empleado / demo1234 (empleado)');
  console.log('');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
