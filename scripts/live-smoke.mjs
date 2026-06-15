#!/usr/bin/env node
import { createServer } from 'http';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cdp = resolve(repoRoot, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const page = resolve(__dirname, 'smoke-page.html');
const port = Number(process.env.CDP_SMOKE_PORT || 9333);
const serverPort = Number(process.env.CDP_SMOKE_HTTP_PORT || 41737);

const browserCandidates = [
  ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge'],
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
  ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'brave'],
  ['/usr/bin/google-chrome', 'chrome'],
  ['/usr/bin/chromium', 'chromium'],
  ['/usr/bin/microsoft-edge', 'edge'],
].filter(([p]) => existsSync(p));

function skip(reason) {
  console.log(`SKIP live smoke: ${reason}`);
  process.exit(0);
}

if (!existsSync(cdp)) skip(`cdp script not found: ${cdp}`);
if (!existsSync(page)) skip(`smoke page not found: ${page}`);
if (browserCandidates.length === 0) skip('no supported Chrome/Edge/Brave browser binary found');

const [browserPath, browserName] = browserCandidates[0];
const profileDir = mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-smoke-${browserName}-`));
let browser;
let server;

function cleanup() {
  if (browser && !browser.killed) browser.kill('SIGTERM');
  if (server) server.close();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/smoke-page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(page));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolveServer, reject) => {
  server.once('error', reject);
  server.listen(serverPort, '127.0.0.1', resolveServer);
});

const url = `http://127.0.0.1:${serverPort}/smoke-page.html`;
browser = spawn(browserPath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  url,
], { stdio: 'ignore' });
browser.unref();

const env = { ...process.env, CDP_PORT: String(port) };
function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [cdp, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: opts.timeout || 20000 });
  if (res.status !== 0) {
    throw new Error(`cdp ${args.join(' ')} failed\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return (res.stdout || '').trim();
}
function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`${label} missing ${JSON.stringify(needle)}\nOutput:\n${text}`);
}

// Wait for /json/version to become reachable via cdp list.
let list = '';
for (let i = 0; i < 30; i++) {
  const res = spawnSync(process.execPath, [cdp, 'list'], { cwd: repoRoot, env, encoding: 'utf8', timeout: 5000 });
  if (res.status === 0 && res.stdout.includes('chrome-cdp-ex long-session smoke')) {
    list = res.stdout.trim();
    break;
  }
  await new Promise(r => setTimeout(r, 300));
}
if (!list) throw new Error('Browser did not become reachable via cdp list');
const target = list.split(/\s+/)[0];

const results = [];
function step(name, fn) {
  const out = fn();
  results.push(`PASS ${name}`);
  return out;
}

step('doctor', () => assertIncludes(run(['doctor']), 'chrome-cdp-ex doctor', 'doctor'));
const perceive = step('perceive keep refs', () => run(['perceive', target, '-C', '-d', '8', '--keep-refs', '--last', '20']));
assertIncludes(perceive, 'Coords: viewport CSS px', 'perceive');
assertIncludes(perceive, 'fixed', 'perceive fixed annotation');
assertIncludes(perceive, '@', 'perceive refs');
const perceiveJson = step('perceive json', () => run(['perceive', target, '--format', 'json']));
const parsedPerceive = JSON.parse(perceiveJson);
if (parsedPerceive.schema !== 'chrome-cdp-ex.perceive.v1') throw new Error(`perceive json schema mismatch:\n${perceiveJson}`);
if (parsedPerceive.viewport.coordinateSpace !== 'viewport-css-px') throw new Error(`perceive json coordinateSpace mismatch:\n${perceiveJson}`);

step('dismiss modal', () => assertIncludes(run(['dismiss-modal', target]), 'Dismissed modal', 'dismiss-modal'));
const fillOut = step('fill action evidence', () => run(['fill', target, '#cmd', 'look trainer']));
assertIncludes(fillOut, 'Filled', 'fill');
assertIncludes(fillOut, 'fill: dispatched', 'fill action evidence');
const pressOut = step('press c', () => run(['press', target, 'c']));
assertIncludes(pressOut, 'Pressed c', 'press c');
assertIncludes(pressOut, 'press: dispatched', 'press action evidence');
const injectOut = step('inject action evidence', () => run(['inject', target, '--css', 'body { outline: 1px solid rgb(1, 2, 3); }']));
assertIncludes(injectOut, 'inject-', 'inject');
assertIncludes(injectOut, 'inject: dispatched', 'inject action evidence');
step('text auto', () => assertIncludes(run(['text', target, '--auto']), 'chrome-cdp-ex long-session smoke', 'text --auto'));
step('text fallback', () => assertIncludes(run(['text', target, '[role="region"][aria-label*="事件"], [class*=MainStage], main']), '歷史訊息', 'text fallback'));
const clickOut = step('combat click', () => run(['click', target, '#combat']));
assertIncludes(clickOut, 'Clicked', 'click #combat');
assertIncludes(clickOut, 'click: dispatched', 'click action evidence');
const sinceActionOut = step('perceive since-action', () => run(['perceive', target, '--since-action']));
assertIncludes(sinceActionOut, 'Page:', 'perceive --since-action');
if (!sinceActionOut.includes('+++ Added') && !sinceActionOut.includes('~~~ Text nodes updated')) {
  throw new Error(`perceive --since-action should show changes from the last action\nOutput:\n${sinceActionOut}`);
}
const reportOut = step('session report', () => run(['report', target]));
assertIncludes(reportOut, 'Session report:', 'report');
assertIncludes(reportOut, 'Action timeline:', 'report');
assertIncludes(reportOut, 'click #combat', 'report action timeline');
step('wait any-of', () => assertIncludes(run(['waitfor', target, '--any-of', '戰鬥勝利|戰敗|逃跑成功', '8000', '--scope', '#combat-log'], { timeout: 12000 }), '戰鬥勝利', 'waitfor --any-of'));
step('wait selector stable', () => assertIncludes(run(['waitfor', target, '--selector-stable', '#combat-log', '500', '8000'], { timeout: 12000 }), 'stable', 'waitfor --selector-stable'));
const shotOut = step('shot quiet', () => run(['shot', target, resolve(tmpdir(), 'chrome-cdp-ex-smoke.png'), '--quiet']));
if (shotOut.split('\n').length !== 1 || !shotOut.endsWith('.png')) throw new Error(`shot --quiet should print only path, got:\n${shotOut}`);

console.log(`Live smoke passed using ${browserName} on CDP_PORT=${port}`);
console.log(results.join('\n'));
cleanup();
process.exit(0);
