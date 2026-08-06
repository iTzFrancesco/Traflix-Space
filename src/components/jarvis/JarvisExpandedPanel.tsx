import { useMemo } from "react";
import { JarvisChatPanel } from "./JarvisChatPanel";
import type { JarvisConversationMessage, JarvisProviderStatus, JarvisRequestState, JarvisUiIntent, PendingAction, TtsStatusView, VoiceRequestStatusView } from "../../lib/jarvis/types";

interface JarvisExpandedPanelProps {
  workspaceId: string | null;
  workspaceName: string | null;
  conversation: JarvisConversationMessage[];
  pendingActions: PendingAction[];
  requests: Record<string, JarvisRequestState>;
  chatError: string | null;
  providerStatus: JarvisProviderStatus | null;
  uiIntents: JarvisUiIntent[];
  followUps: string[];
  onSendMessage: (message: string) => void;
  onCancelRequest: (requestId: string) => void;
  onConfirmAction: (action: PendingAction) => void;
  onRejectAction: (action: PendingAction) => void;
  onUpdateAction: (action: PendingAction, text: string) => Promise<PendingAction>;
  onOpenTerminal: (workspaceId: string, terminalId: string, generation: number) => void;
  voiceRequest: VoiceRequestStatusView | null;
  onVoiceDiscard: () => void;
  onVoiceCancel: () => void;
  ttsStatus: TtsStatusView;
  onStopTts: () => void;
}

export function JarvisExpandedPanel(props: JarvisExpandedPanelProps) {
  const requests = useMemo(() => Object.values(props.requests).filter((request) => request.workspaceId === props.workspaceId), [props.requests, props.workspaceId]);
  return (
    <div className="mt-3 w-[min(680px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-white/[0.1] bg-neutral-elevated/95 shadow-2xl backdrop-blur-xl">
      <div className="border-b border-white/[0.08] px-5 py-4">
        <p className="eyebrow">Jarvis</p>
        <h2 className="mt-1 truncate text-lg font-semibold text-neutral-text">{props.workspaceName ?? "Seleziona una workspace"}</h2>
        <p className="mt-1 text-xs text-neutral-text-muted">Conversazione isolata nella workspace attiva</p>
      </div>
      <JarvisChatPanel {...props} requests={requests} />
    </div>
  );
}
