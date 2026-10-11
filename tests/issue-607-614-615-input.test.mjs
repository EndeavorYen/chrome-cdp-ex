import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { classifyActionFailure, formatActionFailure } from '../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET_ID = 'BB65E689CEA88A787E777B3A5E650842';
const PREFIX = 'BB65E689';

function mouseEvents(cdp) {
  return cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
}

function nextLines(text) {
  return String(text || '').split('\n').filter(line => line.startsWith('Next:'));
}

function clickEvalCdp(value) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value } });
      if (method === 'Input.dispatchMouseEvent') return Promise.resolve({});
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'root' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 1 });
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
}

function failureText(err, action, input) {
  return formatActionFailure(err, {
    action,
    target: { targetId: TARGET_ID, input },
  });
}

describe('#614 zero-size and off-viewport clicks are not sent', () => {
  it('#614 does not click a zero-size target at the origin', async () => {
    const cdp = clickEvalCdp({
      ok: true, x: 0, y: 0, w: 0, h: 0, tag: 'BUTTON', text: 'HIDDEN',
    });
    const err = await T.clickStr(cdp, 'sid', '#hidden', new Map()).catch(error => error);
    expect(mouseEvents(cdp)).toEqual([]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/no clickable box/);
    expect(err.message).toMatch(/#hidden/);
    const failure = classifyActionFailure(err, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#hidden' },
    });
    expect(failure).toMatchObject({ kind: 'no-click-box', dispatched: false });
    const text = failureText(err, 'click', '#hidden');
    expect(text).toMatch(/Kind: no-click-box/);
    expect(nextLines(text)).toEqual([`Next: cdp jsclick ${PREFIX} "#hidden"`]);
  });

  it('#614 does not click an off-viewport target at the origin', async () => {
    const cdp = clickEvalCdp({
      ok: true, x: 0, y: 0, w: 30, h: 16, inViewport: false, tag: 'BUTTON', text: 'Off',
    });
    const err = await T.clickStr(cdp, 'sid', '#off', new Map()).catch(error => error);
    expect(mouseEvents(cdp)).toEqual([]);
    expect(err).toBeInstanceOf(Error);
    const text = failureText(err, 'click', '#off');
    expect(text).toMatch(/Kind: no-click-box/);
    expect(nextLines(text)).toEqual([`Next: cdp jsclick ${PREFIX} "#off"`]);
  });

  it('#614 does not click a zero-size cursor ref', async () => {
    const refMap = new Map([
      ['c1', { x: 0, y: 0, w: 0, h: 0, sel: 'button', text: 'hidden' }],
    ]);
    const cdp = clickEvalCdp({ ok: true });
    const err = await T.clickStr(cdp, 'sid', '@c1', refMap).catch(error => error);
    expect(mouseEvents(cdp)).toEqual([]);
    expect(classifyActionFailure(err, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '@c1' },
    }).kind).toBe('no-click-box');
  });

  it('#614 resolves a descendant or label box and refuses a box that stays unusable', async () => {
    const dom = fakeClickDom();
    const zero = dom.el('button', { id: 'hidden', rect: { x: 0, y: 0, width: 0, height: 0 } });
    const hidden = await settledRect(dom.context, zero);
    expect(hidden.noClickBox).toBe(true);
    expect(hidden.w).toBe(0);
    expect(hidden.h).toBe(0);

    const shell = dom.el('button', { id: 'childbox', rect: { x: 12, y: 122, width: 0, height: 0 } });
    const child = dom.el('span', { rect: { x: 12, y: 122, width: 0, height: 0 } });
    child.getClientRects = () => [{ x: 12, y: 122, width: 80, height: 24 }];
    shell.querySelectorAll = () => [child];
    const resolved = await settledRect(dom.context, shell);
    expect(resolved).toMatchObject({ x: 12, y: 122, w: 80, h: 24, noClickBox: false });

    const input = dom.el('input', { rect: { x: 0, y: 0, width: 0, height: 0 } });
    const label = dom.el('label', { rect: { x: 16, y: 40, width: 100, height: 20 } });
    input.labels = [label];
    input.querySelectorAll = () => [];
    input.getClientRects = () => [];
    const labeled = await settledRect(dom.context, input);
    expect(labeled).toMatchObject({ x: 16, y: 40, w: 100, h: 20, noClickBox: false });

    const off = dom.el('button', { id: 'off', rect: { x: -40, y: -40, width: 10, height: 10 } });
    off.querySelectorAll = () => [];
    const outside = await settledRect(dom.context, off);
    expect(outside.noClickBox).toBe(true);
  });
});

describe('#615 flow and batch quoting', () => {
  it('#615 quoted flow text is stored without the wrapping quotes', () => {
    const space = T.parseFlowSteps('fill #note " "');
    expect(T.parseFillArgs(space[0].args).text).toBe(' ');
    const phrase = T.parseFlowSteps('fill #note "hello world"');
    expect(phrase[0].args).toEqual(['#note', 'hello world']);
    expect(T.parseFillArgs(phrase[0].args).text).toBe('hello world');
    const cleared = T.parseFlowSteps('fill #name ""');
    expect(T.parseFillArgs(cleared[0].args)).toMatchObject({ text: '', selector: '#name' });
    const selector = T.parseFlowSteps('click input[name="q"]');
    expect(selector[0].args).toEqual(['input[name="q"]']);
  });

  it('#615 quoted batch text is one argument', () => {
    const parsed = T.parseBatchArgs(['fill #note "hello world"']);
    expect(parsed.commands[0]).toMatchObject({ cmd: 'fill', args: ['#note', 'hello world'] });
    expect(T.parseFillArgs(parsed.commands[0].args).text).toBe('hello world');
    const blank = T.parseBatchArgs(['fill #note " "']);
    expect(T.parseFillArgs(blank.commands[0].args).text).toBe(' ');
  });

  it('#615 a quoted flag-like word is text and an unquoted --secret stays a flag', () => {
    const quoted = T.parseFlowSteps('fill #note "--secret"');
    expect(T.parseFillArgs(quoted[0].args)).toMatchObject({ text: '--secret', secretName: null });
    const flag = T.parseFlowSteps('fill #pw --secret TOKEN');
    expect(T.parseFillArgs(flag[0].args)).toMatchObject({ secretName: 'TOKEN', text: null, selector: '#pw' });
  });
});

describe('#607 press delivery', () => {
  it('#607 does not report success when the page receives no keydown', async () => {
    const cdp = pressProbeCdp({ matched: false, visibility: 'visible' });
    const err = await T.pressStr(cdp, 'sid', 'Escape', { deliveryWaitMs: 0 }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/no keydown/);
    expect(err.message).not.toMatch(/^Pressed /);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent' && call.params.type === 'keyDown')).toBe(true);
    expect(cdp.calls.some(call => call.method === 'Target.activateTarget' || call.method === 'Browser.setWindowBounds')).toBe(false);
    const failure = classifyActionFailure(err, {
      action: 'press',
      target: { targetId: TARGET_ID, input: 'Escape' },
    });
    expect(failure).toMatchObject({ kind: 'press-not-delivered', dispatched: false });
    const text = failureText(err, 'press', 'Escape');
    expect(text).toMatch(/Kind: press-not-delivered/);
    expect(nextLines(text)).toEqual([`Next: cdp perceive ${PREFIX} -C -d 8`]);
  });

  it('#607 hidden tab next activates the tab and does not raise the window', async () => {
    const cdp = pressProbeCdp({ matched: false, visibility: 'hidden' });
    const err = await T.pressStr(cdp, 'sid', 'Escape', { deliveryWaitMs: 0 }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(cdp.calls.some(call => call.method === 'Target.activateTarget' || call.method === 'Browser.setWindowBounds')).toBe(false);
    const text = failureText(err, 'press', 'Escape');
    expect(nextLines(text)).toEqual([`Next: CDP_BACKGROUND=0 cdp press ${PREFIX} Escape`]);
    expect(text.match(/^Next:/gm)).toHaveLength(1);
  });

  it('reports Pressed when the keydown probe matches', async () => {
    const cdp = pressProbeCdp({ matched: true, visibility: 'visible' });
    await expect(T.pressStr(cdp, 'sid', 'Escape', { deliveryWaitMs: 0 })).resolves.toBe('Pressed Escape');
    expect(cdp.calls.some(call => call.method === 'Target.activateTarget' || call.method === 'Browser.setWindowBounds')).toBe(false);
  });
});

function pressProbeCdp({ matched = false, visibility = 'visible' } = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('chrome-cdp-ex.press-probe.v1')) {
          const installing = expr.includes("addEventListener('keydown'");
          return Promise.resolve({
            result: {
              value: {
                marker: 'chrome-cdp-ex.press-probe.v1',
                ok: true,
                installed: true,
                matched: installing ? false : matched,
                count: !installing && matched ? 1 : 0,
              },
            },
          });
        }
        if (expr.includes('visibilityState')) return Promise.resolve({ result: { value: visibility } });
        if (expr.includes('chrome-cdp-ex.search-submit')) return Promise.resolve({ result: { value: { ok: false } } });
        return Promise.resolve({ result: { value: '' } });
      }
      if (method === 'Input.dispatchKeyEvent') return Promise.resolve({});
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
}

function fakeClickDom({ innerWidth = 800, innerHeight = 600 } = {}) {
  class Node {
    get isConnected() { return true; }
    get ownerDocument() { return doc; }
    get parentNode() { return this._parent || null; }
    getRootNode() { return doc; }
  }
  const window = { innerWidth, innerHeight };
  const doc = { nodeType: 9, elementFromPoint() { return null; } };
  function el(tag, { id = '', rect = null } = {}) {
    const node = Object.create(Node.prototype);
    Object.assign(node, {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id,
      className: '',
      textContent: id,
      _rect: rect || { x: 0, y: 0, width: 0, height: 0 },
      getAttribute() { return null; },
      getBoundingClientRect() { return { ...this._rect }; },
      scrollIntoView() {},
      querySelectorAll() { return []; },
      getClientRects() { return []; },
    });
    return node;
  }
  const context = {
    window,
    document: doc,
    location: { href: 'http://fixture.local/click' },
    Node,
    getComputedStyle: () => ({ position: 'static', overflowX: 'visible', overflowY: 'visible', transform: 'none', filter: 'none', contain: '', display: 'block' }),
    requestAnimationFrame(callback) { callback(); },
    Promise,
    Date,
    setTimeout,
    Math,
    Object,
    Reflect,
    String,
    Number,
    Array,
  };
  return { doc, el, context };
}

function settledRect(context, node) {
  const fn = runInNewContext(`(${T.scrollSettledRectFunctionDeclaration({ hitTest: true })})`, context);
  return fn.call(node);
}
