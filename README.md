# Agent Hub

Agent Hub es un directorio visual de agentes con dos modos de uso:

- **Portal publico:** GitHub Pages sirve una experiencia de exploracion estatica en `https://jagogg.github.io/agent-hub-web/`.
- **Aplicacion completa:** el servidor Node habilita cuentas, agentes, conversaciones y mensajes con persistencia local.

La portada incluye una composicion controlable de HyperFrames que presenta el catalogo como un mapa operativo, no como un video decorativo independiente.

## Ejecutar localmente

Requiere Node.js 18.17 o superior.

```bash
npm start
```

Abre `http://localhost:5173`. Si el backend no esta disponible, la interfaz cambia automaticamente al portal publico y nunca queda atrapada en una pantalla de carga.

## Verificar

```bash
npm test
npm run check
```

Las pruebas cubren el contrato estatico, autenticacion, aislamiento entre cuentas, rutas protegidas, tipos MIME, solicitudes `HEAD` y proteccion ante un archivo de datos corrupto.

## Variables de entorno

| Variable | Predeterminado | Uso |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Interfaz donde escucha el servidor. |
| `PORT` | `5173` | Puerto HTTP. Usa `0` para uno disponible automaticamente. |
| `DATA_FILE` | `data/db.json` | Ruta del archivo JSON persistente. |
| `NODE_ENV` | vacio | Usa `production` para cookies seguras y HSTS. |
| `TRUST_PROXY` | `0` | Usa `1` solo detras de un proxy propio que limpie encabezados reenviados. |

## API local

- `GET /api/version`
- `GET /api/health`
- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `GET|POST /api/agents`
- `PUT|DELETE /api/agents/:id`
- `GET|POST /api/agents/:id/conversations`
- `DELETE /api/conversations/:id`
- `GET|POST /api/conversations/:id/messages`

GitHub Pages no ejecuta Node ni guarda cuentas. Para publicar el modo completo se necesita un host de aplicaciones con almacenamiento persistente.

## Estructura principal

- `index.html`, `styles.css`, `app.js`: portal y aplicacion web.
- `assets/hyperframes-showcase.*`: composicion, estilos y timeline de HyperFrames.
- `server.mjs`: API y servidor estatico sin dependencias externas.
- `tests/server.test.mjs`: pruebas de contrato e integracion.
