-- JME-29: team calendar (matches, trainings, meetings) with coordinator-defined
-- action templates that resolve to a per-event, editable checklist.

CREATE TABLE IF NOT EXISTS team_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('training', 'match', 'meeting')),
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  location TEXT,
  notes TEXT,
  -- 'recurring' rows come from the training-template generator (JME-29),
  -- 'fecapa' is reserved for JME-31's official-match import.
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'recurring', 'fecapa')),
  canceled BOOLEAN NOT NULL DEFAULT false,
  google_calendar_event_id TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_events_team_starts_idx
  ON team_events (team_id, starts_at);

-- Coordinator-defined action templates. Resolution picks the most specific
-- active template for (event_type, team) — team beats category beats club —
-- same precedence idea as strategy_contexts' scope, but exclusive rather
-- than additive since a checklist shouldn't stack three scopes at once.
CREATE TABLE IF NOT EXISTS event_type_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('club', 'category', 'team')),
  category_id UUID REFERENCES categories(id),
  team_id UUID REFERENCES teams(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('training', 'match', 'meeting')),
  label TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_type_actions_lookup_idx
  ON event_type_actions (event_type, scope, team_id, category_id)
  WHERE active = true;

-- Materialized, per-event checklist. Seeded from event_type_actions when the
-- event is created, then freely editable per event without touching the
-- template (add/remove/relabel, mark complete).
CREATE TABLE IF NOT EXISTS team_event_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_event_id UUID NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_event_actions_event_idx
  ON team_event_actions (team_event_id, sort_order);

-- A team_record may optionally reference the event it documents; not every
-- event gets one, and not every record needs to come from a planned event.
ALTER TABLE team_records
  ADD COLUMN IF NOT EXISTS team_event_id UUID REFERENCES team_events(id);
