# Traflix Jarvis — ricerca Fase 1

**Data analisi:** 2026-08-06
**Branch:** `feat/jarvis-agent-research`
**Scope:** ricerca, analisi architetturale e pianificazione. Nessun runtime Jarvis è stato implementato.

## Metodo e confini

La ricerca ha usato Wayfinder come mappa decisionale principale, `grill-with-docs` per esplicitare le decisioni architetturali, `domain-modeling` per mantenere il vocabolario di `CONTEXT.md`, `codebase-design` per distinguere moduli, interfacce, seam e adapter, e `research` per le fonti upstream. `prototype` è stato usato solo come lente per definire un futuro vertical slice: non è stato creato codice prototipale perché questa fase consente soltanto documentazione.

Sono stati letti `AGENTS.md`, `CONTEXT.md`, `README.md`, `.wayfinder/MAP.md` e la documentazione rilevante sotto `docs/`. `.env` non è stato letto. Non sono stati cercati, stampati o copiati segreti.

Le osservazioni locali sono fatti riferiti al commit Traflix `3da6eb18a24b11df6920e32e59f4d40c3e9c1a63`. Le conclusioni su Jarvis e le raccomandazioni sono ipotesi di design, indicate come tali.

## Architettura Traflix Space osservata

Traflix Space è una desktop app Tauri 2 per Windows con React 19/Vite/Zustand nel frontend e Rust nel backend. Il frontend visualizza workspaces, griglia di terminali, sidebar, pannello destro e notifiche. Il backend possiede i processi PTY, la persistenza delle configurazioni workspace, il file watcher e il bridge degli eventi agent.

### Punti di ingresso e stato

- `src/App.tsx` compone `TitleBar`, `Sidebar`, `WorkspaceView`, `RightPanel`, `ProjectWorkspaceSync`, `AgentCompletionListener` e il layer di toast. L'overlay di notifica agent è una `WebviewWindow` separata; non è ancora il widget Jarvis.
- `src/components/sidebar/Sidebar.tsx` legge e modifica `workspaceStore`, `terminalStore` e `uiStore`. È il punto naturale per un futuro comando “Mostra Jarvis”, ma non deve diventare il core dell'assistente.
- `src/components/settings/SettingsModal.tsx` non espone ancora impostazioni applicative utili a Jarvis.
- `src/stores/workspaceStore.ts` mantiene `Workspace { id, name, rootPath, layout, terminalCount, agentCount, ... }` e persiste con la chiave `traflix-workspaces` soltanto workspaces e `activeWorkspaceId`.
- `src/stores/terminalStore.ts` mantiene in memoria `Record<string, TerminalState>`, con `workspaceId`, `cwd`, shell, agent, stato di lavoro/completamento, ultimo evento di completion e posizione di scroll. Non contiene transcript, messaggi strutturati o risultati completi.
- `src/stores/uiStore.ts` persiste sidebar, pannello destro e modali. Non esiste ancora uno stato Jarvis.
- `src/stores/projectStore.ts` mantiene stato Git e directory per workspace, revisioni del file watcher e refresh incrementali.

### Workspace

La workspace viene creata dal wizard (`src/components/workspace/NewSpaceWizard.tsx`) tramite `create_workspace`. L'ID è un UUID generato dal frontend; il backend salva `WorkspaceConfig` in `workspaces.json` sotto l'app-data di Traflix, non nel repository del progetto. La configurazione contiene root path, layout e `TerminalConfig`.

`workspaceStore.syncWithBackend()` usa `get_workspaces` e fonde la configurazione backend con lo stato persistito. L'attivazione è una scelta locale di `activeWorkspaceId`; `ProjectWorkspaceSync` ricollega watcher e Git alla workspace attiva.

La workspace è quindi già il confine di isolamento principale. Jarvis deve usare sempre `workspaceId` come parte dei contratti e non deve comporre automaticamente contesto da workspaces diverse. L'assistente può restare globale come superficie UI e processo di orchestrazione, ma il Context Package deve avere un target esplicito.

### Terminale e PTY

Il flusso reale è:

1. `WorkspaceView` genera un terminal ID, sceglie shell/cwd e invoca `terminal_spawn(..., workspaceId)`.
2. `TerminalManager` in `src-tauri/src/terminal_engine/` conserva le sessioni in una `DashMap` indicizzata per terminal ID e registra il `workspace_id` nella `TerminalSession`.
3. `portable-pty` crea il processo con cwd, dimensioni e variabili `TRAFLIX_*`, inclusi terminal ID, workspace ID e named pipe degli eventi agent.
4. `terminal_write` inoltra byte alla PTY; `terminal_resize`, `terminal_kill`, `terminal_reopen`, `terminal_set_active`, snapshot, scrollback e screen text sono già command Tauri.
5. L'output viene parsato ANSI/VT100 dal backend, emesso come `terminal-output` con sequenza crescente e inoltrato al relativo xterm.

Le primitive già disponibili sono:

- `terminal_spawn`, con riuso della sessione viva;
- `terminal_write`, che permette prompt e bracketed paste;
- `terminal_resize`, `terminal_kill`, `terminal_reopen`;
- `terminal_get_snapshot`, `terminal_get_scrollback`, `terminal_get_screen_text`;
- `terminal_get_context`, `terminal_sync_cwd` e `get_git_branch`;
- eventi `terminal-output`, `terminal-exited`, `terminal-cwd-changed` e `agent-turn-completed`.

`TerminalPane` crea un xterm per pane, mantiene 1000 righe di scrollback e reidrata lo screen text usando un watermark `outputSequence`, poi rigioca i chunk arrivati durante la snapshot. Il scroll position e il follow mode sono distinti secondo `CONTEXT.md`; Jarvis non deve interpretare una posizione di scroll come stato agent.

Un cambio workspace normalmente nasconde la griglia non attiva e mantiene vive le sessioni conservate in `loadedMap`; l'eviction LRU oltre il limite di otto workspace uccide invece i terminali dell'entry espulsa. La gestione concreta del cache deve essere verificata insieme a Jarvis prima di promettere persistenza illimitata degli agenti.

### Agent turn, Agent session, Agent completion notification

Si usano volutamente i termini canonici di `CONTEXT.md`:

- **Agent turn:** un ciclo che elabora una submission e raggiunge una risposta o uno stato di attesa azionabile. Un'Agent session contiene molti turn.
- **Agent session:** vita dell'agente e del suo contesto conversazionale. Non coincide con il processo shell o con un singolo PTY output.
- **Agent completion notification:** segnale normalizzato che un turn ha raggiunto un confine stabile di attesa. Non è un `terminal-exited`, non è la chiusura della PTY e non contiene automaticamente il risultato.

Il backend `agent_events.rs` valida protocollo 1, limita il payload, deduplica gli eventi e verifica l'esistenza della sessione terminale prima di emettere `agent-turn-completed`. `AgentCompletionListener` correla terminale/workspace, aggiorna l'attenzione e mostra toast/overlay. `AgentTurnCompleted` porta provider, terminal ID, workspace ID opzionale, provider session/turn ID opzionali, cwd, timestamp ed event ID.

Questo è un seam importante: Jarvis può usare la completion notification per invalidare cache e avviare una lettura strutturata, ma non deve chiamarla “risultato agent”. Oggi `terminalStore` conserva solo metadati dell'evento; messaggi, tool call, diff e ultimo risultato devono arrivare da adapter strutturati oppure da fallback PTY esplicitamente marcato come non affidabile.

### Agent metadata e lancio

`src/lib/agents.ts` e `src-tauri/src/agent/registry.rs` espongono definizioni statiche (Codex, OpenCode, Claude, Pi, Cline/Cmdc, Anti-Gravity, Freebuff e simili): comando, argomenti, icona e colore. Non esiste ancora nel registry backend una live session registry.

`src/lib/agentLauncher.ts` serializza il lancio con massimo due comandi concorrenti, un ritardo iniziale di un secondo e due secondi tra invii. Scrive il comando nella PTY con `terminal_write`. Questo basta per una launch queue visibile, non per gestire session ID provider, resume, permission request o messaggi.

Le integrazioni in `scripts/agent-notifications/` già inoltrano completion event da Codex, OpenCode e altri harness tramite un bridge PowerShell best-effort. Il README e gli script documentano il contratto, ma il payload resta una notifica normalizzata senza transcript. Il test dello smoke path è Windows-only e non viene dichiarato eseguito sulla VPS Linux.

## Primitive candidate per Jarvis

### Riutilizzabili quasi direttamente

- `get_workspaces`, `get_workspace`, `activeWorkspaceId` e `select_folder` per identificazione/attivazione workspace;
- `terminal_spawn`, `terminal_write`, `terminal_kill`, `terminal_reopen`, `terminal_get_context`, snapshot, screen text e scrollback;
- `workspaceStore`, `terminalStore`, `projectStore` e i loro revisioni/eventi come sorgenti locali;
- `project_git_status`, `project_git_diff`, directory listing, file read e file watcher;
- `agent-turn-completed`, `terminal-output`, `terminal-exited`, `terminal-cwd-changed`;
- le definizioni statiche degli agent e la launch queue, come metadata e seam di compatibilità.

### Primitive backend mancanti

1. Registry persistente di `AgentSession` con provider session ID, provider turn ID, terminal ID, workspace ID, stato, obiettivo, timestamp e relazione di parent/follow-up.
2. Adapter strutturati con eventi typed, messaggi, tool call, permission request, cancellazione, resume e ultimo risultato.
3. `JarvisContextBroker` con package versionato, provenance, cache per workspace e redazione.
4. Tool registry con allowlist, policy read-only/operational/destructive, conferma e audit.
5. Un percorso di lettura dei risultati che non dipenda da scraping del terminale quando l'adapter ufficiale è disponibile.
6. Eventi distinti per turn started, item/message delta, permission pending, turn completed, failed, aborted e session closed; l'evento completion corrente non copre tutti questi stati.
7. Persistenza separata per summary e attività delegate, senza mettere transcript arbitrari nella configurazione workspace.

## Adapter agent

### Contratto comune proposto

L'unità di correlazione interna è una `AgentSessionRef` composta almeno da `agentSessionId`, `provider`, `workspaceId`, `terminalId?`, `providerSessionId?` e `providerTurnId?`. Gli adapter devono mantenere la distinzione Agent turn/Agent session/Agent completion notification.

`StructuredAgentAdapter` dovrebbe esporre `start`, `list`, `getStatus`, `getMessages`, `getLastResult`, `sendMessage`, `resume`, `abort`, `close` e uno stream di eventi typed. `TerminalAgentAdapter` dovrebbe esporre gli stessi intenti, ma implementare il minimo tramite `terminal_write`, output delta e notifiche/euristiche; ogni risultato deve dichiarare la propria confidence e provenance.

Il terminal scraping è un fallback per agenti CLI senza protocollo. Non deve essere il fondamento, perché ANSI, alternate screen, output interleaved, prompt personalizzati e scrollback troncato non costituiscono un protocollo di messaggi.

### OpenCode

**Fatti osservati nel commit `def7220bfc65b84046e597e9be772eae81f663ff`, branch `dev`:**

- `opencode serve` avvia un server HTTP headless con OpenAPI; la documentazione ufficiale indica bind predefinito a `127.0.0.1`, porta 4096, health, sessioni, messaggi, file, diff, abort, permission e SSE/global events.
- Il server pubblica la specifica OpenAPI (`/doc`) e la superficie SDK è generata dalla specifica. Nel repository sono presenti client/protocol packages TypeScript e route/session/message/event/permission.
- La sessione è persistente e identificata; esistono creazione, elenco, lettura, messaggi sincroni, `prompt_async`, attesa, stato, abort e permission reply. Il preciso nome dei metodi può cambiare tra v1/v2: l'adapter deve interrogare la specifica della versione installata.
- Il server/TUI possono essere separati oppure condividere un backend. Il server usa una directory/location esplicita per progetto; la directory deve essere confrontata con `workspace.rootPath` prima di qualsiasi tool call.
- Basic auth e password server sono supportate. Nessuna password o token viene copiata nella documentazione o ricavata da file locali.

**Raccomandazione:** `OpenCodeStructuredAgentAdapter` deve collegarsi a un server locale OpenCode attraverso il client/spec generato della versione installata, preferendo una connessione al backend già usato dalla TUI quando la discovery e il consenso dell'utente lo rendono deterministico. Se non esiste un server identificabile, una modalità gestita da Traflix può avviare `opencode serve` su localhost con lifecycle posseduto da Traflix. La TUI visibile resta una superficie umana, non la fonte di transcript.

Confronto operativo:

| Opzione | Vantaggio | Rischio | Giudizio |
|---|---|---|---|
| Server OpenCode controllato da Traflix | lifecycle e progetto deterministici | processo addizionale, compatibilità, auth/discovery | fallback strutturato |
| Server usato dalla TUI | conserva sessioni e stato già aperti | ownership e discovery possono essere ambigui | preferito se esplicitamente collegabile |
| SDK diretto | tipi, OpenAPI, messaggi ed eventi | SDK/versione devono corrispondere al server | adapter principale |
| TUI visibile + scraping | feedback umano e compatibilità ampia | non è protocollo, alternate-screen e parsing fragile | fallback soltanto |

### Codex

**Fatti osservati nel commit `57f42a81131ccf5933e7ec5dc659c381eeb5d72b`, branch `main`:** `codex app-server` è un protocollo JSON-RPC 2.0 bidirezionale usato da superfici ricche. Supporta stdio JSONL come trasporto predefinito, websocket sperimentale e unix socket locale; genera schema TypeScript/JSON versionati dal binario. Le primitive sono Thread, Turn e Item.

Il percorso typed è `initialize`/`initialized`, `thread/start` o `thread/resume`, `thread/list`/`thread/read`/`thread/fork`, poi `turn/start`. Gli eventi includono `turn/started`, `item/started`, delta di messaggi/strumenti, `item/completed` e `turn/completed`; il turno può essere interrotto con `turn/interrupt` o indirizzato con `turn/steer`. Approvals arrivano come server request JSON-RPC e devono essere risposte dal client con decisione esplicita. `cwd`, modello, sandbox e policy di approval sono input del thread/turn.

`codex exec` è una esecuzione one-shot, MCP è il protocollo/tool surface per server esterni e la TUI è un client: nessuno dei tre sostituisce l'app-server per una sessione viva con eventi. `codex app-server` è quindi l'opzione primaria per `CodexStructuredAgentAdapter`, con schema generato dal binario effettivamente installato e senza estrazione o riuso manuale di token OAuth. L'autenticazione rimane responsabilità del client ufficiale/configurazione Codex.

Limite importante: il protocollo upstream è in evoluzione. L'adapter deve fare capability negotiation, rifiutare metodi non supportati e registrare solo metadata non sensibili. Un processo app-server per workspace o una connessione chiaramente associata a `workspaceId` è preferibile a un canale globale ambiguo.

### Agenti terminal-only

Per Claude Code e agenti CLI privi di adapter strutturato:

1. associare il terminal ID e il workspace ID alla `AgentSession` prima dell'invio;
2. inviare il prompt con `terminal_write` e bracketed paste;
3. ascoltare output delta con sequenza, mantenendo un ring buffer limitato;
4. normalizzare ANSI/VT100 solo per estrarre testo, conservando la provenance raw/non-trusted;
5. usare l'Agent completion notification quando presente;
6. riconoscere waiting state soltanto come euristica con confidence bassa;
7. distinguere timeout, `terminal-exited`, cancellazione e completion;
8. limitare i risultati alla finestra di scrollback disponibile e dichiarare quando una TUI alternate-screen rende il dato incompleto.

La cancellazione deve essere un comando esplicito e confermato: prima interrupt/abort dell'harness se disponibile, poi eventuale `terminal_kill` come operazione distinta. Un timeout non autorizza implicitamente a uccidere la PTY.

## Context Broker

Il modulo proposto `JarvisContextBroker` costruisce un Context Package per ogni invocazione:

- contesto stabile: workspace ID/nome/root, repository root, stack, manifest, `AGENTS.md`, `CONTEXT.md`, README, ADR, struttura e regole;
- contesto fresco: workspace attiva, branch/commit/status/diff/file modificati, terminali e cwd, agenti per stato, completion recenti, errori e permission pendenti;
- contesto sessione: agent session ID, provider, workspace/terminal, stato, obiettivo, messaggi, tool call, file modificati, ultimo risultato, summary e timestamp;
- retrieval mirato: file, simboli, sessioni, decisioni e attività correlate alla richiesta;
- provenance e freshness per ogni blocco.

La prima invocazione fa inventario e summary per la workspace. Le successive usano cache per workspace e invalidano per Git SHA, revisioni/file watcher, sequenze terminal, completion event e agent session ID. File tree, Git, ripgrep/symbol search e summary deterministici sono sufficienti per l'MVP; non si introduce automaticamente un vector database.

Il package non fonde workspace diverse senza target esplicito. `.env` e file di credenziali sono sempre esclusi; i dati letti dal repository o dagli agenti sono input non fidati e possono contenere prompt injection.

La definizione completa è in [`CONTEXT-BROKER.md`](./CONTEXT-BROKER.md).

## Pipeline vocale

La pipeline futura è:

`Microfono → STT → normalizzazione trascrizione → Context Package → LLM/tool loop → risposta → TTS`

Per il primo MVP documentale la scelta più prudente è push-to-talk, italiano dichiarato, cancellazione esplicita, timeout per ogni segmento e provider sostituibili. Groq documenta `whisper-large-v3-turbo` come modello multilingue rapido e `whisper-large-v3` come variante più orientata alla precisione; i prezzi pubblicati al giorno dell'analisi sono indicativi e non autorizzano benchmark a pagamento. Edge TTS può essere valutato come baseline gratuita, ma non va trattato come interfaccia stabile o locale senza verificare dipendenze, disponibilità e policy.

Non è stata integrata voce, STT o TTS.

## Sicurezza e limiti

- allowlist di tool e schema validation prima di ogni invocazione;
- livelli `read-only`, `operational`, `destructive`;
- conferma obbligatoria per abort, kill, close, permission reply e qualsiasi modifica;
- audit log con request ID, workspace ID, tool, esito e durata, mai con secret/raw prompt non necessari;
- limiti su numero di tool call, bytes, durata, profondità di delega e sessioni concorrenti;
- guardia che ogni path sia sotto la root della workspace richiesta;
- binding localhost per server locali e auth gestita dal client ufficiale;
- cancellazione propagata dal widget a STT, LLM loop, adapter e tool;
- redazione di `.env`, `.env.*`, chiavi, token e pattern credenziali;
- testo di file, terminali e agent output sempre marcato come non fidato;
- nessuna fiducia automatica nel testo prodotto da un agent e nessuna autorizzazione implicita da una frase nel repository.

Il desktop Windows, la named pipe, ConPTY e la GUI non sono stati validati dalla VPS Linux. Qualunque conclusione su quel percorso resta “da verificare su Windows”.

## Fonti e artefatti upstream

Data di analisi di tutti gli upstream: 2026-08-06.

| Repository | URL | Branch | Commit analizzato | Licenza | Componenti consultati |
|---|---|---|---|---|---|
| Codex | [openai/codex](https://github.com/openai/codex) | `main` | [`57f42a8`](https://github.com/openai/codex/tree/57f42a81131ccf5933e7ec5dc659c381eeb5d72b) | Apache-2.0 (`LICENSE`) | `codex-rs/app-server/README.md`, `app-server-client`, `app-server-protocol`, test client |
| OpenCode | [anomalyco/opencode](https://github.com/anomalyco/opencode) | `dev` | [`def7220`](https://github.com/anomalyco/opencode/tree/def7220bfc65b84046e597e9be772eae81f663ff) | MIT (`LICENSE`) | `packages/cli` serve/daemon, `packages/server`, `packages/protocol`, SDK/client, event/permission/session routes |
| Matt Pocock skills | [mattpocock/skills](https://github.com/mattpocock/skills) | `main` | [`6acc160`](https://github.com/mattpocock/skills/tree/6acc160e4e0cd062dbbbd7a1b26ae92855edf07e) | MIT (`LICENSE`) | skill `wayfinder`, `grill-with-docs`, `domain-modeling`, `codebase-design`, `research`, `prototype` |

Fonti documentali ufficiali consultate:

- [Codex app-server README](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/app-server/README.md)
- [Codex MCP interface](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/docs/codex_mcp_interface.md)
- [OpenCode server](https://opencode.ai/docs/server/)
- [OpenCode permissions](https://opencode.ai/docs/permissions)
- [OpenCode Zen models](https://opencode.ai/docs/zen)
- [Groq Speech to Text](https://console.groq.com/docs/speech-to-text)
- [Groq Whisper Large V3 Turbo](https://console.groq.com/docs/model/whisper-large-v3-turbo)

Le directory clonate restano esterne a Traflix in `../traflix-space-jarvis-research/` e non sono state copiate nel repository.
