import type { TtsVoice, VoiceErrorView, VoiceInputDevice } from "./types";

export function sanitizedVoiceError(error: unknown): string {
  const raw = error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : error instanceof Error
      ? error.message
      : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|gsk|api[_-]?key)[A-Za-z0-9._-]{8,}\b/gi, "[redacted]")
    .slice(0, 240);
}

export function sanitizedVoiceErrorView(
  error: unknown,
  fallbackCode: string,
): VoiceErrorView {
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : fallbackCode;
  const code = /^[a-z0-9_.-]{1,64}$/i.test(rawCode) ? rawCode : fallbackCode;
  return { code, message: sanitizedVoiceError(error) };
}

export function isVoiceConfigurationError(message: string | null): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes("groq_api_key")
    || normalized.includes("provider non configur")
    || normalized.includes("consenso privacy")
    || normalized.includes("voice_provider_not_configured");
}

export function italianVoices(voices: TtsVoice[]): TtsVoice[] {
  return voices.filter((voice) => voice.locale.toLowerCase().startsWith("it-"));
}

export function inputDeviceOptions(devices: VoiceInputDevice[]): Array<{ id: string; label: string }> {
  return devices.map((device) => ({ id: device.id, label: `${device.name}${device.isDefault ? " (predefinito)" : ""}` }));
}
