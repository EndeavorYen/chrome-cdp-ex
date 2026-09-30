import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CdpSession, pointerExpression } from '../skills/chrome-cdp-ex/scripts/lib/cdp-session.mjs';

function fakeTransport(handler) {
  const calls = [];
  return {
    calls,
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      return handler(method, params);
    },
    on: () => () => {},
  };
}

describe('CdpSession.ev', () => {
  it('evaluates with awaitPromise and returnByValue on the attached session', async () => {
    const t = fakeTransport(() => ({ result: { value: 42 } }));
    const page = new CdpSession(t, 'S1');
    expect(await page.ev('1+41')).toBe(42);
    expect(t.calls[0]).toEqual({
      method: 'Runtime.evaluate',
      params: { expression: '1+41', awaitPromise: true, returnByValue: true },
      sessionId: 'S1',
    });
  });

  it('throws the page exception text', async () => {
    const t = fakeTransport(() => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' } } }));
    await expect(new CdpSession(t, 'S1').ev('x')).rejects.toThrow(/ReferenceError: x is not defined/);
  });
});

describe('CdpSession.waitFor', () => {
  it('resolves as soon as the expression is truthy', async () => {
    let n = 0;
    const t = fakeTransport(() => ({ result: { value: ++n >= 3 } }));
    await new CdpSession(t, 'S1').waitFor('window.ready', { timeoutMs: 1000, intervalMs: 1 });
    expect(n).toBe(3);
  });

  it('times out with the expression in the message', async () => {
    const t = fakeTransport(() => ({ result: { value: false } }));
    await expect(new CdpSession(t, 'S1').waitFor('window.never', { timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(/timeout after 30 ms.*window\.never/);
  });
});

describe('pointer', () => {
  it('builds the full pointer sequence in the page, never Input.* events', async () => {
    const expr = pointerExpression('button.chip');
    const order = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].map((e) => expr.indexOf(`'${e}'`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(expr).toContain('button.chip');
    const t = fakeTransport(() => ({ result: { value: { ok: true, tag: 'BUTTON' } } }));
    await new CdpSession(t, 'S1').pointer('button.chip');
    expect(t.calls.every((c) => !c.method.startsWith('Input.'))).toBe(true);
  });

  it('fails clearly when the element is missing or disabled', async () => {
    const missing = fakeTransport(() => ({ result: { value: { ok: false, reason: 'not found' } } }));
    await expect(new CdpSession(missing, 'S1').pointer('#nope')).rejects.toThrow(/pointer #nope: not found/);
  });
});

describe('CdpSession.upload and shot and download', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cdp-session-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('upload resolves the input to an objectId then sets the files', async () => {
    const t = fakeTransport((method) => (method === 'Runtime.evaluate' ? { result: { objectId: 'OBJ-1' } } : {}));
    await new CdpSession(t, 'S1').upload('input[type=file]', ['C:/a.png']);
    expect(t.calls.map((c) => c.method)).toEqual(['Runtime.evaluate', 'DOM.setFileInputFiles']);
    expect(t.calls[1].params).toEqual({ objectId: 'OBJ-1', files: ['C:/a.png'] });
  });

  it('upload fails when the selector matches nothing', async () => {
    const t = fakeTransport(() => ({ result: { subtype: 'null' } }));
    await expect(new CdpSession(t, 'S1').upload('input.none', ['C:/a.png'])).rejects.toThrow(/no element matches input\.none/);
  });

  it('shot writes the decoded png', async () => {
    const t = fakeTransport(() => ({ data: Buffer.from('PNGDATA').toString('base64') }));
    const out = join(dir, 's.png');
    await new CdpSession(t, 'S1').shot(out);
    expect(readFileSync(out, 'utf8')).toBe('PNGDATA');
  });
});

function eventTransport() {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    send: async (method) => { calls.push(method); return {}; },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event).delete(handler);
    },
    emit: (event, params, sessionId) => { for (const h of [...(handlers.get(event) || [])]) h(params, sessionId); },
    listenerCount: (event) => (handlers.get(event) || new Set()).size,
  };
}

describe('CdpSession.waitResponse', () => {
  it('enables the Network domain once and resolves on the first matching response of this session', async () => {
    const t = eventTransport();
    const page = new CdpSession(t, 'S1');
    const w = page.waitResponse(/generated_video\.mp4/, { timeoutMs: 500 });
    t.emit('Network.responseReceived', { requestId: '1', response: { url: 'https://x/other.js', status: 200, mimeType: 'text/javascript' } }, 'S1');
    t.emit('Network.responseReceived', { requestId: '2', response: { url: 'https://x/generated_video.mp4?c=1', status: 200, mimeType: 'video/mp4' } }, 'OTHER');
    t.emit('Network.responseReceived', { requestId: '3', response: { url: 'https://x/a/generated_video.mp4', status: 200, mimeType: 'video/mp4' } }, 'S1');
    expect(await w.promise).toEqual({ url: 'https://x/a/generated_video.mp4', status: 200, mimeType: 'video/mp4', requestId: '3' });
    expect(t.calls.filter((m) => m === 'Network.enable')).toHaveLength(1);
    expect(t.listenerCount('Network.responseReceived')).toBe(0);
  });

  it('does not miss a response that arrives before the caller awaits (subscribe-first)', async () => {
    const t = eventTransport();
    const page = new CdpSession(t, 'S1');
    const w = page.waitResponse('/late.bin', { timeoutMs: 500 });
    t.emit('Network.responseReceived', { requestId: '9', response: { url: 'https://x/late.bin', status: 200, mimeType: 'application/octet-stream' } }, 'S1');
    await new Promise((r) => setTimeout(r, 20));
    expect((await w.promise).requestId).toBe('9');
  });

  it('times out with the pattern in the message and unsubscribes', async () => {
    const t = eventTransport();
    const w = new CdpSession(t, 'S1').waitResponse(/never/, { timeoutMs: 30 });
    await expect(w.promise).rejects.toThrow(/timeout after 30 ms waiting for a response matching .*never/);
    expect(t.listenerCount('Network.responseReceived')).toBe(0);
  });

  it('cancel() unsubscribes and rejects', async () => {
    const t = eventTransport();
    const w = new CdpSession(t, 'S1').waitResponse(/x/, { timeoutMs: 500 });
    w.cancel();
    await expect(w.promise).rejects.toThrow(/cancelled/);
    expect(t.listenerCount('Network.responseReceived')).toBe(0);
  });
});
