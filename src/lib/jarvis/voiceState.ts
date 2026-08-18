import type {
  VadState,
  VoiceEndpointState,
  VoiceRequestStatusView,
} from "./types";

export type VoiceUiPhase = "idle" | "listening" | "processing" | "draft" | "error";

export type ManualVoiceToggleDecision = "start" | "stop" | "noop";

/** The only capture transition exposed by the compact Jarvis widget. */
export function manualVoiceToggle(
  status: VoiceRequestStatusView["status"] | null,
): ManualVoiceToggleDecision {
  if (status === "recording" || status === "armed") return "stop";
  if (!status || status === "idle" || status === "cancelled" || status === "failed") {
    return "start";
  }
  return "noop";
}

/** Collapse backend lifecycle details into one stable user-facing phase. */
export function voiceUiPhase(
  request: VoiceRequestStatusView | null,
  muted = false,
): VoiceUiPhase {
  if (muted || !request) return "idle";
  switch (request.status) {
    case "armed":
    case "recording":
      return "listening";
    case "stopping":
    case "transcribing":
      return "processing";
    case "transcript_ready":
      return "draft";
    case "failed":
      return "error";
    case "idle":
    case "cancelled":
      return "idle";
  }
}

/** Keep endpoint details out of the compact UI; they remain diagnostic data. */
export function voiceUiLabel(
  request: VoiceRequestStatusView | null,
  muted = false,
): string | null {
  switch (voiceUiPhase(request, muted)) {
    case "listening":
      return "Ti ascolto";
    case "processing":
      return "Elaboro…";
    case "draft":
      return "Pronto · invio";
    case "error":
      return "Errore voce";
    case "idle":
      return null;
  }
}

export type VoiceSubmitDecision = "ignore" | "manual" | "queue" | "send";

/**
 * Voice events travel over two asynchronous paths: the command response and
 * the backend event stream. The response can arrive after a fresher recording
 * event, so same-request state must be monotonic instead of last-write-wins.
 */
const VOICE_STATUS_RANK: Record<VoiceRequestStatusView["status"], number> = {
  idle: 0,
  armed: 10,
  recording: 20,
  stopping: 30,
  transcribing: 40,
  transcript_ready: 50,
  cancelled: 60,
  failed: 60,
};

function voiceStatusRank(request: VoiceRequestStatusView): number {
  // An idle request carrying an error is the terminal result of a timeout;
  // a plain idle snapshot is only the absence of an active capture.
  return request.status === "idle" && request.error
    ? 60
    : VOICE_STATUS_RANK[request.status];
}

/** Merge two snapshots for one request without allowing stale transitions. */
export function mergeVoiceRequestStatus(
  current: VoiceRequestStatusView | undefined,
  incoming: VoiceRequestStatusView,
): VoiceRequestStatusView {
  if (!current || current.requestId !== incoming.requestId) return incoming;

  const currentRank = voiceStatusRank(current);
  const incomingRank = voiceStatusRank(incoming);
  if (incomingRank < currentRank) {
    return current;
  }

  // Live CPAL telemetry and the final WAV use different clocks. A terminal
  // snapshot may therefore report a slightly shorter duration than the last
  // level event; never let that measurement veto a newer lifecycle phase.
  if (
    incomingRank === currentRank &&
    incoming.durationMs !== undefined &&
    current.durationMs !== undefined &&
    incoming.durationMs < current.durationMs
  ) {
    return current;
  }

  return {
    ...current,
    ...incoming,
    // Level events and old backends may omit endpoint metadata. Never make a
    // visible pause jump back to the generic listening state for that reason.
    endpointState: incoming.endpointState ?? current.endpointState,
    normalizedLevel: Number.isFinite(incoming.normalizedLevel)
      ? incoming.normalizedLevel
      : current.normalizedLevel,
    transcript: incoming.transcript ?? current.transcript,
    error: incoming.error ?? current.error,
  };
}

/** True only while the microphone is actually capturing or processing audio. */
export function isVoiceCaptureBusy(
  request: VoiceRequestStatusView | null,
  muted = false,
): boolean {
  if (muted || !request) return false;
  return ["recording", "stopping", "transcribing"].includes(
    request.status,
  );
}

/** Pause is still one recording turn, but it is not active speech. */
export function isVoiceEndpointPaused(
  request: VoiceRequestStatusView | null,
  muted = false,
): boolean {
  if (muted || request?.status !== "recording") return false;
  const endpointState = request.endpointState ?? "";
  return (
    ["pause", "breath", "micro_interruption"].includes(endpointState) ||
    (endpointState === "standby" && request.vadState === "silence")
  );
}

export function voiceRequestForWorkspace(request: VoiceRequestStatusView | null, workspaceId: string | null): VoiceRequestStatusView | null {
  return request && request.workspaceId === workspaceId ? request : null;
}

export function voiceDraftsForWorkspaces(requests: Record<string, VoiceRequestStatusView>, workspaceId: string | null): VoiceRequestStatusView[] {
  return workspaceId ? Object.values(requests).filter((request) => request.workspaceId === workspaceId) : [];
}

export function canSendTranscript(request: VoiceRequestStatusView | null, workspaceId: string | null, text: string): boolean {
  return Boolean(request && request.status === "transcript_ready" && request.workspaceId === workspaceId && text.trim());
}

/** Endpoint detail stays in diagnostics; the compact UI uses one listening caption. */
export function voiceEndpointCaption(
  endpointState?: VoiceEndpointState,
  vadState?: VadState,
): string {
  if (endpointState === "standby" && vadState === "silence") return "Pronto";
  return "Ti ascolto";
}

/** A transcript is always a draft until the user explicitly sends it. */
export function decideVoiceSubmit(input: {
  status: VoiceRequestStatusView["status"];
  hasTranscript: boolean;
  autoSubmit: boolean;
  chatBusy: boolean;
  alreadyClaimed: boolean;
}): VoiceSubmitDecision {
  if (input.status !== "transcript_ready" || !input.hasTranscript || input.alreadyClaimed) {
    return "ignore";
  }
  // `autoSubmit` remains in the input for persisted/API compatibility. The
  // manual interaction contract deliberately ignores it so a stale legacy
  // setting can never send a transcript behind the user's back.
  void input.autoSubmit;
  void input.chatBusy;
  return "manual";
}

export function shouldAutoSpeak(settings: { enabled: boolean; autoSpeak: boolean; privacyConsent: boolean; privacyConsentAt?: string }): boolean {
  return settings.enabled && settings.autoSpeak && settings.privacyConsent && Boolean(settings.privacyConsentAt);
}

/** Kept as a compatibility seam; manual capture never interrupts TTS. */
