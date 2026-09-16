import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("passkey registration requires an existing session and stores procedence-free credential fields", () => {
  assert.match(source, /app\.post\("\/v1\/webauthn\/register\/options", \{ onRequest: \[async \(request\) => request\.jwtVerify\(\)\] \}/);
  assert.match(source, /app\.post\("\/v1\/webauthn\/register\/verify", \{ onRequest: \[async \(request\) => request\.jwtVerify\(\)\] \}/);
  assert.match(source, /INSERT INTO webauthn_credentials/);
  assert.match(source, /authenticatorAttachment: "platform"/);
});

test("passkey login does not require a session, is rate-limited like /v1/session, and never reveals account existence", () => {
  assert.match(source, /app\.post\("\/v1\/webauthn\/login\/options", \{\s*config: \{ rateLimit: \{ max: 10, timeWindow: "1 minute" \} \}/);
  assert.match(source, /app\.post\("\/v1\/webauthn\/login\/verify", \{\s*config: \{ rateLimit: \{ max: 10, timeWindow: "1 minute" \} \}/);
  assert.match(source, /user\?\.id \?\? null/);
});

test("passkey login updates the stored sign_count after a successful verification (clone detection)", () => {
  assert.match(source, /UPDATE webauthn_credentials SET sign_count = \$1 WHERE credential_id = \$2/);
  assert.match(source, /verification\.authenticationInfo\.newCounter/);
});

test("password login stays available as a fallback alongside passkeys", () => {
  assert.match(source, /app\.post\("\/v1\/session"/);
  assert.match(source, /DUMMY_PASSWORD_HASH/);
});
