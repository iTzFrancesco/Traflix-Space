import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LayoutGrid,
  Minus,
  Plus,
  Save,
  Terminal,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { usePresetStore } from "../../stores/presetStore";
import { useToastStore } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { AGENTS } from "../../lib/agents";
import { computeLayout, QUICK_COUNTS } from "../../lib/presets";
import { invokeWithTimeout } from "../../lib/timeout";
import type { Preset } from "../../stores/presetStore";
import type { TerminalConfig } from "../../stores/terminalStore";
import type { Workspace } from "../../stores/workspaceStore";
import { Modal } from "../ui/Modal";

interface NewSpaceWizardProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = ["Cartella", "Terminali", "Agenti", "Riepilogo"] as const;

const agentIcons: Record<string, typeof Bot> = {
  opencode: Terminal,
  "anti-gravity": Bot,
  claude: Bot,
  claudex: Bot,
  codex: Bot,
  cmdc: Terminal,
  cline: Bot,
  freebuff: Bot,
  pi: Bot,
  grok: Bot,
};

export function NewSpaceWizard({ open, onClose }: NewSpaceWizardProps) {
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const { addPreset, updatePreset, removePreset, presets } = usePresetStore();
  const addToast = useToastStore((state) => state.addToast);

  const [step, setStep] = useState(1);
  const [folderPath, setFolderPath] = useState("");
  const [terminalCount, setTerminalCount] = useState(2);
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState(false);
  const [presetSourceId, setPresetSourceId] = useState<string | null>(null);

  const assignedCount = useMemo(
    () => Object.values(agentCounts).reduce((total, count) => total + count, 0),
    [agentCounts],
  );
  const layout = useMemo(() => computeLayout(terminalCount), [terminalCount]);
  const workspaceName = useMemo(() => {
    if (!folderPath) return "";
    const parts = folderPath.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.at(-1) ?? "workspace";
  }, [folderPath]);

  useEffect(() => {
    if (!open || folderPath) return;
    void invokeWithTimeout(
      () => invoke<string>("get_default_workspace_path"),
      5000,
    )
      .then(setFolderPath)
      .catch(() => undefined);
  }, [folderPath, open]);

  const reset = () => {
    setStep(1);
    setFolderPath("");
    setTerminalCount(2);
    setAgentCounts({});
    setCreating(false);
    setPresetSourceId(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const supportedAgentCounts = (counts: Record<string, number>) => {
    const supported = new Set(AGENTS.map((agent) => agent.id));
    return Object.fromEntries(
      Object.entries(counts).filter(
        ([agentId, count]) => supported.has(agentId) && count > 0,
      ),
    );
  };

  const normalizeCounts = (counts: Record<string, number>, max: number) => {
    let remaining = max;
    const next: Record<string, number> = {};
    for (const [agentId, count] of Object.entries(counts)) {
      if (remaining <= 0) break;
      const accepted = Math.min(count, remaining);
      if (accepted > 0) next[agentId] = accepted;
      remaining -= accepted;
    }
    return next;
  };

  const setCount = (count: number) => {
    const bounded = Math.max(1, Math.min(8, count));
    setTerminalCount(bounded);
    setAgentCounts((current) => normalizeCounts(current, bounded));
  };

  const changeAgentCount = (agentId: string, delta: number) => {
    setAgentCounts((current) => {
      const total = Object.values(current).reduce((sum, count) => sum + count, 0);
      const existing = current[agentId] ?? 0;
      if (delta > 0 && total >= terminalCount) return current;
      if (delta < 0 && existing <= 0) return current;
      const next = Math.max(0, existing + delta);
      const updated = { ...current, [agentId]: next };
      if (next === 0) delete updated[agentId];
      return updated;
    });
  };

  const fillWithAgent = (agentId: string) => {
    setAgentCounts({ [agentId]: terminalCount });
  };

  const handleSelectFolder = async () => {
    try {
      // Native human interaction must never inherit an arbitrary request timeout.
      const path = await invoke<string>("select_folder");
      setFolderPath(path);
      setPresetSourceId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("folder-selection-cancelled")) return;
      console.error("Selezione cartella fallita:", error);
      addToast({
        type: "error",
        message: "Impossibile aprire il selettore cartelle",
      });
    }
  };

  const loadPreset = (preset: Preset) => {
    setPresetSourceId(preset.id);
    setFolderPath(preset.folderPath);
    setTerminalCount(preset.terminalCount);
    setAgentCounts(
      normalizeCounts(supportedAgentCounts(preset.agentCounts), preset.terminalCount),
    );
    setStep(4);
  };

  const savePreset = () => {
    if (!folderPath) return;
    const payload = {
      name: workspaceName || "Spazio di lavoro",
      folderPath,
      terminalCount,
      agentCounts: supportedAgentCounts(agentCounts),
    };
    if (presetSourceId) {
      updatePreset(presetSourceId, payload);
      addToast({ type: "success", message: "Preset aggiornato" });
      return;
    }
    addPreset({
      id: crypto.randomUUID(),
      ...payload,
      createdAt: new Date().toISOString(),
    });
    addToast({ type: "success", message: "Preset salvato" });
  };

  const saveAsNewPreset = () => {
    if (!folderPath) return;
    addPreset({
      id: crypto.randomUUID(),
      name: workspaceName || "Spazio di lavoro",
      folderPath,
      terminalCount,
      agentCounts: supportedAgentCounts(agentCounts),
      createdAt: new Date().toISOString(),
    });
    setPresetSourceId(null);
    addToast({ type: "success", message: "Nuovo preset salvato" });
  };

  const handleCreate = async () => {
    if (!folderPath || creating) return;
    setCreating(true);
    try {
      const agentIds: Array<string | null> = [];
      for (const [agentId, count] of Object.entries(
        supportedAgentCounts(agentCounts),
      )) {
        for (let index = 0; index < count; index += 1) agentIds.push(agentId);
      }
      while (agentIds.length < terminalCount) agentIds.push(null);

      const terminals: TerminalConfig[] = Array.from(
        { length: terminalCount },
        (_, index) => {
          const agentId = agentIds[index] ?? null;
          return {
            id: crypto.randomUUID(),
            shell: "powershell.exe",
            agentId,
            command: null,
            cwd: folderPath,
            title: agentId
              ? AGENTS.find((agent) => agent.id === agentId)?.name ?? "Terminale"
              : "Terminale",
          };
        },
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
        agentCount: config.terminals.filter((terminal) => terminal.agentId).length,
        lastOpened: now,
        createdAt: now,
        updatedAt: now,
      };
      addWorkspace(workspace);
      setActiveWorkspace(workspace.id);
      handleClose();
    } catch (error) {
      console.error("Creazione spazio di lavoro fallita:", error);
      addToast({
        type: "error",
        message: "Impossibile creare lo spazio di lavoro",
      });
    } finally {
      setCreating(false);
    }
  };

  const canContinue = step !== 1 || Boolean(folderPath);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Nuovo spazio di lavoro"
      width="max-w-[680px]"
    >
      <div className="flex min-h-[440px] flex-col">
        <div className="border-b border-neutral-border pb-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs font-semibold text-neutral-text">
              {STEPS[step - 1]}
            </span>
            <span className="font-mono text-[10px] text-neutral-text-muted">
              {step}/{STEPS.length}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1" aria-hidden="true">
            {STEPS.map((label, index) => (
              <span
                key={label}
                className={`h-0.5 ${index < step ? "bg-primary" : "bg-white/[0.07]"}`}
              />
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 py-6">
          {step === 1 && (
            <FolderStep
              folderPath={folderPath}
              presets={presets}
              onSelectFolder={() => void handleSelectFolder()}
              onLoadPreset={loadPreset}
              onDeletePreset={(preset) => {
                removePreset(preset.id);
                addToast({ type: "info", message: `Preset “${preset.name}” rimosso` });
              }}
            />
          )}
          {step === 2 && <TerminalStep count={terminalCount} onChange={setCount} />}
          {step === 3 && (
            <AgentStep
              terminalCount={terminalCount}
              assignedCount={assignedCount}
              agentCounts={agentCounts}
              onChange={changeAgentCount}
              onFill={fillWithAgent}
            />
          )}
          {step === 4 && (
            <ReviewStep
              workspaceName={workspaceName}
              folderPath={folderPath}
              terminalCount={terminalCount}
              agentCounts={agentCounts}
              presetSourceId={presetSourceId}
              onSavePreset={savePreset}
              onSaveAsNewPreset={saveAsNewPreset}
            />
          )}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-border pt-4">
          <button
            type="button"
            onClick={() => setStep((current) => Math.max(1, current - 1))}
            disabled={step === 1 || creating}
            className="secondary-button"
          >
            <ChevronLeft size={14} /> Indietro
          </button>
          {step < STEPS.length ? (
            <button
              type="button"
              onClick={() => setStep((current) => Math.min(STEPS.length, current + 1))}
              disabled={!canContinue}
              className="primary-button"
            >
              Continua <ChevronRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!folderPath || creating}
              className="primary-button"
            >
              {creating ? "Creazione…" : "Crea spazio"}
              {!creating && <Check size={14} />}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FolderStep({
  folderPath,
  presets,
  onSelectFolder,
  onLoadPreset,
  onDeletePreset,
}: {
  folderPath: string;
  presets: Preset[];
  onSelectFolder: () => void;
  onLoadPreset: (preset: Preset) => void;
  onDeletePreset: (preset: Preset) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-neutral-text">Cartella progetto</h3>
        <p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">
          Ogni terminale di questo spazio di lavoro partirà da questa cartella.
        </p>
      </div>
      <div className="flex gap-2">
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 border border-neutral-border bg-neutral-surface px-3">
          <FolderOpen size={15} className="shrink-0 text-primary" />
          <span
            className={`truncate font-mono text-[11px] ${
              folderPath ? "text-neutral-text-dim" : "text-neutral-text-muted"
            }`}
          >
            {folderPath || "Scegli una cartella progetto"}
          </span>
        </div>
        <button type="button" onClick={onSelectFolder} className="primary-button h-10">
          Sfoglia
        </button>
      </div>
      {presets.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-neutral-text-dim">Preset salvati</span>
            <span className="font-mono text-[10px] text-neutral-text-muted">{presets.length}</span>
          </div>
          <div className="divide-y divide-neutral-border border-y border-neutral-border">
            {presets.map((preset) => (
              <div key={preset.id} className="group flex min-h-12 items-center gap-3 px-1 py-2">
                <button
                  type="button"
                  onClick={() => onLoadPreset(preset)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-xs font-medium text-neutral-text">{preset.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-text-muted">
                    {preset.folderPath} · {preset.terminalCount} terminali
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onDeletePreset(preset)}
                  className="ui-icon-button h-8 w-8 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  title={`Rimuovi ${preset.name}`}
                  aria-label={`Rimuovi ${preset.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TerminalStep({ count, onChange }: { count: number; onChange: (count: number) => void }) {
  const nextLayout = computeLayout(count);
  return (
    <div className="space-y-7">
      <div>
        <h3 className="text-base font-semibold text-neutral-text">Quanti terminali?</h3>
        <p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">
          Parti con pochi terminali. Potrai aggiungerne altri in qualsiasi momento.
        </p>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => onChange(count - 1)}
          disabled={count <= 1}
          className="ui-icon-button h-9 w-9"
          aria-label="Rimuovi terminale"
        >
          <Minus size={15} />
        </button>
        <span className="w-12 text-center font-mono text-3xl font-semibold tabular-nums text-neutral-text">
          {count}
        </span>
        <button
          type="button"
          onClick={() => onChange(count + 1)}
          disabled={count >= 8}
          className="ui-icon-button h-9 w-9"
          aria-label="Aggiungi terminale"
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {QUICK_COUNTS.map((quickCount) => (
          <button
            key={quickCount}
            type="button"
            onClick={() => onChange(quickCount)}
            className={`h-8 min-w-10 border px-3 font-mono text-xs transition-colors ${
              count === quickCount
                ? "border-primary/70 bg-primary/10 text-primary"
                : "border-neutral-border text-neutral-text-muted hover:border-white/[0.14] hover:text-neutral-text"
            }`}
          >
            {quickCount}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-neutral-text-muted">
        <LayoutGrid size={13} /> Layout {nextLayout.rows}×{nextLayout.cols}
      </div>
    </div>
  );
}

function AgentStep({
  terminalCount,
  assignedCount,
  agentCounts,
  onChange,
  onFill,
}: {
  terminalCount: number;
  assignedCount: number;
  agentCounts: Record<string, number>;
  onChange: (agentId: string, delta: number) => void;
  onFill: (agentId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-neutral-text">Precarica agenti</h3>
          <p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">
            Facoltativo. I terminali senza agente restano normali sessioni PowerShell.
          </p>
        </div>
        <span className="font-mono text-[10px] text-neutral-text-muted">
          {assignedCount}/{terminalCount}
        </span>
      </div>
      <div className="divide-y divide-neutral-border border-y border-neutral-border">
        {AGENTS.map((agent) => {
          const Icon = agentIcons[agent.id] ?? Bot;
          const count = agentCounts[agent.id] ?? 0;
          return (
            <div key={agent.id} className="flex min-h-12 items-center gap-3 py-2">
              <Icon size={15} className={count > 0 ? "text-primary" : "text-neutral-text-muted"} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-text-dim">
                {agent.name}
              </span>
              <button
                type="button"
                onClick={() => onFill(agent.id)}
                className="text-[10px] font-medium text-neutral-text-muted hover:text-primary"
              >
                Riempi tutti
              </button>
              <button
                type="button"
                onClick={() => onChange(agent.id, -1)}
                disabled={count === 0}
                className="ui-icon-button h-8 w-8"
                aria-label={`Rimuovi ${agent.name}`}
              >
                <Minus size={13} />
              </button>
              <span className="w-5 text-center font-mono text-xs tabular-nums text-neutral-text">
                {count}
              </span>
              <button
                type="button"
                onClick={() => onChange(agent.id, 1)}
                disabled={assignedCount >= terminalCount}
                className="ui-icon-button h-8 w-8"
                aria-label={`Aggiungi ${agent.name}`}
              >
                <Plus size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReviewStep({
  workspaceName,
  folderPath,
  terminalCount,
  agentCounts,
  presetSourceId,
  onSavePreset,
  onSaveAsNewPreset,
}: {
  workspaceName: string;
  folderPath: string;
  terminalCount: number;
  agentCounts: Record<string, number>;
  presetSourceId: string | null;
  onSavePreset: () => void;
  onSaveAsNewPreset: () => void;
}) {
  const assignments = AGENTS.flatMap((agent) => {
    const count = agentCounts[agent.id] ?? 0;
    return count > 0 ? [`${agent.name} ×${count}`] : [];
  });
  const nextLayout = computeLayout(terminalCount);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-neutral-text">
          {workspaceName || "Spazio di lavoro"}
        </h3>
        <p
          className="mt-1 truncate font-mono text-[11px] text-neutral-text-muted"
          title={folderPath}
        >
          {folderPath}
        </p>
      </div>
      <dl className="divide-y divide-neutral-border border-y border-neutral-border text-xs">
        <SummaryRow label="Terminali" value={String(terminalCount)} />
        <SummaryRow label="Layout" value={`${nextLayout.rows}×${nextLayout.cols}`} />
        <SummaryRow
          label="Agenti"
          value={assignments.length > 0 ? assignments.join(" · ") : "Nessuno precaricato"}
        />
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onSavePreset} className="secondary-button">
          <Save size={13} /> {presetSourceId ? "Aggiorna preset" : "Salva preset"}
        </button>
        {presetSourceId && (
          <button type="button" onClick={onSaveAsNewPreset} className="secondary-button">
            <Plus size={13} /> Salva come nuovo
          </button>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4 py-3">
      <dt className="text-neutral-text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-neutral-text-dim">{value}</dd>
    </div>
  );
}
