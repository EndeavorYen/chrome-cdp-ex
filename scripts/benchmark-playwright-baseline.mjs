#!/usr/bin/env node
import { createServer } from 'http';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const page = resolve(__dirname, 'smoke-page.html');

const DIFFERENTIATOR_PROBES = Object.freeze([
  'modalOverlay',
  'frameRefs',
  'cssTrace',
  'hmrDomUpdate',
]);

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

function probeLooksSuccessful(probe, step) {
  if (!step || step.ok === false) return false;
  if (typeof step.success === 'boolean') return step.success;
  const text = stringOutput(step.output ?? step.result ?? step.stdout ?? '');
  if (probe === 'modalOverlay') return /dialog|overlay|aria-modal|visible|motd/i.test(text);
  if (probe === 'frameRefs') return /iframe|frame|smoke-child|child action/i.test(text);
  if (probe === 'cssTrace') return /sourceTrace"?\s*:\s*true|stylesheet source|source file|selector/i.test(text);
  if (probe === 'hmrDomUpdate') return /hmr|diff|mutation|added|ready/i.test(text);
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

export function summarizePlaywrightSteps(steps = []) {
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

export function buildPlaywrightRawBaseline({ steps = [], source = 'measured-playwright-baseline', note = 'Measured Playwright raw baseline.', id = 'playwright', label = 'Measured Playwright harness' } = {}) {
  const metrics = summarizePlaywrightSteps(steps);
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

export function parsePlaywrightBaselineArgs(argv = []) {
  const opts = {
    fromStepsPath: null,
    outPath: null,
    source: null,
    note: null,
    serverPort: Number(process.env.PLAYWRIGHT_BASELINE_HTTP_PORT || 41810),
    headed: false,
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
    } else if (arg === '--server-port') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) opts.serverPort = value;
    } else if (arg === '--headed') {
      opts.headed = true;
    }
  }
  return opts;
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    throw new Error(`Playwright package is not available. Run with --from-steps, or install Playwright for live measurement. Original error: ${err.message || err}`);
  }
}

async function recordStep(steps, name, command, run, probe = null, success = undefined) {
  const startedAt = Date.now();
  try {
    const result = await run();
    const endedAt = Date.now();
    const step = { name, command, probe, startedAt, endedAt, ok: true, output: result };
    if (typeof success === 'boolean') step.success = success;
    steps.push(step);
    return result;
  } catch (err) {
    const endedAt = Date.now();
    steps.push({ name, command, probe, startedAt, endedAt, ok: false, output: String(err.message || err) });
    throw err;
  }
}

async function runLivePlaywrightSteps({ serverPort, headed }) {
  if (!existsSync(page)) throw new Error(`smoke page not found: ${page}`);
  const playwright = await loadPlaywright();
  let server;
  let browser;
  const steps = [];

  const cleanup = async () => {
    try { if (browser) await browser.close(); } catch {}
    if (server) server.close();
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
        res.end('{"ok":false,"error":"playwright baseline diagnostic"}');
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
    browser = await playwright.chromium.launch({
      headless: !headed,
    });
    const pageRef = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await recordStep(steps, 'navigate', 'page.goto', async () => {
      await pageRef.goto(url);
      return { title: await pageRef.title(), url: pageRef.url() };
    });
    await recordStep(steps, 'snapshot', 'page.locator("body").innerText', async () => {
      const text = await pageRef.locator('body').innerText();
      return text.slice(0, 6000);
    });
    await recordStep(steps, 'modal-probe', 'page.getByRole("dialog")', async () => ({
      visible: await pageRef.getByRole('dialog', { name: 'MOTD' }).isVisible(),
      name: 'MOTD',
    }), 'modalOverlay');
    await recordStep(steps, 'frame-probe', 'page.frameLocator', async () => ({
      frame: 'Smoke child frame',
      button: await pageRef.frameLocator('iframe[name="smoke-child"]').locator('#child-action').innerText(),
    }), 'frameRefs');
    await recordStep(steps, 'css-probe', 'locator.evaluate(getComputedStyle)', async () => ({
      cursor: await pageRef.locator('#custom-clickable').evaluate(el => el.ownerDocument.defaultView.getComputedStyle(el).cursor),
      sourceTrace: false,
    }), 'cssTrace', false);
    await recordStep(steps, 'click-probe', 'locator.click', async () => {
      await pageRef.getByRole('button', { name: 'Run combat' }).click();
      return { clicked: 'Run combat' };
    });
    await recordStep(steps, 'hmr-probe', 'page.evaluate + locator.innerText', async () => {
      await pageRef.evaluate(() => {
        if (typeof globalThis.appendLog === 'function') globalThis.appendLog('hmr panel ready');
      });
      return (await pageRef.locator('#combat-log').innerText()).slice(-1000);
    }, 'hmrDomUpdate');

    return steps;
  } finally {
    await cleanup();
  }
}

function readTranscriptSteps(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.steps)) return parsed.steps;
  throw new Error(`Playwright transcript must be an array or include a steps array: ${filePath}`);
}

export async function runPlaywrightBaseline(argv = process.argv.slice(2)) {
  const opts = parsePlaywrightBaselineArgs(argv);
  const steps = opts.fromStepsPath
    ? readTranscriptSteps(opts.fromStepsPath)
    : await runLivePlaywrightSteps({ serverPort: opts.serverPort, headed: opts.headed });
  const output = buildPlaywrightRawBaseline({
    steps,
    source: opts.source || (opts.fromStepsPath ? 'transcript-playwright-baseline' : 'measured-playwright-baseline'),
    note: opts.note || (opts.fromStepsPath
      ? `Playwright baseline built from ${opts.fromStepsPath}.`
      : 'Measured by launching a disposable Playwright Chromium context against the smoke page.'),
  });
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (opts.outPath) {
    writeFileSync(opts.outPath, text);
    return opts.outPath;
  }
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runPlaywrightBaseline()
    .then(out => {
      if (!process.argv.includes('--out')) process.stdout.write(out);
    })
    .catch(err => {
      console.error(`Playwright baseline failed: ${err.message || err}`);
      process.exit(1);
    });
}
