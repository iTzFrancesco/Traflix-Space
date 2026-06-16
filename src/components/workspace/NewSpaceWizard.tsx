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
  Save,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { usePresetStore } from "../../stores/presetStore";
import { useToastStore } from "../../stores/toastStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { AGENTS } from "../../lib/agents";
import { computeLayout, QUICK_COUNTS } from "../../lib/presets";
import { Modal } from "../ui/Modal";
import type { Preset } from "../../stores/presetStore";
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
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const { addPreset, removePreset, presets } = usePresetStore();
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
      const next = Math.max(1, Math.min(8, prev + delta));
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

  function loadPreset(preset: Preset) {
    setFolderPath(preset.folderPath);
    setTerminalCount(preset.terminalCount);
    setAgentCounts(preset.agentCounts);
    setStep(4);
  }

  function handleSavePreset() {
    const name = workspaceName || "Senza nome";
    addPreset({
      id: crypto.randomUUID(),
      name,
      folderPath,
      terminalCount,
      agentCounts,
      createdAt: new Date().toISOString(),
    });
    addToast({ type: "success", message: `Preset "${name}" salvato` });
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
      const path = await invokeWithTimeout(
        () => invoke<string>("select_folder"),
        30000,
      );
      setFolderPath(path);
    } catch (err) {
      console.error("Errore selezione cartella:", err);
      addToast({
        type: "error",
        message: "Impossibile aprire il dialog di selezione cartella",
      });
    }
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
          shell: "powershell.exe",
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

      await invokeWithTimeout(
        () => invoke("create_workspace", { config }),
        15000,
      );

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
      width="max-w-3xl"
    >
      <div className="space-y-8">
        {/* Step indicator */}
        <div className="text-center">
          <p className="text-sm font-semibold text-orange-400 uppercase tracking-[0.2em] mb-4">
            {STEPS[step - 1]}
          </p>
          <div className="flex items-center justify-center gap-3">
            {STEPS.map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div
                  className={`h-3 rounded-full transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                    step > i + 1
                      ? "w-6 bg-primary shadow-[0_0_16px_rgba(232,93,4,0.3)]"
                      : step === i + 1
                        ? "w-8 bg-primary shadow-[0_0_20px_rgba(232,93,4,0.4)]"
                        : "w-3 bg-white/[0.1]"
                  }`}
                />
                {i < STEPS.length - 1 && (
                  <div className="w-6 h-px bg-white/[0.06]" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step 1 — Cartella */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="rounded-3xl bg-neutral-elevated border border-white/[0.06] p-8 space-y-6">
              <p className="text-lg text-neutral-text-dim leading-relaxed">
                Seleziona la cartella del progetto.
              </p>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-4 px-6 py-5 rounded-2xl bg-white/[0.03] flex-1 min-w-0 border border-white/[0.06]">
                  <FolderOpen size={24} className="text-primary shrink-0" />
                  <span
                    className={`text-lg font-mono truncate ${
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
                  className="px-8 py-5 text-lg font-bold text-white rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] whitespace-nowrap active:scale-[0.97]"
                  style={{
                    background: "linear-gradient(135deg, #e85d04, #ff7b00)",
                  }}
                >
                  Sfoglia
                </button>
              </div>
            </div>

            {presets.length > 0 && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-white/[0.06]" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="px-5 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-text-muted bg-[#111113]">
                      Preset salvati
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {presets.map((preset) => {
                    const agentTotal = Object.values(
                      preset.agentCounts,
                    ).reduce((a, b) => a + b, 0);
                    return (
                      <div
                        key={preset.id}
                        onClick={() => loadPreset(preset)}
                        className="rounded-2xl bg-neutral-elevated border border-white/[0.06] p-6 cursor-pointer hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-200 active:scale-[0.98] group"
                      >
                        <div className="flex items-start justify-between">
                          <div className="min-w-0 flex-1">
                            <p className="text-lg font-bold text-neutral-text truncate">
                              {preset.name}
                            </p>
                            <p className="text-sm font-mono text-neutral-text-muted mt-2 truncate">
                              {preset.folderPath}
                            </p>
                            <div className="flex items-center gap-3 mt-3 text-xs text-neutral-text-muted">
                              <span className="font-medium tabular-nums">
                                {preset.terminalCount} terminali
                              </span>
                              <span className="opacity-30">&middot;</span>
                              <span className="font-medium tabular-nums">
                                {agentTotal} agenti
                              </span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removePreset(preset.id);
                              addToast({
                                type: "info",
                                message: `Preset "${preset.name}" rimosso`,
                              });
                            }}
                            className="w-9 h-9 rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-white/[0.06] transition-all duration-200 shrink-0 ml-3"
                            aria-label={`Elimina preset ${preset.name}`}
                          >
                            <Trash2 size={16} className="text-red-400/60" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 2 — Conteggio */}
        {step === 2 && (
          <div className="rounded-3xl bg-neutral-elevated border border-white/[0.06] p-8 space-y-8">
            <p className="text-lg text-neutral-text-dim leading-relaxed">
              Quanti terminali vuoi aprire?
            </p>

            <div className="grid grid-cols-3 gap-4">
              {QUICK_COUNTS.map((n) => {
                const active = terminalCount === n;
                return (
                  <button
                    key={n}
                    onClick={() => setCount(n)}
                    className={`py-6 rounded-2xl text-center transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] ${
                      active
                        ? "bg-primary text-white font-bold shadow-[0_0_32px_rgba(232,93,4,0.25)]"
                        : "bg-white/[0.04] text-neutral-text-muted hover:bg-white/[0.08] hover:text-neutral-text-dim border border-white/[0.06]"
                    }`}
                  >
                    <span className="block text-3xl font-bold font-display">
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between p-5 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
              <div className="flex items-center gap-4">
                <LayoutGrid size={22} className="text-primary" />
                <span className="text-base text-neutral-text-dim font-medium">
                  Layout: {layout.rows}&times;{layout.cols}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => updateCount(-1)}
                  disabled={terminalCount <= 1}
                  className="flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-20 active:scale-[0.92]"
                  aria-label="Diminuisci terminali"
                >
                  <Minus size={18} />
                </button>
                <span className="font-display font-bold text-4xl text-primary min-w-[2ch] text-center tabular-nums">
                  {terminalCount}
                </span>
                <button
                  onClick={() => updateCount(1)}
                  disabled={terminalCount >= 8}
                  className="flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-20 active:scale-[0.92]"
                  aria-label="Aumenta terminali"
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3 — Agenti */}
        {step === 3 && (
          <div className="rounded-3xl bg-neutral-elevated border border-white/[0.06] p-8 space-y-6">
            <div className="flex items-center justify-between">
              <p className="text-lg text-neutral-text-dim leading-relaxed">
                Assegna agenti ai terminali.
              </p>
              <span className="text-base font-mono text-neutral-text-muted tabular-nums font-medium">
                {assignedCount}/{terminalCount}
              </span>
            </div>

            <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
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

            <div className="grid grid-cols-2 gap-4">
              {DISPLAY_AGENTS.map((agent) => {
                const count = agentCounts[agent.id] || 0;
                return (
                  <div
                    key={agent.id}
                    onClick={() => fillAllWith(agent.id)}
                    className="rounded-2xl border-2 transition-all duration-200 cursor-pointer active:scale-[0.98]"
                    style={{
                      borderColor:
                        count > 0
                          ? `${agent.color}60`
                          : "rgba(255,255,255,0.06)",
                      backgroundColor:
                        count > 0 ? `${agent.color}10` : "transparent",
                    }}
                  >
                    <div className="p-6 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div
                            className="w-12 h-12 rounded-xl flex items-center justify-center"
                            style={{ backgroundColor: `${agent.color}20` }}
                          >
                            {agentIcons[agent.id] ? (
                              <Bot size={24} style={{ color: agent.color }} />
                            ) : (
                              <Terminal
                                size={24}
                                style={{ color: agent.color }}
                              />
                            )}
                          </div>
                          <span className="text-lg font-bold text-neutral-text">
                            {agent.name}
                          </span>
                        </div>
                        <span
                          className="text-3xl font-bold font-display tabular-nums"
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

                      <div className="flex items-center justify-center gap-4">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            decrementAgent(agent.id);
                          }}
                          disabled={count <= 0}
                          className="flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                          aria-label={`Rimuovi ${agent.name}`}
                        >
                          <Minus size={18} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            incrementAgent(agent.id);
                          }}
                          disabled={assignedCount >= terminalCount}
                          className="flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                          aria-label={`Aggiungi ${agent.name}`}
                        >
                          <Plus size={18} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 4 — Conferma */}
        {step === 4 && (
          <div className="rounded-3xl bg-neutral-elevated border border-white/[0.06] p-8 space-y-8">
            <p className="text-lg text-neutral-text-dim leading-relaxed">
              Conferma i dettagli del workspace.
            </p>

            <div className="text-center pb-6 border-b border-white/[0.06]">
              <h3 className="font-display font-bold text-3xl text-neutral-text">
                {workspaceName}
              </h3>
              <p className="text-base text-neutral-text-muted mt-3 font-mono truncate">
                {folderPath}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-5">
              <div className="text-center p-7 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                <p className="text-4xl font-display font-bold text-primary">
                  {layout.rows}&times;{layout.cols}
                </p>
                <p className="text-xs uppercase tracking-widest text-neutral-text-muted mt-3 font-medium">
                  Layout
                </p>
              </div>
              <div className="text-center p-7 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                <p className="text-4xl font-display font-bold text-primary">
                  {terminalCount}
                </p>
                <p className="text-xs uppercase tracking-widest text-neutral-text-muted mt-3 font-medium">
                  Terminali
                </p>
              </div>
              <div className="text-center p-7 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                <p className="text-4xl font-display font-bold text-primary">
                  {assignedCount}
                </p>
                <p className="text-xs uppercase tracking-widest text-neutral-text-muted mt-3 font-medium">
                  Agenti
                </p>
              </div>
            </div>

            {assignedCount > 0 && (
              <div className="flex flex-wrap gap-3 justify-center">
                {Object.entries(agentCounts).map(([aid, count]) => {
                  if (count <= 0) return null;
                  const agent = AGENTS.find((a) => a.id === aid);
                  if (!agent) return null;
                  return (
                    <span
                      key={aid}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-base font-medium"
                      style={{
                        backgroundColor: `${agent.color}15`,
                        color: agent.color,
                        border: `1px solid ${agent.color}30`,
                      }}
                    >
                      {agent.name}
                      <span className="opacity-60">&times;{count}</span>
                    </span>
                  );
                })}
              </div>
            )}

            <button
              onClick={handleSavePreset}
              className="flex items-center justify-center gap-3 w-full py-4 text-base font-bold text-white rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98]"
              style={{
                background: "linear-gradient(135deg, #e85d04, #ff7b00)",
                boxShadow: "0 4px 20px rgba(232, 93, 4, 0.25)",
              }}
            >
              <Save size={20} />
              Salva come preset
            </button>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
            className="flex items-center gap-3 px-6 py-4 text-lg text-neutral-text-muted rounded-2xl hover:bg-white/[0.04] transition-all duration-200 disabled:opacity-20 active:scale-[0.97]"
          >
            <ChevronLeft size={20} />
            Indietro
          </button>

          {step < 4 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-3 px-8 py-4 text-lg font-bold text-white rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-30 active:scale-[0.97]"
              style={{
                background: canProceed()
                  ? "linear-gradient(135deg, #e85d04, #ff7b00)"
                  : "rgba(255,255,255,0.05)",
              }}
            >
              Avanti
              <ChevronRight size={20} />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-3 px-8 py-4 text-lg font-bold text-white rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-40 active:scale-[0.97]"
              style={{
                background: "linear-gradient(135deg, #e85d04, #ff7b00)",
              }}
            >
              {creating ? (
                <>
                  <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Creazione...
                </>
              ) : (
                <>
                  <Sparkles size={20} />
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
