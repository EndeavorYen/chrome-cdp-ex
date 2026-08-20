import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function chromeVersionPayload() {
  return {
    Browser: 'Chrome/151.0.0.0',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
  };
}

describe('#358 first-step doctor/spawn loop', () => {
  it('treats a live debug Chrome on the requested port as spawn success and does not relaunch', async () => {
    let spawnCalls = 0;
    const fetched = [];
    const fs = { existsSync: () => true, mkdirSync: () => {} };
    const out = await T.spawnDebugBrowserStr(['chrome', '--port', '9222'], { TMPDIR: '/tmp' }, {
      fs,
      platform: 'darwin',
      probeTcpPort: async () => ({ occupied: true }),
      spawn: () => {
        spawnCalls += 1;
        return { pid: 1, unref() {} };
      },
      waitForSpawnedCdp: async ({ port, host }) => ({
        ok: true,
        port,
        host,
        product: 'Chrome/151.0.0.0',
        webSocketDebuggerUrl: `ws://${host}:${port}/devtools/browser/abc`,
      }),
      listSpawnedDebugTargets: async ({ port }) => {
        fetched.push(port);
        return [{ targetId: 'AABBCCDDEEFF0011', type: 'page', title: 'Example Domain', url: 'https://example.com/' }];
      },
    });

    expect(spawnCalls).toBe(0);
    expect(out).toMatch(/CDP_PORT=9222/);
    expect(out).toMatch(/cdp list/);
    expect(out).not.toMatch(/already in use/i);
    expect(out).not.toMatch(/exited early/i);
  });

  it('discovers a listening spawn-default 9222 from doctor without CDP_PORT', async () => {
    const requested = [];
    const fetcher = async (url) => {
      requested.push(String(url));
      if (String(url).includes('127.0.0.1:9222/json/version')) {
        return { ok: true, json: async () => chromeVersionPayload() };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await T.checkCdpReachability({
      env: {},
      fetcher,
      home: '/tmp/chrome-cdp-ex-no-devtools-home',
      existsSync: () => false,
    });

    expect(requested.some(url => url.includes('127.0.0.1:9222/json/version'))).toBe(true);
    expect(result.status).toBe('OK');
    expect(result.port).toBe('9222');
    expect(result.detail).toMatch(/9222/);
    expect(result.detail).toMatch(/Chrome\/151/);
  });

  it('prints preferredBrowser in the blocked-CDP spawn command instead of hardcoded edge', () => {
    const checks = [
      { status: 'OK', label: 'Node', detail: 'v22' },
      {
        status: 'OK',
        label: 'Environment',
        detail: 'darwin, display available',
        environment: {
          preferredBrowser: {
            browser: 'chrome',
            executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          },
        },
      },
      { status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set' },
    ];
    const model = T.buildDoctorModel(checks);

    expect(model.recommendation.run).toMatch(/cdp spawn-debug-browser chrome /);
    expect(model.recommendation.run).not.toMatch(/\bedge\b/);
    expect(model.recommendation.ask || '').not.toMatch(/chrome:\/\/inspect/);
    expect(`${model.recommendation.ask || ''} ${model.recommendation.reason || ''}`).toMatch(/not the daily profile/i);
    expect(T.formatDoctorReport(checks)).toContain('cdp spawn-debug-browser chrome');
    expect(T.formatDoctorReport(checks)).not.toContain('cdp spawn-debug-browser edge');
  });

  it('lets unprefixed list/getWsUrl attach via the same 9222 probe as doctor', async () => {
    const previousPort = process.env.CDP_PORT;
    delete process.env.CDP_PORT;
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      if (String(url).includes('127.0.0.1:9222/json/version')) {
        return {
          ok: true,
          json: async () => ({
            Browser: 'Chrome/151.0.0.0',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      await expect(T.getWsUrl()).resolves.toBe('ws://127.0.0.1:9222/devtools/browser/abc');
      expect(requested.some(url => url.includes('127.0.0.1:9222/json/version'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousPort === undefined) delete process.env.CDP_PORT;
      else process.env.CDP_PORT = previousPort;
    }
  });

  it('keeps waiting for CDP while the spawned child is still starting past the short default', async () => {
    const child = {
      once(event, handler) {
        if (event === 'exit') this._onExit = handler;
      },
    };
    let calls = 0;
    const started = Date.now();
    const readiness = await T.waitForSpawnedCdp({
      port: 9333,
      host: '127.0.0.1',
      timeoutMs: 40,
      child,
      fetcher: async () => {
        calls += 1;
        if (Date.now() - started < 80) throw new Error('ECONNREFUSED');
        return {
          ok: true,
          json: async () => ({ Browser: 'Chrome/151.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/abc' }),
        };
      },
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.product).toMatch(/Chrome\/151/);
    expect(calls).toBeGreaterThan(1);
  });
});
