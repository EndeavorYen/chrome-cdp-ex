#!/usr/bin/env node
// Slice 1 fair benchmark. Attaches every tool to one already-running Chrome.
// Does not change product behavior. Writes docs only when --out points there.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureHtml } from '../validation/slice1/fixtures.mjs';
import {
  JOBS,
  SUBJECT_TOOL,
  TOKEN_ESTIMATOR,
  VIEWPORT,
  combineOutput,
  chromeSandboxMode,
  coveredClickTimingNote,
  extractChromeCdpListPrefix,
  extractChromeCdpRef,
  extractDevtoolsPageId,
  extractDevtoolsUid,
  extractPlaywrightRef,
  findLosses,
  assertPortableBenchmarkJson,
  buildSandboxAb,
  formatLoadSample,
  loadIsIdle,
  recordedChromeArgs,
  recordedCommand,
  redactBenchmarkTree,
  renderSlice1Board,
  scoreAttachSession,
  scoreCoveredClick,
  scoreDenseObservation,
  scoreOverlayHonesty,
  scoreStaleRecovery,
  staleClickNote,
  summarizeTool,
  unicodeLength,
} from './lib/benchmark-slice1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CDP_BIN = resolve(ROOT, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const DEFAULT_PEERS = resolve(ROOT, 'validation/slice1/peers');
const DEFAULT_CHROME = process.env.SLICE1_CHROME || '/opt/google/chrome/chrome';
const TOOLS = Object.freeze(['chrome-cdp-ex', '@playwright/cli', 'chrome-devtools-mcp']);

const PROTOCOL = [
  'Tasks 1-4 share one already-running Chrome. An unscored connection warmup runs once before those tasks: chrome-cdp-ex `list`, @playwright/cli `attach --cdp`, chrome-devtools-mcp `start --browserUrl` and `list_pages`. Each task then runs one discarded warm-up per tool, using the same commands as a scored run, in tool order chrome-cdp-ex, @playwright/cli, chrome-devtools-mcp. Connection warmup and discarded warm-up are stored in the JSON and are not part of steps, agentChars, wallMs, or the median. The harness navigates the existing tab and sets a 1042x632 CSS viewport over CDP before each execution. Scored tool order rotates by run index.',
  'Task 5 stops those tool daemons, reloads the session fixture so the page sets slice1_session=already-set, and times a cold attach plus a cookie read. Its discarded warm-up is the same cold-attach sequence and is excluded from the median. Chrome is not relaunched. The browser websocket id must be unchanged.',
  'Commands: (1) overlay / snapshot / take_snapshot. (2) click #submit, or take_snapshot plus click uid for chrome-devtools-mcp. (3) perceive -C -d 8 / snapshot / take_snapshot without --verbose. (4) the task 3 observation, a harness DOM rewrite, click of the captured ref, and one more observation plus click if the fresh control is not yet saved. (5) list plus cookies / attach plus cookie-list / start plus list_pages plus evaluate_script document.cookie.',
  'Peer processes set NO_UPDATE_NOTIFIER=1 and CI=1. chrome-devtools-mcp also gets --no-usage-statistics. chrome-cdp-ex does not receive CI=1. wallMs is the sum of scored command durations. agentChars is the sum of Unicode code points in each command\'s unredacted stdout plus stderr. Recorded commands use `node` and repository-relative paths. The published JSON replaces the temporary profile with `<tmp-profile>`, loopback ports in commands, output, and groundTruth with `<port>`, and replaces each `/devtools/browser/<uuid>` id with the first 12 hex characters of its sha256. The run records nproc and the 1, 5, and 15 minute load averages, and starts only after the 1-minute load average is below nproc.',
].join(' ');

function parseArgs(argv) {
  const args = {
    runs: 3,
    tasks: [1, 2, 3, 4, 5],
    out: resolve(ROOT, 'docs/benchmarks/2026-10-08-slice1.json'),
    peers: DEFAULT_PEERS,
    chrome: DEFAULT_CHROME,
    sandboxAb: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runs') args.runs = Number(argv[++i]);
    else if (arg === '--tasks') args.tasks = argv[++i].split(',').map(value => Number(value));
    else if (arg === '--out') args.out = resolve(argv[++i]);
    else if (arg === '--peers') args.peers = resolve(argv[++i]);
    else if (arg === '--chrome') args.chrome = argv[++i];
    else if (arg === '--sandbox-ab') args.sandboxAb = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs must be a positive integer');
  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function messageText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return String(data);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      ws.addEventListener('open', resolveOpen, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const client = new Cdp(ws);
    ws.addEventListener('message', event => {
      void client.onMessage(event);
    });
    return client;
  }

  async onMessage(event) {
    let raw = event.data;
    if (raw && typeof raw.text === 'function') raw = await raw.text();
    const message = JSON.parse(messageText(raw));
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else waiter.resolve(message.result || {});
  }

  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

function runProcess(command, args, { env, cwd, timeoutMs = 90000 }) {
  return new Promise(resolveRun => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      clearTimeout(timer);
      const output = combineOutput(stdout, stderr);
      resolveRun({
        command: recordedCommand(ROOT, command, args),
        code: code ?? 1,
        timedOut,
        wallMs: Math.round(performance.now() - started),
        stdout,
        stderr,
        output,
        agentChars: unicodeLength(output),
      });
    });
  });
}

function finish(steps, score, groundTruth) {
  return {
    pass: Boolean(score.pass),
    steps: steps.length,
    wallMs: steps.reduce((sum, step) => sum + step.wallMs, 0),
    agentChars: steps.reduce((sum, step) => sum + step.agentChars, 0),
    notes: score.notes,
    groundTruth,
    commands: steps.map(step => ({
      command: step.command,
      code: step.code,
      wallMs: step.wallMs,
      agentChars: step.agentChars,
      timedOut: step.timedOut,
      output: step.output,
    })),
  };
}

const TRUTH_EXPRESSION = `(() => {
  const cover = document.getElementById('cover');
  const rect = cover ? cover.getBoundingClientRect() : null;
  const style = cover ? getComputedStyle(cover) : null;
  const visible = !!cover && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 2 && rect.height > 2;
  const coversViewport = visible && rect.left <= 1 && rect.top <= 1 && rect.right >= window.innerWidth - 1 && rect.bottom >= window.innerHeight - 1;
  return JSON.stringify({
    coversViewport,
    visible,
    status: document.getElementById('status') ? document.getElementById('status').textContent : null,
    cookie: (() => { try { return document.cookie; } catch (error) { return ''; } })(),
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
    dialog: document.getElementById('dialog-body') ? document.getElementById('dialog-body').textContent : null,
  });
})()`;

async function readTruth(page) {
  const result = await page.send('Runtime.evaluate', { expression: TRUTH_EXPRESSION, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`truth failed: ${JSON.stringify(result.exceptionDetails)}`);
  return JSON.parse(result.result.value);
}

async function applyViewport(page) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const truth = await readTruth(page);
  if (truth.w !== VIEWPORT.width || truth.h !== VIEWPORT.height) {
    throw new Error(`viewport readback ${truth.w}x${truth.h}, expected ${VIEWPORT.width}x${VIEWPORT.height}`);
  }
  return truth;
}

async function waitForOrigin(page, origin) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    if (String(result.result?.value || '').startsWith(origin)) return;
    await sleep(100);
  }
  throw new Error(`fixture origin ${origin} did not load`);
}

async function navigate(page, url) {
  await page.send('Page.enable');
  await page.send('Page.navigate', { url });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await page.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (result.result?.value === 'complete') return;
    await sleep(50);
  }
  throw new Error(`navigation timeout ${url}`);
}

async function prepare(ctx, name) {
  await navigate(ctx.page, `${ctx.origin}/${name}`);
  const truth = await applyViewport(ctx.page);
  if (name === 'session' && !String(truth.cookie).includes('already-set')) {
    throw new Error('session fixture did not set slice1_session before the tool ran');
  }
  if (name === 'overlay' && truth.coversViewport !== true) {
    throw new Error(`overlay fixture did not cover the viewport (${JSON.stringify(truth)})`);
  }
  return truth;
}

function browserVersion(port) {
  return fetch(`http://127.0.0.1:${port}/json/version`).then(response => {
    if (!response.ok) throw new Error(`json/version ${response.status}`);
    return response.json();
  });
}

async function browserId(port) {
  try {
    const version = await browserVersion(port);
    return version.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function waitForBrowser(port) {
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await browserVersion(port);
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(`Chrome CDP did not answer on ${port}: ${lastError?.message || 'timeout'}`);
}

async function connectPage(port, origin) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(target => target.type === 'page' && String(target.url || '').startsWith(origin))
    || targets.find(target => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target');
  const client = await Cdp.connect(page.webSocketDebuggerUrl);
  return { client, targetId: page.id, url: page.url };
}

function removeTemp(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.error(`failed to remove ${dir}: ${error.message}`);
  }
}

function stopChrome(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolveExit => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      resolveExit();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      clearTimeout(timer);
      resolveExit();
    }
  });
}

function roundLoad(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sampleLoad() {
  const [one, five, fifteen] = loadavg();
  return { one: roundLoad(one), five: roundLoad(five), fifteen: roundLoad(fifteen) };
}

function readNproc() {
  try {
    const parsed = Number(execFileSync('nproc', { encoding: 'utf8' }).trim());
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  } catch { /* nproc is not available on every host */ }
  return availableParallelism();
}

async function waitForIdle(nproc) {
  const deadline = Date.now() + 45 * 60 * 1000;
  while (true) {
    const sample = sampleLoad();
    console.error(`load ${formatLoadSample(sample)} nproc ${nproc}`);
    if (loadIsIdle(sample.one, nproc)) return sample;
    if (Date.now() >= deadline) {
      throw new Error(`1-minute load average ${sample.one} stayed at or above nproc ${nproc}`);
    }
    await sleep(5000);
  }
}

function ensurePeers(dir) {
  const pw = resolve(dir, 'node_modules/@playwright/cli/playwright-cli.js');
  const dt = resolve(dir, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools.js');
  if (!existsSync(pw) || !existsSync(dt)) {
    execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: dir, stdio: 'inherit' });
  }
  if (!existsSync(pw) || !existsSync(dt)) throw new Error(`peer CLIs missing in ${dir}`);
  return { pw, dt };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function spawnInherit(args, env) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolveChild();
      else reject(new Error(`slice1 sandbox arm exited ${code}`));
    });
  });
}

async function runSandboxAb(args) {
  if (!existsSync(args.out)) throw new Error(`headline JSON missing: ${args.out}`);
  const dir = mkdtempSync(resolve(tmpdir(), 'slice1-ab-'));
  const defaultOut = resolve(dir, 'default.json');
  const noSandboxOut = resolve(dir, 'no-sandbox.json');
  const script = fileURLToPath(import.meta.url);
  const childArgs = [
    script,
    '--runs', String(args.runs),
    '--tasks', args.tasks.join(','),
    '--peers', args.peers,
    '--chrome', args.chrome,
  ];
  const baseEnv = { ...process.env };
  delete baseEnv.SLICE1_NO_SANDBOX;
  try {
    console.error('sandbox A/B arm: default sandbox');
    await spawnInherit([...childArgs, '--out', defaultOut], baseEnv);
    console.error('sandbox A/B arm: SLICE1_NO_SANDBOX=1');
    await spawnInherit([...childArgs, '--out', noSandboxOut], { ...baseEnv, SLICE1_NO_SANDBOX: '1' });
    const headline = readJson(args.out);
    const kept = {
      rows: headline.rows,
      losses: headline.losses,
      runs: headline.runs,
      environment: headline.environment,
      measuredAt: headline.measuredAt,
      warmup: headline.warmup,
      discardedWarmup: headline.discardedWarmup,
    };
    const sandboxAb = buildSandboxAb(readJson(defaultOut), readJson(noSandboxOut));
    const rel = relative(ROOT, args.out).split(sep).join('/');
    sandboxAb.rerun = `npm run benchmark:slice1 -- --sandbox-ab --runs ${args.runs} --out ${rel}`;
    const merged = { ...headline, protocol: PROTOCOL, sandboxAb };
    for (const key of Object.keys(kept)) {
      if (JSON.stringify(merged[key]) !== JSON.stringify(kept[key])) {
        throw new Error(`sandbox A/B tried to replace headline ${key}`);
      }
    }
    const published = redactBenchmarkTree(merged);
    const json = `${JSON.stringify(published, null, 2)}\n`;
    assertPortableBenchmarkJson(json);
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, json);
    const markdownPath = args.out.replace(/\.json$/i, '.md');
    writeFileSync(markdownPath, renderSlice1Board(published));
    console.log(markdownPath);
    console.log(args.out);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function toolVersions(peersDir, productVersion, gitSha) {
  const cli = readJson(resolve(peersDir, 'node_modules/@playwright/cli/package.json'));
  const playwright = readJson(resolve(peersDir, 'node_modules/playwright/package.json'));
  const devtools = readJson(resolve(peersDir, 'node_modules/chrome-devtools-mcp/package.json'));
  return [
    { name: 'chrome-cdp-ex', version: `${productVersion} (${gitSha})`, detail: 'CLI skills/chrome-cdp-ex/scripts/cdp.mjs' },
    { name: '@playwright/cli', version: cli.version, detail: `playwright ${playwright.version}` },
    { name: 'chrome-devtools-mcp', version: devtools.version, detail: 'CLI chrome-devtools, browserUrl attach' },
  ];
}

function versionFor(tools, name) {
  return tools.find(tool => tool.name === name)?.version || 'unknown';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/benchmark-slice1.mjs [--runs 3] [--tasks 1,2,3,4,5] [--out file.json] [--peers dir] [--chrome path] [--sandbox-ab]');
    console.log('SLICE1_NO_SANDBOX=1 adds --no-sandbox. The runner also adds it when the process uid is 0.');
    console.log('--sandbox-ab measures default sandbox and SLICE1_NO_SANDBOX=1, then attaches both arms without replacing headline rows.');
    return;
  }
  if (args.sandboxAb) {
    await runSandboxAb(args);
    return;
  }
  const peers = ensurePeers(args.peers);
  const product = readJson(resolve(ROOT, 'package.json'));
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const tools = toolVersions(args.peers, product.version, gitSha);
  const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
  const pretty = osRelease.match(/^PRETTY_NAME="(.*)"$/m)?.[1] || execFileSync('uname', ['-sr'], { encoding: 'utf8' }).trim();
  const uname = execFileSync('uname', ['-srmo'], { encoding: 'utf8' }).trim();
  const chromeVersion = execFileSync(args.chrome, ['--version'], { encoding: 'utf8' }).trim();

  const httpServer = createServer((request, response) => {
    const name = String(request.url || '/').replace(/^\//, '').split('?')[0] || 'session';
    let html = '';
    try {
      html = fixtureHtml(name);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('missing fixture');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise(resolveListen => httpServer.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const port = await freePort();
  const nproc = readNproc();
  console.error(`waiting until 1-minute load average is below nproc ${nproc}`);
  const loadStart = await waitForIdle(nproc);
  const sandbox = chromeSandboxMode({
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    euid: typeof process.geteuid === 'function' ? process.geteuid() : null,
    envFlag: process.env.SLICE1_NO_SANDBOX || '',
  });
  const temps = [];
  const makeTemp = prefix => {
    const dir = mkdtempSync(resolve(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  };
  let profile = '';
  let runtimeDir = '';
  let workDir = '';
  let chromeLog = null;
  let chrome = null;
  let chromeArgs = [];
  let ctx = { page: null };
  const noopCommand = async () => ({ command: '', code: 1, wallMs: 0, agentChars: 0, output: '', stdout: '', stderr: '' });
  let cdpCmd = noopCommand;
  let pwCmd = noopCommand;
  let dtCmd = noopCommand;
  try {
  profile = makeTemp('slice1-chrome-');
  runtimeDir = makeTemp('slice1-xdg-');
  workDir = makeTemp('slice1-work-');
  chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-dev-shm-usage',
    ...(sandbox.noSandbox ? ['--no-sandbox'] : []),
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--window-position=0,0',
    `${origin}/session`,
  ];
  chromeLog = openSync(resolve(workDir, 'chrome.log'), 'w');
  chrome = spawn(args.chrome, chromeArgs, { detached: true, stdio: ['ignore', 'ignore', chromeLog] });
  chrome.unref();

  ctx = {
    port,
    origin,
    chromePid: chrome.pid,
    runtimeDir,
    workDir,
    pwBin: peers.pw,
    dtBin: peers.dt,
    pwSession: 'slice1',
    prefix: null,
    devtoolsPageId: null,
    page: null,
  };

  const cdpEnv = { ...process.env, CDP_PORT: String(port), XDG_RUNTIME_DIR: runtimeDir };
  delete cdpEnv.CI;
  const peerEnv = { ...process.env, NO_UPDATE_NOTIFIER: '1', CI: '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' };

  cdpCmd = commandArgs => runProcess(process.execPath, [CDP_BIN, ...commandArgs], { env: cdpEnv, cwd: workDir });
  pwCmd = commandArgs => runProcess(process.execPath, [peers.pw, `-s=${ctx.pwSession}`, ...commandArgs], { env: peerEnv, cwd: workDir });
  dtCmd = commandArgs => runProcess(process.execPath, [peers.dt, ...commandArgs], { env: peerEnv, cwd: workDir });

    const launched = await waitForBrowser(port);
    let attached = null;
    const attachDeadline = Date.now() + 10000;
    while (Date.now() < attachDeadline) {
      try {
        attached = await connectPage(port, origin);
        if (String(attached.url).startsWith(origin)) break;
        attached.client.close();
        attached = null;
      } catch { /* page list not ready */ }
      await sleep(150);
    }
    if (!attached) throw new Error('fixture tab did not appear');
    ctx.page = attached.client;
    ctx.targetId = attached.targetId;
    await waitForOrigin(ctx.page, origin);
    const initial = await applyViewport(ctx.page);
    console.error(`chrome ${launched.Browser} viewport ${initial.w}x${initial.h} dpr ${initial.dpr}`);

    const jobs = JOBS.filter(job => args.tasks.includes(job.task));
    const needsWarm = jobs.some(job => job.task !== 5);
    const warmup = [];
    if (needsWarm) {
      const list = await cdpCmd(['list', '--format', 'json']);
      warmup.push({ tool: 'chrome-cdp-ex', ...publicStep(list) });
      ctx.prefix = JSON.parse(list.stdout).pages.find(page => String(page.url).startsWith(origin))?.targetPrefix;
      if (!ctx.prefix) throw new Error('chrome-cdp-ex list did not return the fixture page');
      warmup.push({ tool: '@playwright/cli', ...publicStep(await pwCmd(['attach', `--cdp=http://127.0.0.1:${port}`])) });
      warmup.push({ tool: 'chrome-devtools-mcp', ...publicStep(await dtCmd(['start', `--browserUrl=http://127.0.0.1:${port}`, '--no-usage-statistics', '--headless=false'])) });
      const pages = await dtCmd(['list_pages']);
      warmup.push({ tool: 'chrome-devtools-mcp', ...publicStep(pages) });
      ctx.devtoolsPageId = extractDevtoolsPageId(pages.output);
      if (!ctx.devtoolsPageId) throw new Error(`chrome-devtools list_pages had no page id:\n${pages.output}`);
    }

    const runs = [];
    const discardedWarmup = [];
    for (const job of jobs) {
      for (const tool of TOOLS) {
        console.error(`discard ${job.id} ${tool}`);
        const discarded = await executeJob(job, tool);
        discardedWarmup.push({
          jobId: job.id,
          tool,
          discarded: true,
          pass: discarded.pass,
          steps: discarded.steps,
          wallMs: discarded.wallMs,
          agentChars: discarded.agentChars,
          notes: discarded.notes,
          commands: (discarded.commands || []).map(command => command.command),
        });
        console.error(`  discarded ${discarded.pass ? 'PASS' : 'FAIL'} steps=${discarded.steps} chars=${discarded.agentChars} ms=${discarded.wallMs} ${discarded.notes}`);
      }
      for (let index = 0; index < args.runs; index += 1) {
        const order = TOOLS.map((_, toolIndex) => TOOLS[(toolIndex + index) % TOOLS.length]);
        for (const tool of order) {
          console.error(`run ${index + 1} ${job.id} ${tool}`);
          const result = await executeJob(job, tool);
          runs.push({
            jobId: job.id,
            tool,
            version: versionFor(tools, tool),
            run: index + 1,
            ...result,
          });
          console.error(`  ${result.pass ? 'PASS' : 'FAIL'} steps=${result.steps} chars=${result.agentChars} ms=${result.wallMs} ${result.notes}`);
        }
      }
    }

    const rows = jobs.flatMap(job => TOOLS.filter(tool => runs.some(run => run.jobId === job.id && run.tool === tool)).map(tool => {
      const samples = runs.filter(run => run.jobId === job.id && run.tool === tool);
      const summary = summarizeTool(samples);
      const detail = [...new Set(samples.map(sample => sample.notes))].join(' | ');
      const timing = coveredClickTimingNote(tool, samples);
      const notes = timing ? `${summary.notes}. ${detail}. ${timing}` : `${summary.notes}. ${detail}`;
      return {
        jobId: job.id,
        tool,
        version: versionFor(tools, tool),
        pass: summary.pass,
        steps: summary.steps,
        wallMs: summary.wallMs,
        agentChars: summary.agentChars,
        notes,
      };
    }));
    const losses = findLosses(rows, SUBJECT_TOOL);
    const measuredAt = new Date().toISOString();
    const loadEnd = sampleLoad();
    console.error(`load end ${formatLoadSample(loadEnd)} nproc ${nproc}`);
    const report = {
      schema: 'chrome-cdp-ex.slice1-benchmark.v1',
      date: measuredAt.slice(0, 10),
      measuredAt,
      gitSha,
      productVersion: product.version,
      environment: {
        os: `${pretty}; ${uname}`,
        node: process.version,
        chrome: `${chromeVersion}; CDP ${launched.Browser}; ${launched['WebKit-Version'] || ''}`.trim(),
        chromeBinary: args.chrome,
        chromeArgs: recordedChromeArgs(chromeArgs),
        noSandbox: sandbox.noSandbox,
        noSandboxReason: sandbox.reason,
        nproc,
        loadAvg: { start: loadStart, end: loadEnd },
      },
      viewport: { ...VIEWPORT, readback: `${initial.w}x${initial.h} dpr ${initial.dpr}` },
      runsPerTool: args.runs,
      discardedWarmupPerTool: true,
      tokenEstimator: TOKEN_ESTIMATOR,
      tools,
      protocol: PROTOCOL,
      rerun: 'npm run benchmark:slice1 -- --runs 3 --out docs/benchmarks/2026-10-08-slice1.json',
      warmup: warmup.map(step => ({ tool: step.tool, command: step.command, code: step.code, wallMs: step.wallMs, agentChars: step.agentChars })),
      discardedWarmup,
      rows,
      losses,
      runs,
    };
    const published = redactBenchmarkTree(report);
    const json = `${JSON.stringify(published, null, 2)}\n`;
    assertPortableBenchmarkJson(json);
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, json);
    const markdownPath = args.out.replace(/\.json$/i, '.md');
    writeFileSync(markdownPath, renderSlice1Board(published));
    console.log(markdownPath);
    console.log(args.out);
  } finally {
    try { ctx.page?.close(); } catch { /* already closed */ }
    await cdpCmd(['stop']).catch(() => {});
    await pwCmd(['detach']).catch(() => {});
    await dtCmd(['stop']).catch(() => {});
    await stopChrome(chrome);
    if (chromeLog !== null) {
      try { closeSync(chromeLog); } catch { /* already closed */ }
    }
    httpServer.close();
    for (const dir of temps) removeTemp(dir);
  }

  async function executeJob(job, tool) {
    try {
      return await runJob(job, tool);
    } catch (error) {
      return {
        pass: false,
        steps: 0,
        wallMs: 0,
        agentChars: 0,
        notes: `harness error: ${error.message}`,
        groundTruth: null,
        commands: [],
      };
    }
  }

  function publicStep(step) {
    return { command: step.command, code: step.code, wallMs: step.wallMs, agentChars: step.agentChars, output: step.output };
  }

  async function runJob(job, tool) {
    if (job.task === 1) return runOverlay(tool);
    if (job.task === 2) return runCovered(tool);
    if (job.task === 3) return runDense(tool);
    if (job.task === 4) return runStale(tool);
    if (job.task === 5) return runAttach(tool);
    throw new Error(`unknown task ${job.task}`);
  }

  async function runOverlay(tool) {
    await prepare(ctx, 'overlay');
    const step = tool === 'chrome-cdp-ex'
      ? await cdpCmd(['overlay', ctx.prefix])
      : tool === '@playwright/cli'
        ? await pwCmd(['snapshot'])
        : await dtCmd(['take_snapshot', ctx.devtoolsPageId]);
    const groundTruth = await readTruth(ctx.page);
    return finish([step], scoreOverlayHonesty({ output: step.output, groundTruth }), groundTruth);
  }

  async function runCovered(tool) {
    await prepare(ctx, 'covered');
    const steps = [];
    if (tool === 'chrome-devtools-mcp') {
      const snap = await dtCmd(['take_snapshot', ctx.devtoolsPageId]);
      steps.push(snap);
      const uid = extractDevtoolsUid(snap.output, 'Submit transfer');
      if (!uid) {
        return finish(steps, { pass: false, notes: 'take_snapshot did not expose Submit transfer' }, await readTruth(ctx.page));
      }
      steps.push(await dtCmd(['click', ctx.devtoolsPageId, uid]));
    } else if (tool === '@playwright/cli') {
      steps.push(await pwCmd(['click', '#submit']));
    } else {
      steps.push(await cdpCmd(['click', ctx.prefix, '#submit']));
    }
    const groundTruth = await readTruth(ctx.page);
    return finish(steps, scoreCoveredClick({ output: steps.map(step => step.output).join('\n'), groundTruth }), groundTruth);
  }

  async function runDense(tool) {
    await prepare(ctx, 'dense');
    const step = tool === 'chrome-cdp-ex'
      ? await cdpCmd(['perceive', ctx.prefix, '-C', '-d', '8'])
      : tool === '@playwright/cli'
        ? await pwCmd(['snapshot'])
        : await dtCmd(['take_snapshot', ctx.devtoolsPageId]);
    const groundTruth = await readTruth(ctx.page);
    return finish([step], scoreDenseObservation({ output: step.output }), groundTruth);
  }

  function observe(tool) {
    if (tool === 'chrome-cdp-ex') return cdpCmd(['perceive', ctx.prefix, '-C', '-d', '8']);
    if (tool === '@playwright/cli') return pwCmd(['snapshot']);
    return dtCmd(['take_snapshot', ctx.devtoolsPageId]);
  }

  function refFrom(tool, output) {
    if (tool === 'chrome-cdp-ex') return extractChromeCdpRef(output, 'Save draft');
    if (tool === '@playwright/cli') return extractPlaywrightRef(output, 'Save draft');
    return extractDevtoolsUid(output, 'Save draft');
  }

  function clickRef(tool, ref) {
    if (tool === 'chrome-cdp-ex') return cdpCmd(['click', ctx.prefix, ref]);
    if (tool === '@playwright/cli') return pwCmd(['click', ref]);
    return dtCmd(['click', ctx.devtoolsPageId, ref]);
  }

  async function runStale(tool) {
    await prepare(ctx, 'stale');
    const steps = [];
    const first = await observe(tool);
    steps.push(first);
    const ref = refFrom(tool, first.output);
    if (!ref) {
      return finish(steps, { pass: false, notes: 'observation did not expose a Save draft ref' }, await readTruth(ctx.page));
    }
    const rewritten = await ctx.page.send('Runtime.evaluate', { expression: 'window.__slice1Rewrite()', returnByValue: true });
    if (rewritten.result?.value !== 'rewritten') {
      throw new Error(`harness rewrite failed: ${JSON.stringify(rewritten)}`);
    }
    const clicked = await clickRef(tool, ref);
    steps.push(clicked);
    let groundTruth = await readTruth(ctx.page);
    if (groundTruth.status !== 'saved:fresh') {
      const again = await observe(tool);
      steps.push(again);
      const nextRef = refFrom(tool, again.output);
      if (!nextRef) {
        const score = scoreStaleRecovery({ groundTruth });
        score.notes += '; recovery observation did not expose a new Save draft ref';
        return finish(steps, score, groundTruth);
      }
      steps.push(await clickRef(tool, nextRef));
      groundTruth = await readTruth(ctx.page);
    }
    const score = scoreStaleRecovery({ groundTruth });
    const clickNote = staleClickNote(clicked.output);
    if (clickNote) score.notes += `; ${clickNote}`;
    if (steps.length > 2) score.notes += '; recovery observation and click followed the rejected ref';
    else if (groundTruth.status === 'saved:fresh') score.notes += '; first post-rewrite click reached the fresh control';
    return finish(steps, score, groundTruth);
  }

  async function stopTools() {
    await cdpCmd(['stop']);
    await pwCmd(['detach']);
    await dtCmd(['stop']);
  }

  async function runAttach(tool) {
    await stopTools();
    await prepare(ctx, 'session');
    const before = await browserId(port);
    if (!before) throw new Error('Chrome CDP was gone before the cold attach');
    const steps = [];
    if (tool === 'chrome-cdp-ex') {
      const list = await cdpCmd(['list']);
      steps.push(list);
      const prefix = extractChromeCdpListPrefix(list.output, origin) || ctx.prefix;
      if (!prefix) throw new Error('list did not identify the existing tab');
      ctx.prefix = prefix;
      steps.push(await cdpCmd(['cookies', prefix]));
    } else if (tool === '@playwright/cli') {
      steps.push(await pwCmd(['attach', `--cdp=http://127.0.0.1:${port}`]));
      steps.push(await pwCmd(['cookie-list']));
    } else {
      steps.push(await dtCmd(['start', `--browserUrl=http://127.0.0.1:${port}`, '--no-usage-statistics', '--headless=false']));
      const pages = await dtCmd(['list_pages']);
      steps.push(pages);
      const pageId = extractDevtoolsPageId(pages.output);
      if (!pageId) {
        const afterMissing = await browserId(port);
        return finish(steps, scoreAttachSession({ output: steps.map(step => step.output).join('\n'), browserUnchanged: before === afterMissing }), { browserBefore: before, browserAfter: afterMissing });
      }
      ctx.devtoolsPageId = pageId;
      steps.push(await dtCmd(['evaluate_script', '() => document.cookie', '--pageId', pageId, '--waitForStableDom', 'false']));
    }
    const after = await browserId(port);
    const groundTruth = await readTruth(ctx.page).catch(() => null);
    const score = scoreAttachSession({
      output: steps.map(step => step.output).join('\n'),
      browserUnchanged: Boolean(before) && before === after,
    });
    if (groundTruth && !String(groundTruth.cookie).includes('already-set')) {
      score.pass = false;
      score.notes += '; page readback no longer had the cookie';
    }
    return finish(steps, score, { ...(groundTruth || {}), browserBefore: before, browserAfter: after });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
