import type { TtsVoice, VoiceInputDevice } from "./types";

export function italianVoices(voices: TtsVoice[]): TtsVoice[] {
  return voices.filter((voice) => voice.locale.toLowerCase().startsWith("it-"));
}

export function inputDeviceOptions(devices: VoiceInputDevice[]): Array<{ id: string; label: string }> {
  return devices.map((device) => ({ id: device.id, label: `${device.name}${device.isDefault ? " (predefinito)" : ""}` }));
}
