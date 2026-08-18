import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { reportFrontendDiagnostic, reportFrontendDiagnosticCode } from "../../lib/crashDiagnostics";
import {
  currentRuntimeKey,
  fitAndResizePty,
  sameRuntimeKey,
  type PtyResizeState,
  type TerminalPaneVisibility,
} from "./TerminalPaneRuntime";
import { cancelProgrammaticScroll } from "../../lib/terminalScrollState";
import {
  MAX_LAYOUT_FIT_RETRY_FRAMES,
  MAX_LAYOUT_SETTLE_MS,
  powerShellPrompt,
  sameWindowsPath,
  type TerminalContext,
  type TerminalCwdChangedPayload,
} from "./TerminalPaneSupport";
import type { Terminal } from "xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalOutputProtocol } from "../../lib/terminalOutputProtocol";
import type { ProgrammaticScrollGuard } from "../../lib/terminalScrollState";
import type { TerminalScrollPosition } from "../../stores/terminalStore";

export interface TerminalPaneLayoutContext {
  terminalId: string;
  shell: string;
  cwd: string;
  terminalWorkspaceId: string;
  terminalCount: number;
  layoutRevision: string;
  runtimeGeneration: number | null;
  runtimeProcessId: number | null;
  isActive: boolean;
  isFocused: boolean;
  focusModeActive: boolean;
  terminalGenerationRef: MutableRefObject<number | null>;
  terminalProcessIdRef: MutableRefObject<number | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  xtermRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  spawnedRef: MutableRefObject<boolean>;
  rehydratingRef: MutableRefObject<boolean>;
  outputProtocolRef: MutableRefObject<TerminalOutputProtocol>;
  autoScrollRef: MutableRefObject<boolean>;
  scrollPositionRef: MutableRefObject<TerminalScrollPosition>;
  programmaticScrollGuardRef: MutableRefObject<ProgrammaticScrollGuard>;
  fitInProgressRef: MutableRefObject<boolean>;
  windowFocusedRef: MutableRefObject<boolean>;
  paneVisibilityRef: MutableRefObject<TerminalPaneVisibility>;
  ptyResizeStateRef: MutableRefObject<PtyResizeState>;
  fitScheduleRef: MutableRefObject<{ raf: number | null; remainingFrames: number; retryFrames: number; deadline: number }>;
  resizeDebounceRef: MutableRefObject<number | null>;
  currentCwdRef: MutableRefObject<string>;
  contextRequestRef: MutableRefObject<number>;
  atPowerShellPromptRef: MutableRefObject<boolean>;
  setRestartToken: Dispatch<SetStateAction<number>>;
  setCurrentCwd: Dispatch<SetStateAction<string>>;
  setGitBranch: Dispatch<SetStateAction<string | null>>;
  scheduleFollowBottomRepair: (framePasses?: number) => void;
}

export function useTerminalPaneLayout({
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
}: TerminalPaneLayoutContext) {
  useEffect(() => {
    if (runtimeGeneration === null || !spawnedRef.current) return;
    if (
      terminalGenerationRef.current === runtimeGeneration &&
      terminalProcessIdRef.current === runtimeProcessId
    ) return;

    console.info("[terminal-lifecycle] runtime identity changed", {
      terminalId,
      previousGeneration: terminalGenerationRef.current,
      generation: runtimeGeneration,
      previousProcessId: terminalProcessIdRef.current,
      processId: runtimeProcessId,
    });
    const generationChanged = terminalGenerationRef.current !== runtimeGeneration;
    terminalGenerationRef.current = runtimeGeneration;
    terminalProcessIdRef.current = runtimeProcessId;
    outputProtocolRef.current.startRehydrate({
      workspaceId: terminalWorkspaceId,
      generation: runtimeGeneration,
      processId: runtimeProcessId,
    });
    if (generationChanged) {
      scrollPositionRef.current = { followsOutput: true, offsetFromBottom: 0 };
      autoScrollRef.current = true;
      cancelProgrammaticScroll(programmaticScrollGuardRef.current);
    }
    rehydratingRef.current = true;
    spawnedRef.current = false;
    setRestartToken((token) => token + 1);
  }, [runtimeGeneration, runtimeProcessId, terminalId, terminalWorkspaceId]);

  const scheduleFitAndResize = useCallback((waitFrames = 0) => {
    const schedule = fitScheduleRef.current;
    schedule.remainingFrames = Math.max(schedule.remainingFrames, waitFrames);
    schedule.retryFrames = Math.max(
      schedule.retryFrames,
      waitFrames > 0 ? MAX_LAYOUT_FIT_RETRY_FRAMES : 2,
    );
    // Explicit layout transitions keep a bounded settle window: the grid can
    // commit late in WebView2, so one failed fit must not leave the pane at
    // the pre-transition size until an unrelated event re-triggers it.
    if (waitFrames > 0) {
      schedule.deadline = Math.max(
        schedule.deadline,
        performance.now() + MAX_LAYOUT_SETTLE_MS,
      );
    }
    if (schedule.raf !== null) return;

    const run = () => {
      if (schedule.remainingFrames > 0) {
        schedule.remainingFrames -= 1;
        schedule.raf = requestAnimationFrame(run);
        return;
      }

      schedule.raf = null;
      // A failed or transient attempt keeps re-arming while the transition is
      // still inside its settle window; once the window expires it stops.
      const retryWhileSettling = () => {
        if (performance.now() < schedule.deadline) {
          schedule.remainingFrames = 1;
          schedule.raf = requestAnimationFrame(run);
        } else {
          schedule.deadline = 0;
        }
      };
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) {
        schedule.retryFrames = 0;
        return;
      }
      // Snapshot reset/history/state replay owns xterm's dimensions until its
      // atomic cutover. A fit here would reflow a half-restored buffer. The
      // completion path re-arms the schedule, and the settle window covers a
      // cutover that lands after the first attempt.
      if (rehydratingRef.current) {
        schedule.retryFrames = 0;
        retryWhileSettling();
        return;
      }
      if (
        paneVisibilityRef.current.focusModeActive &&
        !paneVisibilityRef.current.isFocused
      ) {
        schedule.retryFrames = 0;
        return;
      }
      if (document.visibilityState === "hidden") {
        // A hidden/minimized document has degenerate boxes; nothing to fit
        // until it becomes visible again. Visibility changes re-arm the fit.
        schedule.retryFrames = 0;
        retryWhileSettling();
        return;
      }
      let fitted = false;
      try {
        fitted = fitAndResizePty(
          term,
          fitAddon,
          terminalId,
          terminalGenerationRef.current === null || !terminalWorkspaceId
            ? null
            : {
                workspaceId: terminalWorkspaceId,
                generation: terminalGenerationRef.current,
                processId: terminalProcessIdRef.current,
              },
          autoScrollRef,
          scrollPositionRef,
          programmaticScrollGuardRef,
          ptyResizeStateRef,
          fitInProgressRef,
        );
      } catch (error) {
        // An unexpected measurement exception must not kill the fit loop;
        // re-arm inside the settle window and report the exact failure once
        // so the backend diagnostic log can pinpoint the root cause.
        reportFrontendDiagnostic("terminal-fit-error", error, {
          terminalId,
          workspaceId: terminalWorkspaceId,
          generation: terminalGenerationRef.current ?? undefined,
          processId: terminalProcessIdRef.current,
          state: "fit-callback",
        });
        retryWhileSettling();
        return;
      }
      if (!fitted && schedule.retryFrames > 0) {
        schedule.retryFrames -= 1;
        schedule.remainingFrames = 1;
        schedule.raf = requestAnimationFrame(run);
        return;
      }
      schedule.retryFrames = 0;
      if (!fitted) {
        // Frame retries are exhausted but the transition may still be
        // settling (late WebView2 commit, rehydrate cutover). Re-arm within
        // the settle window instead of staying at the stale size; report the
        // permanent failure once for the backend diagnostic log.
        retryWhileSettling();
        if (schedule.deadline === 0 && schedule.raf === null) {
          const layoutElement = term.element?.parentElement ?? term.element;
          const rect = layoutElement?.getBoundingClientRect();
          const proposed = fitAddon?.proposeDimensions();
          reportFrontendDiagnosticCode(
            "terminal-fit-unstable",
            "layout-settle-expired",
            {
              terminalId,
              workspaceId: terminalWorkspaceId,
              generation: terminalGenerationRef.current ?? undefined,
              processId: terminalProcessIdRef.current,
              state: [
                `doc=${document.visibilityState}`,
                rect ? `w=${Math.round(rect.width)}` : "w=none",
                rect ? `h=${Math.round(rect.height)}` : "h=none",
                proposed ? `cols=${proposed.cols}` : "cols=none",
                proposed ? `rows=${proposed.rows}` : "rows=none",
                term.element ? "dom=y" : "dom=n",
              ].join("_"),
            },
          );
        }
        return;
      }
      schedule.deadline = 0;
      if (scrollPositionRef.current.followsOutput) {
        scheduleFollowBottomRepair();
      }
    };

    schedule.raf = requestAnimationFrame(run);
  }, [scheduleFollowBottomRepair, terminalId, terminalWorkspaceId]);

  useEffect(() => {
    currentCwdRef.current = cwd;
    setCurrentCwd(cwd);
  }, [cwd]);

  const refreshTerminalContext = useCallback(async () => {
    const requestId = ++contextRequestRef.current;
    const runtime = currentRuntimeKey(terminalId);
    if (!runtime) return;
    try {
      const context = await invoke<TerminalContext>("terminal_get_context", {
        terminalId,
        ...runtime,
      });
      if (
        requestId !== contextRequestRef.current ||
        !sameRuntimeKey(currentRuntimeKey(terminalId), runtime)
      ) return;
      currentCwdRef.current = context.cwd;
      setCurrentCwd(context.cwd);
      setGitBranch(context.gitBranch);
    } catch (err) {
      console.error(`[branch] context refresh error for ${terminalId}:`, err);
    }
  }, [terminalId]);

  const syncContextFromPowerShellPrompt = useCallback(async (term: Terminal) => {
    const prompt = powerShellPrompt(term);
    if (!prompt) {
      atPowerShellPromptRef.current = false;
      return;
    }
    if (atPowerShellPromptRef.current) return;
    atPowerShellPromptRef.current = true;
    const requestId = ++contextRequestRef.current;
    const runtime = currentRuntimeKey(terminalId);
    if (!runtime) return;

    try {
      const context = sameWindowsPath(prompt.cwd, currentCwdRef.current)
        ? await invoke<TerminalContext>("terminal_get_context", {
            terminalId,
            ...runtime,
          })
        : await invoke<TerminalContext>("terminal_sync_cwd", {
            terminalId,
            ...runtime,
            cwd: prompt.cwd,
        });
      if (
        requestId !== contextRequestRef.current ||
        !sameRuntimeKey(currentRuntimeKey(terminalId), runtime)
      ) return;
      currentCwdRef.current = context.cwd;
      setCurrentCwd(context.cwd);
      setGitBranch(context.gitBranch);
    } catch (err) {
      console.debug(`[branch] prompt CWD sync ignored for ${terminalId}:`, err);
    }
  }, [terminalId, shell]);

  // 2b. Listen for CWD changes from backend (cd command detected) → refresh git branch.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let disposed = false;
    listen<TerminalCwdChangedPayload>("terminal-cwd-changed", (event) => {
      const payload = event.payload;
      if (
        payload.terminalId === terminalId &&
        sameRuntimeKey(currentRuntimeKey(terminalId), payload)
      ) {
        currentCwdRef.current = payload.cwd;
        setCurrentCwd(payload.cwd);
        console.log(`[branch] cwd-changed event for ${terminalId}, re-fetching`);
        void refreshTerminalContext();
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlistenFn = fn;
      }
    }).catch((error) => {
      reportFrontendDiagnostic("terminal-listener-error", error, {
        terminalId,
        workspaceId: terminalWorkspaceId,
        generation: terminalGenerationRef.current ?? undefined,
        processId: terminalProcessIdRef.current,
        state: "cwd-listener",
      });
      console.error("[terminal-lifecycle] CWD listener setup failed", error);
    });
    return () => {
      disposed = true;
      unlistenFn?.();
    };
  }, [terminalId, terminalWorkspaceId, refreshTerminalContext]);

  // 3. Active focus + backend active flag (skip heavy refresh when hidden in focus mode)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    // Hidden under another pane's focus mode — do not fit/resize to 0×0.
    if (focusModeActive && !isFocused) return;

    if (isActive || isFocused) {
      const focusFrame = requestAnimationFrame(() => {
        scheduleFitAndResize();
        if (isActive || isFocused) {
          term.focus();
          term.clearSelection();
        }
      });
      if (runtimeGeneration !== null && terminalWorkspaceId) {
        invoke("terminal_set_active", {
          terminalId,
          workspaceId: terminalWorkspaceId,
          generation: runtimeGeneration,
          processId: runtimeProcessId,
        }).catch((error) => {
          console.warn("[terminal-lifecycle] active PTY rejected", {
            terminalId,
            workspaceId: terminalWorkspaceId,
            generation: runtimeGeneration,
            processId: runtimeProcessId,
            error: String(error),
          });
        });
      }
      return () => cancelAnimationFrame(focusFrame);
    }
  }, [
    isActive,
    isFocused,
    focusModeActive,
    runtimeGeneration,
    runtimeProcessId,
    scheduleFitAndResize,
    terminalId,
    terminalWorkspaceId,
  ]);

  // 3b. Enter/exit focus mode — always re-fit the focused pane (or all when leaving)
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    const entered = isFocused && !wasFocusedRef.current;
    const exited = !isFocused && wasFocusedRef.current;
    wasFocusedRef.current = isFocused;

    if (!entered && !exited) return;
    // When exiting focus mode, every visible pane needs a fit; when entering,
    // only the focused pane is visible.
    if (focusModeActive && !isFocused) return;

    const term = xtermRef.current;
    if (!term) return;

    // Wait for layout after the grid CSS change. Calls from this effect,
    // active/focused state and ResizeObserver are coalesced per pane.
    scheduleFitAndResize(2);
    if (isFocused || isActive) term.focus();
  }, [isFocused, focusModeActive, isActive, terminalId, scheduleFitAndResize]);

  // When leaving global focus mode, non-focused panes become visible again → fit.
  const prevFocusModeRef = useRef(focusModeActive);
  useEffect(() => {
    const leftFocusMode = prevFocusModeRef.current && !focusModeActive;
    prevFocusModeRef.current = focusModeActive;
    if (!leftFocusMode) return;

    scheduleFitAndResize(2);
  }, [focusModeActive, terminalId, scheduleFitAndResize]);

  // Native tray hide/show and application switches can make xterm recalculate
  // its viewport while it has no usable layout. Re-fit and restore follow mode
  // after the window becomes interactive again.
  useEffect(() => {
    let disposed = false;
    let nativeFocusCheck = 0;
    const restoreFocusedLayout = () => {
      if (focusModeActive && !isFocused) return;
      scheduleFitAndResize(1);
      if (scrollPositionRef.current.followsOutput) {
        scheduleFollowBottomRepair(3);
      }
    };
    const refreshNativeFocus = async () => {
      const check = ++nativeFocusCheck;
      try {
        const focused = await getCurrentWebviewWindow().isFocused();
        if (disposed || check !== nativeFocusCheck) return;
        windowFocusedRef.current =
          focused && document.visibilityState !== "hidden";
      } catch {
        if (disposed || check !== nativeFocusCheck) return;
        // Browser preview has no native window API. WebView2 does, and is the
        // authoritative source because document.hasFocus() can be false while
        // xterm owns the focused element.
        windowFocusedRef.current =
          document.hasFocus() && document.visibilityState !== "hidden";
      }
      if (windowFocusedRef.current) restoreFocusedLayout();
    };
    const handleWindowBlur = () => {
      nativeFocusCheck += 1;
      windowFocusedRef.current = false;
    };
    const handleWindowFocus = () => {
      nativeFocusCheck += 1;
      windowFocusedRef.current = document.visibilityState !== "hidden";
      if (!windowFocusedRef.current) return;
      restoreFocusedLayout();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        nativeFocusCheck += 1;
        windowFocusedRef.current = false;
      } else {
        void refreshNativeFocus();
      }
    };

    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void refreshNativeFocus();
    return () => {
      disposed = true;
      nativeFocusCheck += 1;
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    focusModeActive,
    isFocused,
    scheduleFitAndResize,
    scheduleFollowBottomRepair,
  ]);

  useEffect(() => {
    let guardWarningShown = false;
    // An observer callback must never kill the resize pipeline: any exception
    // is reported once to the backend diagnostic log and the fit is re-armed
    // anyway, so a maximize/restore still converges on the final layout.
    const reportGuardError = (error: unknown, state: string) => {
      if (guardWarningShown) return;
      guardWarningShown = true;
      reportFrontendDiagnostic("terminal-resize-guard-error", error, {
        terminalId,
        workspaceId: terminalWorkspaceId,
        generation: terminalGenerationRef.current ?? undefined,
        processId: terminalProcessIdRef.current,
        state,
      });
    };
    const handleResize = () => {
      try {
        if (focusModeActive && !isFocused) return;
        if (resizeDebounceRef.current !== null) {
          window.clearTimeout(resizeDebounceRef.current);
        }
        resizeDebounceRef.current = window.setTimeout(() => {
          resizeDebounceRef.current = null;
          scheduleFitAndResize(2);
        }, 150);
      } catch (error) {
        reportGuardError(error, "resize-observer-callback");
        // Even when the debounce path broke, the fit must still be armed:
        // the rAF loop is its own throttle and the settle window bounds it.
        scheduleFitAndResize(2);
      }
    };

    const container = containerRef.current;
    if (!container) return;

    // Grid track changes (close, sidebar resize, focus/fullscreen) can settle
    // after the first paint. A bounded two-frame barrier avoids fitting the
    // transient width while still guaranteeing a later correction.
    if (!(focusModeActive && !isFocused)) {
      scheduleFitAndResize(2);
    }

    const observer = new ResizeObserver(() => {
      if (focusModeActive && !isFocused) return;
      handleResize();
    });
    // Observe the xterm box, its pane, the grid cell and the grid itself. The
    // cell is the element whose track changes on close/fullscreen; watching
    // only the xterm child misses that transition in WebView2.
    let observed: HTMLElement | null = container;
    for (let level = 0; observed && level < 5; level += 1) {
      observer.observe(observed);
      observed = observed.parentElement;
    }

    // Window maximize/restore and live drags are the primary growth triggers
    // on Windows and ResizeObserver can miss the WebView2 transition, so the
    // window resize event arms the fit directly. No debounce here: the rAF
    // loop inside scheduleFitAndResize is its own throttle and the pending
    // PTY resize queue coalesces bursts, so a maximize or a drag tracks the
    // container almost frame-by-frame instead of waiting for the 150ms
    // observer debounce to expire.
    const onWindowResize = () => {
      if (focusModeActive && !isFocused) return;
      scheduleFitAndResize(0);
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      window.removeEventListener("resize", onWindowResize);
      observer.disconnect();
    };
  }, [terminalId, terminalCount, layoutRevision, focusModeActive, isFocused, scheduleFitAndResize]);
  return { scheduleFitAndResize, refreshTerminalContext, syncContextFromPowerShellPrompt };
}
