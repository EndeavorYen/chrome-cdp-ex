import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  connectToDaemon,
  daemonEndpointForPlatform,
  daemonEndpointTooLongError,
} = await import('../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs');
const { classifyActionFailure, recoveryCommandArg } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = 'ABCDEF0123456789ABCDEF0123456789';
const LONG_DIR = `/tmp/${'x'.repeat(90)}/cdp`;

// Runs `cdp <verb> <target> <arg>` through a real POSIX shell with `cdp` stubbed, returning the
// argument the CLI would receive.
function shellArg3(command) {
  const res = spawnSync('sh', ['-c', `cdp() { printf '%s' "$3"; }; ${command}`], { encoding: 'utf8' });
  expect(res.status).toBe(0);
  return res.stdout;
}

describe('#444 daemon socket path over the Unix limit', () => {
  it('names an over-long endpoint instead of letting libuv truncate it', () => {
    const endpoint = daemonEndpointForPlatform(TARGET_ID, { platform: 'linux', runtimeDir: LONG_DIR });
    const err = daemonEndpointTooLongError(endpoint, { platform: 'linux' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('daemon_socket_path_too_long');
    expect(err.message).toMatch(/\d+ bytes, over the 107-byte Unix socket limit/);
    expect(err.message).toMatch(/shorter XDG_RUNTIME_DIR/);
  });

  it('accepts ordinary runtime dirs and Windows named pipes', () => {
    const short = daemonEndpointForPlatform(TARGET_ID, { platform: 'linux', runtimeDir: '/run/user/1000/cdp' });
    expect(daemonEndpointTooLongError(short, { platform: 'linux' })).toBeNull();
    const pipe = daemonEndpointForPlatform(TARGET_ID, { platform: 'win32', runtimeDir: LONG_DIR });
    expect(daemonEndpointTooLongError(pipe, { platform: 'win32' })).toBeNull();
  });

  it('uses the stricter 103-byte limit on macOS', () => {
    const endpoint = `/${'y'.repeat(99)}.sock`; // 105 bytes
    expect(daemonEndpointTooLongError(endpoint, { platform: 'linux' })).toBeNull();
    expect(daemonEndpointTooLongError(endpoint, { platform: 'darwin' })?.code).toBe('daemon_socket_path_too_long');
  });

  it('connectToDaemon rejects before connecting to a truncated path', async () => {
    const endpoint = daemonEndpointForPlatform(TARGET_ID, { platform: 'linux', runtimeDir: LONG_DIR });
    let connected = false;
    await expect(connectToDaemon(endpoint, {
      platform: 'linux',
      connect: () => { connected = true; throw new Error('should not connect'); },
    })).rejects.toMatchObject({ code: 'daemon_socket_path_too_long' });
    expect(connected).toBe(false);
  });

  it('getOrStartTabDaemon fails at once and never spawns a daemon that cannot listen', async () => {
    let spawned = false;
    await expect(T.getOrStartTabDaemon(TARGET_ID, {
      platform: 'linux',
      runtimeDir: LONG_DIR,
      connect: () => Promise.reject(new Error('unreachable')),
      unlink: () => {},
      spawnProcess: () => { spawned = true; return { unref() {} }; },
      delay: async () => {},
      retries: 1,
    })).rejects.toMatchObject({ code: 'daemon_socket_path_too_long' });
    expect(spawned).toBe(false);
  });
});

describe('#445 recovery commands quote selectors for the shell', () => {
  const selectors = ['#loop-attack', 'button.primary', '[data-x="1"]', "a[title='it''s']", 'a[href$="$HOME"]', 'div`x`', '#a > .b'];

  it('recoveryCommandArg survives a POSIX shell for any selector', () => {
    for (const selector of selectors) {
      expect(shellArg3(`cdp jsclick T ${recoveryCommandArg(selector)}`)).toBe(selector);
    }
  });

  it('keeps @refs and plain words bare', () => {
    expect(recoveryCommandArg('@12')).toBe('@12');
    expect(recoveryCommandArg('@f2:3')).toBe('@f2:3');
    expect(recoveryCommandArg('button')).toBe('button');
  });

  it('no-input-events Next keeps a #id selector', () => {
    const failure = classifyActionFailure(
      new Error('Mouse click on #loop-attack received no mousedown/click events; mouse path failed closed. Use jsclick.'),
      { action: 'click', target: { targetId: TARGET_ID, input: '#loop-attack' } },
    );
    expect(failure.nextCommand).toMatch(/^cdp jsclick /);
    expect(shellArg3(failure.nextCommand)).toBe('#loop-attack');
  });
});

describe('#444 CLI recovery for an over-long socket path', () => {
  it('reruns the same command with a short XDG_RUNTIME_DIR instead of an unclassified status probe', () => {
    const endpoint = daemonEndpointForPlatform(TARGET_ID, { platform: 'linux', runtimeDir: LONG_DIR });
    const err = daemonEndpointTooLongError(endpoint, { platform: 'linux' });
    const cli = T.formatCliError(err, { cmd: 'eval', targetPrefix: 'ABCDEF01', args: ['document.title'] });
    expect(cli).toMatch(/Kind: runtime-dir/);
    expect(cli).toMatch(/^Next: XDG_RUNTIME_DIR=\/tmp\/cdp-rt cdp eval ABCDEF01 document\.title$/m);
  });
});
