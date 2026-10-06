import { useEffect, useState } from "react";
import { ArrowRight, Download, RefreshCw, X } from "lucide-react";
import { useUpdaterStore } from "../../stores/updaterStore";

const RELEASE_NOTES_LIMIT = 1_600;

export function UpdateNotice() {
  const status = useUpdaterStore((s) => s.status);
  const currentVersion = useUpdaterStore((s) => s.currentVersion);
  const latestVersion = useUpdaterStore((s) => s.latestVersion);
  const releaseNotes = useUpdaterStore((s) => s.releaseNotes);
  const dismissed = useUpdaterStore((s) => s.dismissed);
  const progress = useUpdaterStore((s) => s.progress);
  const installError = useUpdaterStore((s) => s.installError);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const dismiss = useUpdaterStore((s) => s.dismiss);
  const install = useUpdaterStore((s) => s.install);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    void checkForUpdates(false);
    // Solo controllo automatico all'avvio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status !== "available" && status !== "installing") return null;
  if (dismissed) return null;
  if (!latestVersion) return null;

  const installing = status === "installing";
  const notes = releaseNotes?.trim();
  const hasMoreNotes = (notes?.length ?? 0) > RELEASE_NOTES_LIMIT;
  const visibleNotes = notesOpen
    ? notes?.slice(0, RELEASE_NOTES_LIMIT)
    : notes?.slice(0, 220);
  const progressPercent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <aside
      aria-label="Aggiornamento disponibile"
      className="tab-slide-in fixed left-1/2 top-12 z-[101] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2"
    >
      <section className="overflow-hidden rounded-xl border border-primary/25 bg-neutral-elevated/95 shadow-[0_20px_60px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.04)_inset] backdrop-blur-md">
        {/* Barra di accento superiore */}
        <div className="h-[3px] w-full bg-gradient-to-r from-primary-strong via-primary to-primary-light" />

        <div className="px-4 pb-4 pt-3.5">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-gradient-to-br from-primary/25 to-primary/5 text-primary">
              <Download size={17} aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[13px] font-bold leading-tight text-neutral-text">
                    Nuova versione disponibile
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {currentVersion && (
                      <span className="rounded-md border border-neutral-border bg-neutral-darkest px-1.5 py-0.5 font-mono text-[10px] text-neutral-text-muted">
                        v{currentVersion}
                      </span>
                    )}
                    <ArrowRight
                      size={12}
                      className="text-primary"
                      aria-hidden="true"
                    />
                    <span className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary">
                      v{latestVersion}
                    </span>
                  </div>
                </div>
                {!installing && (
                  <button
                    type="button"
                    onClick={dismiss}
                    title="Chiudi"
                    aria-label="Chiudi avviso aggiornamento"
                    className="ui-icon-button h-7 w-7 shrink-0"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {visibleNotes && (
                <div className="mt-2.5 rounded-lg border border-neutral-border-light bg-neutral-darkest/60 px-2.5 py-2">
                  <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-text-dim">
                    {visibleNotes}
                    {!notesOpen && (notes?.length ?? 0) > 220 ? "…" : ""}
                    {notesOpen && hasMoreNotes ? "…" : ""}
                  </p>
                  {(notes?.length ?? 0) > 220 && (
                    <button
                      type="button"
                      onClick={() => setNotesOpen((v) => !v)}
                      className="mt-1 text-[11px] font-semibold text-primary hover:text-primary-light"
                    >
                      {notesOpen ? "Mostra meno" : "Note di rilascio"}
                    </button>
                  )}
                </div>
              )}

              {installing && (
                <div className="mt-2.5" aria-live="polite">
                  <div className="flex items-center justify-between gap-3 text-[11px] text-neutral-text-dim">
                    <span className="flex items-center gap-1.5">
                      <RefreshCw
                        size={12}
                        className="animate-spin text-primary"
                        aria-hidden="true"
                      />
                      {progress.finished
                        ? "Avvio installazione…"
                        : "Download aggiornamento…"}
                    </span>
                    <span className="font-mono text-neutral-text">
                      {progressPercent !== null
                        ? `${progressPercent}%`
                        : formatBytes(progress.downloaded)}
                    </span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-darkest"
                    role="progressbar"
                    aria-label="Download aggiornamento"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPercent ?? 0}
                  >
                    <div
                      className={`h-full rounded-full bg-gradient-to-r from-primary-strong to-primary-light transition-[width] duration-150 ${
                        progressPercent === null
                          ? "w-1/3 animate-pulse"
                          : ""
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
                  className="mt-2.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] text-danger"
                >
                  Installazione non riuscita. Controlla la connessione e
                  riprova.
                </p>
              )}

              <div className="mt-3 flex items-center justify-end gap-2">
                {!installing && (
                  <button
                    type="button"
                    onClick={dismiss}
                    className="secondary-button min-h-[32px] text-[12px]"
                  >
                    Più tardi
                  </button>
                )}
                <button
                  type="button"
                  disabled={installing}
                  onClick={() => void install()}
                  className="primary-button min-h-[32px] text-[12px]"
                >
                  <RefreshCw
                    size={13}
                    className={installing ? "animate-spin" : ""}
                    aria-hidden="true"
                  />
                  {installing ? "Aggiornamento…" : "Installa e riavvia"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </aside>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
