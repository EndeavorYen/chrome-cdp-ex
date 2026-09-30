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
