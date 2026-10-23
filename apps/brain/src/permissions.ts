import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { newMessageId, type PermissionDecision } from '@pocket/protocol';

export const PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** The pseudo tool Claude Code asks about when a sandboxed command wants a host outside the allow list; input `{ host }`. */
export const SANDBOX_NETWORK_TOOL = 'SandboxNetworkAccess';

/** What "allow for this chat" remembers: the tool, or for network access just that one host. */
export function allowKey(toolName: string, input: Record<string, unknown>): string {
  return toolName === SANDBOX_NETWORK_TOOL && typeof input.host === 'string' ? `${toolName}:${input.host.toLowerCase()}` : toolName;
}

interface Pending {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  expiresAt: number;
  resolve: (d: PermissionDecision | 'timeout' | 'cancelled') => void;
}

export interface PermissionHost {
  isAllowedAlways(toolName: string, input: Record<string, unknown>): boolean;
  request(p: { requestId: string; sessionId: string; tool: string; input: unknown; expiresAt: number }): void;
  resolved(requestId: string, sessionId: string, decision: PermissionDecision, by: string): void;
  waiting(sessionId: string, waiting: boolean): void;
}

/** Routes Claude Code permission prompts to every client; the first answer wins. */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly sessionAllow = new Map<string, Set<string>>();

  constructor(
    private readonly host: PermissionHost,
    private readonly timeoutMs = PERMISSION_TIMEOUT_MS,
  ) {}

  async decide(sessionId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    if (this.host.isAllowedAlways(toolName, input) || this.sessionAllow.get(sessionId)?.has(allowKey(toolName, input))) {
      return { behavior: 'allow', updatedInput: input };
    }
    const requestId = newMessageId();
    const expiresAt = Date.now() + this.timeoutMs;
    const decision = await new Promise<PermissionDecision | 'timeout' | 'cancelled'>((resolve) => {
      const timer = setTimeout(() => finish('timeout'), this.timeoutMs);
      const onAbort = () => finish('cancelled');
      const finish = (d: PermissionDecision | 'timeout' | 'cancelled') => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (![...this.pending.values()].some((p) => p.sessionId === sessionId)) this.host.waiting(sessionId, false);
        resolve(d);
      };
      this.pending.set(requestId, { sessionId, toolName, input, expiresAt, resolve: finish });
      signal.addEventListener('abort', onAbort, { once: true });
      this.host.waiting(sessionId, true);
      this.host.request({ requestId, sessionId, tool: toolName, input, expiresAt });
    });

    if (decision === 'timeout' || decision === 'cancelled') {
      this.host.resolved(requestId, sessionId, 'deny', decision);
      return { behavior: 'deny', message: decision === 'timeout' ? 'The user did not answer in time.' : 'Cancelled.' };
    }
    if (decision === 'deny') return { behavior: 'deny', message: 'The user denied this action.' };
    if (decision === 'allow_session') {
      const set = this.sessionAllow.get(sessionId) ?? new Set<string>();
      set.add(allowKey(toolName, input));
      this.sessionAllow.set(sessionId, set);
    }
    return { behavior: 'allow', updatedInput: input };
  }

  /** Returns false if the request is unknown or already answered (a second client answering late). */
  respond(requestId: string, decision: PermissionDecision, by: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.resolve(decision);
    this.host.resolved(requestId, p.sessionId, decision, by);
    return true;
  }

  outstanding(): { requestId: string; sessionId: string; tool: string; input: unknown; expiresAt: number }[] {
    return [...this.pending.entries()].map(([requestId, p]) => ({
      requestId,
      sessionId: p.sessionId,
      tool: p.toolName,
      input: p.input,
      expiresAt: p.expiresAt,
    }));
  }

  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, 'deny', 'kill-switch');
  }
}
