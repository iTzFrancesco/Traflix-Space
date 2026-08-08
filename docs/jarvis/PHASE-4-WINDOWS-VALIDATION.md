# Checklist validazione manuale Windows — Jarvis Fase 4

Questa checklist è futura: la VPS Linux non può dichiarare superata la
validazione manuale Windows.

- [ ] avvio Tauri Windows;
- [ ] configurazione `OPENCODE_ZEN_API_KEY` soltanto nel backend;
- [ ] consenso privacy richiesto e revocabile;
- [ ] risposta con modello primario;
- [ ] fallback con modello primario non disponibile o errore temporaneo;
- [ ] Codex, Pi e OpenCode rilevati nel terminale;
- [ ] prompt agent su singola linea;
- [ ] prompt agent multilinea con un solo Enter;
- [ ] modifica Pending Action `agent.send`;
- [ ] conferma Pending Action;
- [ ] rifiuto Pending Action;
- [ ] `agent.abort` invia Ctrl+C;
- [ ] `terminal.kill` richiede conferma ed è single-use;
- [ ] cambio workspace durante una richiesta;
- [ ] due richieste in workspace differenti;
- [ ] cancellazione di una richiesta;
- [ ] scrollback lungo e output recente;
- [ ] Advanced Settings disattivato di default;
- [ ] nessun flicker o spostamento del widget;
- [ ] nessun secret nei log, settings o messaggi di errore.

## Stato VPS Linux

I test Rust, TypeScript e lo stato frontend portabile sono eseguibili senza
rete reale. Le suite PowerShell/named-pipe e la prova PTY ConPTY restano da
eseguire su Windows.
