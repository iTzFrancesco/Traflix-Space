import { useEffect, useRef } from "react";
import { MicOff, Settings, X } from "lucide-react";
import { JarvisExpandedPanel } from "./JarvisExpandedPanel";
import { JarvisOrb } from "./JarvisOrb";
import { clampWidgetPosition, positionFromRect } from "../../lib/jarvis/position";
import { useJarvisStore } from "../../stores/jarvisStore";
import type { JarvisConversationMessage, JarvisProviderStatus, JarvisRequestState, JarvisUiIntent, PendingAction, WidgetPosition } from "../../lib/jarvis/types";

interface JarvisWidgetProps {
  workspaceId: string | null;
  workspaceName: string | null;
  conversation: JarvisConversationMessage[];
  pendingActions: PendingAction[];
  requests: Record<string, JarvisRequestState>;
  chatError: string | null;
  providerStatus: JarvisProviderStatus | null;
  uiIntents: JarvisUiIntent[];
  followUps: string[];
  onOpenSettings: () => void;
  onHide: () => void;
  onSendMessage: (message: string) => void;
  onCancelRequest: (requestId: string) => void;
  onConfirmAction: (action: PendingAction) => void;
  onRejectAction: (action: PendingAction) => void;
  onUpdateAction: (action: PendingAction, text: string) => void;
  onOpenTerminal: (workspaceId: string, terminalId: string, generation: number) => void;
}

export function JarvisWidget(props: JarvisWidgetProps) {
  const expanded = useJarvisStore((state) => state.expanded);
  const dragging = useJarvisStore((state) => state.dragging);
  const position = useJarvisStore((state) => state.settings.jarvis.widgetPosition);
  const muted = useJarvisStore((state) => state.settings.jarvis.muted);
  const setExpanded = useJarvisStore((state) => state.setExpanded);
  const setDragging = useJarvisStore((state) => state.setDragging);
  const updateWidgetPosition = useJarvisStore((state) => state.updateWidgetPosition);
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

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
  const statusText = !props.workspaceName ? "Seleziona una workspace" : activeRequests ? "Jarvis sta lavorando…" : "Pronto quando vuoi";

  return (
    <div ref={widgetRef} className="fixed z-40 select-none" style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, transform: "translate(-50%, -50%)", touchAction: "none" }}>
      <div className={expanded ? "w-[min(540px,calc(100vw-24px))] rounded-2xl border border-white/[0.1] bg-neutral-surface/95 shadow-xl backdrop-blur-xl" : "w-fit max-w-[calc(100vw-24px)] rounded-2xl border border-white/[0.1] bg-neutral-surface/95 shadow-xl backdrop-blur-xl"} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
        <div className="flex h-16 items-center gap-3 px-4" title="Trascina Jarvis">
          <button type="button" data-jarvis-control onClick={() => setExpanded(!expanded)} aria-label="Apri chat Jarvis"><JarvisOrb active={expanded || activeRequests > 0} /></button>
          <button type="button" data-jarvis-control onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1 text-left"><p className="truncate text-sm font-semibold text-neutral-text">{statusText}</p><p className="truncate text-[11px] text-neutral-text-muted">{props.workspaceName ?? "Jarvis globale"}</p></button>
          <button type="button" data-jarvis-control onClick={() => void useJarvisStore.getState().toggleMuted()} className="ui-icon-button h-9 w-9" title={muted ? "Riattiva stato" : "Muta stato"} aria-label={muted ? "Riattiva stato" : "Muta stato"}><MicOff size={16} className={muted ? "text-primary" : "text-neutral-text-muted"} /></button>
          <button type="button" data-jarvis-control onClick={props.onOpenSettings} className="ui-icon-button h-9 w-9" title="Impostazioni Jarvis" aria-label="Impostazioni Jarvis"><Settings size={16} /></button>
          <button type="button" data-jarvis-control onClick={props.onHide} className="ui-icon-button h-9 w-9" title="Nascondi Jarvis" aria-label="Nascondi Jarvis"><X size={17} /></button>
        </div>
      </div>
      {expanded && <JarvisExpandedPanel workspaceId={props.workspaceId} workspaceName={props.workspaceName} conversation={props.conversation} pendingActions={props.pendingActions} requests={props.requests} chatError={props.chatError} providerStatus={props.providerStatus} uiIntents={props.uiIntents} followUps={props.followUps} onSendMessage={props.onSendMessage} onCancelRequest={props.onCancelRequest} onConfirmAction={props.onConfirmAction} onRejectAction={props.onRejectAction} onUpdateAction={props.onUpdateAction} onOpenTerminal={props.onOpenTerminal} />}
    </div>
  );
}

function applyPosition(element: HTMLElement, next: WidgetPosition) { element.style.left = `${next.x * 100}%`; element.style.top = `${next.y * 100}%`; }
function samePosition(left: WidgetPosition, right: WidgetPosition) { return Math.abs(left.x - right.x) < 0.0005 && Math.abs(left.y - right.y) < 0.0005; }
