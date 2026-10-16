import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { detectBrowserPath } from '../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';
import { createMockCDP } from './mock-cdp.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { dispatchHoverWithLeftoverPolicy, hoverNotDeliveredError } = await import('../skills/chrome-cdp-ex/scripts/lib/cdp-input.mjs');

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

describe('#750 every hover failure names a Kind and a runnable Next', () => {
  const cli = (err, selector) => T.formatCliError(err, { cmd: 'hover', targetPrefix: 'ABCD1234', args: [selector] });
  // Runs the hover page expression against a document whose querySelector behaves as given.
  const pageCdp = querySelector => createMockCDP({
    'Runtime.evaluate': params => ({ result: { value: runInNewContext(params.expression, { document: { querySelector }, JSON, Object }) } }),
  });

  it('refuses text= before any page call: hover takes a CSS selector or an @ref', async () => {
    const cdp = createMockCDP({});
    const err = await dispatchHoverWithLeftoverPolicy({ cdp, sid: 'sid', selector: 'text=Hover me', refMap: new Map(), refState: {} }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(cdp.calls).toEqual([]);
    // The daemon forwards the message text, so classify that, not the in-process error object.
    const text = cli(err.message, 'text=Hover me');
    expect(text).toMatch(/^Error: hover: "text=Hover me" is a text query; hover takes a CSS selector or an @ref\./);
    expect(text).toContain('Kind: usage');
    expect(nextLines(text)).toEqual(['Next: cdp perceive ABCD1234 -C -d 8']);
  });

  it('is not taken over by the generic "required" usage rule, and classifies inside flow', async () => {
    const required = await T.hoverStr(createMockCDP({}), 'sid', 'text=Required', new Map(), {}).catch(error => error);
    expect(nextLines(cli(required.message, 'text=Required'))).toEqual(['Next: cdp perceive ABCD1234 -C -d 8']);
    const miss = await T.hoverStr(pageCdp(() => null), 'sid', 'input:required', new Map(), {}).catch(error => error);
    const missText = cli(miss.message, 'input:required');
    expect(missText).toContain('Kind: selector');
    expect(nextLines(missText)).toEqual(['Next: cdp perceive ABCD1234 -C -d 8']);
    const inFlow = T.formatCliError(required.message, { cmd: 'flow', targetPrefix: 'ABCD1234', args: [] });
    expect(inFlow).toContain('Kind: usage');
    expect(nextLines(inFlow)).toEqual(['Next: cdp perceive ABCD1234 -C -d 8']);
  });

  it('keeps hover-not-delivered when the selector or page text contains "element not found"', () => {
    const err = hoverNotDeliveredError('#element-not-found', { x: 1, y: 2 }, 'visible', { coveredBy: '<DIV> "Invalid selector: x"' });
    expect(cli(err.message, '#element-not-found')).toContain('Kind: hover-not-delivered');
  });

  it('reports an invalid CSS selector without a browser stack', async () => {
    const err = await T.hoverStr(pageCdp(() => {
      throw new SyntaxError("Failed to execute 'querySelector' on 'Document': 'div[' is not a valid selector.");
    }), 'sid', 'div[', new Map(), {}).catch(error => error);
    const text = cli(err, 'div[');
    expect(text).toMatch(/^Error: Invalid selector: /);
    expect(text).not.toMatch(/at <anonymous>/);
    expect(text).toContain('Kind: invalid-selector');
    expect(nextLines(text)).toEqual(['Next: cdp perceive ABCD1234 -C -d 8']);
  });

  it('classifies a selector miss instead of Kind: unknown', async () => {
    const err = await T.hoverStr(pageCdp(() => null), 'sid', '#nope', new Map(), {}).catch(error => error);
    const text = cli(err, '#nope');
    expect(text).toMatch(/^Error: Element not found: #nope/);
    expect(text).toContain('Kind: selector');
    expect(nextLines(text)).toEqual(['Next: cdp perceive ABCD1234 -C -d 8']);
  });
});

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
      'Next: CDP_BACKGROUND=0 cdp hover ABCD1234 "#a"',
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
      'Next: cdp perceive ABCD1234 -C -d 8',
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

const COVER_LABEL = '<DIV#cover role="dialog"> "Cookies"';
// #621: a visible tab that will never match :hover must not spend the ~7s
// background-tab window. About 1s when the point is on the target; a few polls
// when another element is at that point.
const VISIBLE_HOVER_BOUND_MS = 1000;

function hoverDeliveryMock({ visibility = 'visible', pointHit = null, landedAfterMs = null } = {}) {
  const started = Date.now();
  let pointReads = 0;
  const cdp = createMockCDP({
    'Runtime.evaluate': (params) => {
      const expr = String(params.expression || '');
      if (expr.trim() === 'document.visibilityState') {
        return { result: { type: 'string', value: visibility } };
      }
      if (!expr.includes(MARKER)) return { result: { value: '' } };
      // The geometry read also embeds the reveal marker. The point probe is the
      // later poll, which asks what is at the hover point.
      const asksPoint = (expr.includes('elementFromPoint') || expr.includes('DOM.getNodeForLocation'))
        && !expr.includes('rect.width / 2');
      if (asksPoint) pointReads += 1;
      const matchesHover = landedAfterMs != null && Date.now() - started >= landedAfterMs;
      const value = {
        ...revealValue({ matchesHover, tag: 'BUTTON' }),
        x: 108,
        y: 48,
      };
      if (asksPoint && pointHit) value.pointHit = pointHit;
      return { result: { value } };
    },
    'Input.dispatchMouseEvent': () => ({}),
  });
  return {
    cdp,
    get pointReads() { return pointReads; },
  };
}

function pageHitTarget() {
  const target = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: 'go',
    className: '',
    textContent: 'Go',
    shadowRoot: null,
    parentNode: null,
    matches: () => false,
    closest: () => null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 100, y: 40, width: 16, height: 16, left: 100, top: 40 }),
  };
  const child = {
    nodeType: 1,
    tagName: 'SPAN',
    id: '',
    className: '',
    textContent: 'Go',
    shadowRoot: null,
    parentNode: target,
    getAttribute: () => null,
  };
  const cover = {
    nodeType: 1,
    tagName: 'DIV',
    id: 'cover',
    className: '',
    textContent: 'Cookies',
    shadowRoot: null,
    parentNode: null,
    getAttribute: (name) => (name === 'role' ? 'dialog' : name === 'aria-label' ? 'Cookies' : null),
  };
  const inner = {
    nodeType: 1,
    tagName: 'SPAN',
    id: '',
    className: '',
    textContent: 'In shadow',
    shadowRoot: null,
    parentNode: null,
    getAttribute: () => null,
  };
  const root = { nodeType: 11, host: target, elementFromPoint: () => inner };
  inner.parentNode = root;
  let top = cover;
  const doc = {
    querySelector: () => target,
    elementFromPoint: () => top,
  };
  target.ownerDocument = doc;
  child.ownerDocument = doc;
  cover.ownerDocument = doc;
  inner.ownerDocument = doc;
  return {
    target,
    child,
    cover,
    root,
    setTop(node) { top = node; },
  };
}

function readPageHit(hit) {
  return runInNewContext(T.hoverRevealStateExpression('#go'), {
    document: hit.target.ownerDocument,
    getComputedStyle: () => ({ opacity: '1', visibility: 'visible', display: 'inline' }),
    location: { href: 'http://fixture.invalid/hover' },
  });
}

describe('hover fails fast on a visible tab when the point is not the target (#621)', () => {
  it('names the element at the point and fails in under 1.5s when a visible tab is covered', async () => {
    const mock = hoverDeliveryMock({
      visibility: 'visible',
      pointHit: { onTarget: false, label: COVER_LABEL },
    });
    const started = Date.now();
    const err = await T.hoverStr(mock.cdp, 'sid', '#a', new Map(), {}).catch(error => error);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(1500);
    expect(mock.pointReads).toBeGreaterThanOrEqual(2);
    expect(mock.pointReads).toBeLessThanOrEqual(3);
    expect(err.message).toMatch(/did not match :hover/);
    expect(err.message).toMatch(new RegExp(`is covered by ${COVER_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(err.hoverCovered).toBe(true);
    expect(err.message).toMatch(/The hover was not delivered/);
    expect(err.message).not.toMatch(/visibilityState is hidden/);
    const cli = T.formatCliError(err, { cmd: 'hover', targetPrefix: 'ABCD1234', args: ['#a'] });
    expect(cli).toMatch(/Kind: hover-not-delivered/);
    expect(nextLines(cli)).toEqual([
      'Next: cdp perceive ABCD1234 -C -d 8',
    ]);
  });

  it('succeeds when a visible tab is on the target and :hover arrives within the short bound', async () => {
    const mock = hoverDeliveryMock({
      visibility: 'visible',
      pointHit: { onTarget: true, label: '' },
      landedAfterMs: 300,
    });
    const started = Date.now();
    const text = await T.hoverStr(mock.cdp, 'sid', '#a', new Map(), {});
    expect(Date.now() - started).toBeLessThan(VISIBLE_HOVER_BOUND_MS);
    expect(text).toMatch(/Hovering over <BUTTON>/);
  });

  it('stops a visible on-target miss after about 1s instead of the background window', async () => {
    const mock = hoverDeliveryMock({
      visibility: 'visible',
      pointHit: { onTarget: true, label: '' },
    });
    const started = Date.now();
    const err = await T.hoverStr(mock.cdp, 'sid', '#a', new Map(), {}).catch(error => error);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    // Above the covered-point polls (~200ms) and under the old ~7s window.
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(1500);
    expect(elapsed).toBeLessThan(T.HOVER_DELIVERY_WAIT_MS);
    expect(err.message).toMatch(/did not match :hover/);
    expect(err.message).not.toMatch(/is covered by/);
    const cli = T.formatCliError(err, { cmd: 'hover', targetPrefix: 'ABCD1234', args: ['#a'] });
    expect(nextLines(cli)).toEqual([
      'Next: cdp perceive ABCD1234 -C -d 8',
    ]);
  });

  it('still accepts late :hover on a hidden tab after the visible bound', async () => {
    const mock = hoverDeliveryMock({
      visibility: 'hidden',
      pointHit: { onTarget: false, label: COVER_LABEL },
      landedAfterMs: VISIBLE_HOVER_BOUND_MS + 250,
    });
    const started = Date.now();
    const text = await T.hoverStr(mock.cdp, 'sid', '#a', new Map(), {});
    const elapsed = Date.now() - started;
    expect(text).toMatch(/Hovering over <BUTTON>/);
    expect(elapsed).toBeGreaterThan(VISIBLE_HOVER_BOUND_MS);
    expect(elapsed).toBeLessThan(T.HOVER_DELIVERY_WAIT_MS);
  });

  it('treats a child or shadow child as the target and names an element that is not inside it', () => {
    const hit = pageHitTarget();
    hit.setTop(hit.cover);
    const covered = readPageHit(hit);
    expect(covered.pointHit).toEqual({ onTarget: false, label: COVER_LABEL });
    hit.setTop(hit.target);
    expect(readPageHit(hit).pointHit.onTarget).toBe(true);
    hit.setTop(hit.child);
    expect(readPageHit(hit).pointHit.onTarget).toBe(true);
    hit.target.shadowRoot = hit.root;
    hit.setTop(hit.target);
    expect(readPageHit(hit).pointHit.onTarget).toBe(true);
  });

  // #757: the cover is named as other target receipts are: aria-label, then visible text, then title.
  it('names a cover by its visible text before its title, and by its title when it has no text', () => {
    const hit = pageHitTarget();
    const text = { nodeType: 3, nodeValue: 'B200 192 GB', nextSibling: null };
    const span = { nodeType: 1, tagName: 'SPAN', firstChild: text, nextSibling: null, getAttribute: () => null };
    const option = {
      nodeType: 1,
      tagName: 'DIV',
      id: 'opt',
      className: '',
      textContent: 'B200 192 GB',
      firstChild: span,
      shadowRoot: null,
      parentNode: null,
      getAttribute: (name) => (name === 'title' ? '[object Object]' : null),
    };
    hit.setTop(option);
    expect(readPageHit(hit).pointHit).toEqual({ onTarget: false, label: '<DIV#opt> "B200 192 GB"' });
    const tip = { ...option, id: 'tip', textContent: '', firstChild: null, getAttribute: (name) => (name === 'title' ? 'Close dialog' : null) };
    hit.setTop(tip);
    expect(readPageHit(hit).pointHit).toEqual({ onTarget: false, label: '<DIV#tip> "Close dialog"' });
  });
});

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

describe('#621 the covered hover reason follows the source tag', () => {
  it('uses the covered reason for a tagged error, also after the daemon round trip', () => {
    const err = hoverNotDeliveredError('#m', { x: 10, y: 10 }, 'visible', { coveredBy: '<DIV#cover>' });
    expect(err.hoverCovered).toBe(true);
    const direct = T.buildCliErrorRecovery(err.message, { cmd: 'hover', targetPrefix: 'ABCD1234', err });
    expect(direct.kind).toBe('hover-not-delivered');
    expect(direct.reason).toMatch(/Another element is at the hover point/);
    const forwarded = T.cliErrorFromDaemonResponse({ ok: false, error: err.message, errorSource: { hoverCovered: true } });
    expect(forwarded.hoverCovered).toBe(true);
    const viaDaemon = T.buildCliErrorRecovery(forwarded.message, { cmd: 'hover', targetPrefix: 'ABCD1234', err: forwarded });
    expect(viaDaemon.reason).toMatch(/Another element is at the hover point/);
  });

  it('does not read "is covered by" from untagged text', () => {
    const message = 'hover: [aria-label="Menu is covered by default"] did not match :hover. The hover was not delivered.';
    const recovery = T.buildCliErrorRecovery(message, { cmd: 'hover', targetPrefix: 'ABCD1234' });
    expect(recovery.kind).toBe('hover-not-delivered');
    expect(recovery.reason).not.toMatch(/Another element/);
  });
});
