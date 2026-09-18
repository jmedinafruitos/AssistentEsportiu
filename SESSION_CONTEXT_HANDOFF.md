# Assistent Esportiu — Contexto de sesión y traspaso

Fecha de referencia: 2026-09-02 13:26 Europe/Madrid

## Objetivo del proyecto

PWA privada para HC Sentmenat que permite a entrenadores y coordinadores consultar y mantener contexto deportivo del club mediante un asistente conversacional. El acceso requiere sesión y los datos deben quedar aislados por equipo/usuario.

## Repositorio y despliegues

- GitHub: https://github.com/jmedinafruitos/AssistentEsportiu
- Workspace local: `/Users/jordi/GitHub/AssistentEsportiu`
- Rama local de trabajo: `preprod/assistent-esportiu-2026-09-02`
- Rama de backup: `backup/preprod-stack-before-github-sync-2026-09-02`
- PRs integradas: #3, #4, #5, #6, #7 y #8
- API Render: https://assistentesportiu.onrender.com
- PWA Render: https://ssistentesportiu-app.onrender.com
- Base de datos Render: `assistenDB` (PostgreSQL 18)
- Dominio previsto de la PWA: `app.sentmenat.cat` (JME-17; DNS/certificado aún pendientes)
- Dominio mencionado anteriormente: `app.hcsentmenat.cat`; confirmar cuál debe ser el definitivo antes de configurar DNS.

> Atención: la URL pública actual de la PWA empieza por `ssistentesportiu` (dos s iniciales), tal como está desplegada. No corregirla sin revisar Render, DNS y CORS.

## Conexiones y configuración

- API configurada con proveedor OpenAI y modelo compatible con GPT-5 (`gpt-5-mini` validado en producción).
- La petición al proveedor no debe enviar `temperature`; su eliminación resolvió el error `AI_PROVIDER_ERROR_400`.
- CORS permite el origen exacto de la PWA Render: `https://ssistentesportiu-app.onrender.com`.
- El bundle web contiene `VITE_API_URL=https://assistentesportiu.onrender.com`.
- Variables sensibles deben permanecer únicamente en Render Environment; no copiarlas a este documento ni al repositorio.
- Backups de producción confirmados por el usuario.

## Estado de Linear (2026-09-02)

Los detalles funcionales y la evidencia de cada trabajo están en los propios tickets; este documento solo mantiene el mapa de estado:

- `In Pre`: JME-5, JME-6, JME-7, JME-9, JME-10, JME-11, JME-12, JME-13, JME-14 y JME-15.
- `In Progress`: JME-8 (piloto), JME-16 (tracker global) y JME-17 (dominio personalizado).
- Tickets plantilla de Linear sin relación con el MVP: JME-1, JME-2, JME-3 y JME-4.

## Estado técnico transversal

- `npm ci`, `npm run build` y `npm run typecheck`: correctos.
- Tests web: 4/4 correctos.
- Tests JME-5/JME-6 de preproducción: correctos contra producción.
- `/health`: HTTP 200 y consulta a DB correcta.
- `/v1/session`: autenticación correcta.
- `/v1/teams`: HTTP 200 con usuario autenticado.
- `/v1/chat`: HTTP 200 con proveedor OpenAI y `gpt-5-mini`.
- Migraciones 001–008 aplicadas.
- CORS preflight: HTTP 204 con cabeceras correctas.
- PWA: raíz, manifest, service worker e iconos responden HTTP 200.
- Service worker: app shell offline, actualización automática, `clients.claim` y exclusión explícita de `/v1/*` para no cachear datos autenticados.
- Android: instalación física y funcionamiento confirmados por el usuario; dictado y lectura por voz funcionan.
- Render rewrite actual: `/*` → `/` con acción `Rewrite`. Se verificó que `/` y rutas internas devuelven HTML de 809 bytes con `<div id="root"></div>`.
- Resultados de asistente: acceso propio HTTP 200 y acceso ajeno HTTP 403.
Los detalles de JME-10, JME-11, JME-12 y el resto de tickets están documentados en Linear y no se duplican aquí.

## Incidencias o precauciones

- Ejecutar `npm test --workspace @assistent-esportiu/api` sin levantar API local provoca fallos de conexión a `127.0.0.1:3000` en `jme5-preprod.mjs` y `jme6-preprod.mjs`; ejecutar esos scripts con `API_BASE_URL` apuntando a Render.
- `tests/pilot-mvp.mjs` requiere `PILOT_API_URL` y `PILOT_EMAIL`; todavía no se ha ejecutado el piloto real.
- La instalación iOS no está documentada físicamente; es una comprobación opcional pendiente.
- No cambiar CORS ni URLs sin comprobar la URL real desplegada (`ssistentesportiu-app`).

## Próximo orden recomendado

1. Resolver JME-17: decidir dominio definitivo, crear/verificar DNS, esperar propagación, validar certificado y probar `https://app.sentmenat.cat/`.
2. Actualizar CORS para el dominio final manteniendo temporalmente el origen Render si se necesita transición.
3. Completar JME-16 con una checklist global y evidencias de producción.
4. Ejecutar JME-8 con un equipo piloto, usuarios reales/autorizados y criterios de aceptación.
5. Repetir instalación en iOS si se quiere cerrar la cobertura móvil completa.

## Comandos útiles

```bash
cd /Users/jordi/GitHub/AssistentEsportiu
npm ci
npm run build
npm run typecheck

API_BASE_URL=https://assistentesportiu.onrender.com \
  node apps/api/tests/jme5-preprod.mjs

API_BASE_URL=https://assistentesportiu.onrender.com \
  node apps/api/tests/jme6-preprod.mjs
```

## Regla de trabajo para el siguiente agente

Antes de modificar código o infraestructura, consultar este archivo, revisar el estado actual de Linear y comprobar el repositorio (`git status`, rama y último commit). No asumir que los nombres de dominio o estados de tickets han cambiado; volver a verificarlos.
