import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  claimDaemonEndpoint,
  daemonSocketIdentity,
  probeDaemonEndpoint,
  watchDaemonSocket,
} = await import('../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs');

const TARGET_ID = 'ABCDEF0123456789ABCDEF0123456789';
const ENDPOINT = `/run/cdp/cdp-${TARGET_ID}.sock`;

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

const tick = () => new Promise(resolveTick => setImmediate(resolveTick));

// POSIX socket paths in memory: a bound path is live until its owner exits; a stale one
// refuses connections. Every step yields, so two daemons interleave like two processes.
function fakeSocketFs() {
  let nextIno = 100;
  const files = new Map();
  const stat = path => {
    const file = files.get(path);
    if (!file) throw codeError('ENOENT');
    return { dev: 1, ino: file.ino };
  };
  return {
    files,
    stale(path) { files.set(path, { ino: nextIno++, live: false, owner: 'crashed' }); },
    bind(path, owner) { files.set(path, { ino: nextIno++, live: true, owner }); },
    listenAs(owner) {
      return async path => {
        await tick();
        if (files.has(path)) throw codeError('EADDRINUSE');
        files.set(path, { ino: nextIno++, live: true, owner });
      };
    },
    probe: async path => {
      await tick();
      return files.get(path)?.live ? 'answers' : 'absent';
    },
    unlink: vi.fn(path => {
      if (!files.has(path)) throw codeError('ENOENT');
      files.delete(path);
    }),
    stat,
    lstat: stat,
    // libuv unlinks a bound pipe's path when its server closes, whoever holds the path now.
    server() {
      return { close: vi.fn(() => { files.delete(ENDPOINT); }) };
    },
  };
}

const tempDirs = [];
function runtimeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-458-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// One daemon through the same lifecycle runDaemon uses, with fake sockets, a real record dir,
// and a captured socket watch.
async function startDaemon(fs, { pid, dir, probe = fs.probe, platform = 'linux' }) {
  const exitProcess = vi.fn();
  const onServing = vi.fn();
  const server = fs.server();
  const watched = {};
  const lifecycle = T.createDaemonEndpointLifecycle({
    targetId: TARGET_ID,
    socketPath: ENDPOINT,
    requestConnections: new Set(),
    getServer: () => server,
    closeCdp: () => {},
    exitProcess,
    platform,
    probe,
    unlink: fs.unlink,
    stat: fs.stat,
    lstat: fs.lstat,
    runtimeDir: dir,
    pid,
    watch: (path, options) => Object.assign(watched, { path, ...options }),
    log: () => {},
  });
  const serving = await lifecycle.serve({
    listen: fs.listenAs(pid),
    record: { pid, startedAt: `start-${pid}` },
    onServing,
  });
  return { pid, serving, lifecycle, exitProcess, onServing, server, watched };
}

describe('#458 two daemons racing for one target', () => {
  it.each([
    ['no socket yet', false],
    ['a stale socket from a crashed daemon', true],
  ])('exactly one serves when the path holds %s; the loser leaves socket and record alone', async (_label, stale) => {
    const fs = fakeSocketFs();
    const dir = runtimeDir();
    if (stale) fs.stale(ENDPOINT);

    const daemons = await Promise.all([startDaemon(fs, { pid: 101, dir }), startDaemon(fs, { pid: 202, dir })]);

    const winners = daemons.filter(daemon => daemon.serving);
    const losers = daemons.filter(daemon => !daemon.serving);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [winner] = winners;
    const [loser] = losers;
    // The loser exits cleanly: a live daemon serves the target, which is what the client wanted.
    expect(loser.exitProcess).toHaveBeenCalledExactlyOnceWith(0);
    expect(loser.server.close).not.toHaveBeenCalled();
    expect(loser.onServing).not.toHaveBeenCalled();
    expect(loser.watched).toEqual({});
    expect(winner.exitProcess).not.toHaveBeenCalled();
    expect(winner.onServing).toHaveBeenCalledOnce();

    const socket = fs.files.get(ENDPOINT);
    expect(socket).toMatchObject({ live: true, owner: winner.pid });
    expect(winner.lifecycle.socketIdentity()).toEqual({ dev: 1, ino: socket.ino });
    expect(winner.watched).toMatchObject({ path: ENDPOINT, identity: { dev: 1, ino: socket.ino } });
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toMatchObject({ pid: winner.pid, startedAt: `start-${winner.pid}` });

    // The winner still owns everything, so its own exit cleans up both.
    winner.lifecycle.shutdown(0);
    expect(winner.server.close).toHaveBeenCalledOnce();
    expect(fs.files.has(ENDPOINT)).toBe(false);
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toBeNull();
  });

  it('a newcomer leaves a live daemon socket in place and writes no record', async () => {
    const fs = fakeSocketFs();
    const dir = runtimeDir();
    const first = await startDaemon(fs, { pid: 101, dir });
    const second = await startDaemon(fs, { pid: 202, dir });

    expect(first.serving).toBe(true);
    expect(second.serving).toBe(false);
    expect(second.exitProcess).toHaveBeenCalledExactlyOnceWith(0);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.files.get(ENDPOINT)).toMatchObject({ live: true, owner: 101 });
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toMatchObject({ pid: 101 });
  });

  it('does not unlink a socket that replaced the stale file while the probe ran', async () => {
    const fs = fakeSocketFs();
    const dir = runtimeDir();
    fs.stale(ENDPOINT);
    let releaseProbe;
    const probeStarted = new Promise(started => {
      let calls = 0;
      // Daemon 202 probes the stale file, then daemon 101 replaces it before 202 can act.
      fs.slowProbe = async path => {
        calls += 1;
        if (calls > 1) return fs.probe(path);
        started();
        await new Promise(release => { releaseProbe = release; });
        return 'absent';
      };
    });
    const late = startDaemon(fs, { pid: 202, dir, probe: path => fs.slowProbe(path) });
    await probeStarted;
    const first = await startDaemon(fs, { pid: 101, dir });
    expect(first.serving).toBe(true);
    const unlinksBefore = fs.unlink.mock.calls.length;
    releaseProbe();
    const second = await late;

    expect(second.serving).toBe(false);
    expect(second.exitProcess).toHaveBeenCalledExactlyOnceWith(0);
    expect(fs.unlink.mock.calls.length).toBe(unlinksBefore);
    expect(fs.files.get(ENDPOINT)).toMatchObject({ live: true, owner: 101 });
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toMatchObject({ pid: 101 });
  });

  it('removes only a stale socket, never a path whose holder it cannot rule out', async () => {
    const fs = fakeSocketFs();
    fs.stale(ENDPOINT);
    const claimed = await claimDaemonEndpoint(ENDPOINT, {
      platform: 'linux', listen: fs.listenAs(1), probe: fs.probe, unlink: fs.unlink, stat: fs.stat, lstat: fs.lstat,
    });
    expect(claimed.claimed).toBe(true);
    expect(fs.unlink).toHaveBeenCalledOnce();

    // A probe that times out (a wedged but maybe live daemon) is not proof the path is stale.
    const dir = runtimeDir();
    const wedged = fakeSocketFs();
    wedged.bind(ENDPOINT, 'wedged');
    const unknown = await startDaemon(wedged, { pid: 303, dir, probe: async () => 'unknown' });
    expect(unknown.serving).toBe(false);
    expect(unknown.exitProcess).toHaveBeenCalledExactlyOnceWith(1);
    expect(wedged.unlink).not.toHaveBeenCalled();
    expect(wedged.files.get(ENDPOINT)).toMatchObject({ owner: 'wedged' });
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toBeNull();
  });

  it('keeps Windows named pipes on the old path: no probe, no unlink, the listen error stands', async () => {
    const probe = vi.fn();
    const unlink = vi.fn();
    await expect(claimDaemonEndpoint('\\\\.\\pipe\\cdp-X', {
      platform: 'win32',
      listen: async () => { throw codeError('EADDRINUSE'); },
      probe,
      unlink,
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(probe).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    await expect(claimDaemonEndpoint('\\\\.\\pipe\\cdp-X', {
      platform: 'win32', listen: async () => {}, probe, unlink,
    })).resolves.toEqual({ claimed: true, identity: null });

    // A Windows daemon still closes its pipe server on exit, with no socket identity.
    const fs = fakeSocketFs();
    const win = await startDaemon(fs, { pid: 404, dir: runtimeDir(), platform: 'win32' });
    expect(win.serving).toBe(true);
    expect(win.watched.identity).toBeNull();
    win.lifecycle.shutdown(0);
    expect(win.server.close).toHaveBeenCalledOnce();
  });

  it('rethrows a listen failure that is not an address conflict, and exits 1', async () => {
    const probe = vi.fn();
    await expect(claimDaemonEndpoint(ENDPOINT, {
      platform: 'linux',
      listen: async () => { throw codeError('EACCES'); },
      probe,
      unlink: vi.fn(),
    })).rejects.toMatchObject({ code: 'EACCES' });
    expect(probe).not.toHaveBeenCalled();

    const fs = fakeSocketFs();
    fs.listenAs = () => async () => { throw codeError('EACCES'); };
    const failed = await startDaemon(fs, { pid: 505, dir: runtimeDir() });
    expect(failed.serving).toBe(false);
    expect(failed.exitProcess).toHaveBeenCalledExactlyOnceWith(1);
    expect(failed.server.close).not.toHaveBeenCalled();
  });

  it('a spawned daemon exits before attaching when a daemon already answers (POSIX only)', async () => {
    await expect(T.daemonAlreadyServes(ENDPOINT, { platform: 'linux', probe: async () => 'answers' })).resolves.toBe(true);
    await expect(T.daemonAlreadyServes(ENDPOINT, { platform: 'linux', probe: async () => 'absent' })).resolves.toBe(false);
    await expect(T.daemonAlreadyServes(ENDPOINT, { platform: 'linux', probe: async () => 'unknown' })).resolves.toBe(false);
    const probe = vi.fn(async () => 'answers');
    await expect(T.daemonAlreadyServes('\\\\.\\pipe\\cdp-X', { platform: 'win32', probe })).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('#458 a daemon removes only the socket it created', () => {
  it('a daemon whose socket was replaced exits through the watch and leaves the newer socket and record', async () => {
    const fs = fakeSocketFs();
    const dir = runtimeDir();
    const older = await startDaemon(fs, { pid: 101, dir });
    expect(older.serving).toBe(true);
    // Another process replaced the socket (an old client, or the residual race) and recorded itself.
    fs.files.delete(ENDPOINT);
    fs.bind(ENDPOINT, 202);
    T.writeDaemonRecord(TARGET_ID, { pid: 202, startedAt: 'newer' }, { runtimeDir: dir });

    older.watched.onLost();

    expect(older.exitProcess).toHaveBeenCalledExactlyOnceWith(0);
    expect(older.server.close).not.toHaveBeenCalled();
    expect(fs.files.get(ENDPOINT)).toMatchObject({ live: true, owner: 202 });
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toMatchObject({ pid: 202 });
  });

  function shutdownWith({ identity, current }) {
    const server = { close: vi.fn() };
    T.createDaemonShutdown({
      requestConnections: new Set(),
      getServer: () => server,
      socketPath: ENDPOINT,
      getSocketIdentity: () => identity,
      statSocket: () => {
        if (!current) throw codeError('ENOENT');
        return current;
      },
      closeCdp: () => {},
      exitProcess: () => {},
      isWindows: false,
    })(0);
    return server.close;
  }

  it('an older daemon idling out does not close (and so unlink) a path whose inode changed', () => {
    expect(shutdownWith({ identity: { dev: 1, ino: 100 }, current: { dev: 1, ino: 101 } })).not.toHaveBeenCalled();
    expect(shutdownWith({ identity: { dev: 1, ino: 100 }, current: { dev: 2, ino: 100 } })).not.toHaveBeenCalled();
    expect(shutdownWith({ identity: { dev: 1, ino: 100 }, current: null })).not.toHaveBeenCalled();
  });

  it('a daemon that never bound the path (lost the race, or listen failed) closes nothing', () => {
    expect(shutdownWith({ identity: null, current: { dev: 1, ino: 100 } })).not.toHaveBeenCalled();
  });

  it('a daemon still holding its own socket closes its server', () => {
    expect(shutdownWith({ identity: { dev: 1, ino: 100 }, current: { dev: 1, ino: 100 } })).toHaveBeenCalledOnce();
  });

  it('a daemon removes the record only while it still names this daemon', () => {
    const dir = runtimeDir();
    T.writeDaemonRecord(TARGET_ID, { pid: 202, startedAt: 'winner' }, { runtimeDir: dir });
    T.removeOwnDaemonRecord(TARGET_ID, { pid: 101, runtimeDir: dir });
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toMatchObject({ pid: 202 });
    T.removeOwnDaemonRecord(TARGET_ID, { pid: 202, runtimeDir: dir });
    expect(T.readDaemonRecord(TARGET_ID, { runtimeDir: dir })).toBeNull();
  });
});

describe('#458 socket probe and ownership watch', () => {
  it('maps a connect result to answers, absent or unknown and closes the probe connection', async () => {
    const conn = { destroy: vi.fn() };
    await expect(probeDaemonEndpoint(ENDPOINT, { connect: async () => conn })).resolves.toBe('answers');
    expect(conn.destroy).toHaveBeenCalledOnce();
    for (const code of ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']) {
      await expect(probeDaemonEndpoint(ENDPOINT, { connect: async () => { throw codeError(code); } })).resolves.toBe('absent');
    }
    await expect(probeDaemonEndpoint(ENDPOINT, { connect: async () => { throw new Error('Timed out connecting'); } })).resolves.toBe('unknown');
    await expect(probeDaemonEndpoint(ENDPOINT, { connect: async () => { throw codeError('EACCES'); } })).resolves.toBe('unknown');
  });

  it('reads a socket identity as dev and ino, or null when the path is gone', () => {
    expect(daemonSocketIdentity(ENDPOINT, { stat: () => ({ dev: 7, ino: 9, size: 0 }) })).toEqual({ dev: 7, ino: 9 });
    expect(daemonSocketIdentity(ENDPOINT, { stat: () => { throw codeError('ENOENT'); } })).toBeNull();
  });

  it('reports a daemon whose socket another process replaced or removed, once', () => {
    let current = { dev: 1, ino: 100 };
    let check = null;
    const onLost = vi.fn();
    const timer = { unref: vi.fn() };
    const stop = watchDaemonSocket(ENDPOINT, {
      identity: { dev: 1, ino: 100 },
      onLost,
      stat: () => {
        if (current instanceof Error) throw current;
        return current;
      },
      setTimer: fn => { check = fn; return timer; },
      clearTimer: vi.fn(),
    });
    expect(timer.unref).toHaveBeenCalledOnce();
    check();
    expect(onLost).not.toHaveBeenCalled();
    // A transient stat failure is not proof the socket is gone.
    current = codeError('EACCES');
    check();
    expect(onLost).not.toHaveBeenCalled();
    current = { dev: 1, ino: 101 };
    check();
    check();
    expect(onLost).toHaveBeenCalledOnce();
    expect(typeof stop).toBe('function');

    const onGone = vi.fn();
    let checkGone = null;
    watchDaemonSocket(ENDPOINT, {
      identity: { dev: 1, ino: 100 },
      onLost: onGone,
      stat: () => { throw codeError('ENOENT'); },
      setTimer: fn => { checkGone = fn; return {}; },
      clearTimer: () => {},
    });
    checkGone();
    expect(onGone).toHaveBeenCalledOnce();
  });

  it('does not watch without an identity (Windows named pipes)', () => {
    const setTimer = vi.fn();
    watchDaemonSocket('\\\\.\\pipe\\cdp-X', { identity: null, onLost: () => {}, setTimer });
    expect(setTimer).not.toHaveBeenCalled();
  });
});

// Real Unix sockets (Linux/macOS CI): the libuv behavior the fix relies on.
describe.skipIf(process.platform === 'win32')('#458 on real Unix sockets', () => {
  const servers = [];
  afterEach(async () => {
    for (const server of servers.splice(0).reverse()) await new Promise(done => server.close(() => done()));
  });
  function listenWith(server) {
    servers.push(server);
    return path => new Promise((resolveListen, rejectListen) => {
      const onError = error => { server.off('listening', onListening); rejectListen(error); };
      const onListening = () => { server.off('error', onError); resolveListen(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(path);
    });
  }
  const answers = path => probeDaemonEndpoint(path);

  it('a newcomer leaves a live socket bound and a stale one is replaced', async () => {
    const net = (await import('net')).default;
    const { existsSync, unlinkSync } = await import('fs');
    const { spawnSync } = await import('child_process');
    const path = join(runtimeDir(), 'd.sock');

    // A daemon that died without cleanup leaves its socket file behind (process.exit does not unlink).
    const crashed = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`]);
    expect(crashed.status).toBe(0);
    expect(existsSync(path)).toBe(true);
    await expect(answers(path)).resolves.toBe('absent');

    const first = await claimDaemonEndpoint(path, { listen: listenWith(net.createServer()), unlink: unlinkSync });
    expect(first.claimed).toBe(true);
    const second = await claimDaemonEndpoint(path, { listen: listenWith(net.createServer()), unlink: unlinkSync });
    expect(second).toEqual({ claimed: false, holder: 'answers', identity: null });
    expect(daemonSocketIdentity(path)).toEqual(first.identity);
    await expect(answers(path)).resolves.toBe('answers');
  });

  it('closing its own server removes the path; a non-owner does not close, so the newer socket stays', async () => {
    const net = (await import('net')).default;
    const { existsSync, unlinkSync } = await import('fs');
    const path = join(runtimeDir(), 'd.sock');
    const older = net.createServer();
    const olderClaim = await claimDaemonEndpoint(path, { listen: listenWith(older), unlink: unlinkSync });
    unlinkSync(path);
    const newer = net.createServer();
    const newerClaim = await claimDaemonEndpoint(path, { listen: listenWith(newer), unlink: unlinkSync });
    expect(newerClaim.identity).not.toEqual(olderClaim.identity);

    const shutdownFor = (server, identity) => {
      const exitProcess = vi.fn();
      T.createDaemonShutdown({
        requestConnections: new Set(),
        getServer: () => server,
        socketPath: path,
        getSocketIdentity: () => identity,
        closeCdp: () => {},
        exitProcess,
        isWindows: false,
      })(0);
      return exitProcess;
    };
    expect(shutdownFor(older, olderClaim.identity)).toHaveBeenCalledExactlyOnceWith(0);
    expect(daemonSocketIdentity(path)).toEqual(newerClaim.identity);
    await expect(answers(path)).resolves.toBe('answers');

    // The owner's shutdown only closes its server: libuv removes the path, no unlink needed.
    expect(shutdownFor(newer, newerClaim.identity)).toHaveBeenCalledExactlyOnceWith(0);
    expect(existsSync(path)).toBe(false);
    servers.splice(servers.indexOf(newer), 1);

    // What the older daemon's shutdown avoided: closing a server whose path was rebound
    // removes whatever socket is at the path now.
    const newest = await claimDaemonEndpoint(path, { listen: listenWith(net.createServer()), unlink: unlinkSync });
    expect(newest.claimed).toBe(true);
    await new Promise(done => older.close(() => done()));
    servers.splice(servers.indexOf(older), 1);
    expect(existsSync(path)).toBe(false);
  });
});

describe('#458 clients leave stale-socket cleanup to the daemon', () => {
  it('getOrStartTabDaemon spawns without unlinking a path another client may have just bound', async () => {
    const unlink = vi.fn();
    const connection = { id: 'connected' };
    const connect = vi.fn()
      .mockRejectedValueOnce(codeError('ECONNREFUSED'))
      .mockResolvedValueOnce(connection);
    await expect(T.getOrStartTabDaemon(TARGET_ID, {
      connect,
      unlink,
      spawnProcess: () => ({ unref() {} }),
      delay: async () => {},
      retries: 2,
      retryDelayMs: 1,
      platform: 'linux',
      runtimeDir: '/run/cdp',
      scriptPath: '/fixture/cdp.mjs',
      execPath: '/fixture/node',
    })).resolves.toBe(connection);
    expect(unlink).not.toHaveBeenCalled();
  });
});
