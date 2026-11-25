// Copia de seguridad consistente de la base (funciona con la app en marcha).
// Uso: npm run backup            → backups/pool-AAAA-MM-DD_HHMM.sqlite
//      DB_FILE=... npm run backup
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.env.DB_FILE || path.join(ROOT, 'data', 'pool.sqlite');
if (!fs.existsSync(src)) {
  console.error(`No existe la base: ${src}`);
  process.exit(1);
}
const dir = path.join(ROOT, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Argentina/Tucuman', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date()).replace(' ', '_').replace(':', '');
const dest = path.join(dir, `${path.basename(src, '.sqlite')}-${stamp}.sqlite`);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.log(`Copia guardada en ${dest}`);
