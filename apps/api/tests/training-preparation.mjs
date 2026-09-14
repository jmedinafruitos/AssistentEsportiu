import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVATION_PHASES,
  applyManualEdit,
  buildEmailHtml,
  buildEmailSubject,
  deriveSteps,
  resolveStep,
  swapExercise,
  totalSteps,
} from "../dist/training-preparation.js";

function sampleContent(blockCount = 2) {
  return {
    sessionNumber: 3,
    coach: "Biel Cordón",
    notes: null,
    activation: { prevencion: "", activacionPorteros: "", activacionJugadores: "", integrado: "", participativo: "" },
    blocks: Array.from({ length: blockCount }, (_, index) => ({
      orderIndex: index, description: `Bloc ${index + 1}`, diagramAssetUrl: null, exerciseId: null,
    })),
  };
}

test("deriveSteps lists all 5 activation phases before blocks, ending in review", () => {
  const steps = deriveSteps(sampleContent(2));
  assert.equal(steps.length, 5 + 2 + 1);
  assert.deepEqual(steps.slice(0, 5).map((s) => s.kind), Array(5).fill("activation"));
  assert.deepEqual(steps.slice(0, 5).map((s) => s.phase), ACTIVATION_PHASES);
  assert.deepEqual(steps[5], { kind: "block", index: 0 });
  assert.deepEqual(steps[6], { kind: "block", index: 1 });
  assert.deepEqual(steps[7], { kind: "review" });
});

test("deriveSteps adapts to however many blocks the draft has (1-3)", () => {
  assert.equal(totalSteps(sampleContent(1)), 5 + 1 + 1);
  assert.equal(totalSteps(sampleContent(3)), 5 + 3 + 1);
});

test("resolveStep returns the step at that index", () => {
  const content = sampleContent(1);
  assert.deepEqual(resolveStep(content, 0), { kind: "activation", phase: "prevencion" });
  assert.deepEqual(resolveStep(content, 5), { kind: "block", index: 0 });
  assert.deepEqual(resolveStep(content, 6), { kind: "review" });
});

test("resolveStep throws on an out-of-range index", () => {
  assert.throws(() => resolveStep(sampleContent(1), 99), /STEP_OUT_OF_RANGE/);
});

test("applyManualEdit sets one activation phase without touching the others", () => {
  const content = sampleContent(1);
  const updated = applyManualEdit(content, { kind: "activation", phase: "integrado" }, "Rondo 4v2");
  assert.equal(updated.activation.integrado, "Rondo 4v2");
  assert.equal(updated.activation.prevencion, "");
  assert.equal(content.activation.integrado, "", "original content must not be mutated");
});

test("applyManualEdit sets one block's description without touching the other blocks", () => {
  const content = sampleContent(2);
  const updated = applyManualEdit(content, { kind: "block", index: 1 }, "Nova descripció");
  assert.equal(updated.blocks[1].description, "Nova descripció");
  assert.equal(updated.blocks[0].description, "Bloc 1");
});

test("applyManualEdit rejects the review step", () => {
  assert.throws(() => applyManualEdit(sampleContent(1), { kind: "review" }, "x"), /REVIEW_STEP_HAS_NO_CONTENT/);
});

test("swapExercise only applies to block steps", () => {
  const content = sampleContent(1);
  const updated = swapExercise(content, { kind: "block", index: 0 }, "11111111-1111-1111-1111-111111111111");
  assert.equal(updated.blocks[0].exerciseId, "11111111-1111-1111-1111-111111111111");
  assert.throws(() => swapExercise(content, { kind: "activation", phase: "prevencion" }, null), /SWAP_ONLY_VALID_FOR_BLOCKS/);
});

test("buildEmailSubject and buildEmailHtml include the team, session number and date", () => {
  const content = sampleContent(1);
  const subject = buildEmailSubject("Benjamín", "2026-09-14", content);
  assert.match(subject, /Benjamín/);
  assert.match(subject, /sessió 3/);
  assert.match(subject, /2026-09-14/);
  const html = buildEmailHtml("Benjamín", "2026-09-14", content);
  assert.match(html, /Benjamín/);
  assert.match(html, /Bloc 1/);
});

test("buildEmailHtml escapes HTML-significant characters in free text", () => {
  const content = sampleContent(1);
  content.notes = "Porta <script>alert(1)</script> & \"cites\"";
  const html = buildEmailHtml("Equip", "2026-09-14", content);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});
