import { describe, expect, it } from 'vitest';

import {
  estimateTokenCount,
  formatBenchmarkReport,
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
        name: 'click',
        command: ['click', 'AABBCCDD', '#start'],
        startedAt: 100,
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
    ];

    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt: 0,
      endedAt: 180,
      target: 'AABBCCDD',
      steps,
    });

    const outputChars = steps.reduce((sum, step) => sum + step.stdout.length + step.stderr.length, 0);

    expect(summary.schema).toBe('chrome-cdp-ex.benchmark.v1');
    expect(summary.scenario).toBe('killer-path');
    expect(summary.success).toBe(true);
    expect(summary.target).toBe('AABBCCDD');
    expect(summary.metrics.totalMs).toBe(180);
    expect(summary.metrics.commandCalls).toBe(8);
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
      successRate: 1,
    });
    expect(summary.metrics.staleRefRecovery).toMatchObject({
      success: true,
      durationMs: 20,
      commandCalls: 1,
      rate: 1,
    });
    expect(summary.steps[5]).toMatchObject({
      name: 'click',
      ok: true,
      durationMs: 30,
      estimatedTokens: estimateTokenCount(steps[5].stdout.length),
      hasActionEvidence: true,
    });
    expect(summary.steps[6]).toMatchObject({
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
        { name: 'click', command: ['click', 'AABB', '#go'], startedAt: 30, endedAt: 60, status: 0, stdout: 'Clicked\nclick: dispatched', stderr: '' },
        { name: 'stale-ref', command: ['click', 'AABB', '@1'], startedAt: 60, endedAt: 75, status: 1, expectedFailure: true, stdout: '', stderr: 'Action failure: stale-ref\nNext: cdp perceive AABB -C -d 8' },
        { name: 'report', command: ['report', 'AABB'], startedAt: 75, endedAt: 100, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
      ],
    });

    const out = formatBenchmarkReport(summary);

    expect(out).toContain('chrome-cdp-ex benchmark: killer-path');
    expect(out).toContain('Success: yes');
    expect(out).toContain('Command calls: 8');
    expect(out).toContain('Estimated output tokens:');
    expect(out).toContain('Differentiator success rate: 100%');
    expect(out).toContain('CSS trace: yes');
    expect(out).toContain('Frame refs: yes');
    expect(out).toContain('Modal/overlay: yes');
    expect(out).toContain('Stale-ref recovery: yes');
    expect(out).toContain('Verification calls saved: 1');
    expect(out).toContain('doctor');
    expect(out).toContain('report');
  });
});
