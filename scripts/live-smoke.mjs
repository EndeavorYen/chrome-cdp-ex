#!/usr/bin/env node
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
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
  if (req.url?.startsWith('/api/fail')) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"ok":false,"error":"smoke diagnostic"}');
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

const doctorOut = step('doctor onboarding', () => run(['doctor']));
assertIncludes(doctorOut, 'chrome-cdp-ex doctor', 'doctor');
assertIncludes(doctorOut, 'FD limit', 'doctor fd limit');
assertIncludes(doctorOut, 'Next steps:', 'doctor next steps');
assertIncludes(doctorOut, 'cdp list', 'doctor golden path');
const perceive = step('perceive keep refs', () => run(['perceive', target, '-C', '-d', '8', '--keep-refs', '--last', '20']));
assertIncludes(perceive, 'Coords: top-level viewport CSS px', 'perceive');
assertIncludes(perceive, 'fixed', 'perceive fixed annotation');
assertIncludes(perceive, '@', 'perceive refs');
const perceiveJson = step('perceive json', () => run(['perceive', target, '--format', 'json']));
const parsedPerceive = JSON.parse(perceiveJson);
if (parsedPerceive.schema !== 'chrome-cdp-ex.perceive.v1') throw new Error(`perceive json schema mismatch:\n${perceiveJson}`);
if (parsedPerceive.viewport.coordinateSpace !== 'viewport-css-px') throw new Error(`perceive json coordinateSpace mismatch:\n${perceiveJson}`);
const frameOut = step('frame tree refs', () => run(['frame', target]));
assertIncludes(frameOut, 'Frames:', 'frame');
assertIncludes(frameOut, '@f2', 'frame child ref');
assertIncludes(frameOut, 'smoke-child', 'frame child name');

const overlayBlockedOut = step('overlay detector blocks modal', () => run(['overlay', target]));
assertIncludes(overlayBlockedOut, 'Overlay detector: blocking', 'overlay blocking');
assertIncludes(overlayBlockedOut, 'Next: cdp dismiss-modal', 'overlay dismissal hint');
step('dismiss modal', () => assertIncludes(run(['dismiss-modal', target]), 'Dismissed modal', 'dismiss-modal'));
const overlayClearOut = step('overlay detector clear', () => run(['overlay', target]));
assertIncludes(overlayClearOut, 'Overlay detector: clear', 'overlay clear');
const framePerceiveOut = step('frame-scoped perceive refs', () => run(['perceive', target, '--frame', '@f2', '-d', '4']));
assertIncludes(framePerceiveOut, 'Frame: @f2', 'perceive --frame');
assertIncludes(framePerceiveOut, 'Child action', 'perceive --frame child button');
assertIncludes(framePerceiveOut, '@f2:1', 'perceive --frame child ref');
const frameClickOut = step('frame-scoped click evidence', () => run(['click', target, '@f2:1']));
assertIncludes(frameClickOut, 'Clicked', 'click @f2:1');
assertIncludes(frameClickOut, 'click: dispatched', 'frame click action evidence');
assertIncludes(frameClickOut, 'child:clicked', 'frame click since-action evidence');
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
const diagnosticOut = step('diagnostic action evidence', () => run(['click', target, '#diagnostic']));
assertIncludes(diagnosticOut, 'Clicked', 'click #diagnostic');
assertIncludes(diagnosticOut, 'Console: 2 entries (1 error, 1 warning)', 'diagnostic console evidence');
assertIncludes(diagnosticOut, 'Console sample: [error] diagnostic error', 'diagnostic console sample');
assertIncludes(diagnosticOut, 'Network: 1 request', 'diagnostic network evidence');
assertIncludes(diagnosticOut, 'Network sample: POST /api/fail ->', 'diagnostic network sample');
if (!diagnosticOut.includes('Network: 1 request (1 failed)') && !diagnosticOut.includes('Network: 1 request (1 pending)')) {
  throw new Error(`diagnostic network evidence should classify the request as failed or pending\nOutput:\n${diagnosticOut}`);
}
const sinceActionOut = step('perceive since-action', () => run(['perceive', target, '--since-action']));
assertIncludes(sinceActionOut, 'Page:', 'perceive --since-action');
if (!sinceActionOut.includes('+++ Added') && !sinceActionOut.includes('~~~ Text nodes updated')) {
  throw new Error(`perceive --since-action should show changes from the last action\nOutput:\n${sinceActionOut}`);
}
const sessionShotOut = step('session shot attachment', () => run(['shot', target, '--quiet']));
const sessionShotPath = sessionShotOut.split('\n')[0];
if (sessionShotOut.split('\n').length !== 1 || !sessionShotPath.endsWith('.png') || !existsSync(sessionShotPath)) {
  throw new Error(`session shot --quiet should print an existing PNG path, got:\n${sessionShotOut}`);
}
const reportOut = step('session report', () => run(['report', target]));
assertIncludes(reportOut, 'Session report:', 'report');
assertIncludes(reportOut, 'Action timeline:', 'report');
assertIncludes(reportOut, 'click #combat', 'report action timeline');
assertIncludes(reportOut, 'Screenshot dir:', 'report screenshot dir');
assertIncludes(reportOut, 'Attachments:', 'report attachments');
assertIncludes(reportOut, sessionShotPath, 'report screenshot attachment');
const reportLogPath = reportOut.split('\n').find(line => line.startsWith('Log: '))?.slice(5).trim();
if (!reportLogPath || !existsSync(reportLogPath)) throw new Error(`report log path should exist\nOutput:\n${reportOut}`);
const reportLogEvents = readFileSync(reportLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (!reportLogEvents.some(event => event.kind === 'action' && event.action?.action === 'click')) {
  throw new Error(`session log should contain a click action event\nLog:\n${readFileSync(reportLogPath, 'utf8')}`);
}
if (!reportLogEvents.some(event => event.kind === 'screenshot' && event.screenshot?.path === sessionShotPath)) {
  throw new Error(`session log should contain the screenshot event\nLog:\n${readFileSync(reportLogPath, 'utf8')}`);
}
const recordActionsJson = step('record-actions json', () => run(['record-actions', target, '--format', 'json']));
const recordActions = JSON.parse(recordActionsJson);
if (recordActions.schema !== 'chrome-cdp-ex.record-actions.v1') {
  throw new Error(`record-actions json schema mismatch:\n${recordActionsJson}`);
}
if (!recordActions.actions.some(action => action.action === 'fill' && action.command?.join(' ') === 'fill #cmd look trainer' && action.replayable)) {
  throw new Error(`record-actions should include replayable fill command\nOutput:\n${recordActionsJson}`);
}
if (!recordActions.actions.some(action => action.action === 'click' && action.command?.join(' ') === 'click #combat' && action.replayable)) {
  throw new Error(`record-actions should include replayable click command\nOutput:\n${recordActionsJson}`);
}
const replayArtifactPath = resolve(profileDir, 'record-actions.json');
writeFileSync(replayArtifactPath, recordActionsJson);
const replayOut = step('replay record-actions artifact', () => run(['replay', target, '--file', replayArtifactPath], { timeout: 30000 }));
assertIncludes(replayOut, 'Replay:', 'replay');
assertIncludes(replayOut, 'fill #cmd "look trainer"', 'replay fill');
assertIncludes(replayOut, 'click #combat', 'replay click');
assertIncludes(replayOut, 'Done:', 'replay summary');
step('wait any-of', () => assertIncludes(run(['waitfor', target, '--any-of', '戰鬥勝利|戰敗|逃跑成功', '8000', '--scope', '#combat-log'], { timeout: 12000 }), '戰鬥勝利', 'waitfor --any-of'));
step('wait selector stable', () => assertIncludes(run(['waitfor', target, '--selector-stable', '#combat-log', '500', '8000'], { timeout: 12000 }), 'stable', 'waitfor --selector-stable'));
const shotOut = step('shot quiet', () => run(['shot', target, resolve(tmpdir(), 'chrome-cdp-ex-smoke.png'), '--quiet']));
if (shotOut.split('\n').length !== 1 || !shotOut.endsWith('.png')) throw new Error(`shot --quiet should print only path, got:\n${shotOut}`);
step('prepare checkpoint state', () => run(['eval', target, 'localStorage.setItem("cdpSmokeCheckpoint","local-ok"); sessionStorage.setItem("cdpSmokeCheckpoint","session-ok"); "ok"']));
const checkpointJson = step('checkpoint json', () => run(['checkpoint', target, '--format', 'json']));
const checkpoint = JSON.parse(checkpointJson);
if (checkpoint.schema !== 'chrome-cdp-ex.checkpoint.v1') {
  throw new Error(`checkpoint json schema mismatch:\n${checkpointJson}`);
}
if (checkpoint.page.url !== url) throw new Error(`checkpoint should capture current URL ${url}\nOutput:\n${checkpointJson}`);
if (checkpoint.storage?.localStorage?.cdpSmokeCheckpoint !== 'local-ok') {
  throw new Error(`checkpoint should capture localStorage state\nOutput:\n${checkpointJson}`);
}
if (checkpoint.storage?.sessionStorage?.cdpSmokeCheckpoint !== 'session-ok') {
  throw new Error(`checkpoint should capture sessionStorage state\nOutput:\n${checkpointJson}`);
}
const checkpointPath = resolve(profileDir, 'checkpoint.json');
writeFileSync(checkpointPath, checkpointJson);
step('mutate checkpoint state before restore', () => run(['eval', target, 'localStorage.setItem("cdpSmokeCheckpoint","mutated"); sessionStorage.setItem("cdpSmokeCheckpoint","mutated"); "ok"']));
const restoreOut = step('restore checkpoint artifact', () => run(['restore', target, '--file', checkpointPath], { timeout: 30000 }));
assertIncludes(restoreOut, 'Restored checkpoint', 'restore');
assertIncludes(restoreOut, 'cookies:', 'restore cookie summary');
const restoredStorageJson = step('verify restored storage', () => run(['eval', target, 'JSON.stringify({local:localStorage.getItem("cdpSmokeCheckpoint"),session:sessionStorage.getItem("cdpSmokeCheckpoint")})']));
const restoredStorage = JSON.parse(restoredStorageJson);
if (restoredStorage.local !== 'local-ok' || restoredStorage.session !== 'session-ok') {
  throw new Error(`restore should reinstate checkpoint storage\nOutput:\n${restoredStorageJson}`);
}

console.log(`Live smoke passed using ${browserName} on CDP_PORT=${port}`);
console.log(results.join('\n'));
cleanup();
process.exit(0);
