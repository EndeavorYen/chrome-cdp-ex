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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('daemon request server lifecycle', () => {
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

  it('rejects one duplicate active ID without aborting its owner and accepts id=1 on another connection', async () => {
    let resolveFirst;
    const firstHandle = vi.fn((_request, execution) => new Promise((resolve, reject) => {
      resolveFirst = resolve;
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
    connA.emit('data', frame(request));
    connB.emit('data', frame(request));
    await drain();

    expect(firstHandle).toHaveBeenCalledOnce();
    expect(handleB).toHaveBeenCalledOnce();
    expect(lifecycleA.activeRequestCount()).toBe(1);
    expect(connA.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connA.write.mock.calls[0][0])).toEqual({
      id: 1,
      ok: false,
      error: 'Duplicate active request id: 1',
    });
    expect(JSON.parse(connB.write.mock.calls[0][0])).toEqual({
      id: 1,
      ok: true,
      result: 'other client',
    });

    resolveFirst({ ok: true, result: 'owner complete' });
    await drain();
    expect(lifecycleA.activeRequestCount()).toBe(0);
    expect(lifecycleB.activeRequestCount()).toBe(0);
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
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest,
      cleanup,
      now: () => 0,
    });
    conn.emit('data', frame({ id: 4, cmd: 'table', args: ['--collect'] }));
    await drain();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
    expect(JSON.parse(conn.write.mock.calls[0][0])).toEqual({
      id: 4,
      ok: false,
      error: 'table: --collect requires --scroll-container',
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
});
