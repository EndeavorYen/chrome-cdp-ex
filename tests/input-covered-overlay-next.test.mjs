import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const FULL_ID = 'AB78B41A55F062DF42C6734D8AE8610B';
const PREFIX = FULL_ID.slice(0, 8);
const VIEWPORT = { width: 1042, height: 632 };

// Enough of a document for scrollSettledRectFunctionDeclaration({ hitTest: true }).
function fakeDom({ innerWidth = VIEWPORT.width, innerHeight = VIEWPORT.height } = {}) {
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
  function el(tag, { id = '', className = '', text = '', parent = null, rect = null, position = 'static', pointerEvents = 'auto', attrs = {} } = {}) {
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
      _pointerEvents: pointerEvents,
      scrolls: 0,
      getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
      getBoundingClientRect() { return { ...this._rect }; },
      scrollIntoView() { this.scrolls += 1; },
      matches(selector) {
        const tags = selector.split(',').map(part => part.trim().toUpperCase());
        if (tags.includes(this.tagName)) return true;
        if (selector.includes('[role="dialog"]') && this.getAttribute('role') === 'dialog') return true;
        if (selector.includes('[role="alertdialog"]') && this.getAttribute('role') === 'alertdialog') return true;
        return selector.includes('[aria-modal="true"]') && this.getAttribute('aria-modal') === 'true';
      },
      closest(selector) {
        for (let n = this; n && n.nodeType === 1; n = n._parent) if (n.matches(selector)) return n;
        return null;
      },
    });
    return node;
  }
  const context = {
    window,
    document: doc,
    location: { href: 'http://127.0.0.1/covered' },
    Node,
    getComputedStyle: node => ({
      position: node._position || 'static',
      pointerEvents: node._pointerEvents || 'auto',
    }),
    Promise,
    Date,
    setTimeout,
    Math,
    Object,
    Reflect,
    String,
    Number,
    Array,
    Boolean,
  };
  return { doc, el, context };
}

async function settledRect(context, node) {
  const fn = runInNewContext(`(${T.scrollSettledRectFunctionDeclaration({ hitTest: true })})`, context);
  return fn.call(node);
}

function layout(build) {
  const dom = fakeDom();
  const body = dom.el('body');
  const main = dom.el('main', { parent: body });
  const button = dom.el('button', {
    id: 'submit',
    text: 'Submit transfer',
    parent: main,
    rect: { x: 110, y: 120, width: 120, height: 40 },
  });
  dom.doc.body = body;
  const built = build(dom, { body, main, button });
  dom.doc.hitAt = () => built.hit;
  return { ...dom, body, button, ...built };
}

function fullViewportRect() {
  return { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
}

function clickCdp(evaluateValue) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: evaluateValue } });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'root-frame' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
      if (method === 'Input.dispatchMouseEvent') return Promise.resolve({});
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function coveredClick(page) {
  const value = await settledRect(page.context, page.button);
  const cdp = clickCdp({
    ok: true,
    x: value.x + value.w / 2,
    y: value.y + value.h / 2,
    tag: value.tag,
    text: value.text,
    hit: value.hit,
  });
  const err = await T.clickStr(cdp, 'sid', '#submit').catch(error => error);
  const failure = classifyActionFailure(err, {
    action: 'click',
    target: { targetId: FULL_ID, input: '#submit' },
  });
  const handler = T.createClickCommandHandler({
    actionFeedback: (action, dispatch, target, feedbackPolicy, observe, fopts) => T.runActionWithFeedback({
      action,
      target: { ...target, targetId: FULL_ID },
      dispatch,
      feedbackPolicy,
      observe: async () => '(no changes detected in AX tree)',
      format: fopts,
    }),
    click: () => T.clickStr(cdp, 'sid', '#submit'),
    jsClick: () => { throw new Error('jsclick must not run'); },
  });
  const thrown = await handler({ args: ['#submit'] }).catch(error => error);
  const logs = [];
  const proc = { exitCode: 0 };
  T.emitTargetCommandResponse({ ok: false, error: thrown }, {
    cmd: 'click',
    targetPrefix: PREFIX,
    format: 'text',
    console: { log() {}, error: (line) => logs.push(String(line)) },
    process: proc,
  });
  return { value, cdp, err, failure, thrown, printed: logs.join('\n'), exitCode: proc.exitCode };
}

function fullscreenCover() {
  return layout((dom, { body }) => {
    const cover = dom.el('div', {
      id: 'cover',
      text: 'Opaque cover',
      parent: body,
      position: 'fixed',
      rect: fullViewportRect(),
    });
    return { hit: cover, cover };
  });
}

describe('#601 a full-screen fixed cover recovers through overlay', () => {
  it('exits 1 with Kind covered and Next overlay, not click --js', async () => {
    const result = await coveredClick(fullscreenCover());
    expect(result.printed).toContain(`Next: cdp overlay ${PREFIX} "#submit"`);
    expect(result.printed).not.toMatch(/--js/);
    expect(result.failure).toMatchObject({
      kind: 'covered',
      dispatched: false,
      nextCommand: `cdp overlay ${PREFIX} "#submit"`,
    });
    expect(result.failure.hints.join('\n')).toContain(`cdp click ${PREFIX} "#submit" --js`);
    expect(result.failure.hints.join('\n')).toContain(`cdp overlay ${PREFIX} "#submit"`);
    expect(result.exitCode).toBe(1);
    expect(result.cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toEqual([]);
    expect([...result.printed].length).toBeLessThanOrEqual(230);
  });

  it('names the target, point, cover, position, and recentre in one sentence', async () => {
    const result = await coveredClick(fullscreenCover());
    expect(result.err.message).toBe(
      'click not sent: <BUTTON> "Submit transfer" at (170,140) is covered by position:fixed <DIV#cover> "Opaque cover" (also after scrolling to centre).',
    );
    expect(result.printed).toMatch(/^Error: click not sent: <BUTTON> "Submit transfer" at \(170,140\) is covered by position:fixed <DIV#cover> "Opaque cover"/);
    expect(result.printed).toMatch(/^Kind: covered$/m);
  });

  it('treats a fixed layer that covers most of the viewport the same way', async () => {
    const page = layout((dom, { body }) => {
      const cover = dom.el('div', {
        id: 'sheet',
        text: 'Most of the page',
        parent: body,
        position: 'fixed',
        rect: { x: 0, y: 0, width: VIEWPORT.width, height: 323 },
      });
      return { hit: cover, cover };
    });
    const result = await coveredClick(page);
    expect(result.failure.nextCommand).toBe(`cdp overlay ${PREFIX} "#submit"`);
    expect(result.value.hit.large).toBe(true);
  });

  it('keeps --js for a sticky header, a sidebar, a toast, and a bottom strip', async () => {
    const header = layout((dom, { body }) => {
      const bar = dom.el('div', {
        className: 'sticky-tools',
        text: 'Toolbar',
        parent: body,
        position: 'sticky',
        rect: { x: 0, y: 0, width: VIEWPORT.width, height: 48 },
      });
      return { hit: bar };
    });
    header.button._rect = { x: 110, y: 4, width: 120, height: 30 };
    const sidebar = layout((dom, { body }) => {
      const aside = dom.el('aside', {
        className: 'sidebar',
        parent: body,
        position: 'fixed',
        rect: { x: 0, y: 0, width: 240, height: VIEWPORT.height },
      });
      const label = dom.el('p', { id: 'phase7-load-generation', text: 'load:1', parent: aside });
      return { hit: label, aside };
    });
    const toast = layout((dom, { body }) => {
      const note = dom.el('div', {
        className: 'toast',
        text: 'Saved',
        parent: body,
        position: 'fixed',
        rect: { x: 100, y: 110, width: 160, height: 60 },
      });
      return { hit: note };
    });
    const banner = layout((dom, { body }) => {
      const strip = dom.el('div', {
        id: 'cookies',
        text: 'Accept cookies',
        parent: body,
        position: 'fixed',
        rect: { x: 0, y: VIEWPORT.height - 180, width: VIEWPORT.width, height: 180 },
      });
      return { hit: strip };
    });
    banner.button._rect = { x: 110, y: VIEWPORT.height - 80, width: 120, height: 40 };

    for (const [name, page] of [['header', header], ['sidebar', sidebar], ['toast', toast], ['banner', banner]]) {
      const result = await coveredClick(page);
      expect(result.failure.nextCommand, name).toBe(`cdp click ${PREFIX} "#submit" --js`);
      expect(result.failure.kind, name).toBe('covered');
      expect(result.failure.dispatched, name).toBe(false);
      expect(result.value.hit.large, name).not.toBe(true);
    }
  });

  it('keeps dismiss-modal when the cover is a dialog, even if it fills the viewport', async () => {
    const page = layout((dom, { body }) => {
      const dialog = dom.el('div', {
        id: 'consent',
        text: 'Slice1 consent dialog',
        parent: body,
        position: 'fixed',
        rect: fullViewportRect(),
        attrs: { role: 'dialog', 'aria-modal': 'true' },
      });
      return { hit: dialog };
    });
    const result = await coveredClick(page);
    expect(result.failure.nextCommand).toBe(`cdp dismiss-modal ${PREFIX}`);
    expect(result.failure.hints.join('\n')).toContain(`cdp click ${PREFIX} "#submit" --js`);
  });

  it('measures the fixed layer, not a small child inside a full-screen cover', async () => {
    const page = layout((dom, { body }) => {
      const cover = dom.el('div', {
        id: 'cover',
        parent: body,
        position: 'fixed',
        rect: fullViewportRect(),
      });
      const label = dom.el('span', { text: 'Opaque cover', parent: cover, rect: { x: 160, y: 130, width: 40, height: 16 } });
      return { hit: label, cover };
    });
    const result = await coveredClick(page);
    expect(result.failure.nextCommand).toBe(`cdp overlay ${PREFIX} "#submit"`);
    expect(result.err.message).toContain('inside position:fixed <DIV#cover>');
  });

  // react-hot-toast: the fixed shell is inset and pointer-events:none; the toast child receives hits.
  it('keeps --js when a pointer-events:none fixed shell holds a small toast', async () => {
    const page = layout((dom, { body }) => {
      const shell = dom.el('div', {
        id: 'toaster',
        parent: body,
        position: 'fixed',
        pointerEvents: 'none',
        rect: { x: 16, y: 16, width: VIEWPORT.width - 32, height: VIEWPORT.height - 32 },
      });
      const toast = dom.el('div', {
        className: 'toast',
        text: 'Saved',
        parent: shell,
        pointerEvents: 'auto',
        rect: { x: 100, y: 110, width: 200, height: 48 },
      });
      return { hit: toast, shell };
    });
    const result = await coveredClick(page);
    expect(result.printed).toContain(`Next: cdp click ${PREFIX} "#submit" --js`);
    expect(result.printed).not.toContain('overlay');
    expect(result.failure.nextCommand).toBe(`cdp click ${PREFIX} "#submit" --js`);
    expect(result.failure.nextCommand).not.toContain('dismiss-modal');
    expect(result.value.hit.large).not.toBe(true);
  });

  // The app shell fills the viewport and contains the button. A separate absolute popover is the cover.
  it('keeps --js when a full-viewport fixed app shell contains the button and an absolute popover covers it', async () => {
    const page = layout((dom, { body, main, button }) => {
      const shell = dom.el('div', {
        id: 'app',
        parent: body,
        position: 'fixed',
        rect: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      });
      main._parent = shell;
      button._parent = main;
      const popover = dom.el('div', {
        className: 'popover',
        text: 'Account menu',
        parent: shell,
        position: 'absolute',
        rect: { x: 100, y: 100, width: 220, height: 120 },
      });
      return { hit: popover, shell };
    });
    const result = await coveredClick(page);
    expect(result.printed).toContain(`Next: cdp click ${PREFIX} "#submit" --js`);
    expect(result.printed).not.toMatch(/overlay|dismiss-modal/);
    expect(result.failure.nextCommand).toBe(`cdp click ${PREFIX} "#submit" --js`);
    expect(result.value.hit.large).not.toBe(true);
    expect(result.value.hit.dialog).not.toBe(true);
  });

  it('still classifies the previous click sentence and a covered drag', () => {
    const legacy = new Error('click point (5, 5) of <BUTTON> "Element not found timeout" is covered by <DIV.toast> "unknown ref". The mouse click was not sent: it would land on the covering element.');
    expect(classifyActionFailure(legacy, { action: 'click', target: { targetId: FULL_ID, input: '#x' } }).kind).toBe('covered');
    const sentence = new Error('click not sent: <BUTTON> "Submit transfer" at (170,140) is covered by position:fixed <DIV#cover> "Opaque cover".');
    expect(classifyActionFailure(sentence, { action: 'click', target: { targetId: FULL_ID, input: '#submit' } }).kind).toBe('covered');
    const drag = new Error('drag start point (100, 50) of <LI> "Alpha" is covered by position:fixed <DIV.toast> "Saved". The drag was not sent: it would start on the covering element.');
    expect(classifyActionFailure(drag, { action: 'drag', target: { targetId: FULL_ID, input: '#a' } })).toMatchObject({
      kind: 'covered',
      dispatched: false,
    });
  });
});

describe('#601 overlay Next uses the 8-character target prefix', () => {
  const model = {
    schema: 'chrome-cdp-ex.overlays.v1',
    viewport: { width: 1042, height: 632 },
    target: null,
    overlayCount: 1,
    blocking: true,
    overlays: [{
      kind: 'dialog',
      selector: '#cover',
      zIndex: '9999',
      pointerEvents: 'auto',
      rect: { x: 0, y: 0, w: 1090, h: 681 },
      text: 'Slice1 consent dialog',
    }],
    nextCommand: null,
  };

  it('prints the prefix for a 32-character target id', () => {
    const full = '59616163A20A8C1E43D87196E1585688';
    const text = T.formatOverlayReport(model, full);
    expect(text).toContain('Next: cdp dismiss-modal 59616163');
    expect(text).not.toContain(full);
    expect([...`${text}\n`].length).toBeLessThanOrEqual(165);
  });

  it('leaves an alias unchanged', () => {
    const text = T.formatOverlayReport(model, '@checkout-app');
    expect(text).toContain('Next: cdp dismiss-modal @checkout-app');
    expect(text).not.toContain('@checkou\n');
    expect(T.formatOverlayReport(model, '@app')).toContain('Next: cdp dismiss-modal @app');
  });

  it('stores the prefix on the JSON model', async () => {
    const full = '59616163A20A8C1E43D87196E1585688';
    const cdp = {
      send(method) {
        if (method !== 'Runtime.evaluate') return {};
        return { result: { value: JSON.stringify(model) } };
      },
    };
    const json = JSON.parse(await T.overlayStr(cdp, 'sid', full, ['--format', 'json']));
    expect(json.nextCommand).toBe('cdp dismiss-modal 59616163');
    const alias = JSON.parse(await T.overlayStr(cdp, 'sid', '@app', ['--format', 'json']));
    expect(alias.nextCommand).toBe('cdp dismiss-modal @app');
  });
});
