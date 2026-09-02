ALTER TABLE team_plans ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS team_plans_team_season_idx ON team_plans (team_id, season);
