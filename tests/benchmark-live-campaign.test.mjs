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
      '--types', 'mcp,killer',
      '--port-start', '9500',
      '--server-port-start', '43000',
      '--stability-ms', '250',
      '--settle-ms', '0',
      '--json',
      '--output', '/tmp/campaign.json',
    ]);

    expect(opts).toMatchObject({
      rounds: 5,
      types: ['mcp', 'killer'],
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
      { round: 3, type: 'mcp', port: 9502, serverPort: 43002 },
      { round: 4, type: 'killer', port: 9503, serverPort: 43003 },
      { round: 5, type: 'mcp', port: 9504, serverPort: 43004 },
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
          maxStepEstimatedTokens: 2800,
          reportTimeline: true,
          semanticVerificationPassed: true,
          overlayRecoveryCovered: true,
          slowestStep: { name: 'open', durationMs: 1700 },
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
        reportTimeline: true,
      },
      culprit: {
        slowestStep: { name: 'open', durationMs: 1700 },
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
          maxStepEstimatedTokens: 2600,
        },
        culprit: { slowestStep: { name: 'open' }, biggestOutputStep: { name: 'report' } },
      },
      {
        round: 2,
        type: 'killer',
        success: false,
        failedStep: 'list',
        error: null,
        gate: { failedCriteria: ['run-success'] },
        metrics: {
          totalMs: 9000,
          estimatedOutputTokens: 19000,
          usefulObservationTokens: 1500,
          firstUsefulObservationMs: 2200,
          firstActionEvidenceMs: 3000,
          maxStepDurationMs: 2100,
          maxStepEstimatedTokens: 4700,
        },
        culprit: { slowestStep: { name: 'open' }, biggestOutputStep: { name: 'report' } },
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
      passCount: 1,
      failCount: 1,
      passRate: 0.5,
      failurePatterns: [{ round: 2, type: 'killer', failedStep: 'list', failedCriteria: ['run-success'] }],
      opportunities: {
        slowestRound: { round: 2, type: 'killer', value: 2100 },
        biggestOutputRound: { round: 2, type: 'killer', value: 4700 },
      },
    });
    expect(summary.typeSummaries).toContainEqual(expect.objectContaining({
      type: 'mcp',
      rounds: 1,
      passed: 1,
      avgEstimatedOutputTokens: 7000,
    }));
    expect(formatCampaignReport(summary)).toContain('Pass rate: 50% (1/2)');
  });
});
