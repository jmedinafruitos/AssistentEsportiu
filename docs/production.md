# Producción en Render

La API se ejecuta como un Web Service de Render en Frankfurt y PostgreSQL se
ejecuta como una base gestionada en la misma región. `render.yaml` conserva la
configuración no secreta del servicio.

## Variables protegidas

- `DATABASE_URL`: URL interna de Render PostgreSQL.
- `JWT_SECRET`: secreto aleatorio de 32 caracteres o más.
- `AI_API_KEY`: credencial del proveedor de IA, solo en el servidor.
- `AI_BASE_URL` y `AI_MODEL`: permiten cambiar de proveedor compatible sin
  modificar la aplicación móvil.
- `WEB_ORIGIN`: origen exacto autorizado para la PWA. Actualmente
  `https://ssistentesportiu-app.onrender.com`.
- `NODE_VERSION`: `20`.

Los secretos se configuran en Render y nunca se guardan en Git. El proceso de
arranque aplica, en orden y una sola vez, los SQL de `apps/api/migrations` antes
de aceptar tráfico. `/health` verifica tanto la API como una consulta real a la
base de datos.

## Operación

1. Revisar que el último despliegue figure como `Live`.
2. Comprobar que `GET /health` responde `{"status":"ok"}`.
3. Revisar los eventos `migration_applied` y los logs HTTP estructurados en los
   registros del servicio.
4. Activar un plan PostgreSQL de pago con recuperación a un punto en el tiempo
   antes de utilizar datos reales. Revisar periódicamente la retención y hacer
   una restauración de prueba.

La URL pública actual de la API es
`https://assistentesportiu.onrender.com`.

La URL pública actual de la PWA es
`https://ssistentesportiu-app.onrender.com`.
