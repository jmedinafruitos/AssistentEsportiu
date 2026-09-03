import assert from "node:assert/strict";
import test from "node:test";
import { generateSeriesOccurrences, archiveFutureOccurrences } from "../dist/training-series.js";

function makeMockDb({ holidays = [], eventTypeActions = [] } = {}) {
  const inserted = [];
  const db = {
    query: async (sql, params) => {
      if (sql.includes("FROM holidays")) {
        return { rows: holidays.map((date) => ({ date })) };
      }
      if (sql.includes("FROM event_type_actions")) {
        return { rows: eventTypeActions };
      }
      if (sql.includes("INSERT INTO team_events")) {
        const id = `event-${inserted.length + 1}`;
        const row = { id, event_type: "training", title: params[1], starts_at: params[2], ends_at: params[3], training_series_id: params[4] };
        inserted.push(row);
        return { rows: [row] };
      }
      if (sql.includes("UPDATE team_events")) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query in mock: ${sql}`);
    },
  };
  return { db, inserted };
}

const series = {
  id: "series-1",
  team_id: "team-1",
  title: "Entrenament",
  weekdays: [2], // Tuesday
  time: "18:00",
  duration_minutes: 60,
  starts_on: "2026-09-01",
  ends_on: "2026-09-30",
};

test("generates one occurrence per matching weekday, skipping holidays", async () => {
  const { db, inserted } = makeMockDb({ holidays: ["2026-09-08"] });
  const created = await generateSeriesOccurrences(db, series, "category-1", new Date("2026-09-01T00:00:00Z"), "user-1");

  const dates = created.map((event) => event.starts_at.slice(0, 10));
  assert.deepEqual(dates, ["2026-09-01", "2026-09-15", "2026-09-22", "2026-09-29"]);
  assert.equal(created.length, inserted.length);
  // 18:00 local series time stored as UTC — just confirm the time-of-day made it through untouched.
  assert.equal(created[0].starts_at.slice(11, 16), "18:00");
  assert.equal(created[0].ends_at.slice(11, 16), "19:00");
});

test("generating from a later fromDate only produces occurrences from that date on", async () => {
  const { db, inserted } = makeMockDb({ holidays: [] });
  const created = await generateSeriesOccurrences(db, series, "category-1", new Date("2026-09-16T00:00:00Z"), "user-1");
  const dates = created.map((event) => event.starts_at.slice(0, 10));
  assert.deepEqual(dates, ["2026-09-22", "2026-09-29"]);
  assert.equal(inserted.length, 2);
});

test("archiveFutureOccurrences never touches the past regardless of fromDate", async () => {
  let capturedParams;
  const db = {
    query: async (sql, params) => {
      capturedParams = params;
      assert.match(sql, /starts_at > now\(\)/);
      return { rowCount: 3 };
    },
  };
  const count = await archiveFutureOccurrences(db, "series-1", new Date("2020-01-01T00:00:00Z"));
  assert.equal(count, 3);
  assert.equal(capturedParams[0], "series-1");
  assert.equal(capturedParams[1], new Date("2020-01-01T00:00:00Z").toISOString());
});
