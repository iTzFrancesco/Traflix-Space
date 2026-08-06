import type { VoiceRequestStatusView } from "./types";

export function voiceRequestForWorkspace(request: VoiceRequestStatusView | null, workspaceId: string | null): VoiceRequestStatusView | null {
  return request && request.workspaceId === workspaceId ? request : null;
}

export function canSendTranscript(request: VoiceRequestStatusView | null, workspaceId: string | null, text: string): boolean {
  return Boolean(request && request.status === "transcript_ready" && request.workspaceId === workspaceId && text.trim());
}

export function shouldAutoSpeak(settings: { enabled: boolean; autoSpeak: boolean; privacyConsent: boolean; privacyConsentAt?: string }): boolean {
  return settings.enabled && settings.autoSpeak && settings.privacyConsent && Boolean(settings.privacyConsentAt);
}

export function shouldStopTtsBeforeRecording(ttsStatus: string): boolean {
  return ttsStatus === "playing" || ttsStatus === "synthesizing";
}
