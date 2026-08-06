# Traflix Jarvis — Fase 2

## Architettura implementata

Il vertical slice usa Rust/Tauri come autorità del Context Broker. `ContextBroker` è un modulo profondo: riceve un `InvocationBinding`, risolve la raccolta documentale bounded, aggiorna la cache per workspace, interroga un `AgentContextSource` e produce `ContextPackageV1`.

Il seam `AgentContextSource` separa il broker dai provider. Il runtime contiene soltanto una sorgente vuota; `FakeAgentContextSource` è compilato esclusivamente nei test. Non sono presenti adapter Codex/OpenCode reali e non esiste un sidecar.

Il client React/TypeScript in `src/lib/jarvis/` espone funzioni IPC typed e cattura `activeWorkspaceId` tramite selector Zustand imperativo. Non sono stati aggiunti componenti React o stato Jarvis in Zustand.

## File

Rust:

- `src-tauri/src/jarvis/types.rs` — tipi serializzabili versionati, provenance, tool envelope ed error envelope.
- `src-tauri/src/jarvis/documentation.rs` — collector Markdown con canonicalizzazione, denylist, symlink/path guard, limiti, timeout e cancellation token.
- `src-tauri/src/jarvis/cache.rs` — cache volatile `HashMap<workspaceId, ...>` con hit, miss, invalidazione root e refresh incrementale.
- `src-tauri/src/jarvis/agent_adapter.rs` — trait `AgentContextSource`, sorgente vuota runtime e fake test-only.
- `src-tauri/src/jarvis/context_broker.rs` — costruzione di `ContextPackageV1`, profondità e warning parziali.
- `src-tauri/src/jarvis/tools.rs` — servizio read-only, correlazione workspace/terminal/session e lista terminali live.
- `src-tauri/src/jarvis/commands.rs` — adapter IPC Tauri read-only.
- `src-tauri/src/jarvis/tests.rs` — fixture temporanee sintetiche per collector, cache, isolamento e fake adapter.
- `src-tauri/src/lib.rs`, `src-tauri/src/main.rs` — registrazione del modulo, stato applicativo e comandi.

TypeScript:

- `src/lib/jarvis/types.ts` — mirror typed dei contratti IPC.
- `src/lib/jarvis/client.ts` — wrapper per workspace, terminali, Agent session, risultati e context build/refresh.

Documentazione:

- `docs/jarvis/OWNER-DECISIONS.md` — decisioni owner consolidate.
- `docs/jarvis/PHASE-2.md` — questo riepilogo.

## Schema e profondità

`ContextPackageV1` contiene `packageVersion`, `invocation`, `documentation`, `terminals`, `agentSessions`, `requestedDepth` e `warnings`. `requestedDepth` è `summary`, `last_result` oppure `full_messages`.

`DocumentationContext` contiene workspace/root, timestamp, revision, cache status, documenti Markdown bounded, omissioni e warning. Ogni documento include path relativo, metadata, hash, contenuto, `truncated` e `untrusted`.

`AgentSessionContext` distingue Agent session, Agent turn e completion notification. `last_result` non carica i messaggi; `full_messages` è interrogato soltanto dal tool esplicito.

## Policy e limiti

Il collector legge solo file con estensione `.md`, esclude `.env`/`.env.*`, file credential-like e directory di dipendenze, output e cache. I path vengono canonicalizzati e i symlink fuori root sono omessi. I default sono 256 documenti, 64 KiB per documento, 2 MiB totali, profondità 16 e timeout 5 secondi.

La cache rileva modifiche tramite metadata e riusa contenuti non cambiati; rilegge solo file nuovi o modificati. Cambio root o `context.refresh` invalida la voce workspace. Errori di sorgenti agent producono package parziale con warning; non vengono registrati payload raw nei log.

## Test

Sono stati scritti test unitari Rust per i casi obbligatori: Markdown consentito, esclusione codice/.env/directory, traversal, symlink escape, limiti, cache hit e refresh incrementale, isolamento workspace, binding immutabile, fake sessioni/turn, completion senza risultato, separazione ultimo risultato/transcript, prompt injection non fidata, errori parziali, determinismo e assenza di mutazioni.

La VPS non dispone di `cargo`, `rustc` o `rustfmt`; quindi i test Rust non sono stati eseguiti e non sono dichiarati superati. Anche il TypeScript compiler del progetto non è installato localmente. `git diff --check` resta il controllo statico disponibile.

## Windows e fuori scope

Restano da verificare su Windows Tauri IPC reale, app-data registry, ConPTY, terminali live, named pipe degli agent, packaging MSI e integrazione con eventuali provider locali. La VPS Linux non dimostra questi comportamenti.

Sono fuori scope widget, voce, wake word, STT/TTS, LLM, vector database, provider reali Codex/OpenCode, sidecar, spawn/write/abort/close/kill, delega, modifica file e qualsiasi tool mutativo.
