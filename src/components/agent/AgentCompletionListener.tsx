import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import { playAgentCompletionChime } from "../../lib/agentNotificationSound";
import {
  AGENT_NOTIFICATION_OPEN_EVENT,
  showAgentNotificationOverlay,
} from "../../lib/agentNotificationOverlay";
import { useTerminalStore } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { AgentTurnCompleted } from "../terminal/types";

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
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

function handleCompletion(event: AgentTurnCompleted) {
  const terminalStore = useTerminalStore.getState();
  const terminal = terminalStore.terminals[event.terminalId];
  const appHasFocus = document.hasFocus();

  const completionWorkspaceId = terminal?.workspaceId ?? event.workspaceId ?? null;
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const isCompletionInActiveWorkspace =
    completionWorkspaceId !== null &&
    completionWorkspaceId === activeWorkspaceId;
  console.info("[agent-notification] handling completion", {
    provider: event.provider,
    terminalId: event.terminalId,
    eventId: event.eventId ?? "-",
    workspaceId: completionWorkspaceId,
    appHasFocus,
    isCompletionInActiveWorkspace,
    terminalKnown: Boolean(terminal),
  });
  // Completion state is always marked as requiring attention. The visual
  // indicator must remain available in every focus/workspace combination until
  // explicitly cleared.
  const attentionRequired = true;

  if (terminal) {
    terminalStore.markAgentTurnCompleted(
      event.terminalId,
      event,
      attentionRequired,
    );
  }
  // The terminal/workspace attention indicator and sound are always emitted.
  playAgentCompletionChime();

  // A completion in the workspace currently visible to the user only needs
  // the sound and the terminal/workspace attention indicator. Completions in
  // another workspace use the in-app toast, while completions received while
  // Traflix is unfocused use the external overlay.
  if (appHasFocus && isCompletionInActiveWorkspace) {
    console.info("[agent-notification] local attention only", {
      terminalId: event.terminalId,
    });
    return;
  }

  const workspaceId = completionWorkspaceId;
  const terminalTitle =
    terminalStore.terminalTitles[event.terminalId] ?? terminal?.title ?? "un terminale";
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
      ...(terminal
        ? {
            action: {
              label: "Apri",
              onClick: () => {
                if (workspaceId) {
                  useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
                }
                useTerminalStore.getState().setActiveTerminal(event.terminalId);
                useTerminalStore.getState().clearAgentAttention(event.terminalId);
              },
            },
          }
        : {}),
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
      canOpenTerminal: Boolean(terminal),
      event,
    });
  }
}

export function AgentCompletionListener() {
  useEffect(() => {
    const unsubscribe = subscribeAgentTurnCompleted(handleCompletion);
    let unlisten: UnlistenFn | undefined;
    const setup = listen<{ workspaceId?: string | null; terminalId: string }>(
      AGENT_NOTIFICATION_OPEN_EVENT,
      (event) => {
        const { workspaceId, terminalId } = event.payload;
        if (workspaceId) {
          useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
        }
        useTerminalStore.getState().setActiveTerminal(terminalId);
        useTerminalStore.getState().clearAgentAttention(terminalId);
        void WebviewWindow.getByLabel("main").then((window) => {
          void window?.show();
          void window?.setFocus();
        });
      },
    ).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unsubscribe();
      void setup.then(() => unlisten?.());
    };
  }, []);
  return null;
}
