import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ACTIVATION_LABELS, ACTIVATION_PHASES, api, ConflictDetail, CoordinatorMatch, CoordinatorOverview, CurrentUser, derivePreparationSteps, EventAction, EventReadiness, EventTypeActionTemplate, Exercise, Player, RecordInput, RefineAction, RosterEntry, Team, TeamEvent, TeamPlan, TrainingPreparation, TrainingSeries } from "./api";
import { loginWithPasskey, passkeysAvailable, registerPasskey } from "./webauthn";
import "./styles.css";

const TOKEN_KEY = "assistent-esportiu-token";
const TEAM_KEY = "assistent-esportiu-team";
// Sentinel for "Tots els equips" in the team selector — not a real team
// id, so it never collides with one.
const ALL_TEAMS = "__all__";

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  // Persisted so the next visit remembers the last selection, including
  // "Tots els equips" — not just a real team id.
  const [teamId, setTeamIdState] = useState(() => localStorage.getItem(TEAM_KEY) ?? "");
  function setTeamId(id: string) { localStorage.setItem(TEAM_KEY, id); setTeamIdState(id); }
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const [overview, setOverview] = useState<CoordinatorOverview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<{ event: TeamEvent; actions: EventAction[] } | null>(null);
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [managingTemplates, setManagingTemplates] = useState(false);
  const [syncingFecapa, setSyncingFecapa] = useState(false);
  const [canUsePasskeys, setCanUsePasskeys] = useState(false);
  const [activatingPasskey, setActivatingPasskey] = useState(false);
  const [preparing, setPreparing] = useState<{ id: string; teamId: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [managingPlayers, setManagingPlayers] = useState(false);
  // JME-54: cross-cutting filter, independent of team scope — not
  // persisted, defaults to "Tots" (unfiltered) each visit.
  const [mineOnly, setMineOnly] = useState(false);
  const [viewingMatches, setViewingMatches] = useState(false);

  useEffect(() => { void passkeysAvailable().then(setCanUsePasskeys); }, []);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([api.me(token), api.teams(token)]).then(([identity, result]) => {
      setUser(identity); setTeams(result.teams); if (!teamId) setTeamId(result.teams[0]?.id || ""); setError("");
    }).catch(() => logout()).finally(() => setLoading(false));
  }, [token]);

  const week = useMemo(() => weekBounds(weekOffset), [weekOffset]);
  useEffect(() => {
    if (!token || !teamId) { setEvents([]); return; }
    const weekQuery = { from: week.from, to: week.to, mine: mineOnly };
    const fetchEvents = teamId === ALL_TEAMS ? api.allEvents(token, weekQuery) : api.events(token, teamId, weekQuery);
    void fetchEvents.then((result) => setEvents(result.events)).catch(() => {});
  }, [token, teamId, week.from, week.to, mineOnly]);

  async function refreshEvents() {
    if (!teamId) return;
    const weekQuery = { from: week.from, to: week.to, mine: mineOnly };
    const result = teamId === ALL_TEAMS ? await api.allEvents(token, weekQuery) : await api.events(token, teamId, weekQuery);
    setEvents(result.events);
  }

  async function openEvent(eventTeamId: string, eventId: string) {
    // Deliberately doesn't touch viewingMatches: EventDetail's early
    // return takes priority over it regardless, so leaving it true when
    // the match came from "Partits" means closing the event correctly
    // falls back to that screen instead of the home events list.
    try { setSelectedEvent(await api.eventDetail(token, eventTeamId, eventId)); }
    catch { setError("No s'ha pogut carregar l'esdeveniment."); }
  }

  async function syncFecapa() {
    setSyncingFecapa(true); setError("");
    try {
      const summary = await api.syncFecapa(token);
      setNotice(`FECAPA sincronitzat: ${summary.eventsCreated} partits nous, ${summary.eventsUpdated} actualitzats (${summary.leagues} lligues).`);
      void refreshEvents();
    } catch { setError("No s'ha pogut sincronitzar amb FECAPA."); }
    finally { setSyncingFecapa(false); }
  }

  const activeTeam = useMemo(() => teams.find((team) => team.id === teamId), [teams, teamId]);
  // "Tots els equips" is an events-list viewing mode only — actions that
  // need one specific team (add event, record activity, planning,
  // players) fall back to the first team while it's selected.
  const actionTeam = activeTeam ?? teams[0];
  const actionTeamId = actionTeam?.id ?? "";
  function logout() { localStorage.removeItem(TOKEN_KEY); setToken(""); setUser(null); setTeams([]); }

  function applyToken(newToken: string) { localStorage.setItem(TOKEN_KEY, newToken); setToken(newToken); }

  async function login(email: string, password: string) {
    setLoading(true); setError("");
    try { applyToken((await api.login(email, password)).token); }
    catch { setError("Correu o contrasenya incorrectes."); setLoading(false); }
  }

  async function loginWithBiometrics(email: string) {
    setLoading(true); setError("");
    try { applyToken(await loginWithPasskey(email)); }
    catch { setError("No s'ha pogut iniciar sessió amb Face ID / empremta. Prova amb la contrasenya."); setLoading(false); }
  }

  async function activatePasskey() {
    setActivatingPasskey(true); setError("");
    try { await registerPasskey(token, navigator.platform || undefined); setNotice("Login biomètric activat en aquest dispositiu."); }
    catch { setError("No s'ha pogut activar el login biomètric en aquest dispositiu."); }
    finally { setActivatingPasskey(false); }
  }

  if (!token || (!user && !loading)) return <Login onLogin={login} onPasskeyLogin={canUsePasskeys ? loginWithBiometrics : undefined} loading={loading} error={error} />;
  if (!user) return <main className="centered" aria-live="polite">Carregant el teu context…</main>;
  // JME-47: an open event workspace takes over the whole screen instead of
  // overlaying the home screen — "Enrere" inside each component returns
  // here by clearing this state.
  if (selectedEvent) return <EventDetail token={token} teamId={selectedEvent.event.team_id} detail={selectedEvent} canReassignOwner={user.global_access} onClose={() => setSelectedEvent(null)} onChanged={(detail) => { setSelectedEvent(detail); void refreshEvents(); }} />;
  if (preparing) return <TrainingPreparationModal token={token} teamId={preparing.teamId} eventId={preparing.id} teamName={teams.find((team) => team.id === preparing.teamId)?.name ?? "l'equip"} onClose={() => setPreparing(null)} />;
  if (viewingMatches) return <MatchesOverview token={token} onOpenEvent={(eventTeamId, eventId) => void openEvent(eventTeamId, eventId)} onClose={() => setViewingMatches(false)} />;

  return <main className="assistant-shell">
    <header className="app-header">
      <div className="brand"><img className="club-logo compact" src="/hc-sentmenat-logo.png" alt="Escut de l'HC Sentmenat" /><div><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1></div></div>
      <button type="button" className="menu-btn" aria-label="Menú" onClick={() => setMenuOpen(true)}><svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="#173b6d" strokeWidth="2" strokeLinecap="round"><path d="M1 1h16M1 7h16M1 13h16" /></svg></button>
    </header>
    {(activeTeam || teamId === ALL_TEAMS) && <p className="team-pill-row"><span className="team-pill">{teamId === ALL_TEAMS ? "Tots els equips" : `${activeTeam!.name} · ${activeTeam!.season}`}</span></p>}
    <section className="events">
      <div className="events-header"><h2>Esdeveniments</h2><div className="dialog-actions mode-switch"><button type="button" className={mineOnly ? "" : "quiet"} onClick={() => setMineOnly(true)}>Meus</button><button type="button" className={mineOnly ? "quiet" : ""} onClick={() => setMineOnly(false)}>Tots</button></div></div>
      <div className="week-nav"><button type="button" className="quiet" onClick={() => setWeekOffset((current) => current - 1)} aria-label="Setmana anterior">‹</button><span>{week.label}</span><button type="button" className="quiet" onClick={() => setWeekOffset((current) => current + 1)} aria-label="Setmana següent">›</button></div>
      {events.length
        ? <ul className="event-list">{events.map((event) => {
            const showTitle = event.title.trim().toLowerCase() !== eventTypeLabel(event.event_type).toLowerCase();
            return <li key={event.id} className="event-card"><button type="button" className={`event-item ${event.canceled ? "canceled" : ""}`} onClick={() => void openEvent(event.team_id, event.id)}><span className={`status-dot ${readinessDotClass(event.readiness)}`} aria-label={readinessLabel(event.readiness)} title={readinessLabel(event.readiness)} /><span className={`event-type ${event.event_type}`}>{eventTypeLabel(event.event_type)}</span>{teamId === ALL_TEAMS && <em className="event-team-tag">{event.team_name}</em>}{!mineOnly && event.owner_name && <em className="event-team-tag">{event.owner_name}</em>}{showTitle && <strong>{event.title}</strong>}<span>{formatEventTime(event)}</span>{event.canceled && <em>Cancel·lat</em>}</button>{event.event_type === "training" && !event.canceled && <button type="button" className="row-action" onClick={() => setPreparing({ id: event.id, teamId: event.team_id })}>{prepareActionLabel(event.readiness)}</button>}</li>;
          })}</ul>
        : <p className="empty">Sense esdeveniments aquesta setmana.</p>}
    </section>
    {overview && <CoordinatorPanel overview={overview} />}
    {menuOpen && <HamburgerMenu
      user={user} teams={teams} teamId={teamId} syncingFecapa={syncingFecapa}
      canUsePasskeys={canUsePasskeys} activatingPasskey={activatingPasskey}
      onClose={() => setMenuOpen(false)}
      onSelectTeam={(id) => { setTeamId(id); setWeekOffset(0); setMenuOpen(false); }}
      onAddEvent={() => { setCreatingEvent(true); setMenuOpen(false); }}
      onRecordActivity={() => { setRecording(true); setMenuOpen(false); }}
      onPlanning={() => { setPlanning(true); setMenuOpen(false); }}
      onManagePlayers={() => { setManagingPlayers(true); setMenuOpen(false); }}
      onManageTemplates={() => { setManagingTemplates(true); setMenuOpen(false); }}
      onSyncFecapa={() => { setMenuOpen(false); void syncFecapa(); }}
      onActivatePasskey={() => void activatePasskey()}
      onViewMatches={() => { setViewingMatches(true); setMenuOpen(false); }}
      onShowOverview={() => {
        setMenuOpen(false);
        if (overview) setOverview(null);
        else void api.coordinatorOverview(token).then(setOverview).catch(() => setError("No s'ha pogut carregar la visió global."));
      }}
      onLogout={() => { setMenuOpen(false); logout(); }}
    />}
    {recording && <RecordCapture teamName={actionTeam?.name ?? "l'equip"} coachName={user.name} token={token} onCancel={() => setRecording(false)} onSave={async (record) => { await api.createRecord(token, actionTeamId, record); setRecording(false); setNotice("Activitat desada a l'historial de l'equip."); }} />}
    {planning && <PlanningEditor token={token} teamId={actionTeamId} teamName={actionTeam?.name ?? "l'equip"} onClose={() => setPlanning(false)} />}
    {managingPlayers && <PlayersEditor token={token} teams={teams} teamId={actionTeamId} onClose={() => setManagingPlayers(false)} />}
    {creatingEvent && <EventEditor token={token} teamId={actionTeamId} onClose={() => setCreatingEvent(false)} onSaved={() => { setCreatingEvent(false); void refreshEvents(); }} />}
    {managingTemplates && <ActionTemplatesEditor token={token} teams={teams} onClose={() => setManagingTemplates(false)} />}
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}

// JME-46: secondary/occasional actions live here now instead of scattered
// across the header and a chat-suggestions bar that no longer exists —
// team switch, add event, the two things that used to be chat-suggestion
// buttons (record activity, planning), and the coordinator-only actions.
function HamburgerMenu({ user, teams, teamId, syncingFecapa, canUsePasskeys, activatingPasskey, onClose, onSelectTeam, onAddEvent, onRecordActivity, onPlanning, onManagePlayers, onManageTemplates, onSyncFecapa, onActivatePasskey, onViewMatches, onShowOverview, onLogout }: {
  user: CurrentUser; teams: Team[]; teamId: string; syncingFecapa: boolean; canUsePasskeys: boolean; activatingPasskey: boolean;
  onClose: () => void; onSelectTeam: (teamId: string) => void; onAddEvent: () => void;
  onRecordActivity: () => void; onPlanning: () => void; onManagePlayers: () => void; onManageTemplates: () => void;
  onSyncFecapa: () => void; onActivatePasskey: () => void; onViewMatches: () => void; onShowOverview: () => void; onLogout: () => void;
}) {
  return <div className="modal-backdrop" role="presentation" onClick={onClose}>
    <aside className="drawer" role="dialog" aria-modal="true" aria-label="Menú" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-head"><strong>Menú</strong><button type="button" className="close-btn" aria-label="Tanca" onClick={onClose}>×</button></div>
      <label>Equip actiu<select value={teamId} onChange={(event) => onSelectTeam(event.target.value)}>{teams.length > 1 && <option value={ALL_TEAMS}>Tots els equips</option>}{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · {team.season}</option>)}</select></label>
      <hr />
      <button type="button" className="menu-item" onClick={onAddEvent}>Afegir esdeveniment</button>
      <button type="button" className="menu-item" onClick={onRecordActivity}>Registrar activitat</button>
      <button type="button" className="menu-item" onClick={onPlanning}>Planificació</button>
      <button type="button" className="menu-item" onClick={onManagePlayers}>Jugadors</button>
      {canUsePasskeys && <button type="button" className="menu-item" disabled={activatingPasskey} onClick={onActivatePasskey}>{activatingPasskey ? "Activant…" : "Activa Face ID / empremta"}</button>}
      {user.global_access && <>
        <hr />
        <button type="button" className="menu-item" onClick={onManageTemplates}>Accions per tipus</button>
        <button type="button" className="menu-item" disabled={syncingFecapa} onClick={onSyncFecapa}>{syncingFecapa ? "Sincronitzant…" : "Sincronitzar FECAPA"}</button>
        <button type="button" className="menu-item" onClick={onViewMatches}>Partits</button>
        <button type="button" className="menu-item" onClick={onShowOverview}>Visió global</button>
      </>}
      <hr />
      <button type="button" className="menu-item danger" onClick={onLogout}>Sortir</button>
    </aside>
  </div>;
}

function eventTypeLabel(type: "training" | "match" | "meeting") { return type === "training" ? "Entrenament" : type === "match" ? "Partit" : "Reunió"; }
function readinessDotClass(readiness: EventReadiness) { return readiness === "done" ? "done" : readiness === "in_progress" ? "wip" : "none"; }
function readinessLabel(readiness: EventReadiness) { return readiness === "done" ? "Tot llest" : readiness === "in_progress" ? "En curs" : "No començat"; }
function prepareActionLabel(readiness: EventReadiness) { return readiness === "done" ? "Revisa la preparació" : readiness === "in_progress" ? "Continua la preparació" : "Prepara amb IA"; }

// Monday-Sunday week bounds for the calendar's pagination, offset in whole weeks from the current one.
function weekBounds(offset: number) {
  const now = new Date();
  const isoDay = (now.getDay() + 6) % 7; // 0 = Monday ... 6 = Sunday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - isoDay + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  const sunday = new Date(nextMonday);
  sunday.setDate(sunday.getDate() - 1);
  const label = `${monday.toLocaleDateString("ca", { day: "numeric", month: "short" })} – ${sunday.toLocaleDateString("ca", { day: "numeric", month: "short" })}`;
  return { from: monday.toISOString(), to: nextMonday.toISOString(), label };
}

function formatEventTime(event: TeamEvent) {
  const start = new Date(event.starts_at);
  const datePart = start.toLocaleDateString("ca", { weekday: "short", day: "numeric", month: "short" });
  const startTime = start.toLocaleTimeString("ca", { hour: "2-digit", minute: "2-digit" });
  if (!event.ends_at) return `${datePart} · ${startTime}`;
  const endTime = new Date(event.ends_at).toLocaleTimeString("ca", { hour: "2-digit", minute: "2-digit" });
  return `${datePart} · ${startTime}–${endTime}`;
}

function formatEventDateRange(event: TeamEvent) {
  const startLabel = new Date(event.starts_at).toLocaleString("ca", { dateStyle: "full", timeStyle: "short" });
  if (!event.ends_at) return startLabel;
  const endTime = new Date(event.ends_at).toLocaleTimeString("ca", { hour: "2-digit", minute: "2-digit" });
  return `${startLabel}–${endTime}`;
}

function EventDetail({ token, teamId, detail, canReassignOwner, onClose, onChanged }: { token: string; teamId: string; detail: { event: TeamEvent; actions: EventAction[] }; canReassignOwner: boolean; onClose: () => void; onChanged: (detail: { event: TeamEvent; actions: EventAction[] }) => void }) {
  const { event, actions } = detail;
  const [error, setError] = useState("");
  const [editingSeries, setEditingSeries] = useState(false);
  async function toggleAction(actionId: string, completed: boolean) {
    try { const updated = await api.updateEventAction(token, teamId, event.id, actionId, { completed }); onChanged({ event, actions: actions.map((action) => action.id === actionId ? updated : action) }); }
    catch { setError("No s'ha pogut actualitzar l'acció."); }
  }
  async function toggleCanceled() {
    try { onChanged({ event: await api.updateEvent(token, teamId, event.id, { canceled: !event.canceled }), actions }); }
    catch { setError("No s'ha pogut actualitzar l'esdeveniment."); }
  }
  async function reassignOwner(ownerId: string | null) {
    try { onChanged({ event: await api.updateEvent(token, teamId, event.id, { ownerId }), actions }); }
    catch { setError("No s'ha pogut canviar l'assignació."); }
  }
  const showTitle = event.title.trim().toLowerCase() !== eventTypeLabel(event.event_type).toLowerCase();
  // JME-47: full-screen workspace (was a modal) — "Enrere" replaces the old
  // bottom "Tancar" button as the way back to the events list.
  return <main className="workspace-screen">
    <header className="ws-header"><button type="button" className="back-btn" aria-label="Enrere" onClick={onClose}>‹</button><div className="ws-title"><strong>{eventTypeLabel(event.event_type)}{showTitle && ` · ${event.title}`}</strong><span>{formatEventDateRange(event)}{event.location && <> · {event.location}</>}</span></div></header>
    <div className="ws-body">
      <OwnerRow token={token} teamId={teamId} event={event} canReassign={canReassignOwner} onReassign={reassignOwner} />
      {event.notes && <div className="notes-card">{event.notes}</div>}
      {actions.length > 0 && <div className="checklist-card"><h3>Accions</h3><ul className="checklist">{actions.map((action) => <li key={action.id}><label><input type="checkbox" checked={Boolean(action.completed_at)} onChange={(evt) => void toggleAction(action.id, evt.target.checked)} />{action.label}</label></li>)}</ul></div>}
      {event.event_type === "match" && !event.canceled && <RosterEditor token={token} teamId={teamId} event={event} />}
      {error && <p className="error">{error}</p>}
    </div>
    <div className="bottom-nav">{event.training_series_id && <button type="button" className="quiet" onClick={() => setEditingSeries(true)}>Editar sèrie</button>}<button type="button" className="quiet" onClick={() => void toggleCanceled()}>{event.canceled ? "Reactivar" : "Cancel·lar esdeveniment"}</button></div>
    {editingSeries && event.training_series_id && <SeriesEditor token={token} teamId={teamId} seriesId={event.training_series_id} fromEventId={event.id} onClose={() => setEditingSeries(false)} onSaved={() => { setEditingSeries(false); onClose(); }} />}
  </main>;
}

// JME-54: "assignat a" is a label/filter, not an access boundary — every
// coach still edits the event the same way they always could. Only the
// coordinator (canReassign) gets the picker; everyone else sees plain text.
function OwnerRow({ token, teamId, event, canReassign, onReassign }: { token: string; teamId: string; event: TeamEvent; canReassign: boolean; onReassign: (ownerId: string | null) => void }) {
  const [coaches, setCoaches] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    if (!canReassign) return;
    void api.teamCoaches(token, teamId).then((result) => setCoaches(result.coaches)).catch(() => setCoaches([]));
  }, [token, teamId, canReassign]);

  if (!canReassign) return <p className="owner-row">Assignat a: <strong>{event.owner_name ?? "Sense assignar"}</strong></p>;
  return <label className="owner-row">Assignat a
    <select value={event.owner_id ?? ""} onChange={(evt) => onReassign(evt.target.value || null)} disabled={!coaches}>
      <option value="">Sense assignar</option>
      {coaches?.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}
    </select>
  </label>;
}

function describeConflict(playerName: string, conflict: ConflictDetail, blocked: boolean): string {
  const time = new Date(conflict.conflictingMatch.startsAt).toLocaleString("ca", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const where = conflict.conflictingMatch.isHome === false ? ", fora" : conflict.conflictingMatch.isHome === true ? ", a casa" : "";
  const base = `${playerName} ja és convocat amb ${conflict.conflictingMatch.teamName} (${conflict.conflictingMatch.title}${where}) a les ${time} — calen ${conflict.requiredGapMinutes} min entre partits i només hi ha ${conflict.actualGapMinutes}.`;
  return blocked ? `${base} No es pot afegir.` : base;
}

// JME-52: defaults from the team's previous match roster the first time
// it's opened (server-side, JME-51's copyFromPreviousMatch) — always-live
// editing after that, no draft/publish state. Same-slot conflicts are a
// hard block; the 3h away-gap warning asks for explicit confirmation.
function TrashButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="trash-btn" aria-label="Treure de la convocatòria" onClick={onClick}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  </button>;
}

function RosterEditor({ token, teamId, event }: { token: string; teamId: string; event: TeamEvent }) {
  const [entries, setEntries] = useState<RosterEntry[] | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Player[]>([]);
  const [pendingConflict, setPendingConflict] = useState<{ player: Player; conflict: ConflictDetail } | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.roster(token, teamId, event.id).then(async (result) => {
      if (cancelled) return;
      if (result.entries.length > 0) { setEntries(result.entries); return; }
      const copied = await api.copyRosterFromPrevious(token, teamId, event.id);
      if (cancelled) return;
      setEntries(copied.entries);
      const parts = [];
      if (copied.added.length) parts.push(`${copied.added.length} jugadors copiats de l'última convocatòria`);
      if (copied.skipped.length) parts.push(`${copied.skipped.length} no s'han pogut copiar per conflicte d'horari — revisa'ls manualment`);
      if (parts.length) setNotice(parts.join(" · "));
    }).catch(() => { if (!cancelled) setError("No s'ha pogut carregar la convocatòria."); });
    return () => { cancelled = true; };
  }, [token, teamId, event.id]);

  useEffect(() => {
    if (searchQuery.trim().length < 2) { setSearchResults([]); return; }
    const handle = setTimeout(() => { void api.players(token, { query: searchQuery.trim() }).then((result) => setSearchResults(result.players)); }, 250);
    return () => clearTimeout(handle);
  }, [token, searchQuery]);

  async function addPlayer(player: Player, acceptOverride = false) {
    setAdding(true); setError("");
    try {
      const outcome = await api.addToRoster(token, teamId, event.id, player.id, acceptOverride);
      if (outcome.status === "added") { setEntries((current) => [...(current ?? []), outcome.entry]); setSearchQuery(""); setSearchResults([]); setPendingConflict(null); }
      else if (outcome.status === "already_in_roster") setError("Aquest jugador ja és a la convocatòria.");
      else if (outcome.status === "blocked") setError(describeConflict(player.name, outcome.conflict, true));
      else setPendingConflict({ player, conflict: outcome.conflict });
    } catch { setError("No s'ha pogut afegir el jugador."); }
    finally { setAdding(false); }
  }

  async function removePlayer(playerId: string) {
    try { await api.removeFromRoster(token, teamId, event.id, playerId); setEntries((current) => (current ?? []).filter((entry) => entry.player_id !== playerId)); }
    catch { setError("No s'ha pogut treure el jugador."); }
  }

  if (!entries) return <div className="checklist-card"><h3>Convocatòria</h3><p>Carregant…</p></div>;
  const home = entries.filter((entry) => !entry.is_guest);
  const guests = entries.filter((entry) => entry.is_guest);

  return <div className="checklist-card">
    <h3>Convocatòria</h3>
    {notice && <p className="notice">{notice}</p>}
    {entries.length === 0 && <p className="empty">Encara no hi ha jugadors convocats.</p>}
    <ul className="checklist">
      {home.map((entry) => <li key={entry.id} className="roster-row"><span className="roster-name">{entry.player_name}</span><TrashButton onClick={() => void removePlayer(entry.player_id)} /></li>)}
      {guests.map((entry) => <li key={entry.id} className="roster-row"><span className="roster-name">{entry.player_name} <em>({entry.player_team_name})</em>{entry.conflict_override && <span className="layer-badge">risc 3h</span>}</span><TrashButton onClick={() => void removePlayer(entry.player_id)} /></li>)}
    </ul>
    <label>Afegir jugador (de qualsevol equip)<input value={searchQuery} onChange={(evt) => setSearchQuery(evt.target.value)} placeholder="Cerca pel nom…" /></label>
    {searchResults.length > 0 && <ul className="template-list">{searchResults.filter((player) => !entries.some((entry) => entry.player_id === player.id)).map((player) => <li key={player.id}><span>{player.name}</span><span>{player.team_name}</span><button type="button" className="text-action" disabled={adding} onClick={() => void addPlayer(player)}>Afegir</button></li>)}</ul>}
    {pendingConflict && <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true">
      <h2>Possible conflicte d'horari</h2>
      <p>{describeConflict(pendingConflict.player.name, pendingConflict.conflict, false)}</p>
      <div className="dialog-actions"><button type="button" className="quiet" onClick={() => setPendingConflict(null)}>Cancel·lar</button><button disabled={adding} onClick={() => void addPlayer(pendingConflict.player, true)}>Afegir igualment</button></div>
    </section></div>}
    {error && <p className="error">{error}</p>}
  </div>;
}

function SeriesEditor({ token, teamId, seriesId, fromEventId, onClose, onSaved }: { token: string; teamId: string; seriesId: string; fromEventId: string; onClose: () => void; onSaved: () => void }) {
  const [series, setSeries] = useState<TrainingSeries | null>(null);
  const [scope, setScope] = useState<"following" | "all">("following");
  const [title, setTitle] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [time, setTime] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const weekdayLabels = ["Dg", "Dl", "Dt", "Dc", "Dj", "Dv", "Ds"];

  useEffect(() => {
    void api.trainingSeries(token, teamId, seriesId).then((loaded) => {
      setSeries(loaded); setTitle(loaded.title); setWeekdays(loaded.weekdays); setTime(loaded.time);
      setDurationMinutes(loaded.duration_minutes ? String(loaded.duration_minutes) : "");
    }).catch(() => setError("No s'ha pogut carregar la sèrie."));
  }, [token, teamId, seriesId]);

  function toggleWeekday(day: number) { setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort()); }

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault(); setSaving(true); setError("");
    try {
      await api.updateTrainingSeries(token, teamId, seriesId, {
        scope, fromEventId: scope === "following" ? fromEventId : undefined,
        title, weekdays, time, durationMinutes: durationMinutes ? Number(durationMinutes) : null,
      });
      onSaved();
    } catch { setError("No s'ha pogut actualitzar la sèrie."); setSaving(false); }
  }

  if (!series) return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true">{error ? <p className="error">{error}</p> : <p>Carregant…</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Tancar</button></div></section></div>;

  return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true"><h2>Editar sèrie d'entrenaments</h2>
    <div className="dialog-actions mode-switch"><button type="button" className={scope === "following" ? "" : "quiet"} onClick={() => setScope("following")}>Aquest i els següents</button><button type="button" className={scope === "all" ? "" : "quiet"} onClick={() => setScope("all")}>Tots</button></div>
    <form onSubmit={submit}>
      <label>Títol<input required value={title} onChange={(evt) => setTitle(evt.target.value)} /></label>
      <fieldset><legend>Dies de la setmana</legend>{weekdayLabels.map((label, day) => <label key={day} className="weekday-toggle"><input type="checkbox" checked={weekdays.includes(day)} onChange={() => toggleWeekday(day)} />{label}</label>)}</fieldset>
      <label>Hora<input required type="time" value={time} onChange={(evt) => setTime(evt.target.value)} /></label>
      <label>Durada en minuts (opcional)<input type="number" min="1" max="600" value={durationMinutes} onChange={(evt) => setDurationMinutes(evt.target.value)} placeholder="60" /></label>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel·lar</button><button disabled={saving || !weekdays.length}>{saving ? "Desant…" : "Desar"}</button></div>
    </form>
  </section></div>;
}

function EventEditor({ token, teamId, onClose, onSaved }: { token: string; teamId: string; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"single" | "recurring">("single");
  const [eventType, setEventType] = useState<"training" | "match" | "meeting">("training");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [isHome, setIsHome] = useState<boolean | null>(null);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [recurTime, setRecurTime] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const weekdayLabels = ["Dg", "Dl", "Dt", "Dc", "Dj", "Dv", "Ds"];
  function toggleWeekday(day: number) { setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort()); }
  async function submitSingle(formEvent: FormEvent) {
    formEvent.preventDefault(); setSaving(true); setError("");
    try {
      await api.createEvent(token, teamId, {
        eventType, title, startsAt: new Date(`${date}T${time}`).toISOString(),
        endsAt: endTime ? new Date(`${date}T${endTime}`).toISOString() : undefined,
        location: location || undefined, notes: notes || undefined,
        isHome: eventType === "match" && isHome !== null ? isHome : undefined,
      });
      onSaved();
    } catch { setError("No s'ha pogut desar l'esdeveniment."); setSaving(false); }
  }
  async function submitRecurring(formEvent: FormEvent) {
    formEvent.preventDefault(); setSaving(true); setError("");
    try {
      await api.generateTrainings(token, teamId, {
        title: title || undefined, weekdays, time: recurTime,
        durationMinutes: durationMinutes ? Number(durationMinutes) : undefined,
        from, to,
      });
      onSaved();
    } catch { setError("No s'han pogut generar els entrenaments."); setSaving(false); }
  }
  return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true"><h2>Nou esdeveniment</h2><div className="dialog-actions mode-switch"><button type="button" className={mode === "single" ? "" : "quiet"} onClick={() => setMode("single")}>Puntual</button><button type="button" className={mode === "recurring" ? "" : "quiet"} onClick={() => setMode("recurring")}>Entrenaments recurrents</button></div>
    {mode === "single"
      ? <form onSubmit={submitSingle}><label>Tipus<select value={eventType} onChange={(evt) => setEventType(evt.target.value as typeof eventType)}><option value="training">Entrenament</option><option value="match">Partit</option><option value="meeting">Reunió</option></select></label>{eventType === "match" && <div className="dialog-actions mode-switch"><button type="button" className={isHome === true ? "" : "quiet"} onClick={() => setIsHome(true)}>Casa</button><button type="button" className={isHome === false ? "" : "quiet"} onClick={() => setIsHome(false)}>Fora</button></div>}<label>Títol<input required value={title} onChange={(evt) => setTitle(evt.target.value)} placeholder="Ex: Partit vs. CE Vic" /></label><label>Data<input required type="date" value={date} onChange={(evt) => setDate(evt.target.value)} /></label><label>Hora d'inici<input required type="time" value={time} onChange={(evt) => setTime(evt.target.value)} /></label><label>Hora de fi (opcional)<input type="time" value={endTime} onChange={(evt) => setEndTime(evt.target.value)} /></label><label>Lloc<input value={location} onChange={(evt) => setLocation(evt.target.value)} placeholder="Opcional" /></label><label>Notes<textarea value={notes} onChange={(evt) => setNotes(evt.target.value)} /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel·lar</button><button disabled={saving}>{saving ? "Desant…" : "Desar"}</button></div></form>
      : <form onSubmit={submitRecurring}><label>Títol (opcional)<input value={title} onChange={(evt) => setTitle(evt.target.value)} placeholder="Entrenament" /></label><fieldset><legend>Dies de la setmana</legend>{weekdayLabels.map((label, day) => <label key={day} className="weekday-toggle"><input type="checkbox" checked={weekdays.includes(day)} onChange={() => toggleWeekday(day)} />{label}</label>)}</fieldset><label>Hora<input required type="time" value={recurTime} onChange={(evt) => setRecurTime(evt.target.value)} /></label><label>Durada en minuts (opcional)<input type="number" min="1" max="600" value={durationMinutes} onChange={(evt) => setDurationMinutes(evt.target.value)} placeholder="60" /></label><label>Des de<input required type="date" value={from} onChange={(evt) => setFrom(evt.target.value)} /></label><label>Fins a<input required type="date" value={to} onChange={(evt) => setTo(evt.target.value)} /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel·lar</button><button disabled={saving || !weekdays.length}>{saving ? "Generant…" : "Generar"}</button></div></form>}
  </section></div>;
}

const PHASE_QUICK_OPTIONS = ["Escurça-ho", "Allarga-ho", "Canvia l'enfocament"];
const BLOCK_QUICK_OPTIONS = ["Fes-ho més senzill", "Fes-ho més difícil", "Escurça-ho", "Allarga-ho", "Afegeix una variant"];

// JME-44: drafts, then walks the coach through approving one activation
// phase / block at a time (never a free-form chat) before generating the
// one-page PDF and emailing it. See docs/ficha-entreno-schema.md for the
// content shape and apps/api/src/training-preparation.ts for step order.
function TrainingPreparationModal({ token, teamId, eventId, teamName, onClose }: { token: string; teamId: string; eventId: string; teamName: string; onClose: () => void }) {
  const [prep, setPrep] = useState<TrainingPreparation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string[] | null>(null);
  const [header, setHeader] = useState({ sessionNumber: "", coach: "", notes: "" });
  const [manualText, setManualText] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const found = await api.getPreparation(token, teamId, eventId);
        if (active) setPrep(found);
      } catch {
        try {
          const created = await api.startPreparation(token, teamId, eventId);
          if (active) setPrep(created);
        } catch {
          if (active) setError("No s'ha pogut generar la proposta inicial. Comprova que la IA estigui configurada.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token, teamId, eventId]);

  useEffect(() => { void api.exercises(token).then((result) => setExercises(result.exercises)).catch(() => {}); }, [token]);
  useEffect(() => { return () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }; }, [pdfUrl]);

  const content = prep?.draft_content ?? null;
  const steps = content ? derivePreparationSteps(content) : [];
  const step = content && prep ? steps[prep.current_step] : null;
  const isReview = step?.kind === "review";
  const currentText = content && step
    ? step.kind === "activation" ? content.activation[step.phase] : step.kind === "block" ? content.blocks[step.index].description : ""
    : "";

  useEffect(() => {
    if (content) setHeader({ sessionNumber: content.sessionNumber?.toString() ?? "", coach: content.coach ?? "", notes: content.notes ?? "" });
  }, [content?.sessionNumber, content?.coach, content?.notes]);
  useEffect(() => { setManualText(currentText); }, [currentText]);

  async function saveHeader() {
    if (!prep) return;
    setError("");
    try {
      setPrep(await api.updatePreparationHeader(token, teamId, eventId, {
        sessionNumber: header.sessionNumber ? Number(header.sessionNumber) : null,
        coach: header.coach || null,
        notes: header.notes || null,
      }));
    } catch { setError("No s'ha pogut desar la capçalera."); }
  }

  async function apply(action: RefineAction) {
    if (!prep) return;
    setBusy(true); setError(""); setFeedback("");
    try { setPrep(await api.refinePreparationStep(token, teamId, eventId, prep.current_step, action)); }
    catch { setError("No s'ha pogut aplicar el canvi."); }
    finally { setBusy(false); }
  }

  async function skip() {
    if (!prep) return;
    setBusy(true); setError("");
    try {
      const edited = await api.refinePreparationStep(token, teamId, eventId, prep.current_step, { action: "edit", value: "" });
      setPrep(await api.refinePreparationStep(token, teamId, eventId, edited.current_step, { action: "approve" }));
    } catch { setError("No s'ha pogut saltar la fase."); }
    finally { setBusy(false); }
  }

  async function finalize() {
    if (!prep) return;
    setBusy(true); setError("");
    try { setPrep(await api.finalizePreparation(token, teamId, eventId)); }
    catch { setError("Falten passos per aprovar abans de finalitzar."); }
    finally { setBusy(false); }
  }

  async function previewPdf() {
    setBusy(true); setError("");
    try { setPdfUrl(URL.createObjectURL(await api.previewPreparationPdf(token, teamId, eventId))); }
    catch { setError("No s'ha pogut generar el PDF."); }
    finally { setBusy(false); }
  }

  async function sendEmail() {
    setBusy(true); setError("");
    try { setSentTo((await api.sendPreparation(token, teamId, eventId)).recipients); }
    catch { setError("No s'ha pogut enviar el correu."); }
    finally { setBusy(false); }
  }

  const totalVisibleSteps = Math.max(steps.length - 1, 1);
  // JME-47: full-screen workspace (was a modal), matching EventDetail's new
  // shell — "Enrere" in the header replaces the old bottom "Tancar" button.
  return <main className="workspace-screen">
    <header className="ws-header"><button type="button" className="back-btn" aria-label="Enrere" onClick={onClose}>‹</button><div className="ws-title"><strong>Entrenament</strong><span>{teamName}</span></div></header>
    <div className="ws-body">
    {loading && <p>Generant la primera proposta…</p>}
    {error && <p className="error">{error}</p>}
    {prep && content && <>
      <div className="prep-header">
        <label>Sessió núm.<input type="number" min="1" value={header.sessionNumber} disabled={prep.status !== "drafting"} onChange={(evt) => setHeader((current) => ({ ...current, sessionNumber: evt.target.value }))} onBlur={() => void saveHeader()} /></label>
        <label>Entrenador<input value={header.coach} disabled={prep.status !== "drafting"} onChange={(evt) => setHeader((current) => ({ ...current, coach: evt.target.value }))} onBlur={() => void saveHeader()} /></label>
      </div>
      <label>Notes<textarea value={header.notes} disabled={prep.status !== "drafting"} onChange={(evt) => setHeader((current) => ({ ...current, notes: evt.target.value }))} onBlur={() => void saveHeader()} /></label>

      {prep.status === "drafting" && step && !isReview && <div className="prep-step">
        <p className="prep-progress">Pas {prep.current_step + 1} de {totalVisibleSteps}</p>
        <div className="progress-track"><div className="progress-fill" style={{ width: `${((prep.current_step + 1) / totalVisibleSteps) * 100}%` }} /></div>
        <h3>{step.kind === "activation" ? ACTIVATION_LABELS[step.phase] : `Bloc ${step.index + 1}`}</h3>
        <textarea value={manualText} onChange={(evt) => setManualText(evt.target.value)} disabled={busy} />
        {step.kind === "block" && <label>Exercici del banc<select value={content.blocks[step.index].exerciseId ?? ""} disabled={busy} onChange={(evt) => void apply({ action: "swap_exercise", exerciseId: evt.target.value || null })}><option value="">— Cap —</option>{exercises.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label>}
        <div className="prep-options">
          {(step.kind === "activation" ? PHASE_QUICK_OPTIONS : BLOCK_QUICK_OPTIONS).map((option) => <button key={option} type="button" className="text-action prep-chip" disabled={busy} onClick={() => void apply({ action: "feedback", instruction: option })}>{option}</button>)}
          {step.kind === "activation" && <button type="button" className="text-action prep-chip" disabled={busy} onClick={() => void skip()}>Salta aquesta fase</button>}
        </div>
        <div className="prep-feedback"><input value={feedback} onChange={(evt) => setFeedback(evt.target.value)} placeholder="Escriu el teu propi feedback…" disabled={busy} /><button type="button" className="quiet" disabled={busy || !feedback.trim()} onClick={() => void apply({ action: "feedback", instruction: feedback })}>Envia</button></div>
        <div className="dialog-actions">
          <button type="button" className="quiet" disabled={busy || manualText === currentText} onClick={() => void apply({ action: "edit", value: manualText })}>Desa el text</button>
          {prep.current_step > 0 && <button type="button" className="quiet" disabled={busy} onClick={() => void apply({ action: "back" })}>Anterior</button>}
          <button type="button" disabled={busy} onClick={() => void apply({ action: "approve" })}>És correcte, següent</button>
        </div>
      </div>}

      {prep.status === "drafting" && isReview && <div className="prep-step">
        <h3>Revisió final</h3>
        <ul className="prep-summary">{ACTIVATION_PHASES.filter((phase) => content.activation[phase]).map((phase) => <li key={phase}><strong>{ACTIVATION_LABELS[phase]}:</strong> {content.activation[phase]}</li>)}</ul>
        <ol className="prep-summary">{content.blocks.map((block, index) => <li key={index}>{block.description}{block.exerciseId && ` (${exercises.find((exercise) => exercise.id === block.exerciseId)?.name ?? ""})`}</li>)}</ol>
        <div className="dialog-actions"><button type="button" className="quiet" disabled={busy} onClick={() => void apply({ action: "back" })}>Anterior</button><button type="button" disabled={busy} onClick={() => void finalize()}>Finalitza</button></div>
      </div>}

      {prep.status !== "drafting" && <div className="prep-step">
        <h3>{prep.status === "sent" ? "Enviada" : "Llesta per enviar"}</h3>
        {!pdfUrl && <button type="button" className="quiet" disabled={busy} onClick={() => void previewPdf()}>Genera i previsualitza PDF</button>}
        {pdfUrl && <iframe title="Previsualització PDF" src={pdfUrl} className="prep-pdf-preview" />}
        {sentTo && <p className="notice">Enviat a: {sentTo.join(", ")}</p>}
        {prep.status === "ready" && !sentTo && <button type="button" disabled={busy} onClick={() => void sendEmail()}>Envia per correu</button>}
      </div>}
    </>}
    </div>
  </main>;
}

function ActionTemplatesEditor({ token, teams, onClose }: { token: string; teams: Team[]; onClose: () => void }) {
  const [templates, setTemplates] = useState<EventTypeActionTemplate[]>([]);
  const [eventType, setEventType] = useState<"training" | "match" | "meeting">("training");
  const [scope, setScope] = useState<"club" | "team">("club");
  const [scopeTeamId, setScopeTeamId] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.eventTypeActions(token).then((result) => setTemplates(result.actions)); }, [token]);
  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault(); setSaving(true); setError("");
    try { const created = await api.createEventTypeAction(token, { scope, teamId: scope === "team" ? scopeTeamId : undefined, eventType, label }); setTemplates((current) => [...current, created]); setLabel(""); setSaving(false); }
    catch { setError("No s'ha pogut desar l'acció."); setSaving(false); }
  }
  async function toggleActive(template: EventTypeActionTemplate) {
    const updated = await api.updateEventTypeAction(token, template.id, { active: !template.active });
    setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item));
  }
  return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true"><h2>Accions per tipus d'esdeveniment</h2><ul className="template-list">{templates.map((template) => <li key={template.id} className={template.active ? "" : "inactive"}><span className="event-type">{eventTypeLabel(template.event_type)}</span><span>{template.scope === "club" ? "Club" : template.scope === "team" ? template.team : template.category}</span><strong>{template.label}</strong><button type="button" className="text-action" onClick={() => void toggleActive(template)}>{template.active ? "Desactivar" : "Activar"}</button></li>)}</ul><form onSubmit={submit}><label>Tipus d'esdeveniment<select value={eventType} onChange={(evt) => setEventType(evt.target.value as typeof eventType)}><option value="training">Entrenament</option><option value="match">Partit</option><option value="meeting">Reunió</option></select></label><label>Àmbit<select value={scope} onChange={(evt) => setScope(evt.target.value as typeof scope)}><option value="club">Tot el club</option><option value="team">Un equip</option></select></label>{scope === "team" && <label>Equip<select required value={scopeTeamId} onChange={(evt) => setScopeTeamId(evt.target.value)}><option value="">Selecciona…</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · {team.season}</option>)}</select></label>}<label>Acció<input required value={label} onChange={(evt) => setLabel(evt.target.value)} placeholder="Ex: Confirmar convocatòria" /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Tancar</button><button disabled={saving || (scope === "team" && !scopeTeamId)}>{saving ? "Desant…" : "Afegir"}</button></div></form></section></div>;
}

// JME-49: players are club data, not login accounts — the team dropdown
// reuses `teams` (from GET /v1/teams), which already scopes to every team
// for a coordinator or just the coach's own for everyone else.
function PlayersEditor({ token, teams, teamId, onClose }: { token: string; teams: Team[]; teamId: string; onClose: () => void }) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [scopeTeamId, setScopeTeamId] = useState(teamId);
  const [name, setName] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [isGoalkeeper, setIsGoalkeeper] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void api.players(token, { teamId: scopeTeamId }).then((result) => setPlayers(result.players)).catch(() => setError("No s'han pogut carregar els jugadors.")); }, [token, scopeTeamId]);

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault(); setSaving(true); setError("");
    try {
      const created = await api.createPlayer(token, { name, teamId: scopeTeamId, birthYear: birthYear ? Number(birthYear) : undefined, isGoalkeeper });
      setPlayers((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setName(""); setBirthYear(""); setIsGoalkeeper(false);
    } catch { setError("No s'ha pogut desar el jugador."); }
    finally { setSaving(false); }
  }

  async function toggleActive(player: Player) {
    const updated = await api.updatePlayer(token, player.id, { active: !player.active });
    setPlayers((current) => current.map((item) => item.id === updated.id ? updated : item));
  }

  return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true">
    <h2>Jugadors</h2>
    <label>Equip<select value={scopeTeamId} onChange={(evt) => setScopeTeamId(evt.target.value)}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · {team.season}</option>)}</select></label>
    {players.length === 0 && <p className="empty">Aquest equip encara no té jugadors.</p>}
    <ul className="template-list">{players.map((player) => <li key={player.id} className={player.active ? "" : "inactive"}><strong>{player.name}</strong><span>{player.birth_year ?? "—"}</span><span>{player.is_goalkeeper ? "Porter" : ""}</span><button type="button" className="text-action" onClick={() => void toggleActive(player)}>{player.active ? "Donar de baixa" : "Reactivar"}</button></li>)}</ul>
    <form onSubmit={submit}>
      <label>Nom<input required value={name} onChange={(evt) => setName(evt.target.value)} /></label>
      <label>Any de naixement (opcional)<input type="number" min="1950" max="2050" value={birthYear} onChange={(evt) => setBirthYear(evt.target.value)} /></label>
      <label className="weekday-toggle"><input type="checkbox" checked={isGoalkeeper} onChange={(evt) => setIsGoalkeeper(evt.target.checked)} />Porter</label>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Tancar</button><button disabled={saving || !name.trim()}>{saving ? "Desant…" : "Afegir jugador"}</button></div>
    </form>
  </section></div>;
}

function PlanningEditor({ token, teamId, teamName, onClose }: { token: string; teamId: string; teamName: string; onClose: () => void }) {
  const [plan, setPlan] = useState<TeamPlan | null>(null);
  const [seasonObjectives, setSeasonObjectives] = useState("");
  const [trainingObjectives, setTrainingObjectives] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.plan(token, teamId).then(({ plan: loaded }) => { setPlan(loaded); setSeasonObjectives(loaded?.content.seasonObjectives.join("\n") ?? ""); setTrainingObjectives(loaded?.content.nextTrainingObjectives.join("\n") ?? ""); setNotes(loaded?.content.notes ?? ""); }).catch(() => setError("No s'ha pogut carregar la planificació.")); }, [token, teamId]);
  const lines = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { const saved = await api.savePlan(token, teamId, { seasonObjectives: lines(seasonObjectives), nextTrainingObjectives: lines(trainingObjectives), notes, version: plan?.version }); setPlan(saved); onClose(); } catch { setError("La planificació ha canviat o no s'ha pogut desar."); setSaving(false); } }
  return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true"><h2>Planificació · {teamName}</h2><form onSubmit={submit}><label>Objectius de temporada<textarea required value={seasonObjectives} onChange={(event) => setSeasonObjectives(event.target.value)} placeholder="Un objectiu per línia" /></label><label>Objectius dels pròxims entrenaments<textarea value={trainingObjectives} onChange={(event) => setTrainingObjectives(event.target.value)} placeholder="Un objectiu per línia" /></label><label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel·lar</button><button disabled={saving || !lines(seasonObjectives).length}>{saving ? "Desant…" : "Desar pla"}</button></div></form></section></div>;
}

function CoordinatorPanel({ overview }: { overview: CoordinatorOverview }) {
  return <section className="overview"><div><span className="eyebrow">Coordinació</span><h2>Activitat de tots els equips</h2></div><div className="team-grid">{overview.teams.map((team) => <article key={team.id}><strong>{team.name}</strong><span>{team.category}</span><p>{team.record_count} registres · {team.staff_count} tècnics</p><small>{team.last_activity_at ? `Darrera activitat: ${new Date(team.last_activity_at).toLocaleDateString("ca")}` : "Encara sense activitat"}</small></article>)}</div>{overview.pendingProposals.length > 0 && <div className="proposal-list"><p className="pending">{overview.pendingProposals.length} canvis pendents de confirmació explícita.</p>{overview.pendingProposals.map((proposal) => <article key={proposal.id} className="proposal-card"><p>{proposal.reason}</p><small>{proposal.proposed_by_name} · {new Date(proposal.proposed_at).toLocaleDateString("ca")}</small>{proposal.source_document_id && <div className="source-document">{proposal.source_document_layer && <span className={`layer-badge layer-${proposal.source_document_layer}`}>{proposal.source_document_layer}</span>}{proposal.source_document_drive_url ? <a href={proposal.source_document_drive_url} target="_blank" rel="noreferrer">{proposal.source_document_title}</a> : <strong>{proposal.source_document_title}</strong>}{proposal.source_document_summary && <p className="source-summary">{proposal.source_document_summary}</p>}</div>}</article>)}</div>}
  </section>;
}

type MatchSort = "date" | "category" | "coach";

// JME-55: dedicated weekly match dashboard for the coordinator, pulling
// together is_home (JME-50), match_rosters (JME-51) and owner_id
// (JME-54) into one row per match across every team. Supersedes the
// simpler upcomingMatchRosters list that used to live in CoordinatorPanel
// (JME-53).
function MatchesOverview({ token, onOpenEvent, onClose }: { token: string; onOpenEvent: (teamId: string, eventId: string) => void; onClose: () => void }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [matches, setMatches] = useState<CoordinatorMatch[] | null>(null);
  const [sortBy, setSortBy] = useState<MatchSort>("date");
  const [error, setError] = useState("");
  const week = useMemo(() => weekBounds(weekOffset), [weekOffset]);

  useEffect(() => {
    setMatches(null);
    void api.coordinatorMatches(token, { from: week.from, to: week.to })
      .then((result) => setMatches(result.matches))
      .catch(() => setError("No s'han pogut carregar els partits."));
  }, [token, week.from, week.to]);

  const sorted = useMemo(() => {
    if (!matches) return [];
    const collator = new Intl.Collator("ca");
    const copy = [...matches];
    if (sortBy === "category") copy.sort((a, b) => collator.compare(a.category_name, b.category_name) || a.starts_at.localeCompare(b.starts_at));
    else if (sortBy === "coach") copy.sort((a, b) => collator.compare(a.owner_name ?? "", b.owner_name ?? "") || a.starts_at.localeCompare(b.starts_at));
    else copy.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return copy;
  }, [matches, sortBy]);

  return <main className="workspace-screen">
    <header className="ws-header"><button type="button" className="back-btn" aria-label="Enrere" onClick={onClose}>‹</button><div className="ws-title"><strong>Partits — tots els equips</strong><span>{week.label}</span></div></header>
    <div className="ws-body">
      <div className="week-nav"><button type="button" className="quiet" onClick={() => setWeekOffset((current) => current - 1)} aria-label="Setmana anterior">‹</button><span>{week.label}</span><button type="button" className="quiet" onClick={() => setWeekOffset((current) => current + 1)} aria-label="Setmana següent">›</button></div>
      <label>Ordenar per<select value={sortBy} onChange={(evt) => setSortBy(evt.target.value as MatchSort)}>
        <option value="date">Data</option>
        <option value="category">Categoria</option>
        <option value="coach">Entrenador</option>
      </select></label>
      {error && <p className="error">{error}</p>}
      {!matches ? <p>Carregant…</p> : sorted.length === 0 ? <p className="empty">Cap partit aquesta setmana.</p> : <ul className="match-overview-list">
        {sorted.map((match) => <li key={match.id}><button type="button" className="match-overview-row" onClick={() => onOpenEvent(match.team_id, match.id)}>
          <span className={`home-away-badge ${match.is_home === false ? "away" : match.is_home === true ? "home" : "unknown"}`}>{match.is_home === false ? "Fora" : match.is_home === true ? "Casa" : "?"}</span>
          <span className="match-overview-main">
            <strong>{match.team_name}</strong><span className="category-tag">{match.category_name}</span>
            <span className="match-overview-title">{match.title}</span>
            <span>{new Date(match.starts_at).toLocaleString("ca", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
          </span>
          <span className="match-overview-coach">{match.owner_name ?? "Sense assignar"}</span>
          <span className="roster-counts"><span className="count-pill home">{match.home_player_count}</span><span className="count-pill guest">{match.guest_player_count}</span></span>
        </button></li>)}
      </ul>}
    </div>
  </main>;
}

type FichaBlockDraft = { description: string; diagramAssetUrl: string; exerciseId: string };
const EMPTY_FICHA_BLOCK: FichaBlockDraft = { description: "", diagramAssetUrl: "", exerciseId: "" };

function RecordCapture({ teamName, coachName, token, onCancel, onSave }: { teamName: string; coachName: string; token: string; onCancel: () => void; onSave: (record: RecordInput) => Promise<void> }) {
  const [type, setType] = useState<"training" | "match">("training");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState("");
  const [objectives, setObjectives] = useState("");
  const [sessionNumber, setSessionNumber] = useState("");
  const [coach, setCoach] = useState(coachName);
  const [notes, setNotes] = useState("");
  const [activation, setActivation] = useState({ prevencion: "", activacionPorteros: "", activacionJugadores: "", integrado: "", participativo: "" });
  const [blocks, setBlocks] = useState<FichaBlockDraft[]>([{ ...EMPTY_FICHA_BLOCK }]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (type === "training") void api.exercises(token).then((result) => setExercises(result.exercises)).catch(() => {}); }, [type, token]);
  function updateBlock(index: number, patch: Partial<FichaBlockDraft>) {
    setBlocks((current) => current.map((block, i) => (i === index ? { ...block, ...patch } : block)));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      if (type === "match") {
        await onSave({ type, happenedAt: new Date().toISOString(), summary, outcome: outcome || undefined, nextObjectives: objectives.split("\n").map((item) => item.trim()).filter(Boolean) });
      } else {
        await onSave({
          type, happenedAt: new Date().toISOString(),
          sessionNumber: sessionNumber ? Number(sessionNumber) : undefined,
          coach: coach || undefined, notes: notes || undefined,
          activation,
          blocks: blocks.filter((block) => block.description.trim()).map((block) => ({
            description: block.description, diagramAssetUrl: block.diagramAssetUrl || undefined, exerciseId: block.exerciseId || undefined,
          })),
        });
      }
    } catch { setError("No s'ha pogut desar l'activitat."); setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation"><section className="record-card" role="dialog" aria-modal="true" aria-labelledby="record-title"><h2 id="record-title">Registrar {teamName}</h2><form onSubmit={submit}>
    <label>Tipus<select value={type} onChange={(event) => setType(event.target.value as "training" | "match")}><option value="training">Entrenament</option><option value="match">Partit</option></select></label>
    {type === "match"
      ? <><label>Resum<textarea required value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Què heu treballat i com ha anat?" /></label><label>Resultat o valoració<input value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="Opcional" /></label><label>Pròxims objectius<textarea value={objectives} onChange={(event) => setObjectives(event.target.value)} placeholder="Un objectiu per línia" /></label></>
      : <>
        <div className="ficha-header"><label>Sessió núm.<input type="number" min="1" value={sessionNumber} onChange={(event) => setSessionNumber(event.target.value)} /></label><label>Entrenador<input value={coach} onChange={(event) => setCoach(event.target.value)} /></label></div>
        <label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <fieldset><legend>Activació</legend>
          <label>Prevenció<input value={activation.prevencion} onChange={(event) => setActivation((current) => ({ ...current, prevencion: event.target.value }))} /></label>
          <label>Activació porters<input value={activation.activacionPorteros} onChange={(event) => setActivation((current) => ({ ...current, activacionPorteros: event.target.value }))} /></label>
          <label>Activació jugadors<input value={activation.activacionJugadores} onChange={(event) => setActivation((current) => ({ ...current, activacionJugadores: event.target.value }))} /></label>
          <label>Integrat<input value={activation.integrado} onChange={(event) => setActivation((current) => ({ ...current, integrado: event.target.value }))} /></label>
          <label>Participatiu<input value={activation.participativo} onChange={(event) => setActivation((current) => ({ ...current, participativo: event.target.value }))} /></label>
        </fieldset>
        <fieldset><legend>Blocs de la sessió (màx. 3)</legend>
          {blocks.map((block, index) => <div key={index} className="ficha-block"><label>Descripció<textarea required={index === 0} value={block.description} onChange={(event) => updateBlock(index, { description: event.target.value })} /></label><label>Exercici del banc (opcional)<select value={block.exerciseId} onChange={(event) => updateBlock(index, { exerciseId: event.target.value })}><option value="">— Cap —</option>{exercises.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label><label>Enllaç al diagrama (opcional)<input type="url" value={block.diagramAssetUrl} onChange={(event) => updateBlock(index, { diagramAssetUrl: event.target.value })} placeholder="https://…" /></label></div>)}
          {blocks.length < 3 && <button type="button" className="text-action" onClick={() => setBlocks((current) => [...current, { ...EMPTY_FICHA_BLOCK }])}>Afegir bloc</button>}
        </fieldset>
      </>}
    {error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onCancel}>Cancel·lar</button><button disabled={saving}>{saving ? "Desant…" : "Desar"}</button></div></form></section></div>;
}

function Login({ onLogin, onPasskeyLogin, loading, error }: { onLogin: (email: string, password: string) => Promise<void>; onPasskeyLogin?: (email: string) => Promise<void>; loading: boolean; error: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return <main className="login"><section className="login-card"><img className="club-logo" src="/hc-sentmenat-logo.png" alt="Escut de l'HC Sentmenat" /><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1><p className="intro">Planifica, registra i acompanya l'evolució del teu equip.</p><form onSubmit={(event) => { event.preventDefault(); void onLogin(email, password); }}><label>Correu autoritzat<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="entrenador@hcsentmenat.cat" /></label><label>Contrasenya<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="error" role="alert">{error}</p>}<button disabled={loading}>{loading ? "Validant…" : "Entrar"}</button>{onPasskeyLogin && <button type="button" className="quiet" disabled={loading || !email} onClick={() => void onPasskeyLogin(email)}>Usa Face ID / empremta</button>}</form><small>Accés privat per a entrenadors i coordinació.</small></section></main>;
}

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js").then((registration) => registration.update());
  });
}
