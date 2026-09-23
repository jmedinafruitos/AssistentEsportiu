-- JME-50: home/away flag, needed by the match-roster conflict engine
-- (JME-51) to know when the 3h away-gap rule applies. FECAPA already
-- resolves this per match (homeId/awayId vs the team's own
-- fecapa_team_id, see fecapa.ts) but never persisted it — only the
-- free-text title carried the information. Backfill is automatic: the
-- next sync now writes is_home on both insert and update (JME-48's
-- find-or-create already updates every tracked row in place).
ALTER TABLE team_events ADD COLUMN IF NOT EXISTS is_home BOOLEAN;
