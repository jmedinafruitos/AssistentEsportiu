import { z } from "zod";
import { AiMessage, ConfigurableAiService } from "./ai.js";
import { buildContentCoverage, ContentCoverage } from "./content-coverage.js";
import { Queryable } from "./db.js";
import { parseJsonResponse } from "./strategy-proposals.js";

// ---- content shape (JME-60) — a clock-time schedule of blocks, each
// with one or more items (a "stations" block runs several items in
// parallel, e.g. one per goalkeeper station), matching the real paper
// fitxa format rather than the old fixed 5-phase activation + up to 3
// generic blocks. team_records' training shape (JME-42/58) stays on
// the older flat shape deliberately — this schema is scoped to the
// AI-assisted preparation flow and its PDF/email output only. ----

export const SCHEDULE_KINDS = ["simple", "stations", "match", "closing"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

const scheduleItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  durationMinutes: z.number().int().positive().max(120),
  detail: z.string().trim().max(1_500).nullable().default(null),
  exerciseId: z.string().uuid().nullable().default(null),
  // JME-58: which content-catalog node this item delivers, and the
  // coach's own call on how it went — same fields as team_records'
  // training blocks, same purpose (feeds JME-59's coverage tracking).
  contentTaxonomyId: z.string().uuid().nullable().default(null),
  outcome: z.enum(["assolit", "cal_repetir"]).nullable().default(null),
});
export type ScheduleItem = z.infer<typeof scheduleItemSchema>;

const scheduleBlockSchema = z.object({
  label: z.string().trim().min(1).max(100),
  durationMinutes: z.number().int().positive().max(180),
  kind: z.enum(SCHEDULE_KINDS),
  // "stations"/"match" run their items in parallel (e.g. two stations
  // at once, or two simultaneous mini-matches); "simple"/"closing" run
  // theirs in sequence. Never more than 4 — matches the paper fitxa's
  // "un porter a cada estació" pattern, not an open-ended list.
  items: z.array(scheduleItemSchema).min(1).max(4),
});
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;

export const trainingContentSchema = z.object({
  sessionNumber: z.number().int().positive().nullable().default(null),
  coach: z.string().trim().max(200).nullable().default(null),
  notes: z.string().trim().max(2_000).nullable().default(null),
  scheduleBlocks: z.array(scheduleBlockSchema).min(1).max(8),
  whatToObserve: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  closingNotes: z.string().trim().max(1_000).nullable().default(null),
});
export type TrainingContent = z.infer<typeof trainingContentSchema>;

export function allExerciseIds(content: TrainingContent): Array<string | null> {
  return content.scheduleBlocks.flatMap((block) => block.items.map((item) => item.exerciseId));
}

// ---- step derivation — order is computed from content, never stored.
// One step per item (flattened across blocks), then a final review of
// the whole schedule + whatToObserve/closingNotes. ----

export type Step = { kind: "item"; blockIndex: number; itemIndex: number } | { kind: "review" };

export function deriveSteps(content: TrainingContent): Step[] {
  const steps: Step[] = [];
  content.scheduleBlocks.forEach((block, blockIndex) => {
    block.items.forEach((_, itemIndex) => steps.push({ kind: "item", blockIndex, itemIndex }));
  });
  steps.push({ kind: "review" });
  return steps;
}

export function totalSteps(content: TrainingContent): number {
  return deriveSteps(content).length;
}

export function resolveStep(content: TrainingContent, stepIndex: number): Step {
  const step = deriveSteps(content)[stepIndex];
  if (!step) throw new Error("STEP_OUT_OF_RANGE");
  return step;
}

// ---- context gathering ----

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type TrainingContext = {
  team: { id: string; name: string; season: string; categoryId: string; category: string };
  event: { id: string; startsAt: string; weekday: string };
  strategyContexts: Array<{ scope: string; content: Record<string, unknown> }>;
  plan: unknown | null;
  sessionNumber: number;
  plannedContentAreas: string[];
  dueContentTaxonomy: string | null;
  candidateExercises: Array<{ id: string; name: string; type: string; description: string | null; tags: string[] }>;
  // JME-59: real coverage from past sessions, per content-catalog node —
  // supersedes the static periodization progression above for picking
  // what to prioritize (never worked, or last marked cal_repetir, or
  // stale).
  contentCoverage: ContentCoverage[];
};

type PeriodizationShape = {
  weekly_grid?: Record<string, Array<{ weekday: string; content_area: string }>>;
  progression?: Array<{ session_number: number; content_taxonomy: string; status: string }>;
};

export async function buildTrainingContext(db: Queryable, teamId: string, eventId: string): Promise<TrainingContext> {
  const teamResult = await db.query(
    `SELECT t.id, t.name, t.season, t.category_id, c.name AS category
     FROM teams t JOIN categories c ON c.id = t.category_id WHERE t.id = $1`,
    [teamId],
  );
  if (!teamResult.rowCount) throw new Error("TEAM_NOT_FOUND");
  const team = teamResult.rows[0] as { id: string; name: string; season: string; category_id: string; category: string };

  const eventResult = await db.query(`SELECT id, starts_at FROM team_events WHERE id = $1 AND team_id = $2`, [eventId, teamId]);
  if (!eventResult.rowCount) throw new Error("EVENT_NOT_FOUND");
  const event = eventResult.rows[0] as { id: string; starts_at: string | Date };
  const startsAt = new Date(event.starts_at);
  const weekday = WEEKDAY_NAMES[startsAt.getUTCDay()];

  const contextsResult = await db.query(
    `SELECT scope, content FROM strategy_contexts
     WHERE active = true AND (scope = 'club' OR category_id = $1 OR team_id = $2)
     ORDER BY CASE scope WHEN 'club' THEN 1 WHEN 'category' THEN 2 ELSE 3 END`,
    [team.category_id, team.id],
  );
  const strategyContexts = contextsResult.rows as Array<{ scope: string; content: Record<string, unknown> }>;

  const planResult = await db.query(`SELECT content FROM team_plans WHERE team_id = $1 AND season = $2 LIMIT 1`, [team.id, team.season]);
  const plan = (planResult.rows[0] as { content: unknown } | undefined)?.content ?? null;

  const pastTrainingCount = await db.query(
    `SELECT count(*)::int AS count FROM team_records WHERE team_id = $1 AND record_type = 'training'`,
    [team.id],
  );
  const sessionNumber = (pastTrainingCount.rows[0] as { count: number }).count + 1;

  // Only a category-scoped context carries periodization (JME-40) today.
  const categoryContext = strategyContexts.find((entry) => entry.scope === "category");
  const periodization = (categoryContext?.content as { periodization?: PeriodizationShape } | undefined)?.periodization;

  const plannedContentAreas: string[] = [];
  if (periodization?.weekly_grid) {
    for (const entries of Object.values(periodization.weekly_grid)) {
      for (const entry of entries) {
        if (entry.weekday === weekday) plannedContentAreas.push(entry.content_area);
      }
    }
  }
  const dueContentTaxonomy = periodization?.progression?.find((entry) => entry.session_number === sessionNumber)?.content_taxonomy ?? null;

  const exerciseTags = [...new Set([...plannedContentAreas, ...(dueContentTaxonomy ? [dueContentTaxonomy] : [])])];
  const exercisesResult = exerciseTags.length
    ? await db.query(`SELECT id, name, type, description, tags FROM exercises WHERE tags && $1::text[] ORDER BY name LIMIT 15`, [exerciseTags])
    : await db.query(`SELECT id, name, type, description, tags FROM exercises ORDER BY name LIMIT 15`);

  const contentCoverage = await buildContentCoverage(db, team.id, team.category_id);

  return {
    team: { id: team.id, name: team.name, season: team.season, categoryId: team.category_id, category: team.category },
    event: { id: event.id, startsAt: startsAt.toISOString(), weekday },
    strategyContexts,
    plan,
    sessionNumber,
    plannedContentAreas,
    dueContentTaxonomy,
    candidateExercises: exercisesResult.rows as TrainingContext["candidateExercises"],
    contentCoverage,
  };
}

export async function resolveExerciseNames(db: Queryable, exerciseIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(exerciseIds.filter((id): id is string => id !== null))];
  if (!ids.length) return new Map();
  const result = await db.query(`SELECT id, name FROM exercises WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map((result.rows as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
}

// JME-59: nodes never worked, or last marked "cal_repetir", or not
// touched in a while, sort first — a cheap proxy for spaced repetition
// without hardcoding an interval; the AI reads the raw numbers itself.
function prioritizedCoverage(coverage: ContentCoverage[]): ContentCoverage[] {
  return [...coverage].sort((a, b) => {
    const score = (entry: ContentCoverage) => (entry.timesWorked === 0 ? 0 : entry.lastOutcome === "cal_repetir" ? 1 : 2);
    return score(a) - score(b) || (a.lastWorkedAt ?? "").localeCompare(b.lastWorkedAt ?? "");
  });
}

function contextPrompt(context: TrainingContext): string {
  return [
    `Equip: ${context.team.name} (${context.team.category}, temporada ${context.team.season}).`,
    `Sessió número: ${context.sessionNumber}. Dia de la setmana: ${context.event.weekday} (${context.event.startsAt}).`,
    context.plannedContentAreas.length
      ? `Àrees de contingut planificades per aquest dia (periodització): ${context.plannedContentAreas.join(", ")}.`
      : "Sense graella de periodització definida per a aquesta categoria encara.",
    context.dueContentTaxonomy ? `Contingut que toca introduir/reforçar segons la progressió: ${context.dueContentTaxonomy}.` : null,
    context.contentCoverage.length
      ? "Catàleg de continguts de la categoria, amb cobertura real de sessions anteriors " +
        "(timesWorked=0 vol dir mai treballat; lastOutcome=\"cal_repetir\" vol dir que la darrera vegada no es va assolir — " +
        "prioritza aquests per sobre dels ja assolits recentment): " +
        JSON.stringify(prioritizedCoverage(context.contentCoverage))
      : null,
    `Estratègia activa (club/categoria/equip): ${JSON.stringify(context.strategyContexts.map((entry) => entry.content))}`,
    context.plan ? `Pla de temporada: ${JSON.stringify(context.plan)}` : null,
    `Exercicis disponibles al banc (usa'n l'id exacte si en references un): ${JSON.stringify(context.candidateExercises)}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

// ---- AI drafting ----

export async function draftInitialContent(ai: ConfigurableAiService, context: TrainingContext): Promise<TrainingContent> {
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "Ets un assistent que ajuda entrenadors d'hoquei patins a preparar una sessió d'entrenament, seguint " +
        "el format d'una fitxa real: una franja horària de blocs (escalfament, exercicis, estacions " +
        "simultànies, partit final, tancament). " +
        'Respon EXCLUSIVAMENT amb JSON vàlid amb aquesta forma exacta: {"sessionNumber": number, "coach": ' +
        'string|null, "notes": string|null, "scheduleBlocks": [{"label": string, "durationMinutes": number, ' +
        '"kind": "simple"|"stations"|"match"|"closing", "items": [{"title": string, "durationMinutes": ' +
        'number, "detail": string|null, "exerciseId": string|null, "contentTaxonomyId": string|null}]}], ' +
        '"whatToObserve": [string], "closingNotes": string|null}. ' +
        "Entre 3 i 6 scheduleBlocks; \"stations\"/\"match\" tenen 2 items (corren en paral·lel, cadascun amb " +
        "la seva pròpia durada i porter/estació); \"simple\"/\"closing\" normalment 1 item. Si un item " +
        "references un exercici del banc, usa el seu id exacte a exerciseId; si no n'hi ha cap adequat, " +
        "deixa'l null i descriu-ho a detail. Tria contentTaxonomyId del catàleg de continguts prioritzant " +
        "els que la cobertura marca com a mai treballats o \"cal_repetir\"; si cap node hi encaixa, deixa'l " +
        "null. whatToObserve són 3-6 punts curts que l'entrenador ha de vigilar durant la sessió. Contingut " +
        "en català.",
    },
    { role: "user", content: contextPrompt(context) },
  ];
  // The full-context draft is the heaviest call in this module — a large
  // prompt (team/periodization/exercises/plan) asking for a full JSON
  // document back; the chat-tuned default timeout wasn't enough in practice.
  const result = await ai.complete(messages, 60_000);
  return trainingContentSchema.parse(parseJsonResponse(result.content));
}

const itemValueSchema = z.object({
  detail: z.string().trim().max(1_500).nullable().default(null),
  exerciseId: z.string().uuid().nullable().default(null),
});

// One scoped AI call per refine round — only the targeted item's JSON is
// requested/parsed, kept small and fast. Never touches any other item.
export async function refineSection(
  ai: ConfigurableAiService,
  content: TrainingContent,
  step: Step,
  instruction: string,
  candidateExercises: TrainingContext["candidateExercises"],
): Promise<TrainingContent> {
  if (step.kind === "review") throw new Error("REVIEW_STEP_HAS_NO_CONTENT");

  const item = content.scheduleBlocks[step.blockIndex].items[step.itemIndex];
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "Ets un assistent que ajusta UN element d'un entrenament d'hoquei patins segons el feedback de " +
        'l\'entrenador. Respon EXCLUSIVAMENT amb JSON: {"detail": string|null, "exerciseId": string|null}. Usa ' +
        "un id exacte del banc d'exercicis si n'hi ha un d'adequat, si no deixa'l null.",
    },
    {
      role: "user",
      content:
        `Element actual: ${JSON.stringify({ title: item.title, detail: item.detail, exerciseId: item.exerciseId })}\n` +
        `Feedback de l'entrenador: ${instruction}\n` +
        `Banc d'exercicis disponible: ${JSON.stringify(candidateExercises)}`,
    },
  ];
  const result = await ai.complete(messages, 45_000);
  const updated = itemValueSchema.parse(parseJsonResponse(result.content));
  return updateItem(content, step.blockIndex, step.itemIndex, (existing) => ({ ...existing, detail: updated.detail, exerciseId: updated.exerciseId }));
}

// ---- direct, non-AI edits (button/manual actions) ----

function updateItem(content: TrainingContent, blockIndex: number, itemIndex: number, patch: (item: ScheduleItem) => ScheduleItem): TrainingContent {
  const scheduleBlocks = content.scheduleBlocks.map((block, bi) =>
    bi !== blockIndex ? block : { ...block, items: block.items.map((item, ii) => (ii === itemIndex ? patch(item) : item)) },
  );
  return { ...content, scheduleBlocks };
}

export function applyManualEdit(content: TrainingContent, step: Step, value: string): TrainingContent {
  if (step.kind !== "item") throw new Error("REVIEW_STEP_HAS_NO_CONTENT");
  return updateItem(content, step.blockIndex, step.itemIndex, (item) => ({ ...item, detail: value }));
}

export function swapExercise(content: TrainingContent, step: Step, exerciseId: string | null): TrainingContent {
  if (step.kind !== "item") throw new Error("SWAP_ONLY_VALID_FOR_ITEMS");
  return updateItem(content, step.blockIndex, step.itemIndex, (item) => ({ ...item, exerciseId }));
}

// ---- recipients + email content ----

// The established "coordinator" idiom (authorization.ts's isGlobalAccess),
// generalized to a list, plus the team's assigned coaches, plus whoever
// prepared it (may not be assigned to the team, e.g. a co-coach filling in).
export async function resolveRecipients(db: Queryable, teamId: string, preparingCoachId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT DISTINCT u.email
     FROM users u
     WHERE u.active = true AND (
       u.id = $2
       OR u.global_access = true
       OR EXISTS (SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = $1)
     )`,
    [teamId, preparingCoachId],
  );
  return (result.rows as Array<{ email: string }>).map((row) => row.email);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildEmailSubject(teamName: string, eventDate: string, content: TrainingContent): string {
  return `Entrenament ${teamName} — sessió ${content.sessionNumber ?? "?"} (${eventDate})`;
}

export function buildEmailHtml(teamName: string, eventDate: string, content: TrainingContent): string {
  const scheduleItems = content.scheduleBlocks
    .map((block, index) => `<li>${index + 1}. <strong>${escapeHtml(block.label)}</strong> (${block.durationMinutes}')</li>`)
    .join("");
  return (
    `<h1>${escapeHtml(teamName)} — Sessió ${content.sessionNumber ?? "?"}</h1>` +
    `<p>${escapeHtml(eventDate)}${content.coach ? ` · ${escapeHtml(content.coach)}` : ""}</p>` +
    (content.notes ? `<p>${escapeHtml(content.notes)}</p>` : "") +
    `<h2>Franja horària</h2><ol>${scheduleItems}</ol>` +
    `<p>Detall complet a la fitxa adjunta en PDF.</p>`
  );
}
