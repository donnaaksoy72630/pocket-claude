import { describe, expect, it, vi } from 'vitest';
import { PermissionBroker, type PermissionHost } from '../src/permissions.js';

function makeHost(allowAlways: string[] = []) {
  const requests: { requestId: string; tool: string }[] = [];
  const resolved: { requestId: string; decision: string; by: string }[] = [];
  const waiting: [string, boolean][] = [];
  const host: PermissionHost = {
    isAllowedAlways: (t) => allowAlways.includes(t),
    request: (p) => requests.push({ requestId: p.requestId, tool: p.tool }),
    resolved: (requestId, _sessionId, decision, by) => resolved.push({ requestId, decision, by }),
    waiting: (s, w) => waiting.push([s, w]),
  };
  return { host, requests, resolved, waiting };
}

const signal = () => new AbortController().signal;

describe('PermissionBroker', () => {
  it('allows tools on the persistent allowlist without asking', async () => {
    const { host, requests } = makeHost(['run_command']);
    const r = await new PermissionBroker(host).decide('s1', 'run_command', { command: 'ls' }, signal());
    expect(r).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(requests).toHaveLength(0);
  });

  it('asks clients and applies the first answer only', async () => {
    const { host, requests, resolved, waiting } = makeHost();
    const broker = new PermissionBroker(host);
    const pending = broker.decide('s1', 'write_file', { path: 'a' }, signal());
    expect(requests).toHaveLength(1);
    const id = requests[0]!.requestId;
    expect(broker.respond(id, 'allow', 'phone')).toBe(true);
    expect(broker.respond(id, 'deny', 'panel')).toBe(false);
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect(resolved).toEqual([{ requestId: id, decision: 'allow', by: 'phone' }]);
    expect(waiting).toEqual([
      ['s1', true],
      ['s1', false],
    ]);
  });

  it('denies on deny', async () => {
    const { host, requests } = makeHost();
    const broker = new PermissionBroker(host);
    const pending = broker.decide('s1', 'run_command', {}, signal());
    broker.respond(requests[0]!.requestId, 'deny', 'phone');
    expect(await pending).toMatchObject({ behavior: 'deny' });
  });

  it('remembers allow_session for that session only', async () => {
    const { host, requests } = makeHost();
    const broker = new PermissionBroker(host);
    const first = broker.decide('s1', 'edit_file', {}, signal());
    broker.respond(requests[0]!.requestId, 'allow_session', 'phone');
    await first;
    expect(await broker.decide('s1', 'edit_file', {}, signal())).toMatchObject({ behavior: 'allow' });
    expect(requests).toHaveLength(1);
    void broker.decide('s2', 'edit_file', {}, signal());
    expect(requests).toHaveLength(2);
    broker.denyAll();
  });

  it('times out to deny', async () => {
    vi.useFakeTimers();
    try {
      const { host, resolved } = makeHost();
      const pending = new PermissionBroker(host, 1000).decide('s1', 'write_file', {}, signal());
      vi.advanceTimersByTime(1001);
      expect(await pending).toMatchObject({ behavior: 'deny' });
      expect(resolved[0]).toMatchObject({ decision: 'deny', by: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies when Claude aborts the request', async () => {
    const { host } = makeHost();
    const ac = new AbortController();
    const pending = new PermissionBroker(host).decide('s1', 'write_file', {}, ac.signal);
    ac.abort();
    expect(await pending).toMatchObject({ behavior: 'deny' });
  });

  it('kill switch denies everything outstanding', async () => {
    const { host } = makeHost();
    const broker = new PermissionBroker(host);
    const a = broker.decide('s1', 'write_file', {}, signal());
    const b = broker.decide('s2', 'run_command', {}, signal());
    expect(broker.outstanding()).toHaveLength(2);
    broker.denyAll();
    expect(await a).toMatchObject({ behavior: 'deny' });
    expect(await b).toMatchObject({ behavior: 'deny' });
    expect(broker.outstanding()).toHaveLength(0);
  });

  it('takes one allow for computer use as permission for the whole chat', async () => {
    const { host, requests } = makeHost();
    const broker = new PermissionBroker(host);
    const first = broker.decide('s1', 'computer', { action: 'screenshot' }, signal());
    broker.respond(requests[0]!.requestId, 'allow', 'voice');
    await first;
    expect(await broker.decide('s1', 'computer', { action: 'left_click' }, signal())).toMatchObject({ behavior: 'allow' });
    expect(requests).toHaveLength(1);
    void broker.decide('s2', 'computer', { action: 'screenshot' }, signal());
    expect(requests).toHaveLength(2);
    const once = broker.decide('s1', 'write_file', { path: 'a' }, signal());
    broker.respond(requests[2]!.requestId, 'allow', 'phone');
    await once;
    void broker.decide('s1', 'write_file', { path: 'b' }, signal());
    expect(requests).toHaveLength(4);
    broker.denyAll();
  });

  it('remembers network access for the chat per host, not for the whole network', async () => {
    const { host, requests } = makeHost();
    const broker = new PermissionBroker(host);
    const first = broker.decide('s1', 'SandboxNetworkAccess', { host: 'example.com' }, signal());
    broker.respond(requests[0]!.requestId, 'allow_session', 'phone');
    await first;
    expect(await broker.decide('s1', 'SandboxNetworkAccess', { host: 'EXAMPLE.com' }, signal())).toMatchObject({ behavior: 'allow' });
    expect(requests).toHaveLength(1);
    void broker.decide('s1', 'SandboxNetworkAccess', { host: 'other.example' }, signal());
    expect(requests).toHaveLength(2);
    broker.denyAll();
  });
});
