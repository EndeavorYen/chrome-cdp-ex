import { describe, expect, it } from 'vitest';

import {
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
});
