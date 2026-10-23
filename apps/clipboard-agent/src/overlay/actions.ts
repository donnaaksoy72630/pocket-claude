import { prettyJson, shortToolName, summarizeTool, type ChatItem } from '@pocket/client-core';

/** What an action is about; the window picks the icon. */
export type ActionKind =
  | 'command'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'folder'
  | 'web'
  | 'screen'
  | 'clipboard'
  | 'agent'
  | 'todo'
  | 'git'
  | 'plan'
  | 'skill'
  | 'tool'
  | 'attach';

/** `stopped`: the call never got a result and nothing is working on it any more (an interrupted turn). */
export type ActionState = 'running' | 'waiting' | 'done' | 'error' | 'stopped';

/** One labelled piece of an opened action: the command, the file, the result. */
export interface ActionPart {
  label: string;
  text: string;
}

/** A tool call, or what the user attached, as one row that opens on click. */
export interface OverlayAction {
  id: string;
  kind: ActionKind;
  /** The kind in words: "Команда". */
  label: string;
  /** What it was about, cut to the first words: "pnpm test --filter…". */
  short: string;
  state: ActionState;
  /** Everything it did, shown when the row is opened. */
  parts: ActionPart[];
}

export type ToolItem = Extract<ChatItem, { type: 'tool' }>;
type UserItem = Extract<ChatItem, { type: 'user' }>;
type Args = Record<string, unknown>;

/** A closed row shows this many words of what the action was about. */
export const SHORT_WORDS = 3;
const SHORT_MAX = 48;
const INPUT_MAX = 2000;
const RESULT_MAX = 3000;
/** Runs of this many calls and more fold into one line. */
export const GROUP_FROM = 3;

export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const h = n % 100;
  const word = d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  return `${n} ${word}`;
}

/** Long single words keep what tells them apart: the end of a path, the host of a URL. */
function clipWord(word: string, max: number): string {
  const bare = word.replace(/^https?:\/\//, '');
  if (bare.length <= max) return bare;
  const tail = bare === word ? /[^\\/]+[\\/][^\\/]+$/.exec(word)?.[0] : undefined;
  if (tail && tail.length < max) return `…${tail}`;
  return `${bare.slice(0, max - 1)}…`;
}

/** The first words of a target, so a closed row stays one short line. */
export function firstWords(text: string, n = SHORT_WORDS, max = SHORT_MAX): string {
  const words = text.split(/\s+/).filter(Boolean);
  let out = words
    .slice(0, n)
    .map((w) => clipWord(w, max))
    .join(' ');
  let cut = words.length > n;
  if (out.length > max) {
    out = out.slice(0, max - 1).trimEnd();
    cut = true;
  }
  return cut && !out.endsWith('…') ? `${out}…` : out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… ещё ${text.length - max} симв.` : text;
}

/** Command output matters at its end: that is where errors and summaries are. */
function clipTail(text: string, max: number): string {
  return text.length > max ? `… ещё ${text.length - max} симв. выше\n${text.slice(-max)}` : text;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function part(label: string, value: unknown): ActionPart[] {
  const text = str(value).trim();
  return text ? [{ label, text: clip(text, INPUT_MAX) }] : [];
}

function lineRange(offset: unknown, limit: unknown): string {
  const from = typeof offset === 'number' ? offset : undefined;
  const count = typeof limit === 'number' ? limit : undefined;
  if (from === undefined && count === undefined) return '';
  const start = from ?? 1;
  return count === undefined ? `с ${start}` : `${start}–${start + count - 1}`;
}

function json(input: unknown): ActionPart[] {
  const text = prettyJson(input);
  return text && text !== '{}' && text !== 'null' ? [{ label: 'Параметры', text: clip(text, INPUT_MAX) }] : [];
}

/** How a call reads before anything ran: its kind, its target and its input. */
export interface ToolInfo {
  kind: ActionKind;
  label: string;
  target: string;
  input: ActionPart[];
}

function todoList(value: unknown): ToolInfo {
  const list = Array.isArray(value) ? value.filter((t): t is Args => typeof t === 'object' && t !== null) : [];
  const mark = (s: unknown) => (s === 'completed' ? '✓' : s === 'in_progress' ? '▸' : '○');
  const current = list.find((t) => t.status === 'in_progress');
  return {
    kind: 'todo',
    label: 'Задачи',
    target: current ? str(current.activeForm) || str(current.content) : plural(list.length, 'пункт', 'пункта', 'пунктов'),
    input: list.length ? [{ label: 'Список', text: clip(list.map((t) => `${mark(t.status)} ${str(t.content)}`).join('\n'), INPUT_MAX) }] : [],
  };
}

/** Tool names arrive as the brain shows them to every client (run_command, read_file, …); Claude's own names are kept for older history. */
export function describeTool(name: string, input: unknown): ToolInfo {
  const a: Args = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Args) : {};
  const path = a.path ?? a.file_path;
  switch (shortToolName(name)) {
    case 'run_command':
    case 'Bash':
      return { kind: 'command', label: 'Команда', target: str(a.command), input: [...part('Команда', a.command), ...part('Папка', a.cwd)] };
    case 'command_output':
    case 'BashOutput':
      return { kind: 'command', label: 'Вывод команды', target: str(a.id ?? a.bash_id), input: [] };
    case 'command_kill':
    case 'KillShell':
      return { kind: 'command', label: 'Остановка команды', target: str(a.id ?? a.shell_id), input: [] };
    case 'read_file':
    case 'Read':
    case 'NotebookRead':
      return { kind: 'read', label: 'Чтение', target: str(path ?? a.notebook_path), input: [...part('Файл', path ?? a.notebook_path), ...part('Строки', lineRange(a.offset, a.limit))] };
    case 'write_file':
    case 'Write':
      return { kind: 'write', label: 'Запись', target: str(path), input: [...part('Файл', path), ...part('Содержимое', a.content)] };
    case 'edit_file':
    case 'Edit':
      return { kind: 'edit', label: 'Правка', target: str(path), input: [...part('Файл', path), ...part('Было', a.old_string), ...part('Стало', a.new_string)] };
    case 'MultiEdit':
      return { kind: 'edit', label: 'Правка', target: str(path), input: [...part('Файл', path), ...(Array.isArray(a.edits) ? part('Изменений', a.edits.length) : [])] };
    case 'NotebookEdit':
      return { kind: 'edit', label: 'Правка', target: str(a.notebook_path), input: [...part('Файл', a.notebook_path), ...part('Стало', a.new_source)] };
    case 'list_dir':
    case 'LS':
      return { kind: 'folder', label: 'Папка', target: str(a.path) || '.', input: part('Папка', a.path) };
    case 'glob':
    case 'Glob':
      return { kind: 'search', label: 'Поиск файлов', target: str(a.pattern), input: [...part('Шаблон', a.pattern), ...part('Где', a.path)] };
    case 'grep':
    case 'Grep':
      return { kind: 'search', label: 'Поиск', target: str(a.pattern), input: [...part('Что', a.pattern), ...part('Где', a.path), ...part('Файлы', a.glob)] };
    case 'workspace_info':
      return { kind: 'folder', label: 'Обзор проекта', target: '', input: [] };
    case 'git_status':
      return { kind: 'git', label: 'Git: статус', target: str(a.path), input: part('Папка', a.path) };
    case 'git_diff':
      return { kind: 'git', label: 'Git: изменения', target: str(a.file) || str(a.path), input: [...part('Файл', a.file), ...part('Папка', a.path)] };
    case 'git_commit':
      return { kind: 'git', label: 'Git: коммит', target: str(a.message), input: [...part('Сообщение', a.message), ...part('Файлы', Array.isArray(a.files) ? a.files.map(str).join('\n') : '')] };
    case 'WebFetch':
      return { kind: 'web', label: 'Веб', target: str(a.url), input: [...part('Адрес', a.url), ...part('Задача', a.prompt)] };
    case 'WebSearch':
      return { kind: 'web', label: 'Веб-поиск', target: str(a.query), input: part('Запрос', a.query) };
    case 'pc_screenshot':
      return { kind: 'screen', label: 'Скриншот ПК', target: '', input: [] };
    case 'pc_clipboard_read':
      return { kind: 'clipboard', label: 'Буфер ПК', target: 'чтение', input: [] };
    case 'pc_clipboard_write':
      return { kind: 'clipboard', label: 'В буфер ПК', target: str(a.text), input: part('Текст', a.text) };
    case 'Agent':
    case 'Task':
      return { kind: 'agent', label: 'Субагент', target: str(a.description) || str(a.prompt), input: [...part('Задача', a.description), ...part('Тип', a.subagent_type), ...part('Поручение', a.prompt)] };
    case 'TodoWrite':
      return todoList(a.todos);
    case 'TaskCreate':
    case 'TaskGet':
    case 'TaskList':
    case 'TaskUpdate':
    case 'TaskStop':
      return { kind: 'todo', label: 'Задачи', target: str(a.subject) || str(a.description) || str(a.taskId ?? a.task_id), input: json(input) };
    case 'Skill':
      return { kind: 'skill', label: 'Навык', target: str(a.skill) || str(a.command), input: json(input) };
    case 'ToolSearch':
      return { kind: 'search', label: 'Поиск инструментов', target: str(a.query), input: part('Запрос', a.query) };
    case 'EnterPlanMode':
      return { kind: 'plan', label: 'План', target: 'составляет', input: [] };
    case 'ExitPlanMode':
      return { kind: 'plan', label: 'План', target: str(a.plan), input: part('План', a.plan) };
    default:
      return { kind: 'tool', label: shortToolName(name), target: summarizeTool(input), input: json(input) };
  }
}

function resultParts(item: ToolItem, kind: ActionKind): ActionPart[] {
  if (item.result) {
    const content = item.result.content.trim();
    if (!content) return [];
    return [{ label: item.result.isError ? 'Ошибка' : 'Результат', text: kind === 'command' ? clipTail(content, RESULT_MAX) : clip(content, RESULT_MAX) }];
  }
  const out = item.output.trim();
  return out ? [{ label: 'Вывод', text: clipTail(out, RESULT_MAX) }] : [];
}

/** The one-line title of a call: "Команда pnpm test --filter…". */
export function actionTitle(item: ToolItem): string {
  const info = describeTool(item.name, item.input);
  const short = firstWords(info.target);
  return short ? `${info.label} ${short}` : info.label;
}

/** `pending` is what a call without a result means right now: still going, waiting for approval, or cut off. */
export function toolAction(item: ToolItem, pending: 'running' | 'waiting' | 'stopped'): OverlayAction {
  const info = describeTool(item.name, item.input);
  const state: ActionState = item.result ? (item.result.isError ? 'error' : 'done') : pending;
  return { id: item.key, kind: info.kind, label: info.label, short: firstWords(info.target), state, parts: [...info.input, ...resultParts(item, info.kind)] };
}

/** What the user sent along with the text: pictures and files. */
export function attachmentsAction(item: UserItem): OverlayAction | undefined {
  const names = [...(item.images ? [plural(item.images, 'изображение', 'изображения', 'изображений')] : []), ...(item.files ?? [])];
  if (!names.length) return undefined;
  return { id: `${item.key}:files`, kind: 'attach', label: 'Вложения', short: firstWords(names.join(', ')), state: 'done', parts: [{ label: 'Приложено', text: names.join('\n') }] };
}

/** A run of calls folds into "5 действий · Команда ×2 · Чтение ×3"; while one is going, the line says which. */
export function groupOf(actions: OverlayAction[]): { label: string; summary: string } | undefined {
  if (actions.length < GROUP_FROM) return undefined;
  const label = plural(actions.length, 'действие', 'действия', 'действий');
  const live = [...actions].reverse().find((a) => a.state === 'running' || a.state === 'waiting');
  if (live) return { label, summary: `сейчас: ${live.label}${live.short ? ` ${live.short}` : ''}` };
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  const failed = actions.filter((a) => a.state === 'error').length;
  const kinds = [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
  return { label, summary: [...kinds, ...(failed ? [plural(failed, 'ошибка', 'ошибки', 'ошибок')] : [])].join(' · ') };
}

export function runState(actions: OverlayAction[]): ActionState {
  for (const s of ['waiting', 'running', 'error', 'stopped'] as const) if (actions.some((a) => a.state === s)) return s;
  return 'done';
}
