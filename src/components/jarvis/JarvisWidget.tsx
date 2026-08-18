import { useCallback, useEffect, useMemo, useRef } from "react";
import { Settings, X } from "lucide-react";
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
  isVoiceCaptureBusy,
  voiceUiLabel,
  voiceUiPhase,
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
  VoiceRequestStatusView,
  VoiceSubmitState,
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
  onOpenSettings: () => void;
  onHide: () => void;
  voiceRequest: VoiceRequestStatusView | null;
  voiceSubmitState?: VoiceSubmitState;
  onVoiceToggle: () => Promise<void> | void;
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
  const voicePhase = voiceUiPhase(props.voiceRequest, props.muted);
  const voiceArmed = props.voiceRequest?.status === "armed" && !props.muted;
  const voiceListening = props.voiceRequest?.status === "recording" && !props.muted;
  const voiceBusy = isVoiceCaptureBusy(props.voiceRequest, props.muted);
  // The click-toggle contract is a persistent UI state: both the initial
  // armed phase and active recording must survive pointer leave.
  const voiceEngaged = voiceArmed || voiceListening;
  const voiceProcessing = voiceBusy && !voiceEngaged;
  const voiceDraftReady = voicePhase === "draft";
  const voiceStatusLabel = props.muted
    ? null
    : voicePhase === "draft" && props.voiceSubmitState === "queued"
      ? "In coda · invio appena libero"
      : voicePhase === "draft" && props.voiceSubmitState === "submitting"
        ? "Invio a Jarvis…"
        : voiceUiLabel(props.voiceRequest, props.muted);

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

  const voiceToggleLabel = voiceListening || voiceArmed
    ? "Termina ascolto e invia a Jarvis"
    : voiceBusy
      ? "Jarvis sta elaborando la voce"
      : "Avvia ascolto manuale di Jarvis";

  const active =
    !props.muted &&
    (activeRequests > 0 || speaking || jarvisActive || voiceEngaged || voiceBusy);
  const statusLabel = props.voiceError
    ? props.voiceError
    : props.muted
      ? "Microfono disattivato"
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

  const displayedStepLabel = props.muted ? null : voiceStatusLabel ?? stepLabel;
  // A label can remain in the stream after a turn completes. The compact pill
  // must not turn that historical text into a perpetual activity animation.
  const showActivityLoader = Boolean(
    displayedStepLabel &&
      active &&
      voicePhase !== "listening" &&
      !voiceDraftReady,
  );

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
        className={`jarvis-pill cursor-grab ${props.muted ? "jarvis-pill--muted" : ""} ${voiceEngaged ? "jarvis-pill--listening" : ""} ${voiceProcessing ? "jarvis-pill--processing" : ""} ${speaking ? "jarvis-pill--speaking" : ""}`}
        style={{ "--jarvis-level": level } as React.CSSProperties}
        onPointerDown={handlePointerDown}
        title="Premi e trascina per spostare Jarvis"
        aria-label={`Jarvis · ${displayedStepLabel ?? statusLabel}`}
        role="status"
        aria-live={props.voiceError ? "assertive" : "polite"}
      >
        <button
          type="button"
          data-jarvis-control
          onClick={() => void props.onVoiceToggle()}
          className={`jarvis-control jarvis-control--orb ${voiceEngaged ? "jarvis-control--engaged" : ""} ${voiceListening ? "jarvis-control--listening" : ""} ${voiceProcessing ? "jarvis-control--processing" : ""}`}
          title={voiceToggleLabel}
          aria-label={voiceToggleLabel}
          aria-pressed={voiceEngaged}
        >
          <JarvisOrb
            active={active}
            engaged={voiceEngaged}
            listening={voiceListening}
            processing={voiceProcessing}
            speaking={speaking}
            muted={props.muted}
          />
        </button>

        <div className="min-w-0 flex-1">
          {showActivityLoader ? (
            <JarvisActivityLoader label={displayedStepLabel ?? ""} />
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
            />
          )}
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
}: {
  level: number;
  listening: boolean;
}) {
  const visibleLevel = Math.max(0, Math.min(1, level));
  const factors = [0.42, 0.72, 1, 0.72, 0.42];
  return (
    <span
      className={`jarvis-level-meter ${listening ? "jarvis-level-meter--active" : ""}`}
      aria-label={`Livello microfono ${Math.round(visibleLevel * 100)}%`}
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
