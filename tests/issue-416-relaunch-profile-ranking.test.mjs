import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const DAILY = 'C:\\Users\\endea\\AppData\\Local\\chrome-cdp-ex\\daily-chrome';
const TEMP = 'C:\\Users\\endea\\AppData\\Local\\Temp/cdp-accept-profile2';
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function memoryIo(runtimeDir = mkdtempSync(join(tmpdir(), 'cdp-runtime-416-'))) {
  const files = new Map();
  let tick = 0;
  return {
    runtimeDir,
    now: () => Date.parse('2026-10-01T00:00:00.000Z') + (tick++) * 60_000,
    writer: (path, data) => files.set(path, String(data)),
    reader: path => {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    },
  };
}

function refused() {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:9342');
  err.code = 'ECONNREFUSED';
  throw err;
}

const SPAWN = 'spawn-debug-browser';

describe('#416 relaunch recovery picks the persistent profile last used on the port', () => {
  it('keeps every profile seen on a port even after a newer temp spawn overwrote the top-level record', () => {
    const io = memoryIo();
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: DAILY, exe: EXE, browser: 'chrome', via: SPAWN }, io);
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: TEMP, exe: EXE, browser: 'chrome', via: SPAWN }, io);
    const stored = T.readLastCdpEndpoint(io);
    expect(stored.profileDir).toBe(TEMP);
    expect(stored.history.map(entry => entry.profileDir).sort()).toEqual([DAILY, TEMP].sort());
    expect(stored.history.every(entry => entry.port === '9342' && entry.via === SPAWN)).toBe(true);
  });

  it('seeds the history from an old flat record, and a session sighting keeps the spawn marker', () => {
    const io = memoryIo();
    // An old flat record (no history, no via), as written before this fix.
    T.writeLastCdpEndpoint({ host: '127.0.0.1', port: '9342', profileDir: DAILY, exe: EXE, browser: 'chrome', launchedAt: '2026-09-30T00:00:00.000Z' }, io);
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: TEMP, exe: EXE, browser: 'chrome', via: SPAWN }, io);
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: TEMP, exe: EXE, browser: 'chrome' }, io);
    const stored = T.readLastCdpEndpoint(io);
    expect(stored.via).toBe(SPAWN);
    expect(stored.history).toHaveLength(2);
    expect(stored.history.find(entry => entry.profileDir === DAILY).via).toBeUndefined();
    expect(T.rankCdpRelaunchCandidates(stored, '9342').map(c => c.profileDir)).toEqual([DAILY, TEMP]);
  });

  it('names the persistent spawn-recorded profile, not the newer temp one, and lists both', () => {
    const io = memoryIo();
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: DAILY, exe: EXE, browser: 'chrome', via: SPAWN }, io);
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: TEMP, exe: EXE, browser: 'chrome', via: SPAWN }, io);
    const err = T.cdpUnreachableError({
      host: '127.0.0.1', port: '9342', cause: 'ECONNREFUSED', lastEndpoint: T.readLastCdpEndpoint(io),
    });
    expect(err.profileDir).toBe(DAILY);
    expect(err.relaunch).toBe(`cdp spawn-debug-browser chrome --port 9342 --profile-dir '${DAILY}' --exe '${EXE}'`);
    expect(err.relaunch).not.toMatch(/chrome\.exe --remote-debugging-port/);
    expect(err.candidates.map(c => c.profileDir)).toEqual([DAILY, TEMP]);
    expect(err.candidates.map(c => c.temp)).toEqual([false, true]);
    expect(err.message).toContain(err.relaunch);
    expect(err.message).toContain(TEMP);
    expect(T.buildCliErrorModel(err, { cmd: 'list' }).recovery).toMatchObject({
      strategy: 'relaunch-same-profile',
      run: err.relaunch,
      candidates: [expect.objectContaining({ profileDir: DAILY }), expect.objectContaining({ profileDir: TEMP })],
    });
  });

  it('ranks spawn-recorded persistent, other persistent, spawn-recorded temp, other temp', () => {
    const ranked = T.rankCdpRelaunchCandidates({
      port: '9342',
      history: [
        { port: '9342', profileDir: '/tmp/seen-temp', lastSeenAt: '2026-10-01T05:00:00.000Z' },
        { port: '9342', profileDir: '/tmp/spawn-temp', via: SPAWN, lastSeenAt: '2026-10-01T04:00:00.000Z' },
        { port: '9342', profileDir: '/home/me/seen-persistent', lastSeenAt: '2026-10-01T03:00:00.000Z' },
        { port: '9342', profileDir: '/home/me/spawn-persistent', via: SPAWN, lastSeenAt: '2026-10-01T01:00:00.000Z' },
      ],
    }, '9342');
    expect(ranked.map(c => c.profileDir)).toEqual([
      '/home/me/spawn-persistent', '/home/me/seen-persistent', '/tmp/spawn-temp', '/tmp/seen-temp',
    ]);
  });

  it('prefers the newest candidate inside a tier', () => {
    const ranked = T.rankCdpRelaunchCandidates({
      port: '9342',
      history: [
        { port: '9342', profileDir: '/home/me/old', via: SPAWN, lastSeenAt: '2026-10-01T01:00:00.000Z' },
        { port: '9342', profileDir: '/home/me/new', via: SPAWN, lastSeenAt: '2026-10-01T02:00:00.000Z' },
      ],
    }, '9342');
    expect(ranked.map(c => c.profileDir)).toEqual(['/home/me/new', '/home/me/old']);
  });

  it('never offers a profile recorded for another port', () => {
    const record = {
      host: '127.0.0.1', port: '9333', profileDir: '/home/me/other-port', browser: 'chrome',
      history: [{ port: '9333', profileDir: '/home/me/other-port' }],
    };
    expect(T.rankCdpRelaunchCandidates(record, '9342')).toEqual([]);
    const err = T.cdpUnreachableError({ host: '127.0.0.1', port: '9342', cause: 'ECONNREFUSED', lastEndpoint: record });
    expect(err.profileDir).toBeNull();
    expect(err.relaunch).toBeNull();
    expect(err.message).toMatch(/do not invent a new --user-data-dir/i);
  });

  it('classifies Windows and POSIX temp paths as temp and daily dirs as persistent', () => {
    expect(T.isTempCdpProfileDir(TEMP)).toBe(true);
    expect(T.isTempCdpProfileDir('/tmp/cdp-accept-profile2')).toBe(true);
    expect(T.isTempCdpProfileDir('/var/folders/ab/xyz/T/chrome-cdp-ex-chrome-debug-profile-9342')).toBe(true);
    expect(T.isTempCdpProfileDir(DAILY)).toBe(false);
    expect(T.isTempCdpProfileDir('D:/work/tmp/chrome-profile')).toBe(false);
    expect(T.isTempCdpProfileDir('/home/me/temp/prof')).toBe(false);
    expect(T.isTempCdpProfileDir('/home/me/.config/chrome-cdp-ex/daily-chrome')).toBe(false);
  });

  it('a single candidate keeps the old one-line message without a candidate list', () => {
    const err = T.cdpUnreachableError({
      host: '127.0.0.1', port: '9342', cause: 'ECONNREFUSED',
      lastEndpoint: { host: '127.0.0.1', port: '9342', profileDir: '/home/me/only', exe: '/opt/chrome', browser: 'chrome' },
    });
    expect(err.relaunch).toBe('/opt/chrome --remote-debugging-port=9342 --user-data-dir /home/me/only');
    expect(err.candidates).toHaveLength(1);
    expect(err.message).not.toMatch(/other profiles/i);
  });

  it('doctor names the persistent profile, suggests the spawn command, and lists the candidates', async () => {
    const lastEndpoint = {
      host: '127.0.0.1', port: '9342', profileDir: TEMP, exe: EXE, browser: 'chrome', via: SPAWN,
      history: [
        { port: '9342', profileDir: DAILY, exe: EXE, browser: 'chrome', via: SPAWN, lastSeenAt: '2026-10-01T01:00:00.000Z' },
        { port: '9342', profileDir: TEMP, exe: EXE, browser: 'chrome', via: SPAWN, lastSeenAt: '2026-10-01T02:00:00.000Z' },
      ],
    };
    const check = await T.checkCdpReachability({
      env: { CDP_PORT: '9342' },
      fetcher: async () => refused(),
      lastEndpoint,
      connectWebSocket: () => { throw new Error('WebSocket fallback should not run'); },
    });
    const relaunch = `cdp spawn-debug-browser chrome --port 9342 --profile-dir '${DAILY}' --exe '${EXE}'`;
    expect(check).toMatchObject({ status: 'FAIL', error: 'cdp_unreachable', profileDir: DAILY, relaunch });
    expect(check.hint).toBe(relaunch);
    expect(check.candidates.map(c => c.profileDir)).toEqual([DAILY, TEMP]);

    const model = T.buildDoctorModel([check]);
    expect(model.recommendation).toMatchObject({ strategy: 'relaunch-same-profile', run: relaunch });
    expect(model.recommendation.ask).toContain(TEMP);
    expect(model.recommendation.candidates.map(c => c.profileDir)).toEqual([DAILY, TEMP]);
  });

  it('separates the candidate list from the command in the error message', () => {
    const err = T.cdpUnreachableError({
      host: '127.0.0.1', port: '9342', cause: 'ECONNREFUSED',
      lastEndpoint: {
        port: '9342',
        history: [
          { port: '9342', profileDir: '/home/me/a', via: SPAWN, lastSeenAt: '2026-10-01T02:00:00.000Z' },
          { port: '9342', profileDir: '/home/me/b', via: SPAWN, lastSeenAt: '2026-10-01T01:00:00.000Z' },
        ],
      },
    });
    const [first, second] = err.message.split('\n');
    expect(first.endsWith(err.relaunch)).toBe(true);
    expect(second).toMatch(/^Other profiles seen on this port: \/home\/me\/b/);
  });

  it('temp spawn churn cannot evict the persistent profile from the bounded history', () => {
    const io = memoryIo();
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: DAILY, browser: 'chrome', via: SPAWN }, io);
    for (let i = 0; i < 30; i++) {
      T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9400 + i, profileDir: `/tmp/cdp-accept-${i}`, browser: 'chrome', via: SPAWN }, io);
    }
    const stored = T.readLastCdpEndpoint(io);
    expect(stored.history.length).toBeLessThanOrEqual(24);
    expect(stored.history.some(entry => entry.profileDir === DAILY)).toBe(true);
    expect(T.rankCdpRelaunchCandidates(stored, '9342').map(c => c.profileDir)).toEqual([DAILY]);
  });

  it('one busy port cannot push another port out of the history, and the same dir spelled two ways is one candidate', () => {
    const io = memoryIo();
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: DAILY, browser: 'chrome', via: SPAWN }, io);
    for (let i = 0; i < 10; i++) {
      T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9500, profileDir: `/home/me/busy-${i}`, browser: 'chrome', via: SPAWN }, io);
    }
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: DAILY.replace(/\\/g, '/').toLowerCase() + '/' }, io);
    const stored = T.readLastCdpEndpoint(io);
    expect(stored.history.filter(entry => entry.port === '9500')).toHaveLength(4);
    const ranked = T.rankCdpRelaunchCandidates(stored, '9342');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].via).toBe(SPAWN);
  });

  it('a record with a profile but no port still relaunches on the old default port', () => {
    const err = T.cdpUnreachableError({
      host: '127.0.0.1', cause: 'ECONNREFUSED',
      lastEndpoint: { host: '127.0.0.1', profileDir: '/home/me/only', exe: '/opt/chrome', browser: 'chrome' },
    });
    expect(err.relaunch).toBe('/opt/chrome --remote-debugging-port=9222 --user-data-dir /home/me/only');
  });

  it('spawn-debug-browser records via=spawn-debug-browser for the profile it launched', async () => {
    const remembered = [];
    const fs = {
      existsSync: () => true,
      mkdirSync: () => {},
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      statSync: () => ({ isDirectory: () => true }),
    };
    const child = {
      pid: 1234, unref: () => {},
      stdout: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      stderr: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      on: () => {}, once: () => {},
    };
    await T.spawnDebugBrowserStr(
      ['chrome', '--port', '9342', '--profile-dir', '/home/me/persistent', '--exe', '/opt/chromium/chrome'],
      { TMPDIR: '/tmp', PATH: '' },
      {
        platform: 'linux', fs, spawn: () => child,
        probeTcpPort: async () => ({ occupied: false }),
        waitForSpawnedCdp: async ({ port }) => ({ ok: true, port, product: 'Chrome/126.0.0.0' }),
        rememberLastCdpEndpoint: record => remembered.push(record),
      },
    );
    expect(remembered).toEqual([expect.objectContaining({ port: 9342, profileDir: '/home/me/persistent', via: SPAWN })]);
  });
});
