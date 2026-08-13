import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const cdpSource = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');

function connection({ holdWrite = false } = {}) {
  const conn = new EventEmitter();
  conn.destroyed = false;
  conn.writable = true;
  conn.writeCallbacks = [];
  conn.write = vi.fn((payload, callback) => {
    if (holdWrite && typeof callback === 'function') conn.writeCallbacks.push(callback);
    else if (typeof callback === 'function') queueMicrotask(callback);
    return true;
  });
  conn.end = vi.fn((payload, callback) => {
    if (payload !== undefined) conn.write(payload, callback);
    else callback?.();
  });
  conn.destroy = vi.fn(() => {
    conn.destroyed = true;
    conn.writable = false;
  });
  conn.closePeer = (event = 'close', error = null) => {
    conn.destroyed = true;
    conn.writable = false;
    if (event === 'error') conn.emit('error', error || new Error('peer error'));
    else conn.emit(event);
  };
  return conn;
}

function frame(request) {
  return `${JSON.stringify(request)}\n`;
}

async function drain() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('daemon request server lifecycle', () => {
  it.each([
    ['SIGTERM', 0],
    ['listen failure', 1],
  ])('aborts all connection registries before the %s shutdown path exits', (_path, exitCode) => {
    const order = [];
    const first = { abortAll: vi.fn(() => order.push('abort:first')) };
    const second = { abortAll: vi.fn(() => order.push('abort:second')) };
    const server = { close: vi.fn(() => order.push('server:close')) };
    const closeCdp = vi.fn(() => order.push('cdp:close'));
    const unlinkSocket = vi.fn(() => order.push('socket:unlink'));
    const exitProcess = vi.fn(code => order.push(`exit:${code}`));
    const shutdown = T.createDaemonShutdown({
      requestConnections: new Set([first, second]),
      getServer: () => server,
      socketPath: '/run/cdp/table.sock',
      closeCdp,
      exitProcess,
      unlinkSocket,
      isWindows: false,
    });

    const signalHandler = () => shutdown(exitCode);
    signalHandler('SIGTERM');
    shutdown(exitCode);

    expect(first.abortAll).toHaveBeenCalledOnce();
    expect(second.abortAll).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(closeCdp).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledExactlyOnceWith(exitCode);
    expect(order).toEqual([
      'abort:first',
      'abort:second',
      'server:close',
      'socket:unlink',
      'cdp:close',
      `exit:${exitCode}`,
    ]);
  });

  it.each(['end', 'close', 'error'])('aborts a live request on peer %s and suppresses every late response/effect', async event => {
    let resolveCollector;
    const firstEffect = vi.fn();
    const laterClick = vi.fn();
    const laterScroll = vi.fn();
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const handleRequest = vi.fn(async (_request, execution) => {
      expect(execution.signal.aborted).toBe(false);
      firstEffect();
      await new Promise(resolve => { resolveCollector = resolve; });
      execution.signal.throwIfAborted();
      laterClick();
      execution.signal.throwIfAborted();
      laterScroll();
      return { ok: true, result: 'collected' };
    });
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest,
      cleanup,
      onDispose: dispose,
      now: () => 0,
    });

    conn.emit('data', frame({
      id: 7,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();
    expect(firstEffect).toHaveBeenCalledOnce();

    const error = event === 'error' ? new Error('read ECONNRESET') : null;
    conn.closePeer(event, error);
    resolveCollector();
    await drain();

    expect(laterClick).not.toHaveBeenCalled();
    expect(laterScroll).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(conn.write).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
    for (const name of ['data', 'end', 'close', 'error']) expect(conn.listenerCount(name)).toBe(0);
  });

  it('keeps ownership through response flush and aborts once if the peer closes first', async () => {
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const controllerSeen = vi.fn();
    const conn = connection({ holdWrite: true });
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async (_request, execution) => {
        controllerSeen(execution.signal);
        return { ok: true, result: 'committed' };
      },
      cleanup,
      onDispose: dispose,
      now: () => 0,
    });

    conn.emit('data', frame({
      id: 1,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    expect(conn.write).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(1);
    const signal = controllerSeen.mock.calls[0][0];
    expect(signal.aborted).toBe(false);

    conn.closePeer('close');
    expect(signal.aborted).toBe(true);
    await drain();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);

    conn.writeCallbacks[0]?.();
    await drain();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retires fatally at 300s when the raw handler remains unsettled', async () => {
    let serverTimer;
    let signal;
    const setTimer = vi.fn((callback, _delay) => {
      serverTimer = callback;
      return Symbol('server-timer');
    });
    const clearTimer = vi.fn();
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const onFatal = vi.fn();
    const conn = connection({ holdWrite: true });
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: (_request, execution) => {
        signal = execution.signal;
        return new Promise(() => {});
      },
      cleanup,
      onDispose: dispose,
      onFatal,
      now: () => 2000,
      setTimer,
      clearTimer,
    });
    conn.emit('data', frame({
      id: 1,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 300000);
    expect(signal.aborted).toBe(false);
    serverTimer();
    await drain();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({
      code: 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED',
      phase: 'server',
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(conn.write).not.toHaveBeenCalled();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(clearTimer).toHaveBeenCalled();
  });

  it('refuses a collect success returned at the absolute server deadline before enqueue', async () => {
    let now = 0;
    let signal;
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const onFatal = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async (_request, execution) => {
        signal = execution.signal;
        now = execution.deadline.serverAt;
        return { ok: true, result: 'late-handler-success' };
      },
      cleanup,
      onDispose: dispose,
      onFatal,
      now: () => now,
      setTimer: vi.fn(() => Symbol('blocked-server-timer')),
      clearTimer: vi.fn(),
    });
    conn.emit('data', frame({
      id: 2,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({
      code: 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED',
      phase: 'server',
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(conn.write).not.toHaveBeenCalled();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('terminates without a response when invoked page work cannot settle by the server deadline', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let terminated = false;
      let lateCallback;
      const lateEffect = vi.fn();
      const finalize = vi.fn(async () => 'must-not-commit');
      const fatalOrder = [];
      const collectorCleanup = vi.fn(() => { fatalOrder.push('collector-cleanup'); });
      const requestCleanup = vi.fn(() => { fatalOrder.push('request-cleanup'); });
      const dispose = vi.fn();
      const onFatal = vi.fn(error => {
        fatalOrder.push('fatal-shutdown');
        terminated = true;
        expect(error).toMatchObject({
          code: 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED',
          phase: 'server',
          requiresDaemonTermination: true,
        });
      });
      const conn = connection();
      const lifecycle = T.createDaemonRequestConnection(conn, {
        handleRequest: async (_request, execution) => {
          const result = await T.runTableCollectionLifecycle(execution, {
            collect: async runtime => {
              runtime.runCdpOperation(() => new Promise(() => {
                lateCallback = () => {
                  if (!terminated) lateEffect();
                };
              })).catch(() => {});
              await Promise.resolve();
              return { termination: 'logical-count-reached' };
            },
            finalize,
            cleanup: collectorCleanup,
          });
          return { ok: true, result };
        },
        cleanup: requestCleanup,
        onDispose: dispose,
        onFatal,
        now: () => now,
      });
      conn.emit('data', frame({
        id: 3,
        cmd: 'table',
        args: ['--collect', '--scroll-container', '.viewport'],
      }));
      await drain();

      expect(finalize).not.toHaveBeenCalled();
      expect(conn.write).not.toHaveBeenCalled();
      expect(onFatal).not.toHaveBeenCalled();
      expect(lifecycle.activeRequestCount()).toBe(1);

      now = 300000;
      await vi.advanceTimersByTimeAsync(300000);
      await drain();

      expect(onFatal).toHaveBeenCalledOnce();
      expect(collectorCleanup).toHaveBeenCalledOnce();
      expect(requestCleanup).toHaveBeenCalledOnce();
      expect(fatalOrder).toEqual(['collector-cleanup', 'request-cleanup', 'fatal-shutdown']);
      expect(dispose).toHaveBeenCalledOnce();
      expect(conn.destroy).toHaveBeenCalledOnce();
      expect(conn.destroyed).toBe(true);
      expect(conn.write).not.toHaveBeenCalled();
      expect(lifecycle.activeRequestCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      for (const name of ['data', 'end', 'close', 'error']) expect(conn.listenerCount(name)).toBe(0);

      lateCallback();
      expect(lateEffect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates without a response when a raw finalizer cannot settle by the server deadline', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let terminated = false;
      let lateCallback;
      const lateEffect = vi.fn();
      const cleanup = vi.fn();
      const requestCleanup = vi.fn();
      const onFatal = vi.fn(() => { terminated = true; });
      const conn = connection();
      T.createDaemonRequestConnection(conn, {
        handleRequest: async (_request, execution) => {
          const result = await T.runTableCollectionLifecycle(execution, {
            collect: async () => ({ termination: 'logical-count-reached' }),
            finalize: () => new Promise(() => {
              lateCallback = () => {
                if (!terminated) lateEffect();
              };
            }),
            cleanup,
          });
          return { ok: true, result };
        },
        cleanup: requestCleanup,
        onFatal,
        now: () => now,
      });
      conn.emit('data', frame({
        id: 31,
        cmd: 'table',
        args: ['--collect', '--scroll-container', '.viewport'],
      }));
      await drain();

      now = 300000;
      await vi.advanceTimersByTimeAsync(300000);
      await drain();

      expect(onFatal).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(requestCleanup).toHaveBeenCalledOnce();
      expect(conn.destroy).toHaveBeenCalledOnce();
      expect(conn.write).not.toHaveBeenCalled();
      lateCallback();
      expect(lateEffect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates without a response when the raw outer collect handler cannot settle by 300s', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let terminated = false;
      let lateCallback;
      const lateEffect = vi.fn();
      const cleanup = vi.fn();
      const dispose = vi.fn();
      const onFatal = vi.fn(() => { terminated = true; });
      const conn = connection();
      const lifecycle = T.createDaemonRequestConnection(conn, {
        handleRequest: () => new Promise(() => {
          lateCallback = () => {
            if (!terminated) lateEffect();
          };
        }),
        cleanup,
        onDispose: dispose,
        onFatal,
        now: () => now,
      });
      conn.emit('data', frame({
        id: 32,
        cmd: 'table',
        args: ['--collect', '--scroll-container', '.viewport'],
      }));
      await drain();

      now = 300000;
      await vi.advanceTimersByTimeAsync(300000);
      await drain();

      expect(onFatal).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(conn.destroy).toHaveBeenCalledOnce();
      expect(conn.write).not.toHaveBeenCalled();
      expect(lifecycle.activeRequestCount()).toBe(0);
      lateCallback();
      expect(lateEffect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires immediately on disconnect when a raw collect handler has not proven settlement', async () => {
    let terminated = false;
    let finishIgnoredHandler;
    const lateEffect = vi.fn();
    const order = [];
    const cleanup = vi.fn(() => { order.push('request-cleanup'); });
    const dispose = vi.fn(() => { order.push('dispose'); });
    const onFatal = vi.fn(error => {
      order.push('fatal-shutdown');
      terminated = true;
      expect(error).toMatchObject({
        code: 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED',
        phase: 'server',
      });
    });
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: () => new Promise(resolve => {
        finishIgnoredHandler = () => {
          if (!terminated) lateEffect();
          resolve({ ok: true, result: 'too late' });
        };
      }),
      cleanup,
      onDispose: dispose,
      onFatal,
      now: () => 0,
    });
    conn.emit('data', frame({
      id: 33,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    conn.closePeer('close');

    expect(onFatal).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(order).toEqual(['request-cleanup', 'dispose', 'fatal-shutdown']);
    expect(conn.write).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);

    finishIgnoredHandler();
    await drain();
    expect(lateEffect).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it('fails closed without awaiting a thenable request cleanup', async () => {
    const then = vi.fn();
    const cleanup = vi.fn(() => ({ then }));
    const onFatal = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async () => ({ ok: false, error: 'collector failed' }),
      cleanup,
      onFatal,
      now: () => 0,
    });
    conn.emit('data', frame({
      id: 34,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(then).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(onFatal.mock.calls[0][0]).toMatchObject({
      code: 'TABLE_COLLECTION_SYNC_CLEANUP_REQUIRED',
      cleanupScope: 'request',
    });
    expect(conn.write).not.toHaveBeenCalled();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('retains synchronous cleanup failures while completing fatal retirement', async () => {
    const collectorFailure = new Error('collector cleanup failed synchronously');
    const requestFailure = new Error('request cleanup failed synchronously');
    const collectorCleanup = vi.fn(() => { throw collectorFailure; });
    const requestCleanup = vi.fn(() => { throw requestFailure; });
    const dispose = vi.fn();
    const onFatal = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async (_request, execution) => {
        const result = await T.runTableCollectionLifecycle(execution, {
          collect: async runtime => {
            runtime.runCdpOperation(() => new Promise(() => {})).catch(() => {});
            await Promise.resolve();
            return { termination: 'logical-count-reached' };
          },
          finalize: vi.fn(),
          cleanup: collectorCleanup,
        });
        return { ok: true, result };
      },
      cleanup: requestCleanup,
      onDispose: dispose,
      onFatal,
      now: () => 0,
    });
    conn.emit('data', frame({
      id: 35,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    conn.closePeer('close');

    expect(collectorCleanup).toHaveBeenCalledOnce();
    expect(requestCleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(onFatal.mock.calls[0][0].cleanupErrors).toEqual([
      collectorFailure,
      requestFailure,
    ]);
    expect(conn.write).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('aborts the outer request before collector and request cleanup during fatal retirement', async () => {
    const order = [];
    let outerSignal;
    let runtimeSignal;
    let collectorReason;
    const collectorCleanup = vi.fn(reason => {
      collectorReason = reason;
      expect(outerSignal.aborted).toBe(true);
      expect(outerSignal.reason).toBe(reason);
      expect(runtimeSignal.aborted).toBe(true);
      expect(runtimeSignal.reason).toBe(reason);
      order.push('collector-cleanup');
    });
    const requestCleanup = vi.fn((_request, execution, reason) => {
      expect(execution.signal).toBe(outerSignal);
      expect(execution.signal.aborted).toBe(true);
      expect(execution.signal.reason).toBe(reason);
      expect(reason).toBe(collectorReason);
      order.push('request-cleanup');
    });
    const dispose = vi.fn(() => { order.push('dispose'); });
    const onFatal = vi.fn(reason => {
      expect(reason).toBe(collectorReason);
      order.push('fatal-shutdown');
    });
    const conn = connection();
    conn.destroy.mockImplementation(() => {
      order.push('destroy');
      conn.destroyed = true;
      conn.writable = false;
    });
    T.createDaemonRequestConnection(conn, {
      handleRequest: async (_request, execution) => {
        outerSignal = execution.signal;
        outerSignal.addEventListener('abort', () => order.push('outer-abort'), { once: true });
        const result = await T.runTableCollectionLifecycle(execution, {
          collect: async runtime => {
            runtimeSignal = runtime.signal;
            runtimeSignal.addEventListener('abort', () => order.push('runtime-abort'), { once: true });
            runtime.runCdpOperation(() => new Promise(() => {})).catch(() => {});
            await Promise.resolve();
            return { termination: 'logical-count-reached' };
          },
          finalize: vi.fn(),
          cleanup: collectorCleanup,
        });
        return { ok: true, result };
      },
      cleanup: requestCleanup,
      onDispose: dispose,
      onFatal,
      now: () => 0,
    });
    conn.emit('data', frame({
      id: 36,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    conn.closePeer('close');

    expect(collectorCleanup).toHaveBeenCalledOnce();
    expect(requestCleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(order).toEqual([
      'outer-abort',
      'runtime-abort',
      'collector-cleanup',
      'request-cleanup',
      'dispose',
      'destroy',
      'fatal-shutdown',
    ]);
  });

  it('aborts an ordinary duplicate active ID on one socket while accepting id=1 on another socket', async () => {
    let firstSignal;
    const firstHandle = vi.fn((_request, execution) => new Promise((resolve, reject) => {
      firstSignal = execution.signal;
      execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true });
    }));
    const connA = connection();
    const connB = connection();
    const lifecycleA = T.createDaemonRequestConnection(connA, {
      handleRequest: firstHandle,
      cleanup: vi.fn(),
      now: () => 0,
    });
    const handleB = vi.fn(async () => ({ ok: true, result: 'other client' }));
    const lifecycleB = T.createDaemonRequestConnection(connB, {
      handleRequest: handleB,
      cleanup: vi.fn(),
      now: () => 0,
    });

    const request = {
      id: 1,
      cmd: 'status',
      args: [],
    };
    connA.emit('data', frame(request));
    await drain();
    connA.emit('data', frame(request));
    connB.emit('data', frame(request));
    await drain();

    expect(firstHandle).toHaveBeenCalledOnce();
    expect(firstSignal.aborted).toBe(true);
    expect(handleB).toHaveBeenCalledOnce();
    expect(lifecycleA.activeRequestCount()).toBe(0);
    expect(connA.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connA.write.mock.calls[0][0])).toEqual({
      id: 1,
      ok: false,
      error: 'Duplicate active request id: 1',
    });
    expect(connA.end).toHaveBeenCalledOnce();
    expect(JSON.parse(connB.write.mock.calls[0][0])).toEqual({
      id: 1,
      ok: true,
      result: 'other client',
    });
    await drain();
    expect(connA.write).toHaveBeenCalledOnce();
    expect(lifecycleA.activeRequestCount()).toBe(0);
    expect(lifecycleB.activeRequestCount()).toBe(0);
  });

  it('fatally retires an unproven collect victim on duplicate ID without emitting a frame', async () => {
    let terminated = false;
    let finishIgnoredHandler;
    let outerSignal;
    let runtimeSignal;
    let collectorReason;
    const lateEffect = vi.fn();
    const order = [];
    const collectorCleanup = vi.fn(reason => {
      collectorReason = reason;
      expect(outerSignal.aborted).toBe(true);
      expect(outerSignal.reason).toBe(reason);
      expect(runtimeSignal.aborted).toBe(true);
      expect(runtimeSignal.reason).toBe(reason);
      order.push('collector-cleanup');
    });
    const requestCleanup = vi.fn((_request, execution, reason) => {
      expect(execution.signal.aborted).toBe(true);
      expect(execution.signal.reason).toBe(reason);
      expect(reason).toBe(collectorReason);
      order.push('request-cleanup');
    });
    const dispose = vi.fn(() => { order.push('dispose'); });
    const onFatal = vi.fn(reason => {
      expect(reason).toBe(collectorReason);
      terminated = true;
      order.push('fatal-shutdown');
    });
    const conn = connection();
    conn.destroy.mockImplementation(() => {
      order.push('destroy');
      conn.destroyed = true;
      conn.writable = false;
    });
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async (_request, execution) => {
        outerSignal = execution.signal;
        outerSignal.addEventListener('abort', () => order.push('outer-abort'), { once: true });
        return T.runTableCollectionLifecycle(execution, {
          collect: async runtime => {
            runtimeSignal = runtime.signal;
            runtimeSignal.addEventListener('abort', () => order.push('runtime-abort'), { once: true });
            runtime.runCdpOperation(() => new Promise(() => {})).catch(() => {});
            await Promise.resolve();
            return new Promise(resolve => {
              finishIgnoredHandler = () => {
                if (!terminated) lateEffect();
                resolve({ termination: 'logical-count-reached' });
              };
            });
          },
          finalize: vi.fn(),
          cleanup: collectorCleanup,
        });
      },
      cleanup: requestCleanup,
      onDispose: dispose,
      onFatal,
      now: () => 0,
    });
    const request = {
      id: 37,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    };
    conn.emit('data', frame(request));
    await drain();
    conn.emit('data', frame(request));

    expect(outerSignal.reason).toMatchObject({
      code: 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED',
      phase: 'server',
    });
    expect(collectorCleanup).toHaveBeenCalledOnce();
    expect(requestCleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(conn.destroy).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(conn.write).not.toHaveBeenCalled();
    expect(conn.end).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
    expect(order).toEqual([
      'outer-abort',
      'runtime-abort',
      'collector-cleanup',
      'request-cleanup',
      'dispose',
      'destroy',
      'fatal-shutdown',
    ]);

    finishIgnoredHandler();
    await drain();
    expect(lateEffect).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it.each([
    [{ cmd: 'status', args: [] }, /request id/],
    [{ id: 0, cmd: 'status', args: [] }, /request id/],
    [{ id: -1, cmd: 'status', args: [] }, /request id/],
    [{ id: 1.5, cmd: 'status', args: [] }, /request id/],
    [{ id: Number.MAX_SAFE_INTEGER + 1, cmd: 'status', args: [] }, /request id/],
    [{ id: 1, args: [] }, /request command/],
    [{ id: 1, cmd: '', args: [] }, /request command/],
    [{ id: 1, cmd: 'status' }, /request args/],
    [{ id: 1, cmd: 'status', args: 'bad' }, /request args/],
    [{ id: 1, cmd: 'status', args: [], planted: true }, /request\.planted/],
  ])('rejects invalid protocol input before reservation or dispatch: %j', async (request, expected) => {
    const handleRequest = vi.fn();
    const cleanup = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest,
      cleanup,
      now: () => 0,
    });
    conn.emit('data', frame(request));
    await drain();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
    expect(conn.write).toHaveBeenCalledOnce();
    expect(JSON.parse(conn.write.mock.calls[0][0])).toMatchObject({
      id: Number.isSafeInteger(request.id) && request.id > 0 ? request.id : null,
      ok: false,
      error: expect.stringMatching(expected),
    });
  });

  it('strict-parses first and mints one collection deadline from one monotonic origin', async () => {
    const now = vi.fn(() => 1234);
    let execution;
    const conn = connection();
    T.createDaemonRequestConnection(conn, {
      handleRequest: vi.fn(async (_request, context) => {
        expect(now).toHaveBeenCalledOnce();
        execution = context;
        return { ok: true, result: 'unavailable seam' };
      }),
      now,
    });
    conn.emit('data', frame({
      id: 1,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    expect(now).toHaveBeenCalledTimes(3);
    expect(execution.deadline.now).toBe(now);
    expect(execution.deadline).toMatchObject({
      startedAt: 1234,
      pageAt: 296234,
      serverAt: 301234,
    });
  });

  it('aborts every live request synchronously on shutdown and disposes each exactly once', async () => {
    const observedSignals = [];
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: (_request, execution) => {
        observedSignals.push(execution.signal);
        return new Promise((resolve, reject) => {
          execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true });
        });
      },
      cleanup,
      onDispose: dispose,
      now: () => 0,
    });
    for (const id of [1, 2]) {
      conn.emit('data', frame({
        id,
        cmd: 'table',
        args: ['--collect', '--scroll-container', '.viewport'],
      }));
    }
    await drain();

    const reason = new Error('daemon signal shutdown');
    lifecycle.abortAll(reason);
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every(signal => signal.aborted)).toBe(true);
    expect(lifecycle.activeRequestCount()).toBe(0);
    await drain();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(conn.write).not.toHaveBeenCalled();
  });

  it('fails malformed table argv before capability dispatch and responds without reserving an ID', async () => {
    const handleRequest = vi.fn();
    const cleanup = vi.fn();
    const conn = connection();
    const now = vi.fn(() => 0);
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest,
      cleanup,
      now,
    });
    conn.emit('data', frame({ id: 4, cmd: 'table', args: ['--collect'] }));
    await drain();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
    expect(JSON.parse(conn.write.mock.calls[0][0])).toEqual({
      id: 4,
      ok: false,
      error: 'table: --collect requires --scroll-container',
    });
  });

  it('keeps the production collect placeholder fail-closed before page capability effects', async () => {
    const pageEffect = vi.fn();
    const conn = connection();
    T.createDaemonRequestConnection(conn, {
      handleRequest: async (request, execution) => {
        T.enforceDaemonTableCollectionGate(request, execution);
        pageEffect();
        return { ok: true, result: 'unexpected' };
      },
      now: () => 0,
    });
    conn.emit('data', frame({
      id: 6,
      cmd: 'table',
      args: ['#orders', '--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    expect(pageEffect).not.toHaveBeenCalled();
    expect(conn.write).toHaveBeenCalledOnce();
    expect(JSON.parse(conn.write.mock.calls[0][0])).toEqual({
      id: 6,
      ok: false,
      error: 'table: collection is unavailable in this v2.16 candidate',
    });
  });

  it('guards response serialization failure and disposes the request once without writing', async () => {
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async () => {
        const response = { ok: true, result: 'bad' };
        response.self = response;
        return response;
      },
      cleanup,
      onDispose: dispose,
      now: () => 0,
    });
    conn.emit('data', frame({ id: 9, cmd: 'status', args: [] }));
    await drain();

    expect(conn.write).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('cleans an unpublished request before enqueueing a handled failure response', async () => {
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const conn = connection({ holdWrite: true });
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async () => ({ ok: false, error: 'collector failed' }),
      cleanup,
      onDispose: dispose,
      now: () => 0,
    });
    conn.emit('data', frame({
      id: 10,
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
    }));
    await drain();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(conn.write).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(1);
    expect(dispose).not.toHaveBeenCalled();

    conn.writeCallbacks[0]();
    await drain();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('wires synchronous cleanup defaults at the production daemon source boundary', () => {
    expect(cdpSource).toContain('  cleanup = () => {},');
    expect(cdpSource).toContain('      cleanup: () => {},');
    expect(cdpSource).not.toContain('      cleanup: async () => {},');
  });
});
