import { useCallback, useEffect, useRef } from "react";
import { LoaderCircle, Mic, Settings, X } from "lucide-react";
import { JarvisOrb } from "./JarvisOrb";
import { clampWidgetPosition, positionFromRect } from "../../lib/jarvis/position";
import { collapsedJarvisStatus, hasOpenActivity, type ActivityCheckpoint } from "../../lib/jarvis/activityState";
import { isJarvisOwnerModeReady, ownerModeJarvisSettings } from "../../lib/jarvis/settings";
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
  activated: boolean;
  offsetX: number;
  offsetY: number;
};

const DRAG_HOLD_MS = 340;

export function JarvisWidget(props: JarvisWidgetProps) {
  const position = useJarvisStore((state) => state.settings.jarvis.widgetPosition);
  const jarvisSettings = useJarvisStore((state) => state.settings.jarvis);
  const setDragging = useJarvisStore((state) => state.setDragging);
  const updateWidgetPosition = useJarvisStore((state) => state.updateWidgetPosition);
  const updateJarvisSettings = useJarvisStore((state) => state.updateJarvisSettings);
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragIntentRef = useRef<DragIntent | null>(null);
  const dragTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousVoiceStatusRef = useRef<VoiceRequestStatusView["status"] | null>(null);
  const holdPressedRef = useRef(false);
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

  useEffect(() => () => {
    if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current);
    audioContextRef.current?.close().catch(() => undefined);
  }, []);

  const playCue = useCallback((kind: "start" | "stop") => {
    try {
      const WebAudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!WebAudioContext) return;
      const context = audioContextRef.current ?? new WebAudioContext();
      audioContextRef.current = context;
      void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(kind === "start" ? 620 : 760, now);
      oscillator.frequency.exponentialRampToValueAtTime(kind === "start" ? 820 : 520, now + 0.085);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.055, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.105);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.11);
    } catch {
      // Audio cues are helpful feedback, never a blocker for the voice flow.
    }
  }, []);

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
    if (dragTimerRef.current !== null) {
      window.clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-jarvis-control]")) return;
    const element = widgetRef.current;
    if (!element) return;
    clearDragTimer();
    const rect = element.getBoundingClientRect();
    dragIntentRef.current = {
      pointerId: event.pointerId,
      activated: false,
      offsetX: rect.left + rect.width / 2 - event.clientX,
      offsetY: rect.top + rect.height / 2 - event.clientY,
    };
    element.setPointerCapture(event.pointerId);
    dragTimerRef.current = window.setTimeout(() => {
      const intent = dragIntentRef.current;
      if (!intent || intent.pointerId !== event.pointerId) return;
      intent.activated = true;
      setDragging(true);
      element.dataset.jarvisDragging = "true";
    }, DRAG_HOLD_MS);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const intent = dragIntentRef.current;
    if (!intent?.activated || intent.pointerId !== event.pointerId) return;
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

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    clearDragTimer();
    const intent = dragIntentRef.current;
    const element = widgetRef.current;
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    dragIntentRef.current = null;
    if (!intent?.activated || intent.pointerId !== event.pointerId || !element) return;
    delete element.dataset.jarvisDragging;
    setDragging(false);
    void updateWidgetPosition(
      clampWidgetPosition(
        positionFromRect(element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }),
        { width: window.innerWidth, height: window.innerHeight },
        { width: element.offsetWidth, height: element.offsetHeight },
      ),
    );
  };

  const activeRequests = Object.values(props.requests).filter(
    (request) => request.workspaceId === props.workspaceId && (request.status === "running" || request.status === "cancellation_requested"),
  ).length;
  const speaking = props.ttsStatus.status === "synthesizing" || props.ttsStatus.status === "playing";
  const jarvisActive = hasOpenActivity(props.activities, props.workspaceId, props.pendingActions);
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
  const statusText = props.voiceError && rawStatusText === "Voice error" ? "Setup required" : rawStatusText;
  const voiceActive = props.voiceRequest?.status === "recording" || props.voiceRequest?.status === "armed";
  const voiceBusy = props.voiceRequest?.status === "transcribing" || props.voiceRequest?.status === "stopping";
  const level = Math.max(0, Math.min(1, props.voiceRequest?.normalizedLevel ?? 0));

  const handleVoiceClick = async () => {
    if (props.activationMode === "hold_to_talk") return;
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

  const handleVoicePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (props.activationMode !== "hold_to_talk") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!voiceActive && !voiceBusy && !holdPressedRef.current) {
      holdPressedRef.current = true;
      void ensureOwnerMode().then(() => props.onVoiceStart()).then(() => {
        if (!holdPressedRef.current) props.onVoiceStop();
      });
    }
  };

  const handleVoicePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (props.activationMode !== "hold_to_talk") return;
    event.preventDefault();
    const wasPressed = holdPressedRef.current;
    holdPressedRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (wasPressed) props.onVoiceStop();
  };

  const handleVoiceKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (props.activationMode !== "hold_to_talk" || (event.key !== " " && event.key !== "Enter") || event.repeat) return;
    event.preventDefault();
    if (!voiceActive && !voiceBusy && !holdPressedRef.current) {
      holdPressedRef.current = true;
      void ensureOwnerMode().then(() => props.onVoiceStart()).then(() => {
        if (!holdPressedRef.current) props.onVoiceStop();
      });
    }
  };

  const handleVoiceKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (props.activationMode !== "hold_to_talk" || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    const wasPressed = holdPressedRef.current;
    holdPressedRef.current = false;
    if (wasPressed) props.onVoiceStop();
  };

  const active = activeRequests > 0 || speaking || jarvisActive || voiceActive || voiceBusy;

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
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        title="Tieni premuto per spostare Jarvis"
      >
        <JarvisOrb active={active} listening={voiceActive} speaking={speaking} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-semibold leading-none text-neutral-text">{statusText}</p>
            {voiceActive && <VoiceMeter level={level} />}
          </div>
          <p className="mt-1 truncate text-[10px] leading-none text-neutral-text-muted">
            {voiceActive ? "Parla normalmente · termino quando fai una pausa" : props.workspaceName ?? "Jarvis"}
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
            title={voiceActive ? "Sto ascoltando · clicca per terminare ora" : voiceBusy ? "Trascrizione in corso" : "Parla con Jarvis"}
            aria-label={voiceActive ? "Jarvis sta ascoltando" : voiceBusy ? "Jarvis sta trascrivendo" : "Parla con Jarvis"}
            aria-pressed={voiceActive}
            disabled={voiceBusy}
          >
            {voiceBusy ? <LoaderCircle size={15} className="status-icon--spin" /> : <Mic size={15} />}
          </button>
          <button
            type="button"
            data-jarvis-control
            onClick={props.onOpenSettings}
            className="jarvis-control"
            title="Impostazioni Jarvis"
            aria-label="Impostazioni Jarvis"
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
    </div>
  );
}

function VoiceMeter({ level }: { level: number }) {
  const scaled = Math.max(0.08, Math.min(1, level * 2.8));
  return (
    <span className="jarvis-level-meter" aria-hidden="true">
      {[0.45, 0.78, 1, 0.7].map((weight, index) => (
        <span
          key={index}
          style={{ height: `${Math.max(3, Math.round(3 + 10 * scaled * weight))}px` }}
        />
      ))}
    </span>
  );
}

function applyPosition(element: HTMLElement, next: WidgetPosition) {
  element.style.left = `${next.x * 100}%`;
  element.style.top = `${next.y * 100}%`;
}

function samePosition(left: WidgetPosition, right: WidgetPosition) {
  return Math.abs(left.x - right.x) < 0.0005 && Math.abs(left.y - right.y) < 0.0005;
}
