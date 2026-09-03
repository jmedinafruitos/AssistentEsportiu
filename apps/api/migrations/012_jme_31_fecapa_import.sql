-- JME-31: official match import from FECAPA.

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS virtual BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fecapa_idc INTEGER,
  ADD COLUMN IF NOT EXISTS fecapa_team_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS teams_fecapa_team_idx
  ON teams (fecapa_idc, fecapa_team_id)
  WHERE fecapa_idc IS NOT NULL;

-- FECAPA-sourced matches aren't created by a user, and need a stable key
-- to upsert against on every sync without duplicating rows.
ALTER TABLE team_events
  ADD COLUMN IF NOT EXISTS external_ref TEXT,
  ALTER COLUMN created_by DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS team_events_team_external_ref_idx
  ON team_events (team_id, external_ref);

-- Real base teams: coach, training schedule and strategy of their own.
UPDATE teams SET fecapa_idc = 4811, fecapa_team_id = 11697 WHERE name = 'Benjamín' AND season = '2026/2027';
UPDATE teams SET fecapa_idc = 4814, fecapa_team_id = 11700 WHERE name = 'Prebenjamín' AND season = '2026/2027';
UPDATE teams SET fecapa_idc = 4789, fecapa_team_id = 11699 WHERE name = 'Alevín' AND season = '2026/2027';
UPDATE teams SET fecapa_idc = 4786, fecapa_team_id = 11703 WHERE name = 'Infantil A' AND season = '2026/2027';
UPDATE teams SET fecapa_idc = 4787, fecapa_team_id = 11702 WHERE name = 'Infantil B' AND season = '2026/2027';
UPDATE teams SET fecapa_idc = 4805, fecapa_team_id = 11704 WHERE name = 'FEM13' AND season = '2026/2027';
UPDATE teams SET fecapa_idc = 4803, fecapa_team_id = 11705 WHERE name = 'FEM15' AND season = '2026/2027';

-- Virtual teams: extra playing-time squads with a shifting, cross-team
-- roster. No fixed link to a single real team, so they get their own row
-- (own calendar, own matchday coach via team_assignments) instead of being
-- attached to one of the real teams above.
WITH virtual_teams(name, category_name, idc, fecapa_team_id) AS (
  VALUES
    ('Alevín Bronze', 'Alevín', 4791, 11698),
    ('Infantil Plata C', 'Infantil', 4787, 11701),
    ('Infantil Plata D', 'Infantil', 4787, 11706)
)
INSERT INTO teams (name, category_id, season, active, virtual, fecapa_idc, fecapa_team_id)
SELECT vt.name, c.id, '2026/2027', true, true, vt.idc, vt.fecapa_team_id
FROM virtual_teams vt
JOIN categories c ON c.name = vt.category_name
WHERE NOT EXISTS (
  SELECT 1 FROM teams t WHERE t.name = vt.name AND t.season = '2026/2027'
);
