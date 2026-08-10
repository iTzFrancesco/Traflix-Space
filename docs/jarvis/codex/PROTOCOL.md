# Codex App Server — protocollo e comportamento (fatti verificati)

Raccolta dei fatti di protocollo verificati durante C1–C10 (fonte: codice +
test reali su Windows con `codex.exe app-server`).

## Handshake e runtime

- `initialize`/`initialized` all'avvio; versione minima vincolata
  (`MIN_SUPPORTED_CODEX_VERSION`).
- Errori di runtime mappati in `RuntimeError.code()`: `codex_not_installed`,
  `codex_version_mismatch`, `codex_runtime_start_failed`, `codex_runtime_crashed`,
  `codex_rpc_failed`, `codex_environment_error`.

## Thread e turni

- `thread/start` con `cwd` isolato, `sandbox: "read-only"`,
  `approvalPolicy: "never"`, `ephemeral: true`. Un thread per workspace,
  creato lazy al primo turno.
- `turn/start`: `input` è **un array** di UserInput `[{type:"text",text}]`;
  una stringa → `-32600` invalid params. `params` sempre obbligatorio (anche
  `{}`); `effort: "low"` passato sempre esplicitamente.
- `turn/steer`: gated — errore se nessun turno attivo; testo limitato (240 char).
- `turn/interrupt`: idempotente (interrompere un turno già finito è no-op).
- Thread effimeri: `thread/delete` su un thread `ephemeral` è rifiutato dal
  server (V1: la pulizia avviene su Clear Conversation / shutdown pulito).

## Eventi (notifiche)

- `turn/started` → reset budget tool (C5) + guard plan (C6) + reset request id.
- `item/started|completed` con `type`: `dynamicToolCall`, `agentMessage`,
  `reasoning`. `AgentMessageDelta` (delta testo, `content[0].text` o
  `{type:"text_delta"}`) e `AgentMessageThreadItem` (item completo).
- **`AgentMessageDelta` NON ha un campo `phase`** (correzione #4): il final è
  l'ultimo message completato prima di `turn/completed`.
- `reasoning` è sempre ignorato (spec §15): mai inoltrato, mai parlato.
- `turn/completed|failed|interrupted` chiudono il turno; `failed` porta
  `error`; `interrupted` segue `turn/interrupt`.

## Server request (tool dinamici)

- Richieste `{callId, namespace, tool, arguments, threadId, turnId}`:
  `namespace` e `tool` separati. Risposta:
  `{"content":[{"type":"inputText","text":"…"}]}`.
- Richieste non gestite → **sempre** risposta `-32601` method not found (mai
  lasciare il server in attesa).
- Tool read-only: `workspace.overview`, `terminal.list`, `agent.list`,
  `agent.status`, `agent.last_result`, `agent.activity`, `agent.tail`,
  `markdown.read`, `ui.open_terminal`.
- `conversational.plan`: schema condiviso con il path legacy
  (`conversational_plan_schema()` in control.rs), operazioni allowlist:
  respond, clarify, agent_report, agent_send, agent_open, agent_handoff,
  agent_abort, terminal_close, terminal_restart, draft_prompt; campi camelCase
  (`allowBusy`), operazioni snake_case.
  - max 1 plan per turno: secondo plan → `-32003 side_effect_plan_already_executed`;
  - decode fallito → `-32602`; validazione fallita → `-32004 conversational_plan_rejected`;
  - il receipt (`{response, warnings}`) è risposto nello stesso turno;
  - lo slot è consumato anche da tentativi invalidi (scelta conservativa).

## Forma esatta dei payload

La spec ufficiale non documenta ogni forma: il normalizer (`codex/events.rs`)
fa **parse difensivo multi-alias** (`item.id`/`itemId`, `item.type`/`itemType`,
testo da `content[]`/`text`/delta). I payload grezzi dei turni reali vengono
stampati dal test `spawns_real_app_server_and_handshakes` per verifica su
Windows.
