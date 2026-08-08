export interface VoicePress {
  generation: number;
  released: boolean;
}

export function beginVoicePress(current: VoicePress | null, generation: number): VoicePress | null {
  return current ? null : { generation, released: false };
}

export function releaseVoicePress(press: VoicePress | null): VoicePress | null {
  return press ? { ...press, released: true } : null;
}

export function shouldStopAfterAsyncStart(press: VoicePress): boolean {
  return press.released;
}
