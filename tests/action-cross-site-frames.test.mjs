import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PAGE = 'sid';
const CHILD = 'child-sid';
const OWNER_BACKEND = 333;
const INNER_BACKEND = 444;
const BUTTON_BACKEND = 55;
const OWNER_HIT = 'chrome-cdp-ex.owner-iframe-hit.v1';

function sameOriginTree() {
  return {
    frame: { id: 'main-frame', url: 'http://127.0.0.1:9/host.html', name: 'top', securityOrigin: 'http://127.0.0.1:9' },
    childFrames: [{
      frame: {
        id: 'same-frame',
        parentId: 'main-frame',
        url: 'http://127.0.0.1:9/inner.html',
        name: 'same',
        securityOrigin: 'http://127.0.0.1:9',
      },
    }],
  };
}

function oopifTree() {
  return {
    frame: {
      id: 'oopif-frame',
      parentId: 'main-frame',
      url: 'http://localhost:9/inner.html',
      name: 'cross',
      securityOrigin: 'http://localhost:9',
    },
    childFrames: [{
      frame: {
        id: 'oopif-nested',
        parentId: 'oopif-frame',
        url: 'http://localhost:9/nested.html',
        name: 'nested-cross',
      },
    }],
  };
}

function contentQuad(x, y, w = 400, h = 300) {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

function boxModel(x, y) {
  return { model: { content: contentQuad(x, y) } };
}

const DIRECT_FRAMES = [
  { ref: '@f1', id: 'main-frame', depth: 0 },
  { ref: '@f4', id: 'oopif-frame', parentId: 'main-frame', depth: 1, process: 'oopif' },
];

const NESTED_FRAMES = [
  ...DIRECT_FRAMES,
  { ref: '@f5', id: 'oopif-nested', parentId: 'oopif-frame', depth: 2, process: 'oopif' },
];

function refStateFor({ ref, id, parentId, frames }) {
  return {
    frameRefs: new Map([[ref, {
      frameRef: ref,
      frameId: id,
      parentId,
      process: 'oopif',
      refs: new Map([[1, BUTTON_BACKEND]]),
      frames,
    }]]),
  };
}

const DIRECT = { ref: '@f4', id: 'oopif-frame', parentId: 'main-frame', frames: DIRECT_FRAMES };
const NESTED = { ref: '@f5', id: 'oopif-nested', parentId: 'oopif-frame', frames: NESTED_FRAMES };

function callsOn(cdp, method, sessionId) {
  return cdp.calls.filter(call => call.method === method && call.sessionId === sessionId);
}

function ownerHitCalls(cdp) {
  return callsOn(cdp, 'Runtime.callFunctionOn', PAGE).filter(call => (
    String(call.params.functionDeclaration || '').includes(OWNER_HIT)
  ));
}

// The page-layer function is the declaration the click sends. Run that text so a
// cover is decided by elementFromPoint, not by a canned CDP result.
function runOwnerIframeHit(declaration, { elementFromPoint, positionOf = () => '' } = {}) {
  const iframe = { nodeType: 1, tagName: 'IFRAME', id: 'guest', parentNode: null };
  iframe.ownerDocument = { elementFromPoint };
  const fn = runInContext(`(${declaration})`, createContext({
    getComputedStyle(node) {
      return { position: positionOf(node) || '' };
    },
  }));
  return { iframe, fn };
}

function elementAtPoint(tag, { id = '', parent = null, label = '', text = '', position = '' } = {}) {
  return {
    nodeType: 1,
    tagName: tag,
    id,
    parentNode: parent,
    position,
    textContent: text,
    getAttribute(name) {
      return name === 'aria-label' ? label : null;
    },
  };
}

function actionCdp({
  local = {
    connected: true,
    x: 10,
    y: 6,
    w: 40,
    h: 18,
    tag: 'BUTTON',
    text: 'Pay now',
    hit: { covered: false },
    inViewport: true,
    noClickBox: false,
  },
  parentHit = { covered: false },
  ownerHit = null,
  outer = { x: 120, y: 80 },
  inner = null,
  live = { value: '' },
  settleTimeout = false,
} = {}) {
  return createMockCDP({
    'Page.getFrameTree': () => ({ frameTree: sameOriginTree() }),
    'DOM.getFrameOwner': ({ frameId }) => ({ backendNodeId: frameId === 'oopif-frame' ? OWNER_BACKEND : 0 }),
    'DOM.getBoxModel': ({ backendNodeId }) => (
      backendNodeId === OWNER_BACKEND ? boxModel(outer.x, outer.y) : { model: {} }
    ),
    'DOM.resolveNode': () => ({ object: { objectId: 'owner-iframe' } }),
    'Runtime.callFunctionOn': (params) => {
      const fn = String(params.functionDeclaration || '');
      if (fn.includes(OWNER_HIT)) {
        const value = ownerHit
          ? ownerHit(fn, params)
          : { marker: OWNER_HIT, ...parentHit };
        return { result: { value } };
      }
      return { result: { value: { connected: true, visible: true } } };
    },
    childSessions: [{
      sessionId: CHILD,
      targetInfo: { type: 'iframe', url: 'http://localhost:9/inner.html', targetId: `${CHILD}-target` },
      handlers: {
        'Page.getFrameTree': () => ({ frameTree: oopifTree() }),
        'DOM.resolveNode': () => ({ object: { objectId: 'pay-btn' } }),
        'DOM.getFrameOwner': ({ frameId }) => (
          frameId === 'oopif-nested' ? { backendNodeId: INNER_BACKEND } : { backendNodeId: 0 }
        ),
        'DOM.getBoxModel': ({ backendNodeId }) => (
          backendNodeId === INNER_BACKEND && inner ? boxModel(inner.x, inner.y) : { model: {} }
        ),
        'Input.insertText': (params) => {
          live.value = String(params.text || '');
          return {};
        },
        'Runtime.callFunctionOn': (params) => {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('cdpFillLiveValue')) {
            return {
              result: {
                value: {
                  ok: true,
                  cdpFillLiveValue: true,
                  tag: 'INPUT',
                  type: 'text',
                  value: live.value,
                  textContent: live.value,
                  field: {},
                },
              },
            };
          }
          if (fn.includes('fillable')) {
            return { result: { value: { ok: true, fillable: true, tag: 'INPUT', type: 'text', before: '' } } };
          }
          if (fn.includes('this.click()')) {
            return { result: { value: { tag: 'BUTTON', text: 'Pay now', role: '' } } };
          }
          if (fn.includes('Not a <select>')) {
            return { result: { value: { ok: true, text: 'Visa' } } };
          }
          if (settleTimeout && fn.includes('requestAnimationFrame')) {
            return Promise.reject(new Error('Timeout: Runtime.callFunctionOn'));
          }
          if (fn.includes('requestAnimationFrame') || fn.includes('getBoundingClientRect')) {
            return { result: { value: local } };
          }
          return { result: { value: { connected: true } } };
        },
      },
    }],
  });
}

function mousePressed(cdp) {
  return cdp.calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed');
}

describe('actions inside a cross-site frame', () => {
  it('translates a cross-site click by the owner iframe content box and routes it through the child session', async () => {
    const cdp = actionCdp();
    const text = await T.clickStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT));
    expect(text).toBe('Clicked <BUTTON> "Pay now" (@f4:1)');

    const pressed = mousePressed(cdp);
    expect(pressed?.sessionId).toBe(PAGE);
    expect(pressed?.params).toMatchObject({ x: 150, y: 95 });
    expect(cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent').every(call => call.sessionId === PAGE)).toBe(true);

    expect(callsOn(cdp, 'DOM.getFrameOwner', PAGE).some(call => call.params.frameId === 'oopif-frame')).toBe(true);
    expect(callsOn(cdp, 'DOM.getBoxModel', PAGE).some(call => call.params.backendNodeId === OWNER_BACKEND)).toBe(true);
    expect(callsOn(cdp, 'DOM.getBoxModel', CHILD)).toHaveLength(0);

    expect(callsOn(cdp, 'Page.createIsolatedWorld', CHILD).some(call => call.params.frameId === 'oopif-frame')).toBe(true);
    expect(callsOn(cdp, 'DOM.resolveNode', CHILD).some(call => call.params.backendNodeId === BUTTON_BACKEND)).toBe(true);
    expect(callsOn(cdp, 'Runtime.callFunctionOn', CHILD).some(call => (
      String(call.params.functionDeclaration || '').includes('__chromeCdpExClickProbe')
    ))).toBe(true);
    expect(callsOn(cdp, 'Runtime.callFunctionOn', PAGE).some(call => (
      String(call.params.functionDeclaration || '').includes('__chromeCdpExClickProbe')
    ))).toBe(false);
    expect(callsOn(cdp, 'Runtime.callFunctionOn', PAGE).some(call => (
      String(call.params.functionDeclaration || '').includes(OWNER_HIT)
    ))).toBe(true);
  });

  it('adds the nested child box to the page owner box', async () => {
    const cdp = actionCdp({ inner: { x: 8, y: 4 } });
    const text = await T.clickStr(cdp, PAGE, '@f5:1', new Map(), refStateFor(NESTED));
    expect(text).toBe('Clicked <BUTTON> "Pay now" (@f5:1)');
    expect(mousePressed(cdp)?.params).toMatchObject({ x: 158, y: 99 });
    expect(mousePressed(cdp)?.sessionId).toBe(PAGE);
    expect(callsOn(cdp, 'DOM.getFrameOwner', CHILD).some(call => call.params.frameId === 'oopif-nested')).toBe(true);
    expect(callsOn(cdp, 'DOM.getBoxModel', CHILD).some(call => call.params.backendNodeId === INNER_BACKEND)).toBe(true);
    expect(callsOn(cdp, 'DOM.getFrameOwner', PAGE).some(call => call.params.frameId === 'oopif-frame')).toBe(true);
    expect(callsOn(cdp, 'DOM.getBoxModel', PAGE).some(call => call.params.backendNodeId === OWNER_BACKEND)).toBe(true);
  });

  it('refuses a cross-site click covered in the page', async () => {
    const cdp = actionCdp({
      parentHit: { covered: true, by: '<DIV#toast> "Wait"', byPosition: 'fixed' },
    });
    const err = await T.clickStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT)).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/covered by position:fixed <DIV#toast> "Wait"/);
    const text = T.formatActionFailure(err, { action: 'click', target: { targetId: 'AB12CD34', input: '@f4:1' } });
    expect(text).toContain('Kind: covered');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    expect(callsOn(cdp, 'DOM.getBoxModel', PAGE).length).toBeGreaterThan(0);
    expect(callsOn(cdp, 'DOM.resolveNode', CHILD).some(call => call.params.backendNodeId === BUTTON_BACKEND)).toBe(true);
  });

  it('refuses a cross-site click covered inside the child frame', async () => {
    const cdp = actionCdp({
      local: {
        connected: true,
        x: 10,
        y: 6,
        w: 40,
        h: 18,
        tag: 'BUTTON',
        text: 'Pay now',
        hit: { covered: true, by: '<DIV#modal> "Pay"', byPosition: 'fixed' },
        inViewport: true,
        noClickBox: false,
      },
    });
    const err = await T.clickStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT)).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/covered by position:fixed <DIV#modal> "Pay"/);
    expect(T.formatActionFailure(err, {
      action: 'click',
      target: { targetId: 'AB12CD34', input: '@f4:1' },
    })).toContain('Kind: covered');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    expect(callsOn(cdp, 'Runtime.callFunctionOn', PAGE).some(call => (
      String(call.params.functionDeclaration || '').includes(OWNER_HIT)
    ))).toBe(true);
  });

  it('refuses a cross-site click when the owner-iframe hit sees a page cover, and runs that check once', async () => {
    const toast = elementAtPoint('DIV', { id: 'toast', label: 'Wait', position: 'fixed' });
    const cdp = actionCdp({
      ownerHit: (declaration, params) => {
        const x = params.arguments?.[0]?.value;
        const y = params.arguments?.[1]?.value;
        const { iframe, fn } = runOwnerIframeHit(declaration, {
          elementFromPoint() { return toast; },
          positionOf: node => node?.position || '',
        });
        return fn.call(iframe, x, y);
      },
    });
    const err = await T.clickStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT)).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/click not sent: <BUTTON> "Pay now" \(@f4:1\) at \(150,95\) is covered by position:fixed <DIV#toast> "Wait"/);
    expect(T.formatActionFailure(err, {
      action: 'click',
      target: { targetId: 'AB12CD34', input: '@f4:1' },
    })).toContain('Kind: covered');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    const hits = ownerHitCalls(cdp);
    expect(hits).toHaveLength(1);
    expect(hits[0].params.arguments).toEqual([{ value: 150 }, { value: 95 }]);
    expect(hits[0].sessionId).toBe(PAGE);
  });

  it('treats the owner iframe and its child as clear, and a miss at the point as a cover', async () => {
    let declaration = '';
    const cdp = actionCdp({
      ownerHit: (source, params) => {
        declaration = source;
        const x = params.arguments?.[0]?.value;
        const y = params.arguments?.[1]?.value;
        const { iframe, fn } = runOwnerIframeHit(source, {
          elementFromPoint() { return iframe; },
        });
        return fn.call(iframe, x, y);
      },
    });
    const text = await T.clickStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT));
    expect(text).toBe('Clicked <BUTTON> "Pay now" (@f4:1)');
    expect(mousePressed(cdp)?.params).toMatchObject({ x: 150, y: 95 });
    expect(ownerHitCalls(cdp)).toHaveLength(1);
    expect(declaration).toContain(OWNER_HIT);

    let top = null;
    const clear = runOwnerIframeHit(declaration, {
      elementFromPoint() { return top; },
    });
    top = clear.iframe;
    expect(clear.fn.call(clear.iframe, 150, 95)).toMatchObject({ marker: OWNER_HIT, covered: false });

    const inner = elementAtPoint('BUTTON', { parent: clear.iframe, text: 'Pay now' });
    top = inner;
    expect(clear.fn.call(clear.iframe, 150, 95)).toMatchObject({ marker: OWNER_HIT, covered: false });

    top = null;
    expect(clear.fn.call(clear.iframe, 150, 95)).toMatchObject({ marker: OWNER_HIT, covered: true, by: '<none>' });

    const blind = runOwnerIframeHit(declaration, {});
    blind.iframe.ownerDocument = {};
    expect(blind.fn.call(blind.iframe, 4, 8)).toMatchObject({ marker: OWNER_HIT, covered: true, by: '<none>', x: 4, y: 8 });
  });

  it('keeps a child-frame cover when the owner iframe is the top element in the page', async () => {
    const cdp = actionCdp({
      local: {
        connected: true,
        x: 10,
        y: 6,
        w: 40,
        h: 18,
        tag: 'BUTTON',
        text: 'Pay now',
        hit: { covered: true, by: '<DIV#modal> "Pay"', byPosition: 'fixed' },
        inViewport: true,
        noClickBox: false,
      },
      ownerHit: (declaration, params) => {
        const x = params.arguments?.[0]?.value;
        const y = params.arguments?.[1]?.value;
        const { iframe, fn } = runOwnerIframeHit(declaration, {
          elementFromPoint() { return iframe; },
        });
        return fn.call(iframe, x, y);
      },
    });
    const err = await T.clickStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT)).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/covered by position:fixed <DIV#modal> "Pay"/);
    expect(T.formatActionFailure(err, {
      action: 'click',
      target: { targetId: 'AB12CD34', input: '@f4:1' },
    })).toContain('Kind: covered');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    expect(ownerHitCalls(cdp)).toHaveLength(1);
  });

  it('keeps a page cover when the cross-site scroll settle times out, and still checks the owner iframe once', async () => {
    const toast = elementAtPoint('DIV', { id: 'toast', label: 'Wait', position: 'fixed' });
    const cdp = actionCdp({
      settleTimeout: true,
      ownerHit: (declaration, params) => {
        const x = params.arguments?.[0]?.value;
        const y = params.arguments?.[1]?.value;
        const { iframe, fn } = runOwnerIframeHit(declaration, {
          elementFromPoint() { return toast; },
          positionOf: node => node?.position || '',
        });
        return fn.call(iframe, x, y);
      },
    });
    const err = await T.clickStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT)).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/click not sent: <BUTTON> "Pay now" \(@f4:1\) at \(150,95\) is covered by position:fixed <DIV#toast> "Wait"/);
    expect(T.formatActionFailure(err, {
      action: 'click',
      target: { targetId: 'AB12CD34', input: '@f4:1' },
    })).toContain('Kind: covered');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    const hits = ownerHitCalls(cdp);
    expect(hits).toHaveLength(1);
    expect(hits[0].params.arguments).toEqual([{ value: 150 }, { value: 95 }]);
  });

  it('fills a cross-site ref through the child session', async () => {
    const live = { value: '' };
    const cdp = actionCdp({ live });
    const text = await T.fillStr(cdp, PAGE, '@f4:1', 'tok_123', new Map(), refStateFor(DIRECT));
    expect(text).toBe('Filled @f4:1 with "tok_123"');
    const inserted = cdp.calls.filter(call => call.method === 'Input.insertText');
    expect(inserted).toEqual([expect.objectContaining({
      sessionId: CHILD,
      params: expect.objectContaining({ text: 'tok_123' }),
    })]);
    expect(callsOn(cdp, 'Runtime.callFunctionOn', CHILD).some(call => (
      String(call.params.functionDeclaration || '').includes('cdpFillLiveValue')
    ))).toBe(true);
    expect(callsOn(cdp, 'DOM.resolveNode', CHILD).some(call => call.params.backendNodeId === BUTTON_BACKEND)).toBe(true);
    expect(cdp.calls.some(call => call.method === 'DOM.getBoxModel')).toBe(false);
    expect(live.value).toBe('tok_123');
  });

  it('runs jsclick and select for a cross-site ref in the child session', async () => {
    const clickCdp = actionCdp();
    const clicked = await T.jsClickStr(clickCdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT));
    expect(clicked).toBe('JS-clicked <BUTTON> "Pay now" (@f4:1)');
    expect(callsOn(clickCdp, 'Runtime.callFunctionOn', CHILD).some(call => (
      String(call.params.functionDeclaration || '').includes('this.click()')
    ))).toBe(true);
    expect(clickCdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);

    const selectCdp = actionCdp();
    const selected = await T.selectStr(selectCdp, PAGE, '@f4:1', 'Visa', {}, new Map(), refStateFor(DIRECT));
    expect(selected).toBe('Selected "Visa"');
    expect(callsOn(selectCdp, 'Runtime.callFunctionOn', CHILD).some(call => (
      String(call.params.functionDeclaration || '').includes('Not a <select>')
    ))).toBe(true);
    expect(callsOn(selectCdp, 'Runtime.callFunctionOn', PAGE).some(call => (
      String(call.params.functionDeclaration || '').includes('Not a <select>')
    ))).toBe(false);
  });

  it('still refuses hover on a cross-site ref', async () => {
    const cdp = actionCdp();
    const err = await T.hoverStr(cdp, PAGE, '@f4:1', new Map(), refStateFor(DIRECT)).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Actions inside cross-site frames are not supported yet (@f4).');
    expect(T.formatActionFailure(err, {
      action: 'hover',
      target: { targetId: 'AB12CD34', input: '@f4:1' },
    })).toContain('Kind: usage');
    expect(cdp.calls.some(call => call.method === 'Page.createIsolatedWorld')).toBe(false);
    expect(cdp.calls.some(call => call.method === 'DOM.getBoxModel')).toBe(false);
  });
});
