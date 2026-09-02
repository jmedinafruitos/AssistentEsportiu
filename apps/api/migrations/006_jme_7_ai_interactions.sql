-- JME-7: auditable AI requests without storing provider credentials.
CREATE TABLE IF NOT EXISTS ai_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  team_id UUID NOT NULL REFERENCES teams(id),
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_interactions_team_created_idx
  ON ai_interactions (team_id, created_at DESC);
