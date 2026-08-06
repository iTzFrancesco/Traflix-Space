import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, MicOff, Settings, X } from "lucide-react";
import { JarvisExpandedPanel } from "./JarvisExpandedPanel";
import { JarvisOrb } from "./JarvisOrb";
import { clampWidgetPosition, positionFromRect } from "../../lib/jarvis/position";
import { useJarvisStore } from "../../stores/jarvisStore";
import type { AgentSessionContext, ModelContextViewV1, WidgetPosition } from "../../lib/jarvis/types";

interface JarvisWidgetProps {
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceRoot: string | null;
  context: ModelContextViewV1 | null;
  contextStatus: "idle" | "loading" | "ready" | "unavailable";
  contextError: string | null;
  sessions: AgentSessionContext[];
  isRefreshing: boolean;
  otherWorkspaceAgentCount: number;
  onRefresh: () => void;
  onSelectSession: (session: AgentSessionContext) => void;
  onOpenTerminal: (session: AgentSessionContext) => void;
  onOpenSettings: () => void;
  onHide: () => void;
}

export function JarvisWidget(props: JarvisWidgetProps) {
  const expanded = useJarvisStore((state) => state.expanded);
  const dragging = useJarvisStore((state) => state.dragging);
  const position = useJarvisStore((state) => state.settings.jarvis.widgetPosition);
  const muted = useJarvisStore((state) => state.settings.jarvis.muted);
  const selectedSessionId = useJarvisStore((state) => state.selectedAgentSessionId);
  const currentResult = useJarvisStore((state) => state.currentResult);
  const currentResultSessionId = useJarvisStore((state) => state.currentResultSessionId);
  const currentResultLoading = useJarvisStore((state) => state.currentResultLoading);
  const currentError = useJarvisStore((state) => state.currentError);
  const setExpanded = useJarvisStore((state) => state.setExpanded);
  const setDragging = useJarvisStore((state) => state.setDragging);
  const updateWidgetPosition = useJarvisStore((state) => state.updateWidgetPosition);
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

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
  }, [expanded, position, updateWidgetPosition]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-jarvis-control]")) return;
    const element = widgetRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    dragOffsetRef.current = {
      x: rect.left + rect.width / 2 - event.clientX,
      y: rect.top + rect.height / 2 - event.clientY,
    };
    element.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const element = widgetRef.current;
    if (!element) return;
    const desired: WidgetPosition = {
      x: (event.clientX + dragOffsetRef.current.x) / window.innerWidth,
      y: (event.clientY + dragOffsetRef.current.y) / window.innerHeight,
    };
    const next = clampWidgetPosition(
      desired,
      { width: window.innerWidth, height: window.innerHeight },
      { width: element.offsetWidth, height: element.offsetHeight },
    );
    applyPosition(element, next);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const element = widgetRef.current;
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setDragging(false);
    if (element) {
      const next = clampWidgetPosition(
        positionFromRect(element.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
        { width: window.innerWidth, height: window.innerHeight },
        { width: element.offsetWidth, height: element.offsetHeight },
      );
      void updateWidgetPosition(next);
    }
  };

  const statusText = props.workspaceName
    ? props.isRefreshing
      ? "Refreshing agent registry…"
      : props.sessions.some((session) => session.state === "working")
        ? `${props.sessions.filter((session) => session.state === "working").length} agents working`
        : props.sessions.some((session) => session.completionNotification?.resultAvailable)
          ? "Agent has a new result"
          : "Ready when you are"
    : "Select a workspace";

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
        className="w-[min(540px,calc(100vw-24px))] rounded-2xl border border-white/[0.1] bg-neutral-surface/95 shadow-xl backdrop-blur-xl"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="flex h-16 items-center gap-3 px-4" title="Trascina Jarvis">
          <button type="button" data-jarvis-control onClick={() => setExpanded(!expanded)} aria-label="Apri pannello Jarvis">
            <JarvisOrb active={expanded || props.sessions.length > 0} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-neutral-text">{statusText}</p>
            <p className="truncate text-[11px] text-neutral-text-muted">{props.workspaceName ?? "Jarvis globale"}</p>
          </div>
          <button type="button" data-jarvis-control onClick={() => void useJarvisStore.getState().toggleMuted()} className="ui-icon-button h-9 w-9" title={muted ? "Riattiva stato voce" : "Muta stato voce"} aria-label={muted ? "Riattiva stato voce" : "Muta stato voce"}>
            <MicOff size={16} className={muted ? "text-primary" : "text-neutral-text-muted"} />
          </button>
          <button type="button" data-jarvis-control onClick={props.onOpenSettings} className="ui-icon-button h-9 w-9" title="Impostazioni Jarvis" aria-label="Impostazioni Jarvis">
            <Settings size={16} />
          </button>
          <button type="button" data-jarvis-control onClick={() => setExpanded(!expanded)} className="ui-icon-button h-9 w-9" title={expanded ? "Riduci Jarvis" : "Espandi Jarvis"} aria-label={expanded ? "Riduci Jarvis" : "Espandi Jarvis"}>
            {expanded ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
          </button>
          <button type="button" data-jarvis-control onClick={() => void props.onHide()} className="ui-icon-button h-9 w-9" title="Nascondi Jarvis" aria-label="Nascondi Jarvis">
            <X size={17} />
          </button>
        </div>
      </div>

      {expanded && (
        <JarvisExpandedPanel
          workspaceId={props.workspaceId}
          workspaceName={props.workspaceName}
          workspaceRoot={props.workspaceRoot}
          context={props.context}
          contextStatus={props.contextStatus}
          contextError={props.contextError}
          sessions={props.sessions}
          selectedSessionId={selectedSessionId}
          currentResult={currentResult}
          currentResultSessionId={currentResultSessionId}
          currentResultLoading={currentResultLoading}
          currentError={currentError}
          otherWorkspaceAgentCount={props.otherWorkspaceAgentCount}
          isRefreshing={props.isRefreshing}
          onSelectSession={props.onSelectSession}
          onOpenTerminal={props.onOpenTerminal}
          onRefresh={props.onRefresh}
        />
      )}
    </div>
  );
}

function applyPosition(element: HTMLElement, position: WidgetPosition) {
  element.style.left = `${position.x * 100}%`;
  element.style.top = `${position.y * 100}%`;
}

function samePosition(left: WidgetPosition, right: WidgetPosition): boolean {
  return Math.abs(left.x - right.x) < 0.0005 && Math.abs(left.y - right.y) < 0.0005;
}
