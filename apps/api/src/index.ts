import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import Fastify from "fastify";
import { Pool, types } from "pg";
import {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import { ConfigurableAiService } from "./ai.js";
import { hasEventAccess, hasTeamAccess, isGlobalAccess, teamAccessCategory } from "./authorization.js";
import { driveConfigured, syncDriveDocuments } from "./drive.js";
import { extractPendingDocuments } from "./extraction.js";
import { suggestExercisesFromSummary } from "./exercise-suggestions.js";
import { syncEventToCalendar } from "./google-calendar.js";
import { emailConfigured, sendEmail } from "./resend.js";
import {
  applyManualEdit,
  buildEmailHtml,
  buildEmailSubject,
  buildTrainingContext,
  draftInitialContent,
  refineSection,
  resolveExerciseNames,
  resolveRecipients,
  resolveStep,
  swapExercise,
  totalSteps,
  TrainingContent,
  trainingContentSchema,
} from "./training-preparation.js";
import { generateTrainingPdf } from "./training-preparation-pdf.js";
import { generateStrategyProposals } from "./strategy-proposals.js";
import { materializeEventActions } from "./events.js";
import { addPlayerToRoster, copyFromPreviousMatch, listRoster } from "./match-rosters.js";
import { nextFecapaSyncAt, syncFecapaCalendars } from "./fecapa.js";
import { archiveFutureOccurrences, generateSeriesOccurrences, TrainingSeries } from "./training-series.js";
import { consumeChallenge, pruneExpiredChallenges, resolveRpConfig, storeChallenge } from "./webauthn.js";

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
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().min(1).optional(),
  DRIVE_FOLDER_ID: z.string().min(1).optional(),
  GOOGLE_CALENDAR_ID: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
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
const driveConfig = {
  serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  serviceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY,
  folderId: env.DRIVE_FOLDER_ID,
};
// Same service account as Drive, also shared to the club's Calendar — one
// credential for the whole app rather than managing two.
const calendarConfig = {
  serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  serviceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY,
  calendarId: env.GOOGLE_CALENDAR_ID,
};
const emailConfig = { apiKey: env.RESEND_API_KEY, fromEmail: env.RESEND_FROM_EMAIL };

await app.register(cors, { origin: env.WEB_ORIGIN ?? false });
await app.register(jwt, { secret: env.JWT_SECRET });
await app.register(helmet);
// Global baseline for every route; /v1/session and /v1/chat get tighter
// per-route limits below (brute-force and AI-cost concerns respectively).
// Keyed by IP rather than authenticated user — simpler and avoids relying
// on onRequest hook ordering between this plugin and our own jwtVerify
// hook, and is plenty at this club's scale (one coach per connection).
await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });

// JME-17 already validated app.sentmenat.cat end-to-end, so WEB_ORIGIN is
// always the real PWA origin in every deployed environment; the localhost
// fallback only matters for local `npm run dev`.
const rpConfig = resolveRpConfig(env.WEB_ORIGIN);

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
  const [teams, pending, matchRosters] = await Promise.all([
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
      `SELECT p.id, p.strategy_context_id, p.base_version, p.reason, p.proposed_at, u.name AS proposed_by_name,
              sd.id AS source_document_id, sd.title AS source_document_title, sd.layer AS source_document_layer,
              sd.drive_url AS source_document_drive_url, sd.summary AS source_document_summary
       FROM strategy_change_proposals p JOIN users u ON u.id = p.proposed_by
       LEFT JOIN source_documents sd ON sd.id = p.source_document_id
       WHERE p.status = 'pending' ORDER BY p.proposed_at DESC`,
    ),
    // JME-53: roster status per upcoming match, across every team — the
    // coordinator's cross-team view (JME-52 builds the per-match list).
    db.query(
      `SELECT te.id, t.name AS team_name, te.title, te.starts_at,
              count(mr.id)::int AS roster_count,
              count(mr.id) FILTER (WHERE p.team_id <> te.team_id)::int AS guest_count,
              count(mr.id) FILTER (WHERE mr.conflict_override)::int AS override_count
       FROM team_events te
       JOIN teams t ON t.id = te.team_id
       LEFT JOIN match_rosters mr ON mr.team_event_id = te.id
       LEFT JOIN players p ON p.id = mr.player_id
       WHERE te.event_type = 'match' AND te.canceled = false AND te.starts_at >= now()
       GROUP BY te.id, t.name ORDER BY te.starts_at ASC LIMIT 100`,
    ),
  ]);
  return { teams: teams.rows, pendingProposals: pending.rows, upcomingMatchRosters: matchRosters.rows };
});

app.post("/v1/strategy-contexts/:contextId/proposals", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { contextId } = z.object({ contextId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    content: z.record(z.unknown()),
    version: z.number().int().positive(),
    reason: z.string().trim().min(3).max(1_000),
    sourceDocumentId: z.string().uuid().optional(),
  }).parse(request.body);
  const result = await db.query(
    `INSERT INTO strategy_change_proposals
       (strategy_context_id, base_version, proposed_content, reason, proposed_by, source_document_id)
     SELECT sc.id, $3, $4, $5, u.id, sd.id
     FROM users u JOIN strategy_contexts sc ON sc.id = $2
     LEFT JOIN source_documents sd ON sd.id = $6::uuid
     WHERE u.id = $1 AND u.active = true AND u.global_access = true AND sc.version = $3
       AND ($6::uuid IS NULL OR sd.id IS NOT NULL)
     RETURNING id, strategy_context_id, base_version, proposed_content, reason, status, proposed_at, source_document_id`,
    [identity.sub, contextId, body.version, body.content, body.reason, body.sourceDocumentId ?? null],
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

// Training's content contract is documented in docs/ficha-entreno-schema.md
// (JME-42) — a fixed structure matching the paper "Ficha entreno" template,
// as opposed to match's freeform summary/outcome/nextObjectives (JME-10,
// unchanged). "Activación" fields are per-phase descriptions in the paper
// template, not booleans, so each is optional free text.
const trainingBlockSchema = z.object({
  description: z.string().trim().min(1).max(1_000),
  diagramAssetUrl: z.string().trim().url().optional(),
  exerciseId: z.string().uuid().optional(),
});
const recordBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("match"),
    happenedAt: z.string().datetime(),
    summary: z.string().trim().min(1).max(2_000),
    outcome: z.string().trim().max(500).optional(),
    nextObjectives: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  }),
  z.object({
    type: z.literal("training"),
    happenedAt: z.string().datetime(),
    sessionNumber: z.number().int().positive().optional(),
    coach: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(2_000).optional(),
    activation: z.object({
      prevencion: z.string().trim().max(500).optional(),
      activacionPorteros: z.string().trim().max(500).optional(),
      activacionJugadores: z.string().trim().max(500).optional(),
      integrado: z.string().trim().max(500).optional(),
      participativo: z.string().trim().max(500).optional(),
    }).default({}),
    blocks: z.array(trainingBlockSchema).min(1).max(3),
  }),
]);

app.post("/v1/teams/:teamId/records", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const body = recordBodySchema.parse(request.body);
  const content = body.type === "match"
    ? { summary: body.summary, outcome: body.outcome ?? null, nextObjectives: body.nextObjectives }
    : {
        sessionNumber: body.sessionNumber ?? null,
        coach: body.coach ?? null,
        notes: body.notes ?? null,
        activation: body.activation,
        blocks: body.blocks.map((block, orderIndex) => ({
          orderIndex,
          description: block.description,
          diagramAssetUrl: block.diagramAssetUrl ?? null,
          exerciseId: block.exerciseId ?? null,
        })),
      };
  const result = await db.query(
    `INSERT INTO team_records (team_id, record_type, happened_at, content, created_by)
     SELECT t.id, $3, $4, $5, u.id
     FROM users u JOIN teams t ON t.id = $2 AND t.active = true
     WHERE u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id))
     RETURNING id, record_type, happened_at, content, created_at`,
    [identity.sub, teamId, body.type, body.happenedAt, content],
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
    // readiness (JME-45) drives the row's status dot: for training it's
    // training_preparations.status (JME-44); for match/meeting, which have
    // no AI workflow, it's the completion ratio of the event's own
    // checklist (team_event_actions, JME-29) instead.
    `SELECT te.id, te.event_type, te.title, te.starts_at, te.ends_at, te.location, te.notes, te.is_home, te.source, te.canceled, te.created_at,
            te.training_series_id, te.overridden, te.team_id, t.name AS team_name,
            CASE
              WHEN te.event_type = 'training' THEN COALESCE((
                SELECT CASE WHEN tp.status = 'drafting' THEN 'in_progress' WHEN tp.status IN ('ready', 'sent') THEN 'done' END
                FROM training_preparations tp WHERE tp.team_event_id = te.id
              ), 'none')
              ELSE COALESCE((
                SELECT CASE
                  WHEN count(*) = 0 THEN 'none'
                  WHEN count(*) FILTER (WHERE tea.completed_at IS NOT NULL) = count(*) THEN 'done'
                  WHEN count(*) FILTER (WHERE tea.completed_at IS NOT NULL) = 0 THEN 'none'
                  ELSE 'in_progress'
                END
                FROM team_event_actions tea WHERE tea.team_event_id = te.id
              ), 'none')
            END AS readiness
     FROM team_events te JOIN teams t ON t.id = te.team_id
     WHERE te.team_id = $1
       AND te.archived_at IS NULL
       AND te.starts_at >= COALESCE($2::timestamptz, now() - interval '1 day')
       AND ($3::timestamptz IS NULL OR te.starts_at < $3::timestamptz)
     ORDER BY te.starts_at ASC LIMIT 200`,
    [teamId, query.from ?? null, query.to ?? null],
  );
  return { events: result.rows };
});

// "Tots els equips" (all-teams) view on the events list — same weekly
// pagination as the per-team endpoint above, just scoped to every team
// the user can access instead of one team_id.
app.get("/v1/events", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const identity = request.user as { sub: string };
  const query = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }).parse(request.query);
  const result = await db.query(
    `SELECT te.id, te.event_type, te.title, te.starts_at, te.ends_at, te.location, te.notes, te.is_home, te.source, te.canceled, te.created_at,
            te.training_series_id, te.overridden, te.team_id, t.name AS team_name,
            CASE
              WHEN te.event_type = 'training' THEN COALESCE((
                SELECT CASE WHEN tp.status = 'drafting' THEN 'in_progress' WHEN tp.status IN ('ready', 'sent') THEN 'done' END
                FROM training_preparations tp WHERE tp.team_event_id = te.id
              ), 'none')
              ELSE COALESCE((
                SELECT CASE
                  WHEN count(*) = 0 THEN 'none'
                  WHEN count(*) FILTER (WHERE tea.completed_at IS NOT NULL) = count(*) THEN 'done'
                  WHEN count(*) FILTER (WHERE tea.completed_at IS NOT NULL) = 0 THEN 'none'
                  ELSE 'in_progress'
                END
                FROM team_event_actions tea WHERE tea.team_event_id = te.id
              ), 'none')
            END AS readiness
     FROM team_events te
     JOIN teams t ON t.id = te.team_id
     JOIN users u ON u.id = $1 AND u.active = true
       AND (u.global_access OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = te.team_id))
     WHERE te.archived_at IS NULL
       AND te.starts_at >= COALESCE($2::timestamptz, now() - interval '1 day')
       AND ($3::timestamptz IS NULL OR te.starts_at < $3::timestamptz)
     ORDER BY te.starts_at ASC LIMIT 200`,
    [identity.sub, query.from ?? null, query.to ?? null],
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
    // Only meaningful for event_type 'match' — FECAPA-sourced matches
    // derive this themselves at sync time (JME-50); a manually-created
    // match has no opponent-position data to derive it from, so the
    // creator states it explicitly.
    isHome: z.boolean().optional(),
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
      `INSERT INTO team_events (team_id, event_type, title, starts_at, ends_at, location, notes, is_home, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, event_type, title, starts_at, ends_at, location, notes, is_home, source, canceled, created_at`,
      [teamId, body.eventType, body.title, body.startsAt, body.endsAt ?? null, body.location ?? null, body.notes ?? null, body.isHome ?? null, identity.sub],
    );
    const created = event.rows[0];
    const actions = await materializeEventActions(client, created.id, teamId, categoryId, body.eventType);
    await client.query("COMMIT");
    // Fired after commit, not awaited: Calendar's latency shouldn't hold up
    // the response, and a failure here must not undo an event Postgres
    // already has (Postgres is the source of truth — JME-30).
    void syncEventToCalendar(db, calendarConfig, {
      id: created.id, title: created.title, startsAt: created.starts_at, endsAt: created.ends_at,
      location: created.location, notes: created.notes, canceled: created.canceled, googleCalendarEventId: null,
    }).catch((error) => request.log.error({ err: error, eventId: created.id }, "Calendar sync failed"));
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
    `SELECT id, event_type, title, starts_at, ends_at, location, notes, is_home, source, canceled, created_at,
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
    isHome: z.boolean().nullable().optional(),
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
         is_home = CASE WHEN $12::boolean THEN $13 ELSE is_home END,
         overridden = CASE WHEN training_series_id IS NOT NULL THEN true ELSE overridden END,
         updated_at = now()
     WHERE id = $1 AND team_id = $2
     RETURNING id, event_type, title, starts_at, ends_at, location, notes, is_home, source, canceled, created_at,
               training_series_id, overridden, google_calendar_event_id`,
    [
      eventId, teamId,
      body.title ?? null,
      body.startsAt ?? null,
      "endsAt" in body, body.endsAt ?? null,
      "location" in body, body.location ?? null,
      "notes" in body, body.notes ?? null,
      body.canceled ?? null,
      "isHome" in body, body.isHome ?? null,
    ],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "Event not found" });
  const updated = result.rows[0];
  // Same fire-and-forget, best-effort stance as on creation (JME-30).
  void syncEventToCalendar(db, calendarConfig, {
    id: updated.id, title: updated.title, startsAt: updated.starts_at, endsAt: updated.ends_at,
    location: updated.location, notes: updated.notes, canceled: updated.canceled,
    googleCalendarEventId: updated.google_calendar_event_id,
  }).catch((error) => request.log.error({ err: error, eventId: updated.id }, "Calendar sync failed"));
  return updated;
});

// JME-51/52: convocatòria (call-up list) for a match. Conflict-check and
// insert logic lives in match-rosters.ts; these routes are thin glue,
// same split as training-preparation.ts.
app.get("/v1/teams/:teamId/events/:eventId/roster", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  return { entries: await listRoster(db, eventId) };
});

app.post("/v1/teams/:teamId/events/:eventId/roster/copy-from-previous", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  const result = await copyFromPreviousMatch(db, teamId, eventId, identity.sub);
  return { ...result, entries: await listRoster(db, eventId) };
});

app.post("/v1/teams/:teamId/events/:eventId/roster", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const body = z.object({ playerId: z.string().uuid(), acceptOverride: z.boolean().default(false) }).parse(request.body);
  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  const result = await addPlayerToRoster(db, eventId, body.playerId, identity.sub, body.acceptOverride);
  if (result.status === "already_in_roster") return reply.code(409).send({ message: "El jugador ja és a la convocatòria" });
  if (result.status === "blocked") return reply.code(422).send({ message: "Conflicte d'horari", conflict: result.conflict });
  if (result.status === "needs_confirmation") return reply.code(409).send({ message: "Possible conflicte d'horari", conflict: result.conflict });
  return reply.code(201).send(result.entry);
});

app.delete("/v1/teams/:teamId/events/:eventId/roster/:playerId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId, playerId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid(), playerId: z.string().uuid() }).parse(request.params);
  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  await db.query(`DELETE FROM match_rosters WHERE team_event_id = $1 AND player_id = $2`, [eventId, playerId]);
  return reply.code(204).send();
});

// JME-49: players are club data (not staff/login accounts) — read is open
// to any authenticated user, since building a match roster means
// searching players across every team, not just your own (JME-52).
app.get("/v1/players", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const query = z.object({
    teamId: z.string().uuid().optional(),
    query: z.string().trim().min(1).max(100).optional(),
  }).parse(request.query);
  const result = await db.query(
    `SELECT p.id, p.name, p.team_id, t.name AS team_name, p.birth_year, p.is_goalkeeper, p.active
     FROM players p JOIN teams t ON t.id = p.team_id
     WHERE p.active = true
       AND ($1::uuid IS NULL OR p.team_id = $1)
       AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%')
     ORDER BY t.name, p.name`,
    [query.teamId ?? null, query.query ?? null],
  );
  return { players: result.rows };
});

app.post("/v1/players", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const body = z.object({
    name: z.string().trim().min(1).max(200),
    teamId: z.string().uuid(),
    birthYear: z.number().int().min(1950).max(2050).optional(),
    isGoalkeeper: z.boolean().default(false),
    notes: z.string().trim().max(2_000).optional(),
  }).parse(request.body);
  const allowed = await hasTeamAccess(db, identity.sub, body.teamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  const result = await db.query(
    `INSERT INTO players (name, team_id, birth_year, is_goalkeeper, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, team_id, birth_year, is_goalkeeper, active`,
    [body.name, body.teamId, body.birthYear ?? null, body.isGoalkeeper, body.notes ?? null],
  );
  return reply.code(201).send(result.rows[0]);
});

app.patch("/v1/players/:playerId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { playerId } = z.object({ playerId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    teamId: z.string().uuid().optional(),
    birthYear: z.number().int().min(1950).max(2050).nullable().optional(),
    isGoalkeeper: z.boolean().optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  }).parse(request.body);
  const current = await db.query(`SELECT team_id FROM players WHERE id = $1`, [playerId]);
  if (!current.rowCount) return reply.code(404).send({ message: "Player not found" });
  const currentTeamId = (current.rows[0] as { team_id: string }).team_id;
  const allowed = await hasTeamAccess(db, identity.sub, currentTeamId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  // Moving a player to a different team is a bigger action than editing
  // their own record — reserved for the coordinator.
  if (body.teamId && body.teamId !== currentTeamId && !(await isGlobalAccess(db, identity.sub))) {
    return reply.code(403).send({ message: "Forbidden" });
  }
  const result = await db.query(
    `UPDATE players
     SET name = COALESCE($2, name),
         team_id = COALESCE($3, team_id),
         birth_year = CASE WHEN $4::boolean THEN $5 ELSE birth_year END,
         is_goalkeeper = COALESCE($6, is_goalkeeper),
         active = COALESCE($7, active),
         notes = CASE WHEN $8::boolean THEN $9 ELSE notes END,
         updated_at = now()
     WHERE id = $1
     RETURNING id, name, team_id, birth_year, is_goalkeeper, active`,
    [
      playerId, body.name ?? null, body.teamId ?? null,
      "birthYear" in body, body.birthYear ?? null,
      body.isGoalkeeper ?? null, body.active ?? null,
      "notes" in body, body.notes ?? null,
    ],
  );
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

app.get("/v1/exercises", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const query = z.object({
    tag: z.string().trim().min(1).optional(),
    type: z.enum(["juego", "circuito", "ejercicio", "tactica"]).optional(),
  }).parse(request.query);
  const result = await db.query(
    `SELECT id, name, type, description, variants, tags, source_document_id, page_ref, created_at
     FROM exercises
     WHERE ($1::text IS NULL OR tags @> ARRAY[$1::text])
       AND ($2::text IS NULL OR type = $2)
     ORDER BY name`,
    [query.tag ?? null, query.type ?? null],
  );
  return { exercises: result.rows };
});

app.post("/v1/exercises", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  const body = z.object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(["juego", "circuito", "ejercicio", "tactica"]),
    description: z.string().trim().max(4_000).optional(),
    variants: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    sourceDocumentId: z.string().uuid().optional(),
    pageRef: z.string().trim().max(50).optional(),
  }).parse(request.body);
  const result = await db.query(
    `INSERT INTO exercises (name, type, description, variants, tags, source_document_id, page_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, type, description, variants, tags, source_document_id, page_ref, created_at`,
    [body.name, body.type, body.description ?? null, body.variants, body.tags, body.sourceDocumentId ?? null, body.pageRef ?? null, identity.sub],
  );
  return reply.code(201).send(result.rows[0]);
});

app.patch("/v1/exercises/:exerciseId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  const { exerciseId } = z.object({ exerciseId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(["juego", "circuito", "ejercicio", "tactica"]).optional(),
    description: z.string().trim().max(4_000).nullable().optional(),
    variants: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  }).parse(request.body);
  const result = await db.query(
    `UPDATE exercises
     SET name = COALESCE($2, name),
         type = COALESCE($3, type),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         variants = COALESCE($6::text[], variants),
         tags = COALESCE($7::text[], tags)
     WHERE id = $1
     RETURNING id, name, type, description, variants, tags, source_document_id, page_ref, created_at`,
    [exerciseId, body.name ?? null, body.type ?? null, "description" in body, body.description ?? null, body.variants ?? null, body.tags ?? null],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "Exercise not found" });
  return result.rows[0];
});

app.post("/v1/exercises/suggest", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  if (!ai.configured) return reply.code(503).send({ message: "AI service is not configured" });
  const body = z.object({ sourceDocumentId: z.string().uuid() }).parse(request.body);
  const document = await db.query(
    `SELECT title, summary FROM source_documents WHERE id = $1 AND summary IS NOT NULL`,
    [body.sourceDocumentId],
  );
  if (!document.rowCount) return reply.code(404).send({ message: "Document not found or not yet summarized" });
  const { title, summary } = document.rows[0] as { title: string; summary: string };
  try {
    const exercises = await suggestExercisesFromSummary(ai, title, summary);
    return { exercises };
  } catch (error) {
    request.log.error({ err: error }, "Exercise suggestion failed");
    return reply.code(502).send({ message: "Exercise suggestion failed" });
  }
});

// JME-44: AI-assisted training-session preparation, reviewed one
// phase/exercise at a time. Draft shape and step order live in
// training-preparation.ts; these routes are thin request/DB glue.
app.post("/v1/teams/:teamId/events/:eventId/preparation", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });

  const existing = await db.query(
    `SELECT id, status, draft_content, current_step FROM training_preparations WHERE team_event_id = $1`,
    [eventId],
  );
  if (existing.rowCount) return existing.rows[0];

  const event = await db.query(`SELECT event_type FROM team_events WHERE id = $1 AND team_id = $2`, [eventId, teamId]);
  if (!event.rowCount) return reply.code(404).send({ message: "Event not found" });
  if ((event.rows[0] as { event_type: string }).event_type !== "training") {
    return reply.code(400).send({ message: "Preparation is only available for training events" });
  }
  if (!ai.configured) return reply.code(503).send({ message: "AI service is not configured" });

  try {
    const context = await buildTrainingContext(db, teamId, eventId);
    const draft = await draftInitialContent(ai, context);
    const created = await db.query(
      `INSERT INTO training_preparations (team_event_id, team_id, draft_content, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, status, draft_content, current_step`,
      [eventId, teamId, draft, identity.sub],
    );
    return reply.code(201).send(created.rows[0]);
  } catch (error) {
    request.log.error({ err: error, eventId }, "Training preparation draft failed");
    return reply.code(502).send({ message: "Could not draft the training preparation" });
  }
});

app.get("/v1/teams/:teamId/events/:eventId/preparation", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
  const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
  if (!allowed) return reply.code(403).send({ message: "Forbidden" });
  const result = await db.query(
    `SELECT id, status, draft_content, current_step FROM training_preparations WHERE team_event_id = $1`,
    [eventId],
  );
  if (!result.rowCount) return reply.code(404).send({ message: "No preparation yet" });
  return result.rows[0];
});

// Header fields (sessionNumber/coach/notes) sit outside the phase/block step
// sequence — edited inline, always visible, per JME-44's design.
app.patch(
  "/v1/teams/:teamId/events/:eventId/preparation/header",
  { onRequest: [async (request) => request.jwtVerify()] },
  async (request, reply) => {
    const identity = request.user as { sub: string };
    const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      sessionNumber: z.number().int().positive().nullable().optional(),
      coach: z.string().trim().max(200).nullable().optional(),
      notes: z.string().trim().max(2_000).nullable().optional(),
    }).parse(request.body);
    const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
    if (!allowed) return reply.code(403).send({ message: "Forbidden" });

    const existing = await db.query(
      `SELECT id, status, draft_content FROM training_preparations WHERE team_event_id = $1`,
      [eventId],
    );
    if (!existing.rowCount) return reply.code(404).send({ message: "No preparation yet" });
    const row = existing.rows[0] as { id: string; status: string; draft_content: TrainingContent };
    if (row.status !== "drafting") return reply.code(409).send({ message: "Preparation is no longer editable" });

    const content = trainingContentSchema.parse(row.draft_content);
    const updatedContent: TrainingContent = {
      ...content,
      sessionNumber: "sessionNumber" in body ? body.sessionNumber ?? null : content.sessionNumber,
      coach: "coach" in body ? body.coach ?? null : content.coach,
      notes: "notes" in body ? body.notes ?? null : content.notes,
    };
    const updated = await db.query(
      `UPDATE training_preparations SET draft_content = $2, updated_at = now() WHERE id = $1
       RETURNING id, status, draft_content, current_step`,
      [row.id, updatedContent],
    );
    return updated.rows[0];
  },
);

const refineActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("back") }),
  z.object({ action: z.literal("feedback"), instruction: z.string().trim().min(1).max(1_000) }),
  z.object({ action: z.literal("swap_exercise"), exerciseId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("edit"), value: z.string().trim().max(1_000) }),
]);

app.post(
  "/v1/teams/:teamId/events/:eventId/preparation/steps/:step",
  { onRequest: [async (request) => request.jwtVerify()] },
  async (request, reply) => {
    const identity = request.user as { sub: string };
    const { teamId, eventId, step: stepParam } = z
      .object({ teamId: z.string().uuid(), eventId: z.string().uuid(), step: z.coerce.number().int().min(0) })
      .parse(request.params);
    const body = refineActionSchema.parse(request.body);
    const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
    if (!allowed) return reply.code(403).send({ message: "Forbidden" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT id, status, draft_content, current_step FROM training_preparations WHERE team_event_id = $1 FOR UPDATE`,
        [eventId],
      );
      if (!existing.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ message: "No preparation yet" });
      }
      const row = existing.rows[0] as { id: string; status: string; draft_content: TrainingContent; current_step: number };
      if (row.status !== "drafting") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ message: "Preparation is no longer editable" });
      }

      let content = trainingContentSchema.parse(row.draft_content);
      const step = resolveStep(content, stepParam);
      let currentStep = row.current_step;

      if (body.action === "approve") {
        currentStep = Math.min(currentStep + 1, totalSteps(content) - 1);
      } else if (body.action === "back") {
        currentStep = Math.max(currentStep - 1, 0);
      } else if (body.action === "feedback") {
        const context = await buildTrainingContext(db, teamId, eventId);
        content = await refineSection(ai, content, step, body.instruction, context.candidateExercises);
      } else if (body.action === "swap_exercise") {
        content = swapExercise(content, step, body.exerciseId);
      } else {
        content = applyManualEdit(content, step, body.value);
      }

      const updated = await client.query(
        `UPDATE training_preparations SET draft_content = $2, current_step = $3, updated_at = now()
         WHERE id = $1 RETURNING id, status, draft_content, current_step`,
        [row.id, content, currentStep],
      );
      await client.query("COMMIT");
      return updated.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      const message = error instanceof Error ? error.message : "";
      if (message === "AI_NOT_CONFIGURED") return reply.code(503).send({ message: "AI service is not configured" });
      if (["STEP_OUT_OF_RANGE", "REVIEW_STEP_HAS_NO_CONTENT", "SWAP_ONLY_VALID_FOR_BLOCKS"].includes(message)) {
        return reply.code(400).send({ message });
      }
      throw error;
    } finally {
      client.release();
    }
  },
);

app.post(
  "/v1/teams/:teamId/events/:eventId/preparation/finalize",
  { onRequest: [async (request) => request.jwtVerify()] },
  async (request, reply) => {
    const identity = request.user as { sub: string };
    const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
    const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
    if (!allowed) return reply.code(403).send({ message: "Forbidden" });

    const existing = await db.query(
      `SELECT id, status, draft_content, current_step FROM training_preparations WHERE team_event_id = $1`,
      [eventId],
    );
    if (!existing.rowCount) return reply.code(404).send({ message: "No preparation yet" });
    const row = existing.rows[0] as { id: string; status: string; draft_content: TrainingContent; current_step: number };
    if (row.status !== "drafting") return reply.code(409).send({ message: "Already finalized" });
    const content = trainingContentSchema.parse(row.draft_content);
    if (row.current_step !== totalSteps(content) - 1) {
      return reply.code(409).send({ message: "Every phase and block must be approved first" });
    }
    const updated = await db.query(
      `UPDATE training_preparations SET status = 'ready', updated_at = now() WHERE id = $1
       RETURNING id, status, draft_content, current_step`,
      [row.id],
    );
    return updated.rows[0];
  },
);

app.get(
  "/v1/teams/:teamId/events/:eventId/preparation/pdf",
  { onRequest: [async (request) => request.jwtVerify()] },
  async (request, reply) => {
    const identity = request.user as { sub: string };
    const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
    const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
    if (!allowed) return reply.code(403).send({ message: "Forbidden" });

    const result = await db.query(
      `SELECT tp.status, tp.draft_content, t.name AS team_name, te.starts_at
       FROM training_preparations tp
       JOIN teams t ON t.id = tp.team_id
       JOIN team_events te ON te.id = tp.team_event_id
       WHERE tp.team_event_id = $1`,
      [eventId],
    );
    if (!result.rowCount) return reply.code(404).send({ message: "No preparation yet" });
    const row = result.rows[0] as { status: string; draft_content: TrainingContent; team_name: string; starts_at: string | Date };
    if (row.status === "drafting") return reply.code(409).send({ message: "Finalize the preparation first" });

    const content = trainingContentSchema.parse(row.draft_content);
    const exerciseNames = await resolveExerciseNames(db, content.blocks.map((block) => block.exerciseId));
    const eventDate = new Date(row.starts_at).toISOString().slice(0, 10);
    const pdf = await generateTrainingPdf(row.team_name, eventDate, content, exerciseNames);
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `inline; filename="entrenament.pdf"`);
    return reply.send(pdf);
  },
);

app.post(
  "/v1/teams/:teamId/events/:eventId/preparation/send",
  { onRequest: [async (request) => request.jwtVerify()] },
  async (request, reply) => {
    const identity = request.user as { sub: string };
    const { teamId, eventId } = z.object({ teamId: z.string().uuid(), eventId: z.string().uuid() }).parse(request.params);
    const allowed = await hasEventAccess(db, identity.sub, teamId, eventId);
    if (!allowed) return reply.code(403).send({ message: "Forbidden" });
    if (!emailConfigured(emailConfig)) return reply.code(503).send({ message: "Email is not configured" });

    const result = await db.query(
      `SELECT tp.id, tp.status, tp.draft_content, tp.created_by, t.name AS team_name, te.starts_at
       FROM training_preparations tp
       JOIN teams t ON t.id = tp.team_id
       JOIN team_events te ON te.id = tp.team_event_id
       WHERE tp.team_event_id = $1`,
      [eventId],
    );
    if (!result.rowCount) return reply.code(404).send({ message: "No preparation yet" });
    const row = result.rows[0] as {
      id: string; status: string; draft_content: TrainingContent; created_by: string; team_name: string; starts_at: string | Date;
    };
    if (row.status !== "ready") return reply.code(409).send({ message: "Finalize the preparation first" });

    const content = trainingContentSchema.parse(row.draft_content);
    const eventDate = new Date(row.starts_at).toISOString().slice(0, 10);
    const exerciseNames = await resolveExerciseNames(db, content.blocks.map((block) => block.exerciseId));
    const pdf = await generateTrainingPdf(row.team_name, eventDate, content, exerciseNames);
    const recipients = await resolveRecipients(db, teamId, row.created_by);

    try {
      await sendEmail(emailConfig, {
        to: recipients,
        subject: buildEmailSubject(row.team_name, eventDate, content),
        html: buildEmailHtml(row.team_name, eventDate, content),
        attachments: [{ filename: "entrenament.pdf", content: pdf, contentType: "application/pdf" }],
      });
    } catch (error) {
      request.log.error({ err: error, eventId }, "Training preparation email failed");
      return reply.code(502).send({ message: "Could not send the email" });
    }

    const updated = await db.query(
      `UPDATE training_preparations SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING id, status, sent_at`,
      [row.id],
    );
    return { ...updated.rows[0], recipients };
  },
);

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

// JME-43: passkey (Face ID / Touch ID / empremta) as an alternative to the
// password login below — registration requires an existing session;
// login does not, since it's how you get one.

app.post("/v1/webauthn/register/options", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const userResult = await db.query("SELECT email, name FROM users WHERE id = $1 AND active = true", [identity.sub]);
  const user = userResult.rows[0] as { email: string; name: string } | undefined;
  if (!user) return reply.code(404).send({ message: "User not found" });

  const existing = await db.query(
    "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1",
    [identity.sub],
  );

  const options = await generateRegistrationOptions({
    rpName: rpConfig.rpName,
    rpID: rpConfig.rpID,
    userName: user.email,
    userDisplayName: user.name,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred", authenticatorAttachment: "platform" },
    excludeCredentials: (existing.rows as { credential_id: string; transports: string[] }[]).map((row) => ({
      id: row.credential_id,
      transports: row.transports as AuthenticatorTransport[],
    })),
  });

  await pruneExpiredChallenges(db);
  await storeChallenge(db, options.challenge, "register", identity.sub);
  return options;
});

app.post("/v1/webauthn/register/verify", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const body = z.object({
    response: z.record(z.unknown()),
    deviceLabel: z.string().trim().max(100).optional(),
  }).parse(request.body);

  const expectedChallenge = await consumeChallenge(db, identity.sub, "register");
  if (!expectedChallenge) return reply.code(400).send({ message: "No pending registration challenge" });

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: rpConfig.origin,
      expectedRPID: rpConfig.rpID,
    });
  } catch (error) {
    request.log.warn({ err: error }, "WebAuthn registration verification failed");
    return reply.code(400).send({ message: "Registration verification failed" });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return reply.code(400).send({ message: "Registration verification failed" });
  }

  const { credential } = verification.registrationInfo;
  await db.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, sign_count, transports, device_label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [identity.sub, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], body.deviceLabel ?? null],
  );
  return reply.code(201).send({ registered: true });
});

app.post("/v1/webauthn/login/options", {
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
}, async (request) => {
  const body = z.object({ email: z.string().email() }).parse(request.body);
  const userResult = await db.query("SELECT id FROM users WHERE email = $1 AND active = true", [body.email]);
  const user = userResult.rows[0] as { id: string } | undefined;

  const credentials = user
    ? (await db.query(
        "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1",
        [user.id],
      )).rows as { credential_id: string; transports: string[] }[]
    : [];

  const options = await generateAuthenticationOptions({
    rpID: rpConfig.rpID,
    userVerification: "preferred",
    allowCredentials: credentials.map((row) => ({ id: row.credential_id, transports: row.transports as AuthenticatorTransport[] })),
  });

  // Same response shape and a real challenge either way — an unknown email
  // or one with no registered passkey never gets a different answer here,
  // matching the DUMMY_PASSWORD_HASH anti-enumeration approach /v1/session
  // already uses. user_id is stored null in that case; login/verify then
  // fails generically at the first lookup, same as a wrong password would.
  await pruneExpiredChallenges(db);
  await storeChallenge(db, options.challenge, "login", user?.id ?? null);
  return options;
});

app.post("/v1/webauthn/login/verify", {
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
}, async (request, reply) => {
  const body = z.object({
    email: z.string().email(),
    response: z.record(z.unknown()),
  }).parse(request.body);

  const userResult = await db.query("SELECT id, role FROM users WHERE email = $1 AND active = true", [body.email]);
  const user = userResult.rows[0] as { id: string; role: string } | undefined;
  if (!user) return reply.code(401).send({ message: "Unauthorized" });

  const expectedChallenge = await consumeChallenge(db, user.id, "login");
  if (!expectedChallenge) return reply.code(401).send({ message: "Unauthorized" });

  const credentialId = (body.response as { id?: unknown }).id;
  const credentialResult = typeof credentialId === "string"
    ? await db.query(
        "SELECT credential_id, public_key, sign_count, transports FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2",
        [user.id, credentialId],
      )
    : { rows: [] as unknown[] };
  const stored = credentialResult.rows[0] as { credential_id: string; public_key: Buffer; sign_count: string; transports: string[] } | undefined;
  if (!stored) return reply.code(401).send({ message: "Unauthorized" });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: rpConfig.origin,
      expectedRPID: rpConfig.rpID,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(stored.public_key),
        counter: Number(stored.sign_count),
        transports: stored.transports as AuthenticatorTransport[],
      },
    });
  } catch (error) {
    request.log.warn({ err: error }, "WebAuthn login verification failed");
    return reply.code(401).send({ message: "Unauthorized" });
  }
  if (!verification.verified) return reply.code(401).send({ message: "Unauthorized" });

  await db.query(
    "UPDATE webauthn_credentials SET sign_count = $1 WHERE credential_id = $2",
    [verification.authenticationInfo.newCounter, stored.credential_id],
  );
  return { token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: "72h" }) };
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

app.post("/v1/drive/sync", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  if (!driveConfigured(driveConfig)) return reply.code(503).send({ message: "Drive sync is not configured" });
  try {
    return await syncDriveDocuments(db, driveConfig);
  } catch (error) {
    request.log.error({ err: error }, "Drive manual sync failed");
    return reply.code(502).send({ message: "Drive sync failed" });
  }
});

app.post("/v1/drive/extract", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  if (!driveConfigured(driveConfig) || !ai.configured) {
    return reply.code(503).send({ message: "Drive extraction is not configured" });
  }
  try {
    return await extractPendingDocuments(db, driveConfig, ai);
  } catch (error) {
    request.log.error({ err: error }, "Drive manual extraction failed");
    return reply.code(502).send({ message: "Drive extraction failed" });
  }
});

app.post("/v1/drive/generate-proposals", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const actor = await isGlobalAccess(db, identity.sub);
  if (!actor) return reply.code(403).send({ message: "Forbidden" });
  if (!ai.configured) return reply.code(503).send({ message: "AI service is not configured" });
  try {
    return await generateStrategyProposals(db, ai);
  } catch (error) {
    request.log.error({ err: error }, "Strategy proposal generation failed");
    return reply.code(502).send({ message: "Proposal generation failed" });
  }
});

// Coordinator keeps editing EstrategiaHCS in Drive as normal; this just
// polls for changes on a fixed cadence rather than a specific day/time —
// unlike FECAPA there's no external server to be a considerate guest of, and
// a simple fixed interval is enough to keep source_documents fresh.
const DRIVE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
function scheduleDriveSync() {
  if (!driveConfigured(driveConfig)) {
    app.log.info("Drive sync not configured (service account or DRIVE_FOLDER_ID missing); skipping");
    return;
  }
  setTimeout(() => {
    void syncDriveDocuments(db, driveConfig)
      .then((summary) => app.log.info({ summary }, "Drive sync completed"))
      // Extraction, then proposal generation, run right after sync so a
      // newly detected document can reach a reviewable proposal in the same
      // pass — both skipped (not an error) when AI isn't configured,
      // matching the rest of the app's "AI is optional" stance.
      .then(() => {
        if (!ai.configured) return;
        return extractPendingDocuments(db, driveConfig, ai)
          .then((summary) => app.log.info({ summary }, "Drive extraction completed"))
          .then(() => generateStrategyProposals(db, ai))
          .then((summary) => app.log.info({ summary }, "Strategy proposal generation completed"));
      })
      .catch((error) => app.log.error({ err: error }, "Drive scheduled sync/extraction failed"))
      .finally(() => scheduleDriveSync());
  }, DRIVE_SYNC_INTERVAL_MS);
}
scheduleDriveSync();

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
