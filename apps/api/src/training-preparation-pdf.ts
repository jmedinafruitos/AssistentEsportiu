import { PDFDocument, PDFFont, rgb, StandardFonts } from "pdf-lib";
import { TrainingContent } from "./training-preparation.js";

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

// "17.30" style, matching the paper fitxa's clock-time strip — not
// "17:30", that's a deliberate house-style dot per the paper template.
function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}.${String(date.getMinutes()).padStart(2, "0")}`;
}

// One hand-laid-out A4 page (JME-60) matching the real paper fitxa: a
// clock-time schedule strip, then one numbered section per block —
// "stations"/"match" blocks list their parallel items as N.1/N.2 —
// then "Què observar" and a closing note. No diagram image embedding
// (see JME-44's scope notes), just a text link where present.
export async function generateTrainingPdf(
  teamName: string,
  eventStartsAt: string,
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

  const startsAt = new Date(eventStartsAt);
  const eventDate = startsAt.toLocaleDateString("ca", { weekday: "long", day: "numeric", month: "long" });

  draw(`${teamName} — Sessió ${content.sessionNumber ?? "?"}`, { size: 18, useBold: true });
  draw(`${eventDate}${content.coach ? ` · ${content.coach}` : ""}`, { size: 11, gapBefore: 4 });
  if (content.notes) draw(content.notes, { gapBefore: 8 });

  draw("Franja horària", { size: 14, useBold: true, gapBefore: 16 });
  let clock = new Date(startsAt);
  for (const block of content.scheduleBlocks) {
    draw(`${formatClock(clock)} · ${block.label} · ${block.durationMinutes}'`, { gapBefore: 4 });
    clock = new Date(clock.getTime() + block.durationMinutes * 60_000);
  }

  content.scheduleBlocks.forEach((block, blockIndex) => {
    const blockNumber = blockIndex + 1;
    draw(`${blockNumber}. ${block.label.toUpperCase()}`, { size: 14, useBold: true, gapBefore: 18 });
    block.items.forEach((item, itemIndex) => {
      const label = block.items.length > 1 ? `${blockNumber}.${itemIndex + 1}` : `${blockNumber}.`;
      const exerciseName = item.exerciseId ? exerciseNames.get(item.exerciseId) : undefined;
      draw(`${label} ${item.title}${exerciseName ? ` (${exerciseName})` : ""} — ${item.durationMinutes}'`, { gapBefore: 6, useBold: block.items.length > 1 });
      if (item.detail) draw(item.detail, { size: 10, gapBefore: 2 });
    });
  });

  if (content.whatToObserve.length) {
    draw("Què observar", { size: 14, useBold: true, gapBefore: 18 });
    for (const point of content.whatToObserve) draw(`• ${point}`, { gapBefore: 3 });
  }

  if (content.closingNotes) {
    draw("Tancament", { size: 14, useBold: true, gapBefore: 18 });
    draw(content.closingNotes, { gapBefore: 4 });
  }

  return Buffer.from(await doc.save());
}
