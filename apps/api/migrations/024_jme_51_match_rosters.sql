-- JME-51: convocatòria (call-up list) per match. A row where the
-- player's own team differs from the event's team is a guest/loan —
-- computed at read time, not stored, since a player's home team can
-- change over the season.
CREATE TABLE IF NOT EXISTS match_rosters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_event_id UUID NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  added_by UUID REFERENCES users(id),
  -- Set when someone knowingly added a player despite the soft 3h
  -- away-gap warning (JME-51's conflict engine) — the hard same-slot
  -- rule has no override, so this only ever reflects the 3h case.
  conflict_override BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_event_id, player_id)
);

CREATE INDEX IF NOT EXISTS match_rosters_player_idx ON match_rosters (player_id);
CREATE INDEX IF NOT EXISTS match_rosters_event_idx ON match_rosters (team_event_id);
