import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET_ID = '71DF370F9D36D5A232B424FDC696BE1A';
const PREFIX = '71DF370F';

function actionResult(action, { dispatchOk = true, failure = null, domDiff = '+   [StaticText] Saved', dispatchText = '' } = {}) {
  return T.createActionResult({
    action,
    target: { targetId: TARGET_ID, input: '#save', resolvedBy: 'selector', label: 'Save', ...(dispatchText ? { dispatchText } : {}) },
    dispatch: {
      ok: dispatchOk,
      method: action,
      ...(dispatchOk ? {} : { error: failure?.originalMessage || 'covered' }),
    },
    settle: { ok: dispatchOk, durationMs: 10 },
    effects: {
      domDiff,
      console: [],
      network: [],
      navigation: null,
      ...(failure ? { failure } : {}),
    },
  });
}

describe('#553 observation receipts', () => {
  it('T1 skinny click and fill stdout have no Outcome: token', () => {
    const click = T.formatActionResultOutput(actionResult('click'), {
      dispatchText: 'Clicked <BUTTON> "Save"',
    });
    const fill = T.formatActionResultOutput(actionResult('fill', { domDiff: '+   [textbox] q = "abc"' }), {
      dispatchText: 'Filled <INPUT> with "abc"',
    });
    expect(click).toBe(`Clicked <BUTTON> "Save". Next: cdp perceive ${PREFIX} --since-action`);
    expect(fill).toBe(`Filled <INPUT> with "abc". Next: cdp perceive ${PREFIX} --since-action`);
    expect(click).not.toMatch(/Outcome:/);
    expect(fill).not.toMatch(/Outcome:/);
    for (const action of ['press', 'scroll']) {
      const text = T.formatActionResultOutput(actionResult(action, { domDiff: null }), {
        dispatchText: action === 'press' ? 'Pressed Enter' : 'Scrolled by (0, 80)',
      });
      expect(text, action).not.toMatch(/Outcome:/);
    }
  });

  it('T2 a covered hit is Kind: covered, not a success receipt, and the process exits non-zero', () => {
    const failure = {
      kind: 'covered',
      dispatched: false,
      originalMessage: 'click point (10, 10) of <BUTTON> "Save" is covered by <DIV.overlay>. The mouse click was not sent: it would land on the covering element.',
      reason: '',
      nextCommand: `cdp click ${PREFIX} "#save" --js`,
    };
    const text = T.formatActionResultOutput(actionResult('click', {
      dispatchOk: false,
      failure,
      domDiff: null,
    }), {});
    expect(text).toMatch(/^Kind: covered$/m);
    expect(text).not.toMatch(/^Clicked /);
    expect(text).not.toMatch(/Outcome:/);
    const processLike = { exitCode: 0 };
    const stdout = [];
    T.emitTargetCommandResponse({ ok: false, result: text }, {
      cmd: 'click',
      targetPrefix: PREFIX,
      format: 'text',
      console: { log: value => stdout.push(value), error() {} },
      process: processLike,
    });
    expect(processLike.exitCode).toBe(1);
    expect(stdout[0]).toMatch(/Kind: covered/);
  });
});
