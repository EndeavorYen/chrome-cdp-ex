import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PAGES_9345 = [{ targetId: 'AAAA9345PAGE', type: 'page', url: 'about:blank' }];
const PAGES_9224 = [{ targetId: 'BBBB9224PAGE', type: 'page', url: 'about:blank' }];

// A fake daemon that applies the real protocol validator, like the daemon's dispatch does.
function fakeDaemons(byPath) {
  const sent = [];
  const request = vi.fn(async (conn, req) => {
    sent.push({ path: conn.path, cmd: req.cmd, args: req.args });
    try {
      T.validateDaemonProtocolRequest({ id: 1, ...req });
    } catch (error) {
      return { ok: false, error: error.message, id: 1 };
    }
    const daemon = byPath[conn.path];
    if (req.cmd === 'meta') return { ok: true, id: 1, result: JSON.stringify(daemon.meta) };
    if (req.cmd === 'list_raw') return { ok: true, id: 1, result: JSON.stringify(daemon.pages) };
    return { ok: false, id: 1, error: `Unknown command: ${req.cmd}` };
  });
  const connect = vi.fn(async path => ({ path, end() {}, destroy() {} }));
  const listSockets = () => Object.keys(byPath).map(path => ({ targetId: path, socketPath: path }));
  return { sent, request, connect, listSockets };
}

function freshConnectionSpies(pages = [{ targetId: 'FRESHCDPPAGE' }]) {
  const cdp = { close: vi.fn() };
  return {
    resolveWsUrl: vi.fn(async () => 'ws://127.0.0.1:9345/devtools/browser/x'),
    connectCdp: vi.fn(async () => cdp),
    listPages: vi.fn(async () => pages),
    rememberEndpoint: vi.fn(async () => null),
  };
}

const meta = cdpEndpoint => ({ schema: 'chrome-cdp-ex.daemon-metadata.v1', ...(cdpEndpoint ? { cdpEndpoint } : {}) });

describe('#419 daemon page list for target discovery', () => {
  it('sends list_raw with args, passes the daemon validator, and opens no fresh browser connection', async () => {
    const daemons = fakeDaemons({ d1: { meta: meta('127.0.0.1:9345'), pages: PAGES_9345 } });
    const fresh = freshConnectionSpies();
    const pages = await T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9345' },
      listSockets: daemons.listSockets,
      connect: daemons.connect,
      request: daemons.request,
      ...fresh,
    });
    expect(pages).toEqual(PAGES_9345);
    expect(fresh.connectCdp).not.toHaveBeenCalled();
    expect(fresh.resolveWsUrl).not.toHaveBeenCalled();
    const listRaw = daemons.sent.filter(entry => entry.cmd === 'list_raw');
    expect(listRaw).toEqual([{ path: 'd1', cmd: 'list_raw', args: [] }]);
  });

  it('never asks a daemon attached to another CDP endpoint for its page list', async () => {
    const daemons = fakeDaemons({
      other: { meta: meta('127.0.0.1:9224'), pages: PAGES_9224 },
      mine: { meta: meta('127.0.0.1:9345'), pages: PAGES_9345 },
    });
    const fresh = freshConnectionSpies();
    const pages = await T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9345', CDP_HOST: '127.0.0.1' },
      listSockets: daemons.listSockets,
      connect: daemons.connect,
      request: daemons.request,
      ...fresh,
    });
    expect(pages).toEqual(PAGES_9345);
    expect(daemons.sent.filter(entry => entry.path === 'other').map(entry => entry.cmd)).toEqual(['meta']);
    expect(fresh.connectCdp).not.toHaveBeenCalled();
  });

  it('falls back to a fresh connection for an old daemon without endpoint metadata', async () => {
    const daemons = fakeDaemons({ old: { meta: meta(null), pages: PAGES_9224 } });
    const fresh = freshConnectionSpies();
    const pages = await T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9345' },
      listSockets: daemons.listSockets,
      connect: daemons.connect,
      request: daemons.request,
      ...fresh,
    });
    expect(pages).toEqual([{ targetId: 'FRESHCDPPAGE' }]);
    expect(daemons.sent.some(entry => entry.cmd === 'list_raw')).toBe(false);
    expect(fresh.connectCdp).toHaveBeenCalledOnce();
  });

  it('asks no daemon when CDP_PORT is unset, because the endpoint is not known yet', async () => {
    const daemons = fakeDaemons({ d1: { meta: meta('127.0.0.1:9222'), pages: PAGES_9224 } });
    const fresh = freshConnectionSpies();
    const pages = await T.discoverLivePagesForTargetResolution({
      env: {},
      listSockets: daemons.listSockets,
      connect: daemons.connect,
      request: daemons.request,
      ...fresh,
    });
    expect(pages).toEqual([{ targetId: 'FRESHCDPPAGE' }]);
    expect(daemons.request).not.toHaveBeenCalled();
    expect(fresh.connectCdp).toHaveBeenCalledOnce();
  });

  it('normalizes the daemon endpoint and the requested endpoint the same way', () => {
    expect(T.cdpEndpointFromWsUrl('ws://127.0.0.1:9345/devtools/browser/abc')).toBe('127.0.0.1:9345');
    expect(T.requestedCdpEndpoint({ CDP_PORT: '9345' })).toBe('127.0.0.1:9345');
    expect(T.requestedCdpEndpoint({ CDP_PORT: '9345', CDP_HOST: 'LOCALHOST' })).toBe('localhost:9345');
    expect(T.requestedCdpEndpoint({})).toBeNull();
    expect(T.cdpEndpointFromWsUrl('not a url')).toBeNull();
  });

  it('every client list_raw request in cdp.mjs carries args', () => {
    const source = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    const requests = source.match(/\{\s*cmd:\s*'list_raw'[^}]*\}/g) || [];
    expect(requests.length).toBeGreaterThan(0);
    for (const literal of requests) expect(literal).toMatch(/args:/);
  });
});
