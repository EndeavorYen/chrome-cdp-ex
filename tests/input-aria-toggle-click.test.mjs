import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const NO_CHANGE = '(no changes detected in AX tree)';
const TARGET_ID = '9E3238F5CEA88A787E777B3A5E650842';

function axState(name, value, type = 'tristate') {
  return { name, value: { type, value } };
}

function buttonElement(attrs) {
  return {
    tagName: 'BUTTON',
    id: 't',
    type: 'button',
    hasAttribute(name) { return Object.hasOwn(attrs, name); },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
  };
}

function cdpReading(el) {
  return {
    send(method, params = {}) {
      if (method !== 'Runtime.evaluate') return Promise.resolve({ result: { value: null } });
      const document = {
        querySelector(selector) { return selector === '#t' ? el : null; },
      };
      try {
        const value = runInContext(String(params.expression || ''), createContext({ document }));
        return Promise.resolve({ result: { value } });
      } catch (error) {
        return Promise.resolve({
          exceptionDetails: { text: error.message, exception: { description: error.message } },
        });
      }
    },
  };
}

async function readControl(el) {
  return T.snapshotFormControlState(cdpReading(el), 'sid', '#t', new Map(), {});
}

function clickFeedback({ dispatchText, domDiff = NO_CHANGE, target = {}, format = 'text' }) {
  return T.runActionWithFeedback({
    action: 'click',
    target: {
      targetId: TARGET_ID,
      input: '#t',
      resolvedBy: 'selector',
      label: '#t',
      ...target,
    },
    dispatch: async () => dispatchText,
    feedbackPolicy: 'settle-diff',
    observe: async () => domDiff,
    format,
  });
}

describe('a clicked control\'s own aria state is a reaction (#664)', () => {
  it('prints pressed and expanded from the accessibility properties Chrome sends', () => {
    const pressedOff = T.formatAxNode({
      role: { value: 'button' },
      name: { value: 'Details' },
      properties: [axState('pressed', 'false')],
    }, 0);
    const pressedOn = T.formatAxNode({
      role: { value: 'button' },
      name: { value: 'Details' },
      properties: [axState('pressed', 'true')],
    }, 0);
    const expandedOn = T.formatAxNode({
      role: { value: 'button' },
      name: { value: 'Section' },
      properties: [axState('expanded', true, 'booleanOrUndefined')],
    }, 0);
    expect(pressedOff).toBe('[button] Details pressed=false');
    expect(pressedOn).toBe('[button] Details pressed=true');
    expect(expandedOn).toBe('[button] Section expanded=true');
    const diff = T.formatPerceiveDiffOutput(`Page: toggle\n\n${pressedOff}\n`, `Page: toggle\n\n${pressedOn}\n`);
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).not.toMatch(/no changes detected/i);
  });

  it('keeps a pressed token out of the accessible name', () => {
    const [note] = T.refAnnotationsFromTreeLines(['[button] Details pressed=false  @1  (8,8 57×21)']);
    expect(note.name).toBe('Details');
    expect(note.ref).toBe('@1');
  });

  it('names an aria-pressed flip on the one-line receipt', async () => {
    const text = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Details"',
      target: {
        controlStateChanged: true,
        controlStateDiff: 'aria-pressed false → true',
      },
    });
    expect(text).toMatch(/^Clicked <BUTTON> "Details": aria-pressed false → true\. Next: /);
    expect(text).not.toMatch(/Kind:/);
    expect(text).not.toMatch(/Outcome: no-change/);
  });

  it('reads aria-pressed, aria-expanded, aria-checked, and aria-selected off the control', async () => {
    const attrs = {
      'aria-pressed': 'false',
      'aria-expanded': 'false',
      'aria-checked': 'false',
      'aria-selected': 'false',
    };
    const el = buttonElement(attrs);
    const before = await readControl(el);
    expect(before.aria).toEqual(attrs);
    attrs['aria-pressed'] = 'true';
    attrs['aria-expanded'] = 'true';
    attrs['aria-checked'] = 'mixed';
    attrs['aria-selected'] = 'true';
    const after = await readControl(el);
    expect(T.formControlStateChanged(before, after)).toBe(true);
    expect(T.formatFormControlStateDiff(before, after)).toBe(
      'aria-pressed false → true; aria-expanded false → true; aria-checked false → mixed; aria-selected false → true',
    );
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: TARGET_ID,
        input: '#t',
        resolvedBy: 'selector',
        label: '#t',
        controlStateChanged: T.formControlStateChanged(before, after),
        controlStateDiff: T.formatFormControlStateDiff(before, after),
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 20 },
      effects: { domDiff: NO_CHANGE, console: [], network: [], navigation: null },
    });
    expect(result.outcome).toMatchObject({ status: 'changed', changed: true });
    expect(result.verdict).toMatchObject({ status: 'continue', canContinue: true });
  });

  it('records an unchanged aria-pressed value and does not call it a reaction', async () => {
    const el = buttonElement({ 'aria-pressed': 'false' });
    const before = await readControl(el);
    const after = await readControl(el);
    expect(before.aria['aria-pressed']).toBe('false');
    expect(after.aria['aria-pressed']).toBe('false');
    expect(T.formControlStateChanged(before, after)).toBe(false);
    expect(T.formatFormControlStateDiff(before, after)).toBe('');
  });

  it('still fails closed when the formatted tree and the control state are unchanged', async () => {
    const err = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Save"',
    }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Kind: click-no-change/);
    expect(err.message).toMatch(/Outcome: no-change/);
  });
});

// The live click of an aria toggle runs in scripts/live-smoke.mjs (Chrome stable CI job).
