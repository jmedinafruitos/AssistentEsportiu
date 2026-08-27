import { FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Prompt = "Preparar el pròxim entrenament" | "Donar feedback d'un partit" | "Revisar l'estratègia de l'equip";

function App() {
  const [email, setEmail] = useState("");
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("Què vols treballar avui?");

  function login(event: FormEvent) {
    event.preventDefault();
    if (email.trim()) setActive(true);
  }

  function selectPrompt(prompt: Prompt) {
    setMessage(`${prompt}. Explica'm el context i prepararé una proposta per desar.`);
  }

  if (!active) {
    return <main className="login"><section><img className="club-logo" src="/hc-sentmenat-logo.png" alt="HC Sentmenat" /><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1><p>Accedeix per treballar amb el context del teu equip.</p><form onSubmit={login}><label>Correu del club<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="entrenador@hcsentmenat.cat" /></label><button>Entrar</button></form></section></main>;
  }

  return <main className="assistant"><header><div className="brand"><img className="club-logo compact" src="/hc-sentmenat-logo.png" alt="HC Sentmenat" /><div><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Assistent Esportiu</h1></div></div><button className="quiet" onClick={() => setActive(false)}>Sortir</button></header><section className="conversation"><p className="team-label">Equip actual · Prebenjamí · Primer any</p><p className="bubble">{message}</p></section><section className="actions"><p>Accions habituals</p>{(["Preparar el pròxim entrenament", "Donar feedback d'un partit", "Revisar l'estratègia de l'equip"] as Prompt[]).map((prompt) => <button key={prompt} onClick={() => selectPrompt(prompt)}>{prompt}</button>)}</section><form className="composer" onSubmit={(e) => { e.preventDefault(); setMessage("He anotat la teva consulta. La connectarem amb el context de l'equip des de l'API."); }}><input aria-label="Missatge per a l'assistent" placeholder="Escriu o dicta una nota…" /><button>Enviar</button></form></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
