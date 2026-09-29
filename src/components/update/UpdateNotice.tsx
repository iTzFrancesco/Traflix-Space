import { isTauri } from "@tauri-apps/api/core";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { Download, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invokeWithTimeout } from "../../lib/timeout";

const CHECK_TIMEOUT_MS = 10_000;
const CHECK_IPC_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_IPC_TIMEOUT_MS = 16 * 60_000;
const RELEASE_NOTES_LIMIT = 1_600;

interface DownloadProgress {
  downloaded: number;
  total: number | null;
  finished: boolean;
}

export function UpdateNotice() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress>({
    downloaded: 0,
    total: null,
    finished: false,
  });
  const updateRef = useRef<Update | null>(null);
  const installingRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.DEV || !isTauri()) return;

    let disposed = false;
    void invokeWithTimeout(
      () => check({ timeout: CHECK_TIMEOUT_MS }),
      CHECK_IPC_TIMEOUT_MS,
    )
      .then(async (candidate) => {
        if (!candidate) return;
        if (disposed) {
          await candidate.close();
          return;
        }
        updateRef.current = candidate;
        setUpdate(candidate);
      })
      .catch(() => {
        // Update checks are best-effort. Offline starts should stay quiet.
      });

    return () => {
      disposed = true;
      const pending = updateRef.current;
      if (pending && !installingRef.current) {
        updateRef.current = null;
        void pending.close().catch(() => undefined);
      }
    };
  }, []);

  const dismiss = () => {
    const pending = updateRef.current;
    updateRef.current = null;
    setUpdate(null);
    if (pending) void pending.close().catch(() => undefined);
  };

  const install = async () => {
    const pending = updateRef.current;
    if (!pending || installingRef.current) return;

    installingRef.current = true;
    setInstalling(true);
    setInstallError(false);
    setProgress({ downloaded: 0, total: null, finished: false });

    try {
      await invokeWithTimeout(
        () =>
          pending.downloadAndInstall(
            (event) => onDownloadEvent(event, setProgress),
            {
              timeout: DOWNLOAD_TIMEOUT_MS,
              restartAfterInstall: true,
            },
          ),
        INSTALL_IPC_TIMEOUT_MS,
      );
    } catch {
      installingRef.current = false;
      setInstalling(false);
      setInstallError(true);
    }
  };

  if (!update) return null;

  const releaseNotes = update.body?.trim();
  const hasMoreReleaseNotes = (releaseNotes?.length ?? 0) > RELEASE_NOTES_LIMIT;
  const visibleReleaseNotes = releaseNotes?.slice(0, RELEASE_NOTES_LIMIT);
  const progressPercent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <aside className="fixed right-4 top-14 z-[101] w-[min(420px,calc(100vw-2rem))]">
      <section
        aria-label="Aggiornamento disponibile"
        className="overflow-hidden rounded-lg border border-primary/30 bg-neutral-elevated shadow-[0_12px_36px_rgba(0,0,0,0.36)]"
      >
        <header className="flex items-start gap-3 px-4 pb-3 pt-4">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
            <Download size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-neutral-text">
              Aggiornamento disponibile
            </p>
            <p className="mt-1 text-xs text-neutral-text-muted">
              {update.currentVersion} → {update.version}
            </p>
          </div>
        </header>

        {visibleReleaseNotes && (
          <p className="mx-4 max-h-28 overflow-y-auto whitespace-pre-wrap border-t border-neutral-border py-3 text-xs leading-relaxed text-neutral-text-muted">
            {visibleReleaseNotes}
            {hasMoreReleaseNotes ? "…" : ""}
          </p>
        )}

        {installing && (
          <div className="mx-4 border-t border-neutral-border py-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-xs text-neutral-text-muted">
              <span>
                {progress.finished
                  ? "Avvio installazione…"
                  : "Download aggiornamento…"}
              </span>
              <span>
                {progressPercent !== null
                  ? `${progressPercent}%`
                  : formatBytes(progress.downloaded)}
              </span>
            </div>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-darkest"
              role="progressbar"
              aria-label="Download aggiornamento"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent ?? 0}
            >
              <div
                className={`h-full rounded-full bg-primary transition-[width] duration-150 ${
                  progressPercent === null ? "w-1/3 animate-pulse" : ""
                }`}
                style={
                  progressPercent === null
                    ? undefined
                    : { width: `${progressPercent}%` }
                }
              />
            </div>
          </div>
        )}

        {installError && (
          <p
            role="alert"
            className="mx-4 border-t border-neutral-border py-3 text-xs text-danger"
          >
            Installazione non riuscita. Controlla la connessione e riprova.
          </p>
        )}

        <footer className="flex justify-end gap-2 border-t border-neutral-border px-4 py-3">
          {!installing && (
            <button type="button" onClick={dismiss} className="secondary-button">
              Più tardi
            </button>
          )}
          <button
            type="button"
            disabled={installing}
            onClick={() => void install()}
            className="primary-button"
          >
            <RotateCw
              size={14}
              className={installing ? "animate-spin" : ""}
              aria-hidden="true"
            />
            {installing ? "Aggiornamento…" : "Installa e riavvia"}
          </button>
        </footer>
      </section>
    </aside>
  );
}

function onDownloadEvent(
  event: DownloadEvent,
  setProgress: (progress: (current: DownloadProgress) => DownloadProgress) => void,
) {
  if (event.event === "Started") {
    setProgress(() => ({
      downloaded: 0,
      total: event.data.contentLength ?? null,
      finished: false,
    }));
    return;
  }

  if (event.event === "Progress") {
    setProgress((current) => ({
      ...current,
      downloaded: current.downloaded + event.data.chunkLength,
    }));
    return;
  }

  setProgress((current) => ({ ...current, finished: true }));
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
