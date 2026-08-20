import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function chromeVersionPayload() {
  return {
    Browser: 'Chrome/151.0.0.0',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
  };
}

describe('#360 daily-profile debug first step', () => {
  it('recommends enabling daily-profile debug before isolated spawn when CDP is empty', () => {
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
    const report = T.formatDoctorReport(checks);

    expect(model.recommendation.run).toMatch(/cdp spawn-debug-browser chrome --daily-profile --port 9222/);
    expect(model.recommendation.run).not.toMatch(/--headless/);
    expect(model.recommendation.ask || '').not.toMatch(/chrome:\/\/inspect/);
    expect(`${model.recommendation.ask || ''} ${model.recommendation.reason || ''}`).toMatch(/not the daily profile/i);
    expect(report).toMatch(/spawn-debug-browser chrome --daily-profile/);
    expect(report).toMatch(/not the daily profile/i);
    expect(report).toContain('cdp spawn-debug-browser chrome');
  });

  it('parses --daily-profile to the browser default user-data-dir instead of an isolated tmp profile', () => {
    const opts = T.parseSpawnDebugBrowserArgs(
      ['chrome', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      { platform: 'darwin' },
    );

    expect(opts.dailyProfile).toBe(true);
    expect(opts.browser).toBe('chrome');
    expect(opts.profileDir).toBe('/Users/simon/Library/Application Support/Google/Chrome');
    expect(opts.profileDir).not.toMatch(/chrome-cdp-ex-chrome-debug-profile/);
  });

  it('plans a daily-profile launch with remote debugging and does not advertise deleting the profile', () => {
    const fs = { existsSync: () => true };
    const opts = T.parseSpawnDebugBrowserArgs(
      ['chrome', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      { platform: 'darwin' },
    );
    const plan = T.buildSpawnDebugBrowserPlan(opts, 'darwin', fs);
    const model = T.buildSpawnDebugBrowserModel(plan, {
      ok: true,
      product: 'Chrome/151.0.0.0',
    }, { child: { pid: 9 }, attached: false });
    const text = T.formatSpawnDebugBrowserOutput(model);

    expect(plan.dailyProfile).toBe(true);
    expect(plan.args).toContain('--remote-debugging-port=9222');
    expect(plan.args).toContain('--user-data-dir=/Users/simon/Library/Application Support/Google/Chrome');
    expect(text).toMatch(/daily/i);
    expect(text).not.toMatch(/disposable/i);
    expect(text).not.toMatch(/rm -rf \/Users\/simon\/Library\/Application Support\/Google\/Chrome/);
  });

  it('launches the daily profile when it is unlocked and 9222 is free', async () => {
    const calls = [];
    const fs = { existsSync: () => true, mkdirSync: () => {} };
    const out = await T.spawnDebugBrowserStr(
      ['chrome', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs,
        platform: 'darwin',
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => false,
        quitBrowser: async () => {
          throw new Error('should not quit an unlocked daily profile');
        },
        spawn: (exe, args) => {
          calls.push({ exe, args });
          return { pid: 77, unref() {} };
        },
        waitForSpawnedCdp: async ({ port, host }) => ({
          ok: true,
          port,
          host,
          product: 'Chrome/151.0.0.0',
        }),
        listSpawnedDebugTargets: async () => [{
          targetId: 'AABBCCDDEEFF0011',
          type: 'page',
          title: 'Gmail',
          url: 'https://mail.google.com/',
        }],
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--remote-debugging-port=9222');
    expect(calls[0].args).toContain('--user-data-dir=/Users/simon/Library/Application Support/Google/Chrome');
    expect(out).toMatch(/daily/i);
    expect(out).toMatch(/CDP_PORT=9222/);
    expect(out).not.toMatch(/rm -rf \/Users\/simon\/Library\/Application Support\/Google\/Chrome/);
  });

  it('restarts a locked daily Chrome so debug can be enabled, then launches the same profile', async () => {
    const events = [];
    const fs = { existsSync: () => true, mkdirSync: () => {} };
    const out = await T.spawnDebugBrowserStr(
      ['chrome', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs,
        platform: 'darwin',
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => true,
        quitBrowser: async (plan) => {
          events.push(`quit:${plan.browser}:${plan.profileDir}`);
        },
        spawn: (exe, args) => {
          events.push(`spawn:${args.join(' ')}`);
          return { pid: 88, unref() {} };
        },
        waitForSpawnedCdp: async ({ port }) => ({
          ok: true,
          port,
          host: '127.0.0.1',
          product: 'Chrome/151.0.0.0',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    );

    expect(events[0]).toBe('quit:chrome:/Users/simon/Library/Application Support/Google/Chrome');
    expect(events[1]).toMatch(/--remote-debugging-port=9222/);
    expect(out).toMatch(/daily/i);
  });

  it('keeps occupied live 9222 as attach success and does not relaunch (#359)', async () => {
    let spawnCalls = 0;
    let quitCalls = 0;
    const fs = { existsSync: () => true, mkdirSync: () => {} };
    const out = await T.spawnDebugBrowserStr(['chrome', '--port', '9222'], { TMPDIR: '/tmp' }, {
      fs,
      platform: 'darwin',
      probeTcpPort: async () => ({ occupied: true }),
      quitBrowser: async () => { quitCalls += 1; },
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
      listSpawnedDebugTargets: async () => [{
        targetId: 'AABBCCDDEEFF0011',
        type: 'page',
        title: 'Example Domain',
        url: 'https://example.com/',
      }],
    });

    expect(spawnCalls).toBe(0);
    expect(quitCalls).toBe(0);
    expect(out).toMatch(/CDP_PORT=9222/);
    expect(out).not.toMatch(/already in use/i);
  });

  it('still discovers a listening 9222 from doctor without CDP_PORT (#359)', async () => {
    const requested = [];
    const result = await T.checkCdpReachability({
      env: {},
      fetcher: async (url) => {
        requested.push(String(url));
        if (String(url).includes('127.0.0.1:9222/json/version')) {
          return { ok: true, json: async () => chromeVersionPayload() };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      home: '/tmp/chrome-cdp-ex-no-devtools-home',
      existsSync: () => false,
    });

    expect(requested.some(url => url.includes('127.0.0.1:9222/json/version'))).toBe(true);
    expect(result.status).toBe('OK');
    expect(result.port).toBe('9222');
  });
});
