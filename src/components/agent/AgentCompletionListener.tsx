import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import {
  chimeNeedsVisualFallback,
  playAgentCompletionChime,
  primeAgentCompletionChime,
} from "../../lib/agentNotificationSound";
import {
  AGENT_NOTIFICATION_OPEN_EVENT,
  showAgentNotificationOverlay,
} from "../../lib/agentNotificationOverlay";
import { useTerminalStore } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { AgentTurnCompleted } from "../terminal/types";

const PROVIDER_NAMES: Record<string, string> = {
  "anti-gravity": "Anti-Gravity",
  claude: "Claude",
  cloud: "Claude",
  claudex: "Claudex",
  cloudx: "Claudex",
  cline: "Cline",
  codex: "Codex",
  freebuff: "Freebuff",
  opencode: "OpenCode",
  pi: "Pi",
};

function providerName(provider: string): string {
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}

function projectNameForEvent(
  event: AgentTurnCompleted,
  terminal: { workspaceId: string } | undefined,
): string {
  const workspaceId = terminal?.workspaceId ?? event.workspaceId ?? null;
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace?.name) return workspace.name;

  const cwd = event.cwd?.replace(/[\\/]+$/, "");
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    const lastPart = parts[parts.length - 1];
    if (lastPart) return lastPart;
  }

  return "Progetto corrente";
}

async function handleCompletion(event: AgentTurnCompleted) {
  const terminalStore = useTerminalStore.getState();
  const terminal = terminalStore.terminals[event.terminalId];

  if (
    !terminal ||
    event.generation == null ||
    event.generation !== terminal.generation ||
    event.workspaceId == null ||
    event.workspaceId !== terminal.workspaceId ||
    event.processId !== terminal.processId
  ) {
    console.warn("[agent-notification] stale or incomplete completion ignored", {
      terminalId: event.terminalId,
      eventGeneration: event.generation ?? null,
      currentGeneration: terminal?.generation ?? null,
      eventProcessId: event.processId ?? null,
      currentProcessId: terminal?.processId ?? null,
      eventWorkspaceId: event.workspaceId ?? null,
      currentWorkspaceId: terminal?.workspaceId ?? null,
    });
    return;
  }

  const completionWorkspaceId = terminal.workspaceId;
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const isCompletionInActiveWorkspace =
    completionWorkspaceId !== null &&
    completionWorkspaceId === activeWorkspaceId;
  console.info("[agent-notification] handling completion", {
    provider: event.provider,
    terminalId: event.terminalId,
    eventId: event.eventId ?? "-",
    workspaceId: completionWorkspaceId,
    generation: event.generation ?? null,
    isCompletionInActiveWorkspace,
    terminalKnown: true,
  });
  // Completion state is always marked as requiring attention. The visual
  // indicator must remain available in every focus/workspace combination until
  // explicitly cleared.
  const attentionRequired = true;

  terminalStore.markAgentTurnCompleted(
    event.terminalId,
    event,
    attentionRequired,
  );
  // The terminal/workspace attention indicator and sound are always emitted.
  const chime = playAgentCompletionChime({
    eventId: event.eventId,
    terminalId: event.terminalId,
    workspaceId: completionWorkspaceId,
    generation: event.generation,
  });

  let appHasFocus = document.hasFocus();
  try {
    // Native Tauri focus is reliable while xterm owns the focused element;
    // document.hasFocus() can be false in that situation in WebView2.
    appHasFocus = await getCurrentWebviewWindow().isFocused();
  } catch (error) {
    // Browser preview and older runtimes fall back to the DOM signal.
    console.debug("[agent-notification] native focus unavailable; using DOM focus", {
      terminalId: event.terminalId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
  console.info("[agent-notification] focus resolved", {
    terminalId: event.terminalId,
    appHasFocus,
  });
  const chimeResult = await chime;
  const audioFallbackRequired = chimeNeedsVisualFallback(chimeResult);
  if (audioFallbackRequired) {
    console.warn("[agent-notification] visual fallback required for chime", {
      terminalId: event.terminalId,
      workspaceId: completionWorkspaceId,
      generation: event.generation ?? null,
      eventId: event.eventId ?? "-",
      chimeStatus: chimeResult.status,
    });
  }

  // A completion in the workspace currently visible to the user only needs
  // the sound and the terminal/workspace attention indicator. Completions in
  // another workspace use the in-app toast, while completions received while
  // Traflix is unfocused use the external overlay.
  if (appHasFocus && isCompletionInActiveWorkspace && !audioFallbackRequired) {
    console.info("[agent-notification] local attention only", {
      terminalId: event.terminalId,
    });
    return;
  }

  const workspaceId = completionWorkspaceId;
  const terminalTitle =
    terminalStore.terminalTitles[event.terminalId] ?? terminal.title;
  const agentName = providerName(event.provider);
  const projectName = projectNameForEvent(event, terminal);

  if (appHasFocus) {
    console.info("[agent-notification] showing in-app toast", {
      terminalId: event.terminalId,
      workspaceId,
    });
    useToastStore.getState().addToast({
      type: "success",
      message: `${agentName} ha completato il turno in ${terminalTitle}`,
      duration: 8000,
      action: {
        label: "Apri",
        onClick: () => {
          const live = useTerminalStore.getState().terminals[event.terminalId];
          if (
            !live ||
            live.workspaceId !== event.workspaceId ||
            live.generation !== event.generation ||
            live.processId !== event.processId
          ) {
            console.warn("[agent-notification] expired toast target ignored", {
              terminalId: event.terminalId,
              eventGeneration: event.generation ?? null,
              currentGeneration: live?.generation ?? null,
            });
            return;
          }
          useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
          useTerminalStore.getState().setActiveTerminal(event.terminalId);
          useTerminalStore.getState().clearAgentAttention(event.terminalId);
        },
      },
    });
  } else {
    console.info("[agent-notification] showing external overlay", {
      terminalId: event.terminalId,
      workspaceId,
    });
    void showAgentNotificationOverlay({
      message: `${agentName} ha completato il turno`,
      provider: agentName,
      projectName,
      terminalTitle,
      terminalId: event.terminalId,
      workspaceId,
      canOpenTerminal: true,
      event,
    });
  }
}

export function AgentCompletionListener() {
  useEffect(() => {
    let chimePrimeRequested = false;
    const primeChimeFromGesture = () => {
      if (chimePrimeRequested) return;
      chimePrimeRequested = true;
      window.removeEventListener("pointerdown", primeChimeFromGesture, true);
      window.removeEventListener("keydown", primeChimeFromGesture, true);
      void primeAgentCompletionChime();
    };
    window.addEventListener("pointerdown", primeChimeFromGesture, {
      capture: true,
      once: true,
    });
    window.addEventListener("keydown", primeChimeFromGesture, {
      capture: true,
      once: true,
    });

    const unsubscribe = subscribeAgentTurnCompleted(handleCompletion);
    let unlisten: UnlistenFn | undefined;
    const setup = listen<{
      workspaceId?: string | null;
      terminalId: string;
      generation?: number | null;
      processId?: number | null;
    }>(
      AGENT_NOTIFICATION_OPEN_EVENT,
      async (event) => {
        const { workspaceId, terminalId, generation, processId } = event.payload;
        console.info("[agent-notification] open requested", {
          terminalId,
          workspaceId: workspaceId ?? null,
          generation: generation ?? null,
          processId: processId ?? null,
        });
        const terminal = useTerminalStore.getState().terminals[terminalId];
        if (
          !terminal ||
          generation == null ||
          workspaceId == null ||
          terminal.generation !== generation ||
          terminal.processId !== processId ||
          terminal.workspaceId !== workspaceId
        ) {
          console.warn("[agent-notification] expired overlay target ignored", {
            terminalId,
            requestedGeneration: generation ?? null,
            currentGeneration: terminal?.generation ?? null,
          });
          return;
        }
        if (workspaceId) {
          useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
        }
        useTerminalStore.getState().setActiveTerminal(terminalId);
        useTerminalStore.getState().clearAgentAttention(terminalId);
        const mainWindow = getCurrentWebviewWindow();
        try {
          await mainWindow.unminimize();
          await mainWindow.show();
          await mainWindow.setFocus();
          console.info("[agent-notification] main window opened", {
            terminalId,
            workspaceId: workspaceId ?? null,
          });
        } catch (error) {
          console.warn("[agent-notification] main window focus failed:", error);
        }
      },
    ).then((cleanup) => {
      unlisten = cleanup;
    }).catch((error) => {
      console.error("Agent notification open listener failed:", error);
    });

    return () => {
      window.removeEventListener("pointerdown", primeChimeFromGesture, true);
      window.removeEventListener("keydown", primeChimeFromGesture, true);
      unsubscribe();
      void setup.then(() => unlisten?.());
    };
  }, []);
  return null;
}
