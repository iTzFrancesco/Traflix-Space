# Jarvis × Codex App Server — documentazione

La spec master è [APP-SERVER-INTEGRATION.md](APP-SERVER-INTEGRATION.md):
obiettivo, architettura, protocollo e fasi C1–C10 con lo stato di avanzamento
(§30). Questa cartella contiene il dettaglio operativo.

## Indice

| Doc | Contenuto |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architettura finale: flusso chat → turno Codex, moduli, sicurezza, test |
| [PROTOCOL.md](PROTOCOL.md) | Fatti di protocollo verificati: handshake, thread/turni, eventi, server request, forme esatte dei payload |
| [WINDOWS-VALIDATION.md](WINDOWS-VALIDATION.md) | Collaudo su Windows: suite portabile, test reale `#[ignore]`, checklist manuale |

## Mappa spec → docs

- §4–§5 Runtime + isolamento → `ARCHITECTURE.md` (moduli), `PROTOCOL.md` (handshake)
- §6–§7 Auth + modelli → `WINDOWS-VALIDATION.md` (checklist login, modelli)
- §9–§13 Thread, tool dinamici, plan → `PROTOCOL.md`
- §14–§18 Streaming, TTS, steer/cancel → `ARCHITECTURE.md` (flusso), `WINDOWS-VALIDATION.md` (checklist)
- §22 Usage/rate limits → `WINDOWS-VALIDATION.md`
- §31 Test plan → `WINDOWS-VALIDATION.md` (suite + test reale)
