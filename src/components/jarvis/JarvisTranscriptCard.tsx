import { useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import type { VoiceRequestStatusView } from "../../lib/jarvis/types";

export function JarvisTranscriptCard({ request, activeWorkspace, onSend, onDiscard }: { request: VoiceRequestStatusView; activeWorkspace: boolean; onSend: (text: string) => void; onDiscard: () => void }) {
  const [text, setText] = useState(request.transcript ?? "");
  useEffect(() => { setText(request.transcript ?? ""); }, [request.requestId, request.transcript]);
  if (request.status !== "transcript_ready" || !request.transcript) return null;
  return <section className="mt-3 rounded-xl border border-signal/30 bg-signal/[0.06] p-3" data-jarvis-control>
    <div className="flex items-center justify-between gap-2"><p className="eyebrow text-signal">Trascrizione pronta</p><span className="text-[10px] text-neutral-text-muted">{activeWorkspace ? "Workspace attiva" : "Workspace diversa"}</span></div>
    <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-neutral-bg px-2 py-2 text-sm text-neutral-text outline-none focus:border-signal/60" aria-label="Trascrizione modificabile" />
    {!activeWorkspace && <p className="mt-2 text-xs text-warning">Torna alla workspace originale prima di inviare.</p>}
    <div className="mt-2 flex gap-2"><button type="button" disabled={!activeWorkspace || !text.trim()} onClick={() => onSend(text)} className="inline-flex items-center gap-1 rounded-md bg-signal px-2 py-1 text-xs font-semibold text-neutral-bg disabled:opacity-40"><Check size={13} /> Invia alla chat</button><button type="button" onClick={onDiscard} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text-muted"><Trash2 size={13} /> Scarta</button></div>
  </section>;
}
