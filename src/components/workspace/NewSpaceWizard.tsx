import { useState, useMemo } from "react";
import {
  FolderOpen,
  LayoutGrid,
  SlidersHorizontal,
  Check,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Plus,
  Minus,
  Bot,
  Terminal,
  Code,
  Server,
  Container,
  Database,
  BrainCircuit,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { PRESETS } from "../../lib/presets";
import { AGENTS } from "../../lib/agents";
import { Modal } from "../ui/Modal";
import type { Workspace } from "../../stores/workspaceStore";
import type { TerminalConfig } from "../../types/workspace";

interface NewSpaceWizardProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = [
  { num: 1, label: "Cartella" },
  { num: 2, label: "Preset" },
  { num: 3, label: "Terminali" },
  { num: 4, label: "Conferma" },
];

const presetIcons: Record<string, typeof Sparkles> = {
  blank: Terminal,
  fullstack: Code,
  "api-server": Server,
  "ai-swarm": Bot,
  devops: Container,
  "data-science": Database,
};

export function NewSpaceWizard({ open, onClose }: NewSpaceWizardProps) {
  const { addWorkspace, setActiveWorkspace } = useWorkspaceStore();

  const [step, setStep] = useState(1);
  const [folderPath, setFolderPath] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [isManual, setIsManual] = useState(false);
  const [terminalCount, setTerminalCount] = useState(1);
  const [agentIds, setAgentIds] = useState<(string | null)[]>([null]);
  const [shells, setShells] = useState<string[]>(["bash"]);
  const [creating, setCreating] = useState(false);

  const preset = selectedPresetId
    ? PRESETS.find((p) => p.id === selectedPresetId) ?? null
    : null;

  const layout = useMemo(() => {
    if (preset && !isManual) return preset.layout;
    if (terminalCount === 1) return { rows: 1, cols: 1 };
    if (terminalCount <= 2) return { rows: 1, cols: 2 };
    if (terminalCount <= 4) return { rows: 2, cols: 2 };
    if (terminalCount <= 6) return { rows: 2, cols: 3 };
    if (terminalCount <= 9) return { rows: 3, cols: 3 };
    if (terminalCount <= 12) return { rows: 3, cols: 4 };
    return { rows: 4, cols: 4 };
  }, [preset, isManual, terminalCount]);

  const workspaceName = useMemo(() => {
    if (!folderPath) return "";
    const parts = folderPath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || "untitled";
  }, [folderPath]);

  function reset() {
    setStep(1);
    setFolderPath("");
    setSelectedPresetId(null);
    setIsManual(false);
    setTerminalCount(1);
    setAgentIds([null]);
    setShells(["bash"]);
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
    } catch {
      // User cancelled
    }
  }

  function handleSelectPreset(id: string) {
    setSelectedPresetId(id);
    setIsManual(false);
    const p = PRESETS.find((pr) => pr.id === id);
    if (p) {
      setTerminalCount(p.terminalCount);
      setAgentIds(Array(p.terminalCount).fill(p.agentId));
      setShells(Array(p.terminalCount).fill(p.shell));
    }
  }

  function handleManualMode() {
    setIsManual(true);
    setSelectedPresetId(null);
  }

  function updateTerminalCount(delta: number) {
    const next = Math.max(1, Math.min(16, terminalCount + delta));
    setTerminalCount(next);
    setAgentIds((prev) => {
      const arr = [...prev];
      while (arr.length < next) arr.push(null);
      while (arr.length > next) arr.pop();
      return arr;
    });
    setShells((prev) => {
      const arr = [...prev];
      while (arr.length < next) arr.push("bash");
      while (arr.length > next) arr.pop();
      return arr;
    });
  }

  function updateAgent(index: number, agentId: string | null) {
    setAgentIds((prev) => {
      const arr = [...prev];
      arr[index] = agentId || null;
      return arr;
    });
  }

  function updateShell(index: number, shell: string) {
    setShells((prev) => {
      const arr = [...prev];
      arr[index] = shell;
      return arr;
    });
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const terminals: TerminalConfig[] = Array.from(
        { length: terminalCount },
        (_, i) => ({
          id: crypto.randomUUID(),
          shell: shells[i] || "bash",
          agentId: agentIds[i] || null,
          command: null,
          cwd: folderPath,
          title:
            agentIds[i]
              ? AGENTS.find((a) => a.id === agentIds[i])?.name ?? shells[i]
              : shells[i],
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
    } finally {
      setCreating(false);
    }
  }

  function canProceed(): boolean {
    switch (step) {
      case 1: return folderPath.length > 0;
      case 2: return isManual || !!preset;
      case 3: return terminalCount >= 1;
      case 4: return true;
      default: return false;
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Nuovo Spazio di Lavoro" width="max-w-3xl">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <div key={s.num} className="flex items-center gap-2">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors ${
                step > s.num
                  ? "bg-primary text-white"
                  : step === s.num
                    ? "bg-primary/20 text-primary border border-primary/40"
                    : "bg-neutral-elevated text-neutral-text-muted"
              }`}
            >
              {step > s.num ? <Check size={14} /> : s.num}
            </div>
            <span
              className={`text-xs font-medium ${
                step === s.num ? "text-neutral-text" : "text-neutral-text-muted"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <div
                className="w-8 h-px mx-1"
                style={{
                  backgroundColor:
                    step > s.num ? "var(--color-primary, #e85d04)" : "rgba(255,255,255,0.06)",
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step 1: Folder Selection */}
      {step === 1 && (
        <div className="space-y-5">
          <p className="text-sm text-neutral-text-dim">
            Seleziona la cartella del progetto per questo workspace.
          </p>

          <div className="flex items-center gap-3">
            <div
              className="flex-1 flex items-center gap-3 px-4 py-3 rounded-lg border bg-neutral-elevated"
              style={{ borderColor: "rgba(255,255,255,0.06)" }}
            >
              <FolderOpen size={18} className="text-primary shrink-0" />
              <span
                className={`text-sm truncate ${
                  folderPath ? "text-neutral-text" : "text-neutral-text-muted"
                }`}
              >
                {folderPath || "Nessuna cartella selezionata"}
              </span>
            </div>
            <button
              onClick={handleSelectFolder}
              className="px-4 py-3 text-sm font-medium text-primary bg-primary/10 border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors whitespace-nowrap"
            >
              Sfoglia...
            </button>
          </div>

          {folderPath && (
            <p className="text-xs text-neutral-text-muted">
              Nome progetto: <span className="text-neutral-text-dim font-medium">{workspaceName}</span>
            </p>
          )}
        </div>
      )}

      {/* Step 2: Preset Selection */}
      {step === 2 && (
        <div className="space-y-5">
          <p className="text-sm text-neutral-text-dim">
            Scegli un preset per configurare rapidamente il workspace, o configura manualmente.
          </p>

          <div className="grid grid-cols-3 gap-3">
            {PRESETS.map((p) => {
              const Icon = presetIcons[p.id] || Terminal;
              const isSelected = selectedPresetId === p.id && !isManual;
              return (
                <button
                  key={p.id}
                  onClick={() => handleSelectPreset(p.id)}
                  className={`flex flex-col items-start gap-3 p-4 rounded-xl border text-left transition-all ${
                    isSelected
                      ? "border-primary/50 bg-primary/5"
                      : "border-transparent bg-neutral-elevated hover:bg-white/[0.03]"
                  }`}
                  style={isSelected ? { boxShadow: "0 0 20px rgba(232,93,4,0.08)" } : undefined}
                >
                  <Icon size={24} className={isSelected ? "text-primary" : "text-neutral-text-muted"} />
                  <div>
                    <p className="text-sm font-medium text-neutral-text">{p.name}</p>
                    <p className="text-xs text-neutral-text-muted mt-1">{p.description}</p>
                    <div className="flex gap-3 mt-2">
                      <span className="text-[0.65rem] text-neutral-text-muted">
                        {p.terminalCount} term
                      </span>
                      <span className="text-[0.65rem] text-neutral-text-muted">
                        {p.agentCount} agenti
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
              <div className="w-full border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }} />
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 text-xs text-neutral-text-muted bg-[#111113]">
                oppure
              </span>
            </div>
          </div>

          <button
            onClick={handleManualMode}
            className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl border text-left transition-all ${
              isManual
                ? "border-primary/50 bg-primary/5"
                : "border-transparent bg-neutral-elevated hover:bg-white/[0.03]"
            }`}
          >
            <SlidersHorizontal size={20} className={isManual ? "text-primary" : "text-neutral-text-muted"} />
            <div>
              <p className="text-sm font-medium text-neutral-text">Configurazione Manuale</p>
              <p className="text-xs text-neutral-text-muted mt-0.5">
                Scegli numero e tipo di terminali manualmente
              </p>
            </div>
          </button>
        </div>
      )}

      {/* Step 3: Terminal Configuration */}
      {step === 3 && (
        <div className="space-y-5">
          <p className="text-sm text-neutral-text-dim">
            Configura terminali e agenti per questo workspace.
          </p>

          {/* Terminal count slider */}
          <div className="flex items-center justify-between p-4 rounded-xl bg-neutral-elevated border" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
            <div>
              <p className="text-sm font-medium text-neutral-text">Terminali</p>
              <p className="text-xs text-neutral-text-muted mt-0.5">Da 1 a 16</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => updateTerminalCount(-1)}
                disabled={terminalCount <= 1}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-30"
              >
                <Minus size={14} />
              </button>
              <span className="font-display font-bold text-xl text-primary min-w-[2ch] text-center tabular-nums">
                {terminalCount}
              </span>
              <button
                onClick={() => updateTerminalCount(1)}
                disabled={terminalCount >= 16}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-30"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* Layout preview */}
          <div className="flex items-center gap-3">
            <LayoutGrid size={16} className="text-neutral-text-muted shrink-0" />
            <span className="text-xs text-neutral-text-muted">
              Layout: <strong className="text-neutral-text-dim">{layout.rows}x{layout.cols}</strong> grid
            </span>
          </div>

          {/* Per-terminal config */}
          <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
            {Array.from({ length: terminalCount }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-3 rounded-lg border bg-neutral-elevated"
                style={{ borderColor: "rgba(255,255,255,0.06)" }}
              >
                <span className="text-xs font-mono text-neutral-text-muted min-w-[4ch]">
                  #{i + 1}
                </span>

                <select
                  value={shells[i] || "bash"}
                  onChange={(e) => updateShell(i, e.target.value)}
                  className="flex-1 px-3 py-1.5 text-xs rounded-md bg-neutral-bg border text-neutral-text-dim outline-none appearance-none cursor-pointer"
                  style={{ borderColor: "rgba(255,255,255,0.06)" }}
                >
                  <option value="bash">bash</option>
                  <option value="zsh">zsh</option>
                  <option value="pwsh">pwsh</option>
                  <option value="cmd">cmd</option>
                </select>

                <select
                  value={agentIds[i] || ""}
                  onChange={(e) => updateAgent(i, e.target.value || null)}
                  className="flex-[2] px-3 py-1.5 text-xs rounded-md bg-neutral-bg border text-neutral-text-dim outline-none appearance-none cursor-pointer"
                  style={{ borderColor: "rgba(255,255,255,0.06)" }}
                >
                  <option value="">Nessun agente</option>
                  {AGENTS.filter((a) => a.id !== "custom").map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  <option value="custom">Comando Personalizzato</option>
                </select>

                {agentIds[i] && (
                  <span
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.65rem] font-medium"
                    style={{
                      backgroundColor: `${AGENTS.find((a) => a.id === agentIds[i])?.color}20` || "rgba(113,113,122,0.2)",
                      color: AGENTS.find((a) => a.id === agentIds[i])?.color || "#71717a",
                    }}
                  >
                    <Bot size={10} />
                    {AGENTS.find((a) => a.id === agentIds[i])?.name || "Custom"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 4: Confirm */}
      {step === 4 && (
        <div className="space-y-5">
          <p className="text-sm text-neutral-text-dim">
            Riepilogo del nuovo spazio di lavoro. Conferma per creare.
          </p>

          <div
            className="rounded-xl border p-5 space-y-4"
            style={{ backgroundColor: "#0a0a0a", borderColor: "rgba(255,255,255,0.06)" }}
          >
            <div className="flex items-center gap-3 pb-4 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <BrainCircuit size={20} className="text-primary" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-neutral-text">
                  {workspaceName}
                </h3>
                <p className="text-xs text-neutral-text-muted mt-0.5">{folderPath}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 rounded-lg bg-neutral-elevated">
                <p className="text-2xl font-display font-bold text-primary">{layout.rows}&times;{layout.cols}</p>
                <p className="text-xs text-neutral-text-muted mt-1">Layout Grid</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-neutral-elevated">
                <p className="text-2xl font-display font-bold text-primary">{terminalCount}</p>
                <p className="text-xs text-neutral-text-muted mt-1">Terminali</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-neutral-elevated">
                <p className="text-2xl font-display font-bold text-primary">
                  {agentIds.filter(Boolean).length}
                </p>
                <p className="text-xs text-neutral-text-muted mt-1">Agenti</p>
              </div>
            </div>

            {agentIds.filter(Boolean).length > 0 && (
              <div>
                <p className="text-xs font-medium text-neutral-text-muted mb-2 uppercase tracking-wider">
                  Agenti Configurati
                </p>
                <div className="flex flex-wrap gap-2">
                  {agentIds.filter(Boolean).map((aid, i) => {
                    const agent = AGENTS.find((a) => a.id === aid);
                    if (!agent) return null;
                    return (
                      <span
                        key={`${aid}-${i}`}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium"
                        style={{
                          backgroundColor: `${agent.color}15`,
                          color: agent.color,
                          border: `1px solid ${agent.color}30`,
                        }}
                      >
                        <Bot size={12} />
                        {agent.name}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-8 pt-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <button
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          disabled={step === 1}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-neutral-text-muted rounded-lg hover:bg-white/5 transition-colors disabled:opacity-30"
        >
          <ChevronLeft size={16} />
          Indietro
        </button>

        {step < 4 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canProceed()}
            className="flex items-center gap-1.5 px-5 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
          >
            Avanti
            <ChevronRight size={16} />
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-primary rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
          >
            {creating ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Creazione...
              </>
            ) : (
              <>
                <Sparkles size={16} />
                Crea Spazio
              </>
            )}
          </button>
        )}
      </div>
    </Modal>
  );
}
