import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, parseJsonResponse } from "../dist/strategy-proposals.js";

test("parseJsonResponse parses plain JSON", () => {
  assert.deepEqual(parseJsonResponse('{"a":1}'), { a: 1 });
});

test("parseJsonResponse strips a ```json fence some models add despite instructions", () => {
  const fenced = "Here you go:\n```json\n{\"a\": 1, \"b\": [1,2]}\n```";
  assert.deepEqual(parseJsonResponse(fenced), { a: 1, b: [1, 2] });
});

test("parseJsonResponse strips a bare ``` fence with no language tag", () => {
  assert.deepEqual(parseJsonResponse('```\n{"a":1}\n```'), { a: 1 });
});

test("canonicalize makes key order irrelevant for deep equality via JSON.stringify", () => {
  const left = { b: 2, a: 1, nested: { y: 2, x: 1 } };
  const right = { a: 1, nested: { x: 1, y: 2 }, b: 2 };
  assert.equal(JSON.stringify(canonicalize(left)), JSON.stringify(canonicalize(right)));
});

test("canonicalize still detects a real difference", () => {
  const left = { a: 1 };
  const right = { a: 2 };
  assert.notEqual(JSON.stringify(canonicalize(left)), JSON.stringify(canonicalize(right)));
});

test("canonicalize sorts keys inside arrays of objects too", () => {
  const left = [{ b: 1, a: 1 }];
  const right = [{ a: 1, b: 1 }];
  assert.equal(JSON.stringify(canonicalize(left)), JSON.stringify(canonicalize(right)));
});
