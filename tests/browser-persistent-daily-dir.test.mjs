import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const EDGE_EXE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DEFAULT_EDGE_PROFILE = '/Users/simon/Library/Application Support/Microsoft Edge';
const PERSISTENT_EDGE = '/Users/simon/Library/Application Support/chrome-cdp-ex/daily-edge';
const HOME = '/Users/simon';
const ENV = { HOME, TMPDIR: '/tmp' };

function edgeFs() {
  return {
    existsSync: (p) => {
      const path = String(p);
      return path === EDGE_EXE
        || path.startsWith(DEFAULT_EDGE_PROFILE)
        || path.startsWith(PERSISTENT_EDGE);
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
        platform: 'darwin',
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

describe('#368 persistent daily-edge user-data-dir is the first step', () => {
  it('resolves the darwin Edge persistent daily dir, not default Edge and not /tmp', () => {
    expect(T.persistentDailyUserDataDir('edge', { platform: 'darwin', env: ENV })).toBe(PERSISTENT_EDGE);
    expect(T.persistentDailyUserDataDir('chrome', { platform: 'darwin', env: ENV })).toBe(
      '/Users/simon/Library/Application Support/chrome-cdp-ex/daily-chrome',
    );
    expect(T.isIsolatedChromeCdpExProfileDir(PERSISTENT_EDGE)).toBe(false);
    expect(T.isDisposableSpawnProfileDir(PERSISTENT_EDGE)).toBe(false);
  });

  it('parses default spawn (no --daily-profile) to the persistent dir', () => {
    const opts = T.parseSpawnDebugBrowserArgs(
      ['edge', '--port', '9222'],
      ENV,
      { platform: 'darwin' },
    );

    expect(opts.dailyProfile).toBe(false);
    expect(opts.profileDir).toBe(PERSISTENT_EDGE);
    expect(opts.profileDir).not.toBe(DEFAULT_EDGE_PROFILE);
    expect(opts.profileDir).not.toMatch(/\/tmp\/chrome-cdp-ex/);
  });

  it('keeps --daily-profile as the browser default dir', () => {
    const opts = T.parseSpawnDebugBrowserArgs(
      ['edge', '--daily-profile', '--port', '9222'],
      ENV,
      { platform: 'darwin' },
    );

    expect(opts.dailyProfile).toBe(true);
    expect(opts.profileDir).toBe(DEFAULT_EDGE_PROFILE);
  });

  it('doctor empty 9222 recommends the persistent dir, not --daily-profile, /tmp, or inspect Allow', () => {
    const checks = emptyCdpChecks(151);
    const model = T.buildDoctorModel(checks);
    const wizard = T.doctorWizardModel(checks);
    const report = T.formatDoctorReport(checks);
    const steps = T.doctorNextSteps(checks).join('\n');
    const run = model.recommendation.run;

    expect(run).toMatch(/cdp spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(run).toMatch(/chrome-cdp-ex[/\\]daily-edge/);
    expect(run).not.toMatch(/--daily-profile/);
    expect(run).not.toMatch(/\/tmp\/chrome-cdp-ex/);
    expect(run).not.toMatch(/--url https:\/\/example\.com/);
    expect(model.recommendation.ask || '').not.toMatch(/inspect|#remote-debugging|Allow remote/i);
    expect(wizard.currentStep).toMatch(/--user-data-dir/);
    expect(wizard.currentStep).toMatch(/daily-edge/);
    expect(wizard.currentStep).not.toMatch(/--daily-profile/);
    expect(report).toMatch(/daily-edge/);
    expect(report).not.toMatch(/Enable daily-profile debug/);
    expect(steps).toMatch(/daily-edge/);
    expect(steps).not.toMatch(/Isolated fallback \(not the daily profile\): cdp spawn-debug-browser edge --port 9222 --url/);
    expect(report).not.toMatch(/perceive .* -C -d 8/);
  });

  it('spawns the persistent dir on Edge 136+ without quitting Dock default Edge', async () => {
    const events = [];
    const out = await T.spawnDebugBrowserStr(
      ['edge', '--port', '9222'],
      ENV,
      {
        fs: edgeFs(),
        platform: 'darwin',
        chromiumMajorVersion: 151,
        probeTcpPort: async () => ({ occupied: false }),
        quitBrowser: async (plan) => {
          events.push(`quit:${plan.browser}:${plan.profileDir}`);
        },
        spawn: (exe, args) => {
          events.push(`spawn:${args.join(' ')}`);
          return { pid: 77, unref() {} };
        },
        waitForSpawnedCdp: async ({ port, host }) => ({
          ok: true,
          port,
          host,
          product: 'Edg/151.0.4129.93',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/--remote-debugging-port=9222/);
    expect(events[0]).toContain(`--user-data-dir=${PERSISTENT_EDGE}`);
    expect(events[0]).not.toContain(`--user-data-dir=${DEFAULT_EDGE_PROFILE}`);
    expect(out).toMatch(/CDP_PORT=9222/);
    expect(out).toMatch(/daily-edge/);
    expect(out).not.toMatch(/rm -rf .*daily-edge/);
    expect(out).not.toMatch(/disposable/i);
  });
});
