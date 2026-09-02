import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
test("team plan is authorized, versioned and included in AI context", () => {
  assert.match(source, /app\.get\("\/v1\/teams\/:teamId\/plan"/);
  assert.match(source, /app\.put\("\/v1\/teams\/:teamId\/plan"/);
  assert.match(source, /team_plans\.version \+ 1/);
  assert.match(source, /activePlan: activePlan\.rows/);
});
