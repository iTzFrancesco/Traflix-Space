import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const bridgePath = process.env.TRAFLIX_AGENT_EVENT_BRIDGE;

function forward(event: Record<string, unknown>) {
  if (!bridgePath) return;
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      bridgePath,
      "-Provider",
      "pi",
      "-Kind",
      "turn_completed",
      "-Payload",
      JSON.stringify(event),
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

export default function traFlixPiExtension(pi: ExtensionAPI) {
  pi.on("agent_settled", async () => {
    forward({ type: "agent_settled" });
  });
}
