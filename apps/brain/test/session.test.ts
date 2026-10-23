import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionMeta } from '@pocket/protocol';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const base = `${process.env.TMPDIR ?? '/tmp'}/pocket-session-test-${process.pid}`;
  process.env.POCKET_HOME = `${base}/home`;
  process.env.POCKET_WORKSPACE = `${base}/workspace`;
  process.env.POCKET_SKILLS_DIR = `${base}/no-skills`;
  return { base, home: `${base}/home`, workspace: `${base}/workspace` };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importActual) => ({ ...(await importActual<object>()), query: vi.fn() }));

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { Session } = await import('../src/session.js');
type Host = ConstructorParameters<typeof Session>[1];

/** Stands in for the Claude Code process: the test pushes the messages it would stream. */
class FakeQuery {
  readonly setModel = vi.fn(async (_model?: string) => {});
  readonly applyFlagSettings = vi.fn(async (_settings: Record<string, unknown>) => {});
  readonly supportedModels = vi.fn(async () => [{ value: 'fable', displayName: 'Fable', description: 'Deepest', supportedEffortLevels: ['low', 'high', 'max'] }]);
  readonly interrupt = vi.fn(async () => undefined);
  private readonly queue: SDKMessage[] = [];
  private waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null;

  constructor(readonly options: Options) {}

  push(msg: Record<string, unknown>): void {
    const m = msg as unknown as SDKMessage;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
    } else this.queue.push(m);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

const RESULT = { type: 'result', subtype: 'success', duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
const settle = () => new Promise((r) => setTimeout(r, 10));

let fake: FakeQuery;
const metas: SessionMeta[] = [];

function host(over: Partial<Host> = {}): Host {
  return {
    executorFor: () => ({ id: undefined, online: false, info: null, root: undefined, call: async () => ({ content: '', isError: true }) }),
    pcFor: () => ({ id: undefined, name: undefined, online: false, capabilities: [], clipboardRead: async () => ({}), clipboardWrite: async () => ({}), screenshot: async () => ({}) }),
    chatOnly: () => false,
    userName: () => 'Owner',
    emit: () => {},
    metaChanged: (m) => void metas.push(m),
    canUseTool: async (_s, _t, input) => ({ behavior: 'allow', updatedInput: input }),
    claudeOptions: () => ({}),
    onClaudeVersion: () => {},
    ...over,
  };
}

function newSession(id = 'aaaaaaaa-1111-2222-3333-444444444444') {
  const now = Date.UTC(2026, 9, 23, 12);
  return new Session({ sessionId: id, title: 'Test', state: 'idle', createdAt: now, updatedAt: now, userId: 'owner' }, host(), false);
}

beforeEach(() => {
  metas.length = 0;
  mkdirSync(join(dirs.home, 'sessions'), { recursive: true });
  vi.mocked(query).mockImplementation(({ options }) => {
    fake = new FakeQuery(options ?? {});
    return fake as unknown as Query;
  });
});

afterAll(() => rmSync(dirs.base, { recursive: true, force: true }));

describe('Claude switching its own model', () => {
  it('gets the chat_* tools in the Mac prompt and allow list', async () => {
    const s = newSession();
    await s.send({ text: 'hi', from: 'phone' });
    expect(fake.options.allowedTools).toEqual(expect.arrayContaining(['mcp__pocket__chat_models', 'mcp__pocket__chat_configure']));
    expect(JSON.stringify(fake.options.systemPrompt)).toMatch(/chat_configure/);
    s.stop();
  });

  it('shows the change at once and applies it to the live process only after the turn', async () => {
    const s = newSession();
    await s.send({ text: 'switch to Fable and think at maximum', from: 'phone' });
    expect(s.meta.state).toBe('running');

    s.configureAfterTurn({ model: 'fable', effort: 'max' });
    expect(s.meta).toMatchObject({ model: 'fable', effort: 'max' });
    expect(metas.at(-1)).toMatchObject({ model: 'fable', effort: 'max' });
    await settle();
    expect(fake.setModel).not.toHaveBeenCalled();
    expect(fake.applyFlagSettings).not.toHaveBeenCalled();

    fake.push(RESULT);
    await settle();
    expect(fake.setModel).toHaveBeenCalledWith('fable');
    expect(fake.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });
    s.stop();
  });

  it('starts the next process with the new model when the old one stopped first', async () => {
    const s = newSession('bbbbbbbb-1111-2222-3333-444444444444');
    await s.send({ text: 'use Fable', from: 'phone' });
    s.configureAfterTurn({ model: 'fable' });
    s.stop();
    const first = fake;
    await s.send({ text: 'again', from: 'phone' });
    expect(fake).not.toBe(first);
    expect(fake.options.model).toBe('fable');
    expect(first.setModel).not.toHaveBeenCalled();
    s.stop();
  });
});
