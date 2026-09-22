-- JME-48: syncFecapaCalendars used to key ON CONFLICT on the exact
-- external_ref (idc:homeId:awayId:gamedate). A FECAPA correction (date
-- shift by a day, or home/away swapped in their own publication) changes
-- that key, so the sync inserted a phantom duplicate instead of updating
-- the existing row. Found in prod: 11 duplicate pairs across 7 teams, all
-- with the same signature — the row still receiving updated_at on every
-- sync is the live one; the other froze on an earlier sync and is stale.

-- One-off cleanup: cancel the stale half of every existing duplicate pair.
-- "Last published wins": the row with the earlier updated_at is the one
-- FECAPA has since corrected away from.
WITH parsed AS (
  SELECT
    id, team_id, updated_at,
    split_part(external_ref, ':', 1) AS idc,
    LEAST(split_part(external_ref, ':', 2)::int, split_part(external_ref, ':', 3)::int) AS id_a,
    GREATEST(split_part(external_ref, ':', 2)::int, split_part(external_ref, ':', 3)::int) AS id_b,
    to_date(split_part(external_ref, ':', 4), 'YYYYMMDD') AS gamedate
  FROM team_events
  WHERE event_type = 'match' AND source = 'fecapa' AND canceled = false
),
stale AS (
  SELECT p1.id
  FROM parsed p1
  JOIN parsed p2 ON p1.team_id = p2.team_id AND p1.idc = p2.idc
    AND p1.id_a = p2.id_a AND p1.id_b = p2.id_b
    AND p1.id <> p2.id
    AND abs(p1.gamedate - p2.gamedate) <= 3
    AND p1.updated_at < p2.updated_at
)
UPDATE team_events
SET canceled = true, updated_at = now()
WHERE id IN (SELECT id FROM stale);

-- Allow a future sync to reuse an external_ref that only a now-canceled
-- row still holds (e.g. FECAPA reverting back to a previously-corrected
-- date), instead of tripping the uniqueness check against dead rows.
DROP INDEX IF EXISTS team_events_team_external_ref_idx;

CREATE UNIQUE INDEX IF NOT EXISTS team_events_team_external_ref_idx
  ON team_events (team_id, external_ref)
  WHERE canceled = false;
