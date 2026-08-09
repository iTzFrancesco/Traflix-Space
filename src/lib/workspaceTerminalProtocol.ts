export interface RuntimeTerminalWorkspace {
  workspaceId: string;
}

/**
 * Reject duplicate configured IDs and cross-workspace reuse before a load or
 * refresh mutates the terminal store. Terminal IDs are process-global keys.
 */
export function terminalIdentityCollision(
  workspaceId: string,
  configuredTerminalIds: readonly string[],
  runtimeById: Readonly<Record<string, RuntimeTerminalWorkspace | undefined>>,
): string | null {
  const seen = new Set<string>();
  for (const terminalId of configuredTerminalIds) {
    if (!terminalId || seen.has(terminalId)) return terminalId || "<empty>";
    seen.add(terminalId);
    const runtime = runtimeById[terminalId];
    if (runtime && runtime.workspaceId !== workspaceId) return terminalId;
  }
  return null;
}

/** A delayed workspace load must not replace a newer event-driven refresh. */
export function acceptsWorkspaceRevision(
  currentUpdatedAt: string | null | undefined,
  incomingUpdatedAt: string,
): boolean {
  if (!currentUpdatedAt) return true;
  if (currentUpdatedAt === incomingUpdatedAt) return true;
  const currentTime = revisionNanoseconds(currentUpdatedAt);
  const incomingTime = revisionNanoseconds(incomingUpdatedAt);
  if (currentTime !== null && incomingTime !== null) {
    return incomingTime >= currentTime;
  }
  // Registry revisions are server-generated ISO timestamps. If a legacy
  // value cannot be parsed, accept the fresh backend response so it migrates.
  return true;
}

function revisionNanoseconds(value: string): bigint | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = value.match(/\.(\d{1,9})(?=Z|[+-]\d{2}:\d{2}$)/)?.[1] ?? "";
  // Date.parse already accounts for the first three fractional digits. Keep
  // the remaining six so backend nanosecond CAS tokens retain their order.
  const subMillisecond = fraction.slice(3, 9).padEnd(6, "0");
  return BigInt(milliseconds) * 1_000_000n + BigInt(subMillisecond || "0");
}
