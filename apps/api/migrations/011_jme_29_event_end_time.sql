-- JME-29 follow-up: events need an end time so the UI can show duration
-- (e.g. "19:30-20:30") instead of only a start instant.
ALTER TABLE team_events
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
