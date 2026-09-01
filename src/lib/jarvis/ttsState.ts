import type { CodexSpeechItem, TtsStatusView } from "./types";

// C8 — progressive commentary speech queue (spec §17).
// Rules: speak every completed commentary/final item, dedupe by turn and item, FIFO
// order, clear on barge-in. Filtering of empty/technical content belongs to
// the backend speech normalizer; a short natural plan step is still useful.

/** Keep at most this many spoken item ids (bounded dedupe memory). */
export const MAX_SPOKEN_ITEM_IDS = 200;

/** Whether a completed message contains something that can be spoken. */
export function shouldSpeakCommentary(text: string): boolean {
  return text.trim().length > 0;
}

/** Stable identity for a message item across the retained streaming turns. */
export function speechItemKey(
  item: Pick<CodexSpeechItem, "turnId" | "itemId">,
): string {
  return `${item.turnId}::${item.itemId}`;
}

/** Appends an item to the queue, deduping by turn and item, without dropping steps. */
export function enqueueSpeech(
  queue: CodexSpeechItem[],
  item: CodexSpeechItem,
): CodexSpeechItem[] {
  if (queue.some((candidate) => speechItemKey(candidate) === speechItemKey(item))) {
    return queue;
  }
  return [...queue, item];
}

/** Removes the first item (called after synthesis is accepted/failed). */
export function dequeueSpeech(
  queue: CodexSpeechItem[],
  item: Pick<CodexSpeechItem, "turnId" | "itemId">,
): CodexSpeechItem[] {
  const key = speechItemKey(item);
  return queue.filter((candidate) => speechItemKey(candidate) !== key);
}

/** Barge-in / mute: drop everything still pending. */
export function clearSpeechQueue(_queue: CodexSpeechItem[]): CodexSpeechItem[] {
  return [];
}

/** Records a spoken item id for dedupe (bounded). */
export function rememberSpoken(
  spoken: string[],
  item: Pick<CodexSpeechItem, "turnId" | "itemId">,
): string[] {
  const key = speechItemKey(item);
  if (spoken.includes(key)) return spoken;
  return [...spoken, key].slice(-MAX_SPOKEN_ITEM_IDS);
}

export interface TtsClientState {
  ttsStatus: TtsStatusView;
  pendingTtsRequestId: string | null;
}

export interface TtsStateTransition extends TtsClientState {
  accepted: boolean;
}

export function beginLocalTtsRequest(
  current: TtsClientState,
  requestId: string,
  workspaceId: string,
): TtsClientState {
  return {
    pendingTtsRequestId: requestId,
    ttsStatus: {
      requestId,
      workspaceId,
      sequence: current.ttsStatus.sequence,
      status: "synthesizing",
    },
  };
}

export function applyTtsStatusTransition(
  current: TtsClientState,
  incoming: TtsStatusView,
): TtsStateTransition {
  // `stopped` is a terminal backend notification, not a busy client state.
  // Keeping it in Zustand caused the progressive Codex speech worker to
  // consider TTS permanently busy after a barge-in/manual stop. Normalize it
  // to idle so the next Jarvis turn can speak again immediately.
  const normalizedIncoming: TtsStatusView =
    incoming.status === "stopped"
      ? { ...incoming, status: "idle" }
      : incoming;

  if (
    current.pendingTtsRequestId &&
    normalizedIncoming.requestId !== current.pendingTtsRequestId
  ) {
    return { ...current, accepted: false };
  }

  const currentSequence = current.ttsStatus.sequence;
  const incomingSequence = normalizedIncoming.sequence;
  if (
    typeof currentSequence === "number" &&
    typeof incomingSequence === "number" &&
    incomingSequence < currentSequence
  ) {
    return { ...current, accepted: false };
  }

  if (
    !current.pendingTtsRequestId &&
    current.ttsStatus.requestId &&
    normalizedIncoming.requestId &&
    current.ttsStatus.requestId !== normalizedIncoming.requestId &&
    normalizedIncoming.status !== "synthesizing"
  ) {
    return { ...current, accepted: false };
  }

  return {
    ttsStatus: normalizedIncoming,
    pendingTtsRequestId:
      normalizedIncoming.requestId === current.pendingTtsRequestId
        ? null
        : current.pendingTtsRequestId,
    accepted: true,
  };
}
