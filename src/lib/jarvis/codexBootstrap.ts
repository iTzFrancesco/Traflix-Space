export type CodexBootstrapTask = () => Promise<boolean | void>;

export type CodexBootstrapResult =
  | { status: "skipped" }
  | { status: "ready" }
  | { status: "error"; error: string };

export interface CodexBootstrapOptions {
  enabled: boolean;
  startRuntime: CodexBootstrapTask;
  loadAccount: CodexBootstrapTask;
  loadModels: CodexBootstrapTask;
  loadUsage: CodexBootstrapTask;
  loadRateLimits: CodexBootstrapTask;
}

/**
 * Coalesces concurrent bootstrap requests while retaining a refresh request
 * that arrives during an active run (for example, account/login completion).
 * The queued request is executed immediately after the current run settles.
 */
export function createCodexBootstrapQueue(
  run: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued = false;

  return () => {
    if (inFlight) {
      queued = true;
      return inFlight;
    }

    const execute = async () => {
      let failed = false;
      let failure: unknown;
      do {
        queued = false;
        failed = false;
        failure = undefined;
        try {
          await run();
        } catch (error) {
          failed = true;
          failure = error;
        }
      } while (queued);

      if (failed) throw failure;
    };

    const request = execute();
    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Starts the Codex runtime before reading any App Server-backed data.
 *
 * Account is read first because usage and rate limits are authenticated
 * session data. The remaining tasks are settled independently so one
 * optional statistic cannot prevent the other status data from displaying.
 * The returned result lets the store expose a useful error state while each
 * task remains responsible for preserving its last successful snapshot.
 */
export async function bootstrapCodexData(
  options: CodexBootstrapOptions,
): Promise<CodexBootstrapResult> {
  if (!options.enabled) return { status: "skipped" };

  try {
    if ((await options.startRuntime()) === false) {
      return { status: "error", error: "Codex runtime non disponibile" };
    }
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }

  let accountResult: boolean | void;
  try {
    accountResult = await options.loadAccount();
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
  if (accountResult === false) {
    return { status: "error", error: "Codex account non disponibile" };
  }

  const tasks: Array<[string, CodexBootstrapTask]> = [
    ["models", options.loadModels],
    ["usage", options.loadUsage],
    ["rate limits", options.loadRateLimits],
  ];
  const results = await Promise.allSettled(
    tasks.map(async ([name, task]) => {
      if ((await task()) === false) {
        throw new Error(`Codex ${name} non disponibile`);
      }
    }),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  return failure
    ? { status: "error", error: errorMessage(failure.reason) }
    : { status: "ready" };
}
