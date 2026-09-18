# Copias de seguridad y prueba de restauración — PostgreSQL (Render)

Runbook para cerrar los puntos pendientes de JME-16 sobre backups de
`assistenDB` en Render.

## 1. Confirmar plan, retención y copias de seguridad

En el dashboard de Render → base de datos `assistenDB` → pestaña **Backups**:

1. Anotar el plan actual (Starter / Standard / Pro) — el plan gratuito de
   Render **no** ofrece backups automáticos ni recuperación a un punto en el
   tiempo (PITR); hace falta un plan de pago para tenerlos.
2. Anotar los días de retención de backups automáticos que ofrece ese plan.
3. Confirmar si PITR está activo y cuál es su ventana de recuperación.
4. Descargar o listar el backup automático más reciente y anotar su fecha,
   para verificar que Render los está generando de verdad (no solo que el
   plan los incluye sobre el papel).

Registrar el resultado de estos 4 puntos como comentario en JME-16 (plan,
retención en días, PITR sí/no, fecha del último backup visto).

## 2. Prueba de restauración (segura, sin tocar producción)

**No restaurar sobre `assistenDB`.** El procedimiento crea una base nueva
para no arriesgar los datos reales:

1. En Render, sobre el backup más reciente de `assistenDB`, elegir
   "Restore to new database" (o equivalente) y darle un nombre temporal,
   p. ej. `assistendb-restore-test`.
2. Esperar a que la restauración termine y anotar cuánto ha tardado.
3. Conectar con `psql` a la base restaurada y comprobar:
   - `SELECT count(*) FROM schema_migrations;` coincide con el número de
     archivos en `apps/api/migrations/` (14 en este momento).
   - Una tabla con datos reales (p. ej. `teams` o `strategy_contexts`) tiene
     filas y una fila conocida se puede localizar por su clave.
4. Anotar el resultado (éxito/fallo, tiempo de restauración, discrepancias)
   como comentario en JME-16.
5. Borrar la base temporal `assistendb-restore-test` una vez confirmado, para
   no dejar costes ni datos huérfanos.

## 3. Revisión de logs estructurados

En Render → servicio `assistentesportiu` → **Logs**:

1. Buscar `"event":"migration_applied"` — debe aparecer una línea por cada
   archivo en `apps/api/migrations/` la primera vez que ese servicio arrancó
   con esa migración pendiente (ver `apps/api/src/migrate.ts:36`).
2. Confirmar que las peticiones HTTP normales aparecen como líneas JSON
   (Fastify con `logger: true` en `apps/api/src/index.ts:36` genera logs
   estructurados por request: método, ruta, status, tiempo de respuesta).
3. Anotar cualquier error o warning repetido que no se haya visto antes.

## Nota

Los pasos 1 y 2 requieren acceso al dashboard de Render (no disponible desde
este entorno de trabajo); hay que ejecutarlos manualmente y pegar el
resultado en JME-16. El paso 3 se puede completar en cuanto alguien con
acceso al dashboard revise la pestaña de logs.
