import assert from "node:assert/strict";
import test from "node:test";
import { resolveRpConfig } from "../dist/webauthn.js";

test("derives the RP ID from WEB_ORIGIN's hostname, without scheme or port", () => {
  const config = resolveRpConfig("https://app.sentmenat.cat");
  assert.equal(config.rpID, "app.sentmenat.cat");
  assert.equal(config.origin, "https://app.sentmenat.cat");
});

test("falls back to the local Vite dev server when WEB_ORIGIN is unset", () => {
  const config = resolveRpConfig(undefined);
  assert.equal(config.rpID, "localhost");
  assert.equal(config.origin, "http://localhost:5173");
});
