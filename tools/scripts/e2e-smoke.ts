/**
 * End-to-end smoke test with the real Claude Code CLI (uses the logged-in subscription, a cheap model).
 * relay (node) ← brain (this Mac) ← executor (temp dir standing in for the Windows workspace) ← test client.
 *
 *   pnpm tsx tools/scripts/e2e-smoke.ts [--model haiku] [--relay http://127.0.0.1:8787]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pocket-home-'));
process.env.POCKET_HOME = home;
process.env.POCKET_LOG_DIR = join(home, 'logs');
process.env.POCKET_NO_KEYCHAIN = '1';
const macWorkspace = mkdtempSync(join(tmpdir(), 'pocket-mac-ws-'));
process.env.POCKET_WORKSPACE = macWorkspace;

const { generateIdentity, parsePairingCode, parsePairingUri, serializeIdentity } = await import('../../packages/protocol/src/index.js');
const { DeviceLink, joinAccount } = await import('../../packages/transport/src/index.js');
const { startNodeRelay } = await import('../../apps/relay/src/node-server.js');
const { Brain } = await import('../../apps/brain/src/daemon.js');
const { ensureDirs } = await import('../../apps/brain/src/store.js');
const { chatFolder } = await import('../../apps/brain/src/sandbox.js');
const { logToStderr } = await import('../../apps/brain/src/log.js');
const { ToolDispatcher } = await import('../../apps/executor-extension/src/dispatch.js');
const { createPathGuard } = await import('../../apps/executor-extension/src/path-guard.js');

const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'haiku';
const claudePath = execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();

const workspace = mkdtempSync(join(tmpdir(), 'pocket-ws-'));
writeFileSync(join(workspace, 'README.md'), '# Demo project\n');
writeFileSync(join(workspace, 'main.py'), 'print("hello")\n');

const step = (s: string) => console.log(`\n▶ ${s}`);
const until = <T>(what: string, fn: (resolve: (v: T) => void) => void, ms = 180_000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms);
    fn((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });

ensureDirs();
logToStderr(process.argv.includes('--verbose'));
const externalRelay = process.argv.includes('--relay') ? process.argv[process.argv.indexOf('--relay') + 1] : undefined;
const relay = externalRelay ? { url: externalRelay, close: async () => {} } : await startNodeRelay({ port: 0 });
step(`relay ${relay.url}`);

const brain = new Brain(
  generateIdentity(),
  { relayUrl: relay.url, devices: [], users: [], allowlist: [], sessions: [], replay: {} },
  { persist: false, claudeOptions: { pathToClaudeCodeExecutable: claudePath, model } },
);
brain.start();
await until('brain ready', (ok) => {
  const t = setInterval(() => brain.status().relayConnected && (clearInterval(t), ok(undefined)), 50);
});

const ticket = brain.startPairing();
const { code } = parsePairingUri(ticket.uri);
step(`pairing code ${ticket.code}, safety ${ticket.safetyNumber}`);

const exec = await joinAccount({
  relayUrl: relay.url,
  code,
  role: 'executor',
  name: 'fake-windows',
  confirmSafetyNumber: async (n) => n === ticket.safetyNumber,
});
const execLink = new DeviceLink({
  relayUrl: relay.url,
  accountId: exec.bundle.accountId,
  deviceId: exec.deviceId,
  role: 'executor',
  identity: exec.identity,
  peers: { [exec.bundle.brainDeviceId]: exec.bundle.brainEncPub },
});
const dispatcher = new ToolDispatcher({
  brainDeviceId: exec.bundle.brainDeviceId,
  send: (body) => execLink.send(exec.bundle.brainDeviceId, body),
  createContext: (signal, onOutput) => ({
    guard: createPathGuard([workspace]),
    roots: [workspace],
    signal,
    onOutput,
    platform: process.platform,
  }),
});
const toolCalls: string[] = [];
execLink.on('message', (m) => {
  if (m.message.type === 'tool.call') toolCalls.push(m.message.payload.name);
  dispatcher.handle(m);
});
execLink.on('ready', () =>
  execLink.send(exec.bundle.brainDeviceId, { type: 'executor.status', payload: { workspaces: [workspace], os: 'fake-win32', shell: 'sh' } }),
);
execLink.connect();
step(`executor paired ${exec.deviceId}`);

const client = await joinAccount({ relayUrl: relay.url, code, role: 'client', name: 'test-phone' });
const clientLink = new DeviceLink({
  relayUrl: relay.url,
  accountId: client.bundle.accountId,
  deviceId: client.deviceId,
  role: 'client',
  identity: client.identity,
  peers: { [client.bundle.brainDeviceId]: client.bundle.brainEncPub },
});
const brainId = client.bundle.brainDeviceId;
let text = '';
const events: string[] = [];
const toolNames: string[] = [];
let seenAgents: string[] = [];
let seenSubagentTool = false;
let onResult: (() => void) | null = null;
clientLink.on('message', ({ message }) => {
  if (message.type === 'session.event') {
    const e = message.payload.event;
    events.push(e.kind);
    if (e.kind === 'text_delta') {
      text += e.text;
      process.stdout.write(e.text);
    }
    if (e.kind === 'tool_use') {
      toolNames.push(e.name);
      console.log(`\n  [tool_use] ${e.name} ${JSON.stringify(e.input).slice(0, 200)}`);
    }
    if (e.kind === 'tool_result') console.log(`  [tool_result${e.isError ? ' ERROR' : ''}] ${e.content.slice(0, 160).replace(/\n/g, ' ⏎ ')}`);
    if (e.kind === 'error') console.log(`\n  [error] ${e.message}`);
    if (e.kind === 'result') {
      console.log(`\n  [result] ${e.durationMs}ms, $${e.costUsd?.toFixed(4)}`);
      onResult?.();
    }
  }
  if (message.type === 'activity.result') {
    for (const sess of message.payload.sessions) {
      if (sess.agents?.length) seenAgents = sess.agents.map((a) => `${a.type ?? 'agent'}: ${a.description}`);
      if (sess.runningTools.some((t) => t.parentId)) seenSubagentTool = true;
    }
  }
  if (message.type === 'permission.request') {
    console.log(`\n  [permission] ${message.payload.tool} → allow`);
    clientLink.send(brainId, { type: 'permission.respond', payload: { requestId: message.payload.requestId, decision: 'allow' } });
  }
});
const created = until<string>('session.created', (ok) =>
  clientLink.on('message', ({ message }) => message.type === 'session.created' && ok(message.payload.session.sessionId)),
);
await until('client ready', (ok) => {
  clientLink.on('ready', () => ok(undefined));
  clientLink.connect();
});
await until('executor online at brain', (ok) => {
  const t = setInterval(() => brain.status().executorOnline && brain.status().workspaces.length && (clearInterval(t), ok(undefined)), 50);
});
step('client paired, creating session');
clientLink.send(brainId, { type: 'session.create', payload: { title: 'smoke' } });
const sessionId = await created;
clientLink.send(brainId, { type: 'computer.select', payload: { deviceId: exec.deviceId, sessionId } });

const ask = async (prompt: string, sid = sessionId, attachments?: { mime: string; dataBase64: string; name?: string }[]) => {
  step(`ask: ${prompt}`);
  text = '';
  const done = until('result', (ok) => (onResult = () => ok(undefined)));
  clientLink.send(brainId, { type: 'message.send', payload: { sessionId: sid, text: prompt, ...(attachments ? { attachments } : {}) } });
  await done;
};

let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed = true;
};

try {
  await ask('List the files in the workspace root, then reply with just the file names separated by commas.');
  check(toolCalls.some((t) => ['list_dir', 'glob'].includes(t)), `listing ran on the executor (calls: ${toolCalls.join(', ')})`);
  check(/README\.md/.test(text) && /main\.py/.test(text), 'reply names README.md and main.py');

  await ask('Create a file named hello.txt in the workspace root containing exactly: hi from claude');
  check(toolCalls.includes('write_file'), 'write_file ran on the executor after permission');
  const hello = join(workspace, 'hello.txt');
  check(existsSync(hello) && readFileSync(hello, 'utf8').trim() === 'hi from claude', 'hello.txt created in the executor workspace');
  check(!existsSync(join(home, 'work', sessionId, 'hello.txt')), 'nothing written on the brain side');
  check(events.includes('state'), 'state events delivered');

  const before = toolCalls.length;
  const poll = setInterval(() => clientLink.send(brainId, { type: 'activity.get', payload: {} }), 300);
  await ask('Use the Agent tool to start one subagent that reads main.py and reports its first line. Then reply with that line.');
  check(toolNames.includes('Agent'), 'Agent tool used for a subagent');
  if (!/print/.test(text)) {
    step('waiting for the background subagent to report back');
    await until('subagent report', (ok) => (onResult = () => /print/.test(text) && ok(undefined)), 180_000).catch(() => {});
  }
  check(toolCalls.slice(before).includes('read_file'), `subagent read the file on the executor (calls: ${toolCalls.slice(before).join(', ')})`);
  check(/print/.test(text), 'reply contains the first line of main.py');
  clearInterval(poll);
  check(seenAgents.length > 0, `activity listed the subagent (${seenAgents.join('; ')})`);
  console.log(`  subagent tool seen in activity: ${seenSubagentTool}`);

  await ask(
    'Run this with Bash and run_in_background set to true: node -e "let i=0;setInterval(()=>console.log(i++),200)". Then call BashOutput once with wait_ms 1500, then stop it with KillShell. Reply with the numbers you saw.',
  );
  check(toolCalls.includes('command_output'), 'background output read on the executor');
  check(toolCalls.includes('command_kill'), 'background command stopped on the executor');

  step('adding a second computer with a code requested from the phone');
  const ticket2 = until<{ code: string; safetyNumber: string }>('computer.pairing', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'computer.pairing' && ok(message.payload)),
  );
  clientLink.send(brainId, { type: 'computer.pair', payload: {} });
  const t2 = await ticket2;
  const workspace2 = mkdtempSync(join(tmpdir(), 'pocket-ws2-'));
  writeFileSync(join(workspace2, 'second.txt'), 'on the second computer\n');
  const exec2 = await joinAccount({ relayUrl: relay.url, code: parsePairingCode(t2.code), role: 'executor', name: 'fake-windows-2', confirmSafetyNumber: async (n) => n === t2.safetyNumber });
  const exec2Link = new DeviceLink({
    relayUrl: relay.url,
    accountId: exec2.bundle.accountId,
    deviceId: exec2.deviceId,
    role: 'executor',
    identity: exec2.identity,
    peers: { [exec2.bundle.brainDeviceId]: exec2.bundle.brainEncPub },
  });
  const calls2: string[] = [];
  const dispatcher2 = new ToolDispatcher({
    brainDeviceId: exec2.bundle.brainDeviceId,
    send: (body) => exec2Link.send(exec2.bundle.brainDeviceId, body),
    createContext: (signal, onOutput, root) => {
      const roots = [root ?? workspace2];
      return { guard: createPathGuard(roots), roots, signal, onOutput, platform: process.platform };
    },
  });
  exec2Link.on('message', (m) => {
    if (m.message.type === 'tool.call') calls2.push(m.message.payload.name);
    dispatcher2.handle(m);
  });
  const computers = until<number>('two computers', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'computers.result' && message.payload.computers.filter((c) => c.online).length === 2 && ok(2)),
  );
  exec2Link.on('ready', () => exec2Link.send(exec2.bundle.brainDeviceId, { type: 'executor.status', payload: { workspaces: [workspace2], os: 'win32 test', shell: 'sh' } }));
  exec2Link.connect();
  await computers;
  check(brain.status().devices.filter((d) => d.role === 'executor').length === 2, 'both computers stay paired');

  clientLink.send(brainId, { type: 'computer.select', payload: { deviceId: exec2.deviceId, sessionId } });
  const firstCalls = toolCalls.length;
  await ask('List the files in the workspace root and reply with just the names.');
  check(calls2.length > 0 && toolCalls.length === firstCalls, `the chat now works on the second computer (calls there: ${calls2.join(', ')})`);
  check(/second\.txt/.test(text), 'reply names the file from the second computer');

  const project = join(workspace2, 'inner-project');
  mkdirSync(project);
  writeFileSync(join(project, 'inner.txt'), 'inside the project\n');
  clientLink.send(brainId, { type: 'computer.select', payload: { deviceId: exec2.deviceId, sessionId, project } });
  await ask('List the files in the workspace root again and reply with just the names.');
  check(/inner\.txt/.test(text) && !/second\.txt/.test(text), 'the chat works inside the picked project folder');
  exec2Link.close();

  step('a new chat works on the Mac by default, in its own folder');
  const macCreated = until<{ sessionId: string; createdAt: number }>('mac session', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'session.created' && message.payload.session.sessionId !== sessionId && ok(message.payload.session)),
  );
  clientLink.send(brainId, { type: 'session.create', payload: { title: 'mac' } });
  const macMeta = await macCreated;
  const macSession = macMeta.sessionId;
  const macFolder = chatFolder(macMeta);
  mkdirSync(macFolder, { recursive: true });
  writeFileSync(join(macFolder, 'mac-note.txt'), 'the answer is 42\n');
  const execCallsBefore = toolCalls.length + calls2.length;
  await ask('Read mac-note.txt in the current directory and reply with just the number in it.', macSession);
  check(/42/.test(text), 'Claude read a file in the Mac workspace');
  check(toolCalls.length + calls2.length === execCallsBefore, 'nothing was sent to the computers');

  await ask('What does the attached file say? Reply with just its content.', macSession, [
    { mime: 'text/plain', name: 'from-pc.txt', dataBase64: Buffer.from('purple elephant').toString('base64') },
  ]);
  check(/purple elephant/i.test(text), 'Claude read a file attached from the phone');
  check(existsSync(join(macFolder, 'attachments', 'from-pc.txt')), "attachment saved in the chat's folder on the Mac");

  step('clipboard: a computer that only shares its clipboard');
  const { ClipboardAgent } = await import('../../apps/clipboard-agent/src/agent.js');
  const clipTicket = until<{ code: string; safetyNumber: string }>('clip pairing', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'computer.pairing' && ok(message.payload)),
  );
  clientLink.send(brainId, { type: 'computer.pair', payload: {} });
  const ct = await clipTicket;
  const clipJoined = await joinAccount({ relayUrl: relay.url, code: parsePairingCode(ct.code), role: 'executor', name: 'clip-pc', confirmSafetyNumber: async (n) => n === ct.safetyNumber });
  let pcClipboard: { kind: string; text?: string } = { kind: 'text', text: 'copied on windows' };
  const agent = new ClipboardAgent(
    {
      relayUrl: relay.url,
      accountId: clipJoined.bundle.accountId,
      brainDeviceId: clipJoined.bundle.brainDeviceId,
      brainEncPub: clipJoined.bundle.brainEncPub,
      deviceId: clipJoined.deviceId,
      identity: serializeIdentity(clipJoined.identity),
      replay: {},
    },
    {
      clipboard: {
        read: async () => [pcClipboard as { kind: 'text'; text: string }],
        write: async (item) => {
          pcClipboard = item as typeof pcClipboard;
        },
      },
      log: () => {},
      onRelayMoved: () => {},
    },
  );
  const clipOnline = until('clip online', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'computers.result' && message.payload.computers.some((c) => c.deviceId === clipJoined.deviceId && c.online && c.capabilities?.includes('clipboard')) && ok(undefined)),
  );
  agent.connect();
  await clipOnline;
  const got = until<{ items?: { kind: string; text?: string }[] }>('clipboard.result', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'clipboard.result' && message.payload.requestId === 'r1' && ok(message.payload)),
  );
  clientLink.send(brainId, { type: 'clipboard.get', payload: { requestId: 'r1', deviceId: clipJoined.deviceId } });
  check((await got).items?.[0]?.text === 'copied on windows', 'phone got the PC clipboard through the Mac');
  const wrote = until<{ error?: string }>('clipboard.written', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'clipboard.written' && message.payload.requestId === 'r2' && ok(message.payload)),
  );
  clientLink.send(brainId, { type: 'clipboard.set', payload: { requestId: 'r2', deviceId: clipJoined.deviceId, item: { kind: 'text', text: 'reply from claude' } } });
  check(!(await wrote).error && pcClipboard.text === 'reply from claude', 'phone put text on the PC clipboard');
  agent.close();

  step('deleting the chat');
  const deleted = until('session.deleted', (ok) =>
    clientLink.on('message', ({ message }) => message.type === 'session.deleted' && message.payload.sessionId === sessionId && ok(undefined)),
  );
  clientLink.send(brainId, { type: 'session.delete', payload: { sessionId } });
  await deleted;
  check(!brain.status().sessions.some((s) => s.sessionId === sessionId), 'chat removed on the Mac');
  check(!existsSync(join(home, 'sessions', `${sessionId}.jsonl`)), 'chat history file erased');
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  brain.stop();
  execLink.close();
  clientLink.close();
  await relay.close();
  console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
  process.exit(failed ? 1 : 0);
}
