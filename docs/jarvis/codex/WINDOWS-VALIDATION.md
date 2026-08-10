# Codex App Server — collaudo su Windows

Questa app è Windows-only; i test `#[ignore]` richiedono `codex.exe` con
sessione ChatGPT attiva. Su VPS/Linux girano solo i test unit portabili.

## Suite portabile (qualsiasi macchina)

```bash
cd src-tauri
cargo test          # 200 test, 1 ignored (il reale)
cargo check         # 0 warning nei moduli jarvis (Linux mostra solo dead-code
                    # di feature Windows-gated: TTS/VAD/playback)
```

Nota: su Linux serve `CARGO_TARGET_DIR` (il `.cargo/config.toml` committato
punta a `D:/rust/target` per la macchina Windows):
`export CARGO_TARGET_DIR=<repo>/src-tauri/target`

## Test reale (Windows, con codex installato e loggato)

```bash
cd src-tauri
cargo test -- --ignored spawns_real_app_server_and_handshakes --nocapture
```

Cosa verifica (in ordine):

1. `resolve_codex_executable()` + handshake `initialize`.
2. `account/read` (profilo ChatGPT) e `model/list` (gpt-5.6-luna presente).
3. `account/rateLimits/read` + `usage/read`; `login/start` + cancel.
4. Thread effimero C4: `thread/start` con sandbox read-only + turno `agent.list`
   (verifica `Item/*` con `dynamicToolCall`).
5. Turno C6: `conversational.plan` forzato dal modello con operazione
   `respond` — args tipizzati, receipt risposto nello stesso turno,
   `turn/completed`.
6. Turni C7: collezione di tutte le notifiche `item/*` / `AgentMessageDelta`
   / `turn/*` → passate al normalizer di produzione
   (`stream_events_from_notification`): ordine `tool_started` presente,
   `tool_completed <= tool_starts`, ultimo turno termina con `TurnCompleted`.
   I payload grezzi sono stampati con `println!` per l'ispezione.

## Checklist manuale (app avviata, runtime Codex running)

- [ ] Chat vocale: la richiesta parte come `turn/start` sul thread della
      workspace attiva (log `codex chat provider: turn started`).
- [ ] Commentary visibili in Streaming Codex (Impostazioni → Avanzate) mentre
      il turno è attivo; il final è evidenziato dopo `turn/completed`.
- [ ] "Parla commentary" (C8): i message completati vengono parlati in coda
      senza sovrapporre la risposta finale; il barge-in (voce utente) svuota
      la coda.
- [ ] ⏹ Interrompi (C9): ferma il turno; se un plan è in esecuzione si ferma
      al checkpoint successivo (nessuna mutazione dopo lo stop).
- [ ] Steer (C9): visibile solo con turno attivo; errore su thread idle.
- [ ] Settings migrati: `modelProvider` salvato come `open_code_zen` si
      rilegge come `codex`; il modello mostrato è `gpt-5.6-luna`.
- [ ] Nessuna richiesta di API key Zen nell'UI (Connessioni: solo Groq).
