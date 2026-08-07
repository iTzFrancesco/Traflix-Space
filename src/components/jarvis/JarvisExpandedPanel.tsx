import { useMemo } from "react";
import { JarvisChatPanel } from "./JarvisChatPanel";
import type { ActivityCheckpoint } from "../../lib/jarvis/activityState";
import type { JarvisConversationMessage, JarvisProviderStatus, JarvisRequestState, JarvisUiIntent, PendingAction, TtsStatusView, VoiceActivationMode, VoiceRequestStatusView } from "../../lib/jarvis/types";

interface JarvisExpandedPanelProps {
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
  onSendMessage: (message: string) => void;
  onSendVoiceTranscript: (requestId: string, text: string) => Promise<void> | void;
  onCancelRequest: (requestId: string) => void;
  onConfirmAction: (action: PendingAction) => void;
  onRejectAction: (action: PendingAction) => void;
  onUpdateAction: (action: PendingAction, text: string) => Promise<PendingAction>;
  onOpenTerminal: (workspaceId: string, terminalId: string, generation: number) => void;
  voiceRequest: VoiceRequestStatusView | null;
  activationMode: VoiceActivationMode;
  onVoiceDiscard: () => void;
  onVoiceCancel: () => void;
  ttsStatus: TtsStatusView;
  onStopTts: () => void;
  activities: ActivityCheckpoint[];
}

export function JarvisExpandedPanel(props: JarvisExpandedPanelProps) {
  const requests = useMemo(() => Object.values(props.requests).filter((request) => request.workspaceId === props.workspaceId), [props.requests, props.workspaceId]);
  return (
    <div className="mt-2 w-[min(440px,calc(100vw-24px))] overflow-hidden rounded-xl border border-white/[0.09] bg-neutral-elevated/95 shadow-xl backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2">
        <span className="text-[11px] font-medium text-neutral-text">Text fallback</span>
        <span className="max-w-52 truncate text-[10px] text-neutral-text-muted">{props.workspaceName ?? "No workspace"}</span>
      </div>
      <JarvisChatPanel {...props} requests={requests} />
    </div>
  );
}
