import { describe, expect, it } from 'vitest';

import { attachToTarget, connect, createTransport, resolveWsUrl } from '../skills/chrome-cdp-ex/scripts/lib/ws-transport.mjs';

class FakeWs {
  constructor() { this.sent = []; this.handlers = { message: [], close: [] }; }
  addEventListener(type, fn) { this.handlers[type]?.push(fn); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.emit('close', {}); }
  emit(type, event) { for (const fn of this.handlers[type] || []) fn(event); }
  reply(id, result) { this.emit('message', { data: JSON.stringify({ id, result }) }); }
  fail(id, message) { this.emit('message', { data: JSON.stringify({ id, error: { code: -32000, message } }) }); }
  event(method, params, sessionId) { this.emit('message', { data: JSON.stringify({ method, params, sessionId }) }); }
}

describe('createTransport', () => {
  it('routes replies to the matching request by id', async () => {
    const ws = new FakeWs();
    const t = createTransport(ws);
    const a = t.send('Runtime.evaluate', { expression: '1' }, 'S1');
    const b = t.send('Page.enable');
    expect(ws.sent.map((m) => m.method)).toEqual(['Runtime.evaluate', 'Page.enable']);
    expect(ws.sent[0].sessionId).toBe('S1');
    ws.reply(ws.sent[1].id, { ok: 'b' });
    ws.reply(ws.sent[0].id, { ok: 'a' });
    expect(await a).toEqual({ ok: 'a' });
    expect(await b).toEqual({ ok: 'b' });
  });

  it('rejects with the protocol error message', async () => {
    const ws = new FakeWs();
    const t = createTransport(ws);
    const p = t.send('Bad.method');
    ws.fail(ws.sent[0].id, 'no such method');
    await expect(p).rejects.toThrow(/no such method/);
  });

  it('delivers events to subscribers and stops after unsubscribe', () => {
    const ws = new FakeWs();
    const t = createTransport(ws);
    const seen = [];
    const off = t.on('Network.responseReceived', (params, sessionId) => seen.push([params.id, sessionId]));
    ws.event('Network.responseReceived', { id: 1 }, 'S1');
    off();
    ws.event('Network.responseReceived', { id: 2 }, 'S1');
    expect(seen).toEqual([[1, 'S1']]);
  });

  it('rejects every pending request when the socket closes (no hanging waits)', async () => {
    const ws = new FakeWs();
    const t = createTransport(ws);
    const p = t.send('Runtime.evaluate', {});
    ws.close();
    await expect(p).rejects.toThrow(/connection closed/);
    await expect(t.send('Page.enable')).rejects.toThrow(/connection closed/);
  });

  it('times out a request that never gets a reply', async () => {
    const ws = new FakeWs();
    const t = createTransport(ws);
    await expect(t.send('Runtime.evaluate', {}, undefined, 20)).rejects.toThrow(/timed out after 20 ms/);
  });
});

describe('attachToTarget', () => {
  function fakeTransport(targetInfos) {
    const calls = [];
    return {
      calls,
      send: async (method, params) => {
        calls.push([method, params]);
        if (method === 'Target.getTargets') return { targetInfos };
        if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' };
        throw new Error(`unexpected ${method}`);
      },
    };
  }
  const pages = [
    { targetId: 'AAAA1111', type: 'page', url: 'https://a.example' },
    { targetId: 'AAAA2222', type: 'page', url: 'https://b.example' },
    { targetId: 'BBBB3333', type: 'page', url: 'https://c.example' },
    { targetId: 'CCCC4444', type: 'service_worker', url: 'https://d.example' },
  ];

  it('attaches with flatten when exactly one page matches (case-insensitive)', async () => {
    const t = fakeTransport(pages);
    expect(await attachToTarget(t, 'bbbb')).toEqual({ sessionId: 'SESSION-1', targetId: 'BBBB3333' });
    expect(t.calls[1]).toEqual(['Target.attachToTarget', { targetId: 'BBBB3333', flatten: true }]);
  });

  it('refuses an ambiguous prefix and lists the candidates', async () => {
    await expect(attachToTarget(fakeTransport(pages), 'AAAA')).rejects.toThrow(/matches 2 pages.*AAAA1111.*AAAA2222/s);
  });

  it('refuses when nothing matches', async () => {
    await expect(attachToTarget(fakeTransport(pages), 'ZZZZ')).rejects.toThrow(/no page matches/);
  });

  it('ignores non-page targets', async () => {
    await expect(attachToTarget(fakeTransport(pages), 'CCCC')).rejects.toThrow(/no page matches/);
  });
});

describe('resolveWsUrl', () => {
  it('uses /json/version when the HTTP endpoint answers', async () => {
    const fetchImpl = async (url) => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:9224/devtools/browser/abc` }), url });
    expect(await resolveWsUrl({ host: '127.0.0.1', port: 9224, fetchImpl })).toBe('ws://127.0.0.1:9224/devtools/browser/abc');
  });

  it('falls back to DevToolsActivePort (toggle mode: /json/version is 404)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const readFile = (path) => {
      expect(path).toBe('C:/x/DevToolsActivePort');
      return '9222\n/devtools/browser/guid-1\n';
    };
    expect(await resolveWsUrl({ host: '127.0.0.1', port: 9222, fetchImpl, readFile, env: { CDP_PORT_FILE: 'C:/x/DevToolsActivePort' } }))
      .toBe('ws://127.0.0.1:9222/devtools/browser/guid-1');
  });

  it('fails with a clear message when neither works', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const readFile = () => { throw new Error('ENOENT'); };
    await expect(resolveWsUrl({ host: '127.0.0.1', port: 9999, fetchImpl, readFile, env: {} })).rejects.toThrow(/cannot reach CDP on 127.0.0.1:9999/);
  });

  const refused = async () => { throw new Error('ECONNREFUSED'); };
  const mainBrowserFile = () => '9222\n/devtools/browser/main-guid\n';

  it('does not follow a default DevToolsActivePort that names a different port (would attach to the wrong browser)', async () => {
    await expect(resolveWsUrl({ host: '127.0.0.1', port: 9224, fetchImpl: refused, readFile: mainBrowserFile, env: {}, platform: 'win32' }))
      .rejects.toThrow(/cannot reach CDP on 127.0.0.1:9224/);
  });

  it('trusts a differing port when CDP_PORT_FILE was set explicitly', async () => {
    expect(await resolveWsUrl({ host: '127.0.0.1', port: 9224, fetchImpl: refused, readFile: mainBrowserFile, env: { CDP_PORT_FILE: 'C:/x/DevToolsActivePort' } }))
      .toBe('ws://127.0.0.1:9222/devtools/browser/main-guid');
  });

  it('uses the default file when its port equals the requested port', async () => {
    expect(await resolveWsUrl({ host: '127.0.0.1', port: 9222, fetchImpl: refused, readFile: mainBrowserFile, env: {}, platform: 'win32' }))
      .toBe('ws://127.0.0.1:9222/devtools/browser/main-guid');
  });

  it('gives up on a /json/version that never answers and falls through to the file logic', async () => {
    const hangs = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    expect(await resolveWsUrl({ host: '127.0.0.1', port: 9222, fetchImpl: hangs, readFile: mainBrowserFile, env: {}, platform: 'win32', timeoutMs: 20 }))
      .toBe('ws://127.0.0.1:9222/devtools/browser/main-guid');
    await expect(resolveWsUrl({ host: '127.0.0.1', port: 9224, fetchImpl: hangs, readFile: mainBrowserFile, env: {}, platform: 'win32', timeoutMs: 20 }))
      .rejects.toThrow(/cannot reach CDP on 127.0.0.1:9224/);
  });
});

describe('connect', () => {
  class OpenableWs {
    constructor(url, { opens = true } = {}) {
      this.url = url;
      this.closed = false;
      this.handlers = { open: [], error: [], message: [], close: [] };
      if (opens) queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(type, fn) { this.handlers[type]?.push(fn); }
    emit(type, event) { for (const fn of this.handlers[type] || []) fn(event); }
    send(text) {
      const msg = JSON.parse(text);
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result: { targetInfos: [] } }) }));
    }
    close() { this.closed = true; this.emit('close', {}); }
  }
  const fetchImpl = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/x' }) });

  it('closes the socket when attaching fails (no leaked connection)', async () => {
    let ws;
    const WebSocketImpl = class extends OpenableWs { constructor(url) { super(url); ws = this; } };
    await expect(connect({ port: 9333, target: 'NOPE', WebSocketImpl, fetchImpl })).rejects.toThrow(/no page matches/);
    expect(ws.closed).toBe(true);
  });

  it('rejects and closes when the socket never opens', async () => {
    let ws;
    const WebSocketImpl = class extends OpenableWs { constructor(url) { super(url, { opens: false }); ws = this; } };
    await expect(connect({ port: 9333, target: 'X', WebSocketImpl, fetchImpl, openTimeoutMs: 20 })).rejects.toThrow(/timed out after 20 ms/);
    expect(ws.closed).toBe(true);
  });
});
