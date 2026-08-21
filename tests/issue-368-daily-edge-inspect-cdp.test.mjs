import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const EDGE_EXE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DAILY_EDGE_PROFILE = '/Users/simon/Library/Application Support/Microsoft Edge';

function edgeFs() {
  return {
    existsSync: (p) => {
      const path = String(p);
      return path === EDGE_EXE || path.startsWith(DAILY_EDGE_PROFILE);
    },
    mkdirSync: () => {},
  };
}

function emptyCdpChecks(major = 151) {
  return [
    { status: 'OK', label: 'Node', detail: 'v22' },
    {
      status: 'OK',
      label: 'Environment',
      detail: 'darwin, display available',
      environment: {
        preferredBrowser: {
          browser: 'edge',
          executable: EDGE_EXE,
          major,
        },
      },
    },
    { status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set' },
  ];
}

describe('#368 daily Edge 151 inspect attach; isolated spawn is not the fix', () => {
  it('names Chromium inspect remote-debugging URLs for already-open daily sessions', () => {
    expect(T.inspectRemoteDebuggingUrl('edge')).toBe('edge://inspect/#remote-debugging');
    expect(T.inspectRemoteDebuggingUrl('chrome')).toBe('chrome://inspect/#remote-debugging');
    expect(T.inspectRemoteDebuggingUrl('brave')).toBe('brave://inspect/#remote-debugging');
  });

  it('does not treat #367 isolated spawn as the empty-CDP first step on Edge 151', () => {
    const checks = emptyCdpChecks(151);
    const model = T.buildDoctorModel(checks);
    const wizard = T.doctorWizardModel(checks);
    const report = T.formatDoctorReport(checks);
    const steps = T.doctorNextSteps(checks).join('\n');
    const blob = [model.recommendation.run, model.recommendation.ask, wizard.currentStep, report, steps].join('\n');

    expect(model.recommendation.run).toMatch(/cdp spawn-debug-browser edge --daily-profile --port 9222/);
    expect(model.recommendation.run).not.toMatch(/spawn-debug-browser edge --port 9222 --url https:\/\/example\.com/);
    expect(blob).toMatch(/edge:\/\/inspect\/#remote-debugging/);
    expect(blob).not.toMatch(/Isolated fallback \(not the daily profile\): cdp spawn-debug-browser edge --port 9222 --url/);
    expect(blob).toMatch(/Do not quit daily edge|already-running daily edge/i);
  });

  it('fails if doctor still closes the daily-Edge gap by recommending isolated spawn', () => {
    const checks = emptyCdpChecks(136);
    const model = T.buildDoctorModel(checks);
    // #367 shipped this as the "fix". Testarossa still could not attach.
    expect(model.recommendation.run).not.toBe('cdp spawn-debug-browser edge --port 9222 --url https://example.com');
    expect(T.emptyCdpEnableCommand(checks[1])).toMatch(/--daily-profile/);
  });

  it('opens inspect remote-debugging on the already-running daily Edge and does not quit or isolated-spawn', async () => {
    const events = [];
    const out = await T.spawnDebugBrowserStr(
      ['edge', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        chromiumMajorVersion: 151,
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => true,
        quitBrowser: async () => {
          events.push('quit');
          throw new Error('must not quit daily Edge');
        },
        spawn: (exe, args) => {
          events.push(`spawn:${args.join(' ')}`);
          throw new Error('must not spawn --remote-debugging-port on the default dir');
        },
        openInExistingBrowser: async (plan, url) => {
          events.push(`open:${plan.browser}:${url}`);
        },
        waitForDailyInspectCdp: async () => ({
          ok: true,
          port: 9333,
          host: '127.0.0.1',
          product: 'Edg/151.0.4129.93',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/abc',
        }),
        listSpawnedDebugTargets: async () => [{
          targetId: 'EDGE151DAILYTARGET01',
          type: 'page',
          title: 'X',
          url: 'https://x.com/home',
        }],
      },
    );

    expect(events).toEqual(['open:edge:edge://inspect/#remote-debugging']);
    expect(out).toMatch(/daily/i);
    expect(out).toMatch(/CDP_PORT=9333|9333/);
    expect(out).not.toMatch(/chrome-cdp-ex-edge-debug-profile/);
    expect(out).toMatch(/This is the daily profile/);
  });

  it('does not claim attach success when inspect enable never yields CDP, and still does not quit', async () => {
    const events = [];
    await expect(T.spawnDebugBrowserStr(
      ['edge', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        chromiumMajorVersion: 151,
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => true,
        quitBrowser: async () => { events.push('quit'); },
        spawn: () => {
          events.push('spawn');
          return { pid: 1, unref() {} };
        },
        openInExistingBrowser: async () => { events.push('open'); },
        waitForDailyInspectCdp: async () => ({
          ok: false,
          timeout: true,
          port: 9222,
          host: '127.0.0.1',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    )).rejects.toThrow(/edge:\/\/inspect\/#remote-debugging[\s\S]*not the daily profile|Allow remote debugging[\s\S]*not the daily profile/i);

    expect(events).toEqual(['open']);
  });
});
