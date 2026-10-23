import type { ChatItem, PermissionRequest } from '@pocket/client-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callLanguage,
  completeSentences,
  endpointDelay,
  holdWords,
  isBargeIn,
  isStopRequest,
  oralPart,
  parseYesNo,
  permissionQuestion,
  resolveCallLanguage,
  speakable,
  VoiceCall,
  type CallSnapshot,
  type CaptureMode,
  type EngineEvent,
  type EngineInfo,
  type EngineStartOptions,
  type SpeechEngine,
} from '../src/voice';

describe('voice helpers', () => {
  it('strips markdown and code from what is read aloud', () => {
    expect(speakable('**Done.** Run `npm test`:\n```sh\nnpm test\n```\n- one\n- two\nSee [docs](https://x.y).')).toBe('Done. Run npm test:\none\ntwo\nSee docs.');
    expect(speakable('Here it is:\n```sh\nstill streaming')).toBe('Here it is:');
  });

  it('never reads paths or links', () => {
    expect(speakable('Открой `src/app.ts` и C:\\Users\\me\\x.txt, потом /usr/local/bin.')).toBe('Открой и, потом.');
    expect(speakable('Запусти `npm test`, 23/10 и и/или остаются.')).toBe('Запусти npm test, 23/10 и и/или остаются.');
  });

  it('keeps for the chat what follows code, tables, headings, rules and lists of more than two items', () => {
    expect(oralPart('Да.\n```sh\nls\n```\nЕщё.')).toEqual({ oral: 'Да.', cut: true, code: 'sh' });
    expect(oralPart('Два шага:\n- один\n- два\nВсё.')).toEqual({ oral: 'Два шага:\n- один\n- два\nВсё.', cut: false, code: null });
    expect(oralPart('Шаги:\n1. один\n2. два\n3. три')).toEqual({ oral: 'Шаги:', cut: true, code: null });
    expect(oralPart('Коротко: да.\n---\nПодробности.')).toEqual({ oral: 'Коротко: да.', cut: true, code: null });
    expect(oralPart('Итог.\n## Детали\nтекст')).toEqual({ oral: 'Итог.', cut: true, code: null });
    expect(oralPart('Вот так.\nплан | цена\n---|---\nA | 1')).toEqual({ oral: 'Вот так.', cut: true, code: null });
  });

  it('reads only complete sentences while streaming', () => {
    expect(completeSentences('Готово. Я вижу терминал! А ещё')).toEqual({ done: ['Готово.', 'Я вижу терминал!'], rest: 'А ещё' });
    expect(completeSentences('no end yet')).toEqual({ done: [], rest: 'no end yet' });
  });

  it('picks a recognizer language with a region', () => {
    expect(callLanguage('ru-RU')).toBe('ru-RU');
    expect(callLanguage('ru')).toBe('ru-RU');
    expect(callLanguage('ru_KZ')).toBe('ru-RU');
    expect(callLanguage('en-GB')).toBe('en-GB');
    expect(callLanguage('en')).toBe('en-US');
    expect(callLanguage('uk')).toBe('uk-UA');
    expect(callLanguage('zh-Hans-CN')).toBe('zh-CN');
    expect(callLanguage(undefined)).toBe('en-US');
    expect(resolveCallLanguage('auto', ['ru-US', 'en-US'])).toBe('ru-RU');
    expect(resolveCallLanguage('en-US', ['ru-RU'])).toBe('en-US');
  });

  it('waits longer after "и" and less after a full stop before ending an utterance', () => {
    const hold = holdWords('ru');
    expect(endpointDelay('открой браузер', 1100, hold)).toBe(1100);
    expect(endpointDelay('открой браузер.', 1100, hold)).toBe(700);
    expect(endpointDelay('открой браузер и', 1100, hold)).toBe(1800);
    expect(endpointDelay('Сделай так, чтобы', 1100, hold)).toBe(1800);
  });

  it('tells the user cutting in from the phone hearing itself', () => {
    expect(isBargeIn('вижу терминал', 'Я вижу терминал с ошибкой.')).toBe(false);
    expect(isBargeIn('нет открой браузер', 'Я вижу терминал с ошибкой.')).toBe(true);
    expect(isBargeIn('стоп', 'Я вижу терминал с ошибкой.')).toBe(true);
    expect(isBargeIn('ага', 'Я вижу терминал с ошибкой.')).toBe(false);
    expect(isStopRequest('Стоп!')).toBe(true);
    expect(isStopRequest('стоп, открой браузер')).toBe(false);
  });

  it('understands yes and no', () => {
    expect(parseYesNo('Да, давай')).toBe('yes');
    expect(parseYesNo('конечно')).toBe('yes');
    expect(parseYesNo('нет')).toBe('no');
    expect(parseYesNo('не надо')).toBe('no');
    expect(parseYesNo("don't do it")).toBe('no');
    expect(parseYesNo('а что это')).toBe(null);
  });

  it('asks for a permission in words', () => {
    expect(permissionQuestion('Bash', { command: 'npm test' }, 'ru')).toBe('Нужно разрешение: Bash, npm test. Разрешить?');
    expect(permissionQuestion('mcp__pocket__pc_clipboard_write', {}, 'en')).toBe('Claude needs permission: pc clipboard write. Allow it?');
  });
});

/** Records what the call asks of the engine and lets a test play the engine's side. */
class FakeEngine implements SpeechEngine {
  info: EngineInfo = { echoCancellation: true, callKit: true, voiceName: 'Milena', voiceQuality: 'enhanced' };
  options: EngineStartOptions | null = null;
  modes: CaptureMode[] = [];
  queue: { id: string; text: string }[] = [];
  texts: string[] = [];
  thinking: boolean[] = [];
  muted: boolean[] = [];
  stopped = 0;
  cancelled = 0;
  ended = false;
  private readonly listeners = new Set<(e: EngineEvent) => void>();

  async start(options: EngineStartOptions): Promise<EngineInfo> {
    this.options = options;
    return this.info;
  }
  end(): void {
    this.ended = true;
  }
  setMode(mode: CaptureMode): void {
    this.modes.push(mode);
  }
  cancelCapture(): void {
    this.cancelled++;
  }
  speak(id: string, text: string): void {
    this.queue.push({ id, text });
    this.texts.push(text);
  }
  stopSpeaking(): void {
    this.stopped++;
    this.queue = [];
  }
  setThinking(on: boolean): void {
    this.thinking.push(on);
  }
  setMuted(muted: boolean): void {
    this.muted.push(muted);
  }
  setSpeaker(): void {}
  subscribe(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get mode(): CaptureMode | undefined {
    return this.modes.at(-1);
  }
  emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  /** Starts the first queued sentence. */
  begin(): void {
    const first = this.queue[0];
    if (first) this.emit({ type: 'speechStart', id: first.id });
  }
  /** Reads everything queued to the end. */
  finishSpeaking(): void {
    for (const s of this.queue.splice(0)) {
      this.emit({ type: 'speechStart', id: s.id });
      this.emit({ type: 'speechEnd', id: s.id, interrupted: false });
    }
    this.emit({ type: 'speechIdle' });
  }
}

let n = 0;
const user = (text: string): ChatItem => ({ type: 'user', key: `u${++n}`, text, from: 'phone', voice: true });
const reply = (key: string, text: string, streaming = false): ChatItem => ({ type: 'assistant', key, text, streaming });
const result = (): ChatItem => ({ type: 'result', key: `r${++n}` });
const tool = (): ChatItem => ({ type: 'tool', key: `t${++n}`, id: `t${n}`, name: 'mcp__pocket__pc_screenshot', input: {}, output: '' });

function setup(initialThread: ChatItem[] = [], info?: Partial<EngineInfo>) {
  const engine = new FakeEngine();
  Object.assign(engine.info, info);
  const sent: string[] = [];
  const decisions: [string, string][] = [];
  const snaps: CallSnapshot[] = [];
  let online = true;
  const call = new VoiceCall({
    engine,
    send: (text) => {
      if (!online) return false;
      sent.push(text);
      return true;
    },
    respondPermission: (requestId, decision) => (decisions.push([requestId, decision]), true),
    onChange: (s) => snaps.push(s),
    language: 'ru-RU',
    callerName: 'Lipton',
    initialThread,
  });
  return { engine, call, sent, decisions, snaps, setOnline: (v: boolean) => (online = v) };
}

describe('VoiceCall', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never reads what was in the chat before, reads the reply as it streams and listens again only when the turn ends', async () => {
    const history = [user('старое'), reply('old', 'Старый ответ.')];
    const { engine, call, sent } = setup(history);
    await call.start();
    expect(engine.options).toMatchObject({ language: 'ru-RU', callerName: 'Lipton', useCallKit: true });
    expect(engine.mode).toBe('listen');
    expect(call.snapshot().phase).toBe('listening');

    engine.emit({ type: 'partial', text: 'сделай' });
    expect(call.snapshot().heard).toBe('сделай');
    engine.emit({ type: 'final', text: 'сделай скриншот' });
    expect(sent).toEqual(['сделай скриншот']);
    expect(call.snapshot().phase).toBe('thinking');
    vi.advanceTimersByTime(1000);
    expect(engine.thinking).toEqual([true]);

    const asked = user('сделай скриншот');
    call.onThread([...history, asked, reply('a1', 'Сейчас посмотрю. Делаю', true)], 'running');
    expect(engine.texts).toEqual(['Сейчас посмотрю.']);
    expect(engine.thinking).toEqual([true, false]);
    engine.begin();
    expect(call.snapshot()).toMatchObject({ phase: 'speaking', said: 'Сейчас посмотрю.' });
    // Echo cancellation: the user may talk over the phone.
    expect(engine.mode).toBe('watch');

    const step = [...history, asked, reply('a1', 'Сейчас посмотрю. Делаю скриншот.'), tool()];
    call.onThread(step, 'running');
    expect(engine.texts).toEqual(['Сейчас посмотрю.', 'Делаю скриншот.']);
    engine.finishSpeaking();
    // A tool runs: still Claude's turn, so no listening for a new question yet.
    expect(call.snapshot().phase).toBe('thinking');

    call.onThread([...step, reply('a2', 'Вижу терминал с ошибкой.'), result()], 'idle');
    expect(engine.texts.at(-1)).toBe('Вижу терминал с ошибкой.');
    engine.finishSpeaking();
    expect(call.snapshot().phase).toBe('listening');
    expect(engine.mode).toBe('listen');
    expect(engine.texts).not.toContain('Старый ответ.');
  });

  it('stops talking when the user cuts in, skips the rest of that reply and answers the new question', async () => {
    const { engine, call, sent } = setup();
    await call.start();
    engine.emit({ type: 'final', text: 'расскажи про проект' });
    const first = user('расскажи про проект');
    call.onThread([first, reply('a1', 'Первое предложение. Второе предложение. Третье', true)], 'running');
    engine.begin();
    expect(call.snapshot().phase).toBe('speaking');

    // The phone hearing itself through the echo canceller is not a question.
    engine.emit({ type: 'partial', text: 'первое предложение' });
    expect(engine.stopped).toBe(0);
    engine.emit({ type: 'vad', speaking: false });
    expect(engine.cancelled).toBe(1);

    engine.emit({ type: 'partial', text: 'подожди открой браузер' });
    expect(engine.stopped).toBe(1);
    expect(call.snapshot().phase).toBe('listening');
    expect(engine.mode).toBe('listen');

    // More of the old reply streams in: not read.
    const old = reply('a1', 'Первое предложение. Второе предложение. Третье предложение. Четвёртое.', false);
    call.onThread([first, old, result()], 'idle');
    expect(engine.texts).toEqual(['Первое предложение.', 'Второе предложение.']);

    engine.emit({ type: 'final', text: 'подожди открой браузер' });
    expect(sent).toEqual(['расскажи про проект', 'подожди открой браузер']);
    call.onThread([first, old, result(), user('подожди открой браузер'), reply('a2', 'Открыл.'), result()], 'idle');
    expect(engine.texts.at(-1)).toBe('Открыл.');
  });

  it('treats a bare "стоп" as "be quiet", not as a message', async () => {
    const { engine, call, sent } = setup();
    await call.start();
    engine.emit({ type: 'final', text: 'привет' });
    call.onThread([user('привет'), reply('a1', 'Привет! Чем помочь?', true)], 'running');
    engine.begin();
    engine.emit({ type: 'final', text: 'Стоп' });
    expect(engine.stopped).toBe(1);
    expect(sent).toEqual(['привет']);
  });

  it('asks for a permission aloud and answers it with the user\'s "да"', async () => {
    const { engine, call, decisions } = setup();
    await call.start();
    const request: PermissionRequest = { requestId: 'p1', sessionId: 's1', tool: 'Bash', input: { command: 'npm test' }, expiresAt: 0 };
    call.onPermissions([request]);
    expect(engine.texts).toEqual(['Нужно разрешение: Bash, npm test. Разрешить?']);
    engine.finishSpeaking();
    expect(call.snapshot().phase).toBe('confirming');
    expect(engine.mode).toBe('listen');

    engine.emit({ type: 'final', text: 'а это что' });
    expect(engine.texts.at(-1)).toBe('Скажите «да» или «нет».');
    engine.finishSpeaking();
    engine.emit({ type: 'final', text: 'Да, давай' });
    expect(decisions).toEqual([['p1', 'allow']]);
    expect(engine.texts.at(-1)).toBe('Разрешил.');
    // The same prompt is not asked twice.
    call.onPermissions([request]);
    expect(engine.texts.filter((t) => t.startsWith('Нужно разрешение'))).toHaveLength(1);
  });

  it('does not read the history when it loads after the call started, nor again when it reloads', async () => {
    const { engine, call } = setup([]);
    await call.start();
    engine.emit({ type: 'final', text: 'что нового' });
    const loaded = [user('давно'), reply('h1', 'Давний ответ.'), result(), user('что нового'), reply('a1', 'Всё работает.'), result()];
    call.onThread(loaded, 'idle');
    expect(engine.texts).toEqual(['Всё работает.']);
    engine.finishSpeaking();
    // Reconnect: the same history with new keys.
    call.onThread(
      loaded.map((item) => ({ ...item, key: `${item.key}-again` })),
      'idle',
    );
    expect(engine.texts).toEqual(['Всё работает.']);
  });

  it('cuts a long spoken answer at about 40 seconds and points to the chat', async () => {
    const { engine, call } = setup();
    await call.start();
    engine.emit({ type: 'final', text: 'расскажи всё' });
    const sentence = `${'Очень длинное предложение про проект '.repeat(5).trim()}.`;
    call.onThread([user('расскажи всё'), reply('a1', Array.from({ length: 12 }, () => sentence).join(' ')), result()], 'idle');
    expect(engine.texts.at(-1)).toBe('Остальное — в чате.');
    expect(engine.texts.join(' ').length).toBeLessThan(600);
  });

  it('says the spoken answer and leaves the code to the chat', async () => {
    const { engine, call } = setup();
    await call.start();
    engine.emit({ type: 'final', text: 'дай скрипт' });
    const answer = 'Готово, скрипт в чате.\n```powershell\nGet-ChildItem C:\\Users\n```\nЗапусти его от администратора.';
    call.onThread([user('дай скрипт'), reply('a1', answer), result()], 'idle');
    expect(engine.texts).toEqual(['Готово, скрипт в чате.', 'Остальное — в чате.']);
  });

  it('stops at the code while the reply still streams, and reads nothing of that turn after it', async () => {
    const { engine, call } = setup();
    await call.start();
    engine.emit({ type: 'final', text: 'покажи' });
    const asked = user('покажи');
    call.onThread([asked, reply('a1', 'Сейчас покажу. Вот команда:\n```sh\nls -la', true)], 'running');
    expect(engine.texts).toEqual(['Сейчас покажу.', 'Вот команда:', 'Остальное — в чате.']);
    call.onThread([asked, reply('a1', 'Сейчас покажу. Вот команда:\n```sh\nls -la\n```\nОна покажет всё.'), tool(), reply('a2', 'Готово.'), result()], 'idle');
    expect(engine.texts).toEqual(['Сейчас покажу.', 'Вот команда:', 'Остальное — в чате.']);
  });

  it('says in one phrase what a reply of only code is', async () => {
    const { engine, call } = setup();
    await call.start();
    engine.emit({ type: 'final', text: 'команда' });
    call.onThread([user('команда'), reply('a1', '```powershell\nGet-Process | Sort-Object CPU\n```'), result()], 'idle');
    expect(engine.texts).toEqual(['Код для PowerShell — в чате.']);
  });

  it('does not read a table out', async () => {
    const { engine, call } = setup();
    await call.start();
    engine.emit({ type: 'final', text: 'сравни' });
    call.onThread([user('сравни'), reply('a1', 'Вот сравнение.\n| План | Цена |\n|---|---|\n| A | 1 |'), result()], 'idle');
    expect(engine.texts).toEqual(['Вот сравнение.', 'Остальное — в чате.']);
  });

  it('says the Mac is offline instead of losing the question', async () => {
    const { engine, call, setOnline } = setup();
    await call.start();
    setOnline(false);
    engine.emit({ type: 'final', text: 'привет' });
    expect(engine.texts).toEqual(['Нет связи с Маком.']);
    engine.finishSpeaking();
    expect(call.snapshot().phase).toBe('listening');
  });

  it('follows mute and hang-up from the lock screen', async () => {
    const { engine, call } = setup();
    await call.start();
    engine.emit({ type: 'muted', muted: true });
    expect(call.snapshot().phase).toBe('muted');
    expect(engine.mode).toBe('off');
    engine.emit({ type: 'muted', muted: false });
    expect(engine.mode).toBe('listen');
    engine.emit({ type: 'state', state: 'held' });
    expect(call.snapshot().phase).toBe('held');
    engine.emit({ type: 'state', state: 'active' });
    engine.emit({ type: 'state', state: 'ended', reason: 'remote' });
    expect(call.snapshot()).toMatchObject({ phase: 'ended', endedRemotely: true });
    expect(engine.ended).toBe(true);
  });

  it('keeps the microphone off while talking when the engine cannot cancel echo', async () => {
    const { engine, call } = setup([], { echoCancellation: false, voiceQuality: 'default' });
    await call.start();
    expect(call.snapshot().notice).toContain('Spoken Content');
    engine.emit({ type: 'final', text: 'привет' });
    call.onThread([user('привет'), reply('a1', 'Привет.'), result()], 'idle');
    expect(engine.mode).toBe('off');
    engine.emit({ type: 'partial', text: 'совсем другое что-то' });
    expect(engine.stopped).toBe(0);
    engine.finishSpeaking();
    expect(engine.mode).toBe('listen');
  });

  it('shows why a call could not start', async () => {
    const { engine, call } = setup();
    engine.start = async () => {
      throw new Error('Microphone access is off');
    };
    await call.start();
    expect(call.snapshot()).toMatchObject({ phase: 'error', error: 'Microphone access is off' });
    expect(engine.ended).toBe(true);
  });
});
