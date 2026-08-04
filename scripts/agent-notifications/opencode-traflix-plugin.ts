import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

/**
 * OpenCode plugin that forwards the `session.status: idle` (busy -> idle)
 * transition to Traflix Space via the traflix-agent-event.ps1 bridge.
 *
 * Resilient by design:
 *  - bridge path is resolved at event time (env + install-location fallback);
 *  - a log (~/.config/opencode/traflix-notify.log) makes failures visible.
 */

function logFile(): string {
  return path.join(os.homedir(), ".config", "opencode", "traflix-notify.log")
}
function log(msg: string): void {
  try {
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // best-effort
  }
}

function cleanWindowsPath(p: string): string {
  // Windows extended-length prefixes break `powershell -File`. Normalize them:
  //   \\?\C:\...          -> C:\...
  //   \\?\UNC\server\...  -> \\server\...
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`
  if (p.startsWith("\\\\?\\")) return p.slice(4)
  return p
}

function eventIdFor(event: unknown): string {
  if (typeof event !== "object" || event === null || !("eventId" in event)) {
    return "unknown"
  }
  const value = event.eventId
  return typeof value === "string" && value.length > 0 ? value : "unknown"
}

function resolveBridge(): string | null {
  const fromEnv = process.env.TRAFLIX_AGENT_EVENT_BRIDGE
  const candidates = [
    ...(fromEnv && fromEnv.trim() ? [cleanWindowsPath(fromEnv.trim())] : []),
    "C:\\Program Files\\Traflix Space\\agent-notifications\\traflix-agent-event.ps1",
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Programs",
      "Traflix Space",
      "agent-notifications",
      "traflix-agent-event.ps1",
    ),
  ]
  const compatible = (candidate: string) => {
    try {
      return fs.readFileSync(candidate, "utf8").includes("PipeAlternates")
    } catch {
      return false
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && compatible(candidate)) return cleanWindowsPath(candidate)
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return cleanWindowsPath(candidate)
  }
  return null
}

function forward(event: unknown): void {
  const bridge = resolveBridge()
  const terminalId = process.env.TRAFLIX_TERMINAL_ID
  const pipe = process.env.TRAFLIX_AGENT_EVENT_PIPE
  const eventId = eventIdFor(event)
  log(
    `notification start provider=opencode eventId=${eventId} bridge=${bridge ? "yes" : "NO"} terminal=${terminalId ? "yes" : "NO"} pipe=${pipe ? "yes" : "NO"}`,
  )
  if (!bridge || !terminalId || !pipe) return

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      bridge,
      "-Provider",
      "opencode",
      "-Kind",
      "turn_completed",
      "-PipeName",
      pipe,
      "-TerminalId",
      terminalId,
      "-Payload",
      JSON.stringify(event),
    ],
    // Keep the PowerShell process attached to the agent runtime. On Windows,
    // detached + unref can terminate before it connects to the named pipe.
    { detached: false, stdio: "ignore", windowsHide: true },
  )
  child.once("spawn", () => {
    log(`bridge process started provider=opencode eventId=${eventId} pid=${child.pid ?? "unknown"}`)
  })
  child.once("exit", (code, signal) => {
    log(`bridge process exited provider=opencode eventId=${eventId} code=${code ?? "unknown"} signal=${signal ?? "none"}`)
  })
  child.on("error", (error) => {
    log(`bridge spawn failed provider=opencode eventId=${eventId}: ${error.message}`)
  })
}

export const TraflixOpenCodePlugin: Plugin = async () => {
  log("plugin loaded; registering session.status listener")
  const activeSessions = new Set<string>()
  return {
    event: async ({ event }) => {
      if (event.type !== "session.status") return
      const properties = event.properties as {
        sessionID?: string
        status?: { type?: string }
      }
      const sessionID = properties.sessionID
      const status = properties.status?.type
      if (!sessionID || !status) return

      // `retry` is still part of the same in-flight turn. Keep the session
      // armed so a later retry -> idle transition produces exactly one
      // completion notification.
      if (status === "busy" || status === "retry") {
        activeSessions.add(sessionID)
        return
      }
      if (status !== "idle") return
      if (!activeSessions.delete(sessionID)) return

      log(`idle transition for session ${sessionID}`)
      forward({
        type: event.type,
        sessionID,
        providerSessionId: sessionID,
        // OpenCode exposes the session id but not a stable turn id here. The
        // bridge must therefore receive a fresh id for every idle transition;
        // otherwise its dedupe registry treats turn 2+ as duplicates of turn 1.
        eventId: `opencode/${sessionID}/${Date.now()}-${Math.random().toString(36).slice(2)}`,
        status: properties.status,
      })
    },
  }
}

export default TraflixOpenCodePlugin
