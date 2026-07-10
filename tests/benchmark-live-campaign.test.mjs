import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  appendCampaignHistory,
  buildCampaignIssueDrafts,
  buildCampaignRegressionComparison,
  buildCampaignRoundPlan,
  buildMcpCliRouteRecommendation,
  campaignExitCode,
  compactCampaignRound,
  decorateRealAppBenchmarkSummary,
  formatCampaignReport,
  parseCampaignArgs,
  readComparisonBaseline,
  realAppProbeCoverage,
  realAppTargetProfile,
  runLiveCampaign,
  summarizeCampaignRun,
} from '../scripts/benchmark-live-campaign.mjs';

function campaignSummaryForComparison({
  passRate = 1,
  avgTokens = 10000,
  maxStepTokens = 3000,
  slowestMs = 1200,
  slowestStep = 'open',
  biggestOutputStep = 'report',
  type = 'killer',
} = {}) {
  const rounds = [
    {
      round: 1,
      type,
      success: passRate > 0,
      metrics: {
        estimatedOutputTokens: avgTokens,
        maxStepEstimatedTokens: maxStepTokens,
        maxStepDurationMs: slowestMs,
        maxResponsiveStepDurationMs: slowestMs,
      },
      culprit: {
        slowestStep: { name: slowestStep },
        slowestResponsiveStep: { name: slowestStep },
        biggestOutputStep: { name: biggestOutputStep },
      },
    },
  ];
  if (passRate === 0) rounds[0].success = false;
  const summary = summarizeCampaignRun({
    startedAt: '2026-07-07T00:00:00.000Z',
    endedAt: '2026-07-07T00:00:02.000Z',
    plan: [{}],
    rounds,
  });
  summary.passRate = passRate;
  return summary;
}

function routeRound({
  round,
  type,
  success = true,
  totalMs = 4000,
  firstUsefulObservationMs = 1500,
  firstActionEvidenceMs = 2600,
  estimatedOutputTokens = 8000,
  maxStepEstimatedTokens = 2000,
  adversarial = false,
} = {}) {
  return {
    round,
    type,
    success,
    metrics: {
      totalMs,
      firstUsefulObservationMs,
      firstActionEvidenceMs,
      estimatedOutputTokens,
      maxStepEstimatedTokens,
      ...(adversarial ? { adversarialScenario: { enabled: true, seed: 'route-noise' } } : {}),
    },
    culprit: { slowestStep: { name: 'open' }, biggestOutputStep: { name: 'report' } },
  };
}

describe('live campaign benchmark helpers', () => {
  it('parses campaign arguments and alternates benchmark types by default', () => {
    const opts = parseCampaignArgs([
      '--rounds', '5',
      '--types', 'mcp,killer,large-app',
      '--port-start', '9500',
      '--server-port-start', '43000',
      '--stability-ms', '250',
      '--settle-ms', '0',
      '--json',
      '--output', '/tmp/campaign.json',
      '--history', '/tmp/campaign-history.jsonl',
      '--compare-baseline', '/tmp/main-campaign.json',
    ]);

    expect(opts).toMatchObject({
      rounds: 5,
      types: ['mcp', 'killer', 'large-app'],
      portStart: 9500,
      serverPortStart: 43000,
      stabilityMs: 250,
      settleMs: 0,
      json: true,
      output: '/tmp/campaign.json',
      history: '/tmp/campaign-history.jsonl',
      compareBaseline: '/tmp/main-campaign.json',
    });
    expect(buildCampaignRoundPlan(opts)).toEqual([
      { round: 1, type: 'mcp', port: 9500, serverPort: 43000 },
      { round: 2, type: 'killer', port: 9501, serverPort: 43001 },
      { round: 3, type: 'large-app', port: 9502, serverPort: 43002 },
      { round: 4, type: 'mcp', port: 9503, serverPort: 43003 },
      { round: 5, type: 'killer', port: 9504, serverPort: 43004 },
    ]);
  });

  it('returns a failing CLI verdict for failed, incomplete, or regressed campaigns', () => {
    expect(campaignExitCode({ plannedRounds: 3, roundsCompleted: 3, failCount: 0 })).toBe(0);
    expect(campaignExitCode({ plannedRounds: 3, roundsCompleted: 3, failCount: 1 })).toBe(1);
    expect(campaignExitCode({ plannedRounds: 3, roundsCompleted: 2, failCount: 0 })).toBe(1);
    expect(campaignExitCode({
      plannedRounds: 3,
      roundsCompleted: 3,
      failCount: 0,
      regressionComparison: { status: 'fail' },
    })).toBe(1);
    expect(campaignExitCode({ plannedRounds: 3, roundsCompleted: 2, failCount: 1 }, { allowFailures: true })).toBe(0);
    expect(parseCampaignArgs(['--allow-failures']).allowFailures).toBe(true);
  });

  it('assigns adversarial seeds to killer campaign rounds for replay', () => {
    const opts = parseCampaignArgs([
      '--rounds', '5',
      '--types', 'killer,mcp,killer',
      '--adversarial-seeds', 'alpha,beta',
    ]);

    expect(opts.adversarialSeeds).toEqual(['alpha', 'beta']);
    expect(buildCampaignRoundPlan(opts)).toEqual([
      { round: 1, type: 'killer', port: 9440, serverPort: 42140, seed: 'alpha' },
      { round: 2, type: 'mcp', port: 9441, serverPort: 42141 },
      { round: 3, type: 'killer', port: 9442, serverPort: 42142, seed: 'beta' },
      { round: 4, type: 'killer', port: 9443, serverPort: 42143, seed: 'alpha' },
      { round: 5, type: 'mcp', port: 9444, serverPort: 42144 },
    ]);
  });

  it('plans configurable real-app target profiles for local live campaigns', () => {
    const opts = parseCampaignArgs([
      '--rounds', '4',
      '--types', 'real-app',
      '--real-app-targets', 'dashboard,docs-app,auth-flow',
      '--port-start', '9500',
      '--server-port-start', '9600',
    ]);

    expect(opts.realAppTargets).toEqual(['dashboard', 'docs-app', 'auth-flow']);
    expect(buildCampaignRoundPlan(opts)).toEqual([
      { round: 1, type: 'real-app', port: 9500, serverPort: 9600, realAppTarget: 'dashboard', targetClass: 'dashboard' },
      { round: 2, type: 'real-app', port: 9501, serverPort: 9601, realAppTarget: 'docs-app', targetClass: 'docs' },
      { round: 3, type: 'real-app', port: 9502, serverPort: 9602, realAppTarget: 'auth-flow', targetClass: 'auth' },
      { round: 4, type: 'real-app', port: 9503, serverPort: 9603, realAppTarget: 'dashboard', targetClass: 'dashboard' },
    ]);
  });

  it('defines distinct real-app traits and required probes for all target classes', () => {
    const names = ['dashboard', 'docs-app', 'auth-flow', 'data-table', 'canvas-heavy'];
    const profiles = names.map(name => realAppTargetProfile(name));
    expect(new Set(profiles.map(profile => profile.traits.join(','))).size).toBe(names.length);
    expect(profiles.map(profile => profile.targetClass)).toEqual(['dashboard', 'docs', 'auth', 'table', 'canvas']);
    for (const profile of profiles) {
      expect(profile.traits.length).toBeGreaterThanOrEqual(3);
      expect(profile.expectedProbes.length).toBeGreaterThan(0);
    }
    expect(realAppTargetProfile('canvas-heavy').traits).toContain('canvas');
    expect(realAppTargetProfile('auth-flow').traits).toContain('auth-wall');
    expect(realAppTargetProfile('data-table').traits).toContain('large-table');
  });

  it('measures real-app coverage from successful named probes instead of inferred traits', () => {
    const profile = realAppTargetProfile('dashboard');
    const coverage = realAppProbeCoverage({
      steps: [
        { name: 'overlay-json', ok: true },
        { name: 'stale-ref-json', ok: true },
        { name: 'adversarial-route', ok: false },
        { name: 'unrelated-probe', ok: true },
      ],
    }, profile);

    expect(coverage.observed).toEqual(['overlay-json', 'stale-ref-json']);
    expect(coverage.missing).toEqual([
      'adversarial-route',
      'adversarial-slow-network',
      'adversarial-table',
    ]);
    expect(coverage.exercised).toBe(false);
  });

  it('fails a real-app gate when any profile probe is missing or unsuccessful', () => {
    const decorated = decorateRealAppBenchmarkSummary({
      success: true,
      failedStep: null,
      gate: {
        passed: true,
        passedCount: 1,
        total: 1,
        criteria: [{ name: 'base-gate', passed: true }],
      },
      metrics: {},
      steps: [{ name: 'overlay-json', ok: true }],
    }, { realAppTarget: 'dashboard' });

    expect(decorated.success).toBe(false);
    expect(decorated.failedStep).toBe('real-app-probe-coverage');
    expect(decorated.gate).toMatchObject({ passed: false, passedCount: 1, total: 2 });
    expect(decorated.gate.criteria.at(-1)).toMatchObject({
      name: 'real-app-probe-coverage',
      passed: false,
    });
  });

  it('compacts benchmark summaries into comparable live round rows', () => {
    const round = compactCampaignRound(
      { round: 1, type: 'mcp', port: 9440, serverPort: 42140 },
      {
        success: true,
        failedStep: null,
        gate: { profile: 'mcp-problem-finding', passed: true, passedCount: 9, total: 9, criteria: [] },
        metrics: {
          totalMs: 3200,
          toolCalls: 6,
          protocolCalls: 2,
          firstUsefulObservationMs: 1800,
          firstActionEvidenceMs: 2600,
          estimatedOutputTokens: 7600,
          usefulObservationTokens: 4300,
          maxStepDurationMs: 1700,
          maxResponsiveStepDurationMs: 1600,
          maxStepEstimatedTokens: 2800,
          largeAppStress: {
            enabled: true,
            success: true,
            commandCoverage: { total: 5, covered: 5, rate: 1 },
            outputBudgetCoverage: { total: 5, covered: 5, rate: 1 },
            truncationMetadataCoverage: { total: 5, covered: 5, rate: 1 },
          },
          reportTimeline: true,
          semanticVerificationPassed: true,
          overlayRecoveryCovered: true,
          slowestStep: { name: 'open', durationMs: 1700 },
          slowestResponsiveStep: { name: 'perceive', durationMs: 1600 },
          biggestOutputStep: { name: 'report', estimatedTokens: 2800 },
        },
      },
      { startedAt: '2026-07-07T00:00:00.000Z', endedAt: '2026-07-07T00:00:03.200Z', wallMs: 3200 },
    );

    expect(round).toMatchObject({
      round: 1,
      type: 'mcp',
      success: true,
      gatePassed: true,
      metrics: {
        commandCalls: 6,
        toolCalls: 6,
        protocolCalls: 2,
        estimatedOutputTokens: 7600,
        maxResponsiveStepDurationMs: 1600,
        largeAppStress: {
          enabled: true,
          success: true,
        },
        reportTimeline: true,
      },
      culprit: {
        slowestStep: { name: 'open', durationMs: 1700 },
        slowestResponsiveStep: { name: 'perceive', durationMs: 1600 },
        biggestOutputStep: { name: 'report', estimatedTokens: 2800 },
      },
    });
  });

  it('keeps real-app target class in summaries, reports, and issue diagnostics', () => {
    const passed = compactCampaignRound(
      { round: 1, type: 'real-app', port: 9500, serverPort: 9600, realAppTarget: 'docs-app', targetClass: 'docs' },
      {
        success: true,
        gate: { profile: 'killer-path-default', passed: true, passedCount: 30, total: 30, criteria: [] },
        metrics: {
          realAppTarget: {
            name: 'docs-app',
            targetClass: 'docs',
            safeLocalOnly: true,
          },
          totalMs: 4200,
          estimatedOutputTokens: 8100,
          firstUsefulObservationMs: 1400,
          maxStepEstimatedTokens: 900,
          biggestOutputStep: { name: 'perceive', estimatedTokens: 900 },
        },
      },
      { startedAt: '2026-07-07T00:00:00.000Z', endedAt: '2026-07-07T00:00:04.200Z', wallMs: 4200 },
    );
    const failed = {
      round: 2,
      type: 'real-app',
      port: 9501,
      serverPort: 9601,
      seed: 'real-app-auth-flow',
      realAppTarget: 'auth-flow',
      targetClass: 'auth',
      success: false,
      failedStep: 'guarded-page',
      error: 'auth handoff missing',
      gate: { failedCriteria: ['real-app-target-class'] },
      metrics: {
        realAppTarget: { name: 'auth-flow', targetClass: 'auth', safeLocalOnly: true },
        maxResponsiveStepDurationMs: 2200,
      },
      culprit: { slowestResponsiveStep: { name: 'guarded-page', commandText: 'cdp perceive AABB -s #auth-panel', durationMs: 2200 } },
    };
    const summary = summarizeCampaignRun({
      startedAt: '2026-07-07T00:00:00.000Z',
      endedAt: '2026-07-07T00:00:08.000Z',
      plan: [{}, {}],
      rounds: [passed, failed],
    });
    const report = formatCampaignReport(summary);

    expect(passed).toMatchObject({
      realAppTarget: 'docs-app',
      targetClass: 'docs',
      metrics: {
        realAppTarget: {
          name: 'docs-app',
          targetClass: 'docs',
          safeLocalOnly: true,
        },
      },
    });
    expect(summary.typeSummaries).toContainEqual(expect.objectContaining({
      type: 'real-app',
      realAppTargets: {
        targets: ['auth-flow', 'docs-app'],
        classes: ['auth', 'docs'],
      },
    }));
    expect(summary.failurePatterns).toContainEqual(expect.objectContaining({
      round: 2,
      type: 'real-app',
      realAppTarget: 'auth-flow',
      targetClass: 'auth',
    }));
    expect(summary.issueDrafts[0].reproductionCommand).toContain('--real-app-targets auth-flow');
    expect(summary.issueDrafts[0].reproductionCommand).not.toContain('--adversarial-seeds');
    expect(summary.issueDrafts[0].body).toContain('- Real-app target: auth-flow');
    expect(summary.issueDrafts[0].body).toContain('- Target class: auth');
    expect(report).toContain('real-app targets: auth-flow, docs-app; classes auth, docs');
    expect(report).toContain('OK   #1 real-app docs-app/docs');
    expect(report).toContain('FAIL #2 real-app auth-flow/auth');
  });

  it('keeps adversarial seed and replay command in failed campaign diagnostics', () => {
    const round = compactCampaignRound(
      { round: 2, type: 'killer', port: 9442, serverPort: 42142, seed: 'round5-alpha' },
      {
        success: false,
        failedStep: 'adversarial-shadow',
        gate: {
          profile: 'killer-path-default',
          passed: false,
          passedCount: 28,
          total: 32,
          criteria: [
            { name: 'adversarial-scenario-exercised', passed: false },
          ],
        },
        metrics: {
          estimatedOutputTokens: 13000,
          adversarialScenario: {
            enabled: true,
            seed: 'round5-alpha',
            replayCommand: 'npm run benchmark:killer -- --json --adversarial-seed "round5-alpha"',
          },
          biggestOutputStep: { name: 'adversarial-shadow', estimatedTokens: 3000 },
        },
      },
      { startedAt: '2026-07-07T00:00:00.000Z', endedAt: '2026-07-07T00:00:03.200Z', wallMs: 3200 },
    );
    const drafts = buildCampaignIssueDrafts([round], { output: '/tmp/campaign.json' });

    expect(round.seed).toBe('round5-alpha');
    expect(round.metrics.adversarialScenario).toMatchObject({ seed: 'round5-alpha' });
    expect(drafts[0]).toMatchObject({
      seed: 'round5-alpha',
      reproductionCommand: 'npm run benchmark:campaign -- --types killer --rounds 1 --port-start 9442 --server-port-start 42142 --adversarial-seeds round5-alpha --fail-fast --json',
    });
    expect(drafts[0].body).toContain('- Seed: round5-alpha');
    expect(drafts[0].body).toContain('--adversarial-seeds round5-alpha');
  });

  it('recommends MCP when matched rounds are faster and lower token than CLI', () => {
    const recommendation = buildMcpCliRouteRecommendation([
      routeRound({ round: 1, type: 'mcp', totalMs: 3000, firstUsefulObservationMs: 1200, firstActionEvidenceMs: 2100, estimatedOutputTokens: 7000 }),
      routeRound({ round: 2, type: 'cli', totalMs: 5200, firstUsefulObservationMs: 2600, firstActionEvidenceMs: 3900, estimatedOutputTokens: 9600 }),
      routeRound({ round: 3, type: 'killer', adversarial: true, totalMs: 12000, estimatedOutputTokens: 20000 }),
    ]);

    expect(recommendation).toMatchObject({
      schema: 'chrome-cdp-ex.mcp-cli-route-recommendation.v1',
      recommendation: { route: 'mcp', confidence: 'high' },
      deltas: {
        'avg-total-latency': -2200,
        'first-useful-observation': -1400,
        'first-action-evidence': -1800,
        'avg-output-tokens': -2600,
      },
      excludedRounds: [{ round: 3, type: 'killer', seed: 'route-noise' }],
    });
  });

  it('recommends CLI when matched rounds have better pass rate and token cost', () => {
    const recommendation = buildMcpCliRouteRecommendation([
      routeRound({ round: 1, type: 'mcp', success: false, totalMs: 3200, estimatedOutputTokens: 11000 }),
      routeRound({ round: 2, type: 'cli', success: true, totalMs: 4300, estimatedOutputTokens: 7900 }),
    ]);

    expect(recommendation.recommendation).toMatchObject({
      route: 'cli',
      confidence: 'high',
    });
    expect(recommendation.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pass-rate', winner: 'cli' }),
      expect.objectContaining({ name: 'avg-output-tokens', winner: 'cli' }),
    ]));
  });

  it('reports inconclusive routing with first-observation and first-action deltas', () => {
    const summary = summarizeCampaignRun({
      startedAt: '2026-07-07T00:00:00.000Z',
      endedAt: '2026-07-07T00:00:08.000Z',
      plan: [{}, {}],
      rounds: [
        routeRound({ round: 1, type: 'mcp', totalMs: 4000, firstUsefulObservationMs: 1800, firstActionEvidenceMs: 2800, estimatedOutputTokens: 8000 }),
        routeRound({ round: 2, type: 'cli', totalMs: 4300, firstUsefulObservationMs: 2000, firstActionEvidenceMs: 3100, estimatedOutputTokens: 8200 }),
      ],
    });
    const report = formatCampaignReport(summary);

    expect(summary.routeRecommendation.recommendation).toMatchObject({
      route: 'inconclusive',
      confidence: 'low',
    });
    expect(report).toContain('Route recommendation: inconclusive (low confidence)');
    expect(report).toContain('first observation -200 ms');
    expect(report).toContain('first action -300 ms');
  });

  it('passes regression comparison when current metrics stay within thresholds', () => {
    const baseline = campaignSummaryForComparison({ passRate: 1, avgTokens: 10000, maxStepTokens: 3000, slowestMs: 1200, slowestStep: 'open' });
    const current = campaignSummaryForComparison({ passRate: 1, avgTokens: 10050, maxStepTokens: 3050, slowestMs: 1240, slowestStep: 'open' });
    const comparison = buildCampaignRegressionComparison(current, baseline, {
      thresholds: {
        warnAvgEstimatedOutputTokensIncrease: 250,
        warnMaxStepEstimatedTokensIncrease: 250,
        warnSlowestStepMsIncrease: 250,
      },
    });

    expect(comparison).toMatchObject({
      schema: 'chrome-cdp-ex.campaign-regression-comparison.v1',
      status: 'pass',
      deltas: {
        passRate: 0,
        avgEstimatedOutputTokens: 50,
        maxStepEstimatedTokens: 50,
        slowestStepMs: 40,
      },
      newCulpritSteps: [],
    });
    expect(comparison.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'avg-output-tokens', status: 'pass' }),
      expect.objectContaining({ name: 'max-step-tokens', status: 'pass' }),
      expect.objectContaining({ name: 'slowest-step-latency', status: 'pass' }),
    ]));
  });

  it('warns regression comparison for threshold-adjacent token and culprit changes', () => {
    const baseline = campaignSummaryForComparison({ passRate: 1, avgTokens: 10000, maxStepTokens: 3000, slowestMs: 1200, slowestStep: 'open', biggestOutputStep: 'report' });
    const current = campaignSummaryForComparison({ passRate: 0.99, avgTokens: 10300, maxStepTokens: 3250, slowestMs: 1300, slowestStep: 'report', biggestOutputStep: 'action' });
    const comparison = buildCampaignRegressionComparison(current, baseline, {
      thresholds: {
        warnPassRateDrop: 0.01,
        failPassRateDrop: 0.1,
        warnAvgEstimatedOutputTokensIncrease: 250,
        failAvgEstimatedOutputTokensIncrease: 1000,
        warnMaxStepEstimatedTokensIncrease: 250,
        failMaxStepEstimatedTokensIncrease: 1000,
        warnSlowestStepMsIncrease: 250,
        failSlowestStepMsIncrease: 1000,
      },
    });

    expect(comparison.status).toBe('warn');
    expect(comparison.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pass-rate', status: 'warn' }),
      expect.objectContaining({ name: 'avg-output-tokens', status: 'warn', delta: 300 }),
      expect.objectContaining({ name: 'max-step-tokens', status: 'warn', delta: 250 }),
    ]));
    expect(comparison.newCulpritSteps).toEqual(expect.arrayContaining([
      { field: 'slowest-step', from: 'open', to: 'report' },
      { field: 'biggest-output-step', from: 'report', to: 'action' },
    ]));
    expect(formatCampaignReport({ ...current, regressionComparison: comparison })).toContain('Regression comparison: warn');
    expect(formatCampaignReport({ ...current, regressionComparison: comparison })).toContain('new culprit: slowest-step open -> report');
    expect(formatCampaignReport({ ...current, regressionComparison: comparison })).toContain('biggest-output-step report -> action');
  });

  it('fails regression comparison when configured thresholds are exceeded', () => {
    const baseline = campaignSummaryForComparison({ passRate: 1, avgTokens: 10000, maxStepTokens: 3000, slowestMs: 1200 });
    const current = campaignSummaryForComparison({ passRate: 0.8, avgTokens: 11600, maxStepTokens: 4400, slowestMs: 2600 });
    const comparison = buildCampaignRegressionComparison(current, baseline, {
      thresholds: {
        failPassRateDrop: 0.05,
        failAvgEstimatedOutputTokensIncrease: 1000,
        failMaxStepEstimatedTokensIncrease: 1000,
        failSlowestStepMsIncrease: 1000,
      },
    });

    expect(comparison.status).toBe('fail');
    expect(comparison.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pass-rate', status: 'fail' }),
      expect.objectContaining({ name: 'avg-output-tokens', status: 'fail', delta: 1600 }),
      expect.objectContaining({ name: 'max-step-tokens', status: 'fail', delta: 1400 }),
      expect.objectContaining({ name: 'slowest-step-latency', status: 'fail', delta: 1400 }),
    ]));
  });

  it('reads pretty JSON and JSONL regression baselines', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-baseline-'));
    const prettyPath = resolve(dir, 'baseline.json');
    const jsonlPath = resolve(dir, 'baseline.jsonl');
    try {
      writeFileSync(prettyPath, `${JSON.stringify({ schema: 'chrome-cdp-ex.live-campaign.v1', passRate: 1 }, null, 2)}\n`);
      writeFileSync(jsonlPath, [
        JSON.stringify({ schema: 'chrome-cdp-ex.live-campaign-history.v1', metrics: { passRate: 0.5 } }),
        JSON.stringify({ schema: 'chrome-cdp-ex.live-campaign-history.v1', metrics: { passRate: 1 } }),
      ].join('\n'));

      expect(readComparisonBaseline(prettyPath)).toMatchObject({
        schema: 'chrome-cdp-ex.live-campaign.v1',
        passRate: 1,
      });
      expect(readComparisonBaseline(jsonlPath)).toMatchObject({
        schema: 'chrome-cdp-ex.live-campaign-history.v1',
        metrics: { passRate: 1 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads comparison baseline before appending current history', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-history-baseline-'));
    const historyPath = resolve(dir, 'history.jsonl');
    const baseline = {
      schema: 'chrome-cdp-ex.live-campaign-history.v1',
      recordedAt: '2026-07-07T00:00:00.000Z',
      metrics: {
        passRate: 0.5,
        avgEstimatedOutputTokens: 9000,
        maxStepEstimatedTokens: 2000,
        slowestStepMs: 1000,
        slowestStepName: 'open',
        biggestOutputStepName: 'report',
      },
    };
    try {
      writeFileSync(historyPath, `${JSON.stringify(baseline)}\n`);

      const raw = await runLiveCampaign({
        rounds: 0,
        types: ['killer'],
        history: historyPath,
        compareBaseline: historyPath,
        json: true,
        skipLock: true,
      });
      const summary = JSON.parse(raw);
      const records = readFileSync(historyPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));

      expect(summary.history.previous).toMatchObject(baseline);
      expect(summary.regressionComparison.baseline).toMatchObject(baseline.metrics);
      expect(records).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarizes pass rate, per-type averages, failures, and optimization suspects', () => {
    const rounds = [
      {
        round: 1,
        type: 'mcp',
        success: true,
        metrics: {
          totalMs: 3000,
          estimatedOutputTokens: 7000,
          usefulObservationTokens: 4200,
          firstUsefulObservationMs: 1600,
          firstActionEvidenceMs: 2500,
          maxStepDurationMs: 1600,
          maxResponsiveStepDurationMs: 1500,
          maxStepEstimatedTokens: 2600,
        },
        culprit: { slowestStep: { name: 'open' }, slowestResponsiveStep: { name: 'perceive' }, biggestOutputStep: { name: 'report' } },
      },
      {
        round: 2,
        type: 'large-app',
        success: true,
        failedStep: null,
        error: null,
        gate: { failedCriteria: [] },
        metrics: {
          totalMs: 9000,
          estimatedOutputTokens: 19000,
          usefulObservationTokens: 1500,
          firstUsefulObservationMs: 2200,
          firstActionEvidenceMs: 3000,
          maxStepDurationMs: 2100,
          maxResponsiveStepDurationMs: 1200,
          maxStepEstimatedTokens: 4700,
          largeAppStress: {
            enabled: true,
            success: true,
            commandCoverage: { total: 5, covered: 5, rate: 1 },
            outputBudgetCoverage: { total: 5, covered: 5, rate: 1 },
            truncationMetadataCoverage: { total: 5, covered: 5, rate: 1 },
          },
        },
        culprit: { slowestStep: { name: 'open' }, slowestResponsiveStep: { name: 'click' }, biggestOutputStep: { name: 'report' } },
      },
    ];

    const summary = summarizeCampaignRun({
      startedAt: '2026-07-07T00:00:00.000Z',
      endedAt: '2026-07-07T00:00:12.000Z',
      plan: [{}, {}],
      rounds,
    });

    expect(summary).toMatchObject({
      schema: 'chrome-cdp-ex.live-campaign.v1',
      plannedRounds: 2,
      roundsCompleted: 2,
      passCount: 2,
      failCount: 0,
      passRate: 1,
      failurePatterns: [],
      opportunities: {
        slowestRound: { round: 2, type: 'large-app', value: 2100 },
        slowestResponsiveRound: { round: 1, type: 'mcp', value: 1500 },
        biggestOutputRound: { round: 2, type: 'large-app', value: 4700 },
      },
    });
    expect(summary.typeSummaries).toContainEqual(expect.objectContaining({
      type: 'mcp',
      rounds: 1,
      passed: 1,
      avgEstimatedOutputTokens: 7000,
      maxResponsiveStepDurationMs: 1500,
    }));
    expect(summary.typeSummaries).toContainEqual(expect.objectContaining({
      type: 'large-app',
      largeAppStress: {
        rounds: 1,
        passed: 1,
        avgCommandCoverageRate: 1,
        avgOutputBudgetCoverageRate: 1,
        avgTruncationMetadataCoverageRate: 1,
      },
    }));
    expect(formatCampaignReport(summary)).toContain('Pass rate: 100% (2/2)');
    expect(formatCampaignReport(summary)).toContain('slowest responsive step: round 1 mcp, 1500 ms (perceive)');
    expect(formatCampaignReport(summary)).toContain('large-app stress: 1/1 pass, command coverage 100%, output budgets 100%, truncation metadata 100%');
  });

  it('does not round fractional large-app coverage rates up to a false green', () => {
    const summary = summarizeCampaignRun({
      startedAt: '2026-07-07T00:00:00.000Z',
      endedAt: '2026-07-07T00:00:06.000Z',
      plan: [{}, {}],
      rounds: [
        {
          round: 1,
          type: 'large-app',
          success: true,
          metrics: {
            largeAppStress: {
              enabled: true,
              success: true,
              commandCoverage: { rate: 1 },
              outputBudgetCoverage: { rate: 1 },
              truncationMetadataCoverage: { rate: 1 },
            },
          },
          culprit: {},
        },
        {
          round: 2,
          type: 'large-app',
          success: false,
          metrics: {
            largeAppStress: {
              enabled: true,
              success: false,
              commandCoverage: { rate: 0 },
              outputBudgetCoverage: { rate: 0 },
              truncationMetadataCoverage: { rate: 0 },
            },
          },
          culprit: {},
        },
      ],
    });

    const largeApp = summary.typeSummaries.find(entry => entry.type === 'large-app');

    expect(largeApp.largeAppStress).toMatchObject({
      avgCommandCoverageRate: 0.5,
      avgOutputBudgetCoverageRate: 0.5,
      avgTruncationMetadataCoverageRate: 0.5,
    });
    expect(formatCampaignReport(summary)).toContain('large-app stress: 1/2 pass, command coverage 50%, output budgets 50%, truncation metadata 50%');
  });

  it('appends compact campaign history and reports previous-run deltas', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-campaign-history-'));
    const historyPath = resolve(dir, 'history.jsonl');
    try {
      const first = summarizeCampaignRun({
        startedAt: '2026-07-08T00:00:00.000Z',
        endedAt: '2026-07-08T00:00:04.000Z',
        plan: [{}, {}],
        rounds: [
          {
            round: 1,
            type: 'mcp',
            success: true,
            metrics: {
              estimatedOutputTokens: 6000,
              maxStepEstimatedTokens: 2400,
              maxStepDurationMs: 1200,
              maxResponsiveStepDurationMs: 1100,
            },
            culprit: { slowestStep: { name: 'open' }, biggestOutputStep: { name: 'report' } },
          },
          {
            round: 2,
            type: 'killer',
            success: true,
            metrics: {
              estimatedOutputTokens: 16000,
              maxStepEstimatedTokens: 3000,
              maxStepDurationMs: 1400,
              maxResponsiveStepDurationMs: 1300,
            },
            culprit: { slowestStep: { name: 'report' }, biggestOutputStep: { name: 'report' } },
          },
        ],
      });
      expect(appendCampaignHistory(historyPath, first)).toMatchObject({
        previous: null,
        current: {
          schema: 'chrome-cdp-ex.live-campaign-history.v1',
          metrics: {
            passRate: 1,
            avgEstimatedOutputTokens: 11000,
            maxStepEstimatedTokens: 3000,
            slowestStepMs: 1400,
          },
        },
        delta: null,
      });

      const second = summarizeCampaignRun({
        startedAt: '2026-07-08T00:05:00.000Z',
        endedAt: '2026-07-08T00:05:04.000Z',
        plan: [{}, {}],
        rounds: [
          {
            round: 1,
            type: 'mcp',
            success: true,
            metrics: {
              estimatedOutputTokens: 7000,
              maxStepEstimatedTokens: 2600,
              maxStepDurationMs: 1500,
              maxResponsiveStepDurationMs: 1400,
            },
            culprit: { slowestStep: { name: 'open' }, biggestOutputStep: { name: 'report' } },
          },
          {
            round: 2,
            type: 'killer',
            success: false,
            metrics: {
              estimatedOutputTokens: 19000,
              maxStepEstimatedTokens: 3600,
              maxStepDurationMs: 1800,
              maxResponsiveStepDurationMs: 1700,
            },
            culprit: { slowestStep: { name: 'click' }, biggestOutputStep: { name: 'action' } },
          },
        ],
      });
      second.history = appendCampaignHistory(historyPath, second);

      expect(second.history.delta).toMatchObject({
        passRate: -0.5,
        avgEstimatedOutputTokens: 2000,
        maxStepEstimatedTokens: 600,
        slowestStepMs: 400,
        slowestStepChanged: { from: 'report', to: 'click' },
      });
      expect(formatCampaignReport(second)).toContain('History trend: pass rate -50pp, avg output +2000 tokens, max step +600 tokens, slowest step +400 ms');
      expect(formatCampaignReport(second)).toContain('slowest step changed: report -> click');
      const records = readFileSync(historyPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        schema: 'chrome-cdp-ex.live-campaign-history.v1',
        metrics: {
          passRate: 0.5,
          avgEstimatedOutputTokens: 13000,
          maxStepEstimatedTokens: 3600,
          slowestStepMs: 1800,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits issue-ready diagnostics for MCP, Killer, and large-app campaign failures', () => {
    const summary = summarizeCampaignRun({
      startedAt: '2026-07-08T01:00:00.000Z',
      endedAt: '2026-07-08T01:00:12.000Z',
      plan: [{}, {}, {}],
      artifacts: {
        output: '/tmp/campaign-failure.json',
        history: '/tmp/campaign-history.jsonl',
      },
      rounds: [
        {
          round: 1,
          type: 'mcp',
          port: 9500,
          serverPort: 9600,
          success: false,
          failedStep: null,
          error: null,
          gate: { failedCriteria: ['mcp-tool-output-budget'] },
          metrics: { maxStepEstimatedTokens: 4100 },
          culprit: { biggestOutputStep: { name: 'report', commandText: 'mcp report', estimatedTokens: 4100 } },
        },
        {
          round: 2,
          type: 'killer',
          port: 9501,
          serverPort: 9601,
          success: false,
          failedStep: 'click',
          error: 'Action failure: stale-ref',
          gate: { failedCriteria: ['run-success'] },
          metrics: { maxStepDurationMs: 5100 },
          culprit: { slowestStep: { name: 'click', commandText: 'cdp click AABB @1', durationMs: 5100 } },
        },
        {
          round: 3,
          type: 'large-app',
          port: 9502,
          serverPort: 9602,
          success: false,
          failedStep: null,
          error: null,
          gate: { failedCriteria: ['large-app-truncation-metadata'] },
          metrics: { maxResponsiveStepDurationMs: 2200 },
          culprit: { slowestResponsiveStep: { name: 'summary', commandText: 'cdp summary AABB --format json', durationMs: 2200 } },
        },
      ],
    });

    expect(summary.issueDrafts).toHaveLength(3);
    expect(summary.issueDrafts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '[live-campaign] mcp round 1 failed: mcp-tool-output-budget',
        reproductionCommand: 'npm run benchmark:campaign -- --types mcp --rounds 1 --port-start 9500 --server-port-start 9600 --fail-fast --json',
        suggestedLabels: ['bug', 'type: benchmark', 'priority: p1'],
        seed: null,
        ports: { cdp: 9500, http: 9600 },
        failedCriteria: ['mcp-tool-output-budget'],
        culpritStep: { name: 'report', commandText: 'mcp report', estimatedTokens: 4100 },
        artifactPaths: ['/tmp/campaign-failure.json', '/tmp/campaign-history.jsonl'],
      }),
      expect.objectContaining({
        title: '[live-campaign] killer round 2 failed: run-success',
        error: 'Action failure: stale-ref',
        culpritStep: { name: 'click', commandText: 'cdp click AABB @1', durationMs: 5100 },
      }),
      expect.objectContaining({
        title: '[live-campaign] large-app round 3 failed: large-app-truncation-metadata',
        culpritStep: { name: 'summary', commandText: 'cdp summary AABB --format json', durationMs: 2200 },
      }),
    ]));
    expect(summary.issueDrafts[0].body).toContain('Reproduce');
    expect(summary.issueDrafts[0].body).toContain('npm run benchmark:campaign -- --types mcp --rounds 1');
    expect(summary.issueDrafts[0].body).toContain('/tmp/campaign-failure.json');
    expect(formatCampaignReport(summary)).toContain('Issue-ready diagnostics:');
    expect(formatCampaignReport(summary)).toContain('[live-campaign] mcp round 1 failed: mcp-tool-output-budget');
  });
});
