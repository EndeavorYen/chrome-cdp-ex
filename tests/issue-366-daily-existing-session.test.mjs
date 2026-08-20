import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const EDGE_EXE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DAILY_EDGE_PROFILE = '/Users/simon/Library/Application Support/Microsoft Edge';

function edgeFs() {
  return {
    existsSync: (p) => p === EDGE_EXE || String(p).startsWith(DAILY_EDGE_PROFILE),
    mkdirSync: () => {},
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

describe('#366 daily --daily-profile must not be absorbed by a live session', () => {
  it('treats Chromium existing-session handoff English and Chinese as failure text', () => {
    expect(T.isExistingBrowserSessionHandoff('Opening in existing browser session.')).toBe(true);
    expect(T.isExistingBrowserSessionHandoff('在現有的瀏覽器工作階段中開啟。')).toBe(true);
    expect(T.isExistingBrowserSessionHandoff('Enabled daily edge debug on CDP_PORT=9222')).toBe(false);
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

  it('quits and relaunches the same daily Edge user-data-dir after a Chinese handoff', async () => {
    const events = [];
    let spawnCount = 0;
    const out = await T.spawnDebugBrowserStr(
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
        waitForSpawnedCdp: async ({ output, port, host }) => {
          if (T.isExistingBrowserSessionHandoff(`${output?.stdout || ''}${output?.stderr || ''}`)) {
            return {
              ok: false,
              timeout: true,
              port,
              host,
              stdout: output?.stdout || '',
              stderr: output?.stderr || '',
            };
          }
          return { ok: true, port, host, product: 'Edg/151.0.0.0' };
        },
        listSpawnedDebugTargets: async () => [],
      },
    );

    expect(events[0]).toMatch(/^spawn:1:.*--remote-debugging-port=9222/);
    expect(events[0]).toContain(`--user-data-dir=${DAILY_EDGE_PROFILE}`);
    expect(events[1]).toBe(`quit:edge:${DAILY_EDGE_PROFILE}`);
    expect(events[2]).toMatch(/^spawn:2:.*--remote-debugging-port=9222/);
    expect(events[2]).toContain(`--user-data-dir=${DAILY_EDGE_PROFILE}`);
    expect(out).toMatch(/daily/i);
    expect(out).toMatch(/CDP_PORT=9222/);
    expect(out).not.toMatch(/Opening in existing browser session|在現有的瀏覽器工作階段中開啟/);
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

  it('does not pretend quit+relaunch of the default Edge dir enables CDP on Chromium 136+', async () => {
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
});
