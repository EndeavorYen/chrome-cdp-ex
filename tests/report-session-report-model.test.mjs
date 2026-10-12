import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// =========================================================================
// Session report
// =========================================================================

describe('Session report', () => {
  function sampleActionResult() {
    return T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#combat', resolvedBy: 'selector', label: '#combat' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: {
        domDiff: [
          'Page: Smoke — http://127.0.0.1/',
          '',
          '+++ Added (1):',
          '+   [alert] 戰鬥勝利',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
  }

  it('formats an empty session report with a next action hint', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');

    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(out).toContain('Session report: ABC123');
    expect(out).toContain('Uptime: 5s');
    expect(out).toContain('Log:');
    expect(out).toContain('Actions: 0');
    expect(out).toContain('Screenshot dir:');
    expect(out).toContain('No actions recorded yet');
  });

  it('records action evidence and formats an action timeline', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');
    const actionResult = sampleActionResult();

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(state.actionLog).toHaveLength(1);
    expect(state.actionLog[0].sequence).toBe(1);
    expect(state.actionLog[0].eventId).toBe('act_ABC123_000001');
    expect(state.actionLog[0].receipt).toMatchObject({
      eventId: 'act_ABC123_000001',
      sequence: 1,
      outcome: 'changed',
      settlement: {
        state: 'settled',
        strategy: 'dom-observation',
        reason: 'Post-action DOM observation completed.',
      },
      recovery: {
        strategy: 'continue-from-evidence',
      },
      observedDeltaDetails: expect.arrayContaining([
        expect.objectContaining({ type: 'dom', status: 'changed' }),
        expect.objectContaining({ type: 'console', status: 'unchanged' }),
      ]),
    });
    expect(out).toContain('Actions: 1');
    expect(out).toContain('Action timeline:');
    expect(out).toContain('1. click #combat — ok in 123ms');
    expect(out).toContain('Outcome: changed — Observed page change after action.');
    expect(out).toContain('Verdict: continue');
    expect(out).toContain('Effect: +++ Added (1):');
    expect(out).toContain('戰鬥勝利');
  });

  it('builds a JSON report model for agent handoff', () => {
    const state = T.createSessionState({
      targetId: 'ABC123456789',
      sessionId: 'sid-1',
      logPath: '/tmp/chrome-cdp-ex/session-ABC12345.jsonl',
      screenshotDir: '/tmp/chrome-cdp-ex/screens-ABC12345',
    });
    state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');
    T.appendSessionActionLog(state, sampleActionResult(), {
      ts: Date.parse('2026-06-16T00:00:03.000Z'),
    });
    T.appendSessionScreenshot(state, {
      kind: 'shot',
      path: '/tmp/chrome-cdp-ex/screens-ABC12345/shot-001.png',
      note: 'after combat',
      ts: Date.parse('2026-06-16T00:00:04.000Z'),
    });

    const model = T.buildSessionReportModel(state, {
      now: Date.parse('2026-06-16T00:00:05.000Z'),
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.report.v1',
      targetId: 'ABC123456789',
      targetPrefix: 'ABC12345',
      sessionId: 'sid-1',
      uptimeMs: 5000,
      counts: { actions: 1, screenshots: 1, records: 0 },
      latestAction: {
        index: 1,
        sequence: 1,
        eventId: 'act_ABC12345_000001',
        action: 'click',
        status: 'ok',
        outcomeStatus: 'changed',
        verdictStatus: 'continue',
        canContinue: true,
        needsRecovery: false,
        effectSummary: '+++ Added (1):',
        effectSample: '+   [alert] 戰鬥勝利',
        diagnosisKind: 'dom-changed',
        nextHint: 'Use perceive --since-action if more evidence is needed',
      },
      paths: {
        log: '/tmp/chrome-cdp-ex/session-ABC12345.jsonl',
        screenshotDir: '/tmp/chrome-cdp-ex/screens-ABC12345',
      },
      actions: [
        {
          index: 1,
          action: 'click',
          status: 'ok',
          outcome: {
            schema: 'chrome-cdp-ex.action-outcome.v1',
            status: 'changed',
            changed: true,
            needsAttention: false,
          },
          verdict: {
            schema: 'chrome-cdp-ex.action-verdict.v1',
            status: 'continue',
            canContinue: true,
            needsRecovery: false,
          },
          target: { input: '#combat', label: '#combat' },
          evidence: {
            settleDurationMs: 123,
            effectSummary: '+++ Added (1):',
            effectSample: '+   [alert] 戰鬥勝利',
          },
          receipt: {
            eventId: 'act_ABC12345_000001',
            sequence: 1,
            outcome: 'changed',
            settlement: {
              state: 'settled',
              strategy: 'dom-observation',
              durationMs: 123,
              signals: [],
            },
            observedDeltaDetails: [
              expect.objectContaining({ type: 'dom', status: 'changed' }),
            ],
          },
          nextHint: 'Use perceive --since-action if more evidence is needed',
        },
      ],
      screenshots: [
        {
          index: 1,
          kind: 'shot',
          path: '/tmp/chrome-cdp-ex/screens-ABC12345/shot-001.png',
          note: 'after combat',
        },
      ],
      nextSteps: [
        'cdp perceive ABC12345 --since-action',
        'cdp record-actions ABC12345 --format json',
        'cdp export-playwright ABC12345',
      ],
    });
    expect(Object.keys(model.actions[0].receipt).sort()).toEqual([
      'actionId',
      'blockingSignals',
      'eventId',
      'loggedAt',
      'observedDeltaDetails',
      'outcome',
      'recoveryHint',
      'schema',
      'sequence',
      'settlement',
    ]);
    expect(model.actions[0].receipt).not.toHaveProperty('dispatch');
    expect(model.actions[0].receipt).not.toHaveProperty('nextSteps');
    expect(model.actions[0].receipt).not.toHaveProperty('recovery');
  });

  it('builds compact JSON report handoffs with bounded action evidence', () => {
    const state = T.createSessionState({
      targetId: 'ABC123456789',
      sessionId: 'sid-1',
      logPath: '/tmp/chrome-cdp-ex/session-ABC12345.jsonl',
      screenshotDir: '/tmp/chrome-cdp-ex/screens-ABC12345',
    });
    state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');
    T.appendSessionActionLog(state, sampleActionResult(), {
      ts: Date.parse('2026-06-16T00:00:03.000Z'),
    });

    const fullModel = T.buildSessionReportModel(state, {
      now: Date.parse('2026-06-16T00:00:05.000Z'),
    });
    const compactModel = T.buildSessionReportModel(state, {
      now: Date.parse('2026-06-16T00:00:05.000Z'),
      compact: true,
      lastActions: 1,
    });

    expect(compactModel).toMatchObject({
      schema: 'chrome-cdp-ex.report.v1',
      mode: 'compact',
      counts: { actions: 1, screenshots: 0, records: 0 },
      latestAction: {
        index: 1,
        eventId: 'act_ABC12345_000001',
        action: 'click',
        status: 'ok',
      },
      timelineWindow: {
        total: 1,
        shown: 1,
        omitted: 0,
        limit: 1,
        mode: 'latest',
      },
      actions: [
        {
          index: 1,
          action: 'click',
          status: 'ok',
          target: { input: '#combat', label: '#combat' },
          evidence: {
            dispatchMethod: 'click',
            settleOk: true,
            settleDurationMs: 123,
            effectSummary: '+++ Added (1):',
            effectSample: '+   [alert] 戰鬥勝利',
          },
          receipt: {
            eventId: 'act_ABC12345_000001',
            settlement: {
              state: 'settled',
              strategy: 'dom-observation',
              durationMs: 123,
              signals: [],
            },
            observedDeltaDetails: [
              expect.objectContaining({ type: 'dom', status: 'changed' }),
            ],
          },
        },
      ],
      recommendation: expect.objectContaining({
        commands: expect.arrayContaining(['cdp perceive ABC12345 --since-action']),
      }),
      nextSteps: expect.arrayContaining([
        'cdp perceive ABC12345 --since-action',
        'cdp record-actions ABC12345 --format json',
      ]),
    });
    expect(compactModel.actions[0]).not.toHaveProperty('dispatch');
    expect(compactModel.actions[0]).not.toHaveProperty('settle');
    expect(compactModel.actions[0]).not.toHaveProperty('outcome');
    expect(compactModel.actions[0]).not.toHaveProperty('verdict');
    expect(compactModel.reportBudget.estimatedJsonBytes).toBeLessThan(fullModel.reportBudget.estimatedJsonBytes);
  });

  it('bounds JSON report action timeline to the latest actions by default', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    for (let index = 1; index <= 25; index++) {
      T.appendSessionActionLog(state, T.createActionResult({
        action: 'click',
        target: { targetId: 'ABC123', input: `#btn-${index}`, resolvedBy: 'selector', label: `#btn-${index}` },
        dispatch: { ok: true, method: 'click' },
        settle: { ok: true, durationMs: index },
        effects: { domDiff: `+++ Added (1):\n+   [status] Saved ${index}`, console: [], network: [], navigation: null },
        nextHint: null,
      }), { ts: Date.parse('2026-06-16T00:00:00.000Z') + index });
    }

    const model = T.buildSessionReportModel(state, { now: Date.parse('2026-06-16T00:00:30.000Z') });

    expect(model.counts.actions).toBe(25);
    expect(model.timelineWindow).toEqual({
      total: 25,
      shown: 20,
      omitted: 5,
      startIndex: 6,
      endIndex: 25,
      limit: 20,
      mode: 'latest',
      expensive: false,
    });
    expect(model.actions).toHaveLength(20);
    expect(model.actions[0]).toMatchObject({ index: 6, action: 'click', target: { input: '#btn-6' } });
    expect(model.actions[19]).toMatchObject({ index: 25, action: 'click', target: { input: '#btn-25' } });
    expect(model.latestAction).toMatchObject({ index: 25, effectSample: '+   [status] Saved 25' });
  });

  it('keeps long-session report handoffs bounded and documents artifact cleanup', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'cdp-long-session-artifacts-'));
    const logPath = resolve(dir, 'session-ABC12345.jsonl');
    const screenshotDir = resolve(dir, 'screens-ABC12345');
    try {
      mkdirSync(screenshotDir);
      writeFileSync(logPath, 'x'.repeat(4096));
      const state = T.createSessionState({
        targetId: 'ABC123456789',
        sessionId: 'sid-1',
        logPath,
        screenshotDir,
      });
      state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');
      state.actionLog = Array.from({ length: 120 }, (_, index) => {
        const actionIndex = index + 1;
        return {
          ts: Date.parse('2026-06-16T00:00:00.000Z') + actionIndex,
          action: actionIndex % 5 === 0 ? 'fill' : 'click',
          target: {
            targetId: 'ABC123456789',
            input: `#control-${actionIndex}`,
            label: `#control-${actionIndex}`,
            resolvedBy: 'selector',
          },
          dispatch: { ok: true, method: actionIndex % 5 === 0 ? 'fill' : 'click' },
          settle: { ok: true, durationMs: 20 + actionIndex },
          effectSummary: `+++ Added (1): action ${actionIndex}`,
          effectSample: `+   [status] action ${actionIndex} completed`,
          consoleSummary: actionIndex % 7 === 0 ? 'Console: 3 entries (2 errors)' : null,
          consoleSample: actionIndex % 7 === 0 ? '[error] noisy console event' : null,
          networkSummary: actionIndex % 9 === 0 ? 'Network: 2 requests (1 failed)' : null,
          networkSample: actionIndex % 9 === 0 ? 'GET /api/noise -> failed' : null,
          outcome: { status: 'changed', changed: true },
          verdict: { status: 'continue', canContinue: true, needsRecovery: false },
        };
      });
      for (let index = 1; index <= 3; index++) {
        const shotPath = resolve(screenshotDir, `shot-${String(index).padStart(3, '0')}.png`);
        writeFileSync(shotPath, 's'.repeat(index * 1024));
        T.appendSessionScreenshot(state, {
          kind: index === 2 ? 'diff-shot' : 'shot',
          path: shotPath,
          note: `artifact ${index}`,
          ts: Date.parse('2026-06-16T00:00:10.000Z') + index,
        });
      }

      const model = T.buildSessionReportModel(state, {
        now: Date.parse('2026-06-16T00:01:00.000Z'),
      });
      const jsonBytes = Buffer.byteLength(JSON.stringify(model), 'utf8');

      expect(model.counts.actions).toBe(120);
      expect(model.timelineWindow).toMatchObject({
        total: 120,
        shown: 20,
        omitted: 100,
        startIndex: 101,
        endIndex: 120,
        limit: 20,
        mode: 'latest',
        expensive: false,
      });
      expect(model.reportBudget).toMatchObject({
        jsonBytesMax: expect.any(Number),
        actionLimit: 20,
        allActionsOptIn: true,
        expensive: false,
      });
      expect(jsonBytes).toBeLessThanOrEqual(model.reportBudget.jsonBytesMax);
      expect(model.actions).toHaveLength(20);
      expect(model.actions[0]).toMatchObject({ index: 101, target: { input: '#control-101' } });
      expect(model.artifacts).toMatchObject({
        paths: { log: logPath, screenshotDir },
        counts: { actions: 120, screenshots: 3, records: 0 },
        sizes: {
          log: { path: logPath, exists: true, sizeBytes: expect.any(Number) },
          screenshotDir: { path: screenshotDir, exists: true, fileCount: 3, sizeBytes: 6144 },
          screenshots: { count: 3, totalBytes: 6144 },
        },
      });
      expect(model.artifacts.sizes.log.sizeBytes).toBeGreaterThanOrEqual(4096);
      expect(model.cleanup).toMatchObject({
        staleAfterHours: expect.any(Number),
        targets: [logPath, screenshotDir],
      });
      expect(model.cleanup.workflow.join(' ')).toContain('Remove stale session artifacts');

      const allModel = T.buildSessionReportModel(state, {
        now: Date.parse('2026-06-16T00:01:00.000Z'),
        lastActions: null,
      });
      expect(allModel.timelineWindow).toMatchObject({
        total: 120,
        shown: 120,
        omitted: 0,
        limit: null,
        mode: 'all',
        expensive: true,
      });
      expect(allModel.reportBudget).toMatchObject({
        actionLimit: null,
        allActionsOptIn: true,
        expensive: true,
      });
      expect(allModel.reportBudget.warning).toContain('report --all');

      const text = T.formatSessionReport(state, {
        now: Date.parse('2026-06-16T00:01:00.000Z'),
      });
      expect(text).toContain('Report JSON budget:');
      expect(text).toContain('--all is opt-in');
      expect(text).toContain('Artifact bytes:');
      expect(text).toContain('Cleanup: Remove stale session artifacts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats only the requested latest report actions in text mode', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    for (let index = 1; index <= 5; index++) {
      T.appendSessionActionLog(state, T.createActionResult({
        action: 'click',
        target: { targetId: 'ABC123', input: `#btn-${index}`, resolvedBy: 'selector', label: `#btn-${index}` },
        dispatch: { ok: true, method: 'click' },
        settle: { ok: true, durationMs: index },
        effects: { domDiff: `+++ Added (1):\n+   [status] Saved ${index}`, console: [], network: [], navigation: null },
        nextHint: null,
      }), { ts: Date.parse('2026-06-16T00:00:00.000Z') + index });
    }

    const out = T.formatSessionReport(state, {
      now: Date.parse('2026-06-16T00:00:30.000Z'),
      lastActions: 2,
    });

    expect(out).toContain('Actions: 5 (showing last 2, 3 omitted)');
    expect(out).not.toContain('1. click #btn-1');
    expect(out).not.toContain('2. click #btn-2');
    expect(out).not.toContain('3. click #btn-3');
    expect(out).toContain('4. click #btn-4');
    expect(out).toContain('5. click #btn-5');
    expect(out).toContain('Use report --all or inspect the JSONL log for the full action history.');
  });

  it('records compact console and network deltas in session reports', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const actionResult = T.applyActionObservationDelta(sampleActionResult(), {
      console: {
        count: 1,
        errors: 1,
        warnings: 0,
        entries: [{ level: 'error', text: 'combat failed', loc: 'game.js:44' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    });

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(out).toContain('Console: 1 entry (1 error)');
    expect(out).toContain('Console sample: [error] combat failed @ game.js:44');
    expect(out).toContain('Network: 1 request (1 failed)');
    expect(out).toContain('Network sample: POST /api/combat -> 500 in 27ms');
    expect(out).toContain('Diagnosis: network-failure');
    expect(out).toContain('Recovery: inspect-network');
    expect(state.actionLog[0].consoleSummary).toBe('Console: 1 entry (1 error)');
    expect(state.actionLog[0].networkSummary).toBe('Network: 1 request (1 failed)');
    expect(state.actionLog[0].diagnosis).toMatchObject({
      kind: 'network-failure',
      nextCommand: 'cdp netlog ABC123',
    });
  });

  it('prioritizes latest diagnosis recovery commands in JSON report next steps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const actionResult = T.applyActionObservationDelta(sampleActionResult(), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    });

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const model = T.buildSessionReportModel(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(model.nextSteps).toEqual([
      'cdp netlog ABC123',
      'cdp perceive ABC123 --since-action',
      'cdp report ABC123 --format json',
      'cdp record-actions ABC123 --format json',
      'cdp export-playwright ABC123',
    ]);
    expect(model.recommendation).toMatchObject({
      source: 'latest-action-diagnosis',
      strategy: 'inspect-network',
      actionIndex: 1,
      diagnosisKind: 'network-failure',
      verifyCommand: 'cdp perceive ABC123 --since-action',
    });
  });

  it('prioritizes latest no-change outcome recovery in JSON report next steps', () => {
    const state = T.createSessionState({ targetId: 'ABC123456789', sessionId: 'sid-1' });
    const actionResult = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123456789', input: '#refresh', resolvedBy: 'selector', label: '#refresh' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 90 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const model = T.buildSessionReportModel(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(model.recommendation).toMatchObject({
      source: 'latest-action-outcome',
      strategy: 'investigate-no-change',
      actionIndex: 1,
      action: 'click',
      outcomeStatus: 'no-change',
      verifyCommand: 'cdp perceive ABC12345 -C -d 8',
      commands: [
        'cdp overlay ABC12345 "#refresh" --format json',
        'cdp perceive ABC12345 -C -d 8',
        'cdp report ABC12345 --format json',
      ],
    });
    expect(model.nextSteps).toEqual([
      'cdp overlay ABC12345 "#refresh" --format json',
      'cdp perceive ABC12345 -C -d 8',
      'cdp report ABC12345 --format json',
      'cdp record-actions ABC12345 --format json',
      'cdp export-playwright ABC12345',
    ]);
    expect(out).toContain('Outcome: no-change');
    expect(out).toContain('Strategy: investigate-no-change');
    expect(out).toContain('Run: cdp overlay ABC12345 "#refresh" --format json');
  });

  it('normalizes report diagnosis recovery commands to the target prefix', () => {
    const state = T.createSessionState({ targetId: 'ABC123456789', sessionId: 'sid-1' });
    const actionResult = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123456789', input: '#combat', resolvedBy: 'selector', label: '#combat' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    });

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const model = T.buildSessionReportModel(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(model.recommendation.commands).toEqual([
      'cdp netlog ABC12345',
      'cdp perceive ABC12345 --since-action',
      'cdp report ABC12345 --format json',
    ]);
    expect(model.nextSteps).toEqual([
      'cdp netlog ABC12345',
      'cdp perceive ABC12345 --since-action',
      'cdp report ABC12345 --format json',
      'cdp record-actions ABC12345 --format json',
      'cdp export-playwright ABC12345',
    ]);
    expect(out).toContain('Run: cdp netlog ABC12345');
    expect(out).not.toContain('cdp netlog ABC123456789');
  });

  it('prints report recommendation and executable next steps in text mode', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const actionResult = T.applyActionObservationDelta(sampleActionResult(), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    });

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(out).toContain('Recommendation:');
    expect(out).toContain('Source: latest-action-diagnosis');
    expect(out).toContain('Strategy: inspect-network');
    expect(out).toContain('Run: cdp netlog ABC123');
    expect(out).toContain('Verify: cdp perceive ABC123 --since-action');
    expect(out).toContain('Next steps:');
    expect(out).toContain('1. cdp netlog ABC123');
    expect(out).toContain('2. cdp perceive ABC123 --since-action');
    expect(out).toContain('3. cdp report ABC123 --format json');
    expect(out).toContain('4. cdp record-actions ABC123 --format json');
    expect(out).toContain('5. cdp export-playwright ABC123');
  });

  it('records classified action failures in the session report', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const failure = T.classifyActionFailure(
      new Error('No node with given id'),
      { action: 'click', target: { targetId: 'ABC123', input: '@9' } }
    );

    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '@9', resolvedBy: 'ref', label: '@9' },
      dispatch: { ok: false, method: 'click', error: failure.originalMessage },
      settle: { ok: false, durationMs: 12 },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    }), { ts: Date.parse('2026-06-16T00:00:03.000Z') });

    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(out).toContain('1. click @9 — failed in 12ms');
    expect(out).toContain('Failure: dom-rewrite');
    expect(out).toContain('Next: cdp perceive ABC123 -C -d 8');
  });

  it('writes compact action events to the per-target session log', () => {
    const logPath = resolve(tmpdir(), `cdp-session-log-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1', logPath });

    try {
      T.appendSessionActionLog(state, sampleActionResult(), { ts: Date.parse('2026-06-16T00:00:03.000Z') });
      const [line] = readFileSync(logPath, 'utf8').trim().split('\n');
      const event = JSON.parse(line);

      expect(event.schema).toBe('chrome-cdp-ex.session-event.v1');
      expect(event.kind).toBe('action');
      expect(event.targetId).toBe('ABC123');
      expect(event.action.action).toBe('click');
      expect(event.action.effectSummary).toBe('+++ Added (1):');
      expect(event.action.effectSample).toContain('戰鬥勝利');
      expect(event.action.domDiff).toBeUndefined();
    } finally {
      rmSync(logPath, { force: true });
    }
  });

  it('initializes the per-target session log with a session-start event', () => {
    const logPath = resolve(tmpdir(), `cdp-session-start-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1', logPath });

    try {
      T.initializeSessionLog(state, { ts: Date.parse('2026-06-16T00:00:00.000Z') });
      const [line] = readFileSync(logPath, 'utf8').trim().split('\n');
      const event = JSON.parse(line);

      expect(event.schema).toBe('chrome-cdp-ex.session-event.v1');
      expect(event.kind).toBe('session-start');
      expect(event.targetId).toBe('ABC123');
      expect(event.sessionId).toBe('sid-1');
      expect(event.ts).toBe(Date.parse('2026-06-16T00:00:00.000Z'));
    } finally {
      rmSync(logPath, { force: true });
    }
  });

  it('registers screenshot attachments and shows them in the report', () => {
    const state = T.createSessionState({
      targetId: 'ABC123',
      sessionId: 'sid-1',
      screenshotDir: '/tmp/cdp-session-shots-ABC123',
    });
    const entry = T.appendSessionScreenshot(state, {
      kind: 'shot',
      path: '/tmp/cdp-session-shots-ABC123/shot-001.png',
      note: 'viewport',
      ts: Date.parse('2026-06-16T00:00:04.000Z'),
    });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(entry.path).toBe('/tmp/cdp-session-shots-ABC123/shot-001.png');
    expect(state.screenshots).toHaveLength(1);
    expect(out).toContain('Screenshots: 1');
    expect(out).toContain('Attachments:');
    expect(out).toContain('shot — /tmp/cdp-session-shots-ABC123/shot-001.png');
  });

  it('builds default screenshot paths inside the session screenshot directory', () => {
    const state = T.createSessionState({
      targetId: 'ABC123',
      sessionId: 'sid-1',
      screenshotDir: '/tmp/cdp-session-shots-ABC123',
    });

    expect(T.nextSessionScreenshotPath(state, 'shot')).toBe(resolve('/tmp/cdp-session-shots-ABC123', 'shot-001.png'));
    T.appendSessionScreenshot(state, { kind: 'shot', path: '/tmp/cdp-session-shots-ABC123/shot-001.png' });
    expect(T.nextSessionScreenshotPath(state, 'shot')).toBe(resolve('/tmp/cdp-session-shots-ABC123', 'shot-002.png'));
  });

  it('builds a record-actions JSON model from the session action log', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: {
        input: '#combat',
        resolvedBy: 'selector',
        label: '#combat',
        commandArgs: ['#combat'],
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), { ts: Date.parse('2026-06-16T00:00:03.000Z') });

    const model = T.buildRecordActionsModel(state);

    expect(model.schema).toBe('chrome-cdp-ex.record-actions.v1');
    expect(model.targetId).toBe('ABC123');
    expect(model.actions).toHaveLength(1);
    expect(model.actions[0]).toMatchObject({
      index: 1,
      action: 'click',
      command: ['click', '#combat'],
      replayable: true,
      evidence: {
        settleOk: true,
        settleDurationMs: 123,
        effectSummary: '+++ Added (1):',
        verdict: {
          schema: 'chrome-cdp-ex.action-verdict.v1',
          status: 'continue',
          canContinue: true,
          needsRecovery: false,
        },
      },
    });
  });

  it('includes reusable environment controls in record-actions artifacts', async () => {
    const cdp = createMockCDP({
      'Page.addScriptToEvaluateOnNewDocument': () => ({ identifier: 'clock-script-1' }),
      'Runtime.evaluate': () => ({ result: { value: { ok: true } } }),
    });
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    await T.mockStr(cdp, 'sid-1', state, ['add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json']);
    await T.throttleStr(cdp, 'sid-1', state, ['custom', '--latency', '120', '--download', '256', '--upload', '128']);
    await T.clockStr(cdp, 'sid-1', state, ['freeze', '--at', '2020-01-02T03:04:05.000Z']);

    const model = T.buildRecordActionsModel(state);
    const out = T.formatRecordActions(state);

    expect(model.environmentCount).toBe(3);
    expect(model.environment.map(entry => entry.type)).toEqual(['mock', 'throttle', 'clock']);
    expect(model.environment[0]).toMatchObject({
      index: 1,
      type: 'mock',
      action: 'add',
      replayable: true,
      command: ['mock', 'add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json'],
    });
    expect(model.environment[1]).toMatchObject({
      index: 2,
      type: 'throttle',
      action: 'apply',
      command: ['throttle', 'custom', '--latency', '120', '--download', '256', '--upload', '128'],
    });
    expect(model.environment[2]).toMatchObject({
      index: 3,
      type: 'clock',
      action: 'apply',
      command: ['clock', 'freeze', '--at', '2020-01-02T03:04:05.000Z'],
    });
    expect(out).toContain('Environment controls: 3');
    expect(out).toContain('Env 1. mock add **/api/fail* --status 503 --body "{\\"ok\\":false}" --content-type application/json — replayable');
  });

  it('formats record-actions text with replay drafts and honest gaps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: { input: '#cmd', resolvedBy: 'selector', label: '#cmd' },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: false, durationMs: 900 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatRecordActions(state);

    expect(out).toContain('Recorded actions: 2');
    expect(out).toContain('1. click #combat — replayable');
    expect(out).toContain('Replay: click #combat');
    expect(out).toContain('Evidence: +++ Added (1):');
    expect(out).toContain('Verdict: continue');
    expect(out).toContain('2. fill #cmd — needs input');
    expect(out).toContain('Replay: fill #cmd <text>');
  });

  it('includes diagnostic evidence in record-actions artifacts', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: {
        count: 1,
        errors: 0,
        warnings: 1,
        entries: [{ level: 'warning', text: 'animation fallback used', loc: '' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    }));

    const model = T.buildRecordActionsModel(state);
    const out = T.formatRecordActions(state);

    expect(model.actions[0].evidence.consoleSummary).toBe('Console: 1 entry (1 warning)');
    expect(model.actions[0].evidence.networkSummary).toBe('Network: 1 request (1 failed)');
    expect(out).toContain('Console: 1 entry (1 warning)');
    expect(out).toContain('Network sample: POST /api/combat -> 500 in 27ms');
  });

  it('keeps failed dispatches as diagnostic evidence but not replayable steps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const failure = T.classifyActionFailure(
      new Error('Element not found: #missing'),
      { action: 'click', target: { targetId: 'ABC123', input: '#missing' } }
    );
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: {
        input: '#missing',
        resolvedBy: 'selector',
        label: '#missing',
        commandArgs: ['#missing'],
      },
      dispatch: { ok: false, method: 'click', error: failure.originalMessage },
      settle: { ok: false, durationMs: 12 },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    }));

    const model = T.buildRecordActionsModel(state);
    const out = T.formatRecordActions(state);

    expect(model.actions[0]).toMatchObject({
      action: 'click',
      command: ['click', '#missing'],
      replayable: false,
      needsInput: ['successful-dispatch'],
      evidence: {
        failure: { kind: 'selector' },
        nextHint: 'cdp perceive ABC123 -C -d 8',
      },
    });
    expect(out).toContain('1. click #missing — needs input');
    expect(out).toContain('Missing: successful-dispatch');
    expect(out).toContain('Failure: selector');
  });

  it('formats record-actions JSON for scripting', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'nav',
      target: { input: 'https://example.com', resolvedBy: 'url', label: 'https://example.com', commandArgs: ['https://example.com'] },
      dispatch: { ok: true, method: 'nav' },
      settle: { ok: true, durationMs: 300 },
      effects: { domDiff: 'Page changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const parsed = JSON.parse(T.formatRecordActions(state, { format: 'json' }));

    expect(parsed.schema).toBe('chrome-cdp-ex.record-actions.v1');
    expect(parsed.actions[0].command).toEqual(['nav', 'https://example.com']);
  });

  it('exports replayable actions as a Playwright spec with honest gaps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'nav',
      target: { input: 'https://example.com/dashboard', resolvedBy: 'url', label: 'dashboard', commandArgs: ['https://example.com/dashboard'] },
      dispatch: { ok: true, method: 'nav' },
      settle: { ok: true, durationMs: 300 },
      effects: { domDiff: 'Page changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: { input: '#cmd', resolvedBy: 'selector', label: '#cmd', commandArgs: ['#cmd', 'look trainer'] },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '~~~ Text nodes updated (1 added)\n+   [StaticText] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '@1', resolvedBy: 'ref', label: '@1', commandArgs: ['@1'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 60 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out).toContain("import { test, expect } from '@playwright/test';");
    expect(out).toContain("test('chrome-cdp-ex exported workflow'");
    expect(out).toContain('await page.goto("https://example.com/dashboard");');
    expect(out).toContain('await page.locator("#cmd").fill("look trainer");');
    expect(out).toContain('await page.locator("#combat").click();');
    expect(out).toContain('await expect(page.getByText("戰鬥勝利")).toBeVisible();');
    expect(out).toContain('Not exported: click @1');
    expect(out).toContain('needs stable selector');
  });

  it('exports a structured Playwright handoff with spec and review counts', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.environmentLog.push({
      ts: Date.parse('2026-06-16T00:00:01.000Z'),
      kind: 'mock',
      action: 'add',
      rule: {
        urlPattern: '**/api/fail*',
        status: 503,
        body: '{"ok":false}',
        contentType: 'application/json',
      },
    });
    state.environmentLog.push({
      ts: Date.parse('2026-06-16T00:00:02.000Z'),
      kind: 'clock',
      action: 'apply',
      clock: { profile: 'freeze', atMs: Date.parse('2020-01-02T03:04:05.000Z'), offsetMs: 0 },
    });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'nav',
      target: { input: 'https://example.com/dashboard', resolvedBy: 'url', label: 'dashboard', commandArgs: ['https://example.com/dashboard'] },
      dispatch: { ok: true, method: 'nav' },
      settle: { ok: true, durationMs: 300 },
      effects: { domDiff: 'Page changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '@1', resolvedBy: 'ref', label: '@1', commandArgs: ['@1'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 60 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const parsed = JSON.parse(T.formatExportPlaywright(state, { format: 'json', title: 'exported smoke' }));

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.export-playwright.v1',
      targetId: 'ABC123',
      sessionId: 'sid-1',
      title: 'exported smoke',
      counts: {
        environment: 2,
        environmentExported: 1,
        environmentSkipped: 1,
        actions: 3,
        actionsExported: 2,
        actionsSkipped: 1,
        assertions: 1,
      },
      nextSteps: [
        'Review skipped steps and auth state before committing the Playwright spec.',
        'cdp record-actions ABC123 --format json',
        'cdp report ABC123 --format json',
      ],
    });
    expect(parsed.spec).toContain("test('exported smoke'");
    expect(parsed.spec).toContain('await page.route("**/api/fail*"');
    expect(parsed.spec).toContain('await page.goto("https://example.com/dashboard");');
    expect(parsed.spec).toContain('await expect(page.getByText("戰鬥勝利")).toBeVisible();');
    expect(parsed.review).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'environment', index: 2, exported: false, reason: 'chrome-cdp-ex live clock override has no portable exporter step yet' }),
      expect.objectContaining({ phase: 'action', index: 3, exported: false, reason: 'needs stable selector; chrome-cdp-ex @refs are session-local' }),
    ]));
  });

  it('keeps workflow artifacts ordered and honest across record, replay, and export', async () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.environmentLog.push({
      ts: Date.parse('2026-06-16T00:00:01.000Z'),
      kind: 'mock',
      action: 'add',
      rule: {
        urlPattern: '**/api/flaky*',
        status: 503,
        body: '{"ok":false}',
        contentType: 'application/json',
      },
    });
    state.environmentLog.push({
      ts: Date.parse('2026-06-16T00:00:02.000Z'),
      kind: 'throttle',
      action: 'apply',
      throttle: { profile: 'custom', latencyMs: 120, downloadKbps: 256, uploadKbps: 128 },
    });
    state.environmentLog.push({
      ts: Date.parse('2026-06-16T00:00:03.000Z'),
      kind: 'clock',
      action: 'apply',
      clock: { profile: 'freeze', atMs: Date.parse('2020-01-02T03:04:05.000Z'), offsetMs: 0 },
    });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'dismiss-modal',
      target: { input: 'dialog', resolvedBy: 'selector', label: 'dialog', commandArgs: [] },
      dispatch: { ok: true, method: 'dismiss-modal' },
      settle: { ok: true, durationMs: 50 },
      effects: { domDiff: 'modal dismissed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: { input: '#email', resolvedBy: 'selector', label: '#email', commandArgs: ['#email', 'agent@example.test'] },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#submit', resolvedBy: 'selector', label: '#submit', commandArgs: ['#submit'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] Upload complete', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'upload',
      target: { input: '#avatar', resolvedBy: 'selector', label: '#avatar', commandArgs: ['#avatar', '<redacted>'] },
      dispatch: { ok: true, method: 'upload' },
      settle: { ok: true, durationMs: 180 },
      effects: { domDiff: 'file input changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'diff-shot',
      target: { input: '#preview', resolvedBy: 'selector', label: '#preview', commandName: 'diff-shot', commandArgs: ['#preview'] },
      dispatch: { ok: true, method: 'diff-shot' },
      settle: { ok: true, durationMs: 220 },
      effects: { domDiff: 'pixel diff captured', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionScreenshot(state, {
      kind: 'diff-shot',
      path: '/tmp/chrome-cdp-ex/screens-ABC123/diff-shot-001.png',
      note: 'visual baseline changed',
    });

    const record = T.buildRecordActionsModel(state);

    expect(record.environment.map(entry => entry.type)).toEqual(['mock', 'throttle', 'clock']);
    expect(record.actions.map(action => action.action)).toEqual(['dismiss-modal', 'fill', 'click', 'upload', 'diff-shot']);
    expect(record.actions[3]).toMatchObject({
      action: 'upload',
      command: ['upload', '#avatar', '<redacted>'],
      replayable: false,
      needsInput: ['file'],
    });
    expect(record.actions[4]).toMatchObject({
      action: 'diff-shot',
      command: ['diff-shot', '#preview'],
      replayable: false,
      needsInput: ['live-visual-baseline'],
    });
    expect(Buffer.byteLength(JSON.stringify(record), 'utf8')).toBeLessThan(64 * 1024);

    const calls = [];
    const replay = JSON.parse(await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        if (step.cmd === 'click' && step.args[0] === '#submit') {
          return { ok: false, error: 'Action failure: selector\nNext: cdp perceive ABC123 -C -d 8' };
        }
        return { ok: true, result: `${step.cmd} ok` };
      },
    }, ['--continue', '--format', 'json', '--json', JSON.stringify(record)]));

    expect(calls.slice(0, 3)).toEqual([
      { cmd: 'mock', args: ['add', '**/api/flaky*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json'] },
      { cmd: 'throttle', args: ['custom', '--latency', '120', '--download', '256', '--upload', '128'] },
      { cmd: 'clock', args: ['freeze', '--at', '2020-01-02T03:04:05.000Z'] },
    ]);
    expect(replay).toMatchObject({
      schema: 'chrome-cdp-ex.replay.v1',
      continueOnError: true,
      halted: false,
      counts: {
        environment: 3,
        actions: 5,
        total: 8,
        ok: 5,
        failed: 1,
        skipped: 2,
      },
      failedStep: {
        phase: 'action',
        index: 3,
        commandText: 'click #submit',
        error: 'Action failure: selector\nNext: cdp perceive ABC123 -C -d 8',
      },
      nextSteps: [
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
    expect(replay.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'action', index: 4, skipped: true, missing: ['file'] }),
      expect.objectContaining({ phase: 'action', index: 5, skipped: true, missing: ['live-visual-baseline'] }),
    ]));

    const exported = JSON.parse(T.formatExportPlaywright(state, { format: 'json', title: 'workflow artifact' }));

    expect(exported).toMatchObject({
      schema: 'chrome-cdp-ex.export-playwright.v1',
      counts: {
        environment: 3,
        environmentExported: 1,
        environmentSkipped: 2,
        actions: 5,
        actionsExported: 3,
        actionsSkipped: 2,
        assertions: 1,
      },
    });
    expect(exported.spec).toContain('await page.route("**/api/flaky*"');
    expect(exported.spec).toContain('await page.locator("#email").fill("agent@example.test");');
    expect(exported.spec).toContain('await page.locator("#submit").click();');
    expect(exported.spec).toContain('await expect(page.getByText("Upload complete")).toBeVisible();');
    expect(exported.review).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'environment', index: 2, reason: 'chrome-cdp-ex live network throttling has no portable exporter step yet' }),
      expect.objectContaining({ phase: 'environment', index: 3, reason: 'chrome-cdp-ex live clock override has no portable exporter step yet' }),
      expect.objectContaining({ phase: 'action', index: 4, reason: 'not replayable; missing file' }),
      expect.objectContaining({ phase: 'action', index: 5, reason: 'not replayable; missing live-visual-baseline' }),
    ]));
  });

  it('exports observed text additions as Playwright assertions', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#save', resolvedBy: 'selector', label: '#save', commandArgs: ['#save'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] Saved successfully', console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out).toContain("import { test, expect } from '@playwright/test';");
    expect(out).toContain('await page.locator("#save").click();');
    expect(out).toContain('await expect(page.getByText("Saved successfully")).toBeVisible();');
    expect(out.indexOf('await page.locator("#save").click();')).toBeLessThan(
      out.indexOf('await expect(page.getByText("Saved successfully")).toBeVisible();')
    );
  });

  it('prefers high-signal observed text when exporting Playwright assertions', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: {
        domDiff: [
          '~~~ Text nodes updated (3 added)',
          '+   [StaticText] 戰鬥開始',
          '+   [StaticText] 攻擊命中',
          '+   [StaticText] 戰鬥勝利',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out).toContain('await expect(page.getByText("戰鬥勝利")).toBeVisible();');
    expect(out).not.toContain('await expect(page.getByText("戰鬥開始")).toBeVisible();');
  });

  it('exports portable network mocks before Playwright action steps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.environmentLog.push({
      ts: Date.parse('2026-06-16T00:00:01.000Z'),
      kind: 'mock',
      action: 'add',
      rule: {
        urlPattern: '**/api/fail*',
        status: 503,
        body: '{"ok":false}',
        contentType: 'application/json',
      },
    });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: 'Page changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out.indexOf('await page.route("**/api/fail*"')).toBeLessThan(out.indexOf('await page.locator("#combat").click();'));
    expect(out).toContain('route.fulfill({ status: 503, contentType: "application/json", body: "{\\"ok\\":false}" })');
  });

  it('exports react fill actions without treating the flag as a selector', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: { input: '#cmd', resolvedBy: 'selector', label: '#cmd', commandArgs: ['--react', '#cmd', 'look trainer'] },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out).toContain('await page.locator("#cmd").fill("look trainer");');
    expect(out).not.toContain('page.locator("--react")');
  });

  it('redacts sensitive fill values before recording action artifacts', () => {
    const logPath = resolve(tmpdir(), `cdp-sensitive-action-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1', logPath });

    try {
      T.appendSessionActionLog(state, T.createActionResult({
        action: 'fill',
        target: {
          input: '#password',
          resolvedBy: 'selector',
          label: '#password',
          commandArgs: ['#password', 'secret123'],
        },
        dispatch: { ok: true, method: 'fill' },
        settle: { ok: true, durationMs: 50 },
        effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
        nextHint: null,
      }));

      const model = T.buildRecordActionsModel(state);
      const logText = readFileSync(logPath, 'utf8');

      expect(model.actions[0].command).toEqual(['fill', '#password', '<redacted>']);
      expect(model.actions[0].replayable).toBe(false);
      expect(model.actions[0].needsInput).toEqual(['text']);
      expect(logText).not.toContain('secret123');
      expect(logText).toContain('<redacted>');
    } finally {
      rmSync(logPath, { force: true });
    }
  });

  it('redacts sentinel secrets from report, record, export, and JSONL artifacts', () => {
    const logPath = resolve(tmpdir(), `cdp-sensitive-artifacts-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1', logPath });
    const sentinels = [
      'pw-sentinel-123',
      'console-sentinel-456',
      'api-sentinel-789',
      'dom-sentinel-abc',
    ];

    try {
      const actionResult = T.applyActionObservationDelta(T.createActionResult({
        action: 'fill',
        target: {
          input: '#password',
          resolvedBy: 'selector',
          label: '#password',
          commandArgs: ['#password', 'pw-sentinel-123'],
        },
        dispatch: { ok: true, method: 'fill' },
        settle: { ok: true, durationMs: 50 },
        effects: {
          domDiff: '+++ Added (1):\n+   [status] token=dom-sentinel-abc saved',
          console: [],
          network: [],
          navigation: null,
        },
        nextHint: null,
      }), {
        console: {
          count: 1,
          errors: 1,
          warnings: 0,
          entries: [{ level: 'error', text: 'Authorization: Bearer console-sentinel-456', loc: 'auth.js:1' }],
        },
        exceptions: { count: 0, entries: [] },
        network: {
          count: 1,
          failures: 1,
          pending: 0,
          entries: [{ method: 'POST', url: 'https://example.com/api/login?api_key=api-sentinel-789', status: 401, duration: 27 }],
        },
      });
      T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });

      const artifacts = [
        T.formatSessionReport(state),
        T.formatSessionReport(state, { format: 'json' }),
        T.formatRecordActions(state),
        T.formatRecordActions(state, { format: 'json' }),
        T.formatExportPlaywright(state),
        T.formatExportPlaywright(state, { format: 'json' }),
        readFileSync(logPath, 'utf8'),
      ];

      for (const artifact of artifacts) {
        for (const sentinel of sentinels) {
          expect(artifact).not.toContain(sentinel);
        }
      }
      expect(artifacts.join('\n')).toContain('<redacted>');
    } finally {
      rmSync(logPath, { force: true });
    }
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================

