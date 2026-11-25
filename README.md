# Pool · Cuentas

Aplicación web para llevar las cuentas de un local de pool y bar desde el celular: abrir cuentas, cargar fichas y bebidas, cobrar (efectivo, transferencia o dividido), cerrar cuentas, caja por turno e historial.

- **Sin dependencias externas.** Solo hace falta Node.js 22.13 o superior (usa el SQLite que trae Node).
- **Datos en una base SQLite real** (`data/pool.sqlite`). Recargar o cerrar el navegador no pierde nada.
- **Pensada para celular** (360–430 px), y funciona también en tablet y computadora.

## Cómo ejecutarla

```powershell
npm start
```

Abrí `http://localhost:3000` en la computadora. Para usarla desde el celular, conectalo a la misma red Wi‑Fi y abrí la dirección **"En la red"** que muestra la consola (por ejemplo `http://192.168.0.10:3000`). Desde el navegador del celular podés elegir "Agregar a la pantalla de inicio" para abrirla como una app.

Variables opcionales:

| Variable | Para qué | Valor por defecto |
|---|---|---|
| `PORT` | Puerto | `3000` (demo: `3001`) |
| `HOST` | Interfaz de red | `0.0.0.0` (toda la red local) |
| `DB_FILE` | Ruta de la base | `data/pool.sqlite` |
| `TRUST_PROXY` | `1` si está detrás de un proxy HTTPS | — |

## Base de datos y primer acceso

No hay que instalar ni configurar ninguna base: al arrancar por primera vez se crea `data/pool.sqlite` con todas las tablas.

1. Ejecutá `npm start`. La consola muestra un **código de configuración** de 6 dígitos.
2. Abrí la app: aparece "Configuración inicial". Ingresá ese código, el nombre del local y el usuario y contraseña de la administradora (Rocío).
3. Entrá al menú **⋮ → Productos y precios**: poné el precio de la "Ficha de pool" (se crea con $0) y cargá las bebidas. Marcá con ★ las más pedidas.
4. Menú **⋮ → Usuarios**: creá los usuarios de los empleados.

El código solo sirve mientras no exista ningún usuario; después ya no se puede volver a usar.

### Copias de seguridad

```powershell
npm run backup
```

Genera una copia consistente en `backups/` (se puede hacer con la app en uso). Toda la información está en el archivo `data/pool.sqlite`; guardar ese archivo es guardar todo.

## Modo demostración

```powershell
npm run demo
```

Abre en `http://localhost:3001` con datos de prueba en **otro archivo** (`data/demo.sqlite`), nunca en la base real. La app muestra una franja amarilla "MODO DEMO". Usuarios: `rocio` / `demo1234` (administradora) y `empleado` / `demo1234`. Para reiniciar la demo, borrá `data/demo.sqlite`.

## Pruebas

```powershell
npm test
```

Levanta el servidor con una base temporal y recorre los escenarios de validación (cuentas, fichas, bebidas, anulaciones, cambios de precio, pagos parciales y divididos, cierre, persistencia, reintentos sin duplicar, turno que cruza medianoche y permisos).

## Cómo funciona

- **Cuenta**: la unidad principal (persona o grupo). La mesa es opcional y se puede cambiar sin perder consumos.
- **Consumos**: guardan el nombre y el precio del momento. Cambiar el catálogo no altera lo ya cargado. No se borran: se **anulan** con motivo, y queda quién y cuándo.
- **Pagos**: separados de los consumos. Un cobro dividido genera dos pagos (efectivo y transferencia). No se puede cobrar más que el saldo ni cerrar una cuenta con saldo pendiente. Corregir un pago (anularlo con motivo) es exclusivo de la administradora.
- **Turnos**: los pagos se asignan al turno en el que se reciben. Si no hay turno abierto, se abre solo con la primera carga o cobro. Cerrar un turno no toca las cuentas abiertas: siguen para el turno siguiente.
- **Sin duplicados**: cada operación viaja con un identificador único; si se corta la conexión y se reintenta, el servidor devuelve el resultado ya guardado en lugar de repetirlo. Los cobros además verifican que el saldo no haya cambiado, y las ediciones usan número de versión para no pisar cambios de otro dispositivo.
- **Permisos** (validados en el servidor): el empleado abre cuentas, carga consumos, anula consumos con motivo, cobra y abre/cierra turnos. La administradora además gestiona usuarios, productos y precios, corrige pagos, reabre cuentas cerradas y ve el registro de actividad.
- **Importes** en centavos enteros (sin errores de coma flotante), mostrados en pesos argentinos. Horarios en `America/Argentina/Tucuman`.

## Estructura

```
server/
  index.js       arranque (puertos, modo demo, código de configuración)
  app.js         servidor HTTP, enrutador, archivos estáticos, seguridad
  routes.js      API: acceso, cuentas, consumos, pagos, turnos, productos, usuarios
  domain.js      cálculos de totales, reportes de turno, consultas
  db.js          esquema, migraciones, transacciones, idempotencia, auditoría
  auth.js        contraseñas (scrypt) y sesiones
  seed-demo.js   datos de demostración
public/
  index.html, css/app.css
  js/main.js     enrutador y menú
  js/views/      pantallas (cuentas, detalle, catálogo, cobro, resumen, caja, historial, administración)
test/            escenarios de validación
scripts/backup.js
```

## Limitaciones conocidas

- **Compartir nativo requiere HTTPS.** En la red local por `http://` el celular no ofrece "Compartir"; la app muestra "Descargar" (imagen) y "Copiar texto". Para tener el botón Compartir, publicala detrás de HTTPS (por ejemplo con un proxy inverso) o usala en `localhost`.
- **Sin modo offline**: si se corta la conexión, la app avisa y permite reintentar sin duplicar, pero no guarda operaciones para enviarlas después.
- Un solo local y un solo turno abierto a la vez.
