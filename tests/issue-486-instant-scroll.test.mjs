import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const CDP_SOURCE = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');

// A page with `html { scroll-behavior: smooth }`: any scroll that does not pass
// `behavior: 'instant'` starts an animation, so the position read in the same
// task is still the starting one. Only an instant scroll lands synchronously.
function scrollTarget(args, current) {
  const first = args[0];
  if (first && typeof first === 'object') {
    return {
      left: first.left === undefined ? current.left : Number(first.left),
      top: first.top === undefined ? current.top : Number(first.top),
      behavior: first.behavior,
    };
  }
  return { left: Number(args[0]) || 0, top: Number(args[1]) || 0, behavior: undefined };
}

function createSmoothDocumentPage({ scrollY = 0, innerHeight = 600, scrollHeight = 3000 } = {}) {
  const state = { scrollX: 0, scrollY, innerHeight, scrollHeight, calls: [] };
  const max = () => Math.max(0, state.scrollHeight - state.innerHeight);
  const land = (top, left) => {
    if (left !== undefined) state.scrollX = Math.max(0, Math.round(left));
    state.scrollY = Math.max(0, Math.min(max(), Math.round(top)));
  };
  const windowObj = {
    get innerWidth() { return 800; },
    get innerHeight() { return state.innerHeight; },
    get scrollX() { return state.scrollX; },
    get scrollY() { return state.scrollY; },
    scrollTo(...args) {
      const target = scrollTarget(args, { left: state.scrollX, top: state.scrollY });
      state.calls.push({ method: 'scrollTo', args, behavior: target.behavior });
      if (target.behavior === 'instant') land(target.top, target.left);
    },
    scrollBy(...args) {
      const delta = scrollTarget(args, { left: 0, top: 0 });
      state.calls.push({ method: 'scrollBy', args, behavior: delta.behavior });
      if (delta.behavior === 'instant') land(state.scrollY + delta.top, state.scrollX + delta.left);
    },
    getComputedStyle: el => ({ overflowY: el?._overflowY || 'visible', overflow: el?._overflowY || 'visible' }),
  };
  const scroller = { get scrollHeight() { return state.scrollHeight; } };
  const documentObj = {
    scrollingElement: scroller,
    documentElement: scroller,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return { state, window: windowObj, document: documentObj };
}

function createSmoothOverflowElement({ id, scrollHeight = 2000, clientHeight = 400 } = {}) {
  const state = { scrollTop: 0, writes: [], calls: [] };
  const max = () => Math.max(0, scrollHeight - clientHeight);
  return {
    id,
    tagName: 'DIV',
    parentElement: null,
    _overflowY: 'auto',
    _state: state,
    get scrollTop() { return state.scrollTop; },
    // Smooth container: a raw scrollTop write only starts the animation.
    set scrollTop(value) { state.writes.push(value); },
    get scrollHeight() { return scrollHeight; },
    get clientHeight() { return clientHeight; },
    get clientWidth() { return 600; },
    scrollTo(...args) {
      const target = scrollTarget(args, { left: 0, top: state.scrollTop });
      state.calls.push({ args, behavior: target.behavior });
      if (target.behavior === 'instant') state.scrollTop = Math.max(0, Math.min(max(), Math.round(target.top)));
    },
    dispatchEvent() { return true; },
  };
}

function pageCdp(page, { onCapture } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Page.captureScreenshot') {
        onCapture?.();
        return { data: Buffer.from('png').toString('base64') };
      }
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
      const expression = String(params.expression || '');
      // Screenshot sanity inspection is not under test here.
      if (expression.includes('parseRgb')) return { result: { value: '{}' } };
      const value = runInNewContext(expression, {
        window: page.window,
        document: page.document,
        Math,
        JSON,
        Number,
        String,
        Event: function Event(type) { this.type = type; },
      });
      return { result: { value } };
    },
  };
}

describe('issue #486 automation scrolls are instant on smooth-scrolling pages', () => {
  it('scroll down reports the final Position, not the smooth-scroll starting point', async () => {
    const page = createSmoothDocumentPage({ scrollY: 0 });
    const text = await T.scrollStr(pageCdp(page), 'sid', 'down', '80');
    expect(text).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(page.state.calls).toEqual([
      { method: 'scrollBy', args: [{ left: 0, top: 80, behavior: 'instant' }], behavior: 'instant' },
    ]);
  });

  it('scroll x,y passes both axes through an instant scrollBy', async () => {
    const page = createSmoothDocumentPage({ scrollY: 100 });
    const text = await T.scrollStr(pageCdp(page), 'sid', '15,-40');
    expect(text).toBe('Scrolled by (15, -40). Position: (15, 60)');
    expect(page.state.calls.every(call => call.behavior === 'instant')).toBe(true);
  });

  it('scroll to bottom / to top land on the document edge in the same evaluation', async () => {
    const page = createSmoothDocumentPage({ scrollY: 0 });
    const cdp = pageCdp(page);
    expect(await T.scrollStr(cdp, 'sid', 'to', 'bottom')).toBe('Scrolled to bottom. scrollY: 2400 / 2400 max (at-bottom: yes)');
    expect(await T.scrollStr(cdp, 'sid', 'to', 'top')).toBe('Scrolled to top. scrollY: 0 / 2400 max (at-top: yes)');
    expect(page.state.calls.map(call => call.behavior)).toEqual(['instant', 'instant']);
    expect(page.state.calls[0].args).toEqual([{ left: 0, top: 2400, behavior: 'instant' }]);
  });

  it('scroll to bottom of a smooth nested overflow container lands instantly', async () => {
    const page = createSmoothDocumentPage({ scrollY: 0, scrollHeight: 600 });
    const content = createSmoothOverflowElement({ id: 'content' });
    page.document.querySelector = sel => (sel === '#content' ? content : null);
    page.document.querySelectorAll = sel => (sel === '*' ? [content] : []);
    const cdp = pageCdp(page);
    expect(await T.scrollStr(cdp, 'sid', 'to', 'bottom')).toBe('Scrolled to bottom. #content scrollTop: 1600 / 1600 max (at-bottom: yes)');
    expect(await T.scrollStr(cdp, 'sid', 'to', 'top', ['--scroll-container', '#content']))
      .toBe('Scrolled to top. #content scrollTop: 0 / 1600 max (at-top: yes)');
    expect(content._state.writes).toEqual([]);
    expect(content._state.calls).toEqual([
      { args: [{ top: 1600, behavior: 'instant' }], behavior: 'instant' },
      { args: [{ top: 0, behavior: 'instant' }], behavior: 'instant' },
    ]);
  });

  it('scanshot captures each segment at its own offset and restores the original position', async () => {
    const page = createSmoothDocumentPage({ scrollY: 250, innerHeight: 600, scrollHeight: 1500 });
    page.document.documentElement = { scrollHeight: 1500 };
    const capturedAt = [];
    const cdp = pageCdp(page, { onCapture: () => capturedAt.push(page.state.scrollY) });
    // vitest.config points LOCALAPPDATA / XDG_RUNTIME_DIR at a throwaway dir; scanshot writes into <it>/cdp.
    mkdirSync(join(process.env.LOCALAPPDATA || process.env.XDG_RUNTIME_DIR, 'cdp'), { recursive: true });
    const text = await T.scanshotStr(cdp, 'sid', 'ISSUE486SCANSHOT');
    for (const file of text.match(/\S+scanshot-ISSUE486-\d+\.png/g) || []) rmSync(file, { force: true });
    // step = 600 - 10% overlap = 540 → segments 0, 540, 1080; the last one is 420px (>30% of vh) so it stays.
    expect(capturedAt).toEqual([0, 540, 900]);
    expect(text).toMatch(/Captured 3 segment\(s\) of 800x600 viewport \(page height: 1500px\)/);
    expect(page.state.scrollY).toBe(250);
    expect(page.state.calls.length).toBeGreaterThan(0);
    expect(page.state.calls.every(call => call.behavior === 'instant')).toBe(true);
  });

  it('the isolated table collector scrolls and restores its container with an instant Element.scrollTo', () => {
    class Node {
      get parentNode() { return this._parent ?? null; }
      get firstChild() { return null; }
      get nextSibling() { return null; }
      get nodeType() { return 1; }
      get nodeValue() { return null; }
    }
    const calls = [];
    class Element extends Node {
      get localName() { return 'div'; }
      getAttribute() { return null; }
      getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0 }; }
      scrollTo(...args) {
        const target = scrollTarget(args, { left: 0, top: this._top });
        calls.push({ args, behavior: target.behavior });
        if (target.behavior === 'instant') this._top = target.top;
      }
    }
    class Document extends Node {
      querySelector(sel) { return sel === '#vp' ? viewport : null; }
      querySelectorAll() { return []; }
    }
    const viewport = new Element();
    viewport._top = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      get() { return this._top; },
      set(value) { this._writes = [...(this._writes || []), value]; },
    });
    Object.defineProperty(viewport, 'scrollHeight', { get: () => 4000 });
    Object.defineProperty(viewport, 'clientHeight', { get: () => 400 });
    const context = {
      Object, Array, String, Number, JSON, WeakMap, Reflect,
      Node, Element, Document,
      document: new Document(),
      Event: function Event(type) { this.type = type; },
    };
    context.globalThis = context;
    runInNewContext(T.buildTableCollectorBootstrapExpression(), context);
    const moved = JSON.parse(runInNewContext('__chromeCdpExTableCollector.scrollTo("#vp", 400)', context));
    expect(moved.scroll.top).toBe(400);
    runInNewContext('__chromeCdpExTableCollector.restore()', context);
    expect(viewport._top).toBe(0);
    expect(viewport._writes).toBeUndefined();
    expect(calls.map(call => call.args)).toEqual([
      [{ top: 400, behavior: 'instant' }],
      [{ top: 0, behavior: 'instant' }],
    ]);
  });

  it('exports Playwright edge scrolls with instant behavior so replay matches the recorded scroll', () => {
    const documentLine = T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'bottom'],
      replayable: true,
    }).lines[0];
    const containerLine = T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'top', '--scroll-container', '#content'],
      replayable: true,
    }).lines[0];
    expect(documentLine).toContain("window.scrollTo({ left: 0, top: docMax, behavior: 'instant' })");
    expect(documentLine).toContain("best.scrollTo({ top: Math.max(0, (best.scrollHeight || 0) - (best.clientHeight || 0)), behavior: 'instant' })");
    expect(containerLine).toBe("await page.locator(\"#content\").evaluate((el) => { el.scrollTo({ top: 0, behavior: 'instant' }); });");
  });

  it('cdp.mjs has no automation scroll left that follows the page scroll-behavior', () => {
    // Positional window.scrollTo(x, y)/scrollBy(x, y) and raw scrollTop/scrollLeft writes use
    // behavior "auto", which honors CSS `scroll-behavior: smooth`.
    // (`__chromeCdpExTableCollector.scrollTo(${...})` is the collector's own RPC, not a DOM scroll.)
    expect(CDP_SOURCE.match(/\.(?:scrollTo|scrollBy)\((?!\s*\{)(?!\$\{JSON)[^)]*\)/g) || []).toEqual([]);
    expect(CDP_SOURCE.match(/\.scroll(?:Top|Left)\s*=(?!=)/g) || []).toEqual([]);
    const objectScrolls = CDP_SOURCE.match(/\.(?:scrollTo|scrollBy)\(\{[^}]*\}\)/g) || [];
    expect(objectScrolls.length).toBeGreaterThan(0);
    for (const call of objectScrolls) expect(call).toContain("behavior: 'instant'");
  });
});
