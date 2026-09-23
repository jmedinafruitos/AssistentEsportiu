import { Queryable } from "./db.js";

// JME-54: default owner for a newly-created event — the earliest-assigned
// active coach on the team (team_assignments.created_at, name as
// tie-break for the pre-existing rows that all share the same backfill
// timestamp). Returns null for a team with no active assigned coach
// (owner_id is nullable for exactly this case).
export async function resolveDefaultOwner(client: Queryable, teamId: string): Promise<string | null> {
  const result = await client.query(
    `SELECT u.id FROM team_assignments ta JOIN users u ON u.id = ta.user_id
     WHERE ta.team_id = $1 AND u.active = true
     ORDER BY ta.created_at ASC, u.name ASC LIMIT 1`,
    [teamId],
  );
  return result.rowCount ? (result.rows[0] as { id: string }).id : null;
}

// Seeds a new event's checklist from the most specific active
// event_type_actions template (team beats category beats club — exclusive,
// not additive, since a single event shouldn't stack three scopes at once).
export async function materializeEventActions(
  client: Queryable,
  eventId: string,
  teamId: string,
  categoryId: string,
  eventType: "training" | "match" | "meeting",
) {
  const template = await client.query(
    `SELECT scope, label, content, sort_order
     FROM event_type_actions
     WHERE active = true AND event_type = $1
       AND (
         (scope = 'team' AND team_id = $2)
         OR (scope = 'category' AND category_id = $3)
         OR (scope = 'club')
       )
     ORDER BY sort_order`,
    [eventType, teamId, categoryId],
  );
  const rows = template.rows as Array<{ scope: string; label: string; content: unknown; sort_order: number }>;
  const winningScope = ["team", "category", "club"].find((scope) => rows.some((row) => row.scope === scope));
  const applicable = rows.filter((row) => row.scope === winningScope);

  const inserted = [];
  for (const action of applicable) {
    const result = await client.query(
      `INSERT INTO team_event_actions (team_event_id, label, content, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, label, content, sort_order, completed_at`,
      [eventId, action.label, action.content, action.sort_order],
    );
    inserted.push(result.rows[0]);
  }
  return inserted;
}
