import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function chromeVersionPayload() {
  return {
    Browser: 'Chrome/151.0.0.0',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
  };
}

function isolatedProfileDir() {
  return '/var/folders/zz/abcd/T/chrome-cdp-ex-chrome-debug-profile-9222';
}

function dailyProfileDir() {
  return '/Users/simon/Library/Application Support/Google/Chrome';
}

function chromeEnvironmentCheck() {
  return {
    status: 'OK',
    label: 'Environment',
    detail: 'darwin, display available',
    environment: {
      preferredBrowser: {
        browser: 'chrome',
        executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
    },
  };
}

describe('#362 isolated 9222 occupant is not daily attach', () => {
  it('classifies tmp/var chrome-cdp-ex profile dirs as isolated, not the daily Chrome dir', () => {
    expect(T.isIsolatedChromeCdpExProfileDir(isolatedProfileDir())).toBe(true);
    expect(T.isIsolatedChromeCdpExProfileDir('/tmp/chrome-cdp-ex-chrome-debug-profile-9222')).toBe(true);
    expect(T.isIsolatedChromeCdpExProfileDir('/tmp/chrome-cdp-ex-agent-boot-abc123')).toBe(true);
    expect(T.isIsolatedChromeCdpExProfileDir(dailyProfileDir())).toBe(false);
    expect(T.isIsolatedChromeCdpExProfileDir(null)).toBe(false);
  });

  it('does not treat a leftover isolated 9222 occupant as doctor attach success', async () => {
    const result = await T.checkCdpReachability({
      env: {},
      fetcher: async (url) => {
        if (String(url).includes('127.0.0.1:9222/json/version')) {
          return { ok: true, json: async () => chromeVersionPayload() };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      home: '/tmp/chrome-cdp-ex-no-devtools-home',
      existsSync: () => false,
      inspectOccupantProfileDir: async () => isolatedProfileDir(),
    });

    expect(result.status).not.toBe('OK');
    expect(result.isolatedOccupant).toBe(true);
    expect(result.profileDir).toBe(isolatedProfileDir());
    expect(result.detail).toMatch(/not the daily/i);
    expect(result.hint).toMatch(/--user-data-dir/);
    expect(result.hint).toMatch(/persistent daily/);
    expect(result.hint).toMatch(/ask first|Do not kill/i);
    expect(result.hint).toMatch(/CDP_PORT=9222/);
  });

  it('still treats a live daily-profile occupant on 9222 as attach success', async () => {
    const result = await T.checkCdpReachability({
      env: {},
      fetcher: async (url) => {
        if (String(url).includes('127.0.0.1:9222/json/version')) {
          return { ok: true, json: async () => chromeVersionPayload() };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      home: '/tmp/chrome-cdp-ex-no-devtools-home',
      existsSync: () => false,
      inspectOccupantProfileDir: async () => dailyProfileDir(),
    });

    expect(result.status).toBe('OK');
    expect(result.port).toBe('9222');
    expect(result.isolatedOccupant).not.toBe(true);
  });

  it('still attaches when CDP_PORT explicitly targets the isolated occupant', async () => {
    const result = await T.checkCdpReachability({
      env: { CDP_PORT: '9222' },
      fetcher: async (url) => {
        if (String(url).includes('127.0.0.1:9222/json/version')) {
          return { ok: true, json: async () => chromeVersionPayload() };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      inspectOccupantProfileDir: async () => isolatedProfileDir(),
    });

    expect(result.status).toBe('OK');
    expect(result.port).toBe('9222');
  });

  it('recommends persistent daily dir (ask first) and does not tell the agent to kill the occupant', () => {
    const checks = [
      { status: 'OK', label: 'Node', detail: 'v22' },
      chromeEnvironmentCheck(),
      {
        status: 'FAIL',
        label: 'CDP',
        isolatedOccupant: true,
        port: '9222',
        profileDir: isolatedProfileDir(),
        detail: '127.0.0.1:9222 is an isolated chrome-cdp-ex profile, not the daily Chrome',
        hint: 'Enable daily-profile debug (ask first). Do not kill the occupant without asking.',
      },
    ];
    const model = T.buildDoctorModel(checks);
    const report = T.formatDoctorReport(checks);
    const wizard = T.doctorWizardModel(checks);

    expect(model.recommendation.run).toMatch(/cdp spawn-debug-browser chrome --port 9222 --user-data-dir/);
    expect(model.recommendation.run).toMatch(/daily-chrome/);
    expect(model.recommendation.run).not.toMatch(/--daily-profile/);
    expect(model.recommendation.consentRequired).toBe(true);
    expect(`${model.recommendation.ask || ''} ${model.recommendation.reason || ''}`).toMatch(/not the daily profile/i);
    expect(`${model.recommendation.ask || ''} ${model.recommendation.reason || ''}`).toMatch(/Do not kill/i);
    expect(model.recommendation.ask || '').not.toMatch(/chrome:\/\/inspect/);
    expect(wizard.currentStep).toMatch(/--user-data-dir/);
    expect(wizard.currentStep).toMatch(/daily-chrome/);
    expect(wizard.currentStep).not.toMatch(/--daily-profile/);
    expect(report).toMatch(/--user-data-dir/);
    expect(report).toMatch(/ask first/i);
    expect(report).not.toMatch(/\bpkill\b|\bkillall\b|kill -9/i);
    expect(report).not.toMatch(/perceive .* -C -d 8/);
  });

  it('does not let unprefixed getWsUrl silently attach to an isolated leftover', async () => {
    await expect(T.getWsUrl({
      env: {},
      lastEndpoint: null,
      fetcher: async (url) => {
        if (String(url).includes('127.0.0.1:9222/json/version')) {
          return { ok: true, json: async () => chromeVersionPayload() };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      inspectOccupantProfileDir: async () => isolatedProfileDir(),
    })).rejects.toThrow(/not the daily/i);
  });

  it('reads occupant --user-data-dir from Browser.getBrowserCommandLine without attaching', async () => {
    const profileDir = isolatedProfileDir();
    const result = await T.inspectCdpOccupantProfileDirViaCdp({
      host: '127.0.0.1',
      port: '9222',
      connectWebSocket: async () => {
        const ws = {
          readyState: 1,
          send(raw) {
            expect(JSON.parse(raw)).toEqual({ id: 1, method: 'Browser.getBrowserCommandLine' });
            queueMicrotask(() => {
              ws.onmessage?.({
                data: JSON.stringify({
                  id: 1,
                  result: {
                    arguments: [
                      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                      `--user-data-dir=${profileDir}`,
                    ],
                  },
                }),
              });
            });
          },
          close() {},
        };
        return ws;
      },
    });
    expect(result).toBe(profileDir);
  });

  it('does not attach --daily-profile spawn to an isolated leftover or quit it', async () => {
    let spawnCalls = 0;
    let quitCalls = 0;
    await expect(T.spawnDebugBrowserStr(
      ['chrome', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: { existsSync: () => true, mkdirSync: () => {} },
        platform: 'darwin',
        probeTcpPort: async () => ({ occupied: true }),
        inspectOccupantProfileDir: async () => isolatedProfileDir(),
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
        }),
        listSpawnedDebugTargets: async () => [{
          targetId: 'AABBCCDDEEFF0011',
          type: 'page',
          title: 'Example Domain',
          url: 'https://example.com/',
        }],
      },
    )).rejects.toThrow(/not the daily/i);

    expect(spawnCalls).toBe(0);
    expect(quitCalls).toBe(0);
  });
});
