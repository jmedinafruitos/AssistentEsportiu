import assert from "node:assert/strict";
import test from "node:test";
import { calendarConfigured, toCalendarEventBody } from "../dist/google-calendar.js";

test("calendarConfigured requires all three settings", () => {
  assert.equal(calendarConfigured({}), false);
  assert.equal(calendarConfigured({ serviceAccountEmail: "a@b.iam.gserviceaccount.com" }), false);
  assert.equal(
    calendarConfigured({ serviceAccountEmail: "a@b.iam.gserviceaccount.com", serviceAccountKey: "key", calendarId: "club@group.calendar.google.com" }),
    true,
  );
});

test("toCalendarEventBody defaults a missing end time to 1h after start", () => {
  const body = toCalendarEventBody({
    id: "1", title: "Entrenament", startsAt: "2026-09-10T18:00:00.000Z", endsAt: null,
    location: null, notes: null, canceled: false, googleCalendarEventId: null,
  });
  assert.equal(body.start.dateTime, "2026-09-10T18:00:00.000Z");
  assert.equal(body.end.dateTime, "2026-09-10T19:00:00.000Z");
});

test("toCalendarEventBody keeps an explicit end time", () => {
  const body = toCalendarEventBody({
    id: "1", title: "Partit", startsAt: "2026-09-10T18:00:00.000Z", endsAt: "2026-09-10T20:00:00.000Z",
    location: "Pista Sentmenat", notes: "Amistós", canceled: false, googleCalendarEventId: "abc",
  });
  assert.equal(body.end.dateTime, "2026-09-10T20:00:00.000Z");
  assert.equal(body.location, "Pista Sentmenat");
  assert.equal(body.description, "Amistós");
});

test("toCalendarEventBody maps canceled=true to a cancelled status, not a deletion", () => {
  const body = toCalendarEventBody({
    id: "1", title: "Entrenament", startsAt: "2026-09-10T18:00:00.000Z", endsAt: null,
    location: null, notes: null, canceled: true, googleCalendarEventId: "abc",
  });
  assert.equal(body.status, "cancelled");
});

test("toCalendarEventBody accepts a Date instance for startsAt/endsAt", () => {
  const body = toCalendarEventBody({
    id: "1", title: "Entrenament", startsAt: new Date("2026-09-10T18:00:00.000Z"), endsAt: null,
    location: null, notes: null, canceled: false, googleCalendarEventId: null,
  });
  assert.equal(body.start.dateTime, "2026-09-10T18:00:00.000Z");
});
