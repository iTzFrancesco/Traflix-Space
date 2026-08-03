# Traflix agent notification adapters

Traflix Space listens on the Windows named pipe configured in
`TRAFLIX_AGENT_EVENT_PIPE`. Every Traflix-managed PTY receives:

- `TRAFLIX_TERMINAL_ID`
- `TRAFLIX_AGENT_EVENT_PIPE`
- `TRAFLIX_AGENT_EVENT_PROTOCOL=1`

The bridge is [`traflix-agent-event.ps1`](./traflix-agent-event.ps1). It is
best-effort: if Traflix is closed or the pipe is unavailable, it exits without
blocking or changing the agent result.

## Setup rules

1. Copy the bridge to a stable absolute path.
2. Set `TRAFLIX_AGENT_EVENT_BRIDGE` to that path in the environment inherited
   by the relevant agent, or replace the path in the provider configuration.
3. Add only the provider adapter you want; existing user configuration is not
   overwritten automatically.
4. Start Traflix before running an agent from a Traflix terminal.

## Codex

Merge [`codex-config.toml.example`](./codex-config.toml.example) into the
user-level Codex config. Codex's project-local configuration cannot override
the external `notify` command.

## OpenCode

Install [`opencode-traflix-plugin.ts`](./opencode-traflix-plugin.ts) in an
OpenCode plugin directory. It forwards only a real `busy/retry -> idle`
transition (the initial idle state is ignored) and runs detached.

## Pi

Install [`pi-traflix-extension.ts`](./pi-traflix-extension.ts) as a Pi
extension. It uses `agent_settled`, which avoids notifying during automatic
retry/compaction/follow-up work.

## Claude Code

Merge the `Notification` block from [`claude-hooks.json`](./claude-hooks.json)
into the desired Claude settings or plugin hook file. The `idle_prompt`
notification is side-effect-only and cannot block Claude.

## Manual smoke event

From a PowerShell process whose environment belongs to a live Traflix terminal:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\agent-notifications\traflix-agent-event.ps1 `
  -Provider codex `
  -Payload '{"type":"agent-turn-complete","thread-id":"smoke-session","turn-id":"smoke-turn"}'
```

The terminal must still exist in Traflix for the backend to accept the event.
