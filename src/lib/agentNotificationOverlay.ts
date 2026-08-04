import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import { currentMonitor, PhysicalPosition, primaryMonitor } from "@tauri-apps/api/window";
import type { AgentTurnCompleted } from "../components/terminal/types";

export const AGENT_NOTIFICATION_WINDOW = "agent-notification";
export const AGENT_NOTIFICATION_SHOW_EVENT = "agent-notification-show";
export const AGENT_NOTIFICATION_OPEN_EVENT = "agent-notification-open";

export interface AgentNotificationPayload {
  message: string;
  provider: string;
  projectName: string;
  terminalTitle: string;
  terminalId: string;
  workspaceId?: string | null;
  canOpenTerminal: boolean;
  event: AgentTurnCompleted;
}

const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 126;
const OVERLAY_MARGIN = 24;

/** Show the Traflix-owned overlay without activating the main application. */
export async function showAgentNotificationOverlay(
  payload: AgentNotificationPayload,
): Promise<void> {
  try {
    const overlay = await WebviewWindow.getByLabel(AGENT_NOTIFICATION_WINDOW);
    if (!overlay) {
      console.warn("Traflix agent overlay window is not available");
      return;
    }

    try {
      const monitor = (await currentMonitor()) ?? (await primaryMonitor());
      if (monitor) {
        const scale = monitor.scaleFactor;
        const workArea = monitor.workArea;
        const x =
          workArea.position.x + workArea.size.width - (OVERLAY_WIDTH + OVERLAY_MARGIN) * scale;
        const y =
          workArea.position.y + workArea.size.height - (OVERLAY_HEIGHT + OVERLAY_MARGIN) * scale;
        await overlay.setPosition(new PhysicalPosition(x, y));
      }
    } catch (error) {
      console.warn("Traflix overlay could not be positioned:", error);
    }

    await overlay.show();
    try {
      await overlay.setAlwaysOnTop(true);
    } catch (error) {
      console.warn("Traflix overlay could not set always-on-top:", error);
    }

    // A hidden WebView can finish mounting its React listener after the
    // window object already exists. Show first, then retry the event briefly
    // so the first OpenCode/Pi completion cannot be lost during startup.
    for (const delay of [0, 75, 175]) {
      if (delay > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
      await emitTo(AGENT_NOTIFICATION_WINDOW, AGENT_NOTIFICATION_SHOW_EVENT, payload);
    }
  } catch (error) {
    console.warn("Traflix agent overlay unavailable:", error);
  }
}
