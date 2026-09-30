import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// A stand-in element: records every dispatched event so the sequence and its flags can be asserted.
function fakeElement({ disabled = false, ariaDisabled = null, rect = { left: 100, top: 40, width: 80, height: 20 }, style = {}, trigger = null } = {}) {
  const events = [];
  const attrs = { 'aria-expanded': 'false', 'data-state': 'closed' };
  const el = {
    tagName: 'BUTTON',
    disabled,
    innerText: 'Video 720p',
    textContent: 'Video 720p',
    events,
    attrs,
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    getAttribute: name => (name === 'aria-disabled' && ariaDisabled != null ? ariaDisabled : attrs[name] ?? null),
    closest: () => trigger || el,
    dispatchEvent(event) {
      events.push(event);
      // Radix-like: the menu opens on pointerdown, not on click.
      if (event.type === 'pointerdown') { attrs['aria-expanded'] = 'true'; attrs['data-state'] = 'open'; }
      return true;
    },
    style,
  };
  return el;
}

// Run the in-page declaration against the fake element with just enough browser globals.
async function runDeclaration(el, { settleMs = 0 } = {}) {
  class FakeEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const declaration = T.pointerClickFunctionDeclaration(settleMs);
  const factory = new Function('PointerEvent', 'MouseEvent', 'getComputedStyle', 'window', 'setTimeout',
    `return (${declaration});`);
  const fn = factory(FakeEvent, FakeEvent, () => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto', ...el.style }),
    {}, (cb) => { cb(); return 0; });
  return fn.call(el);
}

describe('click --pointer: argument parsing and routing', () => {
  it('parses --pointer next to a selector and rejects mixing it with --js', () => {
    expect(T.parseClickArgs(['#chip', '--pointer']).pointer).toBe(true);
    expect(T.parseClickArgs(['--pointer', '#chip']).selector).toBe('#chip');
    expect(T.parseClickArgs(['#chip']).pointer).toBe(false);
    expect(() => T.parseClickArgs(['#chip', '--pointer', '--js'])).toThrow(/--pointer.*--js|--js.*--pointer/);
    expect(() => T.parseClickArgs(['#chip', '--bogus'])).toThrow(/unknown argument/);
  });

  it('routes --pointer to the pointer path and leaves click and --js untouched', async () => {
    const click = vi.fn(async s => `normal:${s}`);
    const jsClick = vi.fn(async s => `js:${s}`);
    const pointerClick = vi.fn(async s => `pointer:${s}`);
    const seenTargets = [];
    const actionFeedback = vi.fn(async (_action, dispatch, target) => { seenTargets.push(target); return dispatch(); });
    const handler = T.createClickCommandHandler({ actionFeedback, click, jsClick, pointerClick });

    expect((await handler({ args: ['#chip', '--pointer'] })).value).toBe('pointer:#chip');
    expect(seenTargets[0].commandArgs).toEqual(['--pointer', '#chip']);
    expect((await handler({ args: ['#chip', '--js'] })).value).toBe('js:#chip');
    expect((await handler({ args: ['#chip'] })).value).toBe('normal:#chip');
    expect(pointerClick).toHaveBeenCalledTimes(1);
    expect(jsClick).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('click --pointer: the in-page sequence', () => {
  it('dispatches pointerdown, mousedown, pointerup, mouseup, click at the element centre with the right flags', async () => {
    const el = fakeElement();
    const out = await runDeclaration(el);
    expect(out.ok).toBe(true);
    expect(el.events.map(e => e.type)).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    for (const e of el.events) {
      expect(e).toMatchObject({ bubbles: true, cancelable: true, button: 0, clientX: 140, clientY: 50 });
    }
    for (const e of el.events.filter(e => e.type.startsWith('pointer'))) {
      expect(e).toMatchObject({ pointerType: 'mouse', pointerId: 1 });
    }
    expect(el.events.filter(e => ['pointerdown', 'mousedown'].includes(e.type)).every(e => e.buttons === 1)).toBe(true);
    expect(el.events.filter(e => ['pointerup', 'mouseup', 'click'].includes(e.type)).every(e => e.buttons === 0)).toBe(true);
  });

  it('reports the trigger state after the settle wait so a menu that opened is visible', async () => {
    const out = await runDeclaration(fakeElement());
    expect(out).toMatchObject({ ok: true, tag: 'BUTTON', ariaExpanded: 'true', dataState: 'open' });
  });

  it('fails clearly for a disabled, aria-disabled, zero-size, hidden or pointer-events:none element and dispatches nothing', async () => {
    const cases = [
      [fakeElement({ disabled: true }), /disabled/],
      [fakeElement({ ariaDisabled: 'true' }), /disabled/],
      [fakeElement({ rect: { left: 0, top: 0, width: 0, height: 0 } }), /not visible|zero size/],
      [fakeElement({ style: { visibility: 'hidden' } }), /not visible|hidden/],
      [fakeElement({ style: { pointerEvents: 'none' } }), /pointer-events/],
    ];
    for (const [el, message] of cases) {
      const out = await runDeclaration(el);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(message);
      expect(el.events).toHaveLength(0);
    }
  });
});

describe('click --pointer: the command receipt', () => {
  function mockCdp(value) {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 7 });
        if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj-7' } });
        if (method === 'Runtime.callFunctionOn') return Promise.resolve({ result: { value } });
        return Promise.resolve({});
      },
    };
  }

  it('names the mode, the element and the trigger state, and never uses Input events', async () => {
    const cdp = mockCdp({ ok: true, tag: 'BUTTON', text: '720p', ariaExpanded: 'true', dataState: 'open' });
    const out = await T.pointerClickStr(cdp, 'sid', '#chip', new Map(), {});
    expect(out).toContain('mode: pointer-sequence');
    expect(out).toContain('<BUTTON>');
    expect(out).toContain('720p');
    expect(out).toContain('aria-expanded=true');
    expect(out).toContain('data-state=open');
    const call = cdp.calls.find(c => c.method === 'Runtime.callFunctionOn');
    expect(call.params.awaitPromise).toBe(true);
    expect(cdp.calls.find(c => c.method.startsWith('Input.'))).toBeUndefined();
  });

  it('says nothing opened when the trigger reports closed, instead of implying success', async () => {
    const cdp = mockCdp({ ok: true, tag: 'BUTTON', text: '720p', ariaExpanded: 'false', dataState: 'closed' });
    const out = await T.pointerClickStr(cdp, 'sid', '#chip', new Map(), {});
    expect(out).toMatch(/aria-expanded=false/);
    expect(out).toMatch(/no menu|did not open|still closed/i);
  });

  it('throws the page error for an unusable element and refuses a name query', async () => {
    const cdp = mockCdp({ ok: false, error: 'element is disabled' });
    await expect(T.pointerClickStr(cdp, 'sid', '#chip', new Map(), {})).rejects.toThrow(/disabled/);
    await expect(T.pointerClickStr(mockCdp({}), 'sid', 'Browse 1M+ applications', new Map(), {}))
      .rejects.toThrow(/CSS selector or @ref/);
  });
});
