import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

// #640: `scroll <t> down|up [N]` moved only the window. On an app shell whose document does not
// scroll, nothing moved and the receipt still said "Scrolled by (0, 500)". A directional scroll now
// moves the document when it can scroll on that axis, else the page's main scroll container (the
// one `to bottom` and perceive's Scroll line use), and --scroll-container works with every direction.

function FakeElement() {}
FakeElement.prototype.scrollTo = function (...args) { return this._nativeScrollTo(...args); };
FakeElement.prototype.scrollBy = function (...args) { return this._nativeScrollBy(...args); };

function overflowElement({ id, scrollHeight, clientHeight, clientWidth = 800, overflowY = 'auto', scrollTop = 0 }) {
  const state = { scrollTop, scrollHeight, clientHeight, clientWidth, overflowY, scrollEvents: 0 };
  const clamp = value => Math.max(0, Math.min(state.scrollHeight - state.clientHeight, Math.round(Number(value) || 0)));
  const el = {
    id,
    tagName: 'DIV',
    parentElement: null,
    get scrollTop() { return state.scrollTop; },
    get scrollHeight() { return state.scrollHeight; },
    get clientHeight() { return state.clientHeight; },
    get clientWidth() { return state.clientWidth; },
    _nativeScrollTo(options) { state.scrollTop = clamp(options.top); },
    _nativeScrollBy(options) { state.scrollTop = clamp(state.scrollTop + (Number(options.top) || 0)); },
    dispatchEvent() { state.scrollEvents += 1; return true; },
    _state: state,
  };
  return el;
}

// A document `docScrollMax` px taller than the viewport, plus nested scrollers.
function page({ docScrollMax = 0, scrollY = 0, containers = [] } = {}) {
  const innerHeight = 800;
  const state = { scrollY, scrollHeight: innerHeight + docScrollMax, documentCalls: 0 };
  const scroller = {
    get scrollHeight() { return state.scrollHeight; },
    get scrollWidth() { return 1200; },
    get clientWidth() { return 1200; },
    _nativeScrollBy(options) {
      state.documentCalls += 1;
      state.scrollY = Math.max(0, Math.min(docScrollMax, state.scrollY + (Number(options.top) || 0)));
    },
    _nativeScrollTo(options) { state.scrollY = Math.max(0, Math.min(docScrollMax, Number(options.top) || 0)); },
  };
  const byId = new Map(containers.map(el => [`#${el.id}`, el]));
  const document = {
    scrollingElement: scroller,
    documentElement: scroller,
    querySelector: sel => byId.get(sel) || null,
    querySelectorAll: sel => (sel === '*' ? containers : []),
  };
  const window = {
    innerHeight,
    innerWidth: 1200,
    get scrollY() { return state.scrollY; },
    get scrollX() { return 0; },
    getComputedStyle: el => ({ overflowY: el?._state?.overflowY || 'visible', overflow: el?._state?.overflowY || 'visible' }),
  };
  return { state, window, document };
}

function pageCdp(fake) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
      const value = runInNewContext(String(params.expression || ''), {
        window: fake.window,
        document: fake.document,
        Element: FakeElement,
        Math,
        JSON,
        Number,
        String,
        Event: function Event(type) { this.type = type; },
      });
      return Promise.resolve({ result: { value } });
    },
  };
}

describe('#640 directional scroll', () => {
  it('puts the amount before --scroll-container wherever it was typed', () => {
    expect(T.normalizeScrollArgs(['down'])).toEqual(['down']);
    expect(T.normalizeScrollArgs(['down', '300'])).toEqual(['down', '300']);
    expect(T.normalizeScrollArgs(['down', '--scroll-container', '#list'])).toEqual(['down', '--scroll-container', '#list']);
    expect(T.normalizeScrollArgs(['down', '--scroll-container', '#list', '300'])).toEqual(['down', '300', '--scroll-container', '#list']);
    expect(T.normalizeScrollArgs(['to bottom', '--scroll-container', '#list'])).toEqual(['to', 'bottom', '--scroll-container', '#list']);
  });

  it('keeps the document receipt when the document scrolls', async () => {
    const list = overflowElement({ id: 'list', scrollHeight: 5000, clientHeight: 400 });
    const fake = page({ docScrollMax: 3000, containers: [list] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'down', '80')).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(list.scrollTop).toBe(0);
    expect(cdp.calls[0].params.expression).toContain('chrome-cdp-ex.scroll-by');
    expect(cdp.calls[0].params.expression).not.toContain('chrome-cdp-ex.scroll-edge');
  });

  it('stays on the document at its bottom edge instead of scrolling some inner box', async () => {
    const code = overflowElement({ id: 'code', scrollHeight: 900, clientHeight: 300 });
    const fake = page({ docScrollMax: 3000, scrollY: 3000, containers: [code] });
    expect(await T.scrollStr(pageCdp(fake), 'sid', 'down', '500')).toBe('Scrolled by (0, 500). Position: (0, 3000)');
    expect(code.scrollTop).toBe(0);
  });

  it('moves the main scroll container when the document cannot scroll, and names it', async () => {
    const sidebar = overflowElement({ id: 'sidebar', scrollHeight: 1200, clientHeight: 800, clientWidth: 240 });
    const viewport = overflowElement({ id: 'viewport', scrollHeight: 18000, clientHeight: 800 });
    const fake = page({ docScrollMax: 0, containers: [sidebar, viewport] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'down', '6400')).toBe('Scrolled #viewport by (0, 6400): scrollTop 0 → 6400 / 17200 max');
    expect(viewport.scrollTop).toBe(6400);
    expect(viewport._state.scrollEvents).toBe(1);
    expect(sidebar.scrollTop).toBe(0);
    expect(fake.state.documentCalls).toBe(0);
    expect(await T.scrollStr(cdp, 'sid', 'up', '400')).toBe('Scrolled #viewport by (0, -400): scrollTop 6400 → 6000 / 17200 max');
  });

  it('reports the container edge instead of claiming a scroll', async () => {
    const viewport = overflowElement({ id: 'viewport', scrollHeight: 1800, clientHeight: 800, scrollTop: 900 });
    const cdp = pageCdp(page({ containers: [viewport] }));
    expect(await T.scrollStr(cdp, 'sid', 'down', '500')).toBe('Scrolled #viewport by (0, 500): scrollTop 900 → 1000 / 1000 max (at-bottom: yes)');
    expect(await T.scrollStr(cdp, 'sid', 'down', '500')).toBe('Did not scroll: #viewport is already at the bottom. scrollTop: 1000 / 1000 max');
  });

  it('accepts --scroll-container with any direction, with or without an amount', async () => {
    const sidebar = overflowElement({ id: 'sidebar', scrollHeight: 1200, clientHeight: 800, clientWidth: 240 });
    const viewport = overflowElement({ id: 'viewport', scrollHeight: 18000, clientHeight: 800 });
    const fake = page({ docScrollMax: 3000, containers: [sidebar, viewport] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'down', '--scroll-container', ['#sidebar']))
      .toBe('Scrolled #sidebar by (0, 500): scrollTop 0 → 400 / 400 max (at-bottom: yes)');
    expect(await T.scrollStr(cdp, 'sid', 'down', '250', ['--scroll-container', '#viewport']))
      .toBe('Scrolled #viewport by (0, 250): scrollTop 0 → 250 / 17200 max');
    expect(fake.state.scrollY).toBe(0);
    await expect(T.scrollStr(cdp, 'sid', 'down', '250', ['--scroll-container', '#missing'])).rejects.toThrow(/scroll-container not found/);
    await expect(T.scrollStr(cdp, 'sid', 'down', '250', ['--scroll-container', '@3'])).rejects.toThrow(/requires a CSS selector/);
  });

  it('fails when nothing on the page scrolls on that axis, with Kind not-scrollable', async () => {
    const cdp = pageCdp(page({ docScrollMax: 0 }));
    let error;
    try { await T.scrollStr(cdp, 'sid', 'down', '500'); } catch (caught) { error = caught; }
    expect(error?.message).toBe('scroll: nothing scrolled: the page does not scroll vertically, and no scroll container was found. Position: (0, 0)');
    const failure = classifyActionFailure(error, { action: 'scroll', target: { targetId: 'ABCDEF1234567890', input: 'down 500' } });
    expect(failure).toMatchObject({ kind: 'not-scrollable', nextCommand: 'cdp perceive ABCDEF12 -C -d 8' });
    await expect(T.scrollStr(cdp, 'sid', 'right', '300')).rejects.toThrow(/nothing scrolled: the page does not scroll horizontally/);
  });

  it('still reads the old {x, y} reply of a page that answers only that shape', async () => {
    const cdp = { send: () => Promise.resolve({ result: { value: '{"x":0,"y":0}' } }) };
    expect(await T.scrollStr(cdp, 'sid', 'down', '100')).toBe('Scrolled by (0, 100). Position: (0, 0)');
  });
});
