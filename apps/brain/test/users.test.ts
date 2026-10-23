import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InnerMessage, InnerMessageBody, PairingCode } from '@pocket/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'pocket-users-'));
process.env.POCKET_HOME = home;
process.env.POCKET_LOG_DIR = join(home, 'logs');
process.env.POCKET_NO_KEYCHAIN = '1';

const { generateIdentity, MAC_DEVICE_ID, parsePairingCode, parsePairingUri } = await import('@pocket/protocol');
const { DeviceLink, joinAccount } = await import('@pocket/transport');
const { startNodeRelay } = await import('../../relay/src/node-server.js');
const { Brain } = await import('../src/daemon.js');
const { ensureDirs, OWNER_ID } = await import('../src/store.js');

type Relay = Awaited<ReturnType<typeof startNodeRelay>>;
type Link = InstanceType<typeof DeviceLink>;

let relay: Relay;
let brain: InstanceType<typeof Brain>;
const links: Link[] = [];

const until = <T>(what: string, fn: (resolve: (v: T) => void) => void, ms = 10_000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms);
    fn((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });

/** The brain publishes a code over its WebSocket; under load the HTTP lookup can get to the relay first. */
async function joinWhenPublished(opts: Parameters<typeof joinAccount>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await joinAccount(opts);
    } catch (e) {
      if (attempt >= 20 || !/not found/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function connect(code: PairingCode, role: 'executor' | 'client', name: string, userName?: string) {
  const joined = await joinWhenPublished({ relayUrl: relay.url, code, role, name, userName });
  const link = new DeviceLink({
    relayUrl: relay.url,
    accountId: joined.bundle.accountId,
    deviceId: joined.deviceId,
    role,
    identity: joined.identity,
    peers: { [joined.bundle.brainDeviceId]: joined.bundle.brainEncPub },
  });
  links.push(link);
  const inbox: InnerMessage[] = [];
  const waiters: { match: (m: InnerMessage) => boolean; resolve: (m: InnerMessage) => void }[] = [];
  link.on('message', ({ message }) => {
    inbox.push(message);
    for (const w of waiters.splice(0)) {
      if (w.match(message)) w.resolve(message);
      else waiters.push(w);
    }
  });
  const ready = until<void>(`${name} ready`, (ok) => link.on('ready', () => ok()));
  link.connect();
  await ready;
  const brainId = joined.bundle.brainDeviceId;
  /** The first message of the type after `after` (an inbox index) that also passes `test`. */
  const next = <T extends InnerMessage['type']>(type: T, after = 0, test: (m: Extract<InnerMessage, { type: T }>) => boolean = () => true) =>
    until<Extract<InnerMessage, { type: T }>>(`${name} ← ${type}`, (resolve) => {
      const matches = (m: InnerMessage) => m.type === type && test(m as Extract<InnerMessage, { type: T }>);
      const hit = inbox.slice(after).find(matches);
      if (hit) resolve(hit as Extract<InnerMessage, { type: T }>);
      else waiters.push({ match: matches, resolve: (m) => resolve(m as Extract<InnerMessage, { type: T }>) });
    });
  return {
    deviceId: joined.deviceId,
    send: (body: InnerMessageBody) => link.send(brainId, body),
    inbox,
    next,
    /** Sends a request and returns the first reply of the given type that arrives after it. */
    ask: <T extends InnerMessage['type']>(body: InnerMessageBody, type: T) => {
      const mark = inbox.length;
      link.send(brainId, body);
      return next(type, mark);
    },
  };
}

beforeAll(async () => {
  ensureDirs();
  relay = await startNodeRelay({ port: 0 });
  brain = new Brain(generateIdentity(), { relayUrl: relay.url, devices: [], users: [], allowlist: [], sessions: [], replay: {} }, { persist: false });
  brain.start();
  await until<void>('brain ready', (ok) => {
    const t = setInterval(() => brain.status().relayConnected && (clearInterval(t), ok()), 25);
  });
});

afterAll(async () => {
  for (const l of links) l.close();
  brain.stop();
  await relay.close();
});

describe('people', () => {
  it('keeps each person to their own chats, computers and the Mac', async () => {
    const owner = await connect(parsePairingUri(brain.startPairing().uri).code, 'client', 'owner-phone');
    const invite = brain.startPairing(undefined, { invite: {} });
    expect(invite.invite).toBe(true);
    expect(parsePairingUri(invite.uri).invite).toBe(true);
    const masha = await connect(parsePairingUri(invite.uri).code, 'client', 'masha-phone', 'Masha');
    expect(brain.users().map((u) => [u.name, u.owner === true, u.devices.length])).toEqual([[expect.any(String), true, 1], ['Masha', false, 1]]);

    // Each client learns who it is; only the owner gets the Mac as a place to work.
    const ownerStatus = await owner.ask({ type: 'status.get', payload: {} }, 'host.status');
    expect(ownerStatus.payload.user).toEqual({ id: OWNER_ID, name: expect.any(String), owner: true });
    const mashaStatus = await masha.ask({ type: 'status.get', payload: {} }, 'host.status');
    expect(mashaStatus.payload.user).toEqual({ id: expect.any(String), name: 'Masha', owner: false });
    const mashaId = mashaStatus.payload.user!.id;
    expect((await owner.ask({ type: 'computers.get', payload: {} }, 'computers.result')).payload.mac).toBeDefined();
    expect((await masha.ask({ type: 'computers.get', payload: {} }, 'computers.result')).payload.mac).toBeUndefined();

    // Chats are private.
    const created = await owner.ask({ type: 'session.create', payload: { title: 'Owner chat' } }, 'session.created');
    const ownerSession = created.payload.session.sessionId;
    expect(created.payload.session.userId).toBe(OWNER_ID);
    expect((await masha.ask({ type: 'session.list', payload: {} }, 'session.list.result')).payload.sessions).toEqual([]);
    expect((await masha.ask({ type: 'session.history', payload: { sessionId: ownerSession } }, 'error')).payload.code).toBe('unknown_session');
    expect((await owner.ask({ type: 'session.list', payload: {} }, 'session.list.result')).payload.sessions.map((s) => s.sessionId)).toEqual([ownerSession]);
    const mashaCreated = await masha.ask({ type: 'session.create', payload: { title: 'Masha chat' } }, 'session.created');
    expect(mashaCreated.payload.session.userId).toBe(mashaId);
    expect(owner.inbox.filter((m) => m.type === 'session.created').map((m) => m.type === 'session.created' && m.payload.session.title)).toEqual(['Owner chat']);

    // Without a tools computer of her own, Masha's chats run in chat-only mode: never with the Mac's files.
    const mashaSession = mashaCreated.payload.session.sessionId;
    expect(brain.sessionMode(ownerSession)).toEqual({ mode: 'mac' });
    expect(brain.sessionMode(mashaSession)).toEqual({ mode: 'chat' });
    expect((await masha.ask({ type: 'computer.select', payload: { deviceId: MAC_DEVICE_ID } }, 'error')).payload.code).toBe('not_owner');
    expect((await masha.ask({ type: 'user.invite', payload: {} }, 'error')).payload.code).toBe('not_owner');

    // A computer paired with a code from Masha's phone is hers alone.
    const pairing = await masha.ask({ type: 'computer.pair', payload: {} }, 'computer.pairing');
    const pc = await connect(parsePairingCode(pairing.payload.code), 'executor', 'masha-pc');
    pc.send({ type: 'executor.status', payload: { workspaces: ['C:\\\\work'], os: 'win32', shell: 'pwsh', capabilities: ['tools'] } });
    // The brain sends the list when the computer comes online and again on its status: wait for the one with tools.
    const withTools = (m: { payload: { computers: { name: string; capabilities?: string[] }[] } }) => m.payload.computers.some((c) => c.capabilities?.includes('tools'));
    const mashaComputers = await masha.next('computers.result', 0, withTools);
    expect(mashaComputers.payload.computers.map((c) => c.name)).toEqual(['masha-pc']);
    expect(brain.sessionMode(mashaSession)).toEqual({ mode: 'remote', executorId: pc.deviceId });
    // A PocketClipboard-only laptop keeps the chat in chat-only mode but gives the pc_* tools a target.
    const clipPairing = await masha.ask({ type: 'computer.pair', payload: {} }, 'computer.pairing');
    const laptop = await connect(parsePairingCode(clipPairing.payload.code), 'executor', 'masha-laptop');
    laptop.send({ type: 'executor.status', payload: { workspaces: [], os: 'win32', shell: 'none', capabilities: ['clipboard', 'screenshot'] } });
    await masha.next('computers.result', 0, (m) => m.payload.computers.some((c) => c.name === 'masha-laptop' && c.capabilities?.includes('screenshot') === true));
    expect(brain.sessionMode(mashaSession)).toEqual({ mode: 'remote', executorId: pc.deviceId, pcId: laptop.deviceId });
    await masha.ask({ type: 'computer.select', payload: { deviceId: laptop.deviceId, sessionId: mashaSession } }, 'computers.result');
    expect(brain.sessionMode(mashaSession)).toEqual({ mode: 'remote', executorId: pc.deviceId, pcId: laptop.deviceId });

    // Screenshots and the clipboard go to that laptop and come back to the phone that asked.
    const shot = masha.ask({ type: 'screen.get', payload: { requestId: 's1', deviceId: laptop.deviceId } }, 'screen.result');
    const capture = await laptop.next('screen.capture');
    expect(capture.payload.requestId).toBe('s1');
    laptop.send({ type: 'screen.image', payload: { requestId: 's1', image: { mime: 'image/jpeg', dataBase64: 'AAAA', width: 16, height: 9 } } });
    expect((await shot).payload).toEqual({ requestId: 's1', deviceId: laptop.deviceId, image: { mime: 'image/jpeg', dataBase64: 'AAAA', width: 16, height: 9 } });
    expect((await owner.ask({ type: 'screen.get', payload: { requestId: 's2', deviceId: laptop.deviceId } }, 'screen.result')).payload.error).toMatch(/not paired/);
    expect((await owner.ask({ type: 'computers.get', payload: {} }, 'computers.result')).payload.computers).toEqual([]);
    expect((await owner.ask({ type: 'computer.select', payload: { deviceId: pc.deviceId } }, 'error')).payload.code).toBe('unknown_computer');
    expect((await owner.ask({ type: 'clipboard.get', payload: { requestId: 'r1', deviceId: pc.deviceId } }, 'clipboard.result')).payload.error).toMatch(/not paired/);
    expect(brain.users().find((u) => u.id === mashaId)?.devices.map((d) => d.name)).toEqual(['masha-phone', 'masha-pc', 'masha-laptop']);

    // The owner's invite link from the phone registers people too.
    const invitation = await owner.ask({ type: 'user.invite', payload: {} }, 'user.invitation');
    const petya = await connect(parsePairingUri(invitation.payload.uri).code, 'client', 'petya-phone', 'Petya');
    expect((await petya.ask({ type: 'status.get', payload: {} }, 'host.status')).payload.user?.name).toBe('Petya');

    // Removing a person takes their devices and chats with them.
    expect(brain.removeUser('masha')).toBe(true);
    expect(brain.removeUser('owner')).toBe(false);
    expect(brain.users().map((u) => u.name)).toEqual([expect.any(String), 'Petya']);
    expect(brain.status().devices.map((d) => d.name)).toEqual(['owner-phone', 'petya-phone']);
    expect(brain.status().sessions.map((s) => s.title)).toEqual(['Owner chat']);
  });
});
