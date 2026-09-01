import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("provides authenticated team-aware Catalan conversation controls", () => {
  assert.match(source, /api\.login/);
  assert.match(source, /Equip actiu/);
  assert.match(source, /api\.chat/);
  assert.match(source, /Què vols treballar avui/);
});

test("preserves the official logo and mobile layout", () => {
  assert.match(source, /hc-sentmenat-logo\.png/);
  assert.match(styles, /object-fit: contain/);
  assert.match(styles, /@media \(max-width: 560px\)/);
});
