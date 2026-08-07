import { Bot, Settings2, Square } from "lucide-react";
import { JarvisChatInput, CancelButton } from "./JarvisChatInput";
import { JarvisTranscriptCard } from "./JarvisTranscriptCard";
import type { ActivityCheckpoint } from "../../lib/jarvis/activityState";
import type { JarvisConversationMessage, JarvisProviderStatus, JarvisRequestState, JarvisUiIntent, PendingAction, TtsStatusView, VoiceActivationMode, VoiceRequestStatusView } from "../../lib/jarvis/types";

interface Props {
  workspaceId: string | null;
  workspaceName: string | null;
  conversation: JarvisConversationMessage[];
  pendingActions: PendingAction[];
  requests: JarvisRequestState[];
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

export function JarvisChatPanel(props: Props) {
  const recentConversation = props.conversation.slice(-4);
  const chatBusy = props.requests.some((request) => request.status === "running" || request.status === "cancellation_requested");
  const textReady = Boolean(
    props.workspaceId &&
    props.providerStatus?.configured &&
    props.providerStatus.privacyConsent,
  );

  return (
    <div className="space-y-3 p-3">
      {recentConversation.length > 0 && (
        <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
          {recentConversation.map((message) => (
            <div key={message.id} className={message.role === "user" ? "ml-8 rounded-lg bg-primary/[0.12] px-3 py-2" : "mr-8 rounded-lg bg-white/[0.035] px-3 py-2"}>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-text">{message.content}</p>
            </div>
          ))}
        </div>
      )}

      {props.requests.filter((request) => request.status === "running" || request.status === "cancellation_requested").map((request) => (
        <div key={request.requestId} className="flex items-center justify-between rounded-lg border border-white/[0.08] px-3 py-2 text-xs text-neutral-text-muted">
          <span className="inline-flex items-center gap-1.5"><Bot size={13} /> {request.status === "cancellation_requested" ? "Annullamento…" : "Thinking…"}</span>
          <CancelButton onCancel={() => props.onCancelRequest(request.requestId)} />
        </div>
      ))}

      {props.voiceRequest?.status === "transcript_ready" && (
        <JarvisTranscriptCard request={props.voiceRequest} activeWorkspace={props.voiceRequest.workspaceId === props.workspaceId} onSend={(text) => props.onSendVoiceTranscript(props.voiceRequest!.requestId, text)} onDiscard={props.onVoiceDiscard} />
      )}

      {(props.ttsStatus.status === "playing" || props.ttsStatus.status === "synthesizing") && (
        <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2 text-xs text-neutral-text-muted">
          <span>Speaking…</span>
          <button type="button" data-jarvis-control onClick={props.onStopTts} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text"><Square size={11} /> Stop</button>
        </div>
      )}

      {props.uiIntents.filter((intent) => intent.workspaceId === props.workspaceId).slice(-1).map((intent) => (
        <button key={intent.id} type="button" onClick={() => props.onOpenTerminal(intent.workspaceId, intent.terminalId, intent.generation)} className="w-full rounded-lg border border-white/10 px-3 py-2 text-left text-xs text-neutral-text">{intent.label}</button>
      ))}

      {(props.chatError || props.voiceError) && (
        <p className="rounded-lg border border-warning/25 bg-warning/[0.05] px-3 py-2 text-xs text-warning">{props.chatError ?? props.voiceError}</p>
      )}

      {!textReady && (
        <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-[11px] text-neutral-text-muted">
          <Settings2 size={13} className="shrink-0" /> Configura OpenCode Zen e il consenso nelle impostazioni per usare il fallback testuale.
        </div>
      )}

      <JarvisChatInput disabled={!textReady || chatBusy} onSend={props.onSendMessage} />
    </div>
  );
}
