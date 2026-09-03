import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, AssistantResult, ChatMessage, CoordinatorOverview, CurrentUser, EventAction, EventTypeActionTemplate, Team, TeamEvent, TeamPlan } from "./api";
import "./styles.css";

const TOKEN_KEY = "assistent-esportiu-token";
const suggestions = ["Prepara el pròxim entrenament", "Analitza el darrer partit", "Quins objectius prioritzem?"];

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const [overview, setOverview] = useState<CoordinatorOverview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [results, setResults] = useState<AssistantResult[] | null>(null);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<{ event: TeamEvent; actions: EventAction[] } | null>(null);
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [managingTemplates, setManagingTemplates] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([api.me(token), api.teams(token)]).then(([identity, result]) => {
      setUser(identity); setTeams(result.teams); setTeamId((current) => current || result.teams[0]?.id || ""); setError("");
    }).catch(() => logout()).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (!token || !teamId) { setEvents([]); return; }
    void api.events(token, teamId).then((result) => setEvents(result.events)).catch(() => {});
  }, [token, teamId]);

  async function refreshEvents() {
    if (!teamId) return;
    const result = await api.events(token, teamId);
    setEvents(result.events);
  }

  async function openEvent(eventId: string) {
    try { setSelectedEvent(await api.eventDetail(token, teamId, eventId)); }
    catch { setError("No s'ha pogut carregar l'esdeveniment."); }
  }

  const activeTeam = useMemo(() => teams.find((team) => team.id === teamId), [teams, teamId]);
  function logout() { localStorage.removeItem(TOKEN_KEY); setToken(""); setUser(null); setTeams([]); setMessages([]); }

  async function login(email: string, password: string) {
    setLoading(true); setError("");
    try {
      const session = await api.login(email, password); localStorage.setItem(TOKEN_KEY, session.token); setToken(session.token);
    } catch { setError("Correu o contrasenya incorrectes."); setLoading(false); }
  }

  async function send(content: string) {
    const clean = content.trim();
    if (!clean || !teamId || loading) return;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: clean };
    const history = messages;
    setMessages((current) => [...current, userMessage]); setLoading(true); setError("");
    try {
      const response = await api.chat(token, teamId, clean, history);
      setMessages((current) => [...current, { id: response.id, role: "assistant", content: response.content }]);
    } catch (requestError) {
      setError(requestError instanceof Error && requestError.message.includes("not configured")
        ? "L'assistent d'IA encara no està configurat al servidor."
        : "No s'ha pogut obtenir resposta. Torna-ho a provar d'aquí a un moment.");
    } finally { setLoading(false); }
  }

  if (!token || (!user && !loading)) return <Login onLogin={login} loading={loading} error={error} />;
  if (!user) return <main className="centered" aria-live="polite">Carregant el teu context…</main>;

  return <main className="assistant-shell">
    <header className="app-header"><div className="brand"><img className="club-logo compact" src="/hc-sentmenat-logo.png" alt="Escut de l'HC Sentmenat" /><div><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1></div></div><button className="quiet" onClick={logout}>Sortir</button></header>
    <section className="identity-card"><div><strong>{user.name}</strong><span>{user.sport_role ?? user.role}</span>{user.global_access && <button className="text-action" onClick={() => { if (overview) setOverview(null); else void api.coordinatorOverview(token).then(setOverview).catch(() => setError("No s'ha pogut carregar la visió global.")); }}>{overview ? "Tancar visió global" : "Visió global"}</button>}</div><label>Equip actiu<select value={teamId} onChange={(event) => { setTeamId(event.target.value); setMessages([]); }}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · {team.season}</option>)}</select></label></section>
    <section className="events"><div className="events-header"><h2>Pròxims esdeveniments</h2><span><button className="text-action" onClick={() => setCreatingEvent(true)}>Afegir</button>{user.global_access && <button className="text-action" onClick={() => setManagingTemplates(true)}>Accions per tipus</button>}</span></div>{events.length ? <ul className="event-list">{events.map((event) => <li key={event.id}><button type="button" className={`event-item ${event.canceled ? "canceled" : ""}`} onClick={() => void openEvent(event.id)}><span className={`event-type ${event.event_type}`}>{eventTypeLabel(event.event_type)}</span><strong>{event.title}</strong><span>{new Date(event.starts_at).toLocaleString("ca", { dateStyle: "medium", timeStyle: "short" })}</span>{event.canceled && <em>Cancel·lat</em>}</button></li>)}</ul> : <p className="empty">Sense esdeveniments propers.</p>}</section>
    {overview && <CoordinatorPanel overview={overview} />}
    <section className="conversation" aria-live="polite">
      {!messages.length && <div className="welcome"><span className="eyebrow">{activeTeam?.category ?? "El teu equip"}</span><h2>Què vols treballar avui?</h2><p>Conversarem amb l'estratègia del club i el context autoritzat de {activeTeam?.name}.</p></div>}
      {messages.map((message) => <article key={message.id} className={`bubble ${message.role}`}><span>{message.role === "assistant" ? "Assistent" : user.name}</span><p>{message.content}</p>{message.role === "assistant" && <button className="speak" onClick={() => speak(message.content)} aria-label="Escoltar resposta">Escoltar</button>}</article>)}
      {loading && <div className="typing" aria-label="L'assistent està escrivint"><i /><i /><i /></div>}
    </section>
    {!messages.length && <nav className="suggestions" aria-label="Suggeriments">{suggestions.map((item) => <button key={item} onClick={() => send(item)}>{item}</button>)}<button onClick={() => setRecording(true)}>Registrar activitat</button><button onClick={() => setPlanning(true)}>Planificació</button><button onClick={() => { if (results) setResults(null); else void api.assistantResults(token, teamId).then(({ results: history }) => setResults(history)); }}>Resultats desats</button></nav>}
    {results && <section className="result-list"><h2>Resultats de l'assistent</h2>{results.length ? results.map((result) => <article key={result.id}><small>{new Date(result.created_at).toLocaleDateString("ca")} · {result.requested_by}</small><strong>{result.user_message}</strong><p>{result.assistant_message}</p><button className="speak" onClick={() => speak(result.assistant_message)}>Escoltar</button></article>) : <p>Encara no hi ha resultats desats.</p>}</section>}
    {recording && <RecordCapture teamName={activeTeam?.name ?? "l'equip"} onCancel={() => setRecording(false)} onSave={async (record) => { await api.createRecord(token, teamId, record); setRecording(false); setNotice("Activitat desada a l'historial de l'equip."); }} />}
    {planning && <PlanningEditor token={token} teamId={teamId} teamName={activeTeam?.name ?? "l'equip"} onClose={() => setPlanning(false)} />}
    {selectedEvent && <EventDetail token={token} teamId={teamId} detail={selectedEvent} onClose={() => setSelectedEvent(null)} onChanged={(detail) => { setSelectedEvent(detail); void refreshEvents(); }} />}
    {creatingEvent && <EventEditor token={token} teamId={teamId} onClose={() => setCreatingEvent(false)} onSaved={() => { setCreatingEvent(false); void refreshEvents(); }} />}
    {managingTemplates && <ActionTemplatesEditor token={token} teams={teams} onClose={() => setManagingTemplates(false)} />}
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <Composer disabled={!teamId || loading} onSend={send} />
  </main>;
}

function speak(content: string) { if (!("speechSynthesis" in window)) return; window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(content); utterance.lang = "ca-ES"; window.speechSynthesis.speak(utterance); }

function eventTypeLabel(type: "training" | "match" | "meeting") { return type === "training" ? "Entrenament" : type === "match" ? "Partit" : "Reunió"; }

function EventDetail({ token, teamId, detail, onClose, onChanged }: { token: string; teamId: string; detail: { event: TeamEvent; actions: EventAction[] }; onClose: () => void; onChanged: (detail: { event: TeamEvent; actions: EventAction[] }) => void }) {
  const { event, actions } = detail;
  const [error, setError] = useState("");
  async function toggleAction(actionId: string, completed: boolean) {
    try { const updated = await api.updateEventAction(token, teamId, event.id, actionId, { completed }); onChanged({ event, actions: actions.map((action) => action.id === actionId ? updated : action) }); }
    catch { setError("No s'ha pogut actualitzar l'acció."); }
  }
  async function toggleCanceled() {
    try { onChanged({ event: await api.updateEvent(token, teamId, event.id, { canceled: !event.canceled }), actions }); }
    catch { setError("No s'ha pogut actualitzar l'esdeveniment."); }
  }
  return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true"><h2>{eventTypeLabel(event.event_type)} · {event.title}</h2><p className="event-meta">{new Date(event.starts_at).toLocaleString("ca", { dateStyle: "full", timeStyle: "short" })}{event.location && <> · {event.location}</>}</p>{event.notes && <p>{event.notes}</p>}{actions.length > 0 && <ul className="checklist">{actions.map((action) => <li key={action.id}><label><input type="checkbox" checked={Boolean(action.completed_at)} onChange={(evt) => void toggleAction(action.id, evt.target.checked)} />{action.label}</label></li>)}</ul>}{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={() => void toggleCanceled()}>{event.canceled ? "Reactivar" : "Cancel·lar esdeveniment"}</button><button type="button" onClick={onClose}>Tancar</button></div></section></div>;
}

function EventEditor({ token, teamId, onClose, onSaved }: { token: string; teamId: string; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"single" | "recurring">("single");
  const [eventType, setEventType] = useState<"training" | "match" | "meeting">("training");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [recurTime, setRecurTime] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const weekdayLabels = ["Dg", "Dl", "Dt", "Dc", "Dj", "Dv", "Ds"];
  function toggleWeekday(day: number) { setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort()); }
  async function submitSingle(formEvent: FormEvent) {
    formEvent.preventDefault(); setSaving(true); setError("");
    try { await api.createEvent(token, teamId, { eventType, title, startsAt: new Date(`${date}T${time}`).toISOString(), location: location || undefined, notes: notes || undefined }); onSaved(); }
    catch { setError("No s'ha pogut desar l'esdeveniment."); setSaving(false); }
  }
  async function submitRecurring(formEvent: FormEvent) {
    formEvent.preventDefault(); setSaving(true); setError("");
    try { await api.generateTrainings(token, teamId, { title: title || undefined, weekdays, time: recurTime, from, to }); onSaved(); }
    catch { setError("No s'han pogut generar els entrenaments."); setSaving(false); }
  }
  return <div className="modal-backdrop"><section className="record-card" role="dialog" aria-modal="true"><h2>Nou esdeveniment</h2><div className="dialog-actions mode-switch"><button type="button" className={mode === "single" ? "" : "quiet"} onClick={() => setMode("single")}>Puntual</button><button type="button" className={mode === "recurring" ? "" : "quiet"} onClick={() => setMode("recurring")}>Entrenaments recurrents</button></div>
    {mode === "single"
      ? <form onSubmit={submitSingle}><label>Tipus<select value={eventType} onChange={(evt) => setEventType(evt.target.value as typeof eventType)}><option value="training">Entrenament</option><option value="match">Partit</option><option value="meeting">Reunió</option></select></label><label>Títol<input required value={title} onChange={(evt) => setTitle(evt.target.value)} placeholder="Ex: Partit vs. CE Vic" /></label><label>Data<input required type="date" value={date} onChange={(evt) => setDate(evt.target.value)} /></label><label>Hora<input required type="time" value={time} onChange={(evt) => setTime(evt.target.value)} /></label><label>Lloc<input value={location} onChange={(evt) => setLocation(evt.target.value)} placeholder="Opcional" /></label><label>Notes<textarea value={notes} onChange={(evt) => setNotes(evt.target.value)} /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel·lar</button><button disabled={saving}>{saving ? "Desant…" : "Desar"}</button></div></form>
      : <form onSubmit={submitRecurring}><label>Títol (opcional)<input value={title} onChange={(evt) => setTitle(evt.target.value)} placeholder="Entrenament" /></label><fieldset><legend>Dies de la setmana</legend>{weekdayLabels.map((label, day) => <label key={day} className="weekday-toggle"><input type="checkbox" checked={weekdays.includes(day)} onChange={() => toggleWeekday(day)} />{label}</label>)}</fieldset><label>Hora<input required type="time" value={recurTime} onChange={(evt) => setRecurTime(evt.target.value)} /></label><label>Des de<input required type="date" value={from} onChange={(evt) => setFrom(evt.target.value)} /></label><label>Fins a<input required type="date" value={to} onChange={(evt) => setTo(evt.target.value)} /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel·lar</button><button disabled={saving || !weekdays.length}>{saving ? "Generant…" : "Generar"}</button></div></form>}
  </section></div>;
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
  return <section className="overview"><div><span className="eyebrow">Coordinació</span><h2>Activitat de tots els equips</h2></div><div className="team-grid">{overview.teams.map((team) => <article key={team.id}><strong>{team.name}</strong><span>{team.category}</span><p>{team.record_count} registres · {team.staff_count} tècnics</p><small>{team.last_activity_at ? `Darrera activitat: ${new Date(team.last_activity_at).toLocaleDateString("ca")}` : "Encara sense activitat"}</small></article>)}</div>{overview.pendingProposals.length > 0 && <p className="pending">{overview.pendingProposals.length} canvis pendents de confirmació explícita.</p>}</section>;
}

function RecordCapture({ teamName, onCancel, onSave }: { teamName: string; onCancel: () => void; onSave: (record: { type: "training" | "match"; happenedAt: string; summary: string; outcome?: string; nextObjectives: string[] }) => Promise<void> }) {
  const [type, setType] = useState<"training" | "match">("training");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState("");
  const [objectives, setObjectives] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try { await onSave({ type, happenedAt: new Date().toISOString(), summary, outcome: outcome || undefined, nextObjectives: objectives.split("\n").map((item) => item.trim()).filter(Boolean) }); }
    catch { setError("No s'ha pogut desar l'activitat."); setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation"><section className="record-card" role="dialog" aria-modal="true" aria-labelledby="record-title"><h2 id="record-title">Registrar {teamName}</h2><form onSubmit={submit}><label>Tipus<select value={type} onChange={(event) => setType(event.target.value as "training" | "match")}><option value="training">Entrenament</option><option value="match">Partit</option></select></label><label>Resum<textarea required value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Què heu treballat i com ha anat?" /></label><label>Resultat o valoració<input value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="Opcional" /></label><label>Pròxims objectius<textarea value={objectives} onChange={(event) => setObjectives(event.target.value)} placeholder="Un objectiu per línia" /></label>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button type="button" className="quiet" onClick={onCancel}>Cancel·lar</button><button disabled={saving}>{saving ? "Desant…" : "Desar"}</button></div></form></section></div>;
}

function Login({ onLogin, loading, error }: { onLogin: (email: string, password: string) => Promise<void>; loading: boolean; error: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return <main className="login"><section className="login-card"><img className="club-logo" src="/hc-sentmenat-logo.png" alt="Escut de l'HC Sentmenat" /><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1><p className="intro">Planifica, registra i acompanya l'evolució del teu equip.</p><form onSubmit={(event) => { event.preventDefault(); void onLogin(email, password); }}><label>Correu autoritzat<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="entrenador@hcsentmenat.cat" /></label><label>Contrasenya<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="error" role="alert">{error}</p>}<button disabled={loading}>{loading ? "Validant…" : "Entrar"}</button></form><small>Accés privat per a entrenadors i coordinació.</small></section></main>;
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [listening, setListening] = useState(false);
  function submit(event: FormEvent) { event.preventDefault(); if (!message.trim()) return; const value = message; setMessage(""); void onSend(value); }
  function dictate() {
    const SpeechRecognition = (window as typeof window & { SpeechRecognition?: new () => { lang: string; start(): void; onresult: (event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void; onend: () => void; onerror: () => void } }).SpeechRecognition
      ?? (window as typeof window & { webkitSpeechRecognition?: new () => { lang: string; start(): void; onresult: (event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void; onend: () => void; onerror: () => void } }).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition(); recognition.lang = "ca-ES"; setListening(true);
    recognition.onresult = (event) => setMessage(event.results[0]?.[0].transcript ?? ""); recognition.onend = () => setListening(false); recognition.onerror = () => setListening(false); recognition.start();
  }
  return <form className="composer" onSubmit={submit}><button type="button" className="voice" onClick={dictate} disabled={disabled} aria-label="Dictar missatge">{listening ? "Escoltant…" : "Micròfon"}</button><textarea aria-label="Missatge per a l'assistent" rows={1} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Escriu o dicta una consulta…" disabled={disabled} /><button aria-label="Enviar" disabled={disabled || !message.trim()}>Enviar</button></form>;
}

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js").then((registration) => registration.update());
  });
}
