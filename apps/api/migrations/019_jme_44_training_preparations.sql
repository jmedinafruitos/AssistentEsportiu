-- JME-44: AI-assisted training-session preparation, reviewed one
-- phase/exercise at a time, ending in a PDF emailed to the coach and
-- coordinators. One preparation per event; step order is derived at read
-- time from draft_content (see training-preparation.ts), not stored.

CREATE TABLE IF NOT EXISTS training_preparations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_event_id UUID NOT NULL UNIQUE REFERENCES team_events(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting', 'ready', 'sent')),
  -- Same shape as team_records.content for record_type='training'
  -- (docs/ficha-entreno-schema.md, JME-42).
  draft_content JSONB NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  -- Audit trail of every refine round: [{role, section, instruction, createdAt}].
  messages JSONB NOT NULL DEFAULT '[]',
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
