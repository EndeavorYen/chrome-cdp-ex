import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const argv = {
  defaultProfile: [EDGE, '--remote-debugging-port=9222'],
  platformDefaultDir: [CHROME, '--user-data-dir=C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data'],
  persistentDaily: [CHROME, '--user-data-dir=C:\\Users\\me\\AppData\\Local\\chrome-cdp-ex\\daily-chrome'],
  persistentDailyPosix: ['/usr/bin/google-chrome', '--user-data-dir=/home/me/.config/chrome-cdp-ex/daily-chrome'],
  isolated: [CHROME, '--headless=new', '--user-data-dir=C:\\Temp\\iso-533'],
  electron: ['C:\\Program Files\\Darkroom\\Darkroom.exe', '--remote-debugging-port=9229'],
};

const fetcherFor = port => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ Browser: 'Chrome/154.0.0.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/ABC` }),
});

function wsUrlWith(args, env = { CDP_PORT: '9333', CDP_ISOLATED_ONLY: '1' }) {
  const seen = [];
  const promise = T.getWsUrl({
    env,
    fetcher: fetcherFor(env.CDP_PORT || '9222'),
    lastEndpoint: null,
    rememberEndpoint: () => {},
    inspectBrowserArgv: async (endpoint) => {
      seen.push(endpoint);
      return args;
    },
  });
  return { promise, seen };
}

describe('#534 classifyBrowserProfile', () => {
  it('T1: daily, isolated, other and unknown', () => {
    expect(T.classifyBrowserProfile(argv.defaultProfile)).toMatchObject({ kind: 'daily', profileDir: null, browser: 'edge' });
    expect(T.classifyBrowserProfile(argv.platformDefaultDir).kind).toBe('daily');
    expect(T.classifyBrowserProfile(argv.persistentDaily).kind).toBe('daily');
    expect(T.classifyBrowserProfile(argv.persistentDailyPosix).kind).toBe('daily');
    expect(T.classifyBrowserProfile(argv.isolated)).toMatchObject({ kind: 'isolated', profileDir: 'C:\\Temp\\iso-533' });
    expect(T.classifyBrowserProfile(argv.electron).kind).toBe('other');
    expect(T.classifyBrowserProfile([]).kind).toBe('unknown');
    expect(T.classifyBrowserProfile(null).kind).toBe('unknown');
  });
});

describe('#534 CDP_ISOLATED_ONLY gate in getWsUrl', () => {
  it('T2: refuses a daily or unidentified profile, naming host:port and the profile', async () => {
    for (const args of [argv.defaultProfile, argv.persistentDaily, null]) {
      const { promise } = wsUrlWith(args);
      const err = await promise.then(() => null, e => e);
      expect(err?.code, String(args)).toBe('daily_profile_refused');
      expect(err.message).toContain('127.0.0.1:9333');
      expect(err.message).toMatch(/CDP_ISOLATED_ONLY/);
    }
  });

  it('T2: allows an isolated profile and a non-browser (Electron) target', async () => {
    for (const args of [argv.isolated, argv.electron]) {
      const { promise, seen } = wsUrlWith(args);
      await expect(promise).resolves.toBe('ws://127.0.0.1:9333/devtools/browser/ABC');
      expect(seen).toEqual([{ host: '127.0.0.1', port: '9333' }]);
    }
  });

  it('T2: without CDP_ISOLATED_ONLY nothing is inspected and a daily profile attaches', async () => {
    const { promise, seen } = wsUrlWith(argv.defaultProfile, { CDP_PORT: '9333' });
    await expect(promise).resolves.toBe('ws://127.0.0.1:9333/devtools/browser/ABC');
    expect(seen).toEqual([]);
  });

  it('T3: auto-discovery accepts an isolated occupant instead of refusing it', async () => {
    const env = { HOME: '/nonexistent-534', USERPROFILE: '/nonexistent-534', LOCALAPPDATA: '/nonexistent-534', CDP_ISOLATED_ONLY: '1' };
    const isolatedDir = '/tmp/chrome-cdp-ex-chrome-debug-profile-9222';
    const options = {
      env,
      fetcher: fetcherFor('9222'),
      lastEndpoint: null,
      rememberEndpoint: () => {},
      inspectOccupantProfileDir: async () => isolatedDir,
      inspectBrowserArgv: async () => ['/usr/bin/google-chrome', `--user-data-dir=${isolatedDir}`],
    };
    await expect(T.getWsUrl(options)).resolves.toBe('ws://127.0.0.1:9222/devtools/browser/ABC');
    const { CDP_ISOLATED_ONLY, ...plain } = env;
    void CDP_ISOLATED_ONLY;
    const err = await T.getWsUrl({ ...options, env: plain }).then(() => null, e => e);
    expect(err?.code).toBe('cdp_isolated_occupant');
  });

  it('T4: the CLI error is Kind policy with an isolated spawn as Next (ask first)', async () => {
    const { promise } = wsUrlWith(argv.defaultProfile);
    const err = await promise.then(() => null, e => e);
    const out = T.formatCliError(err, { cmd: 'list' });
    expect(out).toMatch(/Kind: policy/);
    expect(out).toMatch(/Strategy: use-isolated-browser/);
    expect(out.split('\n').at(-1)).toMatch(/^Next: cdp spawn-debug-browser \S+ --port 9333 --user-data-dir \S+.* \(ask first\) \(Kind: policy\)$/);
  });
});

describe('#534 doctor and open say when the profile is daily', () => {
  it('T5: doctor adds an advisory Profile check and a text line only for daily', async () => {
    const daily = await T.checkBrowserProfile({ cdp: { status: 'OK', host: '127.0.0.1', port: '9222' }, inspectBrowserArgv: async () => argv.defaultProfile });
    expect(daily).toMatchObject({ label: 'Profile', status: 'WARN', severity: 'advisory', profileKind: 'daily' });
    expect(daily.detail).toMatch(/daily/);
    const isolated = await T.checkBrowserProfile({ cdp: { status: 'OK', host: '127.0.0.1', port: '9333' }, inspectBrowserArgv: async () => argv.isolated });
    expect(isolated).toMatchObject({ label: 'Profile', status: 'OK', profileKind: 'isolated' });
    const skipped = await T.checkBrowserProfile({ cdp: { status: 'FAIL' }, inspectBrowserArgv: async () => { throw new Error('should not run'); } });
    expect(skipped.status).toBe('OK');
    const base = [
      { label: 'Node', status: 'OK', detail: 'v24' },
      { label: 'CDP', status: 'OK', detail: '127.0.0.1:9222' },
    ];
    expect(T.formatDoctorReport([...base, daily])).toMatch(/^Profile: .*daily/m);
    expect(T.formatDoctorReport([...base, isolated])).not.toMatch(/^Profile:/m);
  });

  it('T5: open stays quiet (decision 2026-10-04: doctor only)', () => {
    expect(T.buildOpenModel({ targetId: 'ABCDEF0123456789', url: 'https://example.com' })).not.toHaveProperty('browserProfile');
  });
});

describe('#534 reading the browser command line from the OS process', () => {
  const spawnFor = outputs => (command, args) => {
    const key = command === 'powershell' ? 'powershell' : `${command} ${args.join(' ')}`;
    const stdout = outputs[key];
    return stdout == null ? { status: 1, stdout: '' } : { status: 0, stdout };
  };

  it('splits a Windows command line with quoted paths', () => {
    expect(T.splitCommandLine('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9491 --user-data-dir="C:\\Temp\\a b" about:blank'))
      .toEqual(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '--remote-debugging-port=9491', '--user-data-dir=C:\\Temp\\a b', 'about:blank']);
  });

  it('T2: Windows asks PowerShell for the process listening on the port', () => {
    const argvFound = T.readBrowserProcessArgv({
      host: '127.0.0.1',
      port: '9491',
      platform: 'win32',
      spawnSyncFn: spawnFor({ powershell: `"${CHROME}" --remote-debugging-port=9491 --user-data-dir=C:/Temp/iso-533 about:blank\r\n` }),
    });
    expect(argvFound).toEqual([CHROME, '--remote-debugging-port=9491', '--user-data-dir=C:/Temp/iso-533', 'about:blank']);
    expect(T.classifyBrowserProfile(argvFound).kind).toBe('isolated');
  });

  it('T2: macOS keeps a spaced executable path together', () => {
    const argvFound = T.readBrowserProcessArgv({
      host: 'localhost',
      port: 9222,
      platform: 'darwin',
      spawnSyncFn: spawnFor({
        'lsof -nP -iTCP:9222 -sTCP:LISTEN -Fp': 'p4242\nfcwd\n',
        'ps -ww -o command= -p 4242': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222\n',
      }),
    });
    expect(argvFound).toEqual(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--remote-debugging-port=9222']);
    expect(T.classifyBrowserProfile(argvFound)).toMatchObject({ kind: 'daily', browser: 'chrome' });
  });

  it('T2: Linux uses the /proc scan of the process that owns the LISTEN socket', () => {
    const seenPorts = [];
    const argvFound = T.readBrowserProcessArgv({
      host: '127.0.0.1',
      port: 9222,
      platform: 'linux',
      findLinuxProcess: wanted => {
        seenPorts.push(wanted);
        return { pid: 777, argv: ['/opt/google/chrome/chrome', '--remote-debugging-port=9222', '--user-data-dir=/home/me/.config/chrome-cdp-ex/daily-chrome'], profileDir: null };
      },
    });
    expect(seenPorts).toEqual([9222]);
    expect(T.classifyBrowserProfile(argvFound).kind).toBe('daily');
  });

  it('T2: the Linux scan returns the argv of a default-profile browser too', () => {
    const owner = T.findListeningBrowserProcess(9222, {
      platform: 'linux',
      listPids: () => ['777'],
      readArgv: () => ['/opt/google/chrome/chrome', '--remote-debugging-port=9222'],
      readFile: () => '',
      requireProfileDir: false,
    });
    expect(owner).toMatchObject({ pid: 777, profileDir: null });
    expect(T.classifyBrowserProfile(owner.argv).kind).toBe('daily');
  });

  it('T2: a remote host or an unreadable process gives no command line (unknown)', () => {
    const neverRun = () => { throw new Error('must not run'); };
    expect(T.readBrowserProcessArgv({ host: '192.168.1.5', port: 9222, platform: 'win32', spawnSyncFn: neverRun })).toBeNull();
    expect(T.readBrowserProcessArgv({ host: '127.0.0.1', port: 9222, platform: 'win32', spawnSyncFn: spawnFor({}) })).toBeNull();
  });
});

describe('#534 docs', () => {
  it('T6: CDP_ISOLATED_ONLY is documented with the other guardrails', () => {
    for (const path of ['../skills/chrome-cdp-ex/references/commands.md', '../docs/reference.md', '../skills/chrome-cdp-ex/SKILL.md', '../README.md']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8'), path).toMatch(/CDP_ISOLATED_ONLY/);
    }
  });
});
