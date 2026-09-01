CREATE TABLE IF NOT EXISTS strategy_change_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_context_id UUID NOT NULL REFERENCES strategy_contexts(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL,
  proposed_content JSONB NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  proposed_by UUID NOT NULL REFERENCES users(id),
  confirmed_by UUID REFERENCES users(id),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS strategy_change_proposals_status_idx
  ON strategy_change_proposals (status, proposed_at DESC);
