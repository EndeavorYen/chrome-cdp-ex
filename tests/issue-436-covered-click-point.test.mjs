import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  classifyActionFailure,
  formatActionFailure,
  getRecoveryPolicyTemplate,
  listRecoveryPolicyKinds,
} = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = '9E3238F5CEA88A787E777B3A5E650842';

// A small fake DOM that is just enough for scrollSettledRectFunctionDeclaration() to run in a
// vm: Node.prototype getters (the connected-to-document guard reads them), elementFromPoint,
// open shadow roots, <label>.control, and getComputedStyle().position.
function fakeDom({ innerWidth = 780, innerHeight = 437 } = {}) {
  class Node {
    get isConnected() { return true; }
    get ownerDocument() { return doc; }
    get parentNode() { return this._parent || null; }
    getRootNode() { return doc; }
  }
  const window = { innerWidth, innerHeight };
  const doc = {
    nodeType: 9,
    hitAt: () => null,
    elementFromPoint(x, y) { return this.hitAt(x, y); },
  };
  function el(tag, { id = '', className = '', text = '', parent = null, rect = null, position = 'static', attrs = {} } = {}) {
    const node = Object.create(Node.prototype);
    Object.assign(node, {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id,
      className,
      textContent: text,
      _parent: parent,
      _rect: rect || { x: 0, y: 0, width: 0, height: 0 },
      _position: position,
      scrolls: 0,
      getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
      getBoundingClientRect() { return { ...this._rect }; },
      scrollIntoView() { this.scrolls += 1; if (this.onScroll) this.onScroll(); },
      matches(selector) {
        const tags = selector.split(',').map(part => part.trim().toUpperCase());
        if (tags.includes(this.tagName)) return true;
        if (selector.includes('[role="dialog"]') && this.getAttribute('role') === 'dialog') return true;
        return selector.includes('[aria-modal="true"]') && this.getAttribute('aria-modal') === 'true';
      },
      closest(selector) {
        for (let n = this; n && n.nodeType === 1; n = n._parent) if (n.matches(selector)) return n;
        return null;
      },
    });
    return node;
  }
  function shadowRoot(host, hitAt) {
    const root = { nodeType: 11, host, elementFromPoint: (x, y) => hitAt(x, y) };
    host.shadowRoot = root;
    return root;
  }
  const context = {
    window,
    document: doc,
    location: { href: 'file:///smoke-page.html' },
    Node,
    getComputedStyle: node => ({ position: node._position || 'static' }),
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
  return { doc, el, shadowRoot, context };
}

async function settledRect(context, node, options) {
  const fn = runInNewContext(`(${T.scrollSettledRectFunctionDeclaration(options)})`, context);
  return fn.call(node);
}

function smokeLayout() {
  const dom = fakeDom();
  const body = dom.el('body');
  const main = dom.el('main', { parent: body });
  const button = dom.el('button', {
    id: 'loop-attack',
    text: 'Loop attack',
    parent: main,
    rect: { x: 491, y: 198, width: 120, height: 40 },
  });
  const sidebar = dom.el('aside', { className: 'sidebar', parent: body, position: 'fixed' });
  const loadGeneration = dom.el('p', { id: 'phase7-load-generation', text: 'load:1', parent: sidebar });
  return { ...dom, body, main, button, sidebar, loadGeneration };
}

describe('#436 hit-test the click point inside the scroll-settled rect evaluation', () => {
  it('reports the covering element and its fixed ancestor when another element is on top', async () => {
    const page = smokeLayout();
    page.doc.hitAt = () => page.loadGeneration;
    const value = await settledRect(page.context, page.button, { hitTest: true });
    expect(value).toMatchObject({ connected: true, tag: 'BUTTON', text: 'Loop attack' });
    expect(value.hit).toMatchObject({
      covered: true,
      x: 551,
      y: 218,
      by: '<P#phase7-load-generation> "load:1"',
      within: '<ASIDE.sidebar>',
      withinPosition: 'fixed',
      dialog: false,
    });
  });

  it('accepts the target itself, a descendant, an ancestor, and a <label> that activates it', async () => {
    const page = smokeLayout();
    const icon = page.el('span', { parent: page.button });
    const label = page.el('label', { parent: page.main });
    label.control = page.button;
    const labelText = page.el('span', { parent: label });
    for (const hit of [page.button, icon, page.main, page.body, label, labelText]) {
      page.doc.hitAt = () => hit;
      const value = await settledRect(page.context, page.button, { hitTest: true });
      expect(value.hit, hit.tagName).toEqual({ covered: false });
    }
  });

  it('walks open shadow roots to the element really under the point', async () => {
    const page = smokeLayout();
    const host = page.el('x-toast', { parent: page.body, position: 'fixed' });
    const toastText = page.el('div', { className: 'toast-body', text: 'Saved', parent: null });
    page.shadowRoot(host, () => toastText);
    toastText._parent = host.shadowRoot;
    page.doc.hitAt = () => host;
    const covered = await settledRect(page.context, page.button, { hitTest: true });
    expect(covered.hit).toMatchObject({ covered: true, by: '<DIV.toast-body> "Saved"', within: '<X-TOAST>' });

    // The target is a custom element whose open shadow root holds the real <button>.
    const custom = page.el('x-button', { parent: page.main, rect: { x: 20, y: 20, width: 80, height: 30 } });
    const inner = page.el('button', { text: 'Go' });
    page.shadowRoot(custom, () => inner);
    inner._parent = custom.shadowRoot;
    page.doc.hitAt = () => custom;
    const own = await settledRect(page.context, custom, { hitTest: true });
    expect(own.hit).toEqual({ covered: false });
  });

  it('names a covering dialog so recovery can point at dismiss-modal', async () => {
    const page = smokeLayout();
    const dialog = page.el('div', { id: 'motd', parent: page.body, position: 'fixed', attrs: { role: 'dialog', 'aria-modal': 'true' } });
    const text = page.el('p', { text: 'smoke modal', parent: dialog });
    page.doc.hitAt = () => text;
    const value = await settledRect(page.context, page.button, { hitTest: true });
    expect(value.hit).toMatchObject({ covered: true, dialog: true, within: '<DIV#motd>' });
  });

  it('re-centres a fully visible but covered target once, then reports what is still on top', async () => {
    const page = smokeLayout();
    page.doc.hitAt = () => page.loadGeneration;
    const value = await settledRect(page.context, page.button, { hitTest: true });
    expect(page.button.scrolls).toBe(1);
    expect(value.hit).toMatchObject({ covered: true, recentred: true });

    // A sticky header covered the top of the viewport; centring the target clears it.
    const sticky = smokeLayout();
    const header = sticky.el('div', { className: 'sticky-tools', parent: sticky.body, position: 'sticky' });
    sticky.button._rect = { x: 20, y: 4, width: 120, height: 30 };
    sticky.doc.hitAt = () => (sticky.button.scrolls === 0 ? header : sticky.button);
    sticky.button.onScroll = () => { sticky.button._rect = { x: 20, y: 200, width: 120, height: 30 }; };
    const cleared = await settledRect(sticky.context, sticky.button, { hitTest: true });
    expect(sticky.button.scrolls).toBe(1);
    expect(cleared.hit).toEqual({ covered: false });
    expect(cleared).toMatchObject({ x: 20, y: 200 });
  });

  it('does not block when nothing is hit (point outside the viewport or zero size)', async () => {
    const page = smokeLayout();
    page.doc.hitAt = () => null;
    const value = await settledRect(page.context, page.button, { hitTest: true });
    expect(value.hit).toBeNull();
  });

  it('leaves the rect contract unchanged without hitTest', async () => {
    const page = smokeLayout();
    page.doc.hitAt = () => page.loadGeneration;
    const value = await settledRect(page.context, page.button);
    expect(value).not.toHaveProperty('hit');
    expect(page.button.scrolls).toBe(0);
    expect(T.scrollSettledRectFunctionDeclaration()).not.toContain('elementFromPoint');
  });
});

function clickCdp({ evaluateValue = null, refValue = null } = {}) {
  const calls = [];
  const cdp = {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: evaluateValue } });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'root-frame' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'button-object' } });
      if (method === 'Runtime.callFunctionOn') {
        // The trusted-ref connectivity probe answers true; the rect evaluation answers refValue.
        const rect = String(params.functionDeclaration || '').includes('scrollIntoView');
        return Promise.resolve({ result: { value: rect ? refValue : true } });
      }
      if (method === 'Input.dispatchMouseEvent') return Promise.resolve({});
      throw new Error(`unexpected ${method}`);
    },
  };
  return cdp;
}

const COVERED_HIT = {
  covered: true,
  x: 551,
  y: 218,
  by: '<P#phase7-load-generation> "load:1"',
  byPosition: 'static',
  within: '<ASIDE.sidebar>',
  withinPosition: 'fixed',
  dialog: false,
};

describe('#436 click does not dispatch when the click point is covered', () => {
  it('CSS click fails with the covering element and sends no mouse event', async () => {
    const cdp = clickCdp({
      evaluateValue: { ok: true, x: 551, y: 218, tag: 'BUTTON', text: 'Loop attack', hit: COVERED_HIT },
    });
    const err = await T.clickStr(cdp, 'sid', '#loop-attack').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(
      'click point (551, 218) of <BUTTON> "Loop attack" is covered by <P#phase7-load-generation> "load:1" '
      + '(inside position:fixed <ASIDE.sidebar>). The mouse click was not sent: it would land on the covering element.'
    );
    expect(err.clickCovered).toMatchObject({ by: COVERED_HIT.by, within: '<ASIDE.sidebar>', dialog: false });
    expect(cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toEqual([]);
    const expression = cdp.calls.find(call => call.method === 'Runtime.evaluate').params.expression;
    expect(expression).toContain('elementFromPoint');
    // One page round trip before the decision: the hit-test rides the rect evaluation.
    expect(cdp.calls.map(call => call.method)).toEqual(['Runtime.evaluate']);
  });

  it('@ref click fails the same way, naming the ref, and sends no mouse event', async () => {
    const refMap = new Map([[12, 4242]]);
    const cdp = clickCdp({
      refValue: { connected: true, x: 491, y: 198, w: 120, h: 40, tag: 'BUTTON', text: 'Loop attack', hit: { ...COVERED_HIT, recentred: true } },
    });
    const err = await T.clickStr(cdp, 'sid', '@12', refMap, {}).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^click point \(551, 218\) of <BUTTON> "Loop attack" \(@12\) is covered by <P#phase7-load-generation>/);
    expect(err.message).toContain('even after scrolling it to the viewport centre');
    expect(cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toEqual([]);
    const rectCall = cdp.calls.find(call => call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration).includes('scrollIntoView'));
    expect(rectCall.params.functionDeclaration).toContain('elementFromPoint');
  });

  it('an uncovered CSS click still dispatches at the centre', async () => {
    const cdp = clickCdp({
      evaluateValue: { ok: true, x: 40, y: 20, tag: 'BUTTON', text: 'Save', hit: { covered: false } },
    });
    const err = await T.clickStr(cdp, 'sid', '#save').catch(e => e);
    // The fake page never reports probe events, so the mouse path fails closed after dispatching.
    expect(err.message).toMatch(/received no mousedown\/click events/);
    const pressed = cdp.calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed');
    expect(pressed.params).toMatchObject({ x: 40, y: 20 });
  });
});

describe('#436 covered click failure is classified with an executable Next', () => {
  function coveredError(hit = COVERED_HIT) {
    const err = new Error(`click point (551, 218) of <BUTTON> "Loop attack" is covered by ${hit.by}. The mouse click was not sent: it would land on the covering element.`);
    err.clickCovered = hit;
    return err;
  }

  it('is Kind: covered, not dispatched, with Next click --js and an overlay hint', () => {
    const failure = classifyActionFailure(coveredError(), {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#loop-attack' },
    });
    expect(failure).toMatchObject({
      kind: 'covered',
      dispatched: false,
      nextCommand: `cdp click ${TARGET_ID.slice(0, 8)} "#loop-attack" --js`,
    });
    expect(failure.hints.join('\n')).toContain(`cdp overlay ${TARGET_ID.slice(0, 8)} "#loop-attack"`);
    expect(failure.covering).toMatchObject({ by: COVERED_HIT.by, within: '<ASIDE.sidebar>' });
  });

  it('points at dismiss-modal when the covering element is a dialog', () => {
    const failure = classifyActionFailure(coveredError({ ...COVERED_HIT, by: '<P> "smoke modal"', within: '<DIV#motd>', dialog: true }), {
      action: 'click',
      target: { targetId: TARGET_ID, input: '@12' },
    });
    expect(failure.kind).toBe('covered');
    expect(failure.nextCommand).toBe(`cdp dismiss-modal ${TARGET_ID.slice(0, 8)}`);
    expect(failure.hints.join('\n')).toContain(`cdp click ${TARGET_ID.slice(0, 8)} @12 --js`);
  });

  it('classifies from the message prefix even when the page text looks like another failure', () => {
    const err = new Error('click point (5, 5) of <BUTTON> "Element not found timeout" is covered by <DIV.toast> "unknown ref". The mouse click was not sent: it would land on the covering element.');
    expect(classifyActionFailure(err, { action: 'click', target: { targetId: TARGET_ID, input: '#x' } }).kind).toBe('covered');
  });

  it('prints Error / Kind / Next lines', () => {
    const text = formatActionFailure(coveredError(), { action: 'click', target: { targetId: TARGET_ID, input: '#loop-attack' } });
    expect(text.split('\n')).toEqual([
      'Error: click point (551, 218) of <BUTTON> "Loop attack" is covered by <P#phase7-load-generation> "load:1". The mouse click was not sent: it would land on the covering element.',
      'Kind: covered',
      `Next: cdp click ${TARGET_ID.slice(0, 8)} "#loop-attack" --js`,
    ]);
  });

  it('has a recovery policy template', () => {
    expect(listRecoveryPolicyKinds()).toContain('covered');
    expect(getRecoveryPolicyTemplate('covered').strategy).toBe('bypass-hit-test');
  });

  it('a covered click through the click handler exits with the classified failure', async () => {
    const cdp = clickCdp({
      evaluateValue: { ok: true, x: 551, y: 218, tag: 'BUTTON', text: 'Loop attack', hit: COVERED_HIT },
    });
    const handler = T.createClickCommandHandler({
      actionFeedback: (action, dispatch, target, feedbackPolicy, observe, fopts) => T.runActionWithFeedback({
        action,
        target: { ...target, targetId: TARGET_ID },
        dispatch,
        feedbackPolicy,
        observe: async () => '(no changes detected in AX tree)',
        format: fopts,
      }),
      click: selector => T.clickStr(cdp, 'sid', selector, new Map(), {}),
      jsClick: () => { throw new Error('jsclick must not run'); },
    });
    const err = await handler({ args: ['#loop-attack'] }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Error: click point \(551, 218\) of <BUTTON> "Loop attack" is covered by <P#phase7-load-generation>/);
    expect(err.message).toMatch(/^Kind: covered$/m);
    expect(err.message).toMatch(new RegExp(`^Next: cdp click ${TARGET_ID.slice(0, 8)} "#loop-attack" --js$`, 'm'));
    expect(cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toEqual([]);
  });
});
