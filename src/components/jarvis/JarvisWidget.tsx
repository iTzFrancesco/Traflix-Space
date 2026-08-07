import { useEffect, useRef } from "react";
import { Mic, MicOff, Settings, X } from "lucide-react";
import { JarvisExpandedPanel } from "./JarvisExpandedPanel";
import { JarvisOrb } from "./JarvisOrb";
import { clampWidgetPosition, positionFromRect } from "../../lib/jarvis/position";
import { collapsedJarvisStatus, hasOpenActivity, type ActivityCheckpoint } from "../../lib/jarvis/activityState";
import { useJarvisStore } from "../../stores/jarvisStore";
import type { JarvisConversationMessage, JarvisProviderStatus, JarvisRequestState, JarvisUiIntent, PendingAction, TtsStatusView, VoiceActivationMode, VoiceRequestStatusView, WidgetPosition } from "../../lib/jarvis/types";

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

export function JarvisWidget(props: JarvisWidgetProps) {
  const expanded = useJarvisStore((state) => state.expanded);
  const dragging = useJarvisStore((state) => state.dragging);
  const position = useJarvisStore((state) => state.settings.jarvis.widgetPosition);
  const setExpanded = useJarvisStore((state) => state.setExpanded);
  const setDragging = useJarvisStore((state) => state.setDragging);
  const updateWidgetPosition = useJarvisStore((state) => state.updateWidgetPosition);
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const holdPressedRef = useRef(false);
  const onVoiceStopRef = useRef(props.onVoiceStop);
  onVoiceStopRef.current = props.onVoiceStop;

  useEffect(() => {
    const handleResize = () => { const element = widgetRef.current; if (!element) return; const next = clampWidgetPosition(position, { width: window.innerWidth, height: window.innerHeight }, { width: element.offsetWidth, height: element.offsetHeight }); applyPosition(element, next); if (!samePosition(next, position)) void updateWidgetPosition(next); };
    window.addEventListener("resize", handleResize); handleResize(); return () => window.removeEventListener("resize", handleResize);
  }, [position, updateWidgetPosition]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-jarvis-control]")) return;
    const element = widgetRef.current; if (!element) return;
    const rect = element.getBoundingClientRect(); dragOffsetRef.current = { x: rect.left + rect.width / 2 - event.clientX, y: rect.top + rect.height / 2 - event.clientY }; element.setPointerCapture(event.pointerId); setDragging(true);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return; const element = widgetRef.current; if (!element) return;
    const next = clampWidgetPosition({ x: (event.clientX + dragOffsetRef.current.x) / window.innerWidth, y: (event.clientY + dragOffsetRef.current.y) / window.innerHeight }, { width: window.innerWidth, height: window.innerHeight }, { width: element.offsetWidth, height: element.offsetHeight }); applyPosition(element, next);
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return; const element = widgetRef.current; if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); setDragging(false); if (element) void updateWidgetPosition(clampWidgetPosition(positionFromRect(element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }), { width: window.innerWidth, height: window.innerHeight }, { width: element.offsetWidth, height: element.offsetHeight }));
  };
  const activeRequests = Object.values(props.requests).filter((request) => request.workspaceId === props.workspaceId && (request.status === "running" || request.status === "cancellation_requested")).length;
  const speaking = props.ttsStatus.status === "synthesizing" || props.ttsStatus.status === "playing";
  const jarvisActive = hasOpenActivity(props.activities, props.workspaceId, props.pendingActions);
  const statusText = collapsedJarvisStatus({ workspaceId: props.workspaceId, workspaceName: props.workspaceName, voiceError: props.voiceError, voiceRequest: props.voiceRequest, ttsStatus: props.ttsStatus, requests: props.requests, pendingActions: props.pendingActions, activities: props.activities });
  const voiceActive = props.voiceRequest?.status === "recording" || props.voiceRequest?.status === "armed";
  const voiceBusy = props.voiceRequest?.status === "transcribing" || props.voiceRequest?.status === "stopping";
  const handleVoiceClick = () => {
    if (props.activationMode === "hold_to_talk") return;
    if (props.voiceRequest?.status === "recording") props.onVoiceStop();
    else if (props.voiceRequest?.status === "armed") props.onVoiceCancel();
    else if (voiceBusy) props.onVoiceCancel();
    else props.onVoiceStart();
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
      void Promise.resolve(props.onVoiceStart()).then(() => { if (!holdPressedRef.current) props.onVoiceStop(); });
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
      void Promise.resolve(props.onVoiceStart()).then(() => { if (!holdPressedRef.current) props.onVoiceStop(); });
    }
  };
  const handleVoiceKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (props.activationMode !== "hold_to_talk" || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    const wasPressed = holdPressedRef.current;
    holdPressedRef.current = false;
    if (wasPressed) props.onVoiceStop();
  };

  return (
    <div ref={widgetRef} className="fixed z-40 select-none" style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, transform: "translate(-50%, -50%)", touchAction: "none" }}>
      <div className={expanded ? "w-[min(540px,calc(100vw-24px))] rounded-2xl border border-white/[0.1] bg-neutral-surface/95 shadow-xl backdrop-blur-xl" : "w-fit max-w-[calc(100vw-24px)] rounded-2xl border border-white/[0.1] bg-neutral-surface/95 shadow-xl backdrop-blur-xl"} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
        <div className="flex h-16 items-center gap-3 px-4" title="Trascina Jarvis">
          <button type="button" data-jarvis-control onClick={() => setExpanded(!expanded)} aria-label="Apri chat Jarvis"><JarvisOrb active={expanded || activeRequests > 0 || speaking || jarvisActive} /></button>
          <button type="button" data-jarvis-control onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1 text-left"><p className="truncate text-sm font-semibold text-neutral-text">{statusText}</p><p className="truncate text-[11px] text-neutral-text-muted">{props.voiceError ?? props.workspaceName ?? "Jarvis globale"}</p></button>
          <button type="button" data-jarvis-control onClick={handleVoiceClick} onPointerDown={handleVoicePointerDown} onPointerUp={handleVoicePointerUp} onPointerCancel={handleVoicePointerUp} onBlur={releaseHeldVoice} onKeyDown={handleVoiceKeyDown} onKeyUp={handleVoiceKeyUp} className="ui-icon-button h-9 w-9" title={props.activationMode === "hold_to_talk" ? "Tieni premuto per parlare" : props.voiceRequest?.status === "armed" ? "Annulla ascolto" : props.voiceRequest?.status === "recording" ? "Ferma e trascrivi" : "Inizia registrazione"} aria-label={props.activationMode === "hold_to_talk" ? "Tieni premuto per parlare" : props.voiceRequest?.status === "armed" ? "Annulla ascolto" : props.voiceRequest?.status === "recording" ? "Ferma e trascrivi" : "Inizia registrazione"} aria-pressed={voiceActive}>{props.voiceRequest?.status === "recording" ? <MicOff size={16} className="text-danger" /> : <Mic size={16} className="text-neutral-text-muted" />}</button>
          <button type="button" data-jarvis-control onClick={props.onOpenSettings} className="ui-icon-button h-9 w-9" title="Impostazioni Jarvis" aria-label="Impostazioni Jarvis"><Settings size={16} /></button>
          <button type="button" data-jarvis-control onClick={props.onHide} className="ui-icon-button h-9 w-9" title="Nascondi Jarvis" aria-label="Nascondi Jarvis"><X size={17} /></button>
        </div>
      </div>
      {expanded && <JarvisExpandedPanel workspaceId={props.workspaceId} workspaceName={props.workspaceName} conversation={props.conversation} pendingActions={props.pendingActions} requests={props.requests} chatError={props.chatError} voiceError={props.voiceError} providerStatus={props.providerStatus} uiIntents={props.uiIntents} followUps={props.followUps} activities={props.activities} onSendMessage={props.onSendMessage} onSendVoiceTranscript={props.onSendVoiceTranscript} onCancelRequest={props.onCancelRequest} onConfirmAction={props.onConfirmAction} onRejectAction={props.onRejectAction} onUpdateAction={props.onUpdateAction} onOpenTerminal={props.onOpenTerminal} voiceRequest={props.voiceRequest} activationMode={props.activationMode} onVoiceDiscard={props.onVoiceDiscard} onVoiceCancel={props.onVoiceCancel} ttsStatus={props.ttsStatus} onStopTts={props.onStopTts} />}
    </div>
  );
}

function applyPosition(element: HTMLElement, next: WidgetPosition) { element.style.left = `${next.x * 100}%`; element.style.top = `${next.y * 100}%`; }
function samePosition(left: WidgetPosition, right: WidgetPosition) { return Math.abs(left.x - right.x) < 0.0005 && Math.abs(left.y - right.y) < 0.0005; }
