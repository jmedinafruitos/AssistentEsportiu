import { Queryable } from "./db.js";

// JME-51: a player can't be in two matches too close together. The rule
// is stricter (3h, start-to-start) whenever either match is an away game
// for its own team — otherwise a 60-minute gap is enough to catch two
// matches scheduled at essentially the same slot. See JME-50 for is_home.
const SAME_SLOT_GAP_MINUTES = 60;
const AWAY_GAP_MINUTES = 180;

export type ConflictDetail = {
  conflictType: "same_slot" | "away_gap";
  conflictingMatch: { teamName: string; title: string; startsAt: string; isHome: boolean | null };
  requiredGapMinutes: number;
  actualGapMinutes: number;
};

type ConflictCheckResult = { conflict: null } | { conflict: ConflictDetail; hard: boolean };

// A same-slot conflict, when found, is returned immediately (it's a hard
// block — no point comparing further). Away-gap conflicts are soft, so we
// keep scanning and surface the first one found; a player is expected to
// have at most one other match anywhere near this one in practice.
export async function checkRosterConflict(db: Queryable, playerId: string, targetEventId: string): Promise<ConflictCheckResult> {
  const target = await db.query(`SELECT starts_at, is_home FROM team_events WHERE id = $1`, [targetEventId]);
  if (!target.rowCount) throw new Error("EVENT_NOT_FOUND");
  const targetRow = target.rows[0] as { starts_at: string; is_home: boolean | null };

  const others = await db.query(
    `SELECT te.title, te.starts_at, te.is_home, t.name AS team_name
     FROM match_rosters mr
     JOIN team_events te ON te.id = mr.team_event_id
     JOIN teams t ON t.id = te.team_id
     WHERE mr.player_id = $1 AND te.id <> $2 AND te.canceled = false`,
    [playerId, targetEventId],
  );

  let softConflict: ConflictDetail | null = null;
  for (const other of others.rows as Array<{ title: string; starts_at: string; is_home: boolean | null; team_name: string }>) {
    const eitherAway = targetRow.is_home === false || other.is_home === false;
    const requiredGapMinutes = eitherAway ? AWAY_GAP_MINUTES : SAME_SLOT_GAP_MINUTES;
    const actualGapMinutes = Math.abs(new Date(targetRow.starts_at).getTime() - new Date(other.starts_at).getTime()) / 60_000;
    if (actualGapMinutes >= requiredGapMinutes) continue;
    const detail: ConflictDetail = {
      conflictType: eitherAway ? "away_gap" : "same_slot",
      conflictingMatch: { teamName: other.team_name, title: other.title, startsAt: other.starts_at, isHome: other.is_home },
      requiredGapMinutes,
      actualGapMinutes: Math.round(actualGapMinutes),
    };
    if (!eitherAway) return { conflict: detail, hard: true };
    if (!softConflict) softConflict = detail;
  }
  return softConflict ? { conflict: softConflict, hard: false } : { conflict: null };
}

export type RosterEntry = {
  id: string; player_id: string; player_name: string;
  player_team_id: string; player_team_name: string;
  is_guest: boolean; conflict_override: boolean; created_at: string;
};

export async function listRoster(db: Queryable, eventId: string): Promise<RosterEntry[]> {
  const result = await db.query(
    `SELECT mr.id, mr.player_id, p.name AS player_name, p.team_id AS player_team_id, t.name AS player_team_name,
            (p.team_id <> te.team_id) AS is_guest, mr.conflict_override, mr.created_at
     FROM match_rosters mr
     JOIN players p ON p.id = mr.player_id
     JOIN teams t ON t.id = p.team_id
     JOIN team_events te ON te.id = mr.team_event_id
     WHERE mr.team_event_id = $1
     ORDER BY is_guest ASC, p.name ASC`,
    [eventId],
  );
  return result.rows as RosterEntry[];
}

export type AddRosterResult =
  | { status: "added"; entry: RosterEntry }
  | { status: "already_in_roster" }
  | { status: "blocked"; conflict: ConflictDetail }
  | { status: "needs_confirmation"; conflict: ConflictDetail };

export async function addPlayerToRoster(
  db: Queryable, eventId: string, playerId: string, addedBy: string, acceptOverride: boolean,
): Promise<AddRosterResult> {
  const existing = await db.query(`SELECT 1 FROM match_rosters WHERE team_event_id = $1 AND player_id = $2`, [eventId, playerId]);
  if (existing.rowCount) return { status: "already_in_roster" };

  const check = await checkRosterConflict(db, playerId, eventId);
  if (check.conflict) {
    if (check.hard) return { status: "blocked", conflict: check.conflict };
    if (!acceptOverride) return { status: "needs_confirmation", conflict: check.conflict };
  }
  const override = Boolean(check.conflict && !check.hard && acceptOverride);

  await db.query(
    `INSERT INTO match_rosters (team_event_id, player_id, added_by, conflict_override) VALUES ($1, $2, $3, $4)`,
    [eventId, playerId, addedBy, override],
  );
  const [entry] = await listRoster(db, eventId).then((rows) => rows.filter((row) => row.player_id === playerId));
  return { status: "added", entry };
}

export type CopyFromPreviousResult = {
  added: Array<{ playerId: string; playerName: string }>;
  skipped: Array<{ playerName: string; reason: "conflict" }>;
};

// Only runs when the roster is still empty — avoids surprising re-copies
// once someone has started curating the list by hand. Players who'd
// conflict (either rule) aren't carried over silently; the 3h risk
// decision belongs to a human via the normal add flow, not an automatic
// default.
export async function copyFromPreviousMatch(
  db: Queryable, teamId: string, eventId: string, addedBy: string,
): Promise<CopyFromPreviousResult> {
  const current = await db.query(`SELECT 1 FROM match_rosters WHERE team_event_id = $1 LIMIT 1`, [eventId]);
  if (current.rowCount) return { added: [], skipped: [] };

  const target = await db.query(`SELECT starts_at FROM team_events WHERE id = $1`, [eventId]);
  if (!target.rowCount) return { added: [], skipped: [] };
  const targetStartsAt = (target.rows[0] as { starts_at: string }).starts_at;

  const previousEvent = await db.query(
    `SELECT te.id FROM team_events te
     WHERE te.team_id = $1 AND te.event_type = 'match' AND te.canceled = false
       AND te.starts_at < $2 AND te.id <> $3
       AND EXISTS (SELECT 1 FROM match_rosters mr WHERE mr.team_event_id = te.id)
     ORDER BY te.starts_at DESC LIMIT 1`,
    [teamId, targetStartsAt, eventId],
  );

  // No earlier match has a roster yet — first match of the season, or the
  // very first roster ever built for this team. Bootstrap from the team's
  // own active players instead of leaving it empty. Naturally empty for
  // virtual teams, which have no players of their own (JME-49).
  const sourcePlayers = previousEvent.rowCount
    ? await db.query(
        `SELECT mr.player_id, p.name AS player_name FROM match_rosters mr JOIN players p ON p.id = mr.player_id WHERE mr.team_event_id = $1`,
        [(previousEvent.rows[0] as { id: string }).id],
      )
    : await db.query(`SELECT id AS player_id, name AS player_name FROM players WHERE team_id = $1 AND active = true`, [teamId]);

  const added: CopyFromPreviousResult["added"] = [];
  const skipped: CopyFromPreviousResult["skipped"] = [];
  for (const row of sourcePlayers.rows as Array<{ player_id: string; player_name: string }>) {
    const result = await addPlayerToRoster(db, eventId, row.player_id, addedBy, false);
    if (result.status === "added") added.push({ playerId: row.player_id, playerName: row.player_name });
    else if (result.status === "blocked" || result.status === "needs_confirmation") skipped.push({ playerName: row.player_name, reason: "conflict" });
  }
  return { added, skipped };
}
