import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"

const bridge = fileURLToPath(new URL("./traflix-agent-event.ps1", import.meta.url))

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testProvider(provider) {
  const pipe = `\\\\.\\pipe\\traflix-agent-process-${provider}-${Date.now()}`
  const terminalId = `process-test-${provider}`
  const payload = JSON.stringify({
    type: provider === "pi" ? "agent_settled" : "session.status",
    providerSessionId: `session-${provider}`,
    eventId: `event-${provider}-${Date.now()}`,
    status: { type: "idle" },
  })

  let received = ""
  let connectionResolve
  let connectionReject
  const connection = new Promise((resolve, reject) => {
    connectionResolve = resolve
    connectionReject = reject
  })

  const server = createServer((socket) => {
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      received += chunk
    })
    socket.on("end", () => connectionResolve())
    socket.on("error", connectionReject)
  })

  await new Promise((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
    server.listen(pipe)
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
      provider,
      "-Kind",
      "turn_completed",
      "-PipeName",
      pipe,
      "-TerminalId",
      terminalId,
      "-Payload",
      payload,
    ],
    // This is intentionally the same Windows process mode used by the
    // OpenCode and Pi adapters. Detached + unref loses the pipe connection.
    { detached: false, stdio: "ignore", windowsHide: true },
  )

  const childError = new Promise((_, reject) => {
    child.once("error", reject)
  })
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${provider}: bridge did not connect to named pipe`))
    }, 4000)
  })

  try {
    await Promise.race([connection, childError, timeout])
    const event = JSON.parse(received.trim())
    if (event.protocol !== 1) throw new Error(`${provider}: protocol mismatch`)
    if (event.provider !== provider) throw new Error(`${provider}: provider mismatch`)
    if (event.kind !== "turn_completed") throw new Error(`${provider}: kind mismatch`)
    if (event.terminalId !== terminalId) throw new Error(`${provider}: terminal mismatch`)
    console.log(`[process] ${provider}`)
  } finally {
    clearTimeout(timeoutId)
    server.close()
    if (!child.killed) child.kill()
  }
}

for (const provider of ["opencode", "pi"]) {
  await testProvider(provider)
}

console.log("PASS: adapter child processes delivered events through named pipes.")
