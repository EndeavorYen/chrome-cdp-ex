import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const CHROME_WIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_WIN_DIR = 'C:\\Program Files\\Google\\Chrome\\Application';
const CHROME_WSL = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_WSL_DIR = '/mnt/c/Program Files/Google/Chrome/Application';

// Chrome on Windows is a GUI program: `chrome.exe --version` opens a browser
// window (or hands the command line to the running one) instead of printing.
function spawnRecorder(stdout = '') {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push([cmd, ...(args || [])]);
    return { status: 0, stdout, stderr: '' };
  };
  return { fn, calls };
}

function applicationDirFs(dir, entries) {
  const reads = [];
  return {
    reads,
    existsSync: (p) => String(p) === `${dir}\\chrome.exe` || String(p) === `${dir}/chrome.exe` || String(p) === CHROME_WIN,
    readFileSync: (p) => { throw new Error(`unexpected read ${p}`); },
    readdirSync: (p) => {
      reads.push(String(p));
      if (String(p) !== dir) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return entries;
    },
  };
}

describe('#456 never run a Windows browser binary to learn its version', () => {
  it('reads the highest version folder next to chrome.exe on win32 and never spawns', () => {
    const spawn = spawnRecorder('Google Chrome 999.0.0.0');
    const fs = applicationDirFs(CHROME_WIN_DIR, [
      '153.0.7900.10',
      '154.0.8037.92',
      '154.0.8037.92.manifest',
      'SetupMetrics',
      'chrome.exe',
      'chrome_proxy.exe',
      'chrome.VisualElementsManifest.xml',
    ]);
    expect(T.detectChromiumMajorVersion(CHROME_WIN, { platform: 'win32', fs, spawnSyncFn: spawn.fn })).toBe(154);
    expect(fs.reads).toEqual([CHROME_WIN_DIR]);
    expect(spawn.calls).toEqual([]);
  });

  it('compares version folders numerically, not lexically', () => {
    const spawn = spawnRecorder();
    const fs = applicationDirFs(CHROME_WIN_DIR, ['99.0.4844.51', '100.0.4896.60']);
    expect(T.detectChromiumMajorVersion(CHROME_WIN, { platform: 'win32', fs, spawnSyncFn: spawn.fn })).toBe(100);
    expect(spawn.calls).toEqual([]);
  });

  it('accepts Dirent entries from readdirSync', () => {
    const spawn = spawnRecorder();
    const fs = applicationDirFs(CHROME_WIN_DIR, [{ name: '139.0.3405.102' }, { name: 'Locales' }]);
    expect(T.detectChromiumMajorVersion(CHROME_WIN, { platform: 'win32', fs, spawnSyncFn: spawn.fn })).toBe(139);
    expect(spawn.calls).toEqual([]);
  });

  it('returns null on win32 when no version folder is present, the read fails, or fs cannot list', () => {
    const spawn = spawnRecorder('Google Chrome 154.0.8037.92');
    const opts = fs => ({ platform: 'win32', fs, spawnSyncFn: spawn.fn });
    expect(T.detectChromiumMajorVersion(CHROME_WIN, opts(applicationDirFs(CHROME_WIN_DIR, ['chrome.exe', 'SetupMetrics'])))).toBe(null);
    expect(T.detectChromiumMajorVersion(CHROME_WIN, opts(applicationDirFs('D:\\elsewhere', ['154.0.8037.92'])))).toBe(null);
    expect(T.detectChromiumMajorVersion(CHROME_WIN, opts({ existsSync: () => true }))).toBe(null);
    // A non-.exe launcher on win32 is still never executed.
    expect(T.detectChromiumMajorVersion('C:\\tools\\chrome.cmd', opts({ existsSync: () => true }))).toBe(null);
    expect(spawn.calls).toEqual([]);
  });

  it('treats a WSL-side Windows .exe like win32: reads the folder, never executes it through interop', () => {
    const spawn = spawnRecorder('Google Chrome 154.0.8037.92');
    const fs = applicationDirFs(CHROME_WSL_DIR, ['141.0.7390.55']);
    expect(T.detectChromiumMajorVersion(CHROME_WSL, { platform: 'linux', fs, spawnSyncFn: spawn.fn })).toBe(141);
    expect(fs.reads).toEqual([CHROME_WSL_DIR]);
    expect(spawn.calls).toEqual([]);
  });

  it('keeps the cheap --version probe for a native Linux binary', () => {
    const spawn = spawnRecorder('Google Chrome 154.0.8037.92 \n');
    expect(T.detectChromiumMajorVersion('/usr/bin/google-chrome', {
      platform: 'linux',
      fs: { existsSync: () => true, readdirSync: () => { throw new Error('should not list on linux'); } },
      spawnSyncFn: spawn.fn,
    })).toBe(154);
    expect(spawn.calls).toEqual([['/usr/bin/google-chrome', '--version']]);
  });

  it('refuses win32 spawn-debug-browser --daily-profile on Chrome 136+ from the version folder: one readdir, no quit, no spawn, no CDP probe', async () => {
    const events = [];
    const spawn = spawnRecorder('Google Chrome 999.0.0.0');
    const fs = applicationDirFs(CHROME_WIN_DIR, ['153.0.7900.10', '154.0.8037.92']);
    fs.mkdirSync = (p) => { events.push(`mkdir:${p}`); };
    const error = await T.spawnDebugBrowserStr(
      ['chrome', '--daily-profile', '--port', '9222'],
      { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u', TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp', PATH: '' },
      {
        fs,
        platform: 'win32',
        // No chromiumMajorVersion injection: the major must come from the folder.
        spawnSyncFn: spawn.fn,
        probeTcpPort: async () => ({ occupied: false }),
        isProfileLocked: () => true,
        quitBrowser: async (plan) => { events.push(`quit:${plan.profileDir}`); },
        spawn: (exe, args) => { events.push(`spawn:${exe} ${args.join(' ')}`); return {}; },
        waitForSpawnedCdp: async () => { events.push('wait'); return { ok: false }; },
        listSpawnedDebugTargets: async () => { events.push('list'); return []; },
      },
    ).then(() => null, err => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/did not launch daily chrome \(major 154\) on its default user-data-dir/);
    expect(error.message).toMatch(/no CDP connection was attempted/);
    expect(error.message).not.toMatch(/CDP was not reachable/);
    expect(error.message).toMatch(/Chrome 136\+[\s\S]*non-default data directory[\s\S]*not the daily profile/);
    expect(fs.reads).toEqual([CHROME_WIN_DIR]);
    expect(events).toEqual([]);
    expect(spawn.calls).toEqual([]);
  });

  it('doctor/attach 136+ hint names the running default browser per platform (no macOS "Dock" on Windows)', () => {
    const checks = (platform, executable) => [
      { status: 'OK', label: 'Node', detail: 'v22' },
      {
        status: 'OK',
        label: 'Environment',
        detail: platform,
        environment: { platform, preferredBrowser: { browser: 'chrome', executable, major: 154 } },
      },
      { status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set' },
    ];
    const winAsk = T.buildDoctorModel(checks('win32', CHROME_WIN)).recommendation.ask;
    expect(winAsk).toMatch(/Chrome 136\+ and Microsoft Edge ignore --remote-debugging-port/);
    expect(winAsk).toMatch(/do not kill the running default chrome/);
    expect(winAsk).not.toMatch(/Dock/);
    const macAsk = T.buildDoctorModel(checks('darwin', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).recommendation.ask;
    expect(macAsk).toMatch(/do not kill Dock\/default chrome/);
  });

  it('runtime environment detection on win32 (attach miss / doctor) reports the major without spawning', () => {
    const spawn = spawnRecorder('Google Chrome 999.0.0.0');
    const fs = applicationDirFs(CHROME_WIN_DIR, ['154.0.8037.92']);
    const info = T.detectRuntimeEnvironment({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PATH: '' },
      fs,
      defaultBrowser: null,
      spawnSyncFn: spawn.fn,
    });
    expect(info.preferredBrowser).toMatchObject({ browser: 'chrome', executable: CHROME_WIN, major: 154 });
    expect(spawn.calls).toEqual([]);
  });
});
