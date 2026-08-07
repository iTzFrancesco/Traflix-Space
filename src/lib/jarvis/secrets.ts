import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "../timeout";

const SECRET_TIMEOUT_MS = 15_000;

export type JarvisSecretId = "open_code_zen" | "groq";

export interface JarvisSecretStatus {
  openCodeZenConfigured: boolean;
  groqConfigured: boolean;
  persistent: boolean;
}

export function jarvisSecretStatus(): Promise<JarvisSecretStatus> {
  return invokeWithTimeout(
    () => invoke<JarvisSecretStatus>("jarvis_secret_status"),
    SECRET_TIMEOUT_MS,
  );
}

export function jarvisSetSecret(secret: JarvisSecretId, value: string): Promise<JarvisSecretStatus> {
  return invokeWithTimeout(
    () => invoke<JarvisSecretStatus>("jarvis_set_secret", { secret, value }),
    SECRET_TIMEOUT_MS,
  );
}

export function jarvisClearSecret(secret: JarvisSecretId): Promise<JarvisSecretStatus> {
  return invokeWithTimeout(
    () => invoke<JarvisSecretStatus>("jarvis_clear_secret", { secret }),
    SECRET_TIMEOUT_MS,
  );
}
