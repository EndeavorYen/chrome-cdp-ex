import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const EXE = '/opt/chromium/chrome';
const DAILY = '/home/me/.config/chrome-cdp-ex/daily-chrome';
const WS = 'ws://127.0.0.1:9333/devtools/browser/abc';
const HEADLESS_ARGV = [
  EXE,
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9333',
  `--user-data-dir=${DAILY}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--headless=new',
  '--no-sandbox',
  '--noerrdialogs',
  '--ozone-platform=headless',
  '--use-angle=swiftshader-webgl',
  'http://127.0.0.1:8766/app.html',
];
const NO_DISPLAY = { platform: 'linux', env: {} };
const WITH_DISPLAY = { platform: 'linux', env: { DISPLAY: ':0' } };

function refused(port) {
  const err = new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
  err.code = 'ECONNREFUSED';
  return err;
}

// Only `live` ports answer /json/version; every other port refuses.
function fetcherFor(live = {}) {
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(String(url));
    const port = String(url).match(/:(\d+)\//)?.[1];
    if (!live[port]) throw refused(port);
    return {
      ok: true,
      status: 200,
      json: async () => ({ Browser: 'Chrome/153.0.8010.12', webSocketDebuggerUrl: live[port] }),
    };
  };
  return { fetcher, fetched };
}

const notRunning = () => ({ alive: false, pid: null, argv: null, port: null });

// The user's record from #425: the persistent daily-chrome profile last seen on 9333.
const REMEMBERED_9333 = {
  host: '127.0.0.1',
  port: '9333',
  profileDir: DAILY,
  exe: EXE,
  browser: 'chrome',
  launchedAt: '2026-09-30T04:43:42.184Z',
  history: [{ port: '9333', profileDir: DAILY, exe: EXE, browser: 'chrome', lastSeenAt: '2026-09-30T04:43:42.184Z' }],
};

let fakeHome;
const savedEnv = {};
beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cdp-425-home-'));
  for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'CDP_PORT', 'CDP_PORT_FILE', 'CDP_HOST', 'CDP_LAST_PORT']) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.LOCALAPPDATA = join(fakeHome, 'AppData', 'Local');
  for (const key of ['CDP_PORT', 'CDP_PORT_FILE', 'CDP_HOST', 'CDP_LAST_PORT']) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fakeHome, { recursive: true, force: true });
});

function emptyEnv() {
  return { HOME: fakeHome, USERPROFILE: fakeHome, LOCALAPPDATA: join(fakeHome, 'AppData', 'Local') };
}

async function doctorAndList({ live = {}, lastEndpoint, inspectProfileProcess = notRunning, display = NO_DISPLAY, environmentCheck } = {}) {
  const env = emptyEnv();
  const doctorFetch = fetcherFor(live);
  const check = await T.checkCdpReachability({
    env,
    fetcher: doctorFetch.fetcher,
    lastEndpoint,
    rememberEndpoint: () => {},
    home: fakeHome,
    existsSync: () => false,
    inspectProfileProcess,
    display,
    connectWebSocket: () => { throw new Error('WebSocket fallback should not run'); },
  });
  const checks = [environmentCheck, check].filter(Boolean);
  const doctor = T.buildDoctorModel(checks);
  const listFetch = fetcherFor(live);
  let listError = null;
  let listUrl = null;
  try {
    listUrl = await T.getWsUrl({
      env,
      fetcher: listFetch.fetcher,
      lastEndpoint,
      rememberEndpoint: () => {},
      inspectProfileProcess,
      display,
      environmentCheck: () => environmentCheck || null,
    });
  } catch (error) {
    listError = error;
  }
  return { check, doctor, doctorText: T.formatDoctorOutput(checks), listUrl, listError, doctorFetched: doctorFetch.fetched, listFetched: listFetch.fetched };
}

describe('#425 unprefixed discovery probes the remembered endpoint', () => {
  it('attaches to the remembered port when it answers /json/version (doctor and list)', async () => {
    const r = await doctorAndList({ live: { 9333: WS }, lastEndpoint: REMEMBERED_9333 });
    expect(r.listError).toBeNull();
    expect(r.listUrl).toBe(WS);
    expect(r.listFetched).toEqual([
      'http://127.0.0.1:9222/json/version',
      'http://127.0.0.1:9224/json/version',
      'http://127.0.0.1:9333/json/version',
    ]);
    expect(r.check).toMatchObject({ status: 'OK', label: 'CDP', host: '127.0.0.1', port: '9333' });
    expect(r.check.detail).toMatch(/127\.0\.0\.1:9333 .*remembered/);
    expect(r.doctorText).not.toMatch(/no DevToolsActivePort/);
    expect(r.doctorText).not.toMatch(/spawn-debug-browser/);
  });

  it('keeps 9222, CDP_LAST_PORT, DevToolsActivePort and 9224 ahead of the remembered port', async () => {
    const r = await doctorAndList({
      live: { 9224: 'ws://127.0.0.1:9224/devtools/browser/x', 9333: WS },
      lastEndpoint: REMEMBERED_9333,
    });
    expect(r.listUrl).toBe('ws://127.0.0.1:9224/devtools/browser/x');
    expect(r.listFetched).not.toContain('http://127.0.0.1:9333/json/version');
    expect(r.check).toMatchObject({ status: 'OK', port: '9224' });
  });

  it('a live isolated chrome-cdp-ex profile on the remembered port is named, not attached', async () => {
    const isolated = '/tmp/chrome-cdp-ex-chrome-debug-profile-9333';
    const lastEndpoint = { ...REMEMBERED_9333, profileDir: isolated, history: [{ port: '9333', profileDir: isolated }] };
    const r = await doctorAndList({ live: { 9333: WS }, lastEndpoint });
    expect(r.listError?.code).toBe('cdp_isolated_occupant');
    expect(r.listError.message).toMatch(/CDP_PORT=9333/);
    expect(r.check).toMatchObject({ status: 'FAIL', isolatedOccupant: true, port: '9333' });
  });

  it('a dead remembered port gives one diagnosis and one Next in doctor and list', async () => {
    const r = await doctorAndList({ lastEndpoint: REMEMBERED_9333 });
    expect(r.listFetched).toContain('http://127.0.0.1:9333/json/version');
    const relaunch = `${EXE} --remote-debugging-port=9333 --user-data-dir=${DAILY} --headless=new`;
    expect(r.check).toMatchObject({ status: 'FAIL', error: 'cdp_unreachable', port: '9333', profileDir: DAILY, relaunch });
    expect(r.check.detail).toMatch(/cannot reach 127\.0\.0\.1:9333/);
    expect(r.check.detail).toMatch(/ECONNREFUSED/);
    expect(r.doctor.recommendation).toMatchObject({ strategy: 'relaunch-same-profile', run: relaunch });
    expect(r.doctorText).toContain(`Next: ${relaunch}`);

    expect(r.listError).toMatchObject({ code: 'cdp_unreachable', port: '9333', profileDir: DAILY, relaunch });
    expect(r.listError.message).toMatch(/ECONNREFUSED/);
    const listText = T.formatCliError(r.listError, { cmd: 'list' });
    expect(listText).toContain(`Next: ${relaunch}`);
    expect(T.buildCliErrorModel(r.listError, { cmd: 'list' }).recovery).toMatchObject({ strategy: 'relaunch-same-profile', run: relaunch });
  });

  it('with no remembered endpoint doctor and list give the same Next', async () => {
    const environmentCheck = {
      status: 'OK',
      label: 'Environment',
      detail: 'linux',
      environment: { platform: 'linux', preferredBrowser: { browser: 'chrome', executable: EXE } },
    };
    const r = await doctorAndList({ lastEndpoint: null, environmentCheck });
    expect(r.check.status).toBe('FAIL');
    expect(r.check.detail).toMatch(/no DevToolsActivePort and no CDP_PORT set/i);
    const doctorNext = r.doctor.recommendation.run;
    expect(doctorNext).toMatch(/spawn-debug-browser chrome --port 9222/);
    expect(r.listError).toBeTruthy();
    expect(r.listError.message).toMatch(/no DevToolsActivePort and no CDP_PORT set/i);
    const model = T.buildCliErrorModel(r.listError, { cmd: 'list' });
    expect(model.recovery.run).toBe(doctorNext);
    expect(model.recovery.consentRequired).toBe(true);
    expect(T.formatCliError(r.listError, { cmd: 'list' })).toContain(`Next: ${doctorNext} (ask first)`);
  });

  it('a stale default-profile record still does not beat the daily dir in list (5c41ea5 kept, now in list too)', async () => {
    const environmentCheck = {
      status: 'OK',
      label: 'Environment',
      detail: 'darwin',
      environment: { platform: 'darwin', preferredBrowser: { browser: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' } },
    };
    const lastEndpoint = {
      host: '127.0.0.1', port: '9222', profileDir: '/Users/simon/Library/Application Support/Google/Chrome',
      exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', browser: 'chrome',
    };
    const r = await doctorAndList({ lastEndpoint, environmentCheck, display: { platform: 'darwin', env: {} } });
    expect(r.doctor.recommendation.strategy).not.toBe('relaunch-same-profile');
    const model = T.buildCliErrorModel(r.listError, { cmd: 'list' });
    expect(model.recovery.strategy).not.toBe('relaunch-same-profile');
    expect(model.recovery.run).toBe(r.doctor.recommendation.run);
    expect(model.recovery.run).toMatch(/spawn-debug-browser edge --port 9222/);
  });
});

describe('#425/#426 never recommend relaunching a profile whose browser is still running', () => {
  const runningOn = port => () => ({
    alive: true,
    pid: 4242,
    argv: [EXE, `--remote-debugging-port=${port}`, `--user-data-dir=${DAILY}`, '--headless=new'],
    port: port == null ? null : String(port),
  });

  it('the profile still open on another CDP port points at that port, in doctor and list', async () => {
    const r = await doctorAndList({ lastEndpoint: REMEMBERED_9333, inspectProfileProcess: runningOn(9555) });
    expect(r.check).toMatchObject({ status: 'FAIL', error: 'cdp_profile_in_use', profileInUse: true, pid: 4242, relaunch: null, livePort: '9555' });
    expect(r.check.detail).toMatch(/still open in pid 4242/);
    expect(r.doctor.recommendation).toMatchObject({ strategy: 'profile-in-use', run: 'CDP_PORT=9555 cdp list' });
    expect(r.doctorText).not.toMatch(/--remote-debugging-port=9333 --user-data-dir/);

    expect(r.listError).toMatchObject({ code: 'cdp_profile_in_use', pid: 4242, relaunch: null });
    const model = T.buildCliErrorModel(r.listError, { cmd: 'list' });
    expect(model.recovery).toMatchObject({ strategy: 'profile-in-use', run: 'CDP_PORT=9555 cdp list' });
    expect(T.formatCliError(r.listError, { cmd: 'list' })).toContain('Next: CDP_PORT=9555 cdp list');
  });

  it('the profile open without a CDP port says so and gives no relaunch command', async () => {
    const r = await doctorAndList({
      lastEndpoint: REMEMBERED_9333,
      inspectProfileProcess: () => ({ alive: true, pid: 4242, argv: [EXE, `--user-data-dir=${DAILY}`], port: null }),
    });
    expect(r.check).toMatchObject({ error: 'cdp_profile_in_use', relaunch: null, livePort: null });
    expect(r.doctor.recommendation.strategy).toBe('profile-in-use');
    expect(r.doctor.recommendation.run).toBeNull();
    expect(r.doctor.recommendation.ask).toMatch(/do not relaunch/i);
    expect(r.doctor.recommendation.ask).toMatch(/pid 4242/);
    const model = T.buildCliErrorModel(r.listError, { cmd: 'list' });
    expect(model.recovery.run).toBeNull();
    expect(model.recovery.ask).toBe(r.doctor.recommendation.ask);
    const text = T.formatCliError(r.listError, { cmd: 'list' });
    expect(text).toContain(`Next: ${r.doctor.recommendation.ask}`);
    expect(text).not.toMatch(/Run: null/);
    expect(r.doctorText).toContain(`Next: ${r.doctor.recommendation.ask}`);
  });

  it('the profile running with this very port that does not answer is not relaunched either', async () => {
    const r = await doctorAndList({ lastEndpoint: REMEMBERED_9333, inspectProfileProcess: runningOn(9333) });
    expect(r.check).toMatchObject({ error: 'cdp_profile_in_use', relaunch: null, livePort: '9333', run: null });
    expect(r.doctor.recommendation.ask).toMatch(/does not answer; do not relaunch it/);
    expect(T.buildCliErrorModel(r.listError, { cmd: 'list' }).recovery.ask).toBe(r.doctor.recommendation.ask);
  });

  it('applies to an explicit CDP_PORT too', async () => {
    const err = T.cdpUnreachableError({
      host: '127.0.0.1', port: '9333', cause: 'ECONNREFUSED', lastEndpoint: REMEMBERED_9333,
      inspectProfileProcess: runningOn(null), display: NO_DISPLAY,
    });
    expect(err.code).toBe('cdp_profile_in_use');
    expect(err.relaunch).toBeNull();
    expect(err.message).toMatch(/still open in pid 4242/);
    const check = await T.checkCdpReachability({
      env: { CDP_PORT: '9333' },
      fetcher: async () => { throw refused(9333); },
      lastEndpoint: REMEMBERED_9333,
      inspectProfileProcess: runningOn(null),
      display: NO_DISPLAY,
      connectWebSocket: () => { throw new Error('WebSocket fallback should not run'); },
    });
    expect(check).toMatchObject({ status: 'FAIL', error: 'cdp_profile_in_use', relaunch: null });
  });
});

describe('#426 relaunch-same-profile replays the launch flags', () => {
  it('keeps only the flags worth replaying', () => {
    expect(T.replayableLaunchFlags(HEADLESS_ARGV.slice(1))).toEqual([
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      '--no-sandbox',
    ]);
    expect(T.replayableLaunchFlags(['--headless', '--disable-gpu', '--disable-dev-shm-usage', '--headless'])).toEqual([
      '--headless', '--disable-gpu', '--disable-dev-shm-usage',
    ]);
  });

  it('a raw relaunch line carries the recorded flags', () => {
    const entry = { port: '9333', profileDir: DAILY, exe: EXE, launchFlags: ['--remote-debugging-address=127.0.0.1', '--headless=new', '--no-sandbox'] };
    expect(T.formatCdpRelaunchCommand(entry, { port: '9333', display: WITH_DISPLAY })).toBe(
      `${EXE} --remote-debugging-port=9333 --user-data-dir=${DAILY} --remote-debugging-address=127.0.0.1 --headless=new --no-sandbox`,
    );
  });

  it('passes the profile as --user-data-dir=DIR (Chromium reads `--user-data-dir DIR` as a URL and opens another profile)', () => {
    const entry = { port: '9333', profileDir: '/home/me/My Profile', exe: EXE };
    expect(T.formatCdpRelaunchCommand(entry, { display: WITH_DISPLAY })).toBe(`${EXE} --remote-debugging-port=9333 '--user-data-dir=/home/me/My Profile'`);
  });

  it('adds --headless=new on Linux without DISPLAY/WAYLAND_DISPLAY, and only there', () => {
    const entry = { port: '9333', profileDir: DAILY, exe: EXE };
    expect(T.formatCdpRelaunchCommand(entry, { display: NO_DISPLAY })).toBe(`${EXE} --remote-debugging-port=9333 --user-data-dir=${DAILY} --headless=new`);
    expect(T.formatCdpRelaunchCommand(entry, { display: { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } } })).not.toMatch(/headless/);
    expect(T.formatCdpRelaunchCommand(entry, { display: WITH_DISPLAY })).not.toMatch(/headless/);
    expect(T.formatCdpRelaunchCommand(entry, { display: { platform: 'darwin', env: {} } })).not.toMatch(/headless/);
    expect(T.formatCdpRelaunchCommand({ ...entry, launchFlags: ['--headless'] }, { display: NO_DISPLAY }).match(/--headless/g)).toHaveLength(1);
  });

  it('the spawn-debug-browser form carries the same flags', () => {
    const entry = {
      port: '9333', profileDir: DAILY, exe: EXE, browser: 'chrome', via: 'spawn-debug-browser',
      launchFlags: ['--remote-debugging-address=127.0.0.1', '--headless=new', '--no-sandbox', '--disable-gpu'],
    };
    expect(T.formatCdpRelaunchCommand(entry, { display: WITH_DISPLAY })).toBe(
      `cdp spawn-debug-browser chrome --port 9333 --profile-dir ${DAILY} --exe ${EXE} --headless --no-sandbox --disable-gpu`,
    );
    expect(T.formatCdpRelaunchCommand({ ...entry, launchFlags: ['--remote-debugging-address=0.0.0.0'] }, { display: NO_DISPLAY })).toBe(
      `cdp spawn-debug-browser chrome --port 9333 --profile-dir ${DAILY} --exe ${EXE} --host 0.0.0.0 --headless`,
    );
    // A flag spawn-debug-browser cannot pass falls back to the raw browser line, so nothing is dropped.
    expect(T.formatCdpRelaunchCommand({ ...entry, launchFlags: ['--disable-dev-shm-usage'] }, { display: WITH_DISPLAY })).toBe(
      `${EXE} --remote-debugging-port=9333 --user-data-dir=${DAILY} --disable-dev-shm-usage`,
    );
  });

  it('the endpoint record keeps launch flags per profile, and a newer sighting without flags does not erase them', () => {
    const files = new Map();
    let tick = 0;
    const io = {
      runtimeDir: mkdtempSync(join(tmpdir(), 'cdp-runtime-426-')),
      now: () => Date.parse('2026-10-01T00:00:00.000Z') + (tick++) * 60_000,
      writer: (path, data) => files.set(path, String(data)),
      reader: path => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path); },
    };
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9333, profileDir: DAILY, exe: EXE, browser: 'chrome', launchFlags: ['--headless=new', '--no-sandbox'] }, io);
    T.rememberLastCdpEndpoint({ host: '127.0.0.1', port: 9333, profileDir: DAILY, exe: EXE, browser: 'chrome' }, io);
    const stored = T.readLastCdpEndpoint(io);
    expect(stored.history[0].launchFlags).toEqual(['--headless=new', '--no-sandbox']);
    const [top] = T.rankCdpRelaunchCandidates(stored, '9333', { display: WITH_DISPLAY });
    expect(top.relaunch).toBe(`${EXE} --remote-debugging-port=9333 --user-data-dir=${DAILY} --headless=new --no-sandbox`);
    rmSync(io.runtimeDir, { recursive: true, force: true });
  });

  it('spawn-debug-browser records the flags it launched with', async () => {
    const remembered = [];
    const child = {
      pid: 1234, unref: () => {},
      stdout: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      stderr: { on: () => {}, setEncoding: () => {}, unref: () => {} },
      on: () => {}, once: () => {},
    };
    await T.spawnDebugBrowserStr(
      ['chrome', '--port', '9342', '--profile-dir', '/home/me/persistent', '--exe', EXE, '--headless', '--no-sandbox'],
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
        rememberLastCdpEndpoint: record => remembered.push(record),
      },
    );
    expect(remembered[0].launchFlags).toEqual(['--remote-debugging-address=127.0.0.1', '--headless=new', '--no-sandbox']);
  });

  it('attaching to a live profile records the flags from its process command line', async () => {
    const records = [];
    const url = await T.getWsUrl({
      env: emptyEnv(),
      fetcher: fetcherFor({ 9333: WS }).fetcher,
      lastEndpoint: REMEMBERED_9333,
      rememberEndpoint: record => records.push(record),
      inspectProfileProcess: dir => (dir === DAILY ? { alive: true, pid: 4242, argv: HEADLESS_ARGV, port: '9333' } : notRunning()),
    });
    expect(url).toBe(WS);
    expect(records.at(-1)).toMatchObject({
      host: '127.0.0.1',
      port: '9333',
      profileDir: DAILY,
      exe: EXE,
      launchFlags: ['--remote-debugging-address=127.0.0.1', '--headless=new', '--no-sandbox'],
    });
  });

  it('does not record flags from a profile whose browser listens on a different port', async () => {
    const records = [];
    await T.getWsUrl({
      env: emptyEnv(),
      fetcher: fetcherFor({ 9333: WS }).fetcher,
      lastEndpoint: REMEMBERED_9333,
      rememberEndpoint: record => records.push(record),
      inspectProfileProcess: () => ({ alive: true, pid: 4242, argv: [EXE, '--remote-debugging-port=9555', `--user-data-dir=${DAILY}`], port: '9555' }),
    });
    expect(records.every(record => !record.launchFlags)).toBe(true);
  });
});

describe('#425/#426 profile process inspection', () => {
  const base = {
    platform: 'linux',
    host: 'box',
    readLink: () => 'box-4242',
    isAlive: pid => pid === 4242,
    readArgv: () => HEADLESS_ARGV,
  };

  it('reads the Chromium profile lock and the live command line', () => {
    expect(T.inspectCdpProfileProcess(DAILY, base)).toMatchObject({ alive: true, pid: 4242, port: '9333', argv: HEADLESS_ARGV });
  });

  it('no lock, a dead pid, or a reused pid is not running', () => {
    expect(T.inspectCdpProfileProcess(DAILY, { ...base, readLink: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }).alive).toBe(false);
    expect(T.inspectCdpProfileProcess(DAILY, { ...base, isAlive: () => false }).alive).toBe(false);
    expect(T.inspectCdpProfileProcess(DAILY, { ...base, readArgv: () => ['/usr/bin/vim', 'notes.txt'] }).alive).toBe(false);
  });

  it('a lock held by another host is unknown, never "running"', () => {
    expect(T.inspectCdpProfileProcess(DAILY, { ...base, readLink: () => 'other-host-4242' }).alive).toBeNull();
  });

  it('reads a Chromium command line whose process title was rewritten into one space-joined string', () => {
    // Chromium sets its process title, so /proc/<pid>/cmdline is the whole line with one trailing NUL.
    const joined = `${HEADLESS_ARGV.join(' ')}\0`;
    const argv = T.readProcessArgv(4242, { platform: 'linux', readFile: () => joined });
    expect(argv[0]).toBe(EXE);
    expect(argv).toContain('--headless=new');
    expect(argv.at(-1)).toBe('--use-angle=swiftshader-webgl http://127.0.0.1:8766/app.html');
    expect(T.replayableLaunchFlags(argv.slice(1))).toEqual(['--remote-debugging-address=127.0.0.1', '--headless=new', '--no-sandbox']);
    expect(T.inspectCdpProfileProcess(DAILY, { ...base, readArgv: () => argv })).toMatchObject({ alive: true, port: '9333' });
    // A trailing positional argument stuck to the last flag still counts.
    const tail = [EXE, '--remote-debugging-port=9333', `--user-data-dir=${DAILY} http://127.0.0.1:8766/app.html`];
    expect(T.inspectCdpProfileProcess(DAILY, { ...base, readArgv: () => tail }).alive).toBe(true);
    expect(T.readProcessArgv(4242, { platform: 'linux', readFile: () => `${EXE}\0--no-sandbox\0` })).toEqual([EXE, '--no-sandbox']);
    expect(T.readProcessArgv(4242, { platform: 'darwin', readFile: () => joined })).toBeNull();
  });

  it('a running pid whose command line cannot be read is still running', () => {
    expect(T.inspectCdpProfileProcess(DAILY, { ...base, platform: 'darwin', readArgv: () => null })).toMatchObject({ alive: true, pid: 4242, argv: null, port: null });
  });
});
