/* eslint-disable @typescript-eslint/no-explicit-any */
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, type ComputerAction, type ComputerResult, type Display, type WindowInfo } from '@pocket/protocol';
import { z } from 'zod';
import type { PcHandle } from './pc-tools.js';

export const COMPUTER_TOOL = 'computer';
export const COMPUTER_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${COMPUTER_TOOL}`;

type Rect = { x: number; y: number; width: number; height: number };
type Point = [number, number];

/** What the latest screenshot showed: the display, where it sits on the desktop, and the picture's size. */
export interface ScreenView {
  display: number;
  region: Rect;
  width: number;
  height: number;
  displays: Display[];
}

/** One chat's computer use: the picture Claude's coordinates refer to, and whether a step is running. */
export class ComputerState {
  view: ScreenView | undefined;
  display = 0;
  busy = 0;

  reset(): void {
    this.view = undefined;
    this.display = 0;
  }
}

/** Screenshot pixel → physical desktop pixel (the centre of the area that screenshot pixel covers). */
export function toDesktop(view: ScreenView, [x, y]: readonly [number, number]): { x: number; y: number } {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= view.width || py >= view.height) throw new Error(`[${px}, ${py}] is outside the screenshot, which is ${view.width}x${view.height}`);
  const kx = view.region.width / view.width;
  const ky = view.region.height / view.height;
  return {
    x: view.region.x + Math.min(view.region.width - 1, Math.floor((px + 0.5) * kx)),
    y: view.region.y + Math.min(view.region.height - 1, Math.floor((py + 0.5) * ky)),
  };
}

/** Physical desktop pixel → screenshot pixel, or undefined when the point is on another display. */
export function fromDesktop(view: ScreenView, p: { x: number; y: number }): Point | undefined {
  const r = view.region;
  if (p.x < r.x || p.y < r.y || p.x >= r.x + r.width || p.y >= r.y + r.height) return undefined;
  return [Math.floor(((p.x - r.x) * view.width) / r.width), Math.floor(((p.y - r.y) * view.height) / r.height)];
}

const ACTIONS = [
  'screenshot', 'zoom', 'cursor_position', 'wait',
  'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
  'type', 'key', 'hold_key',
  'list_windows', 'focus_window', 'minimize_window', 'maximize_window', 'restore_window', 'close_window', 'open', 'switch_display',
] as const;

const point = z.tuple([z.number(), z.number()]);
const SHAPE = {
  action: z.enum(ACTIONS),
  coordinate: point.optional().describe('[x, y] in pixels of the latest screenshot'),
  start_coordinate: point.optional().describe('Where left_click_drag starts, [x, y]'),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('[x1, y1, x2, y2] of the screenshot to look at closely (zoom)'),
  text: z.string().max(5000).optional().describe('type: the text. key / hold_key: keys like "ctrl+s", "Return", "alt+tab", "super+r". Clicks and scroll: a modifier to hold, like "shift" or "ctrl"'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().int().min(1).max(30).optional().describe('Wheel notches, default 3'),
  duration: z.number().min(0).max(30).optional().describe('Seconds, for wait and hold_key'),
  window: z.string().max(300).optional().describe('focus/minimize/maximize/restore/close_window: a handle from list_windows or part of the title or program name'),
  target: z.string().max(2000).optional().describe('open: a program, file, folder or URL, as in the Run dialog: "powershell", "chrome", "notepad", "explorer", "https://…"'),
  args: z.string().max(8000).optional().describe('open: arguments for the program'),
  display: z.number().int().min(0).optional().describe('switch_display: the index of the display to look at'),
};
type Input = { [K in keyof typeof SHAPE]: z.infer<(typeof SHAPE)[K]> };

const DESCRIPTION = [
  "Use the user's Windows computer the way a person at it would: see the screen, move and click the mouse, type, press keys, switch, open and close windows, start programs.",
  'Start with screenshot. Coordinates are [x, y] pixels of the latest screenshot; after every action you get a fresh screenshot to check the result.',
  'Actions: screenshot; zoom (region) to read small text; mouse_move, left_click, right_click, middle_click, double_click, triple_click (coordinate, optional; text = modifier); left_click_drag (start_coordinate, coordinate); left_mouse_down, left_mouse_up; scroll (coordinate, scroll_direction, scroll_amount);',
  'type (text); key, hold_key (text, duration); wait (duration); cursor_position; list_windows; focus_window, minimize_window, maximize_window, restore_window, close_window (window); open (target, args); switch_display (display).',
].join(' ');

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

/** What Claude is told about computer use, in every mode. */
export function computerToolsPrompt(pcName: string | undefined): string {
  const who = pcName ? `"${pcName}"` : "the user's Windows computer";
  return [
    "# Using the user's computer",
    `mcp__pocket__computer lets you see and operate ${who} like a person sitting at it. Use it when the user asks you to do something there: open a program or a site, type into a window, click, look at what is on the screen and fix it.`,
    '- Start with a screenshot. Coordinates are pixels of the latest screenshot; each action returns a new one, so check it before the next step instead of assuming.',
    '- Prefer keys and the window actions to hunting with the mouse: open starts programs and URLs (target "powershell", "chrome" with args "https://…", "notepad", "explorer"); list_windows and focus_window switch windows; key presses shortcuts ("ctrl+l", "alt+tab", "Return").',
    '- To run a command in an open PowerShell or terminal: focus_window it, type the command, then key "Return", then read the output on the next screenshot.',
    '- zoom reads small text; switch_display looks at another monitor.',
    '- Ask the user first before anything hard to undo: sending a message or mail, deleting, buying or paying, submitting a form, closing a window with unsaved work, changing system settings.',
    '- The first action in a chat asks the user for permission on their phone; after that the chat may use the computer freely.',
  ].join('\n');
}

const SETTLE_MS = { pointer: 300, click: 600, keys: 500, window: 800, open: 1500 };

/** Consent text shown on the phone (and read out on a call) the first time a chat wants the computer. */
export function computerConsent(pcName: string | undefined): string {
  return `Control ${pcName ? `"${pcName}"` : 'your computer'} in this chat: see the screen, use the mouse and keyboard, open and close windows`;
}

function describeView(v: ScreenView): string {
  const d = v.displays[v.display];
  const count = v.displays.length;
  const where = count > 1 ? `display ${v.display} of ${count}${d?.primary ? ' (main)' : ''}` : 'the screen';
  const scale = d?.scale && d.scale !== 1 ? ` at ${Math.round(d.scale * 100)} %` : '';
  return `Screenshot of ${where}: ${v.width}x${v.height} px (the screen is ${v.region.width}x${v.region.height}${scale}). Coordinates are pixels of this picture.`;
}

export function formatWindows(windows: readonly WindowInfo[], displays: readonly Display[] | undefined): string {
  if (!windows.length) return 'No open windows.';
  const shown = windows.slice(0, 40);
  const lines = shown.map((w) => {
    const flags = [w.focused ? 'in front' : '', w.minimized ? 'minimized' : '', w.maximized ? 'maximized' : '', w.display !== undefined && (displays?.length ?? 0) > 1 ? `display ${w.display}` : '']
      .filter(Boolean)
      .join(', ');
    return `- "${w.title}" (${w.process || 'unknown'}), window ${w.handle}${flags ? `, ${flags}` : ''}`;
  });
  return [`${windows.length} windows, front to back:`, ...lines, ...(windows.length > shown.length ? [`… ${windows.length - shown.length} more`] : [])].join('\n');
}

/** The window a user means: a handle, an exact title, or the frontmost one whose title or program contains the words. */
export function pickWindow(windows: readonly WindowInfo[], query: string): WindowInfo | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const byHandle = windows.find((w) => w.handle === q);
  if (byHandle) return byHandle;
  const exact = windows.find((w) => w.title.toLowerCase() === q);
  if (exact) return exact;
  return windows.find((w) => w.title.toLowerCase().includes(q) || w.process.toLowerCase().includes(q) || w.process.toLowerCase() === q.replace(/\.exe$/, ''));
}

function unavailable(p: PcHandle): Result | null {
  if (!p.id) return fail('No computer with PocketClipboard is paired to this person. They can install PocketClipboard.exe on their Windows computer and pair it from the app.');
  if (!p.online) return fail(`The computer "${p.name}" is offline: PocketClipboard is not running or the computer is asleep.`);
  if (!p.capabilities.includes('computer')) return fail(`PocketClipboard on "${p.name}" is too old for computer use: the user needs to run the current PocketClipboard.exe there once.`);
  return null;
}

export function computerTools(pc: () => PcHandle, state: ComputerState, opts: { sleep?: (ms: number) => Promise<void> } = {}): SdkMcpToolDefinition<any>[] {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const run = async (p: PcHandle, input: Input): Promise<Result> => {
    const act = async (action: ComputerAction): Promise<ComputerResult> => {
      const r = await p.computer(action);
      if (r.error) throw new Error(r.error);
      return r;
    };
    const shot = async (): Promise<ComputerResult & { image: NonNullable<ComputerResult['image']> }> => {
      const r = await act({ action: 'screenshot', display: state.display });
      if (!r.image || !r.region) throw new Error('The computer sent no picture');
      state.view = { display: state.display, region: r.region, width: r.image.width, height: r.image.height, displays: r.displays ?? state.view?.displays ?? [] };
      return { ...r, image: r.image };
    };
    const picture = (r: { image: NonNullable<ComputerResult['image']> }, text: string): Result => ({
      content: [{ type: 'image', data: r.image.dataBase64, mimeType: r.image.mime }, { type: 'text', text }],
    });
    const after = async (what: string, ms: number): Promise<Result> => {
      await sleep(ms);
      const r = await shot();
      return picture(r, `${what} ${describeView(state.view!)}`);
    };
    const view = (): ScreenView => {
      if (!state.view) throw new Error('Take a screenshot first: coordinates are pixels of the latest screenshot.');
      return state.view;
    };
    const at = (c: Point | undefined, name = 'coordinate') => {
      if (!c) throw new Error(`${input.action} needs ${name} [x, y]`);
      return toDesktop(view(), c);
    };
    const needText = (what: string) => {
      if (!input.text) throw new Error(`${input.action} needs text: ${what}`);
      return input.text;
    };
    const modifiers = input.text ? input.text.split('+').map((s) => s.trim()).filter(Boolean) : undefined;
    const where = (c: Point | undefined) => (c ? `at [${Math.round(c[0])}, ${Math.round(c[1])}]` : 'where the pointer is');

    switch (input.action) {
      case 'screenshot': {
        const r = await shot();
        return picture(r, describeView(state.view!));
      }
      case 'zoom': {
        const v = view();
        if (!input.region) throw new Error('zoom needs region [x1, y1, x2, y2]');
        const [x1, y1, x2, y2] = input.region;
        // The region's edges, not pixel centres: [0, 0, width, height] is the whole screenshot.
        const left = Math.max(0, Math.min(x1, x2));
        const right = Math.min(v.width, Math.max(x1, x2));
        const top = Math.max(0, Math.min(y1, y2));
        const bottom = Math.min(v.height, Math.max(y1, y2));
        if (right - left < 2 || bottom - top < 2) throw new Error('zoom needs a region at least a few pixels across, inside the screenshot');
        const kx = v.region.width / v.width;
        const ky = v.region.height / v.height;
        const r = await act({
          action: 'zoom',
          x: v.region.x + Math.floor(left * kx),
          y: v.region.y + Math.floor(top * ky),
          width: Math.max(4, Math.ceil(right * kx) - Math.floor(left * kx)),
          height: Math.max(4, Math.ceil(bottom * ky) - Math.floor(top * ky)),
        });
        if (!r.image) throw new Error('The computer sent no picture');
        return picture({ image: r.image }, `Close-up of [${x1}, ${y1}, ${x2}, ${y2}] of the screenshot, ${r.image.width}x${r.image.height} px. Keep using coordinates of the full screenshot for actions.`);
      }
      case 'cursor_position': {
        const r = await act({ action: 'cursor' });
        if (!r.cursor) throw new Error('The computer did not say where the pointer is');
        const inShot = state.view ? fromDesktop(state.view, r.cursor) : undefined;
        return ok(inShot ? `The pointer is at [${inShot[0]}, ${inShot[1]}] in the screenshot.` : 'The pointer is not on the display of the latest screenshot; take a screenshot to find it.');
      }
      case 'wait': {
        const s = Math.min(30, input.duration ?? 1);
        await sleep(s * 1000);
        const r = await shot();
        return picture(r, `Waited ${s} s. ${describeView(state.view!)}`);
      }
      case 'mouse_move': {
        await act({ action: 'move', ...at(input.coordinate) });
        return after(`Moved the pointer ${where(input.coordinate)}.`, SETTLE_MS.pointer);
      }
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        const button = input.action === 'right_click' ? 'right' : input.action === 'middle_click' ? 'middle' : 'left';
        const count = input.action === 'double_click' ? 2 : input.action === 'triple_click' ? 3 : 1;
        const target = input.coordinate ? at(input.coordinate) : undefined;
        await act({ action: 'click', ...(target ?? {}), button, count, ...(modifiers ? { modifiers } : {}) });
        return after(`${input.action.replace('_', ' ')} ${where(input.coordinate)}${modifiers ? ` with ${input.text}` : ''}.`, SETTLE_MS.click);
      }
      case 'left_click_drag': {
        const from = at(input.start_coordinate, 'start_coordinate');
        const to = at(input.coordinate);
        await act({ action: 'drag', path: [[from.x, from.y], [to.x, to.y]], button: 'left' });
        return after(`Dragged from ${where(input.start_coordinate).slice(3)} to ${where(input.coordinate).slice(3)}.`, SETTLE_MS.click);
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        if (input.coordinate) await act({ action: 'move', ...at(input.coordinate) });
        const down = input.action === 'left_mouse_down';
        await act({ action: 'button', button: 'left', down });
        return down ? ok('The left button is held down; move with mouse_move, then left_mouse_up.') : after('Let go of the left button.', SETTLE_MS.click);
      }
      case 'scroll': {
        const dir = input.scroll_direction ?? 'down';
        const n = input.scroll_amount ?? 3;
        const target = input.coordinate ? at(input.coordinate) : undefined;
        await act({ action: 'scroll', ...(target ?? {}), dx: dir === 'right' ? n : dir === 'left' ? -n : 0, dy: dir === 'down' ? n : dir === 'up' ? -n : 0, ...(modifiers ? { modifiers } : {}) });
        return after(`Scrolled ${dir} by ${n} ${where(input.coordinate)}.`, SETTLE_MS.pointer);
      }
      case 'type': {
        const text = needText('what to type');
        await act({ action: 'type', text });
        return after(`Typed ${text.length} characters.`, SETTLE_MS.keys);
      }
      case 'key': {
        const keys = needText('keys such as "ctrl+s" or "Return"');
        await act({ action: 'key', keys });
        return after(`Pressed ${keys}.`, SETTLE_MS.keys);
      }
      case 'hold_key': {
        const keys = needText('keys to hold');
        const ms = Math.min(10_000, Math.round((input.duration ?? 1) * 1000));
        await act({ action: 'key', keys, holdMs: ms });
        return after(`Held ${keys} for ${ms / 1000} s.`, SETTLE_MS.pointer);
      }
      case 'list_windows': {
        const r = await act({ action: 'windows' });
        return ok(formatWindows(r.windows ?? [], r.displays));
      }
      case 'focus_window':
      case 'minimize_window':
      case 'maximize_window':
      case 'restore_window':
      case 'close_window': {
        if (!input.window) throw new Error(`${input.action} needs window: a handle from list_windows or part of the title`);
        const list = (await act({ action: 'windows' })).windows ?? [];
        const w = pickWindow(list, input.window);
        if (!w) throw new Error(`No window matches "${input.window}". ${formatWindows(list, undefined)}`);
        const op = input.action.replace('_window', '') as 'focus' | 'minimize' | 'maximize' | 'restore' | 'close';
        const r = await act({ action: 'window', handle: w.handle, op });
        return after(`${op} "${w.title}": ${r.text ?? 'done.'}`, SETTLE_MS.window);
      }
      case 'open': {
        if (!input.target) throw new Error('open needs target: a program, file, folder or URL');
        const r = await act({ action: 'open', target: input.target, ...(input.args ? { args: input.args } : {}) });
        return after(r.text ?? `Opened ${input.target}.`, SETTLE_MS.open);
      }
      case 'switch_display': {
        if (input.display === undefined) throw new Error('switch_display needs display: the index of a display');
        const count = state.view?.displays.length ?? 0;
        if (count && input.display >= count) throw new Error(`There is no display ${input.display}: this computer has ${count} (0 to ${count - 1}).`);
        const before = state.display;
        state.display = input.display;
        try {
          const r = await shot();
          return picture(r, describeView(state.view!));
        } catch (e) {
          state.display = before;
          throw e;
        }
      }
    }
  };

  return [
    tool(COMPUTER_TOOL, DESCRIPTION, SHAPE, async (input) => {
      const p = pc();
      const down = unavailable(p);
      if (down) return down;
      state.busy++;
      try {
        return await run(p, input as Input);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      } finally {
        state.busy--;
      }
    }),
  ];
}
