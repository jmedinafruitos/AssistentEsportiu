-- Event ownership: by default the earliest-assigned active coach on the
-- team, reassignable by the coordinator (global_access) — a label for
-- "whose job this is" and a filter ("Els meus esdeveniments"), not a
-- change to who can edit an event (team access rules are unchanged).

-- team_assignments had no timestamp at all, so "earliest-assigned" can't
-- be recovered for existing rows — they all land on this migration's
-- now(), and the default-owner query breaks remaining ties by name.
-- Future assignments get a real creation time.
ALTER TABLE team_assignments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE team_events ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);

-- Backfill existing events from the same default-owner rule applied to
-- new ones going forward (see events.ts's resolveDefaultOwner).
UPDATE team_events te
SET owner_id = (
  SELECT u.id FROM team_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.team_id = te.team_id AND u.active = true
  ORDER BY ta.created_at ASC, u.name ASC LIMIT 1
)
WHERE te.owner_id IS NULL;
