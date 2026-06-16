#!/usr/bin/env node
import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const page = resolve(__dirname, 'smoke-page.html');

const DIFFERENTIATOR_PROBES = Object.freeze([
  'modalOverlay',
  'frameRefs',
  'cssTrace',
  'hmrDomUpdate',
]);

const LIVE_OBSERVE_SCRIPT = String.raw`(() => {
  const text = document.body ? document.body.innerText.slice(0, 6000) : '';
  const clickables = [...document.querySelectorAll('button, input, a, [role=button], [onclick], [tabindex]')]
    .slice(0, 80)
    .map((el) => ({
      tag: el.tagName,
      id: el.id || '',
      role: el.getAttribute('role') || '',
      label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 80),
    }));
  const dialogs = [...document.querySelectorAll('[role=dialog], dialog, [aria-modal=true]')]
    .filter((el) => !el.hidden)
    .map((el) => ({ id: el.id || '', label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 120) }));
  const frames = [...document.querySelectorAll('iframe')]
    .map((el) => ({ name: el.name || '', title: el.title || '', src: el.src || 'srcdoc' }));
  const styles = [...document.styleSheets].map((sheet) => {
    try {
      return {
        href: sheet.href || 'inline',
        rules: [...sheet.cssRules].slice(0, 20).map((rule) => rule.cssText.slice(0, 240)),
      };
    } catch (err) {
      return { href: sheet.href || 'blocked', error: String(err.message || err) };
    }
  });
  return { title: document.title, url: location.href, text, clickables, dialogs, frames, styles };
})()`;

const LIVE_CLICK_SCRIPT = String.raw`(() => {
  const el = document.querySelector('#close-modal') || document.querySelector('#combat');
  if (!el) return { ok: false, reason: 'no target' };
  el.click();
  return { ok: true, id: el.id || '', text: el.textContent.trim() };
})()`;

const LIVE_DIFF_SCRIPT = String.raw`(() => {
  const before = document.querySelector('#combat-log')?.innerText || '';
  if (typeof appendLog === 'function') appendLog('hmr panel ready');
  const after = document.querySelector('#combat-log')?.innerText || '';
  return { beforeLen: before.length, afterLen: after.length, added: after.slice(before.length).trim() };
})()`;

export function estimateTokenCount(value) {
  const chars = typeof value === 'number' ? value : String(value || '').length;
  return Math.ceil(Math.max(0, chars) / 4);
}

function stringOutput(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function metricNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStep(step = {}, index = 0) {
  const stdout = stringOutput(step.stdout);
  const stderr = stringOutput(step.stderr);
  const output = stringOutput(step.output ?? step.result ?? `${stdout}${stderr}`);
  const startedAt = step.startedAt == null ? null : metricNumber(step.startedAt, null);
  const endedAt = step.endedAt == null ? null : metricNumber(step.endedAt, null);
  const status = step.status == null ? null : Number(step.status);
  const ok = typeof step.ok === 'boolean' ? step.ok : (status == null ? true : status === 0);
  const durationMs = startedAt != null && endedAt != null
    ? Math.max(0, endedAt - startedAt)
    : metricNumber(step.durationMs, 0);
  return {
    name: step.name || `step-${index + 1}`,
    command: step.command || step.method || step.name || `step-${index + 1}`,
    probe: normalizeProbeName(step.probe || step.name || ''),
    ok,
    status,
    startedAt,
    endedAt,
    durationMs,
    outputChars: output.length,
    estimatedTokens: estimateTokenCount(output.length),
  };
}

function normalizeProbeName(value) {
  const raw = String(value || '').trim();
  if (DIFFERENTIATOR_PROBES.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  if (/modal|overlay|dialog/.test(lower)) return 'modalOverlay';
  if (/frame|iframe/.test(lower)) return 'frameRefs';
  if (/css|style|cascade/.test(lower)) return 'cssTrace';
  if (/hmr|diff|dom[-_ ]?update|mutation/.test(lower)) return 'hmrDomUpdate';
  return null;
}

function probeLooksSuccessful(probe, step) {
  if (!step || step.ok === false) return false;
  const text = stringOutput(step.output ?? step.result ?? step.stdout ?? '');
  if (typeof step.success === 'boolean') return step.success;
  if (probe === 'modalOverlay') return /dialog|overlay|aria-modal|blocking|motd/i.test(text);
  if (probe === 'frameRefs') return /iframe|frame|smoke-child/i.test(text);
  if (probe === 'cssTrace') return /source|stylesheet|cssrule|inline|cursor|css/i.test(text);
  if (probe === 'hmrDomUpdate') return /hmr|diff|mutation|added|afterLen/i.test(text);
  return true;
}

function summarizeDifferentiators(steps = []) {
  const byProbe = Object.fromEntries(DIFFERENTIATOR_PROBES.map(probe => [probe, {
    success: false,
    durationMs: 0,
    commandCalls: 0,
  }]));
  for (const step of steps) {
    if (!step.probe || !byProbe[step.probe]) continue;
    byProbe[step.probe].commandCalls += 1;
    byProbe[step.probe].durationMs += step.durationMs;
    byProbe[step.probe].success ||= probeLooksSuccessful(step.probe, step);
  }
  const successRate = DIFFERENTIATOR_PROBES.filter(probe => byProbe[probe].success).length / DIFFERENTIATOR_PROBES.length;
  return { ...byProbe, successRate };
}

function totalStepMs(steps = []) {
  const starts = steps.map(step => step.startedAt).filter(v => v != null);
  const ends = steps.map(step => step.endedAt).filter(v => v != null);
  if (starts.length && ends.length) return Math.max(0, Math.max(...ends) - Math.min(...starts));
  return steps.reduce((sum, step) => sum + step.durationMs, 0);
}

export function summarizeGenericCdpSteps(steps = []) {
  const normalizedSteps = steps.map(normalizeStep);
  const outputChars = normalizedSteps.reduce((sum, step) => sum + step.outputChars, 0);
  const differentiators = summarizeDifferentiators(steps.map((step, index) => ({
    ...step,
    ...normalizedSteps[index],
    output: step.output ?? step.result ?? step.stdout,
  })));
  return {
    commandCalls: normalizedSteps.length,
    outputChars,
    usefulObservationTokens: estimateTokenCount(outputChars),
    verificationCallsSaved: 0,
    differentiatorSuccessRate: differentiators.successRate,
    details: {
      totalMs: totalStepMs(normalizedSteps),
      differentiators,
      steps: normalizedSteps,
    },
  };
}

export function buildGenericCdpRawBaseline({ steps = [], source = 'measured-generic-cdp-baseline', note = 'Measured generic CDP raw baseline.', id = 'generic-cdp', label = 'Measured generic CDP harness' } = {}) {
  const metrics = summarizeGenericCdpSteps(steps);
  return {
    schema: 'chrome-cdp-ex.raw-baseline-results.v1',
    source,
    note,
    runs: [
      {
        id,
        label,
        commandCalls: metrics.commandCalls,
        usefulObservationTokens: metrics.usefulObservationTokens,
        verificationCallsSaved: metrics.verificationCallsSaved,
        differentiatorSuccessRate: metrics.differentiatorSuccessRate,
        autoEvidenceActions: 0,
        hasReportTimeline: false,
        staleRefRecoveryRate: 0,
        sessionStabilitySample: false,
        details: metrics.details,
      },
    ],
  };
}

export function parseGenericCdpBaselineArgs(argv = []) {
  const opts = {
    fromStepsPath: null,
    outPath: null,
    source: null,
    note: null,
    port: Number(process.env.CDP_GENERIC_BASELINE_PORT || 9444),
    serverPort: Number(process.env.CDP_GENERIC_BASELINE_HTTP_PORT || 41800),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-steps') {
      opts.fromStepsPath = argv[++i] || null;
    } else if (arg === '--out') {
      opts.outPath = argv[++i] || null;
    } else if (arg === '--source') {
      opts.source = argv[++i] || null;
    } else if (arg === '--note') {
      opts.note = argv[++i] || null;
    } else if (arg === '--port') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) opts.port = value;
    } else if (arg === '--server-port') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) opts.serverPort = value;
    }
  }
  return opts;
}

function browserCandidates() {
  return [
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge'],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
    ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'brave'],
    ['/usr/bin/google-chrome', 'chrome'],
    ['/usr/bin/chromium', 'chromium'],
    ['/usr/bin/microsoft-edge', 'edge'],
  ].filter(([p]) => existsSync(p));
}

async function wait(ms) {
  await new Promise(resolveWait => setTimeout(resolveWait, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

class RawCdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    await new Promise((resolveConnect, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolveConnect();
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message || e.type}`));
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      };
      ws.onclose = () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP websocket closed'));
        this.pending.clear();
      };
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('CDP websocket is not open');
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function recordStep(steps, name, command, run, probe = null) {
  const startedAt = Date.now();
  try {
    const result = await run();
    const endedAt = Date.now();
    steps.push({ name, command, probe, startedAt, endedAt, ok: true, output: result });
    return result;
  } catch (err) {
    const endedAt = Date.now();
    steps.push({ name, command, probe, startedAt, endedAt, ok: false, output: String(err.message || err) });
    throw err;
  }
}

async function runLiveGenericCdpSteps({ port, serverPort }) {
  if (!existsSync(page)) throw new Error(`smoke page not found: ${page}`);
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error('no supported Chrome/Edge/Brave browser binary found');

  const [browserPath, browserName] = candidates[0];
  const profileDir = mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-generic-cdp-${browserName}-`));
  let browser;
  let server;
  let cdp;
  const steps = [];

  const cleanup = () => {
    cdp?.close();
    if (browser && !browser.killed) browser.kill('SIGTERM');
    if (server) server.close();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  try {
    server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/smoke-page.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(page));
        return;
      }
      if (req.url?.startsWith('/api/fail')) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"error":"generic baseline diagnostic"}');
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

    let target = null;
    for (let i = 0; i < 30; i++) {
      try {
        const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
        target = targets.find(t => t.type === 'page' && /smoke-page\.html/.test(t.url || '')) || targets.find(t => t.type === 'page');
        if (target?.webSocketDebuggerUrl) break;
      } catch {}
      await wait(300);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('Browser did not expose a page target via /json');

    await recordStep(steps, 'json-tabs', 'GET /json', () => fetchJson(`http://127.0.0.1:${port}/json`));
    cdp = new RawCdpClient(target.webSocketDebuggerUrl);
    await recordStep(steps, 'websocket-connect', 'new WebSocket(page.webSocketDebuggerUrl)', () => cdp.connect().then(() => ({ ok: true })));
    await recordStep(steps, 'runtime-enable', 'Runtime.enable', () => cdp.send('Runtime.enable'));
    await recordStep(steps, 'dom-summary', 'Runtime.evaluate', () => cdp.send('Runtime.evaluate', {
      expression: LIVE_OBSERVE_SCRIPT,
      returnByValue: true,
      awaitPromise: true,
    }).then(res => res.result?.value || res), 'modalOverlay');
    await recordStep(steps, 'frame-probe', 'Runtime.evaluate', () => cdp.send('Runtime.evaluate', {
      expression: '([...document.querySelectorAll("iframe")].map(el => ({name: el.name || "", title: el.title || "", src: el.src || "srcdoc"})))',
      returnByValue: true,
    }).then(res => res.result?.value || res), 'frameRefs');
    await recordStep(steps, 'css-probe', 'Runtime.evaluate', () => cdp.send('Runtime.evaluate', {
      expression: '([...document.styleSheets].map(sheet => { try { return {href: sheet.href || "inline", rules: [...sheet.cssRules].slice(0, 8).map(r => r.cssText)}; } catch (err) { return {error: String(err)}; } }))',
      returnByValue: true,
    }).then(res => res.result?.value || res), 'cssTrace');
    await recordStep(steps, 'click-probe', 'Runtime.evaluate', () => cdp.send('Runtime.evaluate', {
      expression: LIVE_CLICK_SCRIPT,
      returnByValue: true,
      awaitPromise: true,
    }).then(res => res.result?.value || res));
    await recordStep(steps, 'hmr-probe', 'Runtime.evaluate', () => cdp.send('Runtime.evaluate', {
      expression: LIVE_DIFF_SCRIPT,
      returnByValue: true,
      awaitPromise: true,
    }).then(res => res.result?.value || res), 'hmrDomUpdate');

    return steps;
  } finally {
    cleanup();
  }
}

function readTranscriptSteps(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.steps)) return parsed.steps;
  throw new Error(`generic CDP transcript must be an array or include a steps array: ${filePath}`);
}

export async function runGenericCdpBaseline(argv = process.argv.slice(2)) {
  const opts = parseGenericCdpBaselineArgs(argv);
  const steps = opts.fromStepsPath
    ? readTranscriptSteps(opts.fromStepsPath)
    : await runLiveGenericCdpSteps({ port: opts.port, serverPort: opts.serverPort });
  const output = buildGenericCdpRawBaseline({
    steps,
    source: opts.source || (opts.fromStepsPath ? 'transcript-generic-cdp-baseline' : 'measured-generic-cdp-baseline'),
    note: opts.note || (opts.fromStepsPath
      ? `Generic CDP baseline built from ${opts.fromStepsPath}.`
      : 'Measured by launching a disposable browser and using raw CDP primitives.'),
  });
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (opts.outPath) {
    writeFileSync(opts.outPath, text);
    return opts.outPath;
  }
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runGenericCdpBaseline()
    .then(out => {
      if (!process.argv.includes('--out')) process.stdout.write(out);
    })
    .catch(err => {
      console.error(`Generic CDP baseline failed: ${err.message || err}`);
      process.exit(1);
    });
}
