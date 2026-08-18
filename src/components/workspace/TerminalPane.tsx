import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalInput } from "../terminal/useTerminalInput";
import {
  useTerminalStore,
  type TerminalScrollPosition,
} from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSkillStore } from "../../stores/skillStore";
import { useToastStore } from "../../stores/toastStore";
import { getWorkspaceColor } from "../../lib/workspaceColors";
import { invokeWithTimeout } from "../../lib/timeout";
import { reportFrontendDiagnostic } from "../../lib/crashDiagnostics";
import {
  cancelProgrammaticScroll,
  type ProgrammaticScrollGuard,
} from "../../lib/terminalScrollState";
import { TerminalOutputProtocol } from "../../lib/terminalOutputProtocol";
import { createTerminalWriteBackpressure } from "../../lib/terminalWriteBackpressure";
import type { TerminalRuntimeIdentity } from "../terminal/types";
import {
  agentDisplayName,
  getTitleBarMetrics,
  projectNameFromCwd,
  TITLE_BAR_STYLE,
  type TerminalPaneProps,
} from "./TerminalPaneSupport";
import {
  currentRuntimeKey,
  isTerminalScrollLayoutUsable,
  restoreScrollPosition,
  runtimeKey,
  type PtyResizeState,
  type TerminalPaneVisibility,
} from "./TerminalPaneRuntime";
import { useTerminalPaneLayout } from "./useTerminalPaneLayout";
import { useTerminalPaneLifecycle } from "./useTerminalPaneLifecycle";
import { TerminalPaneView } from "./TerminalPaneView";
import "xterm/css/xterm.css";

export const TerminalPane = memo(function TerminalPane({
  terminalId,
  shell,
  cwd,
  title,
  agentId,
  terminalCount,
  layoutRevision,
  isActive,
  isFocused = false,
  focusModeActive = false,
  closeRequestToken,
  onActivate,
  onClose,
  onToggleFocus,
  onReorder,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  /** True while backend history is being written and sequenced output is buffered. */
  const rehydratingRef = useRef(false);
  const outputProtocolRef = useRef(new TerminalOutputProtocol());
  const xtermWriteBackpressureRef = useRef(createTerminalWriteBackpressure());
  const streamEpochRef = useRef(0);
  const terminalGenerationRef = useRef<number | null>(null);
  const terminalProcessIdRef = useRef<number | null>(null);
  const reopeningRef = useRef(false);
  const unsubOutputRef = useRef<(() => void) | null>(null);
  const outputWarmupUnsubRef = useRef<(() => void) | null>(null);
  const unsubExitRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const autoScrollRef = useRef(true);
  const scrollPositionRef = useRef<TerminalScrollPosition>({
    followsOutput: true,
    offsetFromBottom: 0,
  });
  const userScrollIntentRef = useRef(false);
  const programmaticScrollGuardRef = useRef<ProgrammaticScrollGuard>({
    epoch: 0,
    target: null,
  });
  const fitInProgressRef = useRef(false);
  const windowFocusedRef = useRef(
    document.visibilityState !== "hidden" && document.hasFocus(),
  );
  const paneVisibilityRef = useRef<TerminalPaneVisibility>({
    focusModeActive,
    isFocused,
  });
  paneVisibilityRef.current = { focusModeActive, isFocused };
  const followBottomRepairRef = useRef<{
    raf: number | null;
    remainingFrames: number;
  }>({
    raf: null,
    remainingFrames: 0,
  });
  const ptyResizeStateRef = useRef<PtyResizeState>({
    pending: null,
    flushing: false,
  });
  const fitScheduleRef = useRef<{
    raf: number | null;
    remainingFrames: number;
    retryFrames: number;
    deadline: number;
  }>({
    raf: null,
    remainingFrames: 0,
    retryFrames: 0,
    deadline: 0,
  });
  const resizeDebounceRef = useRef<number | null>(null);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const cancelFollowBottomRepair = useCallback(() => {
    const repair = followBottomRepairRef.current;
    repair.remainingFrames = 0;
    if (repair.raf !== null) {
      cancelAnimationFrame(repair.raf);
      repair.raf = null;
    }
  }, []);

  const scheduleFollowBottomRepair = useCallback((framePasses = 2) => {
    const repair = followBottomRepairRef.current;
    repair.remainingFrames = Math.max(
      repair.remainingFrames,
      Math.max(1, Math.min(4, framePasses)),
    );
    if (repair.raf !== null) return;

    const run = () => {
      repair.raf = null;
      const term = xtermRef.current;
      if (
        !term ||
        repair.remainingFrames <= 0 ||
        !scrollPositionRef.current.followsOutput ||
        userScrollIntentRef.current
      ) {
        repair.remainingFrames = 0;
        return;
      }
      repair.remainingFrames -= 1;

      if (
        !rehydratingRef.current &&
        isTerminalScrollLayoutUsable(
          term,
          paneVisibilityRef,
          windowFocusedRef,
        )
      ) {
        restoreScrollPosition(
          term,
          autoScrollRef,
          scrollPositionRef,
          programmaticScrollGuardRef,
        );
      }
      if (repair.remainingFrames > 0) {
        repair.raf = requestAnimationFrame(run);
      }
    };

    repair.raf = requestAnimationFrame(run);
  }, []);

  const exitCode = useTerminalStore(
    (s) => s.terminals[terminalId]?.exitCode ?? null,
  );
  const runtimeGeneration = useTerminalStore(
    (s) => s.terminals[terminalId]?.generation ?? null,
  );
  const runtimeProcessId = useTerminalStore(
    (s) => s.terminals[terminalId]?.processId ?? null,
  );
  const terminalWorkspaceId = useTerminalStore(
    (s) => s.terminals[terminalId]?.workspaceId ?? "",
  );
  const hasExited = exitCode !== null;

  const draggedTerminalId = useTerminalStore((s) => s.draggedTerminalId);
  const dragHoveredTerminalId = useTerminalStore((s) => s.dragHoveredTerminalId);
  const isDragHovered = dragHoveredTerminalId === terminalId;
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [currentCwd, setCurrentCwd] = useState(cwd);
  const [restartToken, setRestartToken] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [streamSyncFailed, setStreamSyncFailed] = useState(false);
  const dragCounterRef = useRef(0);
  const currentCwdRef = useRef(cwd);
  const contextRequestRef = useRef(0);
  const atPowerShellPromptRef = useRef(false);

  // Jarvis can restart a PTY from the backend while this pane stays mounted.
  // A store identity change is the authoritative hand-off to the new lifetime;
  // remount the stream protocol against that exact generation instead of
  // continuing to display/filter with the old one.

  const pendingDrops = useSkillStore((s) => s.pendingDrops[terminalId]);
  const pendingNames = pendingDrops?.names ?? [];

  useEffect(() => {
    if (!confirmClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmClose(false);
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () =>
      document.removeEventListener("keydown", handler, { capture: true });
  }, [confirmClose]);

  useEffect(() => {
    if (closeRequestToken === undefined) return;
    setConfirmClose(true);
  }, [closeRequestToken]);

  const {
    scheduleFitAndResize,
    refreshTerminalContext,
    syncContextFromPowerShellPrompt,
  } = useTerminalPaneLayout({
    terminalId,
    shell,
    cwd,
    terminalWorkspaceId,
    terminalCount,
    layoutRevision,
    runtimeGeneration,
    runtimeProcessId,
    isActive,
    isFocused,
    focusModeActive,
    terminalGenerationRef,
    terminalProcessIdRef,
    containerRef,
    xtermRef,
    fitAddonRef,
    spawnedRef,
    rehydratingRef,
    outputProtocolRef,
    autoScrollRef,
    scrollPositionRef,
    programmaticScrollGuardRef,
    fitInProgressRef,
    windowFocusedRef,
    paneVisibilityRef,
    ptyResizeStateRef,
    fitScheduleRef,
    resizeDebounceRef,
    currentCwdRef,
    contextRequestRef,
    atPowerShellPromptRef,
    setRestartToken,
    setCurrentCwd,
    setGitBranch,
    scheduleFollowBottomRepair,
  });

  useTerminalPaneLifecycle({
    terminalId,
    shell,
    cwd,
    agentId,
    terminalWorkspaceId,
    terminalGenerationRef,
    terminalProcessIdRef,
    terminalIdRef,
    containerRef,
    xtermRef,
    fitAddonRef,
    spawnedRef,
    rehydratingRef,
    outputProtocolRef,
    xtermWriteBackpressureRef,
    streamEpochRef,
    reopeningRef,
    unsubOutputRef,
    outputWarmupUnsubRef,
    unsubExitRef,
    autoScrollRef,
    scrollPositionRef,
    userScrollIntentRef,
    programmaticScrollGuardRef,
    fitInProgressRef,
    windowFocusedRef,
    paneVisibilityRef,
    ptyResizeStateRef,
    fitScheduleRef,
    resizeDebounceRef,
    atPowerShellPromptRef,
    dataDisposableRef,
    scrollDisposableRef,
    restartToken,
    setRestartToken,
    setStreamSyncFailed,
    refreshTerminalContext,
    syncContextFromPowerShellPrompt,
    scheduleFitAndResize,
    scheduleFollowBottomRepair,
    cancelFollowBottomRepair,
  });


  useTerminalInput(terminalId, containerRef, xtermRef);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const handleMouseDown = () => {
      useTerminalStore.getState().clearAgentAttention(terminalId);
      if (!isActiveRef.current) {
        onActivate(terminalId);
      }
    };
    el.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () =>
      el.removeEventListener("mousedown", handleMouseDown, { capture: true });
  }, [terminalId, onActivate]);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(true);
  }, []);

  const handleConfirmClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setConfirmClose(false);
      onClose?.(terminalId);
    },
    [terminalId, onClose],
  );

  const handleCancelClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(false);
  }, []);

  const handleToggleFocus = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFocus?.(terminalId);
    },
    [terminalId, onToggleFocus],
  );

  // Titolo visualizzato: prima controlla se l'utente ha rinominato, poi deriva.
  const customTitle = useTerminalStore((s) => s.terminalTitles[terminalId]);
  const agentStatus = useTerminalStore(
    (s) => s.terminals[terminalId]?.agentStatus ?? "idle",
  );
  const agentAttentionRequired = useTerminalStore(
    (s) => s.terminals[terminalId]?.agentAttentionRequired ?? false,
  );
  const previousAgentStatusRef = useRef(agentStatus);
  useEffect(() => {
    const completedNow =
      agentStatus === "completed" &&
      previousAgentStatusRef.current !== "completed";
    previousAgentStatusRef.current = agentStatus;
    if (completedNow && scrollPositionRef.current.followsOutput) {
      scheduleFollowBottomRepair(3);
    }
  }, [agentStatus, scheduleFollowBottomRepair]);
  const workspaceIndex = useWorkspaceStore((state) =>
    state.workspaces.findIndex((workspace) => workspace.id === terminalWorkspaceId),
  );
  const workspaceColor = getWorkspaceColor(
    workspaceIndex >= 0 ? workspaceIndex : 0,
  );
  const displayTitle =
    customTitle ??
    (() => {
      // Titles saved by the workspace registry are the durable source of
      // truth after a remount/restart. Keep the generated shell/agent title
      // for the default values so a cwd change still updates the hint.
      const configuredTitle = title.trim();
      const defaultTitle = agentId ? agentDisplayName(agentId) : "Terminale";
      if (
        configuredTitle &&
        configuredTitle !== "Terminal" &&
        configuredTitle !== defaultTitle
      ) {
        return configuredTitle;
      }
      return agentId
        ? `${agentDisplayName(agentId)} — ${projectNameFromCwd(currentCwd)}`
        : `${shell} — ${projectNameFromCwd(currentCwd)}`;
    })();

  const titleBarMetrics = getTitleBarMetrics(terminalCount);
  const titleBarStyle: React.CSSProperties = {
    ...TITLE_BAR_STYLE,
    height: titleBarMetrics.height,
    minHeight: titleBarMetrics.height,
    padding: titleBarMetrics.padding,
    position: "relative",
  };

  const handleStartRename = useCallback(() => {
    setEditValue(displayTitle);
    setEditing(true);
  }, [displayTitle]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== displayTitle) {
      void invokeWithTimeout(
        () =>
          invoke("update_terminal_title", {
            workspaceId: terminalWorkspaceId,
            terminalId,
            title: trimmed,
        }),
        10000,
      ).then(() => {
        const terminalStore = useTerminalStore.getState();
        terminalStore.renameTerminal(terminalId, trimmed);
        terminalStore.updateTitle(terminalId, trimmed);
      }).catch((error) => {
        reportFrontendDiagnostic("terminal-title-error", error, {
          terminalId,
          workspaceId: terminalWorkspaceId,
          generation: terminalGenerationRef.current ?? undefined,
          processId: terminalProcessIdRef.current,
          state: "persist-title",
        });
        useToastStore.getState().addToast({
          type: "error",
          message: "Rinomina non salvata: il titolo del terminale non è cambiato.",
        });
      });
    }
    setEditing(false);
  }, [displayTitle, editValue, terminalId, terminalWorkspaceId]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleRenameSubmit();
      } else if (e.key === "Escape") {
        setEditing(false);
      }
      e.stopPropagation();
    },
    [handleRenameSubmit],
  );

  const handleRestart = useCallback(async () => {
    if (reopeningRef.current) return;
    reopeningRef.current = true;
    try {
      rehydratingRef.current = true;
      const expectedGeneration = terminalGenerationRef.current ??
        useTerminalStore.getState().terminals[terminalId]?.generation;
      if (expectedGeneration === null || expectedGeneration === undefined) {
        throw new Error("terminal identity unavailable for reopen");
      }
      outputProtocolRef.current.startRehydrate({
        workspaceId: terminalWorkspaceId,
        generation: expectedGeneration,
        processId: terminalProcessIdRef.current,
      });
      const runtime = await invoke<TerminalRuntimeIdentity>("terminal_reopen", {
        terminalId,
        expectedGeneration,
        expectedProcessId: terminalProcessIdRef.current,
        shell,
        cwd: currentCwd,
        cols: xtermRef.current?.cols ?? 80,
        rows: xtermRef.current?.rows ?? 24,
        workspaceId: useTerminalStore.getState().terminals[terminalId]?.workspaceId ?? null,
        agentId: agentId ?? null,
      });
      if (!terminalWorkspaceId || runtime.workspaceId !== terminalWorkspaceId) {
        throw new Error(
          `stale-terminal-workspace: expected ${terminalWorkspaceId || "missing"}, current ${runtime.workspaceId || "missing"}`,
        );
      }
      terminalGenerationRef.current = runtime.generation;
      terminalProcessIdRef.current = runtime.processId;
      outputProtocolRef.current.startRehydrate(runtimeKey(runtime));
      scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
      autoScrollRef.current = true;
      cancelProgrammaticScroll(programmaticScrollGuardRef.current);
      useTerminalStore.getState().markSpawned(
        terminalId,
        runtime.workspaceId,
        runtime.generation,
        runtime.processId,
      );
      spawnedRef.current = false;
      setRestartToken((token) => token + 1);
    } catch (err) {
      reopeningRef.current = false;
      rehydratingRef.current = false;
      reportFrontendDiagnostic("terminal-reopen-error", err, {
        terminalId,
        workspaceId: terminalWorkspaceId,
        generation: terminalGenerationRef.current ?? undefined,
        processId: terminalProcessIdRef.current,
        state: "reopen",
      });
      console.error("Errore reopen terminale:", err);
    }
  }, [terminalId, terminalWorkspaceId, shell, currentCwd, agentId]);

  const handleRetryStreamSync = useCallback(() => {
    const runtime = currentRuntimeKey(terminalId);
    if (!runtime) return;
    outputProtocolRef.current.startRehydrate(runtime);
    terminalGenerationRef.current = runtime.generation;
    terminalProcessIdRef.current = runtime.processId;
    rehydratingRef.current = true;
    spawnedRef.current = false;
    setStreamSyncFailed(false);
    setRestartToken((token) => token + 1);
  }, [terminalId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("application/x-traflix-terminal-id")) {
      e.dataTransfer.dropEffect = "move";
    } else {
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      dragCounterRef.current = 0;
      try {
        const draggedTerminalId = e.dataTransfer.getData("application/x-traflix-terminal-id");
        if (draggedTerminalId) {
          if (draggedTerminalId !== terminalId && onReorder) {
            onReorder(draggedTerminalId, terminalId);
          }
          return;
        }

        const raw = e.dataTransfer.getData("application/json");
        if (raw) {
          const data = JSON.parse(raw);
          if (data.type === "skill" && data.name) {
            const store = useTerminalStore.getState();
            const terminal = store.terminals[terminalId];
            if (!terminal || terminal.generation === null) return;
            store.markAgentInput(terminalId);
            useSkillStore.getState().addPendingDrop(terminalId, {
              workspaceId: terminal.workspaceId,
              generation: terminal.generation,
              processId: terminal.processId,
            }, data.name);
            return;
          }
        }
        const text = e.dataTransfer.getData("text/plain");
        if (text && text.trim()) {
          const skills = useSkillStore.getState().skills;
          const matchedSkill = skills.find(
            (s) => s.name.toLowerCase() === text.trim().toLowerCase(),
          );
          if (matchedSkill) {
            const store = useTerminalStore.getState();
            const terminal = store.terminals[terminalId];
            if (!terminal || terminal.generation === null) return;
            store.markAgentInput(terminalId);
            useSkillStore
              .getState()
              .addPendingDrop(terminalId, {
                workspaceId: terminal.workspaceId,
                generation: terminal.generation,
                processId: terminal.processId,
              }, matchedSkill.name);
          }
        }
      } catch {
        // ignore
      }
    },
    [terminalId, onReorder],
  );

  return (
    <TerminalPaneView
      terminalId={terminalId}
      terminalCount={terminalCount}
      isActive={isActive}
      isFocused={isFocused}
      hasExited={hasExited}
      exitCode={exitCode}
      agentStatus={agentStatus}
      agentAttentionRequired={agentAttentionRequired}
      draggedTerminalId={draggedTerminalId}
      isDragHovered={isDragHovered}
      isDragOver={isDragOver}
      gitBranch={gitBranch}
      workspaceColor={workspaceColor}
      editing={editing}
      editValue={editValue}
      setEditValue={setEditValue}
      displayTitle={displayTitle}
      titleBarMetrics={titleBarMetrics}
      titleBarStyle={titleBarStyle}
      containerRef={containerRef}
      dragCleanupRef={dragCleanupRef}
      confirmClose={confirmClose}
      pendingNames={pendingNames}
      streamSyncFailed={streamSyncFailed}
      onClose={onClose}
      onToggleFocus={onToggleFocus}
      onReorder={onReorder}
      handleDragOver={handleDragOver}
      handleDragEnter={handleDragEnter}
      handleDragLeave={handleDragLeave}
      handleDrop={handleDrop}
      handleCloseClick={handleCloseClick}
      handleConfirmClose={handleConfirmClose}
      handleCancelClose={handleCancelClose}
      handleToggleFocus={handleToggleFocus}
      handleStartRename={handleStartRename}
      handleRenameSubmit={handleRenameSubmit}
      handleRenameKeyDown={handleRenameKeyDown}
      handleRetryStreamSync={handleRetryStreamSync}
      handleRestart={handleRestart}
    />
  );
});
