import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { absolutizeBatchArgs, absolutizeFlowArgs } = await import('../skills/chrome-cdp-ex/scripts/lib/cdp-cli.mjs');
const { formatBatchResults, parseBatchArgs, parseFlowSteps, settleFlow, flowStr, autoActionJsonArgs } = T;

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// formatBatchResults — human-readable batch output
// =========================================================================

describe('formatBatchResults', () => {
  const results = [
    { cmd: 'click', ok: true, result: 'Clicked <button> "Submit"' },
    { cmd: 'console', ok: true, result: '[error] boom\n[warning] hi' },
    { cmd: 'fill', ok: false, error: 'Element not found: #x' },
  ];

  it('default json output is parseable JSON array', () => {
    const out = formatBatchResults(results);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[2].ok).toBe(false);
  });

  it('plain output is human-readable and not valid JSON', () => {
    const out = formatBatchResults(results, 'plain');
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('[1/3] click');
    expect(out).toContain('Clicked <button> "Submit"');
    expect(out).toContain('[2/3] console');
    expect(out).toContain('[error] boom');
    expect(out).toContain('[3/3] fill (error)');
    expect(out).toContain('Element not found: #x');
  });

  it('compact output is one line per command', () => {
    const out = formatBatchResults(results, 'compact');
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('[1] click');
    expect(lines[0]).toContain('Clicked <button> "Submit"');
    expect(lines[1]).toContain('[2] console');
    expect(lines[1]).toContain('[error] boom');
    expect(lines[1]).not.toContain('[warning] hi'); // truncated to first line
    expect(lines[2]).toContain('[3] fill');
    expect(lines[2]).toContain('ERROR Element not found');
  });

  it('plain output handles empty result string with bare header', () => {
    const out = formatBatchResults([{ cmd: 'press', ok: true, result: '' }], 'plain');
    expect(out).toContain('[1/1] press');
  });

  it('compact marks empty result as ok', () => {
    const out = formatBatchResults([{ cmd: 'press', ok: true, result: '' }], 'compact');
    expect(out).toContain('[1] press: ok');
  });

  it('formats structured JSON with failed step recovery hints for agents', () => {
    const out = formatBatchResults(results, 'model', {
      targetId: 'ABC123',
      mode: 'sequential',
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.batch.v1',
      targetId: 'ABC123',
      mode: 'sequential',
      counts: {
        steps: 3,
        ok: 2,
        failed: 1,
      },
      failedStep: {
        index: 3,
        cmd: 'fill',
        ok: false,
        error: 'Element not found: #x',
      },
      nextSteps: ['cdp status ABC123'],
    });
    expect(parsed.steps[0]).toMatchObject({
      index: 1,
      cmd: 'click',
      ok: true,
      resultPreview: 'Clicked <button> "Submit"',
    });
  });

  it('extracts classified action failure next steps from structured batch JSON', () => {
    const out = formatBatchResults([{
      cmd: 'click',
      ok: false,
      error: [
        'Action failure: overlay',
        'Reason: overlay blocked the target',
        'Next: cdp dismiss-modal ABC123',
        'Original: Other element would receive the click',
      ].join('\n'),
    }], 'model', { targetId: 'ABC123' });
    const parsed = JSON.parse(out);

    expect(parsed.failedStep).toMatchObject({
      cmd: 'click',
      failureKind: 'overlay',
      nextCommand: 'cdp dismiss-modal ABC123',
    });
    expect(parsed.nextSteps).toEqual(['cdp dismiss-modal ABC123']);
  });

  it('surfaces attention diagnoses from successful action JSON steps', () => {
    const action = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: 'error banner appeared', console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/save', status: 500, duration: 44 }],
      },
    });
    const out = formatBatchResults([{ cmd: 'click', ok: true, result: T.formatJson(action) }], 'model', { targetId: 'ABC123' });
    const parsed = JSON.parse(out);

    expect(parsed.counts).toMatchObject({ steps: 1, ok: 1, failed: 0, attention: 1 });
    expect(parsed.steps[0]).toMatchObject({
      cmd: 'click',
      ok: true,
      diagnosis: {
        status: 'attention',
        kind: 'network-failure',
        nextCommand: 'cdp netlog ABC123',
      },
    });
    expect(parsed.nextSteps).toEqual([
      'cdp netlog ABC123',
      'cdp perceive ABC123 --since-action',
      'cdp report ABC123 --format json',
    ]);
  });

  it('surfaces investigate verdicts from successful action JSON steps', () => {
    const action = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#noop', resolvedBy: 'selector', label: '#noop' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 90 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
      nextHint: null,
    });
    const out = formatBatchResults([{ cmd: 'click', ok: true, result: T.formatJson(action) }], 'model', { targetId: 'ABC123' });
    const parsed = JSON.parse(out);

    expect(parsed.counts).toMatchObject({ steps: 1, ok: 1, failed: 0, attention: 1 });
    expect(parsed.steps[0]).toMatchObject({
      cmd: 'click',
      ok: true,
      verdict: {
        status: 'investigate',
        canContinue: false,
        needsRecovery: true,
        primaryNextStep: 'cdp overlay ABC123 "#noop" --format json',
      },
    });
    expect(parsed.nextSteps).toEqual([
      'cdp overlay ABC123 "#noop" --format json',
      'cdp perceive ABC123 -C -d 8',
      'cdp report ABC123 --format json',
    ]);
  });
});

describe('parseBatchArgs', () => {
  it('keeps legacy JSON array output by default', () => {
    expect(parseBatchArgs(['click #ok | summary'])).toMatchObject({
      parallel: false,
      output: 'legacy-json',
      commands: [
        { cmd: 'click', args: ['#ok'] },
        { cmd: 'summary', args: [] },
      ],
    });
  });

  it('parses explicit --format json as structured batch output', () => {
    expect(parseBatchArgs(['--format', 'json', 'click #ok | click #missing'])).toMatchObject({
      output: 'model',
      commands: [
        { cmd: 'click', args: ['#ok'] },
        { cmd: 'click', args: ['#missing'] },
      ],
    });
  });

  it('preserves plain and compact text modes', () => {
    expect(parseBatchArgs(['--plain', 'click #ok']).output).toBe('plain');
    expect(parseBatchArgs(['--compact', 'click #ok']).output).toBe('compact');
  });

  it('auto-adds action JSON format for parent JSON handoff', () => {
    expect(autoActionJsonArgs('click', ['#noop'], true)).toEqual(['#noop', '--format', 'json']);
  });

  it('respects explicit subcommand format options', () => {
    expect(autoActionJsonArgs('click', ['#noop', '--format', 'text'], true)).toEqual(['#noop', '--format', 'text']);
  });

  it('does not add action JSON format to read-only commands', () => {
    expect(autoActionJsonArgs('summary', [], true)).toEqual([]);
  });

  it('says | separates batch steps when a quoted value contains a pipe', () => {
    const step = 'eval "a|b"';
    expect(absolutizeBatchArgs([step], '/tmp/caller')).toEqual([step]);
    let message = '';
    try {
      parseBatchArgs([step]);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/\| separates batch steps/);
    expect(message).toMatch(/Use flow/);
    expect(message).toMatch(/quote the steps differently/);
    expect(message).toMatch(/unclosed quote/);
    let plain = '';
    try {
      parseBatchArgs(['click "abc']);
    } catch (error) {
      plain = error.message;
    }
    expect(plain).toMatch(/unclosed quote/);
    expect(plain).not.toMatch(/separates batch steps/);
  });
});

describe('absolutizeFlowArgs backtick quotes', () => {
  it('keeps eval `a \'b` and fill #q `it \'x` unchanged in meaning', () => {
    const cases = [
      { step: "eval `a 'b`", args: ["a 'b"] },
      { step: "fill #q `it 'x`", args: ['#q', "it 'x"] },
    ];
    for (const { step, args } of cases) {
      const before = parseFlowSteps(step);
      const out = absolutizeFlowArgs([step], '/tmp/caller');
      expect(parseFlowSteps(out[0])).toEqual(before);
      expect(before).toEqual([{ kind: 'command', cmd: before[0].cmd, args }]);
    }
  });

  it('absolutizes a shot or upload path and keeps a backtick apostrophe as one argument', () => {
    const cwd = '/tmp/caller';
    const step = "shot T1 `it 's a note` `my file.png`; upload T1 `other file.png` `it 's fine`";
    const out = absolutizeFlowArgs([step], cwd);
    expect(parseFlowSteps(out[0])).toEqual([
      {
        kind: 'command',
        cmd: 'shot',
        args: ['T1', "it 's a note", resolve(cwd, 'my file.png')],
      },
      {
        kind: 'command',
        cmd: 'upload',
        args: ['T1', resolve(cwd, 'other file.png'), "it 's fine"],
      },
    ]);
  });
});

// =========================================================================
// parseFlowSteps — semicolon-separated step parser
// =========================================================================

describe('parseFlowSteps', () => {
  it('returns empty array for empty input', () => {
    expect(parseFlowSteps('')).toEqual([]);
    expect(parseFlowSteps('   ')).toEqual([]);
    expect(parseFlowSteps(undefined)).toEqual([]);
  });

  it('parses a single command step', () => {
    expect(parseFlowSteps('click @1')).toEqual([
      { kind: 'command', cmd: 'click', args: ['@1'] },
    ]);
  });

  it('parses multiple steps separated by semicolons', () => {
    const steps = parseFlowSteps('click @1; summary; console --errors');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ kind: 'command', cmd: 'click', args: ['@1'] });
    expect(steps[1]).toEqual({ kind: 'command', cmd: 'summary', args: [] });
    expect(steps[2]).toEqual({ kind: 'command', cmd: 'console', args: ['--errors'] });
  });

  it('parses wait dom stable as a wait step', () => {
    expect(parseFlowSteps('wait dom stable')).toEqual([
      { kind: 'wait', what: 'dom stable' },
    ]);
  });

  it('parses wait network idle as a wait step', () => {
    expect(parseFlowSteps('wait network idle')).toEqual([
      { kind: 'wait', what: 'network idle' },
    ]);
  });

  it('mixes wait and command steps', () => {
    const steps = parseFlowSteps('click @1; wait dom stable; summary; console --errors');
    expect(steps.map(s => s.kind)).toEqual(['command', 'wait', 'command', 'command']);
    expect(steps[1].what).toBe('dom stable');
  });

  it('trims whitespace and skips empty steps', () => {
    expect(parseFlowSteps('  click @1  ;  ;  summary  ')).toEqual([
      { kind: 'command', cmd: 'click', args: ['@1'] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
  });

  it('parses selector and visible-text assertions as postcondition steps', () => {
    expect(parseFlowSteps('assert selector .done; assert selector-missing .loading; assert text Battle complete'))
      .toEqual([
        { kind: 'assert', condition: { kind: 'selector-exists', value: '.done' } },
        { kind: 'assert', condition: { kind: 'selector-missing', value: '.loading' } },
        { kind: 'assert', condition: { kind: 'text', value: 'Battle complete' } },
      ]);
  });
});

// =========================================================================
// flowStr — sequential runner with halt-on-error
// =========================================================================

describe('flowStr', () => {
  it('throws when input is empty', async () => {
    await expect(flowStr({ run: async () => ({}), settle: async () => '' }, '')).rejects.toThrow(/no steps/);
  });

  it('runs commands sequentially and includes results', async () => {
    const calls = [];
    const run = async (step) => {
      calls.push(step);
      return { ok: true, result: `did ${step.cmd}` };
    };
    const settle = async () => 'ignored';
    const out = await flowStr({ run, settle }, 'click @1; summary');
    expect(calls.map(c => c.cmd)).toEqual(['click', 'summary']);
    expect(out).toContain('Flow: 2 step(s)');
    expect(out).toContain('[1/2] click @1');
    expect(out).toContain('did click');
    expect(out).toContain('[2/2] summary');
    expect(out).toContain('did summary');
  });

  it('invokes settle helper for wait steps', async () => {
    const settleCalls = [];
    const run = async () => ({ ok: true, result: 'ok' });
    const settle = async (what) => { settleCalls.push(what); return `settled: ${what}`; };
    const out = await flowStr({ run, settle }, 'wait dom stable; wait network idle');
    expect(settleCalls).toEqual(['dom stable', 'network idle']);
    expect(out).toContain('settled: dom stable');
    expect(out).toContain('settled: network idle');
  });

  it('runs flow assertions through the shared condition probe', async () => {
    const conditions = [];
    const out = await flowStr({
      run: async () => ({ ok: true, result: 'ok' }),
      settle: async () => '',
      assertCondition: async condition => {
        conditions.push(condition);
        return { matched: true, description: 'selector .done exists' };
      },
    }, 'assert selector .done; summary');

    expect(conditions).toEqual([{ kind: 'selector-exists', value: '.done' }]);
    expect(out).toContain('Assertion passed: selector .done exists');
  });

  it('halts and marks downstream steps skipped when a flow assertion fails', async () => {
    const out = await flowStr({
      run: async () => ({ ok: true, result: 'unexpected' }),
      settle: async () => '',
      assertCondition: async () => ({ matched: false, description: 'text includes "Battle complete"' }),
    }, 'assert text Battle complete; summary', { format: 'json', targetId: 'ABC123' });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      halted: true,
      counts: { steps: 2, ok: 0, failed: 1, skipped: 1 },
      failedStep: {
        index: 1,
        kind: 'assert',
        ok: false,
        failureKind: 'assertion',
        nextCommand: 'cdp help flow',
        error: 'Assertion failed: text includes "Battle complete"',
      },
      nextSteps: ['cdp help flow'],
    });
    expect(parsed.nextSteps.join('\n')).not.toMatch(/cdp status/);
    expect(parsed.steps[1]).toMatchObject({ index: 2, cmd: 'summary', skipped: true });
  });

  it('halts immediately on the first failing step', async () => {
    const seen = [];
    const run = async (step) => {
      seen.push(step.cmd);
      if (step.cmd === 'click') return { ok: false, error: 'Element not found' };
      return { ok: true, result: 'ok' };
    };
    const out = await flowStr({ run, settle: async () => '' }, 'click @9; summary');
    expect(seen).toEqual(['click']);
    expect(out).toContain('Element not found');
    expect(out).toContain('Flow halted');
    expect(out).not.toContain('did summary');
  });

  it('rejects a halted flow at the daemon boundary with the full text handoff', async () => {
    await expect(flowStr({
      run: async () => ({ ok: false, error: 'Unknown ref @9\nNext: cdp perceive ABC123 -C -d 8' }),
      settle: async () => '',
    }, 'click @9; summary', { targetId: 'ABC123', throwOnFailure: true }))
      .rejects.toThrow(/Unknown ref @9.*Flow halted at step 1\/2/s);
  });

  it('rejects a halted JSON flow with its structured failed-step handoff intact', async () => {
    let error;
    try {
      await flowStr({
        run: async () => ({ ok: false, error: 'Element not found: #missing' }),
        settle: async () => '',
      }, 'click #missing; summary', { format: 'json', targetId: 'ABC123', throwOnFailure: true });
    } catch (caught) {
      error = caught;
    }
    const parsed = JSON.parse(error.message);
    expect(parsed).toMatchObject({
      halted: true,
      counts: { steps: 2, ok: 0, failed: 1, skipped: 1 },
      failedStep: { index: 1, cmd: 'click', error: 'Element not found: #missing' },
    });
    expect(parsed.nextSteps).toEqual(['cdp status ABC123']);
  });

  it('halts when settle helper throws', async () => {
    const run = async () => ({ ok: true, result: 'ok' });
    const settle = async () => { throw new Error('settle exploded'); };
    const out = await flowStr({ run, settle }, 'wait dom stable; summary');
    expect(out).toContain('settle exploded');
    expect(out).toContain('Flow halted');
  });

  it('produces a step-by-step layout (not one giant JSON blob)', async () => {
    const run = async (step) => ({ ok: true, result: `result of ${step.cmd}` });
    const out = await flowStr({ run, settle: async (w) => w }, 'click @1; wait dom stable; summary');
    // Should not be JSON
    expect(() => JSON.parse(out)).toThrow();
    // Should have one numbered head per step
    const heads = out.split('\n').filter(l => /^\[\d+\/\d+\]/.test(l));
    expect(heads).toHaveLength(3);
  });

  it('returns structured JSON failure handoff for command failures', async () => {
    const seen = [];
    const run = async (step) => {
      seen.push(step.cmd);
      if (step.cmd === 'click') {
        return {
          ok: false,
          error: [
            'Action failure: selector',
            'Reason: No current element matched the requested selector/ref.',
            'Next: cdp perceive ABC123 -C -d 8',
            'Original: Element not found: #missing',
          ].join('\n'),
        };
      }
      return { ok: true, result: `did ${step.cmd}` };
    };
    const out = await flowStr(
      { run, settle: async () => '' },
      'summary; click #missing; status',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(seen).toEqual(['summary', 'click']);
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      targetId: 'ABC123',
      halted: true,
      counts: { steps: 3, ok: 1, failed: 1, skipped: 1 },
      failedStep: {
        index: 2,
        kind: 'command',
        cmd: 'click',
        ok: false,
        failureKind: 'selector',
        nextCommand: 'cdp perceive ABC123 -C -d 8',
      },
      nextSteps: ['cdp perceive ABC123 -C -d 8'],
    });
    expect(parsed.steps[0]).toMatchObject({ index: 1, cmd: 'summary', ok: true, resultPreview: 'did summary' });
    expect(parsed.steps[2]).toMatchObject({ index: 3, cmd: 'status', skipped: true });
  });

  it('halts on failed action JSON steps', async () => {
    const action = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#missing', resolvedBy: 'selector', label: '#missing' },
      dispatch: { ok: false, method: 'click', error: 'Element not found: #missing' },
      settle: { ok: false, durationMs: 12 },
      effects: {
        domDiff: null,
        console: [],
        network: [],
        navigation: null,
        failure: {
          kind: 'selector',
          reason: 'No current element matched the requested selector/ref.',
          nextCommand: 'cdp perceive ABC123 -C -d 8',
          originalMessage: 'Element not found: #missing',
        },
      },
      nextHint: 'cdp perceive ABC123 -C -d 8',
    });
    const seen = [];
    const out = await flowStr(
      {
        run: async (step) => {
          seen.push(step.cmd);
          return step.cmd === 'click'
            ? { ok: true, result: T.formatJson(action) }
            : { ok: true, result: `did ${step.cmd}` };
        },
        settle: async () => '',
      },
      'summary; click #missing; status',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(seen).toEqual(['summary', 'click']);
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: true,
      counts: { steps: 3, ok: 1, failed: 1, skipped: 1, attention: 0 },
      failedStep: {
        index: 2,
        cmd: 'click',
        ok: false,
        failureKind: 'selector',
        nextCommand: 'cdp perceive ABC123 -C -d 8',
        verdict: {
          status: 'blocked',
          needsRecovery: true,
          primaryNextStep: 'cdp perceive ABC123 -C -d 8',
        },
      },
      nextSteps: [
        'cdp perceive ABC123 -C -d 8',
        'cdp status ABC123',
      ],
    });
    expect(parsed.steps[2]).toMatchObject({ index: 3, cmd: 'status', skipped: true });
  });

  it('returns structured JSON failure handoff for wait failures', async () => {
    const out = await flowStr(
      { run: async () => ({ ok: true, result: 'ok' }), settle: async () => { throw new Error('Unknown wait: "paint idle"'); } },
      'wait paint idle; summary',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: true,
      failedStep: {
        index: 1,
        kind: 'wait',
        wait: 'paint idle',
        ok: false,
        error: 'Unknown wait: "paint idle"',
      },
      nextSteps: ['cdp status ABC123'],
    });
  });

  it('surfaces attention diagnoses from successful action JSON steps', async () => {
    const action = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: 'error banner appeared', console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/save', status: 500, duration: 44 }],
      },
    });
    const out = await flowStr(
      { run: async (step) => ({ ok: true, result: step.cmd === 'click' ? T.formatJson(action) : 'ok' }), settle: async () => '' },
      'click #save; summary',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: false,
      counts: { steps: 2, ok: 2, failed: 0, skipped: 0, attention: 1 },
      nextSteps: [
        'cdp netlog ABC123',
        'cdp perceive ABC123 --since-action',
        'cdp report ABC123 --format json',
      ],
    });
    expect(parsed.steps[0]).toMatchObject({
      cmd: 'click',
      ok: true,
      diagnosis: {
        status: 'attention',
        kind: 'network-failure',
        nextCommand: 'cdp netlog ABC123',
      },
    });
  });

  it('surfaces investigate verdicts from successful action JSON steps', async () => {
    const action = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#noop', resolvedBy: 'selector', label: '#noop' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 90 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
      nextHint: null,
    });
    const out = await flowStr(
      { run: async (step) => ({ ok: true, result: step.cmd === 'click' ? T.formatJson(action) : 'ok' }), settle: async () => '' },
      'click #noop; summary',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: false,
      counts: { steps: 2, ok: 2, failed: 0, skipped: 0, attention: 1 },
      nextSteps: [
        'cdp overlay ABC123 "#noop" --format json',
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
    expect(parsed.steps[0]).toMatchObject({
      cmd: 'click',
      ok: true,
      verdict: {
        status: 'investigate',
        canContinue: false,
        needsRecovery: true,
        primaryNextStep: 'cdp overlay ABC123 "#noop" --format json',
      },
    });
  });
});

// =========================================================================
// settleFlow — wait helpers
// =========================================================================

describe('settleFlow', () => {
  it('rejects unknown wait verb', async () => {
    const cdp = createMockCDP({});
    await expect(settleFlow(cdp, 'sid', 'paint stable', new Map())).rejects.toThrow(/dom stable.*network idle/i);
  });

  it('returns "network idle" immediately when no pending requests', async () => {
    const cdp = createMockCDP({});
    const out = await settleFlow(cdp, 'sid', 'network idle', new Map(), { quietMs: 50, maxMs: 500 });
    expect(out).toBe('network idle');
  });

  it('rejects network idle timeout with the pending request count', async () => {
    const cdp = createMockCDP({});
    const pending = new Map([['r1', {}], ['r2', {}]]);
    await expect(settleFlow(cdp, 'sid', 'network idle', pending, { maxMs: 200, quietMs: 50 }))
      .rejects.toThrow(/timed out.*2 pending/i);
  });

  it('uses waitForSettle for "dom stable"', async () => {
    // waitForSettle calls evalStr with a Promise. Our mock resolves immediately.
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'stable' } }),
    });
    const out = await settleFlow(cdp, 'sid', 'dom stable', new Map(), { maxMs: 100 });
    expect(out).toBe('dom stable');
  });

  it('rejects dom stable timeout instead of reporting successful completion', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'timeout' } }),
    });
    await expect(settleFlow(cdp, 'sid', 'dom stable', new Map(), { maxMs: 100 }))
      .rejects.toThrow(/dom stable timed out after 100ms/i);
  });
});

// =========================================================================
// repeat primitive — count cap, fail-fast, --continue
// =========================================================================

describe('parseRepeatArgs', () => {
  const { parseRepeatArgs } = T;

  it('parses count, command, and command args', () => {
    const opts = parseRepeatArgs(['3', 'press', 'c']);
    expect(opts.count).toBe(3);
    expect(opts.cmd).toBe('press');
    expect(opts.args).toEqual(['c']);
    expect(opts.continueOnError).toBe(false);
  });

  it('parses --continue anywhere in the argument list', () => {
    expect(parseRepeatArgs(['5', '--continue', 'click', '@1']).continueOnError).toBe(true);
    expect(parseRepeatArgs(['5', 'click', '@1', '--continue']).continueOnError).toBe(true);
    expect(parseRepeatArgs(['-c', '4', 'press', 'space']).continueOnError).toBe(true);
  });

  it('rejects non-positive counts', () => {
    expect(() => parseRepeatArgs(['0', 'press', 'c'])).toThrow(/positive integer/);
    expect(() => parseRepeatArgs(['-1', 'press', 'c'])).toThrow(/positive integer/);
    expect(() => parseRepeatArgs(['abc', 'press', 'c'])).toThrow(/positive integer/);
  });

  it('caps the loop count to prevent runaways', () => {
    expect(() => parseRepeatArgs(['9999', 'press', 'c'])).toThrow(/exceeds cap/);
  });

  it('rejects nesting itself or other meta-commands', () => {
    expect(() => parseRepeatArgs(['3', 'repeat', '2', 'press', 'c'])).toThrow(/cannot wrap/);
    expect(() => parseRepeatArgs(['3', 'batch', 'press c'])).toThrow(/cannot wrap/);
    expect(() => parseRepeatArgs(['3', 'stop'])).toThrow(/cannot wrap/);
  });

  it('allows wrapping flow so multi-step bodies can loop (matches README)', () => {
    const opts = parseRepeatArgs(['3', 'flow', 'click @1; wait dom stable']);
    expect(opts.count).toBe(3);
    expect(opts.cmd).toBe('flow');
    expect(opts.args).toEqual(['click @1; wait dom stable']);
  });

  it('parses one bounded stop condition without forwarding it to the inner command', () => {
    expect(parseRepeatArgs(['20', 'click', '.attack', '--until-selector', '.battle-end'])).toMatchObject({
      count: 20,
      cmd: 'click',
      args: ['.attack'],
      condition: { kind: 'selector-exists', value: '.battle-end' },
    });
    expect(parseRepeatArgs(['20', '--until-selector-missing', '.loading', 'press', 'space'])).toMatchObject({
      cmd: 'press',
      args: ['space'],
      condition: { kind: 'selector-missing', value: '.loading' },
    });
    expect(parseRepeatArgs(['20', 'press', 'space', '--until-text', 'Battle complete']).condition)
      .toEqual({ kind: 'text', value: 'Battle complete' });
  });

  it('rejects conflicting or valueless repeat conditions before dispatch', () => {
    expect(() => parseRepeatArgs(['3', 'press', 'c', '--until-text'])).toThrow(/requires a value/);
    expect(() => parseRepeatArgs(['3', 'press', 'c', '--until-text', '--continue'])).toThrow(/requires a value/);
    expect(() => parseRepeatArgs(['3', 'press', 'c', '--until-text', 'done', '--until-selector', '.done']))
      .toThrow(/exactly one.*condition/i);
  });

  it('probes selector existence, absence, and visible text through fresh page evaluation', async () => {
    const expressions = [];
    const cdp = createMockCDP({
      'Runtime.evaluate': params => {
        expressions.push(params.expression);
        return { result: { value: JSON.stringify({ matched: true }) } };
      },
    });

    await expect(T.probePageCondition(cdp, 'sid', { kind: 'selector-exists', value: '.done' }))
      .resolves.toEqual({ matched: true, description: 'selector .done exists' });
    await expect(T.probePageCondition(cdp, 'sid', { kind: 'selector-missing', value: '.loading' }))
      .resolves.toEqual({ matched: true, description: 'selector .loading is missing' });
    await expect(T.probePageCondition(cdp, 'sid', { kind: 'text', value: '戰鬥結束' }))
      .resolves.toEqual({ matched: true, description: 'text includes "戰鬥結束"' });

    expect(expressions[0]).toContain('!!document.querySelector(".done")');
    expect(expressions[1]).toContain('!document.querySelector(".loading")');
    expect(expressions[2]).toContain("document.body.innerText");
  });

  it('requires a command name after the count', () => {
    expect(() => parseRepeatArgs(['3'])).toThrow(/command name required|repeat requires/);
  });
});

describe('repeatStr', () => {
  const { repeatStr } = T;

  it('runs the inner command N times and counts successes', async () => {
    let calls = 0;
    const run = async (step) => { calls++; return { ok: true, result: `tick ${step.cmd} ${calls}` }; };
    const out = await repeatStr({ run }, ['3', 'press', 'c']);
    expect(calls).toBe(3);
    expect(out).toMatch(/Repeat 3× press c/);
    expect(out).toMatch(/\[1\/3\] ok/);
    expect(out).toMatch(/\[3\/3\] ok/);
    expect(out).toMatch(/Done: 3 ok, 0 failed/);
  });

  it('rejects on the first error by default with the complete fail-fast transcript', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls === 2) return { ok: false, error: 'kaboom' };
      return { ok: true, result: 'ok' };
    };
    let error;
    try {
      await repeatStr({ run }, ['5', 'click', '@1']);
    } catch (caught) {
      error = caught;
    }
    expect(calls).toBe(2);
    expect(error.message).toMatch(/Repeat halted at iteration 2\/5/);
    expect(error.message).toMatch(/✗ kaboom/);
    expect(error.message).toMatch(/Done: 1 ok, 1 failed/);
  });

  it('does not misreport a conditioned fail-fast halt as cap exhaustion', async () => {
    let calls = 0;
    let error;
    try {
      await repeatStr({
        run: async () => {
          calls++;
          return { ok: false, error: 'kaboom' };
        },
        probeCondition: async () => ({ matched: false, description: 'selector .done exists' }),
      }, ['5', 'click', '.x', '--until-selector', '.done']);
    } catch (caught) {
      error = caught;
    }

    expect(calls).toBe(1);
    expect(error.message).toContain('Repeat halted at iteration 1/5');
    expect(error.message).toContain('kaboom');
    expect(error.message).not.toContain('condition not satisfied after 5 iterations');
  });

  it('keeps going through errors when --continue is passed', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls % 2 === 0) return { ok: false, error: 'flap' };
      return { ok: true, result: 'fine' };
    };
    const out = await repeatStr({ run }, ['4', '--continue', 'press', 'space']);
    expect(calls).toBe(4);
    expect(out).toMatch(/Done: 2 ok, 2 failed/);
    expect(out).not.toMatch(/halted/);
  });

  it('forwards command args verbatim each iteration', async () => {
    const seen = [];
    const run = async (step) => { seen.push(step); return { ok: true, result: '' }; };
    await repeatStr({ run }, ['2', 'fill', '@3', 'hello world']);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ cmd: 'fill', args: ['@3', 'hello world'] });
    expect(seen[1]).toEqual({ cmd: 'fill', args: ['@3', 'hello world'] });
  });

  it('dispatches flow as the inner command (multi-step body loop)', async () => {
    const seen = [];
    const run = async (step) => { seen.push(step); return { ok: true, result: 'flow ok' }; };
    const out = await repeatStr({ run }, ['3', 'flow', 'click @1; wait dom stable']);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ cmd: 'flow', args: ['click @1; wait dom stable'] });
    expect(out).toMatch(/Repeat 3× flow click @1; wait dom stable/);
    expect(out).toMatch(/Done: 3 ok, 0 failed/);
  });

  it('halts a repeat-over-flow loop on the first failed flow turn', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls === 2) return { ok: false, error: 'Flow halted at step 2/3' };
      return { ok: true, result: 'flow ok' };
    };
    let error;
    try {
      await repeatStr({ run }, ['5', 'flow', 'click @attack; wait dom stable']);
    } catch (caught) {
      error = caught;
    }
    expect(calls).toBe(2);
    expect(error.message).toMatch(/Flow halted at step 2\/3/);
    expect(error.message).toMatch(/Repeat halted at iteration 2\/5/);
    expect(error.message).toMatch(/Done: 1 ok, 1 failed/);
  });

  it('stops early when a freshly probed condition matches', async () => {
    let runs = 0;
    const probeResults = [false, false, true];
    const out = await repeatStr({
      run: async () => ({ ok: true, result: `turn ${++runs}` }),
      probeCondition: async () => ({ matched: probeResults.shift(), description: 'text includes "Battle complete"' }),
    }, ['10', 'press', 'space', '--until-text', 'Battle complete']);

    expect(runs).toBe(3);
    expect(out).toContain('Condition satisfied after iteration 3/10');
    expect(out).toContain('[3/10] ok: turn 3');
  });

  it('fails distinctly with the transcript when the condition cap is exhausted', async () => {
    let probes = 0;
    await expect(repeatStr({
      run: async () => ({ ok: true, result: 'still fighting' }),
      probeCondition: async () => ({ matched: false, description: `fresh probe ${++probes}` }),
    }, ['3', 'click', '.attack', '--until-selector', '.battle-end']))
      .rejects.toThrow(/\[1\/3\] ok: still fighting.*\[3\/3\] ok: still fighting.*condition not satisfied after 3 iterations/s);
    expect(probes).toBe(3);
  });
});
