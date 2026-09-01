# Jarvis Codex App Server Integration

This document describes the current public integration between Jarvis and the
official Codex App Server runtime. It is an implementation guide, not a record
of historical milestones or private deployment details.

## Scope and prerequisites

The integration is optional. A Windows installation using Jarvis requires:

- the Codex CLI installed and available to Traflix Space;
- an account authenticated through the official Codex login flow;
- a supported Codex App Server runtime that completes the live handshake.

Traflix Space does not ship Codex, does not provide Codex credentials, and does
not copy or persist OAuth tokens. The official runtime owns authentication and
token refresh.

## End-to-end flow

```text
User text or voice input
        │
        ▼
   Jarvis chat command
        │
        ▼
 Codex App Server adapter
        │  initialize / account / model / thread / turn RPCs
        ▼
  One ephemeral thread per workspace
        │
        ├── bounded read-only dynamic tools
        ├── at most one validated conversational plan
        └── normalized stream events
        │
        ├── Jarvis response and optional TTS
        └── frontend activity and status events
```

The Rust backend is the authority for workspace binding, tool dispatch,
terminal identity, side effects, cancellation, and lifecycle. The React layer
renders typed state and events; it does not make authorization decisions.

## Runtime lifecycle

1. The backend resolves the Codex executable and performs an `initialize` /
   `initialized` handshake over standard input and output.
2. A dedicated runtime directory is supplied through `CODEX_HOME`. It keeps
   the application's Codex state separate from the user's normal Codex profile.
3. The backend reads token-free account, model, usage, and rate-limit views.
   Account and authentication material remains inside the official runtime.
4. A workspace-bound, ephemeral thread is created lazily when Jarvis needs to
   send its first turn.
5. `turn/start` receives a typed text-input array. The server may emit tool
   requests and intermediate messages until the turn completes.
6. The backend resolves the final completed agent message and publishes the
   normalized result to Jarvis and the UI.

The runtime has bounded handshake, request, cancellation, restart, and crash
handling. Compatibility is established by the live handshake and supported RPC
responses rather than by assuming a particular CLI version.

## Workspace isolation

Each Jarvis invocation captures a target workspace. The backend verifies the
workspace, terminal, agent-session, and PTY-generation identities before using
them. A display title or provider label is never an authorization key.

The Codex thread is configured with a read-only sandbox and no automatic
approval policy. Project information is supplied through the host's bounded
context and dynamic tools instead of making the user's project directory a
general Codex-readable root. Mutating actions must pass through the typed
`conversational.plan` boundary.

## Dynamic tools

The following tools are exposed as separate namespace and tool names:

- `workspace.overview`;
- `terminal.list`;
- `agent.list`;
- `agent.status`;
- `agent.last_result`;
- `agent.activity`;
- `agent.tail`;
- `markdown.read`;
- `ui.open_terminal`.

These tools are read-only and bounded. They return structured data with the
workspace identity and provenance needed by Jarvis. Terminal output, Markdown,
and agent messages remain untrusted input; text inside them cannot change
policy or grant authorization.

## Conversational plans

`conversational.plan` is the only dynamic tool that can request an operational
effect. The Rust host validates the plan against an allow-list, the active
workspace, terminal and agent ownership, PTY generation, process state, and
the current turn. Supported operations include response, clarification,
agent reporting, opening or sending to an agent, handoff, abort, terminal
close/restart, and draft prompt creation.

At most one plan can be accepted in a turn. Invalid plans consume the turn's
plan slot, which prevents a fallback or retry from silently creating a second
side effect. The host returns a structured receipt and warnings in the same
turn so the model cannot assume that an action succeeded without a result.

## Streaming, speech, and cancellation

Codex notifications are normalized into `jarvis://chat-stream` events. The UI
receives commentary, tool lifecycle, final-message, and turn-completion state;
raw reasoning is not forwarded or spoken.

Completed commentary can be sent to the optional speech queue. Speech is
bounded, deduplicated, cancellable, and kept separate from the final text. A
user cancellation forwards `turn/interrupt` to the server and cancels any
host-side plan at its next checkpoint. Repeated cancellation is safe.

## Credential and data handling

- Codex OAuth tokens are owned by Codex App Server and are not exposed through
  Traflix IPC.
- Groq credentials belong only to the optional voice transcription path and are
  handled by the Rust backend.
- Secrets are not included in dynamic-tool responses, stream events, logs, or
  terminal child environments.
- Workspace context is bounded and selected for the active workspace; the
  application does not automatically submit an entire source tree to Jarvis.

## Related documentation

- [Architecture](ARCHITECTURE.md)
- [Protocol](PROTOCOL.md)
- [Windows validation](WINDOWS-VALIDATION.md)
- [Context broker](../CONTEXT-BROKER.md)
