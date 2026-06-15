import { useState, useMemo } from "react";
import {
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Plus,
  Minus,
  Bot,
  Terminal,
  LayoutGrid,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useToastStore } from "../../stores/toastStore";
import { AGENTS } from "../../lib/agents";
import { computeLayout, QUICK_COUNTS } from "../../lib/presets";
import { Modal } from "../ui/Modal";
import type { Workspace } from "../../stores/workspaceStore";
import type { TerminalConfig } from "../../stores/terminalStore";

interface NewSpaceWizardProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = ["Cartella", "Conteggio", "Agenti", "Conferma"];

const DISPLAY_AGENTS = AGENTS;

const agentIcons: Record<string, typeof Bot> = {
  opencode: Terminal,
  gemini: Bot,
  claude: Bot,
  codex: Bot,
  "anti-gravity": Bot,
};

export function NewSpaceWizard({ open, onClose }: NewSpaceWizardProps) {
  const { addWorkspace, setActiveWorkspace } = useWorkspaceStore();
  const { addToast } = useToastStore();

  const [step, setStep] = useState(1);
  const [folderPath, setFolderPath] = useState("");
  const [terminalCount, setTerminalCount] = useState(4);
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState(false);

  const assignedCount = useMemo(
    () => Object.values(agentCounts).reduce((a, b) => a + b, 0),
    [agentCounts],
  );

  const layout = useMemo(() => computeLayout(terminalCount), [terminalCount]);

  const workspaceName = useMemo(() => {
    if (!folderPath) return "";
    const parts = folderPath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || "untitled";
  }, [folderPath]);

  function normalizeCounts(
    counts: Record<string, number>,
    max: number,
  ): Record<string, number> {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total <= max) return counts;
    const keys = Object.keys(counts);
    let remaining = max;
    const next: Record<string, number> = {};
    for (let i = 0; i < keys.length; i++) {
      if (i === keys.length - 1) {
        next[keys[i]] = remaining;
      } else {
        next[keys[i]] = Math.min(counts[keys[i]], remaining);
        remaining -= next[keys[i]];
      }
    }
    return next;
  }

  function updateCount(delta: number) {
    setTerminalCount((prev) => {
      const next = Math.max(1, Math.min(16, prev + delta));
      setAgentCounts((c) => normalizeCounts(c, next));
      return next;
    });
  }

  function setCount(n: number) {
    setTerminalCount(n);
    setAgentCounts((c) => normalizeCounts(c, n));
  }

  function incrementAgent(id: string) {
    setAgentCounts((prev) => {
      const total = Object.values(prev).reduce((a, b) => a + b, 0);
      if (total >= terminalCount) return prev;
      return { ...prev, [id]: (prev[id] || 0) + 1 };
    });
  }

  function decrementAgent(id: string) {
    setAgentCounts((prev) => {
      const current = prev[id] || 0;
      if (current <= 0) return prev;
      const next = { ...prev, [id]: current - 1 };
      return next;
    });
  }

  function fillAllWith(id: string) {
    setAgentCounts({ [id]: terminalCount });
  }

  function reset() {
    setStep(1);
    setFolderPath("");
    setTerminalCount(4);
    setAgentCounts({});
    setCreating(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSelectFolder() {
    try {
      const path = await invoke<string>("select_folder");
      setFolderPath(path);
    } catch {}
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const ids: (string | null)[] = [];
      for (const [agentId, count] of Object.entries(agentCounts)) {
        for (let i = 0; i < count; i++) ids.push(agentId);
      }
      while (ids.length < terminalCount) ids.push(null);

      const terminals: TerminalConfig[] = Array.from(
        { length: terminalCount },
        (_, i) => ({
          id: crypto.randomUUID(),
          shell: "bash",
          agentId: ids[i] || null,
          command: null,
          cwd: folderPath,
          title: ids[i]
            ? AGENTS.find((a) => a.id === ids[i])?.name ?? "Terminale"
            : "Terminale",
        }),
      );

      const now = new Date().toISOString();
      const config = {
        id: crypto.randomUUID(),
        name: workspaceName,
        rootPath: folderPath,
        layout,
        terminals,
        createdAt: now,
        updatedAt: now,
      };

      await invoke("create_workspace", { config });

      const workspace: Workspace = {
        id: config.id,
        name: config.name,
        rootPath: config.rootPath,
        layout: config.layout,
        terminalCount: config.terminals.length,
        agentCount: config.terminals.filter((t) => t.agentId).length,
        lastOpened: now,
        createdAt: now,
        updatedAt: now,
      };

      addWorkspace(workspace);
      setActiveWorkspace(workspace.id);
      handleClose();
    } catch (err) {
      console.error("Errore creazione workspace:", err);
      addToast({
        type: "error",
        message: "Errore nella creazione del workspace",
      });
    } finally {
      setCreating(false);
    }
  }

  function canProceed(): boolean {
    switch (step) {
      case 1:
        return folderPath.length > 0;
      case 2:
        return terminalCount >= 1;
      default:
        return true;
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Nuovo Spazio di Lavoro"
      width="max-w-xl"
    >
      <div className="space-y-8">
        {/* Step indicator */}
        <div className="text-center">
          <p className="text-[0.55rem] font-medium text-neutral-text-muted uppercase tracking-[0.2em] mb-3">
            {STEPS[step - 1]}
          </p>
          <div className="flex items-center justify-center gap-2">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-2 rounded-full transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                  step > i + 1
                    ? "w-3 bg-primary shadow-[0_0_8px_rgba(232,93,4,0.2)]"
                    : step === i + 1
                      ? "w-3 bg-primary shadow-[0_0_8px_rgba(232,93,4,0.2)]"
                      : "w-2 bg-white/[0.08]"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Step 1 — Cartella */}
        {step === 1 && (
          <div className="p-1 rounded-2xl bg-white/[0.03]">
            <div className="rounded-[calc(1rem-0.25rem)] bg-neutral-elevated p-5 space-y-4">
              <p className="text-sm text-neutral-text-dim">
                Seleziona la cartella del progetto.
              </p>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.03] flex-1 min-w-0 border border-white/[0.04]">
                  <FolderOpen size={16} className="text-primary shrink-0" />
                  <span
                    className={`text-sm font-mono truncate ${
                      folderPath
                        ? "text-neutral-text"
                        : "text-neutral-text-muted"
                    }`}
                  >
                    {folderPath || "Nessuna cartella"}
                  </span>
                </div>
                <button
                  onClick={handleSelectFolder}
                  className="px-5 py-3 text-sm font-medium text-white rounded-xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] whitespace-nowrap active:scale-[0.97]"
                  style={{
                    background: "linear-gradient(135deg, #e85d04, #ff7b00)",
                  }}
                >
                  Sfoglia
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 2 — Conteggio */}
        {step === 2 && (
          <div className="p-1 rounded-2xl bg-white/[0.03]">
            <div className="rounded-[calc(1rem-0.25rem)] bg-neutral-elevated p-5 space-y-5">
              <p className="text-sm text-neutral-text-dim">
                Quanti terminali vuoi aprire?
              </p>

              <div className="grid grid-cols-5 gap-2">
                {QUICK_COUNTS.map((n) => {
                  const active = terminalCount === n;
                  return (
                    <button
                      key={n}
                      onClick={() => setCount(n)}
                      className={`py-3 rounded-xl text-center transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] ${
                        active
                          ? "bg-primary text-white font-bold shadow-[0_0_16px_rgba(232,93,4,0.15)]"
                          : "bg-white/[0.04] text-neutral-text-muted hover:bg-white/[0.08] hover:text-neutral-text-dim"
                      }`}
                    >
                      <span className="block text-lg font-bold font-display">
                        {n}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <LayoutGrid size={15} className="text-primary" />
                  <span className="text-xs text-neutral-text-dim">
                    Layout: {layout.rows}&times;{layout.cols}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => updateCount(-1)}
                    disabled={terminalCount <= 1}
                    className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-20 active:scale-[0.92]"
                    aria-label="Diminuisci terminali"
                  >
                    <Minus size={13} />
                  </button>
                  <span className="font-display font-bold text-xl text-primary min-w-[2ch] text-center tabular-nums">
                    {terminalCount}
                  </span>
                  <button
                    onClick={() => updateCount(1)}
                    disabled={terminalCount >= 16}
                    className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-20 active:scale-[0.92]"
                    aria-label="Aumenta terminali"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 3 — Agenti */}
        {step === 3 && (
          <div className="p-1 rounded-2xl bg-white/[0.03]">
            <div className="rounded-[calc(1rem-0.25rem)] bg-neutral-elevated p-5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-neutral-text-dim">
                  Assegna agenti ai terminali.
                </p>
                <span className="text-xs font-mono text-neutral-text-muted tabular-nums">
                  {assignedCount}/{terminalCount}
                </span>
              </div>

              <div className="h-1 rounded-full bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
                  style={{
                    width: `${(assignedCount / terminalCount) * 100}%`,
                    background:
                      assignedCount === terminalCount
                        ? "linear-gradient(90deg, #e85d04, #ff7b00)"
                        : "linear-gradient(90deg, rgba(232,93,4,0.5), rgba(232,93,4,0.3))",
                  }}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                {DISPLAY_AGENTS.map((agent) => {
                  const count = agentCounts[agent.id] || 0;
                  return (
                    <div
                      key={agent.id}
                      onClick={() => fillAllWith(agent.id)}
                      className="rounded-xl border transition-all duration-200 cursor-pointer active:scale-[0.98]"
                      style={{
                        borderColor:
                          count > 0
                            ? `${agent.color}30`
                            : "rgba(255,255,255,0.04)",
                        backgroundColor:
                          count > 0 ? `${agent.color}06` : "transparent",
                      }}
                    >
                      <div className="p-3.5 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <div
                              className="w-8 h-8 rounded-lg flex items-center justify-center"
                              style={{ backgroundColor: `${agent.color}15` }}
                            >
                              {agentIcons[agent.id] ? (
                                <Bot size={14} style={{ color: agent.color }} />
                              ) : (
                                <Terminal size={14} style={{ color: agent.color }} />
                              )}
                            </div>
                            <span className="text-sm font-semibold text-neutral-text">
                              {agent.name}
                            </span>
                          </div>
                          <span
                            className="text-base font-bold font-display tabular-nums"
                            style={{
                              color:
                                count > 0
                                  ? agent.color
                                  : "rgba(255,255,255,0.15)",
                            }}
                          >
                            {count}
                          </span>
                        </div>

                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); decrementAgent(agent.id); }}
                            disabled={count <= 0}
                            className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                            aria-label={`Rimuovi ${agent.name}`}
                          >
                            <Minus size={12} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); incrementAgent(agent.id); }}
                            disabled={assignedCount >= terminalCount}
                            className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                            aria-label={`Aggiungi ${agent.name}`}
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Step 4 — Conferma */}
        {step === 4 && (
          <div className="p-1 rounded-2xl bg-white/[0.03]">
            <div className="rounded-[calc(1rem-0.25rem)] bg-neutral-elevated p-5 space-y-5">
              <p className="text-sm text-neutral-text-dim">
                Conferma i dettagli del workspace.
              </p>

              <div className="text-center pb-4 border-b border-white/[0.04]">
                <h3 className="font-display font-bold text-lg text-neutral-text">
                  {workspaceName}
                </h3>
                <p className="text-xs text-neutral-text-muted mt-1 font-mono truncate">
                  {folderPath}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-4 rounded-xl bg-white/[0.03]">
                  <p className="text-2xl font-display font-bold text-primary">
                    {layout.rows}&times;{layout.cols}
                  </p>
                  <p className="text-[0.5rem] uppercase tracking-widest text-neutral-text-muted mt-1.5">
                    Layout
                  </p>
                </div>
                <div className="text-center p-4 rounded-xl bg-white/[0.03]">
                  <p className="text-2xl font-display font-bold text-primary">
                    {terminalCount}
                  </p>
                  <p className="text-[0.5rem] uppercase tracking-widest text-neutral-text-muted mt-1.5">
                    Terminali
                  </p>
                </div>
                <div className="text-center p-4 rounded-xl bg-white/[0.03]">
                  <p className="text-2xl font-display font-bold text-primary">
                    {assignedCount}
                  </p>
                  <p className="text-[0.5rem] uppercase tracking-widest text-neutral-text-muted mt-1.5">
                    Agenti
                  </p>
                </div>
              </div>

              {assignedCount > 0 && (
                <div className="flex flex-wrap gap-2 justify-center">
                  {Object.entries(agentCounts).map(([aid, count]) => {
                    if (count <= 0) return null;
                    const agent = AGENTS.find((a) => a.id === aid);
                    if (!agent) return null;
                    return (
                      <span
                        key={aid}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[0.55rem] font-medium"
                        style={{
                          backgroundColor: `${agent.color}10`,
                          color: agent.color,
                          border: `1px solid ${agent.color}20`,
                        }}
                      >
                        {agent.name}
                        <span className="opacity-60">&times;{count}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
            className="flex items-center gap-1 px-3 py-2 text-sm text-neutral-text-muted rounded-xl hover:bg-white/[0.04] transition-all duration-200 disabled:opacity-20 active:scale-[0.97]"
          >
            <ChevronLeft size={15} />
            Indietro
          </button>

          {step < 4 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white rounded-xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-30 active:scale-[0.97]"
              style={{
                background: canProceed()
                  ? "linear-gradient(135deg, #e85d04, #ff7b00)"
                  : "rgba(255,255,255,0.05)",
              }}
            >
              Avanti
              <ChevronRight size={14} />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white rounded-xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-40 active:scale-[0.97]"
              style={{
                background: "linear-gradient(135deg, #e85d04, #ff7b00)",
              }}
            >
              {creating ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Creazione...
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  Crea
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
