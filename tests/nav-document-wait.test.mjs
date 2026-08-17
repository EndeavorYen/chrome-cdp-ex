import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

const EXAMPLE_ORG = 'https://example.org/';
const EXAMPLE_COM = 'https://example.com/';
const SOURCE = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');

function createNavCdp(handlers = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId, timeout) {
      calls.push({ method, params, sessionId, timeout });
      if (handlers[method]) return Promise.resolve(handlers[method](params, sessionId));
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
    waitForEvent(method, _timeout) {
      let timer;
      return {
        promise: handlers[`event:${method}`]
          ? Promise.resolve(handlers[`event:${method}`]())
          : new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Timeout waiting for event: ${method}`)), 50); }),
        cancel() { clearTimeout(timer); },
      };
    },
  };
}

function destCompleteEvaluate(url = EXAMPLE_ORG, readyState = 'complete') {
  return (params) => {
    const expr = String(params.expression || '');
    if (expr.includes('location.href') || expr.includes('readyState')) {
      return { result: { value: { url, readyState } } };
    }
    return { result: { value: readyState } };
  };
}

describe('#347 faster document nav wait', () => {
  it('keeps nav on the existing command family without waitUntil flags', () => {
    const command = COMMAND_SURFACE.resolve('nav');
    expect(command.name).toBe('nav');
    expect(command.help.synopsis).toMatch(/\bnav <target> <url>/);
    expect(command.help.synopsis).not.toMatch(/--wait-until|--timeout|--skip-settle|--noWaitAfter|--goto/);
  });

  it('returns when dest URL is committed and readyState is complete without loadEventFired', async () => {
    let loadCancelled = false;
    const cdp = createNavCdp({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ loaderId: 'loader1' }),
      'Runtime.evaluate': destCompleteEvaluate(),
    });
    const innerWait = cdp.waitForEvent.bind(cdp);
    cdp.waitForEvent = (method, timeout) => {
      if (method === 'Page.loadEventFired') {
        return {
          promise: new Promise(() => {}),
          cancel() { loadCancelled = true; },
        };
      }
      return innerWait(method, timeout);
    };

    const started = Date.now();
    await expect(T.navStr(cdp, 'sid1', EXAMPLE_ORG, { readyTimeoutMs: 400 }))
      .resolves.toBe(`Navigated to ${EXAMPLE_ORG}`);
    expect(Date.now() - started).toBeLessThan(150);
    expect(loadCancelled).toBe(true);
  });

  it('does not treat the previous document complete state as a successful nav', async () => {
    let probes = 0;
    const cdp = createNavCdp({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ loaderId: 'loader1' }),
      'Runtime.evaluate': (params) => {
        const expr = String(params.expression || '');
        if (expr.includes('location.href') || expr.includes('document.readyState')) {
          probes += 1;
          if (probes < 3) {
            return { result: { value: { url: EXAMPLE_COM, readyState: 'complete' } } };
          }
          return { result: { value: { url: EXAMPLE_ORG, readyState: 'complete' } } };
        }
        return { result: { value: 'complete' } };
      },
      'event:Page.loadEventFired': () => ({}),
    });

    const started = Date.now();
    await expect(T.navStr(cdp, 'sid1', EXAMPLE_ORG, { readyTimeoutMs: 400 }))
      .resolves.toBe(`Navigated to ${EXAMPLE_ORG}`);
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('does not sit on a late loadEventFired after dest is already complete', async () => {
    let loadCancelled = false;
    const cdp = createNavCdp({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ loaderId: 'loader1' }),
      'Runtime.evaluate': destCompleteEvaluate(),
    });
    cdp.waitForEvent = (method) => {
      if (method === 'Page.loadEventFired') {
        let timer;
        return {
          promise: new Promise(resolve => { timer = setTimeout(resolve, 400); }),
          cancel() {
            loadCancelled = true;
            clearTimeout(timer);
          },
        };
      }
      return { promise: new Promise(() => {}), cancel() {} };
    };

    const started = Date.now();
    await expect(T.navStr(cdp, 'sid1', EXAMPLE_ORG, { readyTimeoutMs: 800 }))
      .resolves.toBe(`Navigated to ${EXAMPLE_ORG}`);
    expect(Date.now() - started).toBeLessThan(150);
    expect(loadCancelled).toBe(true);
  });

  it('skips the leftover 150ms action network-quiet floor on document nav', () => {
    expect(T.actionNetworkQuietOptions('nav')).toBeNull();
    expect(T.actionNetworkQuietOptions('click')).toEqual({ quietMs: 150, timeoutMs: 1000 });
    expect(T.actionNetworkQuietOptions('click', { navigated: true })).toEqual({ quietMs: 50, timeoutMs: 250 });
    expect(T.actionNetworkQuietOptions('jsclick', { navigated: true })).toEqual({ quietMs: 50, timeoutMs: 250 });
    expect(T.actionNetworkQuietOptions('fill')).toEqual({ quietMs: 150, timeoutMs: 1000 });
    expect(SOURCE).toMatch(/actionNetworkQuietOptions\(action/);
    expect(SOURCE).toMatch(/if \(quietOpts\) await waitForActionNetworkQuiet/);
    expect(SOURCE).not.toMatch(/await waitForActionNetworkQuiet\(pendingReqs\);/);
  });
});
