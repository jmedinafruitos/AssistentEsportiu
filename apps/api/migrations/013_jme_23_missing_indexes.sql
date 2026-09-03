-- JME-23: team_records and strategy_contexts were missed when
-- strategy_context_revisions and ai_interactions got their equivalent
-- indexes in migrations 005/006.

CREATE INDEX IF NOT EXISTS team_records_team_happened_idx
  ON team_records (team_id, happened_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS strategy_contexts_active_category_idx
  ON strategy_contexts (category_id)
  WHERE active = true AND category_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS strategy_contexts_active_team_idx
  ON strategy_contexts (team_id)
  WHERE active = true AND team_id IS NOT NULL;
