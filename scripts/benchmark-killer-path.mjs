#!/usr/bin/env node
import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cdp = resolve(repoRoot, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const page = resolve(__dirname, 'smoke-page.html');

const MUTATING_COMMANDS = new Set([
  'click', 'fill', 'type', 'press', 'select', 'scroll', 'nav', 'back', 'forward',
  'reload', 'viewport', 'inject', 'dismiss-modal', 'dismissmodal', 'upload',
]);

export function estimateTokenCount(value) {
  const chars = typeof value === 'number' ? value : String(value || '').length;
  return Math.ceil(Math.max(0, chars) / 4);
}

function outputText(step) {
  return `${step.stdout || ''}${step.stderr || ''}`;
}

function hasUsefulObservation(step) {
  const text = outputText(step);
  return step.name === 'perceive'
    || step.name === 'report'
    || /^Page:/m.test(text)
    || /Coords: top-level viewport CSS px/.test(text)
    || /Session report:[\s\S]*Action timeline:/m.test(text);
}

function hasActionEvidence(step) {
  const text = outputText(step);
  const commandName = step.command?.[0] || step.name;
  return MUTATING_COMMANDS.has(commandName)
    && (/^[a-z-]+: dispatched/m.test(text)
      || /Action failure:/m.test(text)
      || /success but observation timed out/i.test(text));
}

function differentiatorProbe(steps, predicate) {
  const matches = steps.filter(predicate);
  const successful = matches.some(step => step.ok);
  return {
    success: successful,
    durationMs: matches.reduce((sum, step) => sum + step.durationMs, 0),
    commandCalls: matches.length,
  };
}

function benchmarkDifferentiators(steps) {
  const modalOverlay = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    return commandName === 'overlay' && /Overlay detector:/i.test(step.outputText || '');
  });
  const frameRefs = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    return (commandName === 'frame' || step.name === 'perceive-frame') && /@f\d+/i.test(step.outputText || '');
  });
  const cssTrace = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    const text = step.outputText || '';
    return commandName === 'cascade'
      && !/No matching CSS rules/i.test(text)
      && /(WIN|→|source|inline|sheet)/i.test(text);
  });
  const hmrDomUpdate = differentiatorProbe(steps, (step) => {
    const commandName = step.command?.[0] || step.name;
    const text = step.outputText || '';
    return (step.name === 'hmr-diff' || (commandName === 'perceive' && step.command?.includes('--diff')))
      && /hmr panel ready|spa|hot update/i.test(text)
      && /\+\+\+ Added|~~~ Text nodes updated|@/m.test(text);
  });
  const probes = [modalOverlay, frameRefs, cssTrace, hmrDomUpdate];
  const successRate = probes.filter(probe => probe.success).length / probes.length;
  return { modalOverlay, frameRefs, cssTrace, hmrDomUpdate, successRate };
}

function benchmarkStaleRefRecovery(steps) {
  const probes = steps.filter(step => step.expectedFailure && /stale-ref|Unknown ref|Refs were (cleared|invalidated)/i.test(step.outputText || ''));
  const recovered = probes.filter(step => /Next:\s*cdp perceive|Run "?perceive"?|Refresh refs/i.test(step.outputText || ''));
  return {
    success: probes.length > 0 && recovered.length === probes.length,
    durationMs: probes.reduce((sum, step) => sum + step.durationMs, 0),
    commandCalls: probes.length,
    recovered: recovered.length,
    rate: probes.length > 0 ? recovered.length / probes.length : 0,
  };
}

export function summarizeBenchmarkRun({ scenario = 'killer-path', startedAt, endedAt, target = '', steps = [] } = {}) {
  const normalizedSteps = steps.map((step) => {
    const text = outputText(step);
    const outputChars = text.length;
    const actionEvidence = hasActionEvidence(step);
    const expectedFailure = Boolean(step.expectedFailure);
    return {
      name: step.name,
      command: step.command || [],
      commandText: `cdp ${(step.command || []).join(' ')}`.trim(),
      ok: step.status === 0 || expectedFailure,
      status: step.status,
      expectedFailure,
      durationMs: Math.max(0, (step.endedAt ?? step.startedAt ?? 0) - (step.startedAt ?? 0)),
      outputChars,
      estimatedTokens: estimateTokenCount(outputChars),
      hasUsefulObservation: hasUsefulObservation(step),
      hasActionEvidence: actionEvidence,
      outputText: text,
    };
  });

  const firstObservation = normalizedSteps.find(step => step.ok && step.hasUsefulObservation);
  const failed = normalizedSteps.find(step => !step.ok);
  const outputChars = normalizedSteps.reduce((sum, step) => sum + step.outputChars, 0);
  const actionEvidenceSteps = normalizedSteps.filter(step => step.hasActionEvidence && !step.expectedFailure);
  const usefulObservationTokens = normalizedSteps
    .filter(step => step.hasUsefulObservation || step.hasActionEvidence)
    .reduce((sum, step) => sum + step.estimatedTokens, 0);
  const reportStep = steps.find(step => step.name === 'report');

  return {
    schema: 'chrome-cdp-ex.benchmark.v1',
    scenario,
    target,
    success: !failed,
    failedStep: failed?.name || null,
    metrics: {
      totalMs: Math.max(0, (endedAt ?? startedAt ?? 0) - (startedAt ?? 0)),
      commandCalls: normalizedSteps.length,
      firstUsefulObservationMs: firstObservation
        ? Math.max(0, (steps[normalizedSteps.indexOf(firstObservation)]?.endedAt ?? endedAt ?? 0) - (startedAt ?? 0))
        : null,
      outputChars,
      estimatedOutputTokens: estimateTokenCount(outputChars),
      usefulObservationTokens,
      autoEvidenceActions: actionEvidenceSteps.length,
      verificationCallsSaved: actionEvidenceSteps.length,
      hasReportTimeline: /Session report:[\s\S]*Action timeline:/m.test(outputText(reportStep || {})),
      differentiators: benchmarkDifferentiators(normalizedSteps),
      staleRefRecovery: benchmarkStaleRefRecovery(normalizedSteps),
    },
    steps: normalizedSteps.map(({ outputText: _outputText, ...step }) => step),
  };
}

export function formatBenchmarkReport(summary) {
  const differentiators = summary.metrics.differentiators || {};
  const pct = Math.round((differentiators.successRate || 0) * 100);
  const lines = [
    `chrome-cdp-ex benchmark: ${summary.scenario}`,
    `Success: ${summary.success ? 'yes' : 'no'}${summary.failedStep ? ` (failed at ${summary.failedStep})` : ''}`,
    `Target: ${summary.target || '(none)'}`,
    `Total time: ${summary.metrics.totalMs} ms`,
    `Command calls: ${summary.metrics.commandCalls}`,
    `First useful observation: ${summary.metrics.firstUsefulObservationMs ?? 'n/a'} ms`,
    `Output chars: ${summary.metrics.outputChars}`,
    `Estimated output tokens: ${summary.metrics.estimatedOutputTokens}`,
    `Useful observation tokens: ${summary.metrics.usefulObservationTokens}`,
    `Auto-evidence actions: ${summary.metrics.autoEvidenceActions}`,
    `Verification calls saved: ${summary.metrics.verificationCallsSaved}`,
    `Report timeline: ${summary.metrics.hasReportTimeline ? 'yes' : 'no'}`,
    `Differentiator success rate: ${pct}%`,
    `Modal/overlay: ${differentiators.modalOverlay?.success ? 'yes' : 'no'} (${differentiators.modalOverlay?.durationMs ?? 0} ms)`,
    `Frame refs: ${differentiators.frameRefs?.success ? 'yes' : 'no'} (${differentiators.frameRefs?.durationMs ?? 0} ms)`,
    `CSS trace: ${differentiators.cssTrace?.success ? 'yes' : 'no'} (${differentiators.cssTrace?.durationMs ?? 0} ms)`,
    `HMR/SPA diff: ${differentiators.hmrDomUpdate?.success ? 'yes' : 'no'} (${differentiators.hmrDomUpdate?.durationMs ?? 0} ms)`,
    `Stale-ref recovery: ${summary.metrics.staleRefRecovery?.success ? 'yes' : 'no'} (${summary.metrics.staleRefRecovery?.recovered ?? 0}/${summary.metrics.staleRefRecovery?.commandCalls ?? 0})`,
    '',
    'Steps:',
  ];
  for (const step of summary.steps) {
    const details = [
      step.hasActionEvidence ? 'evidence' : '',
      step.expectedFailure ? 'expected failure' : '',
    ].filter(Boolean).join(', ');
    const suffix = details ? `, ${details}` : '';
    lines.push(`  ${step.ok ? 'OK  ' : 'FAIL'} ${step.name}: ${step.durationMs} ms, ${step.estimatedTokens} tokens${suffix}`);
  }
  return lines.join('\n');
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

function runStep({ args, env, steps, name = args[0], timeout = 20000, expectedFailure = false }) {
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [cdp, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout,
  });
  const endedAt = Date.now();
  const step = {
    name,
    command: args,
    startedAt,
    endedAt,
    status: res.status ?? 1,
    expectedFailure,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
  steps.push(step);
  return step;
}

function assertStep(step) {
  if (step.status !== 0) {
    throw new Error(`cdp ${step.command.join(' ')} failed\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
  }
  return step.stdout.trim();
}

function assertExpectedFailure(step, pattern) {
  if (step.status === 0) {
    throw new Error(`cdp ${step.command.join(' ')} should have failed\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
  }
  const text = outputText(step);
  if (pattern && !pattern.test(text)) {
    throw new Error(`cdp ${step.command.join(' ')} failed without expected recovery evidence\nSTDOUT:\n${step.stdout}\nSTDERR:\n${step.stderr}`);
  }
  return text.trim();
}

export async function runKillerPathBenchmark({ port = Number(process.env.CDP_BENCH_PORT || 9334), serverPort = Number(process.env.CDP_BENCH_HTTP_PORT || 41738), json = false } = {}) {
  if (!existsSync(cdp)) throw new Error(`cdp script not found: ${cdp}`);
  if (!existsSync(page)) throw new Error(`smoke page not found: ${page}`);
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error('no supported Chrome/Edge/Brave browser binary found');

  const [browserPath, browserName] = candidates[0];
  const profileDir = mkdtempSync(resolve(tmpdir(), `chrome-cdp-ex-bench-${browserName}-`));
  let browser;
  let server;
  const steps = [];
  const startedAt = Date.now();
  let target = '';

  const cleanup = () => {
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
        res.end('{"ok":false,"error":"benchmark diagnostic"}');
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
    for (let i = 0; i < 30; i++) {
      const res = spawnSync(process.execPath, [cdp, 'list'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      if (res.status === 0 && res.stdout.includes('chrome-cdp-ex long-session smoke')) {
        target = res.stdout.trim().split(/\s+/)[0];
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (!target) throw new Error('Browser did not become reachable via cdp list');

    assertStep(runStep({ args: ['doctor'], env, steps }));
    assertStep(runStep({ args: ['list'], env, steps }));
    assertStep(runStep({ args: ['perceive', target, '-C', '-d', '8', '--keep-refs', '--last', '20'], env, steps }));
    assertStep(runStep({ args: ['overlay', target], env, steps }));
    assertStep(runStep({ args: ['frame', target], env, steps }));
    assertStep(runStep({ args: ['cascade', target, '#custom-clickable', 'cursor'], env, steps }));
    assertStep(runStep({ args: ['dismiss-modal', target], env, steps }));
    assertStep(runStep({ args: ['click', target, '#combat'], env, steps }));
    assertStep(runStep({ args: ['perceive', target, '--since-action'], env, steps }));
    assertStep(runStep({ args: ['report', target], env, steps }));
    assertStep(runStep({ args: ['perceive', target, '-s', '#combat-log', '-d', '6', '--last', '20'], env, steps, name: 'hmr-baseline' }));
    assertStep(runStep({
      args: [
        'eval',
        target,
        '(() => { if (typeof appendLog === "function") { appendLog("hmr panel ready"); return "hmr-added"; } const log = document.querySelector("#combat-log"); const el = document.createElement("p"); el.id = "hmr-panel"; el.textContent = "hmr panel ready"; log?.appendChild(el); if (log) log.scrollTop = log.scrollHeight; return "hmr-added"; })()',
      ],
      env,
      steps,
      name: 'hmr-mutate',
    }));
    assertStep(runStep({ args: ['perceive', target, '--diff', '-s', '#combat-log', '-d', '6', '--last', '20'], env, steps, name: 'hmr-diff' }));
    assertStep(runStep({ args: ['perceive', target, '-s', '#cmd', '-d', '4'], env, steps, name: 'stale-ref-setup' }));
    assertStep(runStep({ args: ['eval', target, 'location.reload(); "reload-dispatched"'], env, steps, name: 'stale-ref-mutate' }));
    assertStep(runStep({ args: ['wait', target, '1000'], env, steps, name: 'stale-ref-wait', timeout: 5000 }));
    assertExpectedFailure(
      runStep({ args: ['click', target, '@1'], env, steps, name: 'stale-ref', expectedFailure: true }),
      /Action failure: stale-ref|Unknown ref|Refs were (cleared|invalidated)|Next:\s*cdp perceive/i
    );

    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt,
      endedAt: Date.now(),
      target,
      steps,
    });
    summary.browser = browserName;
    summary.port = port;
    summary.url = url;
    return json ? JSON.stringify(summary, null, 2) : formatBenchmarkReport(summary);
  } finally {
    cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const json = process.argv.includes('--json');
  runKillerPathBenchmark({ json })
    .then(out => {
      console.log(out);
    })
    .catch(err => {
      console.error(`Benchmark failed: ${err.message || err}`);
      process.exit(1);
    });
}
