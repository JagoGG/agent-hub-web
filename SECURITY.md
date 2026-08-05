# Política de seguridad — Agent Hub

## Reporte de vulnerabilidades

No publiques problemas sensibles en público. Usa:

- https://github.com/JagoGG/agent-hub-web/security/advisories/new

Incluye:

- impacto,
- pasos para reproducir,
- evidencia (capturas o request/response),
- propuesta de corrección.

## Controles implementados

- Cabeceras de seguridad HTTP: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, CSP básica y restricciones CSP para evitar ejecución externa.
- Autenticación por sesión con token de cookie HttpOnly.
- Tokens de sesión hasheados antes de persistir.
- Password hashing con PBKDF2 + salt por usuario.
- Rate limiting básico por identidad para `register`, `login` y envío de mensajes.
- Aislamiento por `userId` en todas las rutas de `/api/agents` y `/api/conversations`.
- `404` y APIs desconocidas devuelven respuestas controladas (sin detalles del sistema).

## Riesgos conocidos

- Base de datos actual en JSON local sin cifrado en reposo.
- No hay recuperación de contraseña todavía.
- No hay verificación de correo.
- No hay rotación automática de secretos ni protección CSRF completa.

## Recomendación de hardening recomendado

1. Reemplazar persistencia JSON por base de datos con backups cifrados.
2. Agregar CSRF token por sesión y SameSite=Lax/Strict consistente según clientes móviles.
3. Añadir auditoría de eventos de sesión (login, logout, cambios de contraseña).
4. Revisar límites de tasa y bloquear por fingerprint adicional.
5. Desplegar detrás de HTTPS obligatorio y HSTS.
6. Añadir logging estructurado y alertas por abuso.
