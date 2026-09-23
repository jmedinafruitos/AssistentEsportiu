import { z } from "zod";
import { AiMessage, ConfigurableAiService } from "./ai.js";
import { buildContentCoverage, ContentCoverage } from "./content-coverage.js";
import { Queryable } from "./db.js";
import { parseJsonResponse } from "./strategy-proposals.js";

// ---- content shape — mirrors docs/ficha-entreno-schema.md (JME-42),
// team_records.content for record_type='training'. A finished preparation
// can later seed that real record; not wired up in this pass. ----

export const ACTIVATION_PHASES = ["prevencion", "activacionPorteros", "activacionJugadores", "integrado", "participativo"] as const;
export type ActivationPhase = (typeof ACTIVATION_PHASES)[number];
export const ACTIVATION_LABELS: Record<ActivationPhase, string> = {
  prevencion: "Prevenció",
  activacionPorteros: "Activació porters",
  activacionJugadores: "Activació jugadors",
  integrado: "Integrat",
  participativo: "Participatiu",
};

const activationSchema = z.object({
  prevencion: z.string().trim().max(500).default(""),
  activacionPorteros: z.string().trim().max(500).default(""),
  activacionJugadores: z.string().trim().max(500).default(""),
  integrado: z.string().trim().max(500).default(""),
  participativo: z.string().trim().max(500).default(""),
});

const blockSchema = z.object({
  orderIndex: z.number().int().min(0),
  description: z.string().trim().min(1).max(1_000),
  diagramAssetUrl: z.string().trim().max(500).nullable().default(null),
  exerciseId: z.string().uuid().nullable().default(null),
  // JME-58: mirrors team_records' training blocks — set once the coach
  // picks/confirms which content-catalog node this block delivers.
  contentTaxonomyId: z.string().uuid().nullable().default(null),
  outcome: z.enum(["assolit", "cal_repetir"]).nullable().default(null),
});

export const trainingContentSchema = z.object({
  sessionNumber: z.number().int().positive().nullable().default(null),
  coach: z.string().trim().max(200).nullable().default(null),
  notes: z.string().trim().max(2_000).nullable().default(null),
  activation: activationSchema,
  blocks: z.array(blockSchema).min(1).max(3),
});
export type TrainingContent = z.infer<typeof trainingContentSchema>;

// ---- step derivation — order is computed from content, never stored ----

export type Step = { kind: "activation"; phase: ActivationPhase } | { kind: "block"; index: number } | { kind: "review" };

export function deriveSteps(content: TrainingContent): Step[] {
  return [
    ...ACTIVATION_PHASES.map((phase): Step => ({ kind: "activation", phase })),
    ...content.blocks.map((_, index): Step => ({ kind: "block", index })),
    { kind: "review" },
  ];
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
        "Ets un assistent que ajuda entrenadors d'hoquei patins a preparar una sessió d'entrenament. " +
        'Respon EXCLUSIVAMENT amb JSON vàlid amb aquesta forma exacta: {"sessionNumber": number, "coach": ' +
        'string|null, "notes": string|null, "activation": {"prevencion": string, "activacionPorteros": ' +
        'string, "activacionJugadores": string, "integrado": string, "participativo": string}, "blocks": ' +
        '[{"orderIndex": number, "description": string, "diagramAssetUrl": null, "exerciseId": string|null, ' +
        '"contentTaxonomyId": string|null}]}. ' +
        "Entre 1 i 3 blocs. Si references un exercici del banc, usa el seu id exacte a exerciseId; si no n'hi " +
        "ha cap adequat, deixa'l null i descriu-ho a description. Tria contentTaxonomyId del catàleg de " +
        "continguts prioritzant els que la cobertura marca com a mai treballats o \"cal_repetir\"; si cap " +
        "node del catàleg hi encaixa, deixa'l null. diagramAssetUrl sempre null (es gestiona fora d'aquest " +
        "flux). Contingut en català.",
    },
    { role: "user", content: contextPrompt(context) },
  ];
  // The full-context draft is the heaviest call in this module — a large
  // prompt (team/periodization/exercises/plan) asking for a full JSON
  // document back; the chat-tuned default timeout wasn't enough in practice.
  const result = await ai.complete(messages, 60_000);
  return trainingContentSchema.parse(parseJsonResponse(result.content));
}

const activationValueSchema = z.object({ value: z.string().trim().max(500) });
const blockValueSchema = z.object({
  description: z.string().trim().min(1).max(1_000),
  exerciseId: z.string().uuid().nullable().default(null),
});

// One scoped AI call per refine round — only the targeted section's JSON is
// requested/parsed, kept small and fast. Never touches any other section.
export async function refineSection(
  ai: ConfigurableAiService,
  content: TrainingContent,
  step: Step,
  instruction: string,
  candidateExercises: TrainingContext["candidateExercises"],
): Promise<TrainingContent> {
  if (step.kind === "review") throw new Error("REVIEW_STEP_HAS_NO_CONTENT");

  if (step.kind === "activation") {
    const current = content.activation[step.phase];
    const messages: AiMessage[] = [
      {
        role: "system",
        content:
          "Ets un assistent que ajusta UNA fase d'activació d'un entrenament d'hoquei patins segons el " +
          'feedback de l\'entrenador. Respon EXCLUSIVAMENT amb JSON: {"value": string}. Si el feedback demana ' +
          'ometre la fase, retorna value buit ("").',
      },
      { role: "user", content: `Fase: ${step.phase}\nText actual: ${current || "(buit)"}\nFeedback de l'entrenador: ${instruction}` },
    ];
    const result = await ai.complete(messages, 45_000);
    const { value } = activationValueSchema.parse(parseJsonResponse(result.content));
    return { ...content, activation: { ...content.activation, [step.phase]: value } };
  }

  const block = content.blocks[step.index];
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "Ets un assistent que ajusta UN bloc/exercici d'un entrenament d'hoquei patins segons el feedback de " +
        'l\'entrenador. Respon EXCLUSIVAMENT amb JSON: {"description": string, "exerciseId": string|null}. Usa ' +
        "un id exacte del banc d'exercicis si n'hi ha un d'adequat, si no deixa'l null.",
    },
    {
      role: "user",
      content:
        `Bloc actual: ${JSON.stringify({ description: block.description, exerciseId: block.exerciseId })}\n` +
        `Feedback de l'entrenador: ${instruction}\n` +
        `Banc d'exercicis disponible: ${JSON.stringify(candidateExercises)}`,
    },
  ];
  const result = await ai.complete(messages, 45_000);
  const updated = blockValueSchema.parse(parseJsonResponse(result.content));
  const blocks = content.blocks.map((existing, index) =>
    index === step.index ? { ...existing, description: updated.description, exerciseId: updated.exerciseId } : existing,
  );
  return { ...content, blocks };
}

// ---- direct, non-AI edits (button/manual actions) ----

export function applyManualEdit(content: TrainingContent, step: Step, value: string): TrainingContent {
  if (step.kind === "activation") return { ...content, activation: { ...content.activation, [step.phase]: value } };
  if (step.kind === "block") {
    const blocks = content.blocks.map((block, index) => (index === step.index ? { ...block, description: value } : block));
    return { ...content, blocks };
  }
  throw new Error("REVIEW_STEP_HAS_NO_CONTENT");
}

export function swapExercise(content: TrainingContent, step: Step, exerciseId: string | null): TrainingContent {
  if (step.kind !== "block") throw new Error("SWAP_ONLY_VALID_FOR_BLOCKS");
  const blocks = content.blocks.map((block, index) => (index === step.index ? { ...block, exerciseId } : block));
  return { ...content, blocks };
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
  const activationItems = ACTIVATION_PHASES.filter((phase) => content.activation[phase])
    .map((phase) => `<li><strong>${ACTIVATION_LABELS[phase]}:</strong> ${escapeHtml(content.activation[phase])}</li>`)
    .join("");
  const blockItems = content.blocks.map((block, index) => `<li>${index + 1}. ${escapeHtml(block.description)}</li>`).join("");
  return (
    `<h1>${escapeHtml(teamName)} — Sessió ${content.sessionNumber ?? "?"}</h1>` +
    `<p>${escapeHtml(eventDate)}${content.coach ? ` · ${escapeHtml(content.coach)}` : ""}</p>` +
    (content.notes ? `<p>${escapeHtml(content.notes)}</p>` : "") +
    (activationItems ? `<h2>Activació</h2><ul>${activationItems}</ul>` : "") +
    `<h2>Blocs</h2><ol>${blockItems}</ol>` +
    `<p>Detall complet a la fitxa adjunta en PDF.</p>`
  );
}
