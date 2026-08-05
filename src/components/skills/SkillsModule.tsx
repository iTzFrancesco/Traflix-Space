import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  GripVertical,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  TerminalSquare,
  X,
} from "lucide-react";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSkillStore, useSortedSkills } from "../../stores/skillStore";

const SKILL_ACCENTS = [
  { background: "rgba(255, 157, 36, 0.15)", color: "#ffb84d" },
  { background: "rgba(85, 216, 155, 0.13)", color: "#55d89b" },
  { background: "rgba(114, 168, 255, 0.15)", color: "#72a8ff" },
  { background: "rgba(202, 137, 255, 0.15)", color: "#ca89ff" },
  { background: "rgba(255, 98, 107, 0.14)", color: "#ff858c" },
];
function getSkillAccent(id: string) {
  const hash = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return SKILL_ACCENTS[hash % SKILL_ACCENTS.length];
}

type SkillDragMode = "reorder" | "terminal";

interface ActiveSkillDrag {
  mode: SkillDragMode;
  skillId: string;
  skillName: string;
  pointerId: number;
  source: HTMLElement;
}

interface SkillDragPreview {
  mode: SkillDragMode;
  skillName: string;
  x: number;
  y: number;
  target: "terminal" | "reorder" | null;
}

function elementAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const element = document.elementFromPoint(clientX, clientY);
  return element instanceof HTMLElement ? element : null;
}

function skillRowAtPoint(clientX: number, clientY: number): string | null {
  return elementAtPoint(clientX, clientY)?.closest<HTMLElement>("[data-skill-row-id]")
    ?.dataset.skillRowId ?? null;
}

function terminalAtPoint(clientX: number, clientY: number): string | null {
  return elementAtPoint(clientX, clientY)?.closest<HTMLElement>("[data-terminal-pane-id]")
    ?.dataset.terminalPaneId ?? null;
}

function setTerminalDragTarget(terminalId: string | null) {
  document.querySelectorAll<HTMLElement>("[data-terminal-pane-id]").forEach((pane) => {
    if (terminalId && pane.dataset.terminalPaneId === terminalId) {
      pane.dataset.skillDragOver = "true";
    } else {
      delete pane.dataset.skillDragOver;
    }
  });
}

export function SkillsModule() {
  const [searchQuery, setSearchQuery] = useState("");
  const [draggingSkillId, setDraggingSkillId] = useState<string | null>(null);
  const [dragOverSkillId, setDragOverSkillId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<SkillDragPreview | null>(null);
  const activeDragRef = useRef<ActiveSkillDrag | null>(null);
  const skills = useSortedSkills();
  const loading = useSkillStore((state) => state.loading);
  const error = useSkillStore((state) => state.error);
  const toggleFavorite = useSkillStore((state) => state.toggleFavorite);
  const reorderSkills = useSkillStore((state) => state.reorder);
  const loadSkills = useSkillStore((state) => state.loadSkills);

  const startPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    mode: SkillDragMode,
    skillId: string,
    skillName: string,
  ) => {
    if (event.button !== 0 || activeDragRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    const source = event.currentTarget;
    const drag: ActiveSkillDrag = {
      mode,
      skillId,
      skillName,
      pointerId: event.pointerId,
      source,
    };
    activeDragRef.current = drag;
    setDraggingSkillId(skillId);
    setDragOverSkillId(mode === "reorder" ? skillId : null);
    setDragPreview({
      mode,
      skillName,
      x: event.clientX,
      y: event.clientY,
      target: null,
    });

    try {
      source.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not available in a few WebView2 edge cases;
      // window listeners below still keep the drag alive.
    }

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handlePointerCancel);
      try {
        if (source.hasPointerCapture(event.pointerId)) {
          source.releasePointerCapture(event.pointerId);
        }
      } catch {
        // The pointer may already have been released by WebView2.
      }
      activeDragRef.current = null;
      setDraggingSkillId(null);
      setDragOverSkillId(null);
      setDragPreview(null);
      setTerminalDragTarget(null);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== drag.pointerId) return;
      moveEvent.preventDefault();

      if (drag.mode === "reorder") {
        const targetId = skillRowAtPoint(moveEvent.clientX, moveEvent.clientY);
        setDragOverSkillId(targetId && targetId !== drag.skillId ? targetId : null);
        setDragPreview((current) => current ? {
          ...current,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          target: targetId && targetId !== drag.skillId ? "reorder" : null,
        } : current);
        setTerminalDragTarget(null);
      } else {
        const terminalId = terminalAtPoint(moveEvent.clientX, moveEvent.clientY);
        setDragPreview((current) => current ? {
          ...current,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          target: terminalId ? "terminal" : null,
        } : current);
        setTerminalDragTarget(terminalId);
      }
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== drag.pointerId) return;
      upEvent.preventDefault();

      if (drag.mode === "reorder") {
        const targetId = skillRowAtPoint(upEvent.clientX, upEvent.clientY);
        if (targetId && targetId !== drag.skillId) {
          reorderSkills(drag.skillId, targetId);
        }
      } else {
        const terminalId = terminalAtPoint(upEvent.clientX, upEvent.clientY);
        if (terminalId) {
          useTerminalStore.getState().markAgentInput(terminalId);
          useSkillStore.getState().addPendingDrop(terminalId, drag.skillName);
        }
      }

      cleanup();
    };

    const handlePointerCancel = () => cleanup();

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp, { passive: false });
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handlePointerCancel);
  };

  const visibleSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query),
    );
  }, [searchQuery, skills]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-3 py-4" aria-labelledby="skills-title">
      <div className="mb-3 flex items-center justify-between px-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/[0.13] text-primary">
            <Sparkles size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="skills-title" className="truncate text-[0.84rem] font-bold text-neutral-text">
                Skills
              </h2>
              <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[0.62rem] font-semibold tabular-nums text-neutral-text-dim">
                {skills.length}
              </span>
            </div>
            <p className="mt-0.5 text-[0.65rem] text-neutral-text-dim">
              {dragPreview
                ? dragPreview.target === "terminal"
                  ? "Rilascia nel terminale per inserire"
                  : dragPreview.target === "reorder"
                    ? "Rilascia per riposizionare"
                    : "Trascina e rilascia"
                : "Trascina nel terminale per inserire"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadSkills()}
          disabled={loading}
          className="ui-icon-button h-8 w-8 shrink-0"
          title="Aggiorna skills"
          aria-label="Aggiorna skills"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="relative mb-3 min-w-0 px-1.5">
        <Search
          size={13}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-neutral-text-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Cerca skill..."
          aria-label="Cerca skill"
          className="h-9 w-full min-w-0 appearance-none rounded-lg border border-white/[0.09] bg-black/[0.14] pl-9 pr-9 text-xs text-neutral-text placeholder:text-neutral-text-muted outline-none transition-colors focus:border-primary/60 focus:bg-black/[0.2]"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-neutral-text-muted transition-colors hover:bg-white/[0.08] hover:text-neutral-text"
            aria-label="Pulisci ricerca skill"
            title="Pulisci ricerca"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {loading && skills.length === 0 ? (
        <div className="space-y-2" role="status" aria-label="Caricamento delle skill">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] px-2.5 py-3">
              <span className="mt-0.5 h-4 w-4 animate-pulse rounded bg-white/[0.08]" />
              <span className="flex-1 space-y-2">
                <span className="block h-3 w-2/5 animate-pulse rounded bg-white/[0.1]" />
                <span className="block h-2.5 w-4/5 animate-pulse rounded bg-white/[0.06]" />
              </span>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-danger/25 bg-danger/[0.06] px-4 py-4 text-center text-xs leading-relaxed text-neutral-text-dim" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void loadSkills()}
            className="mt-3 rounded-lg border border-danger/35 px-3 py-1.5 font-semibold text-danger transition-colors hover:bg-danger/[0.1]"
          >
            Riprova
          </button>
        </div>
      ) : visibleSkills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/[0.12] px-4 py-8 text-center text-xs leading-relaxed text-neutral-text-dim">
          {searchQuery.trim() ? (
            <>Nessuna skill corrisponde a <strong className="text-neutral-text">{searchQuery}</strong>.</>
          ) : (
            <>
              Nessuna skill trovata in
              <br />
              <code className="text-primary/80">.agents/skills</code>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-1" role="list" aria-label="Elenco delle skill">
          {visibleSkills.map((skill) => {
            const accent = getSkillAccent(skill.id);
            return (
              <div
                key={skill.id}
                data-skill-row-id={skill.id}
                className={`group relative flex items-start gap-2 rounded-lg border-b px-1 py-2 transition-colors duration-150 ${
                  skill.isFavorite
                    ? "border-primary/30 bg-primary/[0.075] hover:bg-primary/[0.11]"
                    : "border-white/[0.07] hover:bg-white/[0.035]"
                } ${
                  draggingSkillId === skill.id
                    ? "bg-primary/[0.15] ring-1 ring-primary/60"
                    : ""
                } ${
                  dragOverSkillId === skill.id
                    ? "bg-primary/[0.12] ring-1 ring-primary/70 shadow-[0_0_18px_rgba(232,93,4,0.14)]"
                    : ""
                }`}
                role="listitem"
              >
                {dragOverSkillId === skill.id && (
                  <span className="pointer-events-none absolute inset-x-3 -bottom-px z-10 flex translate-y-1/2 justify-center">
                    <span className="rounded-full border border-primary/45 bg-neutral-surface px-2 py-0.5 text-[0.55rem] font-semibold uppercase tracking-[0.08em] text-primary shadow-lg">
                      Rilascia qui
                    </span>
                  </span>
                )}
                <div
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: accent.background, color: accent.color }}
                  aria-hidden="true"
                >
                  <Sparkles size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[0.8rem] font-semibold text-neutral-text">
                      {skill.name}
                    </span>
                    {skill.isFavorite && <Star size={10} className="shrink-0 text-primary" fill="currentColor" aria-label="Preferita" />}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[0.68rem] leading-[1.35] text-neutral-text-dim">
                    {skill.description || "Nessuna descrizione disponibile."}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <div
                    onPointerDown={(event) => {
                      startPointerDrag(event, "reorder", skill.id, skill.name);
                    }}
                    className={`flex h-8 w-8 shrink-0 touch-none cursor-grab select-none items-center justify-center rounded-lg transition-colors hover:bg-white/[0.08] active:cursor-grabbing ${
                      dragOverSkillId === skill.id
                        ? "text-primary"
                        : "text-neutral-text-muted"
                    }`}
                    title={`Riposiziona ${skill.name}`}
                    aria-label={`Riposiziona ${skill.name} nell'elenco`}
                    role="button"
                    tabIndex={0}
                  >
                    <GripVertical size={16} aria-hidden="true" />
                  </div>
                  <div
                    onPointerDown={(event) => {
                      startPointerDrag(event, "terminal", skill.id, skill.name);
                    }}
                    className="flex h-8 w-8 shrink-0 touch-none cursor-grab select-none items-center justify-center rounded-lg text-neutral-text-muted transition-colors hover:bg-white/[0.08] hover:text-primary active:cursor-grabbing"
                    title={`Trascina ${skill.name} nel terminale`}
                    aria-label={`Trascina ${skill.name} nel terminale`}
                    role="button"
                    tabIndex={0}
                  >
                    <TerminalSquare size={15} aria-hidden="true" />
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFavorite(skill.id);
                    }}
                    className={`rounded-lg p-1.5 transition-colors ${
                      skill.isFavorite
                        ? "text-primary hover:bg-primary/[0.14]"
                        : "text-neutral-text-muted hover:bg-white/[0.08] hover:text-primary"
                    }`}
                    title={skill.isFavorite ? "Rimuovi dai preferiti" : "Metti tra i preferiti"}
                    aria-label={skill.isFavorite ? `Rimuovi ${skill.name} dai preferiti` : `Metti ${skill.name} tra i preferiti`}
                  >
                    <Star size={14} fill={skill.isFavorite ? "currentColor" : "none"} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dragPreview && (
        <div
          className="pointer-events-none fixed z-[300] flex items-center gap-2 rounded-lg border border-primary/70 bg-[#20201d]/95 px-2.5 py-2 text-xs text-neutral-text shadow-[0_8px_24px_rgba(0,0,0,0.42),0_0_18px_rgba(232,93,4,0.18)] backdrop-blur-sm transition-colors duration-150"
          style={{ left: dragPreview.x + 14, top: dragPreview.y + 14 }}
          aria-hidden="true"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/[0.15] text-primary">
            {dragPreview.mode === "terminal" ? <TerminalSquare size={14} /> : <GripVertical size={14} />}
          </span>
          <span className="max-w-[190px] truncate font-semibold">{dragPreview.skillName}</span>
          <span className="flex items-center gap-1 text-[0.58rem] uppercase tracking-[0.08em] text-primary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            {dragPreview.target === "terminal"
              ? "rilascia"
              : dragPreview.target === "reorder"
                ? "sposta"
                : "trascina"}
          </span>
        </div>
      )}
    </section>
  );
}
