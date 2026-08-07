import { useMemo } from "react";
import { ArrowUpRight, Bot, ShieldCheck, Square } from "lucide-react";
import { JarvisChatInput, CancelButton } from "./JarvisChatInput";
import { JarvisPendingActionCard } from "./JarvisPendingActionCard";
import { JarvisTranscriptCard } from "./JarvisTranscriptCard";
import type { JarvisConversationMessage, JarvisProviderStatus, JarvisRequestState, JarvisUiIntent, PendingAction, TtsStatusView, VoiceRequestStatusView } from "../../lib/jarvis/types";

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
  onVoiceDiscard: () => void;
  onVoiceCancel: () => void;
  ttsStatus: TtsStatusView;
  onStopTts: () => void;
}

export function JarvisChatPanel(props: Props) {
  const pending = useMemo(() => props.pendingActions.filter((action) => action.status === "pending" && action.invocation.targetWorkspaceId === props.workspaceId), [props.pendingActions, props.workspaceId]);
  return (
    <div className="p-4">
      <div className="max-h-[min(420px,56vh)] space-y-3 overflow-y-auto pr-1">
        {props.conversation.length === 0 && <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-4"><p className="text-sm font-semibold text-neutral-text">Sono Jarvis.</p><p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">Posso leggere Markdown consentito, osservare agenti e preparare operazioni da confermare. Questa conversazione resta nella workspace {props.workspaceName ?? "attiva"}.</p></div>}
        {props.conversation.map((message) => <div key={message.id} className={message.role === "user" ? "ml-10 rounded-xl bg-primary/[0.14] px-3 py-2" : "mr-10 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2"}><p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-text">{message.content}</p>{message.provider && <p className="mt-1 text-[10px] text-neutral-text-muted">{message.provider}</p>}</div>)}
        {props.requests.map((request) => <div key={request.requestId} className="mr-10 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-xs text-neutral-text-muted"><div className="flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1"><Bot size={13} /> {request.status === "cancellation_requested" ? "Annullamento…" : request.status === "running" ? "Jarvis sta pensando…" : request.status}</span>{(request.status === "running" || request.status === "cancellation_requested") && <CancelButton onCancel={() => props.onCancelRequest(request.requestId)} />}</div>{request.error && <p className="mt-1 text-danger">{request.error}</p>}</div>)}
      </div>
      {props.chatError && <p className="mt-3 rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-xs text-danger">{props.chatError}</p>}
      {props.voiceError && <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-xs text-danger">{props.voiceError}</p>}
      {props.voiceRequest && <JarvisTranscriptCard request={props.voiceRequest} activeWorkspace={props.voiceRequest.workspaceId === props.workspaceId} onSend={(text) => props.onSendVoiceTranscript(props.voiceRequest!.requestId, text)} onDiscard={props.onVoiceDiscard} />}
      {props.voiceRequest && (props.voiceRequest.status === "recording" || props.voiceRequest.status === "transcribing" || props.voiceRequest.status === "stopping") && <div className="mt-3 flex items-center justify-between rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2 text-xs text-neutral-text-muted"><span>{props.voiceRequest.status === "recording" ? `Registrazione ${Math.floor((props.voiceRequest.durationMs ?? 0) / 1000)}s · livello ${Math.round((props.voiceRequest.normalizedLevel ?? 0) * 100)}%` : "Trascrizione in corso…"}</span><button type="button" data-jarvis-control onClick={props.onVoiceCancel} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text"><Square size={11} /> Annulla</button></div>}
      {(props.ttsStatus.status === "playing" || props.ttsStatus.status === "synthesizing") && <div className="mt-3 flex items-center justify-between rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2 text-xs text-neutral-text-muted"><span>Sto parlando…</span><button type="button" data-jarvis-control onClick={props.onStopTts} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text"><Square size={11} /> Stop</button></div>}
      {props.ttsStatus.status === "failed" && props.ttsStatus.error && <p className="mt-2 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-xs text-warning">La risposta è disponibile, ma la sintesi vocale non è riuscita: {props.ttsStatus.error.message}</p>}
      {props.uiIntents.filter((intent) => intent.workspaceId === props.workspaceId).map((intent) => <button key={intent.id} type="button" onClick={() => props.onOpenTerminal(intent.workspaceId, intent.terminalId, intent.generation)} className="mt-3 inline-flex items-center rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-text">{intent.label}</button>)}
      {props.followUps.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{props.followUps.map((followUp) => <button key={followUp} type="button" onClick={() => props.onSendMessage(followUp)} className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] text-neutral-text-muted hover:border-primary/50 hover:text-neutral-text">{followUp}</button>)}</div>}
      {pending.length > 0 && <div className="mt-3 space-y-2"><p className="eyebrow text-primary">Conferme richieste</p>{pending.map((action) => <JarvisPendingActionCard key={action.id} action={action} onConfirm={props.onConfirmAction} onReject={props.onRejectAction} onUpdate={props.onUpdateAction} />)}</div>}
      <div className="mt-3 flex items-center gap-2 text-[10px] text-neutral-text-muted"><ShieldCheck size={13} className="text-signal" /> Le operazioni mutative richiedono sempre conferma.</div>
      <JarvisChatInput disabled={!props.workspaceId || props.requests.some((request) => request.status === "running" || request.status === "cancellation_requested")} onSend={props.onSendMessage} />
      {props.providerStatus && <p className="mt-2 text-[10px] text-neutral-text-muted">{props.providerStatus.primaryModelAvailable ? props.providerStatus.primaryModel : props.providerStatus.fallbackModel}{props.providerStatus.configured ? "" : " · provider non configurato"}</p>}
      {/* Intent is rendered by the chat response in future messages; the
          target validation remains in the backend and this button is explicit. */}
      <span className="sr-only"><ArrowUpRight /></span>
    </div>
  );
}
