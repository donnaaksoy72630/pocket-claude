import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SessionMeta } from '@pocket/protocol';

/** Where Mac chats keep their files; each chat gets its own folder under `chats/`. */
export const DEFAULT_MAC_WORKSPACE = process.env.POCKET_WORKSPACE ?? join(homedir(), 'Documents', 'pocket-workspace');

/** The chat's memory, kept by Claude in its folder and put back into the prompt at every start. */
export const NOTES_FILE = 'NOTES.md';
export const ATTACHMENTS_DIR = 'attachments';
const NOTES_LIMIT = 20_000;
const LISTED_FILES = 60;

/**
 * Hosts sandboxed shell commands reach without asking: code hosting and package registries. Anything else is
 * asked on the phone (`SandboxNetworkAccess`). `POCKET_SANDBOX_DOMAINS` adds more.
 */
export const SANDBOX_DOMAINS = [
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  '*.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'formulae.brew.sh',
  'ghcr.io',
];

/** A chat's own folder: named by the day it was made and its id, so it never moves when the chat is renamed. */
export function chatFolder(meta: Pick<SessionMeta, 'sessionId' | 'createdAt' | 'userId'>): string {
  const base = isGuest(meta.userId) ? personRoot(meta.userId!) : DEFAULT_MAC_WORKSPACE;
  return join(base, 'chats', `${new Date(meta.createdAt).toISOString().slice(0, 10)}-${meta.sessionId.slice(0, 8)}`);
}

const OWNER = 'owner';
const isGuest = (userId: string | undefined) => !!userId && userId !== OWNER;

/**
 * Where invited people's folders live: outside the owner's Documents on purpose, so their sandbox can hide the owner's
 * folders without carving theirs back out (Claude Code takes a minute and more to start with such an exception).
 */
export const PEOPLE_WORKSPACE = process.env.POCKET_PEOPLE ?? join(homedir(), 'pocket-people');

/** Everything an invited person has on the Mac: their chats' folders live under it and nothing of theirs outside. */
export function personRoot(userId: string): string {
  return join(PEOPLE_WORKSPACE, userId.replace(/[^\w-]/g, '_'));
}

/** True when `path` (resolved from `cwd`, symlinks followed where they exist) is `root` or inside it. */
export function insideRoot(path: string, cwd: string, root: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      // A file that does not exist yet: check the folder it would go in.
      const parent = dirname(p);
      return parent === p ? p : join(real(parent), basename(p));
    }
  };
  const target = real(resolve(cwd, path));
  const top = real(root);
  return target === top || target.startsWith(top + sep);
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where a Mac chat works: the picked project if it still exists; the shared folder for chats whose Claude Code session
 * already lives there (moving them would lose the conversation); otherwise the chat's own folder.
 */
export function macWorkspaceFor(meta: SessionMeta): { cwd: string; own: boolean } {
  if (isGuest(meta.userId)) {
    // An invited person works only inside their own part of the workspace, never in the owner's folders.
    const root = personRoot(meta.userId!);
    if (meta.project && isDir(meta.project) && insideRoot(meta.project, root, root)) return { cwd: meta.project, own: false };
    return { cwd: chatFolder(meta), own: true };
  }
  if (meta.project && isDir(meta.project)) return { cwd: meta.project, own: false };
  if (meta.engine?.cwd === DEFAULT_MAC_WORKSPACE) return { cwd: DEFAULT_MAC_WORKSPACE, own: false };
  return { cwd: chatFolder(meta), own: true };
}

/**
 * Seatbelt sandbox for the shell commands of Mac chats; `POCKET_SANDBOX=off` turns it off. Commands skip the prompt only
 * in the chat's own folder: in a picked project the sandbox may write to its sources, which later run outside it.
 */
export function macSandbox(env: NodeJS.ProcessEnv = process.env, opts: { autoAllow?: boolean } = {}): Options['sandbox'] | undefined {
  if (/^(off|0|false|no)$/i.test(env.POCKET_SANDBOX ?? '')) return undefined;
  const extra = (env.POCKET_SANDBOX_DOMAINS ?? '').split(/[\s,]+/).filter(Boolean);
  return {
    enabled: true,
    // Without Seatbelt (not macOS, broken install) commands run as before, with a permission prompt each.
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: opts.autoAllow ?? true,
    allowUnsandboxedCommands: true,
    network: { allowedDomains: [...SANDBOX_DOMAINS, ...extra], allowLocalBinding: true },
  };
}

/**
 * The sandbox of an invited person's Mac chat: shell commands never leave it (no unsandboxed retry) and cannot read the
 * owner's documents, projects, keys or Claude settings; the person's own folder stays readable.
 */
export function guestSandbox(root: string, env: NodeJS.ProcessEnv = process.env): Options['sandbox'] {
  const home = homedir();
  const base = macSandbox(env) ?? { enabled: true, network: { allowedDomains: [...SANDBOX_DOMAINS], allowLocalBinding: true } };
  return {
    ...base,
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    // The person's folder is outside every hidden path, so it needs no allowRead (which slows Claude Code's start badly).
    filesystem: { denyRead: GUEST_HIDDEN.map((p) => join(home, p)).filter((p) => !insideRoot(root, p, p)) },
  };
}

/** Parts of the owner's home an invited person's commands may not read. */
const GUEST_HIDDEN = ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', '.pocket-claude', '.claude', '.ssh', '.gnupg', '.config', '.aws', '.netrc', '.gitconfig', '.zsh_history', '.bash_history', 'Library/Keychains', 'Library/Mail', 'Library/Messages', 'Library/Application Support', 'Library/Cookies'];

export const GUEST_PROMPT = [
  '# Your own workspace',
  "You work in this person's own part of the Mac. Your files, commands and edits stay inside it; the rest of the Mac belongs to its owner and is closed to you, so never try to look outside your folder.",
].join('\n');

export const SANDBOX_PROMPT = [
  '# Sandbox',
  'Shell commands run in a macOS sandbox (no approval needed in a chat folder under chats/; in a picked project or the shared workspace the user approves each command): they may write only inside your working directory and temp folders, and reach the network through a proxy where code hosts and package registries are open; any other host is asked on the user\'s phone.',
  'If a command really has to go outside (install something system-wide, change files elsewhere), rerun it with dangerouslyDisableSandbox: the user is asked first, so say why in one sentence.',
].join('\n');

function readNotes(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, NOTES_FILE), 'utf8').trim();
    if (!text) return null;
    return text.length > NOTES_LIMIT ? `${text.slice(0, NOTES_LIMIT)}\n…[cut: the file is longer; read it for the rest]` : text;
  } catch {
    return null;
  }
}

/** Files of the folder, two levels deep, folders marked with a slash; dot files and dependency folders skipped. */
export function listFolder(dir: string, max = LISTED_FILES): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${path}/`);
        if (depth < 1) walk(path, depth + 1);
      } else out.push(path);
    }
  };
  walk('', 0);
  return out;
}

/** What Claude is told about a chat's own folder: what it is for, what is in it, and its notes from earlier. */
export function ownFolderPrompt(dir: string): string {
  const files = listFolder(dir);
  const notes = readNotes(dir);
  return [
    "# This chat's own folder",
    `This chat has its own folder on the Mac, ${dir}; it is your working directory. Keep everything you make for this chat here: it stays between messages and restarts, and is kept even after the chat is deleted. Edits inside it need no approval.`,
    `Keep ${NOTES_FILE} in it as the chat's memory: what the user wants, decisions made, what each file is for, what is left. Update it, briefly, whenever something worth remembering changes; you get it back here every time this chat starts.`,
    `Files the user attaches are saved in ${ATTACHMENTS_DIR}/.`,
    files.length ? `Files here now:\n${files.map((f) => `- ${f}`).join('\n')}${files.length >= LISTED_FILES ? '\n- …' : ''}` : 'The folder is empty so far.',
    notes ? `## ${NOTES_FILE}\n${notes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
