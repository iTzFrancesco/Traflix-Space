import { useCallback, useEffect, useMemo, useRef } from "react";
import { Mic, MicOff, SendHorizontal, Settings, X } from "lucide-react";
import { JarvisOrb } from "./JarvisOrb";
import { JarvisActivityLoader } from "./JarvisActivityLoader";
import { clampWidgetPosition, positionFromRect } from "../../lib/jarvis/position";
import {
  collapsedJarvisStatus,
  hasOpenActivity,
  jarvisStepLabel,
  type ActivityCheckpoint,
} from "../../lib/jarvis/activityState";
import {
  shouldShowVoiceSendControl,
  voiceEndpointCaption,
} from "../../lib/jarvis/voiceState";
import {
  currentCodexTool,
  isCodexTurnActive,
  latestCodexMessage,
} from "../../lib/jarvis/chatState";
import {
  isJarvisOwnerModeReady,
  ownerModeJarvisSettings,
} from "../../lib/jarvis/settings";
import { useJarvisStore } from "../../stores/jarvisStore";
import type {
  JarvisRequestState,
  PendingAction,
  TtsStatusView,
  VoiceActivationMode,
  VoiceRequestStatusView,
  VoiceSubmitState,
  WakeWordStatusView,
  WidgetPosition,
} from "../../lib/jarvis/types";

interface JarvisWidgetProps {
  workspaceId: string | null;
  workspaceName: string | null;
  pendingActions: PendingAction[];
  requests: Record<string, JarvisRequestState>;
  chatError: string | null;
  voiceError: string | null;
  muted: boolean;
  wakeWordStatus: WakeWordStatusView | null;
  onOpenSettings: () => void;
  onHide: () => void;
  onToggleMuted: () => Promise<void> | void;
  voiceRequest: VoiceRequestStatusView | null;
  voiceSubmitState?: VoiceSubmitState;
  bargeIn: boolean;
  activationMode: VoiceActivationMode;
  onVoiceStart: () => Promise<void> | void;
  onVoiceStop: () => void;
  onVoiceSend: () => void;
  ttsStatus: TtsStatusView;
  activities: ActivityCheckpoint[];
}

type DragIntent = {
  pointerId: number;
  activated: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
};

const DRAG_START_DISTANCE = 5;

export function JarvisWidget(props: JarvisWidgetProps) {
  const position = useJarvisStore(
    (state) => state.settings.jarvis.widgetPosition,
  );
  const jarvisSettings = useJarvisStore((state) => state.settings.jarvis);
  const setDragging = useJarvisStore((state) => state.setDragging);
  const updateWidgetPosition = useJarvisStore(
    (state) => state.updateWidgetPosition,
  );
  const updateJarvisSettings = useJarvisStore(
    (state) => state.updateJarvisSettings,
  );
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragIntentRef = useRef<DragIntent | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousVoiceStatusRef = useRef<
    VoiceRequestStatusView["status"] | null
  >(null);
  const onVoiceStopRef = useRef(props.onVoiceStop);
  onVoiceStopRef.current = props.onVoiceStop;

  const ownerModeReady = isJarvisOwnerModeReady(jarvisSettings);

  const ensureOwnerMode = useCallback(async () => {
    const current = useJarvisStore.getState().settings.jarvis;
    if (isJarvisOwnerModeReady(current)) return;
    await updateJarvisSettings(ownerModeJarvisSettings);
  }, [updateJarvisSettings]);

  useEffect(() => {
    if (!ownerModeReady) void ensureOwnerMode();
  }, [ensureOwnerMode, ownerModeReady]);

  useEffect(() => {
    const handleResize = () => {
      const element = widgetRef.current;
      if (!element) return;
      const next = clampWidgetPosition(
        position,
        { width: window.innerWidth, height: window.innerHeight },
        { width: element.offsetWidth, height: element.offsetHeight },
      );
      applyPosition(element, next);
      if (!samePosition(next, position)) void updateWidgetPosition(next);
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [position, updateWidgetPosition]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      audioContextRef.current?.close().catch(() => undefined);
    },
    [],
  );

  const getAudioContext = useCallback(() => {
    try {
      const WebAudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!WebAudioContext) return null;
      const context = audioContextRef.current ?? new WebAudioContext();
      audioContextRef.current = context;
      void context.resume();
      return context;
    } catch {
      return null;
    }
  }, []);

  const playCue = useCallback(
    (kind: "start" | "stop") => {
      const context = getAudioContext();
      if (!context) return;
      try {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const now = context.currentTime;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(kind === "start" ? 610 : 790, now);
        oscillator.frequency.exponentialRampToValueAtTime(
          kind === "start" ? 860 : 500,
          now + 0.095,
        );
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.07, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.125);
      } catch {
        // Cues are feedback only. Never block the actual microphone flow.
      }
    },
    [getAudioContext],
  );

  useEffect(() => {
    const status = props.voiceRequest?.status ?? null;
    const previous = previousVoiceStatusRef.current;
    const wasListening = previous === "recording";
    const isListening = status === "recording";
    if (!wasListening && isListening) playCue("start");
    if (wasListening && !isListening) playCue("stop");
    previousVoiceStatusRef.current = status;
  }, [playCue, props.voiceRequest?.status]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element &&
        event.target.closest("[data-jarvis-control]"))
    ) {
      return;
    }
    const element = widgetRef.current;
    if (!element) return;

    dragCleanupRef.current?.();

    const rect = element.getBoundingClientRect();
    const intent: DragIntent = {
      pointerId: event.pointerId,
      activated: false,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: rect.left + rect.width / 2 - event.clientX,
      offsetY: rect.top + rect.height / 2 - event.clientY,
    };
    dragIntentRef.current = intent;

    let finished = false;
    const cleanupListeners = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      window.removeEventListener("blur", handleCancel);
    };

    const finish = (persist: boolean) => {
      if (finished) return;
      finished = true;
      cleanupListeners();
      dragIntentRef.current = null;
      dragCleanupRef.current = null;
      delete element.dataset.jarvisDragging;

      if (!intent.activated) return;
      setDragging(false);
      if (!persist) {
        applyPosition(element, position);
        return;
      }
      void updateWidgetPosition(
        clampWidgetPosition(
          positionFromRect(element.getBoundingClientRect(), {
            width: window.innerWidth,
            height: window.innerHeight,
          }),
          { width: window.innerWidth, height: window.innerHeight },
          { width: element.offsetWidth, height: element.offsetHeight },
        ),
      );
    };

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== intent.pointerId || finished) return;
      const distance = Math.hypot(
        moveEvent.clientX - intent.startX,
        moveEvent.clientY - intent.startY,
      );

      if (!intent.activated) {
        if (distance < DRAG_START_DISTANCE) return;
        intent.activated = true;
        setDragging(true);
        element.dataset.jarvisDragging = "true";
      }

      moveEvent.preventDefault();
      const next = clampWidgetPosition(
        {
          x: (moveEvent.clientX + intent.offsetX) / window.innerWidth,
          y: (moveEvent.clientY + intent.offsetY) / window.innerHeight,
        },
        { width: window.innerWidth, height: window.innerHeight },
        { width: element.offsetWidth, height: element.offsetHeight },
      );
      applyPosition(element, next);
    };

    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== intent.pointerId) return;
      finish(true);
    };
    const handleCancel = () => finish(false);

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    window.addEventListener("blur", handleCancel);

    dragCleanupRef.current = () => finish(false);
  };

  const activeRequests = Object.values(props.requests).filter(
    (request) =>
      request.workspaceId === props.workspaceId &&
      (request.status === "running" ||
        request.status === "cancellation_requested"),
  ).length;
  const speaking =
    props.ttsStatus.status === "synthesizing" ||
    props.ttsStatus.status === "playing";
  const jarvisActive = hasOpenActivity(
    props.activities,
    props.workspaceId,
    props.pendingActions,
  );
  const voiceArmed = props.voiceRequest?.status === "armed";
  const voiceListening = props.voiceRequest?.status === "recording";
  const voiceBusy =
    props.voiceRequest?.status === "transcribing" ||
    props.voiceRequest?.status === "stopping" ||
    props.voiceRequest?.status === "transcript_ready";
  const voiceStatusLabel =
    props.voiceRequest?.status === "armed"
      ? voiceEndpointCaption("standby")
      : props.voiceRequest?.status === "recording"
        ? voiceEndpointCaption(
            props.voiceRequest.endpointState,
            props.voiceRequest.vadState,
          )
      : props.voiceRequest?.status === "stopping"
        ? "Preparazione invio…"
        : props.voiceRequest?.status === "transcribing"
          ? "Trascrizione…"
          : props.voiceRequest?.status === "transcript_ready" && props.voiceSubmitState === "queued"
            ? "In coda · invio appena libero"
            : props.voiceRequest?.status === "transcript_ready" && props.voiceSubmitState === "submitting"
              ? "Invio a Jarvis…"
            : props.voiceRequest?.status === "transcript_ready"
              ? "Pronto · premi Invia"
              : null;
  // TTS barge-in stays hands-free: the send control appears only after a
  // normal recording starts, never while Jarvis is still speaking.
  const voiceBargeIn = props.bargeIn || (voiceListening && speaking);
  // The backend already exposes a calibrated 0..1 RMS meter. Do not amplify
  // it again: that made ordinary speech and room noise look clipped.
  const level = Math.max(0, Math.min(1, props.voiceRequest?.normalizedLevel ?? 0));

  const codexStreamingTurns = useJarvisStore(
    (state) => state.codexStreamingTurns,
  );
  const codexTool = useMemo(
    () => currentCodexTool(codexStreamingTurns, props.workspaceId),
    [codexStreamingTurns, props.workspaceId],
  );
  const codexTurnActive = useMemo(
    () => isCodexTurnActive(codexStreamingTurns, props.workspaceId),
    [codexStreamingTurns, props.workspaceId],
  );
  const codexMessage = useMemo(
    () => latestCodexMessage(codexStreamingTurns, props.workspaceId),
    [codexStreamingTurns, props.workspaceId],
  );
  const stepLabel = jarvisStepLabel({
    workspaceId: props.workspaceId,
    voiceRequest: props.voiceRequest,
    ttsStatus: props.ttsStatus,
    activities: props.activities,
    pendingActions: props.pendingActions,
    codexTool,
    codexTurnActive,
    codexMessage,
  });
  const displayedStepLabel = voiceStatusLabel ?? stepLabel;

  // Manual submission remains a dedicated action. The mute button never
  // doubles as stop/send, start capture, or hold-to-talk.
  const handleSendNow = () => {
    console.info("[Jarvis voice] manual stop/send", {
      requestId: props.voiceRequest?.requestId,
      workspaceId: props.workspaceId,
    });
    if (props.voiceRequest?.status === "transcript_ready") {
      props.onVoiceSend();
    } else {
      onVoiceStopRef.current();
    }
  };

  const microphoneTitle = props.muted
    ? "Riattiva il microfono di Jarvis"
    : "Disattiva il microfono di Jarvis";

  const active =
    activeRequests > 0 || speaking || jarvisActive || voiceArmed || voiceListening || voiceBusy;
  const statusLabel = props.voiceError
    ? props.voiceError
    : props.muted
      ? "Microfono disattivato"
      : props.wakeWordStatus?.state === "fallback" && props.wakeWordStatus.enabled
        ? "Wake word · fallback VAD locale"
      : props.wakeWordStatus?.state === "unavailable" && props.wakeWordStatus.enabled
        ? `Wake word non disponibile · ${
            props.activationMode === "vad" ? "VAD attivo" : "attivazione manuale"
          }`
      : voiceStatusLabel ?? collapsedJarvisStatus({
        workspaceId: props.workspaceId,
        workspaceName: props.workspaceName,
        voiceError: props.voiceError,
        voiceRequest: props.voiceRequest,
        ttsStatus: props.ttsStatus,
        requests: props.requests,
        pendingActions: props.pendingActions,
        activities: props.activities,
      });

  return (
    <div
      ref={widgetRef}
      className="fixed z-40 select-none"
      style={{
        left: `${position.x * 100}%`,
        top: `${position.y * 100}%`,
        transform: "translate(-50%, -50%)",
        touchAction: "none",
      }}
    >
      <div
        className={`jarvis-pill cursor-grab ${props.muted ? "jarvis-pill--muted" : ""} ${voiceListening ? "jarvis-pill--listening" : ""} ${speaking ? "jarvis-pill--speaking" : ""}`}
        style={{ "--jarvis-level": level } as React.CSSProperties}
        onPointerDown={handlePointerDown}
        title="Premi e trascina per spostare Jarvis"
        aria-label={`Jarvis · ${displayedStepLabel ?? statusLabel}`}
        role="status"
        aria-live={props.voiceError ? "assertive" : "polite"}
      >
        <JarvisOrb active={active} listening={voiceListening} speaking={speaking} muted={props.muted} />

        <div className="min-w-0 flex-1">
          {displayedStepLabel ? (
            <JarvisActivityLoader label={displayedStepLabel} />
          ) : (
            <p
              className="truncate text-[11px] font-semibold leading-none tracking-[0.01em] text-neutral-text"
              title={`Jarvis · ${statusLabel}`}
            >
              Jarvis · {statusLabel}
            </p>
          )}
        </div>

        <div className="jarvis-controls" data-jarvis-control-group>
          {(voiceArmed || voiceListening) && (
            <VoiceMeter
              level={level}
              listening={voiceListening}
              endpointState={props.voiceRequest?.endpointState}
            />
          )}
          {shouldShowVoiceSendControl({
            voiceListening,
            transcriptReady: props.voiceRequest?.status === "transcript_ready",
            bargeIn: voiceBargeIn,
          }) && (
            <button
              type="button"
              data-jarvis-control
              onClick={handleSendNow}
              className="jarvis-control jarvis-control--send jarvis-control--listening"
              title={voiceListening ? "Termina ascolto e invia ora" : "Invia ora"}
              aria-label={voiceListening ? "Termina ascolto e invia ora" : "Invia ora"}
            >
              <SendHorizontal size={15} />
              <span>{voiceListening ? "Termina e invia" : "Invia ora"}</span>
            </button>
          )}
          <button
            type="button"
            data-jarvis-control
            onClick={() => void props.onToggleMuted()}
            className={`jarvis-control ${props.muted ? "jarvis-control--muted" : ""}`}
            title={microphoneTitle}
            aria-label={microphoneTitle}
            aria-pressed={props.muted}
          >
            {props.muted ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          <button
            type="button"
            data-jarvis-control
            onClick={props.onOpenSettings}
            className="jarvis-control"
            title="Impostazioni di Jarvis"
            aria-label="Impostazioni di Jarvis"
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            data-jarvis-control
            onClick={props.onHide}
            className="jarvis-control"
            title="Nascondi Jarvis"
            aria-label="Nascondi Jarvis"
          >
            <X size={15} />
          </button>
        </div>
      </div>
      {props.chatError && (
        <p className="mt-1 max-w-[min(340px,calc(100vw-32px))] px-1 text-[11px] leading-snug text-red-400" role="alert">
          {props.chatError}
        </p>
      )}
    </div>
  );
}

function VoiceMeter({
  level,
  listening,
  endpointState,
}: {
  level: number;
  listening: boolean;
  endpointState?: VoiceRequestStatusView["endpointState"];
}) {
  const visibleLevel = Math.max(0, Math.min(1, level));
  const factors = [0.42, 0.72, 1, 0.72, 0.42];
  return (
    <span
      className={`jarvis-level-meter ${listening ? "jarvis-level-meter--active" : ""} ${endpointState === "pause" ? "jarvis-level-meter--pause" : ""} ${endpointState === "breath" ? "jarvis-level-meter--breath" : ""} ${endpointState === "micro_interruption" ? "jarvis-level-meter--micro" : ""} ${endpointState === "finalizing" ? "jarvis-level-meter--finalizing" : ""}`}
      aria-label={`Livello microfono ${Math.round(visibleLevel * 100)}%, ${voiceEndpointCaption(endpointState)}`}
      role="img"
    >
      {factors.map((factor, index) => (
        <span
          key={factor}
          style={{
            transform: `scaleY(${Math.max(0.14, visibleLevel * factor)})`,
            transitionDelay: `${index * 12}ms`,
          }}
        />
      ))}
    </span>
  );
}

function applyPosition(element: HTMLElement, position: WidgetPosition) {
  element.style.left = `${position.x * 100}%`;
  element.style.top = `${position.y * 100}%`;
}

function samePosition(left: WidgetPosition, right: WidgetPosition) {
  return (
    Math.abs(left.x - right.x) < 0.0001 &&
    Math.abs(left.y - right.y) < 0.0001
  );
}
