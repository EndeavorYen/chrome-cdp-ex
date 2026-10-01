import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const SCRIPTS_DIR = fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/', import.meta.url));

// Every shipped runtime module: cdp.mjs, lib/*.mjs and the helper scripts next to it.
function shippedSources() {
  return readdirSync(SCRIPTS_DIR, { recursive: true })
    .map(String)
    .filter(file => file.endsWith('.mjs'))
    .map(file => ({ file, source: readFileSync(join(SCRIPTS_DIR, file), 'utf8') }));
}

// Node-side code that only looks like a page scroll; each entry is the whole source line, trimmed.
const NODE_SIDE_LINES = new Set([
  'scroll: applicationPreflight.handlerBuilders.scroll(actionCapabilities),', // daemon handler registry
  'if (scrollY != null) model.scrollY = scrollY;', // cards model field, lib/cards-model.mjs
]);

function lineAt(source, index) {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

// Text of a call's argument list, from the "(" at openIndex to its matching ")".
function callArguments(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

function scrollTarget(args, current) {
  const first = args[0];
  // Like the browser's overload resolution: two arguments always mean (x, y), even (object, undefined).
  if (args.length < 2 && first && typeof first === 'object') {
    return {
      left: first.left === undefined ? current.left : Number(first.left),
      top: first.top === undefined ? current.top : Number(first.top),
      behavior: first.behavior,
    };
  }
  // Positional (x, y): what a fixed-signature wrapper hands on. An options object becomes NaN → 0.
  return { left: Number(args[0]) || 0, top: Number(args[1]) || 0, behavior: undefined };
}

// The page's native Element: Element.prototype.scrollTo/scrollBy run the fake node's `_native*`
// implementation, so a test can replace the page-visible window methods independently of it.
function FakeElement() {}
FakeElement.prototype.scrollTo = function (...args) { return this._nativeScrollTo(...args); };
FakeElement.prototype.scrollBy = function (...args) { return this._nativeScrollBy(...args); };

// A page with `html { scroll-behavior: smooth }`: any scroll that does not pass
// `behavior: 'instant'` starts an animation, so the position read in the same task is still the
// starting one. Only an instant scroll lands synchronously. With `stuck`, the page snaps every
// scroll back (a scroll listener resetting the position), so nothing ever lands.
function createSmoothDocumentPage({ scrollY = 0, innerHeight = 600, scrollHeight = 3000, stuck = false } = {}) {
  const state = { scrollX: 0, scrollY, innerHeight, scrollHeight, calls: [], windowCalls: [] };
  const max = () => Math.max(0, state.scrollHeight - state.innerHeight);
  const land = (top, left) => {
    if (stuck) return;
    if (left !== undefined) state.scrollX = Math.max(0, Math.round(left));
    state.scrollY = Math.max(0, Math.min(max(), Math.round(top)));
  };
  const nativeScroll = (method, args) => {
    const current = method === 'scrollBy' ? { left: 0, top: 0 } : { left: state.scrollX, top: state.scrollY };
    const target = scrollTarget(args, current);
    state.calls.push({ method, args, behavior: target.behavior });
    if (target.behavior !== 'instant') return;
    if (method === 'scrollBy') land(state.scrollY + target.top, state.scrollX + target.left);
    else land(target.top, target.left);
  };
  const scroller = {
    get scrollHeight() { return state.scrollHeight; },
    _nativeScrollTo: (...args) => nativeScroll('scrollTo', args),
    _nativeScrollBy: (...args) => nativeScroll('scrollBy', args),
  };
  const windowObj = {
    get innerWidth() { return 800; },
    get innerHeight() { return state.innerHeight; },
    get scrollX() { return state.scrollX; },
    get scrollY() { return state.scrollY; },
    scrollTo(...args) { state.windowCalls.push({ method: 'scrollTo', args }); nativeScroll('scrollTo', args); },
    scrollBy(...args) { state.windowCalls.push({ method: 'scrollBy', args }); nativeScroll('scrollBy', args); },
    getComputedStyle: el => ({ overflowY: el?._overflowY || 'visible', overflow: el?._overflowY || 'visible' }),
  };
  const documentObj = {
    scrollingElement: scroller,
    documentElement: scroller,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return { state, window: windowObj, document: documentObj };
}

// The finding-1 page: window.scrollTo/scrollBy wrapped with a fixed (x, y) signature, e.g.
// `const o = window.scrollBy; window.scrollBy = function (x, y) { return o.call(window, x, y); }`.
// Calling them with an options object scrolls to (0, 0).
function wrapWindowScrollWithFixedSignature(page) {
  const { state } = page;
  const originalTo = page.window.scrollTo;
  const originalBy = page.window.scrollBy;
  page.window.scrollTo = function (x, y) { state.windowCalls.push({ method: 'wrapped scrollTo', args: [x, y] }); return originalTo.call(this, x, y); };
  page.window.scrollBy = function (x, y) { state.windowCalls.push({ method: 'wrapped scrollBy', args: [x, y] }); return originalBy.call(this, x, y); };
  return page;
}

function createSmoothOverflowElement({ id, scrollHeight = 2000, clientHeight = 400 } = {}) {
  const state = { scrollTop: 0, writes: [], calls: [], ownCalls: [] };
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
    // A page-level override on the instance; automation must not depend on it.
    scrollTo(...args) { state.ownCalls.push(args); },
    _nativeScrollTo(...args) {
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
        Element: FakeElement,
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

async function runScanshot(page) {
  const capturedAt = [];
  const cdp = pageCdp(page, { onCapture: () => capturedAt.push(page.state.scrollY) });
  // vitest.config points LOCALAPPDATA / XDG_RUNTIME_DIR at a throwaway dir; scanshot writes into <it>/cdp.
  mkdirSync(join(process.env.LOCALAPPDATA || process.env.XDG_RUNTIME_DIR, 'cdp'), { recursive: true });
  const text = await T.scanshotStr(cdp, 'sid', 'ISSUE486SCANSHOT');
  for (const file of text.match(/\S+scanshot-ISSUE486-\d+\.png/g) || []) rmSync(file, { force: true });
  return { text, capturedAt };
}

describe('issue #486 automation scrolls are instant on smooth-scrolling pages', () => {
  it('scroll down reports the final Position, not the smooth-scroll starting point', async () => {
    const page = createSmoothDocumentPage({ scrollY: 0 });
    const text = await T.scrollStr(pageCdp(page), 'sid', 'down', '80');
    expect(text).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(page.state.calls).toEqual([
      { method: 'scrollBy', args: [{ left: 0, top: 80, behavior: 'instant' }], behavior: 'instant' },
    ]);
    expect(page.state.windowCalls).toEqual([]);
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
    expect(page.state.windowCalls).toEqual([]);
  });

  it('scroll to bottom of a smooth nested overflow container lands instantly through the native scrollTo', async () => {
    const page = createSmoothDocumentPage({ scrollY: 0, scrollHeight: 600 });
    const content = createSmoothOverflowElement({ id: 'content' });
    page.document.querySelector = sel => (sel === '#content' ? content : null);
    page.document.querySelectorAll = sel => (sel === '*' ? [content] : []);
    const cdp = pageCdp(page);
    expect(await T.scrollStr(cdp, 'sid', 'to', 'bottom')).toBe('Scrolled to bottom. #content scrollTop: 1600 / 1600 max (at-bottom: yes)');
    expect(await T.scrollStr(cdp, 'sid', 'to', 'top', ['--scroll-container', '#content']))
      .toBe('Scrolled to top. #content scrollTop: 0 / 1600 max (at-top: yes)');
    expect(content._state.writes).toEqual([]);
    expect(content._state.ownCalls).toEqual([]);
    expect(content._state.calls).toEqual([
      { args: [{ top: 1600, behavior: 'instant' }], behavior: 'instant' },
      { args: [{ top: 0, behavior: 'instant' }], behavior: 'instant' },
    ]);
  });

  it('scanshot captures each segment at its own offset and restores the original position', async () => {
    const page = createSmoothDocumentPage({ scrollY: 250, innerHeight: 600, scrollHeight: 1500 });
    const { text, capturedAt } = await runScanshot(page);
    // step = 600 - 10% overlap = 540 → segments 0, 540, 1080; the last one is 420px (>30% of vh) so it stays.
    expect(capturedAt).toEqual([0, 540, 900]);
    expect(text).toMatch(/Captured 3 segment\(s\) of 800x600 viewport \(page height: 1500px\)/);
    expect(text).not.toMatch(/landed at|Warning/);
    expect(page.state.scrollY).toBe(250);
    expect(page.state.calls.length).toBe(4);
    expect(page.state.calls.every(call => call.behavior === 'instant')).toBe(true);
    expect(page.state.windowCalls).toEqual([]);
  });

  describe('a page that wraps window.scrollTo/scrollBy with a fixed (x, y) signature', () => {
    it('scroll down and scroll to bottom still land, because they never call the window methods', async () => {
      const page = wrapWindowScrollWithFixedSignature(createSmoothDocumentPage({ scrollY: 0 }));
      const cdp = pageCdp(page);
      expect(await T.scrollStr(cdp, 'sid', 'down', '500')).toBe('Scrolled by (0, 500). Position: (0, 500)');
      expect(await T.scrollStr(cdp, 'sid', 'to', 'bottom')).toBe('Scrolled to bottom. scrollY: 2400 / 2400 max (at-bottom: yes)');
      expect(page.state.windowCalls).toEqual([]);
    });

    it('scanshot still captures every segment at its own offset', async () => {
      const page = wrapWindowScrollWithFixedSignature(
        createSmoothDocumentPage({ scrollY: 250, innerHeight: 600, scrollHeight: 1500 }),
      );
      const { text, capturedAt } = await runScanshot(page);
      expect(capturedAt).toEqual([0, 540, 900]);
      expect(text).not.toMatch(/Warning/);
      expect(page.state.scrollY).toBe(250);
      expect(page.state.windowCalls).toEqual([]);
    });

    it('the wrapper really does break an options-object call (guards the fake itself)', () => {
      const page = wrapWindowScrollWithFixedSignature(createSmoothDocumentPage({ scrollY: 300 }));
      page.window.scrollBy({ left: 0, top: 500, behavior: 'instant' });
      expect(page.state.scrollY).toBe(300);
    });
  });

  it('scanshot flags segments that did not land instead of passing them off as the right slice', async () => {
    const page = createSmoothDocumentPage({ scrollY: 0, innerHeight: 600, scrollHeight: 1500, stuck: true });
    const { text, capturedAt } = await runScanshot(page);
    expect(capturedAt).toEqual([0, 0, 0]);
    const lines = text.split('\n');
    expect(lines[1]).toMatch(/\[1\/3\] \S+scanshot-ISSUE486-1\.png$/);
    expect(lines[2]).toMatch(/\[2\/3\] \S+scanshot-ISSUE486-2\.png \(landed at y=0, expected y=540\)$/);
    expect(lines[3]).toMatch(/\[3\/3\] \S+scanshot-ISSUE486-3\.png \(landed at y=0, expected y=900\)$/);
    expect(text).toContain('Warning: 2 of 3 segment(s) did not land on their scroll offset (±2px)');
    expect(text).toContain('use fullshot for a single full-page capture');
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

  it('exports Playwright edge scrolls with the same native instant scroll so replay matches the recorded scroll', () => {
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
    expect(documentLine).toContain("Element.prototype.scrollTo.call(scrolling, { left: 0, top: docMax, behavior: 'instant' })");
    expect(documentLine).toContain("Element.prototype.scrollTo.call(best, { top: Math.max(0, (best.scrollHeight || 0) - (best.clientHeight || 0)), behavior: 'instant' })");
    expect(documentLine).not.toContain('window.scrollTo');
    expect(containerLine).toBe("await page.locator(\"#content\").evaluate((el) => { Element.prototype.scrollTo.call(el, { top: 0, behavior: 'instant' }); });");
  });

  describe('shipped scripts have no automation scroll that follows the page or its overrides', () => {
    const sources = shippedSources();

    it('scans cdp.mjs and lib/', () => {
      const files = sources.map(entry => entry.file.replaceAll('\\', '/'));
      expect(files).toContain('cdp.mjs');
      expect(files.filter(file => file.startsWith('lib/')).length).toBeGreaterThan(10);
      // The Node-side allowlist must not go stale.
      const allLines = new Set(sources.flatMap(({ source }) => source.split('\n').map(line => line.trim())));
      for (const line of NODE_SIDE_LINES) expect(allLines.has(line), line).toBe(true);
    });

    it('no direct .scroll()/.scrollTo()/.scrollBy() call (positional or page-overridable)', () => {
      const direct = [];
      for (const { file, source } of sources) {
        for (const match of source.matchAll(/([\w$]*)\.(scroll|scrollTo|scrollBy)\s*\(/g)) {
          // The isolated table collector's own RPC method, not a DOM scroll.
          if (match[1] === '__chromeCdpExTableCollector') continue;
          if (NODE_SIDE_LINES.has(lineAt(source, match.index))) continue;
          direct.push(`${file}: ${source.slice(match.index, match.index + 80)}`);
        }
      }
      expect(direct).toEqual([]);
    });

    it('every native Element scroll call passes behavior: instant', () => {
      const nativeCalls = [];
      for (const { file, source } of sources) {
        const pattern = /\.(?:scroll|scrollTo|scrollBy)\.(?:call|apply)\s*\(|\bapply\(\s*elementScrollTo\s*,/g;
        for (const match of source.matchAll(pattern)) {
          const open = match.index + match[0].indexOf('(');
          nativeCalls.push({ file, args: callArguments(source, open) });
        }
      }
      expect(nativeCalls.length).toBeGreaterThan(5);
      for (const call of nativeCalls) expect(call.args, `${call.file}: ${call.args}`).toContain("behavior: 'instant'");
    });

    it('no scrollTop/scrollLeft/scrollX/scrollY property write, dotted or bracketed, plain or compound', () => {
      const writes = [];
      const pattern = /(?:\.scroll(?:Top|Left|X|Y)|\[\s*['"`]scroll(?:Top|Left|X|Y)['"`]\s*\])\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)/g;
      for (const { file, source } of sources) {
        for (const match of source.matchAll(pattern)) {
          if (NODE_SIDE_LINES.has(lineAt(source, match.index))) continue;
          writes.push(`${file}: ${lineAt(source, match.index)}`);
        }
      }
      expect(writes).toEqual([]);
    });

    it('the write and call patterns catch the forms they are meant to catch', () => {
      const writePattern = /(?:\.scroll(?:Top|Left|X|Y)|\[\s*['"`]scroll(?:Top|Left|X|Y)['"`]\s*\])\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)/;
      for (const bad of ['el.scrollTop = 0', 'el.scrollTop += 5', "el['scrollTop'] = 1", 'el["scrollLeft"] -= 2', 'el.scrollTop ||= 3']) {
        expect(writePattern.test(bad), bad).toBe(true);
      }
      for (const ok of ['el.scrollTop === 0', 'el.scrollTop <= max', 'const scrollTop = 1', 'el.scrollTop != 0']) {
        expect(writePattern.test(ok), ok).toBe(false);
      }
      const callPattern = /([\w$]*)\.(scroll|scrollTo|scrollBy)\s*\(/;
      for (const bad of ['window.scroll(0, 5)', 'window.scrollTo(0, 5)', 'el.scrollBy({ top: 1 })']) {
        expect(callPattern.test(bad), bad).toBe(true);
      }
      expect(callPattern.test('el.scrollIntoView({ block: "center" })')).toBe(false);
      expect(callPattern.test('Element.prototype.scrollTo.call(el, {})')).toBe(false);
    });
  });
});
