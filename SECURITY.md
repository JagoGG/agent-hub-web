# Seguridad

## Reportar un problema

No publiques vulnerabilidades con datos sensibles en un issue abierto. Envia un reporte privado desde la pestana **Security** del repositorio e incluye impacto, pasos minimos para reproducir y una propuesta de mitigacion si la tienes.

## Controles incluidos

- Contrasenas derivadas con PBKDF2-HMAC-SHA-512 y 220.000 iteraciones; los hashes antiguos se actualizan al iniciar sesion.
- Tokens de sesion aleatorios almacenados como SHA-256 y enviados en cookies `HttpOnly` con `SameSite=Lax`.
- Comparacion de hashes en tiempo constante.
- Limites de tamano, longitud y frecuencia para solicitudes de API.
- Validacion de `Origin`, `Sec-Fetch-Site`, tipos de contenido y propiedad de cada recurso.
- Escrituras atomicas del archivo de datos; un JSON corrupto detiene el arranque y no se reemplaza.
- Politica CSP estricta, encabezados de aislamiento, HSTS en produccion y lista permitida de archivos publicos.

## Despliegue

- Usa HTTPS y `NODE_ENV=production` fuera del equipo local.
- Activa `TRUST_PROXY=1` unicamente detras de un proxy controlado que reemplace `X-Forwarded-For` y `X-Forwarded-Proto`.
- Guarda `DATA_FILE` en un volumen privado con copias de seguridad.
- El almacenamiento JSON es adecuado para una instancia pequena. Para multiples procesos o alta concurrencia, migra a una base de datos transaccional.
- GitHub Pages solo publica el portal estatico; no aloja la API ni datos privados.
