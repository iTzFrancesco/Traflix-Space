# Jarvis and Codex App Server

This directory documents the public integration between Traflix Space and the
Codex App Server. The documents describe the current implementation and the
contracts that must remain stable when the desktop application evolves.

## Documentation map

- [Architecture](ARCHITECTURE.md) — component boundaries and runtime ownership.
- [App Server integration](APP-SERVER-INTEGRATION.md) — implementation lifecycle
  and integration responsibilities.
- [Protocol](PROTOCOL.md) — handshake, turns, notifications, tools, and
  streaming messages.
- [Windows validation](WINDOWS-VALIDATION.md) — portable and live validation
  procedures for the Windows runtime.
- [Context broker](../CONTEXT-BROKER.md) — bounded workspace context assembly.
- [Voice endpointing](../VOICE-ENDPOINTING.md) — capture and submission timing.
- [Voice latency](../VOICE-LATENCY.md) — latency boundaries and measurement.
- [Voice troubleshooting](VOICE-TROUBLESHOOTING.md) — provider and local audio
  diagnostics.
- [Wake-word MVP](../WAKE-WORD-MVP.md) — current activation behavior and future
  extension points.

## Scope

Jarvis uses the Codex App Server as its text-agent runtime. A workspace owns the
conversation thread, while the Rust backend owns process lifecycle, protocol
translation, context boundaries, and Tauri events. The frontend renders the
resulting state and does not receive provider credentials.

The repository intentionally excludes historical planning notes, local
validation logs, generated sidecars, machine-specific paths, and private
research. Use the current source and the documents above as the public contract.
