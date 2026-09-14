# Ficha d'entreno — contracte de `team_records.content` (JME-42)

No hi ha migració d'esquema: `team_records.content` ja és `JSONB`
(vegeu JME-10 / migració `001_initial.sql`). Aquest document fixa el
contracte per a `record_type = 'training'`, a partir de la plantilla
real que fa servir Paco González (`Ficha entreno.jpeg`).

Els noms de camp són camelCase per coherència amb la resta de l'API
(`nextObjectives`, `startsAt`, ...); entre parèntesis, el concepte
original de la fitxa en paper.

```jsonc
{
  // Cabecera
  "sessionNumber": 12,          // número de sessió, o null
  "coach": "Biel Cordón",       // entrenador responsable, o null
  "notes": "...",               // notes lliures, o null

  // Activación — la fitxa en paper té una línia de text per a cada fase
  // d'activació, no una simple casella; per això cada camp és una
  // descripció opcional, no un booleà.
  "activation": {
    "prevencion": "Mobilitat de turmell i genoll",
    "activacionPorteros": "...",
    "activacionJugadores": "...",
    "integrado": "...",
    "participativo": "..."
  },

  // Fins a 3 blocs, en l'ordre en què es fan a la sessió.
  "blocks": [
    {
      "orderIndex": 0,
      "description": "Circuit de conducció + xut",
      "exerciseId": "…-uuid-…",     // opcional — referència a exercises (JME-41)
      "diagramAssetUrl": "https://…" // opcional — vegeu nota més avall
    }
  ]
}
```

Per a `record_type = 'match'` el contracte no canvia (JME-10):
`{ summary, outcome, nextObjectives }`.

## Diagrama de pista (`diagramAssetUrl`)

JME-42 diu explícitament "no es vectoritza en aquesta fase" — i aquesta
app tampoc té encara cap magatzem d'imatges/fitxers (no hi ha S3,
Cloudinary, ni cap endpoint d'upload). Per això `diagramAssetUrl` és,
de moment, un enllaç extern que l'entrenador enganxa (per exemple, una
foto pujada a Drive o Fotos) — no un upload real des de l'app. Afegir
upload real és un canvi d'infraestructura fora de l'abast d'aquest
tiquet.

## Validació

`POST /v1/teams/:teamId/records` valida el body amb un
`z.discriminatedUnion("type", …)` a `apps/api/src/index.ts`: la forma
`training` exigeix com a mínim un bloc amb `description`; la resta de
camps són opcionals. Màxim 3 blocs.
