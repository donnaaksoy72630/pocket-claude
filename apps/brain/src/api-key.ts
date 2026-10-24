import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './store.js';

/**
 * The owner's Anthropic API key for chats switched to API billing. Kept only in this file (mode 600), never in state,
 * logs or events; Claude Code gets it as ANTHROPIC_API_KEY and talks to api.anthropic.com with it directly.
 */
const file = () => join(paths.home, 'anthropic-api-key');

export function readApiKey(): string | undefined {
  try {
    return readFileSync(file(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveApiKey(key: string): void {
  const k = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error('This does not look like an Anthropic API key (sk-ant-…).');
  writeFileSync(file(), `${k}\n`, { mode: 0o600 });
  chmodSync(file(), 0o600);
}

export function removeApiKey(): void {
  rmSync(file(), { force: true });
}

/** Enough to tell keys apart, never enough to use one. */
export function maskApiKey(key: string): string {
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

/**
 * A long-lived Claude subscription token from `claude setup-token`. Chats on the subscription use it instead of the
 * login in the keychain, whose short token many Claude Code processes refresh at once and can lose in the race.
 */
const tokenFile = () => join(paths.home, 'claude-oauth-token');

export function readClaudeToken(): string | undefined {
  try {
    return readFileSync(tokenFile(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveClaudeToken(token: string): void {
  const t = token.trim();
  if (!/^sk-ant-oat[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('This does not look like a token from `claude setup-token` (sk-ant-oat…).');
  writeFileSync(tokenFile(), `${t}\n`, { mode: 0o600 });
  chmodSync(tokenFile(), 0o600);
}

export function removeClaudeToken(): void {
  rmSync(tokenFile(), { force: true });
}
