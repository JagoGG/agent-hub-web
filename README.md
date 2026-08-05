# Agent Hub Web

Portal operativo para gestionar agentes, conversaciones y sesiones por usuario.

## Qué resuelve esta versión

- Registro e inicio de sesión con contraseña.
- Persistencia por usuario en base local JSON (`data/db.json`), compartible entre dispositivos que usen el mismo servidor.
- CRUD de agentes por usuario.
- CRUD de conversaciones por agente.
- Persistencia de mensajes.
- Guardado de sesión con cookie HttpOnly.

## Requisitos

- Node.js 18.17+.
- Un terminal con permisos de escritura en este repositorio.

## Ejecutar localmente

1. Instala dependencias (no hay dependencias externas, solo runtime de Node):
   ```bash
   npm install
   ```
2. Inicia el servidor:
   ```bash
   npm run start
   ```
3. Abre `http://localhost:3000`.

## Endpoints de API

### Salud
- `GET /api/health`

### Auth
- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`

### Agentes
- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:agentId`
- `DELETE /api/agents/:agentId`
- `GET /api/agents/:agentId/conversations`

### Conversaciones
- `GET /api/conversations?agentId=:agentId`
- `POST /api/conversations`
- `GET /api/conversations/:conversationId`
- `PATCH /api/conversations/:conversationId`
- `DELETE /api/conversations/:conversationId`
- `GET /api/conversations/:conversationId/messages`
- `POST /api/conversations/:conversationId/messages`

## Estructura de almacenamiento

Por defecto se guarda en `data/db.json` con tablas lógicas:

- `users`
- `sessions`
- `agents`
- `conversations`
- `messages`

Cada sesión se guarda con hash de token y expiración de 14 días.

## Notas de seguridad mínimas activas

- Cookies HttpOnly, SameSite=Strict.
- Límite de tasa básico en login/registro/mensajes.
- Hash de contraseña con PBKDF2 (salt único por usuario).
- Cabeceras de hardening en respuestas HTTP.
- Aislamiento por `userId` en todas las rutas protegidas.

## Pendientes de mejora crítica

- Migrar almacenamiento de JSON a base de datos real (PostgreSQL o SQLite con migraciones).
- Integración de correo de verificación y recuperación de contraseña.
- Cifrado en reposo de datos sensibles.
- Rotación y revocación proactiva de sesiones.
- Protección CSRF y doble-factor opcional.
- Auditoría y registros de evento firmados.

## Nota sobre compatibilidad

Las rutas absolutas que existían en el snapshot anterior (`/agent-hub-web/...`) fueron eliminadas para evitar roturas de despliegue en rutas personalizadas.
