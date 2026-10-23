import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../src/voice';

const listeners: Record<string, (e: unknown) => void> = {};
const recognition = {
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  addListener: vi.fn((name: string, fn: (e: unknown) => void) => {
    listeners[name] = fn;
    return { remove: () => delete listeners[name] };
  }),
  requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
};
const speech = {
  speak: vi.fn(),
  stop: vi.fn(async () => {}),
  getAvailableVoicesAsync: vi.fn(async () => [
    { identifier: 'en-voice', name: 'Samantha', quality: 'Enhanced', language: 'en-US' },
    { identifier: 'ru-compact', name: 'Milena', quality: 'Default', language: 'ru-RU' },
    { identifier: 'ru-enhanced', name: 'Milena (Enhanced)', quality: 'Enhanced', language: 'ru-RU' },
  ]),
  VoiceQuality: { Default: 'Default', Enhanced: 'Enhanced' },
};

vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: recognition }));
vi.mock('expo-speech', () => speech);
vi.mock('expo-audio', () => ({ setAudioModeAsync: vi.fn(async () => {}) }));
vi.mock('../modules/pocket-call', () => ({ PocketCall: null }));

const { JsSpeechEngine, createSpeechEngine } = await import('../src/speech-engine');

const OPTIONS = { language: 'ru-RU', voice: null, callerName: 'Lipton', speaker: true, useCallKit: true, silenceMs: 500, holdWords: ['и'], contextualStrings: [] };

describe('JsSpeechEngine (Android and iPhones without the native engine)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('is used when the native module is missing', () => {
    expect(createSpeechEngine()).toBeInstanceOf(JsSpeechEngine);
  });

  it('ends an utterance on a pause, longer after "и"', async () => {
    const engine = new JsSpeechEngine();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const info = await engine.start(OPTIONS);
    expect(info).toMatchObject({ echoCancellation: false, callKit: false, voiceName: 'Milena (Enhanced)', voiceQuality: 'enhanced' });

    engine.setMode('listen');
    expect(recognition.start).toHaveBeenCalledWith(expect.objectContaining({ lang: 'ru-RU', continuous: true, interimResults: true }));
    listeners.result!({ isFinal: false, results: [{ transcript: 'открой' }] });
    listeners.result!({ isFinal: false, results: [{ transcript: 'открой браузер и' }] });
    vi.advanceTimersByTime(1100);
    expect(events.filter((e) => e.type === 'final')).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === 'final')).toEqual([{ type: 'final', text: 'открой браузер и' }]);
    expect(recognition.abort).toHaveBeenCalled();
    // Still listening: the next utterance starts right away.
    expect(recognition.start).toHaveBeenCalledTimes(2);
  });

  it('turns the microphone off while it talks, at the normal rate, with the best voice', async () => {
    const engine = new JsSpeechEngine();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start(OPTIONS);
    engine.setMode('listen');
    recognition.abort.mockClear();
    recognition.start.mockClear();

    engine.speak('s1', 'Привет.');
    engine.speak('s2', 'Как дела?');
    expect(recognition.abort).toHaveBeenCalledTimes(1);
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(speech.speak).toHaveBeenCalledWith('Привет.', expect.objectContaining({ rate: 1, voice: 'ru-enhanced', language: 'ru-RU' }));

    (speech.speak.mock.calls[0]![1] as { onDone: () => void }).onDone();
    expect(speech.speak).toHaveBeenLastCalledWith('Как дела?', expect.anything());
    expect(recognition.start).not.toHaveBeenCalled();
    (speech.speak.mock.calls[1]![1] as { onDone: () => void }).onDone();
    expect(events.filter((e) => e.type.startsWith('speech')).map((e) => e.type)).toEqual(['speechStart', 'speechEnd', 'speechStart', 'speechEnd', 'speechIdle']);
    expect(recognition.start).toHaveBeenCalledTimes(1);
  });

  it('stops talking at once and reports the cut sentence', async () => {
    const engine = new JsSpeechEngine();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start(OPTIONS);
    engine.speak('s1', 'Длинный ответ.');
    engine.speak('s2', 'Ещё одно.');
    engine.stopSpeaking();
    expect(speech.stop).toHaveBeenCalled();
    expect(events.slice(-2)).toEqual([
      { type: 'speechEnd', id: 's1', interrupted: true },
      { type: 'speechIdle' },
    ]);
    // A late onStopped from the platform changes nothing.
    (speech.speak.mock.calls[0]![1] as { onStopped: () => void }).onStopped();
    expect(speech.speak).toHaveBeenCalledTimes(1);
  });
});

describe('createSpeechEngine', () => {
  it('uses the native iOS engine when the app was built with it', async () => {
    vi.resetModules();
    const native = {
      requestPermissions: vi.fn(async () => ({ speech: true, microphone: true })),
      start: vi.fn(async () => ({ echoCancellation: true, callKit: true, onDevice: true, voice: 'v', voiceName: 'Milena', voiceQuality: 'enhanced' })),
      addListener: vi.fn(() => ({ remove: () => {} })),
    };
    vi.doMock('../modules/pocket-call', () => ({ PocketCall: native }));
    const { createSpeechEngine: create, nativeCalls } = await import('../src/speech-engine');
    expect(nativeCalls).toBe(true);
    const info = await create().start(OPTIONS);
    expect(info).toEqual({ echoCancellation: true, callKit: true, voiceName: 'Milena', voiceQuality: 'enhanced' });
    // A normal speaking pace (0.5 is AVSpeechUtterance's default), not the old half speed.
    expect(native.start).toHaveBeenCalledWith(expect.objectContaining({ language: 'ru-RU', rate: 0.52, useCallKit: true }));
  });

  it('does not start the native call when it was hung up during the permission prompt', async () => {
    vi.resetModules();
    let allow: (value: { speech: boolean; microphone: boolean }) => void = () => {};
    const native = {
      requestPermissions: vi.fn(() => new Promise<{ speech: boolean; microphone: boolean }>((resolve) => (allow = resolve))),
      start: vi.fn(),
      end: vi.fn(),
      addListener: vi.fn(() => ({ remove: () => {} })),
    };
    vi.doMock('../modules/pocket-call', () => ({ PocketCall: native }));
    const { createSpeechEngine: create } = await import('../src/speech-engine');
    const engine = create();
    const starting = engine.start(OPTIONS);
    engine.end();
    allow({ speech: true, microphone: true });
    await expect(starting).rejects.toThrow('ended');
    expect(native.start).not.toHaveBeenCalled();
    expect(native.end).toHaveBeenCalledTimes(1);
  });

  it('explains how to allow the microphone when it is off', async () => {
    vi.resetModules();
    vi.doMock('../modules/pocket-call', () => ({
      PocketCall: { requestPermissions: vi.fn(async () => ({ speech: true, microphone: false })), addListener: vi.fn() },
    }));
    const { createSpeechEngine: create } = await import('../src/speech-engine');
    await expect(create().start(OPTIONS)).rejects.toThrow('Microphone access is off');
  });
});
