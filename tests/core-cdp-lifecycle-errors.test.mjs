import { describe, expect, it } from 'vitest';

import { runtimeSource } from './runtime-source.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #144 pending CDP lifecycle errors', () => {
  it('does not recommend Allow debugging for websocket close or Inspector.detached', () => {
    const closed = T.formatCliError(
      new Error('CDP websocket closed while waiting for Page.navigate (code=1006, reason=going away)'),
      { cmd: 'nav', targetPrefix: 'AABBCCDD' }
    );
    const detached = T.formatCliError(
      new Error('CDP Inspector.detached while waiting for Page.navigate (reason=target_closed)'),
      { cmd: 'nav', targetPrefix: 'AABBCCDD' }
    );
    for (const out of [closed, detached]) {
      expect(out).not.toMatch(/click Allow/i);
      expect(out).not.toMatch(/Allow debugging/i);
    }
    const detachedModel = T.buildCliErrorModel(
      new Error('CDP Inspector.detached while waiting for Page.navigate (reason=target_closed)'),
      { cmd: 'nav', targetPrefix: 'AABBCCDD' }
    );
    expect(detachedModel.recovery.kind).toBe('target-closed');
    expect(detachedModel.recovery.run).toBe('cdp list');
  });

  it('completes real-document nav when Page.navigate hangs but the same target URL advanced', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        if (method === 'Page.navigate') return new Promise(() => {});
        if (method === 'Target.getTargets') {
          return Promise.resolve({
            targetInfos: [{
              targetId: '156B9713E3E6234E63401429592707D6',
              type: 'page',
              url: 'https://example.org/',
            }],
          });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'complete' } });
        }
        return Promise.resolve({});
      },
      waitForEvent() {
        return {
          promise: new Promise(() => {}),
          cancel() {},
        };
      },
    };

    const started = Date.now();
    await expect(T.navStr(cdp, 'sid1', 'https://example.org/', {
      targetId: '156B9713E3E6234E63401429592707D6',
      observeDelayMs: 0,
    })).resolves.toBe('Navigated to https://example.org/');
    expect(Date.now() - started).toBeLessThan(300);
    expect(calls.some(call => call.method === 'Target.getTargets' && call.sessionId == null)).toBe(true);
    expect(calls.some(call => call.method === 'Target.attachToTarget')).toBe(false);
  });

  it('daemon nav passes the bound targetId into navStr', () => {
    const source = runtimeSource();
    expect(source).toMatch(/navStr\(cdp, sessionId, url, \{[^}]*targetId/);
  });
});
