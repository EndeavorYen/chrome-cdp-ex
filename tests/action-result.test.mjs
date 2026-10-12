import { describe, it, expect } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer } = T;

// =========================================================================
// ActionResult
// =========================================================================

describe('ActionResult', () => {
  it('creates versioned action evidence', () => {
    const result = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: 'button disabled', console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    expect(result.schema).toBe('chrome-cdp-ex.action.v1');
    expect(result.action).toBe('click');
    expect(result.dispatch.ok).toBe(true);
    expect(result.outcome).toMatchObject({
      schema: 'chrome-cdp-ex.action-outcome.v1',
      status: 'changed',
      changed: true,
      needsAttention: false,
      evidence: 'dom',
    });
    expect(result.verdict).toMatchObject({
      schema: 'chrome-cdp-ex.action-verdict.v1',
      status: 'continue',
      confidence: 'medium',
      canContinue: true,
      needsRecovery: false,
      source: 'outcome',
      primaryNextStep: 'cdp report ABC123 --format json',
      nextSteps: [
        'cdp report ABC123 --format json',
        'cdp record-actions ABC123 --format json',
      ],
    });
    expect(result.recommendation).toMatchObject({
      source: 'action-evidence',
      strategy: 'continue-from-evidence',
      action: 'click',
      targetPrefix: 'ABC123',
      commands: [
        'cdp report ABC123 --format json',
        'cdp record-actions ABC123 --format json',
      ],
      optionalCommands: ['cdp perceive ABC123 --since-action'],
    });
    expect(result.nextSteps).toEqual([
      'cdp report ABC123 --format json',
      'cdp record-actions ABC123 --format json',
    ]);
  });

  it('creates an action receipt that separates dispatch, settlement, delta, and recovery', () => {
    const result = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 120 },
      effects: {
        domDiff: '+++ Added\n+   [StaticText] Saved',
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });

    expect(result.receipt).toMatchObject({
      schema: 'chrome-cdp-ex.action-receipt.v1',
      actionName: 'click',
      targetSummary: 'Submit',
      dispatch: {
        ok: true,
        method: 'Input.dispatchMouseEvent',
      },
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
      observedDelta: [
        'DOM changed after action',
        'DOM sample: +   [StaticText] Saved',
        'Console unchanged',
        'Exceptions unchanged',
        'Network unchanged',
      ],
      observedDeltaDetails: [
        {
          type: 'dom',
          status: 'changed',
          summary: 'DOM changed after action',
          sample: '+   [StaticText] Saved',
        },
        {
          type: 'console',
          status: 'unchanged',
          count: 0,
          errors: 0,
          warnings: 0,
          summary: 'Console unchanged',
        },
        {
          type: 'exception',
          status: 'unchanged',
          count: 0,
          summary: 'Exceptions unchanged',
        },
        {
          type: 'network',
          status: 'unchanged',
          count: 0,
          failures: 0,
          pending: 0,
          summary: 'Network unchanged',
        },
      ],
      blockingSignals: [],
      recoveryHint: 'Continue from the observed action evidence.',
      nextSteps: [
        'cdp report ABC123 --format json',
        'cdp record-actions ABC123 --format json',
      ],
    });
    expect(result.receipt.actionId).toMatch(/^act_[0-9a-f]{12}$/);
    expect(result.receipt.recovery).toMatchObject({
      strategy: 'continue-from-evidence',
      priority: 'medium',
    });
  });

  it('makes settlement semantics explicit for failed, timeout, observation-error, and report-only actions', () => {
    const failed = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '@99', resolvedBy: 'ref', label: '@99' },
      dispatch: { ok: false, method: 'click', error: 'Unknown ref @99' },
      settle: { ok: false, durationMs: 12 },
      effects: { domDiff: null, failure: { kind: 'stale-ref', reason: 'Unknown ref @99' } },
      nextHint: 'cdp perceive ABC123 -C -d 8',
    });
    expect(failed.receipt.settlement).toMatchObject({
      ok: false,
      state: 'failed',
      strategy: 'dispatch-failed',
      durationMs: 12,
      signals: ['dispatch-failed'],
      reason: 'Action failed before dispatch completed.',
    });

    const timeout = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: false, durationMs: 2000, timeoutMs: 2000 },
      effects: { domDiff: null, consoleDelta: { count: 0, entries: [] } },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    expect(timeout.receipt.settlement).toMatchObject({
      ok: false,
      state: 'not-confirmed',
      strategy: 'timeout',
      durationMs: 2000,
      timeoutMs: 2000,
      observedChannels: ['console'],
      signals: ['settlement-timeout'],
      reason: 'Action dispatched, but post-action observation did not confirm settlement.',
    });

    const observationError = T.createActionResult({
      action: 'clickxy',
      target: { targetId: 'ABC123', input: '75,116', resolvedBy: 'coordinates', label: '75,116' },
      dispatch: { ok: true, method: 'clickxy' },
      settle: { ok: false, durationMs: 300 },
      effects: {
        domDiff: null,
        observationError: { name: 'TypeError', message: 'observer failed' },
      },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    expect(observationError.receipt.settlement).toMatchObject({
      ok: false,
      state: 'not-confirmed',
      strategy: 'observation-error',
      durationMs: 300,
      signals: ['observation-error'],
      reason: 'Action dispatched, but post-action observation failed.',
    });

    const reportOnly = T.createActionResult({
      action: 'restore',
      target: { targetId: 'ABC123', input: 'checkpoint', resolvedBy: 'artifact', label: 'checkpoint' },
      dispatch: { ok: true, method: 'restore' },
      settle: { ok: true, durationMs: 50 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: 'Use report for follow-up evidence',
    });
    expect(reportOnly.receipt.settlement).toMatchObject({
      ok: true,
      state: 'not-applicable',
      strategy: 'report-only',
      durationMs: 50,
      signals: ['report-only'],
      reason: 'Action dispatched without post-action DOM observation.',
    });
  });

  it('classifies no-change action outcomes without treating the diff text as a DOM change', () => {
    const result = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#refresh', resolvedBy: 'selector', label: 'Refresh' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 90 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });

    expect(result.outcome).toMatchObject({
      schema: 'chrome-cdp-ex.action-outcome.v1',
      status: 'no-change',
      changed: false,
      needsAttention: true,
      evidence: 'dom',
    });
    expect(result.recommendation).toMatchObject({
      source: 'action-outcome',
      strategy: 'investigate-no-change',
      outcomeStatus: 'no-change',
      verifyCommand: 'cdp perceive ABC123 -C -d 8',
      commands: [
        'cdp overlay ABC123 "#refresh" --format json',
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
    expect(result.nextSteps).toEqual([
      'cdp overlay ABC123 "#refresh" --format json',
      'cdp perceive ABC123 -C -d 8',
      'cdp report ABC123 --format json',
    ]);
    expect(result.verdict).toMatchObject({
      schema: 'chrome-cdp-ex.action-verdict.v1',
      status: 'investigate',
      confidence: 'medium',
      canContinue: false,
      needsRecovery: true,
      source: 'outcome',
      primaryNextStep: 'cdp overlay ABC123 "#refresh" --format json',
      nextSteps: [
        'cdp overlay ABC123 "#refresh" --format json',
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
    expect(result.effects.diagnosis).toBeUndefined();
    expect(T.formatActionText(result)).toContain('Verdict: investigate');
    expect(T.formatActionText(result)).toContain('Next: cdp overlay ABC123 "#refresh" --format json');
  });

  it('uses receipt blocking signals and recovery hint for no-change actions', () => {
    const result = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#refresh', resolvedBy: 'selector', label: 'Refresh' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 90 },
      effects: {
        domDiff: '(no changes detected in AX tree)',
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });

    expect(result.receipt).toMatchObject({
      schema: 'chrome-cdp-ex.action-receipt.v1',
      outcome: 'no-change',
      observedDelta: [
        'No visible AX tree change observed',
        'Console unchanged',
        'Exceptions unchanged',
        'Network unchanged',
      ],
      blockingSignals: [
        'overlay-check-needed',
        'fresh-perception-needed',
      ],
      recoveryHint: 'Action dispatched but produced no visible AX tree change; inspect overlays and fresh refs before retrying.',
      nextSteps: [
        'cdp overlay ABC123 "#refresh" --format json',
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
    expect(T.formatActionText(result)).toContain('Receipt: no-change');
    expect(T.formatActionText(result)).toContain('Blocking signals: overlay-check-needed, fresh-perception-needed');
    expect(T.formatActionText(result)).toContain('Recovery hint: Action dispatched but produced no visible AX tree change');
  });

  it('adds frame recovery only when no-change evidence is frame scoped', () => {
    const result = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '@f2:4', resolvedBy: 'frame-ref', label: 'Pay now', frameRef: '@f2' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 90 },
      effects: {
        domDiff: '(no changes detected in AX tree)',
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });

    expect(result.receipt.blockingSignals).toEqual([
      'overlay-check-needed',
      'frame-check-needed',
      'fresh-perception-needed',
    ]);
    expect(result.nextSteps).toEqual([
      'cdp overlay ABC123 @f2:4 --format json',
      'cdp frame ABC123 --format json',
      'cdp perceive ABC123 -C -d 8',
      'cdp report ABC123 --format json',
    ]);
  });

  it('formats action evidence as compact text', () => {
    const text = T.formatActionText(T.createActionResult({
      action: 'fill',
      target: { input: '#email', resolvedBy: 'selector', label: 'Email' },
      dispatch: { ok: true, method: 'Input.insertText' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: 'Continue with the next form field',
    }));
    expect(text).toMatch(/fill/i);
    expect(text).toContain('Outcome: changed');
    expect(text).toMatch(/value changed/);
  });

  it('builds and formats console, exception, and network deltas since action dispatch', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const netReqBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'log', text: 'before action', loc: 'app.js:1', ts: 1 });
    netReqBuf.push({ method: 'GET', url: 'https://example.com/before', status: 200, duration: 9, ts: 1 });
    const baseline = T.createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf });

    consoleBuf.push({ level: 'warning', text: 'deprecated API', loc: 'app.js:10', ts: 2 });
    consoleBuf.push({ level: 'error', text: 'save failed', loc: 'app.js:11', ts: 3 });
    exceptionBuf.push({ msg: 'Error: render exploded', loc: 'app.js:12', ts: 4 });
    netReqBuf.push({ method: 'GET', url: 'https://example.com/ok', status: 200, duration: 12, ts: 5 });
    netReqBuf.push({ method: 'POST', url: 'https://example.com/api/save?draft=1', status: 500, duration: 31, ts: 6 });

    const delta = T.buildActionObservationDelta({ consoleBuf, exceptionBuf, netReqBuf }, baseline);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 150 },
      effects: { domDiff: 'Saved banner appeared', console: [], network: [], navigation: null },
      nextHint: null,
    }), delta);
    const text = T.formatActionText(result);

    expect(delta.console).toMatchObject({ count: 2, errors: 1, warnings: 1 });
    expect(delta.exceptions).toMatchObject({ count: 1 });
    expect(delta.network).toMatchObject({ count: 2, failures: 1 });
    expect(text).toContain('Console: 2 entries (1 error, 1 warning)');
    expect(text).toContain('Console sample: [error] save failed @ app.js:11');
    expect(text).toContain('Exception: 1 thrown');
    expect(text).toContain('Network: 2 requests (1 failed)');
    expect(text).toContain('Network sample: POST /api/save?draft=1 -> 500 in 31ms');
  });

  it('tracks action-relevant network request types while skipping static assets', () => {
    expect(T.shouldTrackActionNetworkRequest('Fetch')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('XHR')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('Document')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('Other')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest(undefined)).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('Image')).toBe(false);
    expect(T.shouldTrackActionNetworkRequest('Script')).toBe(false);
    expect(T.shouldTrackActionNetworkRequest('Stylesheet')).toBe(false);
  });

  it('formats pending network requests as action evidence', () => {
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { input: '#diagnostic', resolvedBy: 'selector', label: 'Diagnostic' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 1400 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 0,
        pending: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/fail', status: 'pending', duration: 1404, pending: true }],
      },
    });

    const text = T.formatActionText(result);

    expect(text).toContain('Network: 1 request (1 pending)');
    expect(text).toContain('Network sample: POST /api/fail -> pending in 1404ms');
  });

  it('wraps dispatch output with observed action evidence', async () => {
    let captured = null;
    const text = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: async () => 'Clicked @4',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'button disabled',
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toBe('Clicked @4. Next: cdp list');
    expect(text).not.toMatch(/click: dispatched/);
    expect(text).not.toMatch(/^Outcome:/m);
    expect(text).not.toMatch(/Receipt:/);
    expect(text).not.toMatch(/Verdict:/);
    expect(text).not.toMatch(/button disabled/);
    expect(captured.action).toBe('click');
    expect(captured.effects.domDiff).toBe('button disabled');
  });

  it('formats observed action evidence as JSON without dispatch text noise', async () => {
    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#submit', resolvedBy: 'selector', label: 'Submit' },
      dispatch: async () => 'Clicked #submit',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'checkout banner appeared',
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.action.v1',
      action: 'click',
      target: { input: '#submit', label: 'Submit' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true },
      effects: { domDiff: 'checkout banner appeared' },
      outcome: { status: 'changed', changed: true, needsAttention: false },
      verdict: {
        status: 'continue',
        canContinue: true,
        needsRecovery: false,
      },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    expect(out).not.toContain('Clicked #submit');
  });

  it('redacts sensitive values in JSON action handoffs', async () => {
    const out = await T.runActionWithFeedback({
      action: 'fill',
      target: {
        input: '#password',
        resolvedBy: 'selector',
        label: '#password',
        commandArgs: ['#password', 'pw-sentinel-123'],
      },
      dispatch: async () => 'Filled #password',
      feedbackPolicy: 'settle-diff',
      observe: async () => '+++ Added (2):\n+   [status] token=dom-sentinel-abc saved\n+   [option] saved password pw-sentinel-123',
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.schema).toBe('chrome-cdp-ex.fill.v1');
    expect(parsed.value).toBe('<redacted>');
    expect(parsed.typeahead).toEqual([]);
    expect(out).not.toContain('pw-sentinel-123');
    expect(out).not.toContain('dom-sentinel-abc');
    expect(out).toContain('<redacted>');
  });

  it('defaults fill JSON to a compact fill receipt under 1000 bytes (#162)', async () => {
    const diagnosisBlob = JSON.stringify({
      schema: 'chrome-cdp-ex.action-diagnosis.v1',
      status: 'ok',
      kind: 'ok',
      reason: 'synthetic diagnosis that must not appear in compact fill JSON',
      recovery: {
        schema: 'chrome-cdp-ex.recovery-policy.v1',
        strategy: 'continue-from-evidence',
        commands: Array.from({ length: 8 }, (_, i) => ({
          command: `cdp report ABC12345FULLTARGET --format json --step ${i}`,
        })),
      },
    });
    const typeaheadDiff = [
      '+++ Added (48):',
      '+   [textbox] Search = "MiniMax-H3-Turbo"  @1',
      '+   [listbox] Suggestions',
      '+   [link] larryvrh/MiniMax-H3-Turbo-Lora  @2',
      '+   [link] lightx2v/Minimax-h3-Turbo  @3',
      ...Array.from({ length: 40 }, (_, i) => `+   [StaticText] reroot noise ${i} ${diagnosisBlob.slice(0, 40)}`),
    ].join('\n');

    const out = await T.runActionWithFeedback({
      action: 'fill',
      target: {
        targetId: 'ABC12345FULLTARGET',
        input: '#search',
        resolvedBy: 'selector',
        label: 'Search',
        commandArgs: ['#search', 'MiniMax-H3-Turbo'],
      },
      dispatch: async () => 'Filled #search',
      feedbackPolicy: 'settle-diff',
      observe: async () => typeaheadDiff,
      enrichActionResult: (result) => {
        T.applyActionObservationDelta(result, {
          console: {
            count: 4,
            errors: 0,
            warnings: 0,
            entries: Array.from({ length: 4 }, (_, i) => ({
              level: 'log',
              text: `search debug ${i} ${diagnosisBlob.slice(0, 24)}`,
              loc: `app.js:${i}`,
            })),
          },
          exceptions: { count: 0, entries: [] },
          network: {
            count: 1,
            failures: 0,
            pending: 0,
            entries: [{
              method: 'GET',
              url: 'https://huggingface.co/api/models?search=MiniMax-H3-Turbo',
              status: 200,
              duration: 18,
            }],
          },
        });
        result.effects.diagnosis = JSON.parse(diagnosisBlob);
      },
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(Buffer.byteLength(out)).toBeLessThan(1000);
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.fill.v1',
      value: 'MiniMax-H3-Turbo',
      changed: true,
      navigation: null,
      typeahead: [
        'larryvrh/MiniMax-H3-Turbo-Lora',
        'lightx2v/Minimax-h3-Turbo',
      ],
      targetPrefix: 'ABC12345',
    });
    expect(parsed).not.toHaveProperty('diagnosis');
    expect(parsed).not.toHaveProperty('receipt');
    expect(parsed).not.toHaveProperty('verdict');
    expect(parsed).not.toHaveProperty('recommendation');
    expect(out).not.toContain('recovery-policy');
    expect(out).not.toContain('reroot noise');
  });

  it('extracts typeahead labels from fill network GET search and option nodes (#162)', async () => {
    const out = await T.runActionWithFeedback({
      action: 'fill',
      target: {
        targetId: 'ABC12345',
        input: '#q',
        resolvedBy: 'selector',
        label: 'q',
        commandArgs: ['#q', 'MiniMax'],
      },
      dispatch: async () => 'Filled #q',
      feedbackPolicy: 'settle-diff',
      observe: async () => [
        '+++ Added (3):',
        '+   [listbox] Results',
        '+   [option] org/model-one',
        '+   [listitem] org/model-two',
      ].join('\n'),
      enrichActionResult: (result) => {
        T.applyActionObservationDelta(result, {
          console: { count: 0, errors: 0, warnings: 0, entries: [] },
          exceptions: { count: 0, entries: [] },
          network: {
            count: 2,
            failures: 0,
            pending: 0,
            entries: [
              { method: 'GET', url: 'https://huggingface.co/api/models?search=MiniMax', status: 200, duration: 12 },
              { method: 'GET', url: 'https://huggingface.co/org/model-three', status: 200, duration: 9 },
            ],
          },
        });
      },
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.schema).toBe('chrome-cdp-ex.fill.v1');
    expect(parsed.typeahead).toEqual([
      'org/model-one',
      'org/model-two',
      'org/model-three',
    ]);
  });

  it('keeps the full action envelope for fill JSON --full (#162)', async () => {
    const out = await T.runActionWithFeedback({
      action: 'fill',
      target: {
        targetId: 'ABC12345',
        input: '#search',
        resolvedBy: 'selector',
        label: 'Search',
        commandArgs: ['#search', 'MiniMax-H3-Turbo'],
      },
      dispatch: async () => 'Filled #search',
      feedbackPolicy: 'settle-diff',
      observe: async () => '+++ Added (1):\n+   [link] org/model  @2',
      format: { format: 'json', full: true },
    });
    const parsed = JSON.parse(out);

    expect(parsed.schema).toBe('chrome-cdp-ex.action.v1');
    expect(parsed.action).toBe('fill');
    expect(parsed.dispatch?.ok).toBe(true);
    expect(parsed.receipt?.schema).toBe('chrome-cdp-ex.action-receipt.v1');
    expect(parsed.verdict).toBeTruthy();
    expect(parsed.nextSteps?.length).toBeGreaterThan(0);
  });

  it('keeps the action envelope when fill JSON observation times out (#162)', async () => {
    const err = new Error('Timeout: post-action perceive');
    err.name = 'TimeoutError';
    const out = await T.runActionWithFeedback({
      action: 'fill',
      target: {
        targetId: 'ABC12345',
        input: '#search',
        resolvedBy: 'selector',
        label: 'Search',
        commandArgs: ['#search', 'query'],
      },
      dispatch: async () => 'Filled #search',
      feedbackPolicy: 'settle-diff',
      observe: async () => { throw err; },
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.schema).toBe('chrome-cdp-ex.action.v1');
    expect(parsed.outcome.status).toBe('timeout');
    expect(parsed.settle.ok).toBe(false);
    expect(parsed.dispatch.ok).toBe(true);
    expect(out).toMatch(/perceive --since-action/);
  });

  it('compacts long DOM diff evidence in JSON action handoffs', async () => {
    const longDiff = [
      'Page: Very Large App',
      '+++ Added (1):',
      ...Array.from({ length: 180 }, (_, index) => `+   [StaticText] low signal row ${index}`),
      '+   [status] Saved successfully',
      'TAIL-SHOULD-NOT-BE-SERIALIZED',
    ].join('\n');

    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: async () => 'Clicked #save',
      feedbackPolicy: 'settle-diff',
      observe: async () => longDiff,
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.effects.domDiffChars).toBe(longDiff.length);
    expect(parsed.effects.domDiffTruncated).toBe(true);
    expect(parsed.effects.domDiffSummary).toBe('+++ Added (1):');
    expect(parsed.effects.domDiffSample).toBe('+   [status] Saved successfully');
    expect(parsed.effects.domDiff).toContain('+++ Added (1):');
    expect(parsed.effects.domDiff).toContain('[status] Saved successfully');
    expect(parsed.effects.domDiff.length).toBeLessThan(900);
    expect(out).not.toContain('TAIL-SHOULD-NOT-BE-SERIALIZED');
  });

  it('returns compact JSON action handoffs without dropping receipt evidence', async () => {
    const longDiff = [
      'Page: Very Large App',
      '+++ Added (1):',
      ...Array.from({ length: 120 }, (_, index) => `+   [StaticText] low signal row ${index}`),
      '+   [status] Saved successfully',
    ].join('\n');
    const options = {
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: async () => 'Clicked #save',
      feedbackPolicy: 'settle-diff',
      observe: async () => longDiff,
      enrichActionResult: (result) => {
        T.applyActionObservationDelta(result, {
          console: {
            count: 5,
            errors: 0,
            warnings: 0,
            entries: Array.from({ length: 5 }, (_, index) => ({
              level: 'log',
              text: `low signal console row ${index}`,
              loc: `app.js:${index + 1}`,
            })),
          },
          exceptions: { count: 0, entries: [] },
          network: {
            count: 5,
            failures: 0,
            pending: 0,
            entries: Array.from({ length: 5 }, (_, index) => ({
              method: 'GET',
              url: `https://example.com/api/row-${index}?cacheBust=${index}`,
              status: 200,
              duration: 10 + index,
            })),
          },
        });
        result.effects.pageHealth = {
          status: 'populated',
          isBlank: false,
          confidence: 'high',
          evidence: { changed: false, visibleTextLength: 2400, elementCount: 180 },
        };
      },
    };

    const fullOut = await T.runActionWithFeedback({ ...options, format: 'json' });
    const compactOut = await T.runActionWithFeedback({ ...options, format: { format: 'json', compact: true } });
    const parsed = JSON.parse(compactOut);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.action.v1',
      mode: 'compact',
      action: 'click',
      target: { input: '#save', label: 'Save', resolvedBy: 'selector' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true },
      outcome: { status: 'changed' },
      verdict: { status: 'continue', canContinue: true, needsRecovery: false },
      effects: {
        domDiffChars: longDiff.length,
        domDiffSummary: '+++ Added (1):',
        domDiffSample: '+   [status] Saved successfully',
      },
      receipt: {
        eventId: null,
        dispatch: { ok: true, method: 'click' },
        settlement: {
          state: 'settled',
          strategy: 'dom-observation',
          durationMs: expect.any(Number),
          signals: [],
        },
        observedDelta: expect.any(Array),
        observedDeltaDetails: expect.any(Array),
        blockingSignals: [],
        recoveryHint: 'Continue from the observed action evidence.',
        nextSteps: [
          'cdp report ABC123 --format json',
          'cdp record-actions ABC123 --format json',
        ],
      },
      nextSteps: [
        'cdp report ABC123 --format json',
        'cdp record-actions ABC123 --format json',
      ],
    });
    expect(parsed.effects).not.toHaveProperty('domDiff');
    expect(parsed.effects).not.toHaveProperty('pageHealth');
    expect(parsed.effects.consoleDelta).toMatchObject({ count: 5, errors: 0, warnings: 0 });
    expect(parsed.effects.networkDelta).toMatchObject({ count: 5, failures: 0, pending: 0 });
    expect(compactOut.length).toBeLessThan(fullOut.length);
    expect(compactOut).not.toContain('\n');
  });

  it('keeps actionable page-health evidence in compact JSON action handoffs', async () => {
    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: async () => 'Clicked #save',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'No changes detected',
      enrichActionResult: (result) => {
        result.effects.pageHealth = {
          status: 'blank',
          isBlank: true,
          confidence: 'high',
          evidence: {
            changed: true,
            readyState: 'complete',
            visibleTextLength: 0,
            elementCount: 3,
            visibleControlCount: 0,
            bodyRect: { width: 1280, height: 720 },
          },
        };
      },
      format: { format: 'json', compact: true },
    });

    expect(JSON.parse(out).effects.pageHealth).toEqual({
      status: 'blank',
      isBlank: true,
      confidence: 'high',
      evidence: {
        changed: true,
        readyState: 'complete',
        visibleTextLength: 0,
        elementCount: 3,
        visibleControlCount: 0,
        bodyRect: { width: 1280, height: 720 },
      },
    });
  });

  it('keeps a compact evidence marker when an action has no DOM diff', async () => {
    const out = await T.runActionWithFeedback({
      action: 'restore',
      target: { targetId: 'ABC123', input: 'checkpoint', resolvedBy: 'artifact', label: 'checkpoint' },
      dispatch: async () => 'Restored checkpoint',
      feedbackPolicy: 'report-only',
      format: { format: 'json', compact: true },
    });
    const parsed = JSON.parse(out);

    expect(parsed.effects).toHaveProperty('domDiff', null);
    expect(parsed.effects.domDiffSummary).toBe('DOM observation not captured');
    expect(parsed.effects.consoleDelta).toMatchObject({ count: 0 });
    expect(parsed.receipt).toMatchObject({
      settlement: {
        state: 'not-applicable',
        strategy: 'report-only',
        signals: ['report-only'],
      },
      observedDeltaDetails: expect.arrayContaining([
        expect.objectContaining({ type: 'dom', status: 'not-captured' }),
      ]),
    });
  });

  it('summarizes compact full-observation action evidence even without diff markers', async () => {
    const observation = 'Page: Example\n@1 [button] Continue';
    const out = await T.runActionWithFeedback({
      action: 'nav',
      target: { targetId: 'ABC123', input: 'https://example.com', resolvedBy: 'url', label: 'https://example.com' },
      dispatch: async () => 'Navigated',
      feedbackPolicy: 'full-perceive',
      observe: async () => observation,
      format: { format: 'json', compact: true },
    });
    const parsed = JSON.parse(out);

    expect(parsed.effects.domDiffChars).toBe(observation.length);
    expect(parsed.effects.domDiffSummary).toBe('DOM observation captured');
  });

  it('enriches action feedback before formatting and logging', async () => {
    const delta = {
      console: {
        count: 1,
        errors: 1,
        warnings: 0,
        entries: [{ level: 'error', text: 'submit failed', loc: 'checkout.js:20' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/checkout', status: 503, duration: 44 }],
      },
    };
    let captured = null;

    const text = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#submit', resolvedBy: 'selector', label: 'Submit' },
      dispatch: async () => 'Clicked #submit',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'checkout error banner',
      enrichActionResult: (result) => T.applyActionObservationDelta(result, delta),
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toBe('Clicked #submit. Next: cdp netlog <target>');
    expect(text).not.toMatch(/^Outcome:/m);
    expect(text).not.toMatch(/Console:/);
    expect(captured.effects.consoleDelta.errors).toBe(1);
    expect(captured.effects.networkDelta.failures).toBe(1);
  });

  it('adds a structured diagnosis when action evidence shows runtime trouble', async () => {
    const delta = {
      console: {
        count: 1,
        errors: 0,
        warnings: 1,
        entries: [{ level: 'warning', text: 'slow endpoint', loc: 'app.js:21' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/save', status: 500, duration: 44 }],
      },
    };

    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: async () => 'Clicked #save',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'error banner appeared',
      enrichActionResult: (result) => T.applyActionObservationDelta(result, delta),
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.effects.diagnosis).toMatchObject({
      schema: 'chrome-cdp-ex.action-diagnosis.v1',
      status: 'attention',
      kind: 'network-failure',
      confidence: 'high',
      source: 'network',
      nextCommand: 'cdp netlog ABC123',
      recovery: {
        schema: 'chrome-cdp-ex.recovery-policy.v1',
        strategy: 'inspect-network',
        priority: 'high',
        verifyCommand: 'cdp perceive ABC123 --since-action',
        commands: [
          { command: 'cdp netlog ABC123' },
          { command: 'cdp perceive ABC123 --since-action' },
          { command: 'cdp report ABC123 --format json' },
        ],
      },
      signals: {
        dispatchOk: true,
        settleOk: true,
        domChanged: true,
        consoleWarnings: 1,
        networkFailures: 1,
      },
    });
    expect(parsed.outcome).toMatchObject({
      status: 'attention',
      changed: true,
      needsAttention: true,
      evidence: 'network',
    });
    expect(parsed.verdict).toMatchObject({
      schema: 'chrome-cdp-ex.action-verdict.v1',
      status: 'recover',
      confidence: 'high',
      canContinue: false,
      needsRecovery: true,
      source: 'diagnosis',
      primaryNextStep: 'cdp netlog ABC123',
      nextSteps: [
        'cdp netlog ABC123',
        'cdp perceive ABC123 --since-action',
        'cdp report ABC123 --format json',
      ],
    });
    expect(T.formatActionText(parsed)).toContain('Diagnosis: network-failure');
    expect(T.formatActionText(parsed)).toContain('Verdict: recover');
    expect(T.formatActionText(parsed)).toContain('Next: cdp netlog ABC123');
    expect(parsed.recommendation).toMatchObject({
      source: 'action-diagnosis',
      strategy: 'inspect-network',
      diagnosisKind: 'network-failure',
      commands: [
        'cdp netlog ABC123',
        'cdp perceive ABC123 --since-action',
        'cdp report ABC123 --format json',
      ],
    });
    expect(parsed.nextSteps).toEqual([
      'cdp netlog ABC123',
      'cdp perceive ABC123 --since-action',
      'cdp report ABC123 --format json',
    ]);
    expect(parsed.receipt).toMatchObject({
      schema: 'chrome-cdp-ex.action-receipt.v1',
      dispatch: { ok: true },
      settlement: {
        ok: true,
        state: 'settled',
        strategy: 'dom-observation',
        signals: [],
      },
      observedDelta: expect.arrayContaining([
        'Console: 1 entry (1 warning)',
        'Network: 1 request (1 failed)',
      ]),
      observedDeltaDetails: expect.arrayContaining([
        expect.objectContaining({ type: 'console', status: 'changed' }),
        expect.objectContaining({ type: 'network', status: 'changed' }),
      ]),
      blockingSignals: expect.arrayContaining(['network-failure']),
      recoveryHint: 'The action triggered one or more failed network requests.',
      nextSteps: [
        'cdp netlog ABC123',
        'cdp perceive ABC123 --since-action',
        'cdp report ABC123 --format json',
      ],
    });
    expect(parsed.receipt.observedDeltaDetails).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'exception', status: 'unchanged' }),
    ]));
    expect(parsed.receipt).not.toHaveProperty('recovery');
  });

  it('records report-only actions as action evidence without a DOM observation', async () => {
    let captured = null;

    const text = await T.runActionWithFeedback({
      action: 'restore',
      target: { input: 'checkpoint', resolvedBy: 'artifact', label: 'checkpoint' },
      dispatch: async () => 'Restored checkpoint',
      feedbackPolicy: 'report-only',
      observe: async () => 'not reached',
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toContain('Restored checkpoint');
    expect(text).toContain('restore: dispatched');
    expect(captured.effects.domDiff).toBeNull();
    expect(captured.settle.ok).toBe(true);
  });

  it('returns timeout evidence with diagnostics when post-action observation times out', async () => {
    const err = new Error('Timeout: post-action perceive');
    err.name = 'TimeoutError';
    const delta = {
      console: { count: 1, errors: 0, warnings: 1, entries: [{ level: 'warning', text: 'slow rerender', loc: '' }] },
      exceptions: { count: 0, entries: [] },
      network: { count: 0, failures: 0, entries: [] },
    };
    let captured = null;

    const text = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: async () => 'Clicked #save',
      feedbackPolicy: 'settle-diff',
      observe: async () => { throw err; },
      enrichActionResult: (result) => T.applyActionObservationDelta(result, delta),
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toContain('success but observation timed out');
    expect(text).toMatch(/^Clicked #save\. Next: /);
    expect(text).not.toMatch(/Console:/);
    expect(captured.settle.ok).toBe(false);
    expect(captured.outcome).toMatchObject({
      status: 'timeout',
      needsAttention: true,
      evidence: 'settle',
    });
    expect(captured.effects.consoleDelta.warnings).toBe(1);
  });

  it('returns action evidence when post-action observation throws after dispatch', async () => {
    const err = new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.");
    let captured = null;

    const out = await T.runActionWithFeedback({
      action: 'clickxy',
      target: { targetId: 'ABC12345', input: '75,116', resolvedBy: 'coordinates', label: '75,116' },
      dispatch: async () => 'Clicked at 75,116',
      feedbackPolicy: 'settle-diff',
      observe: async () => { throw err; },
      format: 'json',
      onActionResult: (result) => { captured = result; },
    });
    const parsed = JSON.parse(out);

    expect(parsed.schema).toBe('chrome-cdp-ex.action.v1');
    expect(parsed.dispatch).toMatchObject({ ok: true, method: 'clickxy' });
    expect(parsed.settle.ok).toBe(false);
    expect(parsed.outcome).toMatchObject({
      status: 'attention',
      needsAttention: true,
      evidence: 'observation',
    });
    expect(parsed.effects.diagnosis).toMatchObject({
      status: 'attention',
      kind: 'observation-error',
      source: 'observation',
      nextCommand: 'cdp status ABC12345',
      recovery: {
        strategy: 'check-tab-health',
        commands: [
          { command: 'cdp status ABC12345' },
          { command: 'cdp perceive ABC12345 --since-action' },
          { command: 'cdp report ABC12345 --format json' },
        ],
      },
    });
    expect(parsed.nextSteps).toEqual([
      'cdp status ABC12345',
      'cdp perceive ABC12345 --since-action',
      'cdp report ABC12345 --format json',
    ]);
    expect(parsed.error).toBeUndefined();
    expect(captured.effects.observationError.message).toContain("Failed to execute 'observe'");
  });

  it('classifies action failures into recoverable next steps', () => {
    const overlay = T.classifyActionFailure(
      new Error('Element is not clickable at point (20, 30). Other element would receive the click'),
      { action: 'click', target: { targetId: 'abc123', input: '@4', label: 'Submit' } }
    );
    expect(overlay.kind).toBe('overlay');
    expect(overlay.nextCommand).toBe('cdp dismiss-modal abc123');
    expect(overlay.hints.join('\n')).toContain('cdp jsclick abc123 @4');

    const wrongFrame = T.classifyActionFailure(
      new Error('No frame for given id found'),
      { action: 'click', target: { targetId: 'abc123', input: '#pay' } }
    );
    expect(wrongFrame.kind).toBe('wrong-frame');
    expect(wrongFrame.nextCommand).toBe('cdp perceive abc123 -C -d 8');

    const navigation = T.classifyActionFailure(
      new Error('Cannot find context with specified id'),
      { action: 'fill', target: { targetId: 'abc123', input: '#email' } }
    );
    expect(navigation.kind).toBe('navigation');
    expect(navigation.nextCommand).toBe('cdp perceive abc123 -C -d 8');

    const domRewrite = T.classifyActionFailure(
      new Error('No node with given id'),
      { action: 'click', target: { targetId: 'abc123', input: '@9' } }
    );
    expect(domRewrite.kind).toBe('dom-rewrite');
    expect(domRewrite.nextCommand).toBe('cdp perceive abc123 -C -d 8');

    const timeout = T.classifyActionFailure(
      new Error('Timeout: Runtime.callFunctionOn'),
      { action: 'reload', target: { targetId: 'abc123', input: 'reload' } }
    );
    expect(timeout.kind).toBe('timeout');
    expect(timeout.nextCommand).toBe('cdp status abc123');
  });

  it('maps wrong-frame diagnoses to frame-aware recovery commands', () => {
    const recovery = T.buildActionRecoveryPlan({
      status: 'blocked',
      kind: 'wrong-frame',
      nextCommand: 'cdp perceive ABC123 -C -d 8',
    }, { targetId: 'ABC123' });

    expect(recovery).toMatchObject({
      schema: 'chrome-cdp-ex.recovery-policy.v1',
      strategy: 'refresh-frame-context',
      priority: 'high',
      commands: [
        { command: 'cdp frame ABC123 --format json' },
        { command: 'cdp perceive ABC123 -C -d 8' },
      ],
      verifyCommand: 'cdp perceive ABC123 -C -d 8',
    });
  });

  it('formats action failures without losing the original browser error', () => {
    const text = T.formatActionFailure(
      new Error('Element not found: #save'),
      { action: 'click', target: { targetId: 'abc123', input: '#save' } }
    );
    expect(text).toBe('Error: Element not found: #save\nKind: selector\nNext: cdp perceive abc123 -C -d 8');
    expect(text).not.toContain('Original:');
    expect(text).not.toContain('Reason:');
  });

  it('records failed dispatches as action evidence before returning a classified error', async () => {
    let captured = null;
    await expect(T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'abc123', input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: async () => {
        throw new Error('Element is not clickable at point (20, 30). Other element would receive the click');
      },
      feedbackPolicy: 'settle-diff',
      observe: async () => 'not reached',
      onActionResult: (result) => { captured = result; },
    })).rejects.toThrow(/Kind: overlay/);

    expect(captured.action).toBe('click');
    expect(captured.dispatch.ok).toBe(false);
    expect(captured.effects.failure.kind).toBe('overlay');
    expect(captured.nextHint).toBe('cdp dismiss-modal abc123');
  });

  it('returns classified failed dispatch evidence as JSON for agents', async () => {
    let captured = null;
    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'abc123', input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: async () => {
        throw new Error('Element is not clickable at point (20, 30). Other element would receive the click');
      },
      feedbackPolicy: 'settle-diff',
      observe: async () => 'not reached',
      format: 'json',
      onActionResult: (result) => { captured = result; },
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.action.v1',
      action: 'click',
      target: { input: '@4', label: 'Submit' },
      dispatch: {
        ok: false,
        method: 'click',
        error: 'Element is not clickable at point (20, 30). Other element would receive the click',
      },
      settle: { ok: false },
      effects: {
        domDiff: null,
        failure: {
          kind: 'overlay',
          nextCommand: 'cdp dismiss-modal abc123',
        },
        diagnosis: {
          status: 'blocked',
          kind: 'overlay',
          source: 'dispatch',
          nextCommand: 'cdp dismiss-modal abc123',
          recovery: {
            strategy: 'clear-overlay',
            commands: [
              { command: 'cdp overlay abc123 @4 --format json' },
              { command: 'cdp dismiss-modal abc123' },
              { command: 'cdp perceive abc123 -C -d 8' },
            ],
            avoid: ['retrying the same click before clearing or re-checking the overlay'],
          },
        },
      },
      verdict: {
        status: 'blocked',
        confidence: 'high',
        canContinue: false,
        needsRecovery: true,
        source: 'diagnosis',
        primaryNextStep: 'cdp overlay abc123 @4 --format json',
      },
      nextHint: 'cdp dismiss-modal abc123',
    });
    expect(captured.effects.failure.kind).toBe('overlay');
    expect(out).not.toContain('Action failure: overlay');
  });
});

