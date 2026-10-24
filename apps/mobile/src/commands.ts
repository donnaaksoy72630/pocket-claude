import type { Effort, ModelInfo, SessionMeta } from '@pocket/protocol';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const EFFORT_HINT: Record<Effort, string> = {
  low: 'Fastest, minimal thinking',
  medium: 'Balanced speed and reasoning',
  high: 'Thinks through harder problems',
  xhigh: 'Deep reasoning for tricky work',
  max: 'Largest thinking budget',
};

export type CommandName = 'model' | 'effort' | 'compact' | 'agents' | 'paste' | 'photo' | 'new' | 'stop' | 'kill';

export interface Command {
  name: CommandName;
  description: string;
  argHint?: string;
}

export const COMMANDS: readonly Command[] = [
  { name: 'model', description: 'Switch the model', argHint: 'model' },
  { name: 'effort', description: 'Set how hard the model thinks', argHint: 'level' },
  { name: 'compact', description: 'Compress the chat history to free up context' },
  { name: 'agents', description: 'Running agents and tools' },
  { name: 'paste', description: 'Attach what is on the PC clipboard' },
  { name: 'photo', description: 'Attach a photo' },
  { name: 'new', description: 'Start a new chat' },
  { name: 'stop', description: 'Stop the current response' },
  { name: 'kill', description: 'Stop everything on the Mac and Windows' },
];

export type Suggestion =
  | { kind: 'command'; key: string; title: string; description: string; command: Command }
  | { kind: 'model'; key: string; title: string; description: string; value: string; current: boolean }
  | { kind: 'effort'; key: string; title: string; description: string; value: Effort | null; current: boolean };

export interface SlashInput {
  name: string;
  arg: string;
  /** True once the user typed a space after the command name, i.e. is now typing the argument. */
  hasArg: boolean;
}

export function parseSlash(text: string): SlashInput | null {
  const m = /^\/(\S*)(\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), arg: (m[3] ?? '').trim().toLowerCase(), hasArg: m[2] !== undefined };
}

const DEFAULT_MODEL: ModelInfo = { value: 'default', displayName: 'Default', description: 'Claude Code default model' };

export function modelOptions(models: readonly ModelInfo[]): ModelInfo[] {
  return models.some((m) => m.value === 'default') ? [...models] : [DEFAULT_MODEL, ...models];
}

type ModelChoice = Pick<SessionMeta, 'model' | 'effort'> | undefined;

export function currentModel(session: ModelChoice): string {
  return session?.model ?? 'default';
}

export function modelLabel(session: ModelChoice, models: readonly ModelInfo[]): string {
  const value = currentModel(session);
  return modelOptions(models).find((m) => m.value === value)?.displayName ?? value;
}

export function effortLabel(session: ModelChoice): string {
  return session?.effort ? EFFORT_LABEL[session.effort] : 'Auto';
}

export function effortsFor(model: string, models: readonly ModelInfo[]): readonly Effort[] {
  return models.find((m) => m.value === model)?.efforts ?? EFFORTS;
}

export function resolveModel(arg: string, models: readonly ModelInfo[]): string | undefined {
  const options = modelOptions(models);
  const a = arg.toLowerCase();
  return (
    options.find((m) => m.value.toLowerCase() === a || m.displayName.toLowerCase() === a) ??
    options.find((m) => m.value.toLowerCase().startsWith(a) || m.displayName.toLowerCase().startsWith(a))
  )?.value;
}

/** `undefined` = not a level; `null` = reset to the model's default. */
export function resolveEffort(arg: string): Effort | null | undefined {
  const a = arg.toLowerCase();
  if (a === 'auto' || a === 'default') return null;
  return EFFORTS.find((e) => e === a || EFFORT_LABEL[e].toLowerCase() === a);
}

const matches = (query: string, ...fields: string[]) => !query || fields.some((f) => f.toLowerCase().includes(query));

export function suggestionsFor(text: string, models: readonly ModelInfo[], session: ModelChoice): Suggestion[] {
  const input = parseSlash(text);
  if (!input) return [];

  if (!input.hasArg) {
    return COMMANDS.filter((c) => c.name.startsWith(input.name)).map((command) => ({
      kind: 'command',
      key: `c:${command.name}`,
      title: `/${command.name}`,
      description: command.description,
      command,
    }));
  }

  if (input.name === 'model') {
    const current = currentModel(session);
    return modelOptions(models)
      .filter((m) => matches(input.arg, m.value, m.displayName))
      .map((m) => ({ kind: 'model', key: `m:${m.value}`, title: m.displayName, description: m.description, value: m.value, current: m.value === current }));
  }

  if (input.name === 'effort') {
    const current = session?.effort ?? null;
    const auto: Suggestion = { kind: 'effort', key: 'e:auto', title: 'Auto', description: "Model's default", value: null, current: current === null };
    const levels: Suggestion[] = effortsFor(currentModel(session), models).map((e) => ({
      kind: 'effort',
      key: `e:${e}`,
      title: EFFORT_LABEL[e],
      description: EFFORT_HINT[e],
      value: e,
      current: current === e,
    }));
    return [auto, ...levels].filter((s) => matches(input.arg, s.title, s.kind === 'effort' && s.value ? s.value : 'auto'));
  }

  return [];
}

/** "Context 42%" for the chip; null until the chat has answered once. */
export function contextLabel(session: Pick<SessionMeta, 'context'> | undefined): string | null {
  const c = session?.context;
  return c ? `Context ${c.percent}%` : null;
}
