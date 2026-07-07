import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  appendCampaignHistory,
  buildCampaignRoundPlan,
  compactCampaignRound,
  formatCampaignReport,
  parseCampaignArgs,
  summarizeCampaignRun,
} from '../scripts/benchmark-live-campaign.mjs';

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
    });
    expect(buildCampaignRoundPlan(opts)).toEqual([
      { round: 1, type: 'mcp', port: 9500, serverPort: 43000 },
      { round: 2, type: 'killer', port: 9501, serverPort: 43001 },
      { round: 3, type: 'large-app', port: 9502, serverPort: 43002 },
      { round: 4, type: 'mcp', port: 9503, serverPort: 43003 },
      { round: 5, type: 'killer', port: 9504, serverPort: 43004 },
    ]);
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
