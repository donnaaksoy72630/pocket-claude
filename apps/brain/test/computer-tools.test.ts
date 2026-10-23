import type { ComputerAction, ComputerResult, Display, WindowInfo } from '@pocket/protocol';
import { describe, expect, it } from 'vitest';
import { computerConsent, computerTools, computerToolsPrompt, ComputerState, describeComputerStep, formatWindows, fromDesktop, pickWindow, toDesktop, type ScreenView } from '../src/computer-tools.js';
import { toDisplayCall } from '../src/claude-tools.js';
import type { PcHandle } from '../src/pc-tools.js';

const DISPLAYS: Display[] = [
  { index: 0, x: 0, y: 0, width: 2560, height: 1440, primary: true, scale: 1.5 },
  { index: 1, x: -1920, y: 0, width: 1920, height: 1080, primary: false, scale: 1 },
];
const WINDOWS: WindowInfo[] = [
  { handle: '100', title: 'Слайды — Google Chrome', process: 'chrome', x: 0, y: 0, width: 2560, height: 1400, minimized: false, maximized: true, focused: true, display: 0 },
  { handle: '200', title: 'Windows PowerShell', process: 'powershell', x: 100, y: 100, width: 900, height: 600, minimized: false, maximized: false, focused: false, display: 0 },
  { handle: '300', title: 'Untitled - Notepad', process: 'notepad', x: -32000, y: -32000, width: 160, height: 28, minimized: true, maximized: false, focused: false },
];

function setup(over: Partial<PcHandle> = {}) {
  const actions: ComputerAction[] = [];
  const answer = (a: ComputerAction): ComputerResult & { error?: string } => {
    switch (a.action) {
      case 'screenshot': {
        const d = DISPLAYS[a.display ?? 0]!;
        return { image: { mime: 'image/jpeg', dataBase64: `shot${a.display ?? 0}`, width: 1280, height: Math.round((1280 * d.height) / d.width) }, region: { x: d.x, y: d.y, width: d.width, height: d.height }, displays: DISPLAYS, cursor: { x: 5, y: 5 } };
      }
      case 'zoom':
        return { image: { mime: 'image/jpeg', dataBase64: 'zoomed', width: a.width, height: a.height }, region: { x: a.x, y: a.y, width: a.width, height: a.height } };
      case 'windows':
        return { windows: WINDOWS, displays: DISPLAYS };
      case 'cursor':
        return { cursor: { x: 1281, y: 721 } };
      case 'window':
        return { text: 'The window is now in front.' };
      case 'open':
        return { text: `Started ${a.target} (process 42).` };
      default:
        return { cursor: { x: 0, y: 0 } };
    }
  };
  const pc: PcHandle = {
    id: 'pc1',
    name: 'Laptop',
    online: true,
    capabilities: ['clipboard', 'screenshot', 'computer'],
    clipboardRead: async () => ({}),
    clipboardWrite: async () => ({}),
    screenshot: async () => ({}),
    computer: async (a) => {
      actions.push(a);
      return answer(a);
    },
    ...over,
  };
  const state = new ComputerState();
  const slept: number[] = [];
  const [tool] = computerTools(() => pc, state, { sleep: async (ms) => void slept.push(ms) });
  const call = (input: Record<string, unknown>) => tool!.handler(input as never, {}) as Promise<{ content: { type: string; text?: string; data?: string }[]; isError?: boolean }>;
  const text = (r: Awaited<ReturnType<typeof call>>) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { pc, state, actions, slept, call, text };
}

describe('screen coordinates', () => {
  const view: ScreenView = { display: 0, region: { x: 0, y: 0, width: 2560, height: 1440 }, width: 1280, height: 720, displays: DISPLAYS };

  it('map screenshot pixels onto the physical desktop and back', () => {
    expect(toDesktop(view, [0, 0])).toEqual({ x: 1, y: 1 });
    expect(toDesktop(view, [640, 360])).toEqual({ x: 1281, y: 721 });
    expect(toDesktop(view, [1279, 719])).toEqual({ x: 2559, y: 1439 });
    expect(toDesktop(view, [639.6, 359.6])).toEqual({ x: 1281, y: 721 });
    expect(fromDesktop(view, { x: 1281, y: 721 })).toEqual([640, 360]);
    expect(fromDesktop(view, { x: -5, y: 10 })).toBeUndefined();
  });

  it('follow a display left of the main one', () => {
    const left: ScreenView = { ...view, display: 1, region: { x: -1920, y: 0, width: 1920, height: 1080 }, width: 1280, height: 720 };
    expect(toDesktop(left, [0, 0])).toEqual({ x: -1920, y: 0 });
    expect(toDesktop(left, [1279, 719])).toEqual({ x: -1, y: 1079 });
  });

  it('refuse points outside the picture', () => {
    expect(() => toDesktop(view, [1280, 10])).toThrow(/outside the screenshot, which is 1280x720/);
    expect(() => toDesktop(view, [-1, 10])).toThrow(/outside/);
  });
});

describe('computer tool', () => {
  it('starts with a screenshot that says what the coordinates mean', async () => {
    const { call, text, state } = setup();
    const r = await call({ action: 'screenshot' });
    expect(r.content[0]).toEqual({ type: 'image', data: 'shot0', mimeType: 'image/jpeg' });
    expect(text(r)).toBe('Screenshot of display 0 of 2 (main): 1280x720 px (the screen is 2560x1440 at 150 %). Coordinates are pixels of this picture.');
    expect(state.view?.region).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
  });

  it('clicks where the screenshot shows and looks again after a moment', async () => {
    const { call, text, actions, slept } = setup();
    await call({ action: 'screenshot' });
    const r = await call({ action: 'double_click', coordinate: [640, 360], text: 'ctrl' });
    expect(actions[1]).toEqual({ action: 'click', x: 1281, y: 721, button: 'left', count: 2, modifiers: ['ctrl'] });
    expect(actions[2]).toEqual({ action: 'screenshot', display: 0 });
    expect(slept).toEqual([600]);
    expect(r.content[0]).toMatchObject({ type: 'image' });
    expect(text(r)).toMatch(/^double click at \[640, 360\] with ctrl\. Screenshot of/);
  });

  it('wants a screenshot before the first coordinate', async () => {
    const { call, text, actions } = setup();
    const r = await call({ action: 'left_click', coordinate: [10, 10] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Take a screenshot first/);
    expect(actions).toEqual([]);
  });

  it('types, presses and holds keys, scrolls and drags', async () => {
    const { call, actions } = setup();
    await call({ action: 'screenshot' });
    await call({ action: 'type', text: 'Get-ChildItem' });
    await call({ action: 'key', text: 'Return' });
    await call({ action: 'hold_key', text: 'shift', duration: 2 });
    await call({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'up', scroll_amount: 5 });
    await call({ action: 'scroll', scroll_direction: 'right' });
    await call({ action: 'left_click_drag', start_coordinate: [10, 10], coordinate: [20, 30] });
    expect(actions.filter((a) => a.action !== 'screenshot')).toEqual([
      { action: 'type', text: 'Get-ChildItem' },
      { action: 'key', keys: 'Return' },
      { action: 'key', keys: 'shift', holdMs: 2000 },
      { action: 'scroll', x: 201, y: 201, dx: 0, dy: -5 },
      { action: 'scroll', dx: 3, dy: 0 },
      { action: 'drag', path: [[21, 21], [41, 61]], button: 'left' },
    ]);
  });

  it('zooms into a region in physical pixels but keeps the full screenshot as the frame', async () => {
    const { call, text, actions, state } = setup();
    await call({ action: 'screenshot' });
    const before = state.view;
    const r = await call({ action: 'zoom', region: [100, 50, 300, 150] });
    expect(actions[1]).toEqual({ action: 'zoom', x: 200, y: 100, width: 400, height: 200 });
    await call({ action: 'zoom', region: [0, 0, 1280, 720] });
    expect(actions.at(-1)).toEqual({ action: 'zoom', x: 0, y: 0, width: 2560, height: 1440 });
    expect((await call({ action: 'zoom', region: [5000, 5000, 6000, 6000] })).isError).toBe(true);
    expect(r.content[0]).toMatchObject({ type: 'image', data: 'zoomed' });
    expect(text(r)).toMatch(/Keep using coordinates of the full screenshot/);
    expect(state.view).toBe(before);
  });

  it('lists windows and acts on one picked by title or program', async () => {
    const { call, text, actions } = setup();
    expect(text(await call({ action: 'list_windows' }))).toMatch(/^3 windows, front to back:\n- "Слайды — Google Chrome" \(chrome\), window 100, in front, maximized, display 0\n- "Windows PowerShell"/);
    const r = await call({ action: 'focus_window', window: 'powershell' });
    expect(actions.at(-2)).toEqual({ action: 'window', handle: '200', op: 'focus' });
    expect(text(r)).toMatch(/^focus "Windows PowerShell": The window is now in front\./);
    const missing = await call({ action: 'close_window', window: 'excel' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No window matches "excel"/);
  });

  it('opens programs and sites and gives them time to appear', async () => {
    const { call, text, actions, slept } = setup();
    const r = await call({ action: 'open', target: 'chrome', args: 'https://example.com/slides' });
    expect(actions[0]).toEqual({ action: 'open', target: 'chrome', args: 'https://example.com/slides' });
    expect(slept).toEqual([1500]);
    expect(text(r)).toMatch(/^Started chrome \(process 42\)\. Screenshot of/);
  });

  it('switches to another display and reports the pointer in screenshot pixels', async () => {
    const { call, text, state } = setup();
    await call({ action: 'screenshot' });
    expect(text(await call({ action: 'cursor_position' }))).toBe('The pointer is at [640, 360] in the screenshot.');
    const r = await call({ action: 'switch_display', display: 1 });
    expect(r.content[0]).toMatchObject({ data: 'shot1' });
    expect(state.view?.region.x).toBe(-1920);
    expect(text(await call({ action: 'cursor_position' }))).toMatch(/not on the display/);
    expect((await call({ action: 'switch_display', display: 5 })).isError).toBe(true);
    expect(state.display).toBe(1);
  });

  it('explains when the computer is missing, offline, too old or refuses a step', async () => {
    expect(setup({ id: undefined }).text(await setup({ id: undefined }).call({ action: 'screenshot' }))).toMatch(/No computer with PocketClipboard/);
    const offline = setup({ online: false });
    expect(offline.text(await offline.call({ action: 'screenshot' }))).toMatch(/"Laptop" is offline/);
    const old = setup({ capabilities: ['clipboard', 'screenshot'] });
    expect(old.text(await old.call({ action: 'screenshot' }))).toMatch(/too old for computer use/);
    const blocked = setup({ computer: async () => ({ error: 'Windows blocked the input' }) });
    const r = await blocked.call({ action: 'screenshot' });
    expect(r.isError).toBe(true);
    expect(blocked.text(r)).toBe('Windows blocked the input');
  });

  it('counts the step in flight so stop can let go of the computer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { call, state } = setup({ computer: async () => (await gate, { error: 'stopped' }) });
    const pending = call({ action: 'screenshot' });
    expect(state.busy).toBe(1);
    release();
    await pending;
    expect(state.busy).toBe(0);
  });
});

describe('computer helpers', () => {
  it('pick windows by handle, exact title, words or program name', () => {
    expect(pickWindow(WINDOWS, '300')?.process).toBe('notepad');
    expect(pickWindow(WINDOWS, 'windows powershell')?.handle).toBe('200');
    expect(pickWindow(WINDOWS, 'слайды')?.handle).toBe('100');
    expect(pickWindow(WINDOWS, 'notepad.exe')?.handle).toBe('300');
    expect(pickWindow(WINDOWS, '  ')).toBeUndefined();
  });

  it('describe windows for Claude and the consent for the user', () => {
    expect(formatWindows([], undefined)).toBe('No open windows.');
    expect(formatWindows(WINDOWS, [DISPLAYS[0]!])).not.toMatch(/display 0/);
    expect(computerConsent('Laptop')).toMatch(/^Control "Laptop" in this chat: see the screen/);
    expect(computerToolsPrompt('Laptop')).toMatch(/mcp__pocket__computer lets you see and operate "Laptop"/);
    expect(computerToolsPrompt(undefined)).toMatch(/Ask the user first before anything hard to undo/);
  });
});

describe('computer steps as the user sees them', () => {
  it('read as short lines in the chat, the activity screen and on a call', () => {
    expect(describeComputerStep({ action: 'left_click', coordinate: [640.4, 360] })).toBe('left click at [640, 360]');
    expect(describeComputerStep({ action: 'double_click', coordinate: [1, 2], text: 'ctrl' })).toBe('double click at [1, 2] with ctrl');
    expect(describeComputerStep({ action: 'type', text: 'Get-ChildItem\n' })).toBe('type "Get-ChildItem "');
    expect(describeComputerStep({ action: 'key', text: 'ctrl+s' })).toBe('press ctrl+s');
    expect(describeComputerStep({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] })).toBe('drag [1, 2] → [3, 4]');
    expect(describeComputerStep({ action: 'open', target: 'chrome', args: 'https://example.com' })).toBe('open chrome https://example.com');
    expect(describeComputerStep({ action: 'focus_window', window: 'PowerShell' })).toBe('focus window "PowerShell"');
    expect(describeComputerStep({ action: 'screenshot' })).toBe('screenshot');
  });

  it('reach every client through the displayed tool call', () => {
    expect(toDisplayCall('computer', { action: 'scroll', scroll_direction: 'up' })).toEqual({ name: 'computer', input: { action: 'scroll', scroll_direction: 'up', description: 'scroll up 3' } });
    expect(toDisplayCall('chat_configure', { model: 'fable', effort: 'max' }).input).toMatchObject({ description: 'model → fable, thinking → max' });
  });
});
