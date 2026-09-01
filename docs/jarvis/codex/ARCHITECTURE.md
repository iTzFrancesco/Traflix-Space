# Codex App Server Architecture

Jarvis uses the official Codex App Server as its text-model runtime when the
integration is enabled. The HTTP provider previously used by Jarvis is not part
of the current implementation. OpenCode remains available as a terminal agent
where configured by the user.

## End-to-end flow

```text
User text or voice input
  → jarvis_chat
  → CodexAppServerProvider
  → workspace-bound ephemeral thread
  → turn/start
  → read-only dynamic tools or one validated conversational plan
  → turn/completed
  → Jarvis response and UI stream
```

The provider owns one live Codex runtime for the application session. The
thread registry binds ephemeral Codex threads to workspaces and correlates
server requests with the originating turn.

## Components

| Component | Responsibility |
| --- | --- |
| `codex/runtime.rs` | Process lifecycle, handshake, crash detection, and bounded restart |
| `codex/rpc.rs` | JSON-RPC request, response, and notification transport |
| `codex/account.rs` | Token-free account view, login forwarding, and event routing |
| `codex/models.rs` | Model catalog, usage, and rate-limit snapshots |
| `codex/threads.rs` | Workspace/thread binding, turn correlation, interruption, and steering |
| `codex/tools.rs` | Dynamic tool host, budgets, plan guard, and cancellation |
| `codex/events.rs` | Stream-event normalization for the frontend |
| `jarvis/model.rs` | `JarvisModelProvider` implementation backed by Codex App Server |

## Safety boundaries

- Codex runs with a dedicated runtime directory and a read-only sandbox.
- The selected project directory is not exposed as an unrestricted Codex root.
- Dynamic tools are allow-listed, workspace-scoped, and size-bounded.
- Operational effects require a typed plan validated by Rust.
- Only one side-effect plan is accepted per turn.
- Workspace IDs, terminal IDs, agent-session IDs, and PTY generations are
  checked before an operation is applied.
- Raw reasoning and secret material are excluded from UI events and speech.

## Voice path

Voice capture is handled locally until an optional Groq Speech-to-Text request
is made. Jarvis sends the resulting text through the same Codex turn path as
typed input. Edge TTS runs through a bounded helper process and can be
cancelled. The helper is built from source for Windows packaging and is not
stored as a repository binary.

## Testing

Portable Rust and frontend tests cover protocol normalization, workspace
binding, plan validation, state transitions, and stream ordering. An ignored
Windows test can exercise a real Codex App Server handshake when the Codex CLI
is installed and authenticated. See [Windows validation](WINDOWS-VALIDATION.md)
for the test commands and limitations.
