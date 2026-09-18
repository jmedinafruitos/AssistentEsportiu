# CLAUDE.md

Guía para Claude Code en este repositorio. Este archivo unifica lo que antes
estaba repartido entre `README.md`, `SESSION_CONTEXT_HANDOFF.md`,
`docs/production.md` y `deploy/preprod/README.md`. Esos archivos siguen
existiendo (no se han borrado ni tocado) pero este es el punto de entrada:
léelo primero, y si algo aquí contradice uno de ellos, este archivo es el que
se ha verificado más recientemente (última verificación: 2026-09-18).

**Regla de trabajo para cualquier agente**: antes de tocar código o
infraestructura, comprueba `git status`, la rama actual y el último commit
(no asumas nada sobre dominios, URLs o estado de Linear sin volver a
verificarlo — este entorno cambia con frecuencia).

## Qué es esto

PWA privada de coordinación deportiva para el **Hoquei Club Sentmenat**.
Entrenadores y coordinadores consultan y mantienen el contexto deportivo del
club (estrategia, planificación de temporada, entrenamientos, partidos) a
través de un asistente conversacional con IA. Acceso solo con sesión; datos
aislados por equipo/usuario.

## Estructura del monorepo

```
apps/api/   — API Node.js/TypeScript (Fastify), migraciones SQL en apps/api/migrations
apps/web/   — PWA (Vite), build a apps/web/dist
docs/       — runbooks y esquemas puntuales (backups, periodización, ficha de entreno...)
deploy/preprod/README.md — procedimiento operativo de preprod en JMFsrv
docker-compose.preprod.yml — stack de preprod (postgres + migrations + api + web)
render.yaml — configuración no secreta de los dos servicios de producción en Render
```

Workspaces npm: `apps/*`. Node 20.x. Scripts clave: `npm run dev:api`,
`npm run dev:web`, `npm run build` (build de ambos workspaces), `npm run
typecheck`, `npm run test:pilot`.

## Repositorio y ramas

- GitHub: `https://github.com/jmedinafruitos/AssistentEsportiu`
- Workspace local: `/Users/jordi/GitHub/AssistentEsportiu`
- **`origin` no apunta a GitHub**: apunta a `jmfsrv:/home/jordi/assistent-esportiu-preprod`
  (repo en el servidor de preproducción). La rama `main` local trackea ese
  `origin`. La rama de trabajo actual, `preprod/assistent-esportiu-2026-09-02`,
  en cambio trackea GitHub directamente (`https://github.com/jmedinafruitos/AssistentEsportiu.git`,
  ver `.git/config`). Es decir: **este repo empuja a dos destinos distintos
  según la rama** — no asumas que un `git push` en cualquier rama va a
  GitHub o a JMFsrv por igual; comprueba con `git remote -v` y la sección
  `[branch "..."]` de `.git/config` cuál le toca a la rama en la que estás.
- Hay refs remotos obsoletos (`remotes/gh-main`, `remotes/gh-preprod`,
  `remotes/ghdirect/*`, `remotes/github/*`) sin un remote configurado que los
  respalde — son restos de una configuración anterior con más remotes.
  Ignóralos salvo que se reconfigure explícitamente un remote con ese nombre.
- Convención de ramas por ticket: `jordi/jme-<n>-<slug-en-castellano>`.
- Rama de integración de preprod: `preprod/assistent-esportiu-<fecha>`.
- Existe una rama `hotfix/rollup-lockfile`, pero el fix real de ese incidente
  (ver más abajo) se aplicó como commit directo tras el merge de la PR, no
  a través de esa rama — no asumas que las ramas `hotfix/*` están siempre
  en uso activo.
- **Estado a 2026-09-18**: en `preprod/assistent-esportiu-2026-09-02` hay dos
  archivos sin commitear (`SESSION_CONTEXT_HANDOFF.md`,
  `docs/backup-restore-runbook.md`) — trabajo en curso, no descartar.

## Entornos

### Preproducción — JMFsrv (servidor Linux gestionado vía `jmfsrv_mcp_server.py`)

- Stack: Docker Compose (`docker-compose.preprod.yml`) — servicios `postgres`
  (postgres:16-alpine), `migrations` (corre una vez y sale), `api` (expuesta
  solo en `127.0.0.1:3000`), `web` (expuesta solo en `127.0.0.1:8088`).
- El proxy existente del servidor apunta a `127.0.0.1:8088`; la API nunca se
  publica directamente.
- Directorio de despliegue documentado: `/opt/assistent-esportiu`
  (`deploy/preprod/README.md`). El remote `origin` apunta a
  `/home/jordi/assistent-esportiu-preprod`. **No están verificados como la
  misma ruta** — confirmarlo en el servidor antes de desplegar, no asumir.
- Actualización:
  ```sh
  git pull --ff-only
  docker compose -f docker-compose.preprod.yml up -d --build
  docker compose -f docker-compose.preprod.yml ps
  curl http://127.0.0.1:3000/health
  ```
- `.env` se crea solo en el servidor a partir de `.env.example`, nunca en el
  repo. Postgres vive en un volumen Docker local en esta fase; antes del
  piloto se programará `pg_dump` diario fuera del volumen.

### Producción — Render

- Workspace Render: `JMF_Prod` (`tea-da8orl15efls73e6kp5g`), cuenta
  `jordi@medina.cat`.
- Configuración no secreta en `render.yaml`; secretos solo en el dashboard de
  Render, nunca en el repo.
- **Servicio API** — `assistentesportiu` (`srv-da8ovoijnfac73brht70`):
  Node, región Frankfurt, build `npm ci && npm run build --workspace
  @assistent-esportiu/api`, start `npm run start --workspace
  @assistent-esportiu/api`, health check `/health`. URL:
  `https://assistentesportiu.onrender.com`.
- **Servicio PWA** — `ssistentesportiu-app` (`srv-dabtr93tqb8s73di7hs0`):
  sitio estático, build `npm ci && npm run build --workspace
  @assistent-esportiu/web`, publica `apps/web/dist`. URL:
  `https://ssistentesportiu-app.onrender.com`.
  > ⚠️ La URL empieza por **`ssistentesportiu`** (sin la primera "a"), tal
  > cual está desplegada. No corregir el nombre sin actualizar a la vez
  > Render, DNS y CORS — está enlazado en `WEB_ORIGIN` de la API.
- **Base de datos** — `assistenDB`, PostgreSQL 18, Frankfurt. Plan de pago
  con backups/PITR pendiente de confirmar en el dashboard (ver JME-16 y
  `docs/backup-restore-runbook.md`); el plan gratuito de Render no incluye
  backups automáticos ni PITR.
- **Otro servicio en el mismo workspace, no relacionado con la app**:
  `pgAdmin-dpg-...` (`srv-dac1kbgjo6nc7399pqk0`), actualmente suspendido —
  es una utilidad de administración de la base de datos, no forma parte del
  MVP.
- **Dominio**: `app.sentmenat.cat` configurado y validado (JME-17, Done). Las
  URLs `*.onrender.com` siguen vivas como origen CORS / fallback.
- **Auto-deploy**: ambos servicios (API y PWA) tienen `autoDeploy` activado
  sobre la rama `main` — cualquier merge a `main` dispara un deploy a
  producción sin paso de aprobación manual en Render.
- **Variables de entorno**:
  - No secretas (en `render.yaml`): `NODE_VERSION=20`,
    `AI_BASE_URL=https://api.openai.com/v1`, `AI_MODEL=gpt-5-mini`,
    `WEB_ORIGIN=https://ssistentesportiu-app.onrender.com`,
    `VITE_API_URL=https://assistentesportiu.onrender.com` (en el build del
    sitio estático).
  - Secretas (solo Render dashboard / `.env` en servidor, nunca en el repo):
    `DATABASE_URL`, `JWT_SECRET`, `AI_API_KEY`, y además (según
    `.env.example`) `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`_KEY` (JME-35 ingesta de
    Drive, JME-30 sync de Calendar — cuenta de servicio dedicada, nunca la
    cuenta personal del coordinador), `DRIVE_FOLDER_ID`,
    `GOOGLE_CALENDAR_ID`, `RESEND_API_KEY`/`RESEND_FROM_EMAIL` (JME-44, email
    de preparación de entreno), `BOOTSTRAP_COORDINATOR_EMAILS`.
- **Proveedor de IA**: OpenAI, modelo `gpt-5-mini`. La petición **no debe
  incluir `temperature`** — enviarlo provoca `AI_PROVIDER_ERROR_400`.

## Incidente conocido: build failed por rollup

Error `Cannot find module @rollup/rollup-linux-x64-gnu` en el build de
`vite build` de `apps/web`, en ambos servicios de Render (2026-09-17). Es el
bug conocido de npm sobre dependencias opcionales
([npm/cli#4828](https://github.com/npm/cli/issues/4828)): `npm ci`/`npm
install` puede omitir binarios nativos opcionales de rollup si el lockfile no
tiene las entradas resueltas para esa plataforma, aunque el install termine
"sin errores". Reintentar el build no lo arregla. **Solución aplicada**:
regenerar `package-lock.json` desde cero (commit `c5c926b`) sin tocar ningún
`package.json`. Si reaparece, regenerar el lockfile, no solo reintentar.

## Linear

- Workspace: **Jmedinafruitos**, equipo `JME` (id
  `33fafbca-e145-446d-b5ce-37d724db04df`).
- Proyecto: **"Asistente de Coordinación Deportiva"**
  (`49925580-2317-4a1c-aaea-99c081ee4712`), lead Jordi, estado "Planned" a
  nivel de proyecto (aunque hay tickets ya "In Prod").
- `JME-1` a `JME-4` son las tarjetas de plantilla que crea Linear por
  defecto — no tienen relación con este proyecto, ignorarlas.
- **Flujo de estados personalizado** (no es el default de Linear): `Todo` →
  `In Progress` → `In Review` → `In Pre` (desplegado en preprod/JMFsrv) →
  `In Prod` (desplegado en Render) → `Done`. Además `Canceled` / `Duplicate`.
  El estado de Linear puede quedarse por detrás del deploy real — comprobar
  siempre rama/commit real además del estado del ticket.
- Snapshot a 2026-09-18: la mayoría de tickets recientes (`JME-34` a
  `JME-47` — ingesta de Drive, capas de periodización, UX de calendario de
  eventos, preparación de entreno con IA) están en `In Review`: implementados
  pero aún no promocionados a `In Pre`/`In Prod`.
- Los detalles funcionales de cada ticket viven en el propio ticket de
  Linear; no se duplican aquí ni en `SESSION_CONTEXT_HANDOFF.md`.

## Reglas de despliegue (resumen operativo)

1. Consultar este archivo + `SESSION_CONTEXT_HANDOFF.md` + `git status` /
   rama / último commit antes de tocar nada.
2. Secretos nunca en el repo ni en la documentación: solo Render Environment
   o `.env` local en el servidor.
3. No renombrar `ssistentesportiu-app` sin actualizar Render + DNS + CORS a
   la vez.
4. No enviar `temperature` en las peticiones al proveedor de IA.
5. Un merge a `main` despliega a producción automáticamente en ambos
   servicios de Render — tratar los merges a `main` con esa seriedad.
6. Antes de usar datos reales de pilotos: confirmar plan de pago + PITR en
   `assistenDB` (JME-16 sigue pendiente de esa confirmación manual en el
   dashboard).
7. Preprod (JMFsrv) es temporal, no es el destino final de producción — no
   tratar su configuración de backups (volumen Docker local) como
   suficiente a largo plazo.
