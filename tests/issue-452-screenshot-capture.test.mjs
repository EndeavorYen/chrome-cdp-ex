import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { screenshotHealthScript } = await import('../skills/chrome-cdp-ex/scripts/lib/screenshot-health.mjs');

const LIGHT = 'rgb(244, 244, 240)';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

function element(tagName, { backgroundColor = TRANSPARENT, backgroundImage = 'none', parent = null } = {}) {
  return { nodeType: 1, tagName, parentElement: parent, style: { backgroundColor, backgroundImage } };
}

// Runs the page-side sanity script against a fake page: `hit(x, y)` is the topmost element
// at a viewport point, and every captured pixel is near-black.
const savedGlobals = {};
function installFakePage({ hit, body, root, width = 100, height = 100 }) {
  const globals = {
    innerWidth: width,
    innerHeight: height,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: node => node.style,
    Image: class {
      constructor() { this.naturalWidth = 64; this.naturalHeight = 64; }
      set src(_value) { queueMicrotask(() => this.onload?.()); }
    },
    document: {
      body,
      documentElement: root,
      elementFromPoint: hit,
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

  it('maps an elshot clip onto the clipped region only', async () => {
    const root = element('HTML');
    const body = element('BODY', { backgroundColor: LIGHT, parent: root });
    const canvas = element('CANVAS', { parent: body });
    // Canvas fills the left half; the clip covers only that half.
    installFakePage({ body, root, hit: x => (x < 50 ? canvas : body) });
    expect((await runSanity({ clip: { x: 0, y: 0, width: 50, height: 100 } })).retry).toBe(false);
    expect((await runSanity({ clip: { x: 50, y: 0, width: 50, height: 100 } })).retry).toBe(true);
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
