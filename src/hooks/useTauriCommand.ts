import { invoke } from "@tauri-apps/api/core";

export function useTauriCommand() {
  async function run<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(cmd, args);
  }

  return { run };
}
