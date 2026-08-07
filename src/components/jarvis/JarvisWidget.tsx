import { useCallback, useEffect, useRef } from "react";
import { Mic, MicOff, Settings, X } from "lucide-react";
import { JarvisOrb } from "./JarvisOrb";
import { clampWidgetPosition, positionFromRect } from "../../lib/jarvis/position";
import {
  collapsedJarvisStatus,
  hasOpenActivity,
  type ActivityCheckpoint,
} from "../../lib/jarvis/activityState";
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
  onToggleMuted: () => Promise<void> | void;
  voiceRequest: VoiceRequestStatusView | null;
  activationMode: VoiceActivationMode;
  onVoiceStart: () => Promise<void> | void;
  onVoiceStop: () => void;
  ttsStatus: TtsStatusView;
  activities: ActivityCheckpoint[];
}

type DragIntent = {
  pointerId: number;
  armed: boolean;
  activated: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
};

// Traflix Voice lets the native mouse-up own the end of a drag. Space keeps
// the widget inside the main window, so we mirror that lifecycle with global
// listeners instead of pointer capture: hold briefly, move, release anywhere.
const DRAG_HOLD_MS = 220;
const DRAG_START_DISTANCE = 5;
const EARLY_MOVE_CANCEL_DISTANCE = 14;

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
  const dragTimerRef = useRef<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousVoiceStatusRef = useRef<
    VoiceRequestStatusView["status"] | null
  >(null);
  const holdPressedRef = useRef(false);
  const holdGestureHandledRef = useRef(false);
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
      if (dragTimerRef.current !== null) {
        window.clearTimeout(dragTimerRef.current);
      }
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

  const clearDragTimer = () => {
    if (dragTimerRef.current === null) return;
    window.clearTimeout(dragTimerRef.current);
    dragTimerRef.current = null;
  };

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
    clearDragTimer();

    const rect = element.getBoundingClientRect();
    const intent: DragIntent = {
      pointerId: event.pointerId,
      armed: false,
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
      clearDragTimer();
      cleanupListeners();
      dragIntentRef.current = null;
      dragCleanupRef.current = null;
      delete element.dataset.jarvisDragging;
      delete element.dataset.jarvisDragArmed;

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

      if (!intent.armed) {
        if (distance >= EARLY_MOVE_CANCEL_DISTANCE) clearDragTimer();
        return;
      }
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

    dragTimerRef.current = window.setTimeout(() => {
      if (finished || dragIntentRef.current !== intent) return;
      intent.armed = true;
      element.dataset.jarvisDragArmed = "true";
      dragTimerRef.current = null;
    }, DRAG_HOLD_MS);

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
  const ttsFailed = props.ttsStatus.status === "failed";
  const jarvisActive = hasOpenActivity(
    props.activities,
    props.workspaceId,
    props.pendingActions,
  );
  const rawStatusText = collapsedJarvisStatus({
    workspaceId: props.workspaceId,
    workspaceName: props.workspaceName,
    voiceError: props.voiceError,
    voiceRequest: props.voiceRequest,
    ttsStatus: props.ttsStatus,
    requests: props.requests,
    pendingActions: props.pendingActions,
    activities: props.activities,
  });
  const voiceArmed = props.voiceRequest?.status === "armed";
  const voiceListening = props.voiceRequest?.status === "recording";
  const voiceBusy =
    props.voiceRequest?.status === "transcribing" ||
    props.voiceRequest?.status === "stopping";
  const statusText = props.muted
    ? "Microphone muted"
    : props.voiceError
      ? "Audio setup needed"
      : props.chatError
        ? "Jarvis unavailable"
        : ttsFailed
          ? "Voice unavailable"
          : voiceArmed
            ? "Ready when you are"
            : rawStatusText;
  const level = Math.max(
    0,
    Math.min(1, props.voiceRequest?.normalizedLevel ?? 0),
  );

  const handleMicrophoneClick = async () => {
    if (
      props.activationMode === "hold_to_talk" &&
      holdGestureHandledRef.current
    ) {
      holdGestureHandledRef.current = false;
      return;
    }
    getAudioContext();
    await ensureOwnerMode();
    await props.onToggleMuted();
  };

  const releaseHeldVoice = () => {
    if (!holdPressedRef.current) return;
    holdPressedRef.current = false;
    holdGestureHandledRef.current = true;
    onVoiceStopRef.current();
  };

  useEffect(() => {
    if (props.activationMode !== "hold_to_talk") return;
    window.addEventListener("blur", releaseHeldVoice);
    document.addEventListener("visibilitychange", releaseHeldVoice);
    return () => {
      window.removeEventListener("blur", releaseHeldVoice);
      document.removeEventListener("visibilitychange", releaseHeldVoice);
      releaseHeldVoice();
    };
  }, [props.activationMode]);

  const handleVoicePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (props.activationMode !== "hold_to_talk" || props.muted) return;
    event.preventDefault();
    getAudioContext();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!voiceListening && !voiceBusy && !holdPressedRef.current) {
      holdPressedRef.current = true;
      holdGestureHandledRef.current = false;
      void ensureOwnerMode()
        .then(() => props.onVoiceStart())
        .then(() => {
          if (!holdPressedRef.current) props.onVoiceStop();
        });
    }
  };

  const handleVoicePointerUp = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (props.activationMode !== "hold_to_talk") return;
    event.preventDefault();
    const wasPressed = holdPressedRef.current;
    holdPressedRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (wasPressed) {
      holdGestureHandledRef.current = true;
      props.onVoiceStop();
    }
  };

  const handleVoiceKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      props.activationMode !== "hold_to_talk" ||
      props.muted ||
      (event.key !== " " && event.key !== "Enter") ||
      event.repeat
    ) {
      return;
    }
    event.preventDefault();
    getAudioContext();
    if (!voiceListening && !voiceBusy && !holdPressedRef.current) {
      holdPressedRef.current = true;
      holdGestureHandledRef.current = false;
      void ensureOwnerMode()
        .then(() => props.onVoiceStart())
        .then(() => {
          if (!holdPressedRef.current) props.onVoiceStop();
        });
    }
  };

  const handleVoiceKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      props.activationMode !== "hold_to_talk" ||
      (event.key !== " " && event.key !== "Enter")
    ) {
      return;
    }
    event.preventDefault();
    const wasPressed = holdPressedRef.current;
    holdPressedRef.current = false;
    if (wasPressed) {
      holdGestureHandledRef.current = true;
      props.onVoiceStop();
    }
  };

  const active =
    activeRequests > 0 || speaking || jarvisActive || voiceListening || voiceBusy;
  const helperText = props.muted
    ? "Click the microphone to resume"
    : props.voiceError
      ? "Open settings to check microphone and Groq"
      : props.chatError
        ? "Retry, or check OpenCode Zen in settings"
        : ttsFailed
          ? "Check voice output in settings"
          : voiceListening
            ? "Listening · silence sends automatically"
            : voiceArmed
              ? "Always ready · speak normally"
              : speaking
                ? "Jarvis is speaking"
                : props.workspaceName ?? "Jarvis";

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
        className={`jarvis-pill cursor-grab ${voiceListening ? "jarvis-pill--listening" : ""} ${speaking ? "jarvis-pill--speaking" : ""}`}
        style={{ "--jarvis-level": level } as React.CSSProperties}
        onPointerDown={handlePointerDown}
        title="Hold briefly, then drag to reposition Jarvis"
      >
        <JarvisOrb active={active} listening={voiceListening} speaking={speaking} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-semibold leading-none text-neutral-text">
              {statusText}
            </p>
            {voiceListening && <VoiceMeter level={level} />}
          </div>
          <p className="mt-1 truncate text-[10px] leading-none text-neutral-text-muted">
            {helperText}
          </p>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            data-jarvis-control
            onClick={() => void handleMicrophoneClick()}
            onPointerDown={handleVoicePointerDown}
            onPointerUp={handleVoicePointerUp}
            onPointerCancel={handleVoicePointerUp}
            onBlur={releaseHeldVoice}
            onKeyDown={handleVoiceKeyDown}
            onKeyUp={handleVoiceKeyUp}
            className={`jarvis-control ${props.muted ? "bg-danger/[0.10] text-danger hover:bg-danger/[0.14] hover:text-danger" : voiceListening ? "jarvis-control--listening" : ""}`}
            title={props.muted ? "Unmute Jarvis microphone" : "Mute Jarvis microphone"}
            aria-label={props.muted ? "Unmute Jarvis microphone" : "Mute Jarvis microphone"}
            aria-pressed={props.muted}
          >
            {props.muted ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          <button
            type="button"
            data-jarvis-control
            onClick={props.onOpenSettings}
            className={`jarvis-control ${props.voiceError || props.chatError || ttsFailed ? "text-warning" : ""}`}
            title="Jarvis settings"
            aria-label="Jarvis settings"
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            data-jarvis-control
            onClick={props.onHide}
            className="jarvis-control"
            title="Hide Jarvis"
            aria-label="Hide Jarvis"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function VoiceMeter({ level }: { level: number }) {
  const visibleLevel = Math.max(0.08, Math.min(1, level * 3.2));
  return (
    <span className="jarvis-level-meter" aria-hidden="true">
      {[0.45, 0.8, 1, 0.68].map((factor, index) => (
        <span
          key={factor}
          style={{
            transform: `scaleY(${Math.max(0.22, visibleLevel * factor)})`,
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
