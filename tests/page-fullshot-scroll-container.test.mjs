import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #746: fullshot sized itself from the document. A fixed shell whose content
// scrolls inside overflow:auto came back as one viewport.

function makeBox({
  tagName = 'DIV',
  id = '',
  className = '',
  parent = null,
  scrollHeight = 100,
  clientHeight = 100,
  clientWidth = 100,
  scrollTop = 0,
  overflowY = 'visible',
  styleText = null,
} = {}) {
  const state = {
    scrollTop,
    scrollLeft: 0,
    attrs: {},
    calls: [],
    // Chrome writes style="" back on removeAttribute unless getAttribute('style')
    // ran immediately before it. A cssText clear does not count as that read.
    lastStyleOp: null,
    // cssText assignment canonicalizes; setAttribute keeps the exact string.
    cssText: styleText == null ? '' : String(styleText),
  };
  if (styleText != null) state.attrs.style = String(styleText);
  const el = {
    tagName,
    id,
    className,
    classList: className ? className.split(/\s+/).filter(Boolean) : [],
    parentElement: parent,
    scrollHeight,
    clientHeight,
    scrollWidth: clientWidth,
    clientWidth,
    _state: { overflowY, overflowX: 'visible', overflow: overflowY },
    get scrollTop() { return state.scrollTop; },
    set scrollTop(value) { state.scrollTop = Number(value) || 0; },
    get scrollLeft() { return state.scrollLeft; },
    set scrollLeft(value) { state.scrollLeft = Number(value) || 0; },
    style: {
      setProperty(name, value) {
        state.calls.push(['setProperty', name]);
        state.lastStyleOp = 'write';
        state.attrs[`prop:${name}`] = String(value);
        const piece = `${name}: ${value}`;
        state.cssText = state.cssText ? `${state.cssText}; ${piece}` : piece;
        state.attrs.style = state.cssText;
        // Expanding overflow:auto to visible drops the scroll offset, as Chrome does.
        if ((name === 'overflow' || name === 'overflow-y') && value === 'visible') state.scrollTop = 0;
      },
      get cssText() { return state.cssText; },
      set cssText(value) {
        state.calls.push(['cssText', 'style']);
        state.lastStyleOp = 'write';
        const raw = String(value);
        if (raw === '') {
          state.cssText = '';
          if (Object.hasOwn(state.attrs, 'style')) state.attrs.style = '';
          return;
        }
        state.cssText = raw.endsWith(';') ? raw : `${raw};`;
        state.attrs.style = state.cssText;
      },
    },
    hasAttribute(name) { return Object.hasOwn(state.attrs, name); },
    getAttribute(name) {
      state.calls.push(['getAttribute', name]);
      if (name === 'style') state.lastStyleOp = 'get';
      return Object.hasOwn(state.attrs, name) ? state.attrs[name] : null;
    },
    setAttribute(name, value) {
      state.calls.push(['setAttribute', name]);
      state.attrs[name] = String(value);
      if (name === 'style') {
        state.lastStyleOp = 'write';
        state.cssText = String(value);
      }
    },
    removeAttribute(name) {
      state.calls.push(['removeAttribute', name]);
      if (name === 'style' && Object.hasOwn(state.attrs, 'style') && state.lastStyleOp !== 'get') {
        state.attrs.style = '';
        state.lastStyleOp = 'remove';
        return;
      }
      if (name === 'style') state.lastStyleOp = 'remove';
      delete state.attrs[name];
    },
    _scroll: state,
  };
  return el;
}

function FakeElement() {}
FakeElement.prototype.scrollTo = function scrollTo(options = {}) {
  if (!options || options.behavior !== 'instant') return;
  if (options.top != null) this.scrollTop = options.top;
  if (options.left != null) this.scrollLeft = options.left;
};
FakeElement.prototype.scrollBy = function scrollBy() {};

function scrollPage({
  docScrollHeight = 900,
  docClientHeight = 900,
  containers = [],
  query = new Map(),
} = {}) {
  const docEl = makeBox({
    tagName: 'HTML',
    scrollHeight: docScrollHeight,
    clientHeight: docClientHeight,
    clientWidth: 1440,
  });
  const scrollbar = { styleNode: null, forced: false, applied: false };
  const head = {
    appendChild(node) {
      scrollbar.styleNode = node;
      scrollbar.applied = false;
      node.parentNode = head;
      return node;
    },
    removeChild(node) {
      if (scrollbar.styleNode === node) {
        scrollbar.styleNode = null;
        scrollbar.applied = false;
        scrollbar.forced = false;
      }
      node.parentNode = null;
      return node;
    },
  };
  Object.defineProperty(docEl, 'offsetWidth', {
    configurable: true,
    get() {
      scrollbar.forced = true;
      return 1440;
    },
  });
  const body = makeBox({
    tagName: 'BODY',
    parent: docEl,
    scrollHeight: docScrollHeight,
    clientHeight: docClientHeight,
    clientWidth: 1440,
  });
  for (const el of containers) {
    if (!el.parentElement) el.parentElement = body;
  }
  const document = {
    scrollingElement: docEl,
    documentElement: docEl,
    body,
    head,
    createElement(tag) {
      const node = {
        nodeName: String(tag || '').toUpperCase(),
        attrs: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) { this.attrs[name] = String(value); },
        getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
        remove() {
          if (this.parentNode && typeof this.parentNode.removeChild === 'function') this.parentNode.removeChild(this);
        },
      };
      return node;
    },
    querySelector(sel) {
      if (sel === 'style[data-cdp-fullshot]') return scrollbar.styleNode;
      if (sel === 'div[') throw new Error('invalid selector');
      const marker = /^\[data-cdp-fullshot-target="([^"]*)"\]$/.exec(String(sel || ''));
      if (marker) {
        for (const el of containers) {
          if (el.getAttribute('data-cdp-fullshot-target') === marker[1]) return el;
        }
        return null;
      }
      if (query.has(sel)) return query.get(sel);
      for (const el of containers) {
        const tag = String(el.tagName || '').toLowerCase();
        const cls = el.className ? String(el.className).split(/\s+/).filter(Boolean).join('.') : '';
        const built = cls ? `${tag}.${cls}` : (el.id ? `#${el.id}` : tag);
        if (sel === built || (el.id && sel === `#${el.id}`)) return el;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '*') return containers;
      if (sel === '[data-cdp-fullshot-target]') {
        return containers.filter(el => el.hasAttribute('data-cdp-fullshot-target'));
      }
      return [];
    },
  };
  const window = {
    innerWidth: 1440,
    innerHeight: docClientHeight,
    scrollX: 0,
    scrollY: 0,
    scrollTo(x, y) {
      window.scrollX = x;
      window.scrollY = y;
    },
    getComputedStyle(el) {
      return {
        overflowX: el?._state?.overflowX || 'visible',
        overflowY: el?._state?.overflowY || 'visible',
        overflow: el?._state?.overflow || 'visible',
        position: 'static',
      };
    },
    devicePixelRatio: 1,
    requestAnimationFrame(cb) {
      queueMicrotask(() => {
        if (scrollbar.styleNode && scrollbar.forced) scrollbar.applied = true;
        cb();
      });
      return 1;
    },
  };
  return { window, document, docEl, body, scrollbar };
}

function pageContext(page) {
  return {
    window: page.window,
    document: page.document,
    Element: FakeElement,
    Math,
    JSON,
    Number,
    String,
    Promise,
    requestAnimationFrame: page.window.requestAnimationFrame,
    Event: function Event(type) { this.type = type; },
  };
}

// awaitPromise mirrors Runtime.evaluate: a returned promise settles only when
// the call asks to wait, which is what lets one frame land before measuring.
async function runPageExpression(expr, context, awaitPromise = true) {
  const value = runInNewContext(expr, context);
  if (value && typeof value.then === 'function') {
    if (awaitPromise !== true) return undefined;
    return await value;
  }
  return value;
}

function assertStyleRemovedAfterRead(el) {
  const calls = el._scroll.calls;
  let removeAt = -1;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i][0] === 'removeAttribute' && calls[i][1] === 'style') {
      removeAt = i;
      break;
    }
  }
  expect(removeAt).toBeGreaterThan(0);
  expect(calls[removeAt - 1]).toEqual(['getAttribute', 'style']);
  expect(el.hasAttribute('style')).toBe(false);
}

function runPlan(page, selector = null) {
  const expression = T.fullshotScrollPlanExpression({ selector });
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
  return JSON.parse(value);
}

const DOCUMENT_RECEIPT = [
  '/tmp/full.png',
  'Full-page screenshot saved. Size: 1042x632 CSS px, DPR: 2',
  "Note: large pages produce tiny text. Use 'scanshot' for readable segmented capture.",
].join('\n');

describe('#746 fullshot scroll container', () => {
  it('parses a file, --scroll-container, and --format without treating flags as paths', () => {
    expect(T.parseFullshotArgs([])).toEqual({ filePath: null, scrollContainer: null, format: 'text' });
    expect(T.parseFullshotArgs(['shots/full.png'])).toEqual({
      filePath: 'shots/full.png',
      scrollContainer: null,
      format: 'text',
    });
    expect(T.parseFullshotArgs(['out.png', '--scroll-container', 'main.ant-layout-content'])).toEqual({
      filePath: 'out.png',
      scrollContainer: 'main.ant-layout-content',
      format: 'text',
    });
    expect(T.parseFullshotArgs(['--format', 'json', '--scroll-container', '@3', 'shots/full.png'])).toEqual({
      filePath: 'shots/full.png',
      scrollContainer: '@3',
      format: 'json',
    });
    expect(() => T.parseFullshotArgs(['--scroll-container'])).toThrow(/--scroll-container requires/);
    expect(() => T.parseFullshotArgs(['--scroll-container', '--format'])).toThrow(/--scroll-container requires/);
    expect(() => T.parseFullshotArgs(['--scroll-container', 'main', '--scroll-container', '#other'])).toThrow(/duplicate --scroll-container/);
    expect(() => T.parseFullshotArgs(['--nope'])).toThrow(/unknown argument/);
  });

  it('caps container height with the same ceiling as a document fullshot', () => {
    const max = T.FULLSHOT_MAX_CAPTURE_HEIGHT;
    expect(max).toBeGreaterThan(1000);
    expect(T.capFullshotHeight(4210)).toEqual({ height: 4210, capped: false, max, content: 4210 });
    expect(T.capFullshotHeight(max)).toEqual({ height: max, capped: false, max, content: max });
    expect(T.capFullshotHeight(max + 500)).toEqual({ height: max, capped: true, max, content: max + 500 });
  });

  it('names a scrolled container in the receipt and leaves the document receipt unchanged', () => {
    expect(T.formatFullshotReceipt({
      path: '/tmp/full.png',
      width: 1042,
      height: 632,
      dpr: 2,
    })).toBe(DOCUMENT_RECEIPT);

    const container = T.formatFullshotReceipt({
      path: '/tmp/full.png',
      width: 1440,
      height: 4210,
      dpr: 1,
      container: 'main.ant-layout-content',
    });
    expect(container).toContain('Saved full-page screenshot /tmp/full.png (scrolled container main.ant-layout-content, 1440×4210)');
    expect(container.startsWith('/tmp/full.png\n')).toBe(true);

    const capped = T.formatFullshotReceipt({
      path: '/tmp/full.png',
      width: 1440,
      height: T.FULLSHOT_MAX_CAPTURE_HEIGHT,
      dpr: 1,
      container: 'main.ant-layout-content',
      capped: T.capFullshotHeight(T.FULLSHOT_MAX_CAPTURE_HEIGHT + 500),
    });
    expect(capped).toContain(`Height capped at ${T.FULLSHOT_MAX_CAPTURE_HEIGHT} CSS px`);
    expect(capped).toContain(String(T.FULLSHOT_MAX_CAPTURE_HEIGHT + 500));

    const json = JSON.parse(T.formatFullshotOutput({
      path: '/tmp/full.png',
      width: 1440,
      height: 4210,
      dpr: 1,
      container: 'main.ant-layout-content',
    }, 'json'));
    expect(json.scrollContainer).toBe('main.ant-layout-content');
    expect(json.width).toBe(1440);
    expect(json.height).toBe(4210);

    const documentJson = JSON.parse(T.formatFullshotOutput({
      path: '/tmp/full.png',
      width: 1042,
      height: 632,
      dpr: 2,
    }, 'json'));
    expect(documentJson).not.toHaveProperty('scrollContainer');
    expect(T.formatFullshotOutput({
      path: '/tmp/full.png',
      width: 1042,
      height: 632,
      dpr: 2,
    }, 'text')).toBe(DOCUMENT_RECEIPT);
  });

  it('picks the largest scrolling element only when the document itself does not scroll', () => {
    const sidebar = makeBox({
      id: 'sidebar',
      tagName: 'ASIDE',
      scrollHeight: 3000,
      clientHeight: 400,
      clientWidth: 200,
      overflowY: 'auto',
    });
    const main = makeBox({
      tagName: 'MAIN',
      className: 'ant-layout-content',
      scrollHeight: 4210,
      clientHeight: 800,
      clientWidth: 1200,
      scrollTop: 250,
      overflowY: 'auto',
    });
    const hidden = makeBox({
      id: 'shell',
      tagName: 'DIV',
      scrollHeight: 50000,
      clientHeight: 900,
      clientWidth: 1440,
      overflowY: 'hidden',
    });
    const fixed = scrollPage({ containers: [hidden, sidebar, main] });
    const picked = runPlan(fixed);
    expect(picked).toMatchObject({ ok: true, mode: 'container', how: 'auto', label: 'main.ant-layout-content' });
    expect(main.scrollTop).toBe(0);

    const scrollingDoc = scrollPage({
      docScrollHeight: 5000,
      docClientHeight: 900,
      containers: [main],
    });
    const fresh = makeBox({
      tagName: 'MAIN',
      className: 'ant-layout-content',
      scrollHeight: 4210,
      clientHeight: 800,
      clientWidth: 1200,
      scrollTop: 40,
      overflowY: 'auto',
    });
    scrollingDoc.document.querySelectorAll = () => [fresh];
    expect(runPlan(scrollingDoc)).toMatchObject({ ok: true, mode: 'document' });
    expect(fresh.scrollTop).toBe(40);
    expect(fresh._scroll.attrs['prop:overflow']).toBeUndefined();

    const barely = scrollPage({
      docScrollHeight: 901,
      docClientHeight: 900,
      containers: [main],
    });
    expect(runPlan(barely).mode).toBe('container');
    const justScrolls = scrollPage({
      docScrollHeight: 902,
      docClientHeight: 900,
      containers: [main],
    });
    expect(runPlan(justScrolls).mode).toBe('document');

    const none = scrollPage({ containers: [] });
    expect(runPlan(none)).toMatchObject({ ok: true, mode: 'document' });
  });

  it('reports a missing selector as selector and a box that does not scroll as usage', () => {
    const page = scrollPage({ containers: [] });
    const missing = runPlan(page, 'main.missing');
    expect(missing.ok).toBe(false);
    expect(missing.kind).toBe('selector');
    const missError = T.fullshotPlanError(missing);
    expect(missError.selectorMiss).toBe(true);
    const missRecovery = T.buildCliErrorRecovery(missError.message, {
      cmd: 'fullshot',
      targetPrefix: 'ABCD1234',
      err: missError,
    });
    expect(missRecovery.kind).toBe('selector');
    expect(missRecovery.run).toBe('cdp perceive ABCD1234 -C -d 8');

    const frozen = makeBox({
      tagName: 'DIV',
      id: 'static',
      scrollHeight: 400,
      clientHeight: 400,
      clientWidth: 800,
      overflowY: 'auto',
    });
    const stuck = scrollPage({
      containers: [frozen],
      query: new Map([['#static', frozen]]),
    });
    const idle = runPlan(stuck, '#static');
    expect(idle.ok).toBe(false);
    expect(idle.kind).toBe('usage');
    const idleError = T.fullshotPlanError(idle);
    expect(idleError.usage).toBe(true);
    const idleRecovery = T.buildCliErrorRecovery(idleError.message, {
      cmd: 'fullshot',
      targetPrefix: 'ABCD1234',
      err: idleError,
    });
    expect(idleRecovery.kind).toBe('usage');
    expect(idleRecovery.run).toBe('cdp fullshot ABCD1234');

    const scroller = makeBox({
      tagName: 'MAIN',
      className: 'ant-layout-content',
      scrollHeight: 4210,
      clientHeight: 800,
      clientWidth: 1200,
      scrollTop: 80,
      overflowY: 'auto',
    });
    const named = scrollPage({
      docScrollHeight: 5000,
      docClientHeight: 900,
      containers: [scroller],
      query: new Map([['main.ant-layout-content', scroller]]),
    });
    expect(runPlan(named, 'main.ant-layout-content')).toMatchObject({
      ok: true,
      mode: 'container',
      how: 'explicit',
      label: 'main.ant-layout-content',
    });
  });

  it('captures the inner container height and restores its scroll offset', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-fullshot-scroll-'));
    const file = join(tmp, 'full.png');
    try {
      const main = makeBox({
        tagName: 'MAIN',
        className: 'ant-layout-content',
        scrollHeight: 4000,
        clientHeight: 800,
        clientWidth: 1200,
        scrollTop: 250,
        overflowY: 'auto',
      });
      const page = scrollPage({ containers: [main] });
      const context = pageContext(page);
      let expanded = false;
      const cdp = {
        calls: [],
        async send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('contentType')) {
              return { result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } };
            }
            if (expr.includes('devicePixelRatio')) return { result: { value: 1 } };
            if (expr.includes('innerWidth')) {
              return { result: { value: JSON.stringify({ w: 1440, h: 900 }) } };
            }
            if (expr.includes('chrome-cdp-ex.fullshot')) {
              const value = await runPageExpression(expr, context, params.awaitPromise);
              if (value === 'restored') expanded = false;
              else if (typeof value === 'string' && value.startsWith('{') && JSON.parse(value).mode === 'container') expanded = true;
              return { result: { value } };
            }
            return { result: { value: 1 } };
          }
          if (method === 'Page.getLayoutMetrics') {
            return Promise.resolve({ cssContentSize: { width: 1440, height: expanded ? 4000 : 900 } });
          }
          if (method === 'Page.captureScreenshot') {
            return Promise.resolve({ data: Buffer.from('PNG746').toString('base64') });
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };

      T.resetScreenshotTier();
      const out = await T.fullshotStr(cdp, 'sid', file, '1D3669785EAC5A1A211792636BAE8A07');
      const capture = cdp.calls.find(call => call.method === 'Page.captureScreenshot');
      expect(capture.params.captureBeyondViewport).toBe(true);
      expect(capture.params.clip.height).toBe(4000);
      expect(capture.params.clip.width).toBe(1440);
      expect(main.scrollTop).toBe(250);
      expect(out).toContain('scrolled container main.ant-layout-content');
      expect(out).toContain('1440×4000');

      main.scrollTop = 250;
      expanded = false;
      T.resetScreenshotTier();
      const named = await T.fullshotStr(
        cdp,
        'sid',
        ['--scroll-container', 'main.ant-layout-content', file],
        '1D3669785EAC5A1A211792636BAE8A07',
      );
      expect(named).toContain('scrolled container main.ant-layout-content');
      expect(main.scrollTop).toBe(250);

      main.scrollTop = 250;
      expanded = false;
      const failing = {
        ...cdp,
        calls: [],
        send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Page.captureScreenshot') throw new Error('Timeout: Page.captureScreenshot');
          return cdp.send(method, params);
        },
      };
      T.resetScreenshotTier();
      await expect(T.fullshotStr(failing, 'sid', file, '1D3669785EAC5A1A211792636BAE8A07'))
        .rejects.toThrow(/timed out|untrusted/);
      expect(main.scrollTop).toBe(250);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('documents --scroll-container on help and the command surface', () => {
    expect(T.helpTopicStr('fullshot')).toContain('--scroll-container');
    expect(T.helpTopicStr('fullshot')).toMatch(/fixed|sticky/i);
  });

  // Expanding html/body to overflow:visible makes the document scroll, and Chrome
  // reserves a 15px scrollbar on the next layout. setScrollbarsHidden does not
  // change that width until a later layout, so the capture injects a temporary
  // stylesheet, reads offsetWidth, and waits one frame before measuring.
  // The sheet is removed when capture ends, including when capture fails.
  // Style reads happen before fullshot, not from an observer.
  it('hides scrollbars with a temporary stylesheet, waits one frame, then removes it', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-fullshot-scroll-'));
    const file = join(tmp, 'full.png');
    const scrollbarCss = 'html{scrollbar-width:none} ::-webkit-scrollbar{display:none}';
    try {
      const run = async (failCapture = false) => {
        const beforeWidth = 1425;
        const scroller = makeBox({
          tagName: 'DIV',
          id: 'scroller',
          scrollHeight: 4000,
          clientHeight: 800,
          clientWidth: beforeWidth,
          scrollTop: 120,
          overflowY: 'auto',
        });
        const page = scrollPage({ containers: [scroller] });
        Object.defineProperty(scroller, 'clientWidth', {
          configurable: true,
          get() { return page.scrollbar.applied ? 1440 : beforeWidth; },
        });
        const context = pageContext(page);
        let expanded = false;
        const seen = {};
        const calls = [];
        const cdp = {
          calls,
          async send(method, params = {}) {
            calls.push({ method, params });
            if (method === 'Runtime.evaluate') {
              const expr = String(params.expression || '');
              if (expr.includes('contentType')) {
                return { result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } };
              }
              if (expr.includes('devicePixelRatio')) return { result: { value: 1 } };
              if (expr.includes('innerWidth')) {
                return { result: { value: JSON.stringify({ w: 1440, h: 900 }) } };
              }
              if (expr.includes('chrome-cdp-ex.fullshot')) {
                const value = await runPageExpression(expr, context, params.awaitPromise);
                if (value === 'restored') expanded = false;
                else if (typeof value === 'string' && value.startsWith('{') && JSON.parse(value).mode === 'container') expanded = true;
                return { result: { value } };
              }
              return { result: { value: 1 } };
            }
            if (method === 'Page.getLayoutMetrics') {
              const style = page.document.querySelector('style[data-cdp-fullshot]');
              const width = page.scrollbar.applied ? 1440 : 1425;
              seen.measured = {
                width,
                clientWidth: scroller.clientWidth,
                forced: page.scrollbar.forced,
                styleText: style ? style.textContent : null,
                styleAttr: style ? style.getAttribute('data-cdp-fullshot') : undefined,
              };
              return { cssContentSize: { width, height: expanded ? 4000 : 900 } };
            }
            if (method === 'Page.captureScreenshot') {
              if (failCapture) throw new Error('Timeout: Page.captureScreenshot');
              return { data: Buffer.from('PNG746').toString('base64') };
            }
            return {};
          },
          onEvent() { return () => {}; },
          waitForEvent() {
            return { promise: Promise.reject(new Error('timeout')), cancel() {} };
          },
        };
        T.resetScreenshotTier();
        return { cdp, page, scroller, beforeWidth, seen, result: T.fullshotStr(cdp, 'sid', file, '1D3669785EAC5A1A211792636BAE8A07') };
      };

      const ok = await run(false);
      expect(ok.scroller.clientWidth).toBe(ok.beforeWidth);
      const out = await ok.result;
      const frameAt = ok.cdp.calls.findIndex(call => call.method === 'Runtime.evaluate'
        && String(call.params.expression).includes('requestAnimationFrame')
        && String(call.params.expression).includes('data-cdp-fullshot'));
      const metricsAt = ok.cdp.calls.findIndex(call => call.method === 'Page.getLayoutMetrics');
      const shotAt = ok.cdp.calls.findIndex(call => call.method === 'Page.captureScreenshot');
      expect(ok.cdp.calls.some(call => call.method === 'Emulation.setScrollbarsHidden')).toBe(false);
      expect(frameAt).toBeGreaterThanOrEqual(0);
      expect(frameAt).toBeLessThan(metricsAt);
      expect(metricsAt).toBeLessThan(shotAt);
      expect(ok.cdp.calls[frameAt].params.awaitPromise).toBe(true);
      expect(ok.seen.measured).toMatchObject({
        width: 1440,
        clientWidth: 1440,
        forced: true,
        styleText: scrollbarCss,
        styleAttr: '',
      });
      const capture = ok.cdp.calls.find(call => call.method === 'Page.captureScreenshot');
      expect(capture.params.clip).toMatchObject({ width: 1440, height: 4000 });
      expect(out).toContain('1440×4000');
      expect(ok.page.document.querySelector('style[data-cdp-fullshot]')).toBe(null);
      expect(ok.scroller.clientWidth).toBe(ok.beforeWidth);

      const failed = await run(true);
      await expect(failed.result).rejects.toThrow(/timed out|untrusted/);
      expect(failed.cdp.calls.some(call => call.method === 'Emulation.setScrollbarsHidden')).toBe(false);
      expect(failed.seen.measured.styleText).toBe(scrollbarCss);
      expect(failed.page.document.querySelector('style[data-cdp-fullshot]')).toBe(null);
      expect(failed.scroller.clientWidth).toBe(failed.beforeWidth);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaves no style attribute when none existed and restores an exact style string', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-fullshot-style-'));
    const file = join(tmp, 'full.png');
    try {
      const shell = makeBox({
        tagName: 'DIV',
        id: 'shell',
        styleText: 'color: red',
        scrollHeight: 900,
        clientHeight: 900,
        clientWidth: 1440,
        overflowY: 'visible',
      });
      const scroller = makeBox({
        tagName: 'DIV',
        id: 'scroller',
        parent: shell,
        scrollHeight: 4000,
        clientHeight: 800,
        clientWidth: 1440,
        scrollTop: 80,
        overflowY: 'auto',
      });
      const page = scrollPage({ containers: [shell, scroller] });
      expect(page.docEl.getAttribute('style')).toBe(null);
      expect(page.body.getAttribute('style')).toBe(null);
      expect(scroller.getAttribute('style')).toBe(null);
      expect(shell.getAttribute('style')).toBe('color: red');
      const context = pageContext(page);
      let expanded = false;
      const cdp = {
        calls: [],
        async send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('contentType')) {
              return { result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } };
            }
            if (expr.includes('devicePixelRatio')) return { result: { value: 1 } };
            if (expr.includes('innerWidth')) {
              return { result: { value: JSON.stringify({ w: 1440, h: 900 }) } };
            }
            if (expr.includes('chrome-cdp-ex.fullshot')) {
              const value = await runPageExpression(expr, context, params.awaitPromise);
              if (value === 'restored') expanded = false;
              else if (typeof value === 'string' && value.startsWith('{') && JSON.parse(value).mode === 'container') expanded = true;
              return { result: { value } };
            }
            return { result: { value: 1 } };
          }
          if (method === 'Page.getLayoutMetrics') {
            return Promise.resolve({ cssContentSize: { width: 1440, height: expanded ? 4000 : 900 } });
          }
          if (method === 'Page.captureScreenshot') {
            return Promise.resolve({ data: Buffer.from('PNG746').toString('base64') });
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      T.resetScreenshotTier();
      await T.fullshotStr(cdp, 'sid', file, '1D3669785EAC5A1A211792636BAE8A07');
      assertStyleRemovedAfterRead(page.docEl);
      assertStyleRemovedAfterRead(page.body);
      assertStyleRemovedAfterRead(scroller);
      expect(shell.getAttribute('style')).toBe('color: red');
      expect(scroller.scrollTop).toBe(80);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The pin marker is only a lookup handle. The receipt and JSON name the
  // caller's @ref. A frame ref is refused before that attribute is written.
  it('names the caller @ref in the receipt and JSON, not the pin marker', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-fullshot-ref-'));
    const file = join(tmp, 'full.png');
    try {
      const scroller = makeBox({
        tagName: 'MAIN',
        className: 'ant-layout-content',
        scrollHeight: 4000,
        clientHeight: 800,
        clientWidth: 1200,
        scrollTop: 250,
        overflowY: 'auto',
      });
      const page = scrollPage({ containers: [scroller] });
      const context = pageContext(page);
      let expanded = false;
      const cdp = {
        calls: [],
        async send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
          if (method === 'DOM.resolveNode') return { object: { objectId: 'main-node' } };
          if (method === 'Runtime.callFunctionOn') {
            const decl = String(params.functionDeclaration || '');
            if (decl.includes('data-cdp-fullshot-target')) {
              scroller.setAttribute('data-cdp-fullshot-target', params.arguments?.[0]?.value);
              return { result: { value: true } };
            }
            return { result: { value: { connected: true } } };
          }
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('contentType')) {
              return { result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } };
            }
            if (expr.includes('devicePixelRatio')) return { result: { value: 1 } };
            if (expr.includes('innerWidth')) {
              return { result: { value: JSON.stringify({ w: 1440, h: 900 }) } };
            }
            if (expr.includes('chrome-cdp-ex.fullshot')) {
              const value = await runPageExpression(expr, context, params.awaitPromise);
              if (value === 'restored') expanded = false;
              else if (typeof value === 'string' && value.startsWith('{') && JSON.parse(value).mode === 'container') expanded = true;
              return { result: { value } };
            }
            return { result: { value: 1 } };
          }
          if (method === 'Page.getLayoutMetrics') {
            return { cssContentSize: { width: 1440, height: expanded ? 4000 : 900 } };
          }
          if (method === 'Page.captureScreenshot') {
            return { data: Buffer.from('PNG746').toString('base64') };
          }
          return {};
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      const refMap = new Map([[3, 303]]);
      T.resetScreenshotTier();
      const text = await T.fullshotStr(
        cdp,
        'sid',
        ['--scroll-container', '@3', file],
        '1D3669785EAC5A1A211792636BAE8A07',
        { refMap },
      );
      expect(text).toContain('scrolled container @3');
      expect(text).not.toContain('data-cdp-fullshot-target');
      expect(scroller.hasAttribute('data-cdp-fullshot-target')).toBe(false);
      expect(scroller.scrollTop).toBe(250);

      scroller.scrollTop = 250;
      expanded = false;
      T.resetScreenshotTier();
      const json = JSON.parse(await T.fullshotStr(
        cdp,
        'sid',
        ['--format', 'json', '--scroll-container', '@3', file],
        '1D3669785EAC5A1A211792636BAE8A07',
        { refMap },
      ));
      expect(json.scrollContainer).toBe('@3');
      expect(JSON.stringify(json)).not.toContain('data-cdp-fullshot-target');
      expect(scroller.hasAttribute('data-cdp-fullshot-target')).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a frame ref for --scroll-container before a marker is set', async () => {
    const calls = [];
    const page = scrollPage({ containers: [] });
    const context = pageContext(page);
    const cdp = {
      calls,
      async send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'frame-node' } };
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: { connected: true } } };
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('contentType')) {
            return { result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } };
          }
          if (expr.includes('chrome-cdp-ex.fullshot')) {
            const value = await runPageExpression(expr, context, params.awaitPromise);
            return { result: { value } };
          }
          return { result: { value: 1 } };
        }
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1440, height: 900 } };
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('PNG746').toString('base64') };
        return {};
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    const refState = {
      frameRefs: new Map([
        ['@f1', { frameId: 'child-frame', refs: new Map([[3, 303]]) }],
      ]),
    };
    const error = await T.fullshotStr(
      cdp,
      'sid',
      ['--scroll-container', '@f1:3'],
      '1D3669785EAC5A1A211792636BAE8A07',
      { refState },
    ).then(() => null, (err) => err);
    expect(error?.usage).toBe(true);
    expect(error.message).toMatch(/frame ref/i);
    expect(error.message).toMatch(/main document/i);
    expect(error.message).not.toContain('data-cdp-fullshot-target');
    expect(calls.some(call => String(call.params?.functionDeclaration || '').includes('data-cdp-fullshot-target'))).toBe(false);
    const recovery = T.buildCliErrorRecovery(error.message, {
      cmd: 'fullshot',
      targetPrefix: '1D366978',
      err: error,
    });
    expect(recovery.kind).toBe('usage');
    const formatted = T.formatCliError(error, { cmd: 'fullshot', targetPrefix: '1D366978' });
    const nexts = formatted.split('\n').filter(line => line.startsWith('Next:'));
    expect(nexts).toHaveLength(1);
    expect(nexts[0]).toBe(`Next: ${recovery.run}`);
  });
});
