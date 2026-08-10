import type { CodexSpeechItem, TtsStatusView } from "./types";

// C8 — progressive commentary speech queue (spec §17).
// Rules: speak only completed commentary/final items, dedupe by itemId,
// skip too-short utterances ("Ok."), FIFO order, clear on barge-in.

/** Skip utterances shorter than this ("Ok.", "Fatto." are noise). */
export const MIN_SPOKEN_COMMENTARY_CHARS = 14;
/** Keep at most this many spoken item ids (bounded dedupe memory). */
export const MAX_SPOKEN_ITEM_IDS = 200;
/** At most this many items waiting in the queue (bounded, FIFO drop). */
export const MAX_SPEECH_QUEUE_LENGTH = 8;

/** Whether a completed message deserves speech (not too short/empty). */
export function shouldSpeakCommentary(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SPOKEN_COMMENTARY_CHARS) return false;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return words >= 3;
}

/** Appends an item to the queue, deduping by itemId (bounded). */
export function enqueueSpeech(
  queue: CodexSpeechItem[],
  item: CodexSpeechItem,
): CodexSpeechItem[] {
  if (queue.some((candidate) => candidate.itemId === item.itemId)) {
    return queue;
  }
  return [...queue, item].slice(-MAX_SPEECH_QUEUE_LENGTH);
}

/** Removes the first item (called after synthesis is accepted/failed). */
export function dequeueSpeech(
  queue: CodexSpeechItem[],
  itemId: string,
): CodexSpeechItem[] {
  return queue.filter((item) => item.itemId !== itemId);
}

/** Barge-in / mute: drop everything still pending. */
export function clearSpeechQueue(_queue: CodexSpeechItem[]): CodexSpeechItem[] {
  return [];
}

/** Records a spoken item id for dedupe (bounded). */
export function rememberSpoken(
  spoken: string[],
  itemId: string,
): string[] {
  if (spoken.includes(itemId)) return spoken;
  return [...spoken, itemId].slice(-MAX_SPOKEN_ITEM_IDS);
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
