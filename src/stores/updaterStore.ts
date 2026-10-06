import { isTauri } from "@tauri-apps/api/core";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { invokeWithTimeout } from "../lib/timeout";

const CHECK_TIMEOUT_MS = 10_000;
const CHECK_IPC_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_IPC_TIMEOUT_MS = 16 * 60_000;

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "error"
  | "installing";

export type CheckResult = "available" | "up-to-date" | "error" | "busy" | "unavailable";

export interface UpdaterProgress {
  downloaded: number;
  total: number | null;
  finished: boolean;
}

interface UpdaterStore {
  status: UpdaterStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  releaseNotes: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  dismissed: boolean;
  progress: UpdaterProgress;
  installError: boolean;
  checkForUpdates: (manual?: boolean) => Promise<CheckResult>;
  dismiss: () => void;
  reopen: () => void;
  install: () => Promise<void>;
}

let activeUpdate: Update | null = null;
let checkingInFlight: Promise<CheckResult> | null = null;

function applyDownloadEvent(event: DownloadEvent) {
  if (event.event === "Started") {
    useUpdaterStore.setState({
      progress: {
        downloaded: 0,
        total: event.data.contentLength ?? null,
        finished: false,
      },
    });
    return;
  }
  if (event.event === "Progress") {
    const current = useUpdaterStore.getState().progress;
    useUpdaterStore.setState({
      progress: {
        ...current,
        downloaded: current.downloaded + event.data.chunkLength,
      },
    });
    return;
  }
  const current = useUpdaterStore.getState().progress;
  useUpdaterStore.setState({ progress: { ...current, finished: true } });
}

async function closeActiveUpdate() {
  const pending = activeUpdate;
  activeUpdate = null;
  if (pending) {
    try {
      await pending.close();
    } catch {
      // best-effort: the handle is going away anyway.
    }
  }
}

export const useUpdaterStore = create<UpdaterStore>()((set, get) => ({
  status: "idle",
  currentVersion: null,
  latestVersion: null,
  releaseNotes: null,
  lastCheckedAt: null,
  lastError: null,
  dismissed: false,
  progress: { downloaded: 0, total: null, finished: false },
  installError: false,

  checkForUpdates: async (manual = false) => {
    const state = get();
    if (state.status === "checking" || state.status === "installing") {
      return "busy";
    }
    if (checkingInFlight) return checkingInFlight;

    // Fuori dall'app desktop (browser/dev) non c'è un updater reale.
    if (import.meta.env.DEV || !isTauri()) {
      if (manual) {
        set({
          status: "error",
          lastError: "desktop-only",
          lastCheckedAt: new Date().toISOString(),
        });
      }
      return "unavailable";
    }

    set({
      status: "checking",
      lastError: null,
      installError: false,
      dismissed: manual ? false : get().dismissed,
    });

    const run = (async (): Promise<CheckResult> => {
      try {
        const candidate = await invokeWithTimeout(
          () => check({ timeout: CHECK_TIMEOUT_MS }),
          CHECK_IPC_TIMEOUT_MS,
        );
        if (!candidate) {
          await closeActiveUpdate();
          set({
            status: "up-to-date",
            currentVersion: null,
            latestVersion: null,
            releaseNotes: null,
            lastCheckedAt: new Date().toISOString(),
            dismissed: false,
          });
          return "up-to-date";
        }
        activeUpdate = candidate;
        set({
          status: "available",
          currentVersion: candidate.currentVersion,
          latestVersion: candidate.version,
          releaseNotes: candidate.body?.trim() ? candidate.body.trim() : null,
          lastCheckedAt: new Date().toISOString(),
          dismissed: false,
          progress: { downloaded: 0, total: null, finished: false },
        });
        return "available";
      } catch (error) {
        await closeActiveUpdate();
        set({
          status: "error",
          lastError:
            error instanceof Error ? error.message : "Controllo non riuscito",
          lastCheckedAt: new Date().toISOString(),
        });
        return "error";
      } finally {
        checkingInFlight = null;
      }
    })();

    checkingInFlight = run;
    return run;
  },

  dismiss: () => {
    void closeActiveUpdate();
    set({ dismissed: true });
  },

  reopen: () => {
    if (get().status === "available") set({ dismissed: false });
  },

  install: async () => {
    const pending = activeUpdate;
    if (!pending || get().status === "installing") return;
    set({
      status: "installing",
      installError: false,
      progress: { downloaded: 0, total: null, finished: false },
    });
    try {
      await invokeWithTimeout(
        () =>
          pending.downloadAndInstall(
            (event) => applyDownloadEvent(event),
            { timeout: DOWNLOAD_TIMEOUT_MS, restartAfterInstall: true },
          ),
        INSTALL_IPC_TIMEOUT_MS,
      );
      // Se andato a buon fine l'app si riavvia; non serve altro stato.
    } catch {
      set({ status: "available", installError: true });
    }
  },
}));

export function isDesktopUpdaterAvailable(): boolean {
  return !import.meta.env.DEV && isTauri();
}
