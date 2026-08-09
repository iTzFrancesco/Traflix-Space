import { invoke } from "@tauri-apps/api/core";

const encoder = new TextEncoder();

/** Encode UTF-8 text to number[] for terminal_write IPC (reuses TextEncoder). */
export function encodeForPty(text: string): number[] {
  const bytes = encoder.encode(text);
  const out = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}

export function writeToPty(
  terminalId: string,
  workspaceId: string,
  generation: number,
  processId: number | null,
  text: string,
): Promise<void> {
  return invoke("terminal_write", {
    terminalId,
    workspaceId,
    generation,
    processId,
    data: encodeForPty(text),
  });
}

export function writeBytesToPty(
  terminalId: string,
  workspaceId: string,
  generation: number,
  processId: number | null,
  data: number[] | Uint8Array,
): Promise<void> {
  const arr =
    data instanceof Uint8Array
      ? Array.from(data)
      : data;
  return invoke("terminal_write", {
    terminalId,
    workspaceId,
    generation,
    processId,
    data: arr,
  });
}
