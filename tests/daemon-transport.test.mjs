import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import {
  connectToDaemon,
  daemonEndpointForPlatform,
  ipcTimeoutForRequest,
  requestDaemon,
} from '../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs';

function connection({ onWrite } = {}) {
  const conn = new EventEmitter();
  conn.write = vi.fn(payload => onWrite?.(conn, payload));
  conn.end = vi.fn();
  conn.destroy = vi.fn();
  return conn;
}

describe('daemon endpoint and connection transport', () => {
  it('constructs exact Unix socket and Windows named-pipe endpoints', () => {
    expect(daemonEndpointForPlatform('TARGET', { platform: 'linux', runtimeDir: '/run/cdp' }))
      .toBe('/run/cdp/cdp-TARGET.sock');
    expect(daemonEndpointForPlatform('TARGET', { platform: 'darwin', runtimeDir: '/run/cdp' }))
      .toBe('/run/cdp/cdp-TARGET.sock');
    expect(daemonEndpointForPlatform('TARGET', { platform: 'win32', runtimeDir: 'ignored' }))
      .toBe('\\\\.\\pipe\\cdp-TARGET');
  });

  it('returns the connected socket and preserves the exact refusal error', async () => {
    const accepted = connection();
    const connect = vi.fn(() => accepted);
    const promise = connectToDaemon('/run/cdp.sock', { connect, timeoutMs: 100 });
    accepted.emit('connect');
    await expect(promise).resolves.toBe(accepted);
    expect(connect).toHaveBeenCalledWith('/run/cdp.sock');

    const refused = connection();
    const original = new Error('connect ECONNREFUSED /run/cdp.sock');
    const rejected = connectToDaemon('/run/cdp.sock', { connect: () => refused, timeoutMs: 100 });
    refused.emit('error', original);
    await expect(rejected).rejects.toBe(original);
  });

  it('destroys the socket and preserves the exact bounded connection timeout', async () => {
    vi.useFakeTimers();
    try {
      const conn = connection();
      const promise = connectToDaemon('/run/cdp.sock', { connect: () => conn, timeoutMs: 25 });
      const rejection = expect(promise).rejects.toThrow('Timed out connecting to daemon socket: /run/cdp.sock');
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(conn.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('daemon NDJSON request transport', () => {
  it('preserves request bytes, partial framing, first response, and request mutation', async () => {
    const conn = connection({
      onWrite(socket) {
        queueMicrotask(() => {
          socket.emit('data', '{"ok":true,"id":');
          socket.emit('data', '1,"result":"first"}\n{"ok":true,"id":1,"result":"duplicate"}\n');
        });
      },
    });
    const request = { cmd: 'report', args: ['--format', 'json'] };
    await expect(requestDaemon(conn, request, { runtimeDir: '/run/cdp' }))
      .resolves.toEqual({ ok: true, id: 1, result: 'first' });
    expect(request).toEqual({ cmd: 'report', args: ['--format', 'json'], id: 1 });
    expect(conn.write).toHaveBeenCalledWith('{"cmd":"report","args":["--format","json"],"id":1}\n');
    expect(conn.end).toHaveBeenCalledOnce();
  });

  it('accumulates highly fragmented frames with one final buffer copy', async () => {
    const frame = Buffer.from(`${JSON.stringify({ ok: true, id: 1, result: 'x'.repeat(2048) })}\n`);
    const conn = connection({
      onWrite(socket) {
        queueMicrotask(() => {
          for (let offset = 0; offset < frame.length; offset += 17) {
            socket.emit('data', frame.subarray(offset, offset + 17));
          }
        });
      },
    });
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      await expect(requestDaemon(conn, { cmd: 'report', args: [] }))
        .resolves.toMatchObject({ result: 'x'.repeat(2048) });
      expect(concat).toHaveBeenCalledOnce();
    } finally {
      concat.mockRestore();
    }
  });

  it('accepts the legacy missing response id but rejects an explicit mismatch', async () => {
    const legacy = connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', '{"ok":true,"result":"legacy"}\n')) });
    await expect(requestDaemon(legacy, { cmd: 'summary', args: [] }))
      .resolves.toEqual({ ok: true, result: 'legacy' });

    const mismatch = connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', '{"ok":true,"id":7,"result":"wrong"}\n')) });
    await expect(requestDaemon(mismatch, { cmd: 'summary', args: [] }))
      .rejects.toThrow('Daemon response id 7 did not match request id 1');
    expect(mismatch.end).toHaveBeenCalledOnce();

    const explicitNull = connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', '{"ok":true,"id":null}\n')) });
    await expect(requestDaemon(explicitNull, { cmd: 'summary', args: [] }))
      .rejects.toThrow('Daemon response id null did not match request id 1');

    const mutableRequest = { cmd: 'summary', args: [] };
    const mutated = connection({
      onWrite: socket => queueMicrotask(() => {
        mutableRequest.id = 7;
        socket.emit('data', '{"ok":true,"id":7}\n');
      }),
    });
    await expect(requestDaemon(mutated, mutableRequest))
      .rejects.toThrow('Daemon response id 7 did not match request id 1');
  });

  it.each([
    ['missing ok', '{"id":1}\n'],
    ['non-boolean ok', '{"id":1,"ok":"yes","result":"clicked"}\n'],
    ['success without result', '{"id":1,"ok":true}\n'],
    ['null success result', '{"id":1,"ok":true,"result":null}\n'],
    ['numeric success result', '{"id":1,"ok":true,"result":0}\n'],
    ['object success result', '{"id":1,"ok":true,"result":{}}\n'],
    ['resultless stop marker on click', '{"id":1,"ok":true,"stopAfter":true}\n'],
    ['failure without error', '{"id":1,"ok":false}\n'],
    ['scalar', '42\n'],
  ])('rejects a mutation response with an invalid terminal schema: %s', async (_label, frame) => {
    const conn = connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', frame)) });

    const error = await requestDaemon(
      conn,
      { cmd: 'click', args: ['#purchase'] },
      { mayHaveSideEffects: true },
    ).catch(cause => cause);

    expect(error).toMatchObject({
      name: 'DaemonTransportError',
      code: 'DAEMON_COMPLETION_UNKNOWN',
      completion: 'unknown',
      sideEffectMayHaveOccurred: true,
      retrySafe: false,
      transportCause: {
        phase: 'awaiting-response',
        kind: 'invalid-response',
        message: expect.stringMatching(/invalid daemon response/i),
      },
    });
  });

  it('decodes split valid UTF-8 and rejects malformed UTF-8 bytes', async () => {
    const encoded = Buffer.from('{"ok":true,"id":1,"result":"✓"}\n');
    const checkmark = Buffer.from('✓');
    const splitAt = encoded.indexOf(checkmark) + 1;
    const valid = connection({
      onWrite: socket => queueMicrotask(() => {
        socket.emit('data', encoded.subarray(0, splitAt));
        socket.emit('data', encoded.subarray(splitAt));
      }),
    });
    await expect(requestDaemon(valid, { cmd: 'summary', args: [] }))
      .resolves.toMatchObject({ result: '✓' });

    const malformedFrame = Buffer.concat([
      Buffer.from('{"ok":true,"id":1,"result":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]);
    const malformed = connection({
      onWrite: socket => queueMicrotask(() => socket.emit('data', malformedFrame)),
    });
    await expect(requestDaemon(malformed, { cmd: 'summary', args: [] }))
      .rejects.toBeInstanceOf(TypeError);
  });

  it('rejects invalid JSON and oversized responses without waiting for peer close', async () => {
    const invalid = connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', '{bad json}\n')) });
    await expect(requestDaemon(invalid, { cmd: 'status', args: [] })).rejects.toBeInstanceOf(SyntaxError);
    expect(invalid.end).toHaveBeenCalledOnce();

    const oversized = connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', 'x'.repeat(65))) });
    await expect(requestDaemon(oversized, { cmd: 'status', args: [] }, { maxResponseBytes: 64 }))
      .rejects.toThrow('Daemon response exceeded 64 bytes');
    expect(oversized.destroy).toHaveBeenCalledOnce();

    const firstBeforeHugeDuplicate = connection({
      onWrite: socket => queueMicrotask(() => socket.emit(
        'data',
        `{"ok":true,"id":1,"result":"first"}\n${'x'.repeat(256)}`,
      )),
    });
    await expect(requestDaemon(
      firstBeforeHugeDuplicate,
      { cmd: 'status', args: [] },
      { maxResponseBytes: 64 },
    )).resolves.toMatchObject({ ok: true, result: 'first' });
  });

  it('rejects an exact synchronous write error and removes every listener/timer', async () => {
    const original = new Error('write failed');
    const conn = connection();
    conn.write.mockImplementation(() => { throw original; });
    await expect(requestDaemon(conn, { cmd: 'status', args: [] })).rejects.toBe(original);
    for (const event of ['data', 'error', 'end', 'close']) expect(conn.listenerCount(event)).toBe(0);
  });

  it.each(['end', 'close'])('preserves the exact peer-%s diagnostic', async event => {
    const conn = connection({ onWrite: socket => queueMicrotask(() => socket.emit(event)) });
    await expect(requestDaemon(conn, { cmd: 'perceive', args: [] }, { runtimeDir: '/fixture/runtime' }))
      .rejects.toThrow('Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check /fixture/runtime for stale sockets if this repeats.');
  });

  it.each(['end', 'close'])('marks a committed mutation as ambiguous when the peer emits %s before its receipt', async event => {
    let committed = 0;
    const conn = connection({
      onWrite(socket, payload) {
        expect(JSON.parse(payload)).toEqual({
          cmd: 'click',
          args: ['#purchase'],
          id: 1,
        });
        committed += 1;
        queueMicrotask(() => socket.emit(event));
      },
    });

    const error = await requestDaemon(
      conn,
      { cmd: 'click', args: ['#purchase'] },
      { runtimeDir: '/fixture/runtime', mayHaveSideEffects: true },
    ).catch(cause => cause);

    expect(committed).toBe(1);
    expect(conn.write).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      name: 'DaemonTransportError',
      code: 'DAEMON_COMPLETION_UNKNOWN',
      completion: 'unknown',
      sideEffectMayHaveOccurred: true,
      transportCause: {
        phase: 'awaiting-response',
        kind: `peer-${event}`,
        message: expect.stringContaining('Connection closed before response.'),
      },
    });
    expect(error.transportCause.message.length).toBeLessThanOrEqual(512);
  });

  it('conservatively marks a synchronous mutation write failure as ambiguous after send is attempted', async () => {
    const original = new Error('write EPIPE before bytes were accepted');
    original.code = 'EPIPE';
    const conn = connection();
    conn.write.mockImplementation(() => { throw original; });

    const error = await requestDaemon(
      conn,
      { cmd: 'click', args: ['#purchase'] },
      { mayHaveSideEffects: true },
    ).catch(cause => cause);

    expect(error).toMatchObject({
      name: 'DaemonTransportError',
      code: 'DAEMON_COMPLETION_UNKNOWN',
      completion: 'unknown',
      sideEffectMayHaveOccurred: true,
      retrySafe: false,
      transportCause: {
        phase: 'sending-request',
        kind: 'write-error',
        code: 'EPIPE',
        message: 'write EPIPE before bytes were accepted',
      },
    });
    expect(conn.write).toHaveBeenCalledOnce();
  });

  it('keeps serialization failure proven pre-dispatch and never writes', async () => {
    const request = { cmd: 'click', args: ['#purchase'] };
    request.self = request;
    const conn = connection();

    const error = await requestDaemon(conn, request, { mayHaveSideEffects: true }).catch(cause => cause);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toHaveProperty('completion');
    expect(error).not.toHaveProperty('sideEffectMayHaveOccurred');
    expect(conn.write).not.toHaveBeenCalled();
  });

  it.each([
    ['socket error', connection({ onWrite: socket => queueMicrotask(() => {
      const error = new Error('read ECONNRESET after request');
      error.code = 'ECONNRESET';
      socket.emit('error', error);
    }) }), 'peer-error', 'ECONNRESET'],
    ['malformed response', connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', '{bad json}\n')) }), 'invalid-response', undefined],
    ['oversized response', connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', 'x'.repeat(65))) }), 'response-too-large', undefined],
  ])('marks a mutation %s as unknown without a validated receipt', async (_label, conn, kind, code) => {
    const error = await requestDaemon(
      conn,
      { cmd: 'click', args: ['#purchase'] },
      { mayHaveSideEffects: true, maxResponseBytes: 64 },
    ).catch(cause => cause);

    expect(error).toMatchObject({
      name: 'DaemonTransportError',
      code: 'DAEMON_COMPLETION_UNKNOWN',
      completion: 'unknown',
      sideEffectMayHaveOccurred: true,
      retrySafe: false,
      transportCause: {
        phase: 'awaiting-response',
        kind,
        ...(code ? { code } : {}),
        message: expect.any(String),
      },
    });
    expect(error.transportCause.message.length).toBeLessThanOrEqual(512);
    expect(conn.write).toHaveBeenCalledOnce();
  });

  it('marks a mutation timeout as unknown after one send attempt', async () => {
    vi.useFakeTimers();
    try {
      const conn = connection();
      const promise = requestDaemon(
        conn,
        { cmd: 'click', args: ['#purchase'] },
        { mayHaveSideEffects: true, timeoutMs: 25 },
      );
      const rejection = promise.catch(cause => cause);
      await vi.advanceTimersByTimeAsync(25);
      const error = await rejection;
      expect(error).toMatchObject({
        name: 'DaemonTransportError',
        code: 'DAEMON_COMPLETION_UNKNOWN',
        completion: 'unknown',
        sideEffectMayHaveOccurred: true,
        retrySafe: false,
        transportCause: {
          phase: 'awaiting-response',
          kind: 'timeout',
          message: 'IPC timeout: command "click" took longer than 0.025s',
        },
      });
      expect(conn.write).toHaveBeenCalledOnce();
      expect(conn.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the exact connection error object and stop-after response completion', async () => {
    const original = new Error('socket reset');
    const failed = connection({ onWrite: socket => queueMicrotask(() => socket.emit('error', original)) });
    await expect(requestDaemon(failed, { cmd: 'report', args: [] })).rejects.toBe(original);

    const stopped = connection({ onWrite: socket => queueMicrotask(() => socket.emit('data', '{"ok":true,"id":1,"stopAfter":true}\n')) });
    await expect(requestDaemon(stopped, { cmd: 'stop', args: [] }))
      .resolves.toEqual({ ok: true, id: 1, stopAfter: true });
    expect(stopped.end).toHaveBeenCalledOnce();
  });

  it('preserves command and wait timeout rules plus exact timeout cleanup', async () => {
    expect(ipcTimeoutForRequest({ cmd: 'status', args: [] })).toBe(120000);
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['180000'] })).toBe(185000);
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['30'] })).toBe(120000);
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['bad'] })).toBe(120000);
    expect(ipcTimeoutForRequest({ cmd: 'status', args: [], timeoutMs: 1 })).toBe(100);
    expect(ipcTimeoutForRequest({ cmd: 'status', args: [], timeoutMs: 999999 })).toBe(120000);

    vi.useFakeTimers();
    try {
      const conn = connection();
      const promise = requestDaemon(conn, { cmd: 'status', args: [] }, { timeoutMs: 25 });
      const rejection = expect(promise).rejects.toThrow('IPC timeout: command "status" took longer than 0.025s');
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(conn.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects the bounded collection IPC deadline only after strict table parsing', () => {
    expect(ipcTimeoutForRequest({
      cmd: 'table',
      args: ['#orders', '--format', 'json', '--scroll-container', '.viewport', '--collect'],
    })).toBe(315000);
    expect(ipcTimeoutForRequest({ cmd: 'table', args: ['#orders'] })).toBe(120000);
    expect(ipcTimeoutForRequest({
      cmd: 'table',
      args: ['--continue', 'ct1.0123456789abcdef0123456789abcdef.0', '--format', 'json'],
    })).toBe(120000);
    expect(ipcTimeoutForRequest({
      cmd: 'table',
      args: ['#orders', '--scroll-container', '.viewport', '--collect'],
      timeoutMs: 999999,
    })).toBe(315000);
    expect(ipcTimeoutForRequest({ cmd: 'status', args: [], timeoutMs: 999999 })).toBe(120000);
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['180000'] })).toBe(185000);
    expect(() => ipcTimeoutForRequest({ cmd: 'table', args: ['--collect'] }))
      .toThrow('table: --collect requires --scroll-container');
  });

  it('rejects malformed collection argv before request mutation, listeners, timers, or IPC', () => {
    const conn = connection();
    const request = { cmd: 'table', args: ['--collect'] };

    expect(() => requestDaemon(conn, request))
      .toThrow('table: --collect requires --scroll-container');

    expect(request).toEqual({ cmd: 'table', args: ['--collect'] });
    expect(conn.write).not.toHaveBeenCalled();
    for (const event of ['data', 'error', 'end', 'close']) expect(conn.listenerCount(event)).toBe(0);
  });

  it('caps explicit internal timeout overrides while preserving shorter test deadlines', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const capped = connection();
      const cappedPromise = requestDaemon(capped, {
        cmd: 'table',
        args: ['--collect', '--scroll-container', '.viewport'],
      }, {
        mayHaveSideEffects: true,
        timeoutMs: 999999,
      }).catch(error => error);

      expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), 315000);
      capped.emit('close');
      await expect(cappedPromise).resolves.toMatchObject({
        code: 'DAEMON_COMPLETION_UNKNOWN',
        completion: 'unknown',
        retrySafe: false,
      });
    } finally {
      timerSpy.mockRestore();
    }

    vi.useFakeTimers();
    try {
      const shortened = connection();
      const shortenedPromise = requestDaemon(shortened, {
        cmd: 'table',
        args: ['--collect', '--scroll-container', '.viewport'],
      }, {
        mayHaveSideEffects: true,
        timeoutMs: 25,
      }).catch(error => error);
      await vi.advanceTimersByTimeAsync(25);
      await expect(shortenedPromise).resolves.toMatchObject({
        code: 'DAEMON_COMPLETION_UNKNOWN',
        completion: 'unknown',
        retrySafe: false,
        transportCause: {
          kind: 'timeout',
          message: 'IPC timeout: command "table" took longer than 0.025s',
        },
      });
      expect(shortened.write).toHaveBeenCalledOnce();
      expect(shortened.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
