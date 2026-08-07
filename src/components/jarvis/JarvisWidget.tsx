import { useCallback, useEffect, useRef } from "react";
import { LoaderCircle, Mic, Settings, Square, X } from "lucide-react";
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
  JarvisConversationMessage,
  JarvisProviderStatus,
  JarvisRequestState,
  JarvisUiIntent,
  PendingAction,
  TtsStatusView,
  VoiceActivationMode,
  VoiceRequestStatusView,
  WidgetPosition,
} from "../../lib/jarvis/types";

interface JarvisWidgetProps {
  workspaceId: string | null;
  workspaceName: string | null;
  conversation: JarvisConversationMessage[];
  pendingActions: PendingAction[];
  requests: Record<string, JarvisRequestState>;
  chatError: string | null;
  voiceError: string | null;
  providerStatus: JarvisProviderStatus | null;
  uiIntents: JarvisUiIntent[];
  followUps: string[];
  onOpenSettings: () => void;
  onHide: () => void;
  onSendMessage: (message: string) => void;
  onSendVoiceTranscript: (requestId: string, text: string) => Promise<void> | void;
  onCancelRequest: (requestId: string) => void;
  onConfirmAction: (action: PendingAction) => void;
  onRejectAction: (action: PendingAction) => void;
  onUpdateAction: (action: PendingAction, text: string) => Promise<PendingAction>;
  onOpenTerminal: (workspaceId: string, terminalId: string, generation: number) => void;
  voiceRequest: VoiceRequestStatusView | null;
  activationMode: VoiceActivationMode;
  onVoiceStart: () => Promise<void> | void;
  onVoiceStop: () => void;
  onVoiceCancel: () => void;
  onVoiceDiscard: () => void;
  ttsStatus: TtsStatusView;
  onStopTts: () => void;
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

const DRAG_HOLD_MS = 380;
const DRAG_START_DISTANCE = 6;
const EARLY_MOVE_CANCEL_DISTANCE = 12;

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
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousVoiceStatusRef = useRef<
    VoiceRequestStatusView["status"] | null
  >(null);
  const holdPressedRef = useRef(false);
  const onVoiceStopRef = useRef(props.onVoiceStop);
  onVoiceStopRef.current = props.onVoiceStop;

  // Voice is the product surface. These compatibility props remain wired to
  // the underlying conversational engine, but this component never renders a
  // transcript/chat/provider/debug drawer.
  void props.conversation;
  void props.providerStatus;
  void props.uiIntents;
  void props.followUps;
  void props.onSendMessage;
  void props.onSendVoiceTranscript;
  void props.onCancelRequest;
  void props.onConfirmAction;
  void props.onRejectAction;
  void props.onUpdateAction;
  void props.onOpenTerminal;
  void props.onVoiceCancel;
  void props.onVoiceDiscard;
  void props.onStopTts;

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
    const wasListening = previous === "recording" || previous === "armed";
    const isListening = status === "recording" || status === "armed";
    if (!wasListening && isListening) playCue("start");
    if (wasListening && !isListening) playCue("stop");
    previousVoiceStatusRef.current = status;
  }, [playCue, props.voiceRequest?.status]);

  const clearDragTimer = () => {
    if (dragTimerRef.current === null) return;
    window.clearTimeout(dragTimerRef.current);
    dragTimerRef.current = null;
  };

  const endDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    persist: boolean,
  ) => {
    clearDragTimer();
    const intent = dragIntentRef.current;
    const element = widgetRef.current;
    if (element?.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    dragIntentRef.current = null;
    if (!intent?.activated || intent.pointerId !== event.pointerId || !element) {
      return;
    }
    delete element.dataset.jarvisDragging;
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

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-jarvis-control]")
    ) {
      return;
    }
    const element = widgetRef.current;
    if (!element) return;
    clearDragTimer();
    const rect = element.getBoundingClientRect();
    dragIntentRef.current = {
      pointerId: event.pointerId,
      armed: false,
      activated: false,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: rect.left + rect.width / 2 - event.clientX,
      offsetY: rect.top + rect.height / 2 - event.clientY,
    };
    element.setPointerCapture(event.pointerId);
    dragTimerRef.current = window.setTimeout(() => {
      const intent = dragIntentRef.current;
      if (!intent || intent.pointerId !== event.pointerId) return;
      intent.armed = true;
      dragTimerRef.current = null;
    }, DRAG_HOLD_MS);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const intent = dragIntentRef.current;
    if (!intent || intent.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - intent.startX,
      event.clientY - intent.startY,
    );

    if (!intent.armed) {
      if (distance >= EARLY_MOVE_CANCEL_DISTANCE) clearDragTimer();
      return;
    }
    if (!intent.activated) {
      if (distance < DRAG_START_DISTANCE) return;
      intent.activated = true;
      setDragging(true);
      if (widgetRef.current) widgetRef.current.dataset.jarvisDragging = "true";
    }

    const element = widgetRef.current;
    if (!element) return;
    const next = clampWidgetPosition(
      {
        x: (event.clientX + intent.offsetX) / window.innerWidth,
        y: (event.clientY + intent.offsetY) / window.innerHeight,
      },
      { width: window.innerWidth, height: window.innerHeight },
      { width: element.offsetWidth, height: element.offsetHeight },
    );
    applyPosition(element, next);
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
  const statusText = props.voiceError
    ? "Audio setup needed"
    : props.chatError
      ? "Jarvis unavailable"
      : ttsFailed
        ? "Voice unavailable"
        : rawStatusText;
  const voiceActive =
    props.voiceRequest?.status === "recording" ||
    props.voiceRequest?.status === "armed";
  const voiceBusy =
    props.voiceRequest?.status === "transcribing" ||
    props.voiceRequest?.status === "stopping";
  const level = Math.max(
    0,
    Math.min(1, props.voiceRequest?.normalizedLevel ?? 0),
  );

  const handleVoiceClick = async () => {
    if (props.activationMode === "hold_to_talk") return;
    // Prime WebAudio inside the user gesture. The actual cue is emitted when
    // the backend confirms that recording started.
    getAudioContext();
    if (voiceActive) {
      props.onVoiceStop();
      return;
    }
    if (voiceBusy) return;
    await ensureOwnerMode();
    await props.onVoiceStart();
  };

  const releaseHeldVoice = () => {
    if (!holdPressedRef.current) return;
    holdPressedRef.current = false;
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
    if (props.activationMode !== "hold_to_talk") return;
    event.preventDefault();
    getAudioContext();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!voiceActive && !voiceBusy && !holdPressedRef.current) {
      holdPressedRef.current = true;
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
    if (wasPressed) props.onVoiceStop();
  };

  const handleVoiceKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      props.activationMode !== "hold_to_talk" ||
      (event.key !== " " && event.key !== "Enter") ||
      event.repeat
    ) {
      return;
    }
    event.preventDefault();
    getAudioContext();
    if (!voiceActive && !voiceBusy && !holdPressedRef.current) {
      holdPressedRef.current = true;
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
    if (wasPressed) props.onVoiceStop();
  };

  const active =
    activeRequests > 0 || speaking || jarvisActive || voiceActive || voiceBusy;
  const helperText = props.voiceError
    ? "Open settings to check microphone and Groq"
    : props.chatError
      ? "Retry, or check OpenCode Zen in settings"
      : ttsFailed
        ? "Check voice output in settings"
        : voiceActive
          ? "Speak normally · silence sends automatically"
          : speaking
            ? "You can interrupt me with the microphone"
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
        className={`jarvis-pill ${voiceActive ? "jarvis-pill--listening" : ""} ${speaking ? "jarvis-pill--speaking" : ""}`}
        style={{ "--jarvis-level": level } as React.CSSProperties}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        title="Hold, then move to reposition Jarvis"
      >
        <JarvisOrb active={active} listening={voiceActive} speaking={speaking} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-semibold leading-none text-neutral-text">
              {statusText}
            </p>
            {voiceActive && <VoiceMeter level={level} />}
          </div>
          <p className="mt-1 truncate text-[10px] leading-none text-neutral-text-muted">
            {helperText}
          </p>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            data-jarvis-control
            onClick={() => void handleVoiceClick()}
            onPointerDown={handleVoicePointerDown}
            onPointerUp={handleVoicePointerUp}
            onPointerCancel={handleVoicePointerUp}
            onBlur={releaseHeldVoice}
            onKeyDown={handleVoiceKeyDown}
            onKeyUp={handleVoiceKeyUp}
            className={`jarvis-control ${voiceActive ? "jarvis-control--listening" : ""}`}
            title={
              voiceActive
                ? "Stop now"
                : voiceBusy
                  ? "Transcribing"
                  : "Talk to Jarvis"
            }
            aria-label={
              voiceActive
                ? "Stop listening"
                : voiceBusy
                  ? "Jarvis is transcribing"
                  : "Talk to Jarvis"
            }
            aria-pressed={voiceActive}
            disabled={voiceBusy}
          >
            {voiceBusy ? (
              <LoaderCircle size={15} className="status-icon--spin" />
            ) : voiceActive ? (
              <Square size={13} fill="currentColor" />
            ) : (
              <Mic size={15} />
            )}
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
