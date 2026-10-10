#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { detectBrowserPath } from '../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cdp = resolve(repoRoot, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const page = resolve(__dirname, 'smoke-page.html');
const port = Number(process.env.CDP_SMOKE_PORT || 9333);
const serverPort = Number(process.env.CDP_SMOKE_HTTP_PORT || 41737);

// CDP_SMOKE_BROWSER=<path> runs the smoke on any Chromium build (e.g. a Playwright download)
// when no system browser is installed. Otherwise the smoke looks where spawn-debug-browser looks
// (standard install folders on macOS, Linux and Windows, then PATH).
const browserOrder = process.platform === 'darwin' ? ['edge', 'chrome', 'brave'] : ['chrome', 'edge', 'brave'];
const browserCandidates = [
  ...(process.env.CDP_SMOKE_BROWSER ? [[process.env.CDP_SMOKE_BROWSER, 'chromium']] : []),
  ...browserOrder.map(name => [detectBrowserPath(name), name]),
].filter(([p]) => p && existsSync(p));

function skip(reason) {
  console.log(`SKIP live smoke: ${reason}`);
  process.exit(0);
}

if (!existsSync(cdp)) skip(`cdp script not found: ${cdp}`);
if (!existsSync(page)) skip(`smoke page not found: ${page}`);
if (browserCandidates.length === 0) skip('no supported Chrome/Edge/Brave browser binary found');

const [browserPath, browserName] = browserCandidates[0];
// Never drive a browser the user already has on this port: the smoke clicks, fills and navigates.
try {
  await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
  skip(`port ${port} already has a CDP endpoint; set CDP_SMOKE_PORT to a free port`);
} catch {}
const profileDir = mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-smoke-${browserName}-`));
// Endpoint records, page caches and daemon sockets stay in the throwaway profile dir, not the
// user's real runtime dir, where later doctor/list runs would trust the smoke's records.
const runtimeDir = resolve(profileDir, 'runtime');
mkdirSync(runtimeDir, { recursive: true });
const uploadFixturePath = resolve(profileDir, 'upload-fixture.txt');
const uploadJsonFixturePath = resolve(profileDir, 'upload-json-fixture.txt');
writeFileSync(uploadFixturePath, 'chrome-cdp-ex upload smoke fixture\n');
writeFileSync(uploadJsonFixturePath, 'chrome-cdp-ex upload JSON smoke fixture\n');
let browser;
let server;

function cleanup() {
  if (browser && !browser.killed) browser.kill('SIGTERM');
  if (server && !server.killed) server.kill('SIGTERM');
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// The fixture server has to accept Chrome's reload request while `cdp reload`
// is blocked in spawnSync. An in-process server never sees that request, so
// the navigation does not commit.
const smokeHttpServer = `
import { createServer } from 'http';
import { readFileSync } from 'fs';
const [pagePath, portRaw] = process.argv.slice(1);
const httpServer = createServer((req, res) => {
  const path = String(req.url || '/').split('?')[0];
  if (path === '/' || path === '/smoke-page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(pagePath));
    return;
  }
  if (path.startsWith('/api/fail')) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"ok":false,"error":"smoke diagnostic"}');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
httpServer.listen(Number(portRaw), '127.0.0.1', () => {
  process.stdout.write('ready\\n');
});
`;
server = spawn(process.execPath, ['--input-type=module', '-e', smokeHttpServer, page, String(serverPort)], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolveServer, rejectServer) => {
  let buf = '';
  const timer = setTimeout(() => rejectServer(new Error('smoke HTTP server did not start')), 5000);
  const fail = (error) => {
    clearTimeout(timer);
    rejectServer(error);
  };
  server.stdout.on('data', (chunk) => {
    buf += chunk;
    if (buf.includes('ready')) {
      clearTimeout(timer);
      resolveServer();
    }
  });
  server.once('error', fail);
  server.once('exit', (code) => fail(new Error(`smoke HTTP server exited before ready (${code})`)));
});

const url = `http://127.0.0.1:${serverPort}/smoke-page.html`;
browser = spawn(browserPath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  // The page's fixed .sidebar covers the main column's buttons below about 1100 px (headless
  // defaults to 800x600), so real mouse clicks would land on the sidebar.
  '--window-size=1280,900',
  // Background mode is the default (#488), so no command raises this window. Like
  // spawn-debug-browser, keep Windows from marking it hidden while other windows cover it; a hidden
  // tab drops Input.* events and the click steps would fail with no-input-events.
  '--disable-features=CalculateNativeWinOcclusion',
  // A headed browser aborts at once on Linux without a display.
  // CDP_SMOKE_HEADLESS=1 keeps the smoke browser off a shared desktop on any platform.
  ...((process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    || /^(1|true|yes|on)$/i.test(process.env.CDP_SMOKE_HEADLESS || '') ? ['--headless=new'] : []),
  // Opt-in for hosts whose kernel blocks Chromium's sandbox (Ubuntu AppArmor userns rules).
  ...(/^(1|true|yes|on)$/i.test(process.env.CDP_SMOKE_NO_SANDBOX || '') ? ['--no-sandbox'] : []),
  url,
], { stdio: 'ignore' });
browser.unref();

const env = {
  ...process.env,
  CDP_PORT: String(port),
  ...(process.platform === 'win32' ? { LOCALAPPDATA: runtimeDir } : { XDG_RUNTIME_DIR: runtimeDir }),
};
function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [cdp, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: opts.timeout || 20000 });
  if (res.status !== 0) {
    throw new Error(`cdp ${args.join(' ')} failed${res.error ? ` (${res.error.message})` : ''}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return (res.stdout || '').trim();
}
function runFailure(args, opts = {}) {
  const res = spawnSync(process.execPath, [cdp, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: opts.timeout || 20000 });
  if (res.status === 0) {
    throw new Error(`cdp ${args.join(' ')} should have failed\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return `${res.stdout || ''}${res.stderr || ''}`.trim();
}
// A failed action exits 1 but still prints its JSON evidence on stdout.
function runFailureStdout(args, opts = {}) {
  const res = spawnSync(process.execPath, [cdp, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: opts.timeout || 20000 });
  if (res.status === 0) {
    throw new Error(`cdp ${args.join(' ')} should have failed\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return (res.stdout || '').trim();
}
function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`${label} missing ${JSON.stringify(needle)}\nOutput:\n${text}`);
}

// #648: Next follows the failed-request receipt. A body already on the receipt
// points at the page. An unreadable body points at `netlog <target> --id N --body`.
// A request still pending after settle has no failed line; Next stays `perceive`.
function diagnosticFailedRequestNext(targetPrefix, failedRequests, { pending = false } = {}) {
  if (pending) return `cdp perceive ${targetPrefix}`;
  const list = Array.isArray(failedRequests) ? failedRequests : [];
  const unread = list.find(item => item && !item.errorText && !item.body);
  if (list.length > 0 && !unread) return `cdp perceive ${targetPrefix} --since-action`;
  if (unread && unread.id != null) return `cdp netlog ${targetPrefix} --id ${unread.id} --body`;
  return `cdp netlog ${targetPrefix}`;
}

function diagnosticFailedRequestFromLine(line) {
  const text = String(line || '');
  const idMatch = /^Request failed: #(\d+)\s/.exec(text);
  const bodyAt = text.indexOf('; body: ');
  return {
    id: idMatch ? Number(idMatch[1]) : null,
    errorText: / → failed \(/.test(text) ? 'failed' : null,
    body: bodyAt === -1 ? null : { text: text.slice(bodyAt + '; body: '.length) },
  };
}

// Wait for /json/version to become reachable via cdp list. A fresh profile on a busy host can take
// well over 15 s to commit the first page, so wait on a deadline rather than a fixed retry count.
let list = '';
const reachDeadline = Date.now() + Number(process.env.CDP_SMOKE_START_TIMEOUT_MS || 60000);
while (Date.now() < reachDeadline) {
  const res = spawnSync(process.execPath, [cdp, 'list'], { cwd: repoRoot, env, encoding: 'utf8', timeout: 5000 });
  if (res.status === 0 && res.stdout.includes('chrome-cdp-ex long-session smoke')) {
    list = res.stdout.trim();
    break;
  }
  await new Promise(r => setTimeout(r, 300));
}
if (!list) {
  const last = spawnSync(process.execPath, [cdp, 'list'], { cwd: repoRoot, env, encoding: 'utf8', timeout: 5000 });
  throw new Error(`Browser did not become reachable via cdp list\nexit=${last.status}\n${last.stdout}${last.stderr}`);
}
const target = list.split(/\s+/)[0];

const results = [];
function step(name, fn) {
  const out = fn();
  results.push(`PASS ${name}`);
  return out;
}

const listJson = step('list json', () => run(['list', '--format', 'json']));
const parsedList = JSON.parse(listJson);
if (parsedList.schema !== 'chrome-cdp-ex.list.v1' || !Array.isArray(parsedList.pages) || !parsedList.pages.some(page => page.targetPrefix === target)) {
  throw new Error(`list json should include the smoke target prefix\nOutput:\n${listJson}`);
}
if (!parsedList.nextSteps?.some(step => step.includes('text <target-from-list> --auto'))) {
  throw new Error(`list json should include executable text --auto next step\nOutput:\n${listJson}`);
}
if (parsedList.recommendation?.source !== 'golden-path' || parsedList.recommendation?.run !== 'cdp list --format json') {
  throw new Error(`list json should include golden-path list recommendation\nOutput:\n${listJson}`);
}
const doctorOut = step('doctor onboarding', () => run(['doctor']));
// Compact doctor (#375): one line per check, then a single Next.
assertIncludes(doctorOut, `CDP: 127.0.0.1:${port}`, 'doctor cdp check');
assertIncludes(doctorOut, 'Next: cdp list', 'doctor golden path');
const doctorJson = step('doctor onboarding json', () => run(['doctor', '--format', 'json']));
const parsedDoctor = JSON.parse(doctorJson);
if (parsedDoctor.schema !== 'chrome-cdp-ex.doctor.v1' || !Array.isArray(parsedDoctor.checks) || !Array.isArray(parsedDoctor.nextSteps)) {
  throw new Error(`doctor json schema mismatch:\n${doctorJson}`);
}
if (!parsedDoctor.recommendation?.source || !parsedDoctor.recommendation?.run) {
  throw new Error(`doctor json should include a runnable onboarding recommendation:\n${doctorJson}`);
}
// With CDP up, doctor's one next step is `cdp list` (pick a target); perceive follows on the golden path.
if (!JSON.stringify(parsedDoctor.wizard?.goldenPath || '').includes('perceive') || !parsedDoctor.nextSteps.includes('cdp list')) {
  throw new Error(`doctor json should include the perceive golden path and a cdp list next step:\n${doctorJson}`);
}
const fdWarning = parsedDoctor.recommendation?.warnings?.find(warning => warning.label === 'FD limit');
if (fdWarning) {
  const fdCommands = fdWarning.commands?.map(command => command.command) || [];
  if (!fdCommands.includes('ulimit -n 4096')) {
    throw new Error(`doctor json FD warning should include current-shell ulimit recovery:\n${doctorJson}`);
  }
  if (process.platform === 'darwin' && !fdCommands.includes('sudo launchctl limit maxfiles 65536 200000')) {
    throw new Error(`doctor json FD warning should include macOS launchctl recovery:\n${doctorJson}`);
  }
}
const openJson = step('open json', () => run(['open', 'about:blank', '--format', 'json'], { timeout: 70000 }));
const parsedOpen = JSON.parse(openJson);
if (parsedOpen.schema !== 'chrome-cdp-ex.open.v1' || !parsedOpen.targetPrefix || parsedOpen.url !== 'about:blank') {
  throw new Error(`open json schema/target mismatch:\n${openJson}`);
}
if (parsedOpen.attached !== true || parsedOpen.approval !== 'approved') {
  throw new Error(`open json should attach in the smoke debug browser:\n${openJson}`);
}
if (!parsedOpen.nextSteps?.some(nextStep => nextStep.startsWith(`cdp text ${parsedOpen.targetPrefix}`) || nextStep.startsWith(`cdp perceive ${parsedOpen.targetPrefix}`))) {
  throw new Error(`open json should include executable read-page next step:\n${openJson}`);
}
const expectedOpenRecommendationPrefix = parsedOpen.autoPerceive?.ok
  ? `cdp click ${parsedOpen.targetPrefix}`
  : `cdp text ${parsedOpen.targetPrefix}`;
if (parsedOpen.recommendation?.source !== 'golden-path' || !parsedOpen.recommendation?.run?.startsWith(expectedOpenRecommendationPrefix)) {
  throw new Error(`open json should recommend the next golden-path command:\n${openJson}`);
}
step('close open json tab', () => run(['closetab', parsedOpen.targetPrefix]));
const cliErrorOut = step('actionable cli error', () => runFailure(['perceive']));
assertIncludes(cliErrorOut, 'Error: target ID required', 'targetless perceive error');
assertIncludes(cliErrorOut, 'Recovery:', 'targetless perceive recovery block');
assertIncludes(cliErrorOut, 'Kind: target-resolution', 'targetless perceive recovery kind');
assertIncludes(cliErrorOut, 'Run: cdp list', 'targetless perceive recovery run');
assertIncludes(cliErrorOut, 'Next: cdp list', 'targetless perceive next step');
const cliJsonErrorOut = step('actionable cli json error', () => runFailure(['perceive', '--format', 'json']));
const parsedCliJsonError = JSON.parse(cliJsonErrorOut);
if (parsedCliJsonError.schema !== 'chrome-cdp-ex.cli-error.v1' || parsedCliJsonError.ok !== false) {
  throw new Error(`targetless perceive --format json should return CLI error JSON:\n${cliJsonErrorOut}`);
}
if (parsedCliJsonError.recovery?.kind !== 'target-resolution' || !parsedCliJsonError.nextSteps?.some(step => step.startsWith('cdp list'))) {
  throw new Error(`targetless perceive --format json should include structured recovery next steps:\n${cliJsonErrorOut}`);
}
const perceive = step('perceive keep refs', () => run(['perceive', target, '-C', '-d', '8', '--keep-refs', '--last', '20']));
assertIncludes(perceive, 'Coords: top-level viewport CSS px', 'perceive');
assertIncludes(perceive, 'fixed', 'perceive fixed annotation');
assertIncludes(perceive, '@', 'perceive refs');
const fillCliJsonErrorOut = step('validation cli json error', () => runFailure(['fill', target, '--format', 'json']));
const parsedFillCliJsonError = JSON.parse(fillCliJsonErrorOut);
if (parsedFillCliJsonError.schema !== 'chrome-cdp-ex.cli-error.v1' || parsedFillCliJsonError.recovery?.kind !== 'usage') {
  throw new Error(`fill --format json without selector should return usage recovery JSON:\n${fillCliJsonErrorOut}`);
}
if (!parsedFillCliJsonError.nextSteps?.includes(`cdp fill ${target} <selector|@ref> <text>`)) {
  throw new Error(`fill --format json validation failure should include a runnable command template:\n${fillCliJsonErrorOut}`);
}
const perceiveJson = step('perceive json', () => run(['perceive', target, '--format', 'json']));
const parsedPerceive = JSON.parse(perceiveJson);
if (parsedPerceive.schema !== 'chrome-cdp-ex.perceive.v1') throw new Error(`perceive json schema mismatch:\n${perceiveJson}`);
if (parsedPerceive.viewport.coordinateSpace !== 'viewport-css-px') throw new Error(`perceive json coordinateSpace mismatch:\n${perceiveJson}`);
if (parsedPerceive.recommendation?.source !== 'golden-path' || !parsedPerceive.recommendation?.run?.startsWith(`cdp click ${target}`)) {
  throw new Error(`perceive json should recommend action/evidence/report continuation:\n${perceiveJson}`);
}
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

const asyncEvalOut = step('multi-statement async eval final value', () => run([
  'eval', target, 'const value = await Promise.resolve(42); value',
]));
if (asyncEvalOut !== '42') throw new Error(`multi-statement async eval should return 42, got:\n${asyncEvalOut}`);

step('seed console baseline', () => run(['eval', target, 'console.error("baseline-old-error"); "seeded"']));
const consoleClearOut = step('console clear baseline', () => run(['console', target, '--clear']));
assertIncludes(consoleClearOut, 'Console baseline cleared', 'console --clear');
const consoleEmptyOut = step('console baseline empty', () => run(['console', target, '--all']));
assertIncludes(consoleEmptyOut, 'Console buffer is empty', 'console after clear');
const unknownConsoleOut = step('console rejects unknown flags', () => runFailure(['console', target, '--wat']));
assertIncludes(unknownConsoleOut, 'Supported options', 'console unknown flag');
step('seed post-baseline console', () => run(['eval', target, 'console.error("after-clear-error"); "seeded"']));
const consoleAfterClearOut = step('console collects after baseline', () => run(['console', target, '--all']));
assertIncludes(consoleAfterClearOut, 'after-clear-error', 'console after baseline entry');
if (consoleAfterClearOut.includes('baseline-old-error')) {
  throw new Error(`console baseline leaked an old entry:\n${consoleAfterClearOut}`);
}

const resetLoop = () => run(['eval', target, '(function(){document.querySelectorAll(".battle-end").forEach(el=>el.remove()); const loopStatus=document.querySelector("#loop-status"); loopStatus.dataset.count="0"; loopStatus.textContent="loop:0"; return "reset";})()']);
step('reset bounded loop fixture', resetLoop);
const repeatUntilOut = step('repeat until selector', () => run([
  'repeat', target, '6', 'click', '#loop-attack', '--until-selector', '.battle-end',
]));
assertIncludes(repeatUntilOut, 'Condition satisfied after iteration 3/6', 'repeat early success');
const flowAssertOut = step('flow assertion postconditions', () => run([
  'flow', target, 'assert selector .battle-end; assert text Battle complete',
]));
assertIncludes(flowAssertOut, 'Assertion passed: selector .battle-end exists', 'flow selector assertion');
assertIncludes(flowAssertOut, 'Assertion passed: text includes "Battle complete"', 'flow text assertion');
step('reset bounded loop fixture for cap', resetLoop);
const repeatCapOut = step('repeat condition cap failure', () => runFailure([
  'repeat', target, '2', 'click', '#loop-attack', '--until-text', 'Never complete',
]));
assertIncludes(repeatCapOut, '[1/2] ok:', 'repeat cap transcript');
assertIncludes(repeatCapOut, 'condition not satisfied after 2 iterations', 'repeat cap failure');

function smoothTargetRef() {
  const out = run(['perceive', target, '-i', '-d', '8']);
  const line = out.split('\n').find(candidate => candidate.includes('Smooth target'));
  const ref = line?.match(/@\d+/)?.[0];
  if (!ref) throw new Error(`smooth target ref missing:\n${out}`);
  return ref;
}
function verifySmoothClick(viewport) {
  run(['viewport', target, viewport]);
  run(['eval', target, 'window.scrollTo(0,0); document.querySelector("#smooth-status").textContent="smooth:not-clicked"; "reset"']);
  const ref = smoothTargetRef();
  const click = run(['click', target, ref]);
  assertIncludes(click, 'Clicked', `smooth click ${viewport}`);
  const status = run(['eval', target, 'document.querySelector("#smooth-status").textContent']);
  if (status !== 'smooth:clicked') throw new Error(`one ${ref} click did not update smooth target at ${viewport}: ${status}`);
}
step('smooth-scroll @ref desktop', () => verifySmoothClick('1280x720'));
step('smooth-scroll @ref mobile', () => verifySmoothClick('375x812'));
step('restore desktop viewport', () => run(['viewport', target, '1280x720']));
step('restore top-level scroll baseline', () => run(['eval', target, 'document.documentElement.style.scrollBehavior="auto"; window.scrollTo(0,0); "restored"']));

const throttleOut = step('network throttle slow-3g', () => run(['throttle', target, 'slow-3g']));
assertIncludes(throttleOut, 'Network throttle: slow-3g', 'throttle');
assertIncludes(throttleOut, 'Next: cdp throttle', 'throttle reset hint');
const throttleStatusJson = step('network throttle json status', () => run(['throttle', target, '--format', 'json']));
const throttleStatus = JSON.parse(throttleStatusJson);
if (throttleStatus.schema !== 'chrome-cdp-ex.throttle.v1' || throttleStatus.profile !== 'slow-3g') {
  throw new Error(`throttle json status mismatch:\n${throttleStatusJson}`);
}
const throttleOffOut = step('network throttle off', () => run(['throttle', target, 'off']));
assertIncludes(throttleOffOut, 'Network throttle: off', 'throttle off');
assertIncludes(throttleOffOut, 'Network conditions reset', 'throttle reset');
const mockOut = step('network mock add', () => run(['mock', target, 'add', '**/api/mock*', '--status', '418', '--body', '{"ok":"mocked"}', '--content-type', 'application/json']));
assertIncludes(mockOut, 'Network mock: 1 rule', 'mock add');
assertIncludes(mockOut, '**/api/mock* -> 418', 'mock rule');
const mockedFetchJson = step('network mock fulfilled fetch', () => run(['eval', target, 'JSON.stringify(await fetch("/api/mock").then(async r => ({status:r.status,type:r.headers.get("content-type"),text:await r.text()})))']));
const mockedFetch = JSON.parse(mockedFetchJson);
if (mockedFetch.status !== 418 || mockedFetch.text !== '{"ok":"mocked"}' || !mockedFetch.type.includes('application/json')) {
  throw new Error(`mocked fetch mismatch:\n${mockedFetchJson}`);
}
const mockStatusJson = step('network mock json status', () => run(['mock', target, '--format', 'json']));
const mockStatus = JSON.parse(mockStatusJson);
if (mockStatus.schema !== 'chrome-cdp-ex.mock.v1' || mockStatus.rules?.[0]?.hits !== 1) {
  throw new Error(`mock json status mismatch:\n${mockStatusJson}`);
}
const mockClearOut = step('network mock clear', () => run(['mock', target, 'clear']));
assertIncludes(mockClearOut, 'Network mock: off', 'mock clear');
const clockFreezeOut = step('clock freeze', () => run(['clock', target, 'freeze', '--at', '2020-01-02T03:04:05.000Z']));
assertIncludes(clockFreezeOut, 'Clock: frozen at 2020-01-02T03:04:05.000Z', 'clock freeze');
const frozenClockJson = step('clock freeze Date.now', () => run(['eval', target, 'JSON.stringify({now:Date.now(),iso:new Date().toISOString()})']));
const frozenClock = JSON.parse(frozenClockJson);
if (frozenClock.now !== 1577934245000 || frozenClock.iso !== '2020-01-02T03:04:05.000Z') {
  throw new Error(`frozen clock mismatch:\n${frozenClockJson}`);
}
const clockStatusJson = step('clock json status', () => run(['clock', target, '--format', 'json']));
const clockStatus = JSON.parse(clockStatusJson);
if (clockStatus.schema !== 'chrome-cdp-ex.clock.v1' || clockStatus.profile !== 'freeze' || clockStatus.atMs !== 1577934245000) {
  throw new Error(`clock json status mismatch:\n${clockStatusJson}`);
}
const clockOffsetOut = step('clock offset', () => run(['clock', target, 'offset', '--ms', '3600000']));
assertIncludes(clockOffsetOut, 'Clock: offset +3600000ms', 'clock offset');
const offsetClockJson = step('clock offset Date.now', () => run(['eval', target, 'JSON.stringify({delta: Date.now() - window.__cdpClockOriginals.Date.now()})']));
const offsetClock = JSON.parse(offsetClockJson);
if (offsetClock.delta < 3599000 || offsetClock.delta > 3601000) {
  throw new Error(`clock offset should be about 3600000ms\nOutput:\n${offsetClockJson}`);
}
const clockResetOut = step('clock reset', () => run(['clock', target, 'reset']));
assertIncludes(clockResetOut, 'Clock: real time', 'clock reset');
const framePerceiveOut = step('frame-scoped perceive refs', () => run(['perceive', target, '--frame', '@f2', '-d', '4']));
assertIncludes(framePerceiveOut, 'Frame: @f2', 'perceive --frame');
assertIncludes(framePerceiveOut, 'Child action', 'perceive --frame child button');
assertIncludes(framePerceiveOut, '@f2:1', 'perceive --frame child ref');
const frameClickOut = step('frame-scoped click evidence', () => run(['click', target, '@f2:1']));
assertIncludes(frameClickOut, 'Clicked', 'click @f2:1');
assertIncludes(frameClickOut, 'Next:', 'frame click next command');
const diffBaselineOut = step('diff-shot baseline', () => run(['diff-shot', target]));
assertIncludes(diffBaselineOut, 'Diff-shot baseline captured', 'diff-shot baseline');
assertIncludes(diffBaselineOut, 'Next: cdp diff-shot', 'diff-shot next step');
const fillOut = step('fill action evidence', () => run(['fill', target, '#cmd', 'look trainer']));
assertIncludes(fillOut, 'Filled', 'fill');
assertIncludes(fillOut, 'Next:', 'fill next command');
const fillJsonOut = step('fill action json evidence', () => run(['fill', target, '#cmd', 'look merchant', '--format', 'json']));
const parsedFillAction = JSON.parse(fillJsonOut);
if (parsedFillAction.schema !== 'chrome-cdp-ex.fill.v1') {
  throw new Error(`fill --format json should return compact fill receipt JSON:\n${fillJsonOut}`);
}
if (parsedFillAction.value !== 'look merchant' || parsedFillAction.changed !== true) {
  throw new Error(`fill --format json should report the typed value and change:\n${fillJsonOut}`);
}
if (!Object.hasOwn(parsedFillAction, 'navigation') || parsedFillAction.navigation !== null) {
  throw new Error(`fill --format json should include a null navigation field:\n${fillJsonOut}`);
}
if (!Array.isArray(parsedFillAction.typeahead)) {
  throw new Error(`fill --format json should include a typeahead array:\n${fillJsonOut}`);
}
// #429: an explicit "" clears the field and names the previous value; a missing text stays an error.
const clearOut = step('fill "" clears a field', () => run(['fill', target, '#smoke-name', '']));
assertIncludes(clearOut, 'Cleared <INPUT> (was "Ada")', 'fill clear');
const clearAgainJson = JSON.parse(step('fill "" on an empty field json', () => run(['fill', target, '#smoke-name', '', '--format', 'json'])));
if (clearAgainJson.schema !== 'chrome-cdp-ex.fill.v1' || clearAgainJson.value !== '' || clearAgainJson.previousValue !== '') {
  throw new Error(`fill "" on an empty field should return a fill.v1 receipt with previousValue "":\n${JSON.stringify(clearAgainJson)}`);
}
assertIncludes(step('fill without text is a usage error', () => runFailure(['fill', target, '#smoke-name'])), 'text required', 'fill missing text');
// #428: a number input that rejects text is a value change, not fill-no-change, with a shell-safe Next.
const mismatchOut = step('fill rejected by number input', () => runFailure(['fill', target, '#smoke-amount', 'abc']));
assertIncludes(mismatchOut, 'Kind: fill-value-mismatch', 'fill value mismatch kind');
assertIncludes(mismatchOut, 'Value: "0.5" → "" (requested "abc"; <input type=number> rejected the text)', 'fill value mismatch value');
assertIncludes(mismatchOut, `Next: cdp eval ${target} "document.querySelector('#smoke-amount')?.value"`, 'fill value mismatch next');
// #485: a field whose name (not selector) marks it secret never echoes the typed value, in any
// receipt mode, on success or failure. The daemon's dispatch wrapper carries the decision.
const SMOKE_SECRET = 'sk-smoke-485-secret-value';
const SMOKE_REJECTED_SECRET = 'abcdef485';
const secretFillOuts = [
  step('fill secret-named field', () => run(['fill', target, '#smoke-cred', SMOKE_SECRET])),
  step('fill secret-named field json', () => run(['fill', target, '#smoke-cred', SMOKE_SECRET, '--format', 'json'])),
  step('fill secret-named field compact json', () => run(['fill', target, '#smoke-cred', SMOKE_SECRET, '--compact', '--format', 'json'])),
  step('fill secret-named field full json', () => run(['fill', target, '#smoke-cred', `${SMOKE_SECRET}-2`, '--full', '--format', 'json'])),
  step('fill secret-named field full text', () => run(['fill', target, '#smoke-cred', SMOKE_SECRET, '--full'])),
  step('fill rejected by secret-named number input json', () => runFailureStdout(['fill', target, '#smoke-code', SMOKE_REJECTED_SECRET, '--format', 'json'])),
  step('fill rejected by secret-named number input', () => runFailure(['fill', target, '#smoke-code', SMOKE_REJECTED_SECRET])),
];
for (const out of secretFillOuts) {
  if (out.includes('sk-smoke-485') || out.includes(SMOKE_REJECTED_SECRET)) throw new Error(`fill echoed a secret-named field's value:\n${out}`);
}
assertIncludes(secretFillOuts[0], 'with "<redacted>"', 'secret fill receipt');
if (JSON.parse(secretFillOuts[1]).value !== '<redacted>') throw new Error(`fill.v1 should redact a secret-named field:\n${secretFillOuts[1]}`);
if (JSON.parse(secretFillOuts[5]).effects?.failure?.kind !== 'fill-value-mismatch') {
  throw new Error(`a secret-named number input that rejects text should be a fill-value-mismatch:\n${secretFillOuts[5]}`);
}
assertIncludes(secretFillOuts[6], `Next: cdp eval ${target} "document.querySelector('#smoke-code')?.value.length"`, 'secret fill value mismatch next');
const uploadOut = step('upload action evidence', () => run(['upload', target, '#upload-file', uploadFixturePath]));
assertIncludes(uploadOut, 'Uploaded 1 file', 'upload');
assertIncludes(uploadOut, 'upload: dispatched', 'upload action evidence');
assertIncludes(uploadOut, 'upload-fixture.txt', 'upload action DOM diff');
const uploadJsonOut = step('upload action json evidence', () => run(['upload', target, '#upload-file', uploadJsonFixturePath, '--format', 'json']));
const parsedUploadAction = JSON.parse(uploadJsonOut);
if (parsedUploadAction.schema !== 'chrome-cdp-ex.action.v1' || parsedUploadAction.action !== 'upload') {
  throw new Error(`upload --format json should return action evidence JSON:\n${uploadJsonOut}`);
}
if (parsedUploadAction.dispatch?.ok !== true || parsedUploadAction.settle?.ok !== true) {
  throw new Error(`upload --format json should report dispatched and settled action:\n${uploadJsonOut}`);
}
if (!parsedUploadAction.effects?.domDiff?.includes('upload-json-fixture.txt')) {
  throw new Error(`upload --format json should include observed upload effects:\n${uploadJsonOut}`);
}
if (parsedUploadAction.recommendation?.source !== 'action-evidence' || !parsedUploadAction.nextSteps?.includes(`cdp report ${target} --format json`)) {
  throw new Error(`upload --format json should include action continuation recommendation:\n${uploadJsonOut}`);
}
const parallelUploadOut = step('parallel upload blocked', () => runFailure(['batch', target, '--parallel', `upload #upload-file ${uploadFixturePath} | summary`]));
assertIncludes(parallelUploadOut, 'batch --parallel:', 'parallel upload blocked');
assertIncludes(parallelUploadOut, 'upload', 'parallel upload blocked command name');
assertIncludes(parallelUploadOut, 'mutate shared state', 'parallel upload blocked reason');
const parallelMutatingGuards = [
  ['restore', '--json', '{}'],
  ['replay', '--json', '{"schema":"chrome-cdp-ex.record-actions.v1","actions":[]}'],
  ['cookieset', 'smoke_parallel_guard=1'],
  ['cookiedel', 'smoke_parallel_guard'],
  ['closetab'],
];
for (const [cmd, ...cmdArgs] of parallelMutatingGuards) {
  const out = step(`parallel ${cmd} blocked`, () => runFailure(['batch', target, '--parallel', `${[cmd, ...cmdArgs].join(' ')} | summary`]));
  assertIncludes(out, 'batch --parallel:', `parallel ${cmd} blocked`);
  assertIncludes(out, cmd, `parallel ${cmd} blocked command name`);
  assertIncludes(out, 'mutate shared state', `parallel ${cmd} blocked reason`);
}
const failedClickJsonOut = step('failed action json evidence', () => runFailureStdout(['click', target, '#missing-action-json-smoke', '--format', 'json']));
const parsedFailedClickAction = JSON.parse(failedClickJsonOut);
if (parsedFailedClickAction.schema !== 'chrome-cdp-ex.action.v1' || parsedFailedClickAction.action !== 'click') {
  throw new Error(`failed click --format json should return action evidence JSON:\n${failedClickJsonOut}`);
}
if (parsedFailedClickAction.dispatch?.ok !== false || parsedFailedClickAction.effects?.failure?.kind !== 'selector') {
  throw new Error(`failed click --format json should classify dispatch failure:\n${failedClickJsonOut}`);
}
if (!parsedFailedClickAction.nextHint?.includes('cdp perceive')) {
  throw new Error(`failed click --format json should include an executable recovery nextHint:\n${failedClickJsonOut}`);
}
if (parsedFailedClickAction.recommendation?.source !== 'action-diagnosis' || !parsedFailedClickAction.nextSteps?.some(step => step.includes('cdp perceive'))) {
  throw new Error(`failed click --format json should promote diagnosis recovery commands:\n${failedClickJsonOut}`);
}
// #552: a button that stays Outcome: no-change is a failed action (exit 1, Kind
// click-no-change). Scripts can branch on the status without reading prose.
const noChangeClickJsonOut = step('no-change action json recovery', () => runFailureStdout(['click', target, '#noop', '--format', 'json']));
const parsedNoChangeAction = JSON.parse(noChangeClickJsonOut);
if (parsedNoChangeAction.schema !== 'chrome-cdp-ex.action.v1' || parsedNoChangeAction.action !== 'click') {
  throw new Error(`no-change click --format json should return action evidence JSON:\n${noChangeClickJsonOut}`);
}
if (parsedNoChangeAction.dispatch?.ok !== false || parsedNoChangeAction.effects?.failure?.kind !== 'click-no-change') {
  throw new Error(`no-change click should fail closed with Kind click-no-change:\n${noChangeClickJsonOut}`);
}
if (!parsedNoChangeAction.effects?.failure?.detailLines?.includes('Outcome: no-change')) {
  throw new Error(`no-change click should keep Outcome: no-change on the failure:\n${noChangeClickJsonOut}`);
}
if (parsedNoChangeAction.outcome?.status !== 'failed' || parsedNoChangeAction.outcome?.needsAttention !== true) {
  throw new Error(`no-change click should report a failed outcome:\n${noChangeClickJsonOut}`);
}
if (parsedNoChangeAction.verdict?.status !== 'blocked' || parsedNoChangeAction.verdict?.canContinue !== false || parsedNoChangeAction.verdict?.needsRecovery !== true) {
  throw new Error(`no-change click should block continuation:\n${noChangeClickJsonOut}`);
}
if (parsedNoChangeAction.recommendation?.strategy !== 'inspect-unchanged-control') {
  throw new Error(`no-change click should recommend inspecting the unchanged control:\n${noChangeClickJsonOut}`);
}
const noChangeNextSteps = parsedNoChangeAction.nextSteps || [];
for (const expected of [
  `cdp perceive ${target} --since-action`,
  `cdp perceive ${target} -C -d 8`,
]) {
  if (!noChangeNextSteps.includes(expected)) {
    throw new Error(`no-change click should include ${expected} in nextSteps:\n${noChangeClickJsonOut}`);
  }
}
const batchNoChangeJsonOut = step('batch json no-change verdict handoff', () => runFailureStdout(['batch', target, '--format', 'json', 'click #noop']));
const parsedBatchNoChange = JSON.parse(batchNoChangeJsonOut);
if (parsedBatchNoChange.schema !== 'chrome-cdp-ex.batch.v1' || parsedBatchNoChange.counts?.failed !== 1 || parsedBatchNoChange.counts?.attention !== 0) {
  throw new Error(`batch --format json should fail a no-change click instead of treating it as attention:\n${batchNoChangeJsonOut}`);
}
if (parsedBatchNoChange.steps?.[0]?.failureKind !== 'click-no-change' || parsedBatchNoChange.steps?.[0]?.verdict?.status !== 'blocked') {
  throw new Error(`batch --format json should preserve Kind click-no-change:\n${batchNoChangeJsonOut}`);
}
if (!parsedBatchNoChange.nextSteps?.includes(`cdp perceive ${target} --since-action`)) {
  throw new Error(`batch --format json should promote the click-no-change recovery command:\n${batchNoChangeJsonOut}`);
}
const flowNoChangeJsonOut = step('flow json no-change verdict handoff', () => runFailure(['flow', target, '--format', 'json', 'click #noop; summary']));
const parsedFlowNoChange = JSON.parse(flowNoChangeJsonOut);
if (parsedFlowNoChange.schema !== 'chrome-cdp-ex.flow.v1' || parsedFlowNoChange.halted !== true || parsedFlowNoChange.counts?.failed !== 1 || parsedFlowNoChange.counts?.attention !== 0) {
  throw new Error(`flow --format json should halt when a click does not change a control:\n${flowNoChangeJsonOut}`);
}
if (parsedFlowNoChange.steps?.[0]?.failureKind !== 'click-no-change' || parsedFlowNoChange.steps?.[0]?.verdict?.status !== 'blocked') {
  throw new Error(`flow --format json should preserve Kind click-no-change:\n${flowNoChangeJsonOut}`);
}
if (parsedFlowNoChange.steps?.[1]?.skipped !== true) {
  throw new Error(`flow --format json should skip steps after a click-no-change failure:\n${flowNoChangeJsonOut}`);
}
if (!parsedFlowNoChange.nextSteps?.includes(`cdp perceive ${target} --since-action`)) {
  throw new Error(`flow --format json should promote the click-no-change recovery command:\n${flowNoChangeJsonOut}`);
}
const diffShotOut = step('diff-shot fill diff', () => run(['diff-shot', target]));
assertIncludes(diffShotOut, 'Diff-shot: changed', 'diff-shot diff');
assertIncludes(diffShotOut, 'Diff image:', 'diff-shot artifact');
const diffShotPath = diffShotOut.split('\n').find(line => line.startsWith('Diff image: '))?.slice('Diff image: '.length).trim();
if (!diffShotPath || !existsSync(diffShotPath)) {
  throw new Error(`diff-shot should save a diff PNG artifact\nOutput:\n${diffShotOut}`);
}
const changedMatch = diffShotOut.match(/changed\s+(\d+)\/(\d+)\s+px/);
if (!changedMatch || Number(changedMatch[1]) <= 0 || Number(changedMatch[2]) <= 0) {
  throw new Error(`diff-shot should report changed pixels after fill\nOutput:\n${diffShotOut}`);
}
// #661: the compare names the element whose pixels changed, and "around" one an outline spills past.
// The page has scrolled by now: bring #cmd into view and take a fresh baseline, and restore after.
run(['eval', target, "window.__smokeScrollY = scrollY; document.getElementById('cmd').scrollIntoView({ block: 'center', behavior: 'instant' })"]);
run(['diff-shot', target]);
run(['eval', target, "document.getElementById('cmd').style.background = 'rgb(255, 236, 179)'"]);
const diffShotRegionOut = step('diff-shot names the changed element', () => run(['diff-shot', target]));
if (!/^ {2}<INPUT#cmd> "command input" at \d+,\d+ \d+×\d+ \(\d+ px\)$/m.test(diffShotRegionOut)) {
  throw new Error(`diff-shot should name <INPUT#cmd> as a changed region\nOutput:\n${diffShotRegionOut}`);
}
run(['eval', target, "document.getElementById('cmd').style.outline = '3px solid rgb(207, 34, 46)'"]);
const diffShotAroundOut = step('diff-shot names the element an outline spills past', () => run(['diff-shot', target]));
assertIncludes(diffShotAroundOut, '  around <INPUT#cmd> "command input" at ', 'diff-shot around region');
run(['eval', target, "document.getElementById('cmd').style.background = ''; document.getElementById('cmd').style.outline = ''; scrollTo({ top: window.__smokeScrollY, behavior: 'instant' })"]);
const pressOut = step('press c', () => run(['press', target, 'c']));
assertIncludes(pressOut, 'Pressed c', 'press c');
assertIncludes(pressOut, 'Next:', 'press next command');
const injectOut = step('inject action evidence', () => run(['inject', target, '--css', 'body { outline: 1px solid rgb(1, 2, 3); }']));
assertIncludes(injectOut, 'inject-', 'inject');
assertIncludes(injectOut, 'inject: dispatched', 'inject action evidence');
step('text auto', () => assertIncludes(run(['text', target, '--auto']), 'chrome-cdp-ex long-session smoke', 'text --auto'));
step('text fallback', () => assertIncludes(run(['text', target, '[role="region"][aria-label*="事件"], [class*=MainStage], main']), '歷史訊息', 'text fallback'));
const clickOut = step('combat click', () => run(['click', target, '#combat']));
assertIncludes(clickOut, 'Clicked', 'click #combat');
assertIncludes(clickOut, 'Next:', 'click next command');
const diagnosticOut = step('diagnostic action evidence', () => run(['click', target, '#diagnostic']));
assertIncludes(diagnosticOut, 'Clicked', 'click #diagnostic');
const diagnosticFailedLine = diagnosticOut.split('\n').find(line => line.startsWith('Request failed:') && line.includes('/api/fail'));
if (!diagnosticFailedLine || !diagnosticFailedLine.includes('/api/fail → 500')) {
  throw new Error(`diagnostic receipt should contain Request failed: … /api/fail → 500\nOutput:\n${diagnosticOut}`);
}
if (!diagnosticFailedLine.includes('; body:') || !diagnosticFailedLine.includes('smoke diagnostic')) {
  throw new Error(`diagnostic receipt should include a body excerpt\nOutput:\n${diagnosticOut}`);
}
const diagnosticReceiptNext = diagnosticFailedRequestNext(target, [diagnosticFailedRequestFromLine(diagnosticFailedLine)]);
if (!diagnosticOut.split('\n').includes(`Next: ${diagnosticReceiptNext}`)) {
  throw new Error(`diagnostic receipt Next should be ${diagnosticReceiptNext}\nOutput:\n${diagnosticOut}`);
}
const sinceActionOut = step('perceive since-action', () => run(['perceive', target, '--since-action']));
assertIncludes(sinceActionOut, 'Page:', 'perceive --since-action');
if (!sinceActionOut.includes('+++ Added') && !sinceActionOut.includes('~~~ Text nodes updated')) {
  throw new Error(`perceive --since-action should show changes from the last action\nOutput:\n${sinceActionOut}`);
}
const sinceActionJson = step('perceive since-action json', () => run(['perceive', target, '--since-action', '--format', 'json']));
const parsedSinceAction = JSON.parse(sinceActionJson);
if (parsedSinceAction.schema !== 'chrome-cdp-ex.perceive-diff.v1' || parsedSinceAction.mode !== 'since-action') {
  throw new Error(`perceive --since-action json schema mismatch:\n${sinceActionJson}`);
}
if (parsedSinceAction.summary?.changed !== true) {
  throw new Error(`perceive --since-action json should report changed=true:\n${sinceActionJson}`);
}
if (!parsedSinceAction.nextSteps?.some(nextStep => nextStep.includes('report') && nextStep.includes('--format json'))) {
  throw new Error(`perceive --since-action json should include report handoff next step:\n${sinceActionJson}`);
}
const diagnosticJsonOut = step('diagnostic action json diagnosis', () => run(['click', target, '#diagnostic', '--format', 'json']));
const parsedDiagnosticAction = JSON.parse(diagnosticJsonOut);
if (parsedDiagnosticAction.schema !== 'chrome-cdp-ex.action.v1') {
  throw new Error(`diagnostic action json should return action schema:\n${diagnosticJsonOut}`);
}
if (!['network-failure', 'network-pending'].includes(parsedDiagnosticAction.effects?.diagnosis?.kind)) {
  throw new Error(`diagnostic action json should diagnose the network effect:\n${diagnosticJsonOut}`);
}
if (parsedDiagnosticAction.outcome?.status !== 'attention' || parsedDiagnosticAction.outcome?.needsAttention !== true) {
  throw new Error(`diagnostic action json should include an attention outcome:\n${diagnosticJsonOut}`);
}
// #648: the same Next rule as the text receipt. A body on the failed request
// points at perceive --since-action; an unreadable body points at netlog --id N --body.
const diagnosticActionTarget = String(parsedDiagnosticAction.target?.targetId || target).slice(0, 8);
const diagnosticFailedRequest = (parsedDiagnosticAction.effects?.failedRequests || [])
  .find(item => String(item?.url || '').includes('/api/fail'));
if (!diagnosticFailedRequest || diagnosticFailedRequest.status !== 500 || !String(diagnosticFailedRequest.body?.text || '').includes('smoke diagnostic')) {
  throw new Error(`diagnostic action json should name /api/fail → 500 with a body excerpt:\n${diagnosticJsonOut}`);
}
const diagnosticNextCommand = diagnosticFailedRequestNext(
  diagnosticActionTarget,
  parsedDiagnosticAction.effects?.failedRequests,
  { pending: parsedDiagnosticAction.effects?.diagnosis?.kind === 'network-pending' },
);
if (parsedDiagnosticAction.verdict?.status !== 'recover' || parsedDiagnosticAction.verdict?.primaryNextStep !== diagnosticNextCommand) {
  throw new Error(`diagnostic action json primaryNextStep should be ${diagnosticNextCommand}:\n${diagnosticJsonOut}`);
}
if (parsedDiagnosticAction.effects?.diagnosis?.nextCommand !== diagnosticNextCommand) {
  throw new Error(`diagnostic action json nextCommand should be ${diagnosticNextCommand}:\n${diagnosticJsonOut}`);
}
const diagnosticRecoveryCommands = parsedDiagnosticAction.effects?.diagnosis?.recovery?.commands?.map(entry => entry.command) || [];
if (!diagnosticRecoveryCommands.includes(diagnosticNextCommand)) {
  throw new Error(`diagnostic action json recovery should include ${diagnosticNextCommand}:\n${diagnosticJsonOut}`);
}
if (!diagnosticRecoveryCommands.some(command => command.includes('perceive') && command.includes('--since-action'))) {
  throw new Error(`diagnostic action json should include a recovery since-action command:\n${diagnosticJsonOut}`);
}
if (!diagnosticRecoveryCommands.some(command => command.includes('report') && command.includes('--format json'))) {
  throw new Error(`diagnostic action json should include a recovery report handoff command:\n${diagnosticJsonOut}`);
}
const batchJsonOut = step('batch json failure handoff', () => runFailureStdout(['batch', target, '--format', 'json', 'summary | click #missing-batch-json-smoke']));
const parsedBatch = JSON.parse(batchJsonOut);
if (parsedBatch.schema !== 'chrome-cdp-ex.batch.v1' || parsedBatch.counts?.failed !== 1) {
  throw new Error(`batch --format json should return structured failure handoff:\n${batchJsonOut}`);
}
if (parsedBatch.failedStep?.cmd !== 'click' || parsedBatch.failedStep?.failureKind !== 'selector') {
  throw new Error(`batch --format json should identify the failed step and failure kind:\n${batchJsonOut}`);
}
if (!parsedBatch.nextSteps?.some(nextStep => nextStep.includes('cdp perceive'))) {
  throw new Error(`batch --format json should include an executable recovery next step:\n${batchJsonOut}`);
}
const flowJsonOut = step('flow json failure handoff exits non-zero', () => runFailure(['flow', target, '--format', 'json', 'summary; click #missing-flow-json-smoke; status']));
const parsedFlow = JSON.parse(flowJsonOut);
if (parsedFlow.schema !== 'chrome-cdp-ex.flow.v1' || parsedFlow.counts?.failed !== 1 || parsedFlow.counts?.skipped !== 1) {
  throw new Error(`flow --format json should return structured failure handoff:\n${flowJsonOut}`);
}
if (parsedFlow.failedStep?.cmd !== 'click' || parsedFlow.failedStep?.failureKind !== 'selector') {
  throw new Error(`flow --format json should identify the failed step and failure kind:\n${flowJsonOut}`);
}
if (!parsedFlow.nextSteps?.some(nextStep => nextStep.includes('cdp perceive'))) {
  throw new Error(`flow --format json should include an executable recovery next step:\n${flowJsonOut}`);
}
const nestedFlowRepeatOut = step('repeat halts on failed nested flow', () => runFailure([
  'repeat', target, '3', 'flow', 'click #missing-repeat-flow-smoke; status',
]));
assertIncludes(nestedFlowRepeatOut, '[1/3] ✗', 'nested flow repeat failed turn');
assertIncludes(nestedFlowRepeatOut, 'Flow halted at step 1/2', 'nested flow failed step');
assertIncludes(nestedFlowRepeatOut, 'Repeat halted at iteration 1/3', 'nested flow repeat halt');
if (nestedFlowRepeatOut.includes('[2/3]')) {
  throw new Error(`repeat should stop before a second failed nested-flow turn:\n${nestedFlowRepeatOut}`);
}
const continuedFlowRepeatOut = step('repeat continue reports failed nested flows', () => run([
  'repeat', target, '2', '--continue', 'flow', 'click #missing-repeat-flow-smoke; status',
]));
assertIncludes(continuedFlowRepeatOut, '[2/2] ✗', 'continued nested flow second turn');
assertIncludes(continuedFlowRepeatOut, 'Done: 0 ok, 2 failed', 'continued nested flow counts');
const sessionShotOut = step('session shot attachment', () => run(['shot', target, '--quiet']));
const sessionShotPath = sessionShotOut.split('\n')[0];
if (sessionShotOut.split('\n').length !== 1 || !sessionShotPath.endsWith('.png') || !existsSync(sessionShotPath)) {
  throw new Error(`session shot --quiet should print an existing PNG path, got:\n${sessionShotOut}`);
}
const reportOut = step('session report', () => run(['report', target]));
assertIncludes(reportOut, 'Session report:', 'report');
assertIncludes(reportOut, 'Action timeline:', 'report');
assertIncludes(reportOut, 'click #combat', 'report action timeline');
assertIncludes(reportOut, 'Recovery:', 'report recovery strategy');
assertIncludes(reportOut, 'Recommendation:', 'report recommendation');
assertIncludes(reportOut, 'Next steps:', 'report next steps');
assertIncludes(reportOut, `cdp record-actions ${target} --format json`, 'report workflow handoff');
assertIncludes(reportOut, 'Screenshot dir:', 'report screenshot dir');
assertIncludes(reportOut, 'Attachments:', 'report attachments');
assertIncludes(reportOut, sessionShotPath, 'report screenshot attachment');
const reportLogPath = reportOut.split('\n').find(line => line.startsWith('Log: '))?.slice(5).trim();
if (!reportLogPath || !existsSync(reportLogPath)) throw new Error(`report log path should exist\nOutput:\n${reportOut}`);
const reportJson = step('session report json', () => run(['report', target, '--format', 'json']));
const parsedReport = JSON.parse(reportJson);
if (parsedReport.schema !== 'chrome-cdp-ex.report.v1' || parsedReport.targetPrefix !== target) {
  throw new Error(`report json schema/target mismatch:\n${reportJson}`);
}
if (parsedReport.counts?.actions < 1 || parsedReport.counts?.screenshots < 1) {
  throw new Error(`report json should include action and screenshot counts:\n${reportJson}`);
}
if (!parsedReport.actions?.some(action => action.action === 'click' && action.evidence?.effectSummary)) {
  throw new Error(`report json should include action evidence timeline:\n${reportJson}`);
}
// The compact report carries the outcome on the action receipt (receipt.outcome).
if (!parsedReport.actions?.some(action => ['changed', 'attention'].includes(action.outcome?.status || action.receipt?.outcome))) {
  throw new Error(`report json should include action outcomes:\n${reportJson}`);
}
// The compact report puts the verdict on latestAction (verdictStatus / canContinue).
if (!parsedReport.latestAction?.verdictStatus || typeof parsedReport.latestAction?.canContinue !== 'boolean') {
  throw new Error(`report json should include action verdicts:\n${reportJson}`);
}
if (!parsedReport.screenshots?.some(shot => shot.path === sessionShotPath)) {
  throw new Error(`report json should include screenshot attachment:\n${reportJson}`);
}
if (parsedReport.paths?.log !== reportLogPath || !parsedReport.nextSteps?.some(nextStep => nextStep.includes('record-actions'))) {
  throw new Error(`report json should include log path and handoff next steps:\n${reportJson}`);
}
if (!parsedReport.recommendation?.source || !parsedReport.recommendation?.strategy) {
  throw new Error(`report json should include a Smart Eye recommendation:\n${reportJson}`);
}
const recommendedCommands = parsedReport.recommendation?.commands || [];
if (recommendedCommands.length > 0 && !recommendedCommands.some(command => parsedReport.nextSteps?.includes(command))) {
  throw new Error(`report json nextSteps should include recovery recommendation commands:\n${reportJson}`);
}
const reportLogEvents = readFileSync(reportLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (!reportLogEvents.some(event => event.kind === 'action' && event.action?.action === 'click')) {
  throw new Error(`session log should contain a click action event\nLog:\n${readFileSync(reportLogPath, 'utf8')}`);
}
if (!reportLogEvents.some(event => event.kind === 'action' && event.action?.outcome?.status)) {
  throw new Error(`session log should contain action outcome events\nLog:\n${readFileSync(reportLogPath, 'utf8')}`);
}
if (!reportLogEvents.some(event => event.kind === 'screenshot' && event.screenshot?.path === sessionShotPath)) {
  throw new Error(`session log should contain the screenshot event\nLog:\n${readFileSync(reportLogPath, 'utf8')}`);
}
const recordActionsJson = step('record-actions json', () => run(['record-actions', target, '--format', 'json']));
const recordActions = JSON.parse(recordActionsJson);
for (const [label, text] of [['record-actions', recordActionsJson], ['session log', readFileSync(reportLogPath, 'utf8')], ['report', reportJson]]) {
  if (text.includes('sk-smoke-485') || text.includes(SMOKE_REJECTED_SECRET)) throw new Error(`${label} kept a secret-named field's value (#485)`);
}
if (recordActions.schema !== 'chrome-cdp-ex.record-actions.v1') {
  throw new Error(`record-actions json schema mismatch:\n${recordActionsJson}`);
}
if (!Array.isArray(recordActions.environment) || recordActions.environmentCount < 6) {
  throw new Error(`record-actions should include reusable environment controls\nOutput:\n${recordActionsJson}`);
}
const environmentCommands = recordActions.environment.map(entry => entry.command?.join(' '));
if (!environmentCommands.includes('throttle slow-3g') || !environmentCommands.some(command => command?.startsWith('mock add **/api/mock* --status 418')) || !environmentCommands.includes('clock freeze --at 2020-01-02T03:04:05.000Z')) {
  throw new Error(`record-actions should capture throttle/mock/clock environment commands\nOutput:\n${recordActionsJson}`);
}
if (!recordActions.actions.some(action => action.action === 'fill' && action.command?.join(' ') === 'fill #cmd look trainer' && action.replayable)) {
  throw new Error(`record-actions should include replayable fill command\nOutput:\n${recordActionsJson}`);
}
if (!recordActions.actions.some(action => action.action === 'fill' && action.command?.join(' ') === 'fill #cmd look merchant' && action.replayable)) {
  throw new Error(`record-actions should preserve fill --format json text without recording the format flag as input\nOutput:\n${recordActionsJson}`);
}
const failedDiagnosticAction = recordActions.actions.find(action => action.action === 'click' && action.target?.input === '#missing-action-json-smoke');
if (!failedDiagnosticAction || failedDiagnosticAction.replayable !== false || !failedDiagnosticAction.needsInput?.includes('successful-dispatch')) {
  throw new Error(`record-actions should keep failed dispatch diagnostics but mark them non-replayable\nOutput:\n${recordActionsJson}`);
}
if (!recordActions.actions.some(action => action.action === 'click' && action.command?.join(' ') === 'click #combat' && action.replayable)) {
  throw new Error(`record-actions should include replayable click command\nOutput:\n${recordActionsJson}`);
}
if (!recordActions.actions.some(action => action.evidence?.outcome?.status)) {
  throw new Error(`record-actions should include action outcome evidence\nOutput:\n${recordActionsJson}`);
}
if (!recordActions.actions.some(action => action.evidence?.verdict?.status)) {
  throw new Error(`record-actions should include action verdict evidence\nOutput:\n${recordActionsJson}`);
}
const playwrightExport = step('export playwright', () => run(['export-playwright', target]));
assertIncludes(playwrightExport, "import { test, expect } from '@playwright/test';", 'export-playwright import');
assertIncludes(playwrightExport, 'await page.route("**/api/mock*"', 'export-playwright mock route');
assertIncludes(playwrightExport, 'await page.locator("#cmd").fill("look trainer");', 'export-playwright fill');
assertIncludes(playwrightExport, 'await page.locator("#combat").click();', 'export-playwright click');
assertIncludes(playwrightExport, 'await expect(page.getByText("戰鬥勝利")).toBeVisible();', 'export-playwright evidence assertion');
const playwrightExportJson = step('export playwright json', () => run(['export-playwright', target, '--format', 'json']));
const playwrightExportModel = JSON.parse(playwrightExportJson);
if (playwrightExportModel.schema !== 'chrome-cdp-ex.export-playwright.v1') {
  throw new Error(`export-playwright JSON should include schema\nOutput:\n${playwrightExportJson}`);
}
assertIncludes(playwrightExportModel.spec, "import { test, expect } from '@playwright/test';", 'export-playwright JSON spec');
if ((playwrightExportModel.counts?.actions || 0) < 1 || (playwrightExportModel.counts?.actionsExported || 0) < 1) {
  throw new Error(`export-playwright JSON should include exported action counts\nOutput:\n${playwrightExportJson}`);
}
if ((playwrightExportModel.counts?.assertions || 0) < 1) {
  throw new Error(`export-playwright JSON should include assertion counts\nOutput:\n${playwrightExportJson}`);
}
if (!Array.isArray(playwrightExportModel.review)) {
  throw new Error(`export-playwright JSON should include review list\nOutput:\n${playwrightExportJson}`);
}
const replayArtifactPath = resolve(profileDir, 'record-actions.json');
writeFileSync(replayArtifactPath, recordActionsJson);
// Recorded button clicks are not idempotent: a later replay of #loop-attack or
// #smooth-target can land on Outcome: no-change. --continue keeps the rest of
// the artifact running, and the click-no-change line is the failure signal.
const replayOut = step('replay record-actions artifact', () => run(['replay', target, '--file', replayArtifactPath, '--continue'], { timeout: 70000 }));
assertIncludes(replayOut, 'Replay:', 'replay');
assertIncludes(replayOut, 'Environment:', 'replay environment');
assertIncludes(replayOut, 'mock add **/api/mock*', 'replay mock environment');
assertIncludes(replayOut, 'Kind: click-no-change', 'replay click-no-change');
assertIncludes(replayOut, 'fill #cmd "look trainer"', 'replay fill');
assertIncludes(replayOut, 'click #combat', 'replay click');
assertIncludes(replayOut, 'Done:', 'replay summary');
const replayJsonOut = step('replay record-actions artifact json', () => run(['replay', target, '--file', replayArtifactPath, '--format', 'json', '--continue'], { timeout: 70000 }));
const parsedReplay = JSON.parse(replayJsonOut);
if (parsedReplay.schema !== 'chrome-cdp-ex.replay.v1' || parsedReplay.counts?.actions < 1 || parsedReplay.counts?.environment < 1) {
  throw new Error(`replay --format json should return structured replay counts:\n${replayJsonOut}`);
}
if (!Array.isArray(parsedReplay.steps) || !parsedReplay.steps.some(step => step.phase === 'environment') || !parsedReplay.steps.some(step => step.phase === 'action')) {
  throw new Error(`replay --format json should include environment and action steps:\n${replayJsonOut}`);
}
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
step('mutate checkpoint state before restore json', () => run(['eval', target, 'localStorage.setItem("cdpSmokeCheckpoint","mutated-json"); sessionStorage.setItem("cdpSmokeCheckpoint","mutated-json"); "ok"']));
const restoreJsonOut = step('restore checkpoint artifact json', () => run(['restore', target, '--file', checkpointPath, '--format', 'json'], { timeout: 30000 }));
const parsedRestoreAction = JSON.parse(restoreJsonOut);
if (parsedRestoreAction.schema !== 'chrome-cdp-ex.action.v1' || parsedRestoreAction.action !== 'restore') {
  throw new Error(`restore --format json should return action evidence JSON:\n${restoreJsonOut}`);
}
if (parsedRestoreAction.dispatch?.ok !== true || parsedRestoreAction.settle?.ok !== true) {
  throw new Error(`restore --format json should report dispatched and settled restore:\n${restoreJsonOut}`);
}
if (!parsedRestoreAction.nextSteps?.includes(`cdp report ${target} --format json`)) {
  throw new Error(`restore --format json should include report handoff next step:\n${restoreJsonOut}`);
}
const restoredStorageJson = step('verify restored storage', () => run(['eval', target, 'JSON.stringify({local:localStorage.getItem("cdpSmokeCheckpoint"),session:sessionStorage.getItem("cdpSmokeCheckpoint")})']));
const restoredStorage = JSON.parse(restoredStorageJson);
if (restoredStorage.local !== 'local-ok' || restoredStorage.session !== 'session-ok') {
  throw new Error(`restore should reinstate checkpoint storage\nOutput:\n${restoredStorageJson}`);
}

// #471 drag: a pointer-event sortable list and an HTML5 drop zone. Reset first: restore may
// have reloaded the page (modal visible again) and earlier steps may have scrolled it.
const dragFixtureState = () => JSON.parse(run(['eval', target, 'JSON.stringify({order:document.getElementById("sortable-status").textContent,drop:document.getElementById("drop-status").textContent})']));
step('reset drag fixtures', () => run(['eval', target, '(function(){document.getElementById("motd").hidden=true; const list=document.getElementById("sortable"); for (const id of ["alpha","beta","gamma"]) list.appendChild(list.querySelector(`[data-id="${id}"]`)); document.getElementById("sortable-status").textContent="order:alpha,beta,gamma"; document.getElementById("drop-status").textContent="drop:none"; document.documentElement.style.scrollBehavior="auto"; return "reset";})()']));
const dragSortOut = step('drag reorders a pointer sortable list', () => run(['drag', target, '#sortable [data-id="alpha"]', '#sortable [data-id="gamma"]']));
assertIncludes(dragSortOut, 'Dragged <LI> "Alpha" → <LI> "Gamma"', 'drag sortable receipt');
assertIncludes(dragSortOut, 'mode: pointer', 'drag sortable mode');
assertIncludes(dragSortOut, 'Outcome: changed', 'drag sortable outcome');
if (dragFixtureState().order !== 'order:beta,gamma,alpha') {
  throw new Error(`drag should reorder the sortable list\nOutput:\n${dragSortOut}\nState:\n${JSON.stringify(dragFixtureState())}`);
}
const dragDropJson = JSON.parse(step('drag fires drop on an HTML5 drop zone', () => run(['drag', target, '#drag-card', '#drop-zone', '--format', 'json'])));
if (dragDropJson.schema !== 'chrome-cdp-ex.action.v1' || dragDropJson.action !== 'drag' || dragDropJson.dispatch?.ok !== true) {
  throw new Error(`drag --format json should return drag action evidence:\n${JSON.stringify(dragDropJson, null, 2)}`);
}
assertIncludes(dragDropJson.target?.dispatchText || '', 'mode: html5', 'drag html5 mode');
assertIncludes(dragDropJson.target?.dispatchText || '', 'drop', 'drag html5 page events');
if (dragFixtureState().drop !== 'drop:card') {
  throw new Error(`drag should fire drop on the HTML5 drop zone\nState:\n${JSON.stringify(dragFixtureState())}`);
}

// #472 click --expect-download: the page builds a CSV blob; the saved file must hash to that body.
const downloadDir = resolve(profileDir, 'downloads');
const expectedCsvSha = createHash('sha256').update('id,name\n1,smoke\n').digest('hex');
const downloadOut = step('click --expect-download saves a blob download', () => run(
  ['click', target, '#export-csv', '--expect-download', '--out', downloadDir],
  { timeout: 60000 },
));
assertIncludes(downloadOut, 'Downloaded "smoke-report.csv"', 'expect-download receipt');
assertIncludes(downloadOut, `sha256=${expectedCsvSha}`, 'expect-download receipt sha256');
const savedCsv = resolve(downloadDir, 'smoke-report.csv');
if (!existsSync(savedCsv) || createHash('sha256').update(readFileSync(savedCsv)).digest('hex') !== expectedCsvSha) {
  throw new Error(`click --expect-download should save the blob with its sha256\nOutput:\n${downloadOut}`);
}
const noDownloadOut = step('click --expect-download times out without a download', () => runFailure(
  ['click', target, '#noop', '--expect-download', '--out', downloadDir, '--timeout', '1500'],
  { timeout: 60000 },
));
assertIncludes(noDownloadOut, 'Kind: timeout', 'expect-download timeout kind');

// Reload is last so it cannot reset earlier fixture state. The same daemon
// must still evaluate afterwards.
const reloadOut = step('reload keeps the daemon usable', () => run(['reload', target], { timeout: 30000 }));
assertIncludes(reloadOut, 'Page reloaded', 'reload receipt');
const titleAfterReload = step('evaluate after reload', () => run(['eval', target, 'document.title']));
assertIncludes(titleAfterReload, 'chrome-cdp-ex long-session smoke', 'post-reload title');

console.log(`Live smoke passed using ${browserName} on CDP_PORT=${port}`);
console.log(results.join('\n'));
cleanup();
process.exit(0);
