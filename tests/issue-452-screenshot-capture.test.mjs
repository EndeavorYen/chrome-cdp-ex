import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { screenshotHealthScript } = await import('../skills/chrome-cdp-ex/scripts/lib/screenshot-health.mjs');

const LIGHT = 'rgb(244, 244, 240)';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

function element(tagName, { backgroundColor = TRANSPARENT, backgroundImage = 'none', parent = null } = {}) {
  return { nodeType: 1, tagName, parentElement: parent, style: { backgroundColor, backgroundImage } };
}

// Paint stack at a point for a plain tree: the hit element, then its ancestors.
function ancestorStack(node) {
  const stack = [];
  for (let current = node; current; current = current.parentElement) stack.push(current);
  return stack;
}

// Runs the page-side sanity script against a fake page: `hit(x, y)` is the topmost element
// at a viewport point (its paint stack is it plus its ancestors unless `stack(x, y)` is
// given), and every captured pixel is near-black.
const savedGlobals = {};
function installFakePage({ hit, stack = null, body, root, width = 100, height = 100, scroll = { x: 0, y: 0 } }) {
  const globals = {
    innerWidth: width,
    innerHeight: height,
    scrollX: scroll.x,
    scrollY: scroll.y,
    getComputedStyle: node => node.style,
    Image: class {
      constructor() { this.naturalWidth = 64; this.naturalHeight = 64; }
      set src(_value) { queueMicrotask(() => this.onload?.()); }
    },
    document: {
      body,
      documentElement: root,
      elementFromPoint: hit,
      elementsFromPoint: (x, y) => (stack ? stack(x, y) : ancestorStack(hit(x, y))),
      createElement: () => ({
        getContext: () => ({
          drawImage() {},
          getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 4)) }),
        }),
      }),
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    savedGlobals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

afterEach(() => {
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
    delete savedGlobals[key];
  }
});

async function runSanity(options) {
  return JSON.parse(await (0, eval)(screenshotHealthScript('AAAA', options)));
}

describe('#452 screenshot sanity check judges only what the DOM predicts', () => {
  it('accepts a near-black frame when a WebGL canvas covers a light page', async () => {
    const root = element('HTML');
    const body = element('BODY', { backgroundColor: LIGHT, parent: root });
    const canvas = element('CANVAS', { parent: body });
    installFakePage({ body, root, hit: (_x, y) => (y < 10 ? body : canvas) });
    const sanity = await runSanity();
    expect(sanity.retry).toBe(false);
    expect(sanity.reason).toBe('frame-consistent');
    expect(sanity.mediaRatio).toBeGreaterThan(0.8);
  });

  it('still retries when light DOM was captured as black', async () => {
    const root = element('HTML');
    const body = element('BODY', { backgroundColor: LIGHT, parent: root });
    const panel = element('DIV', { parent: body });
    installFakePage({ body, root, hit: () => panel });
    const sanity = await runSanity();
    expect(sanity.retry).toBe(true);
    expect(sanity.reason).toBe('near-black-frame-on-light-page');
    expect(sanity.contradictionRatio).toBe(1);
  });

  it('does not predict background-image content', async () => {
    const root = element('HTML');
    const body = element('BODY', { backgroundColor: LIGHT, parent: root });
    const hero = element('DIV', { backgroundImage: 'url(hero.jpg)', parent: body });
    installFakePage({ body, root, hit: () => hero });
    expect((await runSanity()).retry).toBe(false);
  });

  it('maps an elshot clip (document coordinates) onto the clipped region only', async () => {
    const root = element('HTML');
    const body = element('BODY', { backgroundColor: LIGHT, parent: root });
    const canvas = element('CANVAS', { parent: body });
    // Canvas fills the left half of the viewport; the page is scrolled down by 1000 px.
    installFakePage({ body, root, hit: x => (x < 50 ? canvas : body), scroll: { x: 0, y: 1000 } });
    expect((await runSanity({ clip: { x: 0, y: 1000, width: 50, height: 100 } })).retry).toBe(false);
    expect((await runSanity({ clip: { x: 50, y: 1000, width: 50, height: 100 } })).retry).toBe(true);
    // A clip below the viewport cannot be hit-tested, so it is not judged at all.
    const offscreen = await runSanity({ clip: { x: 0, y: 3000, width: 100, height: 100 } });
    expect(offscreen.retry).toBe(false);
    expect(offscreen.sample.points).toBe(0);
  });

  it('looks through a transparent full-window UI layer to the canvas under it', async () => {
    const root = element('HTML');
    const body = element('BODY', { backgroundColor: LIGHT, parent: root });
    const canvas = element('CANVAS', { parent: body });
    const overlay = element('DIV', { parent: body }); // position:fixed; inset:0; transparent
    installFakePage({ body, root, hit: () => overlay, stack: () => [overlay, canvas, body, root] });
    const sanity = await runSanity();
    expect(sanity.retry).toBe(false);
    expect(sanity.mediaRatio).toBe(1);
  });

  it('descends into an open shadow root to find a canvas behind its host', async () => {
    const root = element('HTML');
    const body = element('BODY', { backgroundColor: LIGHT, parent: root });
    const host = element('GAME-VIEW', { parent: body });
    const canvas = element('CANVAS');
    host.shadowRoot = { elementsFromPoint: () => [canvas, host, body, root] };
    installFakePage({ body, root, hit: () => host, stack: () => [host, body, root] });
    expect((await runSanity()).retry).toBe(false);
  });
});

describe('#452 responsive-audit keeps the requested viewport label', () => {
  it('reports the layout viewport beside the requested size instead of replacing it', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: '3E1EF53C00000000000000000000000',
      viewports: [
        { viewport: '1440x900', layoutViewport: '1440x900', controlCount: 3 },
        { viewport: '390x844', layoutViewport: '980x2120', controlCount: 3 },
      ],
      page: { title: 'Rexiano', url: 'http://localhost:5173/#/library' },
    });
    expect(model.viewports.map(v => v.viewport)).toEqual(['1440x900', '390x844']);
    expect(model.viewports[1].layoutViewport).toBe('980x2120');
    const text = T.formatResponsiveAuditReport(model);
    expect(text).toContain('- 390x844: pass layout=980x2120 controls=3');
    expect(text).toContain('- 1440x900: pass controls=3');
  });
});

function captureCdp(handlers) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) return Promise.resolve({});
      try { return Promise.resolve(handler(params)); } catch (error) { return Promise.reject(error); }
    },
    onEvent() { return () => {}; },
    waitForEvent() {
      return { promise: Promise.reject(new Error('Timeout waiting for event: Page.screencastFrame')), cancel() {} };
    },
  };
}

const quietHooks = { inspectFrame: async () => ({ retry: false, reason: 'frame-consistent' }) };

describe('#452 review: capture tiers', () => {
  it('a clipped capture never falls back to a whole-viewport screencast frame', async () => {
    const cdp = captureCdp({ 'Page.captureScreenshot': () => { throw new Error('Unable to capture screenshot'); } });
    const clip = { x: 0, y: 900, width: 10, height: 10, scale: 1 };
    const error = await T.captureScreenshot(cdp, 'sid', { format: 'png', clip }, quietHooks).catch(e => e);
    expect(error.code).toBe('screenshot_capture_failed');
    expect(error.screenshotAttempts.map(a => a.tier)).toEqual([1, 2]);
    expect(cdp.calls.some(call => call.method === 'Page.startScreencast')).toBe(false);
  });

  it('a protocol error in the screencast tier is rethrown as-is, not as a capture verdict', async () => {
    const cdp = captureCdp({ 'Page.captureScreenshot': () => { throw new Error('Unable to capture screenshot'); } });
    cdp.waitForEvent = () => ({ promise: Promise.reject(new Error('Target closed')), cancel() {} });
    const error = await T.captureScreenshot(cdp, 'sid', { format: 'png' }, quietHooks).catch(e => e);
    expect(error.message).toBe('Target closed');
    expect(T.formatCliError(error, { cmd: 'shot', targetPrefix: 'ABCD1234' })).not.toContain('Kind: screenshot-capture');
  });

  it('a screencast timeout is skipped for the rest of the command', async () => {
    const cdp = captureCdp({ 'Page.captureScreenshot': () => { throw new Error('Timeout: Page.captureScreenshot'); } });
    const tierState = T.createScreenshotTierState();
    await T.captureScreenshot(cdp, 'sid', { format: 'png' }, { ...quietHooks, tierState }).catch(() => {});
    expect(tierState.tier).toBe(4);
    const calls = cdp.calls.length;
    const error = await T.captureScreenshot(cdp, 'sid', { format: 'png' }, { ...quietHooks, tierState }).catch(e => e);
    expect(cdp.calls.length).toBe(calls);
    expect(error.message).toContain('skipped: timed out earlier in this command');
  });

  it('elshot clips are document coordinates: the scroll offset is added', () => {
    expect(T.elementScreenshotClip({ x: 10, y: 50, w: 200, h: 100 }, { x: 0, y: 1250 }))
      .toEqual({ x: 2, y: 1292, width: 216, height: 116, scale: 1 });
    expect(T.elementScreenshotClip({ x: 3, y: 4, w: 10, h: 10 }))
      .toEqual({ x: 0, y: 0, width: 26, height: 26, scale: 1 });
  });

  it('diff-shot and fullshot name the failed tier instead of claiming a timeout', async () => {
    const cdp = captureCdp({
      'Page.captureScreenshot': params => {
        if (params.fromSurface === false) return { data: 'alt' };
        throw new Error('Unable to capture screenshot');
      },
    });
    const capture = await T.captureScreenshot(cdp, 'sid', { format: 'png' }, quietHooks);
    expect(T.screenshotFallbackReason(capture))
      .toBe('fell back to captureScreenshot-fromSurface-false (tier 1: Unable to capture screenshot)');
    expect(T.screenshotFallbackReason({ fallback: true, attempts: [{ tier: 1, timedOut: true, message: 'Timeout: x' }] }))
      .toBe('timed out');
  });

  it('responsive-audit shares one tier state across viewports', async () => {
    let tier1Calls = 0;
    const outDir = mkdtempSync(join(tmpdir(), 'cdp-452-audit-'));
    const session = T.createSessionState({
      targetId: 'ABCDEF0123456789',
      sessionId: 'sid',
      logPath: join(outDir, 'session.jsonl'),
      screenshotDir: join(outDir, 'shots'),
    });
    const cdp = captureCdp({
      'Page.captureScreenshot': params => {
        if (params.fromSurface === false) return { data: 'iVBORw0KGgo=' };
        tier1Calls += 1;
        throw new Error('Timeout: Page.captureScreenshot');
      },
      'Runtime.evaluate': params => {
        const expr = String(params.expression || '');
        if (expr.includes('controlCount')) {
          return { result: { value: JSON.stringify({ viewport: '800x600', controlCount: 0, clippedControls: [], overlaps: [] }) } };
        }
        if (expr.includes('innerWidth')) return { result: { value: JSON.stringify({ w: 800, h: 600 }) } };
        return { result: { value: JSON.stringify({ retry: false, reason: 'frame-consistent' }) } };
      },
    });
    try {
      await T.responsiveAuditStr(cdp, 'sid', session, 'ABCDEF0123456789', new T.RingBuffer(8), new T.RingBuffer(8),
        ['--viewport', '800x600', '--viewport', '390x844', '--out-dir', outDir, '--format', 'json']).catch(() => {});
      expect(tier1Calls).toBe(1);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
