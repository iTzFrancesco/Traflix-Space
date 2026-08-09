import type { TtsStatusView } from "./types";

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
  if (
    current.pendingTtsRequestId &&
    incoming.requestId !== current.pendingTtsRequestId
  ) {
    return { ...current, accepted: false };
  }

  const currentSequence = current.ttsStatus.sequence;
  const incomingSequence = incoming.sequence;
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
    incoming.requestId &&
    current.ttsStatus.requestId !== incoming.requestId &&
    incoming.status !== "synthesizing"
  ) {
    return { ...current, accepted: false };
  }

  return {
    ttsStatus: incoming,
    pendingTtsRequestId:
      incoming.requestId === current.pendingTtsRequestId
        ? null
        : current.pendingTtsRequestId,
    accepted: true,
  };
}
