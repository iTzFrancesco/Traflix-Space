import { useState, useMemo } from "react";
import {
  FolderOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Plus,
  Minus,
  Bot,
  Terminal,
  LayoutGrid,
  BrainCircuit,
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

const STEPS = [
  { num: 1, label: "Cartella" },
  { num: 2, label: "Conteggio" },
  { num: 3, label: "Agenti" },
  { num: 4, label: "Conferma" },
];

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
      case 3:
        return true;
      case 4:
        return true;
      default:
        return false;
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Nuovo Spazio di Lavoro"
      width="max-w-3xl"
    >
      <div className="space-y-7">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.num} className="flex items-center gap-2">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                  step > s.num
                    ? "bg-primary text-white shadow-[0_0_12px_rgba(232,93,4,0.25)]"
                    : step === s.num
                      ? "bg-primary/15 text-primary ring-1 ring-primary/40 shadow-[0_0_8px_rgba(232,93,4,0.12)]"
                      : "bg-white/[0.04] text-neutral-text-muted"
                }`}
              >
                {step > s.num ? <Check size={13} /> : s.num}
              </div>
              <span
                className={`text-[0.65rem] font-medium tracking-wide uppercase transition-colors ${
                  step === s.num ? "text-neutral-text" : "text-neutral-text-muted"
                }`}
              >
                {s.label}
              </span>
              {i < STEPS.length - 1 && (
                <div
                  className="w-8 h-px mx-1 transition-colors duration-500"
                  style={{
                    backgroundColor:
                      step > s.num
                        ? "var(--color-primary, #e85d04)"
                        : "rgba(255,255,255,0.05)",
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step 1 — Cartella */}
        {step === 1 && (
          <div className="space-y-5">
            <p className="text-sm text-neutral-text-dim">
              Seleziona la cartella del progetto per iniziare.
            </p>

            {/* Current folder */}
            <div
              className="flex items-center gap-3 p-1 rounded-2xl"
              style={{ backgroundColor: "rgba(255,255,255,0.03)" }}
            >
              <div className="flex items-center gap-3 px-4 py-3 rounded-[calc(1rem-0.25rem)] flex-1 bg-neutral-elevated">
                <FolderOpen size={16} className="text-primary shrink-0" />
                <span
                  className={`text-sm font-mono truncate ${
                    folderPath
                      ? "text-neutral-text"
                      : "text-neutral-text-muted"
                  }`}
                >
                  {folderPath || "Nessuna cartella selezionata"}
                </span>
              </div>
              <button
                onClick={handleSelectFolder}
                className="px-4 py-3 mr-0.5 text-sm font-medium text-primary bg-primary/10 border border-primary/20 rounded-xl hover:bg-primary/20 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] whitespace-nowrap active:scale-[0.97]"
              >
                Sfoglia...
              </button>
            </div>

            {folderPath && (
              <p className="text-xs text-neutral-text-muted font-mono">
                Nome progetto:{" "}
                <span className="text-neutral-text-dim font-medium">
                  {workspaceName}
                </span>
              </p>
            )}
          </div>
        )}

        {/* Step 2 — Conteggio */}
        {step === 2 && (
          <div className="space-y-6">
            <p className="text-sm text-neutral-text-dim">
              Quanti terminali vuoi aprire nel workspace?
            </p>

            {/* Quick counts */}
            <div className="grid grid-cols-5 gap-3">
              {QUICK_COUNTS.map((n) => {
                const active = terminalCount === n;
                return (
                  <button
                    key={n}
                    onClick={() => setCount(n)}
                    className={`relative py-4 rounded-2xl text-center transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] ${
                      active
                        ? "bg-primary/10 text-primary ring-1 ring-primary/40 shadow-[0_0_16px_rgba(232,93,4,0.08)]"
                        : "bg-white/[0.03] text-neutral-text-muted hover:bg-white/[0.06] hover:text-neutral-text-dim border border-white/[0.04]"
                    }`}
                  >
                    <span className="block text-xl font-bold font-display">
                      {n}
                    </span>
                    <span className="text-[0.55rem] uppercase tracking-wider mt-1 block opacity-60">
                      terminali
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Divider */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/[0.04]" />
              </div>
              <div className="relative flex justify-center">
                <span className="px-3 text-[0.6rem] uppercase tracking-widest text-neutral-text-muted bg-[#111113]">
                  o personalizza
                </span>
              </div>
            </div>

            {/* +/- controls */}
            <div className="flex items-center justify-between p-1 rounded-2xl bg-white/[0.03]">
              <div className="flex items-center gap-4 px-5 py-3.5 rounded-[calc(1rem-0.25rem)] flex-1 bg-neutral-elevated">
                <LayoutGrid size={16} className="text-primary shrink-0" />
                <div>
                  <p className="text-sm font-medium text-neutral-text">
                    Terminali
                  </p>
                  <p className="text-[0.6rem] text-neutral-text-muted mt-0.5">
                    Layout: {layout.rows}&times;{layout.cols}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 px-4">
                <button
                  onClick={() => updateCount(-1)}
                  disabled={terminalCount <= 1}
                  className="flex items-center justify-center w-9 h-9 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-20 active:scale-[0.92]"
                >
                  <Minus size={14} />
                </button>
                <span className="font-display font-bold text-2xl text-primary min-w-[2.5ch] text-center tabular-nums">
                  {terminalCount}
                </span>
                <button
                  onClick={() => updateCount(1)}
                  disabled={terminalCount >= 16}
                  className="flex items-center justify-center w-9 h-9 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-20 active:scale-[0.92]"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            {/* Grid preview */}
            <div className="flex items-center gap-2 justify-center">
              {Array.from({ length: terminalCount }).map((_, i) => (
                <div
                  key={i}
                  className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center transition-all duration-300"
                  style={{
                    animationDelay: `${i * 30}ms`,
                  }}
                >
                  <span className="text-[0.5rem] font-mono text-primary/60">
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3 — Agenti */}
        {step === 3 && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-text-dim">
                Assegna agenti ai {terminalCount} terminali.
              </p>
              <span className="text-xs font-mono text-neutral-text-muted">
                {assignedCount}/{terminalCount} assegnati
              </span>
            </div>

            {/* Progress bar */}
            <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
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

            {/* Agent cards */}
            <div className="grid grid-cols-2 gap-3">
              {DISPLAY_AGENTS.map((agent) => {
                const count = agentCounts[agent.id] || 0;
                return (
                  <div
                    key={agent.id}
                    className="p-1 rounded-2xl transition-all duration-300"
                    style={{
                      backgroundColor: count > 0 ? `${agent.color}08` : "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div className="rounded-[calc(1rem-0.25rem)] bg-neutral-elevated p-4 border border-white/[0.04]">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-9 h-9 rounded-xl flex items-center justify-center"
                            style={{
                              backgroundColor: `${agent.color}18`,
                            }}
                          >
                            {agentIcons[agent.id] ? (
                              <Bot size={16} style={{ color: agent.color }} />
                            ) : (
                              <Terminal size={16} style={{ color: agent.color }} />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-neutral-text">
                              {agent.name}
                            </p>
                            <p className="text-[0.6rem] text-neutral-text-muted mt-px">
                              {agent.description}
                            </p>
                          </div>
                        </div>
                        <span
                          className="text-lg font-bold font-display tabular-nums transition-all duration-300"
                          style={{ color: count > 0 ? agent.color : "rgba(255,255,255,0.15)" }}
                        >
                          {count}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => decrementAgent(agent.id)}
                          disabled={count <= 0}
                          className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                        >
                          <Minus size={12} />
                        </button>

                        <button
                          onClick={() => fillAllWith(agent.id)}
                          className="flex-1 text-[0.6rem] font-medium py-1.5 rounded-lg uppercase tracking-wider transition-all duration-200 active:scale-[0.97]"
                          style={{
                            backgroundColor: `${agent.color}12`,
                            color: agent.color,
                          }}
                        >
                          {assignedCount === count ? "Rimuovi tutti" : "Tutti"}
                        </button>

                        <button
                          onClick={() => incrementAgent(agent.id)}
                          disabled={
                            assignedCount >= terminalCount
                          }
                          className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {assignedCount < terminalCount && (
              <p className="text-xs text-neutral-text-muted text-center">
                {terminalCount - assignedCount} terminale{terminalCount - assignedCount !== 1 ? "i" : ""}{" "}
                senza agente
              </p>
            )}
          </div>
        )}

        {/* Step 4 — Conferma */}
        {step === 4 && (
          <div className="space-y-5">
            <p className="text-sm text-neutral-text-dim">
              Riepilogo del nuovo spazio di lavoro. Conferma per creare.
            </p>

            <div
              className="p-1 rounded-2xl"
              style={{ backgroundColor: "rgba(255,255,255,0.03)" }}
            >
              <div className="rounded-[calc(1rem-0.25rem)] bg-neutral-elevated p-5 space-y-4">
                <div className="flex items-center gap-3 pb-4 border-b border-white/[0.04]">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                    <BrainCircuit size={20} className="text-primary" />
                  </div>
                  <div>
                    <h3 className="font-display font-bold text-base text-neutral-text">
                      {workspaceName}
                    </h3>
                    <p className="text-xs text-neutral-text-muted mt-0.5 font-mono">
                      {folderPath}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="text-center p-3.5 rounded-xl bg-white/[0.03]">
                    <p className="text-2xl font-display font-bold text-primary">
                      {layout.rows}&times;{layout.cols}
                    </p>
                    <p className="text-[0.55rem] uppercase tracking-wider text-neutral-text-muted mt-1">
                      Layout
                    </p>
                  </div>
                  <div className="text-center p-3.5 rounded-xl bg-white/[0.03]">
                    <p className="text-2xl font-display font-bold text-primary">
                      {terminalCount}
                    </p>
                    <p className="text-[0.55rem] uppercase tracking-wider text-neutral-text-muted mt-1">
                      Terminali
                    </p>
                  </div>
                  <div className="text-center p-3.5 rounded-xl bg-white/[0.03]">
                    <p className="text-2xl font-display font-bold text-primary">
                      {assignedCount}
                    </p>
                    <p className="text-[0.55rem] uppercase tracking-wider text-neutral-text-muted mt-1">
                      Agenti
                    </p>
                  </div>
                </div>

                {assignedCount > 0 && (
                  <div>
                    <p className="text-[0.55rem] font-medium text-neutral-text-muted mb-2 uppercase tracking-widest">
                      Agenti configurati
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(agentCounts).map(([aid, count]) => {
                        if (count <= 0) return null;
                        const agent = AGENTS.find((a) => a.id === aid);
                        if (!agent) return null;
                        return (
                          <span
                            key={aid}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[0.6rem] font-medium"
                            style={{
                              backgroundColor: `${agent.color}12`,
                              color: agent.color,
                              border: `1px solid ${agent.color}20`,
                            }}
                          >
                            <Bot size={10} />
                            {agent.name}
                            <span className="opacity-60 ml-0.5">&times;{count}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between pt-4 border-t border-white/[0.04]">
          <button
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-neutral-text-muted rounded-xl hover:bg-white/[0.04] transition-all duration-200 disabled:opacity-20 active:scale-[0.97]"
          >
            <ChevronLeft size={15} />
            Indietro
          </button>

          {step < 4 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canProceed()}
              className="group flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white rounded-xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-30 active:scale-[0.97]"
              style={{
                background: canProceed()
                  ? "linear-gradient(135deg, #e85d04, #ff7b00)"
                  : "rgba(255,255,255,0.05)",
              }}
            >
              Avanti
              <div className="w-5 h-5 rounded-full bg-white/15 flex items-center justify-center group-hover:translate-x-0.5 transition-transform duration-200">
                <ChevronRight size={12} />
              </div>
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="group flex items-center gap-2.5 px-6 py-2.5 text-sm font-bold text-white rounded-xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-40 active:scale-[0.97]"
              style={{
                background: "linear-gradient(135deg, #e85d04, #ff7b00)",
              }}
            >
              {creating ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Creazione...
                </>
              ) : (
                <>
                  <Sparkles size={15} />
                  Crea Spazio
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
