import { describe, expect, it } from 'vitest';

import {
  buildReportRecommendation,
  defaultReportNextSteps,
  formatReportRecommendationLines,
  normalizeReportTargetCommand,
} from '../skills/chrome-cdp-ex/scripts/lib/session-report.mjs';

describe('session report lib', () => {
  it('promotes the latest actionable diagnosis into report recommendations', () => {
    const recommendation = buildReportRecommendation([
      {
        action: 'click',
        target: { targetId: 'FULLTARGET123', input: '#save' },
        diagnosis: {
          status: 'attention',
          kind: 'console-error',
          recovery: {
            strategy: 'inspect-runtime-errors',
            priority: 'high',
            verifyCommand: 'cdp perceive FULLTARGET123 --since-action',
            commands: [
              { command: 'cdp console FULLTARGET123 --errors' },
              { command: 'cdp report FULLTARGET123 --format json' },
            ],
          },
        },
      },
    ], 'ABC123', 'FULLTARGET123');

    expect(recommendation).toMatchObject({
      source: 'latest-action-diagnosis',
      actionIndex: 1,
      action: 'click',
      diagnosisKind: 'console-error',
      strategy: 'inspect-runtime-errors',
      priority: 'high',
      verifyCommand: 'cdp perceive ABC123 --since-action',
      commands: [
        'cdp console ABC123 --errors',
        'cdp report ABC123 --format json',
      ],
    });
  });

  it('routes latest no-change outcomes through overlay and frame checks', () => {
    const recommendation = buildReportRecommendation([
      {
        action: 'click',
        target: { targetId: 'FULLTARGET123', input: '#refresh' },
        outcome: { status: 'no-change' },
      },
    ], 'ABC123', 'FULLTARGET123');

    expect(recommendation).toMatchObject({
      source: 'latest-action-outcome',
      outcomeStatus: 'no-change',
      commands: [
        'cdp overlay ABC123 "#refresh" --format json',
        'cdp frame ABC123 --format json',
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
  });

  it('formats concise report recommendation lines', () => {
    const lines = formatReportRecommendationLines({
      source: 'latest-action-diagnosis',
      actionIndex: 1,
      action: 'click',
      diagnosisKind: 'overlay',
      strategy: 'clear-overlay',
      priority: 'high',
      verifyCommand: 'cdp perceive ABC123 -C -d 8',
      commands: ['cdp overlay ABC123 "#save" --format json'],
    });

    expect(lines).toEqual([
      'Recommendation:',
      '  Source: latest-action-diagnosis',
      '  Action: #1 click',
      '  Diagnosis: overlay',
      '  Strategy: clear-overlay',
      '  Priority: high',
      '  Run: cdp overlay ABC123 "#save" --format json',
      '  Verify: cdp perceive ABC123 -C -d 8',
    ]);
  });

  it('normalizes full target commands to displayed target prefixes', () => {
    expect(defaultReportNextSteps('ABC123', true)).toEqual([
      'cdp perceive ABC123 --since-action',
      'cdp record-actions ABC123 --format json',
      'cdp export-playwright ABC123',
    ]);
    expect(normalizeReportTargetCommand('cdp report FULLTARGET123 --format json', 'FULLTARGET123', 'ABC123'))
      .toBe('cdp report ABC123 --format json');
  });
});
