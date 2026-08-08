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
  const hash = [...id].reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
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
  return (
    elementAtPoint(clientX, clientY)?.closest<HTMLElement>("[data-skill-row-id]")
      ?.dataset.skillRowId ?? null
  );
}

function terminalAtPoint(clientX: number, clientY: number): string | null {
  return (
    elementAtPoint(clientX, clientY)?.closest<HTMLElement>(
      "[data-terminal-pane-id]",
    )?.dataset.terminalPaneId ?? null
  );
}

function setTerminalDragTarget(terminalId: string | null) {
  document
    .querySelectorAll<HTMLElement>("[data-terminal-pane-id]")
    .forEach((pane) => {
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
      // Window listeners keep the drag alive when WebView2 cannot capture it.
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
        // Pointer may already have been released by WebView2.
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
        setDragOverSkillId(
          targetId && targetId !== drag.skillId ? targetId : null,
        );
        setDragPreview((current) =>
          current
            ? {
                ...current,
                x: moveEvent.clientX,
                y: moveEvent.clientY,
                target:
                  targetId && targetId !== drag.skillId ? "reorder" : null,
              }
            : current,
        );
        setTerminalDragTarget(null);
      } else {
        const terminalId = terminalAtPoint(moveEvent.clientX, moveEvent.clientY);
        setDragPreview((current) =>
          current
            ? {
                ...current,
                x: moveEvent.clientX,
                y: moveEvent.clientY,
                target: terminalId ? "terminal" : null,
              }
            : current,
        );
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

  const interactionHint = dragPreview
    ? dragPreview.target === "terminal"
      ? "Release over terminal"
      : dragPreview.target === "reorder"
        ? "Release to reorder"
        : "Drag to a target"
    : "Drag a skill onto a terminal";

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-labelledby="skills-title"
    >
      <div className="shrink-0 border-b border-neutral-border px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2
                id="skills-title"
                className="truncate text-xs font-semibold text-neutral-text"
              >
                Skills
              </h2>
              <span className="font-mono text-[10px] tabular-nums text-neutral-text-muted">
                {skills.length}
              </span>
            </div>
            <p className="mt-1 truncate text-[10px] text-neutral-text-muted">
              {interactionHint}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSkills()}
            disabled={loading}
            className="ui-icon-button h-8 w-8 shrink-0"
            title="Refresh skills"
            aria-label="Refresh skills"
          >
            <RefreshCw
              size={14}
              className={loading ? "status-icon--spin" : ""}
            />
          </button>
        </div>

        <div className="relative mt-3 min-w-0">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-text-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search skills"
            aria-label="Search skills"
            className="field-input h-8 w-full min-w-0 pl-8 pr-8"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-neutral-text-muted hover:text-neutral-text"
              aria-label="Clear skill search"
              title="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && skills.length === 0 ? (
          <div role="status" aria-label="Loading skills">
            {[0, 1, 2, 3].map((item) => (
              <div
                key={item}
                className="flex min-h-12 items-center gap-3 border-b border-neutral-border-light px-2"
              >
                <span className="h-3 w-3 animate-pulse bg-white/[0.08]" />
                <span className="h-3 flex-1 animate-pulse bg-white/[0.05]" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div
            className="border-l-2 border-danger px-3 py-2 text-xs leading-relaxed text-neutral-text-dim"
            role="alert"
          >
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void loadSkills()}
              className="mt-2 text-xs font-semibold text-danger hover:underline"
            >
              Retry
            </button>
          </div>
        ) : visibleSkills.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs leading-relaxed text-neutral-text-muted">
            {searchQuery.trim() ? (
              <>No skill matches “{searchQuery}”.</>
            ) : (
              <>
                No skills found in{" "}
                <code className="text-neutral-text-dim">.agents/skills</code>
              </>
            )}
          </div>
        ) : (
          <div role="list" aria-label="Skills">
            {visibleSkills.map((skill) => {
              const accent = getSkillAccent(skill.id);
              return (
                <div
                  key={skill.id}
                  data-skill-row-id={skill.id}
                  className={`group relative flex min-h-14 items-start gap-2 border-b border-neutral-border-light px-1.5 py-2 transition-colors ${
                    draggingSkillId === skill.id
                      ? "bg-primary/[0.08]"
                      : dragOverSkillId === skill.id
                        ? "bg-primary/[0.10]"
                        : "hover:bg-white/[0.025]"
                  }`}
                  role="listitem"
                >
                  <div
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                    style={{
                      backgroundColor: accent.background,
                      color: accent.color,
                    }}
                    aria-hidden="true"
                  >
                    <Sparkles size={13} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-neutral-text">
                        {skill.name}
                      </span>
                      {skill.isFavorite && (
                        <Star
                          size={10}
                          className="shrink-0 text-primary"
                          fill="currentColor"
                          aria-label="Favorite"
                        />
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-neutral-text-muted">
                      {skill.description || "No description."}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onPointerDown={(event) =>
                        startPointerDrag(event, "reorder", skill.id, skill.name)
                      }
                      className="ui-icon-button h-7 w-7 touch-none cursor-grab active:cursor-grabbing"
                      title={`Reorder ${skill.name}`}
                      aria-label={`Reorder ${skill.name}`}
                    >
                      <GripVertical size={14} />
                    </button>
                    <button
                      type="button"
                      onPointerDown={(event) =>
                        startPointerDrag(event, "terminal", skill.id, skill.name)
                      }
                      className="ui-icon-button h-7 w-7 touch-none cursor-grab active:cursor-grabbing"
                      title={`Drag ${skill.name} to a terminal`}
                      aria-label={`Drag ${skill.name} to a terminal`}
                    >
                      <TerminalSquare size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFavorite(skill.id);
                      }}
                      className={`ui-icon-button h-7 w-7 ${
                        skill.isFavorite ? "text-primary" : ""
                      }`}
                      title={
                        skill.isFavorite ? "Remove favorite" : "Add favorite"
                      }
                      aria-label={
                        skill.isFavorite
                          ? `Remove ${skill.name} from favorites`
                          : `Add ${skill.name} to favorites`
                      }
                    >
                      <Star
                        size={13}
                        fill={skill.isFavorite ? "currentColor" : "none"}
                      />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dragPreview && (
        <div
          className="pointer-events-none fixed z-[300] flex max-w-[240px] items-center gap-2 border border-primary/60 bg-neutral-elevated px-2.5 py-2 text-xs text-neutral-text shadow-[0_8px_20px_rgba(0,0,0,0.32)]"
          style={{ left: dragPreview.x + 14, top: dragPreview.y + 14 }}
          aria-hidden="true"
        >
          {dragPreview.mode === "terminal" ? (
            <TerminalSquare size={13} className="shrink-0 text-primary" />
          ) : (
            <GripVertical size={13} className="shrink-0 text-primary" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">
            {dragPreview.skillName}
          </span>
          <span className="shrink-0 font-mono text-[9px] text-primary">
            {dragPreview.target === "terminal"
              ? "DROP"
              : dragPreview.target === "reorder"
                ? "MOVE"
                : "DRAG"}
          </span>
        </div>
      )}
    </section>
  );
}
