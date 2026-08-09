import { invoke } from "@tauri-apps/api/core";

let diagnosticIpcWarningShown = false;

export interface FrontendDiagnosticContext {
  source?: string;
  line?: number;
  column?: number;
  terminalId?: string;
  workspaceId?: string;
  generation?: number;
  processId?: number | null;
  requestId?: string;
  state?: string;
}

function safeCode(error: unknown): string {
  const text = String(error).toLowerCase();
  for (const code of [
    "stale-terminal-workspace",
    "stale-terminal-generation",
    "stale-terminal-process",
    "terminal-output-gap",
    "terminal-exited",
    "timeout",
  ]) {
    if (text.includes(code)) return code;
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(error.name)) {
    return error.name;
  }
  return "unknown-error";
}

export function reportFrontendDiagnostic(
  kind: string,
  error: unknown,
  context: FrontendDiagnosticContext = {},
): void {
  reportFrontendDiagnosticCode(kind, safeCode(error), context);
}

export function reportFrontendDiagnosticCode(
  kind: string,
  code: string,
  context: FrontendDiagnosticContext = {},
): void {
  void invoke("report_frontend_diagnostic", {
    event: {
      kind,
      code,
      ...context,
      processId: context.processId ?? null,
    },
  }).catch(() => {
    // Avoid recursively reporting a logger failure, but keep one visible clue
    // in DevTools instead of swallowing the diagnostics outage silently.
    if (!diagnosticIpcWarningShown) {
      diagnosticIpcWarningShown = true;
      console.warn("[diagnostics] persistent frontend logger unavailable");
    }
  });
}

function sourceName(filename: string): string | undefined {
  if (!filename) return undefined;
  const normalized = filename.replace(/\\/g, "/");
  return normalized.split("/").pop()?.slice(0, 128);
}

export function installFrontendCrashDiagnostics(): () => void {
  const handleError = (event: ErrorEvent) => {
    reportFrontendDiagnostic("frontend-error", event.error, {
      source: sourceName(event.filename),
      line: event.lineno || undefined,
      column: event.colno || undefined,
      // The code alone ("TypeError") cannot pinpoint the failing property;
      // the message ("Cannot read properties of null (reading 'x')") can.
      state: (event.error instanceof Error
        ? event.error.message
        : String(event.error)
      ).slice(0, 128),
    });
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    reportFrontendDiagnostic("unhandled-rejection", event.reason);
  };
  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
  };
}
