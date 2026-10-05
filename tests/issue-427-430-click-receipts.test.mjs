import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  classifyActionFailure,
  formatActionFailure,
  isClassifiedActionFailureText,
} = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = '71DF370F9D36D5A232B424FDC696BE1A';
const PREFIX = '71DF370F';
const BUTTON_NAME = '套用設定';

function fakeButton(text, { clicks }) {
  return {
    tagName: 'BUTTON',
    innerText: text,
    textContent: text,
    href: '',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 24, top: 10, left: 10, right: 90, bottom: 34 }),
    click() { clicks.push(text); },
    scrollIntoView() {},
  };
}

function fakePageCdp(names) {
  const clicks = [];
  const buttons = names.map(name => fakeButton(name, { clicks }));
  const context = {
    window: { innerWidth: 800, innerHeight: 600, scrollY: 0, MouseEvent: class {} },
    document: {
      querySelectorAll: () => buttons,
      querySelector: () => null,
    },
    location: { href: 'http://127.0.0.1/fixture' },
    Array, JSON, String, Math, Number,
  };
  context.window.MouseEvent = class MouseEvent {};
  const cdp = {
    send(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: runInNewContext(String(params.expression || ''), context) } });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { cdp, clicks };
}

describe('#427 failed actions always print an Error line', () => {
  it('formatActionFailure leads with Error: even when the kind is unknown', () => {
    const text = formatActionFailure(new Error('Something odd happened in the page'), {
      action: 'click',
      target: { targetId: TARGET_ID, input: 'x' },
    });
    expect(text.split('\n')[0]).toBe('Error: Something odd happened in the page');
    expect(text).toMatch(/^Kind: unknown$/m);
    expect(text).toMatch(/^Next: cdp perceive /m);
  });

  it('formatActionFailure keeps the selector in the Error line for a selector miss', () => {
    const text = formatActionFailure(new Error('Element not found: #save'), {
      action: 'click',
      target: { targetId: 'ABC123', input: '#save' },
    });
    expect(text).toBe('Error: Element not found: #save\nKind: selector\nNext: cdp perceive ABC123 -C -d 8');
  });

  it('keeps the fill Value line (#428) between Kind and Next under the Error line', () => {
    const err = new Error('fill: #amp did not accept "abc"; value changed "0.5" → ""');
    err.fillValue = { before: '0.5', after: '', requested: 'abc', inputType: 'number', changed: true };
    const text = formatActionFailure(err, { action: 'fill', target: { targetId: 'ABC123', input: '#amp' } });
    expect(text.split('\n')).toEqual([
      'Error: fill: #amp did not accept "abc"; value changed "0.5" → ""',
      'Kind: fill-value-mismatch',
      'Value: "0.5" → "" (requested "abc"; <input type=number> rejected the text)',
      `Next: cdp eval ABC123 "document.querySelector('#amp')?.value"`,
    ]);
  });

  it('does not double-prefix an Error: message or re-wrap an already formatted failure', () => {
    const once = formatActionFailure(new Error('Error: boom'), { action: 'click', target: { targetId: 'ABC123' } });
    expect(once.split('\n')[0]).toBe('Error: boom');
    expect(isClassifiedActionFailureText(once)).toBe(true);
    expect(formatActionFailure(new Error(once), { action: 'click', target: { targetId: 'ABC123' } })).toBe(once);
  });

  it('collapses a multi-line message onto one bounded Error line', () => {
    const text = formatActionFailure(new Error(`first line\n  second line\n${'x'.repeat(2000)}`), {
      action: 'click',
      target: { targetId: 'ABC123' },
    });
    const errorLine = text.split('\n')[0];
    expect(errorLine.startsWith('Error: first line second line')).toBe(true);
    expect(errorLine.length).toBeLessThanOrEqual(620);
    expect(text.split('\n')).toHaveLength(3);
  });

  it('the CLI error renderer passes the formatted failure through, Kind repeated on the last Next line (#533)', () => {
    const failure = formatActionFailure(new Error('Named control not found: "x"'), {
      action: 'click',
      target: { targetId: TARGET_ID, input: 'x' },
    });
    const kind = failure.match(/^Kind: (\S+)/m)[1];
    expect(T.formatCliError(new Error(failure), { cmd: 'click', targetPrefix: PREFIX })).toBe(`${failure} (Kind: ${kind})`);
  });

  it('a failed dispatch receipt rendered as text carries the original error', () => {
    const failure = classifyActionFailure(new Error('Only http/https URLs allowed, got: data:'), {
      action: 'nav',
      target: { targetId: TARGET_ID, input: 'data:text/html,x' },
    });
    const result = T.createActionResult({
      action: 'nav',
      target: { targetId: TARGET_ID, input: 'data:text/html,x', resolvedBy: 'url', label: 'data:text/html,x' },
      dispatch: { ok: false, method: 'nav', error: failure.originalMessage },
      settle: { ok: false, durationMs: 0 },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
    });
    const text = T.formatActionResultOutput(result, {});
    expect(text.split('\n')[0]).toBe('Error: Only http/https URLs allowed, got: data:');
    expect(text).toMatch(/^Kind: /m);
    expect(text).toMatch(/^Next: /m);
  });

  it('classifies a named-control miss as a selector failure, not unknown', () => {
    for (const message of [
      'Named control not found: "套用設定"',
      'Named control is not unique and none are in the viewport: "Save"',
    ]) {
      expect(classifyActionFailure(new Error(message), {
        action: 'click',
        target: { targetId: TARGET_ID, input: 'x' },
      }).kind).toBe('selector');
    }
  });
});

describe('#427 Playwright text= selector is an alias for the visible-text form', () => {
  it('treats text=, text="…" and text=\'…\' as named queries', () => {
    expect(T.isNamedClickQuery(`text=${BUTTON_NAME}`)).toBe(true);
    expect(T.isNamedClickQuery('text="Save changes"')).toBe(true);
    expect(T.isNamedClickQuery("text='Save'")).toBe(true);
    expect(T.isNamedClickQuery('text=Save')).toBe(true);
    // A bare single word is still a CSS tag selector; text= is the way to force a name.
    expect(T.isNamedClickQuery('Save')).toBe(false);
    expect(T.namedClickQueryName('text="Save changes"')).toBe('Save changes');
    expect(T.namedClickQueryName(`text=${BUTTON_NAME}`)).toBe(BUTTON_NAME);
    expect(T.namedClickQueryName(BUTTON_NAME)).toBe(BUTTON_NAME);
  });

  it('click "text=套用設定" clicks the button with that visible text', async () => {
    for (const input of [`text=${BUTTON_NAME}`, `text="${BUTTON_NAME}"`]) {
      const { cdp, clicks } = fakePageCdp([BUTTON_NAME, '無動作']);
      const out = await T.clickStr(cdp, 'sid', input);
      expect(out).toBe(`JS-clicked <BUTTON> "${BUTTON_NAME}"`);
      expect(clicks).toEqual([BUTTON_NAME]);
    }
  });

  it('a text= miss names the selector and points at visible text or an @ref', async () => {
    const { cdp, clicks } = fakePageCdp([BUTTON_NAME]);
    const err = await T.clickStr(cdp, 'sid', 'text=不存在').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Named control not found: "不存在" \(from text=不存在\)/);
    expect(err.message).toMatch(/visible text/);
    expect(err.message).toMatch(/@ref/);
    expect(clicks).toEqual([]);
    const text = formatActionFailure(err, { action: 'click', target: { targetId: TARGET_ID, input: 'text=不存在' } });
    expect(text.split('\n')[0]).toBe(`Error: ${err.message}`);
    expect(text).toMatch(/^Kind: selector$/m);
  });

  it('a CSS click miss names the selector and points at text= or an @ref', async () => {
    const cdp = {
      send(method, params = {}) {
        if (method === 'Runtime.evaluate') {
          const selector = JSON.parse(String(params.expression).match(/'Element not found: ' \+ ("(?:[^"\\]|\\.)*")/)[1]);
          return Promise.resolve({ result: { value: { ok: false, error: `Element not found: ${selector}` } } });
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const err = await T.clickStr(cdp, 'sid', 'Save').catch(e => e);
    expect(err.message).toMatch(/^Element not found: Save\./);
    expect(err.message).toContain('"text=Save"');
    expect(err.message).toMatch(/@ref/);
    const css = await T.clickStr(cdp, 'sid', '#nope').catch(e => e);
    expect(css.message).toMatch(/^Element not found: #nope\./);
    expect(css.message).not.toContain('"text=');
    expect(css.message).toMatch(/@ref/);
    expect(classifyActionFailure(css, { action: 'click', target: { targetId: TARGET_ID, input: '#nope' } }).kind)
      .toBe('selector');
  });

  it('a plain-name miss also names the input and hints at an @ref', async () => {
    const { cdp } = fakePageCdp([BUTTON_NAME]);
    const err = await T.jsClickStr(cdp, 'sid', '不存在的按鈕').catch(e => e);
    expect(err.message).toMatch(/^Named control not found: "不存在的按鈕"\./);
    expect(err.message).toMatch(/@ref/);
  });
});

describe('#430 click receipts suggest perceive --since-action, not list', () => {
  function clickResult({ domDiff = null, navigation = null, targetId = TARGET_ID, dispatchMethod = 'click' } = {}) {
    return T.createActionResult({
      action: 'click',
      target: { ...(targetId ? { targetId } : {}), input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff, console: [], network: [], navigation },
    });
  }

  it('an in-page click that changed the AX tree prints Outcome: changed and Next perceive --since-action', () => {
    const text = T.formatActionResultOutput(clickResult({ domDiff: '+   [StaticText] Saved' }), {
      dispatchText: 'Clicked <BUTTON> "Save"',
    });
    expect(text).toBe(`Clicked <BUTTON> "Save". Next: cdp perceive ${PREFIX} --since-action`);
  });

  it('an unobserved named click (report-only) prints no outcome word and Next perceive --since-action', () => {
    const result = T.createActionResult({
      action: 'click',
      target: T.namedClickActionTarget(BUTTON_NAME, { targetId: TARGET_ID }),
      dispatch: { ok: true, method: 'jsclick' },
      settle: { ok: true, durationMs: 2 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionResultOutput(result, { dispatchText: `JS-clicked <BUTTON> "${BUTTON_NAME}"` });
    expect(text).toBe(`JS-clicked <BUTTON> "${BUTTON_NAME}". Next: cdp perceive ${PREFIX} --since-action`);
    expect(text).not.toMatch(/cdp list/);
  });

  it('a no-change click says so and keeps its diagnosis Next', () => {
    const noChange = [
      'Page: Fixture — http://127.0.0.1/',
      '(no changes detected in AX tree)',
    ].join('\n');
    const text = T.formatActionResultOutput(clickResult({ domDiff: noChange }), {
      dispatchText: 'Clicked <BUTTON> "Noop"',
    });
    expect(text).toMatch(/^Clicked <BUTTON> "Noop"\. Next: cdp perceive /);
    expect(text).not.toMatch(/Outcome:/);
    expect(text).not.toMatch(/cdp list/);
  });

  it('a click that navigated the same tab points at a fresh perceive, not list', () => {
    const result = clickResult({
      domDiff: '+ [RootWebArea] Two',
      navigation: { from: 'http://127.0.0.1/', to: 'http://127.0.0.1/two', changed: true },
    });
    const text = T.formatActionResultOutput(result, {
      dispatchText: 'JS-clicked <A> "Next page"\nURL: http://127.0.0.1/two',
    });
    expect(text).toBe(`JS-clicked <A> "Next page"\nURL: http://127.0.0.1/two. Next: cdp perceive ${PREFIX} -C -d 8`);
  });

  it('keeps Next: cdp list only when the receipt has no target to perceive', () => {
    const text = T.formatActionResultOutput(clickResult({ domDiff: '+   [StaticText] Saved', targetId: null }), {
      dispatchText: 'Clicked <BUTTON> "Save"',
    });
    expect(text).toBe('Clicked <BUTTON> "Save". Next: cdp list');
  });

  it('other skinny actions (fill) also stop suggesting list when the target is known', () => {
    const result = T.createActionResult({
      action: 'fill',
      target: { targetId: TARGET_ID, input: '#q', resolvedBy: 'selector', label: '#q', commandArgs: ['#q', 'abc'] },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '+   [textbox] 搜尋 = "abc"', console: [], network: [], navigation: null },
    });
    const text = T.formatActionResultOutput(result, { dispatchText: 'Filled <INPUT> with "abc"' });
    expect(text).toBe(`Filled <INPUT> with "abc". Next: cdp perceive ${PREFIX} --since-action`);
  });
});
