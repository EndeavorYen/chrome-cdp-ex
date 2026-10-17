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
    // cssText assignment canonicalizes; setAttribute keeps the exact string.
    cssText: styleText == null ? '' : String(styleText),
    cssCleared: false,
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
        state.attrs[`prop:${name}`] = String(value);
        state.cssCleared = false;
        const piece = `${name}: ${value}`;
        state.cssText = state.cssText ? `${state.cssText}; ${piece}` : piece;
        state.attrs.style = state.cssText;
        // Expanding overflow:auto to visible drops the scroll offset, as Chrome does.
        if ((name === 'overflow' || name === 'overflow-y') && value === 'visible') state.scrollTop = 0;
      },
      get cssText() { return state.cssText; },
      set cssText(value) {
        const raw = String(value);
        if (raw === '') {
          state.cssText = '';
          state.cssCleared = true;
          if (Object.hasOwn(state.attrs, 'style')) state.attrs.style = '';
          return;
        }
        state.cssCleared = false;
        state.cssText = raw.endsWith(';') ? raw : `${raw};`;
        state.attrs.style = state.cssText;
      },
    },
    hasAttribute(name) { return Object.hasOwn(state.attrs, name); },
    getAttribute(name) { return Object.hasOwn(state.attrs, name) ? state.attrs[name] : null; },
    setAttribute(name, value) {
      state.attrs[name] = String(value);
      if (name === 'style') {
        state.cssText = String(value);
        state.cssCleared = false;
      }
    },
    removeAttribute(name) {
      // Chrome keeps style="" when the CSSOM was mutated and cssText was not cleared first.
      if (name === 'style' && !state.cssCleared && Object.hasOwn(state.attrs, 'style')) {
        state.attrs.style = '';
        return;
      }
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
    querySelector(sel) {
      if (sel === 'div[') throw new Error('invalid selector');
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
  };
  return { window, document, docEl, body };
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
      const context = {
        window: page.window,
        document: page.document,
        Element: FakeElement,
        Math,
        JSON,
        Number,
        String,
        Event: function Event(type) { this.type = type; },
      };
      let expanded = false;
      const cdp = {
        calls: [],
        send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('contentType')) {
              return Promise.resolve({ result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } });
            }
            if (expr.includes('devicePixelRatio')) return Promise.resolve({ result: { value: 1 } });
            if (expr.includes('innerWidth')) {
              return Promise.resolve({ result: { value: JSON.stringify({ w: 1440, h: 900 }) } });
            }
            if (expr.includes('chrome-cdp-ex.fullshot')) {
              const value = runInNewContext(expr, context);
              if (value === 'restored') expanded = false;
              else if (JSON.parse(value).mode === 'container') expanded = true;
              return Promise.resolve({ result: { value } });
            }
            return Promise.resolve({ result: { value: 1 } });
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
  // then reserves a 15px scrollbar. Layout width is the viewport only while
  // scrollbars are hidden. Style reads happen before fullshot, not from an observer.
  it('hides scrollbars during capture so the image width matches the viewport, then shows them again', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-fullshot-scroll-'));
    const file = join(tmp, 'full.png');
    try {
      const run = async (failCapture = false) => {
        const scroller = makeBox({
          tagName: 'DIV',
          id: 'scroller',
          scrollHeight: 4000,
          clientHeight: 800,
          clientWidth: 1440,
          scrollTop: 120,
          overflowY: 'auto',
        });
        const page = scrollPage({ containers: [scroller] });
        const context = {
          window: page.window,
          document: page.document,
          Element: FakeElement,
          Math,
          JSON,
          Number,
          String,
          Event: function Event(type) { this.type = type; },
        };
        let expanded = false;
        let scrollbarsHidden = false;
        const calls = [];
        const cdp = {
          calls,
          send(method, params = {}) {
            calls.push({ method, params });
            if (method === 'Emulation.setScrollbarsHidden') {
              scrollbarsHidden = params.hidden === true;
              return Promise.resolve({});
            }
            if (method === 'Runtime.evaluate') {
              const expr = String(params.expression || '');
              if (expr.includes('contentType')) {
                return Promise.resolve({ result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } });
              }
              if (expr.includes('devicePixelRatio')) return Promise.resolve({ result: { value: 1 } });
              if (expr.includes('innerWidth')) {
                return Promise.resolve({ result: { value: JSON.stringify({ w: 1440, h: 900 }) } });
              }
              if (expr.includes('chrome-cdp-ex.fullshot')) {
                const value = runInNewContext(expr, context);
                if (value === 'restored') expanded = false;
                else if (JSON.parse(value).mode === 'container') expanded = true;
                return Promise.resolve({ result: { value } });
              }
              return Promise.resolve({ result: { value: 1 } });
            }
            if (method === 'Page.getLayoutMetrics') {
              const width = expanded && !scrollbarsHidden ? 1425 : 1440;
              return Promise.resolve({ cssContentSize: { width, height: expanded ? 4000 : 900 } });
            }
            if (method === 'Page.captureScreenshot') {
              if (failCapture) throw new Error('Timeout: Page.captureScreenshot');
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
        return { cdp, page, scroller, result: T.fullshotStr(cdp, 'sid', file, '1D3669785EAC5A1A211792636BAE8A07') };
      };

      const ok = await run(false);
      const out = await ok.result;
      const hideAt = ok.cdp.calls.findIndex(call => call.method === 'Emulation.setScrollbarsHidden' && call.params.hidden === true);
      const metricsAt = ok.cdp.calls.findIndex(call => call.method === 'Page.getLayoutMetrics');
      const shotAt = ok.cdp.calls.findIndex(call => call.method === 'Page.captureScreenshot');
      const showAt = ok.cdp.calls.findIndex(call => call.method === 'Emulation.setScrollbarsHidden' && call.params.hidden === false);
      expect(hideAt).toBeGreaterThanOrEqual(0);
      expect(hideAt).toBeLessThan(metricsAt);
      expect(metricsAt).toBeLessThan(shotAt);
      expect(shotAt).toBeLessThan(showAt);
      expect(ok.cdp.calls.filter(call => call.method === 'Emulation.setScrollbarsHidden').map(call => call.params)).toEqual([
        { hidden: true },
        { hidden: false },
      ]);
      const capture = ok.cdp.calls.find(call => call.method === 'Page.captureScreenshot');
      expect(capture.params.clip).toMatchObject({ width: 1440, height: 4000 });
      expect(out).toContain('1440×4000');

      const failed = await run(true);
      await expect(failed.result).rejects.toThrow(/timed out|untrusted/);
      expect(failed.cdp.calls.filter(call => call.method === 'Emulation.setScrollbarsHidden').map(call => call.params)).toEqual([
        { hidden: true },
        { hidden: false },
      ]);
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
      const context = {
        window: page.window,
        document: page.document,
        Element: FakeElement,
        Math,
        JSON,
        Number,
        String,
        Event: function Event(type) { this.type = type; },
      };
      let expanded = false;
      const cdp = {
        calls: [],
        send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('contentType')) {
              return Promise.resolve({ result: { value: JSON.stringify({ title: 'app', url: 'https://app.example/', contentType: 'text/html' }) } });
            }
            if (expr.includes('devicePixelRatio')) return Promise.resolve({ result: { value: 1 } });
            if (expr.includes('innerWidth')) {
              return Promise.resolve({ result: { value: JSON.stringify({ w: 1440, h: 900 }) } });
            }
            if (expr.includes('chrome-cdp-ex.fullshot')) {
              const value = runInNewContext(expr, context);
              if (value === 'restored') expanded = false;
              else if (JSON.parse(value).mode === 'container') expanded = true;
              return Promise.resolve({ result: { value } });
            }
            return Promise.resolve({ result: { value: 1 } });
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
      expect(page.docEl.getAttribute('style')).toBe(null);
      expect(page.body.getAttribute('style')).toBe(null);
      expect(scroller.getAttribute('style')).toBe(null);
      expect(shell.getAttribute('style')).toBe('color: red');
      expect(scroller.scrollTop).toBe(80);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
