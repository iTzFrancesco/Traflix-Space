import type { CSSProperties } from "react";
import { Terminal } from "xterm";
import { AGENTS } from "../../lib/agents";
import { findCurrentPowerShellPrompt } from "../../lib/powerShellPrompt";

/** Map agent id to a short display name for the title bar. */
export function agentDisplayName(agentId: string): string {
  const found = AGENTS.find((agent) => agent.id === agentId);
  return found?.name ?? agentId;
}

/** Extract project/folder name from a CWD path. */
export function projectNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export const STOCK_THEME = {
  background: "#111211",
  foreground: "#f5f3ef",
  cursor: "#ff9d24",
  cursorAccent: "#111211",
  selectionBackground: "rgba(255, 157, 36, 0.25)",
  selectionInactiveBackground: "rgba(255, 157, 36, 0.12)",
  black: "#111211",
  red: "#ff626b",
  green: "#55d89b",
  yellow: "#ffae42",
  blue: "#ff9d24",
  magenta: "#ff6b21",
  cyan: "#29b8db",
  white: "#f5f3ef",
  brightBlack: "#74716c",
  brightRed: "#ff626b",
  brightGreen: "#55d89b",
  brightYellow: "#ffae42",
  brightBlue: "#ff9d24",
  brightMagenta: "#ff6b21",
  brightCyan: "#29b8db",
  brightWhite: "#f5f3ef",
};

export interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  terminalCount: number;
  layoutRevision: string;
  isActive: boolean;
  isFocused?: boolean;
  focusModeActive?: boolean;
  closeRequestToken?: number;
  onActivate: (id: string) => void;
  onClose?: (id: string) => void;
  onToggleFocus?: (id: string) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
}

export const ACTIVE_STYLE: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid var(--color-primary)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow: "0 4px 20px rgba(255, 157, 36, 0.04)",
};

export const FOCUSED_STYLE: CSSProperties = {
  ...ACTIVE_STYLE,
  border: "1px solid var(--color-primary-strong)",
  boxShadow: "0 4px 20px rgba(255, 107, 33, 0.05)",
};

export const INACTIVE_STYLE: CSSProperties = {
  ...ACTIVE_STYLE,
  border: "1px solid var(--color-neutral-border)",
  cursor: "pointer",
  boxShadow: undefined,
};

export const EXITED_STYLE: CSSProperties = {
  ...ACTIVE_STYLE,
  border: "1px solid rgba(255, 98, 107, 0.25)",
  boxShadow: undefined,
};

export const CONTAINER_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  width: "100%",
  background: "var(--color-neutral-bg)",
  overflow: "hidden",
};

export const TITLE_BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "rgba(255, 255, 255, 0.015)",
  borderBottom: "1px solid var(--color-neutral-border)",
  userSelect: "none",
  overflow: "hidden",
};

export function getTitleBarMetrics(terminalCount: number) {
  if (terminalCount <= 1) {
    return { height: 42, padding: "0 14px", fontSize: 13, buttonSize: 32, iconSize: 16, dotSize: 10 };
  }
  if (terminalCount === 2) {
    return { height: 40, padding: "0 12px", fontSize: 12, buttonSize: 32, iconSize: 15, dotSize: 9 };
  }
  if (terminalCount <= 4) {
    return { height: 38, padding: "0 10px", fontSize: 12, buttonSize: 32, iconSize: 14, dotSize: 8 };
  }
  return { height: 36, padding: "0 9px", fontSize: 12, buttonSize: 30, iconSize: 14, dotSize: 7 };
}

/** Return the latest complete PowerShell prompt, including wrapped paths. */
export function powerShellPrompt(term: Terminal) {
  const buffer = term.buffer.active;
  const lastLine = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
  let firstLine = Math.max(0, lastLine - 16);
  while (firstLine > 0 && buffer.getLine(firstLine)?.isWrapped) firstLine--;

  const lines: Array<{ text: string; isWrapped: boolean }> = [];
  for (let lineIndex = firstLine; lineIndex <= lastLine; lineIndex++) {
    const line = buffer.getLine(lineIndex);
    if (!line) continue;
    const nextLine = buffer.getLine(lineIndex + 1);
    lines.push({
      text: line.translateToString(!nextLine?.isWrapped),
      isWrapped: line.isWrapped,
    });
  }
  return findCurrentPowerShellPrompt(lines);
}

export function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/^\\\\[?.]\\/, "").replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

export function isPowerShell(shell: string): boolean {
  const executable = shell.replace(/\\/g, "/").split("/").pop() ?? shell;
  return /^(?:powershell|pwsh)(?:\.exe)?$/i.test(executable);
}

export interface TerminalContext {
  cwd: string;
  gitBranch: string | null;
}

export interface TerminalCwdChangedPayload {
  terminalId: string;
  workspaceId: string;
  generation: number;
  processId: number | null;
  cwd: string;
}

export const TITLE_BAR_LEFT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  minWidth: 0,
  flex: 1,
};

export const TITLE_BAR_DOT: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
};

export const TITLE_BAR_NAME: CSSProperties = {
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  color: "rgba(255,255,255,0.8)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "text",
  lineHeight: 1,
  minWidth: 0,
  letterSpacing: "0.02em",
};

export const TITLE_BAR_RENAME_INPUT: CSSProperties = {
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  color: "rgba(255,255,255,0.9)",
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 4,
  padding: "1px 4px",
  outline: "none",
  lineHeight: 1,
  width: "100%",
  minWidth: 0,
};

export const MAX_LAYOUT_FIT_RETRY_FRAMES = 5;
export const MAX_LAYOUT_SETTLE_MS = 1500;

export const TITLE_BAR_BRANCH: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "rgba(255,255,255,0.45)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 180,
  flexShrink: 0,
};

export const TITLE_BAR_RIGHT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
  marginLeft: "auto",
  paddingLeft: 8,
};

export const TOOL_BTN_BASE: CSSProperties = {
  width: "30px",
  height: "30px",
  borderRadius: "8px",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
  transition: "background 0.15s ease, color 0.15s ease",
  padding: 0,
};
