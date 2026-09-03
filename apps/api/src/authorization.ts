import { Queryable } from "./db.js";

export async function hasTeamAccess(db: Queryable, userId: string, teamId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))`,
    [userId, teamId],
  );
  return Boolean(result.rowCount);
}

// Same access check as hasTeamAccess, but also returns the team's
// category_id for call sites that need it right after (event creation,
// recurring-training generation) — avoids a second round trip.
export async function teamAccessCategory(db: Queryable, userId: string, teamId: string): Promise<string | null> {
  const result = await db.query(
    `SELECT t.category_id FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))`,
    [userId, teamId],
  );
  return result.rowCount ? (result.rows[0] as { category_id: string }).category_id : null;
}

export async function hasEventAccess(db: Queryable, userId: string, teamId: string, eventId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     JOIN team_events te ON te.id = $3 AND te.team_id = t.id
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))`,
    [userId, teamId, eventId],
  );
  return Boolean(result.rowCount);
}

export async function isGlobalAccess(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM users WHERE id = $1 AND active = true AND global_access = true",
    [userId],
  );
  return Boolean(result.rowCount);
}
