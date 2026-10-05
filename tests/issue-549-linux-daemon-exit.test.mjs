import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  claimDaemonEndpoint,
  watchDaemonSocket,
} = await import('../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs');

const CDP_SOURCE = new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url);

const tempDirs = [];
function runtimeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-549-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionAt(dir, name = 'T549') {
  return T.createSessionState({
    targetId: name,
    sessionId: 'sid-549',
    logPath: join(dir, `cdp-${name}.log`),
  });
}

function logEvents(session) {
  return readFileSync(session.logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('#549 socket watch keeps the owning daemon', () => {
  it('does not call onLost when statSync without bigint would disagree with the recorded identity', () => {
    const identity = { dev: 1n, ino: 100n, ctime: 50n };
    const onLost = vi.fn();
    let check = null;
    watchDaemonSocket('/tmp/cdp-549.sock', {
      identity,
      onLost,
      stat: (_path, options) => (options?.bigint
        ? { dev: 1n, ino: 100n, ctimeNs: 50n }
        : { dev: 1, ino: 100, ctimeNs: 50n }),
      setTimer: fn => {
        check = fn;
        return { unref() {} };
      },
      clearTimer: () => {},
    });
    check();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('a real bound socket is still this daemon after one watch tick, and a replacement is not', async () => {
    const dir = runtimeDir();
    const endpoint = join(dir, 'cdp-T549.sock');
    const server = net.createServer();
    const listen = path => new Promise((resolveListen, rejectListen) => {
      const onError = error => {
        server.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(path);
    });
    try {
      const claim = await claimDaemonEndpoint(endpoint, { listen, unlink: () => {} });
      expect(claim.claimed).toBe(true);
      const onLost = vi.fn();
      let check = null;
      watchDaemonSocket(endpoint, {
        identity: claim.identity,
        onLost,
        stat: statSync,
        setTimer: fn => {
          check = fn;
          return { unref() {} };
        },
        clearTimer: () => {},
      });
      check();
      expect(onLost).not.toHaveBeenCalled();

      // A newer socket at the same path (different inode or ctime) is a real loss.
      const replaced = { dev: claim.identity.dev, ino: claim.identity.ino + 1n, ctimeNs: claim.identity.ctime };
      watchDaemonSocket(endpoint, {
        identity: claim.identity,
        onLost,
        stat: () => replaced,
        setTimer: fn => {
          check = fn;
          return { unref() {} };
        },
        clearTimer: () => {},
      });
      check();
      expect(onLost).toHaveBeenCalledOnce();
    } finally {
      await new Promise(done => server.close(() => done()));
    }
  });
});

describe('#549 session log keeps the exit reason', () => {
  it('a first session-start keeps daemon-start and does not claim a restart', () => {
    const session = sessionAt(runtimeDir(), 'T549F');
    T.initializeSessionLog(session, { ts: 10 });
    expect(session.refs.invalidationReason).toBe('daemon-start');
    expect(logEvents(session)).toEqual([
      expect.objectContaining({ kind: 'session-start', restarted: false, ts: 10 }),
    ]);
  });

  it('appends session-start after a prior session-end and marks the new daemon as restarted', () => {
    const session = sessionAt(runtimeDir());
    writeFileSync(session.logPath, `${JSON.stringify({
      schema: 'chrome-cdp-ex.session-event.v1',
      kind: 'session-end',
      reason: 'idle-timeout',
    })}\n`);
    T.initializeSessionLog(session, { ts: Date.parse('2026-10-05T00:00:00.000Z') });
    const events = logEvents(session);
    expect(events.map(event => event.kind)).toEqual(['session-end', 'session-start']);
    expect(events[1]).toMatchObject({
      schema: 'chrome-cdp-ex.session-event.v1',
      targetId: 'T549',
      sessionId: 'sid-549',
      ts: Date.parse('2026-10-05T00:00:00.000Z'),
      restarted: true,
    });
    expect(session.refs.invalidationReason).toBe('daemon-restart');
  });

  it('records exception, idle-timeout, and signal on session-end', () => {
    const session = sessionAt(runtimeDir());
    T.initializeSessionLog(session);
    T.appendSessionExitLog(session, {
      reason: 'exception',
      exceptionKind: 'uncaughtException',
      message: 'boom',
      exitCode: 1,
      ts: 1,
    });
    T.appendSessionExitLog(session, { reason: 'idle-timeout', exitCode: 0, ts: 2 });
    T.appendSessionExitLog(session, { reason: 'signal', signal: 'SIGTERM', exitCode: 0, ts: 3 });
    const ends = logEvents(session).filter(event => event.kind === 'session-end');
    expect(ends).toEqual([
      expect.objectContaining({
        schema: 'chrome-cdp-ex.session-event.v1',
        kind: 'session-end',
        reason: 'exception',
        exceptionKind: 'uncaughtException',
        message: 'boom',
        exitCode: 1,
        ts: 1,
      }),
      expect.objectContaining({ kind: 'session-end', reason: 'idle-timeout', exitCode: 0, ts: 2 }),
      expect.objectContaining({ kind: 'session-end', reason: 'signal', signal: 'SIGTERM', exitCode: 0, ts: 3 }),
    ]);
  });

  it('does not write session-end until this daemon owns the tab log', () => {
    const session = sessionAt(runtimeDir(), 'T549L');
    const exitLog = T.createDaemonExitLog(session);
    exitLog.beforeExit({ reason: 'exit', exitCode: 0 });
    exitLog.onCrash('uncaughtException', new Error('before-own'));
    expect(existsSync(session.logPath)).toBe(false);
    exitLog.markOwned();
    exitLog.beforeExit({ reason: 'idle-timeout', exitCode: 0, ts: 4 });
    expect(logEvents(session)).toEqual([
      expect.objectContaining({ kind: 'session-end', reason: 'idle-timeout', ts: 4 }),
    ]);
  });

  it('shutdown writes the exit reason before the process exits', () => {
    const order = [];
    const session = sessionAt(runtimeDir());
    T.initializeSessionLog(session);
    const exitProcess = vi.fn(() => order.push('exit'));
    const shutdown = T.createDaemonShutdown({
      requestConnections: new Set(),
      getServer: () => ({ close: () => order.push('server') }),
      socketPath: '/run/cdp/cdp-T549.sock',
      closeCdp: () => order.push('cdp'),
      exitProcess,
      isWindows: true,
      beforeExit: info => {
        order.push('log');
        T.appendSessionExitLog(session, info);
      },
    });
    shutdown(0, { reason: 'idle-timeout' });
    expect(order).toEqual(['log', 'server', 'cdp', 'exit']);
    expect(logEvents(session).at(-1)).toMatchObject({ kind: 'session-end', reason: 'idle-timeout', exitCode: 0 });
    expect(exitProcess).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('an uncaught exception is a session-end line written before exit', () => {
    const session = sessionAt(runtimeDir(), 'T549X');
    T.initializeSessionLog(session);
    const handlers = {};
    const processRef = {
      on: (event, fn) => { handlers[event] = fn; },
      exit: vi.fn(),
      stderr: { write() {} },
    };
    T.installDaemonCrashRecorder('T549X', {
      processRef,
      record: () => {},
      onCrash: (kind, error) => T.appendSessionExitLog(session, {
        reason: 'exception',
        exceptionKind: kind,
        message: error?.message,
        exitCode: 1,
      }),
    });
    handlers.uncaughtException(new Error('socket dropped'));
    expect(processRef.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logEvents(session).at(-1)).toMatchObject({
      kind: 'session-end',
      reason: 'exception',
      exceptionKind: 'uncaughtException',
      message: 'socket dropped',
    });
  });

  it('a lost socket and the daemon main paths name idle-timeout, signal, and exception', async () => {
    const beforeExit = vi.fn();
    const exitProcess = vi.fn();
    let onLost = null;
    const lifecycle = T.createDaemonEndpointLifecycle({
      targetId: 'T549',
      socketPath: join(runtimeDir(), 'missing.sock'),
      requestConnections: new Set(),
      getServer: () => ({ close() {} }),
      closeCdp: () => {},
      exitProcess,
      platform: 'linux',
      probe: async () => 'answers',
      unlink: () => {},
      stat: () => ({ dev: 1n, ino: 9n, ctimeNs: 1n }),
      lstat: () => ({ dev: 1n, ino: 9n, ctimeNs: 1n }),
      runtimeDir: runtimeDir(),
      pid: 42,
      watch: (_path, options) => {
        onLost = options.onLost;
        return () => {};
      },
      log: () => {},
      beforeExit,
    });
    const serving = await lifecycle.serve({
      listen: async () => {},
      record: { pid: 42, startedAt: 'now' },
    });
    expect(serving).toBe(true);
    onLost();
    expect(beforeExit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'socket-lost', exitCode: 0 }));
    expect(exitProcess).toHaveBeenCalledExactlyOnceWith(0);

    const source = readFileSync(CDP_SOURCE, 'utf8');
    const runDaemon = source.slice(source.indexOf('async function runDaemon'), source.indexOf('function listenDaemonServer'));
    expect(runDaemon).toMatch(/onIdle:\s*\(\)\s*=>\s*shutdown\(0,\s*\{\s*reason:\s*'idle-timeout'\s*\}\)/);
    expect(runDaemon).toMatch(/shutdown\(0,\s*\{\s*reason:\s*'signal',\s*signal:\s*'SIGTERM'\s*\}\)/);
    expect(runDaemon).toMatch(/shutdown\(0,\s*\{\s*reason:\s*'signal',\s*signal:\s*'SIGINT'\s*\}\)/);
    expect(runDaemon).toMatch(/reason:\s*'exception'/);
    expect(runDaemon).toMatch(/createDaemonEndpointLifecycle\(\{[\s\S]*?beforeExit:\s*info\s*=>\s*exitLog\.current\.beforeExit\(info\)/);
  });
});

describe('#549 unknown ref after a daemon restart', () => {
  it('says the daemon restarted and does not claim that no refs were assigned', () => {
    const restarted = T.formatUnknownRefError('@3', { generation: 0, invalidationReason: 'daemon-restart' });
    expect(restarted).toBe('Unknown ref: @3. Refs from the previous daemon were cleared because this tab\'s daemon restarted. Run "perceive" to refresh refs, or use a CSS selector.');
    expect(restarted).not.toMatch(/No refs have been assigned/);

    const fresh = T.formatUnknownRefError('@3', { generation: 0, invalidationReason: 'daemon-start' });
    expect(fresh).toMatch(/No refs have been assigned/);
  });
});
