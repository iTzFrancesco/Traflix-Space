export interface TerminalBufferLine {
  text: string;
  isWrapped: boolean;
}

export interface PowerShellPrompt {
  cwd: string;
}

/** Reads a complete PowerShell prompt only when it is the current logical row. */
export function findCurrentPowerShellPrompt(
  lines: TerminalBufferLine[],
): PowerShellPrompt | null {
  let logicalText = "";

  for (const line of lines) {
    logicalText = line.isWrapped ? logicalText + line.text : line.text;
  }

  const match = logicalText.trim().match(/^PS\s+(.+)>$/i);
  return match?.[1] ? { cwd: match[1].trim() } : null;
}
