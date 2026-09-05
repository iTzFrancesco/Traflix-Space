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

const ROOT_PID_ENV = "TRAFLIX_PI_ROOT_PID"
const DEPTH_ENV = "TRAFLIX_PI_DEPTH"

function currentPid(): string {
  return String(process.pid ?? "")
}

/**
 * Only the outermost Pi attached to a Traflix terminal may notify.
 * Pi subagents/workflows spawn nested `pi --mode json -p --no-session`
 * processes that inherit TRAFLIX_* env, so without a guard every subagent
 * completion would toast while the root task is still running.
 * The root claims ROOT_PID once; nested processes keep it and stay silent.
 * PID comparison (not a boolean) survives `/reload` in the same process.
 */
function claimPiRoot(): boolean {
  const inherited = (process.env[ROOT_PID_ENV] ?? "").trim()
  const pid = currentPid()
  if (!inherited) {
    if (pid) process.env[ROOT_PID_ENV] = pid
    if (process.env[DEPTH_ENV] === undefined) process.env[DEPTH_ENV] = "0"
    return true
  }
  if (pid && inherited === pid) return true
  const depth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10)
  process.env[DEPTH_ENV] = String(Number.isFinite(depth) ? depth + 1 : 1)
  return false
}

function looksLikeSubagentArgv(): boolean {
  const argv = process.argv.slice(2).map((arg) => arg.toLowerCase())
  return (
    argv.includes("--mode") &&
    argv.includes("json") &&
    (argv.includes("-p") || argv.includes("--print")) &&
    argv.includes("--no-session")
  )
}

function isNestedPiProcess(): boolean {
  const marker = (process.env[ROOT_PID_ENV] ?? "").trim()
  if (marker && marker !== currentPid()) return true
  // Migration cover: parent started before this guard existed and never
  // claimed ROOT_PID. The subagent spawn signature is specific enough that
  // a manual `pi -p` from the shell is unaffected.
  if (!marker && looksLikeSubagentArgv()) return true
  return false
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
  const isRoot = claimPiRoot()
  log(
    `extension loaded; registering agent_settled root=${isRoot ? "yes" : "NO"} pid=${currentPid()} depth=${process.env[DEPTH_ENV] ?? "?"}`,
  )
  pi.on("agent_settled", () => {
    if (!isRoot || isNestedPiProcess()) {
      log(
        `notification suppressed reason=nested-subagent pid=${currentPid()} depth=${process.env[DEPTH_ENV] ?? "?"} terminal=${process.env.TRAFLIX_TERMINAL_ID ? "yes" : "NO"}`,
      )
      return
    }
    log("agent_settled fired")
    forward("pi")
  })
  log("agent_settled registered")
}
