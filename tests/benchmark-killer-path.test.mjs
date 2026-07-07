import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildBenchmarkGate,
  buildLargeAppStressFixture,
  buildKillerPathEntryPlan,
  buildKillerPathBenchmarkPlan,
  estimateTokenCount,
  formatBenchmarkReport,
  loadComparisonBaselineFile,
  parseBenchmarkArgs,
  summarizeBenchmarkRun,
} from '../scripts/benchmark-killer-path.mjs';

function sampleActionReceipt(overrides = {}) {
  return {
    schema: 'chrome-cdp-ex.action-receipt.v1',
    actionId: 'act_123456789abc',
    eventId: 'act_AABBCCDD_000001',
    sequence: 1,
    actionName: 'click',
    targetSummary: 'Start',
    dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
    settlement: {
      ok: true,
      state: 'settled',
      strategy: 'dom-observation',
      durationMs: 120,
      timeoutMs: null,
      observedChannels: ['ax-diff', 'console', 'exceptions', 'network'],
      signals: [],
      reason: 'Post-action DOM observation completed.',
    },
    outcome: 'changed',
    observedDelta: ['DOM changed after action'],
    observedDeltaDetails: [
      { type: 'dom', status: 'changed', summary: 'DOM changed after action' },
      { type: 'console', status: 'unchanged', count: 0, errors: 0, warnings: 0, summary: 'Console unchanged' },
      { type: 'exception', status: 'unchanged', count: 0, summary: 'Exceptions unchanged' },
      { type: 'network', status: 'unchanged', count: 0, failures: 0, pending: 0, summary: 'Network unchanged' },
    ],
    blockingSignals: [],
    recoveryHint: 'Continue from the observed action evidence.',
    nextSteps: ['cdp report AABBCCDD --format json'],
    recovery: {
      strategy: 'continue-from-evidence',
      priority: 'low',
      verifyCommand: 'cdp report AABBCCDD --format json',
    },
    ...overrides,
  };
}

describe('benchmark killer path helpers', () => {
  it('summarizes command calls, timing, token estimates, and action evidence', () => {
    const steps = [
      {
        name: 'doctor',
        command: ['doctor'],
        startedAt: 0,
        endedAt: 10,
        status: 0,
        stdout: 'chrome-cdp-ex doctor\nWizard:\nNext steps:\n  1. cdp list\n',
        stderr: '',
      },
      {
        name: 'perceive',
        command: ['perceive', 'AABBCCDD', '-C', '-d', '8'],
        startedAt: 10,
        endedAt: 40,
        status: 0,
        stdout: 'Page: Test\n@1 [button] Start\nCoords: top-level viewport CSS px\n',
        stderr: '',
      },
      {
        name: 'overlay',
        command: ['overlay', 'AABBCCDD'],
        startedAt: 40,
        endedAt: 55,
        status: 0,
        stdout: 'Overlay detector: blocking\nNext: cdp dismiss-modal AABBCCDD\n',
        stderr: '',
      },
      {
        name: 'overlay-json',
        command: ['overlay', 'AABBCCDD', '--format', 'json'],
        startedAt: 55,
        endedAt: 60,
        status: 0,
        benchmarkProbe: true,
        stdout: JSON.stringify({
          schema: 'chrome-cdp-ex.overlays.v1',
          viewport: { width: 1280, height: 720 },
          target: null,
          overlayCount: 1,
          blocking: true,
          overlays: [{ kind: 'dialog', selector: '#modal', blocking: true }],
          nextCommand: 'cdp dismiss-modal AABBCCDD',
        }),
        stderr: '',
      },
      {
        name: 'frame',
        command: ['frame', 'AABBCCDD'],
        startedAt: 60,
        endedAt: 80,
        status: 0,
        stdout: 'Frames:\n@f2 smoke-child http://example.test/child\n',
        stderr: '',
      },
      {
        name: 'frame-json',
        command: ['frame', 'AABBCCDD', '--format', 'json'],
        startedAt: 80,
        endedAt: 85,
        status: 0,
        benchmarkProbe: true,
        stdout: JSON.stringify({
          schema: 'chrome-cdp-ex.frames.v1',
          frameCount: 2,
          frames: [
            { ref: '@f1', id: 'main', depth: 0, url: 'http://example.test/' },
            { ref: '@f2', id: 'child', depth: 1, parentRef: '@f1', url: 'http://example.test/child' },
          ],
        }),
        stderr: '',
      },
      {
        name: 'cascade',
        command: ['cascade', 'AABBCCDD', '#start', 'background-color'],
        startedAt: 85,
        endedAt: 110,
        status: 0,
        stdout: 'background-color:\n  WIN rgb(1, 2, 3) ← #start\n    → inline:12\n',
        stderr: '',
      },
      {
        name: 'cascade-json',
        command: ['cascade', 'AABBCCDD', '#start', 'background-color', '--format', 'json'],
        startedAt: 110,
        endedAt: 115,
        status: 0,
        benchmarkProbe: true,
        stdout: JSON.stringify({
          schema: 'chrome-cdp-ex.cascade.v1',
          input: { selector: '#start', property: 'background-color' },
          propertyCount: 1,
          properties: [{
            name: 'background-color',
            computedValue: 'rgb(1, 2, 3)',
            winner: { selector: '#start', value: 'rgb(1, 2, 3)', source: 'inline:12' },
            rules: [{ selector: '#start', value: 'rgb(1, 2, 3)', source: 'inline:12', winner: true }],
          }],
          editTarget: { property: 'background-color', selector: '#start', source: 'inline:12' },
        }),
        stderr: '',
      },
      {
        name: 'hmr-diff',
        command: ['perceive', 'AABBCCDD', '--diff', '-s', '#combat-log', '--last', '20'],
        startedAt: 115,
        endedAt: 133,
        status: 0,
        stdout: '~~~ Text nodes updated (1 added)\n+   [StaticText] hmr panel ready\n',
        stderr: '',
      },
      {
        name: 'guarded-page',
        command: ['perceive', 'AABBCCDD', '-s', '#auth-panel', '-d', '4'],
        startedAt: 133,
        endedAt: 140,
        status: 0,
        stdout: 'Page: Test\n[region] Authenticated dashboard\n[StaticText] auth state preserved\n@7 [button] Refresh account\n',
        stderr: '',
      },
      {
        name: 'click',
        command: ['click', 'AABBCCDD', '#start'],
        startedAt: 140,
        endedAt: 152,
        status: 0,
        stdout: 'Clicked #start\n---\nclick: dispatched\nEffects:\n+++ Added\n[StaticText] Started\n',
        stderr: '',
      },
      {
        name: 'since-action',
        command: ['perceive', 'AABBCCDD', '--since-action', '--format', 'json'],
        startedAt: 152,
        endedAt: 162,
        status: 0,
        stdout: JSON.stringify({
          schema: 'chrome-cdp-ex.perceive-diff.v1',
          mode: 'since-action',
          summary: { changed: true, removed: 0, added: 1, textRemoved: 0, textAdded: 0 },
          removed: [],
          added: ['[StaticText] Started'],
          removedOmitted: 0,
          addedOmitted: 0,
          textRemovedSamples: [],
          textAddedSamples: [],
          recommendation: {
            source: 'perceive-diff',
            mode: 'since-action',
            commands: ['cdp report AABBCCDD --format json'],
          },
          nextSteps: ['cdp report AABBCCDD --format json'],
        }),
        stderr: '',
      },
      {
        name: 'stale-ref',
        command: ['click', 'AABBCCDD', '@1'],
        startedAt: 162,
        endedAt: 182,
        status: 1,
        expectedFailure: true,
        stdout: '',
        stderr: 'Action failure: stale-ref\nReason: The @ref no longer maps to the current DOM.\nNext: cdp perceive AABBCCDD -C -d 8\n',
      },
      {
        name: 'report',
        command: ['report', 'AABBCCDD'],
        startedAt: 182,
        endedAt: 212,
        status: 0,
        stdout: 'Session report: AABBCCDD\nActions: 1\n\nAction timeline:\n- click #start\n',
        stderr: '',
      },
      {
        name: 'stability-wait',
        command: ['wait', 'AABBCCDD', '1000'],
        startedAt: 212,
        endedAt: 222,
        status: 0,
        stdout: 'waited 1000ms',
        stderr: '',
      },
      {
        name: 'stability-status',
        command: ['status', 'AABBCCDD'],
        startedAt: 222,
        endedAt: 237,
        status: 0,
        stdout: 'Status: ready\n',
        stderr: '',
      },
      {
        name: 'stability-report',
        command: ['report', 'AABBCCDD'],
        startedAt: 237,
        endedAt: 252,
        status: 0,
        stdout: 'Session report: AABBCCDD\nActions: 1\n\nAction timeline:\n- click #start\n',
        stderr: '',
      },
    ];

    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt: 0,
      endedAt: 252,
      target: 'AABBCCDD',
      steps,
    });

    const outputChars = steps.reduce((sum, step) => sum + step.stdout.length + step.stderr.length, 0);

    expect(summary.schema).toBe('chrome-cdp-ex.benchmark.v1');
    expect(summary.scenario).toBe('killer-path');
    expect(summary.success).toBe(true);
    expect(summary.target).toBe('AABBCCDD');
    expect(summary.metrics.totalMs).toBe(252);
    expect(summary.metrics.commandCalls).toBe(14);
    expect(summary.metrics.outputChars).toBe(outputChars);
    expect(summary.metrics.estimatedOutputTokens).toBe(estimateTokenCount(outputChars));
    expect(summary.metrics.maxStepEstimatedTokens).toBeGreaterThan(0);
    expect(summary.metrics.maxStepDurationMs).toBe(30);
    expect(summary.metrics.biggestOutputStep).toEqual(expect.objectContaining({
      name: expect.any(String),
      estimatedTokens: summary.metrics.maxStepEstimatedTokens,
    }));
    expect(summary.metrics.slowestStep).toEqual(expect.objectContaining({
      durationMs: 30,
    }));
    expect(summary.metrics.firstUsefulObservationMs).toBe(40);
    expect(summary.metrics.firstActionEvidenceMs).toBe(152);
    expect(summary.metrics.goldenPathMs).toBe(212);
    expect(summary.metrics.autoEvidenceActions).toBe(1);
    expect(summary.metrics.actionEvidenceCoverage).toMatchObject({
      total: 2,
      covered: 2,
      missing: [],
      rate: 1,
      byCommand: {
        click: { total: 2, covered: 2, missing: 0 },
      },
    });
    expect(summary.metrics.handoffNextStepsCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.sinceActionEvidenceCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.verificationCallsSaved).toBe(1);
    expect(summary.metrics.hasReportTimeline).toBe(true);
    expect(summary.metrics.differentiators).toMatchObject({
      modalOverlay: { success: true, durationMs: 15, commandCalls: 1 },
      frameRefs: { success: true, durationMs: 20, commandCalls: 1 },
      cssTrace: { success: true, durationMs: 25, commandCalls: 1 },
      hmrDomUpdate: { success: true, durationMs: 18, commandCalls: 1 },
      guardedPage: { success: true, durationMs: 7, commandCalls: 1 },
      successRate: 1,
    });
    expect(summary.metrics.differentiatorHandoffCoverage).toMatchObject({
      total: 3,
      covered: 3,
      missing: [],
      rate: 1,
      bySchema: {
        'chrome-cdp-ex.overlays.v1': { total: 1, covered: 1, missing: 0 },
        'chrome-cdp-ex.frames.v1': { total: 1, covered: 1, missing: 0 },
        'chrome-cdp-ex.cascade.v1': { total: 1, covered: 1, missing: 0 },
      },
    });
    expect(summary.metrics.staleRefRecovery).toMatchObject({
      success: true,
      durationMs: 20,
      commandCalls: 1,
      rate: 1,
    });
    expect(summary.metrics.sessionStability).toMatchObject({
      enabled: true,
      success: true,
      durationMs: 40,
      commandCalls: 3,
      statusOk: true,
      reportOk: true,
      failedStep: null,
    });
    expect(summary.comparison).toMatchObject({
      schema: 'chrome-cdp-ex.benchmark-comparison.v1',
      source: 'heuristic-smoke-baseline',
      note: 'Baselines are conservative planning estimates for this smoke path until competitor harnesses are implemented.',
    });
    expect(summary.comparison.baselines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'playwright',
        label: 'Playwright test generator/snapshot',
        metrics: expect.objectContaining({
          commandCalls: 26,
          usefulObservationTokens: 5000,
          verificationCallsSaved: 0,
        }),
        delta: expect.objectContaining({
          commandCallsSaved: 12,
          usefulObservationTokensSaved: expect.any(Number),
          verificationCallsSaved: 1,
        }),
      }),
      expect.objectContaining({
        id: 'devtools-manual',
        label: 'Manual DevTools inspection',
        delta: expect.objectContaining({
          commandCallsSaved: 21,
        }),
      }),
      expect.objectContaining({
        id: 'generic-cdp',
        label: 'Generic CDP script',
        delta: expect.objectContaining({
          commandCallsSaved: 16,
        }),
      }),
    ]));
    expect(summary.gate).toMatchObject({
      schema: 'chrome-cdp-ex.benchmark-gate.v1',
      passed: true,
      profile: 'killer-path-default',
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'first-useful-observation', passed: true, actual: 40, operator: '<=', limit: 5000 }),
      expect.objectContaining({ name: 'first-action-evidence', passed: true, actual: 152, operator: '<=' }),
      expect.objectContaining({ name: 'golden-path-under-two-minutes', passed: true, actual: 212, operator: '<=', limit: 120000 }),
      expect.objectContaining({ name: 'total-output-tokens', passed: true, actual: summary.metrics.estimatedOutputTokens, operator: '<=', limit: 17000 }),
      expect.objectContaining({ name: 'max-step-output-tokens', passed: true, actual: summary.metrics.maxStepEstimatedTokens, operator: '<=' }),
      expect.objectContaining({ name: 'max-step-duration', passed: true, actual: 30, operator: '<=' }),
      expect.objectContaining({ name: 'useful-observation-tokens', passed: true, operator: '<=', limit: 3000 }),
      expect.objectContaining({ name: 'auto-evidence-actions', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'observed-action-evidence-coverage', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'since-action-evidence-coverage', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'report-timeline', passed: true, actual: true, operator: '===', limit: true }),
      expect.objectContaining({ name: 'differentiator-success-rate', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'differentiator-handoff-coverage', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'stale-ref-recovery-rate', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'session-stability-sample', passed: true, actual: true, operator: '===', limit: true }),
    ]));
    const clickSummary = summary.steps.find(step => step.name === 'click');
    const clickSource = steps.find(step => step.name === 'click');
    expect(clickSummary).toMatchObject({
      name: 'click',
      ok: true,
      durationMs: 12,
      estimatedTokens: estimateTokenCount(clickSource.stdout.length),
      hasActionEvidence: true,
    });
    expect(summary.steps.find(step => step.name === 'stale-ref')).toMatchObject({
      name: 'stale-ref',
      ok: true,
      expectedFailure: true,
    });
  });

  it('fails the gate when total output, step output, latency, or first action evidence exceed budgets', () => {
    const steps = [
      { name: 'doctor', command: ['doctor'], startedAt: 0, endedAt: 10, status: 0, stdout: 'Wizard:\n', stderr: '' },
      { name: 'perceive', command: ['perceive', 'AABB'], startedAt: 10, endedAt: 80, status: 0, stdout: 'Page:\n@1 Button\n', stderr: '' },
      {
        name: 'click',
        command: ['click', 'AABB', '@1'],
        startedAt: 80,
        endedAt: 300,
        status: 0,
        stdout: `${'x'.repeat(1000)}\nclick: dispatched\n`,
        stderr: '',
      },
      { name: 'perceive', command: ['perceive', 'AABB', '--since-action'], startedAt: 300, endedAt: 330, status: 0, stdout: '+++ Added\n', stderr: '' },
      { name: 'report', command: ['report', 'AABB'], startedAt: 330, endedAt: 360, status: 0, stdout: 'Session report:\nAction timeline:\n- click\n', stderr: '' },
      { name: 'stability-wait', command: ['wait', 'AABB', '1'], startedAt: 360, endedAt: 520, status: 0, stdout: 'Waited 1ms', stderr: '' },
      { name: 'stability-status', command: ['status', 'AABB'], startedAt: 520, endedAt: 530, status: 0, stdout: 'Status: ready', stderr: '' },
      { name: 'stability-report', command: ['report', 'AABB'], startedAt: 530, endedAt: 540, status: 0, stdout: 'Session report:\nAction timeline:\n- click\n', stderr: '' },
    ];
    const summary = summarizeBenchmarkRun({ startedAt: 0, endedAt: 540, target: 'AABB', steps });
    const gate = buildBenchmarkGate(summary, {
      commandCallsMax: 20,
      firstUsefulObservationMsMax: 5000,
      firstActionEvidenceMsMax: 250,
      goldenPathMsMax: 120000,
      estimatedOutputTokensMax: 200,
      maxStepEstimatedTokensMax: 100,
      maxStepDurationMsMax: 150,
      usefulObservationTokensMax: 3000,
      autoEvidenceActionsMin: 1,
      observedActionEvidenceCoverageRateMin: 1,
      actionEvidenceCompletenessCoverageRateMin: 0,
      actionFailureDiagnosisCoverageRateMin: 0,
      actionNoChangeRecoveryCoverageRateMin: 0,
      cliRecoveryCoverageRateMin: 0,
      handoffNextStepsCoverageRateMin: 0,
      handoffRecommendationCoverageRateMin: 0,
      doctorOnboardingCoverageRateMin: 0,
      targetHandoffCoverageRateMin: 0,
      reportLatestActionCoverageRateMin: 0,
      reportTimelineWindowCoverageRateMin: 0,
      reportArtifactCoverageRateMin: 0,
      perceptionSignalCoverageRateMin: 0,
      sinceActionEvidenceCoverageRateMin: 0,
      differentiatorSuccessRateMin: 0,
      differentiatorHandoffCoverageRateMin: 0,
      staleRefRecoveryRateMin: 0,
    });

    expect(gate.passed).toBe(false);
    expect(gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'first-action-evidence',
        passed: false,
        actual: 300,
        limit: 250,
        culprit: expect.objectContaining({ name: 'click' }),
      }),
      expect.objectContaining({
        name: 'total-output-tokens',
        passed: false,
        actual: summary.metrics.estimatedOutputTokens,
        limit: 200,
        culprit: expect.objectContaining({ name: 'click' }),
      }),
      expect.objectContaining({
        name: 'max-step-output-tokens',
        passed: false,
        actual: summary.metrics.maxStepEstimatedTokens,
        limit: 100,
        culprit: expect.objectContaining({ name: 'click' }),
      }),
      expect.objectContaining({
        name: 'max-step-duration',
        passed: false,
        actual: 220,
        limit: 150,
        culprit: expect.objectContaining({ name: 'click' }),
      }),
    ]));
  });

  it('keeps intentional stability waits out of the responsive max-step gate', () => {
    const steps = [
      { name: 'perceive', command: ['perceive', 'AABB'], startedAt: 0, endedAt: 80, status: 0, stdout: 'Page:\n@1 Button', stderr: '' },
      { name: 'click', command: ['click', 'AABB', '#go'], startedAt: 80, endedAt: 200, status: 0, stdout: 'Clicked\nclick: dispatched', stderr: '' },
      { name: 'since-action', command: ['perceive', 'AABB', '--since-action'], startedAt: 200, endedAt: 240, status: 0, stdout: '+++ Added\n', stderr: '' },
      { name: 'report', command: ['report', 'AABB'], startedAt: 240, endedAt: 270, status: 0, stdout: 'Session report:\nAction timeline:\n- click\n', stderr: '' },
      { name: 'stability-wait', command: ['wait', 'AABB', '5000'], startedAt: 270, endedAt: 5317, status: 0, stdout: 'Waited 5000ms', stderr: '' },
      { name: 'stability-status', command: ['status', 'AABB'], startedAt: 5317, endedAt: 5330, status: 0, stdout: 'Status: ready', stderr: '' },
      { name: 'stability-report', command: ['report', 'AABB'], startedAt: 5330, endedAt: 5355, status: 0, stdout: 'Session report:\nAction timeline:\n- click\n', stderr: '' },
    ];
    const summary = summarizeBenchmarkRun({ startedAt: 0, endedAt: 5355, target: 'AABB', steps });
    const gate = buildBenchmarkGate(summary, {
      commandCallsMax: 20,
      firstUsefulObservationMsMax: 5000,
      firstActionEvidenceMsMax: 5000,
      goldenPathMsMax: 120000,
      estimatedOutputTokensMax: 20000,
      maxStepEstimatedTokensMax: 5000,
      maxStepDurationMsMax: 150,
      usefulObservationTokensMax: 3000,
      autoEvidenceActionsMin: 1,
      observedActionEvidenceCoverageRateMin: 0,
      actionEvidenceCompletenessCoverageRateMin: 0,
      actionFailureDiagnosisCoverageRateMin: 0,
      actionNoChangeRecoveryCoverageRateMin: 0,
      cliRecoveryCoverageRateMin: 0,
      handoffNextStepsCoverageRateMin: 0,
      handoffRecommendationCoverageRateMin: 0,
      doctorOnboardingCoverageRateMin: 0,
      targetHandoffCoverageRateMin: 0,
      reportLatestActionCoverageRateMin: 0,
      reportTimelineWindowCoverageRateMin: 0,
      reportArtifactCoverageRateMin: 0,
      perceptionSignalCoverageRateMin: 0,
      sinceActionEvidenceCoverageRateMin: 0,
      differentiatorSuccessRateMin: 0,
      differentiatorHandoffCoverageRateMin: 0,
      staleRefRecoveryRateMin: 0,
    });

    expect(summary.metrics.maxStepDurationMs).toBe(5047);
    expect(summary.metrics.slowestStep).toEqual(expect.objectContaining({ name: 'stability-wait' }));
    expect(summary.metrics.maxResponsiveStepDurationMs).toBe(120);
    expect(summary.metrics.slowestResponsiveStep).toEqual(expect.objectContaining({ name: 'click' }));
    expect(gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'max-step-duration',
        passed: true,
        actual: 120,
        limit: 150,
        culprit: expect.objectContaining({ name: 'click' }),
      }),
    ]));
  });

  it('marks failed runs with the failed step and keeps partial metrics', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt: 0,
      endedAt: 50,
      steps: [
        { name: 'doctor', command: ['doctor'], startedAt: 0, endedAt: 10, status: 0, stdout: 'Wizard:', stderr: '' },
        { name: 'perceive', command: ['perceive', 'AABB'], startedAt: 10, endedAt: 50, status: 1, stdout: '', stderr: 'Error: target crashed' },
      ],
    });

    expect(summary.success).toBe(false);
    expect(summary.failedStep).toBe('perceive');
    expect(summary.metrics.commandCalls).toBe(2);
    expect(summary.metrics.firstUsefulObservationMs).toBeNull();
    expect(summary.metrics.firstActionEvidenceMs).toBeNull();
    expect(summary.metrics.goldenPathMs).toBeNull();
    expect(summary.metrics.actionEvidenceCoverage).toMatchObject({
      total: 0,
      covered: 0,
      missing: [],
      rate: null,
    });
    expect(summary.gate.passed).toBe(false);
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'first-useful-observation',
        passed: false,
        actual: null,
        recommendation: 'Get the first useful page observation from doctor/list/open/perceive within the onboarding budget.',
      }),
      expect.objectContaining({
        name: 'report-timeline',
        passed: false,
        actual: false,
        recommendation: 'Run cdp report <target> after action evidence so the session can be handed off.',
      }),
      expect.objectContaining({
        name: 'golden-path-under-two-minutes',
        passed: false,
        actual: null,
        recommendation: 'Complete doctor/list/perceive/action/report within the two-minute first-success budget.',
      }),
      expect.objectContaining({
        name: 'session-stability-sample',
        passed: false,
        actual: false,
        recommendation: 'Run the stability wait/status/report probe, or use --stability-ms for a longer dogfood window.',
      }),
    ]));
  });

  it('formats a compact text report for README and dogfood logs', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt: 0,
      endedAt: 100,
      target: 'AABBCCDD',
      steps: [
        { name: 'doctor', command: ['doctor'], startedAt: 0, endedAt: 10, status: 0, stdout: 'Wizard:', stderr: '' },
        { name: 'perceive', command: ['perceive', 'AABB'], startedAt: 10, endedAt: 30, status: 0, stdout: 'Page:\n@1 Button', stderr: '' },
        { name: 'overlay', command: ['overlay', 'AABB'], startedAt: 30, endedAt: 40, status: 0, stdout: 'Overlay detector: clear', stderr: '' },
        { name: 'frame', command: ['frame', 'AABB'], startedAt: 40, endedAt: 50, status: 0, stdout: 'Frames:\n@f2 smoke-child', stderr: '' },
        { name: 'cascade', command: ['cascade', 'AABB', '#go', 'color'], startedAt: 50, endedAt: 60, status: 0, stdout: 'color:\n  WIN red ← #go\n    → inline:1', stderr: '' },
        { name: 'hmr-diff', command: ['perceive', 'AABB', '--diff', '-s', '#combat-log', '--last', '20'], startedAt: 60, endedAt: 72, status: 0, stdout: '~~~ Text nodes updated (1 added)\n+   [StaticText] hmr panel ready', stderr: '' },
        { name: 'guarded-page', command: ['perceive', 'AABB', '-s', '#auth-panel', '-d', '4'], startedAt: 72, endedAt: 80, status: 0, stdout: '[region] Authenticated dashboard\n[StaticText] auth state preserved\n@7 [button] Refresh account', stderr: '' },
        { name: 'click', command: ['click', 'AABB', '#go'], startedAt: 30, endedAt: 60, status: 0, stdout: 'Clicked\nclick: dispatched', stderr: '' },
        {
          name: 'since-action',
          command: ['perceive', 'AABB', '--since-action', '--format', 'json'],
          startedAt: 60,
          endedAt: 72,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.perceive-diff.v1',
            mode: 'since-action',
            summary: { changed: true, removed: 0, added: 1, textRemoved: 0, textAdded: 0 },
            removed: [],
            added: ['[button] Started'],
            removedOmitted: 0,
            addedOmitted: 0,
            textRemovedSamples: [],
            textAddedSamples: [],
            recommendation: {
              source: 'perceive-diff',
              mode: 'since-action',
              commands: ['cdp report AABB --format json'],
            },
            nextSteps: ['cdp report AABB --format json'],
          }),
          stderr: '',
        },
        { name: 'stale-ref', command: ['click', 'AABB', '@1'], startedAt: 72, endedAt: 80, status: 1, expectedFailure: true, stdout: '', stderr: 'Action failure: stale-ref\nNext: cdp perceive AABB -C -d 8' },
        { name: 'report', command: ['report', 'AABB'], startedAt: 80, endedAt: 100, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
        { name: 'stability-wait', command: ['wait', 'AABB', '1000'], startedAt: 100, endedAt: 110, status: 0, stdout: 'waited 1000ms', stderr: '' },
        { name: 'stability-status', command: ['status', 'AABB'], startedAt: 110, endedAt: 125, status: 0, stdout: 'Status: ready', stderr: '' },
        { name: 'stability-report', command: ['report', 'AABB'], startedAt: 125, endedAt: 140, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
      ],
    });

    const out = formatBenchmarkReport(summary);

    expect(out).toContain('chrome-cdp-ex benchmark: killer-path');
    expect(out).toContain('Success: yes');
    expect(out).toContain('Command calls: 14');
    expect(out).toContain('First action evidence: 60 ms');
    expect(out).toContain('Golden path complete: 100 ms');
    expect(out).toContain('Estimated output tokens:');
    expect(out).toContain('Action evidence coverage: 100% (2/2)');
    expect(out).toContain('Action evidence completeness: n/a (0/0)');
    expect(out).toContain('Action failure diagnosis coverage: n/a (0/0)');
    expect(out).toContain('Action no-change recovery coverage: n/a (0/0)');
    expect(out).toContain('Handoff nextSteps coverage: 100% (1/1)');
    expect(out).toContain('Handoff recommendation coverage: 100% (1/1)');
    expect(out).toContain('Doctor onboarding coverage: n/a (0/0)');
    expect(out).toContain('Target handoff coverage: n/a (0/0)');
    expect(out).toContain('Report latestAction coverage: n/a (0/0)');
    expect(out).toContain('Report timelineWindow coverage: n/a (0/0)');
    expect(out).toContain('Report artifact coverage: n/a (0/0)');
    expect(out).toContain('Perception signal coverage: n/a (0/0)');
    expect(out).toContain('Since-action evidence coverage: 100% (1/1)');
    expect(out).toContain('CLI recovery coverage: 100% (1/1)');
    expect(out).toContain('Quality gate: pass');
    expect(out).toContain('Gate checks: 29/29 pass');
    expect(out).toContain('Differentiator success rate: 100%');
    expect(out).toContain('Session stability: yes (40 ms, 3 probes)');
    expect(out).toContain('Comparison baselines:');
    expect(out).toContain('Playwright test generator/snapshot: saves 12 calls');
    expect(out).toContain('Generic CDP script: saves 16 calls');
    expect(out).toContain('heuristic-smoke-baseline');
    expect(out).toContain('CSS trace: yes');
    expect(out).toContain('Frame refs: yes');
    expect(out).toContain('HMR/SPA diff: yes');
    expect(out).toContain('Modal/overlay: yes');
    expect(out).toContain('Guarded page: yes');
    expect(out).toContain('Stale-ref recovery: yes');
    expect(out).toContain('Verification calls saved: 1');
    expect(out).toContain('doctor');
    expect(out).toContain('report');
  });

  it('fails the gate when an observed mutating command lacks action evidence', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'action-evidence-coverage',
      startedAt: 0,
      endedAt: 60,
      target: 'AABBCCDD',
      steps: [
        { name: 'perceive', command: ['perceive', 'AABB'], startedAt: 0, endedAt: 10, status: 0, stdout: 'Page:\n@1 Textbox', stderr: '' },
        { name: 'click', command: ['click', 'AABB', '#go'], startedAt: 10, endedAt: 20, status: 0, stdout: 'Clicked\nclick: dispatched', stderr: '' },
        { name: 'fill', command: ['fill', 'AABB', '#cmd', 'look'], startedAt: 20, endedAt: 30, status: 0, stdout: 'Filled #cmd', stderr: '' },
        { name: 'inject', command: ['inject', 'AABB', '--css', 'body{}'], startedAt: 30, endedAt: 40, status: 0, stdout: 'inject: dispatched\nEffects:\nstate changed', stderr: '' },
        { name: 'reload', command: ['reload', 'AABB'], startedAt: 40, endedAt: 50, status: 0, stdout: 'reload: dispatched\nPage: Test', stderr: '' },
        { name: 'nav', command: ['nav', 'AABB', 'https://example.test'], startedAt: 50, endedAt: 60, status: 0, stdout: 'nav: dispatched\nPage: Test', stderr: '' },
      ],
    });

    expect(summary.metrics.actionEvidenceCoverage).toMatchObject({
      total: 5,
      covered: 4,
      rate: 0.8,
      byCommand: {
        click: { total: 1, covered: 1, missing: 0 },
        fill: { total: 1, covered: 0, missing: 1 },
        inject: { total: 1, covered: 1, missing: 0 },
        reload: { total: 1, covered: 1, missing: 0 },
        nav: { total: 1, covered: 1, missing: 0 },
      },
    });
    expect(summary.metrics.actionEvidenceCoverage.missing).toEqual([
      expect.objectContaining({ command: 'fill', commandText: 'cdp fill AABB #cmd look' }),
    ]);
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'observed-action-evidence-coverage',
        passed: false,
        actual: 0.8,
        recommendation: 'Every mutating command exercised by the benchmark must return action evidence.',
      }),
    ]));
  });

  it('fails the gate when differentiator JSON handoffs are incomplete', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'differentiator-handoff',
      startedAt: 0,
      endedAt: 20,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'overlay-json',
          command: ['overlay', 'AABBCCDD', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          benchmarkProbe: true,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.overlays.v1',
            overlayCount: 1,
            blocking: true,
            overlays: [],
          }),
          stderr: '',
        },
        {
          name: 'frame-json',
          command: ['frame', 'AABBCCDD', '--format', 'json'],
          startedAt: 10,
          endedAt: 20,
          status: 0,
          benchmarkProbe: true,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.frames.v1',
            frameCount: 1,
            frames: [{ id: 'main', depth: 0, url: 'http://example.test/' }],
          }),
          stderr: '',
        },
        {
          name: 'cascade-json',
          command: ['cascade', 'AABBCCDD', '#go', 'color', '--format', 'json'],
          startedAt: 20,
          endedAt: 30,
          status: 0,
          benchmarkProbe: true,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.cascade.v1',
            input: { selector: '#go', property: 'color' },
            propertyCount: 1,
            properties: [{ name: 'color', computedValue: 'red', rules: [] }],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.differentiatorHandoffCoverage).toMatchObject({
      total: 3,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'overlay-json',
          schema: 'chrome-cdp-ex.overlays.v1',
          missing: expect.arrayContaining(['viewport', 'overlays.blocking', 'nextCommand']),
        }),
        expect.objectContaining({
          name: 'frame-json',
          schema: 'chrome-cdp-ex.frames.v1',
          missing: expect.arrayContaining(['frames.ref']),
        }),
        expect.objectContaining({
          name: 'cascade-json',
          schema: 'chrome-cdp-ex.cascade.v1',
          missing: expect.arrayContaining(['properties.winner.source', 'editTarget.source']),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'differentiator-handoff-coverage',
        passed: false,
        actual: 0,
        recommendation: 'Keep overlay, frame, and cascade JSON probes agent-readable before making differentiation claims.',
      }),
    ]));
  });

  it('fails the gate when a failed step lacks an executable recovery command', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'cli-recovery-coverage',
      startedAt: 0,
      endedAt: 20,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'click',
          command: ['click', 'AABBCCDD', '@404'],
          startedAt: 0,
          endedAt: 20,
          status: 1,
          stdout: '',
          stderr: 'Error: Unknown ref @404',
        },
      ],
    });

    expect(summary.metrics.cliRecoveryCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'click',
          commandText: 'cdp click AABBCCDD @404',
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'cli-recovery-coverage',
        passed: false,
        actual: 0,
        recommendation: 'Every failed benchmark step must expose an executable recovery command through Next:, Run:, or JSON nextSteps.',
      }),
    ]));
  });

  it('fails the gate when a versioned JSON handoff lacks executable next steps', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'handoff-next-steps',
      startedAt: 0,
      endedAt: 40,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'doctor',
          command: ['doctor', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.doctor.v1',
            nextSteps: ['cdp list'],
          }),
          stderr: '',
        },
        {
          name: 'perceive',
          command: ['perceive', 'AABBCCDD', '--format', 'json'],
          startedAt: 10,
          endedAt: 20,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.perceive.v1',
            recommendation: {
              commands: ['cdp click AABBCCDD @1'],
            },
          }),
          stderr: '',
        },
        {
          name: 'click',
          command: ['click', 'AABBCCDD', '@1', '--format', 'json'],
          startedAt: 20,
          endedAt: 30,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.action.v1',
            dispatch: { ok: true },
            outcome: { status: 'changed' },
            nextSteps: ['cdp report AABBCCDD --format json'],
          }),
          stderr: '',
        },
        {
          name: 'report',
          command: ['report', 'AABBCCDD', '--format', 'json'],
          startedAt: 30,
          endedAt: 40,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.report.v1',
            actions: [{ index: 1 }],
            nextSteps: ['cdp record-actions AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.handoffNextStepsCoverage).toMatchObject({
      total: 4,
      covered: 3,
      rate: 0.75,
      missing: [
        expect.objectContaining({
          name: 'perceive',
          schema: 'chrome-cdp-ex.perceive.v1',
          commandText: 'cdp perceive AABBCCDD --format json',
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'handoff-next-steps-coverage',
        passed: false,
        actual: 0.75,
        recommendation: 'Every versioned JSON handoff in the Killer Path must expose executable top-level nextSteps.',
      }),
    ]));
  });

  it('treats versioned JSON action and report handoffs as benchmark evidence', () => {
    const perceiveJson = JSON.stringify({
      schema: 'chrome-cdp-ex.perceive.v1',
      targetPrefix: 'AABBCCDD',
      page: { title: 'Smoke', url: 'https://example.test' },
      viewport: { width: 1280, height: 720, coordinateSpace: 'viewport-css-px' },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      refs: { generation: 1, validity: 'until-navigation-or-dom-rewrite' },
      nodes: [{ ref: '@1', role: 'button', name: 'Start' }],
      limits: { depth: 8, last: 20 },
      recommendation: {
        source: 'perceive',
        commands: ['cdp click AABBCCDD @1 --format json'],
      },
      nextSteps: ['cdp click AABBCCDD @1 --format json'],
    });
    const actionJson = JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      action: 'click',
      target: { targetId: 'AABBCCDD', input: '@1', resolvedBy: 'ref', label: 'Start' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 120 },
      effects: {
        domDiff: '+++ Added (1):\n+   [status] Started',
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
      outcome: { status: 'changed' },
      verdict: { status: 'continue', canContinue: true, needsRecovery: false },
      recommendation: {
        source: 'action',
        commands: ['cdp report AABBCCDD --format json'],
      },
      receipt: sampleActionReceipt(),
      nextSteps: ['cdp report AABBCCDD --format json'],
    });
    const sinceActionJson = JSON.stringify({
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode: 'since-action',
      summary: { changed: true, removed: 0, added: 1, textRemoved: 0, textAdded: 0 },
      removed: [],
      added: ['[status] Started'],
      removedOmitted: 0,
      addedOmitted: 0,
      textRemovedSamples: [],
      textAddedSamples: [],
      recommendation: {
        source: 'perceive-diff',
        mode: 'since-action',
        commands: ['cdp report AABBCCDD --format json'],
      },
      nextSteps: ['cdp report AABBCCDD --format json'],
    });
    const summary = summarizeBenchmarkRun({
      scenario: 'json-handoff-killer-path',
      startedAt: 0,
      endedAt: 60,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'doctor',
          command: ['doctor', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.doctor.v1',
            wizard: {
              currentStep: 'cdp perceive AABBCCDD -C -d 8',
              goldenPath: ['doctor', 'list/open', 'perceive', 'click/fill', 'since-action evidence', 'report'],
            },
            checks: [
              { label: 'Node', status: 'OK' },
              { label: 'FD limit', status: 'OK' },
              { label: 'CDP', status: 'OK' },
              { label: 'Tabs', status: 'OK' },
              { label: 'Permission', status: 'WARN' },
            ],
            recommendation: {
              source: 'doctor',
              commands: ['cdp list --format json'],
            },
            nextSteps: ['cdp list --format json'],
          }),
          stderr: '',
        },
        {
          name: 'open',
          command: ['open', 'https://example.test', '--format', 'json'],
          startedAt: 10,
          endedAt: 15,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.open.v1',
            targetId: 'AABBCCDDEEFF',
            targetPrefix: 'AABBCCDD',
            url: 'https://example.test',
            attached: true,
            approval: 'approved',
            navigation: { ok: true, url: 'https://example.test' },
            ready: { attempted: true, ok: true, readyState: 'complete', selector: '#app', selectorFound: true },
            autoPerceive: { attempted: false, ok: false, reason: 'not-run' },
            recommendation: {
              source: 'golden-path',
              run: 'cdp perceive AABBCCDD -C -d 8',
              commands: ['cdp perceive AABBCCDD -C -d 8'],
            },
            nextSteps: ['cdp perceive AABBCCDD -C -d 8'],
          }),
          stderr: '',
        },
        {
          name: 'list',
          command: ['list', '--format', 'json'],
          startedAt: 15,
          endedAt: 20,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.list.v1',
            targetCount: 1,
            prefixLength: 8,
            browser: { name: 'Chrome', port: 9222 },
            pages: [{
              index: 1,
              targetId: 'AABBCCDDEEFF',
              targetPrefix: 'AABBCCDD',
              type: 'page',
              title: 'Example',
              url: 'https://example.test',
              isBlank: false,
            }],
            recommendation: {
              source: 'golden-path',
              run: 'cdp perceive AABBCCDD -C -d 8',
              commands: ['cdp perceive AABBCCDD -C -d 8'],
            },
            nextSteps: ['cdp perceive AABBCCDD -C -d 8'],
          }),
          stderr: '',
        },
        {
          name: 'perceive',
          command: ['perceive', 'AABBCCDD', '-C', '-d', '8', '--format', 'json'],
          startedAt: 20,
          endedAt: 30,
          status: 0,
          stdout: perceiveJson,
          stderr: '',
        },
        {
          name: 'click',
          command: ['click', 'AABBCCDD', '@1', '--format', 'json'],
          startedAt: 30,
          endedAt: 45,
          status: 0,
          stdout: actionJson,
          stderr: '',
        },
        {
          name: 'since-action',
          command: ['perceive', 'AABBCCDD', '--since-action', '--format', 'json'],
          startedAt: 45,
          endedAt: 55,
          status: 0,
          stdout: sinceActionJson,
          stderr: '',
        },
        {
          name: 'report',
          command: ['report', 'AABBCCDD', '--format', 'json'],
          startedAt: 55,
          endedAt: 65,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.report.v1',
            paths: {
              log: '/tmp/cdp-AABBCCDD.log',
              screenshotDir: '/tmp/cdp-AABBCCDD-screenshots',
            },
            counts: { actions: 1, screenshots: 0, records: 0 },
            timelineWindow: { total: 1, shown: 1, omitted: 0, startIndex: 1, endIndex: 1, limit: 20 },
            environment: {
              networkThrottleSummary: 'off',
              networkMocksSummary: 'none',
              clockSummary: 'realtime',
              controls: [],
            },
            actions: [{
              index: 1,
              action: 'click',
              evidence: { effectSummary: '+++ Added (1)' },
              outcome: { status: 'changed' },
              verdict: { status: 'continue' },
            }],
            screenshots: [],
            latestAction: {
              index: 1,
              action: 'click',
              status: 'ok',
              outcomeStatus: 'changed',
              verdictStatus: 'continue',
              canContinue: true,
            },
            recommendation: {
              source: 'session-continuation',
              commands: ['cdp record-actions AABBCCDD --format json'],
            },
            nextSteps: ['cdp record-actions AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.firstUsefulObservationMs).toBe(30);
    expect(summary.metrics.firstActionEvidenceMs).toBe(45);
    expect(summary.metrics.goldenPathMs).toBe(65);
    expect(summary.metrics.hasReportTimeline).toBe(true);
    expect(summary.metrics.reportLatestActionCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.reportTimelineWindowCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.reportArtifactCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.usefulObservationTokens).toBe(
      estimateTokenCount(perceiveJson.length) + estimateTokenCount(sinceActionJson.length),
    );
    expect(summary.metrics.actionEvidenceCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.actionEvidenceCompletenessCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.handoffNextStepsCoverage).toMatchObject({
      total: 7,
      covered: 7,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.handoffRecommendationCoverage).toMatchObject({
      total: 7,
      covered: 7,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.doctorOnboardingCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.perceptionSignalCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.sinceActionEvidenceCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.targetHandoffCoverage).toMatchObject({
      total: 2,
      covered: 2,
      missing: [],
      rate: 1,
    });
    expect(summary.steps[4].hasActionEvidence).toBe(true);
  });

  it('fails the gate when target handoff JSON cannot lead to perceive', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'target-handoff',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'open',
          command: ['open', 'https://example.test', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.open.v1',
            url: 'https://example.test',
            attached: true,
            approval: 'approved',
            navigation: { ok: false },
            ready: { attempted: true, ok: false },
            recommendation: { source: 'golden-path' },
            nextSteps: ['cdp report AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.targetHandoffCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'open',
          schema: 'chrome-cdp-ex.open.v1',
          commandText: 'cdp open https://example.test --format json',
          missing: expect.arrayContaining([
            'targetPrefix',
            'navigation.ok',
            'ready.ok',
            'recommendation.run',
            'nextSteps.perceive',
          ]),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'target-handoff-coverage',
        passed: false,
        actual: 0,
        recommendation: 'List/open JSON must expose a concrete target prefix and an executable perceive next step so first-run agents can continue the golden path.',
      }),
    ]));
  });

  it('keeps branch-coverage probes out of the core command budget', () => {
    const openHandoff = {
      schema: 'chrome-cdp-ex.open.v1',
      targetId: 'AABBCCDDEEFF',
      targetPrefix: 'AABBCCDD',
      url: 'https://example.test',
      attached: true,
      approval: 'approved',
      navigation: { ok: true },
      ready: { ok: true },
      recommendation: {
        source: 'golden-path',
        run: 'cdp perceive AABBCCDD -C -d 8',
        commands: ['cdp perceive AABBCCDD -C -d 8'],
      },
      nextSteps: ['cdp perceive AABBCCDD -C -d 8'],
    };
    const listHandoff = {
      schema: 'chrome-cdp-ex.list.v1',
      targetCount: 1,
      prefixLength: 8,
      pages: [{
        index: 1,
        targetId: 'AABBCCDDEEFF',
        targetPrefix: 'AABBCCDD',
        type: 'page',
        title: 'Example',
        url: 'https://example.test',
        isBlank: false,
      }],
      recommendation: openHandoff.recommendation,
      nextSteps: openHandoff.nextSteps,
    };
    const summary = summarizeBenchmarkRun({
      scenario: 'entry-probe',
      startedAt: 0,
      endedAt: 40,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'open',
          command: ['open', 'https://example.test', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify(openHandoff),
          stderr: '',
        },
        {
          name: 'list',
          command: ['list', '--format', 'json'],
          startedAt: 10,
          endedAt: 15,
          status: 0,
          benchmarkProbe: true,
          stdout: JSON.stringify(listHandoff),
          stderr: '',
        },
        {
          name: 'perceive',
          command: ['perceive', 'AABBCCDD', '-C', '-d', '8', '--format', 'json'],
          startedAt: 15,
          endedAt: 25,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.perceive.v1',
            targetPrefix: 'AABBCCDD',
            page: { title: 'Example', url: 'https://example.test' },
            viewport: { width: 1280, height: 720 },
            console: { errors: 0, warnings: 0, recent: [] },
            refs: [{ ref: '@1', role: 'button', text: 'Go' }],
            nodes: [{ ref: '@1', role: 'button', name: 'Go', bounds: { x: 1, y: 1, width: 40, height: 20 } }],
            limits: { depth: 8, truncated: false },
            recommendation: {
              source: 'perceive',
              commands: ['cdp click AABBCCDD @1 --format json'],
            },
            nextSteps: ['cdp click AABBCCDD @1 --format json'],
          }),
          stderr: '',
        },
        {
          name: 'report',
          command: ['report', 'AABBCCDD', '--format', 'json'],
          startedAt: 25,
          endedAt: 40,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.report.v1',
            paths: { log: '/tmp/log.jsonl', screenshotDir: '/tmp/screens' },
            counts: { actions: 0, screenshots: 0, records: 0 },
            timelineWindow: { total: 0, shown: 0, omitted: 0, startIndex: 0, endIndex: 0, limit: 20 },
            environment: { networkThrottleSummary: 'off', networkMocksSummary: 'none', clockSummary: 'realtime', controls: [] },
            actions: [],
            screenshots: [],
            recommendation: { source: 'session-continuation', commands: ['cdp perceive AABBCCDD -C -d 8'] },
            nextSteps: ['cdp perceive AABBCCDD -C -d 8'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.commandCalls).toBe(3);
    expect(summary.metrics.targetHandoffCoverage).toMatchObject({
      total: 2,
      covered: 2,
      rate: 1,
    });
    expect(summary.steps.find(step => step.name === 'list')).toMatchObject({
      benchmarkProbe: true,
    });
  });

  it('fails the gate when perceive JSON lacks agent perception signals', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'perception-signal',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'perceive',
          command: ['perceive', 'AABBCCDD', '-C', '-d', '8', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.perceive.v1',
            nodes: [],
            recommendation: {
              source: 'perceive',
              commands: ['cdp report AABBCCDD --format json'],
            },
            nextSteps: ['cdp report AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.perceptionSignalCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'perceive',
          commandText: 'cdp perceive AABBCCDD -C -d 8 --format json',
          missing: expect.arrayContaining([
            'targetPrefix',
            'page',
            'viewport',
            'viewport.coordinateSpace',
            'console',
            'refs',
            'refs.validity',
            'nodes.ref',
            'limits',
          ]),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'perception-signal-coverage',
        passed: false,
        actual: 0,
        recommendation: 'Perceive JSON must expose page, viewport, console, refs, interactive nodes, limits, recommendation, and nextSteps so agents can choose an action without another page read.',
      }),
    ]));
  });

  it('fails the gate when since-action JSON lacks causal diff evidence', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'since-action-evidence',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'since-action',
          command: ['perceive', 'AABBCCDD', '--since-action', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.perceive-diff.v1',
            mode: 'since-action',
            summary: { changed: true },
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.sinceActionEvidenceCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'since-action',
          commandText: 'cdp perceive AABBCCDD --since-action --format json',
          missing: expect.arrayContaining([
            'summary.removed',
            'summary.added',
            'summary.textRemoved',
            'summary.textAdded',
            'evidence',
            'recommendation',
            'nextSteps',
          ]),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'since-action-evidence-coverage',
        passed: false,
        actual: 0,
        recommendation: 'Since-action JSON must expose a causal diff summary, bounded evidence samples, recommendation, and nextSteps so agents know what changed after the action.',
      }),
    ]));
  });

  it('fails the gate when action JSON lacks structured evidence for agent decisions', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'action-evidence-completeness',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'click',
          command: ['click', 'AABBCCDD', '@1', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.action.v1',
            dispatch: { ok: true },
            outcome: { status: 'changed' },
            recommendation: {
              source: 'action',
              commands: ['cdp report AABBCCDD --format json'],
            },
            nextSteps: ['cdp report AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.actionEvidenceCompletenessCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'click',
          commandText: 'cdp click AABBCCDD @1 --format json',
          missing: expect.arrayContaining([
            'action',
            'target',
            'dispatch.method',
            'settle.ok',
            'settle.durationMs',
            'effects.evidence',
            'effects.consoleDelta',
            'effects.exceptionDelta',
            'effects.networkDelta',
            'verdict.status',
            'receipt',
            'receipt.eventId',
            'receipt.dispatch',
            'receipt.settlement',
            'receipt.settlement.state',
            'receipt.settlement.strategy',
            'receipt.settlement.durationMs',
            'receipt.settlement.signals',
            'receipt.observedDelta',
            'receipt.observedDeltaDetails',
            'receipt.blockingSignals',
            'receipt.recoveryHint',
            'receipt.nextSteps',
          ]),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'action-evidence-completeness',
        passed: false,
        actual: 0,
        recommendation: 'Action JSON evidence must include the Action Receipt contract: event id, dispatch, settlement semantics, observed delta details, blocking signals, recovery hint, and next steps.',
      }),
    ]));
  });

  it('fails the gate when action receipts omit settlement semantics', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'action-settlement-semantics',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'click',
          command: ['click', 'AABBCCDD', '@1', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.action.v1',
            action: 'click',
            target: { targetId: 'AABBCCDD', input: '@1', resolvedBy: 'ref', label: 'Start' },
            dispatch: { ok: true, method: 'click' },
            settle: { ok: true, durationMs: 120 },
            effects: {
              domDiff: '+++ Added\n+   [status] Done',
              consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
              exceptionDelta: { count: 0, entries: [] },
              networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
            },
            outcome: { status: 'changed' },
            verdict: { status: 'continue', canContinue: true, needsRecovery: false },
            recommendation: {
              source: 'action-evidence',
              commands: ['cdp report AABBCCDD --format json'],
            },
            receipt: sampleActionReceipt({
              settlement: { ok: true, durationMs: 120 },
            }),
            nextSteps: ['cdp report AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.actionEvidenceCompletenessCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'click',
          commandText: 'cdp click AABBCCDD @1 --format json',
          missing: expect.arrayContaining([
            'receipt.settlement.state',
            'receipt.settlement.strategy',
            'receipt.settlement.signals',
          ]),
        }),
      ],
    });
  });

  it('covers failed action JSON diagnosis handoffs', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'action-failure-diagnosis',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'stale-ref-json',
          command: ['click', 'AABBCCDD', '@1', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          benchmarkProbe: true,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.action.v1',
            action: 'click',
            target: { targetId: 'AABBCCDD', input: '@1', resolvedBy: 'ref', label: '@1' },
            dispatch: { ok: false, method: 'click', error: 'Unknown ref @1' },
            settle: { ok: false, durationMs: 10 },
            effects: {
              domDiff: null,
              failure: {
                kind: 'stale-ref',
                nextCommand: 'cdp perceive AABBCCDD -C -d 8',
              },
              diagnosis: {
                schema: 'chrome-cdp-ex.action-diagnosis.v1',
                status: 'blocked',
                kind: 'stale-ref',
                source: 'dispatch',
                nextCommand: 'cdp perceive AABBCCDD -C -d 8',
                recovery: {
                  schema: 'chrome-cdp-ex.recovery-policy.v1',
                  strategy: 'refresh-perception',
                  priority: 'high',
                  commands: [
                    { command: 'cdp perceive AABBCCDD -C -d 8' },
                    { command: 'cdp status AABBCCDD' },
                    { command: 'cdp report AABBCCDD --format json' },
                  ],
                  verifyCommand: 'cdp perceive AABBCCDD -C -d 8',
                  avoid: ['retrying the stale @ref before refreshing perception'],
                },
              },
              consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
              exceptionDelta: { count: 0, entries: [] },
              networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
            },
            outcome: { status: 'failed', reason: 'Unknown ref @1' },
            verdict: {
              status: 'blocked',
              source: 'diagnosis',
              confidence: 'high',
              canContinue: false,
              needsRecovery: true,
              primaryNextStep: 'cdp perceive AABBCCDD -C -d 8',
              nextSteps: ['cdp perceive AABBCCDD -C -d 8', 'cdp status AABBCCDD'],
            },
            recommendation: {
              source: 'action-diagnosis',
              diagnosisKind: 'stale-ref',
              commands: ['cdp perceive AABBCCDD -C -d 8', 'cdp status AABBCCDD'],
            },
            receipt: sampleActionReceipt({
              dispatch: { ok: false, method: 'click', error: 'Unknown ref @1' },
              settlement: { ok: false, strategy: 'dispatch-failure', durationMs: 10 },
              outcome: 'failed',
              observedDelta: ['Dispatch failed: stale-ref'],
              blockingSignals: ['stale-ref'],
              recoveryHint: 'Unknown ref @1',
              nextSteps: ['cdp perceive AABBCCDD -C -d 8', 'cdp status AABBCCDD'],
              recovery: {
                strategy: 'refresh-perception',
                priority: 'high',
                verifyCommand: 'cdp perceive AABBCCDD -C -d 8',
              },
            }),
            nextSteps: ['cdp perceive AABBCCDD -C -d 8', 'cdp status AABBCCDD'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.actionFailureDiagnosisCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'action-failure-diagnosis',
        passed: true,
        actual: 1,
      }),
    ]));
  });

  it('fails the gate when failed action JSON lacks diagnosis recovery', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'action-failure-diagnosis',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'stale-ref-json',
          command: ['click', 'AABBCCDD', '@1', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          benchmarkProbe: true,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.action.v1',
            action: 'click',
            target: { targetId: 'AABBCCDD', input: '@1', resolvedBy: 'ref', label: '@1' },
            dispatch: { ok: false, method: 'click', error: 'Unknown ref @1' },
            settle: { ok: false, durationMs: 10 },
            effects: {
              domDiff: null,
              failure: { kind: 'stale-ref' },
              consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
              exceptionDelta: { count: 0, entries: [] },
              networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
            },
            outcome: { status: 'failed' },
            verdict: { status: 'blocked', canContinue: false, needsRecovery: true },
            recommendation: { source: 'action' },
            nextSteps: [],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.actionFailureDiagnosisCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'stale-ref-json',
          commandText: 'cdp click AABBCCDD @1 --format json',
          missing: expect.arrayContaining([
            'effects.diagnosis',
            'effects.diagnosis.recovery.commands',
            'verdict.primaryNextStep',
            'recommendation',
            'nextSteps',
          ]),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'action-failure-diagnosis',
        passed: false,
        actual: 0,
        recommendation: 'Failed action JSON must classify the failure and expose diagnosis recovery commands so agents can recover without parsing text.',
      }),
    ]));
  });

  it('fails the gate when no-change action JSON looks like normal success', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'action-no-change-recovery',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'no-change-json',
          command: ['click', 'AABBCCDD', '#noop', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          benchmarkProbe: true,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.action.v1',
            action: 'click',
            target: { targetId: 'AABBCCDD', input: '#noop', resolvedBy: 'selector', label: '#noop' },
            dispatch: { ok: true, method: 'click' },
            settle: { ok: true, durationMs: 10 },
            effects: {
              domDiff: '(no changes detected in AX tree)',
              consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
              exceptionDelta: { count: 0, entries: [] },
              networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
            },
            outcome: { status: 'no-change', changed: false, needsAttention: true },
            verdict: { status: 'continue', canContinue: true, needsRecovery: false },
            recommendation: {
              source: 'action-evidence',
              strategy: 'continue-from-evidence',
              commands: ['cdp report AABBCCDD --format json'],
            },
            nextSteps: ['cdp report AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.actionNoChangeRecoveryCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'no-change-json',
          commandText: 'cdp click AABBCCDD #noop --format json',
          missing: expect.arrayContaining([
            'verdict.status',
            'verdict.canContinue',
            'verdict.needsRecovery',
            'verdict.primaryNextStep',
            'recommendation.strategy',
            'nextSteps.perceive',
            'receipt.blockingSignals',
            'receipt.recoveryHint',
          ]),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'action-no-change-recovery',
        passed: false,
        actual: 0,
        recommendation: 'No-change action JSON must route agents to target-aware overlay/frame checks, fresh perceive, and report instead of treating dispatch as success.',
      }),
    ]));
  });

  it('fails the gate when doctor JSON lacks onboarding wizard evidence', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'doctor-onboarding',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'doctor',
          command: ['doctor', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.doctor.v1',
            recommendation: {
              source: 'doctor-onboarding',
              commands: ['cdp list --format json'],
            },
            nextSteps: ['cdp list --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.doctorOnboardingCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'doctor',
          commandText: 'cdp doctor --format json',
          missing: expect.arrayContaining(['wizard.currentStep', 'wizard.goldenPath', 'checks.Node', 'checks.CDP']),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'doctor-onboarding',
        passed: false,
        actual: 0,
        recommendation: 'Doctor JSON must expose wizard currentStep, golden path, and readiness checks for first-run onboarding.',
      }),
    ]));
  });

  it('fails the gate when a versioned JSON handoff lacks a recommendation', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'handoff-recommendation',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'since-action',
          command: ['perceive', 'AABBCCDD', '--since-action', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.perceive-diff.v1',
            mode: 'since-action',
            summary: { changed: true },
            nextSteps: ['cdp report AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.handoffRecommendationCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'since-action',
          schema: 'chrome-cdp-ex.perceive-diff.v1',
          commandText: 'cdp perceive AABBCCDD --since-action --format json',
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'handoff-recommendation-coverage',
        passed: false,
        actual: 0,
        recommendation: 'Every versioned JSON handoff must expose a recommendation that explains the next action.',
      }),
    ]));
  });

  it('fails the gate when a JSON report timeline lacks bounded window metadata', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'report-timeline-window',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'report',
          command: ['report', 'AABBCCDD', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.report.v1',
            actions: [{ index: 1, action: 'click' }],
            latestAction: { index: 1, action: 'click', status: 'ok' },
            nextSteps: ['cdp record-actions AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.reportTimelineWindowCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'report',
          commandText: 'cdp report AABBCCDD --format json',
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'report-timeline-window',
        passed: false,
        actual: 0,
        recommendation: 'JSON report handoffs must expose bounded timelineWindow metadata so long sessions stay token-safe.',
      }),
    ]));
  });

  it('fails the gate when report JSON lacks session artifact handoff fields', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'report-artifacts',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'report',
          command: ['report', 'AABBCCDD', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.report.v1',
            timelineWindow: { total: 1, shown: 1, omitted: 0, startIndex: 1, endIndex: 1, limit: 20 },
            latestAction: { index: 1, action: 'click', status: 'ok' },
            actions: [{ index: 1, action: 'click' }],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.reportArtifactCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'report',
          commandText: 'cdp report AABBCCDD --format json',
          missing: expect.arrayContaining([
            'paths.log',
            'paths.screenshotDir',
            'counts.actions',
            'counts.screenshots',
            'actions.evidence',
            'environment',
            'recommendation',
            'nextSteps',
          ]),
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'report-artifact-coverage',
        passed: false,
        actual: 0,
        recommendation: 'Report JSON must expose session log path, screenshot directory, counts, action evidence, environment, recommendation, and nextSteps so long sessions can be handed off.',
      }),
    ]));
  });

  it('fails the gate when a JSON report timeline lacks latestAction summary', () => {
    const summary = summarizeBenchmarkRun({
      scenario: 'report-latest-action',
      startedAt: 0,
      endedAt: 10,
      target: 'AABBCCDD',
      steps: [
        {
          name: 'report',
          command: ['report', 'AABBCCDD', '--format', 'json'],
          startedAt: 0,
          endedAt: 10,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.report.v1',
            actions: [{ index: 1, action: 'click' }],
            nextSteps: ['cdp record-actions AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.reportLatestActionCoverage).toMatchObject({
      total: 1,
      covered: 0,
      rate: 0,
      missing: [
        expect.objectContaining({
          name: 'report',
          commandText: 'cdp report AABBCCDD --format json',
        }),
      ],
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'report-latest-action',
        passed: false,
        actual: 0,
        recommendation: 'JSON report handoffs with actions must expose latestAction so agents can resume without rescanning the timeline.',
      }),
    ]));
  });

  it('parses JSON mode and stability window options', () => {
    expect(parseBenchmarkArgs(['--json', '--stability-ms', '1200000', '--comparison-baselines', '/tmp/baselines.json'])).toEqual({
      json: true,
      stabilityMs: 1200000,
      comparisonBaselinesPath: '/tmp/baselines.json',
    });
    expect(parseBenchmarkArgs([])).toEqual({
      json: false,
      stabilityMs: 1000,
      comparisonBaselinesPath: null,
    });
  });

  it('summarizes large app stress budgets, truncation metadata, and bounded controls', () => {
    const fixture = buildLargeAppStressFixture();
    const summary = summarizeBenchmarkRun(fixture);

    expect(summary.scenario).toBe('large-app-stress');
    expect(summary.metrics.largeAppStress).toMatchObject({
      enabled: true,
      commandCoverage: { total: 5, covered: 5, rate: 1 },
      outputBudgetCoverage: { total: 5, covered: 5, rate: 1 },
      truncationMetadataCoverage: { total: 5, covered: 5, rate: 1 },
      scale: {
        domNodes: 5200,
        tableRows: 1000,
        visibleControls: 240,
        hiddenTemplateNodes: 1600,
        covered: true,
      },
      visibleControls: {
        total: 240,
        returned: 30,
        limit: 30,
        bounded: true,
      },
      hiddenTemplateOmission: { covered: true },
    });
    expect(summary.gate).toMatchObject({
      profile: 'large-app-stress',
      passed: true,
    });
    expect(summary.gate.criteria.map(criterion => criterion.name)).toEqual(expect.arrayContaining([
      'large-app-command-coverage',
      'large-app-scale-coverage',
      'large-app-output-budget-metadata',
      'large-app-truncation-metadata',
      'large-app-visible-controls-bounded',
      'large-app-hidden-template-omission',
    ]));
    expect(formatBenchmarkReport(summary)).toContain('Large app stress: pass (commands 5/5, budgets 5/5, truncation metadata 5/5)');
  });

  it('keeps the large app perceive step compact enough for live token gates', () => {
    const fixture = buildLargeAppStressFixture();
    const perceive = fixture.steps.find(step => step.name === 'perceive');

    expect(perceive.command).toEqual(['perceive', 'AABBCCDD', '-C', '-d', '3', '--keep-refs', '--last', '5', '--format', 'json']);
  });

  it('fails large app stress gate with command culprit when output is unbounded', () => {
    const fixture = buildLargeAppStressFixture();
    const perceive = fixture.steps.find(step => step.name === 'perceive');
    const controls = fixture.steps.find(step => step.name === 'controls');
    const text = fixture.steps.find(step => step.name === 'text');
    const table = fixture.steps.find(step => step.name === 'table');
    const summaryStep = fixture.steps.find(step => step.name === 'summary');

    perceive.stdout = JSON.stringify({
      schema: 'chrome-cdp-ex.perceive.v1',
      page: { title: 'Large SaaS stress fixture' },
      viewport: { width: 1440, height: 900 },
      console: { errors: 0 },
      refs: { count: 240 },
      interactive: { total: 240 },
      nextSteps: ['cdp controls AABBCCDD --format json'],
      recommendation: { run: 'cdp controls AABBCCDD --format json' },
    });
    controls.stdout = JSON.stringify({
      schema: 'chrome-cdp-ex.visible-controls.v1',
      total: 240,
      returned: 240,
      limit: 240,
      truncated: false,
      controls: [],
    });
    text.stdout = 'Visible text copied from every noisy hidden template node without an output budget.';
    table.stdout = 'name\tstatus\towner\n' + Array.from({ length: 20 }, (_, index) => `row-${index + 1}\topen\tteam`).join('\n');
    summaryStep.stdout = JSON.stringify({
      schema: 'chrome-cdp-ex.summary.v1',
      counts: {
        domNodes: 5200,
        tableRows: 1000,
        visibleControls: 240,
        hiddenTemplateNodes: 1600,
      },
      limits: {
        outputTokenBudget: 1200,
      },
      recommendation: { run: 'cdp controls AABBCCDD --format json' },
      nextSteps: ['cdp controls AABBCCDD --format json'],
    });

    const summary = summarizeBenchmarkRun(fixture);

    expect(summary.gate).toMatchObject({
      profile: 'large-app-stress',
      passed: false,
    });
    expect(summary.metrics.largeAppStress.truncationMetadataCoverage).toMatchObject({
      total: 5,
      covered: 0,
      rate: 0,
    });
    expect(summary.metrics.largeAppStress.hiddenTemplateOmission).toMatchObject({
      covered: false,
      hiddenTemplateNodes: 1600,
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'large-app-truncation-metadata',
        passed: false,
        actual: 0,
        culprit: expect.objectContaining({
          name: 'perceive',
          commandText: 'cdp perceive AABBCCDD -C -d 3 --keep-refs --last 5 --format json',
        }),
      }),
      expect.objectContaining({
        name: 'large-app-visible-controls-bounded',
        passed: false,
        actual: false,
        culprit: expect.objectContaining({
          name: 'controls',
          commandText: 'cdp controls AABBCCDD --limit 30 --format json',
        }),
      }),
      expect.objectContaining({
        name: 'large-app-hidden-template-omission',
        passed: false,
        actual: false,
        culprit: expect.objectContaining({
          reason: 'hidden/template node omission metadata is missing',
        }),
      }),
    ]));
  });

  it('plans core mutating commands with live action evidence coverage', () => {
    const plan = buildKillerPathBenchmarkPlan('AABBCCDD', {
      stabilityMs: 1000,
      navUrl: 'http://127.0.0.1:41738/smoke-page.html',
    });
    const staleRefMutation = plan.find(step => step.name === 'stale-ref-mutate');

    expect(staleRefMutation).toMatchObject({
      name: 'stale-ref-mutate',
      args: ['reload', 'AABBCCDD', '--format', 'json'],
    });
    expect(staleRefMutation.args[0]).not.toBe('eval');
    expect(plan.map(step => step.args[0])).toEqual(expect.arrayContaining([
      'dismiss-modal',
      'fill',
      'click',
      'inject',
      'nav',
      'reload',
      'report',
    ]));
    expect(plan.find(step => step.args[0] === 'fill')?.args).toEqual(['fill', 'AABBCCDD', '#cmd', 'look trainer', '--format', 'json']);
    expect(plan.find(step => step.args[0] === 'dismiss-modal')?.args).toEqual(['dismiss-modal', 'AABBCCDD', '--format', 'json']);
    expect(plan.find(step => step.args[0] === 'inject')?.args).toEqual(['inject', 'AABBCCDD', '--css', '#combat-log { outline: 2px solid rgb(37, 99, 235); }', '--format', 'json']);
    expect(plan.find(step => step.args[0] === 'nav')?.args).toEqual(['nav', 'AABBCCDD', 'http://127.0.0.1:41738/smoke-page.html#after-action-evidence', '--format', 'json']);
    expect(plan.find(step => step.name === 'stale-ref-mutate')?.args).toEqual(['reload', 'AABBCCDD', '--format', 'json']);
    expect(plan.find(step => step.name === 'stale-ref-json')).toMatchObject({
      args: ['click', 'AABBCCDD', '@1', '--format', 'json'],
      benchmarkProbe: true,
    });
    expect(plan.find(step => step.args[0] === 'doctor')?.args).toEqual(['doctor', '--format', 'json']);
    expect(plan.find(step => step.args[0] === 'list')?.args).toEqual(['list', '--format', 'json']);
    expect(plan.find(step => step.args[0] === 'perceive')?.args).toContain('--format');
    expect(plan.find(step => step.args.includes('--since-action'))?.args).toEqual([
      'perceive',
      'AABBCCDD',
      '--since-action',
      '--format',
      'json',
    ]);
    expect(plan.find(step => step.args[0] === 'click')?.args).toContain('--format');
    expect(plan.find(step => step.args[0] === 'report')?.args).toEqual(['report', 'AABBCCDD', '--last', '1', '--format', 'json']);
    expect(plan.find(step => step.name === 'guarded-page')?.args).toEqual(['perceive', 'AABBCCDD', '-s', '#auth-panel', '-d', '4']);
    expect(plan.filter(step => !step.benchmarkProbe).length).toBeLessThanOrEqual(24);
  });

  it('plans live entry handoff probes for both open and list before perception', () => {
    const plan = buildKillerPathEntryPlan('http://127.0.0.1:41738/smoke-page.html');

    expect(plan.map(step => step.args[0])).toEqual(['doctor', 'open', 'list']);
    expect(plan[0]).toEqual({ args: ['doctor', '--format', 'json'] });
    expect(plan[1]).toMatchObject({
      args: [
        'open',
        'http://127.0.0.1:41738/smoke-page.html',
        '--attach-timeout-ms',
        '5000',
        '--ready-timeout-ms',
        '5000',
        '--ready-selector',
        '#custom-clickable',
        '--format',
        'json',
      ],
      timeout: 40000,
    });
    expect(plan[2]).toEqual({
      args: ['list', '--format', 'json'],
      requiresOpenedTarget: true,
      benchmarkProbe: true,
    });
  });

  it('can build the post-open benchmark plan without repeating doctor/list', () => {
    const plan = buildKillerPathBenchmarkPlan('AABBCCDD', {
      stabilityMs: 1000,
      entrySteps: 'none',
      navUrl: 'http://127.0.0.1:41738/smoke-page.html',
    });

    expect(plan[0].args).toEqual(['perceive', 'AABBCCDD', '-C', '-d', '8', '--keep-refs', '--last', '20', '--format', 'json']);
    expect(plan.map(step => step.args[0])).not.toContain('doctor');
    expect(plan.map(step => step.args[0])).not.toContain('list');
    expect(plan.find(step => step.args[0] === 'report')?.args).toEqual(['report', 'AABBCCDD', '--last', '1', '--format', 'json']);
    expect(plan.find(step => step.name === 'guarded-page')?.args).toEqual(['perceive', 'AABBCCDD', '-s', '#auth-panel', '-d', '4']);
    expect(plan.filter(step => !step.benchmarkProbe).length).toBeLessThanOrEqual(22);
  });

  it('loads measured comparison baselines from a versioned file', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-baselines-'));
    const file = resolve(dir, 'baselines.json');
    try {
      writeFileSync(file, JSON.stringify({
        schema: 'chrome-cdp-ex.comparison-baselines.v1',
        source: 'measured-local-baseline',
        note: 'Measured with local Playwright and generic CDP harnesses.',
        baselines: [
          {
            id: 'playwright',
            label: 'Measured Playwright harness',
            metrics: {
              commandCalls: 24,
              usefulObservationTokens: 4200,
              verificationCallsSaved: 0,
              differentiatorSuccessRate: 0.5,
              autoEvidenceActions: 0,
              hasReportTimeline: false,
              staleRefRecoveryRate: 0,
              sessionStabilitySample: false,
            },
          },
        ],
      }));

      const loaded = loadComparisonBaselineFile(file);
      const summary = summarizeBenchmarkRun({
        scenario: 'killer-path',
        startedAt: 0,
        endedAt: 40,
        target: 'AABBCCDD',
        comparisonBaselineSet: loaded,
        steps: [
          { name: 'perceive', command: ['perceive', 'AABB'], startedAt: 0, endedAt: 20, status: 0, stdout: 'Page:\n@1 Button', stderr: '' },
          { name: 'click', command: ['click', 'AABB', '#go'], startedAt: 20, endedAt: 30, status: 0, stdout: 'Clicked\nclick: dispatched', stderr: '' },
          { name: 'report', command: ['report', 'AABB'], startedAt: 30, endedAt: 40, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
          { name: 'stale-ref', command: ['click', 'AABB', '@1'], startedAt: 40, endedAt: 55, status: 1, expectedFailure: true, stdout: '', stderr: 'Action failure: stale-ref\nNext: cdp perceive AABB -C -d 8' },
          { name: 'stability-wait', command: ['wait', 'AABB', '1000'], startedAt: 55, endedAt: 65, status: 0, stdout: 'waited 1000ms', stderr: '' },
          { name: 'stability-status', command: ['status', 'AABB'], startedAt: 65, endedAt: 75, status: 0, stdout: 'Status: ready', stderr: '' },
          { name: 'stability-report', command: ['report', 'AABB'], startedAt: 75, endedAt: 90, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
        ],
      });

      expect(loaded).toMatchObject({
        source: 'measured-local-baseline',
        note: 'Measured with local Playwright and generic CDP harnesses.',
        baselines: [
          expect.objectContaining({ id: 'playwright', label: 'Measured Playwright harness' }),
        ],
      });
      expect(summary.comparison).toMatchObject({
        source: 'measured-local-baseline',
        note: 'Measured with local Playwright and generic CDP harnesses.',
        baselines: [
          expect.objectContaining({
            id: 'playwright',
            label: 'Measured Playwright harness',
            metrics: expect.objectContaining({
              autoEvidenceActions: 0,
              hasReportTimeline: false,
              staleRefRecoveryRate: 0,
              sessionStabilitySample: false,
            }),
            delta: expect.objectContaining({
              commandCallsSaved: expect.any(Number),
              usefulObservationTokensSaved: expect.any(Number),
            }),
            capabilityGaps: [
              'action-evidence',
              'report-timeline',
              'stale-ref-recovery',
              'session-stability',
            ],
          }),
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
