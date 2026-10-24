import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ModelInfo } from '@pocket/protocol';
import { log } from './log.js';
import { paths } from './store.js';

/**
 * OrcaRouter as a second provider for chats that pick its model. Claude Code only accepts model names it knows, so the
 * chat runs Claude Code on a Claude alias against a loopback endpoint here, which swaps in the Orca model and the key
 * and forwards to api.orcarouter.ai. Chats on Claude models never touch it and keep talking to api.anthropic.com.
 */
export const ORCA_MODEL = 'orca/orcacyber-zero-1.5';
const ORCA_HOST = 'api.orcarouter.ai';
/** The Claude alias Claude Code is started with; the endpoint replaces it with ORCA_MODEL on the wire. */
export const ORCA_STAND_IN = 'sonnet';

export const ORCA_MODEL_INFO: ModelInfo = {
  value: ORCA_MODEL,
  displayName: 'OrcaCyber Zero 1.5',
  description: 'OrcaRouter, billed to the OrcaRouter key',
};

export const isOrcaModel = (model: string | undefined): boolean => model === ORCA_MODEL;

/** The model list with OrcaRouter's model at the end when the Mac has its key. */
export function withOrca(models: readonly ModelInfo[]): ModelInfo[] {
  const rest = models.filter((m) => m.value !== ORCA_MODEL);
  return readOrcaKey() ? [...rest, ORCA_MODEL_INFO] : rest;
}

const keyFile = () => join(paths.home, 'orca-api-key');

export function readOrcaKey(): string | undefined {
  try {
    return readFileSync(keyFile(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

let endpoint: Promise<{ url: string; token: string }> | null = null;

/** Starts the loopback endpoint once; only Claude Code processes given `token` may use it. */
export function orcaEndpoint(): Promise<{ url: string; token: string }> {
  endpoint ??= new Promise((resolve, reject) => {
    const token = randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => {
      const auth = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const key = readOrcaKey();
      if (auth !== token || !key) {
        res.writeHead(auth !== token ? 401 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: key ? 'Not allowed.' : 'No OrcaRouter key on the Mac.' } }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);
        if (body.length && String(req.headers['content-type'] ?? '').includes('json')) {
          try {
            const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            if (typeof json.model === 'string') json.model = ORCA_MODEL;
            body = Buffer.from(JSON.stringify(json));
          } catch {
            // Not JSON after all: forward as it came.
          }
        }
        const headers: http.OutgoingHttpHeaders = { ...req.headers, host: ORCA_HOST, 'x-api-key': key, authorization: `Bearer ${key}`, 'content-length': body.length };
        delete headers['accept-encoding'];
        const up = https.request({ host: ORCA_HOST, path: req.url, method: req.method, headers }, (u) => {
          res.writeHead(u.statusCode ?? 502, u.headers);
          u.pipe(res);
        });
        up.on('error', (e) => {
          log(`orca: ${e.message}`);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `OrcaRouter unreachable: ${e.message}` } }));
        });
        up.end(body);
      });
    });
    server.on('error', (e) => {
      endpoint = null;
      reject(e);
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token }));
  });
  return endpoint;
}
