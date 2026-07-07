#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';

import { runKillerPathBenchmark, runLargeAppStressBenchmark } from './benchmark-killer-path.mjs';
import { runMcpBenchmark } from './benchmark-mcp-path.mjs';
import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';

const DEFAULT_TYPES = Object.freeze(['mcp', 'killer']);
const ALL_TYPES = Object.freeze(['mcp', 'killer', 'large-app']);

function parsePositiveInt(value, name, { min = 1, max = 100 } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${name} must be >= ${min}`);
  if (parsed > max) throw new Error(`${name} must be <= ${max}`);
  return parsed;
}

function parseTypes(value) {
  const types = String(value || '')
    .split(',')
    .map(type => type.trim())
    .filter(Boolean);
  if (!types.length) throw new Error('types must include at least one benchmark type');
  const invalid = types.filter(type => !ALL_TYPES.includes(type));
  if (invalid.length) throw new Error(`unknown benchmark type(s): ${invalid.join(', ')}`);
  return types;
}

export function parseCampaignArgs(argv = []) {
  const opts = {
    rounds: 10,
    types: [...DEFAULT_TYPES],
    portStart: Number(process.env.CDP_CAMPAIGN_PORT_START || 9440),
    serverPortStart: Number(process.env.CDP_CAMPAIGN_HTTP_PORT_START || 42140),
    stabilityMs: 1000,
    settleMs: 250,
    json: false,
    failFast: false,
    output: null,
    history: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--rounds') {
      opts.rounds = parsePositiveInt(argv[++i], 'rounds', { min: 1, max: 100 });
    } else if (arg === '--types') {
      opts.types = parseTypes(argv[++i]);
    } else if (arg === '--port-start') {
      opts.portStart = parsePositiveInt(argv[++i], 'port-start', { min: 1024, max: 65000 });
    } else if (arg === '--server-port-start') {
      opts.serverPortStart = parsePositiveInt(argv[++i], 'server-port-start', { min: 1024, max: 65000 });
    } else if (arg === '--stability-ms') {
      opts.stabilityMs = parsePositiveInt(argv[++i], 'stability-ms', { min: 0, max: 60000 });
    } else if (arg === '--settle-ms') {
      opts.settleMs = parsePositiveInt(argv[++i], 'settle-ms', { min: 0, max: 10000 });
    } else if (arg === '--output') {
      opts.output = argv[++i] || null;
      if (!opts.output) throw new Error('output path is required after --output');
    } else if (arg === '--history' || arg === '--history-file') {
      opts.history = argv[++i] || null;
      if (!opts.history) throw new Error('history path is required after --history');
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--fail-fast') {
      opts.failFast = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function buildCampaignRoundPlan({
  rounds = 10,
  types = [...DEFAULT_TYPES],
  portStart = 9440,
  serverPortStart = 42140,
} = {}) {
  return Array.from({ length: rounds }, (_, index) => ({
    round: index + 1,
    type: types[index % types.length],
    port: portStart + index,
    serverPort: serverPortStart + index,
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseBenchmarkSummary(raw) {
  if (raw && typeof raw === 'object') return raw;
  return JSON.parse(String(raw || '').trim());
}

function metricValue(result = {}, key, fallback = null) {
  return result.metrics && Object.hasOwn(result.metrics, key) ? result.metrics[key] : fallback;
}

export function compactCampaignRound(plan, result, timing = {}) {
  const gatePassed = result?.gate?.passed === true;
  const success = result?.success === true && gatePassed;
  return {
    round: plan.round,
    type: plan.type,
    port: plan.port,
    serverPort: plan.serverPort,
    success,
    runSuccess: result?.success === true,
    gatePassed,
    failedStep: result?.failedStep || null,
    gate: result?.gate ? {
      profile: result.gate.profile || null,
      passed: gatePassed,
      passedCount: result.gate.passedCount ?? null,
      total: result.gate.total ?? null,
      failedCriteria: Array.isArray(result.gate.criteria)
        ? result.gate.criteria
          .filter(criterion => criterion && criterion.passed === false)
          .map(criterion => criterion.name)
        : [],
    } : null,
    metrics: {
      totalMs: metricValue(result, 'totalMs'),
      commandCalls: metricValue(result, 'commandCalls', metricValue(result, 'toolCalls')),
      toolCalls: metricValue(result, 'toolCalls'),
      protocolCalls: metricValue(result, 'protocolCalls'),
      firstUsefulObservationMs: metricValue(result, 'firstUsefulObservationMs'),
      firstActionEvidenceMs: metricValue(result, 'firstActionEvidenceMs'),
      goldenPathMs: metricValue(result, 'goldenPathMs'),
      estimatedOutputTokens: metricValue(result, 'estimatedOutputTokens'),
      usefulObservationTokens: metricValue(result, 'usefulObservationTokens'),
      maxStepDurationMs: metricValue(result, 'maxStepDurationMs'),
      maxResponsiveStepDurationMs: metricValue(result, 'maxResponsiveStepDurationMs'),
      maxStepEstimatedTokens: metricValue(result, 'maxStepEstimatedTokens'),
      largeAppStress: metricValue(result, 'largeAppStress'),
      autoEvidenceActions: metricValue(result, 'autoEvidenceActions'),
      reportTimeline: metricValue(result, 'hasReportTimeline', metricValue(result, 'reportTimeline')),
      semanticVerificationPassed: metricValue(result, 'semanticVerificationPassed'),
      overlayRecoveryCovered: metricValue(result, 'overlayRecoveryCovered'),
    },
    culprit: {
      slowestStep: metricValue(result, 'slowestStep'),
      slowestResponsiveStep: metricValue(result, 'slowestResponsiveStep'),
      biggestOutputStep: metricValue(result, 'biggestOutputStep'),
    },
    timing: {
      startedAt: timing.startedAt || null,
      endedAt: timing.endedAt || null,
      wallMs: Number.isFinite(timing.wallMs) ? timing.wallMs : null,
    },
  };
}

function failedRound(plan, error, timing = {}) {
  return {
    round: plan.round,
    type: plan.type,
    port: plan.port,
    serverPort: plan.serverPort,
    success: false,
    runSuccess: false,
    gatePassed: false,
    failedStep: 'campaign-run',
    error: error?.message || String(error),
    gate: null,
    metrics: {},
    culprit: {},
    timing: {
      startedAt: timing.startedAt || null,
      endedAt: timing.endedAt || null,
      wallMs: Number.isFinite(timing.wallMs) ? timing.wallMs : null,
    },
  };
}

function numericAverage(values, { round = true } = {}) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  const average = nums.reduce((sum, value) => sum + value, 0) / nums.length;
  return round ? Math.round(average) : average;
}

function numericMax(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
}

function summarizeRoundsForType(rounds, type) {
  const selected = rounds.filter(round => round.type === type);
  const metric = name => selected.map(round => round.metrics?.[name]);
  const passed = selected.filter(round => round.success).length;
  const stressRounds = selected
    .map(round => round.metrics?.largeAppStress)
    .filter(stress => stress?.enabled === true);
  return {
    type,
    rounds: selected.length,
    passed,
    failed: selected.length - passed,
    passRate: selected.length ? passed / selected.length : null,
    avgTotalMs: numericAverage(metric('totalMs')),
    avgFirstUsefulObservationMs: numericAverage(metric('firstUsefulObservationMs')),
    avgFirstActionEvidenceMs: numericAverage(metric('firstActionEvidenceMs')),
    avgEstimatedOutputTokens: numericAverage(metric('estimatedOutputTokens')),
    avgUsefulObservationTokens: numericAverage(metric('usefulObservationTokens')),
    maxStepDurationMs: numericMax(metric('maxStepDurationMs')),
    maxResponsiveStepDurationMs: numericMax(metric('maxResponsiveStepDurationMs')),
    maxStepEstimatedTokens: numericMax(metric('maxStepEstimatedTokens')),
    largeAppStress: stressRounds.length ? {
      rounds: stressRounds.length,
      passed: stressRounds.filter(stress => stress.success === true).length,
      avgCommandCoverageRate: numericAverage(stressRounds.map(stress => stress.commandCoverage?.rate), { round: false }),
      avgOutputBudgetCoverageRate: numericAverage(stressRounds.map(stress => stress.outputBudgetCoverage?.rate), { round: false }),
      avgTruncationMetadataCoverageRate: numericAverage(stressRounds.map(stress => stress.truncationMetadataCoverage?.rate), { round: false }),
    } : null,
  };
}

function topCulprit(rounds, field, metricName) {
  const entries = rounds
    .map(round => ({
      round: round.round,
      type: round.type,
      value: round.metrics?.[metricName],
      step: round.culprit?.[field] || null,
    }))
    .filter(entry => Number.isFinite(entry.value));
  entries.sort((a, b) => b.value - a.value);
  return entries[0] || null;
}

export function summarizeCampaignRun({ startedAt, endedAt, rounds = [], plan = [] } = {}) {
  const passCount = rounds.filter(round => round.success).length;
  const typeSummaries = [...new Set(rounds.map(round => round.type))]
    .map(type => summarizeRoundsForType(rounds, type));
  const failedRounds = rounds
    .filter(round => !round.success)
    .map(round => ({
      round: round.round,
      type: round.type,
      failedStep: round.failedStep,
      error: round.error || null,
      failedCriteria: round.gate?.failedCriteria || [],
    }));
  return {
    schema: 'chrome-cdp-ex.live-campaign.v1',
    startedAt: startedAt || null,
    endedAt: endedAt || null,
    durationMs: startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
    plannedRounds: plan.length,
    roundsCompleted: rounds.length,
    passCount,
    failCount: rounds.length - passCount,
    passRate: rounds.length ? passCount / rounds.length : null,
    typeSummaries,
    failurePatterns: failedRounds,
    opportunities: {
      slowestRound: topCulprit(rounds, 'slowestStep', 'maxStepDurationMs'),
      slowestResponsiveRound: topCulprit(rounds, 'slowestResponsiveStep', 'maxResponsiveStepDurationMs'),
      biggestOutputRound: topCulprit(rounds, 'biggestOutputStep', 'maxStepEstimatedTokens'),
    },
    rounds,
  };
}

function trendMetricsForSummary(summary = {}) {
  const rounds = Array.isArray(summary.rounds) ? summary.rounds : [];
  const metric = name => rounds.map(round => round.metrics?.[name]);
  const slowest = summary.opportunities?.slowestRound || null;
  return {
    passRate: Number.isFinite(summary.passRate) ? summary.passRate : null,
    avgEstimatedOutputTokens: numericAverage(metric('estimatedOutputTokens')),
    avgUsefulObservationTokens: numericAverage(metric('usefulObservationTokens')),
    maxStepEstimatedTokens: numericMax(metric('maxStepEstimatedTokens')),
    slowestStepMs: slowest?.value ?? numericMax(metric('maxStepDurationMs')),
    slowestStepName: slowest?.step?.name || null,
    slowestStepType: slowest?.type || null,
    slowestStepRound: slowest?.round || null,
  };
}

export function buildCampaignHistoryRecord(summary = {}, { recordedAt = null } = {}) {
  return {
    schema: 'chrome-cdp-ex.live-campaign-history.v1',
    recordedAt: recordedAt || summary.endedAt || new Date().toISOString(),
    startedAt: summary.startedAt || null,
    endedAt: summary.endedAt || null,
    roundsCompleted: summary.roundsCompleted ?? null,
    passCount: summary.passCount ?? null,
    failCount: summary.failCount ?? null,
    metrics: trendMetricsForSummary(summary),
  };
}

function readPreviousCampaignHistoryRecord(historyPath) {
  if (!existsSync(historyPath)) return null;
  const lines = readFileSync(historyPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return JSON.parse(lines.at(-1));
}

function metricDelta(current, previous, key) {
  const currentValue = current?.metrics?.[key];
  const previousValue = previous?.metrics?.[key];
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) return null;
  return currentValue - previousValue;
}

function buildCampaignHistoryDelta(current, previous) {
  if (!previous) return null;
  const fromStep = previous.metrics?.slowestStepName || null;
  const toStep = current.metrics?.slowestStepName || null;
  return {
    previousRecordedAt: previous.recordedAt || null,
    passRate: metricDelta(current, previous, 'passRate'),
    avgEstimatedOutputTokens: metricDelta(current, previous, 'avgEstimatedOutputTokens'),
    avgUsefulObservationTokens: metricDelta(current, previous, 'avgUsefulObservationTokens'),
    maxStepEstimatedTokens: metricDelta(current, previous, 'maxStepEstimatedTokens'),
    slowestStepMs: metricDelta(current, previous, 'slowestStepMs'),
    slowestStepChanged: fromStep !== toStep ? { from: fromStep, to: toStep } : null,
  };
}

export function appendCampaignHistory(historyPath, summary, opts = {}) {
  const outputPath = resolve(historyPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  const previous = readPreviousCampaignHistoryRecord(outputPath);
  const current = buildCampaignHistoryRecord(summary, opts);
  const delta = buildCampaignHistoryDelta(current, previous);
  appendFileSync(outputPath, `${JSON.stringify(current)}\n`);
  return {
    path: outputPath,
    previous,
    current,
    delta,
  };
}

function formatSignedIntegerDelta(value, unit) {
  if (!Number.isFinite(value)) return `n/a ${unit}`;
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded} ${unit}`;
}

function formatPassRateDelta(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const points = Math.round(value * 100);
  const sign = points > 0 ? '+' : '';
  return `${sign}${points}pp`;
}

export function formatCampaignReport(summary) {
  const pct = summary.passRate == null ? 'n/a' : `${Math.round(summary.passRate * 100)}%`;
  const lines = [
    'chrome-cdp-ex live campaign',
    `Rounds: ${summary.roundsCompleted}/${summary.plannedRounds}`,
    `Pass rate: ${pct} (${summary.passCount}/${summary.roundsCompleted})`,
    `Duration: ${summary.durationMs ?? 'n/a'} ms`,
    '',
    'By benchmark:',
  ];
  for (const entry of summary.typeSummaries) {
    const passRate = entry.passRate == null ? 'n/a' : `${Math.round(entry.passRate * 100)}%`;
    lines.push(`  - ${entry.type}: ${passRate}, avg total ${entry.avgTotalMs ?? 'n/a'} ms, avg output ${entry.avgEstimatedOutputTokens ?? 'n/a'} tokens, avg useful observation ${entry.avgUsefulObservationTokens ?? 'n/a'} tokens`);
    if (entry.largeAppStress) {
      lines.push(`    large-app stress: ${entry.largeAppStress.passed}/${entry.largeAppStress.rounds} pass, command coverage ${Math.round((entry.largeAppStress.avgCommandCoverageRate || 0) * 100)}%, output budgets ${Math.round((entry.largeAppStress.avgOutputBudgetCoverageRate || 0) * 100)}%, truncation metadata ${Math.round((entry.largeAppStress.avgTruncationMetadataCoverageRate || 0) * 100)}%`);
    }
  }
  if (summary.history) {
    if (summary.history.delta) {
      const delta = summary.history.delta;
      lines.push('', `History trend: pass rate ${formatPassRateDelta(delta.passRate)}, avg output ${formatSignedIntegerDelta(delta.avgEstimatedOutputTokens, 'tokens')}, max step ${formatSignedIntegerDelta(delta.maxStepEstimatedTokens, 'tokens')}, slowest step ${formatSignedIntegerDelta(delta.slowestStepMs, 'ms')}`);
      if (delta.slowestStepChanged) {
        lines.push(`  - slowest step changed: ${delta.slowestStepChanged.from || 'n/a'} -> ${delta.slowestStepChanged.to || 'n/a'}`);
      }
    } else {
      lines.push('', 'History trend: first recorded run, no previous campaign baseline');
    }
  }
  if (summary.failurePatterns.length) {
    lines.push('', 'Failures:');
    for (const failure of summary.failurePatterns) {
      const details = failure.error || failure.failedCriteria.join(', ') || failure.failedStep;
      lines.push(`  - round ${failure.round} ${failure.type}: ${details}`);
    }
  }
  const slowest = summary.opportunities.slowestRound;
  const biggest = summary.opportunities.biggestOutputRound;
  if (slowest || biggest) {
    lines.push('', 'Optimization suspects:');
    if (slowest) lines.push(`  - slowest step: round ${slowest.round} ${slowest.type}, ${slowest.value} ms (${slowest.step?.name || 'unknown'})`);
    if (summary.opportunities.slowestResponsiveRound) {
      const responsive = summary.opportunities.slowestResponsiveRound;
      lines.push(`  - slowest responsive step: round ${responsive.round} ${responsive.type}, ${responsive.value} ms (${responsive.step?.name || 'unknown'})`);
    }
    if (biggest) lines.push(`  - biggest output: round ${biggest.round} ${biggest.type}, ${biggest.value} tokens (${biggest.step?.name || 'unknown'})`);
  }
  lines.push('', 'Rounds:');
  for (const round of summary.rounds) {
    lines.push(`  ${round.success ? 'OK  ' : 'FAIL'} #${round.round} ${round.type}: total ${round.metrics.totalMs ?? 'n/a'} ms, output ${round.metrics.estimatedOutputTokens ?? 'n/a'} tokens, first observation ${round.metrics.firstUsefulObservationMs ?? 'n/a'} ms`);
  }
  return lines.join('\n');
}

async function runCampaignRound(plan, opts) {
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  try {
    const raw = plan.type === 'mcp'
      ? await runMcpBenchmark({ port: plan.port, serverPort: plan.serverPort, json: true, skipLock: true })
      : plan.type === 'large-app'
      ? await runLargeAppStressBenchmark({ port: plan.port, serverPort: plan.serverPort, json: true, skipLock: true })
      : await runKillerPathBenchmark({
        port: plan.port,
        serverPort: plan.serverPort,
        json: true,
        stabilityMs: opts.stabilityMs,
        skipLock: true,
      });
    const endedAt = new Date().toISOString();
    return compactCampaignRound(plan, parseBenchmarkSummary(raw), {
      startedAt,
      endedAt,
      wallMs: Date.now() - wallStart,
    });
  } catch (error) {
    const endedAt = new Date().toISOString();
    return failedRound(plan, error, {
      startedAt,
      endedAt,
      wallMs: Date.now() - wallStart,
    });
  }
}

export async function runLiveCampaign(opts = {}) {
  if (!opts.skipLock) {
    return withLiveBenchmarkLock({ name: 'benchmark:campaign' }, () => runLiveCampaign({ ...opts, skipLock: true }));
  }
  const plan = buildCampaignRoundPlan(opts);
  const startedAt = new Date().toISOString();
  const rounds = [];
  for (const roundPlan of plan) {
    const round = await runCampaignRound(roundPlan, opts);
    rounds.push(round);
    if (!round.success && opts.failFast) break;
    if (opts.settleMs > 0 && rounds.length < plan.length) await sleep(opts.settleMs);
  }
  const summary = summarizeCampaignRun({
    startedAt,
    endedAt: new Date().toISOString(),
    rounds,
    plan,
  });
  if (opts.history) {
    summary.history = appendCampaignHistory(opts.history, summary);
  }
  if (opts.output) {
    const outputPath = resolve(opts.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  return opts.json ? JSON.stringify(summary, null, 2) : formatCampaignReport(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let opts;
  try {
    opts = parseCampaignArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Live campaign failed: ${error.message || error}`);
    process.exit(1);
  }
  runLiveCampaign(opts)
    .then(output => console.log(output))
    .catch(error => {
      console.error(`Live campaign failed: ${error.message || error}`);
      process.exit(1);
    });
}
