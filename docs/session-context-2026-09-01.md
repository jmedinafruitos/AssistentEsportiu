# Context de continuïtat — Assistent Esportiu

Data de captura: 2026-09-01
Projecte: Asistente de Coordinación Deportiva — Hoquei Club Sentmenat

## Sessió original recuperada

- Nom de la sessió Codex: `Asistente deportivo de hockey`
- ID: `01a00ebc-1127-7dd1-a39a-b043e2327eb1`
- Repositori de treball actual: `/Users/jordi/GitHub/AssistentEsportiu`
- Antic espai de treball i documents: `/Users/jordi/Documents/Codex/2026-08-17/realtime-voice-chat`

## Objectiu del producte

PWA privada per a entrenadors i coordinació esportiva del HC Sentmenat. Inclou context esportiu jerarquitzat, conversa amb IA, planificació d'equip, registre d'entrenaments i partits, supervisió de coordinació, veu i resultats consultables.

## Context esportiu recuperat

Categories: Escoleta, Prebenjamí, Benjamí, Aleví i Infantil.

Estructura acordada per als entrenaments de 60 minuts:

| Bloc | Durada | Finalitat |
|---|---:|---|
| Escalfament | 10 min | Patinatge i reforç de conducció de bola |
| Reforç | 15 min | Repetir un contingut anterior, prioritzant mancances observades |
| Nou concepte | 20 min | Introduir un únic contingut nou |
| Partit amb objectiu | 15 min | Aplicar el reforç o el contingut nou amb una consigna observable |

La planificació de setembre de 2026 per a Prebenjamí i Benjamí ja va ser preparada. La validació mensual següent prevista era octubre.

## Documents existents

- `output/docx/Objectius_primer_trimestre_Prebenjami.docx`
- `output/docx/Objectius_primer_trimestre_Benjami.docx`
- `output/docx/Estructura_i_planificacio_primer_trimestre.docx`
- `output/markdown/Estructura_i_planificacio_primer_trimestre.md`
- `output/pdf/Estructura_i_planificacio_primer_trimestre.pdf`

Els fitxers són dins de `/Users/jordi/Documents/Codex/2026-08-17/realtime-voice-chat/`.

## Estat Git verificat

- Branca activa en capturar aquest context: `jordi/jme-8-validar-el-mvp-con-un-equipo-piloto`
- HEAD: `a77067a test: add repeatable MVP pilot validation for JME-8`
- L'arbre de treball estava net abans de crear aquest document.
- La pila local estava 13 commits per davant de `origin/main`.
- `origin/main`: `94df27d fix: use isolated HC Sentmenat logo asset`
- El remot `origin` apunta a `jmfsrv:/home/jordi/assistent-esportiu-preprod`, no a GitHub.

Pila funcional local:

- JME-14: `5bbb87c`
- JME-7: `ef92d59`
- JME-9: `b3e6f11`
- JME-10: `95b4e1c`
- JME-11: `1c7aca9`
- JME-12: `26890b0`
- JME-13: `0eaa876`
- JME-15: `53ae629`
- JME-8: `a77067a`

## Estat Linear verificat

Projecte Linear: `Asistente de Coordinación Deportiva`
Equip: `Jmedinafruitos` (`JME`)
Estat del projecte: `Planned`

Tiquets a `In Pre`:

- JME-5 — Definir el contexto deportivo común del club
- JME-6 — Configurar datos centrales de club, usuarios y equipos

Tiquets a `In Progress`:

- JME-7 — Integrar una capa de IA configurable y protegida
- JME-8 — Validar el MVP con un equipo piloto
- JME-9 — Crear la experiencia móvil conversacional
- JME-10 — Registrar entrenamientos y partidos a nivel de equipo
- JME-11 — Dar al coordinador visión global y control de cambios
- JME-12 — Habilitar planificación colectiva de temporada y entrenamientos
- JME-13 — Incorporar interacción por voz y resultados consultables
- JME-14 — Configurar servidor online y entorno base del MVP
- JME-15 — Distribuir la app móvil como PWA privada

No es va modificar cap estat de Linear durant la revisió.

## Què falta per passar a In Pre

Bloquejos comuns:

1. Instal·lar dependències i executar `build`, `typecheck` i totes les proves.
2. Publicar o integrar la pila de commits a preproducció.
3. Desplegar API, PWA i migracions PostgreSQL.
4. Executar proves integrades a l'entorn desplegat.
5. Registrar evidències de validació a Linear.

Validacions específiques:

- JME-7: `/v1/chat`, permisos, context i protecció de credencials.
- JME-9: experiència mòbil desplegada per a entrenador i coordinador.
- JME-10: creació/consulta de registres i ús del seu historial per la IA.
- JME-11: visió global i confirmació explícita dels canvis.
- JME-12: planificació versionada i context de la IA.
- JME-13: dictat i síntesi de veu en iOS i Android físics.
- JME-14: servidor, migracions, base de dades, secrets, logs, còpies i accés mòbil.
- JME-15: instal·lació, actualització i autenticació de la PWA en iOS i Android.
- JME-8: pilot real amb usuaris; ha de validar el conjunt al final.

Ordre recomanat: JME-14 → JME-7 → JME-9/10/11/12 → JME-13/15 → JME-8.

## Resultat de comprovacions locals

- `npm test` a l'arrel no existeix com a script.
- `npm run build` no es va poder executar perquè no hi havia dependències instal·lades i `tsc` no estava disponible.
- Scripts disponibles: `dev:api`, `dev:web`, `build`, `typecheck`, `test:pilot`.
- No es van instal·lar dependències ni es van modificar fitxers per resoldre-ho.

## JMFsrv

- Adreça correcta indicada per l'usuari: `jordi@100.87.69.72`
- Ruta prevista: `/home/jordi/assistent-esportiu-preprod`
- L'intent SSH a `100.87.69.72:22` va expirar.
- La comanda `tailscale` no estava disponible al Mac des d'on es va fer la comprovació.
- No es va poder validar la branca desplegada, els contenidors, `/health`, la PWA ni les migracions.

## Següent acció recomanada

Recuperar connectivitat amb JMFsrv/Tailscale. Després, inspeccionar l'estat del servidor sense modificar-lo, instal·lar i validar les dependències localment, desplegar la pila en l'ordre indicat i passar a `In Pre` únicament els tiquets amb evidència satisfactòria.

## Instrucció per reprendre

En una sessió nova, demanar: «Llegeix `docs/session-context-2026-09-01.md` del repositori AssistentEsportiu i continua des del següent pas recomanat».
