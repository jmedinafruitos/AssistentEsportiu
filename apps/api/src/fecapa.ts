import * as cheerio from "cheerio";
import { Queryable } from "./db.js";
import { materializeEventActions, resolveDefaultOwner } from "./events.js";

const FECAPA_BASE = "https://www.server2.sidgad.es/fecapa";
const SYNC_WEEKDAYS = new Set(["Mon", "Thu"]);
const SYNC_HOUR = 3;
const SYNC_MINUTE = 0;

// Resolves the UTC instant for a Europe/Madrid wall-clock time, correcting
// for CET/CEST via a couple of format-and-compare passes (the offset only
// ever takes two values, so this always converges in at most 2 iterations).
function madridInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(target);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(dtf.formatToParts(guess).map((p) => [p.type, p.value]));
    const seenAsUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const diff = target - seenAsUTC;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

// Next Monday or Thursday 03:00 Europe/Madrid strictly after `from`.
export function nextFecapaSyncAt(from: Date): Date {
  const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "short" });
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
  });
  for (let addDays = 0; addDays <= 7; addDays++) {
    const day = new Date(from.getTime() + addDays * 86_400_000);
    if (!SYNC_WEEKDAYS.has(weekdayFmt.format(day))) continue;
    const parts = Object.fromEntries(dateFmt.formatToParts(day).map((p) => [p.type, p.value]));
    const candidate = madridInstant(+parts.year, +parts.month, +parts.day, SYNC_HOUR, SYNC_MINUTE);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  throw new Error("Could not compute next FECAPA sync time");
}

export type FecapaMatch = {
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  gamedate: string; // YYYYMMDD
  time: string | null; // HH:MM
};

export async function fetchFecapaCalendar(idc: number): Promise<string> {
  const response = await fetch(`${FECAPA_BASE}/fecapa_cal_idc_${idc}_1.php`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: "https://www.hoqueipatins.fecapa.cat",
      referer: "https://www.hoqueipatins.fecapa.cat/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
    },
    body: new URLSearchParams({ idc: String(idc), site_lang: "ca" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`FECAPA_FETCH_ERROR_${response.status}`);
  return response.text();
}

// Each match is a <tr class="team_{homeId} team_{awayId} team_class"
// gamedate="YYYYMMDD"> row. Names come from .nombre_junto_logo divs in the
// same DOM order as the class ids (home first, away second). Time is
// matched defensively by shape (HH:MM) rather than cell position, since
// the row layout isn't guaranteed stable across competition phases.
export function parseFecapaCalendar(html: string): FecapaMatch[] {
  const $ = cheerio.load(html);
  const matches: FecapaMatch[] = [];

  $("tr.team_class").each((_, row) => {
    const classAttr = $(row).attr("class") ?? "";
    const ids = classAttr
      .split(/\s+/)
      .filter((token) => /^team_\d+$/.test(token))
      .map((token) => Number(token.slice("team_".length)));
    if (ids.length < 2) return;
    const [homeId, awayId] = ids;

    const gamedate = $(row).attr("gamedate");
    if (!gamedate || !/^\d{8}$/.test(gamedate)) return;

    const names = $(row)
      .find(".nombre_junto_logo")
      .map((_, node) => $(node).text().trim())
      .get();
    if (names.length < 2) return;
    const [homeName, awayName] = names;

    let time: string | null = null;
    $(row)
      .find("td.tabla_standard_less")
      .each((_, cell) => {
        const text = $(cell).text().trim();
        if (/^\d{1,2}:\d{2}$/.test(text)) time = text;
      });

    matches.push({ homeId, awayId, homeName, awayName, gamedate, time });
  });

  return matches;
}

function toStartsAt(gamedate: string, time: string | null): string {
  const year = gamedate.slice(0, 4);
  const month = gamedate.slice(4, 6);
  const day = gamedate.slice(6, 8);
  const [hour, minute] = (time ?? "00:00").split(":");
  return new Date(`${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:00Z`).toISOString();
}

export type FecapaSyncSummary = { leagues: number; matchesSeen: number; eventsCreated: number; eventsUpdated: number };

export async function syncFecapaCalendars(db: Queryable): Promise<FecapaSyncSummary> {
  const teamsResult = await db.query(
    `SELECT id, fecapa_idc, fecapa_team_id, category_id
     FROM teams
     WHERE active = true AND fecapa_idc IS NOT NULL AND fecapa_team_id IS NOT NULL`,
  );
  const teams = teamsResult.rows as Array<{ id: string; fecapa_idc: number; fecapa_team_id: number; category_id: string }>;

  const teamsByIdc = new Map<number, typeof teams>();
  for (const team of teams) {
    const group = teamsByIdc.get(team.fecapa_idc) ?? [];
    group.push(team);
    teamsByIdc.set(team.fecapa_idc, group);
  }

  const summary: FecapaSyncSummary = { leagues: teamsByIdc.size, matchesSeen: 0, eventsCreated: 0, eventsUpdated: 0 };

  for (const [idc, teamsInLeague] of teamsByIdc) {
    const html = await fetchFecapaCalendar(idc);
    const matches = parseFecapaCalendar(html);
    summary.matchesSeen += matches.length;

    for (const team of teamsInLeague) {
      const relevant = matches.filter((match) => match.homeId === team.fecapa_team_id || match.awayId === team.fecapa_team_id);
      for (const match of relevant) {
        const title = `${match.homeName} - ${match.awayName}`;
        const startsAt = toStartsAt(match.gamedate, match.time);
        const externalRef = `${idc}:${match.homeId}:${match.awayId}:${match.gamedate}`;
        const idA = Math.min(match.homeId, match.awayId);
        const idB = Math.max(match.homeId, match.awayId);
        // JME-50: first position in FECAPA's own title is the home side —
        // keyed off the id comparison we already do to resolve `team`
        // above, not text-matching the club's name (its own A/B/C/D
        // lettering doesn't always match our team names, e.g. our "Alevín
        // Bronze" shows up as "HCSENTMENAT B" in FECAPA's text).
        const isHome = match.homeId === team.fecapa_team_id;

        // FECAPA occasionally republishes a match with a shifted date or a
        // swapped home/away side (JME-48) — matching on the exact
        // external_ref would treat that as a brand new fixture and leave a
        // stale duplicate behind. Instead, identify "the same real fixture"
        // by team + unordered opponent pair + gamedate within a few days,
        // and update that row in place. A real rematch against the same
        // opponent later in the season falls outside the window and still
        // inserts as its own row.
        const existing = await db.query(
          `SELECT id FROM team_events
           WHERE team_id = $1 AND source = 'fecapa' AND canceled = false
             AND split_part(external_ref, ':', 1) = $2
             AND LEAST(split_part(external_ref, ':', 2)::int, split_part(external_ref, ':', 3)::int) = $3
             AND GREATEST(split_part(external_ref, ':', 2)::int, split_part(external_ref, ':', 3)::int) = $4
             AND abs(to_date(split_part(external_ref, ':', 4), 'YYYYMMDD') - to_date($5, 'YYYYMMDD')) <= 3
           ORDER BY updated_at DESC
           LIMIT 1`,
          [team.id, String(idc), idA, idB, match.gamedate],
        );

        // notes is intentionally never touched here, on insert or update —
        // a coach may have added their own notes to an imported match, and
        // a later sync must not silently wipe them out.
        let row: { id: string; inserted: boolean };
        if (existing.rows.length > 0) {
          const result = await db.query(
            `UPDATE team_events SET title = $2, starts_at = $3, external_ref = $4, is_home = $5, updated_at = now()
             WHERE id = $1
             RETURNING id, false AS inserted`,
            [existing.rows[0].id, title, startsAt, externalRef, isHome],
          );
          row = result.rows[0] as { id: string; inserted: boolean };
        } else {
          // JME-54: owner_id set only on insert, same rule as notes above —
          // a resync must never overwrite a coordinator's reassignment.
          const ownerId = await resolveDefaultOwner(db, team.id);
          const result = await db.query(
            `INSERT INTO team_events (team_id, event_type, title, starts_at, source, external_ref, is_home, owner_id)
             VALUES ($1, 'match', $2, $3, 'fecapa', $4, $5, $6)
             RETURNING id, true AS inserted`,
            [team.id, title, startsAt, externalRef, isHome, ownerId],
          );
          row = result.rows[0] as { id: string; inserted: boolean };
        }
        if (row.inserted) {
          summary.eventsCreated += 1;
          await materializeEventActions(db, row.id, team.id, team.category_id, "match");
        } else {
          summary.eventsUpdated += 1;
        }
      }
    }
  }

  return summary;
}
