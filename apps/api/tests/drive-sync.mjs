import assert from "node:assert/strict";
import test from "node:test";
import { decideSyncStatus, driveConfigured, resolveLayerFolder } from "../dist/drive.js";

test("resolveLayerFolder matches the 3 known layer names case-insensitively", () => {
  assert.equal(resolveLayerFolder("principios"), "principios");
  assert.equal(resolveLayerFolder("Estructura"), "estructura");
  assert.equal(resolveLayerFolder("RECURSOS"), "recursos");
  assert.equal(resolveLayerFolder("  recursos  "), "recursos");
});

test("resolveLayerFolder ignores unrelated folder names", () => {
  assert.equal(resolveLayerFolder("Archivados"), null);
  assert.equal(resolveLayerFolder(""), null);
});

test("decideSyncStatus marks a never-seen file as nuevo", () => {
  assert.equal(decideSyncStatus(undefined, "hash-a"), "nuevo");
});

test("decideSyncStatus marks a changed hash as en_revision", () => {
  assert.equal(decideSyncStatus("hash-a", "hash-b"), "en_revision");
});

test("decideSyncStatus leaves an unchanged hash alone (undefined = don't touch status)", () => {
  assert.equal(decideSyncStatus("hash-a", "hash-a"), undefined);
});

test("driveConfigured requires all three settings", () => {
  assert.equal(driveConfigured({}), false);
  assert.equal(driveConfigured({ serviceAccountEmail: "a@b.iam.gserviceaccount.com" }), false);
  assert.equal(
    driveConfigured({ serviceAccountEmail: "a@b.iam.gserviceaccount.com", serviceAccountKey: "key", folderId: "folder" }),
    true,
  );
});
