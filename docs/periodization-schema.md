# Esquema de periodització (capa 2) — dins de `strategy_contexts.content` (JME-40)

> **Nota (JME-57/59):** `progression` (sessió → content_taxonomy →
> status) segueix llegint-se (és un pla estàtic), però el prompt de la
> IA ara prioritza la cobertura *real* derivada de `team_records`
> (`apps/api/src/content-coverage.ts`, contra el nou catàleg
> `content_taxonomy`) per sobre d'aquest pla — vegeu `contextPrompt` a
> `apps/api/src/training-preparation.ts`. `trimesters` i `weekly_grid`
> segueixen vius i sense canvis.

Sense migració d'esquema — `content` ja és `JSONB` (migracions 001/002).
Aquest document fixa el següent nivell de detall que sí existeix als
documents reals de Drive (*Ejemplo estructura pre-benjamin.pdf*,
*TÈCNICA PERIODITZACIÓ TOTAL DELS CONTINGUTS.docx*) però que encara no
té un lloc fix dins de `content`: trimestres, la graella setmanal
dia×bloc×durada, i la progressió de continguts per sessió.

Viu sota la clau `periodization`. Claus en **snake_case**, seguint la
convenció ja establerta per `club-strategy-v1` (migració 002:
`club_name`, `category_cycle`, `source_hierarchy_rule`, ...) — no el
camelCase dels bodies de l'API HTTP, que és una convenció diferent.

```jsonc
{
  // ... claus existents (club_name, category_cycle, content_blocks, ...) ...
  "periodization": {
    "trimesters": [
      { "index": 1, "label": "1r trimestre", "starts_in": "September", "ends_in": "December" },
      { "index": 2, "label": "2n trimestre", "starts_in": "January", "ends_in": "March" },
      { "index": 3, "label": "3r trimestre", "starts_in": "April", "ends_in": "June" }
    ],
    // Una graella per nivell — la mateixa categoria pot tenir un grup
    // "básico" i un "avanzado" amb continguts setmanals diferents.
    "weekly_grid": {
      "basico": [
        { "weekday": "Monday", "content_area": "Patinaje", "duration_minutes": 20, "detail": "Frenades i girs bàsics" }
      ],
      "avanzado": [
        { "weekday": "Monday", "content_area": "Táctica individual", "duration_minutes": 15, "detail": "1x1 amb superioritat" }
      ]
    },
    // Seqüència de sessions (1..N) i, per a cada una, quin contingut es
    // treballa i en quin estat.
    "progression": [
      { "session_number": 1, "content_taxonomy": "Dominio de bola", "status": "introducido" },
      { "session_number": 5, "content_taxonomy": "Dominio de bola", "status": "reforzado" }
    ]
  }
}
```

`status` és `"introducido"` o `"reforzado"`.

## Ús pel generador de propostes (JME-38)

`strategy-proposals.ts` rep aquest esquema al prompt quan el document
d'origen és de capa `estructura` (programació oficial), perquè les
seves propostes escriguin sota `periodization.*` amb aquesta forma en
lloc d'inventar una estructura diferent cada vegada. No canvia res per
a documents de capa `principios`/`recursos` (fonts complementàries).
