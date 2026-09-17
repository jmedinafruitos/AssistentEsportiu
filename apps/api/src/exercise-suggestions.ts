import { z } from "zod";
import { AiMessage, ConfigurableAiService } from "./ai.js";
import { parseJsonResponse } from "./strategy-proposals.js";

// "Carga inicial: etiquetar (semi-automático vía IA + revisión)" — exercises
// has no draft/pending state, so review happens by construction: this only
// ever returns candidates, and a coordinator decides which become real rows
// via the normal POST /v1/exercises (which can cite the same
// sourceDocumentId/pageRef back).
const suggestionSchema = z.object({
  exercises: z.array(z.object({
    name: z.string().trim().min(1),
    type: z.enum(["juego", "circuito", "ejercicio", "tactica"]),
    description: z.string().trim().min(1),
    variants: z.array(z.string().trim().min(1)).default([]),
    tags: z.array(z.string().trim().min(1)).default([]),
    pageRef: z.string().trim().min(1).nullable().default(null),
  })).max(30),
});
export type ExerciseSuggestion = z.infer<typeof suggestionSchema>["exercises"][number];

export async function suggestExercisesFromSummary(
  ai: ConfigurableAiService,
  documentTitle: string,
  summary: string,
): Promise<ExerciseSuggestion[]> {
  if (!ai.configured) throw new Error("AI_NOT_CONFIGURED");
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "Ets un assistent que identifica exercicis i jocs individuals d'hoquei patins descrits en un document " +
        'de referència. Respon EXCLUSIVAMENT amb JSON vàlid: {"exercises": [{"name", "type" ' +
        '(juego|circuito|ejercicio|tactica), "description", "variants": string[], "tags": string[], ' +
        '"pageRef": string o null}]}. Màxim 30 exercicis, els més clars i reutilitzables. No inventis ' +
        "exercicis que no apareguin al document.",
    },
    { role: "user", content: `DOCUMENT — "${documentTitle}":\n${summary}` },
  ];
  const result = await ai.complete(messages, 45_000);
  return suggestionSchema.parse(parseJsonResponse(result.content)).exercises;
}
