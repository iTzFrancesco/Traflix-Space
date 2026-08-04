import { useState, useMemo, useEffect } from "react";
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
  "anti-gravity": Bot,
  claude: Bot,
  codex: Bot,
  cline: Bot,
  freebuff: Bot,
  pi: Bot,
};

export function NewSpaceWizard({ open, onClose }: NewSpaceWizardProps) {
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const { addPreset, updatePreset, removePreset, presets } = usePresetStore();
  const { addToast } = useToastStore();

  const [step, setStep] = useState(1);
  const [folderPath, setFolderPath] = useState("");
  const [terminalCount, setTerminalCount] = useState(4);
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState(false);

  // Track which preset we're modifying (null = new preset)
  const [presetSourceId, setPresetSourceId] = useState<string | null>(null);

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

  // Carica il path di default all'apertura
  useEffect(() => {
    if (open && !folderPath) {
      invokeWithTimeout(
        () => invoke<string>("get_default_workspace_path"),
        5000,
      )
        .then((defaultPath) => {
          setFolderPath(defaultPath);
        })
        .catch(() => {
          // Fallback: prova col profilo utente
        });
    }
  }, [open]);



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

  function supportedAgentCounts(
    counts: Record<string, number>,
  ): Record<string, number> {
    const supportedIds = new Set(AGENTS.map((agent) => agent.id));
    return Object.fromEntries(
      Object.entries(counts).filter(
        ([agentId, count]) => supportedIds.has(agentId) && count > 0,
      ),
    );
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
    setPresetSourceId(preset.id);
    setFolderPath(preset.folderPath);
    setTerminalCount(preset.terminalCount);
    setAgentCounts(supportedAgentCounts(preset.agentCounts));
    setStep(4);
  }

  function handleSavePreset() {
    const name = workspaceName || "Senza nome";
    const now = new Date().toISOString();
    const supportedCounts = supportedAgentCounts(agentCounts);

    if (presetSourceId) {
      // Aggiorna il preset esistente
      updatePreset(presetSourceId, {
        name,
        folderPath,
        terminalCount,
        agentCounts: supportedCounts,
      });
      addToast({ type: "success", message: `Preset "${name}" aggiornato` });
    } else {
      // Crea un nuovo preset
      addPreset({
        id: crypto.randomUUID(),
        name,
        folderPath,
        terminalCount,
        agentCounts: supportedCounts,
        createdAt: now,
      });
      addToast({ type: "success", message: `Preset "${name}" salvato` });
    }
  }

  function handleSaveAsNewPreset() {
    const name = workspaceName || "Senza nome";
    const supportedCounts = supportedAgentCounts(agentCounts);
    addPreset({
      id: crypto.randomUUID(),
      name,
      folderPath,
      terminalCount,
      agentCounts: supportedCounts,
      createdAt: new Date().toISOString(),
    });
    addToast({ type: "success", message: `Nuovo preset "${name}" salvato` });
    setPresetSourceId(null);
  }



  function reset() {
    setStep(1);
    setFolderPath("");
    setTerminalCount(4);
    setAgentCounts({});
    setCreating(false);
    setPresetSourceId(null);
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
      for (const [agentId, count] of Object.entries(
        supportedAgentCounts(agentCounts),
      )) {
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
      <div className="space-y-6">
        {/* Step indicator */}
        <div className="surface-card p-4">
          <p className="text-xs font-semibold text-primary uppercase tracking-[0.16em] mb-3">
            Passo {step} di {STEPS.length}
          </p>
          <div className="grid grid-cols-4 gap-2">
            {STEPS.map((stepName, i) => {
              const isCurrent = step === i + 1;
              const isComplete = step > i + 1;
              return (
              <div key={stepName} className="flex min-w-0 items-center gap-2">
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all duration-300 ${
                    isCurrent || isComplete
                      ? "bg-primary text-white shadow-[0_0_16px_rgba(232,93,4,0.22)]"
                      : "bg-white/[0.07] text-neutral-text-muted"
                  }`}
                >
                  {i + 1}
                </div>
                <span className={`truncate text-xs font-medium ${isCurrent ? "text-neutral-text" : "text-neutral-text-muted"}`}>
                  {stepName}
                </span>
              </div>
            )})}
          </div>
        </div>

        {/* Step 1 — Cartella */}
        {step === 1 && (
          <div className="space-y-7">
            {/* Path attuale + Sfoglia */}
            <div className="surface-card p-6 space-y-7">
              <p className="text-base text-neutral-text-dim leading-relaxed mb-1">
                Seleziona la cartella del progetto.
              </p>

              {/* Path display + Sfoglia button */}
              <div className="flex items-stretch gap-4">
                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl bg-black/15 flex-1 min-w-0 border border-white/[0.06]">
                  <FolderOpen size={22} className="text-primary shrink-0" />
                  <span
                    className={`text-base font-mono truncate ${
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
                  className="px-9 py-4 text-base font-extrabold text-white rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(232,93,4,0.35)] whitespace-nowrap active:scale-[0.97] shrink-0"
                  style={{
                    background: "linear-gradient(135deg, #e85d04, #ff7b00)",
                    boxShadow: "0 4px 12px rgba(232, 93, 4, 0.15)",
                  }}
                >
                  Sfoglia
                </button>
              </div>
            </div>

            {/* Preset salvati */}
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
                    // Build per-agent summary in AGENTS order
                    const agentSummary = AGENTS
                      .map((a) => {
                        const count = preset.agentCounts[a.id];
                        return count && count > 0 ? `${a.name} x${count}` : null;
                      })
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <div
                        key={preset.id}
                        onClick={() => loadPreset(preset)}
                        className="rounded-2xl bg-neutral-elevated border border-white/[0.06] p-5 cursor-pointer hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-200 active:scale-[0.98] group"
                      >
                        <div className="flex items-start justify-between">
                          <div className="min-w-0 flex-1">
                            <p className="text-base font-bold text-neutral-text truncate">
                              {preset.name}
                            </p>
                            <p className="text-xs font-mono text-neutral-text-muted mt-1.5 truncate">
                              {preset.folderPath}
                            </p>
                            <div className="flex items-center gap-3 mt-2 text-xs text-neutral-text-muted">
                              <span className="font-medium tabular-nums">
                                {preset.terminalCount} terminali
                              </span>
                              {agentSummary ? (
                                <>
                                  <span className="opacity-30">&middot;</span>
                                  <span className="font-medium truncate max-w-[180px]">
                                    {agentSummary}
                                  </span>
                                </>
                              ) : null}
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
                            className="w-8 h-8 rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-white/[0.06] transition-all duration-200 shrink-0 ml-3"
                            aria-label={`Elimina preset ${preset.name}`}
                          >
                            <Trash2 size={14} className="text-red-400/60" />
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
          <div className="surface-card p-6 space-y-6">
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
                        ? "bg-primary text-neutral-bg font-extrabold shadow-[0_0_32px_rgba(255,157,36,0.18)]"
                        : "bg-white/[0.02] text-neutral-text-muted hover:bg-white/[0.05] hover:text-neutral-text-dim border border-white/[0.06]"
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
          <div className="surface-card p-5 space-y-5">
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
                      ? "linear-gradient(90deg, var(--color-primary), var(--color-primary-strong))"
                      : "linear-gradient(90deg, rgba(255,157,36,0.4), rgba(255,157,36,0.2))",
                }}
              />
            </div>

            <div className="grid grid-cols-2 gap-3.5">
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
                    <div className="p-4.5 space-y-3.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3.5">
                          <div
                            className="w-11 h-12 rounded-xl flex items-center justify-center"
                            style={{ backgroundColor: `${agent.color}20` }}
                          >
                            {(() => {
                              const IconComponent = agentIcons[agent.id] || Terminal;
                              return <IconComponent size={24} style={{ color: agent.color }} />;
                            })()}
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

                      <div className="flex items-center justify-center gap-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            decrementAgent(agent.id);
                          }}
                          disabled={count <= 0}
                          className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                          aria-label={`Rimuovi ${agent.name}`}
                        >
                          <Minus size={16} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            incrementAgent(agent.id);
                          }}
                          disabled={assignedCount >= terminalCount}
                          className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] transition-all duration-200 disabled:opacity-15 active:scale-[0.92]"
                          aria-label={`Aggiungi ${agent.name}`}
                        >
                          <Plus size={16} />
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
          <div className="surface-card p-6 space-y-6">
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
                {AGENTS.map((agent) => {
                  const count = agentCounts[agent.id];
                  if (!count || count <= 0) return null;
                  return (
                    <span
                      key={agent.id}
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

            <div className="flex flex-col gap-3">
              {presetSourceId ? (
                <>
                  <button
                    onClick={handleSavePreset}
                    className="flex items-center justify-center gap-3 w-full py-4 text-base font-bold rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] cursor-pointer"
                    style={{
                      background: "linear-gradient(135deg, var(--color-primary), var(--color-primary-strong))",
                      color: "var(--color-neutral-bg)",
                      boxShadow: "0 4px 20px rgba(255, 157, 36, 0.18)",
                    }}
                  >
                    <Save size={20} />
                    Aggiorna preset esistente
                  </button>
                  <button
                    onClick={handleSaveAsNewPreset}
                    className="flex items-center justify-center gap-3 w-full py-3 text-sm font-medium text-neutral-text-muted rounded-2xl border border-white/[0.06] hover:bg-white/[0.03] transition-all duration-200 active:scale-[0.98] cursor-pointer"
                  >
                    <Save size={16} />
                    Salva come nuovo preset
                  </button>
                </>
              ) : (
                <button
                  onClick={handleSavePreset}
                  className="flex items-center justify-center gap-3 w-full py-4 text-base font-bold rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] cursor-pointer"
                  style={{
                    background: "linear-gradient(135deg, var(--color-primary), var(--color-primary-strong))",
                    color: "var(--color-neutral-bg)",
                    boxShadow: "0 4px 20px rgba(255, 157, 36, 0.18)",
                  }}
                >
                  <Save size={20} />
                  Salva come preset
                </button>
              )}
            </div>
          </div>
        )}
 
        {/* Navigation */}
        <div className="sticky bottom-0 -mx-7 flex items-center justify-between border-t border-white/[0.06] bg-[#1a1b19]/95 px-7 pt-5 pb-2 backdrop-blur">
          <button
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
            className="flex items-center gap-3 px-8 py-4 text-lg font-bold text-neutral-text-muted rounded-2xl hover:bg-white/[0.05] hover:text-neutral-text transition-all duration-200 disabled:opacity-20 active:scale-[0.97] cursor-pointer"
          >
            <ChevronLeft size={22} />
            Indietro
          </button>
 
          {step < 4 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-3 px-11 py-4 text-lg font-extrabold rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-30 active:scale-[0.97] hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(255,157,36,0.35)] cursor-pointer"
              style={{
                background: canProceed()
                  ? "linear-gradient(135deg, var(--color-primary), var(--color-primary-strong))"
                  : "rgba(255,255,255,0.05)",
                color: canProceed() ? "var(--color-neutral-bg)" : "var(--color-neutral-text-muted)",
              }}
            >
              Avanti
              <ChevronRight size={22} />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-3 px-11 py-4 text-lg font-extrabold rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] disabled:opacity-40 active:scale-[0.97] hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(255,157,36,0.35)] cursor-pointer"
              style={{
                background: "linear-gradient(135deg, var(--color-primary), var(--color-primary-strong))",
                color: "var(--color-neutral-bg)",
              }}
            >
              {creating ? (
                <>
                  <span className="w-5 h-5 border-2 border-neutral-bg/30 border-t-neutral-bg rounded-full animate-spin" />
                  Creazione...
                </>
              ) : (
                <>
                  <Sparkles size={22} />
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
