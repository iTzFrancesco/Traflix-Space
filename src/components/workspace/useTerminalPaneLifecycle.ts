import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  useTerminalStore,
  type TerminalScrollPosition,
} from "../../stores/terminalStore";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import {
  subscribeTerminalExit,
  subscribeTerminalOutput,
  waitForTerminalOutputListener,
} from "../../lib/terminalEvents";
import { encodeForPty } from "../../lib/ptyWrite";
import { reportFrontendDiagnostic } from "../../lib/crashDiagnostics";
import {
  cancelProgrammaticScroll,
  isTerminalViewportNavigationKey,
  positionAfterHiddenOutput,
  positionAfterUnmountedOutput,
  reconcileScrollSample,
  shouldTrackTerminalWheel,
  type ProgrammaticScrollGuard,
} from "../../lib/terminalScrollState";
import {
  TerminalOutputProtocol,
  type SequencedTerminalChunk,
  type TerminalRuntimeKey,
} from "../../lib/terminalOutputProtocol";
import {
  cancelTerminalWrites,
  createTerminalWriteBackpressure,
  releaseTerminalWrite,
  reserveTerminalWrite,
  waitForTerminalWrites,
} from "../../lib/terminalWriteBackpressure";
import type {
  TerminalRehydrateState,
  TerminalRuntimeIdentity,
} from "../terminal/types";
import {
  captureScrollPosition,
  currentRuntimeKey,
  isTerminalExitedError,
  isTerminalScrollLayoutUsable,
  mergeOutputChunks,
  restoreScrollPosition,
  runtimeKey,
  sameRuntimeKey,
  syncMeasuredPtySize,
  type PtyResizeState,
  type TerminalPaneVisibility,
} from "./TerminalPaneRuntime";
import { isPowerShell, STOCK_THEME } from "./TerminalPaneSupport";

export interface TerminalPaneLifecycleContext {
  terminalId: string;
  shell: string;
  cwd: string;
  agentId?: string | null;
  terminalWorkspaceId: string;
  terminalGenerationRef: MutableRefObject<number | null>;
  terminalProcessIdRef: MutableRefObject<number | null>;
  terminalIdRef: MutableRefObject<string>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  xtermRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  spawnedRef: MutableRefObject<boolean>;
  rehydratingRef: MutableRefObject<boolean>;
  outputProtocolRef: MutableRefObject<TerminalOutputProtocol>;
  xtermWriteBackpressureRef: MutableRefObject<ReturnType<typeof createTerminalWriteBackpressure>>;
  streamEpochRef: MutableRefObject<number>;
  reopeningRef: MutableRefObject<boolean>;
  unsubOutputRef: MutableRefObject<(() => void) | null>;
  outputWarmupUnsubRef: MutableRefObject<(() => void) | null>;
  unsubExitRef: MutableRefObject<(() => void) | null>;
  autoScrollRef: MutableRefObject<boolean>;
  scrollPositionRef: MutableRefObject<TerminalScrollPosition>;
  userScrollIntentRef: MutableRefObject<boolean>;
  programmaticScrollGuardRef: MutableRefObject<ProgrammaticScrollGuard>;
  fitInProgressRef: MutableRefObject<boolean>;
  windowFocusedRef: MutableRefObject<boolean>;
  paneVisibilityRef: MutableRefObject<TerminalPaneVisibility>;
  ptyResizeStateRef: MutableRefObject<PtyResizeState>;
  fitScheduleRef: MutableRefObject<{ raf: number | null; remainingFrames: number; retryFrames: number; deadline: number }>;
  resizeDebounceRef: MutableRefObject<number | null>;
  atPowerShellPromptRef: MutableRefObject<boolean>;
  dataDisposableRef: MutableRefObject<{ dispose: () => void } | null>;
  scrollDisposableRef: MutableRefObject<{ dispose: () => void } | null>;
  restartToken: number;
  setRestartToken: Dispatch<SetStateAction<number>>;
  setStreamSyncFailed: Dispatch<SetStateAction<boolean>>;
  refreshTerminalContext: () => Promise<void>;
  syncContextFromPowerShellPrompt: (term: Terminal) => Promise<void>;
  scheduleFitAndResize: (waitFrames?: number) => void;
  scheduleFollowBottomRepair: (framePasses?: number) => void;
  cancelFollowBottomRepair: () => void;
}

export function useTerminalPaneLifecycle({
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
}: TerminalPaneLifecycleContext) {
  // 1. Create xterm once per mount
  useEffect(() => {
    xtermWriteBackpressureRef.current = createTerminalWriteBackpressure();
    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      // Align with backend vt100 SCROLLBACK_LINES (1000) for remount rehydrate.
      scrollback: 1000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
    }
    scrollPositionRef.current =
      useTerminalStore.getState().terminals[terminalId]?.scrollPosition ??
      scrollPositionRef.current;
    autoScrollRef.current = scrollPositionRef.current.followsOutput;

    dataDisposableRef.current = term.onData((data) => {
      // The current prompt is being edited/executed. The next complete prompt
      // marks command completion even when it has the same CWD and text.
      atPowerShellPromptRef.current = false;
      const tid = terminalIdRef.current;
      if (!tid) return;
      const termState = useTerminalStore.getState().terminals[tid];
      if (
        !termState ||
        termState.exitCode !== null ||
        termState.generation === null
      ) return;
      useTerminalStore.getState().markAgentInput(tid);
      const write = invoke("terminal_write", {
        terminalId: tid,
        workspaceId: termState.workspaceId,
        generation: termState.generation,
        processId: termState.processId,
        data: encodeForPty(data),
      });
      const handleWriteError = (error: unknown) => {
        reportFrontendDiagnostic("terminal-input-error", error, {
          terminalId: tid,
          workspaceId: termState.workspaceId,
          generation: termState.generation ?? undefined,
          processId: termState.processId,
          state: "xterm-input",
        });
        console.warn("[terminal-lifecycle] PTY input rejected", {
          terminalId: tid,
          generation: termState.generation,
          processId: termState.processId,
          error: String(error),
        });
      };

      // PowerShell is refreshed only after its next completed prompt, when
      // commands such as `git checkout` have actually finished. Other shells
      // retain the Enter fallback because their prompt format is unknown.
      if (
        !isPowerShell(shell) &&
        (data.includes("\r") || data.includes("\n"))
      ) {
        write.then(() => void refreshTerminalContext()).catch(handleWriteError);
      } else {
        write.catch(handleWriteError);
      }
    });

    scrollDisposableRef.current?.dispose();
    scrollDisposableRef.current = term.onScroll(() => {
      // xterm may emit a scroll event while fitAddon.resize() is reflowing the
      // buffer. That is layout work, not user navigation, and must not replace
      // the follow-mode snapshot with a transient viewportY at the top.
      const userInitiated = userScrollIntentRef.current;
      if (userInitiated) {
        // A real input event wins even if it lands synchronously inside an
        // xterm restore call.
        cancelProgrammaticScroll(programmaticScrollGuardRef.current);
      }
      const programmaticTarget = programmaticScrollGuardRef.current.target;
      const layoutStable = isTerminalScrollLayoutUsable(
        term,
        paneVisibilityRef,
        windowFocusedRef,
      );
      const reconciliation = reconcileScrollSample(scrollPositionRef.current, {
        baseY: term.buffer.active.baseY,
        viewportY: term.buffer.active.viewportY,
        layoutStable,
        fitInProgress: fitInProgressRef.current,
        rehydrating: rehydratingRef.current,
        userInitiated,
        programmatic: !userInitiated && programmaticTarget !== null,
      });
      if (!layoutStable || fitInProgressRef.current || rehydratingRef.current) {
        userScrollIntentRef.current = false;
        return;
      }
      if (reconciliation.repairFollow) {
        // Follow mode is authoritative across xterm's asynchronous reflow.
        // This also repairs a viewport that was moved to line zero while the
        // window or pane was hidden.
        restoreScrollPosition(
          term,
          autoScrollRef,
          scrollPositionRef,
          programmaticScrollGuardRef,
        );
        return;
      }

      // The guard is cleared in a microtask by runProgrammaticScroll. It can
      // suppress only events from this restore call, never a later output.
      if (!userInitiated && programmaticTarget !== null) {
        return;
      }

      // Every non-programmatic xterm scroll event is authoritative. Output
      // can change baseY while a reader is in history, and ignoring these
      // events while writes are pending loses the real viewport under load.
      if (reconciliation.captured) {
        scrollPositionRef.current = reconciliation.position;
        autoScrollRef.current = reconciliation.position.followsOutput;
      }
      userScrollIntentRef.current = false;
      if (!scrollPositionRef.current.followsOutput) {
        cancelFollowBottomRepair();
      }
    });

    let disposed = false;
    const scheduleUserScrollCapture = () => {
      requestAnimationFrame(() => {
        if (disposed || xtermRef.current !== term) return;
        if (
          !rehydratingRef.current &&
          isTerminalScrollLayoutUsable(
            term,
            paneVisibilityRef,
            windowFocusedRef,
          )
        ) {
          captureScrollPosition(term, autoScrollRef, scrollPositionRef);
        }
        userScrollIntentRef.current = false;
      });
    };
    const onWheel = (event: WheelEvent) => {
      // A full-screen TUI in the alternate buffer owns its mouse protocol.
      // Treating that wheel as xterm history navigation used to disable
      // follow mode even though the viewport never moved.
      if (!shouldTrackTerminalWheel(term.buffer.active.type)) return;
      userScrollIntentRef.current = true;
      // Stop a queued output callback from snapping back before the browser
      // applies this upward wheel movement.
      if (event.deltaY < 0) {
        cancelFollowBottomRepair();
        autoScrollRef.current = false;
        scrollPositionRef.current = {
          followsOutput: false,
          offsetFromBottom: Math.max(1, scrollPositionRef.current.offsetFromBottom),
          baseYAtCapture: term.buffer.active.baseY,
        };
      }
      // Applications using the alternate buffer/mouse reporting own the
      // regular wheel event. Shift+wheel is the standard terminal-emulator
      // escape hatch: keep the agent's mouse interaction intact while still
      // allowing the user to inspect xterm scrollback when it exists.
      if (event.shiftKey && term.buffer.active.type === "normal") {
        event.preventDefault();
        event.stopPropagation();
        const magnitude = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? Math.abs(event.deltaY)
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.abs(event.deltaY) * term.rows
            : Math.max(1, Math.round(Math.abs(event.deltaY) / 20));
        term.scrollLines(Math.max(1, magnitude) * (event.deltaY < 0 ? -1 : 1));
      }
      scheduleUserScrollCapture();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTerminalViewportNavigationKey(
        term.buffer.active.type,
        event.key,
        event.shiftKey,
      )) return;
      userScrollIntentRef.current = true;
      if (event.key === "PageUp" || event.key === "Home") {
        cancelFollowBottomRepair();
        autoScrollRef.current = false;
      }
      scheduleUserScrollCapture();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!shouldTrackTerminalWheel(term.buffer.active.type)) return;
      const viewport = term.element?.querySelector<HTMLElement>(".xterm-viewport");
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const scrollbarWidth = Math.max(16, viewport.offsetWidth - viewport.clientWidth);
      if (event.clientX < rect.right - scrollbarWidth) return;
      // Covers drag of xterm's scrollbar. Suspend immediately so a queued
      // output callback cannot pull the thumb back to the live bottom.
      userScrollIntentRef.current = true;
      cancelFollowBottomRepair();
      autoScrollRef.current = false;
      scrollPositionRef.current = {
        followsOutput: false,
        offsetFromBottom: Math.max(1, scrollPositionRef.current.offsetFromBottom),
        baseYAtCapture: term.buffer.active.baseY,
      };
    };
    // WebView2 can expose the native scrollbar as a mouse event without a
    // reliable pointer event. Treat both paths as explicit user navigation.
    const onMouseDown = (event: MouseEvent) => {
      onPointerDown(event as unknown as PointerEvent);
    };
    const finishScrollbarGesture = () => {
      if (userScrollIntentRef.current) scheduleUserScrollCapture();
    };
    const container = containerRef.current;
    container?.addEventListener("wheel", onWheel, { passive: false, capture: true });
    container?.addEventListener("keydown", onKeyDown, { capture: true });
    container?.addEventListener("pointerdown", onPointerDown, { capture: true });
    container?.addEventListener("mousedown", onMouseDown, { capture: true });
    window.addEventListener("pointerup", finishScrollbarGesture, { capture: true });
    window.addEventListener("pointercancel", finishScrollbarGesture, { capture: true });
    window.addEventListener("mouseup", finishScrollbarGesture, { capture: true });

    return () => {
      disposed = true;
      // Do not sample xterm during teardown. React can unmount this pane while
      // its host grid is collapsing, and xterm may report viewportY=0 for that
      // layout-only transition. All valid user scroll events have already
      // updated scrollPositionRef, so saving the last known intent is safer.
      useTerminalStore.getState().saveScrollPosition(
        terminalIdRef.current,
        terminalGenerationRef.current,
        scrollPositionRef.current,
      );
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
      unsubExitRef.current?.();
      unsubExitRef.current = null;
      dataDisposableRef.current?.dispose();
      dataDisposableRef.current = null;
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      container?.removeEventListener("wheel", onWheel, { capture: true });
      container?.removeEventListener("keydown", onKeyDown, { capture: true });
      container?.removeEventListener("pointerdown", onPointerDown, { capture: true });
      container?.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("pointerup", finishScrollbarGesture, { capture: true });
      window.removeEventListener("pointercancel", finishScrollbarGesture, { capture: true });
      window.removeEventListener("mouseup", finishScrollbarGesture, { capture: true });
      if (fitScheduleRef.current.raf !== null) {
        cancelAnimationFrame(fitScheduleRef.current.raf);
        fitScheduleRef.current.raf = null;
        fitScheduleRef.current.remainingFrames = 0;
        fitScheduleRef.current.retryFrames = 0;
      }
      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      cancelFollowBottomRepair();
      cancelProgrammaticScroll(programmaticScrollGuardRef.current);
      cancelTerminalWrites(xtermWriteBackpressureRef.current);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [cancelFollowBottomRepair, refreshTerminalContext, shell, terminalId]);


  // Prime the shared output listener before the spawn effect below runs. The
  // Tauri listen registration is asynchronous, so the spawn effect also waits
  // for it before the shell can emit its first prompt.
  useEffect(() => {
    outputWarmupUnsubRef.current?.();
    outputWarmupUnsubRef.current = subscribeTerminalOutput(terminalId, () => {});
    return () => {
      outputWarmupUnsubRef.current?.();
      outputWarmupUnsubRef.current = null;
    };
  }, [terminalId]);

  // 2. Spawn PTY + optional screen rehydrate + agent launch
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    const storeState = useTerminalStore.getState();
    const t = storeState.terminals[terminalId];
    if (t?.generation !== null && t?.generation !== undefined) {
      terminalGenerationRef.current = t.generation;
      terminalProcessIdRef.current = t.processId;
      outputProtocolRef.current.startRehydrate({
        workspaceId: t.workspaceId,
        generation: t.generation,
        processId: t.processId,
      });
    }
    spawnedRef.current = true;
    const epoch = ++streamEpochRef.current;
    let disposed = false;
    const isCurrent = () =>
      !disposed && streamEpochRef.current === epoch && xtermRef.current === term;

    // Always take a backend snapshot. On first open the shell can emit its
    // prompt before the React event listener is attached; treating the
    // parser as authoritative closes that initial-output race too.
    // Set this before any await: terminal_spawn and terminal_resize can
    // trigger output from a live TUI while the new xterm is still empty.
    rehydratingRef.current = true;

    const cols = Math.max(term.cols, 80);
    const rows = Math.max(term.rows, 24);
    let spawnSucceeded = false;
    const replayBufferedOutput = async () => {
      while (isCurrent()) {
        const replay = outputProtocolRef.current.takeReplay();
        if (replay.kind === "gap") {
          throw new Error(
            `terminal-output-gap: expected ${replay.expected}, received ${replay.received}`,
          );
        }
        if (replay.kind === "chunks") {
          await new Promise<void>((resolve) =>
            term.write(mergeOutputChunks(replay.chunks), resolve),
          );
          continue;
        }
        // Empty-check and live transition are one synchronous operation. If an
        // output callback appended data earlier, cutover returns false and the
        // loop replays it; no final chunk can be stranded in a dead queue.
        if (outputProtocolRef.current.cutoverToLive()) {
          return;
        }
      }
      throw new Error("terminal-stream-superseded");
    };
    const restoreSnapshot = async (expectedRuntime: TerminalRuntimeKey | null) => {
      const rehydrateState = await invoke<TerminalRehydrateState>("terminal_get_screen_text", {
        terminalId,
        workspaceId: expectedRuntime?.workspaceId ?? terminalWorkspaceId,
        expectedGeneration: expectedRuntime?.generation ?? null,
        expectedProcessId: expectedRuntime?.processId ?? null,
      });
      if (!isCurrent()) throw new Error("terminal-stream-superseded");
      const snapshotRuntime = runtimeKey(rehydrateState);
      if (
        expectedRuntime &&
        (rehydrateState.workspaceId !== expectedRuntime.workspaceId ||
          rehydrateState.generation !== expectedRuntime.generation ||
          rehydrateState.processId !== expectedRuntime.processId)
      ) {
        throw new Error("stale-terminal-generation: rehydrate snapshot changed");
      }
      if (!outputProtocolRef.current.currentRuntime()) {
        outputProtocolRef.current.startRehydrate(snapshotRuntime);
      }
      terminalGenerationRef.current = rehydrateState.generation;
      terminalProcessIdRef.current = rehydrateState.processId;
      outputProtocolRef.current.installSnapshot(
        snapshotRuntime,
        rehydrateState.outputSequence,
      );
      const termNow = xtermRef.current;
      if (!termNow) return;

      // A gap/overflow can be detected while a previous live term.write is
      // still inside xterm's asynchronous parser. Drain those accepted bytes
      // before reset so they cannot land after the authoritative snapshot.
      await waitForTerminalWrites(xtermWriteBackpressureRef.current);
      if (!isCurrent()) throw new Error("terminal-stream-superseded");

      // The backend stream contains a complete formatted state, including
      // cursor, attributes, alternate screen, and input modes. Reset is safe
      // even for a blank screen.
      termNow.reset();
      if (
        rehydrateState.cols > 0 &&
        rehydrateState.rows > 0 &&
        (termNow.cols !== rehydrateState.cols || termNow.rows !== rehydrateState.rows)
      ) {
        termNow.resize(rehydrateState.cols, rehydrateState.rows);
      }
      if (rehydrateState.history.length > 0) {
        await new Promise<void>((resolve) =>
          termNow.write(new Uint8Array(rehydrateState.history), resolve),
        );
      }
      if (!isCurrent()) throw new Error("terminal-stream-superseded");
      if (rehydrateState.state.length > 0) {
        await new Promise<void>((resolve) =>
          termNow.write(new Uint8Array(rehydrateState.state), resolve),
        );
      }
      if (!isCurrent()) throw new Error("terminal-stream-superseded");
      await replayBufferedOutput();
      if (termNow.buffer.active.type === "normal") {
        scrollPositionRef.current = positionAfterUnmountedOutput(
          scrollPositionRef.current,
          termNow.buffer.active.baseY,
        );
      }
      restoreScrollPosition(
        termNow,
        autoScrollRef,
        scrollPositionRef,
        programmaticScrollGuardRef,
      );
      // Keep scroll sampling and ResizeObserver behind the same barrier as the
      // snapshot/replay cutover. Otherwise reset()/resize()/write() can persist
      // a transient viewportY=0 before the saved reader position is restored.
      rehydratingRef.current = false;
      setStreamSyncFailed(false);
      scheduleFitAndResize(1);
      if (scrollPositionRef.current.followsOutput) {
        scheduleFollowBottomRepair(3);
      }
      if (termNow.rows > 0) {
        termNow.refresh(0, termNow.rows - 1);
      }
    };
    const restoreWithBoundedRetry = async (
      expectedRuntime: TerminalRuntimeKey | null,
    ) => {
      let expected = expectedRuntime;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await restoreSnapshot(expected);
          return;
        } catch (error) {
          lastError = error;
          if (!isCurrent() || String(error).includes("stale-terminal")) throw error;
          if (attempt === 1) {
            console.warn("[terminal-output] bounded rehydrate retry", {
              terminalId,
              generation: expected?.generation ?? null,
              processId: expected?.processId ?? null,
              error: String(error),
            });
            expected = outputProtocolRef.current.currentRuntime();
            if (expected) outputProtocolRef.current.startRehydrate(expected);
          }
        }
      }
      throw lastError;
    };

    void (async () => {
      try {
        await waitForTerminalOutputListener();
        if (!isCurrent()) return;
        if (t?.exitCode !== null && t?.generation != null) {
          await restoreWithBoundedRetry({
            workspaceId: t.workspaceId,
            generation: t.generation,
            processId: t.processId,
          });
          return;
        }
        const runtime = await invoke<TerminalRuntimeIdentity>("terminal_spawn", {
          terminalId,
          shell,
          cwd,
          cols,
          rows,
          workspaceId: useTerminalStore.getState().terminals[terminalId]?.workspaceId ?? null,
          agentId: agentId ?? null,
        });
        if (!isCurrent()) {
          // Workspace switching keeps the store identity and therefore keeps
          // the PTY alive. If the terminal was actually removed while spawn
          // was in flight, close the exact returned lifetime so it cannot
          // become a config-less child process after this pane unmounts.
          const current = useTerminalStore.getState().terminals[terminalId];
          if (!current || current.workspaceId !== runtime.workspaceId) {
            void invoke("terminal_kill", {
              terminalId,
              workspaceId: runtime.workspaceId,
              generation: runtime.generation,
              processId: runtime.processId,
            }).catch((cleanupError) => {
              reportFrontendDiagnostic("terminal-kill-error", cleanupError, {
                terminalId,
                workspaceId: runtime.workspaceId,
                generation: runtime.generation,
                processId: runtime.processId,
                state: "disposed-spawn-cleanup",
              });
            });
          }
          return;
        }
        if (!terminalWorkspaceId || runtime.workspaceId !== terminalWorkspaceId) {
          throw new Error(
            `stale-terminal-workspace: expected ${terminalWorkspaceId || "missing"}, current ${runtime.workspaceId || "missing"}`,
          );
        }
        terminalGenerationRef.current = runtime.generation;
        terminalProcessIdRef.current = runtime.processId;
        outputProtocolRef.current.startRehydrate(runtimeKey(runtime));
        spawnSucceeded = true;
        useTerminalStore.getState().markSpawned(
          terminalId,
          runtime.workspaceId,
          runtime.generation,
          runtime.processId,
        );
        if (runtime.agentLaunchOwner === "backend" && runtime.agentLaunchState) {
          useTerminalStore.getState().markBackendAgentLaunch(
            terminalId,
            runtime.workspaceId,
            runtime.generation,
            runtime.processId,
            runtime.agentLaunchState,
          );
        }

        // Carica il branch git all'avvio del terminale (primo mount + rehydrate).
        // Il backend ritorna Ok(Some("main")) → "main" | Ok(None) → null
        void refreshTerminalContext();

        const fitAddon = fitAddonRef.current;
        if (fitAddon) {
          await syncMeasuredPtySize(
            term,
            fitAddon,
            terminalId,
            runtimeKey(runtime),
            paneVisibilityRef.current.focusModeActive &&
              !paneVisibilityRef.current.isFocused,
            ptyResizeStateRef,
            fitInProgressRef,
          );
        }
        await restoreWithBoundedRetry(runtimeKey(runtime));
        if (isCurrent()) {
          await syncContextFromPowerShellPrompt(term);
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (isTerminalExitedError(error)) {
          // The backend keeps the dead parser so the last screen can still be
          // displayed even when the pane was unmounted at exit time.
          rehydratingRef.current = true;
          try {
            await restoreWithBoundedRetry(
              terminalGenerationRef.current === null
                ? null
                : {
                    workspaceId: terminalWorkspaceId,
                    generation: terminalGenerationRef.current,
                    processId: terminalProcessIdRef.current,
                  },
            );
          } catch (snapshotError) {
            reportFrontendDiagnostic("terminal-snapshot-error", snapshotError, {
              terminalId,
              workspaceId: terminalWorkspaceId,
              generation: terminalGenerationRef.current ?? undefined,
              processId: terminalProcessIdRef.current,
              state: "exited-rehydrate",
            });
            console.error("[terminal-output] exited snapshot failed", {
              terminalId,
              error: String(snapshotError),
            });
          }
          const exitCodeMatch = String(error).match(/exit(?:[-_ ]?code)?\s*[:=]\s*(-?\d+)/i);
          const exitedGeneration = terminalGenerationRef.current;
          if (exitedGeneration !== null) {
            useTerminalStore.getState().markExited(
              terminalId,
              terminalWorkspaceId,
              exitedGeneration,
              terminalProcessIdRef.current,
              exitCodeMatch ? Number(exitCodeMatch[1]) : 0,
            );
          }
        } else {
          spawnedRef.current = false;
          setStreamSyncFailed(true);
          reportFrontendDiagnostic("terminal-lifecycle-error", error, {
            terminalId,
            workspaceId: terminalWorkspaceId,
            generation: terminalGenerationRef.current ?? undefined,
            processId: terminalProcessIdRef.current,
            state: outputProtocolRef.current.isBuffering() ? "buffering" : "live",
          });
          console.error("[terminal-output] lifecycle failed", {
            terminalId,
            generation: terminalGenerationRef.current,
            processId: terminalProcessIdRef.current,
            error: String(error),
          });
          term.write(
            "\r\n\x1b[31m[Traflix: impossibile sincronizzare il terminale; riaprilo per riprovare]\x1b[0m\r\n",
          );
        }
      } finally {
        if (isCurrent()) {
          rehydratingRef.current = outputProtocolRef.current.isBuffering();
          reopeningRef.current = false;
        }
      }

      if (isCurrent() && agentId && spawnSucceeded) {
        const store = useTerminalStore.getState();
        const terminal = store.terminals[terminalId];
        if (
          terminal?.generation !== null &&
          terminal?.generation !== undefined &&
          !terminal.agentLaunched &&
          terminal.agentLaunchOwner !== "backend"
        ) {
          store.markAgentLaunched(terminalId, terminal.generation);
          agentLaunchQueue.enqueue(terminalId, terminal.generation, agentId);
        }
      }
    })();

    return () => {
      disposed = true;
      if (streamEpochRef.current === epoch) streamEpochRef.current += 1;
    };
  }, [
    terminalId,
    shell,
    cwd,
    agentId,
    refreshTerminalContext,
    scheduleFitAndResize,
    scheduleFollowBottomRepair,
    syncContextFromPowerShellPrompt,
    restartToken,
  ]);

  // 4a. Output — shared bus + rAF batch (already coalesced in terminalEvents)
  useEffect(() => {
    outputWarmupUnsubRef.current?.();
    outputWarmupUnsubRef.current = null;
    unsubOutputRef.current?.();
    unsubOutputRef.current = subscribeTerminalOutput(terminalId, (payload) => {
      if (payload.resyncRequired) {
        const signaledRuntime = runtimeKey(payload);
        if (!sameRuntimeKey(currentRuntimeKey(terminalId), signaledRuntime)) return;
        reportFrontendDiagnostic("terminal-output-resync", payload.resyncReason, {
          terminalId,
          workspaceId: payload.workspaceId,
          generation: payload.generation,
          processId: payload.processId,
          state: "frontend-queue-overflow",
        });
        outputProtocolRef.current.startRehydrate(signaledRuntime);
        rehydratingRef.current = true;
        spawnedRef.current = false;
        setRestartToken((token) => token + 1);
        return;
      }
      const chunks: SequencedTerminalChunk[] = payload.chunks ?? [{
        workspaceId: payload.workspaceId,
        sequence: payload.sequence,
        generation: payload.generation,
        processId: payload.processId,
        data: new Uint8Array(payload.data),
      }];
      const result = outputProtocolRef.current.ingest(chunks);
      if (result.resyncRequired) {
        reportFrontendDiagnostic("terminal-output-resync", "terminal-output-gap", {
          terminalId,
          workspaceId: payload.workspaceId,
          generation: payload.generation,
          processId: payload.processId,
          state: "sequence-gap",
        });
        console.warn("[terminal-output] sequence gap; requesting authoritative snapshot", {
          terminalId,
          generation: payload.generation,
          processId: payload.processId,
          receivedSequence: payload.sequence,
          lastDeliveredSequence: outputProtocolRef.current.lastDeliveredSequence(),
        });
        rehydratingRef.current = true;
        spawnedRef.current = false;
        setRestartToken((token) => token + 1);
        return;
      }
      if (result.deliver.length === 0) return;
      const data = mergeOutputChunks(result.deliver);
      const term = xtermRef.current;
      if (!term) return;
      const deliveredRuntime = runtimeKey(result.deliver[0]);
      const baseYBeforeWrite = term.buffer.active.baseY;
      const writeState = xtermWriteBackpressureRef.current;
      const requestBackpressureSnapshot = (error: unknown) => {
        if (!sameRuntimeKey(currentRuntimeKey(terminalId), deliveredRuntime)) return;
        reportFrontendDiagnostic("terminal-output-resync", error, {
          terminalId,
          workspaceId: deliveredRuntime.workspaceId,
          generation: deliveredRuntime.generation,
          processId: deliveredRuntime.processId,
          state: "xterm-write-backpressure",
        });
        console.warn("[terminal-output] xterm write queue requires snapshot", {
          terminalId,
          workspaceId: deliveredRuntime.workspaceId,
          generation: deliveredRuntime.generation,
          processId: deliveredRuntime.processId,
          errorCode: String(error),
        });
        outputProtocolRef.current.startRehydrate(deliveredRuntime);
        rehydratingRef.current = true;
        spawnedRef.current = false;
        setRestartToken((token) => token + 1);
      };
      if (!reserveTerminalWrite(writeState, data.byteLength)) {
        requestBackpressureSnapshot("xterm-write-backpressure");
        return;
      }
      try {
        term.write(data, () => {
          releaseTerminalWrite(writeState, data.byteLength);
          if (
            xtermRef.current !== term ||
            !sameRuntimeKey(currentRuntimeKey(terminalId), deliveredRuntime)
          ) {
            return;
          }
          void syncContextFromPowerShellPrompt(term);
          // xterm writes asynchronously. Scrolling before this callback uses the
          // previous baseY and leaves the viewport one or more chunks behind.
          // Check the current value so a user scroll during a large agent output
          // is respected instead of being pulled back to the bottom.
          if (scrollPositionRef.current.followsOutput && !userScrollIntentRef.current) {
            autoScrollRef.current = true;
            scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
            if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
              restoreScrollPosition(
                term,
                autoScrollRef,
                scrollPositionRef,
                programmaticScrollGuardRef,
              );
            }
            scheduleFollowBottomRepair(1);
          } else if (
            isTerminalScrollLayoutUsable(
              term,
              paneVisibilityRef,
              windowFocusedRef,
            )
          ) {
            // Output changes baseY while a reader stays at an older line. Record
            // the new relative offset so a later resize/remount returns here.
            captureScrollPosition(term, autoScrollRef, scrollPositionRef);
          } else if (!scrollPositionRef.current.followsOutput) {
            // While hidden, viewportY can be a layout artifact but the increase
            // in baseY caused by this exact write is still meaningful. Grow the
            // saved distance from the bottom so continuous TUI output does not
            // move a reader forward when the pane becomes visible again.
            const previous = scrollPositionRef.current;
            scrollPositionRef.current = positionAfterHiddenOutput(
              previous,
              previous.baseYAtCapture ?? baseYBeforeWrite,
              term.buffer.active.baseY,
            );
          }
        });
      } catch (error) {
        releaseTerminalWrite(writeState, data.byteLength);
        requestBackpressureSnapshot(error);
      }
    });
    return () => {
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
    };
  }, [terminalId, scheduleFollowBottomRepair, syncContextFromPowerShellPrompt]);

  // 4b. Exit
  useEffect(() => {
    unsubExitRef.current?.();
    unsubExitRef.current = subscribeTerminalExit(
      terminalId,
      ({ terminalId: tid, workspaceId, generation, processId, exitCode: code }) => {
        if (reopeningRef.current) return;
        if (workspaceId !== terminalWorkspaceId) return;
        if (
          terminalGenerationRef.current !== null &&
          generation !== terminalGenerationRef.current
        ) {
          return;
        }
        if (
          terminalProcessIdRef.current !== null &&
          processId !== null &&
          processId !== terminalProcessIdRef.current
        ) {
          return;
        }
        useTerminalStore.getState().markExited(
          tid,
          workspaceId,
          generation,
          processId,
          code,
        );
      },
    );
    return () => {
      unsubExitRef.current?.();
      unsubExitRef.current = null;
    };
  }, [terminalId, terminalWorkspaceId]);
}
