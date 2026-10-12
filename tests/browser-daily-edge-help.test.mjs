import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const EDGE_EXE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function bothBrowsersFs() {
  return {
    existsSync: (p) => p === EDGE_EXE || p === CHROME_EXE,
    mkdirSync: () => {},
  };
}

function edgeEnvironmentCheck() {
  return {
    status: 'OK',
    label: 'Environment',
    detail: 'darwin, display available',
    environment: {
      preferredBrowser: {
        browser: 'edge',
        executable: EDGE_EXE,
      },
    },
  };
}

describe('#364 daily Edge first step; spawn --help must not launch', () => {
  it('prefers the OS default Edge over an installed Chrome', () => {
    const info = T.detectRuntimeEnvironment({
      platform: 'darwin',
      env: { PATH: '' },
      fs: bothBrowsersFs(),
      defaultBrowser: 'edge',
    });

    expect(info.preferredBrowser.browser).toBe('edge');
    expect(info.preferredBrowser.executable).toBe(EDGE_EXE);
  });

  it('recommends persistent daily Edge (ask first) when CDP is empty, not isolated tmp 9311', () => {
    const checks = [
      { status: 'OK', label: 'Node', detail: 'v22' },
      edgeEnvironmentCheck(),
      { status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set' },
    ];
    const model = T.buildDoctorModel(checks);
    const report = T.formatDoctorReport(checks);
    const wizard = T.doctorWizardModel(checks);

    expect(model.recommendation.run).toMatch(/cdp spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(model.recommendation.run).toMatch(/daily-edge/);
    expect(model.recommendation.run).not.toMatch(/9311/);
    expect(model.recommendation.run).not.toMatch(/\/tmp\/chrome-cdp-ex/);
    expect(model.recommendation.run).not.toMatch(/--daily-profile/);
    expect(model.recommendation.consentRequired).toBe(true);
    expect(`${model.recommendation.ask || ''} ${model.recommendation.reason || ''}`).toMatch(/not the daily profile/i);
    expect(wizard.currentStep).toMatch(/edge --port 9222 --user-data-dir/);
    expect(wizard.currentStep).toMatch(/daily-edge/);
    expect(report).toMatch(/spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(report).not.toMatch(/spawn-debug-browser edge --port 9311/);
  });

  it('does not let a stale Chrome last-endpoint beat daily Edge --daily-profile when 9222 is empty', async () => {
    const lastEndpoint = {
      host: '127.0.0.1',
      port: '9222',
      profileDir: '/Users/simon/Library/Application Support/Google/Chrome',
      exe: CHROME_EXE,
      browser: 'chrome',
      launchedAt: '2026-08-14T09:00:00.000Z',
    };
    const fetcher = async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:9222');
      err.code = 'ECONNREFUSED';
      throw err;
    };
    const cdp = await T.checkCdpReachability({
      env: {},
      fetcher,
      lastEndpoint,
      home: '/tmp/chrome-cdp-ex-no-devtools-home',
      existsSync: () => false,
      connectWebSocket: () => {
        throw new Error('WebSocket fallback should not run after connection refused');
      },
    });
    const checks = [
      { status: 'OK', label: 'Node', detail: 'v22' },
      edgeEnvironmentCheck(),
      cdp,
    ];
    const model = T.buildDoctorModel(checks);
    const report = T.formatDoctorReport(checks);
    const wizard = T.doctorWizardModel(checks);

    expect(cdp.status).toBe('FAIL');
    expect(model.recommendation.run).toMatch(/cdp spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(model.recommendation.run).toMatch(/daily-edge/);
    expect(model.recommendation.strategy).not.toBe('relaunch-same-profile');
    expect(model.recommendation.consentRequired).toBe(true);
    expect(model.recommendation.run).not.toMatch(/Google Chrome|Google\/Chrome|--daily-profile/);
    expect(model.recommendation.run).not.toMatch(/\/tmp\/chrome-cdp-ex/);
    expect(`${model.recommendation.ask || ''} ${model.recommendation.reason || ''}`).toMatch(/not the daily profile/i);
    expect(wizard.currentStep).toMatch(/edge --port 9222 --user-data-dir/);
    expect(wizard.currentStep).toMatch(/daily-edge/);
    expect(report).toMatch(/spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(report).not.toMatch(/relaunch the same debug browser profile/i);
  });

  it('parses --help and unknown flags as help, not as a spawn plan', () => {
    for (const args of [['--help'], ['-h'], ['--wat']]) {
      const opts = T.parseSpawnDebugBrowserArgs(args, { TMPDIR: '/tmp' });
      expect(opts.helpRequested).toBe(true);
    }
  });

  it('does not spawn a browser for --help, -h, or unknown flags', async () => {
    let spawnCalls = 0;
    let probeCalls = 0;
    const fs = bothBrowsersFs();
    const deps = {
      fs,
      platform: 'darwin',
      probeTcpPort: async () => {
        probeCalls += 1;
        return { occupied: false };
      },
      spawn: () => {
        spawnCalls += 1;
        return { pid: 93558, unref() {} };
      },
    };

    for (const args of [['--help'], ['-h'], ['--wat']]) {
      spawnCalls = 0;
      probeCalls = 0;
      await expect(T.spawnDebugBrowserStr(args, { TMPDIR: '/tmp' }, deps)).rejects.toMatchObject({
        code: 'help_requested',
        helpTopic: 'spawn-debug-browser',
      });
      expect(spawnCalls).toBe(0);
      expect(probeCalls).toBe(0);
    }
  });
});
