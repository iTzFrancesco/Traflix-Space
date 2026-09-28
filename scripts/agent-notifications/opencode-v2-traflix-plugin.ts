import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Plugin } from "@opencode/plugin"

const MAX_TRACKED_SESSIONS = 512

function logFile(): string {
  return path.join(os.homedir(), ".config", "opencode", "traflix-notify.log")
}

function log(message: string): void {
  try {
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Logging is best-effort and must not interfere with OpenCode.
  }
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) {
    return undefined
  }
  const field: unknown = Reflect.get(value, key)
  return field
}

function readString(value: unknown, ...keys: string[]): string | null {
  for (const key of keys) {
    const field = readField(value, key)
    if (typeof field === "string" && field.length > 0) return field
  }
  return null
}

function eventDetails(event: unknown): {
  type: string | null
  sessionId: string | null
  status: string | null
} {
  const type = readString(event, "type")
  const payload = readField(event, "properties") ?? readField(event, "data") ?? event
  const session = readField(payload, "session") ?? readField(payload, "info")
  const sessionId = readString(payload, "sessionID", "sessionId", "session_id")
    ?? readString(session, "id", "sessionID", "sessionId")
  const rawStatus = readField(payload, "status")
  const status = typeof rawStatus === "string"
    ? rawStatus
    : readString(rawStatus, "type")
  return { type, sessionId, status }
}

function rememberBounded(values: Set<string>, value: string): void {
  values.delete(value)
  values.add(value)
  while (values.size > MAX_TRACKED_SESSIONS) {
    const oldest = values.values().next().value
    if (oldest === undefined) return
    values.delete(oldest)
  }
}

function resolveBridge(): string | null {
  const fromEnv = process.env.TRAFLIX_AGENT_EVENT_BRIDGE
  const candidates = [
    ...(fromEnv?.trim() ? [fromEnv.trim()] : []),
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
  for (const candidate of candidates) {
    try {
      if (fs.readFileSync(candidate, "utf8").includes("PipeAlternates")) return candidate
    } catch {
      // Try the next known install location.
    }
  }
  return null
}

function forward(sessionId: string, type: string, status: string): void {
  const bridge = resolveBridge()
  const terminalId = process.env.TRAFLIX_TERMINAL_ID
  const pipe = process.env.TRAFLIX_AGENT_EVENT_PIPE
  const eventId = `opencode/${sessionId}/${Date.now()}-${randomUUID()}`
  log(
    `notification start provider=opencode eventId=${eventId} bridge=${bridge ? "yes" : "NO"} terminal=${terminalId ? "yes" : "NO"} pipe=${pipe ? "yes" : "NO"}`,
  )
  if (!bridge || !terminalId || !pipe) return

  const payload = JSON.stringify({
    type,
    sessionID: sessionId,
    providerSessionId: sessionId,
    eventId,
    status: { type: status },
  })
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
      payload,
    ],
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

export default Plugin.define({
  id: "traflix.agent-notifications",
  setup(ctx) {
    const controller = new AbortController()
    const activeSessions = new Set<string>()
    const notifiedSessions = new Set<string>()
    log("OpenCode V2 plugin loaded; subscribing to session events")

    const isRootSession = async (sessionId: string): Promise<boolean> => {
      try {
        const response: unknown = await ctx.session.get({ sessionID: sessionId })
        const session = readField(response, "data") ?? response
        const parentId = readField(session, "parentID") ?? readField(session, "parentId")
        if (parentId === undefined || parentId === null) return true
        return typeof parentId === "string" && parentId.length === 0
      } catch {
        log("session parent lookup failed; completion ignored")
        return false
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const details = eventDetails(event)
          if (!details.sessionId || !details.type) continue

          if (details.type === "session.status") {
            if (details.status === "busy" || details.status === "retry") {
              rememberBounded(activeSessions, details.sessionId)
              notifiedSessions.delete(details.sessionId)
              continue
            }
            if (details.status !== "idle" || !activeSessions.delete(details.sessionId)) continue
          } else if (details.type !== "session.idle") {
            continue
          }

          if (!(await isRootSession(details.sessionId))) {
            activeSessions.delete(details.sessionId)
            continue
          }
          if (notifiedSessions.has(details.sessionId)) continue
          rememberBounded(notifiedSessions, details.sessionId)
          activeSessions.delete(details.sessionId)
          forward(details.sessionId, details.type, details.status ?? "idle")
        }
      } catch {
        if (!controller.signal.aborted) log("OpenCode V2 event subscription stopped unexpectedly")
      }
    })()

    return () => controller.abort()
  },
})
