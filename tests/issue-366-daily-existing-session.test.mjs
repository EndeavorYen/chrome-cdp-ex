import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const EDGE_EXE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DAILY_EDGE_PROFILE = '/Users/simon/Library/Application Support/Microsoft Edge';

function edgeFs(plistXml = null) {
  return {
    existsSync: (p) => {
      const path = String(p);
      return path === EDGE_EXE
        || path.startsWith(DAILY_EDGE_PROFILE)
        || (plistXml && path.endsWith('/Microsoft Edge.app/Contents/Info.plist'));
    },
    mkdirSync: () => {},
    readFileSync: (p) => {
      if (plistXml && String(p).endsWith('/Microsoft Edge.app/Contents/Info.plist')) return plistXml;
      throw new Error(`unexpected read ${p}`);
    },
  };
}

function childWithStdout(text, pid = 42) {
  return {
    pid,
    stdout: {
      on(event, fn) {
        if (event === 'data' && text) fn(text);
      },
      setEncoding() {},
      unref() {},
    },
    stderr: { on() {}, setEncoding() {}, unref() {} },
    unref() {},
    once() {},
  };
}

function emptyCdpChecks(environment) {
  return [
    { status: 'OK', label: 'Node', detail: 'v22' },
    environment,
    { status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set' },
  ];
}

describe('#366 daily --daily-profile must not fake CDP on Chromium 136+', () => {
  it('treats Chromium existing-session handoff English and Chinese as failure text', () => {
    expect(T.isExistingBrowserSessionHandoff('Opening in existing browser session.')).toBe(true);
    expect(T.isExistingBrowserSessionHandoff('在現有的瀏覽器工作階段中開啟。')).toBe(true);
    expect(T.isExistingBrowserSessionHandoff('Enabled daily edge debug on CDP_PORT=9222')).toBe(false);
  });

  it('reads Chromium/Edge major from Info.plist and treats 136+ as default-dir debug ignore', () => {
    const xml = `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleShortVersionString</key><string>139.0.3405.102</string>
</dict></plist>`;
    expect(T.detectChromiumMajorVersion(EDGE_EXE, {
      fs: edgeFs(xml),
      spawnSyncFn: () => { throw new Error('should not spawn --version'); },
    })).toBe(139);
    expect(T.defaultProfileIgnoresRemoteDebugging(135)).toBe(false);
    expect(T.defaultProfileIgnoresRemoteDebugging(136)).toBe(true);
    expect(T.defaultProfileIgnoresRemoteDebugging(139)).toBe(true);
    expect(T.defaultProfileIgnoresRemoteDebugging(null)).toBe(false);
  });

  it('does not treat existing-session stdout as daily-profile attach success', async () => {
    await expect(T.spawnDebugBrowserStr(
      ['edge', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => false,
        quitBrowser: async () => {},
        spawn: () => childWithStdout('Opening in existing browser session.\n'),
        waitForSpawnedCdp: async ({ output, port, host }) => ({
          ok: true,
          port,
          host,
          product: 'Edg/151.0.0.0',
          stdout: output?.stdout || '',
          stderr: output?.stderr || '',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    )).rejects.toThrow(/existing browser session|在現有的瀏覽器工作階段中開啟/i);
  });

  it('refuses Chromium 136+ --daily-profile without quitting or relaunching the default dir', async () => {
    const events = [];
    await expect(T.spawnDebugBrowserStr(
      ['edge', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        chromiumMajorVersion: 136,
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => true,
        quitBrowser: async (plan) => {
          events.push(`quit:${plan.profileDir}`);
        },
        spawn: (exe, args) => {
          events.push(`spawn:${args.join(' ')}`);
          return childWithStdout('');
        },
        waitForSpawnedCdp: async () => {
          throw new Error('should not wait for CDP on a doomed default-dir launch');
        },
        listSpawnedDebugTargets: async () => [],
      },
    )).rejects.toThrow(/Chrome 136[\s\S]*non-default data directory[\s\S]*not the daily profile/i);

    expect(events).toEqual([]);
  });

  it('does not claim success when quit+relaunch of the same default Edge dir still has empty 9222', async () => {
    const events = [];
    let spawnCount = 0;
    await expect(T.spawnDebugBrowserStr(
      ['edge', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => false,
        quitBrowser: async (plan) => {
          events.push(`quit:${plan.browser}:${plan.profileDir}`);
        },
        spawn: (exe, args) => {
          spawnCount += 1;
          events.push(`spawn:${spawnCount}:${args.join(' ')}`);
          return childWithStdout(
            spawnCount === 1 ? '在現有的瀏覽器工作階段中開啟。\n' : '',
            100 + spawnCount,
          );
        },
        waitForSpawnedCdp: async ({ output, port, host }) => ({
          ok: false,
          timeout: true,
          port,
          host,
          stdout: output?.stdout || '',
          stderr: output?.stderr || '',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    )).rejects.toThrow(/Chrome 136|non-default data directory|not the daily profile/i);

    expect(events[0]).toMatch(/^spawn:1:.*--user-data-dir=\/Users\/simon\/Library\/Application Support\/Microsoft Edge/);
    expect(events[1]).toBe(`quit:edge:${DAILY_EDGE_PROFILE}`);
    expect(events[2]).toMatch(/^spawn:2:.*--user-data-dir=\/Users\/simon\/Library\/Application Support\/Microsoft Edge/);
    expect(events.join('\n')).not.toMatch(/Enabled daily/i);
  });

  it('fails if handoff remains after quit+relaunch and does not claim attach success', async () => {
    let quitCalls = 0;
    await expect(T.spawnDebugBrowserStr(
      ['edge', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => false,
        quitBrowser: async () => { quitCalls += 1; },
        spawn: () => childWithStdout('在現有的瀏覽器工作階段中開啟。\n'),
        waitForSpawnedCdp: async ({ output, port, host }) => ({
          ok: false,
          timeout: true,
          port,
          host,
          stdout: output?.stdout || '',
          stderr: output?.stderr || '',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    )).rejects.toThrow(/在現有的瀏覽器工作階段中開啟[\s\S]*Chrome 136|Chrome 136[\s\S]*在現有的瀏覽器工作階段中開啟/i);

    expect(quitCalls).toBe(1);
  });

  it('does not pretend an unlocked default Edge dir enables CDP when 9222 stays empty', async () => {
    let quitCalls = 0;
    await expect(T.spawnDebugBrowserStr(
      ['edge', '--daily-profile', '--port', '9222'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => false,
        quitBrowser: async () => { quitCalls += 1; },
        spawn: () => childWithStdout(''),
        waitForSpawnedCdp: async ({ port, host }) => ({
          ok: false,
          timeout: true,
          port,
          host,
          stdout: '',
          stderr: 'DevTools remote debugging requires a non-default data directory.',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    )).rejects.toThrow(/non-default data directory|Chrome 136|not the daily profile/i);

    expect(quitCalls).toBe(0);
  });

  it('still allows isolated non-default user-data-dir spawn on Chromium 136+', async () => {
    const calls = [];
    const isolatedDir = '/tmp/chrome-cdp-ex-edge-debug-profile-9222';
    const out = await T.spawnDebugBrowserStr(
      ['edge', '--port', '9222', '--user-data-dir', isolatedDir, '--url', 'https://example.com'],
      { HOME: '/Users/simon', TMPDIR: '/tmp' },
      {
        fs: edgeFs(),
        platform: 'darwin',
        chromiumMajorVersion: 139,
        probeTcpPort: async () => ({ occupied: false }),
        quitBrowser: async () => {
          throw new Error('isolated spawn must not quit daily Edge');
        },
        spawn: (exe, args) => {
          calls.push(args);
          return { pid: 9, unref() {} };
        },
        waitForSpawnedCdp: async ({ port, host }) => ({
          ok: true,
          port,
          host,
          product: 'Edg/139.0.0.0',
        }),
        listSpawnedDebugTargets: async () => [],
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].some(a => a.startsWith('--user-data-dir=') && a.includes('chrome-cdp-ex-edge-debug-profile-9222'))).toBe(true);
    expect(calls[0]).not.toContain(`--user-data-dir=${DAILY_EDGE_PROFILE}`);
    expect(out).toMatch(/CDP_PORT=9222/);
    expect(out).not.toMatch(/daily/i);
  });

  it('doctor empty 9222 on Edge 136+ recommends persistent daily dir, not doomed default-dir debug', () => {
    const checks = emptyCdpChecks({
      status: 'OK',
      label: 'Environment',
      detail: 'darwin, display available',
      environment: {
        preferredBrowser: {
          browser: 'edge',
          executable: EDGE_EXE,
          major: 136,
        },
      },
    });
    const model = T.buildDoctorModel(checks);
    const wizard = T.doctorWizardModel(checks);
    const report = T.formatDoctorReport(checks);
    const steps = T.doctorNextSteps(checks).join('\n');

    expect(model.recommendation.run).toMatch(/cdp spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(model.recommendation.run).toMatch(/daily-edge/);
    expect(model.recommendation.run).not.toMatch(/--daily-profile/);
    expect(model.recommendation.run).not.toMatch(/\/tmp\/chrome-cdp-ex/);
    expect(model.recommendation.ask || '').toMatch(/Chrome 136|non-default|not the daily profile/i);
    expect(wizard.currentStep).not.toMatch(/--daily-profile/);
    expect(wizard.currentStep).toMatch(/spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(report).not.toMatch(/Enable daily-profile debug/);
    expect(report).toMatch(/spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(report).toMatch(/\(ask first\)/);
    expect(steps).toMatch(/spawn-debug-browser edge --port 9222 --user-data-dir/);
    expect(steps).not.toMatch(/perceive .* -C -d 8/);
  });
});
