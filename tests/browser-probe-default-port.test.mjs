import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #356 probe 127.0.0.1:9224 when DevToolsActivePort is missing', () => {
  const previousEnv = {};

  function isolateEmptyProfileHome() {
    const fakeHome = mkdtempSync(join(tmpdir(), 'cdp-356-home-'));
    for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'CDP_PORT', 'CDP_PORT_FILE', 'CDP_HOST']) {
      previousEnv[key] = process.env[key];
    }
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.LOCALAPPDATA = join(fakeHome, 'AppData', 'Local');
    delete process.env.CDP_PORT;
    delete process.env.CDP_PORT_FILE;
    delete process.env.CDP_HOST;
    return fakeHome;
  }

  function restoreIsolatedHome(fakeHome) {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  }

  function emptyDiscoveryEnv(fakeHome) {
    return {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
    };
  }

  it('#356 discovers ws url from 127.0.0.1:9224 /json/version when no env and no DevToolsActivePort file', async () => {
    const fakeHome = isolateEmptyProfileHome();
    try {
      const fetched = [];
      const fetcher = async (url) => {
        fetched.push(url);
        if (String(url).includes(':9222/')) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Browser: 'Chrome/151.0.0.0',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9224/devtools/browser/4C9C3AC5',
          }),
        };
      };

      await expect(T.getWsUrl({
        env: emptyDiscoveryEnv(fakeHome),
        fetcher,
        lastEndpoint: null,
        rememberEndpoint: () => {},
      })).resolves.toBe('ws://127.0.0.1:9224/devtools/browser/4C9C3AC5');
      expect(fetched).toEqual([
        'http://127.0.0.1:9222/json/version',
        'http://127.0.0.1:9224/json/version',
      ]);
    } finally {
      restoreIsolatedHome(fakeHome);
    }
  });

  it('#356 falls back to ws://127.0.0.1:9224/devtools/browser when /json/version is 404', async () => {
    const fakeHome = isolateEmptyProfileHome();
    try {
      const fetcher = async (url) => {
        if (String(url).includes(':9222/')) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };
      await expect(T.getWsUrl({
        env: emptyDiscoveryEnv(fakeHome),
        fetcher,
        lastEndpoint: null,
        rememberEndpoint: () => {},
      })).resolves.toBe('ws://127.0.0.1:9224/devtools/browser');
    } finally {
      restoreIsolatedHome(fakeHome);
    }
  });

  it('#356 still fails as environment when 127.0.0.1:9224 is closed', async () => {
    const fakeHome = isolateEmptyProfileHome();
    try {
      const fetcher = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9224');
      };
      // The attach miss runs the environment check; it must never execute a
      // browser binary here (#456: `chrome.exe --version` launches Chrome).
      const spawned = [];
      await expect(T.getWsUrl({
        env: emptyDiscoveryEnv(fakeHome),
        fetcher,
        lastEndpoint: null,
        rememberEndpoint: () => {},
        environmentCheck: () => T.checkRuntimeEnvironment({
          env: emptyDiscoveryEnv(fakeHome),
          spawnSyncFn: (cmd, args) => {
            spawned.push([cmd, ...(args || [])]);
            return { status: 1, stdout: '', stderr: '' };
          },
        }),
      })).rejects.toThrow(/No DevToolsActivePort and no CDP_PORT set/);
      if (process.platform === 'win32') expect(spawned).toEqual([]);

      const doctor = await T.checkCdpReachability({
        env: emptyDiscoveryEnv(fakeHome),
        fetcher,
        lastEndpoint: null,
        rememberEndpoint: () => {},
      });
      expect(doctor.status).toBe('FAIL');
      expect(doctor.detail).toMatch(/no DevToolsActivePort and no CDP_PORT set/i);
      expect(doctor.error).not.toBe('cdp_unreachable');
    } finally {
      restoreIsolatedHome(fakeHome);
    }
  });

  it('#356 doctor CDP check PASSes on the same 9224 /json/version probe', async () => {
    const fakeHome = isolateEmptyProfileHome();
    try {
      const fetcher = async (url) => {
        if (String(url).includes(':9222/')) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
        }
        expect(url).toBe('http://127.0.0.1:9224/json/version');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Browser: 'Chrome/151.0.0.0',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9224/devtools/browser/F0C6A8F5',
          }),
        };
      };
      const r = await T.checkCdpReachability({
        env: emptyDiscoveryEnv(fakeHome),
        fetcher,
        lastEndpoint: null,
        rememberEndpoint: () => {},
      });
      expect(r.status).toBe('OK');
      expect(r.port).toBe('9224');
      expect(r.host).toBe('127.0.0.1');
      expect(r.detail).toMatch(/9224/);
      expect(r.detail).toMatch(/Chrome\/151/);
    } finally {
      restoreIsolatedHome(fakeHome);
    }
  });
});
