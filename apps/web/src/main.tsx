import { FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Prompt = "Preparar el próximo entreno" | "Dar feedback de un partido" | "Revisar la estrategia del equipo";

function App() {
  const [email, setEmail] = useState("");
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("¿Qué quieres trabajar hoy?");

  function login(event: FormEvent) {
    event.preventDefault();
    if (email.trim()) setActive(true);
  }

  function selectPrompt(prompt: Prompt) {
    setMessage(`${prompt}. Cuéntame el contexto y prepararé una propuesta para guardar.`);
  }

  if (!active) {
    return <main className="login"><section><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Asistente Deportivo</h1><p>Accede para trabajar con el contexto de tu equipo.</p><form onSubmit={login}><label>Correo del club<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="entrenador@club.cat" /></label><button>Entrar</button></form></section></main>;
  }

  return <main className="assistant"><header><div><p className="club">HOQUEI CLUB SENTMENAT</p><h1>Asistente Deportivo</h1></div><button className="quiet" onClick={() => setActive(false)}>Salir</button></header><section className="conversation"><p className="bubble">{message}</p></section><section className="actions"><p>Acciones habituales</p>{(["Preparar el próximo entreno", "Dar feedback de un partido", "Revisar la estrategia del equipo"] as Prompt[]).map((prompt) => <button key={prompt} onClick={() => selectPrompt(prompt)}>{prompt}</button>)}</section><form className="composer" onSubmit={(e) => { e.preventDefault(); setMessage("He anotado tu consulta. La conectaremos con el contexto del equipo desde la API."); }}><input aria-label="Mensaje para el asistente" placeholder="Escribe o dicta una nota…" /><button>Enviar</button></form></main>;
}

createRoot(document.getElementById("root")!).render(<App />);

