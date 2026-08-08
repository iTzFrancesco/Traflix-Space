import type { JarvisConversationMessage, JarvisRequestState, PendingAction } from "./types";

export const MAX_COMPLETED_REQUEST_HISTORY = 64;

export function mergeConversationMessages(current: JarvisConversationMessage[], incoming: JarvisConversationMessage[]): JarvisConversationMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function requestsForWorkspace(requests: Record<string, JarvisRequestState>, workspaceId: string | null): JarvisRequestState[] {
  return Object.values(requests).filter((request) => request.workspaceId === workspaceId);
}

export function pruneRequestHistory(requests: Record<string, JarvisRequestState>): Record<string, JarvisRequestState> {
  const entries = Object.entries(requests);
  const active = entries.filter(([, request]) => request.status === "running" || request.status === "cancellation_requested");
  const completed = entries
    .filter(([, request]) => request.status !== "running" && request.status !== "cancellation_requested")
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId))
    .slice(-MAX_COMPLETED_REQUEST_HISTORY);
  return Object.fromEntries([...active, ...completed]);
}

export function pendingActionsForWorkspace(actions: PendingAction[], workspaceId: string | null): PendingAction[] {
  return actions.filter((action) => action.status === "pending" && action.invocation.targetWorkspaceId === workspaceId);
}

export function isWorkspaceChatLoading(requests: Record<string, JarvisRequestState>, workspaceId: string | null): boolean {
  return requestsForWorkspace(requests, workspaceId).some((request) => request.status === "running" || request.status === "cancellation_requested");
}

export function advancedViewVisible(enabled: boolean, settingsOpen: boolean): boolean {
  return enabled && settingsOpen;
}
