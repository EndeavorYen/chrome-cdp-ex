import { describe, expect, it } from 'vitest';

import {
  estimateTokenCount,
  formatBenchmarkReport,
  parseBenchmarkArgs,
  summarizeBenchmarkRun,
} from '../scripts/benchmark-killer-path.mjs';

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
        name: 'frame',
        command: ['frame', 'AABBCCDD'],
        startedAt: 55,
        endedAt: 75,
        status: 0,
        stdout: 'Frames:\n@f2 smoke-child http://example.test/child\n',
        stderr: '',
      },
      {
        name: 'cascade',
        command: ['cascade', 'AABBCCDD', '#start', 'background-color'],
        startedAt: 75,
        endedAt: 100,
        status: 0,
        stdout: 'background-color:\n  WIN rgb(1, 2, 3) ← #start\n    → inline:12\n',
        stderr: '',
      },
      {
        name: 'hmr-diff',
        command: ['perceive', 'AABBCCDD', '--diff', '-s', '#combat-log', '--last', '20'],
        startedAt: 100,
        endedAt: 118,
        status: 0,
        stdout: '~~~ Text nodes updated (1 added)\n+   [StaticText] hmr panel ready\n',
        stderr: '',
      },
      {
        name: 'click',
        command: ['click', 'AABBCCDD', '#start'],
        startedAt: 118,
        endedAt: 130,
        status: 0,
        stdout: 'Clicked #start\n---\nclick: dispatched\nEffects:\n+++ Added\n[StaticText] Started\n',
        stderr: '',
      },
      {
        name: 'stale-ref',
        command: ['click', 'AABBCCDD', '@1'],
        startedAt: 130,
        endedAt: 150,
        status: 1,
        expectedFailure: true,
        stdout: '',
        stderr: 'Action failure: stale-ref\nReason: The @ref no longer maps to the current DOM.\nNext: cdp perceive AABBCCDD -C -d 8\n',
      },
      {
        name: 'report',
        command: ['report', 'AABBCCDD'],
        startedAt: 150,
        endedAt: 180,
        status: 0,
        stdout: 'Session report: AABBCCDD\nActions: 1\n\nAction timeline:\n- click #start\n',
        stderr: '',
      },
      {
        name: 'stability-wait',
        command: ['wait', 'AABBCCDD', '1000'],
        startedAt: 180,
        endedAt: 190,
        status: 0,
        stdout: 'waited 1000ms',
        stderr: '',
      },
      {
        name: 'stability-status',
        command: ['status', 'AABBCCDD'],
        startedAt: 190,
        endedAt: 205,
        status: 0,
        stdout: 'Status: ready\n',
        stderr: '',
      },
      {
        name: 'stability-report',
        command: ['report', 'AABBCCDD'],
        startedAt: 205,
        endedAt: 220,
        status: 0,
        stdout: 'Session report: AABBCCDD\nActions: 1\n\nAction timeline:\n- click #start\n',
        stderr: '',
      },
    ];

    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt: 0,
      endedAt: 220,
      target: 'AABBCCDD',
      steps,
    });

    const outputChars = steps.reduce((sum, step) => sum + step.stdout.length + step.stderr.length, 0);

    expect(summary.schema).toBe('chrome-cdp-ex.benchmark.v1');
    expect(summary.scenario).toBe('killer-path');
    expect(summary.success).toBe(true);
    expect(summary.target).toBe('AABBCCDD');
    expect(summary.metrics.totalMs).toBe(220);
    expect(summary.metrics.commandCalls).toBe(12);
    expect(summary.metrics.outputChars).toBe(outputChars);
    expect(summary.metrics.estimatedOutputTokens).toBe(estimateTokenCount(outputChars));
    expect(summary.metrics.firstUsefulObservationMs).toBe(40);
    expect(summary.metrics.autoEvidenceActions).toBe(1);
    expect(summary.metrics.verificationCallsSaved).toBe(1);
    expect(summary.metrics.hasReportTimeline).toBe(true);
    expect(summary.metrics.differentiators).toMatchObject({
      modalOverlay: { success: true, durationMs: 15, commandCalls: 1 },
      frameRefs: { success: true, durationMs: 20, commandCalls: 1 },
      cssTrace: { success: true, durationMs: 25, commandCalls: 1 },
      hmrDomUpdate: { success: true, durationMs: 18, commandCalls: 1 },
      successRate: 1,
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
    expect(summary.gate).toMatchObject({
      schema: 'chrome-cdp-ex.benchmark-gate.v1',
      passed: true,
      profile: 'killer-path-default',
    });
    expect(summary.gate.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'first-useful-observation', passed: true, actual: 40, operator: '<=', limit: 5000 }),
      expect.objectContaining({ name: 'useful-observation-tokens', passed: true, operator: '<=', limit: 3000 }),
      expect.objectContaining({ name: 'auto-evidence-actions', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'report-timeline', passed: true, actual: true, operator: '===', limit: true }),
      expect.objectContaining({ name: 'differentiator-success-rate', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'stale-ref-recovery-rate', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'session-stability-sample', passed: true, actual: true, operator: '===', limit: true }),
    ]));
    expect(summary.steps[6]).toMatchObject({
      name: 'click',
      ok: true,
      durationMs: 12,
      estimatedTokens: estimateTokenCount(steps[6].stdout.length),
      hasActionEvidence: true,
    });
    expect(summary.steps[7]).toMatchObject({
      name: 'stale-ref',
      ok: true,
      expectedFailure: true,
    });
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
        { name: 'click', command: ['click', 'AABB', '#go'], startedAt: 30, endedAt: 60, status: 0, stdout: 'Clicked\nclick: dispatched', stderr: '' },
        { name: 'stale-ref', command: ['click', 'AABB', '@1'], startedAt: 60, endedAt: 75, status: 1, expectedFailure: true, stdout: '', stderr: 'Action failure: stale-ref\nNext: cdp perceive AABB -C -d 8' },
        { name: 'report', command: ['report', 'AABB'], startedAt: 75, endedAt: 100, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
        { name: 'stability-wait', command: ['wait', 'AABB', '1000'], startedAt: 100, endedAt: 110, status: 0, stdout: 'waited 1000ms', stderr: '' },
        { name: 'stability-status', command: ['status', 'AABB'], startedAt: 110, endedAt: 125, status: 0, stdout: 'Status: ready', stderr: '' },
        { name: 'stability-report', command: ['report', 'AABB'], startedAt: 125, endedAt: 140, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
      ],
    });

    const out = formatBenchmarkReport(summary);

    expect(out).toContain('chrome-cdp-ex benchmark: killer-path');
    expect(out).toContain('Success: yes');
    expect(out).toContain('Command calls: 12');
    expect(out).toContain('Estimated output tokens:');
    expect(out).toContain('Quality gate: pass');
    expect(out).toContain('Gate checks: 9/9 pass');
    expect(out).toContain('Differentiator success rate: 100%');
    expect(out).toContain('Session stability: yes (40 ms, 3 probes)');
    expect(out).toContain('CSS trace: yes');
    expect(out).toContain('Frame refs: yes');
    expect(out).toContain('HMR/SPA diff: yes');
    expect(out).toContain('Modal/overlay: yes');
    expect(out).toContain('Stale-ref recovery: yes');
    expect(out).toContain('Verification calls saved: 1');
    expect(out).toContain('doctor');
    expect(out).toContain('report');
  });

  it('parses JSON mode and stability window options', () => {
    expect(parseBenchmarkArgs(['--json', '--stability-ms', '1200000'])).toEqual({
      json: true,
      stabilityMs: 1200000,
    });
    expect(parseBenchmarkArgs([])).toEqual({
      json: false,
      stabilityMs: 1000,
    });
  });
});
