import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { MCP_SERVER_NAME, toolArgs, toolDescriptions, type ToolName } from '@pocket/protocol';
import { describeChatChange } from './chat-tools.js';
import { COMPUTER_TOOL, describeComputerStep } from './computer-tools.js';

/**
 * Claude Code-shaped tools that run on the executor.
 * Claude sees the familiar names and argument shapes (Bash, Read, Edit, ...) as `mcp__pocket__<Name>`;
 * the built-in names are aliased to them so skills that say "use Bash" also land on Windows.
 * Every call is translated to a protocol tool call, which is what permissions, history and clients see.
 */
export interface ClaudeTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** Built-in Claude Code tool names routed to this tool. */
  aliases: readonly string[];
  readOnly: boolean;
  toProtocol(args: Record<string, unknown>): { name: ToolName; args: Record<string, unknown> };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const WINDOWS = 'on the user\'s Windows machine';

export const CLAUDE_TOOLS: readonly ClaudeTool[] = [
  {
    name: 'Bash',
    description: `Run a Windows PowerShell command ${WINDOWS} in the workspace. Set run_in_background for long-running processes (dev servers, watchers) and read them with BashOutput.`,
    shape: {
      command: z.string().describe('PowerShell command line'),
      timeout: z.number().int().min(1000).max(3_600_000).optional().describe('Timeout in milliseconds (default 120000)'),
      description: z.string().optional().describe('Short description of what the command does'),
      run_in_background: z.boolean().optional().describe('Start in the background and return an id'),
    },
    aliases: ['Bash', 'PowerShell'],
    readOnly: false,
    toProtocol: (a) => ({ name: 'run_command', args: clean({ command: a.command, timeout_ms: num(a.timeout), background: a.run_in_background === true ? true : undefined }) }),
  },
  {
    name: 'BashOutput',
    description: `Read new output of a background command started with Bash run_in_background ${WINDOWS}.`,
    shape: {
      bash_id: z.string().describe('Id returned when the command was started'),
      wait_ms: z.number().int().min(0).max(60_000).optional().describe('Wait up to this long for new output'),
    },
    aliases: [],
    readOnly: true,
    toProtocol: (a) => ({ name: 'command_output', args: clean({ id: a.bash_id, wait_ms: num(a.wait_ms) }) }),
  },
  {
    name: 'KillShell',
    description: `Stop a background command ${WINDOWS}.`,
    shape: { shell_id: z.string().describe('Id of the background command') },
    aliases: [],
    readOnly: false,
    toProtocol: (a) => ({ name: 'command_kill', args: { id: a.shell_id } }),
  },
  {
    name: 'Read',
    description: `Read a text file ${WINDOWS}. Returns numbered lines. Paths are absolute Windows paths or relative to the workspace root.`,
    shape: {
      file_path: z.string().describe('File path'),
      offset: z.number().int().min(1).optional().describe('1-based line to start from'),
      limit: z.number().int().min(1).optional().describe('Maximum number of lines'),
    },
    aliases: ['Read'],
    readOnly: true,
    toProtocol: (a) => ({ name: 'read_file', args: clean({ path: a.file_path, offset: num(a.offset), limit: num(a.limit) }) }),
  },
  {
    name: 'Write',
    description: `Create or overwrite a file ${WINDOWS}.`,
    shape: { file_path: z.string(), content: z.string() },
    aliases: ['Write'],
    readOnly: false,
    toProtocol: (a) => ({ name: 'write_file', args: { path: a.file_path, content: a.content } }),
  },
  {
    name: 'Edit',
    description: `Replace an exact string in a file ${WINDOWS}. Read the file first; old_string must be unique unless replace_all is set.`,
    shape: {
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    },
    aliases: ['Edit'],
    readOnly: false,
    toProtocol: (a) => ({ name: 'edit_file', args: clean({ path: a.file_path, old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all }) }),
  },
  {
    name: 'Glob',
    description: `Find files by glob pattern ${WINDOWS}.`,
    shape: { pattern: z.string().describe('Glob such as src/**/*.ts'), path: z.string().optional() },
    aliases: ['Glob'],
    readOnly: true,
    toProtocol: (a) => ({ name: 'glob', args: clean({ pattern: a.pattern, path: str(a.path) }) }),
  },
  {
    name: 'Grep',
    description: `Search file contents with a regular expression (ripgrep syntax) ${WINDOWS}. Returns path:line:text.`,
    shape: {
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
      '-i': z.boolean().optional(),
      head_limit: z.number().int().min(1).max(2000).optional(),
    },
    aliases: ['Grep'],
    readOnly: true,
    toProtocol: (a) => ({ name: 'grep', args: clean({ pattern: a.pattern, path: str(a.path), glob: str(a.glob), ignore_case: a['-i'] === true ? true : undefined, max_results: num(a.head_limit) }) }),
  },
  {
    name: 'LS',
    description: `List a directory ${WINDOWS}.`,
    shape: { path: z.string().optional() },
    aliases: [],
    readOnly: true,
    toProtocol: (a) => ({ name: 'list_dir', args: clean({ path: str(a.path) }) }),
  },
  ...(['workspace_info', 'git_status', 'git_diff', 'git_commit'] as const).map(
    (name): ClaudeTool => ({
      name,
      description: toolDescriptions[name],
      shape: toolArgs[name].shape,
      aliases: [],
      readOnly: name !== 'git_commit',
      toProtocol: (a) => ({ name, args: a }),
    }),
  ),
];

const byName = new Map(CLAUDE_TOOLS.map((t) => [t.name, t]));

export const mcpName = (name: string) => `mcp__${MCP_SERVER_NAME}__${name}`;

export const TOOL_ALIASES: Record<string, string> = Object.fromEntries(CLAUDE_TOOLS.flatMap((t) => t.aliases.map((a) => [a, mcpName(t.name)])));

/** Built-in tools that never touch the brain machine's files or shell. */
export const BUILTIN_TOOLS = [
  'Agent',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'WebFetch',
  'WebSearch',
  'Skill',
  'ToolSearch',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

/** Run without asking: read-only executor tools and the harmless built-ins. ExitPlanMode stays gated so the user approves plans. */
export const AUTO_ALLOWED_TOOLS = [
  ...CLAUDE_TOOLS.filter((t) => t.readOnly).map((t) => mcpName(t.name)),
  ...BUILTIN_TOOLS.filter((t) => t !== 'ExitPlanMode'),
];

/** Maps a Claude-facing tool use to what clients display and permissions check. Unknown names pass through. */
export function toDisplayCall(name: string, input: unknown): { name: string; input: unknown } {
  const described = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined;
  if (described && name === COMPUTER_TOOL) return { name, input: { ...described, description: describeComputerStep(described) } };
  if (described && name === 'chat_configure') return { name, input: { ...described, description: describeChatChange(described) } };
  const t = byName.get(name);
  if (!t || typeof input !== 'object' || input === null) return { name, input };
  const call = t.toProtocol(input as Record<string, unknown>);
  return { name: call.name, input: call.args };
}

export function claudeTool(name: string): ClaudeTool | undefined {
  return byName.get(name);
}

/** Files of the skills installed on this machine are served locally; everything else goes to the executor. */
export async function readLocalSkillFile(skillsDirs: readonly string[], filePath: string, offset?: number, limit?: number): Promise<string | undefined> {
  if (!isAbsolute(filePath)) return undefined;
  const target = resolve(filePath);
  if (!skillsDirs.some((d) => {
    const rel = relative(d, target);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  })) return undefined;
  const lines = (await readFile(target, 'utf8')).split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const start = (offset ?? 1) - 1;
  const end = Math.min(lines.length, start + (limit ?? 2000));
  return lines
    .slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
    .join('\n');
}

const READ_ONLY_AGENT_TOOLS = [...CLAUDE_TOOLS.filter((t) => t.readOnly).map((t) => mcpName(t.name)), 'WebFetch', 'WebSearch', 'Skill'];

/**
 * Replaces the built-in subagents so they know where the work is: without this they see only the
 * brain's scratch folder and pass Mac paths to the executor tools. Omitting `tools` inherits the parent's.
 */
export function agentDefinitions(remote: string): Record<string, { description: string; prompt: string; tools?: string[] }> {
  const common = `${remote}\n\nWhen you finish, reply with a concise report of what you found or changed, with Windows paths.`;
  return {
    'general-purpose': {
      description: 'General agent for multi-step research and coding tasks on the Windows workspace. Can read, search, edit files and run commands.',
      prompt: `You are a subagent doing one delegated task end to end.\n\n${common}`,
    },
    Explore: {
      description: 'Fast read-only agent for finding files, searching code and answering questions about the Windows workspace.',
      prompt: `You are a read-only search subagent. Do not modify anything. Search broadly, read only what you need.\n\n${common}`,
      tools: READ_ONLY_AGENT_TOOLS,
    },
    Plan: {
      description: 'Read-only architect agent that studies the Windows workspace and returns a step-by-step implementation plan.',
      prompt: `You are a planning subagent. Study the code read-only and return a concrete step-by-step plan with the files to change.\n\n${common}`,
      tools: READ_ONLY_AGENT_TOOLS,
    },
  };
}
