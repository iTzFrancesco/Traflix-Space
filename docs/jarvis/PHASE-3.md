# Traflix Jarvis — Fase 3

## Vertical slice

La Fase 3 aggiunge una shell globale visibile, un registry live read-only delle
Agent session e lo schema persistente per i motori vocali. Jarvis non è un
nuovo agent harness: il percorso principale resta
`Jarvis → TerminalManager/PTTY → CLI originale dell’agente`.

Non sono stati collegati LLM, STT, TTS, Gemini Live, Groq, Codex app-server,
OpenCode server o provider esterni.

## Architettura implementata

- `AgentSessionRegistry` è posseduto da `JarvisState` in Rust ed è in memoria.
- `LiveAgentContextSource` implementa il seam `AgentContextSource` usando
  esclusivamente snapshot del `TerminalManager` e notifiche di completion.
- L’identità di una sessione è stabile per la vita del processo ed è composta
  da `terminalId + generation`. Una riapertura/rilancio dello stesso terminale
  riceve una nuova generation.
- `provider`, `providerSessionId` e `providerTurnId` sono metadata opzionali;
  non sono necessari per creare o correlare una sessione.
- Il Context Broker continua a essere l’autorità Rust per policy, cache,
  provenance e isolamento workspace. Il widget richiede soltanto
  `ModelContextView` a profondità `summary`.
- Il frontend usa `src/stores/jarvisStore.ts` per lo stato volatile e carica i
  campi persistenti tramite `get_settings`/`set_settings`. Non duplica la
  workspace attiva o il registry nel client.

## Registry e lifecycle

Un terminale configurato con `agent_id` crea una sessione `starting`/`working`;
una shell normale non crea sessioni. L’input verso quel terminale porta la
sessione a `working`. Una completion deduplicata aggiorna turn, notification e
risultato, portando la sessione a `waiting`: la completion non chiude la
sessione. Un nuovo input la riporta a `working`, mentre l’uscita del processo
porta a `exited`.

`agent.list` e il build del contesto riconciliano tutti gli snapshot agent del
`TerminalManager`, aggiungendo i terminali vivi mancanti e marcando exited
quelli non più vivi senza mescolare workspace.

## Terminal fallback

Quando una completion appartiene a un terminale locale, il registry acquisisce
lo screen text normalizzato già disponibile nel backend, senza introdurre un
parser ANSI separato. Il risultato è limitato a 32 KiB, normalizza i line
ending, rimuove le righe vuote finali e marca:

- `provenance.source = terminal-fallback`;
- `provenance.untrusted = true`;
- confidence ridotta (`0.35`);
- warning `Result captured from terminal fallback; structured messages unavailable`.

Se il testo non è disponibile, resta la completion notification e l’output è
`completion observed, result unavailable`. `agent.get_messages` segnala
capability unavailable: il terminale non viene trasformato in una falsa
conversazione strutturata.

## IPC e frontend

Restano read-only gli IPC `jarvis_workspace_list`, `jarvis_terminal_list`,
`jarvis_agent_list`, `jarvis_agent_get_status`,
`jarvis_agent_get_last_result`, `jarvis_agent_get_messages`,
`jarvis_build_context`, `jarvis_refresh_context`,
`jarvis_build_model_context` e `jarvis_refresh_model_context`.

`JarvisGlobalOverlay` è montato una sola volta in `App.tsx`, sopra la superficie
applicativa e fuori da `WorkspaceView`. Il widget resta montato durante il
cambio workspace; il target dei build è comunque catturato dal client IPC e il
backend risolve la workspace dal registry.

La modalità compatta mostra orb, stato, mute, settings, expand e chiusura. La
X disabilita Jarvis e la sidebar lo riapre senza creare una seconda istanza.
La posizione è globale, normalizzata rispetto al viewport, limitata ai bordi e
salvata soltanto a fine drag. Il resize ricolloca il widget nel viewport e la
posizione può essere ripristinata dalle impostazioni.

Il pannello espanso mostra workspace attiva, stato/cache del Context Broker,
conteggi working/waiting, sessioni della workspace, sessioni in altre
workspace, provider metadata, terminale, turn, completion, provenance, warning
e ultimo risultato bounded. Selezionare una sessione è solo una lettura; il
pulsante terminale porta alla workspace/terminale già esistente.

## Impostazioni vocali

`AppSettings.jarvis` è retrocompatibile e include:

- selettore `standard` / `gemini_live`;
- enabled, muted e wake-word futuro;
- posizione widget normalizzata;
- campi preparatori Standard Voice Pipeline;
- campi preparatori Gemini Live.

Le card indicano esplicitamente che le integrazioni voce non sono collegate.
Non esistono campi API key, discovery, richieste di rete o stato di provider
connesso.

## Test e verifiche

Il core Rust ha test per creazione/isolamento/generation, lifecycle, dedupe,
fallback bounded e untrusted, capability messages unavailable e registry
provider-agnostic. I test Fase 2 del Context Broker restano verdi.

Verifiche eseguite nel worktree:

- `cargo fmt --all -- --check` — passato;
- `cargo check --lib --target-dir /var/tmp/traflix-jarvis-phase3-target -j 2` — passato;
- `cargo test --lib jarvis --target-dir /var/tmp/traflix-jarvis-phase3-target -j 2` — 30 passati;
- `./node_modules/.bin/tsc --noEmit` — passato;
- `git diff --check` — passato.

Il check Rust Linux emette warning per il listener named-pipe Windows non
utilizzato su Linux; non rappresentano una verifica del percorso Windows.

## Limiti Windows

Da questa VPS Linux non sono verificati ConPTY reale, named pipe Windows,
WebView2, DPI, drag con resize reale, multi-monitor, lifecycle tray o
packaging MSI. Sono inoltre da validare su Windows i dettagli visuali e di
pointer capture del widget.

## Fuori scope

Restano fuori scope microfono, wake word reale, audio recording, STT, TTS,
Gemini WebSocket, Groq, Edge TTS, LLM, tool calling, prompt composer, invio
messaggi, spawn, abort, close, kill, adapter strutturati Codex/OpenCode,
transcript persistenti e vector database.
