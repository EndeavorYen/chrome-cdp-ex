import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #262 checkbox/radio/select-multiple settle honesty', () => {
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  it('#262 unnamed checkbox/radio appear in the AX dump with @refs', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'WebArea' }, name: { value: 'Example' }, childIds: ['2', '3', '4'] },
      {
        nodeId: '2', parentId: '1', role: { value: 'checkbox' }, name: { value: '' },
        backendDOMNodeId: 11, checked: { value: false },
      },
      {
        nodeId: '3', parentId: '1', role: { value: 'radio' }, name: { value: '' },
        backendDOMNodeId: 12, checked: { value: false },
      },
      {
        nodeId: '4', parentId: '1', role: { value: 'radio' }, name: { value: '' },
        backendDOMNodeId: 13, checked: { value: true },
      },
    ];
    const { treeLines } = T.buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, new Map());
    const output = treeLines.join('\n');
    expect(output).toMatch(/\[checkbox\] checked=false\s+@1/);
    expect(output).toMatch(/\[radio\] checked=false\s+@2/);
    expect(output).toMatch(/\[radio\] checked=true\s+@3/);
  });

  it('#262 a dispatched click that flips .checked is Outcome:changed / continue, not overlay', () => {
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: 'ABC123',
        input: '#p16cb',
        resolvedBy: 'selector',
        label: '#p16cb',
        controlStateChanged: true,
        controlStateDiff: 'checkbox #p16cb checked false → true',
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: '(no changes detected in AX tree)',
        console: [],
        network: [],
        navigation: null,
        ...emptyDelta,
        consoleDelta: emptyDelta.console,
        exceptionDelta: emptyDelta.exceptions,
        networkDelta: emptyDelta.network,
      },
    });
    expect(result.outcome).toMatchObject({ status: 'changed', changed: true });
    expect(result.verdict).toMatchObject({ status: 'continue', canContinue: true });
    expect(T.formatActionText(result)).not.toMatch(/overlay "#p16cb"/);
  });

  it('#262 select multiple selectedOptions change is Outcome:changed', () => {
    expect(T.formControlStateChanged(
      { tag: 'select', multiple: true, selected: ['a'] },
      { tag: 'select', multiple: true, selected: ['b'] },
    )).toBe(true);
    expect(T.formatFormControlStateDiff(
      { tag: 'select', id: 'p16msel', selected: ['a'] },
      { tag: 'select', id: 'p16msel', selected: ['b'] },
    )).toContain('["b"]');

    const result = T.createActionResult({
      action: 'select',
      target: {
        targetId: 'ABC123',
        input: '#p16msel',
        resolvedBy: 'selector',
        label: '#p16msel',
        controlStateChanged: true,
        controlStateDiff: 'select #p16msel selected ["a"] → ["b"]',
      },
      dispatch: { ok: true, method: 'select' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
  });

  it('#262 no-op Escape / dismiss-modal with no dialog stay no-change + continue', () => {
    const press = T.createActionResult({
      action: 'press',
      target: { targetId: 'ABC123', input: 'Escape', resolvedBy: 'key', label: 'Escape', expectedOutcome: 'press-no-change' },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 20 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(press.outcome.status).toBe('no-change');
    expect(press.verdict.status).toBe('continue');
    expect(press.verdict.canContinue).toBe(true);

    const dismiss = T.createActionResult({
      action: 'dismiss-modal',
      target: { targetId: 'ABC123', input: 'modal', resolvedBy: 'dialog', label: 'modal', expectedOutcome: 'no-modal' },
      dispatch: { ok: true, method: 'dismiss-modal' },
      settle: { ok: true, durationMs: 20 },
      effects: { domDiff: 'No changes detected (no modal).', console: [], network: [], navigation: null },
    });
    expect(dismiss.outcome.status).toBe('no-change');
    expect(dismiss.verdict.status).toBe('continue');
  });

  async function snapshotThenOutcome({ action, input, before, after }) {
    expect(T.shouldSnapshotFormControlState(action, { input, resolvedBy: 'selector' })).toBe(true);
    const values = [before, after];
    const cdp = {
      send(method) {
        if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
          const snapshot = values.shift();
          return Promise.resolve({ result: { value: snapshot } });
        }
        return Promise.resolve({});
      },
    };
    const beforeSnap = await T.snapshotFormControlState(cdp, 'sid', input, new Map(), {});
    const afterSnap = await T.snapshotFormControlState(cdp, 'sid', input, new Map(), {});
    expect(beforeSnap).toEqual(before);
    expect(afterSnap).toEqual(after);
    expect(T.formControlStateChanged(beforeSnap, afterSnap)).toBe(true);
    const result = T.createActionResult({
      action,
      target: {
        targetId: 'ABC123',
        input,
        resolvedBy: 'selector',
        label: input,
        controlStateChanged: T.formControlStateChanged(beforeSnap, afterSnap),
        controlStateDiff: T.formatFormControlStateDiff(beforeSnap, afterSnap),
      },
      dispatch: { ok: true, method: action },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: '(no changes detected in AX tree)',
        console: [],
        network: [],
        navigation: null,
        ...emptyDelta,
        consoleDelta: emptyDelta.console,
        exceptionDelta: emptyDelta.exceptions,
        networkDelta: emptyDelta.network,
      },
    });
    expect(result.outcome).toMatchObject({ status: 'changed', changed: true });
    expect(result.verdict).toMatchObject({ status: 'continue', canContinue: true });
    expect(T.formatActionText(result)).not.toMatch(new RegExp(`overlay "${input.replace('#', '\\#')}"`));
    return result;
  }

  it('#262 snapshotFormControlState probe path flips checkbox .checked to Outcome:changed', async () => {
    await snapshotThenOutcome({
      action: 'click',
      input: '#p16cb',
      before: { tag: 'input', type: 'checkbox', id: 'p16cb', checked: false },
      after: { tag: 'input', type: 'checkbox', id: 'p16cb', checked: true },
    });
  });

  it('#262 snapshotFormControlState probe path flips radio .checked to Outcome:changed', async () => {
    await snapshotThenOutcome({
      action: 'click',
      input: '#p16radio',
      before: { tag: 'input', type: 'radio', id: 'p16radio', checked: false },
      after: { tag: 'input', type: 'radio', id: 'p16radio', checked: true },
    });
  });

  it('#262 snapshotFormControlState probe path for select-multiple is Outcome:changed', async () => {
    const result = await snapshotThenOutcome({
      action: 'select',
      input: '#p16msel',
      before: { tag: 'select', type: 'select-multiple', id: 'p16msel', multiple: true, selected: ['a'], value: 'a' },
      after: { tag: 'select', type: 'select-multiple', id: 'p16msel', multiple: true, selected: ['b'], value: 'b' },
    });
    expect(result.target.controlStateDiff).toContain('["b"]');
  });
});
