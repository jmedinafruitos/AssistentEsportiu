import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ACTIVATION_LABELS, ACTIVATION_PHASES, api, CoordinatorOverview, CurrentUser, derivePreparationSteps, EventAction, EventReadiness, EventTypeActionTemplate, Exercise, RecordInput, RefineAction, Team, TeamEvent, TeamPlan, TrainingPreparation, TrainingSeries } from "./api";
import "./styles.css";

const TOKEN_KEY = "assistent-esportiu-token";

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
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
  const [preparingEventId, setPreparingEventId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([api.me(token), api.teams(token)]).then(([identity, result]) => {
      setUser(identity); setTeams(result.teams); setTeamId((current) => current || result.teams[0]?.id || ""); setError("");
    }).catch(() => logout()).finally(() => setLoading(false));
  }, [token]);

  const week = useMemo(() => weekBounds(weekOffset), [weekOffset]);
  useEffect(() => {
    if (!token || !teamId) { setEvents([]); return; }
    void api.events(token, teamId, { from: week.from, to: week.to }).then((result) => setEvents(result.events)).catch(() => {});
  }, [token, teamId, week.from, week.to]);

  async function refreshEvents() {
    if (!teamId) return;
    const result = await api.events(token, teamId, { from: week.from, to: week.to });
    setEvents(result.events);
  }

  async function openEvent(eventId: string) {
    try { setSelectedEvent(await api.eventDetail(token, teamId, eventId)); }
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
  function logout() { localStorage.removeItem(TOKEN_KEY); setToken(""); setUser(null); setTeams([]); }

  async function login(email: string, password: string) {
    setLoading(true); setError("");
    try {
      const session = await api.login(email, password); localStorage.setItem(TOKEN_KEY, session.token); setToken(session.token);
    } catch { setError("Correu o contrasenya incorrectes."); setLoading(false); }
  }

  if (!token || (!user && !loading)) return <Login onLogin={login} loading={loading} error={error} />;
  if (!user) return <main className="centered" aria-live="polite">Carregant el teu context…</main>;
  // JME-47: an open event workspace takes over the whole screen instead of
  // overlaying the home screen — "Enrere" inside each component returns
  // here by clearing this state.
  if (selectedEvent) return <EventDetail token={token} teamId={teamId} detail={selectedEvent} onClose={() => setSelectedEvent(null)} onChanged={(detail) => { setSelectedEvent(detail); void refreshEvents(); }} />;
  if (preparingEventId) return <TrainingPreparationModal token={token} teamId={teamId} eventId={preparingEventId} teamName={activeTeam?.name ?? "l'equip"} onClose={() => setPreparingEventId(null)} />;

  return <main className="assistant-shell">
    <header className="app-header">
      <div className="brand"><img className="club-logo compact" src="/hc-sentmenat-logo.png" alt="Escut de l'HC Sentmenat" /><div><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1></div></div>
      <button type="button" className="menu-btn" aria-label="Menú" onClick={() => setMenuOpen(true)}><svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="#173b6d" strokeWidth="2" strokeLinecap="round"><path d="M1 1h16M1 7h16M1 13h16" /></svg></button>
    </header>
    {activeTeam && <p className="team-pill-row"><span className="team-pill">{activeTeam.name} · {activeTeam.season}</span></p>}
    <section className="events">
      <div className="events-header"><h2>Esdeveniments</h2></div>
      <div className="week-nav"><button type="button" className="quiet" onClick={() => setWeekOffset((current) => current - 1)} aria-label="Setmana anterior">‹</button><span>{week.label}</span><button type="button" className="quiet" onClick={() => setWeekOffset((current) => current + 1)} aria-label="Setmana següent">›</button></div>
      {events.length
        ? <ul className="event-list">{events.map((event) => {
            const showTitle = event.title.trim().toLowerCase() !== eventTypeLabel(event.event_type).toLowerCase();
            return <li key={event.id} className="event-card"><button type="button" className={`event-item ${event.canceled ? "canceled" : ""}`} onClick={() => void openEvent(event.id)}><span className={`status-dot ${readinessDotClass(event.readiness)}`} aria-label={readinessLabel(event.readiness)} title={readinessLabel(event.readiness)} /><span className={`event-type ${event.event_type}`}>{eventTypeLabel(event.event_type)}</span>{showTitle && <strong>{event.title}</strong>}<span>{formatEventTime(event)}</span>{event.canceled && <em>Cancel·lat</em>}</button>{event.event_type === "training" && !event.canceled && <button type="button" className="row-action" onClick={() => setPreparingEventId(event.id)}>{prepareActionLabel(event.readiness)}</button>}</li>;
          })}</ul>
        : <p className="empty">Sense esdeveniments aquesta setmana.</p>}
    </section>
    {overview && <CoordinatorPanel overview={overview} />}
    {menuOpen && <HamburgerMenu
      user={user} teams={teams} teamId={teamId} syncingFecapa={syncingFecapa}
      onClose={() => setMenuOpen(false)}
      onSelectTeam={(id) => { setTeamId(id); setWeekOffset(0); setMenuOpen(false); }}
      onAddEvent={() => { setCreatingEvent(true); setMenuOpen(false); }}
      onRecordActivity={() => { setRecording(true); setMenuOpen(false); }}
      onPlanning={() => { setPlanning(true); setMenuOpen(false); }}
      onManageTemplates={() => { setManagingTemplates(true); setMenuOpen(false); }}
      onSyncFecapa={() => { setMenuOpen(false); void syncFecapa(); }}
      onShowOverview={() => {
        setMenuOpen(false);
        if (overview) setOverview(null);
        else void api.coordinatorOverview(token).then(setOverview).catch(() => setError("No s'ha pogut carregar la visió global."));
      }}
      onLogout={() => { setMenuOpen(false); logout(); }}
    />}
    {recording && <RecordCapture teamName={activeTeam?.name ?? "l'equip"} coachName={user.name} token={token} onCancel={() => setRecording(false)} onSave={async (record) => { await api.createRecord(token, teamId, record); setRecording(false); setNotice("Activitat desada a l'historial de l'equip."); }} />}
    {planning && <PlanningEditor token={token} teamId={teamId} teamName={activeTeam?.name ?? "l'equip"} onClose={() => setPlanning(false)} />}
    {creatingEvent && <EventEditor token={token} teamId={teamId} onClose={() => setCreatingEvent(false)} onSaved={() => { setCreatingEvent(false); void refreshEvents(); }} />}
    {managingTemplates && <ActionTemplatesEditor token={token} teams={teams} onClose={() => setManagingTemplates(false)} />}
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}

// JME-46: secondary/occasional actions live here now instead of scattered
// across the header and a chat-suggestions bar that no longer exists —
// team switch, add event, the two things that used to be chat-suggestion
// buttons (record activity, planning), and the coordinator-only actions.
function HamburgerMenu({ user, teams, teamId, syncingFecapa, onClose, onSelectTeam, onAddEvent, onRecordActivity, onPlanning, onManageTemplates, onSyncFecapa, onShowOverview, onLogout }: {
  user: CurrentUser; teams: Team[]; teamId: string; syncingFecapa: boolean;
  onClose: () => void; onSelectTeam: (teamId: string) => void; onAddEvent: () => void;
  onRecordActivity: () => void; onPlanning: () => void; onManageTemplates: () => void;
  onSyncFecapa: () => void; onShowOverview: () => void; onLogout: () => void;
}) {
  return <div className="modal-backdrop" role="presentation" onClick={onClose}>
    <aside className="drawer" role="dialog" aria-modal="true" aria-label="Menú" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-head"><strong>Menú</strong><button type="button" className="close-btn" aria-label="Tanca" onClick={onClose}>×</button></div>
      <label>Equip actiu<select value={teamId} onChange={(event) => onSelectTeam(event.target.value)}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · {team.season}</option>)}</select></label>
      <hr />
      <button type="button" className="menu-item" onClick={onAddEvent}>Afegir esdeveniment</button>
      <button type="button" className="menu-item" onClick={onRecordActivity}>Registrar activitat</button>
      <button type="button" className="menu-item" onClick={onPlanning}>Planificació</button>
      {user.global_access && <>
        <hr />
        <button type="button" className="menu-item" onClick={onManageTemplates}>Accions per tipus</button>
        <button type="button" className="menu-item" disabled={syncingFecapa} onClick={onSyncFecapa}>{syncingFecapa ? "Sincronitzant…" : "Sincronitzar FECAPA"}</button>
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

function EventDetail({ token, teamId, detail, onClose, onChanged }: { token: string; teamId: string; detail: { event: TeamEvent; actions: EventAction[] }; onClose: () => void; onChanged: (detail: { event: TeamEvent; actions: EventAction[] }) => void }) {
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
  const showTitle = event.title.trim().toLowerCase() !== eventTypeLabel(event.event_type).toLowerCase();
  // JME-47: full-screen workspace (was a modal) — "Enrere" replaces the old
  // bottom "Tancar" button as the way back to the events list.
  return <main className="workspace-screen">
    <header className="ws-header"><button type="button" className="back-btn" aria-label="Enrere" onClick={onClose}>‹</button><div className="ws-title"><strong>{eventTypeLabel(event.event_type)}{showTitle && ` · ${event.title}`}</strong><span>{formatEventDateRange(event)}{event.location && <> · {event.location}</>}</span></div></header>
    <div className="ws-body">
      {event.notes && <div className="notes-card">{event.notes}</div>}
      {actions.length > 0 && <div className="checklist-card"><h3>Accions</h3><ul className="checklist">{actions.map((action) => <li key={action.id}><label><input type="checkbox" checked={Boolean(action.completed_at)} onChange={(evt) => void toggleAction(action.id, evt.target.checked)} />{action.label}</label></li>)}</ul></div>}
      {error && <p className="error">{error}</p>}
    </div>
    <div className="bottom-nav">{event.training_series_id && <button type="button" className="quiet" onClick={() => setEditingSeries(true)}>Editar sèrie</button>}<button type="button" className="quiet" onClick={() => void toggleCanceled()}>{event.canceled ? "Reactivar" : "Cancel·lar esdeveniment"}</button></div>
    {editingSeries && event.training_series_id && <SeriesEditor token={token} teamId={teamId} seriesId={event.training_series_id} fromEventId={event.id} onClose={() => setEditingSeries(false)} onSaved={() => { setEditingSeries(false); onClose(); }} />}
  </main>;
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
      ? <form onSubmit={submitSingle}><label>Tipus<select value={eventType} onChange={(evt) => setEventType(evt.target.value as typeof eventType)}><option value="training">Entrenament</option><option value="match">Partit</option><option value="meeting">Reunió</option></select></label><label>Títol<input required value={title} onChange={(evt) => setTitle(evt.target.value)} placeholder="Ex: Partit vs. CE Vic" /></label><label>Data<input required type="date" value={date} onChange={(evt) => setDate(evt.target.value)} /></label><label>Hora d'inici<input required type="time" value={time} onChange={(evt) => setTime(evt.target.value)} /></label><label>Hora de fi (opcional)<input type="time" value={endTime} onChange={(evt) => setEndTime(evt.target.value)} /></label><label>Lloc<input value={location} onChange={(evt) => setLocation(evt.target.value)} placeholder="Opcional" /></label><label>Notes<textarea value={notes} onChange={(evt) => setNotes(evt.target.value)} /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel·lar</button><button disabled={saving}>{saving ? "Desant…" : "Desar"}</button></div></form>
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
  return <section className="overview"><div><span className="eyebrow">Coordinació</span><h2>Activitat de tots els equips</h2></div><div className="team-grid">{overview.teams.map((team) => <article key={team.id}><strong>{team.name}</strong><span>{team.category}</span><p>{team.record_count} registres · {team.staff_count} tècnics</p><small>{team.last_activity_at ? `Darrera activitat: ${new Date(team.last_activity_at).toLocaleDateString("ca")}` : "Encara sense activitat"}</small></article>)}</div>{overview.pendingProposals.length > 0 && <div className="proposal-list"><p className="pending">{overview.pendingProposals.length} canvis pendents de confirmació explícita.</p>{overview.pendingProposals.map((proposal) => <article key={proposal.id} className="proposal-card"><p>{proposal.reason}</p><small>{proposal.proposed_by_name} · {new Date(proposal.proposed_at).toLocaleDateString("ca")}</small>{proposal.source_document_id && <div className="source-document">{proposal.source_document_layer && <span className={`layer-badge layer-${proposal.source_document_layer}`}>{proposal.source_document_layer}</span>}{proposal.source_document_drive_url ? <a href={proposal.source_document_drive_url} target="_blank" rel="noreferrer">{proposal.source_document_title}</a> : <strong>{proposal.source_document_title}</strong>}{proposal.source_document_summary && <p className="source-summary">{proposal.source_document_summary}</p>}</div>}</article>)}</div>}</section>;
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

function Login({ onLogin, loading, error }: { onLogin: (email: string, password: string) => Promise<void>; loading: boolean; error: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return <main className="login"><section className="login-card"><img className="club-logo" src="/hc-sentmenat-logo.png" alt="Escut de l'HC Sentmenat" /><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1><p className="intro">Planifica, registra i acompanya l'evolució del teu equip.</p><form onSubmit={(event) => { event.preventDefault(); void onLogin(email, password); }}><label>Correu autoritzat<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="entrenador@hcsentmenat.cat" /></label><label>Contrasenya<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="error" role="alert">{error}</p>}<button disabled={loading}>{loading ? "Validant…" : "Entrar"}</button></form><small>Accés privat per a entrenadors i coordinació.</small></section></main>;
}

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js").then((registration) => registration.update());
  });
}
