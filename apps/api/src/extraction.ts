import mammoth from "mammoth";
// Import the library module directly rather than the package root: the
// root index.js has a leftover `if (!module.parent)` debug block that runs
// a self-test file read under some CJS/ESM interop loaders, which fails
// with an unrelated ENOENT unless a specific test fixture is in the CWD.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { AiMessage, ConfigurableAiService } from "./ai.js";
import { Queryable } from "./db.js";
import { DriveConfiguration, downloadDriveFile, driveConfigured, getAccessToken } from "./drive.js";

const TEXT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

// Above this length, store an AI-condensed summary instead of the raw text —
// source_documents.summary is meant to be a quick read for the coordinator
// and the input to the proposal generator (JME-38), not a document archive
// (drive_url already points back to the original for that).
const CONDENSE_THRESHOLD_CHARS = 6_000;
const MAX_CONDENSE_INPUT_CHARS = 20_000;

async function extractRawText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") return (await pdfParse(buffer)).text;
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return (await mammoth.extractRawText({ buffer })).value;
  }
  throw new Error(`UNSUPPORTED_TEXT_MIME_TYPE_${mimeType}`);
}

export async function condenseText(ai: ConfigurableAiService, text: string): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length <= CONDENSE_THRESHOLD_CHARS) return trimmed;
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "Ets un assistent que resumeix documents esportius en català, de forma fidel i concisa " +
        "(màxim 500 paraules), conservant xifres, noms d'exercicis, categories i estructura rellevants.",
    },
    { role: "user", content: trimmed.slice(0, MAX_CONDENSE_INPUT_CHARS) },
  ];
  const result = await ai.complete(messages, 45_000);
  return result.content.trim();
}

export async function describeTrainingImage(ai: ConfigurableAiService, buffer: Buffer, mimeType: string): Promise<string> {
  const messages: AiMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Aquesta imatge és una fitxa d'entrenament d'hoquei patins (diagrama de pista i notes " +
            "manuscrites abreujades). Descriu en català què s'hi veu: exercicis, disposició a la pista " +
            "i notes rellevants. No cal transcripció literal (OCR) — interpreta el contingut.",
        },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } },
      ],
    },
  ];
  const result = await ai.complete(messages, 45_000);
  return result.content.trim();
}

async function summarizeBuffer(ai: ConfigurableAiService, buffer: Buffer, mimeType: string): Promise<string> {
  if (IMAGE_MIME_TYPES.has(mimeType)) return describeTrainingImage(ai, buffer, mimeType);
  if (TEXT_MIME_TYPES.has(mimeType)) return condenseText(ai, await extractRawText(buffer, mimeType));
  throw new Error(`UNSUPPORTED_MIME_TYPE_${mimeType}`);
}

export type ExtractionSummary = {
  candidates: number;
  extracted: number;
  skippedUnsupported: number;
  failed: number;
};

type PendingDocument = { id: string; drive_file_id: string; mime_type: string };

// Only documents still needing a summary: status nuevo/en_revision (JME-34's
// "pending attention" states) with summary still NULL — a document already
// summarized for its current content isn't re-processed just because a
// proposal built from it (JME-38) hasn't been confirmed yet.
export async function extractPendingDocuments(db: Queryable, driveConfig: DriveConfiguration, ai: ConfigurableAiService): Promise<ExtractionSummary> {
  if (!driveConfigured(driveConfig)) throw new Error("DRIVE_NOT_CONFIGURED");
  if (!ai.configured) throw new Error("AI_NOT_CONFIGURED");

  const accessToken = await getAccessToken(driveConfig);
  const pending = await db.query(
    `SELECT id, drive_file_id, mime_type FROM source_documents
     WHERE status IN ('nuevo', 'en_revision') AND summary IS NULL
     ORDER BY ingested_at ASC LIMIT 20`,
  );

  const summary: ExtractionSummary = {
    candidates: pending.rowCount ?? 0,
    extracted: 0,
    skippedUnsupported: 0,
    failed: 0,
  };

  for (const row of pending.rows as PendingDocument[]) {
    try {
      if (!TEXT_MIME_TYPES.has(row.mime_type) && !IMAGE_MIME_TYPES.has(row.mime_type)) {
        // Marks it as "handled" (summary no longer NULL) so it isn't picked
        // up again on every pass — a human reviewing it sees why there's no
        // real summary instead of an unexplained blank.
        await db.query(`UPDATE source_documents SET summary = $2 WHERE id = $1`, [
          row.id,
          `[Tipus de fitxer no compatible amb el resum automàtic: ${row.mime_type}]`,
        ]);
        summary.skippedUnsupported += 1;
        continue;
      }

      const buffer = await downloadDriveFile(accessToken, row.drive_file_id);
      const text = await summarizeBuffer(ai, buffer, row.mime_type);
      await db.query(`UPDATE source_documents SET summary = $2 WHERE id = $1`, [row.id, text]);
      summary.extracted += 1;
    } catch {
      // Leave summary NULL so a future pass retries this document; one bad
      // file (corrupt PDF, transient AI failure) must not sink the batch.
      summary.failed += 1;
    }
  }

  return summary;
}
