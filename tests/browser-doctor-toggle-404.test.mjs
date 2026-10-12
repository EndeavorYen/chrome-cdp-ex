import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const GUID_PATH = '/devtools/browser/5afac4c9-9456-4c1e-8e73-1cc157e261fd';
const dirs = [];

function activePortFile(port, wsPath = GUID_PATH) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-395-'));
  dirs.push(dir);
  const file = join(dir, 'DevToolsActivePort');
  writeFileSync(file, `${port}\n${wsPath}\n`);
  return file;
}

function http(status) {
  return async () => {
    const err = new Error(`HTTP ${status}`);
    err.status = status;
    throw err;
  };
}

function wsRecorder(okUrls) {
  const urls = [];
  const connectWebSocket = async (url) => {
    urls.push(url);
    if (okUrls.includes(url)) return true;
    throw new Error('WebSocket refused');
  };
  return { urls, connectWebSocket };
}

const base = (env, extra) => ({
  env,
  lastEndpoint: null,
  inspectOccupantProfileDir: async () => null,
  ...extra,
});

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('#395 doctor in chrome://inspect toggle mode (HTTP 404, WebSocket only)', () => {
  it('probes the default port with the guid path from DevToolsActivePort', async () => {
    const ws = wsRecorder([`ws://127.0.0.1:9222${GUID_PATH}`]);
    const r = await T.checkCdpReachability(base(
      { CDP_PORT_FILE: activePortFile('9222') },
      { fetcher: http(404), connectWebSocket: ws.connectWebSocket },
    ));

    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/WebSocket/);
    expect(ws.urls).toContain(`ws://127.0.0.1:9222${GUID_PATH}`);
  });

  it('auto-discovered port also falls back to WebSocket on HTTP 404', async () => {
    const ws = wsRecorder([`ws://127.0.0.1:9333${GUID_PATH}`]);
    const r = await T.checkCdpReachability(base(
      { CDP_PORT_FILE: activePortFile('9333') },
      { fetcher: http(404), connectWebSocket: ws.connectWebSocket },
    ));

    expect(r.status).toBe('OK');
    expect(r.port).toBe('9333');
    expect(r.detail).toMatch(/auto-discovered/);
    expect(r.detail).toMatch(/WebSocket/);
  });

  it('keeps WARN when the 404 port also refuses the WebSocket', async () => {
    const ws = wsRecorder([]);
    const r = await T.checkCdpReachability(base(
      { CDP_PORT_FILE: activePortFile('9333') },
      { fetcher: http(404), connectWebSocket: ws.connectWebSocket },
    ));

    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/9333 but \/json\/version unreachable: HTTP 404/);
  });

  it('does not try the WebSocket for non-404 HTTP errors', async () => {
    const ws = wsRecorder([`ws://127.0.0.1:9333${GUID_PATH}`]);
    const r = await T.checkCdpReachability(base(
      { CDP_PORT_FILE: activePortFile('9333') },
      { fetcher: http(500), connectWebSocket: ws.connectWebSocket },
    ));

    expect(r.status).toBe('WARN');
    expect(ws.urls).not.toContain(`ws://127.0.0.1:9333${GUID_PATH}`);
  });

  it('ignores a DevToolsActivePort path that is not a browser socket path', async () => {
    const ws = wsRecorder([]);
    await T.checkCdpReachability(base(
      { CDP_PORT_FILE: activePortFile('9333', '/evil/../path') },
      { fetcher: http(404), connectWebSocket: ws.connectWebSocket },
    ));

    expect(ws.urls.every((u) => !u.includes('/evil'))).toBe(true);
  });

  it('explicit CDP_PORT with no DevToolsActivePort keeps the bare browser path', async () => {
    const ws = wsRecorder(['ws://127.0.0.1:9555/devtools/browser']);
    const r = await T.checkCdpReachability(base(
      { CDP_PORT: '9555', CDP_PORT_FILE: join(tmpdir(), 'cdp-395-missing-file') },
      { fetcher: http(404), connectWebSocket: ws.connectWebSocket },
    ));

    expect(r.status).toBe('OK');
    expect(ws.urls).toEqual(['ws://127.0.0.1:9555/devtools/browser']);
  });
});
