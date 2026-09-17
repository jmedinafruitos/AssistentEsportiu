import { PDFDocument, PDFFont, rgb, StandardFonts } from "pdf-lib";
import { ACTIVATION_LABELS, ACTIVATION_PHASES, TrainingContent } from "./training-preparation.js";

const PAGE_WIDTH = 595.28; // A4 at 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE_HEIGHT = 16;
const INK = rgb(0.08, 0.07, 0.05);

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// One hand-laid-out A4 page matching docs/ficha-entreno-schema.md's fields —
// no diagram image embedding (see JME-44's scope notes), just a text link.
export async function generateTrainingPdf(
  teamName: string,
  eventDate: string,
  content: TrainingContent,
  exerciseNames: Map<string, string>,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = PAGE_HEIGHT - MARGIN;

  function draw(text: string, options: { size?: number; useBold?: boolean; gapBefore?: number } = {}) {
    y -= options.gapBefore ?? 0;
    for (const line of wrapText(options.useBold ? bold : font, text, options.size ?? 11, CONTENT_WIDTH)) {
      page.drawText(line, { x: MARGIN, y, size: options.size ?? 11, font: options.useBold ? bold : font, color: INK });
      y -= LINE_HEIGHT;
    }
  }

  draw(`${teamName} — Sessió ${content.sessionNumber ?? "?"}`, { size: 18, useBold: true });
  draw(`${eventDate}${content.coach ? ` · ${content.coach}` : ""}`, { size: 11, gapBefore: 4 });
  if (content.notes) draw(content.notes, { gapBefore: 8 });

  const activationLines = ACTIVATION_PHASES.filter((phase) => content.activation[phase]);
  if (activationLines.length) {
    draw("Activació", { size: 14, useBold: true, gapBefore: 16 });
    for (const phase of activationLines) draw(`${ACTIVATION_LABELS[phase]}: ${content.activation[phase]}`, { gapBefore: 4 });
  }

  draw("Blocs", { size: 14, useBold: true, gapBefore: 16 });
  content.blocks.forEach((block, index) => {
    const exerciseName = block.exerciseId ? exerciseNames.get(block.exerciseId) : undefined;
    draw(`${index + 1}. ${block.description}${exerciseName ? ` (${exerciseName})` : ""}`, { gapBefore: 6 });
    if (block.diagramAssetUrl) draw(`Diagrama: ${block.diagramAssetUrl}`, { size: 9, gapBefore: 2 });
  });

  return Buffer.from(await doc.save());
}
