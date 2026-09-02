import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
const worker = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
test("PWA is installable and updates its app shell", () => {
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(worker, /skipWaiting/);
  assert.match(worker, /clients\.claim/);
});
test("service worker never caches authenticated API requests", () => assert.match(worker, /startsWith\("\/v1\/"\)/));
