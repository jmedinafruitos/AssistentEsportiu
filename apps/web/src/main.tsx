import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ChatMessage, CurrentUser, Team } from "./api";
import "./styles.css";

const TOKEN_KEY = "assistent-esportiu-token";
const suggestions = ["Prepara el pròxim entrenament", "Analitza el darrer partit", "Quins objectius prioritzem?"];

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([api.me(token), api.teams(token)]).then(([identity, result]) => {
      setUser(identity); setTeams(result.teams); setTeamId((current) => current || result.teams[0]?.id || ""); setError("");
    }).catch(() => logout()).finally(() => setLoading(false));
  }, [token]);

  const activeTeam = useMemo(() => teams.find((team) => team.id === teamId), [teams, teamId]);
  function logout() { sessionStorage.removeItem(TOKEN_KEY); setToken(""); setUser(null); setTeams([]); setMessages([]); }

  async function login(email: string) {
    setLoading(true); setError("");
    try {
      const session = await api.login(email); sessionStorage.setItem(TOKEN_KEY, session.token); setToken(session.token);
    } catch { setError("No hem pogut validar aquest correu. Comprova que estigui autoritzat."); setLoading(false); }
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
    <section className="identity-card"><div><strong>{user.name}</strong><span>{user.sport_role ?? user.role}</span></div><label>Equip actiu<select value={teamId} onChange={(event) => { setTeamId(event.target.value); setMessages([]); }}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name} · {team.season}</option>)}</select></label></section>
    <section className="conversation" aria-live="polite">
      {!messages.length && <div className="welcome"><span className="eyebrow">{activeTeam?.category ?? "El teu equip"}</span><h2>Què vols treballar avui?</h2><p>Conversarem amb l'estratègia del club i el context autoritzat de {activeTeam?.name}.</p></div>}
      {messages.map((message) => <article key={message.id} className={`bubble ${message.role}`}><span>{message.role === "assistant" ? "Assistent" : user.name}</span><p>{message.content}</p></article>)}
      {loading && <div className="typing" aria-label="L'assistent està escrivint"><i /><i /><i /></div>}
    </section>
    {!messages.length && <nav className="suggestions" aria-label="Suggeriments">{suggestions.map((item) => <button key={item} onClick={() => send(item)}>{item}</button>)}</nav>}
    {error && <p className="error" role="alert">{error}</p>}
    <Composer disabled={!teamId || loading} onSend={send} />
  </main>;
}

function Login({ onLogin, loading, error }: { onLogin: (email: string) => Promise<void>; loading: boolean; error: string }) {
  const [email, setEmail] = useState("");
  return <main className="login"><section className="login-card"><img className="club-logo" src="/hc-sentmenat-logo.png" alt="Escut de l'HC Sentmenat" /><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1><p className="intro">Planifica, registra i acompanya l'evolució del teu equip.</p><form onSubmit={(event) => { event.preventDefault(); void onLogin(email); }}><label>Correu autoritzat<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="entrenador@hcsentmenat.cat" /></label>{error && <p className="error" role="alert">{error}</p>}<button disabled={loading}>{loading ? "Validant…" : "Entrar"}</button></form><small>Accés privat per a entrenadors i coordinació.</small></section></main>;
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState("");
  function submit(event: FormEvent) { event.preventDefault(); if (!message.trim()) return; const value = message; setMessage(""); void onSend(value); }
  return <form className="composer" onSubmit={submit}><textarea aria-label="Missatge per a l'assistent" rows={1} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Escriu una consulta…" disabled={disabled} /><button aria-label="Enviar" disabled={disabled || !message.trim()}>Enviar</button></form>;
}

createRoot(document.getElementById("root")!).render(<App />);
