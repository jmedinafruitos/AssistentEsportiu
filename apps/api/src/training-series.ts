import { Queryable } from "./db.js";
import { materializeEventActions } from "./events.js";

export type TrainingSeries = {
  id: string;
  team_id: string;
  title: string;
  weekdays: number[];
  time: string;
  duration_minutes: number | null;
  starts_on: string;
  ends_on: string;
};

// starts_on/ends_on are DATE columns. index.ts configures pg to return
// those as plain 'YYYY-MM-DD' strings (matching TrainingSeries' type), but
// this stays defensive in case that isn't true for some caller — a raw
// Date here would silently stringify wrong inside a template literal.
function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

async function holidaySet(db: Queryable, from: Date, to: Date): Promise<Set<string>> {
  const result = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM holidays WHERE date >= $1 AND date <= $2`,
    [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
  );
  return new Set((result.rows as Array<{ date: string }>).map((row) => row.date));
}

// Materializes concrete team_events rows for a series from `fromDate`
// (inclusive) through the series' ends_on, skipping official holidays.
// Used for initial series creation and for regenerating after a
// this-and-following/all edit — always starting from a caller-supplied
// date, never touching anything before it.
export async function generateSeriesOccurrences(
  db: Queryable,
  series: TrainingSeries,
  categoryId: string,
  fromDate: Date,
  createdBy: string | null,
) {
  const seriesEnd = new Date(`${dateOnly(series.ends_on)}T00:00:00Z`);
  const holidays = await holidaySet(db, fromDate, seriesEnd);
  const weekdaySet = new Set(series.weekdays);
  const [hour, minute] = series.time.split(":").map(Number);
  const created = [];

  for (
    const cursor = new Date(fromDate);
    cursor <= seriesEnd;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    if (!weekdaySet.has(cursor.getUTCDay())) continue;
    if (holidays.has(cursor.toISOString().slice(0, 10))) continue;

    const startsAt = new Date(cursor);
    startsAt.setUTCHours(hour, minute, 0, 0);
    const endsAt = series.duration_minutes ? new Date(startsAt.getTime() + series.duration_minutes * 60_000) : null;

    const event = await db.query(
      `INSERT INTO team_events (team_id, event_type, title, starts_at, ends_at, source, training_series_id, created_by)
       VALUES ($1, 'training', $2, $3, $4, 'recurring', $5, $6)
       RETURNING id, event_type, title, starts_at, ends_at, location, notes, source, canceled, created_at, training_series_id`,
      [series.team_id, series.title, startsAt.toISOString(), endsAt ? endsAt.toISOString() : null, series.id, createdBy],
    );
    const createdEvent = event.rows[0];
    await materializeEventActions(db, createdEvent.id, series.team_id, categoryId, "training");
    created.push(createdEvent);
  }
  return created;
}

// Archives (never deletes — team_records.team_event_id has no ON DELETE
// CASCADE, and archiving preserves history) every not-yet-overridden
// future occurrence of a series. `fromDate` scopes this to a
// this-and-following split point; omit it for a whole-series "all" edit.
// Never touches anything at or before now(), regardless of fromDate.
export async function archiveFutureOccurrences(db: Queryable, seriesId: string, fromDate?: Date): Promise<number> {
  const result = await db.query(
    `UPDATE team_events
     SET archived_at = now()
     WHERE training_series_id = $1
       AND archived_at IS NULL
       AND starts_at > now()
       AND ($2::timestamptz IS NULL OR starts_at >= $2)
     RETURNING id`,
    [seriesId, fromDate ? fromDate.toISOString() : null],
  );
  return result.rowCount ?? 0;
}
