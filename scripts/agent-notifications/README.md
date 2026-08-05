# Traflix agent notification adapters

Traflix Space listens on the Windows named pipe configured in
`TRAFLIX_AGENT_EVENT_PIPE`. Every Traflix-managed PTY receives:

- `TRAFLIX_TERMINAL_ID`
- `TRAFLIX_AGENT_EVENT_PIPE`
- `TRAFLIX_AGENT_EVENT_PROTOCOL=1`
- `TRAFLIX_AGENT_EVENT_BRIDGE` (absolute path to the bridge)
- `TRAFLIX_WORKSPACE_ID` (owning workspace, since the workspace_id fix)

The bridge is [`traflix-agent-event.ps1`](./traflix-agent-event.ps1). It is
best-effort: if Traflix is closed or a pipe is unavailable, it exits without
blocking or changing the agent result. A real Traflix terminal event is always
routed to the pipe that owns the terminal. This is required when DEV and the
installed release run at the same time: the notification and its “Continua”
action must stay with the instance that owns the real PTY.

## Notification logs

The notification path logs each stage without recording the agent payload:

- OpenCode: `~/.config/opencode/traflix-notify.log`
- Pi: `~/.pi/agent/traflix-notify.log`
- Cline: `~/.cline/traflix-notify.log`
- Anti-Gravity: `~/.gemini/antigravity-cli/traflix-notify.log`
- Freebuff: `~/.config/manicode/traflix-notify.log`
- PowerShell bridge: `%TEMP%\traflix-agent-event-bridge.log`
- Traflix backend: Rust tracing output with `RUST_LOG=traflix_space=info,warn`
- Traflix frontend: browser/WebView console entries prefixed with
  `[agent-notification]`

Use the `eventId` printed in the adapter, bridge, Rust, and frontend logs to
follow one notification end to end. The logs cover adapter start, bridge
process start/exit, pipe send, Rust validation/deduplication, frontend receipt,
and toast/overlay routing.

## Automatic setup (recommended)

[`install-adapters.ps1`](./install-adapters.ps1) wires the bridge into the
config folders of the agents in one, idempotent run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\agent-notifications\install-adapters.ps1
```

It detects the installed bridge (`C:\Program Files\Traflix Space\...`) or a
repo checkout, and:

| Agent | Install target | Notes |
|-------|----------------|-------|
| Codex | `~/.codex/config.toml` → `notify` | Replaces the single `notify` command (Codex allows one). A backup is saved to `config.toml.traflix.bak`. |
| OpenCode | `~/.config/opencode/plugin/opencode-traflix-plugin.ts` | Auto-loaded from the plugin dir. If your OpenCode version does not pick it up, add the path to the `plugin`/`plugins` array in `opencode.json` / `opencode.v2.json`. |
| Cline | `~/.cline/hooks/TaskComplete.ps1` | Cline’s native `TaskComplete` file hook. It returns an empty hook result and forwards only task/workspace IDs. |
| Anti-Gravity | `.agents/hooks.json` + `anti-gravity-traflix-hook.ps1` | AGY’s native `Stop` lifecycle hook. It ignores cancellation/error stops and forwards idle completions. |
| Pi | `~/.pi/agent/extensions/traflix-notify.ts` | Pi auto-discovers `extensions/*.ts`. |

Run it again after every reinstall/update of Traflix (the bridge path can move).
It preserves an existing Codex `notify` command and adds the Cline hook while
installing/updating the OpenCode and Pi adapter files.

After changing the bridge itself, restart/reinstall Traflix so the packaged
copy under `C:\Program Files\Traflix Space\agent-notifications\` is updated.
For a DEV-only check, start the DEV app with
`TRAFLIX_AGENT_EVENT_BRIDGE` pointing to this repository's
`scripts\agent-notifications\traflix-agent-event.ps1`, then restart the agent
process so it inherits the new path.

## Smoke test

From a terminal opened inside Traflix Space (so the environment carries
`TRAFLIX_TERMINAL_ID`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\agent-notifications\smoke-test.ps1
```

If the toast appears, the pipe → Rust → frontend chain works and the agent in
question only needs its adapter installed/restarted. If it does not appear,
Traflix's own event chain is at fault (check the Rust logs:
`RUST_LOG=traflix_space=info,warn`).

## Adapter test suite

Run the Windows contract/integration suite from the repository root:

```powershell
npm run test:agent-notifications
```

It checks the Codex, Claude, OpenCode, Pi, Cline, and Anti-Gravity lifecycle adapters, then sends
synthetic completion payloads through a real named pipe for every configured
agent (`anti-gravity`, `claude`, `codex`, `opencode`, `pi`, `cmdc`, and
`freebuff`). It never reads `.env` and never starts an agent process.

Attention-required completions use Traflix's own always-on-top overlay window;
they remain visible when the main window is unfocused or the desktop is in
front. A focused terminal plays only the completion chime. No native Windows
notification is used. Restart the Tauri DEV app after changing the window
configuration so the overlay window is created.

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
transition (the initial idle state is ignored). The short-lived PowerShell
bridge stays attached long enough to connect to the Windows named pipe.

## Pi

Install [`pi-traflix-extension.ts`](./pi-traflix-extension.ts) as a Pi
extension. It uses `agent_settled`, which avoids notifying during automatic
retry/compaction/follow-up work.

## Claude Code

Merge the `Notification` block from [`claude-hooks.json`](./claude-hooks.json)
into the desired Claude settings or plugin hook file. The `idle_prompt`
notification is side-effect-only and cannot block Claude.

Freebuff is wired in its source tree at `codebuff/cli/src/utils/sdk-event-handlers.ts`:
the Freebuff-only root `finish` event starts the bridge process. A rebuilt
Freebuff binary is required before the installed binary can use that change.

The current Traflix agent registry also contains Claude, Cline, Anti-Gravity,
and Freebuff. Claude is left unchanged here because it is not available in the
current environment.

## Manual smoke event

From a PowerShell process whose environment belongs to a live Traflix terminal:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\agent-notifications\traflix-agent-event.ps1 `
  -Provider codex `
  -Payload '{"type":"agent-turn-complete","thread-id":"smoke-session","turn-id":"smoke-turn"}'
```

The terminal must still exist in Traflix for the backend to accept the event.
