# Traflix Jarvis — Fase 8 Windows validation

**Stato: PENDING.** Questa checklist richiede l'app Windows/Tauri reale. Non
marcare una voce come superata tramite sola review statica.

## Voice-first

- [ ] All'avvio Jarvis mostra soltanto la barra compatta, senza chat/transcript drawer.
- [ ] Idle esatto: `Ready when you are`.
- [ ] Un click sul microfono avvia l'ascolto senza richiedere altri pulsanti.
- [ ] Si sente un breve cue audio quando il backend conferma l'inizio dell'ascolto.
- [ ] La barra passa a `Listening…` e il meter reagisce realmente al microfono.
- [ ] Dopo aver parlato, una pausa naturale fa scattare il VAD e chiude il turno automaticamente.
- [ ] Si sente un breve cue audio alla fine dell'ascolto, anche quando lo stop arriva dal VAD.
- [ ] La barra passa a `Transcribing…` senza mostrare `trascrizione pronta` o `invia alla chat`.
- [ ] La trascrizione viene inviata automaticamente a Jarvis.
- [ ] La barra mostra gli stati operativi (`Thinking…`, agent checkpoint, `Speaking…`) senza debug IDs.
- [ ] Jarvis riproduce automaticamente la risposta tramite Edge TTS.
- [ ] Durante TTS, premere il microfono interrompe la voce di Jarvis e apre un nuovo turno.
- [ ] Se Groq, OpenCode Zen o TTS falliscono, la barra mostra uno stato compatto utile e Settings resta raggiungibile.
- [ ] Nessun consent/privacy gate compare nel percorso normale.
- [ ] OpenCode Zen e Groq sono configurabili nelle Settings e le chiavi non vengono rilette in chiaro.
- [ ] Click normale sulla barra non la sposta.
- [ ] Piccolo movimento involontario non la sposta.
- [ ] Solo pressione prolungata + movimento trascina Jarvis e salva la nuova posizione.

## Agent control

- [ ] Parlare a Jarvis e aprire Codex.
- [ ] Verificare che compaia un terminale visibile.
- [ ] Verificare il launch del CLI Codex e la readiness della TUI.
- [ ] Verificare che il prompt arrivi nella stessa PTY.
- [ ] Verificare che Codex/OpenCode non vengano lanciati due volte quando il pane React monta.
- [ ] Continuare a usare manualmente la stessa TUI aperta da Jarvis.
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
- [ ] Verificare che Jarvis non parli spontaneamente dopo completion.
- [ ] Verificare che non esista un processo provider hidden.
- [ ] Verificare assenza di `codex app-server` e `opencode serve`.

## Desktop UI

- [ ] Sidebar resta compatta e non sottrae spazio inutile ai terminali.
- [ ] Terminal pane attivo è leggibile senza glow o card decoration invasiva.
- [ ] Right panel, Browser, Skills e Git condividono la stessa gerarchia visiva.
- [ ] New workspace wizard resta rapido e leggibile a 1–8 terminali.
- [ ] Settings resta utilizzabile a risoluzioni ridotte e non espone diagnostica salvo richiesta.
- [ ] Modal, toast, focus ring e stato disabled sono leggibili da tastiera.
- [ ] `prefers-reduced-motion` non lascia animazioni indispensabili alla comprensione.

La verifica deve includere liveness, generation, titolo user-controlled,
riapertura della workspace, WebView2 reale, audio device reale e la possibilità
per l'utente di usare normalmente la TUI dopo ogni azione di Jarvis.
