# Traflix Jarvis — opzioni architetturali

## Decisione proposta

La raccomandazione provvisoria è un'architettura ibrida:

- React mantiene widget flottante, menu laterale, transcript, push-to-talk, conferme e stato visuale;
- Rust/Tauri mantiene il confine di sicurezza, `JarvisContextBroker`, tool registry, audit, isolamento workspace, lifecycle dei processi locali e accesso alle primitive PTY/Git/file già esistenti;
- adapter strutturati provider-specifici vivono dietro un seam typed; quando SDK e protocollo lo rendono necessario possono essere supervisionati da un helper TypeScript locale, ma non diventano una seconda autorità di stato;
- OpenCode e Codex restano canali strutturati; terminale/PTY è un adapter fallback e superficie visibile;
- il modello LLM, STT e TTS sono provider-agnostic e configurabili, non hardcoded nel core.

Questa è una raccomandazione di design, non una decisione implementata. La prima Fase 2 dovrebbe validare il seam del broker con fake adapter e tool read-only prima di aggiungere processi provider reali.

## Confronto del core

| Opzione | PTY | Sicurezza | Streaming/processi | Crash isolation | Persistenza | Testabilità | Tauri/Windows | Latenza | Complessità | Giudizio |
|---|---|---|---|---|---|---|---|---|---|---|
| Core nel frontend React | IPC già disponibile ma indiretto | debole: UI e policy si mescolano | hooks difficili da rendere affidabili | bassa | Zustand non è registry agent | media-bassa | packaging semplice | bassa per read | cresce rapidamente | solo presentazione |
| Core nel backend Rust | accesso nativo a PTY, Git e filesystem già esposto | forte, allowlist e path guard centralizzabili | tokio/eventi adatto a stream e processi | media | app-data e registry naturali | alta con fake seam | ottimo per Windows | bassa locale | Rust/provider SDK più onerosi | buona autorità |
| Sidecar TypeScript | IPC/HTTP verso PTY | buono se sandbox e allowlist sono nel backend | SDK OpenCode/Codex più naturali | alta | storage separato da decidere | alta per adapter | lifecycle/packaging più complessi | piccolo overhead | due runtime | buon supporto provider |
| React + Rust + agent server | PTY e policy in Rust, UI in React | forte se server solo localhost e auth gestita | ideale per SSE/JSON-RPC e lifecycle | media-alta | separabile per adapter/summary | alta per seam | coerente con Tauri ma Windows richiede verifica | buona | media-alta | raccomandata |
| Processo locale separato + IPC | backend può controllare PTY o connettersi | forte con IPC autenticato e path guard | isolamento migliore, più processi | alta | esplicita | alta | installer/upgrade/kill più complessi | overhead IPC | alta | evoluzione futura |

“Rust authority” non significa che ogni SDK debba essere riscritto in Rust. Significa che una richiesta del modello passa sempre da un registry e una policy posseduti da Traflix; un adapter TypeScript può essere un’implementazione dietro quel confine.

## Moduli e seam

### `JarvisContextBroker`

Modulo profondo: riceve `InvocationRequest` e produce `ContextPackage` con freshness, provenance, budget e workspace target. Nasconde cache, invalidazione, retrieval Git/file/session e redazione.

### `JarvisToolRegistry`

Espone soltanto tool allowlisted e validati. Ogni tool conosce `workspaceId` e applica la policy prima di delegare a workspace/terminal/agent/context service. L'LLM non chiama direttamente `invoke` Tauri o comandi shell.

### `AgentRegistry` / `AgentSessionRegistry`

Il registry statico esistente (`list_agents`) diventa metadata di capability. Un nuovo registry live separa provider definition da `AgentSession`, Agent turn e Agent completion notification.

### `StructuredAgentAdapter`

Interfaccia comune per OpenCode/Codex:

```text
list(workspaceId?) -> AgentSessionRef[]
start(input) -> AgentSessionRef
getStatus(ref) -> AgentStatus
getMessages(ref, cursor?) -> Page<Message>
getLastResult(ref) -> AgentResult?
sendMessage(ref, prompt, options) -> AgentTurnRef
resume(ref, options) -> AgentSessionRef
abort(ref, turn?) -> AbortReceipt
close(ref) -> CloseReceipt
events(ref/workspace) -> AgentEventStream
```

Il contratto deve dichiarare capability, timeout, provenance e provider version. Un adapter non può fingere di avere messaggi strutturati se dispone soltanto di completion notification.

### `TerminalAgentAdapter`

Adapter di compatibilità per agenti CLI terminal-only:

- `terminalId`, `workspaceId`, provider e session reference;
- prompt via `terminal_write` con bracketed paste;
- output delta sequenziato, snapshot e scrollback limitato;
- normalizzazione ANSI separata dal raw buffer;
- completion notification come segnale, non risultato;
- waiting-state euristico con confidence;
- timeout, cancellation, process exit e alternate-screen warnings.

Il terminal scraping non è il fondamento perché una TUI può ridisegnare lo schermo, troncare scrollback, interleavare tool output o non avere un delimitatore di turn affidabile.

## Adapter OpenCode

OpenCode offre `opencode serve` headless su localhost, OpenAPI, SDK generato, sessioni, messaggi sync/async, attesa/stato, SSE, permission reply, abort, diff e file API. Il server si lega a una directory/location di progetto.

Scelta preferita: collegarsi al server che la TUI usa già quando porta/host, autenticazione, versione e directory sono ottenuti tramite un meccanismo ufficiale e la ownership è chiara. In assenza di una connessione deterministica, Traflix può possedere un server locale per workspace; questa modalità introduce lifecycle, compatibilità e gestione auth da documentare.

Il client deve derivare tipi dalla spec del server in uso, fare health/version check e rifiutare mismatch. La password resta nella configurazione del server/client; non va letta o registrata da Jarvis come testo del contesto.

Confronto:

| Strategia | Punti forti | Punti deboli | Uso previsto |
|---|---|---|---|
| server controllato da Traflix | lifecycle e cwd deterministici | processo e versione da amministrare | fallback strutturato |
| server della TUI | sessioni già aperte e continuità | discovery/ownership/auth | principale quando disponibile |
| SDK diretto | messaggi/status/eventi typed | coupling alla versione OpenCode | implementazione dell'adapter |
| terminale visibile + API | UX umana e canale strutturato | doppia correlazione da gestire | compatibilità, non scraping primario |

Fonte: [OpenCode Server](https://opencode.ai/docs/server/) e snapshot upstream `def7220bfc65b84046e597e9be772eae81f663ff`.

## Adapter Codex

`codex app-server` è la scelta primaria documentata per un'integrazione viva. Il protocollo JSON-RPC bidirezionale espone Thread, Turn e Item; supporta `thread/start`, `thread/list`, `thread/read`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer`, `turn/interrupt`, eventi di lifecycle, delta item e approval request.

Il client deve:

- lanciare o collegarsi all'app-server ufficiale tramite stdio JSONL o altro trasporto supportato;
- eseguire handshake `initialize`/`initialized` e capability negotiation;
- generare/validare tipi dallo stesso binario Codex;
- associare `threadId`/`turnId` a `workspaceId` e terminal ID opzionale;
- propagare approval request alla UI con conferma esplicita;
- usare `turn/completed` come lifecycle provider, distinto da `agent-turn-completed` normalizzato;
- usare `thread/read`/list e summary per risultati recenti;
- lasciare auth e auth refresh al client ufficiale/configurazione Codex.

Non si estraggono token OAuth e non si riutilizzano manualmente. `codex exec`, MCP e TUI hanno scopi diversi: non sostituiscono il protocollo app-server per una Agent session con stream e resume.

Fonte: [Codex app-server README](https://github.com/openai/codex/blob/57f42a81131ccf5933e7ec5dc659c381eeb5d72b/codex-rs/app-server/README.md) e commit `57f42a81131ccf5933e7ec5dc659c381eeb5d72b`.

## Adapter terminal-only

Il fallback invia prompt, ascolta output, normalizza ANSI, calcola delta con watermark, osserva completion notification e gestisce timeout/exit. Deve produrre:

```text
TerminalObservation {
  terminalId, workspaceId, observedAt, sequenceRange
  normalizedText, rawAvailable, waitingHeuristic?
  processAlive, completionEventId?, confidence, warnings[]
}
```

Una cancellation prova prima l'interrupt del provider se disponibile; `terminal_kill` è un'operazione separata, distruttiva e confermata. Alternate-screen, prompt invisibili, output non terminato e scrollback 1000 sono limiti espliciti.

## Context Broker

Il broker è descritto in [`CONTEXT-BROKER.md`](./CONTEXT-BROKER.md). La scelta architetturale è una cache separata per workspace, invalidata da Git SHA/status, file watcher, output sequence, eventi di Agent turn/completion, permission request e session ID. File tree, Git, ripgrep, symbol search e summary deterministici precedono qualunque vector database.

Il package deve includere stable project context, fresh workspace context, Agent session context, retrieval evidence, memory slices, freshness e token budget. Il broker non deve mischiare workspace senza target.

## Provider LLM

L'interfaccia è provider-agnostic:

```text
LlmProvider {
  healthCheck() -> Health
  stream(request) -> AsyncStream<ResponseDelta>
  generateStructured(schema, request) -> StructuredResult
  callTools(request, registry) -> ToolLoop
  summarize(input, budget) -> Summary
  estimateBudget(input) -> BudgetReport
  fallback(reason) -> ProviderSelection
}
```

La strategia a due livelli è coerente con il dominio:

- **Fast router:** mostra/nascondi widget, mute, apri terminale, elenco agenti, cambio workspace, interrupt di una sessione nota. Deve usare classificazione strutturata e contesto minimo, con conferma per operazioni rischiose.
- **Contextual planner:** legge repository, confronta agenti, risolve riferimenti, prepara follow-up, delega e compone piani multi-tool. Riceve Context Package e deve poter interrompere il loop.

Non si hardcoda ancora un modello. `MODEL-EVALUATION.md` registra modelli verificati, campi ancora mancanti e benchmark futuro.

## Tool registry typed

### Convenzioni comuni

Ogni tool riceve `requestId` e, quando applicabile, `workspaceId`, `terminalId` e `agentSessionId`. Output e errori sono serializzabili, con `source`, timestamp e `auditRef`. Timeout sono deadline server-side; l'UI può cancellare prima. `R` = read-only, `O` = operational, `D` = destructive. “Sì” in conferma significa conferma UI esplicita, non approvazione implicita del modello.

| Tool | Input → output | Timeout / errori principali | Idempotenza | Rischio / conferma | Scope |
|---|---|---|---|---|---|
| `workspace.list` | `{}` → workspace summaries | 2s; backend unavailable | sì | R, no | workspace |
| `workspace.get_active` | `{}` → active workspace? | 2s; no active | sì | R, no | active workspace |
| `workspace.activate` | `{workspaceId}` → receipt + active | 3s; unknown/evicted | sì per stesso ID | O, sì se cambia focus | workspace |
| `workspace.get_context` | `{workspaceId}` → stable/fresh summary | 10s; path/Git timeout | sì con revision | R, no | workspace |
| `terminal.list` | `{workspaceId}` → terminal summaries | 3s; unknown workspace | sì | R, no | workspace + terminal |
| `terminal.spawn` | `{workspaceId,shell?,cwd?,agentId?}` → terminal ref | 10s; limit/shell/PTY failure | no, con idempotency key | O, sì | workspace + terminal |
| `terminal.write` | `{workspaceId,terminalId,data,mode}` → receipt | 5s; closed/ownership/size | no; key per retry | O, sì per prompt | workspace + terminal |
| `terminal.read_scrollback` | `{workspaceId,terminalId,offset?,limit?}` → bounded text | 5s; unknown/limit | sì | R, no | workspace + terminal |
| `terminal.close` | `{workspaceId,terminalId,reason}` → close receipt | 10s; already closed/race | sì per terminal state | D, sì sempre | workspace + terminal |
| `agent.list` | `{workspaceId,state?}` → session refs | 3s; adapter unavailable | sì | R, no | workspace + session |
| `agent.spawn` | `{workspaceId,provider,objective,cwd?,terminal?}` → session/turn plan | 15s; capability/limit/auth | no, idempotency key | O, sì | workspace + terminal? + session |
| `agent.send_message` | `{workspaceId,agentSessionId,prompt,delivery?}` → turn ref | 15s enqueue; offline/permission | no | O, sì | workspace + session |
| `agent.get_messages` | `{workspaceId,agentSessionId,cursor?,limit?}` → message page | 8s; provider/session missing | sì | R, no | workspace + session |
| `agent.get_last_result` | `{workspaceId,agentSessionId}` → result summary + evidence | 10s; incomplete/timeout | sì | R, no | workspace + session |
| `agent.get_status` | `{workspaceId,agentSessionId}` → status + pending approval | 5s; stale/provider error | sì | R, no | workspace + session |
| `agent.abort` | `{workspaceId,agentSessionId,turnId?}` → abort receipt | 15s; not running/provider error | sì per turn | D, sì sempre | workspace + session |
| `agent.close` | `{workspaceId,agentSessionId}` → close receipt | 15s; active turn/race | sì per closed | D, sì sempre | workspace + session |
| `context.build` | `{workspaceId,request,profile}` → Context Package | 15s; budget/path/Git | sì per revision+request key | R, no | workspace |
| `context.refresh` | `{workspaceId,parts?,reason}` → invalidation/build receipt | 15s; watcher/Git timeout | sì per revision | R/O, no | workspace |
| `context.search` | `{workspaceId,query,scope,limit}` → evidence refs | 10s; invalid query/path | sì | R, no | workspace |
| `context.summarize` | `{workspaceId,sessionId?/evidence,budget}` → summary | 20s; provider/budget | sì per input hash | R, no | workspace + session? |
| `orchestration.prepare_follow_up` | `{workspaceId,agentSessionId,goal?}` → draft follow-up plan | 20s; missing result/ambiguity | sì per evidence hash | R/O draft, no send | workspace + session |
| `orchestration.delegate` | `{workspaceId,tasks,assignments,dryRun?}` → delegation plan/receipts | 30s; collision/limit | no; task keys | O multi-session, sì | workspace + sessions |
| `orchestration.compare_results` | `{workspaceId,agentSessionIds,criteria?}` → comparison | 25s; result missing/budget | sì per evidence hash | R, no | workspace + sessions |
| `jarvis.widget.show` | `{workspaceId?}` → visibility receipt | 2s; UI unavailable | sì | O, no | global UI + optional workspace |
| `jarvis.widget.hide` | `{}` → visibility receipt | 2s; UI unavailable | sì | O, no | global UI |
| `jarvis.microphone.mute` | `{muted}` → microphone state | 2s; device unavailable | sì | O, no | global UI/audio |
| `jarvis.speech.stop` | `{requestId?}` → cancellation receipt | 2s; already stopped | sì | O, no | global request |

`terminal.write`, `agent.send_message`, `agent.spawn`, `orchestration.delegate` e le conferme devono includere un audit reference e un idempotency key. `workspace.activate` non modifica file, ma è comunque operational perché cambia il target visuale e il contesto successivo.

## Sicurezza del registry

- allowlist statica e schema validation; nessun nome tool arbitrario dal modello;
- policy `read-only`, `operational`, `destructive` verificata nel backend;
- conferma per abort, kill, close, spawn, prompt send, delegate e permission reply secondo policy;
- path guard sotto `workspace.rootPath`, con denylist `.env`/credential e redazione secret;
- massimo tool call per richiesta, profondità di delega, durata totale, bytes letti e sessioni concorrenti;
- audit log append-only con request/tool/workspace/session, decisione, esito e latenza;
- cancellazione a cascata: widget → planner → tool loop → adapter/processo;
- testo di file, messaggi e output agent è prompt injection non fidato;
- server locali bindati a localhost, con discovery/auth ufficiale e niente token copiati nel Context Package;
- nessun `git push` o PR è nel registry della Fase 1; eventuali tool futuri dovrebbero essere deny-by-default.

## Rischi e trade-off

1. **Drift provider:** OpenCode e Codex cambiano schema; servono version/capability checks e adapter versionati.
2. **Correlazione:** `terminalId` e provider session ID non sono equivalenti; il registry deve conservare entrambe le relazioni.
3. **Lifecycle:** l'eviction workspace può uccidere PTY; la promessa “resta attivo al cambio workspace” vale solo per sessioni non evicted e adapter esterni ancora vivi.
4. **TUI:** scraping ANSI non garantisce completezza né semantica di turn.
5. **Windows:** ConPTY, named pipe, PowerShell, tray, overlay e packaging MSI richiedono verifica Windows, non dimostrabile sulla VPS.
6. **LLM:** provider, rate limit, tool calling e italiano sono variabili; il modello non deve essere un vincolo architetturale.
