import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectBrowserPath } from '../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = join(REPO, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const MARKER = 'chrome-cdp-ex.hover-reveal.v1';

function revealValue({ matchesHover = false, tag = 'BUTTON' } = {}) {
  return {
    ok: true,
    marker: MARKER,
    x: 108,
    y: 48,
    tag,
    opacity: 1,
    visibility: 'visible',
    display: 'inline',
    visible: true,
    groupHover: matchesHover === true,
    matchesHover,
    href: 'http://fixture.invalid/hover',
  };
}

function hoverCdp({ matchesHoverForRead, visibility = 'hidden' } = {}) {
  const calls = [];
  let reads = 0;
  const cdp = {
    calls,
    get reads() { return reads; },
    send(method, params = {}, sessionId, timeoutMs) {
      calls.push({ method, params, sessionId, timeoutMs });
      if (method === 'Input.dispatchMouseEvent') return Promise.resolve({});
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.trim() === 'document.visibilityState') {
          return Promise.resolve({ result: { type: 'string', value: visibility } });
        }
        if (expr.includes(MARKER)) {
          reads += 1;
          const matchesHover = matchesHoverForRead(reads);
          return Promise.resolve({ result: { value: revealValue({ matchesHover }) } });
        }
      }
      return Promise.resolve({ result: { value: '' } });
    },
  };
  return cdp;
}

function nextLines(text) {
  return String(text || '').split('\n').filter(line => line.startsWith('Next:'));
}

describe('hover does not report success before the page is hovered (#608)', () => {
  it('keeps polling until :hover is true instead of returning on the first miss', async () => {
    const cdp = hoverCdp({
      matchesHoverForRead: read => read >= 3,
    });
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);
    expect(T.HOVER_DELIVERY_WAIT_MS).toBeGreaterThanOrEqual(6000);
    const text = await T.hoverStr(cdp, 'sid', '#a', new Map(), {}, { deliveryWaitMs: 800 });
    expect(text).toMatch(/Hovering over <BUTTON>/);
    expect(cdp.reads).toBeGreaterThanOrEqual(3);
    expect(cdp.calls.some(call => (
      call.method === 'Input.dispatchMouseEvent'
      && call.params.type === 'mouseMoved'
      && call.timeoutMs === T.HOVER_MOUSE_ACK_TIMEOUT_MS
    ))).toBe(true);
  });

  it('fails closed with one recovery when a hidden tab never matches :hover', async () => {
    const cdp = hoverCdp({
      matchesHoverForRead: () => false,
      visibility: 'hidden',
    });
    const err = await T.hoverStr(cdp, 'sid', '#a', new Map(), {}, { deliveryWaitMs: 180 }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/did not match :hover/);
    expect(err.message).toMatch(/The hover was not delivered/);
    expect(err.message).toMatch(/visibilityState is hidden/);
    expect(err.message).not.toMatch(/jsclick/);
    expect(err.message).not.toMatch(/click --js/);
    const cli = T.formatCliError(err, { cmd: 'hover', targetPrefix: 'ABCD1234', args: ['#a'] });
    expect(cli).toMatch(/Kind: hover-not-delivered/);
    expect(nextLines(cli)).toEqual([
      'Next: CDP_BACKGROUND=0 cdp hover ABCD1234 "#a" (Kind: hover-not-delivered)',
    ]);
    expect(cli).not.toMatch(/jsclick/);
    expect(cli).not.toMatch(/click --js/);
  });

  it('names one perceive recovery when a visible tab never matches :hover', async () => {
    const cdp = hoverCdp({
      matchesHoverForRead: () => false,
      visibility: 'visible',
    });
    const err = await T.hoverStr(cdp, 'sid', '#a', new Map(), {}, { deliveryWaitMs: 180 }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    const cli = T.formatCliError(err, { cmd: 'hover', targetPrefix: 'ABCD1234', args: ['#a'] });
    expect(nextLines(cli)).toEqual([
      'Next: cdp perceive ABCD1234 -C -d 8 (Kind: hover-not-delivered)',
    ]);
    expect(cli).not.toMatch(/jsclick/);
    expect(cli).not.toMatch(/click --js/);
  });
});

function browserPath() {
  const fromEnv = process.env.CDP_SMOKE_BROWSER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const name of ['chrome', 'edge', 'brave']) {
    const found = detectBrowserPath(name);
    if (found && existsSync(found)) return found;
  }
  return '';
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const FIXTURE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>hover-delivery</title>
<style>button { width: 160px; height: 40px; margin: 20px; }</style>
<button id="a">Alpha</button>
<script>
  window.__hoverDelivery = { over: 0, move: 0 };
  const button = document.querySelector('#a');
  button.addEventListener('mouseover', () => { window.__hoverDelivery.over += 1; });
  button.addEventListener('mousemove', () => { window.__hoverDelivery.move += 1; });
</script>`;

describe('headless background tab hover (#608)', () => {
  const browser = browserPath();

  it.skipIf(!browser)('does not return until the background tab matches :hover and mouseover fired', async () => {
    const port = await freePort();
    const profile = mkdtempSync(join(tmpdir(), 'hover-608-'));
    const runtime = join(profile, 'runtime');
    mkdirSync(runtime, { recursive: true });
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const url = `http://127.0.0.1:${server.address().port}/hover.html`;
    const sandboxOff = /^(1|true|yes|on)$/i.test(process.env.CDP_SMOKE_NO_SANDBOX || '') || Boolean(process.env.CI);
    const chromeLog = [];
    const chrome = spawn(browser, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-size=1000,700',
      ...(sandboxOff ? ['--no-sandbox'] : []),
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr?.setEncoding('utf8');
    chrome.stderr?.on('data', chunk => {
      chromeLog.push(String(chunk));
      if (chromeLog.length > 40) chromeLog.shift();
    });
    const env = {
      ...process.env,
      CDP_PORT: String(port),
      ...(process.platform === 'win32' ? { LOCALAPPDATA: runtime } : { XDG_RUNTIME_DIR: runtime }),
    };
    const run = args => spawnSync(process.execPath, [CDP, ...args], {
      cwd: REPO, env, encoding: 'utf8', timeout: 45000,
    });
    let socket;
    try {
      // A parallel suite can keep the first headless Chrome from opening DevTools
      // for well over the old 20s budget. Keep polling until the URL exists.
      const readyAt = Date.now() + 45000;
      let version;
      while (Date.now() < readyAt && !version?.webSocketDebuggerUrl) {
        if (chrome.exitCode != null) break;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
          if (response.ok) version = await response.json();
        } catch {
          // DevTools is not accepting connections yet.
        }
        if (!version?.webSocketDebuggerUrl) await new Promise(resolveWait => setTimeout(resolveWait, 200));
      }
      expect(
        version?.webSocketDebuggerUrl,
        `chrome exit=${chrome.exitCode ?? 'running'}\n${chromeLog.join('').slice(-1500)}`,
      ).toBeTruthy();
      socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolveOpen, rejectOpen) => {
        socket.addEventListener('open', resolveOpen);
        socket.addEventListener('error', () => rejectOpen(new Error('cdp websocket failed')));
      });
      let seq = 0;
      const pending = new Map();
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      });
      const send = (method, params = {}, sessionId) => new Promise((resolveSend, rejectSend) => {
        const id = ++seq;
        pending.set(id, message => {
          if (message.error) rejectSend(new Error(message.error.message || 'cdp error'));
          else resolveSend(message.result || {});
        });
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        socket.send(JSON.stringify(payload));
      });
      const page = await send('Target.createTarget', { url, background: true });
      await send('Target.createTarget', { url: 'about:blank' });
      const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      await send('Runtime.enable', {}, attached.sessionId);
      const read = async () => {
        const result = await send('Runtime.evaluate', {
          expression: `(() => {
            const button = document.querySelector('#a');
            const probe = window.__hoverDelivery;
            if (!button || !probe) {
              return JSON.stringify({
                ready: false,
                href: String(location.href || ''),
                state: document.readyState,
              });
            }
            return JSON.stringify({
              ready: true,
              visibility: document.visibilityState,
              hover: button.matches(':hover'),
              over: probe.over,
            });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        }, attached.sessionId);
        const details = result.exceptionDetails;
        if (details) {
          throw new Error(details.exception?.description || details.text || 'hover fixture evaluate failed');
        }
        const value = result.result?.value;
        if (typeof value !== 'string') {
          throw new Error(`hover fixture evaluate returned ${JSON.stringify(result.result)}`);
        }
        return JSON.parse(value);
      };
      const deadline = Date.now() + 15000;
      let before = null;
      while (Date.now() < deadline) {
        before = await read();
        if (before.ready) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
      }
      expect(before?.ready, JSON.stringify(before)).toBe(true);
      expect(before.visibility).toBe('hidden');
      expect(before.hover).toBe(false);
      expect(before.over).toBe(0);
      const listDeadline = Date.now() + 10000;
      let prefix = '';
      let list = null;
      while (Date.now() < listDeadline && !prefix) {
        list = run(['list']);
        expect(list.status, `${list.stdout}\n${list.stderr}`).toBe(0);
        prefix = list.stdout.split('\n').find(line => line.includes('hover.html'))?.trim().split(/\s+/)[0] || '';
        if (!prefix) await new Promise(resolveWait => setTimeout(resolveWait, 200));
      }
      expect(prefix, list?.stdout || '').toBeTruthy();
      const hover = run(['hover', prefix, '#a']);
      expect(hover.status, `${hover.stdout}\n${hover.stderr}`).toBe(0);
      expect(hover.stdout).toMatch(/Hovering over <BUTTON>/);
      const after = await read();
      expect(after.hover).toBe(true);
      expect(after.over).toBeGreaterThan(0);
    } finally {
      try { socket?.close(); } catch {}
      try { chrome.kill('SIGTERM'); } catch {}
      try { run(['stop', '--all']); } catch {}
      await new Promise(resolveClose => server.close(resolveClose));
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile may still be closing */ }
    }
  }, 120000);
});
