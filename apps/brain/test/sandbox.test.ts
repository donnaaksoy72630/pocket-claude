import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMeta } from '@pocket/protocol';
import { afterAll, describe, expect, it, vi } from 'vitest';

const base = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/pocket-sandbox-test-${process.pid}`;
  process.env.POCKET_WORKSPACE = `${dir}/workspace`;
  return dir;
});

const { chatFolder, DEFAULT_MAC_WORKSPACE, listFolder, macSandbox, macWorkspaceFor, ownFolderPrompt, SANDBOX_DOMAINS } = await import('../src/sandbox.js');

const created = Date.UTC(2026, 9, 23, 9, 30);
const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({ sessionId: 'abcdef12-3456', title: 't', state: 'idle', createdAt: created, updatedAt: created, ...over });

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('chat folders', () => {
  it('are named by day and id under chats/', () => {
    expect(DEFAULT_MAC_WORKSPACE).toBe(`${base}/workspace`);
    expect(chatFolder(meta())).toBe(`${base}/workspace/chats/2026-10-23-abcdef12`);
  });

  it('are where new chats work; a picked project and chats already in the shared folder keep their place', () => {
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    expect(macWorkspaceFor(meta())).toEqual({ cwd: chatFolder(meta()), own: true });
    expect(macWorkspaceFor(meta({ project }))).toEqual({ cwd: project, own: false });
    expect(macWorkspaceFor(meta({ project: join(base, 'gone') }))).toEqual({ cwd: chatFolder(meta()), own: true });
    expect(macWorkspaceFor(meta({ engine: { id: 'e', cwd: DEFAULT_MAC_WORKSPACE } }))).toEqual({ cwd: DEFAULT_MAC_WORKSPACE, own: false });
    expect(macWorkspaceFor(meta({ engine: { id: 'e', cwd: project } }))).toEqual({ cwd: chatFolder(meta()), own: true });
  });

  it('are listed two levels deep without dot files and dependencies', () => {
    const dir = join(base, 'listing');
    mkdirSync(join(dir, 'src', 'deep', 'deeper'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'NOTES.md'), '# notes');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'src', 'a.ts'), '');
    writeFileSync(join(dir, 'src', 'deep', 'b.ts'), '');
    expect(listFolder(dir)).toEqual(['NOTES.md', 'src/', 'src/a.ts', 'src/deep/']);
    expect(listFolder(dir, 2)).toEqual(['NOTES.md', 'src/']);
    expect(listFolder(join(base, 'missing'))).toEqual([]);
  });

  it('come back into the prompt with their notes and files', () => {
    const dir = join(base, 'prompt');
    mkdirSync(dir, { recursive: true });
    expect(ownFolderPrompt(dir)).toMatch(/The folder is empty so far/);
    writeFileSync(join(dir, 'NOTES.md'), 'User wants a landing page; draft is in site/index.html');
    writeFileSync(join(dir, 'report.pdf'), '');
    const prompt = ownFolderPrompt(dir);
    expect(prompt).toContain(`own folder on the Mac, ${dir}`);
    expect(prompt).toMatch(/- NOTES\.md\n- report\.pdf/);
    expect(prompt).toMatch(/## NOTES\.md\nUser wants a landing page/);
  });
});

describe('Seatbelt sandbox', () => {
  it('runs sandboxed commands without asking, keeps a dev allow list and degrades instead of failing', () => {
    expect(macSandbox({})).toEqual({
      enabled: true,
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      network: { allowedDomains: SANDBOX_DOMAINS, allowLocalBinding: true },
    });
    expect(SANDBOX_DOMAINS).toEqual(expect.arrayContaining(['github.com', 'registry.npmjs.org', 'pypi.org']));
  });

  it('still asks for commands in a picked project, whose sources run outside the sandbox later', () => {
    expect(macSandbox({}, { autoAllow: false })?.autoAllowBashIfSandboxed).toBe(false);
  });

  it('takes extra hosts from POCKET_SANDBOX_DOMAINS and can be switched off', () => {
    expect(macSandbox({ POCKET_SANDBOX_DOMAINS: 'example.com, *.corp.local' })?.network?.allowedDomains?.slice(-2)).toEqual(['example.com', '*.corp.local']);
    expect(macSandbox({ POCKET_SANDBOX: 'off' })).toBeUndefined();
    expect(macSandbox({ POCKET_SANDBOX: '0' })).toBeUndefined();
  });
});
