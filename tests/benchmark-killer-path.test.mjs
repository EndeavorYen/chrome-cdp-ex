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
        name: 'click',
        command: ['click', 'AABBCCDD', '#start'],
        startedAt: 40,
        endedAt: 70,
        status: 0,
        stdout: 'Clicked #start\n---\nclick: dispatched\nEffects:\n+++ Added\n[StaticText] Started\n',
        stderr: '',
      },
      {
        name: 'report',
        command: ['report', 'AABBCCDD'],
        startedAt: 70,
        endedAt: 100,
        status: 0,
        stdout: 'Session report: AABBCCDD\nActions: 1\n\nAction timeline:\n- click #start\n',
        stderr: '',
      },
    ];

    const summary = summarizeBenchmarkRun({
      scenario: 'killer-path',
      startedAt: 0,
      endedAt: 100,
      target: 'AABBCCDD',
      steps,
    });

    const outputChars = steps.reduce((sum, step) => sum + step.stdout.length + step.stderr.length, 0);

    expect(summary.schema).toBe('chrome-cdp-ex.benchmark.v1');
    expect(summary.scenario).toBe('killer-path');
    expect(summary.success).toBe(true);
    expect(summary.target).toBe('AABBCCDD');
    expect(summary.metrics.totalMs).toBe(100);
    expect(summary.metrics.commandCalls).toBe(4);
    expect(summary.metrics.outputChars).toBe(outputChars);
    expect(summary.metrics.estimatedOutputTokens).toBe(estimateTokenCount(outputChars));
    expect(summary.metrics.firstUsefulObservationMs).toBe(40);
    expect(summary.metrics.autoEvidenceActions).toBe(1);
    expect(summary.metrics.verificationCallsSaved).toBe(1);
    expect(summary.metrics.hasReportTimeline).toBe(true);
    expect(summary.steps[2]).toMatchObject({
      name: 'click',
      ok: true,
      durationMs: 30,
      estimatedTokens: estimateTokenCount(steps[2].stdout.length),
      hasActionEvidence: true,
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
        { name: 'click', command: ['click', 'AABB', '#go'], startedAt: 30, endedAt: 60, status: 0, stdout: 'Clicked\nclick: dispatched', stderr: '' },
        { name: 'report', command: ['report', 'AABB'], startedAt: 60, endedAt: 100, status: 0, stdout: 'Session report: AABB\nActions: 1\n\nAction timeline:', stderr: '' },
      ],
    });

    const out = formatBenchmarkReport(summary);

    expect(out).toContain('chrome-cdp-ex benchmark: killer-path');
    expect(out).toContain('Success: yes');
    expect(out).toContain('Command calls: 4');
    expect(out).toContain('Estimated output tokens:');
    expect(out).toContain('Verification calls saved: 1');
    expect(out).toContain('doctor');
    expect(out).toContain('report');
  });
});
