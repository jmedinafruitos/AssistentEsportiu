import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

// JME-46 replaced the home screen's open chat with an events-first list
// (no general conversation UI at all — see docs discussion in that ticket)
// plus a hamburger menu for the secondary actions that used to sit in the
// chat-suggestions bar and header buttons.
test("provides an authenticated, team-aware events-first home screen", () => {
  assert.match(source, /api\.login/);
  assert.match(source, /Equip actiu/);
  assert.match(source, /api\.createRecord/);
  assert.match(source, /coordinatorOverview/);
  assert.match(source, /PlanningEditor/);
  assert.match(source, /HamburgerMenu/);
  assert.match(source, /status-dot/);
  assert.match(source, /Prepara la sessió amb IA/);
});

test("preserves the official logo and mobile layout", () => {
  assert.match(source, /hc-sentmenat-logo\.png/);
  assert.match(styles, /object-fit: contain/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.match(html, /<html lang="ca">/);
  assert.match(html, /<title>Assistent Esportiu · HC Sentmenat<\/title>/);
  assert.equal((html.match(/name="theme-color"/g) ?? []).length, 1);
});
