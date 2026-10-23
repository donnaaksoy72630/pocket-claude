import type { SessionState } from '@pocket/protocol';
import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const STATE_LABEL: Record<SessionState, string> = {
  idle: 'idle',
  running: 'running',
  waiting_permission: 'needs approval',
  ended: 'ended',
};

export const STATE_COLOR: Record<SessionState, string> = {
  idle: colors.textMuted,
  running: colors.accent,
  waiting_permission: colors.warn,
  ended: colors.textMuted,
};

const TOOL_ICONS: Record<string, IconName> = {
  read_file: 'document-text-outline',
  write_file: 'create-outline',
  edit_file: 'pencil-outline',
  list_dir: 'folder-open-outline',
  glob: 'search-outline',
  grep: 'search-outline',
  run_command: 'terminal-outline',
  workspace_info: 'desktop-outline',
  command_output: 'reader-outline',
  command_kill: 'stop-circle-outline',
  git_status: 'git-branch-outline',
  git_diff: 'git-compare-outline',
  git_commit: 'git-commit-outline',
  Agent: 'git-branch-outline',
  WebFetch: 'globe-outline',
  WebSearch: 'globe-outline',
  Skill: 'sparkles-outline',
  TodoWrite: 'checkbox-outline',
  ExitPlanMode: 'map-outline',
  EnterPlanMode: 'map-outline',
  computer: 'desktop-outline',
  pc_screenshot: 'camera-outline',
  pc_clipboard_read: 'clipboard-outline',
  pc_clipboard_write: 'clipboard-outline',
  chat_configure: 'options-outline',
  chat_models: 'options-outline',
  SandboxNetworkAccess: 'globe-outline',
};

export function bareToolName(name: string): string {
  const i = name.lastIndexOf('__');
  return i >= 0 ? name.slice(i + 2) : name;
}

export function toolIcon(name: string): IconName {
  return TOOL_ICONS[bareToolName(name)] ?? 'construct-outline';
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function toolSummary(name: string, input: unknown): string {
  const r = asRecord(input);
  const first = (...keys: string[]) => keys.map((k) => str(r[k])).find((v) => v !== undefined);
  const v = first('command', 'path', 'file_path', 'pattern', 'url', 'query', 'description', 'skill', 'id');
  if (v) return v.replace(/\s+/g, ' ').trim();
  return bareToolName(name);
}

export function toolPath(input: unknown): string | undefined {
  const r = asRecord(input);
  return str(r.path) ?? str(r.file_path);
}

export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export function tail(text: string, lines = 12): string {
  const all = text.replace(/\n+$/, '').split('\n');
  return all.length <= lines ? all.join('\n') : `…\n${all.slice(-lines).join('\n')}`;
}

export function formatResult(durationMs?: number, costUsd?: number): string {
  const parts = ['done'];
  if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  if (costUsd !== undefined) parts.push(`$${costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

export function asStrings(input: unknown): {
  command?: string;
  path?: string;
  content?: string;
  oldString?: string;
  newString?: string;
} {
  const r = asRecord(input);
  return {
    command: str(r.command),
    path: str(r.path) ?? str(r.file_path),
    content: typeof r.content === 'string' ? r.content : undefined,
    oldString: typeof r.old_string === 'string' ? r.old_string : undefined,
    newString: typeof r.new_string === 'string' ? r.new_string : undefined,
  };
}
