# Codex App Server — integrazione Jarvis (architettura)

Stato: **implementata (C1–C10)**. Jarvis parla con **Codex App Server** (`codex.exe app-server`,
auth ChatGPT, modello `gpt-5.6-luna`, reasoning `low`) come unico LLM. Il gateway HTTP legacy
OpenCode Zen è stato **rimosso** (C10): nessuna API key, nessun endpoint HTTP.

## Flusso end-to-end

```
Utente (voce/testo)
  → jarvis_chat (chat.rs run_chat)
    → CodexAppServerProvider::complete (model.rs, C10)
      → ThreadRegistry.ensure_thread(workspace)      (C4: thread effimero per workspace)
      → register_chat_waiter(thread_id)              (oneshot, C10)
      → turn/start (input: [{type:"text",text}], effort: low)
        → il modello ragiona; chiama i dynamic tools:
            workspace.* / terminal.* / agent.* / markdown.* / ui.*  (C5, read-only)
            conversational.plan                          (C6, unico side-effect per turno)
        → il bridge (account.rs) risponde alle server request con i receipt
      → turn/completed → il bridge completa il waiter col testo dell'ultimo
        AgentMessageThreadItem → ModelCompletion (risposta finale)
```

Il bridge (C7) inoltra `item/*`, `AgentMessageDelta`, `turn/*` alla UI come
`jarvis://chat-stream` (commentary progressivi, tool lifecycle, final). Il TTS
progressivo (C8) parla i commentary completati. `turn/steer` e `turn/interrupt`
(C9) indirizzano/cancellano il turno attivo; l'interrupt cancella anche il plan
in esecuzione al checkpoint successivo. **`jarvis_cancel_chat` inoltra a sua
volta `turn/interrupt`** (spec §18): il token locale e il turno server vengono
fermati insieme (best-effort, idempotente).

## Niente loop in `run_chat` (spec §27)

Il vecchio `for round in 0..MAX_TOOL_ROUNDS` è stato **rimosso**: il provider
Codex esegue `turn/start` una volta e il server tiene vivo il turno (i tool
arrivano come server request `item/tool/call` e vengono risposti dal bridge).
`run_chat` ora è: validate → context → checkpoint → `complete()` → response.
Le regole permanenti di Jarvis vivono in `codex-home/AGENTS.md` (spec §10,
scritto all'avvio del runtime), non più nel `system_prompt()` per-turno.

## Sicurezza (spec §5, §13, §25)

- Thread con `cwd` isolato (`<app-data>/codex-home`), `sandbox: read-only`,
  `approvalPolicy: never`, `ephemeral: true` (correzione #4).
- La repo reale non è mai una root leggibile: ogni fatto arriva via dynamic
  tools, ogni mutazione via `conversational.plan` (max 1 per turno, guard
  TurnSafetyState).
- `reasoning` non viene mai inoltrato alla UI; i payload streaming non
  contengono credenziali; `conversational.plan` risponde con il receipt nello
  stesso turno.
- Steer limitato a 240 char; testo di steer non fidato (mai autorizzazioni).

## Moduli

| Modulo | Chunk | Ruolo |
|---|---|---|
| `codex/runtime.rs` | C1 | process lifecycle, handshake JSON-RPC, restart |
| `codex/rpc.rs` | C1 | client JSON-RPC (request/respond/notify) |
| `codex/account.rs` | C2 | bridge account + approvals + hub eventi |
| `codex/models.rs` | C3 | catalogo modelli + rate limits |
| `codex/threads.rs` | C4/C7/C9/C10 | thread per workspace, request ids, chat waiter, steer/interrupt |
| `codex/tools.rs` | C5/C6/C9 | dynamic tool host, budget, plan guard, cancel plan |
| `codex/events.rs` | C7 | normalizzazione chat-stream |
| `model.rs` | C10 | `CodexAppServerProvider` (trait `JarvisModelProvider`) |

## Test

- Unit/portable: `cargo test` (200 test — nessun codicex.exe richiesto).
- Reale (solo Windows, `#[ignore]`): `spawns_real_app_server_and_handshakes`
  in `codex/runtime.rs` — handshake, account, modelli, thread effimero, turno
  con `agent.list`, turno con `conversational.plan`, turno con streaming
  events; gira con `cargo test -- --ignored spawns_real`.
