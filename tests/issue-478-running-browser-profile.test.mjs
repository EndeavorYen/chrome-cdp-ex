import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PROFILE = '/home/u/.config/chrome-cdp-ex/daily-chrome';
const EXE = '/opt/chromium/chrome';
const MAIN_ARGV = [EXE, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9333', `--user-data-dir=${PROFILE}`, '--no-first-run', '--headless=new', '--no-sandbox', 'about:blank'];
const RENDERER_ARGV = [EXE, '--type=renderer', '--remote-debugging-port=9333', `--user-data-dir=${PROFILE}`];

// 9333 = 0x2475. One LISTEN (st 0A) socket on 127.0.0.1:9333 with inode 777.
const TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:2475 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 100 0 0 10 0',
  '   1: 0100007F:2475 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 888 1 0000000000000000 20 4 30 10 -1',
].join('\n');

function fakeProc({ processes = {}, tcp = TCP, tcp6 = '', fds = {}, existing = [PROFILE] } = {}) {
  return {
    platform: 'linux',
    listPids: () => Object.keys(processes),
    readArgv: pid => processes[pid] || null,
    readFile: path => {
      if (path === '/proc/net/tcp') return tcp;
      if (path === '/proc/net/tcp6') return tcp6;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    listFdTargets: pid => fds[pid] || [],
    exists: path => existing.includes(path),
  };
}

describe('#478 find the browser process listening on a CDP port', () => {
  it('picks the main browser process (no --type=) that owns the listening socket', () => {
    const found = T.findListeningBrowserProcess('9333', fakeProc({
      processes: { 100: MAIN_ARGV, 101: RENDERER_ARGV, 102: ['/bin/bash', '-c', 'echo --remote-debugging-port=9333'] },
      fds: { 100: ['socket:[777]', 'pipe:[5]'], 101: ['socket:[999]'] },
    }));
    expect(found).toMatchObject({ pid: 100, profileDir: PROFILE });
    expect(found.argv[0]).toBe(EXE);
  });

  it('rejects a candidate that does not own the listening socket', () => {
    expect(T.findListeningBrowserProcess('9333', fakeProc({
      processes: { 100: MAIN_ARGV },
      fds: { 100: ['socket:[123]'] },
    }))).toBeNull();
  });

  it('confirms by inode when two browsers claim the port, and gives up when it cannot tell', () => {
    const other = MAIN_ARGV.map(arg => arg.replace(PROFILE, '/tmp/other'));
    const proc = fakeProc({ processes: { 100: MAIN_ARGV, 200: other }, fds: { 200: ['socket:[777]'] }, existing: [PROFILE, '/tmp/other'] });
    expect(T.findListeningBrowserProcess('9333', proc)).toMatchObject({ pid: 200, profileDir: '/tmp/other' });
    const blind = fakeProc({ processes: { 100: MAIN_ARGV, 200: other }, tcp: '', existing: [PROFILE, '/tmp/other'] });
    expect(T.findListeningBrowserProcess('9333', blind)).toBeNull();
  });

  it('accepts a single candidate when the socket table cannot be read', () => {
    expect(T.findListeningBrowserProcess('9333', fakeProc({ processes: { 100: MAIN_ARGV }, tcp: '' })))
      .toMatchObject({ pid: 100, profileDir: PROFILE });
  });

  it('reads an IPv6 listener too', () => {
    const tcp6 = '  sl  local_address rem_address st\n   0: 00000000000000000000000001000000:2475 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 555 1';
    expect(T.findListeningBrowserProcess('9333', fakeProc({ processes: { 100: MAIN_ARGV }, tcp: '', tcp6, fds: { 100: ['socket:[555]'] } })))
      .toMatchObject({ pid: 100 });
  });

  it('cuts a trailing URL off a title-joined --user-data-dir only when the full value is not a folder', () => {
    const joined = [EXE, '--remote-debugging-port=9333', `--user-data-dir=${PROFILE} http://127.0.0.1:8766/x.html`];
    expect(T.findListeningBrowserProcess('9333', fakeProc({ processes: { 100: joined }, fds: { 100: ['socket:[777]'] } })))
      .toMatchObject({ profileDir: PROFILE });
  });

  it('does nothing off Linux or without a profile on the command line', () => {
    expect(T.findListeningBrowserProcess('9333', { ...fakeProc({ processes: { 100: MAIN_ARGV } }), platform: 'darwin' })).toBeNull();
    const noProfile = MAIN_ARGV.filter(arg => !arg.startsWith('--user-data-dir='));
    expect(T.findListeningBrowserProcess('9333', fakeProc({ processes: { 100: noProfile }, fds: { 100: ['socket:[777]'] } }))).toBeNull();
  });
});

describe('#478 withLiveLaunchFlags records a running browser found by port', () => {
  const noProfileProcess = () => ({ alive: false, pid: null, argv: null, port: null });

  it('fills profile, exe and replayable flags when nothing was remembered for the port', () => {
    const record = T.withLiveLaunchFlags({ host: '127.0.0.1', port: '9333' }, {
      remembered: null,
      inspectProfileProcess: noProfileProcess,
      findListeningBrowser: port => (port === '9333' ? { pid: 100, argv: MAIN_ARGV, profileDir: PROFILE } : null),
    });
    expect(record).toMatchObject({ port: '9333', profileDir: PROFILE, exe: EXE, browser: 'chrome' });
    expect(record.launchFlags).toEqual(['--remote-debugging-address=127.0.0.1', '--headless=new', '--no-sandbox']);
  });

  it('never scans for a remote CDP_HOST', () => {
    let scanned = false;
    const record = T.withLiveLaunchFlags({ host: '10.0.0.5', port: '9333' }, {
      remembered: null,
      inspectProfileProcess: noProfileProcess,
      findListeningBrowser: () => { scanned = true; return { pid: 1, argv: MAIN_ARGV, profileDir: PROFILE }; },
    });
    expect(scanned).toBe(false);
    expect(record.profileDir).toBeUndefined();
  });

  it('keeps the record unchanged when the scan finds nothing', () => {
    const input = { host: '127.0.0.1', port: '9333' };
    expect(T.withLiveLaunchFlags(input, { remembered: null, inspectProfileProcess: noProfileProcess, findListeningBrowser: () => null })).toEqual(input);
  });
});
