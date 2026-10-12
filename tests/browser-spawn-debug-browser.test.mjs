import { describe, it, expect } from 'vitest';

import { EventEmitter } from 'events';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================

describe('parseSpawnDebugBrowserArgs', () => {
  const { parseSpawnDebugBrowserArgs } = T;

  it('defaults to edge on port 9222 with the persistent daily dir', () => {
    const opts = parseSpawnDebugBrowserArgs([], { HOME: '/Users/simon', TMPDIR: '/tmp' }, { platform: 'darwin' });
    expect(opts.browser).toBe('edge');
    expect(opts.port).toBe(9222);
    expect(opts.profileDir).toBe('/Users/simon/Library/Application Support/chrome-cdp-ex/daily-edge');
    expect(opts.profileDir).not.toMatch(/\/tmp\/chrome-cdp-ex/);
  });

  it('parses browser, port, url, and profile-dir together', () => {
    const opts = parseSpawnDebugBrowserArgs(
      ['chrome', '--port', '9333', '--url', 'http://127.0.0.1:3000', '--profile-dir', '/tmp/p'],
      { TMPDIR: '/tmp' }
    );
    expect(opts).toMatchObject({
      browser: 'chrome',
      port: 9333,
      url: 'http://127.0.0.1:3000',
      profileDir: '/tmp/p',
      executable: null,
    });
  });

  it('normalises browser aliases', () => {
    expect(parseSpawnDebugBrowserArgs(['msedge'], { TMPDIR: '/tmp' }).browser).toBe('edge');
    expect(parseSpawnDebugBrowserArgs(['google-chrome'], { TMPDIR: '/tmp' }).browser).toBe('chrome');
    expect(parseSpawnDebugBrowserArgs(['chromium'], { TMPDIR: '/tmp' }).browser).toBe('chrome');
  });

  it('honours CDP_DEBUG_BROWSER and explicit executable path', () => {
    const opts = parseSpawnDebugBrowserArgs(['--exe', '/opt/browser'], { TMPDIR: '/tmp', CDP_DEBUG_BROWSER: 'chrome' });
    expect(opts.browser).toBe('chrome');
    expect(opts.executable).toBe('/opt/browser');
  });
});

describe('detectBrowserPath / buildSpawnDebugBrowserPlan', () => {
  const { detectBrowserPath, buildSpawnDebugBrowserPlan, parseSpawnDebugBrowserArgs } = T;

  it('returns the first existing candidate path', () => {
    const fs = { existsSync: (p) => p === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' };
    expect(detectBrowserPath('edge', 'darwin', fs)).toBe('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  });

  it('returns null when nothing exists', () => {
    const fs = { existsSync: () => false };
    expect(detectBrowserPath('chrome', 'darwin', fs, { PATH: '' })).toBeNull();
  });

  it('falls back to browser executables on PATH', () => {
    const fs = { existsSync: (p) => p === '/opt/bin/google-chrome' };
    expect(detectBrowserPath('chrome', 'linux', fs, { PATH: '/usr/bin:/opt/bin' })).toBe('/opt/bin/google-chrome');
  });

  it('builds a plan with --remote-debugging-port and --user-data-dir', () => {
    const fs = { existsSync: () => true };
    const opts = { browser: 'edge', port: 9222, url: null, profileDir: '/tmp/p' };
    const plan = buildSpawnDebugBrowserPlan(opts, 'darwin', fs);
    expect(plan.args).toContain('--remote-debugging-port=9222');
    expect(plan.args).toContain('--user-data-dir=/tmp/p');
    expect(plan.args).toContain('--no-first-run');
  });

  it('keeps a covered debug window from turning hidden by default (#402)', () => {
    const fs = { existsSync: () => true };
    const opts = parseSpawnDebugBrowserArgs(['chrome', '--exe', '/opt/browser'], { TMPDIR: '/tmp' });
    const plan = buildSpawnDebugBrowserPlan(opts, 'linux', fs);
    expect(opts.allowOcclusion).toBe(false);
    expect(plan.args).toContain('--disable-features=CalculateNativeWinOcclusion');
  });

  it('--allow-occlusion opts out of the occlusion default (#402)', () => {
    const fs = { existsSync: () => true };
    const opts = parseSpawnDebugBrowserArgs(['chrome', '--exe', '/opt/browser', '--allow-occlusion'], { TMPDIR: '/tmp' });
    const plan = buildSpawnDebugBrowserPlan(opts, 'linux', fs);
    expect(opts.allowOcclusion).toBe(true);
    expect(plan.args.some(arg => arg.startsWith('--disable-features='))).toBe(false);
  });

  it('documents the occlusion default and its opt-out in help (#402)', () => {
    const help = T.helpTopicStr('spawn-debug-browser');
    expect(help).toContain('--allow-occlusion');
    expect(help).toMatch(/CalculateNativeWinOcclusion/);
  });

  it('throws an actionable error when the executable is missing', () => {
    const fs = { existsSync: () => false };
    expect(() => buildSpawnDebugBrowserPlan({ browser: 'edge', port: 9222, profileDir: '/tmp/p' }, 'darwin', fs, { PATH: '' }))
      .toThrow(/Use --exe/);
  });
});

describe('spawnDebugBrowserStr', () => {
  const { spawnDebugBrowserStr } = T;

  it('keeps an error guard while destroying a connected port probe socket', async () => {
    class ResetOnDestroySocket extends EventEmitter {
      destroy() {
        const error = new Error('read ECONNRESET');
        error.code = 'ECONNRESET';
        this.emit('error', error);
      }
    }
    const socket = new ResetOnDestroySocket();
    const probe = T.probeTcpPort({
      host: '127.0.0.1',
      port: 9333,
      connect: () => {
        queueMicrotask(() => socket.emit('connect'));
        return socket;
      },
    });

    await expect(probe).resolves.toEqual({ occupied: true });
  });

  it('attaches when the requested port already has a live debug Chrome', async () => {
    let spawnCalls = 0;
    const fs = { existsSync: () => true, mkdirSync: () => {} };

    const out = await spawnDebugBrowserStr(['chrome', '--port', '9333'], { TMPDIR: '/tmp' }, {
      fs,
      platform: 'darwin',
      probeTcpPort: async () => ({ occupied: true }),
      waitForSpawnedCdp: async () => ({ ok: true, port: 9333, product: 'Chrome/126' }),
      spawn: () => {
        spawnCalls++;
        return { pid: 4242, unref() {} };
      },
    });

    expect(spawnCalls).toBe(0);
    expect(out).toContain('CDP_PORT=9333');
    expect(out).toContain('cdp list');
  });

  it('still rejects an occupied port that is not a live debug Chrome', async () => {
    let spawnCalls = 0;
    const fs = { existsSync: () => true, mkdirSync: () => {} };

    await expect(spawnDebugBrowserStr(['chrome', '--port', '9333'], { TMPDIR: '/tmp' }, {
      fs,
      platform: 'darwin',
      probeTcpPort: async () => ({ occupied: true }),
      waitForSpawnedCdp: async () => ({ ok: false, timeout: true }),
      spawn: () => {
        spawnCalls++;
        return { pid: 4242, unref() {} };
      },
    })).rejects.toThrow(/port 9333 is already in use.*choose another port/i);

    expect(spawnCalls).toBe(0);
  });

  it('reports the launch command and next-step usage', async () => {
    const calls = [];
    const fakeSpawn = (exe, args, _opts) => {
      calls.push({ exe, args });
      return { pid: 4242, unref() {} };
    };
    const fs = { existsSync: () => true, mkdirSync: () => {} };
    const out = await spawnDebugBrowserStr(['edge', '--port', '9311'], { TMPDIR: '/tmp' }, {
      fs,
      spawn: fakeSpawn,
      platform: 'darwin',
      probeTcpPort: async () => ({ occupied: false }),
      waitForSpawnedCdp: async () => ({ ok: true, port: 9311, product: 'Edge/126' }),
    });
    expect(out).toContain('Spawned edge debug profile on CDP_PORT=9311');
    expect(out).toContain('CDP ready');
    expect(out).toContain('Next: CDP_PORT=9311');
    expect(calls[0].args).toContain('--remote-debugging-port=9311');
  });
});
