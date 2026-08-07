# Traflix Jarvis — Fase 8 Windows validation

**Stato: PENDING.** Questa checklist richiede l'app Windows/Tauri reale e non
è stata eseguita in ambiente Linux/VPS.

- [ ] Parlare a Jarvis e aprire Codex.
- [ ] Verificare che compaia un terminale visibile.
- [ ] Verificare il launch del CLI Codex e la readiness della TUI.
- [ ] Verificare che il prompt arrivi nella stessa PTY.
- [ ] Risolvere un agente esistente dal provider e dal titolo rinominato.
- [ ] Distinguere due terminali dello stesso provider.
- [ ] Mostrare clarification per un agente pertinente occupato.
- [ ] Chiedere il provider quando l'utente dice soltanto di aprire un agente.
- [ ] Aprire un provider specificato e inviare l'initial prompt.
- [ ] Verificare handoff Codex → OpenCode.
- [ ] Verificare draft-only senza scrittura PTY.
- [ ] Verificare conferma conversazionale di una sessione working.
- [ ] Chiudere direttamente una sessione waiting.
- [ ] Verificare isolamento tra workspace.
- [ ] Verificare lo stesso flow tramite comando vocale/transcript.
- [ ] Verificare che Jarvis non parli spontaneamente dopo completion.
- [ ] Verificare che non esista un processo provider hidden.
- [ ] Verificare assenza di `codex app-server` e `opencode serve`.

La verifica deve includere liveness, generation, titolo user-controlled,
riapertura della workspace e la possibilità per l'utente di usare normalmente
la TUI dopo l'azione di Jarvis.
