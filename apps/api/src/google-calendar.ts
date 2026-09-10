import { Queryable } from "./db.js";
import { getGoogleAccessToken } from "./google-auth.js";

export type CalendarConfiguration = {
  serviceAccountEmail?: string;
  serviceAccountKey?: string;
  calendarId?: string;
};
type ResolvedCalendarConfiguration = Required<CalendarConfiguration>;

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
// team_events.ends_at is nullable (JME-29); Calendar requires an end time —
// default to a 1h block when the app doesn't have one.
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

export function calendarConfigured(config: CalendarConfiguration): config is ResolvedCalendarConfiguration {
  return Boolean(config.serviceAccountEmail && config.serviceAccountKey && config.calendarId);
}

export type SyncableEvent = {
  id: string;
  title: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  location: string | null;
  notes: string | null;
  canceled: boolean;
  googleCalendarEventId: string | null;
};

export function toCalendarEventBody(event: SyncableEvent): Record<string, unknown> {
  const start = new Date(event.startsAt).toISOString();
  const end = new Date(event.endsAt ?? new Date(new Date(event.startsAt).getTime() + DEFAULT_EVENT_DURATION_MS)).toISOString();
  return {
    summary: event.title,
    location: event.location ?? undefined,
    description: event.notes ?? undefined,
    start: { dateTime: start },
    end: { dateTime: end },
    // Google Calendar has no "canceled" flag on a live event outside of
    // deleting it — cancellation is mirrored as status instead, since this
    // app itself has no hard-delete for events either (only PATCH canceled).
    status: event.canceled ? "cancelled" : "confirmed",
  };
}

async function calendarRequest(accessToken: string, method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`CALENDAR_API_ERROR_${response.status}`);
  }
  return response;
}

async function insertCalendarEvent(accessToken: string, calendarId: string, body: unknown): Promise<string> {
  const response = await calendarRequest(accessToken, "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, body);
  const created = (await response.json()) as { id: string };
  return created.id;
}

// Creates or updates the Calendar event mirroring `event`, returning the
// Calendar event id to persist back onto team_events.google_calendar_event_id
// (JME-29 already reserves that column). Write-only, one direction
// (Postgres -> Calendar) — no sync back, per this ticket's scope.
export async function upsertCalendarEvent(config: CalendarConfiguration, event: SyncableEvent): Promise<string> {
  if (!calendarConfigured(config)) throw new Error("CALENDAR_NOT_CONFIGURED");
  const accessToken = await getGoogleAccessToken(config.serviceAccountEmail, config.serviceAccountKey, CALENDAR_SCOPE);
  const body = toCalendarEventBody(event);

  if (event.googleCalendarEventId) {
    const response = await calendarRequest(
      accessToken, "PUT",
      `/calendars/${encodeURIComponent(config.calendarId)}/events/${event.googleCalendarEventId}`,
      body,
    );
    if (response.status === 404 || response.status === 410) {
      // Deleted out-of-band on the Calendar side — recreate rather than fail.
      return insertCalendarEvent(accessToken, config.calendarId, body);
    }
    const updated = (await response.json()) as { id: string };
    return updated.id;
  }
  return insertCalendarEvent(accessToken, config.calendarId, body);
}

// Best-effort orchestration for route handlers: no-ops when Calendar isn't
// configured, and persists the returned Calendar event id back onto the row
// when it's new or changed (only true on first sync).
export async function syncEventToCalendar(db: Queryable, config: CalendarConfiguration, event: SyncableEvent): Promise<void> {
  if (!calendarConfigured(config)) return;
  const googleCalendarEventId = await upsertCalendarEvent(config, event);
  if (googleCalendarEventId !== event.googleCalendarEventId) {
    await db.query(`UPDATE team_events SET google_calendar_event_id = $2 WHERE id = $1`, [event.id, googleCalendarEventId]);
  }
}
