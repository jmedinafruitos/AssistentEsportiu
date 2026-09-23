import { Queryable } from "./db.js";

// JME-59: coverage is always derived from real team_records — never a
// separate log table, so it can't drift from what actually happened.
// "Worked" means a training block's contentTaxonomyId (JME-58) points at
// that node; outcome is whatever the coach marked on the most recent one.
export type ContentCoverage = {
  id: string;
  code: string;
  label: string;
  timesWorked: number;
  lastWorkedAt: string | null;
  lastOutcome: "assolit" | "cal_repetir" | null;
};

export async function buildContentCoverage(db: Queryable, teamId: string, categoryId: string): Promise<ContentCoverage[]> {
  const result = await db.query(
    `WITH taxonomy AS (
       SELECT id, code, label FROM content_taxonomy WHERE category_id = $2 AND active = true
     ),
     blocks AS (
       SELECT
         (block->>'contentTaxonomyId')::uuid AS content_taxonomy_id,
         tr.happened_at,
         block->>'outcome' AS outcome
       FROM team_records tr
       CROSS JOIN LATERAL jsonb_array_elements(tr.content->'blocks') AS block
       WHERE tr.team_id = $1 AND tr.record_type = 'training'
         AND block ? 'contentTaxonomyId' AND block->>'contentTaxonomyId' IS NOT NULL
     ),
     ranked AS (
       SELECT *, row_number() OVER (PARTITION BY content_taxonomy_id ORDER BY happened_at DESC) AS rn
       FROM blocks
     )
     SELECT t.id, t.code, t.label,
       COALESCE(agg.times_worked, 0)::int AS times_worked,
       last.happened_at AS last_worked_at,
       last.outcome AS last_outcome
     FROM taxonomy t
     LEFT JOIN (SELECT content_taxonomy_id, count(*) AS times_worked FROM blocks GROUP BY content_taxonomy_id) agg
       ON agg.content_taxonomy_id = t.id
     LEFT JOIN (SELECT content_taxonomy_id, happened_at, outcome FROM ranked WHERE rn = 1) last
       ON last.content_taxonomy_id = t.id
     ORDER BY t.code`,
    [teamId, categoryId],
  );
  return result.rows as ContentCoverage[];
}
