import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildKillerPathBenchmarkPlan,
  estimateTokenCount,
  formatBenchmarkReport,
  loadComparisonBaselineFile,
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
    expect(summary.metrics.firstActionEvidenceMs).toBe(130);
    expect(summary.metrics.goldenPathMs).toBe(180);
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
      total: 0,
      covered: 0,
      missing: [],
      rate: null,
    });
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
          commandCallsSaved: 14,
          usefulObservationTokensSaved: expect.any(Number),
          verificationCallsSaved: 1,
        }),
      }),
      expect.objectContaining({
        id: 'devtools-manual',
        label: 'Manual DevTools inspection',
        delta: expect.objectContaining({
          commandCallsSaved: 23,
        }),
      }),
      expect.objectContaining({
        id: 'generic-cdp',
        label: 'Generic CDP script',
        delta: expect.objectContaining({
          commandCallsSaved: 18,
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
      expect.objectContaining({ name: 'golden-path-under-two-minutes', passed: true, actual: 180, operator: '<=', limit: 120000 }),
      expect.objectContaining({ name: 'useful-observation-tokens', passed: true, operator: '<=', limit: 3000 }),
      expect.objectContaining({ name: 'auto-evidence-actions', passed: true, actual: 1, operator: '>=', limit: 1 }),
      expect.objectContaining({ name: 'observed-action-evidence-coverage', passed: true, actual: 1, operator: '>=', limit: 1 }),
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
    expect(out).toContain('First action evidence: 60 ms');
    expect(out).toContain('Golden path complete: 100 ms');
    expect(out).toContain('Estimated output tokens:');
    expect(out).toContain('Action evidence coverage: 100% (2/2)');
    expect(out).toContain('Handoff nextSteps coverage: n/a (0/0)');
    expect(out).toContain('Report latestAction coverage: n/a (0/0)');
    expect(out).toContain('Report timelineWindow coverage: n/a (0/0)');
    expect(out).toContain('Quality gate: pass');
    expect(out).toContain('Gate checks: 14/14 pass');
    expect(out).toContain('Differentiator success rate: 100%');
    expect(out).toContain('Session stability: yes (40 ms, 3 probes)');
    expect(out).toContain('Comparison baselines:');
    expect(out).toContain('Playwright test generator/snapshot: saves 14 calls');
    expect(out).toContain('Generic CDP script: saves 18 calls');
    expect(out).toContain('heuristic-smoke-baseline');
    expect(out).toContain('CSS trace: yes');
    expect(out).toContain('Frame refs: yes');
    expect(out).toContain('HMR/SPA diff: yes');
    expect(out).toContain('Modal/overlay: yes');
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
      page: { title: 'Smoke' },
      nodes: [{ ref: '@1', role: 'button', name: 'Start' }],
      nextSteps: ['cdp click AABBCCDD @1 --format json'],
    });
    const actionJson = JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      dispatch: { ok: true },
      outcome: { status: 'changed' },
      nextSteps: ['cdp report AABBCCDD --format json'],
    });
    const sinceActionJson = JSON.stringify({
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode: 'since-action',
      summary: { changed: true },
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
            nextSteps: ['cdp list --format json'],
          }),
          stderr: '',
        },
        {
          name: 'perceive',
          command: ['perceive', 'AABBCCDD', '-C', '-d', '8', '--format', 'json'],
          startedAt: 10,
          endedAt: 25,
          status: 0,
          stdout: perceiveJson,
          stderr: '',
        },
        {
          name: 'click',
          command: ['click', 'AABBCCDD', '@1', '--format', 'json'],
          startedAt: 25,
          endedAt: 40,
          status: 0,
          stdout: actionJson,
          stderr: '',
        },
        {
          name: 'since-action',
          command: ['perceive', 'AABBCCDD', '--since-action', '--format', 'json'],
          startedAt: 40,
          endedAt: 50,
          status: 0,
          stdout: sinceActionJson,
          stderr: '',
        },
        {
          name: 'report',
          command: ['report', 'AABBCCDD', '--format', 'json'],
          startedAt: 50,
          endedAt: 60,
          status: 0,
          stdout: JSON.stringify({
            schema: 'chrome-cdp-ex.report.v1',
            timelineWindow: { total: 1, shown: 1, omitted: 0, startIndex: 1, endIndex: 1, limit: 20 },
            actions: [{ index: 1, action: 'click' }],
            latestAction: {
              index: 1,
              action: 'click',
              status: 'ok',
              outcomeStatus: 'changed',
              verdictStatus: 'continue',
              canContinue: true,
            },
            nextSteps: ['cdp record-actions AABBCCDD --format json'],
          }),
          stderr: '',
        },
      ],
    });

    expect(summary.metrics.firstUsefulObservationMs).toBe(25);
    expect(summary.metrics.firstActionEvidenceMs).toBe(40);
    expect(summary.metrics.goldenPathMs).toBe(60);
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
    expect(summary.metrics.usefulObservationTokens).toBe(
      estimateTokenCount(perceiveJson.length) + estimateTokenCount(sinceActionJson.length),
    );
    expect(summary.metrics.actionEvidenceCoverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: [],
      rate: 1,
    });
    expect(summary.metrics.handoffNextStepsCoverage).toMatchObject({
      total: 5,
      covered: 5,
      missing: [],
      rate: 1,
    });
    expect(summary.steps[2].hasActionEvidence).toBe(true);
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

  it('plans core mutating commands with live action evidence coverage', () => {
    const plan = buildKillerPathBenchmarkPlan('AABBCCDD', {
      stabilityMs: 1000,
      navUrl: 'http://127.0.0.1:41738/smoke-page.html',
    });
    const staleRefMutation = plan.find(step => step.name === 'stale-ref-mutate');

    expect(staleRefMutation).toMatchObject({
      name: 'stale-ref-mutate',
      args: ['reload', 'AABBCCDD'],
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
    expect(plan.find(step => step.args[0] === 'inject')?.args).toEqual(['inject', 'AABBCCDD', '--css', '#combat-log { outline: 2px solid rgb(37, 99, 235); }', '--format', 'json']);
    expect(plan.find(step => step.args[0] === 'nav')?.args).toEqual(['nav', 'AABBCCDD', 'http://127.0.0.1:41738/smoke-page.html#after-action-evidence', '--format', 'json']);
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
    expect(plan.find(step => step.args[0] === 'report')?.args).toEqual(['report', 'AABBCCDD', '--format', 'json']);
    expect(plan.length).toBeLessThanOrEqual(23);
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
    expect(plan.length).toBeLessThanOrEqual(21);
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
