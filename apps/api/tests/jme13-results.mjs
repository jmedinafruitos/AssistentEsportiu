import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
test("assistant results remain consultable under team authorization", () => {
  assert.match(source, /\/assistant-results/);
  assert.match(source, /JOIN ai_interactions ai ON ai\.team_id = t\.id/);
  assert.match(source, /team_assignments/);
});
