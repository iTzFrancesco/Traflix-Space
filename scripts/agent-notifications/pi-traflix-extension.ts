import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

/**
 * Pi extension that forwards the `agent_settled` lifecycle event to Traflix
 * Space (via the traflix-agent-event.ps1 bridge + Windows named pipe).
 *
 * It is deliberately resilient:
 *  - the bridge path is resolved at event time (not at module load), so it
 *    works even if TRAFLIX_AGENT_EVENT_BRIDGE is set after the extension loads;
 *  - it falls back to the standard install locations when the env var is empty;
 *  - it writes a log to ~/.pi/agent/traflix-notify.log so failures are visible.
 */

function logFile(): string {
  return path.join(os.homedir(), ".pi", "agent", "traflix-notify.log")
}

function log(msg: string): void {
  try {
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // Logging is best-effort; never break the agent.
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

function createEventId(terminalId: string | undefined): string {
  const terminal = terminalId ?? "unknown-terminal"
  return `pi/${terminal}/${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function forward(provider: string): void {
  const bridge = resolveBridge()
  const terminalId = process.env.TRAFLIX_TERMINAL_ID
  const pipe = process.env.TRAFLIX_AGENT_EVENT_PIPE
  const workspaceId = process.env.TRAFLIX_WORKSPACE_ID
  const eventId = createEventId(terminalId)

  log(
    `notification start provider=${provider} eventId=${eventId} bridge=${bridge ? "yes" : "NO"} terminal=${terminalId ? "yes" : "NO"} pipe=${pipe ? "yes" : "NO"} workspace=${workspaceId ? "yes" : "no"}`,
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
      provider,
      "-Kind",
      "turn_completed",
      "-PipeName",
      pipe,
      "-TerminalId",
      terminalId,
      "-Payload",
      JSON.stringify({ type: "agent_settled", eventId }),
    ],
    // Keep the PowerShell process attached to the agent runtime. On Windows,
    // detached + unref can terminate before it connects to the named pipe.
    { detached: false, stdio: "ignore", windowsHide: true },
  )
  child.once("spawn", () => {
    log(`bridge process started provider=${provider} eventId=${eventId} pid=${child.pid ?? "unknown"}`)
  })
  child.once("exit", (code, signal) => {
    log(`bridge process exited provider=${provider} eventId=${eventId} code=${code ?? "unknown"} signal=${signal ?? "none"}`)
  })
  child.on("error", (error) => {
    log(`bridge spawn failed provider=${provider} eventId=${eventId}: ${error.message}`)
  })
  log(`bridge spawned provider=${provider} eventId=${eventId} path=${bridge}`)
}

export default function traFlixPiExtension(pi: ExtensionAPI): void {
  log("extension loaded; registering agent_settled")
  pi.on("agent_settled", () => {
    log("agent_settled fired")
    forward("pi")
  })
  log("agent_settled registered")
}
