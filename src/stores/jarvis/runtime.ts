import { invoke } from "@tauri-apps/api/core";

const CODEX_STREAM_BINDING_GRACE_MS = 1_000;
export const VOICE_LEVEL_UI_MIN_INTERVAL_MS = 100;

let codexChatStreamBindingReady: Promise<void> = Promise.resolve();
let codexChatStreamAvailable = false;

export function waitForCodexChatStreamBinding(): Promise<void> {
  return Promise.race([
    codexChatStreamBindingReady,
    new Promise<void>((resolve) => setTimeout(resolve, CODEX_STREAM_BINDING_GRACE_MS)),
  ]);
}

export function setCodexChatStreamBindingReady(binding: Promise<void>): void {
  codexChatStreamBindingReady = binding;
}

export function setCodexChatStreamAvailable(available: boolean): void {
  codexChatStreamAvailable = available;
}

export function isCodexChatStreamAvailable(): boolean {
  return codexChatStreamAvailable;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return error instanceof Error ? error.message : String(error);
}

export function voiceLog(message: string, details: Record<string, unknown> = {}): void {
  console.info("[Jarvis voice]", message, details);
}

export function voiceWarn(message: string, details: Record<string, unknown> = {}): void {
  console.warn("[Jarvis voice]", message, details);
}

export function mergeActions<T extends { id: string; createdAt: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((action) => [action.id, action]));
  for (const action of incoming) byId.set(action.id, action);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function codexErrorMessage(message: string): string {
  const code = message.split(": ")[0];
  switch (code) {
    case "codex_not_installed":
      return "Codex CLI non installato: installa il pacchetto npm `@openai/codex` e riavvia.";
    case "codex_runtime_start_failed":
      return "Impossibile avviare il runtime Codex (handshake fallito).";
    case "codex_runtime_crashed":
      return "Il runtime Codex non è in esecuzione (riavvialo dalla sezione Codex).";
    default:
      return message;
  }
}

export async function openCodexAuthUrl(authUrl: string): Promise<void> {
  await invoke("browser_create");
  await invoke("browser_navigate", { url: authUrl });
}
