import { useEffect, useState } from "react";
import { Check, Edit3, X } from "lucide-react";
import type { PendingAction } from "../../lib/jarvis/types";

export function JarvisPendingActionCard({ action, onConfirm, onReject, onUpdate }: { action: PendingAction; onConfirm: (action: PendingAction) => void; onReject: (action: PendingAction) => void; onUpdate: (action: PendingAction, text: string) => void }) {
  const [text, setText] = useState(action.operation === "agent.send" ? action.editableText ?? "" : "");
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing && action.operation === "agent.send") setText(action.editableText ?? ""); }, [action.editableText, action.operation, editing]);
  if (action.status !== "pending") return null;
  const editable = action.operation === "agent.send";
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3">
      <p className="text-xs font-semibold text-neutral-text">{action.description}</p>
      {editable && editing ? <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-neutral-bg px-2 py-2 font-mono text-xs text-neutral-text outline-none focus:border-primary/60" aria-label="Testo operazione agente" /> : <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-text-muted">{action.preview}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {editable && <button type="button" onClick={() => { if (editing) onUpdate(action, text); setEditing(!editing); }} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text-muted"><Edit3 size={13} /> {editing ? "Aggiorna anteprima" : "Modifica"}</button>}
        <button type="button" onClick={() => onConfirm(action)} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-white"><Check size={13} /> Conferma</button>
        <button type="button" onClick={() => onReject(action)} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text-muted"><X size={13} /> Rifiuta</button>
      </div>
    </div>
  );
}
