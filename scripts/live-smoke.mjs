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
function runFailure(args, opts = {}) {
  const res = spawnSync(process.execPath, [cdp, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: opts.timeout || 20000 });
  if (res.status === 0) {
    throw new Error(`cdp ${args.join(' ')} should have failed\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return `${res.stdout || ''}${res.stderr || ''}`.trim();
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

const listJson = step('list json', () => run(['list', '--format', 'json']));
const parsedList = JSON.parse(listJson);
if (parsedList.schema !== 'chrome-cdp-ex.list.v1' || !Array.isArray(parsedList.pages) || !parsedList.pages.some(page => page.targetPrefix === target)) {
  throw new Error(`list json should include the smoke target prefix\nOutput:\n${listJson}`);
}
if (!parsedList.nextSteps?.some(step => step.startsWith(`cdp perceive ${target}`))) {
  throw new Error(`list json should include executable perceive next step\nOutput:\n${listJson}`);
}
if (parsedList.recommendation?.source !== 'golden-path' || parsedList.recommendation?.run !== `cdp perceive ${target} -C -d 8`) {
  throw new Error(`list json should include golden-path perceive recommendation\nOutput:\n${listJson}`);
}
const doctorOut = step('doctor onboarding', () => run(['doctor']));
assertIncludes(doctorOut, 'chrome-cdp-ex doctor', 'doctor');
assertIncludes(doctorOut, 'FD limit', 'doctor fd limit');
assertIncludes(doctorOut, 'Next steps:', 'doctor next steps');
assertIncludes(doctorOut, 'cdp list', 'doctor golden path');
const doctorJson = step('doctor onboarding json', () => run(['doctor', '--format', 'json']));
const parsedDoctor = JSON.parse(doctorJson);
if (parsedDoctor.schema !== 'chrome-cdp-ex.doctor.v1' || !Array.isArray(parsedDoctor.checks) || !Array.isArray(parsedDoctor.nextSteps)) {
  throw new Error(`doctor json schema mismatch:\n${doctorJson}`);
}
if (!parsedDoctor.recommendation?.source || !parsedDoctor.recommendation?.run) {
  throw new Error(`doctor json should include a runnable onboarding recommendation:\n${doctorJson}`);
}
if (!parsedDoctor.wizard?.goldenPath?.includes('perceive') || !parsedDoctor.nextSteps.some(step => step.startsWith('cdp perceive'))) {
  throw new Error(`doctor json should include golden path and executable perceive next step:\n${doctorJson}`);
}
const openJson = step('open json', () => run(['open', 'about:blank', '--format', 'json'], { timeout: 70000 }));
const parsedOpen = JSON.parse(openJson);
if (parsedOpen.schema !== 'chrome-cdp-ex.open.v1' || !parsedOpen.targetPrefix || parsedOpen.url !== 'about:blank') {
  throw new Error(`open json schema/target mismatch:\n${openJson}`);
}
if (parsedOpen.attached !== true || parsedOpen.approval !== 'approved') {
  throw new Error(`open json should attach in the smoke debug browser:\n${openJson}`);
}
if (!parsedOpen.nextSteps?.some(nextStep => nextStep.startsWith(`cdp perceive ${parsedOpen.targetPrefix}`))) {
  throw new Error(`open json should include executable perceive next step:\n${openJson}`);
}
const expectedOpenRecommendationPrefix = parsedOpen.autoPerceive?.ok
  ? `cdp click ${parsedOpen.targetPrefix}`
  : `cdp perceive ${parsedOpen.targetPrefix}`;
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
assertIncludes(frameClickOut, 'click: dispatched', 'frame click action evidence');
assertIncludes(frameClickOut, 'child:clicked', 'frame click since-action evidence');
const diffBaselineOut = step('diff-shot baseline', () => run(['diff-shot', target]));
assertIncludes(diffBaselineOut, 'Diff-shot baseline captured', 'diff-shot baseline');
assertIncludes(diffBaselineOut, 'Next: cdp diff-shot', 'diff-shot next step');
const fillOut = step('fill action evidence', () => run(['fill', target, '#cmd', 'look trainer']));
assertIncludes(fillOut, 'Filled', 'fill');
assertIncludes(fillOut, 'fill: dispatched', 'fill action evidence');
const fillJsonOut = step('fill action json evidence', () => run(['fill', target, '#cmd', 'look merchant', '--format', 'json']));
const parsedFillAction = JSON.parse(fillJsonOut);
if (parsedFillAction.schema !== 'chrome-cdp-ex.action.v1' || parsedFillAction.action !== 'fill') {
  throw new Error(`fill --format json should return action evidence JSON:\n${fillJsonOut}`);
}
if (parsedFillAction.dispatch?.ok !== true || parsedFillAction.settle?.ok !== true) {
  throw new Error(`fill --format json should report dispatched and settled action:\n${fillJsonOut}`);
}
if (!parsedFillAction.effects || !('domDiff' in parsedFillAction.effects)) {
  throw new Error(`fill --format json should include observed effects:\n${fillJsonOut}`);
}
if (parsedFillAction.recommendation?.source !== 'action-evidence' || !parsedFillAction.nextSteps?.includes(`cdp report ${target} --format json`)) {
  throw new Error(`fill --format json should include action continuation recommendation:\n${fillJsonOut}`);
}
const failedClickJsonOut = step('failed action json evidence', () => run(['click', target, '#missing-action-json-smoke', '--format', 'json']));
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
if (!parsedDiagnosticAction.effects?.diagnosis?.nextCommand?.includes('cdp netlog')) {
  throw new Error(`diagnostic action json should include a netlog next command:\n${diagnosticJsonOut}`);
}
const diagnosticRecoveryCommands = parsedDiagnosticAction.effects?.diagnosis?.recovery?.commands?.map(entry => entry.command) || [];
if (!diagnosticRecoveryCommands.some(command => command.includes('cdp netlog'))) {
  throw new Error(`diagnostic action json should include a recovery netlog command:\n${diagnosticJsonOut}`);
}
if (!diagnosticRecoveryCommands.some(command => command.includes('perceive') && command.includes('--since-action'))) {
  throw new Error(`diagnostic action json should include a recovery since-action command:\n${diagnosticJsonOut}`);
}
if (!diagnosticRecoveryCommands.some(command => command.includes('report') && command.includes('--format json'))) {
  throw new Error(`diagnostic action json should include a recovery report handoff command:\n${diagnosticJsonOut}`);
}
const batchJsonOut = step('batch json failure handoff', () => run(['batch', target, '--format', 'json', 'summary | click #missing-batch-json-smoke']));
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
const flowJsonOut = step('flow json failure handoff', () => run(['flow', target, '--format', 'json', 'summary; click #missing-flow-json-smoke; status']));
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
if (!reportLogEvents.some(event => event.kind === 'screenshot' && event.screenshot?.path === sessionShotPath)) {
  throw new Error(`session log should contain the screenshot event\nLog:\n${readFileSync(reportLogPath, 'utf8')}`);
}
const recordActionsJson = step('record-actions json', () => run(['record-actions', target, '--format', 'json']));
const recordActions = JSON.parse(recordActionsJson);
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
const playwrightExport = step('export playwright', () => run(['export-playwright', target]));
assertIncludes(playwrightExport, "import { test } from '@playwright/test';", 'export-playwright import');
assertIncludes(playwrightExport, 'await page.route("**/api/mock*"', 'export-playwright mock route');
assertIncludes(playwrightExport, 'await page.locator("#cmd").fill("look trainer");', 'export-playwright fill');
assertIncludes(playwrightExport, 'await page.locator("#combat").click();', 'export-playwright click');
const replayArtifactPath = resolve(profileDir, 'record-actions.json');
writeFileSync(replayArtifactPath, recordActionsJson);
const replayOut = step('replay record-actions artifact', () => run(['replay', target, '--file', replayArtifactPath], { timeout: 30000 }));
assertIncludes(replayOut, 'Replay:', 'replay');
assertIncludes(replayOut, 'Environment:', 'replay environment');
assertIncludes(replayOut, 'mock add **/api/mock*', 'replay mock environment');
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
