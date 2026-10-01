import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  WEB_VITALS_SCHEMA,
  buildWebVitalsModel,
  buildWebVitalsUnavailable,
  formatWebVitalsText,
  webVitalsPageScript,
} from '../skills/chrome-cdp-ex/scripts/lib/web-vitals.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, statusStr } = T;

const ALL_TYPES = ['largest-contentful-paint', 'layout-shift', 'event', 'longtask', 'long-animation-frame'];

function createDom() {
  const all = [];
  const el = (tag, { id = '', className = '', text = '', attrs = {}, parent = null } = {}) => {
    const node = {
      nodeType: 1,
      localName: tag,
      nodeName: tag.toUpperCase(),
      id,
      className,
      textContent: text,
      children: [],
      parentElement: parent,
      getAttribute: name => (name in attrs ? attrs[name] : null),
    };
    if (parent) parent.children.push(node);
    all.push(node);
    return node;
  };
  const document = {
    querySelectorAll(selector) {
      const id = selector.slice(1);
      return all.filter(node => node.id === id);
    },
  };
  return { el, document };
}

// A PerformanceObserver fake: buffered entries for an observed type are delivered one per
// callback tick, and whatever is still queued when the window closes comes from takeRecords().
// Like Chrome, droppedEntriesCount only arrives as the callback's third argument.
function createObserverEnv(buffers, { supported = ALL_TYPES, throwOn = [], dropped = {} } = {}) {
  const observers = [];
  class FakePerformanceObserver {
    static supportedEntryTypes = supported;

    constructor(callback) {
      this.callback = callback;
      this.queue = [];
      this.init = null;
      this.disconnected = false;
      observers.push(this);
    }

    observe(init) {
      if (throwOn.includes(init.type)) throw new TypeError(`unsupported ${init.type}`);
      this.init = init;
      this.queue = init.buffered ? [...(buffers[init.type] || [])] : [];
      setTimeout(() => {
        if (this.disconnected || !this.queue.length) return;
        const first = this.queue.shift();
        this.callback({ getEntries: () => [first] }, this, { droppedEntriesCount: dropped[init.type] || 0 });
      }, 0);
    }

    takeRecords() {
      const rest = this.queue;
      this.queue = [];
      return rest;
    }

    disconnect() {
      this.disconnected = true;
    }
  }
  return { PerformanceObserver: FakePerformanceObserver, observers };
}

async function runPageScript(globals) {
  const result = await runInNewContext(webVitalsPageScript({ windowMs: 5 }), { setTimeout, ...globals });
  // Runtime.evaluate returnByValue hands Node a JSON copy.
  return JSON.parse(JSON.stringify(result));
}

function richPage() {
  const { el, document } = createDom();
  const html = el('html');
  const body = el('body', { parent: html });
  const main = el('main', { className: 'content wide extra', parent: body });
  el('div', { className: 'ad', parent: main });
  const ad = el('div', { className: 'ad', parent: main });
  const para = el('p', { text: 'Intro', parent: main });
  const footer = el('footer', { id: 'site-footer', parent: body });
  const hero = el('img', { id: 'hero', attrs: { alt: '  Hero\n banner  ' }, parent: main });
  const heading = el('h1', { text: 'Welcome', parent: main });
  const save = el('button', { id: 'save', text: 'Save', parent: main });
  const input = el('input', { parent: main });
  const buffers = {
    'largest-contentful-paint': [
      { startTime: 400.4, size: 1200, element: heading, url: '' },
      { startTime: 1830.6, size: 90000, element: hero, url: 'https://cdn.test/hero.jpg?token=secret#x' },
    ],
    'layout-shift': [
      { startTime: 100, value: 0.05, hadRecentInput: false, sources: [{ node: ad }] },
      { startTime: 300, value: 0.03, hadRecentInput: false, sources: [{ node: ad }, { node: { nodeType: 3, nodeName: '#text', parentElement: para } }] },
      { startTime: 2000, value: 0.2, hadRecentInput: true, sources: [{ node: para }] },
      { startTime: 3000, value: 0.04, hadRecentInput: false, sources: [{ node: footer }] },
      { startTime: 3500, value: 0.01, hadRecentInput: false, sources: [{ node: null }] },
    ],
    event: [
      { name: 'pointerdown', interactionId: 1, duration: 120, target: save },
      { name: 'click', interactionId: 1, duration: 136, target: save },
      { name: 'keydown', interactionId: 2, duration: 112, target: input },
      { name: 'mousemove', interactionId: 0, duration: 300, target: body },
    ],
    longtask: [{ duration: 60 }, { duration: 90 }],
    'long-animation-frame': [
      // Not the longest frame, but the one with the most blocking time.
      { duration: 250, blockingDuration: 230, scripts: [] },
      {
        duration: 260,
        blockingDuration: 210,
        scripts: [
          { invoker: 'BUTTON#save.onclick', sourceURL: 'https://app.test/main.js?v=3', duration: 180 },
          { invoker: 'TimerHandler:setTimeout', sourceURL: 'https://app.test/vendor.js', duration: 20 },
        ],
      },
    ],
  };
  const performance = {
    interactionCount: 40,
    getEntriesByType: type => (type === 'navigation'
      ? [{ type: 'navigate', activationStart: 0, responseStart: 45.4, domContentLoadedEventEnd: 300.2, loadEventEnd: 0 }]
      : []),
  };
  return { buffers, document, performance };
}

describe('status --vitals page script (#473)', () => {
  it('reads buffered LCP, CLS, INP, long-task, LoAF, and navigation entries with selectors', async () => {
    const { buffers, document, performance } = richPage();
    const env = createObserverEnv(buffers);
    const raw = await runPageScript({ PerformanceObserver: env.PerformanceObserver, performance, document });

    expect(env.observers.map(observer => observer.init)).toEqual([
      { type: 'largest-contentful-paint', buffered: true },
      { type: 'layout-shift', buffered: true },
      { type: 'event', buffered: true, durationThreshold: 16 },
      { type: 'longtask', buffered: true },
      { type: 'long-animation-frame', buffered: true },
    ]);
    expect(env.observers.every(observer => observer.disconnected)).toBe(true);

    const model = buildWebVitalsModel(raw);
    expect(model.schema).toBe(WEB_VITALS_SCHEMA);
    expect(model.lcp).toEqual({
      status: 'ok',
      ms: 1831,
      rating: 'good',
      selector: 'img#hero',
      text: 'Hero banner',
      url: 'https://cdn.test/hero.jpg',
      size: 90000,
    });
    // Session windows: [100, 300] = 0.08; the 2000 ms shift had recent input; [3000, 3500] = 0.05.
    // Sources come from the reported [100, 300] window only, so the footer (3000 ms) is not one.
    expect(model.cls).toEqual({
      status: 'ok',
      value: 0.08,
      rating: 'good',
      shifts: 4,
      windowShifts: 2,
      sources: [
        { selector: 'body > main.content.wide > div.ad:nth-of-type(2)', value: 0.08, shifts: 2 },
        { selector: 'body > main.content.wide > p', value: 0.03, shifts: 1 },
      ],
    });
    expect(model.inp).toEqual({
      status: 'ok',
      ms: 136,
      rating: 'good',
      type: 'click',
      selector: 'button#save',
      slowInteractions: 2,
      interactionCount: 40,
      bufferThresholdMs: 104,
    });
    expect(model.longTasks).toEqual({ status: 'ok', count: 2, totalMs: 150, worstMs: 90 });
    expect(model.longAnimationFrames).toEqual({
      status: 'ok',
      count: 2,
      totalMs: 510,
      worstMs: 260,
      maxBlockingMs: 230,
      worstScript: { invoker: 'BUTTON#save.onclick', source: 'https://app.test/main.js', ms: 180 },
    });
    expect(model.navigation).toEqual({
      status: 'ok', type: 'navigate', ttfbMs: 45, domContentLoadedMs: 300, loadMs: null,
    });
  });

  it('reports unsupported or rejected entry types as unavailable, and supported-but-empty as none', async () => {
    const env = createObserverEnv({}, {
      supported: ['largest-contentful-paint', 'event', 'longtask'],
      throwOn: ['event'],
    });
    const raw = await runPageScript({
      PerformanceObserver: env.PerformanceObserver,
      performance: { getEntriesByType: () => [] },
      document: createDom().document,
    });
    const model = buildWebVitalsModel(raw);
    expect(model.lcp).toEqual({ status: 'none' });
    expect(model.cls).toEqual({ status: 'unavailable' });
    expect(model.inp).toEqual({ status: 'unavailable' });
    expect(model.longTasks).toEqual({ status: 'none', count: 0 });
    expect(model.longAnimationFrames).toEqual({ status: 'unavailable' });
    expect(model.navigation).toEqual({ status: 'none' });
    expect(model.error).toBeUndefined();
  });

  it('still answers when the page has no PerformanceObserver or performance at all', async () => {
    const model = buildWebVitalsModel(await runPageScript({}));
    for (const key of ['lcp', 'cls', 'inp', 'longTasks', 'longAnimationFrames', 'navigation']) {
      expect(model[key], key).toEqual({ status: 'unavailable' });
    }
  });

  it('drops query strings from classic-script invokers and URLs, in the page and again in Node', async () => {
    const env = createObserverEnv({
      'long-animation-frame': [{
        duration: 300,
        blockingDuration: 250,
        scripts: [{
          invoker: 'https://ads.test/inject.js?session=abc&url=https%3A%2F%2Fapp.test%2F',
          sourceURL: 'https://ads.test/inject.js?session=abc',
          duration: 231,
        }],
      }],
    });
    const model = buildWebVitalsModel(await runPageScript({
      PerformanceObserver: env.PerformanceObserver,
      performance: { getEntriesByType: () => [] },
      document: createDom().document,
    }));
    expect(model.longAnimationFrames.worstScript).toEqual({
      invoker: 'https://ads.test/inject.js', source: 'https://ads.test/inject.js', ms: 231,
    });

    const fromRaw = buildWebVitalsModel({
      lcp: { status: 'ok', ms: 10, url: 'https://cdn.test/a.png?sig=1#frag' },
      longAnimationFrames: {
        status: 'ok', count: 1, totalMs: 60, worstMs: 60,
        worstScript: { invoker: 'https://x.test/a.js?token=t', source: 'data:text/javascript,alert(1)', ms: 55 },
      },
    });
    expect(fromRaw.lcp.url).toBe('https://cdn.test/a.png');
    expect(fromRaw.longAnimationFrames.worstScript).toEqual({ invoker: 'https://x.test/a.js', source: 'data:…', ms: 55 });
    expect(buildWebVitalsModel({
      longAnimationFrames: { status: 'ok', count: 1, totalMs: 60, worstMs: 60, worstScript: { invoker: 'TimerHandler:setTimeout', ms: 55 } },
    }).longAnimationFrames.worstScript.invoker).toBe('TimerHandler:setTimeout');
  });

  it('reports buffer saturation from the callback droppedEntriesCount', async () => {
    const env = createObserverEnv({
      'layout-shift': [{ startTime: 10, value: 0.3, hadRecentInput: false, sources: [] }],
      longtask: [{ duration: 70 }],
      'largest-contentful-paint': [],
    }, { dropped: { 'layout-shift': 20, longtask: 16 } });
    const model = buildWebVitalsModel(await runPageScript({
      PerformanceObserver: env.PerformanceObserver,
      performance: { getEntriesByType: () => [] },
      document: createDom().document,
    }));
    expect(model.cls).toMatchObject({ value: 0.3, shifts: 1, bufferFull: true, dropped: 20 });
    expect(model.longTasks).toEqual({ status: 'ok', count: 1, totalMs: 70, worstMs: 70, bufferFull: true, dropped: 16 });
    expect(model.lcp).toEqual({ status: 'none' });
    expect(formatWebVitalsText(model)).toContain('  Buffer full, dropped: CLS 20, long tasks 16');
  });

  it('reports a buffer at capacity as full even when the browser reports no drop count', async () => {
    // Live Chrome 154: 200 long-animation-frame entries with droppedEntriesCount 0.
    const env = createObserverEnv({
      'long-animation-frame': Array.from({ length: 200 }, () => ({ duration: 55, blockingDuration: 5, scripts: [] })),
      longtask: Array.from({ length: 199 }, () => ({ duration: 55 })),
    });
    const model = buildWebVitalsModel(await runPageScript({
      PerformanceObserver: env.PerformanceObserver,
      performance: { getEntriesByType: () => [] },
      document: createDom().document,
    }));
    expect(model.longAnimationFrames).toMatchObject({ count: 200, bufferFull: true, dropped: null });
    expect(model.longTasks.bufferFull).toBeUndefined();
    expect(formatWebVitalsText(model)).toContain('  Buffer full, dropped: LoAF ?');
  });

  it('picks INP with one outlier skipped per 50 page interactions, using performance.interactionCount', async () => {
    const { el, document } = createDom();
    const body = el('body');
    const [a, b, c] = ['a', 'b', 'c'].map(id => el('button', { id, parent: body }));
    const buffers = {
      event: [
        { name: 'click', interactionId: 1, duration: 300, target: a },
        { name: 'click', interactionId: 2, duration: 200, target: b },
        { name: 'keydown', interactionId: 3, duration: 150, target: c },
      ],
    };
    const run = interactionCount => runPageScript({
      PerformanceObserver: createObserverEnv(buffers).PerformanceObserver,
      performance: { interactionCount, getEntriesByType: () => [] },
      document,
    }).then(buildWebVitalsModel);

    // 120 interactions: skip 2 outliers, so the third-worst slow interaction.
    expect((await run(120)).inp).toMatchObject({
      status: 'ok', ms: 150, rating: 'good', type: 'keydown', selector: 'button#c', slowInteractions: 3, interactionCount: 120,
    });
    // 160 interactions: the pick is past every buffered slow interaction, so INP is below 104 ms.
    const below = (await run(160)).inp;
    expect(below).toEqual({
      status: 'ok', ms: null, belowMs: 104, rating: 'good', slowInteractions: 3, interactionCount: 160, bufferThresholdMs: 104,
    });
    expect(formatWebVitalsText(buildWebVitalsModel({ windowMs: 120, inp: below })))
      .toContain('  INP (slow only): < 104 ms (good), 3 slow of 160');
    // A full event buffer dropped later slow interactions, so "< 104 ms" is not rated good.
    const unratedBelow = buildWebVitalsModel({
      windowMs: 120,
      inp: { status: 'ok', ms: null, belowThreshold: true, slowInteractions: 75, interactionCount: 4000, dropped: 12 },
    });
    expect(unratedBelow.inp).toMatchObject({ ms: null, belowMs: 104, rating: null, bufferFull: true, dropped: 12 });
    expect(formatWebVitalsText(unratedBelow)).toContain('  INP (slow only): < 104 ms, 75 slow of 4000');
    // Without interactionCount the divisor falls back to the slow interactions seen.
    expect((await run(undefined)).inp).toMatchObject({ ms: 300, interactionCount: null });
  });

  it('measures LCP from activationStart, like the navigation timings', async () => {
    const { el, document } = createDom();
    const hero = el('h1', { text: 'Prerendered', parent: el('body') });
    const env = createObserverEnv({
      'largest-contentful-paint': [{ startTime: 1830.6, size: 10, element: hero, url: '' }],
    });
    const model = buildWebVitalsModel(await runPageScript({
      PerformanceObserver: env.PerformanceObserver,
      performance: {
        getEntriesByType: type => (type === 'navigation'
          ? [{ type: 'prerender', activationStart: 1000, responseStart: 40, domContentLoadedEventEnd: 1300, loadEventEnd: 1500 }]
          : []),
      },
      document,
    }));
    expect(model.lcp.ms).toBe(831);
    expect(model.navigation).toEqual({ status: 'ok', type: 'prerender', ttfbMs: 0, domContentLoadedMs: 300, loadMs: 500 });
  });

  it('redacts URL path parameters and userinfo with the shared URL redactor', () => {
    const model = buildWebVitalsModel({
      lcp: { status: 'ok', ms: 10, url: 'https://user:pw@cdn.test/hero.png;jsessionid=ABC123?x=1' },
      longAnimationFrames: {
        status: 'ok', count: 1, totalMs: 60, worstMs: 60,
        worstScript: { invoker: 'https://app.test/app.js;jsessionid=ABC123', source: 'https://app.test/app.js;jsessionid=ABC123', ms: 55 },
      },
    });
    expect(model.lcp.url).toBe('https://user:<redacted>@cdn.test/hero.png;jsessionid=<redacted>');
    expect(model.longAnimationFrames.worstScript.invoker).toBe('https://app.test/app.js;jsessionid=<redacted>');
    expect(JSON.stringify(model)).not.toContain('ABC123');
  });

  it('does not use a duplicated id as a unique selector', async () => {
    const { el, document } = createDom();
    const body = el('body');
    el('section', { id: 'dup', parent: body });
    const target = el('section', { id: 'dup', className: 'card', text: 'Second', parent: body });
    const env = createObserverEnv({
      'largest-contentful-paint': [{ startTime: 4200, size: 10, element: target, url: '' }],
    });
    const model = buildWebVitalsModel(await runPageScript({
      PerformanceObserver: env.PerformanceObserver,
      performance: { getEntriesByType: () => [] },
      document,
    }));
    expect(model.lcp).toMatchObject({
      ms: 4200,
      rating: 'poor',
      selector: 'body > section.card:nth-of-type(2)',
      text: 'Second',
    });
  });
});

describe('status --vitals formats (#473)', () => {
  const longSelector = `body > ${'div.wrapper-with-a-long-class-name > '.repeat(6)}span.x`;
  // Every field at its widest: long strings, large counts, every buffer saturated.
  const maximalRaw = ({ lcpMs, clsValue, inpMs }) => ({
    windowMs: 120,
    lcp: { status: 'ok', ms: lcpMs, size: 99999, selector: longSelector, text: 'x'.repeat(500), url: `https://cdn.test/${'a'.repeat(500)}`, dropped: 9999 },
    cls: {
      status: 'ok',
      value: clsValue,
      shifts: 9999,
      windowShifts: 9999,
      sources: Array.from({ length: 6 }, (_, index) => ({ selector: `${longSelector}${index}`, value: 0.1234, shifts: 50 })),
      dropped: 9999,
    },
    inp: {
      status: 'ok', ms: inpMs, type: 'pointerdown'.repeat(10), selector: longSelector,
      slowInteractions: 9999, interactionCount: 99999, dropped: 9999,
    },
    longTasks: { status: 'ok', count: 9999, totalMs: 1234567, worstMs: 123456, dropped: 9999 },
    longAnimationFrames: {
      status: 'ok', count: 9999, totalMs: 1234567, worstMs: 123456, maxBlockingMs: 12000, dropped: 9999,
      worstScript: { invoker: 'I'.repeat(300), source: 'S'.repeat(300), ms: 9999 },
    },
    navigation: { status: 'ok', type: 'navigate', ttfbMs: 123456, domContentLoadedMs: 123456, loadMs: 123456 },
  });
  const maximal = buildWebVitalsModel(maximalRaw({ lcpMs: 12345, clsValue: 1.23456789, inpMs: 1234 }));
  const maximalNeedsImprovement = buildWebVitalsModel(maximalRaw({ lcpMs: 3999, clsValue: 0.2499, inpMs: 499 }));

  it('bounds the JSON model', () => {
    expect(maximal.schema).toBe('chrome-cdp-ex.vitals.v1');
    expect(maximal.cls.sources).toHaveLength(3);
    expect(maximal.cls.value).toBe(1.2346);
    expect(maximal.cls.rating).toBe('poor');
    expect(maximal.inp.rating).toBe('poor');
    expect(maximal.lcp.rating).toBe('poor');
    expect(maximalNeedsImprovement.inp.rating).toBe('needs-improvement');
    expect(maximal.lcp.text.length).toBeLessThanOrEqual(80);
    expect(maximal.lcp.selector.length).toBeLessThanOrEqual(120);
    expect(maximal.lcp.url.length).toBeLessThanOrEqual(120);
    expect(maximal.longAnimationFrames.worstScript.invoker.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(maximal).length).toBeLessThan(2200);
  });

  it('keeps the text block under 600 characters even for the largest model', () => {
    for (const model of [maximal, maximalNeedsImprovement]) {
      const text = formatWebVitalsText(model);
      expect(text.length, text).toBeLessThanOrEqual(600);
      expect(text).toMatch(/^Web vitals \(buffered entries, 120 ms\):/);
      expect(text).toContain('  Buffer full, dropped: LCP 9999, CLS 9999, INP 9999, long tasks 9999, LoAF 9999');
    }
    const text = formatWebVitalsText(maximal);
    expect(text).toContain('LCP: 12345 ms (poor)');
    expect(text).toContain('CLS: 1.2346 (poor), 9999 shifts; top ');
    expect(text).toContain('INP (slow only): 1234 ms (poor)');
    expect(text).toContain(', 9999 slow of 99999');
    expect(text).toContain('Long tasks: 9999, total 1234567 ms, worst 123456 ms');
  });

  it('prints a readable summary, none and unavailable states', () => {
    const text = formatWebVitalsText(buildWebVitalsModel({
      windowMs: 120,
      lcp: { status: 'ok', ms: 1831, selector: 'img#hero', text: 'Hero banner' },
      cls: { status: 'ok', value: 0.08, shifts: 2, windowShifts: 2, sources: [{ selector: 'div.ad', value: 0.08, shifts: 2 }] },
      inp: { status: 'none', slowInteractions: 0, interactionCount: 7 },
      longTasks: { status: 'none', count: 0 },
      longAnimationFrames: { status: 'unavailable' },
      navigation: { status: 'ok', type: 'navigate', ttfbMs: 45, domContentLoadedMs: 300, loadMs: 512 },
    }));
    expect(text).toBe([
      'Web vitals (buffered entries, 120 ms):',
      '  LCP: 1831 ms (good) img#hero "Hero banner"',
      '  CLS: 0.08 (good), 2 shifts; top div.ad 0.08',
      '  INP (slow only): none >= 104 ms, 7 interactions',
      '  Long tasks: none',
      '  LoAF: unavailable',
      '  Navigation: TTFB 45 ms, DCL 300 ms, load 512 ms',
    ].join('\n'));
  });

  it('turns a failed collection into an unavailable model instead of an error', () => {
    const model = buildWebVitalsUnavailable('Runtime.evaluate timed out');
    expect(model).toMatchObject({ schema: WEB_VITALS_SCHEMA, error: 'Runtime.evaluate timed out', lcp: { status: 'unavailable' } });
    expect(formatWebVitalsText(model)).toBe([
      'Web vitals (buffered entries, 120 ms):',
      '  unavailable (Runtime.evaluate timed out)',
    ].join('\n'));
    expect(buildWebVitalsModel(null).error).toBe('page returned no vitals result');
  });
});

describe('status <target> --vitals (#473)', () => {
  function statusCdp(vitalsResponse) {
    const calls = [];
    return {
      calls,
      async send(method, params = {}, sessionId, timeout) {
        calls.push({ method, params, sessionId, timeout });
        if (method !== 'Runtime.evaluate') return {};
        if (params.expression.includes('collectWebVitalsInPage')) return vitalsResponse();
        return { result: { value: JSON.stringify({ title: 'T', url: 'https://example.test/' }) } };
      },
      on() {},
      off() {},
    };
  }

  const buffers = () => [new RingBuffer(10), new RingBuffer(10), new RingBuffer(10), { console: 0, exception: 0 }];

  it('appends the vitals block only when requested, and evaluates the page script with a bounded timeout', async () => {
    const cdp = statusCdp(() => ({
      result: { value: { windowMs: 120, lcp: { status: 'ok', ms: 900, selector: 'h1' }, cls: { status: 'none', value: 0, shifts: 0, sources: [] } } },
    }));
    const plain = await statusStr(cdp, 'sid1', ...buffers());
    expect(plain).not.toContain('Web vitals');
    expect(cdp.calls.some(call => call.params.expression?.includes('collectWebVitalsInPage'))).toBe(false);

    const out = await statusStr(cdp, 'sid1', ...buffers(), { vitals: true });
    expect(out).toContain('Web vitals (buffered entries, 120 ms):');
    expect(out).toContain('  LCP: 900 ms (good) h1');
    expect(out).toContain('  CLS: 0 (good), 0 shifts');
    expect(out).toContain('  INP: unavailable');
    const vitalsCall = cdp.calls.find(call => call.params.expression?.includes('collectWebVitalsInPage'));
    expect(vitalsCall.params).toMatchObject({ returnByValue: true, awaitPromise: true });
    expect(vitalsCall.timeout).toBeGreaterThan(120);
    expect(vitalsCall.timeout).toBeLessThanOrEqual(5000);
  });

  it('prints console entries and exceptions logged during the vitals window instead of marking them read unseen', async () => {
    const [consoleBuf, exceptionBuf, navBuf, lastReadSeq] = buffers();
    consoleBuf.push({ level: 'log', text: 'before status' });
    const cdp = statusCdp(() => {
      // A janky page logs while the 120 ms collection window is open.
      consoleBuf.push({ level: 'error', text: 'TypeError during vitals window' });
      exceptionBuf.push({ msg: 'Uncaught RangeError during vitals window' });
      return { result: { value: { windowMs: 120 } } };
    });
    const out = await statusStr(cdp, 'sid1', consoleBuf, exceptionBuf, navBuf, lastReadSeq, { vitals: true });
    expect(out).toContain('Console (2 new):');
    expect(out).toContain('[log] before status');
    expect(out).toContain('[error] TypeError during vitals window');
    expect(out).toContain('Exceptions (1 new):');
    expect(out).toContain('Uncaught RangeError during vitals window');
    expect(out.indexOf('Console (2 new):')).toBeLessThan(out.indexOf('Web vitals'));

    // Printed once: the next status starts after them, and later entries still show.
    consoleBuf.push({ level: 'warning', text: 'after status' });
    const next = await statusStr(cdp, 'sid1', consoleBuf, exceptionBuf, navBuf, lastReadSeq);
    expect(next).toContain('Console (1 new):');
    expect(next).toContain('[warning] after status');
    expect(next).not.toContain('during vitals window');
  });

  it('source-maps entries logged during the vitals window and leaves entries logged during map loading unread', async () => {
    const [consoleBuf, exceptionBuf, navBuf, lastReadSeq] = buffers();
    const cdp = statusCdp(() => {
      consoleBuf.push({ level: 'error', text: 'TypeError in bundle', loc: 'index-3fa9c2.js:1:48213', frames: [{ url: 'https://app.test/index-3fa9c2.js', line: 0, col: 48212 }] });
      exceptionBuf.push({ msg: 'Uncaught RangeError', loc: 'index-3fa9c2.js:1:900', frames: [{ url: 'https://app.test/index-3fa9c2.js', line: 0, col: 899 }] });
      return { result: { value: { windowMs: 120, lcp: { status: 'ok', ms: 700, selector: 'h1' } } } };
    });
    const asked = [];
    const locate = async entries => {
      asked.push(...entries.map(entry => entry.text || entry.msg));
      // Logged while the maps load: not printed by this status.
      consoleBuf.push({ level: 'warning', text: 'logged during source-map load' });
      return new Map(entries.map(entry => [entry, {
        loc: entry.text ? 'src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)' : 'src/util.ts:3:1 (index-3fa9c2.js:1:900)',
        stack: [],
      }]));
    };
    const out = await statusStr(cdp, 'sid1', consoleBuf, exceptionBuf, navBuf, lastReadSeq, { vitals: true, runtime: false, locate });
    expect(asked).toEqual(['TypeError in bundle', 'Uncaught RangeError']);
    expect(out).toContain('[error] TypeError in bundle (src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213))');
    expect(out).toContain('Uncaught RangeError at src/util.ts:3:1 (index-3fa9c2.js:1:900)');
    expect(out).toContain('  LCP: 700 ms (good) h1');
    expect(out).not.toContain('logged during source-map load');
    expect(out.match(/Web vitals/g)).toHaveLength(1);

    const next = await statusStr(cdp, 'sid1', consoleBuf, exceptionBuf, navBuf, lastReadSeq);
    expect(next).toContain('Console (1 new):');
    expect(next).toContain('[warning] logged during source-map load');
    expect(next).not.toContain('TypeError in bundle');
  });

  it('prints console entries logged while --runtime metrics are read', async () => {
    const [consoleBuf, exceptionBuf, navBuf, lastReadSeq] = buffers();
    const cdp = statusCdp(() => ({ result: { value: {} } }));
    const send = cdp.send;
    cdp.send = async (method, ...rest) => {
      if (method === 'Performance.getMetrics') {
        consoleBuf.push({ level: 'error', text: 'logged during getMetrics' });
        return { metrics: [{ name: 'Nodes', value: 3 }] };
      }
      return send(method, ...rest);
    };
    const out = await statusStr(cdp, 'sid1', consoleBuf, exceptionBuf, navBuf, lastReadSeq, { runtime: true });
    expect(out).toContain('[error] logged during getMetrics');
    expect(out).toContain('Nodes: 3');
  });

  it('reports a page-side failure as unavailable instead of failing status', async () => {
    const cdp = statusCdp(() => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'EvalError: blocked by CSP' } } }));
    const out = await statusStr(cdp, 'sid1', ...buffers(), { vitals: true });
    expect(out).toContain('URL: https://example.test/');
    expect(out).toMatch(/Web vitals \(buffered entries, 120 ms\):\n {2}unavailable \(.*blocked by CSP.*\)/);
  });

  it('webVitalsModel returns the versioned model used by status --format json', async () => {
    const cdp = statusCdp(() => ({ result: { value: { windowMs: 120, longTasks: { status: 'ok', count: 1, totalMs: 70, worstMs: 70 } } } }));
    const model = await T.webVitalsModel(cdp, 'sid1');
    expect(model.schema).toBe('chrome-cdp-ex.vitals.v1');
    expect(model.longTasks).toEqual({ status: 'ok', count: 1, totalMs: 70, worstMs: 70 });
    const status = T.buildStatusModel({
      targetId: 'ABC',
      page: { title: 'T', url: 'https://example.test/' },
      consoleBuf: new RingBuffer(10),
      exceptionBuf: new RingBuffer(10),
      navBuf: new RingBuffer(10),
      lastReadSeq: { console: 0, exception: 0 },
      vitals: model,
    });
    expect(status.schema).toBe('chrome-cdp-ex.status.v1');
    expect(status.vitals).toBe(model);
    expect(T.buildStatusModel({
      targetId: 'ABC', page: {}, consoleBuf: new RingBuffer(1), exceptionBuf: new RingBuffer(1), navBuf: new RingBuffer(1), lastReadSeq: {},
    }).vitals).toBeNull();
  });
});
