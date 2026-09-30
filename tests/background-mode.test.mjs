// #415 background mode: drive the agent browser without stealing focus.
import { describe, expect, it, vi } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const FOCUS_METHODS = ['Target.activateTarget', 'Page.bringToFront'];

function fakeCdp(responses = {}) {
  const send = vi.fn(async (method) => responses[method] ?? {});
  return { connect: vi.fn(async () => {}), close: vi.fn(), send };
}

const methodsOf = cdp => cdp.send.mock.calls.map(call => call[0]);

describe('isBackgroundMode', () => {
  it('is off unless CDP_BACKGROUND is a truthy word', () => {
    expect(T.isBackgroundMode({})).toBe(false);
    expect(T.isBackgroundMode({ CDP_BACKGROUND: '' })).toBe(false);
    expect(T.isBackgroundMode({ CDP_BACKGROUND: '0' })).toBe(false);
    expect(T.isBackgroundMode({ CDP_BACKGROUND: 'false' })).toBe(false);
    for (const value of ['1', 'true', 'YES', 'on']) {
      expect(T.isBackgroundMode({ CDP_BACKGROUND: value }), value).toBe(true);
    }
  });
});

describe('daemon attach (attachDaemonTarget)', () => {
  it('activates the tab before attaching when background mode is off (unchanged)', async () => {
    const cdp = fakeCdp({ 'Target.attachToTarget': { sessionId: 'S1' } });
    await expect(T.attachDaemonTarget(cdp, 'TARGET', { background: false })).resolves.toBe('S1');
    expect(cdp.send.mock.calls).toEqual([
      ['Target.activateTarget', { targetId: 'TARGET' }],
      ['Target.attachToTarget', { targetId: 'TARGET', flatten: true }],
    ]);
  });

  it('never sends a focus call when background mode is on', async () => {
    const cdp = fakeCdp({ 'Target.attachToTarget': { sessionId: 'S1' } });
    await expect(T.attachDaemonTarget(cdp, 'TARGET', { background: true })).resolves.toBe('S1');
    expect(methodsOf(cdp)).toEqual(['Target.attachToTarget']);
  });
});

describe('open navigate fallback (navigateOpenTarget)', () => {
  const run = (background) => {
    const cdp = fakeCdp({ 'Target.attachToTarget': { sessionId: 'NAV' }, 'Page.navigate': { loaderId: 'L' } });
    const result = T.navigateOpenTarget('TARGET', '/tmp/unused.sock', 'https://example.test/', {
      createCdp: () => cdp,
      getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/x',
      waitForOpenTargetUrlFn: async () => ({ ok: false, href: null }),
      background,
    });
    return { cdp, result };
  };

  it('keeps the activateTarget call when background mode is off', async () => {
    const { cdp, result } = run(false);
    await expect(result).resolves.toMatchObject({ ok: true, method: 'Page.navigate' });
    expect(methodsOf(cdp)[0]).toBe('Target.activateTarget');
  });

  it('skips every focus call when background mode is on', async () => {
    const { cdp, result } = run(true);
    await expect(result).resolves.toMatchObject({ ok: true, method: 'Page.navigate' });
    expect(methodsOf(cdp)).toEqual(['Target.attachToTarget', 'Page.enable', 'Page.navigate']);
    for (const method of FOCUS_METHODS) expect(methodsOf(cdp)).not.toContain(method);
  });
});

describe('open target creation (createOpenTarget)', () => {
  it('creates a foreground tab when background mode is off (unchanged)', async () => {
    const cdp = fakeCdp({ 'Target.createTarget': { targetId: 'NEW' } });
    await expect(T.createOpenTarget(cdp, { background: false })).resolves.toBe('NEW');
    expect(cdp.send.mock.calls).toEqual([['Target.createTarget', { url: 'about:blank' }]]);
  });

  it('creates the tab in a new unfocused window when background mode is on', async () => {
    const cdp = fakeCdp({ 'Target.createTarget': { targetId: 'NEW' } });
    await expect(T.createOpenTarget(cdp, { background: true })).resolves.toBe('NEW');
    expect(cdp.send.mock.calls).toEqual([['Target.createTarget', { url: 'about:blank', newWindow: true, background: true }]]);
  });

  it('parses open --background and falls back to the env', () => {
    expect(T.parseOpenArgs(['https://example.test/']).background).toBe(false);
    expect(T.parseOpenArgs(['https://example.test/', '--background']).background).toBe(true);
    expect(T.parseOpenArgs(['https://example.test/'], { CDP_BACKGROUND: '1' }).background).toBe(true);
  });
});

describe('spawn-debug-browser --background', () => {
  const THROTTLE_FLAGS = [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  const fs = { existsSync: () => true, mkdirSync: () => {} };
  const plan = (args, env = { TMPDIR: '/tmp' }) =>
    T.buildSpawnDebugBrowserPlan(T.parseSpawnDebugBrowserArgs(['chrome', '--exe', '/x/chrome', ...args], env), 'linux', fs, env);

  it('adds the anti-throttling flags only in background mode', () => {
    const off = plan([]);
    for (const flag of THROTTLE_FLAGS) expect(off.args).not.toContain(flag);
    expect(off.background).toBe(false);
    const on = plan(['--background']);
    for (const flag of THROTTLE_FLAGS) expect(on.args).toContain(flag);
    expect(on.background).toBe(true);
    expect(plan([], { TMPDIR: '/tmp', CDP_BACKGROUND: '1' }).background).toBe(true);
  });

  const spawnWith = async (args) => {
    const minimize = vi.fn(async () => ({ minimized: 1 }));
    await T.spawnDebugBrowserStr(['chrome', '--exe', '/x/chrome', '--port', '9341', ...args], { TMPDIR: '/tmp' }, {
      fs,
      platform: 'linux',
      chromiumMajorVersion: null,
      probeTcpPort: async () => ({ occupied: false }),
      waitForSpawnedCdp: async () => ({ ok: true, port: 9341, product: 'Chrome/140' }),
      listSpawnedDebugTargets: async () => [{ targetId: 'PAGE1', type: 'page', url: 'about:blank' }],
      rememberLastCdpEndpoint: () => {},
      spawn: () => ({ pid: 4242, unref() {}, once() {} }),
      minimizeBrowserWindows: minimize,
    });
    return minimize;
  };

  it('minimizes the launched windows only for a non-headless background spawn', async () => {
    expect(await spawnWith([])).not.toHaveBeenCalled();
    expect(await spawnWith(['--background', '--headless'])).not.toHaveBeenCalled();
    const minimize = await spawnWith(['--background']);
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(minimize.mock.calls[0][0]).toMatchObject({ port: 9341, targetIds: ['PAGE1'] });
  });

  it('minimizes each page window through Browser.setWindowBounds without a focus call', async () => {
    const cdp = fakeCdp({ 'Browser.getWindowForTarget': { windowId: 7 } });
    await expect(T.minimizeWindowsForTargets(cdp, ['PAGE1', 'PAGE2'])).resolves.toEqual({ minimized: 1, errors: [] });
    expect(cdp.send.mock.calls).toEqual([
      ['Browser.getWindowForTarget', { targetId: 'PAGE1' }, undefined, 2000],
      ['Browser.getWindowForTarget', { targetId: 'PAGE2' }, undefined, 2000],
      ['Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'minimized' } }, undefined, 2000],
    ]);
  });
});

describe('open --background reaches the tab daemon', () => {
  it('exports CDP_BACKGROUND=1 to the spawned daemon only in background mode', () => {
    const env = { PATH: '/bin' };
    expect(T.backgroundDaemonEnv(false, env)).toBe(env);
    expect(T.backgroundDaemonEnv(true, env)).toEqual({ PATH: '/bin', CDP_BACKGROUND: '1' });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
