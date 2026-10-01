import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  classifyActionFailure,
  formatActionFailure,
  getRecoveryPolicyTemplate,
  listRecoveryPolicyKinds,
} = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = '9E3238F5CEA88A787E777B3A5E650842';
const PAGE_HREF = 'http://127.0.0.1:8468/index.html';

// A small fake page that is just enough for the click / fill / select page expressions to run in a
// vm: querySelector by exact selector, Node.prototype getters (the connected-to-document guard reads
// them), elementFromPoint, getComputedStyle, :disabled / fieldset[disabled], and real timers.
function fakePage() {
  class Node {
    get isConnected() { return true; }
    get ownerDocument() { return doc; }
    get parentNode() { return this._parent || null; }
    getRootNode() { return doc; }
  }
  const nodes = new Map();
  const doc = {
    nodeType: 9,
    querySelector(selector) { return nodes.get(selector) || null; },
    // `extraMatches` simulates siblings that match the same selector after the first one.
    extraMatches: new Map(),
    querySelectorAll(selector) {
      const first = nodes.get(selector);
      return first ? [first, ...(this.extraMatches.get(selector) || [])] : [];
    },
    elementFromPoint(x, y) {
      for (const node of nodes.values()) {
        const r = node._rect;
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return node;
      }
      return null;
    },
  };
  const FORM_CONTROLS = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
  function el(tag, { text = '', attrs = {}, rect = null, style = {}, type = '', fieldset = null, options = [] } = {}) {
    const node = Object.create(Node.prototype);
    Object.assign(node, {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      type,
      textContent: text,
      innerText: text,
      value: '',
      options,
      events: [],
      _rect: rect || { x: 100, y: 100, width: 120, height: 40 },
      _style: { display: 'inline-block', visibility: 'visible', position: 'static', ...style },
      _fieldset: fieldset,
      attrs: { ...attrs },
      getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
      hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
      getBoundingClientRect() { return { ...this._rect }; },
      scrollIntoView() {},
      focus() { this.focused = true; },
      dispatchEvent(event) { this.events.push(event.type); return true; },
      matches(selector) {
        if (selector !== ':disabled' || !FORM_CONTROLS.includes(this.tagName)) return false;
        return this.hasAttribute('disabled') || Boolean(this._fieldset && this._fieldset.hasAttribute('disabled'));
      },
      closest(selector) {
        if (selector === 'fieldset[disabled]' && this._fieldset && this._fieldset.hasAttribute('disabled')) return this._fieldset;
        return null;
      },
    });
    return node;
  }
  class Event {
    constructor(type) { this.type = type; }
  }
  const context = {
    window: { innerWidth: 1280, innerHeight: 800 },
    document: doc,
    location: { href: PAGE_HREF },
    Node,
    Event,
    getComputedStyle: node => node._style,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    Object,
    Reflect,
    String,
    Number,
    Array,
    JSON,
  };
  const later = (ms, fn) => setTimeout(fn, ms);
  return { nodes, el, context, later };
}

// Fake CDP: page expressions run in the fake page; the click event probe and Input.* are canned.
function fakeCdp(page) {
  const calls = [];
  let seen = [];
  return {
    calls,
    inputEvents: () => calls.filter(call => call.method.startsWith('Input.')),
    onEvent() { return () => {}; },
    async send(method, params = {}, sessionId, timeoutMs) {
      calls.push({ method, params, sessionId, timeoutMs });
      const src = method === 'Runtime.evaluate' ? String(params.expression || '') : String(params.functionDeclaration || '');
      if (src.includes('__chromeCdpExClickProbe')) {
        if (src.includes('installed: true')) {
          seen = [];
          return { result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'top', top: true, href: PAGE_HREF } } };
        }
        return { result: { value: { cdpClickProbe: true, ok: true, seen: seen.slice() } } };
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseReleased') seen.push('mousedown', 'click');
        return {};
      }
      if (method === 'Input.insertText') {
        const focused = [...page.nodes.values()].find(node => node.focused);
        if (focused) focused.value += params.text;
        return {};
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'location.href') return { result: { type: 'string', value: PAGE_HREF } };
        const value = await runInNewContext(params.expression, page.context);
        return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
      }
      return {};
    },
  };
}

describe('#468 click waits for the target to be attached, visible and enabled', () => {
  it('clicks an element that appears after 500 ms in one call and reports the wait', async () => {
    const page = fakePage();
    const cdp = fakeCdp(page);
    page.later(500, () => page.nodes.set('#late', page.el('button', { text: 'Save' })));
    const started = Date.now();
    const out = await T.clickStr(cdp, 'sid', '#late', new Map(), {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(out).toMatch(/^Clicked <BUTTON> "Save" \(waited \d+ms for attach\)$/);
    const waited = Number(out.match(/waited (\d+)ms/)[1]);
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(T.ACTIONABILITY_WAIT_DEFAULT_MS);
    expect(cdp.inputEvents().map(call => call.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('reports nothing about waiting when the element is actionable at once', async () => {
    const page = fakePage();
    page.nodes.set('#now', page.el('button', { text: 'Go' }));
    const cdp = fakeCdp(page);
    await expect(T.clickStr(cdp, 'sid', '#now', new Map(), {})).resolves.toBe('Clicked <BUTTON> "Go"');
  });

  it('waits for a hidden element to become visible and names both waits', async () => {
    const page = fakePage();
    const cdp = fakeCdp(page);
    const button = page.el('button', { text: 'Next', style: { display: 'none' }, rect: { x: 0, y: 0, width: 0, height: 0 } });
    page.later(150, () => page.nodes.set('#next', button));
    page.later(400, () => {
      button._style = { ...button._style, display: 'inline-block' };
      button._rect = { x: 100, y: 100, width: 120, height: 40 };
    });
    const out = await T.clickStr(cdp, 'sid', '#next', new Map(), {});
    expect(out).toMatch(/^Clicked <BUTTON> "Next" \(waited \d+ms for attach, visible\)$/);
  });

  it('fails a disabled button with Kind: disabled and dispatches no input events', async () => {
    const page = fakePage();
    page.nodes.set('#submit', page.el('button', { text: 'Submit', attrs: { disabled: '' } }));
    const cdp = fakeCdp(page);
    const err = await T.clickStr(cdp, 'sid', '#submit', new Map(), {}, { waitMs: 100 }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^<BUTTON> "Submit" is disabled \(disabled attribute\) after waiting \d+ms; the click was not sent\.$/);
    expect(err.actionDisabled).toMatchObject({ tag: 'BUTTON', text: 'Submit', reason: 'disabled attribute', selector: '#submit' });
    expect(cdp.inputEvents()).toEqual([]);

    const target = { input: '#submit', targetId: TARGET_ID };
    const failure = classifyActionFailure(err, { action: 'click', target });
    expect(failure).toMatchObject({ kind: 'disabled', dispatched: false });
    // `:not(:disabled)` alone would also match an aria-disabled control, so Next requires both.
    const enabled = `cdp waitfor ${TARGET_ID} '#submit:not(:disabled):not([aria-disabled="true"])'`;
    expect(failure.nextCommand).toBe(enabled);
    expect(failure.disabled).toMatchObject({ reason: 'disabled attribute', matches: 1 });
    expect(failure.hints.join('\n')).toMatch(/browser does not deliver it to a disabled form control/);
    const text = formatActionFailure(err, { action: 'click', target });
    expect(text.split('\n')).toEqual([
      expect.stringMatching(/^Error: <BUTTON> "Submit" is disabled/),
      'Kind: disabled',
      `Next: ${enabled}`,
    ]);
  });

  it('points Next at perceive when the selector matches several elements, so a sibling cannot satisfy waitfor', async () => {
    const page = fakePage();
    page.nodes.set('form button', page.el('button', { text: 'Save', attrs: { disabled: '' } }));
    page.context.document.extraMatches.set('form button', [page.el('button', { text: 'Cancel' })]);
    const cdp = fakeCdp(page);
    const err = await T.clickStr(cdp, 'sid', 'form button', new Map(), {}, { waitMs: 0 }).catch(e => e);
    expect(err.actionDisabled.matches).toBe(2);
    const failure = classifyActionFailure(err, { action: 'click', target: { input: 'form button', targetId: TARGET_ID } });
    expect(failure.nextCommand).toBe(`cdp perceive ${TARGET_ID} -C -d 8`);
    expect(failure.hints.join('\n')).toMatch(/matches 2 elements and click uses the first/);
    expect(failure.hints.join('\n')).not.toMatch(/waitfor/);
  });

  it('clicks a button that becomes enabled during the wait', async () => {
    const page = fakePage();
    const button = page.el('button', { text: 'Pay', attrs: { disabled: '' } });
    page.nodes.set('#pay', button);
    page.later(300, () => { delete button.attrs.disabled; });
    const cdp = fakeCdp(page);
    const out = await T.clickStr(cdp, 'sid', '#pay', new Map(), {});
    expect(out).toMatch(/^Clicked <BUTTON> "Pay" \(waited \d+ms for enabled\)$/);
  });

  it('treats aria-disabled="true" and a disabled <fieldset> ancestor as disabled', async () => {
    const page = fakePage();
    page.nodes.set('[role=button]', page.el('div', { text: 'Archive', attrs: { 'aria-disabled': 'true', role: 'button' } }));
    const fieldset = page.el('fieldset', { attrs: { disabled: '' } });
    page.nodes.set('#inner', page.el('button', { text: 'Send', fieldset }));
    const cdp = fakeCdp(page);
    const aria = await T.clickStr(cdp, 'sid', '[role=button]', new Map(), {}, { waitMs: 0 }).catch(e => e);
    expect(aria.message).toBe('<DIV> "Archive" is disabled (aria-disabled="true"); the click was not sent.');
    const ariaFailure = classifyActionFailure(aria, { action: 'click', target: { input: '[role=button]', targetId: TARGET_ID } });
    expect(ariaFailure.nextCommand)
      .toBe(`cdp waitfor ${TARGET_ID} '[role=button]:not(:disabled):not([aria-disabled="true"])'`);
    // aria-disabled is not enforced by browsers: the hints name the deliberate escape and do not
    // claim that a JS click would be ignored.
    const ariaHints = ariaFailure.hints.join('\n');
    expect(ariaHints).toContain(`cdp click ${TARGET_ID} "[role=button]" --js`);
    expect(ariaHints).toMatch(/not enforced by the browser/);
    expect(ariaHints).not.toMatch(/ignores it|does not deliver/);
    const inner = await T.clickStr(cdp, 'sid', '#inner', new Map(), {}, { waitMs: 0 }).catch(e => e);
    expect(inner.message).toBe('<BUTTON> "Send" is disabled (inside a disabled <fieldset>); the click was not sent.');
    expect(cdp.inputEvents()).toEqual([]);
  });

  it('--wait-ms 0 keeps the fail-fast miss, with the existing message', async () => {
    const page = fakePage();
    page.later(100, () => page.nodes.set('#late', page.el('button', { text: 'Late' })));
    const cdp = fakeCdp(page);
    const started = Date.now();
    const err = await T.clickStr(cdp, 'sid', '#late', new Map(), {}, { waitMs: 0 }).catch(e => e);
    expect(Date.now() - started).toBeLessThan(90);
    expect(err.message).toBe('Element not found: #late. No element matches this CSS selector; pass the control\'s visible text or an @ref from perceive.');
  });

  it('a missing element still fails after the wait with the selector classification', async () => {
    const page = fakePage();
    const cdp = fakeCdp(page);
    const started = Date.now();
    const err = await T.clickStr(cdp, 'sid', '#gone', new Map(), {}, { waitMs: 300 }).catch(e => e);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(err.message).toMatch(/^Element not found: #gone \(waited \d+ms for attach\)\. No element matches this CSS selector/);
    const failure = classifyActionFailure(err, { action: 'click', target: { input: '#gone', targetId: TARGET_ID } });
    expect(failure.kind).toBe('selector');
    expect(cdp.inputEvents()).toEqual([]);
  });

  it('bounds the page evaluation by the wait so CDP does not time out first', async () => {
    const page = fakePage();
    page.nodes.set('#now', page.el('button', { text: 'Go' }));
    const cdp = fakeCdp(page);
    await T.clickStr(cdp, 'sid', '#now', new Map(), {}, { waitMs: 5000 });
    const locate = cdp.calls.find(call => call.method === 'Runtime.evaluate' && String(call.params.expression).includes('waitForActionable'));
    expect(locate.timeoutMs).toBe(15000 + 5000);
  });

  it('keeps an invalid selector an invalid-selector failure without waiting', async () => {
    const page = fakePage();
    page.context.document.querySelector = (selector) => {
      if (selector.includes(':has-text(')) throw new Error(`'${selector}' is not a valid selector.`);
      return null;
    };
    const cdp = fakeCdp(page);
    const started = Date.now();
    const err = await T.clickStr(cdp, 'sid', 'button:has-text("Save")', new Map(), {}).catch(e => e);
    expect(Date.now() - started).toBeLessThan(200);
    expect(classifyActionFailure(err, { action: 'click', target: { input: 'button:has-text("Save")' } }).kind).toBe('invalid-selector');
  });
});

describe('#468 @ref click checks disabled without waiting', () => {
  it('fails a disabled @ref from the scroll-settled rect before any input is sent', async () => {
    const page = fakePage();
    const button = page.el('button', { text: 'Delete', attrs: { disabled: '' } });
    const fn = runInNewContext(`(${T.scrollSettledRectFunctionDeclaration({ hitTest: true })})`, page.context);
    const value = await fn.call(button);
    expect(value.disabled).toBe('disabled attribute');
    const enabled = await fn.call(page.el('button', { text: 'Keep' }));
    expect(enabled.disabled).toBe('');
  });

  it('names the @ref in the error and points Next at perceive', () => {
    const err = T.actionDisabledError('click', { tag: 'BUTTON', text: 'Delete', reason: 'disabled attribute' }, '@7');
    expect(err.message).toBe('<BUTTON> "Delete" (@7) is disabled (disabled attribute); the click was not sent.');
    const failure = classifyActionFailure(err, { action: 'click', target: { input: '@7', targetId: TARGET_ID } });
    expect(failure.kind).toBe('disabled');
    expect(failure.nextCommand).toBe(`cdp perceive ${TARGET_ID} -C -d 8`);
  });

  it('still refuses a disabled @ref when the scroll settle timed out (#464 fallback)', async () => {
    const calls = [];
    const cdp = {
      onEvent() { return () => {}; },
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: null } });
        if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'root-frame' } } });
        if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
        if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'button-object' } });
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('scrollIntoView')) return Promise.reject(new Error('Timeout: Runtime.callFunctionOn'));
          if (fn.includes('hit: clickPointHit(this')) {
            return Promise.resolve({ result: { value: { hit: { covered: false }, disabled: 'disabled attribute' } } });
          }
          if (fn.includes('getBoundingClientRect')) {
            return Promise.resolve({ result: { value: { x: 40, y: 300, w: 120, h: 32, tag: 'BUTTON', text: 'Delete' } } });
          }
          return Promise.resolve({ result: { value: true } });
        }
        return Promise.resolve({});
      },
    };
    const refs = new Map([[15, 99]]);
    const rect = await T.resolveRef(cdp, 'sid', refs, '@15', {}, { hitTest: true });
    expect(rect).toMatchObject({ settled: false, disabled: 'disabled attribute', hit: { covered: false } });
    const err = await T.clickStr(cdp, 'sid', '@15', refs, {}).catch(e => e);
    expect(err.message).toBe('<BUTTON> "Delete" (@15) is disabled (disabled attribute); the click was not sent.');
    expect(calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });
});

describe('#468 click --pointer gives the same Kind: disabled', () => {
  async function pointerOn(attrs, { matches = 1 } = {}) {
    const page = fakePage();
    const button = page.el('button', { text: 'Archive', attrs });
    button.disabled = Object.hasOwn(attrs, 'disabled');
    page.context.document.querySelectorAll = () => Array.from({ length: matches }, () => button);
    const declaration = T.pointerClickFunctionDeclaration(0, '#archive');
    return runInNewContext(`(${declaration})`, page.context).call(button);
  }

  it('carries the reason, so an aria-disabled target gets a Next that cannot loop', async () => {
    const r = await pointerOn({ 'aria-disabled': 'true' });
    expect(r).toMatchObject({ ok: false, disabled: { tag: 'BUTTON', reason: 'aria-disabled="true"', matches: 1 } });
    const cdp = {
      send(method) {
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 7 });
        if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj-7' } });
        if (method === 'Runtime.callFunctionOn') return Promise.resolve({ result: { value: r } });
        return Promise.resolve({});
      },
    };
    const err = await T.pointerClickStr(cdp, 'sid', '#archive', new Map(), {}).catch(e => e);
    expect(err.message).toBe('<BUTTON> "Archive" is disabled (aria-disabled="true"); the click was not sent.');
    const failure = classifyActionFailure(err, { action: 'click', target: { input: '#archive', targetId: TARGET_ID } });
    expect(failure.kind).toBe('disabled');
    expect(failure.nextCommand).toBe(`cdp waitfor ${TARGET_ID} '#archive:not(:disabled):not([aria-disabled="true"])'`);
    expect(failure.hints.join(' ')).toContain(`cdp click ${TARGET_ID} "#archive" --js`);
  });

  it('reports a native disabled reason and the match count', async () => {
    expect((await pointerOn({ disabled: '' }, { matches: 3 })).disabled).toMatchObject({ reason: 'disabled attribute', matches: 3 });
  });

  it('falls back to perceive for the legacy message with no structured reason', () => {
    const failure = classifyActionFailure(new Error('click --pointer: element is disabled (BUTTON "Save")'), {
      action: 'click',
      target: { input: '#save', targetId: TARGET_ID },
    });
    expect(failure.nextCommand).toBe(`cdp perceive ${TARGET_ID} -C -d 8`);
  });
});

describe('#468 fill and select share the wait and the disabled check', () => {
  it('fills an input that appears late and reports the wait', async () => {
    const page = fakePage();
    page.later(200, () => page.nodes.set('#email', page.el('input', { type: 'email' })));
    const cdp = fakeCdp(page);
    const out = await T.fillStr(cdp, 'sid', '#email', 'a@b.c', new Map(), {});
    expect(out).toMatch(/^Filled <INPUT> with "a@b\.c" \(waited \d+ms for attach\)$/);
  });

  it('fails a disabled input with Kind: disabled and types nothing', async () => {
    const page = fakePage();
    const input = page.el('input', { type: 'text', attrs: { disabled: '', name: 'city' } });
    page.nodes.set('#city', input);
    const cdp = fakeCdp(page);
    const err = await T.fillStr(cdp, 'sid', '#city', 'Paris', new Map(), {}, { waitMs: 0 }).catch(e => e);
    expect(err.message).toBe('<INPUT> "city" is disabled (disabled attribute); nothing was typed.');
    expect(classifyActionFailure(err, { action: 'fill', target: { input: '#city', targetId: TARGET_ID } }).kind).toBe('disabled');
    expect(cdp.inputEvents()).toEqual([]);
    expect(input.value).toBe('');
    expect(input.events).toEqual([]);
  });

  it('selects an option and fails a disabled <select> without changing it', async () => {
    const page = fakePage();
    const option = { value: 'fr', textContent: 'France', selected: false };
    const select = page.el('select', { attrs: { name: 'country' }, options: [option] });
    page.nodes.set('#country', select);
    const cdp = fakeCdp(page);
    await expect(T.selectStr(cdp, 'sid', '#country', 'fr')).resolves.toBe('Selected "France"');

    select.attrs.disabled = '';
    option.selected = false;
    select.events = [];
    const err = await T.selectStr(cdp, 'sid', '#country', 'fr', { waitMs: 0 }).catch(e => e);
    expect(err.message).toBe('<SELECT> "country" is disabled (disabled attribute); no option was selected.');
    expect(classifyActionFailure(err, { action: 'select', target: { input: '#country', targetId: TARGET_ID } }).kind).toBe('disabled');
    expect(option.selected).toBe(false);
    expect(select.events).toEqual([]);
  });

  it('fill and select refuse only native disabled: aria-disabled is not enforced and they have no JS-click escape', async () => {
    const page = fakePage();
    page.nodes.set('#note', page.el('input', { type: 'text', attrs: { 'aria-disabled': 'true' } }));
    const option = { value: 'fr', textContent: 'France', selected: false };
    page.nodes.set('#country', page.el('select', { attrs: { 'aria-disabled': 'true' }, options: [option] }));
    const cdp = fakeCdp(page);
    const started = Date.now();
    await expect(T.fillStr(cdp, 'sid', '#note', 'hi', new Map(), {})).resolves.toBe('Filled <INPUT> with "hi"');
    await expect(T.selectStr(cdp, 'sid', '#country', 'fr')).resolves.toBe('Selected "France"');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('does not require a <select> to be visible', async () => {
    const page = fakePage();
    const option = { value: 'b', textContent: 'B', selected: false };
    page.nodes.set('#hidden', page.el('select', { options: [option], style: { display: 'none' }, rect: { x: 0, y: 0, width: 0, height: 0 } }));
    const cdp = fakeCdp(page);
    const started = Date.now();
    await expect(T.selectStr(cdp, 'sid', '#hidden', 'b')).resolves.toBe('Selected "B"');
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('#468 --wait-ms flag and recovery policy', () => {
  it('parses --wait-ms on click and fill, and keeps it through CLI fill normalisation', () => {
    expect(T.parseClickArgs(['#a', '--wait-ms', '500']).waitMs).toBe(500);
    expect(T.parseClickArgs(['--wait-ms=0', '#a'])).toMatchObject({ waitMs: 0, selector: '#a' });
    expect(T.parseClickArgs(['#a']).waitMs).toBeNull();
    expect(() => T.parseClickArgs(['#a', '--wait-ms', 'soon'])).toThrow(/--wait-ms must be a non-negative integer/);
    expect(() => T.parseClickArgs(['#a', '--wait-ms', '999999'])).toThrow(/--wait-ms must be at most 30000/);
    expect(T.parseFillArgs(['#a', 'hello', '--wait-ms', '0'])).toMatchObject({ waitMs: 0, selector: '#a', text: 'hello' });
    expect(T.normalizeTargetCommandArgs('fill', ['#a', 'hi', 'there', '--wait-ms', '250'])).toEqual(['#a', 'hi there', '--wait-ms', '250']);
    expect(T.normalizeTargetCommandArgs('fill', ['#a', 'hi'])).toEqual(['#a', 'hi']);
  });

  it('passes --wait-ms from the click handler to the mouse click path only', async () => {
    const seen = [];
    const handler = T.createClickCommandHandler({
      actionFeedback: async (_action, dispatch) => dispatch(),
      click: (selector, opts) => { seen.push(['click', selector, opts]); return 'ok'; },
      jsClick: selector => { seen.push(['js', selector]); return 'ok'; },
      pointerClick: selector => { seen.push(['pointer', selector]); return 'ok'; },
    });
    await handler({ args: ['#a', '--wait-ms', '750'] });
    await handler({ args: ['#a'] });
    expect(seen).toEqual([['click', '#a', { waitMs: 750 }], ['click', '#a', { waitMs: null }]]);
  });

  it('registers a disabled recovery policy', () => {
    expect(listRecoveryPolicyKinds()).toContain('disabled');
    expect(getRecoveryPolicyTemplate('disabled').strategy).toBe('wait-or-inspect');
  });

  it('classifies the older click --pointer disabled message as Kind: disabled', () => {
    const failure = classifyActionFailure(new Error('click --pointer: element is disabled (BUTTON "Save")'), {
      action: 'click',
      target: { input: '#save', targetId: TARGET_ID },
    });
    expect(failure.kind).toBe('disabled');
  });
});
