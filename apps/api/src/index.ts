import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import Fastify from "fastify";
import { Pool, types } from "pg";
import { z } from "zod";
import { ConfigurableAiService } from "./ai.js";
import { hasEventAccess, hasTeamAccess, isGlobalAccess, teamAccessCategory } from "./authorization.js";
import { materializeEventActions } from "./events.js";
import { nextFecapaSyncAt, syncFecapaCalendars } from "./fecapa.js";
import { archiveFutureOccurrences, generateSeriesOccurrences, TrainingSeries } from "./training-series.js";

// Constant-effort placeholder hash so a request for an unknown or
// password-less email takes roughly as long as a real mismatch,
// instead of returning early and leaking which emails are registered.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("not-a-real-password", 10);

// pg defaults DATE columns (team_training_series.starts_on/ends_on,
// holidays.date) to JS Date objects. The rest of the app treats dates as
// plain 'YYYY-MM-DD' strings (request bodies, external_ref keys, etc.) —
// keep DATE columns consistent with that instead of silently mixing types.
types.setTypeParser(1082, (value) => value);

const env = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3000),
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_MODEL: z.string().min(1).default("gpt-5-mini"),
  WEB_ORIGIN: z.string().url().optional(),
}).parse(process.env);

const app = Fastify({ logger: true });
// Explicit rather than relying on pg's own default — a single web service
// instance at this club's scale (a few dozen concurrent users at most), well
// within any Render Postgres plan's connection limit. Revisit once JME-8's
// pilot shows real concurrency.
const db = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
const ai = new ConfigurableAiService({
  apiKey: env.AI_API_KEY,
  baseUrl: env.AI_BASE_URL,
  model: env.AI_MODEL,
});

await app.register(cors, { origin: env.WEB_ORIGIN ?? false });
await app.register(jwt, { secret: env.JWT_SECRET });
await app.register(helmet);
// Global baseline for every route; /v1/session and /v1/chat get tighter
// per-route limits below (brute-force and AI-cost concerns respectively).
// Keyed by IP rather than authenticated user — simpler and avoids relying
// on onRequest hook ordering between this plugin and our own jwtVerify
// hook, and is plenty at this club's scale (one coach per connection).
await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });

app.get("/health", async () => {
  await db.query("SELECT 1");
  return { status: "ok" };
});

app.get("/v1/me", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const identity = request.user as { sub: string };
  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.sport_role, u.global_access,
       COALESCE((
         SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'season', t.season) ORDER BY t.name)
         FROM teams t
         WHERE t.active = true
           AND (u.global_access OR EXISTS (
             SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
           ))
       ), '[]') AS teams
     FROM users u
     WHERE u.id = $1 AND u.active = true`,
    [identity.sub],
  );
  if (!result.rowCount) return replyNotFound();
  return result.rows[0];
});

const replyNotFound = () => ({ message: "User not found" });

app.get("/v1/teams", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const identity = request.user as { sub: string };
  const result = await db.query(
    `SELECT t.id, t.name, t.season, c.name AS category
     FROM users u
     JOIN teams t ON t.active = true
       AND (u.global_access OR EXISTS (
         SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
       ))
     JOIN categories c ON c.id = t.category_id
     WHERE u.id = $1 AND u.active = true
     ORDER BY t.name`,
    [identity.sub],
  );
  return { teams: result.rows };
});

app.get("/v1/teams/:teamId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const result = await db.query(
    `SELECT t.id, t.name, t.season, c.name AS category
     FROM users u
     JOIN teams t ON t.id = $2 AND t.active = true
       AND (u.global_access OR EXISTS (
         SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
       ))
     JOIN categories c ON c.id = t.category_id
     WHERE u.id = $1 AND u.active = true`,
    [identity.sub, teamId],
  );
  if (!result.rowCount) return reply.code(403).send({ message: "Forbidden" });
  return result.rows[0];
});

app.get("/v1/strategy-contexts", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const identity = request.user as { sub: string };
  const result = await db.query(
    `SELECT sc.id, sc.scope, sc.category_id, sc.team_id, sc.content, sc.active, sc.version, sc.updated_at,
       c.name AS category, t.name AS team
     FROM users u
     JOIN strategy_contexts sc ON sc.active = true
       AND (
         u.global_access
         OR sc.scope = 'club'
         OR (sc.category_id IS NOT NULL AND EXISTS (
           SELECT 1
           FROM team_assignments ta
           JOIN teams assigned_team ON assigned_team.id = ta.team_id
           WHERE ta.user_id = u.id AND assigned_team.category_id = sc.category_id
         ))
         OR (sc.team_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = sc.team_id
         ))
       )
     LEFT JOIN categories c ON c.id = sc.category_id
     LEFT JOIN teams t ON t.id = sc.team_id
     WHERE u.id = $1 AND u.active = true
     ORDER BY CASE sc.scope WHEN 'club' THEN 1 WHEN 'category' THEN 2 ELSE 3 END, c.name, t.name`,
    [identity.sub],
  );
  return { contexts: result.rows };
});

app.get("/v1/teams/:teamId/context", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const access = await db.query(
    `SELECT t.id, t.name, t.category_id
     FROM users u
     JOIN teams t ON t.id = $2 AND t.active = true
       AND (u.global_access OR EXISTS (
         SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
       ))
     WHERE u.id = $1 AND u.active = true`,
    [identity.sub, teamId],
  );
  if (!access.rowCount) return reply.code(403).send({ message: "Forbidden" });

  const team = access.rows[0] as { id: string; name: string; category_id: string };
  const contexts = await db.query(
    `SELECT id, scope, category_id, team_id, content, version, updated_at
     FROM strategy_contexts
     WHERE active = true
       AND (scope = 'club' OR category_id = $1 OR team_id = $2)
     ORDER BY CASE scope WHEN 'club' THEN 1 WHEN 'category' THEN 2 ELSE 3 END`,
    [team.category_id, team.id],
  );
  return { team: { id: team.id, name: team.name }, contexts: contexts.rows };
});

app.patch("/v1/strategy-contexts/:contextId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { contextId } = z.object({ contextId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    content: z.record(z.unknown()),
    version: z.number().int().positive(),
    confirm: z.literal(true),
  }).parse(request.body);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const actor = await client.query(
      "SELECT id FROM users WHERE id = $1 AND active = true AND global_access = true",
      [identity.sub],
    );
    if (!actor.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ message: "Forbidden" });
    }

    const current = await client.query(
      `SELECT id, content, active, version
       FROM strategy_contexts WHERE id = $1 FOR UPDATE`,
      [contextId],
    );
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Strategy context not found" });
    }
    const context = current.rows[0] as { id: string; content: unknown; active: boolean; version: number };
    if (context.version !== body.version) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ message: "Strategy context has changed", version: context.version });
    }

    await client.query(
      `INSERT INTO strategy_context_revisions
         (strategy_context_id, version, content, active, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [context.id, context.version, context.content, context.active, identity.sub],
    );
    const updated = await client.query(
      `UPDATE strategy_contexts
       SET content = $2, version = version + 1, updated_by = $3, updated_at = now()
       WHERE id = $1
       RETURNING id, scope, category_id, team_id, content, active, version, updated_at`,
      [context.id, body.content, identity.sub],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/coordinator/overview", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  const [teams, pending] = await Promise.all([
    db.query(
      `SELECT t.id, t.name, t.season, c.name AS category,
              count(DISTINCT ta.user_id)::int AS staff_count,
              count(DISTINCT tr.id)::int AS record_count,
              max(tr.happened_at) AS last_activity_at
       FROM teams t JOIN categories c ON c.id = t.category_id
       LEFT JOIN team_assignments ta ON ta.team_id = t.id
       LEFT JOIN team_records tr ON tr.team_id = t.id
       WHERE t.active = true
       GROUP BY t.id, c.name ORDER BY t.name`,
    ),
    db.query(
      `SELECT p.id, p.strategy_context_id, p.base_version, p.reason, p.proposed_at, u.name AS proposed_by_name
       FROM strategy_change_proposals p JOIN users u ON u.id = p.proposed_by
       WHERE p.status = 'pending' ORDER BY p.proposed_at DESC`,
    ),
  ]);
  return { teams: teams.rows, pendingProposals: pending.rows };
});

app.post("/v1/strategy-contexts/:contextId/proposals", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { contextId } = z.object({ contextId: z.string().uuid() }).parse(request.params);
  const body = z.object({ content: z.record(z.unknown()), version: z.number().int().positive(), reason: z.string().trim().min(3).max(1_000) }).parse(request.body);
  const result = await db.query(
    `INSERT INTO strategy_change_proposals
       (strategy_context_id, base_version, proposed_content, reason, proposed_by)
     SELECT sc.id, $3, $4, $5, u.id
     FROM users u JOIN strategy_contexts sc ON sc.id = $2
     WHERE u.id = $1 AND u.active = true AND u.global_access = true AND sc.version = $3
     RETURNING id, strategy_context_id, base_version, proposed_content, reason, status, proposed_at`,
    [identity.sub, contextId, body.version, body.content, body.reason],
  );
  if (!result.rowCount) return reply.code(409).send({ message: "Forbidden or strategy context has changed" });
  return reply.code(201).send(result.rows[0]);
});

app.post("/v1/strategy-change-proposals/:proposalId/confirm", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { proposalId } = z.object({ proposalId: z.string().uuid() }).parse(request.params);
  z.object({ confirm: z.literal(true) }).parse(request.body);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const proposal = await client.query(
      `SELECT p.*, sc.content AS current_content, sc.active, sc.version AS current_version
       FROM strategy_change_proposals p
       JOIN strategy_contexts sc ON sc.id = p.strategy_context_id
       JOIN users u ON u.id = $1 AND u.active = true AND u.global_access = true
       WHERE p.id = $2 AND p.status = 'pending' FOR UPDATE OF p, sc`,
      [identity.sub, proposalId],
    );
    if (!proposal.rowCount) { await client.query("ROLLBACK"); return reply.code(404).send({ message: "Pending proposal not found" }); }
    const item = proposal.rows[0];
    if (item.base_version !== item.current_version) {
      await client.query("UPDATE strategy_change_proposals SET status = 'superseded' WHERE id = $1", [proposalId]);
      await client.query("COMMIT");
      return reply.code(409).send({ message: "Strategy context has changed" });
    }
    await client.query(
      `INSERT INTO strategy_context_revisions (strategy_context_id, version, content, active, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [item.strategy_context_id, item.current_version, item.current_content, item.active, identity.sub],
    );
    const updated = await client.query(
      `UPDATE strategy_contexts SET content = $2, version = version + 1, updated_by = $3, updated_at = now()
       WHERE id = $1 RETURNING id, content, version, updated_at`,
      [item.strategy_context_id, item.proposed_content, identity.sub],
    );
    await client.query(
      `UPDATE strategy_change_proposals SET status = 'applied', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
      [proposalId, identity.sub],
    );
    await client.query("COMMIT");
    return { proposalId, context: updated.rows[0] };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

app.get("/v1/teams/:teamId/records", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const allowed = await hasTeamAccess(db, identity.sub, teamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  const result = await db.query(
    `SELECT tr.id, tr.record_type, tr.happened_at, tr.content, tr.created_at,
            u.name AS created_by_name
     FROM team_records tr JOIN users u ON u.id = tr.created_by
     WHERE tr.team_id = $1 ORDER BY tr.happened_at DESC, tr.created_at DESC LIMIT 100`,
    [teamId],
  );
  return { records: result.rows };
});

app.post("/v1/teams/:teamId/records", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    type: z.enum(["training", "match"]),
    happenedAt: z.string().datetime(),
    summary: z.string().trim().min(1).max(2_000),
    outcome: z.string().trim().max(500).optional(),
    nextObjectives: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  }).parse(request.body);
  const result = await db.query(
    `INSERT INTO team_records (team_id, record_type, happened_at, content, created_by)
     SELECT t.id, $3, $4, $5, u.id
     FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))
     RETURNING id, record_type, happened_at, content, created_at`,
    [identity.sub, teamId, body.type, body.happenedAt, {
      summary: body.summary, outcome: body.outcome ?? null, nextObjectives: body.nextObjectives,
    }],
  );
  if (!result.rowCount) return reply.code(403).send({ message: "Forbidden" });
  return reply.code(201).send(result.rows[0]);
});

app.get("/v1/teams/:teamId/plan", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const result = await db.query(
    `SELECT tp.id, tp.team_id, tp.season, tp.content, tp.version, tp.updated_at
     FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     LEFT JOIN team_plans tp ON tp.team_id = t.id AND tp.season = t.season
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))`,
    [identity.sub, teamId],
  );
  if (!result.rowCount) return reply.code(403).send({ message: "Forbidden" });
  return { plan: result.rows[0].id ? result.rows[0] : null };
});

app.put("/v1/teams/:teamId/plan", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    seasonObjectives: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
    nextTrainingObjectives: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    notes: z.string().trim().max(4_000).default(""),
    version: z.number().int().positive().optional(),
  }).parse(request.body);
  const result = await db.query(
    `INSERT INTO team_plans (team_id, season, content, created_by)
     SELECT t.id, t.season, $3, u.id
     FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))
     ON CONFLICT (team_id, season) DO UPDATE
       SET content = EXCLUDED.content, version = team_plans.version + 1, updated_at = now()
       WHERE $4::integer IS NOT NULL AND team_plans.version = $4
     RETURNING id, team_id, season, content, version, updated_at`,
    [identity.sub, teamId, {
      seasonObjectives: body.seasonObjectives,
      nextTrainingObjectives: body.nextTrainingObjectives,
      notes: body.notes,
    }, body.version ?? null],
  );
  if (!result.rowCount) return reply.code(body.version ? 409 : 403).send({ message: body.version ? "Plan has changed" : "Forbidden" });
  return result.rows[0];
});

app.get("/v1/teams/:teamId/events", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  // Paginated by week: callers pass the Monday/Sunday bounds of the week
  // they want (see weekBounds() on the frontend). Falls back to "from now"
  // with no upper bound for any caller that doesn't pass them.
  const query = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }).parse(request.query);
  const allowed = await hasTeamAccess(db, identity.sub, teamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  const result = await db.query(
    `SELECT id, event_type, title, starts_at, ends_at, location, notes, source, canceled, created_at,
            training_series_id, overridden
     FROM team_events
     WHERE team_id = $1
       AND archived_at IS NULL
       AND starts_at >= COALESCE($2::timestamptz, now() - interval '1 day')
       AND ($3::timestamptz IS NULL OR starts_at < $3::timestamptz)
     ORDER BY starts_at ASC LIMIT 200`,
    [teamId, query.from ?? null, query.to ?? null],
  );
  return { events: result.rows };
});

app.post("/v1/teams/:teamId/events", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    eventType: z.enum(["training", "match", "meeting"]),
    title: z.string().trim().min(1).max(200),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
    location: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(2_000).optional(),
  })
    .refine((value) => !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt), { message: "endsAt must be after startsAt" })
    .parse(request.body);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const categoryId = await teamAccessCategory(client, identity.sub, teamId);
    if (!categoryId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ message: "Forbidden" });
    }

    const event = await client.query(
      `INSERT INTO team_events (team_id, event_type, title, starts_at, ends_at, location, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, event_type, title, starts_at, ends_at, location, notes, source, canceled, created_at`,
      [teamId, body.eventType, body.title, body.startsAt, body.endsAt ?? null, body.location ?? null, body.notes ?? null, identity.sub],
    );
    const created = event.rows[0];
    const actions = await materializeEventActions(client, created.id, teamId, categoryId, body.eventType);
    await client.query("COMMIT");
    return reply.code(201).send({ event: created, actions });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/teams/:teamId/events/generate-trainings", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    title: z.string().trim().min(1).max(200).default("Entrenament"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Format HH:MM"),
    durationMinutes: z.number().int().min(1).max(600).optional(),
    from: z.string().date(),
    to: z.string().date(),
  })
    .refine((value) => new Date(`${value.to}T00:00:00Z`) >= new Date(`${value.from}T00:00:00Z`), { message: "to must be on or after from" })
    .refine(
      (value) => new Date(`${value.to}T00:00:00Z`).getTime() - new Date(`${value.from}T00:00:00Z`).getTime() <= 366 * 24 * 60 * 60 * 1000,
      { message: "Range too large (max ~1 year)" },
    )
    .parse(request.body);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const categoryId = await teamAccessCategory(client, identity.sub, teamId);
    if (!categoryId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ message: "Forbidden" });
    }

    const seriesResult = await client.query(
      `INSERT INTO team_training_series (team_id, title, weekdays, time, duration_minutes, starts_on, ends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, team_id, title, weekdays, time, duration_minutes, starts_on, ends_on`,
      [teamId, body.title, body.weekdays, body.time, body.durationMinutes ?? null, body.from, body.to, identity.sub],
    );
    const series = seriesResult.rows[0] as TrainingSeries;
    const created = await generateSeriesOccurrences(client, series, categoryId, new Date(`${body.from}T00:00:00Z`), identity.sub);
    await client.query("COMMIT");
    return reply.code(201).send({ series, created: created.length, events: created });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/teams/:teamId/training-series/:seriesId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, seriesId } = z.object({ teamId: z.string().uuid(), seriesId: z.string().uuid() }).parse(request.params);
  const allowed = await hasTeamAccess(db, identity.sub, teamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  const result = await db.query(
    `SELECT id, team_id, title, weekdays, time, duration_minutes, starts_on, ends_on, active
     FROM team_training_series WHERE id = $1 AND team_id = $2`,
    [seriesId, teamId],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "Series not found" });
  return result.rows[0];
});

// this-and-following / all edits to a recurring-training series. "Only this
// event" doesn't come through here — it's a plain PATCH on the event itself
// (see /v1/teams/:teamId/events/:eventId above), which sets `overridden`.
app.patch("/v1/teams/:teamId/training-series/:seriesId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, seriesId } = z.object({ teamId: z.string().uuid(), seriesId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    scope: z.enum(["following", "all"]),
    fromEventId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Format HH:MM").optional(),
    durationMinutes: z.number().int().min(1).max(600).nullable().optional(),
    endsOn: z.string().date().optional(),
  })
    .refine((value) => value.scope !== "following" || value.fromEventId, { message: "fromEventId required for scope=following" })
    .parse(request.body);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const categoryId = await teamAccessCategory(client, identity.sub, teamId);
    if (!categoryId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ message: "Forbidden" });
    }

    const currentResult = await client.query(
      `SELECT id, team_id, title, weekdays, time, duration_minutes, starts_on, ends_on
       FROM team_training_series WHERE id = $1 AND team_id = $2 AND active = true FOR UPDATE`,
      [seriesId, teamId],
    );
    if (!currentResult.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Series not found" });
    }
    const current = currentResult.rows[0] as TrainingSeries;

    if (body.scope === "following") {
      const fromEvent = await client.query(
        `SELECT starts_at FROM team_events WHERE id = $1 AND team_id = $2 AND training_series_id = $3`,
        [body.fromEventId, teamId, seriesId],
      );
      if (!fromEvent.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ message: "Event not found in this series" });
      }
      const splitDateOnly = new Date(fromEvent.rows[0].starts_at).toISOString().slice(0, 10);
      const dayBefore = new Date(`${splitDateOnly}T00:00:00Z`);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);

      // Close the old series the day before the split, and archive every
      // future occurrence of it from the split date onward — including
      // ones that were individually overridden or canceled, since a split
      // means "start fresh from here."
      await client.query(`UPDATE team_training_series SET ends_on = $2, updated_at = now() WHERE id = $1`, [seriesId, dayBefore.toISOString().slice(0, 10)]);
      await archiveFutureOccurrences(client, seriesId, new Date(`${splitDateOnly}T00:00:00Z`));

      const newSeriesResult = await client.query(
        `INSERT INTO team_training_series (team_id, title, weekdays, time, duration_minutes, starts_on, ends_on, created_by)
         VALUES ($1, $2, $3::smallint[], $4, $5, $6, $7, $8)
         RETURNING id, team_id, title, weekdays, time, duration_minutes, starts_on, ends_on`,
        [
          teamId,
          body.title ?? current.title,
          body.weekdays ?? current.weekdays,
          body.time ?? current.time,
          body.durationMinutes !== undefined ? body.durationMinutes : current.duration_minutes,
          splitDateOnly,
          body.endsOn ?? current.ends_on,
        ],
      );
      const newSeries = newSeriesResult.rows[0] as TrainingSeries;
      const created = await generateSeriesOccurrences(client, newSeries, categoryId, new Date(`${splitDateOnly}T00:00:00Z`), identity.sub);
      await client.query("COMMIT");
      return { series: newSeries, created: created.length, events: created };
    }

    // scope === "all": update the series definition in place, archive every
    // future (not-yet-happened) occurrence, and regenerate. Past
    // occurrences are never touched or rewritten.
    const updated = await client.query(
      `UPDATE team_training_series
       SET title = COALESCE($2, title),
           weekdays = COALESCE($3::smallint[], weekdays),
           time = COALESCE($4, time),
           duration_minutes = CASE WHEN $5::boolean THEN $6 ELSE duration_minutes END,
           ends_on = COALESCE($7, ends_on),
           updated_at = now()
       WHERE id = $1
       RETURNING id, team_id, title, weekdays, time, duration_minutes, starts_on, ends_on`,
      [
        seriesId,
        body.title ?? null,
        body.weekdays ?? null,
        body.time ?? null,
        "durationMinutes" in body, body.durationMinutes ?? null,
        body.endsOn ?? null,
      ],
    );
    const newDefinition = updated.rows[0] as TrainingSeries;
    await archiveFutureOccurrences(client, seriesId);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const seriesStart = new Date(`${newDefinition.starts_on}T00:00:00Z`);
    const regenerateFrom = seriesStart > today ? seriesStart : today;
    const created = await generateSeriesOccurrences(client, newDefinition, categoryId, regenerateFrom, identity.sub);
    await client.query("COMMIT");
    return { series: newDefinition, created: created.length, events: created };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/teams/:teamId/events/:eventId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const allowed = await hasTeamAccess(db, identity.sub, teamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });

  const event = await db.query(
    `SELECT id, event_type, title, starts_at, ends_at, location, notes, source, canceled, created_at,
            training_series_id, overridden
     FROM team_events WHERE id = $1 AND team_id = $2`,
    [eventId, teamId],
  );
  if (!event.rowCount) return reply.code(404).send({ message: "Event not found" });

  const actions = await db.query(
    `SELECT id, label, content, sort_order, completed_at
     FROM team_event_actions WHERE team_event_id = $1 ORDER BY sort_order`,
    [eventId],
  );
  return { event: event.rows[0], actions: actions.rows };
});

app.patch("/v1/teams/:teamId/events/:eventId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    location: z.string().trim().max(200).nullable().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
    canceled: z.boolean().optional(),
  }).parse(request.body);

  const allowed = await hasTeamAccess(db, identity.sub, teamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });

  // A direct single-event edit is always "only this event" — if it belongs
  // to a series, mark it overridden so a later this-and-following/all edit
  // knows to leave it alone instead of silently resetting this change.
  const result = await db.query(
    `UPDATE team_events
     SET title = COALESCE($3, title),
         starts_at = COALESCE($4, starts_at),
         ends_at = CASE WHEN $5::boolean THEN $6 ELSE ends_at END,
         location = CASE WHEN $7::boolean THEN $8 ELSE location END,
         notes = CASE WHEN $9::boolean THEN $10 ELSE notes END,
         canceled = COALESCE($11, canceled),
         overridden = CASE WHEN training_series_id IS NOT NULL THEN true ELSE overridden END,
         updated_at = now()
     WHERE id = $1 AND team_id = $2
     RETURNING id, event_type, title, starts_at, ends_at, location, notes, source, canceled, created_at,
               training_series_id, overridden`,
    [
      eventId, teamId,
      body.title ?? null,
      body.startsAt ?? null,
      "endsAt" in body, body.endsAt ?? null,
      "location" in body, body.location ?? null,
      "notes" in body, body.notes ?? null,
      body.canceled ?? null,
    ],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "Event not found" });
  return result.rows[0];
});

app.post("/v1/teams/:teamId/events/:eventId/actions", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    label: z.string().trim().min(1).max(300),
    content: z.record(z.unknown()).default({}),
  }).parse(request.body);

  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });

  const nextOrder = await db.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM team_event_actions WHERE team_event_id = $1`,
    [eventId],
  );
  const result = await db.query(
    `INSERT INTO team_event_actions (team_event_id, label, content, sort_order)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, content, sort_order, completed_at`,
    [eventId, body.label, body.content, nextOrder.rows[0].next],
  );
  return reply.code(201).send(result.rows[0]);
});

app.patch("/v1/teams/:teamId/events/:eventId/actions/:actionId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId, actionId } = z.object({
    teamId: z.string().uuid(), eventId: z.string().uuid(), actionId: z.string().uuid(),
  }).parse(request.params);
  const body = z.object({
    label: z.string().trim().min(1).max(300).optional(),
    completed: z.boolean().optional(),
  }).parse(request.body);

  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });

  const result = await db.query(
    `UPDATE team_event_actions
     SET label = COALESCE($3, label),
         completed_at = CASE
           WHEN $4::boolean IS NULL THEN completed_at
           WHEN $4::boolean THEN now()
           ELSE NULL
         END,
         completed_by = CASE
           WHEN $4::boolean IS NULL THEN completed_by
           WHEN $4::boolean THEN $5
           ELSE NULL
         END
     WHERE id = $1 AND team_event_id = $2
     RETURNING id, label, content, sort_order, completed_at`,
    [actionId, eventId, body.label ?? null, body.completed ?? null, identity.sub],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "Action not found" });
  return result.rows[0];
});

app.delete("/v1/teams/:teamId/events/:eventId/actions/:actionId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId, actionId } = z.object({
    teamId: z.string().uuid(), eventId: z.string().uuid(), actionId: z.string().uuid(),
  }).parse(request.params);

  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });

  const result = await db.query(
    `DELETE FROM team_event_actions WHERE id = $1 AND team_event_id = $2`,
    [actionId, eventId],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "Action not found" });
  return {};
});

app.get("/v1/event-type-actions", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  const result = await db.query(
    `SELECT eta.id, eta.scope, eta.category_id, eta.team_id, eta.event_type, eta.label, eta.content, eta.sort_order, eta.active,
            c.name AS category, t.name AS team
     FROM event_type_actions eta
     LEFT JOIN categories c ON c.id = eta.category_id
     LEFT JOIN teams t ON t.id = eta.team_id
     ORDER BY eta.event_type, CASE eta.scope WHEN 'club' THEN 1 WHEN 'category' THEN 2 ELSE 3 END, eta.sort_order`,
  );
  return { actions: result.rows };
});

app.post("/v1/event-type-actions", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });

  const body = z.object({
    scope: z.enum(["club", "category", "team"]),
    categoryId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    eventType: z.enum(["training", "match", "meeting"]),
    label: z.string().trim().min(1).max(300),
    content: z.record(z.unknown()).default({}),
    sortOrder: z.number().int().default(0),
  })
    .refine((value) => value.scope !== "category" || value.categoryId, { message: "categoryId required for scope=category" })
    .refine((value) => value.scope !== "team" || value.teamId, { message: "teamId required for scope=team" })
    .parse(request.body);

  const result = await db.query(
    `INSERT INTO event_type_actions (scope, category_id, team_id, event_type, label, content, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, scope, category_id, team_id, event_type, label, content, sort_order, active`,
    [body.scope, body.categoryId ?? null, body.teamId ?? null, body.eventType, body.label, body.content, body.sortOrder, identity.sub],
  );
  return reply.code(201).send(result.rows[0]);
});

app.patch("/v1/event-type-actions/:actionId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });

  const { actionId } = z.object({ actionId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    label: z.string().trim().min(1).max(300).optional(),
    content: z.record(z.unknown()).optional(),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
  }).parse(request.body);

  const result = await db.query(
    `UPDATE event_type_actions
     SET label = COALESCE($2, label),
         content = COALESCE($3, content),
         sort_order = COALESCE($4, sort_order),
         active = COALESCE($5, active),
         updated_at = now()
     WHERE id = $1
     RETURNING id, scope, category_id, team_id, event_type, label, content, sort_order, active`,
    [actionId, body.label ?? null, body.content ?? null, body.sortOrder ?? null, body.active ?? null],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "Action template not found" });
  return result.rows[0];
});

app.post("/v1/chat", {
  onRequest: [async (request) => request.jwtVerify()],
  config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
}, async (request, reply) => {
  const identity = request.user as { sub: string };
  const body = z.object({
    teamId: z.string().uuid(),
    message: z.string().trim().min(1).max(4_000),
    history: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().trim().min(1).max(4_000),
    })).max(12).optional(),
  }).parse(request.body);

  if (!ai.configured) {
    return reply.code(503).send({ message: "AI service is not configured" });
  }

  const authorized = await db.query(
    `SELECT u.name, u.role, u.sport_role, t.id, t.name AS team_name, t.season,
            t.category_id, c.name AS category
     FROM users u
     JOIN teams t ON t.id = $2 AND t.active = true
       AND (u.global_access OR EXISTS (
         SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
       ))
     JOIN categories c ON c.id = t.category_id
     WHERE u.id = $1 AND u.active = true`,
    [identity.sub, body.teamId],
  );
  if (!authorized.rowCount) return reply.code(403).send({ message: "Forbidden" });

  const actor = authorized.rows[0] as {
    name: string; role: string; sport_role: string | null; id: string;
    team_name: string; season: string; category_id: string; category: string;
  };
  const [contexts, recentRecords, activePlan] = await Promise.all([
    db.query(
      `SELECT scope, content, version
       FROM strategy_contexts
       WHERE active = true AND (scope = 'club' OR category_id = $1 OR team_id = $2)
       ORDER BY CASE scope WHEN 'club' THEN 1 WHEN 'category' THEN 2 ELSE 3 END`,
      [actor.category_id, actor.id],
    ),
    db.query(
      `SELECT record_type, happened_at, content
       FROM team_records WHERE team_id = $1
       ORDER BY happened_at DESC, created_at DESC LIMIT 10`,
      [actor.id],
    ),
    db.query(
      `SELECT season, content, version, updated_at FROM team_plans
       WHERE team_id = $1 AND season = $2 LIMIT 1`,
      [actor.id, actor.season],
    ),
  ]);

  try {
    const result = await ai.reply({
      context: {
        user: { name: actor.name, role: actor.role, sportRole: actor.sport_role },
        team: {
          id: actor.id,
          name: actor.team_name,
          category: actor.category,
          season: actor.season,
        },
        strategyContexts: contexts.rows,
        recentRecords: recentRecords.rows,
        activePlan: activePlan.rows[0] ?? null,
      },
      message: body.message,
      history: body.history,
    });
    const stored = await db.query(
      `INSERT INTO ai_interactions
         (user_id, team_id, user_message, assistant_message, provider_model)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [identity.sub, actor.id, body.message, result.content, result.model],
    );
    return { id: stored.rows[0].id, content: result.content, createdAt: stored.rows[0].created_at };
  } catch (error) {
    request.log.error({ err: error, teamId: actor.id }, "AI request failed");
    return reply.code(502).send({ message: "AI provider unavailable" });
  }
});

app.get("/v1/teams/:teamId/assistant-results", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const allowed = await hasTeamAccess(db, identity.sub, teamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });

  const result = await db.query(
    `SELECT ai.id, ai.user_message, ai.assistant_message, ai.created_at, u.name AS requested_by
     FROM ai_interactions ai
     JOIN users u ON u.id = ai.user_id
     WHERE ai.team_id = $1
     ORDER BY ai.created_at DESC LIMIT 30`,
    [teamId],
  );
  return { results: result.rows };
});

app.post("/v1/session", {
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
}, async (request, reply) => {
  const body = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }).parse(request.body);

  const result = await db.query(
    "SELECT id, role, password_hash FROM users WHERE email = $1 AND active = true",
    [body.email],
  );
  const user = result.rows[0] as { id: string; role: string; password_hash: string | null } | undefined;

  const valid = await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !user.password_hash || !valid) {
    return reply.code(401).send({ message: "Unauthorized" });
  }
  return { token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: "72h" }) };
});

app.post("/v1/fecapa/sync", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  try {
    return await syncFecapaCalendars(db);
  } catch (error) {
    request.log.error({ err: error }, "FECAPA manual sync failed");
    return reply.code(502).send({ message: "FECAPA sync failed" });
  }
});

// Runs every Monday and Thursday at 03:00 Europe/Madrid (low-traffic hour,
// avoids hammering FECAPA's server during the day) rather than a fixed
// interval from process boot, which would drift onto arbitrary days/times
// across restarts.
function scheduleFecapaSync() {
  const next = nextFecapaSyncAt(new Date());
  app.log.info({ next: next.toISOString() }, "Next FECAPA sync scheduled");
  setTimeout(() => {
    void syncFecapaCalendars(db)
      .then((summary) => app.log.info({ summary }, "FECAPA sync completed"))
      .catch((error) => app.log.error({ err: error }, "FECAPA scheduled sync failed"))
      .finally(() => scheduleFecapaSync());
  }, next.getTime() - Date.now());
}
scheduleFecapaSync();

const shutdown = async () => {
  await db.end();
  await app.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
