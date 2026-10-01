import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const FULL = 'ABCDEF1234567890ABCDEF1234567890';
const OTHER = '1234567890ABCDEF1234567890ABCDEF';

function enoent() {
  return Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
}

function fakeRegistry(records = {}) {
  const store = new Map(Object.entries(records));
  return {
    store,
    list: vi.fn(() => [...store.entries()].map(([targetId, record]) => ({ targetId, ...record }))),
    read: vi.fn(targetId => (store.has(targetId) ? { targetId, ...store.get(targetId) } : null)),
    remove: vi.fn(targetId => { store.delete(targetId); }),
  };
}

function pipe(targetId) {
  return { targetId, socketPath: `\\\\.\\pipe\\cdp-${targetId}` };
}

function deps(overrides = {}) {
  return {
    platform: 'win32',
    list: () => [],
    registry: fakeRegistry(),
    connect: async () => { throw enoent(); },
    send: async () => ({ ok: true, result: '' }),
    unlink: vi.fn(),
    isAlive: () => false,
    isDaemonProcess: () => false,
    kill: vi.fn(),
    sleep: async () => {},
    ...overrides,
  };
}

describe('#417 stop on a daemon whose browser is gone', () => {
  it('reports "already gone" and removes the registry record when the pipe and process are gone', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242 } });
    const kill = vi.fn();
    const model = await T.stopDaemons('ABCDEF12', deps({ list: () => [pipe(FULL)], registry, kill }));

    expect(kill).not.toHaveBeenCalled();
    expect(registry.remove).toHaveBeenCalledWith(FULL);
    expect(model).toMatchObject({
      requestedTarget: 'ABCDEF12',
      stopped: false,
      stoppedTargets: [],
      goneTargets: ['ABCDEF12'],
      failedTargets: [],
      remainingSessions: 0,
      noop: false,
    });
    expect(model.results).toEqual([{ target: 'ABCDEF12', status: 'gone', reason: expect.any(String) }]);
    const text = T.formatStopResult(model);
    expect(text).toContain('ABCDEF12: already gone');
    expect(text.split('\n').filter(line => line.startsWith('ABCDEF12:'))).toHaveLength(1);
  });

  it('does not call a cached page with no daemon and no record a failed daemon (win32 pages.json enumeration)', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({ list: () => [pipe(FULL)] }));
    expect(model).toMatchObject({
      stopped: false,
      stoppedTargets: [],
      goneTargets: [],
      failedTargets: [],
      remainingSessions: 0,
      noop: true,
    });
    expect(T.formatStopResult(model)).toContain('No active daemon for ABCDEF12');
  });

  it('stops only daemons that exist when several cached pages are listed without a target', async () => {
    const connect = async path => {
      if (path.endsWith(FULL)) return { live: true };
      throw enoent();
    };
    const model = await T.stopDaemons(null, deps({ list: () => [pipe(FULL), pipe(OTHER)], connect }));
    expect(model).toMatchObject({
      stoppedTargets: ['ABCDEF12'],
      failedTargets: [],
      remainingSessions: 0,
    });
  });

  it('kills a recorded daemon that is alive but unreachable, then removes its record', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242 } });
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const isDaemonProcess = vi.fn(() => true);
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      registry,
      connect: async () => ({ live: true }),
      send: async () => { throw new Error('Timed out waiting for daemon response'); },
      isAlive: () => alive,
      isDaemonProcess,
      kill,
    }));

    expect(isDaemonProcess).toHaveBeenCalledWith(4242, FULL);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(registry.remove).toHaveBeenCalledWith(FULL);
    expect(model).toMatchObject({ stoppedTargets: ['ABCDEF12'], failedTargets: [], remainingSessions: 0 });
    expect(model.results[0]).toMatchObject({ status: 'stopped' });
    expect(T.formatStopResult(model)).toContain('ABCDEF12: stopped (unresponsive, killed pid 4242)');
  });

  it('removes the stale POSIX socket and kills a live unreachable daemon found only through its record', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 77 } });
    let alive = true;
    const unlink = vi.fn();
    const model = await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [],
      registry,
      connect: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
      isAlive: () => alive,
      isDaemonProcess: () => true,
      kill: () => { alive = false; },
      unlink,
    }));
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/cdp-ABCDEF1234567890ABCDEF1234567890\.sock$/));
    expect(model).toMatchObject({ stoppedTargets: ['ABCDEF12'], failedTargets: [] });
  });

  it('never kills a pid that is alive but is not this target daemon (pid reuse)', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242 } });
    const kill = vi.fn();
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      registry,
      isAlive: () => true,
      isDaemonProcess: () => false,
      kill,
    }));
    expect(kill).not.toHaveBeenCalled();
    expect(registry.remove).toHaveBeenCalledWith(FULL);
    expect(model).toMatchObject({ goneTargets: ['ABCDEF12'], failedTargets: [] });
  });

  it('reports failed with the reason when the recorded daemon survives the kill', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242 } });
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      registry,
      connect: async () => { throw new Error('Timed out connecting to daemon socket'); },
      isAlive: () => true,
      isDaemonProcess: () => true,
      kill: vi.fn(),
    }));
    expect(model).toMatchObject({ stoppedTargets: [], failedTargets: ['ABCDEF12'], remainingSessions: 1 });
    expect(model.results[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('4242') });
    expect(registry.remove).not.toHaveBeenCalled();
    expect(T.formatStopResult(model)).toMatch(/ABCDEF12: failed: .*4242/);
  });

  it('reports failed without a record when the endpoint exists but cannot be reached (win32)', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      connect: async () => { throw new Error('ECONNREFUSED'); },
    }));
    expect(model).toMatchObject({ failedTargets: ['ABCDEF12'], goneTargets: [], remainingSessions: 1 });
    expect(model.results[0].reason).toContain('ECONNREFUSED');
  });

  it('keeps stopping the remaining daemons when one rejects stop with ok:false', async () => {
    const send = vi.fn(async conn => (conn.id === 'first'
      ? { ok: false, error: 'busy' }
      : { ok: true, result: '' }));
    const connect = async path => ({ id: path.endsWith(FULL) ? 'first' : 'second' });
    const model = await T.stopDaemons(null, deps({ list: () => [pipe(FULL), pipe(OTHER)], connect, send }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(model).toMatchObject({
      stoppedTargets: ['12345678'],
      failedTargets: ['ABCDEF12'],
      remainingSessions: 1,
    });
    expect(model.results.find(entry => entry.target === 'ABCDEF12')).toMatchObject({ status: 'failed', reason: 'busy' });
  });

  it('does not kill or delete anything when the live pid cannot be verified', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242 } });
    const kill = vi.fn();
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      registry,
      isAlive: () => true,
      isDaemonProcess: () => null,
      kill,
    }));
    expect(kill).not.toHaveBeenCalled();
    expect(registry.remove).not.toHaveBeenCalled();
    expect(model).toMatchObject({ failedTargets: ['ABCDEF12'], goneTargets: [], remainingSessions: 1 });
    expect(model.results[0].reason).toContain('could not be verified');
  });

  it('counts a stop whose reply was lost as stopped when the daemon is gone afterwards', async () => {
    const lost = () => { throw new Error('Connection closed before response'); };
    const withRecord = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      registry: fakeRegistry({ [FULL]: { pid: 4242 } }),
      connect: async () => ({ live: true }),
      send: lost,
      isAlive: () => false,
    }));
    expect(withRecord).toMatchObject({ stoppedTargets: ['ABCDEF12'], failedTargets: [] });

    let calls = 0;
    const noRecord = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      connect: async () => { if (calls++ === 0) return { live: true }; throw enoent(); },
      send: lost,
    }));
    expect(noRecord).toMatchObject({ stoppedTargets: ['ABCDEF12'], failedTargets: [] });

    const stillUp = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      connect: async () => ({ live: true, destroy() {} }),
      send: lost,
    }));
    expect(stillUp).toMatchObject({ stoppedTargets: [], failedTargets: ['ABCDEF12'] });
  });

  it('keeps the json receipt additive', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242 } });
    const model = await T.stopDaemons('ABCDEF12', deps({ list: () => [pipe(FULL)], registry }));
    const parsed = JSON.parse(T.formatStopResult(model, { format: 'json' }));
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.stop.v1',
      requestedTarget: 'ABCDEF12',
      stopped: false,
      goneTargets: ['ABCDEF12'],
      failedTargets: [],
    });
  });
});

describe('#417 daemon registry records', () => {
  it('writes, reads, lists and removes a per-daemon record without touching session logs', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'cdp-registry-'));
    T.writeDaemonRecord(FULL, { pid: 4242, startedAt: '2026-10-01T00:00:00.000Z' }, { runtimeDir });

    expect(T.daemonRecordPath(FULL, runtimeDir)).toMatch(/cdp-ABCDEF1234567890ABCDEF1234567890\.daemon\.json$/);
    expect(T.readDaemonRecord(FULL, { runtimeDir })).toMatchObject({ targetId: FULL, pid: 4242 });
    expect(T.listDaemonRecords({ runtimeDir })).toEqual([expect.objectContaining({ targetId: FULL, pid: 4242 })]);
    expect(T.readDaemonRecord(OTHER, { runtimeDir })).toBeNull();

    T.removeDaemonRecord(FULL, { runtimeDir });
    expect(existsSync(T.daemonRecordPath(FULL, runtimeDir))).toBe(false);
    expect(readdirSync(runtimeDir)).toEqual([]);
    expect(() => T.removeDaemonRecord(FULL, { runtimeDir })).not.toThrow();
  });

  it('ignores a corrupt or foreign record file', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'cdp-registry-'));
    T.writeDaemonRecord(FULL, { pid: 'not-a-pid' }, { runtimeDir });
    expect(T.readDaemonRecord(FULL, { runtimeDir })).toBeNull();
    expect(T.listDaemonRecords({ runtimeDir })).toEqual([]);
  });

  it('daemon shutdown removes its record', () => {
    const removeRecord = vi.fn();
    const shutdown = T.createDaemonShutdown({
      requestConnections: new Set(),
      getServer: () => null,
      socketPath: 'x',
      cleanupSession: () => {},
      closeCdp: () => {},
      exitProcess: () => {},
      removeRecord,
      isWindows: true,
    });
    shutdown(0);
    expect(removeRecord).toHaveBeenCalledOnce();
  });

  it('keeps the other records when one file cannot be read or has a bad target id', () => {
    const files = {
      [`cdp-${FULL}.daemon.json`]: JSON.stringify({ schema: 'chrome-cdp-ex.daemon-record.v1', targetId: FULL, pid: 9 }),
      [`cdp-${OTHER}.daemon.json`]: 'throws',
      'cdp-evil.daemon.json': JSON.stringify({ schema: 'chrome-cdp-ex.daemon-record.v1', targetId: '../evil', pid: 9 }),
      'cdp-mismatch.daemon.json': JSON.stringify({ schema: 'chrome-cdp-ex.daemon-record.v1', targetId: FULL, pid: 9 }),
    };
    const records = T.listDaemonRecords({
      runtimeDir: '/runtime',
      readdir: () => Object.keys(files),
      reader: path => {
        const body = files[path.split(/[\\/]/).pop()];
        if (body === 'throws') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return body;
      },
    });
    expect(records).toEqual([expect.objectContaining({ targetId: FULL, pid: 9 })]);
  });
});

describe('#417 process identity check', () => {
  const win = (stdout, status = 0, extra = {}) => ({ status, stdout, stderr: '', ...extra });
  it('accepts only this target daemon command line and tells "no" from "cannot check"', () => {
    const cmd = `"node.exe" D:/x/cdp.mjs _daemon ${FULL}`;
    const check = (result, platform = 'win32') => T.processIsTargetDaemon(4242, FULL, { platform, spawnSyncFn: () => result });
    expect(check(win(cmd))).toBe(true);
    expect(check(win(`"node.exe" D:/x/cdp.mjs _daemon ${OTHER}`))).toBe(false);
    expect(check(win('notepad.exe'))).toBe(false);
    expect(check(win(''))).toBeNull();
    expect(check({ status: 0, stdout: '' }, 'linux')).toBe(false);
    expect(check({ status: 1, stdout: '', stderr: '' }, 'linux')).toBe(false);
    expect(check({ status: 1, stdout: '', stderr: 'ps: invalid option' }, 'linux')).toBeNull();
    expect(check({ status: null, stdout: '', error: new Error('ENOENT') })).toBeNull();
    expect(check({ status: null, stdout: '', signal: 'SIGTERM' })).toBeNull();
    expect(T.processIsTargetDaemon(4242, FULL, { spawnSyncFn: () => { throw new Error('boom'); } })).toBeNull();
  });
});

describe('#417 unreachable daemon without a record', () => {
  it('does not call a connect timeout proof that the daemon is gone', async () => {
    const unlink = vi.fn();
    const model = await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [{ targetId: FULL, socketPath: `/runtime/cdp-${FULL}.sock` }],
      connect: async () => { throw new Error('Timed out connecting to daemon socket'); },
      unlink,
    }));
    expect(unlink).not.toHaveBeenCalled();
    expect(model).toMatchObject({ failedTargets: ['ABCDEF12'], goneTargets: [], remainingSessions: 1 });
  });

  it('does not report stopped when a listener still answers and the recorded pid was reused', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      registry: fakeRegistry({ [FULL]: { pid: 4242 } }),
      connect: async () => ({ live: true, destroy() {} }),
      send: async () => { throw new Error('Connection closed before response'); },
      isAlive: () => true,
      isDaemonProcess: () => false,
    }));
    expect(model).toMatchObject({ stoppedTargets: [], failedTargets: ['ABCDEF12'] });
  });
});

describe('#439 stop counts only live daemons and removes only what the dead daemon left', () => {
  const THIRD = 'FEDCBA0987654321FEDCBA0987654321';
  const sock = targetId => ({ targetId, socketPath: `/runtime/cdp-${targetId}.sock` });
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const timedOut = () => new Error('Timed out connecting to daemon socket');
  const answersFor = (...ids) => async path => {
    if (ids.some(id => path.includes(id))) return { live: true, destroy() {} };
    throw path.startsWith('\\\\.\\pipe\\') ? enoent() : refused();
  };

  it('win32: a page-cache entry that never had a daemon is not a remaining session', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL), pipe(OTHER)],
      connect: answersFor(FULL),
    }));
    expect(model).toMatchObject({ stoppedTargets: ['ABCDEF12'], remainingSessions: 0, remainingTargets: [] });
    expect(T.formatStopResult(model)).toBe('Stopped daemon ABCDEF12; 0 remaining session(s).');
  });

  it('win32: an unselected target with a live recorded pid or an answering pipe still counts', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL), pipe(OTHER), pipe(THIRD)],
      registry: fakeRegistry({ [OTHER]: { pid: 31, startedAt: 'a' } }),
      isAlive: pid => pid === 31,
      connect: answersFor(FULL, THIRD),
    }));
    expect(model.stoppedTargets).toEqual(['ABCDEF12']);
    expect(model.remainingSessions).toBe(2);
    expect([...model.remainingTargets].sort()).toEqual(['12345678', 'FEDCBA09']);
  });

  it('win32: a record whose pid is dead and whose pipe is missing is not a remaining session', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL), pipe(OTHER)],
      registry: fakeRegistry({ [OTHER]: { pid: 31, startedAt: 'a' } }),
      connect: answersFor(FULL),
      isAlive: () => false,
    }));
    expect(model).toMatchObject({ stoppedTargets: ['ABCDEF12'], remainingSessions: 0 });
  });

  it('counts an unselected daemon whose endpoint only timed out as remaining (it may be slow, not gone)', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [sock(FULL), sock(OTHER)],
      connect: async path => {
        if (path.includes(FULL)) return { live: true, destroy() {} };
        throw timedOut();
      },
    }));
    expect(model).toMatchObject({ stoppedTargets: ['ABCDEF12'], remainingSessions: 1, remainingTargets: ['12345678'] });
  });

  it('a target prefix that matches nothing counts only live daemons as remaining', async () => {
    const model = await T.stopDaemons('99999999', deps({
      platform: 'linux',
      list: () => [sock(FULL), sock(OTHER)],
      connect: answersFor(OTHER),
    }));
    expect(model).toMatchObject({ noop: true, remainingSessions: 1, remainingTargets: ['12345678'] });
  });

  it('posix: an unselected stale socket that refuses connections is not a remaining session', async () => {
    const model = await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [sock(FULL), sock(OTHER)],
      connect: answersFor(FULL),
    }));
    expect(model).toMatchObject({ stoppedTargets: ['ABCDEF12'], remainingSessions: 0 });
  });

  it('leaves the record and socket that a new daemon wrote during the kill window', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242, startedAt: 'old' } });
    const unlink = vi.fn();
    let alive = true;
    let replaced = false;
    const kill = vi.fn(() => {
      alive = false;
      // A new daemon for the same target starts while stop waits for 4242 to die.
      registry.store.set(FULL, { pid: 5555, startedAt: 'new' });
      replaced = true;
    });
    const model = await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [sock(FULL)],
      registry,
      connect: async () => {
        if (replaced) return { live: true, destroy() {} };
        throw timedOut();
      },
      isAlive: pid => (pid === 4242 ? alive : true),
      isDaemonProcess: () => true,
      kill,
      unlink,
    }));
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(registry.remove).not.toHaveBeenCalled();
    expect(registry.store.get(FULL)).toMatchObject({ pid: 5555, startedAt: 'new' });
    expect(unlink).not.toHaveBeenCalled();
    expect(model.results[0]).toMatchObject({ status: 'stopped', reason: expect.stringContaining('killed pid 4242') });
    // The new daemon is live, so the target still has a session.
    expect(model).toMatchObject({ stoppedTargets: ['ABCDEF12'], remainingSessions: 1, remainingTargets: ['ABCDEF12'] });
  });

  it('leaves a record whose start time changed even when the pid is the same', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242, startedAt: 'old' } });
    const unlink = vi.fn();
    let reads = 0;
    registry.read = vi.fn(targetId => {
      reads += 1;
      return { targetId, pid: 4242, startedAt: reads === 1 ? 'old' : 'new' };
    });
    await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [sock(FULL)],
      registry,
      connect: async () => { throw refused(); },
      isAlive: () => false,
      unlink,
    }));
    expect(registry.remove).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('does not remove the socket of a daemon that only timed out, but removes the dead pid record', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242, startedAt: 'old' } });
    const unlink = vi.fn();
    const model = await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [sock(FULL)],
      registry,
      connect: async () => { throw timedOut(); },
      isAlive: () => false,
      unlink,
    }));
    expect(unlink).not.toHaveBeenCalled();
    expect(registry.remove).toHaveBeenCalledWith(FULL);
    expect(model).toMatchObject({ failedTargets: ['ABCDEF12'], goneTargets: [], remainingSessions: 1 });
    expect(model.results[0].reason).toMatch(/left in place/);
  });

  it('after killing the recorded pid, leaves a socket that still does not refuse connections', async () => {
    const registry = fakeRegistry({ [FULL]: { pid: 4242, startedAt: 'old' } });
    const unlink = vi.fn();
    let alive = true;
    const model = await T.stopDaemons('ABCDEF12', deps({
      platform: 'linux',
      list: () => [sock(FULL)],
      registry,
      connect: async () => { throw timedOut(); },
      isAlive: () => alive,
      isDaemonProcess: () => true,
      kill: () => { alive = false; },
      unlink,
    }));
    expect(registry.remove).toHaveBeenCalledWith(FULL);
    expect(unlink).not.toHaveBeenCalled();
    expect(model.results[0]).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/killed pid 4242.*left in place/) });
    expect(model.remainingSessions).toBe(1);
  });

  it('a lost stop reply without a record does not remove a record that appeared meanwhile', async () => {
    const registry = fakeRegistry();
    let calls = 0;
    const model = await T.stopDaemons('ABCDEF12', deps({
      list: () => [pipe(FULL)],
      registry,
      connect: async () => {
        if (calls++ === 0) return { live: true };
        registry.store.set(FULL, { pid: 9, startedAt: 'new' });
        throw enoent();
      },
      send: () => { throw new Error('Connection closed before response'); },
    }));
    expect(model.stoppedTargets).toEqual(['ABCDEF12']);
    expect(registry.remove).not.toHaveBeenCalled();
  });
});
