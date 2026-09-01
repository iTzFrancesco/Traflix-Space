# Traflix Space Documentation

This directory contains maintained technical documentation for the public
Traflix Space source tree. Historical planning notes, local machine reports,
temporary patches, and private validation artifacts are intentionally excluded.

## Jarvis and Codex App Server

- [App Server integration](jarvis/codex/APP-SERVER-INTEGRATION.md) — current
  architecture, lifecycle, safety boundaries, and configuration;
- [Architecture](jarvis/codex/ARCHITECTURE.md) — component responsibilities and
  end-to-end data flow;
- [Protocol](jarvis/codex/PROTOCOL.md) — supported JSON-RPC messages and tool
  contracts;
- [Windows validation](jarvis/codex/WINDOWS-VALIDATION.md) — portable and
  Windows-specific verification;
- [Voice troubleshooting](jarvis/codex/VOICE-TROUBLESHOOTING.md) — safe
  troubleshooting for the optional Groq voice path;
- [Context broker](jarvis/CONTEXT-BROKER.md) — workspace-scoped context and
  bounded retrieval behavior.

## Voice pipeline

- [Voice endpointing](jarvis/VOICE-ENDPOINTING.md) — VAD and end-of-turn
  behavior;
- [Voice latency](jarvis/VOICE-LATENCY.md) — implementation constraints and
  measurement plan;
- [Wake-word MVP](jarvis/WAKE-WORD-MVP.md) — current local fallback and future
  model boundary.

## Scope

The documentation describes the current source tree and its supported local
workflows. Provider terms, model licenses, Windows runtime behavior, and
third-party APIs remain external dependencies and must be checked separately.
