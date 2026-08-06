# Traflix Jarvis — unico vertical slice per Fase 2

## Scelta

Il solo vertical slice consigliato è:

> **Context Broker minimo + fake agent adapter + tool read-only per workspace, terminali, agenti e ultimi risultati.**

Non include widget, microfono, STT/TTS, LLM reale, OpenCode, Codex, scrittura PTY, abort/kill/close, delega reale o modifica file.

## Obiettivo

Dimostrare che una richiesta testuale indirizzata alla workspace attiva costruisce un Context Package coerente e isolato, interroga un fake `StructuredAgentAdapter`, espone dati workspace/terminali/Agent session/ultimi risultati con provenance e produce un risultato ripetibile senza eseguire azioni operative.

Il vertical slice deve provare la distinzione tra:

- Agent turn e Agent session;
- Agent completion notification e ultimo risultato;
- workspace attiva e workspace target;
- dati strutturati e fallback terminale;
- fatto osservato, summary e ipotesi.

## File probabili da valutare

Questi sono punti di integrazione probabili, non autorizzazione a modificarli in questa Fase 1:

- `src-tauri/src/` per il servizio broker, tipi IPC e registry read-only;
- `src-tauri/src/workspace/registry.rs` e commands esistenti per workspace;
- `src-tauri/src/terminal_engine/commands.rs` per list/context/snapshot/scrollback, evitando nuove azioni operative;
- `src-tauri/src/agent/registry.rs` per metadata statici e un seam fake separato;
- `src-tauri/src/agent_events.rs` per completion notification e invalidazione;
- `src-tauri/src/project/` per Git, directory, file watcher e revisioni;
- `src-tauri/capabilities/default.json` soltanto se il nuovo IPC read-only richiede una capability aggiuntiva;
- `src/components/` o un client IPC minimale per visualizzare il package, senza costruire ancora il widget finale;
- test Rust/unitari e fixture documentali sotto una directory di test dedicata, senza `.env` e senza repository reali.

La collocazione finale Rust/sidecar resta una decisione bloccante: il vertical slice deve preservare un'interfaccia che permetta di spostare l'adapter senza cambiare il tool contract.

## Test richiesti

Test unitari/integration test con fixture sintetiche:

1. una workspace target produce `workspaceId`, root, Git summary e regole canoniche;
2. una workspace diversa non entra nel package senza target esplicito;
3. terminali sono correlati tramite `workspaceId` e `terminalId`;
4. il fake adapter espone due Agent turn nella stessa Agent session;
5. una Agent completion notification senza result non viene trasformata in risultato inventato;
6. `agent.get_last_result` usa struttura fake e provenance;
7. cache hit evita una scansione completa e cache invalidation reagisce a Git SHA/event/session ID;
8. `.env`, `.env.*`, credential-like fixture e token pattern sono esclusi/redatti;
9. file/output contenenti istruzioni malevole restano dati non fidati;
10. budget piccolo produce truncation esplicita e mantiene ID/stato/provenance;
11. schema e error envelope dei tool read-only sono stabili;
12. timeout di una sorgente produce warning e package parziale, senza crash globale.

Non eseguire test o fixture che leggano `.env`, credenziali reali, home directory, cache condivise o repository upstream clonati.

## Verificabile su Linux VPS

- costruzione del package con fake data;
- cache, invalidazione, provenance, redazione e token budgeting;
- unit test di workspace/terminal/session correlation;
- schema validation e tool registry read-only;
- fake event stream e fake Agent completion notification;
- errori, timeout e cancellazione del package in memoria;
- `git diff --check` e controlli che solo documentazione/test fixture siano cambiati.

## Da verificare su Windows

- Tauri IPC e lifecycle della WebviewWindow reale;
- ConPTY, PowerShell, resize, output sequence e alternate-screen;
- named pipe `traflix-space-agent-events` e bridge PowerShell;
- correlazione con agenti realmente lanciati;
- persistenza app-data e comportamento al cambio workspace/eviction LRU;
- tray, focus, overlay e futura posizione del widget flottante;
- permission/capability CSP e packaging MSI;
- dispositivi microfono, push-to-talk, STT/TTS, cancellazione audio;
- processo Codex app-server e OpenCode server sul Windows dell'utente.

La VPS Linux non può dichiarare verificata la GUI Windows o il percorso ConPTY.

## Criteri di completamento

Il vertical slice è completo quando:

- una request fixture produce un Context Package versionato e leggibile;
- ogni dato ha workspace, freshness e provenance;
- il target workspace è verificato e non c'è leakage tra workspace;
- fake adapter e sessioni rispettano Agent turn/Agent session/Agent completion notification;
- tutti i tool read-only concordati hanno input/output/error envelope e audit reference;
- esistono test per cache/invalidation/redaction/budget e passano in ambiente dichiarato;
- nessun provider reale, PTY write o mutazione file è eseguito;
- sono documentati i limiti non verificabili su Linux;
- una review conferma che il seam non obbliga il futuro a terminal scraping.

## Decisioni bloccanti prima di procedere oltre

1. scegliere Rust authority + adapter helper TypeScript oppure adapter Rust/IPC completamente typed;
2. definire la persistenza di cache, summary e audit fuori dalla configurazione workspace;
3. fissare il formato di `AgentSessionRef` e la correlazione provider/terminal;
4. approvare denylist, policy di redazione e retention;
5. selezionare il primo provider LLM soltanto dopo metadata/benchmark, non durante questo slice;
6. decidere come scoprire OpenCode server senza leggere o copiare credenziali;
7. confermare il percorso Windows per il fake event bridge prima di provider reali.

## Stop condition

Dopo questo slice si torna alla ricerca/decisione se il broker non riesce a mantenere isolamento, provenance o lifecycle semantico. Non si aggiungono automaticamente voce, widget, tool operational o adapter upstream finché le decisioni bloccanti non sono approvate.
