import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const EXE = '/opt/chromium/chrome';
const PROFILE = '/home/u/.config/chrome-cdp-ex/daily-chrome';
const PORT_FILE = `${PROFILE}/DevToolsActivePort`;

function fsFor({ portText = null } = {}) {
  return {
    existsSync: (p) => p === EXE || (portText != null && p === PORT_FILE),
    mkdirSync: () => {},
    readFileSync: (p) => {
      if (portText != null && p === PORT_FILE) return portText;
      throw new Error(`unexpected read ${p}`);
    },
  };
}

function answering(port) {
  return async (url) => {
    if (url === `http://127.0.0.1:${port}/json/version`) return { ok: true, json: async () => ({}) };
    throw new Error(`unexpected ${url}`);
  };
}

function childWithStdout(chunk) {
  return {
    pid: 7,
    stdout: {
      on(event, fn) {
        if (event === 'data' && chunk != null) fn(chunk);
      },
      unref() {},
    },
    stderr: { on() {}, unref() {} },
    unref() {},
    once() {},
  };
}

async function spawnChrome(_extra = {}, deps = {}) {
  const launched = [];
  const merged = {
    platform: 'linux',
    fs: fsFor(),
    probeTcpPort: async () => ({ occupied: false }),
    spawn: () => {
      launched.push('spawn');
      return childWithStdout('');
    },
    waitForSpawnedCdp: async () => ({ ok: true, product: 'Chrome/154' }),
    listSpawnedDebugTargets: async () => [],
    rememberLastCdpEndpoint: () => {},
    ...deps,
  };
  let caught = null;
  let out = null;
  try {
    out = await T.spawnDebugBrowserStr(
      ['chrome', '--exe', EXE, '--port', '9555', '--profile-dir', PROFILE],
      { HOME: '/home/u' },
      merged,
    );
  } catch (error) {
    caught = error;
  }
  return { launched, caught, out, text: caught ? T.formatCliError(caught, { cmd: 'spawn-debug-browser' }) : out };
}

describe('#550 spawn-debug-browser profile already open on another port', () => {
  it('T1 does not launch when remembered history names a live port', async () => {
    const { launched, text } = await spawnChrome({}, {
      readLastCdpEndpoint: () => ({
        port: '9333',
        profileDir: PROFILE,
        history: [{ port: '9333', profileDir: PROFILE }],
      }),
      fetcher: answering('9333'),
    });
    expect(launched).toEqual([]);
    expect(text).toContain(`profile ${PROFILE} is already open on port 9333`);
    expect(text).toContain('Next: CDP_PORT=9333 cdp list (Kind: profile-in-use)');
    expect(text).not.toContain('--headless --no-sandbox');
  });

  it('T2 does not launch when DevToolsActivePort names a live port and history does not', async () => {
    const { launched, text } = await spawnChrome({}, {
      fs: fsFor({ portText: '9333\n/devtools/browser\n' }),
      readLastCdpEndpoint: () => null,
      fetcher: answering('9333'),
    });
    expect(launched).toEqual([]);
    expect(text).toContain('Next: CDP_PORT=9333 cdp list (Kind: profile-in-use)');
  });

  it('T3 still launches when the named port does not answer', async () => {
    const { launched, caught } = await spawnChrome({}, {
      fs: fsFor({ portText: '9333\n/devtools/browser\n' }),
      readLastCdpEndpoint: () => ({ port: '9333', profileDir: PROFILE, history: [] }),
      fetcher: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(caught).toBeNull();
    expect(launched).toEqual(['spawn']);
  });

  it('T4 still launches when the answering occupant is a different profile', async () => {
    const { launched, caught } = await spawnChrome({}, {
      readLastCdpEndpoint: () => ({ port: '9333', profileDir: PROFILE, history: [] }),
      fetcher: answering('9333'),
      inspectOccupantProfileDir: async () => '/other/profile',
    });
    expect(caught).toBeNull();
    expect(launched).toEqual(['spawn']);
  });

  it('T5 classifies an exit-0 existing-session handoff and drops the headless Try line', async () => {
    const launched = [];
    const { text } = await spawnChrome({}, {
      spawn: () => {
        launched.push('spawn');
        return childWithStdout('Opening in existing browser session.\n');
      },
      waitForSpawnedCdp: async ({ output }) => ({
        ok: false,
        exited: true,
        exitCode: 0,
        stdout: output?.stdout || '',
        stderr: output?.stderr || '',
      }),
    });
    expect(launched).toEqual(['spawn']);
    expect(text).toContain('Kind: profile-in-use');
    expect(text).not.toContain('--headless --no-sandbox');
    expect(text).not.toContain('exited early');
  });

  it('T6 omits non-UTF-8 stdout on exit 0 and classifies the hand-off', async () => {
    const mojibake = Buffer.from([0xb2, 0x7d, 0xa6, 0x62]);
    const { text } = await spawnChrome({}, {
      spawn: () => childWithStdout(mojibake),
      waitForSpawnedCdp: async ({ output }) => ({
        ok: false,
        exited: true,
        exitCode: 0,
        stdout: output?.stdout || '',
        stderr: output?.stderr || '',
      }),
    });
    expect(text).not.toContain(mojibake.toString('latin1'));
    expect(text).not.toContain('\uFFFD');
    expect(text).toContain('Kind: profile-in-use');
    expect(text).not.toContain('--headless --no-sandbox');
  });

  it('keeps a UTF-8 tail that starts mid-character as an ordinary early exit', async () => {
    const chunk = Buffer.concat([Buffer.from([0x80]), Buffer.from('renderer exited cleanly')]);
    const { text } = await spawnChrome({}, {
      spawn: () => childWithStdout(chunk),
      waitForSpawnedCdp: async ({ output }) => ({
        ok: false,
        exited: true,
        exitCode: 0,
        stdout: output?.stdout || '',
        stderr: output?.stderr || '',
      }),
    });
    expect(text).toContain('renderer exited cleanly');
    expect(text).toContain('exited early');
    expect(text).not.toContain('Kind: profile-in-use');
  });

  it('T7 keeps exited-early for a non-zero exit that is not a hand-off', async () => {
    const { text } = await spawnChrome({}, {
      spawn: () => childWithStdout(''),
      waitForSpawnedCdp: async () => ({
        ok: false,
        exited: true,
        exitCode: 1,
        stderr: 'zygote host requires --no-sandbox',
      }),
    });
    expect(text).toMatch(/exited early/);
    expect(text).toContain('zygote host requires --no-sandbox');
    expect(text).not.toContain('Kind: profile-in-use');
  });
});
