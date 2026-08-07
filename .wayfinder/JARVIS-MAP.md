# Traflix Jarvis — Wayfinder decision map

**Tipo:** mappa decisionale della Fase 1, non task list.
**Data:** 2026-08-06.
**Baseline:** Traflix `3da6eb18a24b11df6920e32e59f4d40c3e9c1a63`; upstream e fonti sono elencati in [`docs/jarvis/RESEARCH.md`](../docs/jarvis/RESEARCH.md).

## Come leggere la mappa

`Raccomandata` indica una direzione progettuale proposta dalla ricerca, non un'implementazione approvata. `Aperta` richiede una decisione dell'owner. `Condizionata` dipende da una verifica Windows, provider o versione upstream. Le evidenze distinguono osservazioni del codice da inferenze architetturali.

## Decisioni

### JARVIS-011 — Provider testuale del vertical slice

- **Stato:** Decisa per la Fase 4
- **Decisione:** OpenCode Zen è l'unico provider runtime; `longcat-2.0-free` è
  primary configurabile e `deepseek-v4-flash-free` è fallback configurabile.
- **Vincoli:** una sola credenziale backend, consenso esplicito, nessuna
  discovery/preflight automatica e nessuna chiave nel frontend.

### JARVIS-012 — Pipeline vocale Fase 5

- **Stato:** Decisa per la Fase 5
- **Decisione:** input click-to-toggle con Groq `whisper-large-v3-turbo` come
  unico STT; transcript modificabile e invio esplicito a `jarvis_chat`; output
  Edge TTS interrompibile.
- **Vincoli:** consensi input/output separati, audio bounded in memoria,
  nessun fallback STT/TTS, nessuna wake word/VAD/full duplex e nessuna chiave
  nel frontend.

### JARVIS-001 — Qual è il confine globale?

- **Domanda:** Jarvis deve poter mescolare automaticamente workspace diverse?
- **Stato:** Raccomandata
- **Raccomandazione:** globale come widget/orchestratore, ma ogni Context Package e ogni tool hanno un `targetWorkspaceId`; nessun merge cross-workspace senza target esplicito.
- **Alternative:** contesto globale misto; workspace selezionata soltanto dalla UI.
- **Evidenze:** `workspaceStore` ha `activeWorkspaceId`; terminali e watcher hanno `workspaceId`; `CONTEXT-BROKER.md` richiede isolamento.
- **Dipendenze:** broker, tool registry, memoria.
- **Manca:** UX per richiesta senza target e scelta esplicita cross-workspace.

### JARVIS-002 — Dove vive il core?

- **Domanda:** frontend, Rust, sidecar o processo separato?
- **Stato:** Raccomandata, da validare nel vertical slice
- **Raccomandazione:** React per presentazione; Rust per authority, policy, broker, audit e processi; adapter provider dietro seam typed, con helper TypeScript solo dove SDK/protocollo lo richiede.
- **Alternative:** core React; tutto Rust; sidecar TypeScript autonomo; processo locale separato.
- **Evidenze:** PTY, Git, watcher, named pipe e Tauri command sono già Rust; SDK OpenCode/Codex sono naturalmente JSON/TypeScript; confronto completo in `ARCHITECTURE-OPTIONS.md`.
- **Dipendenze:** IPC, packaging Windows, lifecycle sidecar.
- **Manca:** prova di crash/lifecycle e scelta della forma IPC.

### JARVIS-003 — Qual è il protocollo agent principale?

- **Domanda:** structured adapter o scraping terminale?
- **Stato:** Decisa per principio
- **Raccomandazione:** `StructuredAgentAdapter` come fondamento; `TerminalAgentAdapter` soltanto fallback.
- **Alternative:** scraping PTY per tutti; notifiche completion come risultato.
- **Evidenze:** Traflix ha completion notification ma non transcript/results; ANSI/alternate-screen non è protocollo.
- **Dipendenze:** AgentSessionRegistry e adapter lifecycle.
- **Manca:** schema persistente di `AgentSessionRef`.

### JARVIS-004 — Come si integra OpenCode?

- **Domanda:** server controllato da Traflix, server TUI, SDK diretto o ibrido?
- **Stato:** Raccomandata condizionata
- **Raccomandazione:** SDK/spec generated verso il server già usato dalla TUI quando discovery/auth/version/cwd sono deterministici; server controllato da Traflix come fallback strutturato; TUI visibile non è fonte primaria.
- **Alternative:** avviare sempre un server per workspace; solo terminale; chiamare direttamente l'SDK senza health/version check.
- **Evidenze:** OpenCode documenta `serve`, OpenAPI, session/message APIs, SSE, permission e localhost; snapshot upstream `def7220b...` contiene server/SDK/protocol packages.
- **Dipendenze:** versione OpenCode installata, location directory e gestione auth.
- **Manca:** discovery ufficiale sul Windows target e capability matrix della versione installata.

### JARVIS-005 — Come si integra Codex?

- **Domanda:** app-server, exec, MCP o TUI?
- **Stato:** Raccomandata condizionata
- **Raccomandazione:** `codex app-server` come adapter primario, con JSON-RPC typed, thread/turn lifecycle, approval forwarding e schema generato dallo stesso binario; auth resta al client ufficiale.
- **Alternative:** `codex exec`; scraping TUI; MCP come canale sessione.
- **Evidenze:** README app-server upstream al commit `57f42a8...` descrive thread/list/read/resume/fork, turn lifecycle, eventi, approvals, cwd e interrupt.
- **Dipendenze:** binario/versione e trasporto locale.
- **Manca:** verifica Windows e policy per app-server process ownership.

### JARVIS-006 — Come si costruisce il contesto?

- **Domanda:** vector DB subito o retrieval deterministico?
- **Stato:** Raccomandata
- **Raccomandazione:** file tree, Git, ripgrep/symbol search, documenti canonici, eventi e summary; cache per workspace; vector DB solo dopo benchmark.
- **Alternative:** embedding/vector DB dal primo giorno; contesto completo sempre.
- **Evidenze:** projectStore ha directory/Git/file watcher e revisioni; `CONTEXT.md` definisce contesto workspace/agent; budget e retrieval sono descritti in `CONTEXT-BROKER.md`.
- **Dipendenze:** cache persistence, file exclusions, token budget.
- **Manca:** soglie TTL e schema di invalidation persistente.

### JARVIS-007 — Qual è la memoria?

- **Domanda:** transcript globale o slice separate?
- **Stato:** Raccomandata
- **Raccomandazione:** memoria globale Jarvis, memoria workspace, summary per Agent session, attività delegate, decisioni approvate e stato effimero separati per scope.
- **Alternative:** una cronologia unica; memoria soltanto in localStorage.
- **Evidenze:** Zustand persistente non contiene transcript/session results; il dominio richiede workspace/session scope.
- **Dipendenze:** retention, audit, storage app-data.
- **Manca:** schema di archiviazione e privacy UX.

### JARVIS-008 — Quale modello?

- **Domanda:** fissare subito provider/model ID?
- **Stato:** Aperta
- **Raccomandazione:** interfaccia provider-agnostic e due livelli; candidato fast router `llama-3.1-8b-instant`; shortlist planner Zen paid/free + fallback, senza default definitivo.
- **Alternative:** Groq per tutto; Zen free per tutto; modello forte unico.
- **Evidenze:** Groq documenta tool use/JSON/context per Llama; Zen pubblica ID, pricing e free temporanei il 2026-08-06.
- **Dipendenze:** benchmark sintetico, metadata, privacy, rate limits account.
- **Manca:** qualità italiana/repository e capability strict per ogni modello.

### JARVIS-009 — Qual è il primo percorso vocale?

- **Domanda:** full duplex o push-to-talk?
- **Stato:** Raccomandata
- **Raccomandazione:** push-to-talk, STT provider-agnostic, Groq Whisper turbo come candidato rapido e Whisper v3 come fallback; TTS astratto con Edge TTS solo baseline da verificare.
- **Alternative:** wake word/full duplex; voice dopo il planner.
- **Evidenze:** Groq documenta i due Whisper multilingue, costi, velocità e limiti; Edge TTS non è stato integrato.
- **Dipendenze:** Windows audio device, cancellazione, privacy.
- **Manca:** test italiano rumoroso e policy TTS.

### JARVIS-010 — Quali tool sono autorizzati?

- **Domanda:** il modello può agire direttamente?
- **Stato:** Decisa per principio
- **Raccomandazione:** registry allowlist typed; read-only default; operational/destructive separati; conferma per spawn/send/abort/close/kill/delegate e permission.
- **Alternative:** tool dinamici generati dal modello; conferma soltanto UI globale.
- **Evidenze:** workspace/terminal/agent command attuali hanno effetti diversi; OpenCode/Codex hanno permission/approval; prompt injection è rischio dichiarato.
- **Dipendenze:** audit, identity, cancellation.
- **Manca:** policy dettagliata per ogni workspace/provider.

### JARVIS-011 — Come si rileva completion?

- **Domanda:** basta il testo del terminale?
- **Stato:** Decisa per principio
- **Raccomandazione:** provider event strutturato quando disponibile; Agent completion notification come invalidation signal; scraping con confidence/warning.
- **Alternative:** prompt heuristic universale; process exit.
- **Evidenze:** `agent_events.rs` normalizza completion e il README degli adapter mostra provider-specific hooks; `CONTEXT.md` separa turn/session/completion.
- **Dipendenze:** AgentSessionRegistry e session result reader.
- **Manca:** eventi started/working/waiting/failed uniformi oltre completion.

### JARVIS-012 — Qual è il vertical slice?

- **Domanda:** cosa implementare per primo nella Fase 2?
- **Stato:** Raccomandata
- **Raccomandazione:** Context Broker minimo + fake structured adapter + tool read-only per workspace, terminali, agenti e ultimi risultati.
- **Alternative:** widget; voce; OpenCode reale; Codex app-server reale.
- **Evidenze:** consente di provare isolamento, provenance, cache e vocabolario senza provider/Windows.
- **Dipendenze:** JARVIS-001, 002, 003, 006, 007, 010, 011.
- **Manca:** approvazione dei decision blocker in `NEXT-STEP.md`.

## Dipendenze tra decisioni

```text
JARVIS-001 ─┬─> JARVIS-006 ─> JARVIS-007
            ├─> JARVIS-010 ─> JARVIS-012
JARVIS-002 ─┴─> JARVIS-003 ─┬─> JARVIS-004
                             └─> JARVIS-005
JARVIS-008 ────────────────> planner reale (dopo JARVIS-012)
JARVIS-009 ────────────────> voice MVP (dopo planner)
JARVIS-011 ────────────────> session summaries e invalidation
```

## Fuori scope della mappa

- implementazione di widget, voce, broker o tool runtime;
- modifica di `src/` o `src-tauri/src/` durante questa fase;
- build, test Windows, packaging MSI;
- autenticazione/token provider;
- push, PR e modifica di `.wayfinder/MAP.md`.

## Stato Fase 2 — decisioni owner consolidate

- JARVIS-001: **approvata** — Jarvis globale, target workspace catturato per invocazione e nessun merge implicito.
- JARVIS-002: **approvata per questo slice** — Rust è l’autorità del broker e delle policy; React mantiene solo il client IPC typed.
- JARVIS-003: **approvata per questo slice** — seam `AgentContextSource`; fake test-only, nessun terminal scraping come fondamento.
- JARVIS-006: **sostituita per questo slice** — raccolta automatica soltanto Markdown, cache incrementale volatile per workspace, nessuna lettura automatica del codice.
- JARVIS-010: **approvata per questo slice** — tool allowlisted e completamente read-only.
- JARVIS-011: **approvata per questo slice** — completion notification è segnale di lifecycle, non risultato.
- JARVIS-012: **approvata** — Context Broker minimo, fake adapter e tool read-only.

## Stato Fase 3 — decisioni owner consolidate

- JARVIS-001: **consolidata** — shell globale persistente, target e dati separati per workspace.
- JARVIS-003: **sostituita per il percorso live** — registry terminal-based/provider-agnostic; `terminalId + generation` è l’identità, gli adapter strutturati restano opzionali.
- JARVIS-009: **rinviata** — Standard/Gemini sono soltanto impostazioni; nessun motore vocale è collegato.
- JARVIS-010: **consolidata** — il registry e i tool Jarvis restano read-only in questa fase.
- JARVIS-011: **consolidata** — completion aggiorna `waiting` e l’ultimo fallback, senza chiudere la sessione.
- JARVIS-012: **estesa** — Context Broker live collegato al `AgentSessionRegistry` terminal-based e shell globale visibile.

## Stato Fase 6

- Hotkey globale, hold-to-talk e Energy VAD locale opzionale sono decisioni
  consolidate sopra la pipeline cloud Fase 5.
- Click-toggle resta il default; Groq `whisper-large-v3-turbo` e Edge TTS non
  cambiano.
- Wake word, ascolto continuo, full duplex, streaming e Fase 7 restano fuori
  scope.
