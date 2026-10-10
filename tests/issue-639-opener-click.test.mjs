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
createServer((req, res) => {
  const path = String(req.url || '/').split('?')[0];
  const body = path === '/host.html' ? host : path === '/inner2' ? inner : null;
  if (!body) { res.writeHead(404); res.end('no'); return; }
  const send = () => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  // /inner2 is slow on purpose: Chrome 154 publishes the popup with an empty
  // URL before the response arrives. The click must wait for /inner2.
  if (path === '/inner2') setTimeout(send, 1500);
  else send();
}).listen(port, '127.0.0.1', () => process.stdout.write('ready\\n'));
`;

const HOST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>host</title>
<style>button{display:block;width:240px;height:36px;margin:16px 40px}</style>
<button id="popup" onclick="window.open('/inner2','_blank')">Open inner2</button>
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
        if (chrome.exitCode != null) break;
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

      const spin = run(['click', target, '#spin'], 15000);
      expect(spin.status, `${spin.stdout}\n${spin.stderr}`).toBe(0);
      expect(spin.stdout).toMatch(/opened new tab [0-9A-Fa-f]+ /);
      expect(spin.stdout).not.toMatch(/Kind: no-input-events/);
      expect(spin.stdout).not.toMatch(/jsclick/);
      const unstuck = run(['eval', target, '1+1'], 8000);
      expect(unstuck.status, `${unstuck.stdout}\n${unstuck.stderr}`).toBe(0);
      expect(unstuck.stdout.trim()).toBe('2');
      const spinTab = spin.stdout.match(/opened new tab ([0-9A-Fa-f]+)/)?.[1];
      if (spinTab) run(['closetab', spinTab], 8000);

      // Chrome stable 154 can leave this opener unusable (#677). A committed URL
      // is still reported. Either result is accepted; the stuck receipt must not
      // send the agent back to the hung tab.
      const click = run(['click', target, '#popup'], 20000);
      const clickText = `${click.stdout}\n${click.stderr}`;
      if (click.status === 0 && /opened new tab [0-9A-Fa-f]+ http:\/\/127\.0\.0\.1:\d+\/inner2/.test(click.stdout)) {
        expect(click.stdout).not.toMatch(/about:blank/);
        const after = run(['eval', target, '1+1'], 8000);
        expect(after.status, `${after.stdout}\n${after.stderr}`).toBe(0);
        expect(after.stdout.trim()).toBe('2');
        const popup = click.stdout.match(/opened new tab ([0-9A-Fa-f]+)/)?.[1];
        if (popup) run(['closetab', popup], 8000);
      } else {
        expect(click.status, clickText).not.toBe(0);
        expect(clickText).toMatch(/the original tab is no longer usable/);
        expect(clickText).toMatch(/Reopen the tab or restart the browser/);
        expect(clickText).toMatch(/Kind: opener-blocked/);
        expect(clickText).toMatch(/Next: cdp open /);
        expect(clickText).not.toMatch(/perceive/);
        expect(clickText).not.toMatch(/opened new tab/);
        expect(clickText).not.toMatch(/about:blank/);
        expect(clickText).not.toMatch(/closetab/);
      }
    } finally {
      try { chrome.kill('SIGTERM'); } catch { /* already gone */ }
      try { server.kill('SIGTERM'); } catch { /* already gone */ }
      try { run(['stop', '--all'], 8000); } catch { /* daemon may already be gone */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile may still be closing */ }
    }
  }, 90000);
});
