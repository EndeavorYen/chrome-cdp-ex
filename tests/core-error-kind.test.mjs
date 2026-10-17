// #636: Kind names where the failure came from. The same failure has the same
// Kind and Next on every command, and a page's own text is not tool usage.
import { describe, expect, it } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';
import { daemonCommandCatchResult } from '../skills/chrome-cdp-ex/scripts/lib/cdp-daemon.mjs';
import { frameScopedBackendNode } from '../skills/chrome-cdp-ex/scripts/lib/cdp-perceive.mjs';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET = 'ABCD1234';
const CONSOLE = `cdp console ${TARGET}`;
const STATUS = `cdp status ${TARGET}`;
const PERCEIVE = `cdp perceive ${TARGET} -C -d 8`;
const FRAME = `cdp frame ${TARGET}`;
const SCROLL_HELP = 'cdp help scroll';
const FIELD_REQUIRED = 'Field is required';
const SAVE_FAILED = 'Save failed';
const DNS = 'net::ERR_NAME_NOT_RESOLVED';
const REFUSED = 'net::ERR_CONNECTION_REFUSED';
const TEXT_MISS = 'text: no element matched within root "document". Tried: #does-not-exist.';
const CLICK_MISS = 'Element not found: #does-not-exist';
const SCROLL_DIRECTION = 'Direction required: down, up, left, right, x,y, or to top/to bottom';
const SCROLL_EDGE = 'Direction required: to top or to bottom';
const UNKNOWN_FRAME = 'Unknown frame: @f3. Run "frame" to refresh the frame tree, then use a listed @fN ref.';

function pageException(message) {
  const err = new Error(message);
  err.pageException = true;
  return err;
}

function cli(message, cmd, err = null) {
  return T.buildCliErrorRecovery(message, { cmd, targetPrefix: TARGET, err });
}

function act(err, action) {
  return T.classifyActionFailure(err, { action, target: { targetId: TARGET } });
}

function expectPair(message, cmd, err, kind, next) {
  const recovery = cli(message, cmd, err);
  const failure = act(err || new Error(message), cmd);
  expect(recovery.kind, `cli ${cmd}`).toBe(kind);
  expect(recovery.run, `cli ${cmd}`).toBe(next);
  expect(failure.kind, `action ${cmd}`).toBe(kind);
  expect(failure.nextCommand, `action ${cmd}`).toBe(next);
  expect(T.ERROR_KINDS, `cli ${cmd} kind`).toContain(recovery.kind);
  expect(T.ERROR_KINDS, `action ${cmd} kind`).toContain(failure.kind);
}

function catchContext(cmd, targetId = `${TARGET}DEADBEEF`) {
  return {
    cdp: {},
    sessionId: 'sid',
    cmd,
    args: [],
    targetId,
    session: {},
    dialogBuf: {},
    dialogSince: 0,
    jsDialogs: { hasPending: () => false },
  };
}

describe('error kind by source (#636)', () => {
  it('a page exception "Field is required" is page-exception, not help eval', () => {
    const err = pageException(FIELD_REQUIRED);
    expectPair(FIELD_REQUIRED, 'eval', err, 'page-exception', CONSOLE);
    const text = T.formatCliError(err, { cmd: 'eval', targetPrefix: TARGET });
    expect(text).toContain('Kind: page-exception');
    expect(text).toContain(`Next: ${CONSOLE}`);
    expect(text).not.toContain('cdp help eval');
    const actionText = T.formatActionFailure(err, { action: 'eval', target: { targetId: TARGET } });
    expect(actionText).toContain('Kind: page-exception');
    expect(actionText).toContain(`Next: ${CONSOLE}`);
  });

  it('a page exception "Save failed" has that same Kind and Next', () => {
    expectPair(SAVE_FAILED, 'eval', pageException(SAVE_FAILED), 'page-exception', CONSOLE);
  });

  it('eval, eval64, and call share the page-exception Kind and Next', () => {
    for (const cmd of ['eval', 'eval64', 'call']) {
      expectPair(FIELD_REQUIRED, cmd, pageException(FIELD_REQUIRED), 'page-exception', CONSOLE);
      expectPair(SAVE_FAILED, cmd, pageException(SAVE_FAILED), 'page-exception', CONSOLE);
    }
  });

  it('does not classify a page exception from its message text', () => {
    const message = 'SyntaxError: Field is required. net::ERR_FAILED. Element not found. Unknown frame: @f3.';
    expectPair(message, 'eval', pageException(message), 'page-exception', CONSOLE);
    const full = 'ABCD1234DEADBEEF0123456789ABCDEF';
    expect(T.classifyActionFailure(pageException(FIELD_REQUIRED), {
      action: 'eval',
      target: { targetId: full },
    }).nextCommand).toBe(CONSOLE);
  });

  it('tags Runtime exceptionDetails from eval and call at the source', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'Error: Field is required\n    at save (page.js:1:1)' },
        },
      }),
    });
    await expect(T.evalStr(cdp, 'sid', 'throw new Error("Field is required")', true, { pageException: true }))
      .rejects.toMatchObject({ pageException: true });
    await expect(T.callStr(cdp, 'sid', '() => { throw new Error("Save failed"); }'))
      .rejects.toMatchObject({ pageException: true });
    await expect(T.evalStr(cdp, 'sid', 'throw new Error("Field is required")', true)).rejects.toMatchObject({
      message: expect.stringContaining('Field is required'),
    });
    try {
      await T.evalStr(cdp, 'sid', 'throw new Error("Field is required")', true);
    } catch (err) {
      expect(err.pageException).toBeUndefined();
    }
  });

  it('does not treat untagged page prose that says "is required" as tool usage', () => {
    const recovery = cli(FIELD_REQUIRED, 'eval');
    expect(recovery.kind).not.toBe('usage');
    expect(recovery.run).not.toBe('cdp help eval');
    expect(cli('Please fill the Field is required before save', 'eval').kind).not.toBe('usage');
    expect(cli('selector required', 'fill')).toMatchObject({
      kind: 'usage',
      run: `cdp fill ${TARGET} <selector|@ref> <text>`,
    });
    expect(cli('Expression required', 'eval')).toMatchObject({ kind: 'usage', run: 'cdp help eval' });
    expect(cli('text: target prefix is required', 'text')).toMatchObject({ kind: 'usage', run: 'cdp help text' });
    expect(cli("SyntaxError: Unexpected identifier 'format'", 'eval').kind).toBe('eval');
  });

  it('classifies net::ERR_NAME_NOT_RESOLVED as navigation with one Next on nav and click', () => {
    expectPair(DNS, 'nav', null, 'navigation', STATUS);
    expectPair(DNS, 'click', null, 'navigation', STATUS);
    expectPair(REFUSED, 'nav', null, 'navigation', STATUS);
    expectPair(REFUSED, 'eval', null, 'navigation', STATUS);
    const navText = T.formatCliError(new Error(DNS), { cmd: 'nav', targetPrefix: TARGET });
    const clickText = T.formatActionFailure(new Error(DNS), { action: 'click', target: { targetId: TARGET } });
    expect(navText).toContain('Kind: navigation');
    expect(navText).toContain(`Next: ${STATUS}`);
    expect(clickText).toContain('Kind: navigation');
    expect(clickText).toContain(`Next: ${STATUS}`);
  });

  it('tags a Chrome navigation errorText at the source', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ errorText: DNS }),
    });
    await expect(T.navStr(cdp, 'sid', 'http://no-such-host.invalid/'))
      .rejects.toMatchObject({ navigationFailure: true, message: DNS });
  });

  it('classifies a text selector miss like a click selector miss', () => {
    expectPair(TEXT_MISS, 'text', null, 'selector', PERCEIVE);
    expectPair(CLICK_MISS, 'click', null, 'selector', PERCEIVE);
    expect(cli(TEXT_MISS, 'text').run).toBe(cli(CLICK_MISS, 'click').run);
    expect(act(new Error(TEXT_MISS), 'text').nextCommand).toBe(act(new Error(CLICK_MISS), 'click').nextCommand);
  });

  it('tags a text selector miss at the source', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: JSON.stringify({ ok: false, root: 'document', tried: ['#does-not-exist'] }) },
      }),
    });
    await expect(T.textStr(cdp, 'sid', ['#does-not-exist']))
      .rejects.toMatchObject({ selectorMiss: true, message: expect.stringContaining('no element matched') });
  });

  it('classifies a missing scroll direction as usage with cdp help scroll', () => {
    expectPair(SCROLL_DIRECTION, 'scroll', null, 'usage', SCROLL_HELP);
    expectPair(SCROLL_EDGE, 'scroll', null, 'usage', SCROLL_HELP);
    const text = T.formatCliError(new Error(SCROLL_DIRECTION), { cmd: 'scroll', targetPrefix: TARGET });
    expect(text).toContain('Kind: usage');
    expect(text).toContain(`Next: ${SCROLL_HELP}`);
    expect(text).not.toContain('<required-args>');
    const actionText = T.formatActionFailure(new Error(SCROLL_DIRECTION), {
      action: 'scroll',
      target: { targetId: TARGET },
    });
    expect(actionText).toContain('Kind: usage');
    expect(actionText).toContain(`Next: ${SCROLL_HELP}`);
  });

  it('tags a missing scroll direction as a tool usage error', async () => {
    await expect(T.scrollStr(null, 'sid', 'bottom')).rejects.toMatchObject({
      usage: true,
      code: 'usage',
      message: SCROLL_DIRECTION,
    });
    expect(() => T.parseScrollEdge('to')).toThrowError(expect.objectContaining({
      usage: true,
      code: 'usage',
      message: SCROLL_EDGE,
    }));
  });

  it('classifies an unknown perceive frame as wrong-frame with cdp frame', () => {
    expectPair(UNKNOWN_FRAME, 'perceive', null, 'wrong-frame', FRAME);
    const text = T.formatCliError(new Error(UNKNOWN_FRAME), { cmd: 'perceive', targetPrefix: TARGET });
    expect(text).toContain('Kind: wrong-frame');
    expect(text).toContain(`Next: ${FRAME}`);
    expect(text).not.toContain(`Next: ${STATUS}`);
  });

  it('tags an unknown frame at the source', () => {
    expect(() => frameScopedBackendNode({}, { frameRef: '@f3', refIndex: 1 })).toThrowError(
      expect.objectContaining({ unknownFrame: true }),
    );
  });

  it('lists every kind the classifiers return', () => {
    expect(Array.isArray(T.ERROR_KINDS)).toBe(true);
    expect(new Set(T.ERROR_KINDS).size).toBe(T.ERROR_KINDS.length);
    const samples = [
      [FIELD_REQUIRED, 'eval', pageException(FIELD_REQUIRED)],
      [DNS, 'nav', null],
      [TEXT_MISS, 'text', null],
      [CLICK_MISS, 'click', null],
      [SCROLL_DIRECTION, 'scroll', null],
      [UNKNOWN_FRAME, 'perceive', null],
      ['selector required', 'fill', null],
      ['something odd happened', 'eval', null],
    ];
    for (const [message, cmd, err] of samples) {
      expect(T.ERROR_KINDS).toContain(cli(message, cmd, err).kind);
      expect(T.ERROR_KINDS).toContain(act(err || new Error(message), cmd).kind);
    }
  });

  it('forwards a source tag across the daemon and prints that Kind', async () => {
    const evalResult = await daemonCommandCatchResult(pageException(FIELD_REQUIRED), catchContext('eval'));
    expect(evalResult.error).toBe(FIELD_REQUIRED);
    expect(evalResult.errorSource).toEqual({ pageException: true });
    const evalPrinted = T.formatCliError(T.cliErrorFromDaemonResponse(evalResult), {
      cmd: 'eval',
      targetPrefix: TARGET,
    });
    expect(evalPrinted).toContain('Kind: page-exception');
    expect(evalPrinted).toContain(`Next: ${CONSOLE}`);
    expect(evalPrinted).not.toContain('cdp help eval');

    const navErr = new Error(DNS);
    navErr.navigationFailure = true;
    const navResult = await daemonCommandCatchResult(navErr, catchContext('nav'));
    expect(navResult.errorSource).toMatchObject({ navigationFailure: true });
    expect(navResult.error).toContain('Kind: navigation');
    expect(navResult.error).toContain(`Next: ${STATUS}`);

    const textErr = new Error(TEXT_MISS);
    textErr.selectorMiss = true;
    const textResult = await daemonCommandCatchResult(textErr, catchContext('text'));
    expect(textResult.error).toBe(TEXT_MISS);
    expect(textResult.errorSource).toEqual({ selectorMiss: true });
    const textPrinted = T.formatCliError(T.cliErrorFromDaemonResponse(textResult), {
      cmd: 'text',
      targetPrefix: TARGET,
    });
    expect(textPrinted).toContain('Kind: selector');
    expect(textPrinted).toContain(`Next: ${PERCEIVE}`);

    const scrollErr = new Error(SCROLL_DIRECTION);
    scrollErr.usage = true;
    scrollErr.code = 'usage';
    const scrollResult = await daemonCommandCatchResult(scrollErr, catchContext('scroll'));
    expect(scrollResult.error).toBe(SCROLL_DIRECTION);
    expect(scrollResult.errorSource).toEqual({ usage: true, code: 'usage' });
    const scrollPrinted = T.formatCliError(T.cliErrorFromDaemonResponse(scrollResult), {
      cmd: 'scroll',
      targetPrefix: TARGET,
    });
    expect(scrollPrinted).toContain('Kind: usage');
    expect(scrollPrinted).toContain(`Next: ${SCROLL_HELP}`);

    const frameErr = new Error(UNKNOWN_FRAME);
    frameErr.unknownFrame = true;
    const frameResult = await daemonCommandCatchResult(frameErr, catchContext('perceive'));
    expect(frameResult.error).toBe(UNKNOWN_FRAME);
    expect(frameResult.errorSource).toEqual({ unknownFrame: true });
    const framePrinted = T.formatCliError(T.cliErrorFromDaemonResponse(frameResult), {
      cmd: 'perceive',
      targetPrefix: TARGET,
    });
    expect(framePrinted).toContain('Kind: wrong-frame');
    expect(framePrinted).toContain(`Next: ${FRAME}`);

    expect(T.cliErrorFromDaemonResponse({ ok: false, error: 'boom' })).toBe('boom');
  });

  it('classifies async eval inference failures as Kind: eval (#751)', () => {
    const messages = [
      'eval: cannot infer the final async expression safely; add an explicit return for the desired result.',
      'eval: multi-statement async input is ambiguous; add an explicit return for the desired result.',
    ];
    for (const message of messages) {
      for (const cmd of ['eval', 'eval64']) {
        const recovery = cli(message, cmd);
        expect(recovery.kind, cmd).toBe('eval');
        expect(recovery.run, cmd).toBe('cdp help eval');
        const text = T.formatCliError(new Error(message), { cmd, targetPrefix: TARGET });
        expect(text).toContain('Kind: eval');
        expect(text).toContain('Next: cdp help eval');
        expect(text).toMatch(/explicit return/);
        expect(text).not.toContain('Kind: unknown');
        expect(text).not.toContain('Kind: target-resolution');
      }
    }
    expect(() => T.wrapAwaitExpression('const v = await Promise.resolve(2); if (v) { v * 10 }', true))
      .toThrow(/cannot infer the final async expression safely/);
    expect(() => T.wrapAwaitExpression('const value = await Promise.resolve(42);', true))
      .toThrow(/multi-statement async input is ambiguous/);
  });
});
