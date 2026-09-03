import assert from "node:assert/strict";
import test from "node:test";
import { nextFecapaSyncAt } from "../dist/fecapa.js";

function madridParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid", hourCycle: "h23", weekday: "short",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: +parts.hour, minute: +parts.minute };
}

function assertLandsOnMonOrThuAt3am(from, label) {
  const result = nextFecapaSyncAt(from);
  const parts = madridParts(result);
  assert.ok(result.getTime() > from.getTime(), `${label}: result must be strictly after from`);
  assert.ok(["Mon", "Thu"].includes(parts.weekday), `${label}: expected Mon/Thu, got ${parts.weekday}`);
  assert.equal(parts.hour, 3, `${label}: expected hour 03`);
  assert.equal(parts.minute, 0, `${label}: expected minute 00`);
  // Max gap between consecutive Mon/Thu occurrences is 4 days (Thu->Mon);
  // allow a couple of extra hours of slack for a DST shift landing in between.
  const maxGapMs = 4 * 86_400_000 + 2 * 3_600_000;
  assert.ok(result.getTime() - from.getTime() <= maxGapMs, `${label}: gap too large (${result.getTime() - from.getTime()}ms)`);
  return result;
}

test("picks the next Mon/Thu 03:00 Europe/Madrid from an arbitrary weekday", () => {
  assertLandsOnMonOrThuAt3am(new Date("2026-09-02T10:00:00Z"), "mid-week");
});

test("from exactly a scheduled instant, picks the following one, not the same one", () => {
  const monday3am = nextFecapaSyncAt(new Date("2026-01-01T00:00:00Z"));
  const next = nextFecapaSyncAt(monday3am);
  assert.ok(next.getTime() > monday3am.getTime());
});

test("holds across the spring-forward DST boundary (late March)", () => {
  assertLandsOnMonOrThuAt3am(new Date("2026-03-27T12:00:00Z"), "spring-forward");
});

test("holds across the fall-back DST boundary (late October)", () => {
  assertLandsOnMonOrThuAt3am(new Date("2026-10-23T12:00:00Z"), "fall-back");
});

test("holds across a year boundary", () => {
  assertLandsOnMonOrThuAt3am(new Date("2026-12-30T23:00:00Z"), "year-boundary");
});
