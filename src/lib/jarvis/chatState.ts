import type {
  CodexChatStreamEvent,
  CodexSpeechItem,
  CodexStreamItem,
  CodexStreamingTurn,
  JarvisConversationMessage,
  JarvisRequestState,
  PendingAction,
} from "./types";

export const MAX_COMPLETED_REQUEST_HISTORY = 64;
/** C7: keep at most this many streaming turns per workspace (LRU drop). */
export const MAX_STREAMING_TURNS_PER_WORKSPACE = 3;

export function mergeConversationMessages(current: JarvisConversationMessage[], incoming: JarvisConversationMessage[]): JarvisConversationMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function requestsForWorkspace(requests: Record<string, JarvisRequestState>, workspaceId: string | null): JarvisRequestState[] {
  return Object.values(requests).filter((request) => request.workspaceId === workspaceId);
}

export function mergeJarvisRequestState(
  current: JarvisRequestState | undefined,
  incoming: JarvisRequestState,
): JarvisRequestState {
  if (!current || current.requestId !== incoming.requestId) return incoming;

  // Chat responses and cancellation callbacks race across IPC boundaries. A
  // terminal result is authoritative and cannot be rewritten by a late
  // cancellation marker or an older running snapshot. Cancellation requested
  // remains transitional, so a successful backend response may still win.
  if (
    ["completed", "cancelled", "failed"].includes(current.status) &&
    incoming.status !== current.status
  ) {
    return current;
  }
  if (current.status === "cancellation_requested" && incoming.status === "running") {
    return current;
  }
  return { ...current, ...incoming };
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

// ---------------------------------------------------------------------------
// C7 — Codex streaming turns (pure state machine, correction #4: agentMessage
// has NO phase; the final is the last completed message before
// turn/completed; raw reasoning is never forwarded by the backend).
// ---------------------------------------------------------------------------

/** Applies one `jarvis://chat-stream` event to the per-workspace turns. */
export function applyCodexChatStream(
  turns: Record<string, CodexStreamingTurn[]>,
  event: CodexChatStreamEvent,
): Record<string, CodexStreamingTurn[]> {
  // The backend never emits events without thread/turn ids, but the wire type
  // is nullable — normalize defensively (spec §25: unknown payloads are dropped).
  const workspaceId = event.workspaceId ?? "unknown";
  const workspaceTurns = turns[workspaceId] ?? [];
  const next = applyToTurnList(workspaceTurns, event);
  if (next.length === 0 && workspaceTurns.length === 0) return turns;
  return { ...turns, [workspaceId]: next };
}

function applyToTurnList(
  turns: CodexStreamingTurn[],
  event: CodexChatStreamEvent,
): CodexStreamingTurn[] {
  const turnId = event.turnId ?? "unknown";
  const threadId = event.threadId ?? "unknown";
  const workspaceId = event.workspaceId ?? "unknown";
  const index = turns.findIndex((turn) => turn.turnId === turnId);
  const turn: CodexStreamingTurn = index >= 0
    ? turns[index]
    : {
        turnId,
        threadId,
        requestId: event.requestId,
        workspaceId,
        status: "active",
        items: [],
        startedAt: event.timestamp,
        endedAt: null,
      };

  const nextTurn = reduceTurn(turn, event);
  // Streaming turns are intentionally stored newest-first. Keep an existing
  // turn at its current position; insert only genuinely new turns at index 0.
  const updated = index >= 0
    ? turns.map((item, i) => (i === index ? nextTurn : item))
    : [nextTurn, ...turns];
  return updated.slice(0, MAX_STREAMING_TURNS_PER_WORKSPACE);
}

function reduceTurn(turn: CodexStreamingTurn, event: CodexChatStreamEvent): CodexStreamingTurn {
  switch (event.kind) {
    case "turn_started":
      return { ...turn, status: "active", startedAt: turn.startedAt || event.timestamp };
    case "turn_completed":
    case "turn_failed":
    case "turn_interrupted": {
      const status = event.kind === "turn_completed" ? "completed" : event.kind === "turn_failed" ? "failed" : "interrupted";
      // Correction #4: the last completed message before turn/completed is
      // the final answer.
      const items = markLastCompletedMessageFinal(turn.items);
      return { ...turn, status, items, endedAt: event.timestamp };
    }
    case "message_started":
      return upsertItem(turn, {
        itemId: event.itemId ?? `msg-${event.turnId}-${turn.items.length}`,
        kind: "message",
        status: "started",
        text: event.text ?? "",
        toolName: null,
        final: false,
        updatedAt: event.timestamp,
      });
    case "message_delta": {
      const itemId = event.itemId ?? lastMessageItemId(turn) ?? `msg-${event.turnId}-${turn.items.length}`;
      return upsertItem(turn, {
        itemId,
        kind: "message",
        status: "active",
        text: event.text ?? "",
        toolName: null,
        final: false,
        updatedAt: event.timestamp,
      }, (existing) => existing.text + (event.text ?? ""));
    }
    case "message_completed": {
      const nextTurn = upsertItem(turn, {
        itemId: event.itemId ?? lastMessageItemId(turn) ?? `msg-${event.turnId}-${turn.items.length}`,
        kind: "message",
        status: "completed",
        // A completed item may carry the full text; otherwise keep the
        // accumulated delta text.
        text: event.text ?? "",
        toolName: null,
        final: false,
        updatedAt: event.timestamp,
      }, (existing) => event.text ?? existing.text);
      // Be tolerant of terminal notifications that arrive just before the
      // final item completion on the WebView event queue.
      return turn.status === "completed"
        ? { ...nextTurn, items: markLastCompletedMessageFinal(nextTurn.items) }
        : nextTurn;
    }
    case "tool_started":
      return upsertItem(turn, {
        itemId: event.itemId ?? `tool-${event.turnId}-${turn.items.length}`,
        kind: "tool",
        status: "started",
        text: "",
        toolName: event.toolName ?? "tool",
        final: false,
        updatedAt: event.timestamp,
      });
    case "tool_completed":
      return upsertItem(turn, {
        itemId: event.itemId ?? lastToolItemId(turn) ?? `tool-${event.turnId}-${turn.items.length}`,
        kind: "tool",
        status: "completed",
        text: "",
        toolName: event.toolName ?? null,
        final: false,
        updatedAt: event.timestamp,
      }, (existing) => ({ ...existing, status: "completed" as const, toolName: event.toolName ?? existing.toolName }));
  }
}

function upsertItem(
  turn: CodexStreamingTurn,
  item: CodexStreamItemInput,
  merge?: (existing: CodexStreamItem) => Partial<CodexStreamItem> | string,
): CodexStreamingTurn {
  const index = turn.items.findIndex((candidate) => candidate.itemId === item.itemId);
  if (index < 0) {
    return { ...turn, items: [...turn.items, toItem(item)] };
  }
  const existing = turn.items[index];
  const patch = merge ? merge(existing) : {};
  const merged = typeof patch === "string" ? { text: patch } : patch;
  return {
    ...turn,
    items: turn.items.map((candidate, i) =>
      i === index ? { ...existing, ...item, ...merged, updatedAt: item.updatedAt } : candidate,
    ),
  };
}

function toItem(item: CodexStreamItemInput): CodexStreamItem {
  return {
    itemId: item.itemId,
    kind: item.kind,
    status: item.status,
    text: item.text,
    toolName: item.toolName,
    final: item.final,
    updatedAt: item.updatedAt,
  };
}

function lastMessageItemId(turn: CodexStreamingTurn): string | null {
  for (let i = turn.items.length - 1; i >= 0; i -= 1) {
    if (turn.items[i].kind === "message") return turn.items[i].itemId;
  }
  return null;
}

function lastToolItemId(turn: CodexStreamingTurn): string | null {
  for (let i = turn.items.length - 1; i >= 0; i -= 1) {
    if (turn.items[i].kind === "tool") return turn.items[i].itemId;
  }
  return null;
}

function markLastCompletedMessageFinal(items: CodexStreamItem[]): CodexStreamItem[] {
  let lastIndex = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === "message" && item.status === "completed") lastIndex = i;
  }
  if (lastIndex < 0) return items;
  return items.map((item, i) => ({
    ...item,
    // Multiple completed agent messages are valid in one turn. Exactly the
    // last one is final, including when terminal/item notifications reorder.
    final: i === lastIndex,
  }));
}

interface CodexStreamItemInput {
  itemId: string;
  kind: "message" | "tool";
  status: "started" | "active" | "completed";
  text: string;
  toolName: string | null;
  final: boolean;
  updatedAt: string;
}


/**
 * The tool currently being executed by the latest active turn of the
 * workspace, if any. Streaming turns are stored newest-first, so inspect
 * index 0 first and then scan that turn's items in reverse for the newest
 * in-flight tool.
 */
export function currentCodexTool(
  turns: Record<string, CodexStreamingTurn[]>,
  workspaceId: string | null,
): { toolName: string; itemId: string } | null {
  if (!workspaceId) return null;
  const workspaceTurns = turns[workspaceId];
  if (!workspaceTurns?.length) return null;
  for (let i = 0; i < workspaceTurns.length; i += 1) {
    const turn = workspaceTurns[i];
    if (turn.status !== "active") continue;
    for (let j = turn.items.length - 1; j >= 0; j -= 1) {
      const item = turn.items[j];
      if (item.kind === "tool" && item.status !== "completed" && item.toolName) {
        return { toolName: item.toolName, itemId: item.itemId };
      }
    }
    return null;
  }
  return null;
}

/** Whether the newest turn of the workspace is still running. */
export function isCodexTurnActive(
  turns: Record<string, CodexStreamingTurn[]>,
  workspaceId: string | null,
): boolean {
  if (!workspaceId) return false;
  const newest = turns[workspaceId]?.[0];
  return newest?.status === "active";
}

/**
 * Resolves the text that must be sent to the progressive speech queue for a
 * completed agent message. The App Server can deliver the body as deltas and
 * then send `item/completed` with no `text`; the visible reducer has already
 * accumulated those deltas, so TTS must use the post-event turn state too.
 */
export function completedCodexSpeechItem(
  turns: Record<string, CodexStreamingTurn[]>,
  event: CodexChatStreamEvent,
): CodexSpeechItem | null {
  if (event.kind !== "message_completed") return null;

  const workspaceId = event.workspaceId ?? "unknown";
  const turnId = event.turnId ?? "unknown";
  const turn = turns[workspaceId]?.find((candidate) => candidate.turnId === turnId);
  if (!turn) return null;

  const itemId = event.itemId ?? lastMessageItemId(turn);
  if (!itemId) return null;
  const item = turn.items.find((candidate) => candidate.itemId === itemId);
  if (!item || item.kind !== "message" || item.status !== "completed") return null;

  const text = (event.text?.trim() ? event.text : item.text).trim();
  if (!text) return null;

  return { itemId, turnId, workspaceId, text };
}

/** Returns the newest accumulated agent message for the compact Jarvis pill. */
export function latestCodexMessage(
  turns: Record<string, CodexStreamingTurn[]>,
  workspaceId: string | null,
): string | null {
  if (!workspaceId) return null;
  // The list is newest-first. Once a new turn exists, an empty current turn
  // must stay empty until its own first message token arrives; falling back to
  // an older turn makes the widget look as if Jarvis answered the previous
  // prompt again.
  const newestTurn = turns[workspaceId]?.[0];
  if (!newestTurn) return null;
  for (let index = newestTurn.items.length - 1; index >= 0; index -= 1) {
    const item = newestTurn.items[index];
    if (item.kind === "message" && item.text.trim()) return item.text.trim();
  }
  return null;
}
