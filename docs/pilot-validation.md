# Validació del pilot MVP

Equip recomanat: **Benjamí 2026/2027**, amb un entrenador i un coordinador.

## Prova automatitzada

La primera execució és de només lectura:

```bash
PILOT_API_URL=https://assistentesportiu.onrender.com \
PILOT_EMAIL=correu-autoritzat \
PILOT_TEAM=Benjamín \
node apps/api/tests/pilot-mvp.mjs
```

Afegir `PILOT_CONFIRM_WRITES=yes` només quan es vulgui crear el registre de
validació identificat explícitament com a pilot.

## Acceptació manual

- Instal·lar la PWA des de l'enllaç privat en un iPhone i un Android.
- Entrar com a entrenador i comprovar que només apareixen els equips autoritzats.
- Crear o actualitzar la planificació de temporada.
- Registrar un entrenament i un partit, i consultar-ne l'historial.
- Fer una consulta escrita i una consulta dictada; escoltar una resposta.
- Entrar com a coordinador, revisar tots els equips i l'activitat anterior.
- Proposar un canvi de context, comprovar que no s'aplica abans de confirmar-lo,
  confirmar-lo i revisar-ne la versió/auditoria.
- Tancar i reobrir la PWA, i verificar que rep una nova versió sense reinstal·lar.

El pilot només es considera validat quan un entrenador i un coordinador han
completat aquesta llista en el desplegament de producció i no queden incidències
bloquejants.
