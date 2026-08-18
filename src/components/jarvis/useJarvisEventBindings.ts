import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  TtsStatusView,
  VoiceLevelEvent,
  VoiceRequestStatusView,
  WakeWordStatusView,
} from "../../lib/jarvis/types";
import type { ActivityCheckpoint } from "../../lib/jarvis/activityState";
import {
  reportFrontendDiagnostic,
  reportFrontendDiagnosticCode,
} from "../../lib/crashDiagnostics";

interface UseJarvisEventBindingsOptions {
  applyActivityEvents: (events: ActivityCheckpoint[]) => void;
  setTtsStatus: (status: TtsStatusView) => void;
  setWakeWordStatus: (status: WakeWordStatusView) => void;
  setVoiceLevel: (event: VoiceLevelEvent) => void;
  setVoiceRequest: (status: VoiceRequestStatusView) => void;
}

export function useJarvisEventBindings({
  applyActivityEvents,
  setTtsStatus,
  setWakeWordStatus,
  setVoiceLevel,
  setVoiceRequest,
}: UseJarvisEventBindingsOptions): void {
  useEffect(() => {
    let disposed = false;
    const listeners = Promise.allSettled([
      listen<WakeWordStatusView>("jarvis://wake-state", (event) => {
        if (!disposed) setWakeWordStatus(event.payload);
      }),
      listen<VoiceRequestStatusView>("jarvis://voice-state", (event) => {
        if (disposed) return;
        console.info("[Jarvis voice] frontend state event", {
          requestId: event.payload.requestId,
          workspaceId: event.payload.workspaceId,
          status: event.payload.status,
          errorCode: event.payload.error?.code,
          transcriptChars: event.payload.transcript?.length ?? 0,
        });
        if (event.payload.status === "failed" && event.payload.error?.code) {
          reportFrontendDiagnosticCode(
            "jarvis-voice-error",
            event.payload.error.code,
            {
              requestId: event.payload.requestId,
              workspaceId: event.payload.workspaceId ?? undefined,
              state: "failed",
            },
          );
        }
        setVoiceRequest(event.payload);
      }),
      listen<VoiceLevelEvent>("jarvis://voice-level", (event) => {
        if (!disposed) setVoiceLevel(event.payload);
      }),
      listen<TtsStatusView>("jarvis://tts-state", (event) => {
        if (disposed) return;
        console.info("[Jarvis TTS] frontend state event", {
          requestId: event.payload.requestId,
          workspaceId: event.payload.workspaceId,
          sequence: event.payload.sequence,
          status: event.payload.status,
          errorCode: event.payload.error?.code,
          errorMessage: event.payload.error?.message,
        });
        if (event.payload.status === "failed" && event.payload.error?.code) {
          reportFrontendDiagnosticCode(
            "jarvis-tts-error",
            event.payload.error.code,
            {
              requestId: event.payload.requestId,
              workspaceId: event.payload.workspaceId ?? undefined,
              state: "failed",
            },
          );
        }
        setTtsStatus(event.payload);
      }),
      listen<ActivityCheckpoint>("jarvis://activity", (event) => {
        if (!disposed) applyActivityEvents([event.payload]);
      }),
    ]).then((results) => {
      const active: Array<() => void> = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          active.push(result.value);
        } else {
          reportFrontendDiagnostic("jarvis-listener-error", result.reason, {
            state: "voice-events",
          });
          console.error("[Jarvis voice] event listener setup failed", result.reason);
        }
      }
      return active;
    });

    return () => {
      disposed = true;
      void listeners
        .then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
        .catch(() => undefined);
    };
  }, [
    applyActivityEvents,
    setTtsStatus,
    setWakeWordStatus,
    setVoiceLevel,
    setVoiceRequest,
  ]);
}
