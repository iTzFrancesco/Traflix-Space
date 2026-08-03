import { spawn } from "node:child_process";
import type { Plugin } from "@opencode-ai/plugin";

/**
 * Add this file to an OpenCode plugin directory. The bridge path is supplied
 * explicitly so Traflix never edits the user's OpenCode configuration.
 */
const bridgePath = process.env.TRAFLIX_AGENT_EVENT_BRIDGE;
const activeSessions = new Set<string>();

function forward(event: unknown) {
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
      "opencode",
      "-Kind",
      "turn_completed",
      "-Payload",
      JSON.stringify(event),
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

export const TraflixOpenCodePlugin: Plugin = async () => ({
  event: async ({ event }) => {
    if (event.type !== "session.status") return;
    const properties = event.properties as {
      sessionID?: string;
      status?: { type?: string };
    };
    const sessionID = properties.sessionID;
    const status = properties.status?.type;
    if (!sessionID || !status) return;

    if (status === "busy") {
      activeSessions.add(sessionID);
      return;
    }
    if (status !== "idle") return;
    if (!activeSessions.delete(sessionID)) return;

    // Keep the provider session id at the top level for the generic bridge.
    forward({
      type: event.type,
      sessionID,
      status: properties.status,
    });
  },
});

export default TraflixOpenCodePlugin;
