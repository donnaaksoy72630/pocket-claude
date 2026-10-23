import { describe, expect, it } from 'vitest';
import { innerMessageBodySchema, innerMessageSchema } from '../src/index.js';

const session = { sessionId: 's', title: 't', state: 'idle', createdAt: 1, updatedAt: 2 };

describe('innerMessageBodySchema', () => {
  it.each([
    { type: 'session.create', payload: {} },
    { type: 'message.send', payload: { sessionId: 's', text: 'x', attachments: [{ mime: 'image/png', dataBase64: 'AA==' }] } },
    { type: 'permission.respond', payload: { requestId: 'r', decision: 'allow_session' } },
    { type: 'session.created', payload: { session } },
    { type: 'session.event', payload: { sessionId: 's', event: { kind: 'tool_result', id: 'i', content: 'c', isError: false } } },
    { type: 'tool.call', payload: { callId: 'c', name: 'read_file', args: { path: 'a' } } },
    { type: 'tool.output', payload: { callId: 'c', chunk: 'x', stream: 'stderr' } },
    { type: 'control.kill', payload: { scope: 'all' } },
  ])('accepts $type', (msg) => {
    expect(innerMessageBodySchema.safeParse(msg).success).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(innerMessageBodySchema.safeParse({ type: 'nope', payload: {} }).success).toBe(false);
  });

  it('rejects invalid payloads', () => {
    expect(innerMessageBodySchema.safeParse({ type: 'message.send', payload: { sessionId: 's' } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'control.kill', payload: { scope: 'one' } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'permission.respond', payload: { requestId: 'r', decision: 'maybe' } }).success).toBe(false);
  });

  it('inner message requires ts and counter', () => {
    expect(innerMessageSchema.safeParse({ ts: 1, counter: 2, type: 'status.get', payload: {} }).success).toBe(true);
    expect(innerMessageSchema.safeParse({ type: 'status.get', payload: {} }).success).toBe(false);
  });
});

describe('computer use messages', () => {
  it.each([
    { action: 'screenshot' },
    { action: 'screenshot', display: 1, maxWidth: 1280, maxHeight: 800 },
    { action: 'zoom', x: -1920, y: 0, width: 400, height: 300 },
    { action: 'click', x: 10, y: 20, button: 'left', count: 2, modifiers: ['ctrl'] },
    { action: 'click', button: 'right', count: 1 },
    { action: 'drag', path: [[0, 0], [100, 50]] },
    { action: 'scroll', x: 5, y: 5, dx: 0, dy: -3 },
    { action: 'type', text: 'Привет, dir\n' },
    { action: 'key', keys: 'ctrl+shift+esc', holdMs: 500 },
    { action: 'window', handle: '1312342', op: 'focus' },
    { action: 'open', target: 'chrome', args: 'https://example.com' },
    { action: 'release' },
  ])('accepts computer.act $action', (action) => {
    expect(innerMessageBodySchema.safeParse({ type: 'computer.act', payload: { requestId: 'r', action } }).success).toBe(true);
  });

  it.each([
    { action: 'click', x: 1.5, y: 2, button: 'left', count: 1 },
    { action: 'click', x: 1, y: 2, button: 'left', count: 4 },
    { action: 'drag', path: [[0, 0]] },
    { action: 'type', text: '' },
    { action: 'window', handle: 'abc', op: 'focus' },
    { action: 'window', handle: '1', op: 'explode' },
    { action: 'teleport' },
  ])('rejects a bad computer.act %#', (action) => {
    expect(innerMessageBodySchema.safeParse({ type: 'computer.act', payload: { requestId: 'r', action } }).success).toBe(false);
  });

  it('carries screenshots with their place on the desktop, windows and errors back', () => {
    const done = {
      requestId: 'r',
      image: { mime: 'image/jpeg', dataBase64: 'QUJD', width: 1280, height: 720 },
      region: { x: 0, y: 0, width: 2560, height: 1440 },
      displays: [{ index: 0, x: 0, y: 0, width: 2560, height: 1440, primary: true, scale: 1.5 }],
      cursor: { x: 10, y: 10 },
      windows: [{ handle: '42', title: 'Windows PowerShell', process: 'powershell', x: 0, y: 0, width: 800, height: 600, minimized: false, maximized: false, focused: true, display: 0 }],
    };
    expect(innerMessageBodySchema.safeParse({ type: 'computer.done', payload: done }).success).toBe(true);
    expect(innerMessageBodySchema.safeParse({ type: 'computer.done', payload: { requestId: 'r', error: 'blocked' } }).success).toBe(true);
  });
});
