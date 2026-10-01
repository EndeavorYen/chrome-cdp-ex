// #438: relaunch-same-profile repeats background mode and matches profile folders by normalized path.
// #441: background mode set by `open --background` survives a tab daemon restart.
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const SPAWN = 'spawn-debug-browser';
const EXE = '/opt/chrome/chrome';
const WITH_DISPLAY = { platform: 'linux', env: { DISPLAY: ':0' } };
const NO_DISPLAY = { platform: 'linux', env: {} };
const THROTTLE_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

function memoryIo() {
  const files = new Map();
  let tick = 0;
  return {
    runtimeDir: '/virtual/runtime',
    now: () => Date.parse('2026-10-01T00:00:00.000Z') + (tick++) * 60_000,
    writer: (path, data) => files.set(path, String(data)),
    reader: path => {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    },
  };
}

async function spawnRecord(args) {
  const remembered = [];
  const child = {
    pid: 1234, unref: () => {},
    stdout: { on: () => {}, setEncoding: () => {}, unref: () => {} },
    stderr: { on: () => {}, setEncoding: () => {}, unref: () => {} },
    on: () => {}, once: () => {},
  };
  await T.spawnDebugBrowserStr(
    ['chrome', '--port', '9342', '--profile-dir', '/home/me/persistent', '--exe', EXE, ...args],
    { TMPDIR: '/tmp', PATH: '' },
    {
      platform: 'linux',
      fs: {
        existsSync: () => true,
        mkdirSync: () => {},
        lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
        statSync: () => ({ isDirectory: () => true }),
      },
      spawn: () => child,
      probeTcpPort: async () => ({ occupied: false }),
      waitForSpawnedCdp: async ({ port }) => ({ ok: true, port, product: 'Chrome/153' }),
      listSpawnedDebugTargets: async () => [],
      minimizeBrowserWindows: async () => ({ minimized: 0 }),
      rememberLastCdpEndpoint: record => remembered.push(record),
    },
  );
  return remembered[0];
}

describe('#438 relaunch hint repeats background mode', () => {
  it('spawn-debug-browser --background records the anti-throttling flags it launched with', async () => {
    const record = await spawnRecord(['--background', '--headless']);
    expect(record.via).toBe(SPAWN);
    expect(record.launchFlags).toEqual([
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      ...THROTTLE_FLAGS,
    ]);
  });

  it('the spawn-debug-browser form repeats --background, --headless and the browser name', async () => {
    const record = await spawnRecord(['--background', '--headless']);
    const entry = { ...record, port: String(record.port) };
    expect(T.formatCdpRelaunchCommand(entry, { display: WITH_DISPLAY })).toBe(
      `cdp spawn-debug-browser chrome --port 9342 --profile-dir /home/me/persistent --exe ${EXE} --headless --background`,
    );
    const headed = await spawnRecord(['--background']);
    expect(T.formatCdpRelaunchCommand({ ...headed, port: '9342' }, { display: WITH_DISPLAY })).toBe(
      `cdp spawn-debug-browser chrome --port 9342 --profile-dir /home/me/persistent --exe ${EXE} --background`,
    );
  });

  it('the background flags survive the endpoint record round trip and ranking', async () => {
    const io = memoryIo();
    T.rememberLastCdpEndpoint(await spawnRecord(['--background']), io);
    // A later attach sighting without flags must not erase them.
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342, profileDir: '/home/me/persistent', exe: EXE }, io);
    const [top] = T.rankCdpRelaunchCandidates(T.readLastCdpEndpoint(io), '9342', { display: NO_DISPLAY });
    expect(top.relaunch).toBe(
      `cdp spawn-debug-browser chrome --port 9342 --profile-dir /home/me/persistent --exe ${EXE} --headless --background`,
    );
  });

  it('a spawn without --background does not gain it (mode off: unchanged hint)', async () => {
    const record = await spawnRecord(['--headless']);
    expect(record.launchFlags).toEqual(['--remote-debugging-address=127.0.0.1', '--headless=new']);
    expect(T.formatCdpRelaunchCommand({ ...record, port: '9342' }, { display: WITH_DISPLAY })).toBe(
      `cdp spawn-debug-browser chrome --port 9342 --profile-dir /home/me/persistent --exe ${EXE} --headless`,
    );
  });

  it('the raw browser line replays the anti-throttling flags verbatim (it cannot minimize, so it does not claim --background)', () => {
    const entry = { port: '9342', profileDir: '/home/me/persistent', exe: EXE, launchFlags: ['--headless=new', ...THROTTLE_FLAGS] };
    expect(T.formatCdpRelaunchCommand(entry, { display: WITH_DISPLAY })).toBe(
      `${EXE} --remote-debugging-port=9342 --user-data-dir=/home/me/persistent --headless=new ${THROTTLE_FLAGS.join(' ')}`,
    );
    // A spawn-created profile with a flag spawn-debug-browser cannot pass falls back to the raw line,
    // and the background flags stay on it.
    expect(T.formatCdpRelaunchCommand({ ...entry, via: SPAWN, launchFlags: ['--disable-dev-shm-usage', ...THROTTLE_FLAGS] }, { display: WITH_DISPLAY })).toBe(
      `${EXE} --remote-debugging-port=9342 --user-data-dir=/home/me/persistent --disable-dev-shm-usage ${THROTTLE_FLAGS.join(' ')}`,
    );
  });

  it('only the full anti-throttling set maps to --background; a partial set keeps the raw line', () => {
    const entry = { port: '9342', profileDir: '/home/me/persistent', exe: EXE, browser: 'chrome', via: SPAWN };
    expect(T.formatCdpRelaunchCommand({ ...entry, launchFlags: [THROTTLE_FLAGS[1]] }, { display: WITH_DISPLAY })).toBe(
      `${EXE} --remote-debugging-port=9342 --user-data-dir=/home/me/persistent ${THROTTLE_FLAGS[1]}`,
    );
  });
});

describe('#438 profile folders compare after normalization', () => {
  it('one key per folder: resolved, one slash style, case-insensitive for Windows paths', () => {
    const same = (a, b, platform = 'linux') => expect(T.cdpProfileKey(a, platform), `${a} vs ${b}`).toBe(T.cdpProfileKey(b, platform));
    same('C:\\Users\\Me\\prof', 'c:/users/me/prof/');
    same('C:\\Users\\Me\\.\\prof', 'C:\\Users\\Me\\prof');
    same('C:\\Users\\Me\\x\\..\\prof', 'c:\\users\\me\\prof');
    same('\\\\Srv\\Share\\Prof', '\\\\srv\\share\\prof');
    same('/home/me//prof', '/home/me/prof');
    same('/home/me/x/../prof/', '/home/me/prof');
    // POSIX folders stay case-sensitive.
    expect(T.cdpProfileKey('/home/Me/prof', 'linux')).not.toBe(T.cdpProfileKey('/home/me/prof', 'linux'));
    expect(T.cdpProfileKey('', 'linux')).toBe('');
  });

  it('ranking folds spellings of one folder into one candidate and keeps the spawn tag', () => {
    for (const [spawned, seen] of [
      ['/home/me/x/../prof', '/home/me/prof'],
      ['/home/me//prof', '/home/me/prof'],
      ['\\\\Srv\\Share\\Prof', '\\\\srv\\share\\prof'],
      ['C:\\Users\\Me\\.\\prof', 'c:/users/me/prof'],
    ]) {
      const record = {
        port: '9342',
        profileDir: seen,
        history: [
          { port: '9342', profileDir: spawned, exe: EXE, browser: 'chrome', via: SPAWN, lastSeenAt: '2026-01-01T00:00:00.000Z' },
          { port: '9342', profileDir: seen, exe: EXE, lastSeenAt: '2026-02-01T00:00:00.000Z' },
        ],
      };
      const candidates = T.rankCdpRelaunchCandidates(record, '9342', { display: WITH_DISPLAY });
      expect(candidates, spawned).toHaveLength(1);
      expect(candidates[0].via).toBe(SPAWN);
      expect(candidates[0].relaunch).toMatch(/^cdp spawn-debug-browser chrome --port 9342 --profile-dir /);
    }
  });

  it('the record keeps its spawn tag when the folder is spelled differently than in history', () => {
    const io = memoryIo();
    io.writer(T.lastCdpEndpointPath(io.runtimeDir), JSON.stringify({
      schema: 'chrome-cdp-ex.cdp-last-endpoint.v1',
      host: '127.0.0.1',
      port: '9342',
      profileDir: 'C:\\Users\\Me\\prof',
      exe: 'C:\\chrome.exe',
      browser: 'chrome',
      via: SPAWN,
      history: [{ port: '9342', profileDir: 'c:/users/me/prof', exe: 'C:\\chrome.exe', browser: 'chrome', via: SPAWN, lastSeenAt: '2026-01-01T00:00:00.000Z' }],
    }));
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9342 }, io);
    expect(T.readLastCdpEndpoint(io).via).toBe(SPAWN);
  });
});

describe('#438 temp-folder check', () => {
  it('falls back to the system temp folder for paths the fixed patterns miss', () => {
    expect(T.isTempCdpProfileDir('/srv/scratch/prof', { tempRoot: '/srv/scratch' })).toBe(true);
    expect(T.isTempCdpProfileDir('/srv/scratch//a/../prof', { tempRoot: '/srv/scratch/' })).toBe(true);
    expect(T.isTempCdpProfileDir('/srv/scratchy/prof', { tempRoot: '/srv/scratch' })).toBe(false);
    expect(T.isTempCdpProfileDir('/srv/scratch', { tempRoot: '/srv/scratch' })).toBe(false);
    expect(T.isTempCdpProfileDir('D:/Scratch/Prof', { tempRoot: 'd:\\scratch' })).toBe(true);
    expect(T.isTempCdpProfileDir('/home/me/prof', { tempRoot: '' })).toBe(false);
    // The fixed patterns do not depend on the fallback.
    expect(T.isTempCdpProfileDir('/tmp/prof', { tempRoot: '/srv/scratch' })).toBe(true);
  });

  it('reads the system temp folder once, not on every call', () => {
    const read = vi.fn(() => '/srv/scratch');
    const tempRoot = T.createSystemTempRootReader(read);
    expect(tempRoot()).toBe('/srv/scratch');
    expect(tempRoot()).toBe('/srv/scratch');
    expect(read).toHaveBeenCalledTimes(1);
    const broken = T.createSystemTempRootReader(() => { throw new Error('no temp'); });
    expect(broken()).toBe('');
  });
});

describe('#441 background mode set by open --background survives a daemon restart', () => {
  const fakeCdp = () => {
    const send = vi.fn(async method => (method === 'Target.attachToTarget' ? { sessionId: 'S1' } : {}));
    return { send };
  };
  const methodsOf = cdp => cdp.send.mock.calls.map(call => call[0]);
  const scratch = () => mkdtempSync(join(tmpdir(), 'cdp-runtime-441-'));

  it('open --background records the mode for its tab', () => {
    const runtimeDir = scratch();
    expect(T.writeTabBackgroundMode('TARGET441', { runtimeDir })).toBe(true);
    expect(T.readTabBackgroundMode('TARGET441', { runtimeDir })).toBe(true);
    expect(JSON.parse(readFileSync(T.tabModePath('TARGET441', runtimeDir), 'utf8'))).toMatchObject({
      schema: 'chrome-cdp-ex.tab-mode.v1',
      targetId: 'TARGET441',
      background: true,
    });
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('a daemon restarted without CDP_BACKGROUND does not activate that tab', async () => {
    const runtimeDir = scratch();
    T.writeTabBackgroundMode('TARGET441', { runtimeDir });
    // Restart (idle exit or crash): a later command starts the daemon with the plain environment.
    const background = T.daemonBackgroundMode('TARGET441', { env: {}, runtimeDir });
    expect(background).toBe(true);
    const cdp = fakeCdp();
    await expect(T.attachDaemonTarget(cdp, 'TARGET441', { background })).resolves.toBe('S1');
    expect(methodsOf(cdp)).toEqual(['Target.attachToTarget']);
    expect(methodsOf(cdp)).not.toContain('Target.activateTarget');
    // Only the tab it was turned on for.
    expect(T.daemonBackgroundMode('OTHERTAB', { env: {}, runtimeDir })).toBe(false);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('with the mode off nothing is recorded and the daemon still activates the tab', async () => {
    const runtimeDir = scratch();
    expect(existsSync(T.tabModePath('TARGET441', runtimeDir))).toBe(false);
    const background = T.daemonBackgroundMode('TARGET441', { env: {}, runtimeDir });
    expect(background).toBe(false);
    const cdp = fakeCdp();
    await T.attachDaemonTarget(cdp, 'TARGET441', { background });
    expect(cdp.send.mock.calls).toEqual([
      ['Target.activateTarget', { targetId: 'TARGET441' }],
      ['Target.attachToTarget', { targetId: 'TARGET441', flatten: true }],
    ]);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('CDP_BACKGROUND=1 still turns the mode on for any tab', () => {
    const runtimeDir = scratch();
    expect(T.daemonBackgroundMode('ANY', { env: { CDP_BACKGROUND: '1' }, runtimeDir })).toBe(true);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('ignores a malformed or foreign mode record, and forgets the mode once the tab is gone', () => {
    const runtimeDir = scratch();
    const reader = () => JSON.stringify({ schema: 'chrome-cdp-ex.tab-mode.v1', targetId: 'SOMEONEELSE', background: true });
    expect(T.readTabBackgroundMode('TARGET441', { runtimeDir, reader })).toBe(false);
    expect(T.readTabBackgroundMode('TARGET441', { runtimeDir, reader: () => '{oops' })).toBe(false);
    T.writeTabBackgroundMode('TARGET441', { runtimeDir });
    expect(T.readTabBackgroundMode('TARGET441', { runtimeDir })).toBe(true);
    T.removeTabMode('TARGET441', { runtimeDir });
    expect(T.readTabBackgroundMode('TARGET441', { runtimeDir })).toBe(false);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('closetab removes the mode record of the tab it closes', async () => {
    const runtimeDir = scratch();
    T.writeTabBackgroundMode('TARGET441', { runtimeDir });
    T.writeTabBackgroundMode('OTHERTAB', { runtimeDir });
    const cdp = { send: vi.fn(async () => ({})) };
    await expect(T.closetabStr(cdp, 'TARGET441', { force: true, runtimeDir })).resolves.toBe('Closed tab: TARGET44');
    expect(cdp.send.mock.calls.map(call => call[0])).toEqual(['Target.closeTarget']);
    expect(T.readTabBackgroundMode('TARGET441', { runtimeDir })).toBe(false);
    expect(T.readTabBackgroundMode('OTHERTAB', { runtimeDir })).toBe(true);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('keeps the mode files bounded', () => {
    const runtimeDir = scratch();
    for (let i = 0; i < T.TAB_MODE_RECORDS_MAX + 5; i++) {
      T.writeTabBackgroundMode(`TAB${String(i).padStart(4, '0')}`, { runtimeDir, now: () => 1_000_000 + i });
    }
    expect(T.readTabBackgroundMode('TAB0000', { runtimeDir })).toBe(false);
    expect(T.readTabBackgroundMode(`TAB${String(T.TAB_MODE_RECORDS_MAX + 4).padStart(4, '0')}`, { runtimeDir })).toBe(true);
    expect(T.listTabModeRecords({ runtimeDir })).toHaveLength(T.TAB_MODE_RECORDS_MAX);
    rmSync(runtimeDir, { recursive: true, force: true });
    // ~70 writes, each re-listing and re-reading every record: a few thousand small file reads,
    // which Windows (antivirus scanning each open) serves far slower than Linux under load.
  }, 60_000);

  it('writes mode records into the isolated test runtime dir by default', () => {
    if (process.platform === 'win32') return;
    expect(T.tabModePath('ABCDEF0123456789').startsWith(resolve(process.env.XDG_RUNTIME_DIR, 'cdp') + sep)).toBe(true);
  });
});
