import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("team records are authorized, persisted and supplied to AI context", () => {
  assert.match(source, /GET|app\.get\("\/v1\/teams\/:teamId\/records"/);
  assert.match(source, /app\.post\("\/v1\/teams\/:teamId\/records"/);
  assert.match(source, /recentRecords: recentRecords\.rows/);
  assert.match(source, /team_assignments/);
});
