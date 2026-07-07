#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';

import { runKillerPathBenchmark, runLargeAppStressBenchmark } from './benchmark-killer-path.mjs';
import { runMcpBenchmark } from './benchmark-mcp-path.mjs';
import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';

const DEFAULT_TYPES = Object.freeze(['mcp', 'killer']);
const ALL_TYPES = Object.freeze(['mcp', 'killer', 'large-app', 'real-app']);
const DEFAULT_REAL_APP_TARGETS = Object.freeze(['dashboard', 'docs-app', 'auth-flow']);
const REAL_APP_BASE_TRAITS = Object.freeze([
  'overlay',
  'stale-ref',
  'iframe',
  'shadow-dom',
  'spa-route',
  'slow-network',
  'auth-wall',
  'large-table',
  'hidden-template',
]);
const REAL_APP_TARGET_PROFILES = Object.freeze({
  dashboard: {
    targetClass: 'dashboard',
    traits: REAL_APP_BASE_TRAITS,
  },
  'docs-app': {
    targetClass: 'docs',
    traits: REAL_APP_BASE_TRAITS,
  },
  'auth-flow': {
    targetClass: 'auth',
    traits: REAL_APP_BASE_TRAITS,
  },
  'data-table': {
    targetClass: 'table',
    traits: REAL_APP_BASE_TRAITS,
  },
  'canvas-heavy': {
    targetClass: 'canvas',
    traits: REAL_APP_BASE_TRAITS,
  },
});
const DEFAULT_REGRESSION_THRESHOLDS = Object.freeze({
  warnPassRateDrop: 0.01,
  failPassRateDrop: 0.05,
  warnAvgEstimatedOutputTokensIncrease: 250,
  failAvgEstimatedOutputTokensIncrease: 1000,
  warnMaxStepEstimatedTokensIncrease: 250,
  failMaxStepEstimatedTokensIncrease: 1000,
  warnSlowestStepMsIncrease: 250,
  failSlowestStepMsIncrease: 1000,
});
const ROUTE_RECOMMENDATION_THRESHOLDS = Object.freeze({
  passRate: 0.05,
  strongPassRate: 0.2,
  avgTotalMs: 500,
  avgFirstUsefulObservationMs: 500,
  avgFirstActionEvidenceMs: 500,
  avgEstimatedOutputTokens: 250,
});

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

function parseSeedList(value) {
  const seeds = String(value || '')
    .split(',')
    .map(seed => seed.trim())
    .filter(Boolean);
  if (!seeds.length) throw new Error('adversarial seeds must include at least one seed');
  return seeds;
}

function parseRealAppTargets(value) {
  const targets = String(value || '')
    .split(',')
    .map(target => target.trim())
    .filter(Boolean);
  const selected = targets.length ? targets : [...DEFAULT_REAL_APP_TARGETS];
  const invalid = selected.filter(target => !REAL_APP_TARGET_PROFILES[target]);
  if (invalid.length) throw new Error(`unknown real-app target(s): ${invalid.join(', ')}`);
  return [...new Set(selected)];
}

function realAppTargetProfile(name) {
  const target = name || DEFAULT_REAL_APP_TARGETS[0];
  const profile = REAL_APP_TARGET_PROFILES[target];
  if (!profile) throw new Error(`unknown real-app target: ${target}`);
  return { name: target, ...profile };
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
    compareBaseline: null,
    adversarialSeeds: [],
    realAppTargets: [...DEFAULT_REAL_APP_TARGETS],
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
    } else if (arg === '--compare-baseline' || arg === '--baseline-summary') {
      opts.compareBaseline = argv[++i] || null;
      if (!opts.compareBaseline) throw new Error('comparison baseline path is required after --compare-baseline');
    } else if (arg === '--adversarial-seed') {
      opts.adversarialSeeds = parseSeedList(argv[++i]);
    } else if (arg === '--adversarial-seeds') {
      opts.adversarialSeeds = parseSeedList(argv[++i]);
    } else if (arg === '--real-app-targets') {
      opts.realAppTargets = parseRealAppTargets(argv[++i]);
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
  adversarialSeeds = [],
  realAppTargets = [...DEFAULT_REAL_APP_TARGETS],
} = {}) {
  let adversarialIndex = 0;
  let realAppIndex = 0;
  return Array.from({ length: rounds }, (_, index) => {
    const type = types[index % types.length];
    const seed = type === 'killer' && adversarialSeeds.length
      ? adversarialSeeds[adversarialIndex++ % adversarialSeeds.length]
      : null;
    const realAppTarget = type === 'real-app'
      ? realAppTargets[realAppIndex++ % realAppTargets.length]
      : null;
    const realAppProfile = realAppTarget ? realAppTargetProfile(realAppTarget) : null;
    return {
      round: index + 1,
      type,
      port: portStart + index,
      serverPort: serverPortStart + index,
      ...(seed ? { seed } : {}),
      ...(realAppProfile ? { realAppTarget: realAppProfile.name, targetClass: realAppProfile.targetClass } : {}),
    };
  });
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
    seed: plan.seed || result?.metrics?.adversarialScenario?.seed || null,
    realAppTarget: plan.realAppTarget || result?.metrics?.realAppTarget?.name || null,
    targetClass: plan.targetClass || result?.metrics?.realAppTarget?.targetClass || null,
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
      realAppTarget: metricValue(result, 'realAppTarget'),
      autoEvidenceActions: metricValue(result, 'autoEvidenceActions'),
      reportTimeline: metricValue(result, 'hasReportTimeline', metricValue(result, 'reportTimeline')),
      semanticVerificationPassed: metricValue(result, 'semanticVerificationPassed'),
      overlayRecoveryCovered: metricValue(result, 'overlayRecoveryCovered'),
      adversarialScenario: metricValue(result, 'adversarialScenario'),
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
    seed: plan.seed || null,
    realAppTarget: plan.realAppTarget || null,
    targetClass: plan.targetClass || null,
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
  const realAppTargets = selected
    .map(round => round.metrics?.realAppTarget || (round.realAppTarget ? {
      name: round.realAppTarget,
      targetClass: round.targetClass || null,
    } : null))
    .filter(Boolean);
  const unique = values => [...new Set(values.filter(Boolean))].sort();
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
    realAppTargets: realAppTargets.length ? {
      targets: unique(realAppTargets.map(target => target.name)),
      classes: unique(realAppTargets.map(target => target.targetClass)),
    } : null,
    largeAppStress: stressRounds.length ? {
      rounds: stressRounds.length,
      passed: stressRounds.filter(stress => stress.success === true).length,
      avgCommandCoverageRate: numericAverage(stressRounds.map(stress => stress.commandCoverage?.rate), { round: false }),
      avgOutputBudgetCoverageRate: numericAverage(stressRounds.map(stress => stress.outputBudgetCoverage?.rate), { round: false }),
      avgTruncationMetadataCoverageRate: numericAverage(stressRounds.map(stress => stress.truncationMetadataCoverage?.rate), { round: false }),
    } : null,
  };
}

function comparableRouteRounds(rounds = [], type) {
  return rounds.filter(round => (
    round.type === type
    && round.metrics?.adversarialScenario?.enabled !== true
  ));
}

function summarizeRouteRounds(rounds = [], route, type) {
  const selected = comparableRouteRounds(rounds, type);
  const metric = name => selected.map(round => round.metrics?.[name]);
  const passed = selected.filter(round => round.success).length;
  return {
    route,
    type,
    rounds: selected.length,
    passed,
    failed: selected.length - passed,
    passRate: selected.length ? passed / selected.length : null,
    avgTotalMs: numericAverage(metric('totalMs')),
    avgFirstUsefulObservationMs: numericAverage(metric('firstUsefulObservationMs')),
    avgFirstActionEvidenceMs: numericAverage(metric('firstActionEvidenceMs')),
    avgEstimatedOutputTokens: numericAverage(metric('estimatedOutputTokens')),
    maxStepEstimatedTokens: numericMax(metric('maxStepEstimatedTokens')),
  };
}

function routeMetricEvidence({ name, mcp, cli, threshold, direction = 'lower', unit, weight = 1 }) {
  const delta = Number.isFinite(mcp) && Number.isFinite(cli) ? mcp - cli : null;
  let winner = null;
  if (Number.isFinite(delta) && Math.abs(delta) >= threshold) {
    winner = direction === 'higher'
      ? (delta > 0 ? 'mcp' : 'cli')
      : (delta < 0 ? 'mcp' : 'cli');
  }
  return {
    name,
    winner,
    delta,
    unit,
    direction,
    threshold,
    weight,
  };
}

function routeScore(evidence = [], route) {
  return evidence
    .filter(entry => entry.winner === route)
    .reduce((sum, entry) => sum + entry.weight, 0);
}

function routeRecommendationForEvidence(evidence = [], mcp = {}, cli = {}) {
  if (!mcp.rounds || !cli.rounds) {
    return {
      route: 'inconclusive',
      confidence: 'low',
      reason: 'Need at least one comparable MCP round and one comparable CLI round.',
    };
  }

  const passRate = evidence.find(entry => entry.name === 'pass-rate');
  if (passRate?.winner && Math.abs(passRate.delta) >= ROUTE_RECOMMENDATION_THRESHOLDS.strongPassRate) {
    return {
      route: passRate.winner,
      confidence: 'high',
      reason: `${passRate.winner} has a materially higher pass rate on matched rounds.`,
    };
  }

  const mcpScore = routeScore(evidence, 'mcp');
  const cliScore = routeScore(evidence, 'cli');
  if (mcpScore >= cliScore + 2) {
    return {
      route: 'mcp',
      confidence: mcpScore >= 5 ? 'high' : 'medium',
      reason: 'MCP wins the weighted latency/token/pass-rate evidence.',
    };
  }
  if (cliScore >= mcpScore + 2) {
    return {
      route: 'cli',
      confidence: cliScore >= 5 ? 'high' : 'medium',
      reason: 'CLI wins the weighted latency/token/pass-rate evidence.',
    };
  }
  return {
    route: 'inconclusive',
    confidence: 'low',
    reason: 'Matched MCP and CLI evidence is too close to recommend a route.',
  };
}

export function buildMcpCliRouteRecommendation(rounds = []) {
  const mcp = summarizeRouteRounds(rounds, 'mcp', 'mcp');
  const cli = summarizeRouteRounds(rounds, 'cli', 'killer');
  const excludedRounds = rounds
    .filter(round => round.type === 'killer' && round.metrics?.adversarialScenario?.enabled === true)
    .map(round => ({ round: round.round, type: round.type, seed: round.seed || round.metrics?.adversarialScenario?.seed || null }));
  const evidence = [
    routeMetricEvidence({
      name: 'pass-rate',
      mcp: mcp.passRate,
      cli: cli.passRate,
      threshold: ROUTE_RECOMMENDATION_THRESHOLDS.passRate,
      direction: 'higher',
      unit: 'ratio',
      weight: 3,
    }),
    routeMetricEvidence({
      name: 'avg-total-latency',
      mcp: mcp.avgTotalMs,
      cli: cli.avgTotalMs,
      threshold: ROUTE_RECOMMENDATION_THRESHOLDS.avgTotalMs,
      unit: 'ms',
    }),
    routeMetricEvidence({
      name: 'first-useful-observation',
      mcp: mcp.avgFirstUsefulObservationMs,
      cli: cli.avgFirstUsefulObservationMs,
      threshold: ROUTE_RECOMMENDATION_THRESHOLDS.avgFirstUsefulObservationMs,
      unit: 'ms',
    }),
    routeMetricEvidence({
      name: 'first-action-evidence',
      mcp: mcp.avgFirstActionEvidenceMs,
      cli: cli.avgFirstActionEvidenceMs,
      threshold: ROUTE_RECOMMENDATION_THRESHOLDS.avgFirstActionEvidenceMs,
      unit: 'ms',
    }),
    routeMetricEvidence({
      name: 'avg-output-tokens',
      mcp: mcp.avgEstimatedOutputTokens,
      cli: cli.avgEstimatedOutputTokens,
      threshold: ROUTE_RECOMMENDATION_THRESHOLDS.avgEstimatedOutputTokens,
      unit: 'tokens',
      weight: 2,
    }),
  ];
  return {
    schema: 'chrome-cdp-ex.mcp-cli-route-recommendation.v1',
    routes: { mcp, cli },
    deltas: Object.fromEntries(evidence.map(entry => [entry.name, entry.delta])),
    evidence,
    excludedRounds,
    recommendation: routeRecommendationForEvidence(evidence, mcp, cli),
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

function artifactPathList(artifacts = {}) {
  return Object.values(artifacts)
    .filter(Boolean)
    .map(value => String(value));
}

function roundCulpritStep(round = {}) {
  return round.culprit?.biggestOutputStep
    || round.culprit?.slowestResponsiveStep
    || round.culprit?.slowestStep
    || null;
}

function roundFailedCriteria(round = {}) {
  return Array.isArray(round.gate?.failedCriteria) ? round.gate.failedCriteria : [];
}

function issueFailureReason(round = {}) {
  const criteria = roundFailedCriteria(round);
  return criteria.length ? criteria.join(', ') : round.error || round.failedStep || 'unknown failure';
}

function buildReproductionCommand(round = {}) {
  const parts = [
    'npm run benchmark:campaign --',
    '--types', round.type || 'mcp',
    '--rounds', '1',
  ];
  if (Number.isFinite(round.port)) parts.push('--port-start', String(round.port));
  if (Number.isFinite(round.serverPort)) parts.push('--server-port-start', String(round.serverPort));
  if (round.seed && round.type !== 'real-app') parts.push('--adversarial-seeds', String(round.seed));
  if (round.realAppTarget) parts.push('--real-app-targets', String(round.realAppTarget));
  parts.push('--fail-fast', '--json');
  return parts.join(' ');
}

function buildIssueDraftBody(round, draft) {
  const artifactLines = draft.artifactPaths.length
    ? draft.artifactPaths.map(path => `- ${path}`).join('\n')
    : '- n/a';
  return [
    `Live campaign ${round.type} round ${round.round} failed.`,
    '',
    '## Reproduce',
    '```bash',
    draft.reproductionCommand,
    '```',
    '',
    '## Failure',
    `- Type: ${round.type}`,
    `- Round: ${round.round}`,
    ...(draft.realAppTarget ? [
      `- Real-app target: ${draft.realAppTarget}`,
      `- Target class: ${draft.targetClass || 'n/a'}`,
    ] : []),
    `- Ports: CDP ${round.port ?? 'n/a'}, HTTP ${round.serverPort ?? 'n/a'}`,
    `- Seed: ${draft.seed ?? 'n/a'}`,
    `- Failed criteria: ${draft.failedCriteria.length ? draft.failedCriteria.join(', ') : 'n/a'}`,
    `- Failed step: ${round.failedStep || 'n/a'}`,
    `- Error: ${round.error || 'n/a'}`,
    '',
    '## Culprit',
    '```json',
    JSON.stringify(draft.culpritStep || {}, null, 2),
    '```',
    '',
    '## Artifacts',
    artifactLines,
    '',
    `Suggested labels: ${draft.suggestedLabels.join(', ')}`,
  ].join('\n');
}

export function buildCampaignIssueDrafts(rounds = [], artifacts = {}) {
  const paths = artifactPathList(artifacts);
  return rounds
    .filter(round => round && round.success === false)
    .map((round) => {
      const failedCriteria = roundFailedCriteria(round);
      const draft = {
        title: `[live-campaign] ${round.type} round ${round.round} failed: ${issueFailureReason(round)}`,
        reproductionCommand: buildReproductionCommand(round),
        suggestedLabels: ['bug', 'type: benchmark', 'priority: p1'],
        seed: round.seed ?? round.metrics?.seed ?? null,
        realAppTarget: round.realAppTarget ?? round.metrics?.realAppTarget?.name ?? null,
        targetClass: round.targetClass ?? round.metrics?.realAppTarget?.targetClass ?? null,
        ports: {
          cdp: Number.isFinite(round.port) ? round.port : null,
          http: Number.isFinite(round.serverPort) ? round.serverPort : null,
        },
        failedCriteria,
        failedStep: round.failedStep || null,
        error: round.error || null,
        culpritStep: roundCulpritStep(round),
        artifactPaths: paths,
      };
      return {
        ...draft,
        body: buildIssueDraftBody(round, draft),
      };
    });
}

export function summarizeCampaignRun({ startedAt, endedAt, rounds = [], plan = [], artifacts = {} } = {}) {
  const passCount = rounds.filter(round => round.success).length;
  const typeSummaries = [...new Set(rounds.map(round => round.type))]
    .map(type => summarizeRoundsForType(rounds, type));
  const failedRounds = rounds
    .filter(round => !round.success)
    .map(round => ({
      round: round.round,
      type: round.type,
      seed: round.seed || null,
      realAppTarget: round.realAppTarget || null,
      targetClass: round.targetClass || null,
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
    routeRecommendation: buildMcpCliRouteRecommendation(rounds),
    issueDrafts: buildCampaignIssueDrafts(rounds, artifacts),
    rounds,
  };
}

function trendMetricsForSummary(summary = {}) {
  const rounds = Array.isArray(summary.rounds) ? summary.rounds : [];
  const metric = name => rounds.map(round => round.metrics?.[name]);
  const slowest = summary.opportunities?.slowestRound || null;
  const biggest = summary.opportunities?.biggestOutputRound || null;
  return {
    passRate: Number.isFinite(summary.passRate) ? summary.passRate : null,
    avgEstimatedOutputTokens: numericAverage(metric('estimatedOutputTokens')),
    avgUsefulObservationTokens: numericAverage(metric('usefulObservationTokens')),
    maxStepEstimatedTokens: numericMax(metric('maxStepEstimatedTokens')),
    slowestStepMs: slowest?.value ?? numericMax(metric('maxStepDurationMs')),
    slowestStepName: slowest?.step?.name || null,
    slowestStepType: slowest?.type || null,
    slowestStepRound: slowest?.round || null,
    biggestOutputStepName: biggest?.step?.name || null,
    biggestOutputStepType: biggest?.type || null,
    biggestOutputStepRound: biggest?.round || null,
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

function campaignComparisonMetrics(input = {}) {
  if (input.schema === 'chrome-cdp-ex.live-campaign-history.v1') {
    return input.metrics || {};
  }
  return trendMetricsForSummary(input);
}

function comparisonStatusForDelta(delta, { warn, fail, direction = 'increase' } = {}) {
  if (!Number.isFinite(delta)) return 'unknown';
  const regression = direction === 'drop' ? -delta : delta;
  if (Number.isFinite(fail) && regression >= fail) return 'fail';
  if (Number.isFinite(warn) && regression >= warn) return 'warn';
  return 'pass';
}

function worstComparisonStatus(statuses = []) {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('unknown')) return 'unknown';
  return 'pass';
}

function comparisonCheck({ name, delta, warn, fail, direction, unit }) {
  return {
    name,
    status: comparisonStatusForDelta(delta, { warn, fail, direction }),
    delta,
    unit,
    direction,
    warnThreshold: warn,
    failThreshold: fail,
  };
}

function culpritChanges(current = {}, baseline = {}) {
  const fields = [
    ['slowestStepName', 'slowest-step'],
    ['slowestStepType', 'slowest-step-type'],
    ['slowestStepRound', 'slowest-step-round'],
    ['biggestOutputStepName', 'biggest-output-step'],
    ['biggestOutputStepType', 'biggest-output-step-type'],
    ['biggestOutputStepRound', 'biggest-output-step-round'],
  ];
  return fields
    .map(([field, label]) => ({
      field: label,
      from: baseline[field] ?? null,
      to: current[field] ?? null,
    }))
    .filter(change => change.from !== change.to && (change.from != null || change.to != null));
}

export function buildCampaignRegressionComparison(currentSummary = {}, baselineSummary = {}, opts = {}) {
  const thresholds = { ...DEFAULT_REGRESSION_THRESHOLDS, ...(opts.thresholds || {}) };
  const current = campaignComparisonMetrics(currentSummary);
  const baseline = campaignComparisonMetrics(baselineSummary);
  const deltas = {
    passRate: Number.isFinite(current.passRate) && Number.isFinite(baseline.passRate) ? current.passRate - baseline.passRate : null,
    avgEstimatedOutputTokens: Number.isFinite(current.avgEstimatedOutputTokens) && Number.isFinite(baseline.avgEstimatedOutputTokens) ? current.avgEstimatedOutputTokens - baseline.avgEstimatedOutputTokens : null,
    maxStepEstimatedTokens: Number.isFinite(current.maxStepEstimatedTokens) && Number.isFinite(baseline.maxStepEstimatedTokens) ? current.maxStepEstimatedTokens - baseline.maxStepEstimatedTokens : null,
    slowestStepMs: Number.isFinite(current.slowestStepMs) && Number.isFinite(baseline.slowestStepMs) ? current.slowestStepMs - baseline.slowestStepMs : null,
  };
  const checks = [
    comparisonCheck({
      name: 'pass-rate',
      delta: deltas.passRate,
      warn: thresholds.warnPassRateDrop,
      fail: thresholds.failPassRateDrop,
      direction: 'drop',
      unit: 'ratio',
    }),
    comparisonCheck({
      name: 'avg-output-tokens',
      delta: deltas.avgEstimatedOutputTokens,
      warn: thresholds.warnAvgEstimatedOutputTokensIncrease,
      fail: thresholds.failAvgEstimatedOutputTokensIncrease,
      direction: 'increase',
      unit: 'tokens',
    }),
    comparisonCheck({
      name: 'max-step-tokens',
      delta: deltas.maxStepEstimatedTokens,
      warn: thresholds.warnMaxStepEstimatedTokensIncrease,
      fail: thresholds.failMaxStepEstimatedTokensIncrease,
      direction: 'increase',
      unit: 'tokens',
    }),
    comparisonCheck({
      name: 'slowest-step-latency',
      delta: deltas.slowestStepMs,
      warn: thresholds.warnSlowestStepMsIncrease,
      fail: thresholds.failSlowestStepMsIncrease,
      direction: 'increase',
      unit: 'ms',
    }),
  ];
  const newCulpritSteps = culpritChanges(current, baseline);
  const status = worstComparisonStatus(checks.map(check => check.status));
  return {
    schema: 'chrome-cdp-ex.campaign-regression-comparison.v1',
    baselineLabel: opts.baselineLabel || baselineSummary.recordedAt || baselineSummary.endedAt || 'baseline',
    currentLabel: opts.currentLabel || currentSummary.endedAt || 'current',
    status,
    thresholds,
    baseline,
    current,
    deltas,
    checks,
    newCulpritSteps,
  };
}

export function readComparisonBaseline(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) throw new Error(`comparison baseline is empty: ${path}`);
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to JSONL support for compact campaign history files.
  }
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  return JSON.parse(lines.at(-1));
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

function formatRouteMetric(value, unit) {
  if (!Number.isFinite(value)) return `n/a ${unit}`;
  return `${Math.round(value)} ${unit}`;
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
    if (entry.realAppTargets) {
      lines.push(`    real-app targets: ${entry.realAppTargets.targets.join(', ')}; classes ${entry.realAppTargets.classes.join(', ')}`);
    }
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
  if (summary.regressionComparison) {
    const comparison = summary.regressionComparison;
    lines.push('', `Regression comparison: ${comparison.status}`);
    lines.push(`  - pass rate delta: ${formatPassRateDelta(comparison.deltas.passRate)}`);
    lines.push(`  - avg output delta: ${formatSignedIntegerDelta(comparison.deltas.avgEstimatedOutputTokens, 'tokens')}`);
    lines.push(`  - max step delta: ${formatSignedIntegerDelta(comparison.deltas.maxStepEstimatedTokens, 'tokens')}`);
    lines.push(`  - slowest step delta: ${formatSignedIntegerDelta(comparison.deltas.slowestStepMs, 'ms')}`);
    if (comparison.newCulpritSteps?.length) {
      lines.push(`  - new culprit: ${comparison.newCulpritSteps.map(change => `${change.field} ${change.from || 'n/a'} -> ${change.to || 'n/a'}`).join('; ')}`);
    }
  }
  if (summary.routeRecommendation) {
    const routing = summary.routeRecommendation;
    const recommendation = routing.recommendation || {};
    const mcp = routing.routes?.mcp || {};
    const cli = routing.routes?.cli || {};
    lines.push('', `Route recommendation: ${recommendation.route || 'inconclusive'} (${recommendation.confidence || 'low'} confidence)`);
    lines.push(`  - reason: ${recommendation.reason || 'n/a'}`);
    lines.push(`  - mcp: ${mcp.rounds ?? 0} rounds, pass ${mcp.passRate == null ? 'n/a' : `${Math.round(mcp.passRate * 100)}%`}, avg total ${formatRouteMetric(mcp.avgTotalMs, 'ms')}, avg output ${formatRouteMetric(mcp.avgEstimatedOutputTokens, 'tokens')}`);
    lines.push(`  - cli: ${cli.rounds ?? 0} rounds, pass ${cli.passRate == null ? 'n/a' : `${Math.round(cli.passRate * 100)}%`}, avg total ${formatRouteMetric(cli.avgTotalMs, 'ms')}, avg output ${formatRouteMetric(cli.avgEstimatedOutputTokens, 'tokens')}`);
    lines.push(`  - deltas (mcp - cli): pass ${formatPassRateDelta(routing.deltas?.['pass-rate'])}, avg total ${formatSignedIntegerDelta(routing.deltas?.['avg-total-latency'], 'ms')}, first observation ${formatSignedIntegerDelta(routing.deltas?.['first-useful-observation'], 'ms')}, first action ${formatSignedIntegerDelta(routing.deltas?.['first-action-evidence'], 'ms')}, avg output ${formatSignedIntegerDelta(routing.deltas?.['avg-output-tokens'], 'tokens')}`);
    if (routing.excludedRounds?.length) {
      lines.push(`  - excluded from route comparison: ${routing.excludedRounds.length} adversarial CLI round(s)`);
    }
  }
  if (summary.failurePatterns.length) {
    lines.push('', 'Failures:');
    for (const failure of summary.failurePatterns) {
      const details = failure.error || failure.failedCriteria.join(', ') || failure.failedStep;
      const seed = failure.seed ? ` seed ${failure.seed}` : '';
      lines.push(`  - round ${failure.round} ${failure.type}${seed}: ${details}`);
    }
  }
  if (summary.issueDrafts?.length) {
    lines.push('', 'Issue-ready diagnostics:');
    for (const draft of summary.issueDrafts) {
      lines.push(`  - ${draft.title}`);
      lines.push(`    Reproduce: ${draft.reproductionCommand}`);
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
    const seed = round.seed ? ` seed ${round.seed}` : '';
    const target = round.realAppTarget ? ` ${round.realAppTarget}/${round.targetClass || 'unknown'}` : '';
    lines.push(`  ${round.success ? 'OK  ' : 'FAIL'} #${round.round} ${round.type}${target}${seed}: total ${round.metrics.totalMs ?? 'n/a'} ms, output ${round.metrics.estimatedOutputTokens ?? 'n/a'} tokens, first observation ${round.metrics.firstUsefulObservationMs ?? 'n/a'} ms`);
  }
  return lines.join('\n');
}

function decorateRealAppBenchmarkSummary(summary, plan = {}) {
  const profile = realAppTargetProfile(plan.realAppTarget);
  return {
    ...summary,
    scenario: 'real-app-target',
    metrics: {
      ...(summary.metrics || {}),
      realAppTarget: {
        schema: 'chrome-cdp-ex.real-app-target.v1',
        name: profile.name,
        targetClass: profile.targetClass,
        traits: profile.traits,
        safeLocalOnly: true,
        source: 'local-test-fixture',
      },
    },
  };
}

async function runCampaignRound(plan, opts) {
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  try {
    let raw;
    if (plan.type === 'mcp') {
      raw = await runMcpBenchmark({ port: plan.port, serverPort: plan.serverPort, json: true, skipLock: true });
    } else if (plan.type === 'large-app') {
      raw = await runLargeAppStressBenchmark({ port: plan.port, serverPort: plan.serverPort, json: true, skipLock: true });
    } else if (plan.type === 'real-app') {
      const profile = realAppTargetProfile(plan.realAppTarget);
      raw = await runKillerPathBenchmark({
        port: plan.port,
        serverPort: plan.serverPort,
        json: true,
        stabilityMs: opts.stabilityMs,
        adversarialSeed: `real-app-${profile.name}`,
        adversarialTraits: profile.traits,
        skipLock: true,
      });
    } else {
      raw = await runKillerPathBenchmark({
        port: plan.port,
        serverPort: plan.serverPort,
        json: true,
        stabilityMs: opts.stabilityMs,
        adversarialSeed: plan.seed || null,
        skipLock: true,
      });
    }
    const result = plan.type === 'real-app'
      ? decorateRealAppBenchmarkSummary(parseBenchmarkSummary(raw), plan)
      : parseBenchmarkSummary(raw);
    const endedAt = new Date().toISOString();
    return compactCampaignRound(plan, result, {
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
    const port = Number(opts.portStart || process.env.CDP_CAMPAIGN_PORT_START || 9440);
    const serverPort = Number(opts.serverPortStart || process.env.CDP_CAMPAIGN_HTTP_PORT_START || 42140);
    return withLiveBenchmarkLock({
      name: 'benchmark:campaign',
      port,
      serverPort,
      browser: 'campaign',
      profilePrefix: 'chrome-cdp-ex-campaign',
    }, run => runLiveCampaign({
      ...opts,
      skipLock: true,
      portStart: run.metadata.port,
      serverPortStart: run.metadata.serverPort,
      liveRun: run,
    }));
  }
  const plan = buildCampaignRoundPlan(opts);
  const outputPath = opts.output ? resolve(opts.output) : null;
  const historyPath = opts.history ? resolve(opts.history) : null;
  const baselinePath = opts.compareBaseline ? resolve(opts.compareBaseline) : null;
  const comparisonBaseline = baselinePath ? readComparisonBaseline(baselinePath) : null;
  const startedAt = new Date().toISOString();
  const rounds = [];
  for (const roundPlan of plan) {
    const round = await runCampaignRound(roundPlan, opts);
    rounds.push(round);
    opts.liveRun?.heartbeat();
    if (!round.success && opts.failFast) break;
    if (opts.settleMs > 0 && rounds.length < plan.length) await sleep(opts.settleMs);
  }
  const summary = summarizeCampaignRun({
    startedAt,
    endedAt: new Date().toISOString(),
    rounds,
    plan,
    artifacts: {
      output: outputPath,
      history: historyPath,
    },
  });
  if (historyPath) {
    summary.history = appendCampaignHistory(historyPath, summary);
  }
  if (comparisonBaseline) {
    summary.regressionComparison = buildCampaignRegressionComparison(summary, comparisonBaseline, {
      baselineLabel: baselinePath,
      currentLabel: summary.endedAt,
    });
  }
  if (outputPath) {
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
