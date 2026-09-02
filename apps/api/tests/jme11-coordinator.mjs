import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
test("coordinator changes require a proposal and literal confirmation", () => {
  assert.match(source, /\/v1\/coordinator\/overview/);
  assert.match(source, /\/proposals/);
  assert.match(source, /proposalId\/confirm/);
  assert.match(source, /z\.literal\(true\)/);
  assert.match(source, /status = 'superseded'/);
});
