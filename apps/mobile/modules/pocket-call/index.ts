import { NativeModule, requireOptionalNativeModule } from 'expo';

/** Events of a native call; mirrors `EngineEvent` in src/voice.ts. */
export type NativeCallEvent =
  | { type: 'state'; state: 'connecting' | 'active' | 'held' | 'ended'; reason?: string }
  | { type: 'vad'; speaking: boolean }
  | { type: 'capture'; active: boolean }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'recognitionError'; code: string; message: string }
  | { type: 'speechStart'; id: string }
  | { type: 'speechEnd'; id: string; interrupted: boolean }
  | { type: 'speechIdle' }
  | { type: 'muted'; muted: boolean }
  | { type: 'route'; output: string }
  | { type: 'error'; code: string; message: string; fatal: boolean }
  | { type: 'log'; message: string };

export interface PowerState {
  thermalState: 'nominal' | 'fair' | 'serious' | 'critical';
  lowPower: boolean;
}

export type VoiceQuality = 'default' | 'enhanced' | 'premium';

export interface NativeVoice {
  identifier: string;
  name: string;
  language: string;
  quality: VoiceQuality;
}

export interface NativeCallOptions {
  language: string;
  voice: string | null;
  /** AVSpeechUtterance rate, 0…1; 0.5 is the normal pace. */
  rate: number;
  callerName: string;
  speaker: boolean;
  useCallKit: boolean;
  onDevice: boolean;
  silenceMs: number;
  holdWords: string[];
  contextualStrings: string[];
}

export interface NativeCallInfo {
  echoCancellation: boolean;
  callKit: boolean;
  onDevice: boolean;
  voice: string | null;
  voiceName: string | null;
  voiceQuality: VoiceQuality | null;
}

type PocketCallEvents = {
  onCallEvent: (event: NativeCallEvent) => void;
  onPowerChange: (state: PowerState) => void;
};

declare class PocketCallModule extends NativeModule<PocketCallEvents> {
  requestPermissions(): Promise<{ speech: boolean; microphone: boolean }>;
  start(options: NativeCallOptions): Promise<NativeCallInfo>;
  end(): void;
  setMode(mode: 'off' | 'listen' | 'watch'): void;
  cancelCapture(): void;
  finishUtterance(): void;
  speak(id: string, text: string): void;
  stopSpeaking(): void;
  setThinking(on: boolean): void;
  setMuted(muted: boolean): void;
  setSpeaker(on: boolean): void;
  getVoices(language: string): Promise<NativeVoice[]>;
  getPowerState(): PowerState;
  preferredLanguages(): string[];
  /** Languages of the keyboards added on the phone (UITextInputMode), e.g. ru-RU. */
  keyboardLanguages(): Promise<string[]>;
}

export type { PocketCallModule };

/** The iOS call engine (modules/pocket-call/ios); null on Android, on the web and in builds made before it existed. */
export const PocketCall = requireOptionalNativeModule<PocketCallModule>('PocketCall');
