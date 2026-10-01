import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { buildMcpToolCommand } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
const {
  buildNoChangeOutcomeRecommendation,
  evalCommand,
  querySelectorEvalCommand,
} = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = '71DF370FDEADBEEF71DF370FDEADBEEF';

// Fake page for fillStr: one control whose live value follows a tiny model of the browser.
// `accept(text)` returns what the browser keeps after typing/setting `text` (number inputs drop
// non-numeric text). Page scripts are recognised by markers in the real expressions fillStr sends.
function fakeFillPage({ value = '', type = 'text', tag = 'INPUT', accept = text => text, refSelector = '#from-ref' } = {}) {
  const state = { value, events: [], calls: [] };
  const live = () => ({ ok: true, cdpFillLiveValue: true, tag, value: state.value, textContent: '' });
  const probe = (script) => {
    const before = state.value;
    // The pre-clear (`el.value = ''`) only runs when the probe script carries it.
    if (/el\.value = ''|this\.value = ''/.test(script)) {
      state.value = '';
      state.events.push('input');
    }
    return { ok: true, fillable: true, tag, type, before };
  };
  const nativeSet = (text) => {
    state.value = accept(text);
    state.events.push('native-set', 'input', 'change');
    return { tag, value: state.value };
  };
  const cdp = {
    calls: state.calls,
    send(method, params = {}) {
      state.calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('cdpFillLiveValue')) return Promise.resolve({ result: { value: live() } });
        return Promise.resolve({ result: { value: JSON.stringify(probe(expr)) } });
      }
      if (method === 'Input.insertText') {
        if (params.text !== '') {
          state.value = accept(String(state.value) + params.text);
          state.events.push('insertText', 'input');
        }
        return Promise.resolve({});
      }
      if (method === 'DOM.enable') return Promise.resolve({});
      if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
      if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 42 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj-1' } });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'root' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 901 });
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('cdpFillLiveValue')) return Promise.resolve({ result: { value: live() } });
        if (fn.includes('cdpFillUniqueSelector')) return Promise.resolve({ result: { value: refSelector } });
        if (params.arguments) return Promise.resolve({ result: { value: nativeSet(params.arguments[0].value) } });
        if (fn.includes('connected') || fn.includes('isConnected')) return Promise.resolve({ result: { value: true } });
        return Promise.resolve({ result: { value: probe(fn) } });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return { cdp, state };
}

const numberOnly = text => (/^-?\d*\.?\d*$/.test(text) ? text : '');

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

// Runs a recovery command through a real POSIX shell with `cdp` stubbed to print its argv, then
// returns the expression argument the CLI would have received.
function shellEvalArg(command) {
  const res = spawnSync('sh', ['-c', `cdp() { printf '%s' "$3"; }; ${command}`], { encoding: 'utf8' });
  expect(res.status).toBe(0);
  return res.stdout;
}

function selectorFromEvalExpression(expression) {
  let seen = null;
  const document = { querySelector(sel) { seen = sel; return { value: 'v', textContent: 't', outerHTML: '<x>' }; } };
  new Function('document', 'getComputedStyle', `return (${expression});`)(document, el => el);
  return seen;
}

describe('#428 fill reports the real before/after value', () => {
  it('reports a value change ("0.5" -> "") instead of fill-no-change when a number input rejects text', async () => {
    const { cdp, state } = fakeFillPage({ value: '0.5', type: 'number', accept: numberOnly });
    const err = await rejection(T.fillStr(cdp, 'sid', '#amp', 'abc', new Map()));
    expect(state.value).toBe('');
    expect(err.fillValue).toMatchObject({ before: '0.5', after: '', requested: 'abc', inputType: 'number', changed: true });

    const target = { targetId: TARGET_ID, input: '#amp' };
    const failure = T.classifyActionFailure(err, { action: 'fill', target });
    expect(failure.kind).toBe('fill-value-mismatch');
    expect(failure.kind).not.toBe('fill-no-change');
    expect(failure.pageChanged).toBe(true);
    expect(failure.value).toMatchObject({ before: '0.5', after: '', requested: 'abc' });

    const text = T.formatActionFailure(err, { action: 'fill', target });
    expect(text).toMatch(/^Kind: fill-value-mismatch$/m);
    expect(text).toMatch(/^Value: "0\.5" → "" \(requested "abc"; <input type=number> rejected the text\)$/m);
    expect(text).toMatch(/^Next: cdp eval 71DF370F "document\.querySelector\('#amp'\)\?\.value"$/m);
  });

  it('marks the failed action outcome as changed so JSON does not hide the mutation', async () => {
    const { cdp } = fakeFillPage({ value: '0.5', type: 'number', accept: numberOnly });
    const out = await T.runActionWithFeedback({
      action: 'fill',
      target: { targetId: TARGET_ID, input: '#amp', resolvedBy: 'selector-or-ref', label: '#amp', commandArgs: ['#amp', 'abc'] },
      dispatch: () => T.fillStr(cdp, 'sid', '#amp', 'abc', new Map()),
      feedbackPolicy: 'settle-diff',
      observe: async () => '(no changes detected in AX tree)',
      format: 'json',
    });
    const parsed = JSON.parse(out);
    expect(parsed.dispatch.ok).toBe(false);
    expect(parsed.outcome.status).toBe('failed');
    expect(parsed.outcome.changed).toBe(true);
    expect(parsed.effects.failure.kind).toBe('fill-value-mismatch');
    expect(parsed.effects.failure.value).toMatchObject({ before: '0.5', after: '' });
  });

  it('keeps fill-no-change only when the value really did not change', async () => {
    const { cdp } = fakeFillPage({ value: '', accept: () => '' });
    const err = await rejection(T.fillStr(cdp, 'sid', '#chat', 'hello', new Map()));
    expect(err.fillValue).toMatchObject({ before: '', after: '', changed: false });
    const failure = T.classifyActionFailure(err, { action: 'fill', target: { targetId: TARGET_ID, input: '#chat' } });
    expect(failure.kind).toBe('fill-no-change');
    expect(failure.pageChanged).not.toBe(true);
  });

  it('builds shell-safe eval Next lines for any selector', () => {
    const selectors = ['#amp', 'input[name="q"]', "input[data-k='a\"b']", 'a[href$="x"]', 'div:has(> `b`)', 'p\\:x'];
    for (const selector of selectors) {
      const command = querySelectorEvalCommand('71DF370F', selector, '?.value');
      expect(command.startsWith('cdp eval 71DF370F ')).toBe(true);
      const expression = shellEvalArg(command);
      expect(selectorFromEvalExpression(expression)).toBe(selector);
    }
    expect(querySelectorEvalCommand('71DF370F', '#amp', '?.value'))
      .toBe(`cdp eval 71DF370F "document.querySelector('#amp')?.value"`);
    expect(shellEvalArg(evalCommand('71DF370F', 'document.contentType'))).toBe('document.contentType');
  });

  it('never treats an @ref as CSS: resolves it to a real selector or falls back to perceive', async () => {
    expect(querySelectorEvalCommand('71DF370F', '@2', '?.value')).toBeNull();

    const refMap = new Map([[2, 202]]);
    const { cdp } = fakeFillPage({ value: '0.5', type: 'number', accept: numberOnly, refSelector: 'body > input:nth-of-type(1)' });
    const err = await rejection(T.fillStr(cdp, 'sid', '@2', 'abc', refMap));
    const failure = T.classifyActionFailure(err, { action: 'fill', target: { targetId: TARGET_ID, input: '@2' } });
    expect(failure.nextCommand).not.toContain('@2');
    expect(selectorFromEvalExpression(shellEvalArg(failure.nextCommand))).toBe('body > input:nth-of-type(1)');

    const bare = new Error('fill: @2 did not accept "abc"; live value is still empty');
    const fallback = T.classifyActionFailure(bare, { action: 'fill', target: { targetId: TARGET_ID, input: '@2' } });
    expect(fallback.nextCommand).toBe(`cdp perceive ${TARGET_ID} -C -d 8`);
    expect(fallback.nextCommand).not.toContain('querySelector');
  });

  it('fixes the same quoting bug in html/styles/text fallbacks', async () => {
    const textErr = T.formatTextNoMatchError({ tried: ['#promptBlock'], root: 'body' }, { selectors: ['#promptBlock'], root: 'body' });
    expect(textErr).toContain(`cdp eval <target> "document.querySelector('#promptBlock')?.textContent"`);

    const page = {
      send(method, params = {}) {
        const expr = String(params.expression || '');
        if (expr.includes('contentType') || expr.includes('document.title')) {
          return Promise.resolve({ result: { value: JSON.stringify({ title: 'x', url: 'https://example.com/', contentType: 'text/html' }) } });
        }
        return Promise.resolve({ result: { value: JSON.stringify({ ok: false, root: 'document', selector: 'input[name="q"]' }) } });
      },
    };
    const stylesErr = await rejection(T.stylesStr(page, 'sid', ['input[name="q"]'], { targetPrefix: '1D366978' }));
    const stylesCmd = stylesErr.message.match(/Fallback: (cdp eval .*)$/)[1];
    expect(selectorFromEvalExpression(shellEvalArg(stylesCmd))).toBe('input[name="q"]');

    const htmlErr = await rejection(T.htmlStr(page, 'sid', ['input[name="q"]'], { targetPrefix: '1D366978' }));
    const htmlCmd = htmlErr.message.match(/Fallback: (cdp eval .*)$/)[1];
    expect(selectorFromEvalExpression(shellEvalArg(htmlCmd))).toBe('input[name="q"]');
  });

  it('redacts password values in the value transition', async () => {
    const { cdp } = fakeFillPage({ value: 'hunter2', type: 'password', accept: () => 'x' });
    const err = await rejection(T.fillStr(cdp, 'sid', '#pw', 'abc', new Map()));
    expect(JSON.stringify(err.fillValue)).not.toContain('hunter2');
    expect(err.message).not.toContain('hunter2');
    const text = T.formatActionFailure(err, { action: 'fill', target: { targetId: TARGET_ID, input: '#pw' } });
    expect(text).not.toContain('hunter2');
  });
});

describe('#429 fill "" clears a field', () => {
  it('clears through the native setter path (input + change), not the pre-clear that React ignores', async () => {
    const { cdp, state } = fakeFillPage({ value: 'Ada' });
    const out = await T.fillStr(cdp, 'sid', '#name', '', new Map());
    expect(state.value).toBe('');
    expect(state.events).toEqual(['native-set', 'input', 'change']);
    expect(out).toBe('Cleared <INPUT> (was "Ada")');
    expect(cdp.calls.some(call => call.method === 'Input.insertText')).toBe(false);
  });

  it('clears an @ref through the native setter path too', async () => {
    const { cdp, state } = fakeFillPage({ value: 'Ada' });
    const out = await T.fillStr(cdp, 'sid', '@1', '', new Map([[1, 101]]));
    expect(state.value).toBe('');
    expect(state.events).toEqual(['native-set', 'input', 'change']);
    expect(out).toBe('Cleared @1 (was "Ada")');
  });

  it('fails the clear when the page puts the value back (an <input> textContent is always "")', async () => {
    // A controlled input that re-renders its old value: the native set of "" does not stick.
    const { cdp, state } = fakeFillPage({ value: 'Ada', accept: text => (text === '' ? 'Ada' : text) });
    const err = await rejection(T.fillStr(cdp, 'sid', '#name', '', new Map()));
    expect(state.value).toBe('Ada');
    expect(err.message).toMatch(/did not accept ""; value stayed "Ada"/);
    expect(err.fillValue).toMatchObject({ before: 'Ada', after: 'Ada', changed: false });
  });

  it('accepts an exact empty value, not empty textContent, as a clear', () => {
    expect(T.fillLiveValueAccepted({ ok: true, value: 'Ada', textContent: '' }, '')).toBe(false);
    expect(T.fillLiveValueAccepted({ ok: true, value: '', textContent: '' }, '')).toBe(true);
    // An emptied contenteditable can keep a trailing <br>, which innerText reports as "\n".
    expect(T.fillLiveValueAccepted({ ok: true, value: '\n', textContent: '' }, '')).toBe(true);
  });

  it('reports no change when the field is already empty', async () => {
    const valueState = {};
    const { cdp } = fakeFillPage({ value: '' });
    const out = await T.fillStr(cdp, 'sid', '#name', '', new Map(), null, { valueState });
    expect(out).toBe('Cleared <INPUT> (value unchanged: already empty)');
    expect(valueState).toMatchObject({ before: '', after: '', changed: false });
  });

  it('reports the previous value on an ordinary fill', async () => {
    const valueState = {};
    const { cdp } = fakeFillPage({ value: 'Bob' });
    const out = await T.fillStr(cdp, 'sid', '#name', 'Carl', new Map(), null, { valueState });
    expect(out).toBe('Filled <INPUT> with "Carl" (was "Bob")');
    expect(valueState).toMatchObject({ before: 'Bob', after: 'Carl', changed: true });
  });

  it('still rejects a missing text argument but accepts an explicit empty string', async () => {
    expect(T.parseFillArgs(['#name']).text).toBeNull();
    expect(T.parseFillArgs(['#name', '']).text).toBe('');
    expect(T.parseFillArgs(['--react', '#name', '']).text).toBe('');
    expect(T.fillCliArgError(['#name'])).toBe('text required');
    expect(T.fillCliArgError(['#name', '--format', 'json'])).toBe('text required');
    expect(T.fillCliArgError(['#name', ''])).toBeNull();
    expect(T.fillCliArgError(['--react', '#name', ''])).toBeNull();
    expect(T.fillCliArgError([])).toBe('selector required');
    expect(T.normalizeTargetCommandArgs('fill', ['#name', ''])).toEqual(['#name', '']);
    const { cdp } = fakeFillPage({ value: 'Ada' });
    await expect(T.fillStr(cdp, 'sid', '#name', null, new Map())).rejects.toThrow(/Text required/);
  });

  it('maps MCP text "" to a clear and a missing MCP text to an error', () => {
    expect(buildMcpToolCommand('fill', { target: 'T1', selector: '#name', text: '', confirm: true }))
      .toEqual(['fill', 'T1', '#name', '', '--format', 'json']);
    expect(() => buildMcpToolCommand('fill', { target: 'T1', selector: '#name', confirm: true }))
      .toThrow(/text is required/);
  });

  it('turns the value transition into receipt state: changed, or an expected no-change', () => {
    const cleared = { input: '#name' };
    T.applyFillValueState(cleared, { before: 'Ada', after: '', requested: '', changed: true });
    expect(cleared).toMatchObject({ controlStateChanged: true, controlStateDiff: 'value "Ada" → ""', fillValue: { before: 'Ada', after: '' } });
    expect(cleared.expectedOutcome).toBeUndefined();

    const already = { input: '#name' };
    T.applyFillValueState(already, { before: '', after: '', requested: '', changed: false });
    expect(already.controlStateChanged).toBeUndefined();
    expect(already.expectedOutcome).toBe('fill-value-unchanged');
    const outcome = T.buildActionOutcome({
      action: 'fill',
      target: already,
      dispatch: { ok: true },
      settle: { ok: true },
      effects: { domDiff: '(no changes detected in AX tree)' },
    });
    expect(outcome).toMatchObject({ status: 'no-change', needsAttention: false });
    const recommendation = buildNoChangeOutcomeRecommendation({ action: 'fill', target: '71DF370F', targetInput: '#name', targetInfo: already });
    expect(recommendation).toMatchObject({ strategy: 'continue', blockingSignals: [] });
    expect(recommendation.recoveryHint).not.toMatch(/key/i);

    const changedOutcome = T.buildActionOutcome({
      action: 'fill',
      target: cleared,
      dispatch: { ok: true },
      settle: { ok: true },
      effects: { domDiff: '(no changes detected in AX tree)' },
    });
    expect(changedOutcome).toMatchObject({ status: 'changed', changed: true });
  });

  it('adds the previous value to the compact fill.v1 receipt', () => {
    const receipt = T.compactFillReceiptForJson({
      action: 'fill',
      target: { targetId: TARGET_ID, input: '#name', commandArgs: ['#name', ''], fillValue: { before: 'Ada', after: '' } },
      outcome: { status: 'changed', changed: true },
      effects: {},
    });
    expect(receipt).toMatchObject({ schema: 'chrome-cdp-ex.fill.v1', value: '', previousValue: 'Ada', changed: true });
  });
});
