import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const DEAD_PORT = '3048';
const LIVE_PORT = '9333';
const LIVE_WS = `ws://127.0.0.1:${LIVE_PORT}/devtools/browser/LIVE558`;
const FILE_WS = '/devtools/browser/dead-file-guid';
const dirs = [];

function portFile(port, wsPath = FILE_WS) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-558-'));
  dirs.push(dir);
  const file = join(dir, 'DevToolsActivePort');
  writeFileSync(file, `${port}\n${wsPath}\n`);
  return file;
}

function fetcherFor(livePort) {
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(String(url));
    const port = String(url).match(/:(\d+)\//)?.[1];
    if (port !== livePort) throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        Browser: 'Chrome/154.0.0.0',
        webSocketDebuggerUrl: LIVE_WS,
      }),
    };
  };
  return { fetched, fetcher };
}

function discovery(file, { livePort = null, lastEndpoint = { host: '127.0.0.1', port: LIVE_PORT } } = {}) {
  const { fetched, fetcher } = fetcherFor(livePort);
  const opts = {
    env: { CDP_PORT_FILE: file },
    fetcher,
    lastEndpoint,
    rememberEndpoint: () => {},
    connectWebSocket: async () => {
      throw new Error('WebSocket refused');
    },
  };
  return { fetched, opts };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('#558 dead DevToolsActivePort falls through to the remembered port', () => {
  it('T1 doctor accepts the remembered port when the file port does not answer', async () => {
    const { fetched, opts } = discovery(portFile(DEAD_PORT), { livePort: LIVE_PORT });
    const result = await T.checkCdpReachability(opts);

    expect(result.status).toBe('OK');
    expect(result.port).toBe(LIVE_PORT);
    expect(result.detail).not.toMatch(/spawn-debug-browser/);
    expect(fetched.indexOf(`http://127.0.0.1:${DEAD_PORT}/json/version`))
      .toBeLessThan(fetched.indexOf(`http://127.0.0.1:${LIVE_PORT}/json/version`));
  });

  it('T2 list discovery returns the remembered WebSocket, not the dead file port', async () => {
    const { opts } = discovery(portFile(DEAD_PORT), { livePort: LIVE_PORT });
    await expect(T.getWsUrl(opts)).resolves.toBe(LIVE_WS);
  });

  it('T3 a dead file and no later port names the dead port and does not claim the file is absent', async () => {
    const { opts } = discovery(portFile(DEAD_PORT), { livePort: null });
    const doctor = await T.checkCdpReachability(opts);
    expect(doctor.status).not.toBe('OK');
    expect(doctor.detail).toMatch(new RegExp(DEAD_PORT));
    expect(doctor.detail).not.toMatch(/no DevToolsActivePort/i);

    await expect(T.getWsUrl(opts)).rejects.toThrow(new RegExp(DEAD_PORT));
    await expect(T.getWsUrl(opts)).rejects.not.toThrow(/no DevToolsActivePort/i);
  });

  it('a file port whose HTTP 404 still opens its websocket stays that endpoint', async () => {
    const file = portFile(DEAD_PORT);
    const fetched = [];
    const wsUrl = `ws://127.0.0.1:${DEAD_PORT}${FILE_WS}`;
    const url = await T.getWsUrl({
      env: { CDP_PORT_FILE: file },
      fetcher: async (target) => {
        fetched.push(String(target));
        const err = new Error('HTTP 404');
        err.status = 404;
        throw err;
      },
      lastEndpoint: { host: '127.0.0.1', port: LIVE_PORT },
      rememberEndpoint: () => {},
      connectWebSocket: async (target) => {
        if (target === wsUrl) return true;
        throw new Error('WebSocket refused');
      },
    });

    expect(url).toBe(wsUrl);
    expect(fetched).not.toContain(`http://127.0.0.1:${LIVE_PORT}/json/version`);
  });
});
