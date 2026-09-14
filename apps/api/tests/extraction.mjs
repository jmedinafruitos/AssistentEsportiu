import assert from "node:assert/strict";
import test from "node:test";
import { condenseText } from "../dist/extraction.js";

test("condenseText returns short text unchanged without calling the AI", async () => {
  const ai = { complete: () => { throw new Error("should not be called for short text"); } };
  const result = await condenseText(ai, "  Un resum curt.  ");
  assert.equal(result, "Un resum curt.");
});
