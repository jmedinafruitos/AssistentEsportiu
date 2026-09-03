-- JME-33: recurring training series with editable this/following/all
-- semantics, and a holiday calendar to skip when generating occurrences.

CREATE TABLE IF NOT EXISTS team_training_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL DEFAULT 'Entrenament',
  weekdays SMALLINT[] NOT NULL,
  time TEXT NOT NULL,
  duration_minutes INTEGER,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_training_series_team_idx
  ON team_training_series (team_id)
  WHERE active = true;

ALTER TABLE team_events
  ADD COLUMN IF NOT EXISTS training_series_id UUID REFERENCES team_training_series(id),
  -- Set when an occurrence is edited individually ("only this event"), so a
  -- later series-level edit (this-and-following / all) knows to leave it
  -- alone instead of silently overwriting a deliberate one-off change.
  ADD COLUMN IF NOT EXISTS overridden BOOLEAN NOT NULL DEFAULT false,
  -- Set when a series edit supersedes a future occurrence. Rows are never
  -- deleted — team_records.team_event_id has no ON DELETE CASCADE, and
  -- archiving preserves history instead of rewriting it.
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS team_events_series_idx
  ON team_events (training_series_id)
  WHERE training_series_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS holidays (
  date DATE PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('nacional', 'catalunya'))
);

-- Season 2026/2027 (01/09/2026-30/06/2027), sourced from the official
-- Generalitat de Catalunya calendars (treball.gencat.cat). Municipalities
-- may add up to 2 local holidays on top of this — Sentmenat's specific
-- ones aren't included here, they weren't available to source.
INSERT INTO holidays (date, name, scope) VALUES
  ('2026-09-11', 'Diada Nacional de Catalunya', 'catalunya'),
  ('2026-10-12', 'Festa Nacional d''Espanya', 'nacional'),
  ('2026-11-01', 'Tots Sants', 'nacional'),
  ('2026-12-06', 'Dia de la Constitució', 'nacional'),
  ('2026-12-08', 'Immaculada Concepció', 'nacional'),
  ('2026-12-25', 'Nadal', 'nacional'),
  ('2026-12-26', 'Sant Esteve', 'catalunya'),
  ('2027-01-01', 'Any Nou', 'nacional'),
  ('2027-01-06', 'Reis', 'nacional'),
  ('2027-03-26', 'Divendres Sant', 'nacional'),
  ('2027-03-29', 'Dilluns de Pasqua Florida', 'catalunya'),
  ('2027-05-01', 'Festa del Treball', 'nacional'),
  ('2027-06-24', 'Sant Joan', 'catalunya')
ON CONFLICT (date) DO NOTHING;
