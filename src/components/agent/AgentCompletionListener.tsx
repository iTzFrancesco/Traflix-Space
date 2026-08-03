import { useEffect } from "react";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import { playAgentCompletionChime } from "../../lib/agentNotificationSound";
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

function terminalHasDomFocus(terminalId: string): boolean {
  const activeElement = document.activeElement;
  if (!activeElement) return false;

  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-terminal-pane-id]"),
  ).some(
    (pane) =>
      pane.dataset.terminalPaneId === terminalId &&
      pane.contains(activeElement),
  );
}

function handleCompletion(event: AgentTurnCompleted) {
  const terminalStore = useTerminalStore.getState();
  const terminal = terminalStore.terminals[event.terminalId];
  if (!terminal) return;

  const workspaceStore = useWorkspaceStore.getState();
  const isFocused =
    document.hasFocus() &&
    workspaceStore.activeWorkspaceId === terminal.workspaceId &&
    terminalStore.activeTerminalId === event.terminalId &&
    terminalHasDomFocus(event.terminalId) &&
    (!terminalStore.focusedTerminalId ||
      terminalStore.focusedTerminalId === event.terminalId);
  const attentionRequired = !isFocused;

  terminalStore.markAgentTurnCompleted(
    event.terminalId,
    event,
    attentionRequired,
  );
  if (attentionRequired) playAgentCompletionChime();

  const workspaceId = terminal.workspaceId;
  const terminalTitle = terminal.title || "Terminale";
  const agentName = providerName(event.provider);

  useToastStore.getState().addToast({
    type: "success",
    message: `${agentName} ha completato il turno in ${terminalTitle}`,
    duration: 8000,
    action: {
      label: "Apri",
      onClick: () => {
        useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
        useTerminalStore.getState().setActiveTerminal(event.terminalId);
        useTerminalStore.getState().clearAgentAttention(event.terminalId);
      },
    },
  });
}

export function AgentCompletionListener() {
  useEffect(() => subscribeAgentTurnCompleted(handleCompletion), []);
  return null;
}
