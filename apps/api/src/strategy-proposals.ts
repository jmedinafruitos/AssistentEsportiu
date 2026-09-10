import { z } from "zod";
import { AiMessage, ConfigurableAiService } from "./ai.js";
import { Queryable } from "./db.js";
import { DocumentLayer } from "./drive.js";

// Seeded by migration 017 — see that file for why AI-generated proposals
// need a dedicated, unable-to-log-in system user.
export const AI_PROPOSALS_USER_EMAIL = "ai-proposals@hcsentmenat.local";

// The one layer that represents official programming (see JME-34's
// reference and club-strategy-v1's source_hierarchy_rule); the other two
// (principios, recursos) are complementary and must never be framed as
// replacing it.
const OFFICIAL_LAYER: DocumentLayer = "estructura";

type PendingSourceDocument = {
  id: string;
  title: string;
  layer: DocumentLayer;
  summary: string;
  category_scope: string[];
};

type TargetStrategyContext = { id: string; content: Record<string, unknown>; version: number };

function layerFraming(layer: DocumentLayer): { instruction: string; reasonPrefix: string } {
  if (layer === OFFICIAL_LAYER) {
    return {
      instruction:
        "Aquest document és una font de PROGRAMACIÓ OFICIAL (capa 'estructura'). " +
        "Pots proposar canvis directes a l'estructura o la periodització.",
      reasonPrefix: "Font: programació oficial (capa estructura).",
    };
  }
  return {
    instruction:
      `Aquest document és una font COMPLEMENTÀRIA (capa '${layer}'). NO ha de substituir ni canviar ` +
      "la programació oficial — proposa només addicions o enriquiment (nous exercicis, principis, notes), " +
      "mai reemplaçar continguts existents de programació.",
    reasonPrefix: `Font: material complementari (capa ${layer}) — no substitueix la programació oficial.`,
  };
}

// Models sometimes wrap JSON answers in a ```json fence despite instructions
// not to — strip it before parsing instead of failing the whole draft.
export function parseJsonResponse(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse((fenced ? fenced[1] : content).trim());
}

// Recursively sorts object keys so two semantically-identical objects with
// differently ordered keys still compare equal via JSON.stringify — an AI
// response reordering keys must not read as "the AI proposed a real change."
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

const draftResponseSchema = z.object({
  proposedContent: z.record(z.unknown()),
  reason: z.string().trim().min(1),
});

async function draftProposal(
  ai: ConfigurableAiService,
  document: PendingSourceDocument,
  context: TargetStrategyContext,
): Promise<{ proposedContent: Record<string, unknown>; reason: string }> {
  const { instruction, reasonPrefix } = layerFraming(document.layer);
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "Ets un assistent que ajuda a mantenir l'estratègia esportiva del club (un objecte JSON) a partir de " +
        'documents de Drive. Respon EXCLUSIVAMENT amb JSON vàlid, sense text addicional: {"proposedContent": ' +
        "<objecte amb la mateixa estructura que l'actual, amb els canvis aplicats>, \"reason\": <string en català " +
        "explicant què canvia i per què>}. No eliminis claus existents llevat que el document ho justifiqui " +
        "explícitament. Si el document no aporta res rellevant per a aquest context, retorna proposedContent " +
        "idèntic al contingut actual i reason explicant per què no cal cap canvi.",
    },
    {
      role: "user",
      content:
        `${instruction}\n\nCONTINGUT ACTUAL (JSON):\n${JSON.stringify(context.content)}\n\n` +
        `DOCUMENT NOU — "${document.title}" (capa: ${document.layer}):\n${document.summary}`,
    },
  ];
  const result = await ai.complete(messages);
  const parsed = draftResponseSchema.parse(parseJsonResponse(result.content));
  return { proposedContent: parsed.proposedContent, reason: `${reasonPrefix} ${parsed.reason}`.trim() };
}

// category_scope (JME-34) has no populator yet — nothing in the Drive
// ingestion pipeline can infer it from folder structure alone (the 3 layer
// folders aren't split by category). Until something does, every
// Drive-sourced proposal targets the club-wide context, which already
// carries the official/complementary-source distinction this generator
// relies on (see club-strategy-v1's source_hierarchy_rule). A populated
// category_scope is honored if present, for whenever that changes.
async function resolveTargetContexts(db: Queryable, categoryScope: string[]): Promise<TargetStrategyContext[]> {
  if (categoryScope.length === 0) {
    const result = await db.query(
      `SELECT id, content, version FROM strategy_contexts WHERE active = true AND scope = 'club' LIMIT 1`,
    );
    return result.rows as TargetStrategyContext[];
  }
  const result = await db.query(
    `SELECT sc.id, sc.content, sc.version
     FROM strategy_contexts sc JOIN categories c ON c.id = sc.category_id
     WHERE sc.active = true AND sc.scope = 'category' AND c.name = ANY($1::text[])`,
    [categoryScope],
  );
  return result.rows as TargetStrategyContext[];
}

export type ProposalGenerationSummary = {
  candidates: number;
  proposalsCreated: number;
  noChangeNeeded: number;
  failed: number;
};

// For each pending, already-summarized document (JME-36) with no proposal
// already awaiting review, drafts a proposed strategy_contexts.content patch
// per applicable context and inserts it as 'pending' (JME-11's existing
// confirm/reject/supersede flow takes it from there — this never writes to
// strategy_contexts directly). When the draft is identical to the current
// content, no proposal is created and the document is marked 'descartado'
// (reviewed automatically, nothing worth a coordinator's attention) instead
// of sitting in 'en_revision' forever.
export async function generateStrategyProposals(db: Queryable, ai: ConfigurableAiService): Promise<ProposalGenerationSummary> {
  if (!ai.configured) throw new Error("AI_NOT_CONFIGURED");

  const systemUser = await db.query(`SELECT id FROM users WHERE email = $1`, [AI_PROPOSALS_USER_EMAIL]);
  if (!systemUser.rowCount) throw new Error("AI_PROPOSALS_USER_MISSING");
  const proposedBy = (systemUser.rows[0] as { id: string }).id;

  const pending = await db.query(
    `SELECT id, title, layer, summary, category_scope
     FROM source_documents sd
     WHERE status IN ('nuevo', 'en_revision')
       AND summary IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM strategy_change_proposals scp
         WHERE scp.source_document_id = sd.id AND scp.status = 'pending'
       )
     ORDER BY ingested_at ASC LIMIT 10`,
  );

  const summary: ProposalGenerationSummary = { candidates: pending.rowCount ?? 0, proposalsCreated: 0, noChangeNeeded: 0, failed: 0 };

  for (const doc of pending.rows as PendingSourceDocument[]) {
    try {
      const targets = await resolveTargetContexts(db, doc.category_scope);
      let createdAny = false;

      for (const context of targets) {
        const draft = await draftProposal(ai, doc, context);
        const unchanged = JSON.stringify(canonicalize(draft.proposedContent)) === JSON.stringify(canonicalize(context.content));
        if (unchanged) continue;

        await db.query(
          `INSERT INTO strategy_change_proposals
             (strategy_context_id, base_version, proposed_content, reason, proposed_by, source_document_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [context.id, context.version, draft.proposedContent, draft.reason, proposedBy, doc.id],
        );
        createdAny = true;
      }

      await db.query(`UPDATE source_documents SET status = $2 WHERE id = $1`, [doc.id, createdAny ? "en_revision" : "descartado"]);
      if (createdAny) summary.proposalsCreated += 1;
      else summary.noChangeNeeded += 1;
    } catch {
      // Leave this document's status untouched so a future pass retries it;
      // one bad draft (malformed AI JSON, transient failure) must not sink
      // the batch.
      summary.failed += 1;
    }
  }

  return summary;
}
