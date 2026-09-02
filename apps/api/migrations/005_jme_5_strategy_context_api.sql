-- JME-5: versioned strategy maintenance with a complete audit trail.
ALTER TABLE strategy_contexts
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS strategy_context_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_context_id UUID NOT NULL REFERENCES strategy_contexts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content JSONB NOT NULL,
  active BOOLEAN NOT NULL,
  changed_by UUID NOT NULL REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (strategy_context_id, version)
);

CREATE INDEX IF NOT EXISTS strategy_context_revisions_context_idx
  ON strategy_context_revisions (strategy_context_id, version DESC);
