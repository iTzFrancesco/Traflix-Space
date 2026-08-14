import type { VadState, VoiceEndpointState, VoiceRequestStatusView } from "./types";

export type VoiceSubmitDecision = "ignore" | "manual" | "queue" | "send";

export function voiceRequestForWorkspace(request: VoiceRequestStatusView | null, workspaceId: string | null): VoiceRequestStatusView | null {
  return request && request.workspaceId === workspaceId ? request : null;
}

export function voiceDraftsForWorkspaces(requests: Record<string, VoiceRequestStatusView>, workspaceId: string | null): VoiceRequestStatusView[] {
  return workspaceId ? Object.values(requests).filter((request) => request.workspaceId === workspaceId) : [];
}

export function canSendTranscript(request: VoiceRequestStatusView | null, workspaceId: string | null, text: string): boolean {
  return Boolean(request && request.status === "transcript_ready" && request.workspaceId === workspaceId && text.trim());
}

export function shouldShowVoiceSendControl(input: {
  voiceListening: boolean;
  transcriptReady: boolean;
  bargeIn: boolean;
}): boolean {
  return !input.bargeIn && (input.voiceListening || input.transcriptReady);
}

/**
 * Stable, action-oriented caption for the meter. The wording makes it clear
 * that a pause is still inside the current turn and that finalizing is only a
 * protected candidate, not an already-sent transcript.
 */
export function voiceEndpointCaption(
  endpointState?: VoiceEndpointState,
  vadState?: VadState,
): string {
  const state = endpointState ?? (vadState === "silence" ? "pause" : undefined);
  switch (state) {
    case "standby":
      return "Pronto · rumore filtrato";
    case "pause":
      return "Pausa naturale · continuo ad ascoltare";
    case "breath":
      return "Respiro · tengo aperto l'ascolto";
    case "micro_interruption":
      return "Micro-interruzione · verifico la ripresa";
    case "finalizing":
      return "Fine frase · attendo il silenzio";
    case "speaking":
      return "Ti ascolto";
    default:
      return "Ti ascolto";
  }
}

/** Submit policy is intentionally independent from microphone VAD/endpointing. */
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
  if (!input.autoSubmit) return "manual";
  return input.chatBusy ? "queue" : "send";
}

export function shouldAutoSpeak(settings: { enabled: boolean; autoSpeak: boolean; privacyConsent: boolean; privacyConsentAt?: string }): boolean {
  return settings.enabled && settings.autoSpeak && settings.privacyConsent && Boolean(settings.privacyConsentAt);
}

export function shouldStopTtsBeforeRecording(ttsStatus: string): boolean {
  return ttsStatus === "playing" || ttsStatus === "synthesizing";
}
