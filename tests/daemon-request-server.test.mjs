import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

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

  it('fails truthfully at the shared 300s server deadline and retains ownership until flush', async () => {
    let serverTimer;
    let signal;
    const setTimer = vi.fn((callback, _delay) => {
      serverTimer = callback;
      return Symbol('server-timer');
    });
    const clearTimer = vi.fn();
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const conn = connection({ holdWrite: true });
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: (_request, execution) => {
        signal = execution.signal;
        return new Promise(() => {});
      },
      cleanup,
      onDispose: dispose,
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
      code: 'TABLE_COLLECTION_SERVER_DEADLINE',
      phase: 'server',
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(conn.write).toHaveBeenCalledOnce();
    expect(JSON.parse(conn.write.mock.calls[0][0])).toMatchObject({
      id: 1,
      ok: false,
      error: expect.stringMatching(/server deadline/),
    });
    expect(lifecycle.activeRequestCount()).toBe(1);
    expect(dispose).not.toHaveBeenCalled();

    conn.writeCallbacks[0]();
    await drain();
    expect(lifecycle.activeRequestCount()).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(clearTimer).toHaveBeenCalled();
  });

  it('refuses a collect success returned at the absolute server deadline before enqueue', async () => {
    let now = 0;
    let signal;
    const cleanup = vi.fn();
    const dispose = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: async (_request, execution) => {
        signal = execution.signal;
        now = execution.deadline.serverAt;
        return { ok: true, result: 'late-handler-success' };
      },
      cleanup,
      onDispose: dispose,
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
      code: 'TABLE_COLLECTION_SERVER_DEADLINE',
      phase: 'server',
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(conn.write).toHaveBeenCalledOnce();
    expect(JSON.parse(conn.write.mock.calls[0][0])).toMatchObject({
      id: 2,
      ok: false,
      error: expect.stringMatching(/server deadline/),
    });
    expect(conn.write.mock.calls[0][0]).not.toContain('late-handler-success');
    expect(dispose).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('aborts and suppresses a duplicate active ID on one socket while accepting id=1 on another socket', async () => {
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
      cmd: 'table',
      args: ['--collect', '--scroll-container', '.viewport'],
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

    expect(now).toHaveBeenCalledOnce();
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
});
