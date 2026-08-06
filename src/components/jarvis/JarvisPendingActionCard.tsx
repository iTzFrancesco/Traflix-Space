import { useEffect, useRef, useState } from "react";
import { Check, Edit3, X } from "lucide-react";
import { canConfirmPendingAction, savePendingActionEdit } from "../../lib/jarvis/pendingActionState";
import type { PendingAction } from "../../lib/jarvis/types";

export function JarvisPendingActionCard({ action, onConfirm, onReject, onUpdate }: { action: PendingAction; onConfirm: (action: PendingAction) => void; onReject: (action: PendingAction) => void; onUpdate: (action: PendingAction, text: string) => Promise<PendingAction> }) {
  const [text, setText] = useState(action.operation === "agent.send" ? action.editableText ?? "" : "");
  const [latestAction, setLatestAction] = useState(action);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastSavedSignature = useRef<string | null>(null);
  useEffect(() => {
    if (editing || saving) return;
    const incomingSignature = actionSignature(action);
    if (lastSavedSignature.current) {
      if (lastSavedSignature.current === incomingSignature) lastSavedSignature.current = null;
      else return;
    }
    if (incomingSignature !== actionSignature(latestAction)) setLatestAction(action);
  }, [action, editing, latestAction, saving]);
  useEffect(() => { if (!editing && !saving && action.operation === "agent.send") setText(action.editableText ?? ""); }, [action.editableText, action.operation, editing, saving]);
  if (latestAction.status !== "pending") return null;
  const editable = latestAction.operation === "agent.send";
  const confirmable = canConfirmPendingAction({ action: latestAction, editing, saving });
  const saveEdit = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      const saved = await savePendingActionEdit({ action: latestAction, editing: true, saving: false }, text, onUpdate);
      lastSavedSignature.current = actionSignature(saved.action);
      setLatestAction(saved.action);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3">
      <p className="text-xs font-semibold text-neutral-text">{latestAction.description}</p>
      {editable && editing ? <textarea value={text} disabled={saving} onChange={(event) => setText(event.target.value)} rows={3} className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-neutral-bg px-2 py-2 font-mono text-xs text-neutral-text outline-none focus:border-primary/60 disabled:opacity-60" aria-label="Testo operazione agente" /> : <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-text-muted">{latestAction.preview}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {editable && <button type="button" disabled={saving} onClick={() => { if (editing) void saveEdit(); else setEditing(true); }} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text-muted disabled:opacity-60"><Edit3 size={13} /> {saving ? "Salvataggio…" : editing ? "Aggiorna anteprima" : "Modifica"}</button>}
        <button type="button" disabled={!confirmable} onClick={() => onConfirm(latestAction)} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"><Check size={13} /> Conferma</button>
        <button type="button" disabled={editing || saving} onClick={() => onReject(latestAction)} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text-muted disabled:cursor-not-allowed disabled:opacity-40"><X size={13} /> Rifiuta</button>
      </div>
    </div>
  );
}

function actionSignature(action: PendingAction): string {
  return [action.id, action.status, action.preview, action.editableText ?? ""].join("\u0000");
}
