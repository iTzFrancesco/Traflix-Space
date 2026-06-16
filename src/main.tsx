import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// Disabilita il menu contestuale del webview (Aggiorna, Indietro, ecc.)
// Inappropriato per un'app desktop Tauri con decorations: false
// Eccezione: permette il contextmenu nei terminali xterm.js (necessario per right-click paste)
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".xterm")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
