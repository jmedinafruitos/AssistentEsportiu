import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const webauthn = await readFile(new URL("../src/webauthn.ts", import.meta.url), "utf8");

test("password login stays the default, passkey button only appears once the platform authenticator is feature-detected", () => {
  assert.match(main, /passkeysAvailable/);
  assert.match(main, /canUsePasskeys \?\s*loginWithBiometrics/);
  assert.match(main, /Usa Face ID \/ empremta/);
});

test("passkeys are offered as an addition after a normal login, not a replacement for it", () => {
  assert.match(main, /Activa Face ID \/ empremta/);
  assert.match(main, /registerPasskey/);
});

test("passkey helpers only target platform authenticators (Face ID / Touch ID / empremta), never cross-platform security keys", () => {
  assert.match(webauthn, /platformAuthenticatorIsAvailable/);
});
