import { useState } from "react";
import { Send, X } from "lucide-react";

export function JarvisChatInput({ disabled, onSend }: { disabled: boolean; onSend: (message: string) => void }) {
  const [draft, setDraft] = useState("");
  const submit = () => { const message = draft.trim(); if (!message || disabled) return; setDraft(""); onSend(message); };
  return <div className="mt-3 flex items-end gap-2 rounded-xl border border-white/[0.1] bg-neutral-bg/70 p-2"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="Chiedi a Jarvis della workspace…" rows={2} className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-neutral-text outline-none placeholder:text-neutral-text-muted" aria-label="Messaggio per Jarvis" /><button type="button" onClick={submit} disabled={!draft.trim() || disabled} className="ui-icon-button h-9 w-9 shrink-0 bg-primary text-white disabled:opacity-40" title="Invia messaggio" aria-label="Invia messaggio"><Send size={15} /></button></div>;
}

export function CancelButton({ onCancel }: { onCancel: () => void }) { return <button type="button" onClick={onCancel} className="inline-flex items-center gap-1 rounded-md border border-danger/30 px-2 py-1 text-xs text-danger"><X size={13} /> Annulla</button>; }
