import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, type ExpoSpeechRecognitionResultEvent } from 'expo-speech-recognition';
import { PocketCall, type PocketCallModule } from '../modules/pocket-call';
import { endpointDelay, type CaptureMode, type EngineEvent, type EngineInfo, type EngineStartOptions, type SpeechEngine } from './voice';

type Listener = (event: EngineEvent) => void;

/** The iOS engine (modules/pocket-call): CallKit, echo cancellation, recognition only while someone talks. */
class NativeSpeechEngine implements SpeechEngine {
  private ended = false;

  constructor(private readonly native: PocketCallModule) {}

  async start(options: EngineStartOptions): Promise<EngineInfo> {
    const allowed = await this.native.requestPermissions();
    if (!allowed.microphone) throw new Error('Microphone access is off: iPhone Settings → Pocket → Microphone.');
    if (!allowed.speech) throw new Error('Speech recognition is off: iPhone Settings → Pocket → Speech Recognition.');
    // Hung up during the permission prompt: starting now would leave the microphone on with nobody listening.
    if (this.ended) throw new Error('The call has ended.');
    const info = await this.native.start({
      language: options.language,
      voice: options.voice,
      // AVSpeechUtterance rate: 0.5 is the normal pace, a touch faster suits a conversation.
      rate: 0.52,
      callerName: options.callerName,
      speaker: options.speaker,
      useCallKit: options.useCallKit,
      onDevice: true,
      silenceMs: options.silenceMs,
      holdWords: options.holdWords,
      contextualStrings: options.contextualStrings,
    });
    return { echoCancellation: info.echoCancellation, callKit: info.callKit, voiceName: info.voiceName, voiceQuality: info.voiceQuality };
  }

  end(): void {
    this.ended = true;
    this.native.end();
  }

  setMode(mode: CaptureMode): void {
    this.native.setMode(mode);
  }

  cancelCapture(): void {
    this.native.cancelCapture();
  }

  speak(id: string, text: string): void {
    this.native.speak(id, text);
  }

  stopSpeaking(): void {
    this.native.stopSpeaking();
  }

  setThinking(on: boolean): void {
    this.native.setThinking(on);
  }

  setMuted(muted: boolean): void {
    this.native.setMuted(muted);
  }

  setSpeaker(on: boolean): void {
    this.native.setSpeaker(on);
  }

  subscribe(listener: Listener): () => void {
    const sub = this.native.addListener('onCallEvent', listener);
    return () => sub.remove();
  }
}

/**
 * Android, and iPhone builds without the native module: the system recognizer and voice. No echo cancellation, so
 * the microphone is off while the phone talks, and no system call UI.
 */
export class JsSpeechEngine implements SpeechEngine {
  private readonly listeners = new Set<Listener>();
  private subs: { remove: () => void }[] = [];
  private options: EngineStartOptions | null = null;
  private voice: string | undefined;
  private mode: CaptureMode = 'off';
  private recognizing = false;
  private heard = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private muted = false;
  private ended = false;
  /** Sessions that ended right after starting in a row; restarting them at once spins the CPU. */
  private quickEnds = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private queue: { id: string; text: string }[] = [];
  private speaking: string | null = null;

  async start(options: EngineStartOptions): Promise<EngineInfo> {
    this.options = options;
    const allowed = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!allowed.granted) throw new Error('Microphone or speech recognition was not allowed.');
    this.subs.push(
      ExpoSpeechRecognitionModule.addListener('result', (e: ExpoSpeechRecognitionResultEvent) => this.onResult(e)),
      ExpoSpeechRecognitionModule.addListener('error', (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        this.lastError = e.message || e.error;
        if (this.quickEnds === 0) this.emit({ type: 'recognitionError', code: e.error, message: e.message || e.error });
      }),
      ExpoSpeechRecognitionModule.addListener('end', () => {
        // The platform ends sessions on its own (iOS after about a minute): keep listening. A session that ends
        // right away means the recognizer cannot run; back off instead of restarting in a tight loop.
        this.recognizing = false;
        this.emit({ type: 'capture', active: false });
        const quick = Date.now() - this.startedAt < 1500;
        this.quickEnds = quick ? this.quickEnds + 1 : 0;
        if (this.quickEnds === 4) {
          this.emit({
            type: 'error',
            code: 'recognition',
            message: `Speech recognition keeps stopping${this.lastError ? `: ${this.lastError}` : ''}. Check Settings → Pocket → Speech Recognition and Microphone.`,
            fatal: false,
          });
        }
        const delay = quick ? Math.min(250 * 2 ** this.quickEnds, 8000) : 0;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.update();
        }, delay);
      }),
      ExpoSpeechRecognitionModule.addListener('speechstart', () => this.emit({ type: 'vad', speaking: true })),
      ExpoSpeechRecognitionModule.addListener('speechend', () => this.emit({ type: 'vad', speaking: false })),
    );
    const voice = await pickVoice(options.language, options.voice);
    this.voice = voice?.identifier;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
    this.emit({ type: 'state', state: 'active' });
    return {
      echoCancellation: false,
      callKit: false,
      voiceName: voice?.name ?? null,
      voiceQuality: voice ? (voice.quality === Speech.VoiceQuality.Enhanced ? 'enhanced' : 'default') : null,
    };
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.abort();
    this.queue = [];
    this.speaking = null;
    void Speech.stop();
    for (const sub of this.subs) sub.remove();
    this.subs = [];
    void setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false }).catch(() => {});
    this.emit({ type: 'state', state: 'ended', reason: 'local' });
    this.listeners.clear();
  }

  setMode(mode: CaptureMode): void {
    this.mode = mode;
    this.update();
  }

  cancelCapture(): void {
    this.abort();
  }

  speak(id: string, text: string): void {
    if (this.ended) return;
    this.queue.push({ id, text });
    if (this.speaking === null) this.next();
  }

  stopSpeaking(): void {
    const id = this.speaking;
    this.queue = [];
    this.speaking = null;
    void Speech.stop();
    if (id) this.emit({ type: 'speechEnd', id, interrupted: true });
    this.emit({ type: 'speechIdle' });
    this.update();
  }

  setThinking(): void {}

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.emit({ type: 'muted', muted });
    this.update();
  }

  setSpeaker(): void {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The recognizer runs only when the call listens and the phone is silent. */
  private update(): void {
    const want = this.mode === 'listen' && !this.muted && !this.ended && this.speaking === null;
    if (want && !this.recognizing) this.listen();
    else if (!want && this.recognizing) this.abort();
  }

  private listen(): void {
    if (!this.options) return;
    this.recognizing = true;
    this.startedAt = Date.now();
    this.heard = '';
    try {
      ExpoSpeechRecognitionModule.start({
        lang: this.options.language,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        contextualStrings: this.options.contextualStrings,
        iosTaskHint: 'dictation',
        iosCategory: { category: 'playAndRecord', categoryOptions: ['defaultToSpeaker', 'allowBluetooth'], mode: 'voiceChat' },
      });
      this.emit({ type: 'capture', active: true });
    } catch (e) {
      this.recognizing = false;
      this.emit({ type: 'error', code: 'recognition', message: e instanceof Error ? e.message : String(e), fatal: false });
    }
  }

  private abort(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.recognizing) return;
    this.recognizing = false;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {}
  }

  private onResult(e: ExpoSpeechRecognitionResultEvent): void {
    if (!this.recognizing || this.ended || !this.options) return;
    const text = e.results[0]?.transcript?.trim() ?? '';
    if (!text) return;
    this.heard = text;
    this.emit({ type: 'partial', text });
    if (this.timer) clearTimeout(this.timer);
    // Both platforms keep sending interim results; a pause with nothing new ends the utterance.
    const wait = e.isFinal ? 150 : endpointDelay(text, this.options.silenceMs, this.options.holdWords);
    this.timer = setTimeout(() => this.commit(), wait);
  }

  private commit(): void {
    this.timer = null;
    const text = this.heard;
    this.heard = '';
    this.abort();
    if (text) this.emit({ type: 'final', text });
    this.update();
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.speaking = null;
      this.emit({ type: 'speechIdle' });
      this.update();
      return;
    }
    this.speaking = item.id;
    // Without echo cancellation the recognizer would hear the phone.
    this.update();
    this.emit({ type: 'speechStart', id: item.id });
    const done = (interrupted: boolean) => {
      if (this.speaking !== item.id) return;
      this.emit({ type: 'speechEnd', id: item.id, interrupted });
      this.speaking = null;
      this.next();
    };
    Speech.speak(item.text, {
      language: this.options?.language,
      ...(this.voice ? { voice: this.voice } : {}),
      // expo-speech multiplies this by the platform's normal rate: 1 is normal speed.
      rate: 1,
      onDone: () => done(false),
      onStopped: () => done(true),
      onError: () => done(false),
    });
  }
}

/** The best installed voice for the language (an enhanced one when there is), or the one picked in Settings. */
async function pickVoice(language: string, chosen: string | null): Promise<Speech.Voice | undefined> {
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    if (chosen) {
      const picked = voices.find((v) => v.identifier === chosen);
      if (picked) return picked;
    }
    const prefix = language.slice(0, 2).toLowerCase();
    const score = (v: Speech.Voice) => (v.quality === Speech.VoiceQuality.Enhanced ? 2 : 0) + (v.language.toLowerCase() === language.toLowerCase() ? 1 : 0);
    return voices.filter((v) => v.language.toLowerCase().startsWith(prefix)).sort((a, b) => score(b) - score(a))[0];
  } catch {
    return undefined;
  }
}

export function createSpeechEngine(): SpeechEngine {
  return PocketCall ? new NativeSpeechEngine(PocketCall) : new JsSpeechEngine();
}

/** True when calls use the native iOS engine (system call UI, talking over the phone). */
export const nativeCalls = PocketCall !== null;

export interface VoiceOption {
  identifier: string;
  name: string;
  quality: 'default' | 'enhanced' | 'premium';
}

/** Installed voices for a language, best first. */
export async function listVoices(language: string): Promise<VoiceOption[]> {
  if (PocketCall) return PocketCall.getVoices(language);
  const prefix = language.slice(0, 2).toLowerCase();
  const voices = await Speech.getAvailableVoicesAsync().catch(() => [] as Speech.Voice[]);
  return voices
    .filter((v) => v.language.toLowerCase().startsWith(prefix))
    .map((v) => ({ identifier: v.identifier, name: v.name, quality: v.quality === Speech.VoiceQuality.Enhanced ? ('enhanced' as const) : ('default' as const) }))
    .sort((a, b) => (a.quality === b.quality ? 0 : a.quality === 'enhanced' ? -1 : 1));
}

/** The phone's preferred languages, most preferred first. */
export function preferredLanguages(): string[] {
  if (PocketCall) return PocketCall.preferredLanguages();
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return [];
  }
}
