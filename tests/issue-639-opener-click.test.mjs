import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectBrowserPath } from '../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = join(REPO, 'skills/chrome-cdp-ex/scripts/cdp.mjs');

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

// The popup request arrives while the CLI is inside spawnSync. An in-process
// server cannot accept it, so the fixture listens in its own process.
const FIXTURE_SERVER = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const port = Number(process.argv[2]);
const root = process.argv[3];
const host = readFileSync(root + '/host.html');
const inner = '<!doctype html><meta charset=utf-8><title>inner2</title><p id="ready">inner2 ready</p>';
const slow = '<!doctype html><meta charset=utf-8><title>slow</title><p id="ready">slow ready</p>';
createServer((req, res) => {
  const path = String(req.url || '/').split('?')[0];
  const body = path === '/host.html' ? host : path === '/inner2' ? inner : path === '/slow' ? slow : null;
  if (!body) { res.writeHead(404); res.end('no'); return; }
  const send = () => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  // /inner2 is slow on purpose: Chrome 154 publishes the popup with an empty
  // URL before the response arrives. The click must wait for /inner2.
  // /slow is past the old 3s empty-url deadline and still inside the navigation cap.
  if (path === '/inner2') setTimeout(send, 1500);
  else if (path === '/slow') setTimeout(send, 5000);
  else send();
}).listen(port, '127.0.0.1', () => process.stdout.write('ready\\n'));
`;

const HOST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>host</title>
<style>button{display:block;width:240px;height:36px;margin:16px 40px}</style>
<button id="popup" onclick="window.open('/inner2','_blank')">Open inner2</button>
<button id="slow" onclick="window.open('/slow','_blank')">Open slow</button>
<button id="noop" onclick="window.open('/inner2','_blank','noopener')">Open noopener</button>
<button id="plain" onclick="document.title='plain-clicked'">Plain</button>
<button id="spin" onclick="openSpin()">Open spin</button>
<script>
function openSpin() {
  const popup = window.open('about:blank', '_blank');
  popup.document.open();
  popup.document.write('<!doctype html><title>spin</title><script>while(true){try{opener.document.title="x"}catch(e){}}<\\/script>');
  popup.document.close();
}
</script>`;

describe('headless Chrome window.open with an opener (#639)', () => {
  const browser = browserPath();

  it.skipIf(!browser)('reports the opened tab for an opener popup, a blocked probe, and clickxy', async () => {
    const cdpPort = await freePort();
    const httpPort = await freePort();
    const profile = mkdtempSync(join(tmpdir(), 'issue-639-opener-'));
    const runtime = join(profile, 'runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(profile, 'fixture-server.mjs'), FIXTURE_SERVER);
    writeFileSync(join(profile, 'host.html'), HOST_HTML);
    const server = spawn(process.execPath, [join(profile, 'fixture-server.mjs'), String(httpPort), profile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout?.on('data', chunk => { serverLog += chunk; });
    server.stderr?.on('data', chunk => { serverLog += chunk; });
    const sandboxOff = /^(1|true|yes|on)$/i.test(process.env.CDP_SMOKE_NO_SANDBOX || '') || Boolean(process.env.CI);
    const chrome = spawn(browser, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}/chrome`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-size=1280,900',
      ...(sandboxOff ? ['--no-sandbox', '--disable-gpu'] : []),
      'about:blank',
    ], { stdio: 'ignore' });
    const env = {
      ...process.env,
      CDP_PORT: String(cdpPort),
      ...(process.platform === 'win32' ? { LOCALAPPDATA: runtime } : { XDG_RUNTIME_DIR: runtime }),
    };
    const run = (args, timeout = 20000) => spawnSync(process.execPath, [CDP, ...args], {
      cwd: REPO, env, encoding: 'utf8', timeout,
    });
    try {
      await new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error(`fixture server did not start\n${serverLog}`)), 5000);
        server.stdout?.on('data', () => {
          if (serverLog.includes('ready')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
      });
      const readyAt = Date.now() + 45000;
      let version = null;
      while (Date.now() < readyAt && !version?.webSocketDebuggerUrl) {
        if (chrome.exitCode !== null) {
          throw new Error(`browser exited before DevTools accepted connections (exit ${chrome.exitCode})`);
        }
        try {
          const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(400) });
          if (response.ok) version = await response.json();
        } catch {
          // DevTools is not accepting connections yet.
        }
        if (!version?.webSocketDebuggerUrl) await new Promise(resolveWait => setTimeout(resolveWait, 200));
      }
      expect(version?.webSocketDebuggerUrl).toBeTruthy();
      const url = `http://127.0.0.1:${httpPort}/host.html`;
      const hostUrl = url;
      const opened = run(['open', url]);
      expect(opened.status, `${opened.stdout}\n${opened.stderr}`).toBe(0);
      const target = opened.stdout.match(/Opened new tab:\s+([0-9A-Fa-f]+)/)?.[1];
      expect(target).toBeTruthy();

      const plain = run(['click', target, '#plain']);
      expect(plain.status, `${plain.stdout}\n${plain.stderr}`).toBe(0);
      expect(plain.stdout).toMatch(/Clicked <BUTTON> "Plain"/);
      expect(plain.stdout).not.toMatch(/Kind:/);

      const noop = run(['click', target, '#noop']);
      expect(noop.status, `${noop.stdout}\n${noop.stderr}`).toBe(0);
      expect(noop.stdout).toMatch(/opened new tab [0-9A-Fa-f]+ http:\/\/127\.0\.0\.1:\d+\/inner2/);
      const afterNoop = run(['eval', target, '1+1'], 8000);
      expect(afterNoop.status, `${afterNoop.stdout}\n${afterNoop.stderr}`).toBe(0);
      expect(afterNoop.stdout.trim()).toBe('2');
      const noopTab = noop.stdout.match(/opened new tab ([0-9A-Fa-f]+)/)?.[1];
      if (noopTab) run(['closetab', noopTab], 8000);

      const box = run(['eval', target, '(() => { const r = document.querySelector("#noop").getBoundingClientRect(); return Math.round(r.x + r.width / 2) + " " + Math.round(r.y + r.height / 2); })()']);
      expect(box.status, `${box.stdout}\n${box.stderr}`).toBe(0);
      const [x, y] = box.stdout.trim().split(/\s+/);
      const clickxy = run(['clickxy', target, x, y]);
      expect(clickxy.status, `${clickxy.stdout}\n${clickxy.stderr}`).toBe(0);
      expect(clickxy.stdout).toMatch(/Clicked at CSS \([^)]+\) → opened new tab /);
      expect(clickxy.stdout).not.toMatch(/Outcome:/);
      expect(clickxy.stdout).not.toMatch(/clickxy: dispatched/);
      expect([...clickxy.stdout].length + [...clickxy.stderr].length).toBeLessThan(220);
      const second = clickxy.stdout.match(/opened new tab ([0-9A-Fa-f]+)/)?.[1];
      if (second) run(['closetab', second], 8000);

      const js = run(['click', target, '#popup', '--js']);
      expect(js.status, `${js.stdout}\n${js.stderr}`).not.toBe(0);
      expect(`${js.stdout}\n${js.stderr}`).toMatch(/click-no-change/);
      expect(`${js.stdout}\n${js.stderr}`).not.toMatch(/opened new tab/);
      const afterJs = run(['eval', target, '1+1'], 8000);
      expect(afterJs.status, `${afterJs.stdout}\n${afterJs.stderr}`).toBe(0);
      expect(afterJs.stdout.trim()).toBe('2');

      // #677: on Google Chrome stable 154 the opener can stay unusable. That
      // receipt is exit 1, Kind opener-blocked, Next `cdp open <url>`. Running
      // that Next must open a new tab whose eval succeeds. Later clicks use
      // that tab: the original one does not accept input. Where the opener
      // recovers, the original tab still answers 1+1.
      const acceptOpener = (pageTarget, selector, { url = null } = {}) => {
        const result = run(['click', pageTarget, selector], 20000);
        const text = `${result.stdout}\n${result.stderr}`;
        const opened = result.stdout.match(/opened new tab ([0-9A-Fa-f]+) (\S+)/);
        if (result.status === 0 && opened) {
          if (url) expect(result.stdout).toMatch(url);
          expect(text).not.toMatch(/Kind: opener-blocked/);
          expect(text).not.toMatch(/Kind: no-input-events/);
          expect(text).not.toMatch(/jsclick/);
          const unstuck = run(['eval', pageTarget, '1+1'], 8000);
          expect(unstuck.status, `${unstuck.stdout}\n${unstuck.stderr}`).toBe(0);
          expect(unstuck.stdout.trim()).toBe('2');
          run(['closetab', opened[1]], 8000);
          return { branch: 'recovered', target: pageTarget };
        }
        expect(result.status, text).not.toBe(0);
        expect(text).toMatch(/the original tab is no longer usable/);
        expect(text).toMatch(/Reopen the tab or restart the browser/);
        expect(text).toMatch(/Kind: opener-blocked/);
        expect(text).not.toMatch(/perceive/);
        expect(text).not.toMatch(/opened new tab/);
        expect(text).not.toMatch(/about:blank/);
        expect(text).not.toMatch(/closetab/);
        const next = text.match(/Next: cdp open (\S+)/);
        expect(next, text).toBeTruthy();
        expect(next[1], text).toBe(hostUrl);
        const reopened = run(['open', next[1]], 20000);
        expect(reopened.status, `${reopened.stdout}\n${reopened.stderr}`).toBe(0);
        const fresh = reopened.stdout.match(/Opened new tab:\s+([0-9A-Fa-f]+)/)?.[1];
        expect(fresh, reopened.stdout).toBeTruthy();
        const freshEval = run(['eval', fresh, '1+1'], 8000);
        expect(freshEval.status, `${freshEval.stdout}\n${freshEval.stderr}`).toBe(0);
        expect(freshEval.stdout.trim()).toBe('2');
        return { branch: 'blocked', target: fresh };
      };

      let page = target;
      const spin = acceptOpener(page, '#spin');
      expect(['recovered', 'blocked']).toContain(spin.branch);
      page = spin.target;

      const popup = acceptOpener(page, '#popup', {
        url: /opened new tab [0-9A-Fa-f]+ http:\/\/127\.0\.0\.1:\d+\/inner2/,
      });
      expect(['recovered', 'blocked']).toContain(popup.branch);

      // A response slower than the old 3s empty-url deadline still commits.
      // The original tab stays usable. This must not be Kind: opener-blocked.
      const slow = run(['click', page, '#slow'], 20000);
      const slowText = `${slow.stdout}\n${slow.stderr}`;
      expect(slow.status, slowText).toBe(0);
      expect(slow.stdout).toMatch(/opened new tab [0-9A-Fa-f]+ http:\/\/127\.0\.0\.1:\d+\/slow/);
      expect(slowText).not.toMatch(/Kind: opener-blocked/);
      expect(slowText).not.toMatch(/Kind: popup-uncommitted/);
      expect(slowText).not.toMatch(/about:blank/);
      const afterSlow = run(['eval', page, '1+1'], 8000);
      expect(afterSlow.status, `${afterSlow.stdout}\n${afterSlow.stderr}`).toBe(0);
      expect(afterSlow.stdout.trim()).toBe('2');
    } finally {
      try { chrome.kill('SIGTERM'); } catch { /* already gone */ }
      try { server.kill('SIGTERM'); } catch { /* already gone */ }
      try { run(['stop', '--all'], 8000); } catch { /* daemon may already be gone */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile may still be closing */ }
    }
  }, 120000);
});
