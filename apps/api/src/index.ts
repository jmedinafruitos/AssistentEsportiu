import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { Pool } from "pg";
import { z } from "zod";
import { ConfigurableAiService } from "./ai.js";

const env = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3000),
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_MODEL: z.string().min(1).default("gpt-5-mini"),
}).parse(process.env);

const app = Fastify({ logger: true });
const db = new Pool({ connectionString: env.DATABASE_URL });
const ai = new ConfigurableAiService({
  apiKey: env.AI_API_KEY,
  baseUrl: env.AI_BASE_URL,
  model: env.AI_MODEL,
});

await app.register(cors, { origin: false });
await app.register(jwt, { secret: env.JWT_SECRET });

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
  const actor = await db.query("SELECT 1 FROM users WHERE id = $1 AND active = true AND global_access = true", [identity.sub]);
  if (!actor.rowCount) return reply.code(403).send({ message: "Forbidden" });
  const teams = await db.query(
    `SELECT t.id, t.name, t.season, c.name AS category,
            count(DISTINCT ta.user_id)::int AS staff_count,
            count(DISTINCT tr.id)::int AS record_count,
            max(tr.happened_at) AS last_activity_at
     FROM teams t JOIN categories c ON c.id = t.category_id
     LEFT JOIN team_assignments ta ON ta.team_id = t.id
     LEFT JOIN team_records tr ON tr.team_id = t.id
     WHERE t.active = true
     GROUP BY t.id, c.name ORDER BY t.name`,
  );
  const pending = await db.query(
    `SELECT p.id, p.strategy_context_id, p.base_version, p.reason, p.proposed_at, u.name AS proposed_by_name
     FROM strategy_change_proposals p JOIN users u ON u.id = p.proposed_by
     WHERE p.status = 'pending' ORDER BY p.proposed_at DESC`,
  );
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
  const allowed = await db.query(
    `SELECT 1 FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))`,
    [identity.sub, teamId],
  );
  if (!allowed.rowCount) return reply.code(403).send({ message: "Forbidden" });
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

app.post("/v1/chat", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
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
  const contexts = await db.query(
    `SELECT scope, content, version
     FROM strategy_contexts
     WHERE active = true AND (scope = 'club' OR category_id = $1 OR team_id = $2)
     ORDER BY CASE scope WHEN 'club' THEN 1 WHEN 'category' THEN 2 ELSE 3 END`,
    [actor.category_id, actor.id],
  );
  const recentRecords = await db.query(
    `SELECT record_type, happened_at, content
     FROM team_records WHERE team_id = $1
     ORDER BY happened_at DESC, created_at DESC LIMIT 10`,
    [actor.id],
  );
  const activePlan = await db.query(
    `SELECT season, content, version, updated_at FROM team_plans
     WHERE team_id = $1 AND season = $2 LIMIT 1`,
    [actor.id, actor.season],
  );

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
  const result = await db.query(
    `SELECT ai.id, ai.user_message, ai.assistant_message, ai.created_at, u.name AS requested_by
     FROM users viewer
     JOIN teams t ON t.id = $2 AND t.active = true
       AND (viewer.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = viewer.id AND ta.team_id = t.id))
     JOIN ai_interactions ai ON ai.team_id = t.id
     JOIN users u ON u.id = ai.user_id
     WHERE viewer.id = $1 AND viewer.active = true
     ORDER BY ai.created_at DESC LIMIT 30`,
    [identity.sub, teamId],
  );
  return { results: result.rows };
});

app.post("/v1/session", async (request, reply) => {
  const body = z.object({ email: z.string().email() }).parse(request.body);
  const result = await db.query("SELECT id, role FROM users WHERE email = $1 AND active = true", [body.email]);
  if (!result.rowCount) return reply.code(401).send({ message: "Unauthorized" });
  const user = result.rows[0] as { id: string; role: string };
  return { token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: "12h" }) };
});

const shutdown = async () => {
  await db.end();
  await app.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
