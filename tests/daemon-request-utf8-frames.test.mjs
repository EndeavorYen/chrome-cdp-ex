import { EventEmitter } from 'events';
import net from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  connectToDaemon,
  daemonEndpointForPlatform,
  requestDaemon,
} from '../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function connection() {
  const conn = new EventEmitter();
  conn.destroyed = false;
  conn.writable = true;
  conn.write = vi.fn((payload, callback) => {
    if (typeof callback === 'function') queueMicrotask(callback);
    return true;
  });
  conn.end = vi.fn((payload, callback) => {
    if (payload !== undefined) conn.write(payload, callback);
    else callback?.();
    conn.writable = false;
  });
  conn.destroy = vi.fn(() => {
    conn.destroyed = true;
    conn.writable = false;
  });
  return conn;
}

async function drain() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function frameBytes(request) {
  return Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
}

function written(conn) {
  return conn.write.mock.calls.map(([payload]) => JSON.parse(payload));
}

function listen(conn, handleRequest = async request => ({ ok: true, result: request.args.join('|') }), options = {}) {
  return T.createDaemonRequestConnection(conn, { handleRequest, cleanup: vi.fn(), now: () => 0, ...options });
}

// é is 2 bytes, 日 is 3 bytes, 😀 is 4 bytes in UTF-8.
const MULTIBYTE = ['é', '日', '😀'];

describe('#457 daemon request reader decodes whole frames, not chunks', () => {
  it.each(MULTIBYTE)('keeps %s intact when a split lands at every byte offset of the frame', async char => {
    const request = { id: 1, cmd: 'fill', args: ['#q', `${char}a${char}${char}`] };
    const bytes = frameBytes(request);
    for (let split = 1; split < bytes.length; split += 1) {
      const conn = connection();
      const handleRequest = vi.fn(async () => ({ ok: true, result: 'ok' }));
      listen(conn, handleRequest);
      conn.emit('data', bytes.subarray(0, split));
      conn.emit('data', bytes.subarray(split));
      await drain();
      expect(handleRequest, `split at ${split}`).toHaveBeenCalledOnce();
      expect(handleRequest.mock.calls[0][0].args).toEqual(request.args);
    }
  });

  it('keeps 2-, 3- and 4-byte characters intact when every byte arrives in its own chunk', async () => {
    const request = { id: 3, cmd: 'type', args: ['é日😀 mixed 日本語テキスト 😀é'] };
    const conn = connection();
    const handleRequest = vi.fn(async () => ({ ok: true, result: 'ok' }));
    listen(conn, handleRequest);
    const bytes = frameBytes(request);
    for (let index = 0; index < bytes.length; index += 1) conn.emit('data', bytes.subarray(index, index + 1));
    await drain();
    expect(handleRequest).toHaveBeenCalledOnce();
    expect(Buffer.from(handleRequest.mock.calls[0][0].args[0], 'utf8').equals(Buffer.from(request.args[0], 'utf8'))).toBe(true);
  });

  it('splits a 4-byte character three ways and holds the frame until a lone newline chunk arrives', async () => {
    const request = { id: 4, cmd: 'type', args: ['😀'] };
    const bytes = frameBytes(request);
    const emoji = bytes.indexOf(Buffer.from('😀', 'utf8'));
    const conn = connection();
    const handleRequest = vi.fn(async () => ({ ok: true, result: 'ok' }));
    listen(conn, handleRequest);
    conn.emit('data', bytes.subarray(0, emoji + 1));
    conn.emit('data', bytes.subarray(emoji + 1, emoji + 3));
    conn.emit('data', bytes.subarray(emoji + 3, bytes.length - 1));
    await drain();
    expect(handleRequest).not.toHaveBeenCalled();
    conn.emit('data', bytes.subarray(bytes.length - 1));
    await drain();
    expect(handleRequest).toHaveBeenCalledOnce();
    expect(handleRequest.mock.calls[0][0].args).toEqual(['😀']);
  });

  it('dispatches several frames from one chunk and carries a split character into the next frame', async () => {
    const first = { id: 1, cmd: 'type', args: ['日本'] };
    const second = { id: 2, cmd: 'type', args: ['😀é'] };
    const third = { id: 3, cmd: 'type', args: ['語'] };
    const all = Buffer.concat([frameBytes(first), frameBytes(second), frameBytes(third)]);
    const cut = all.indexOf(Buffer.from('😀', 'utf8')) + 2;
    const conn = connection();
    const handleRequest = vi.fn(async request => ({ ok: true, result: request.args[0] }));
    const lifecycle = listen(conn, handleRequest);
    conn.emit('data', all.subarray(0, cut));
    await drain();
    expect(handleRequest.mock.calls.map(([request]) => request.args)).toEqual([['日本']]);
    conn.emit('data', all.subarray(cut));
    await drain();
    expect(handleRequest.mock.calls.map(([request]) => request.args)).toEqual([['日本'], ['😀é'], ['語']]);
    expect(written(conn).map(response => response.result)).toEqual(['日本', '😀é', '語']);
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('accepts string chunks as before', async () => {
    const conn = connection();
    const handleRequest = vi.fn(async () => ({ ok: true, result: 'ok' }));
    listen(conn, handleRequest);
    conn.emit('data', '{"id":1,"cmd":"type","args":["日');
    conn.emit('data', '"]}\n');
    await drain();
    expect(handleRequest.mock.calls[0][0].args).toEqual(['日']);
  });

  it('rejects a frame that is not valid UTF-8 instead of handing U+FFFD to the page', async () => {
    const conn = connection();
    const handleRequest = vi.fn(async () => ({ ok: true, result: 'ok' }));
    const lifecycle = listen(conn, handleRequest);
    const head = Buffer.from('{"id":5,"cmd":"type","args":["', 'utf8');
    const tail = Buffer.from('"]}\n', 'utf8');
    conn.emit('data', Buffer.concat([head, Buffer.from([0xe6, 0x97]), tail]));
    await drain();
    expect(handleRequest).not.toHaveBeenCalled();
    expect(written(conn)).toEqual([{ ok: false, error: expect.stringMatching(/not valid UTF-8/), id: null }]);
    // The connection stays usable for the next well-formed frame.
    conn.emit('data', frameBytes({ id: 6, cmd: 'type', args: ['日'] }));
    await drain();
    expect(handleRequest).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });
});

describe('#457 daemon request line size cap', () => {
  it('exposes a documented 16 MiB cap', () => {
    expect(T.MAX_DAEMON_REQUEST_LINE_BYTES).toBe(16 * 1024 * 1024);
  });

  it.each([
    ['without a newline', false],
    ['with the newline in the same chunk', true],
  ])('replies with a structured error and closes the connection for an over-cap line %s', async (_label, withNewline) => {
    const cap = T.MAX_DAEMON_REQUEST_LINE_BYTES;
    const conn = connection();
    const handleRequest = vi.fn(async () => ({ ok: true, result: 'ok' }));
    const onDisconnect = vi.fn();
    const onFatal = vi.fn();
    const lifecycle = listen(conn, handleRequest, { onDisconnect, onFatal });
    const piece = Buffer.alloc(4 * 1024 * 1024, 0x61);
    for (let sent = 0; sent < cap; sent += piece.length) conn.emit('data', piece);
    expect(conn.write).not.toHaveBeenCalled();
    conn.emit('data', withNewline ? Buffer.from('a\n') : Buffer.from('a'));
    await drain();

    expect(written(conn)).toEqual([{
      ok: false,
      error: `daemon request line exceeded ${cap} bytes; connection closed`,
      id: null,
    }]);
    expect(conn.end).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(onFatal).not.toHaveBeenCalled();
    expect(handleRequest).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
    for (const name of ['data', 'end', 'close']) expect(conn.listenerCount(name)).toBe(0);
    // A sink stays on 'error' so a late EPIPE/ECONNRESET from the closing socket is not unhandled.
    expect(conn.listenerCount('error')).toBe(1);
  });

  it.each([
    ['an over-cap line', conn => conn.emit('data', Buffer.alloc(T.MAX_DAEMON_REQUEST_LINE_BYTES + 1, 0x61))],
    ['a duplicate request id', conn => {
      conn.emit('data', Buffer.concat([
        frameBytes({ id: 1, cmd: 'status', args: [] }),
        frameBytes({ id: 1, cmd: 'status', args: [] }),
      ]));
    }],
  ])('swallows a socket error that arrives after %s closed the connection', async (_label, trigger) => {
    const conn = connection();
    const onFatal = vi.fn();
    const onDisconnect = vi.fn();
    listen(conn, () => new Promise(() => {}), { onFatal, onDisconnect });
    trigger(conn);
    await drain();
    expect(conn.end).toHaveBeenCalledOnce();
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => conn.emit('error', epipe)).not.toThrow();
    expect(onFatal).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('swallows a socket error that arrives after the peer ended the connection', async () => {
    const conn = connection();
    const onDisconnect = vi.fn();
    listen(conn, () => new Promise(() => {}), { onDisconnect });
    conn.emit('data', frameBytes({ id: 1, cmd: 'status', args: [] }));
    await drain();
    conn.emit('end');
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(() => conn.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('treats a request cleanup failure on an over-cap connection as fatal, like any other disconnect', async () => {
    const cleanupError = new Error('rollback failed');
    const conn = connection();
    const onFatal = vi.fn();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: () => new Promise(() => {}),
      cleanup: () => { throw cleanupError; },
      onFatal,
      now: () => 0,
    });
    conn.emit('data', frameBytes({ id: 1, cmd: 'status', args: [] }));
    await drain();
    conn.emit('data', Buffer.alloc(T.MAX_DAEMON_REQUEST_LINE_BYTES + 1, 0x61));
    await drain();
    expect(onFatal).toHaveBeenCalledExactlyOnceWith(cleanupError);
    expect(conn.destroy).toHaveBeenCalled();
    expect(conn.write).not.toHaveBeenCalled();
    expect(lifecycle.activeRequestCount()).toBe(0);
  });

  it('accepts a line of exactly the cap', async () => {
    const cap = T.MAX_DAEMON_REQUEST_LINE_BYTES;
    const prefix = '{"id":1,"cmd":"type","args":["';
    const suffix = '"]}';
    const filler = 'a'.repeat(cap - prefix.length - suffix.length);
    const conn = connection();
    const handleRequest = vi.fn(async () => ({ ok: true, result: 'ok' }));
    listen(conn, handleRequest);
    conn.emit('data', Buffer.from(`${prefix}${filler}${suffix}\n`, 'utf8'));
    await drain();
    expect(handleRequest).toHaveBeenCalledOnce();
    expect(handleRequest.mock.calls[0][0].args[0].length).toBe(filler.length);
  });

  it('aborts and cleans an in-flight request on the over-cap connection while another connection keeps working', async () => {
    const cap = T.MAX_DAEMON_REQUEST_LINE_BYTES;
    let inFlightSignal;
    const cleanup = vi.fn();
    const onDispose = vi.fn();
    const conn = connection();
    const lifecycle = T.createDaemonRequestConnection(conn, {
      handleRequest: (_request, execution) => new Promise((_resolve, reject) => {
        inFlightSignal = execution.signal;
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true });
      }),
      cleanup,
      onDispose,
      now: () => 0,
    });
    conn.emit('data', frameBytes({ id: 1, cmd: 'status', args: [] }));
    await drain();
    expect(lifecycle.activeRequestCount()).toBe(1);

    conn.emit('data', Buffer.alloc(cap + 1, 0x61));
    await drain();

    expect(inFlightSignal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
    expect(lifecycle.activeRequestCount()).toBe(0);
    expect(written(conn)).toEqual([{ ok: false, error: expect.stringMatching(/exceeded/), id: null }]);

    const other = connection();
    const otherHandle = vi.fn(async () => ({ ok: true, result: 'healthy' }));
    listen(other, otherHandle);
    other.emit('data', frameBytes({ id: 1, cmd: 'status', args: [] }));
    await drain();
    expect(written(other)).toEqual([{ ok: true, result: 'healthy', id: 1 }]);
  });
});

describe('#457 over a real socket', () => {
  it('delivers a 420 KB Japanese argument byte-identical to the handler', async () => {
    const endpoint = process.platform === 'win32'
      ? daemonEndpointForPlatform(`457-test-${process.pid}-${Date.now()}`, { platform: 'win32' })
      : join(mkdtempSync(join(tmpdir(), 'cdp-457-')), 'd.sock');
    const text = '日本語のテキスト😀é'.repeat(Math.ceil(420 * 1024 / 30));
    let received = null;
    const server = net.createServer(conn => {
      T.createDaemonRequestConnection(conn, {
        handleRequest: async request => {
          received = request.args[1];
          return { ok: true, result: 'filled' };
        },
        cleanup: () => {},
      });
    });
    await new Promise(resolveListen => server.listen(endpoint, resolveListen));
    try {
      const conn = await connectToDaemon(endpoint, { timeoutMs: 2000 });
      const response = await requestDaemon(conn, { cmd: 'fill', args: ['#q', text] });
      expect(response.ok).toBe(true);
      expect(received.includes('\uFFFD')).toBe(false);
      expect(received === text).toBe(true);
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThanOrEqual(420 * 1024);
    } finally {
      server.close();
    }
  });

  // On a Unix socket the whole line is still readable after the client closes, so the
  // daemon's end(reply) hits EPIPE; before the error sink this crashed the process.
  // A Windows named pipe does not surface that late EPIPE, so there it is a survival check.
  it('survives a client that destroys its socket right after writing an over-cap line', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true, result: 'healthy' }));
    const onFatal = vi.fn();
    const disconnects = [];
    const server = net.createServer(conn => {
      T.createDaemonRequestConnection(conn, {
        handleRequest,
        cleanup: () => {},
        onFatal,
        onDisconnect: error => disconnects.push(error.message),
      });
    });
    const endpoint = process.platform === 'win32'
      ? daemonEndpointForPlatform(`457-epipe-${process.pid}-${Date.now()}`, { platform: 'win32' })
      : join(mkdtempSync(join(tmpdir(), 'cdp-457-')), 'd.sock');
    await new Promise(resolveListen => server.listen(endpoint, resolveListen));
    const oversized = Buffer.alloc(T.MAX_DAEMON_REQUEST_LINE_BYTES + 1, 0x61);
    try {
      for (let round = 0; round < 4; round += 1) {
        const client = await connectToDaemon(endpoint, { timeoutMs: 2000 });
        client.on('error', () => {});
        const closed = new Promise(resolveClose => client.once('close', resolveClose));
        client.write(oversized, () => client.destroy());
        await closed;
      }
      // Give the daemon side time to hit EPIPE/ECONNRESET on its reply write.
      await new Promise(resolveTick => setTimeout(resolveTick, 200));
      const conn = await connectToDaemon(endpoint, { timeoutMs: 2000 });
      const response = await requestDaemon(conn, { cmd: 'status', args: [] });
      expect(response).toMatchObject({ ok: true, result: 'healthy' });
      expect(handleRequest).toHaveBeenCalledOnce();
      expect(onFatal).not.toHaveBeenCalled();
      expect(disconnects.filter(message => /exceeded/.test(message)).length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
