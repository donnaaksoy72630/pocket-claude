import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'pocket-orca-'));
process.env.POCKET_HOME = home;
const { isOrcaModel, ORCA_MODEL, orcaEndpoint, withOrca } = await import('../src/orca.js');
const { FALLBACK_MODELS } = await import('../src/chat-tools.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('OrcaRouter provider', () => {
  it('shows its model only when the Mac has the key', () => {
    expect(withOrca(FALLBACK_MODELS).some((m) => m.value === ORCA_MODEL)).toBe(false);
    writeFileSync(join(home, 'orca-api-key'), 'sk-orca-test\n');
    const models = withOrca(FALLBACK_MODELS);
    expect(models.at(-1)).toMatchObject({ value: ORCA_MODEL, displayName: 'OrcaCyber Zero 1.5' });
    expect(withOrca(models).filter((m) => m.value === ORCA_MODEL)).toHaveLength(1);
    expect(isOrcaModel(ORCA_MODEL)).toBe(true);
    expect(isOrcaModel('opus')).toBe(false);
  });

  it('serves only the Claude Code processes it gave the token to, on loopback', async () => {
    const { url, token } = await orcaEndpoint();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const denied = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'guess', 'content-type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(401);
    expect(token).toHaveLength(48);
    expect((await orcaEndpoint()).url).toBe(url);
  });
});
