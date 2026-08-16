import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const HF_HOME = 'https://huggingface.co/';
const HF_RESULTS = 'https://huggingface.co/models?search=bert';
const HF_FIRST_HIT = 'https://huggingface.co/google-bert/bert-base-uncased';
const RESULTS_SELECTOR = 'a[href="/models?search=bert"]';
const RESULTS_TEXT = 'See 51552 model results for "bert"';

function hfTypeaheadControls() {
  const repos = Array.from({ length: 12 }, (_, i) => ({
    tag: 'a',
    role: 'link',
    label: i === 0 ? 'google-bert/bert-base-uncased' : `typeahead-repo-${i}`,
    text: i === 0 ? 'google-bert/bert-base-uncased' : `typeahead-repo-${i}`,
    href: i === 0 ? '/google-bert/bert-base-uncased' : `/org/model-${i}`,
    selector: i === 0 ? 'a[href="/google-bert/bert-base-uncased"]' : `a[href="/org/model-${i}"]`,
    clickable: true,
  }));
  return [
    ...repos,
    {
      tag: 'a',
      role: 'link',
      label: RESULTS_TEXT,
      text: RESULTS_TEXT,
      href: '/models?search=bert',
      selector: RESULTS_SELECTOR,
      clickable: true,
    },
    {
      tag: 'a',
      role: 'link',
      ariaLabel: 'Skip to main content',
      label: 'Skip to main content',
      href: '#main',
      selector: 'a[href="#main"]',
      clickable: true,
    },
  ];
}

function leftoverGoldenPathDump() {
  return [
    'Page: Hugging Face — https://huggingface.co/',
    'Viewport: 1042×632 | Scroll: 0/5295 (0%) | Focused: <input>',
    'Interactive: 40 a',
    'Console: clean',
    '',
    '[RootWebArea] Hugging Face',
    '  [link] Models',
    '(no changes detected in AX tree)',
  ].join('\n');
}

function createSearchSubmitCdp({
  probe = {
    ok: true,
    selector: RESULTS_SELECTOR,
    href: '/models?search=bert',
    text: RESULTS_TEXT,
  },
  pageHref = HF_HOME,
  mouseDeliversPageEvents = true,
  mouseNavigates = true,
  jsClickNavigates = true,
} = {}) {
  const calls = [];
  const clickProbe = { seen: [] };
  let href = pageHref;
  return {
    calls,
    hrefOf: () => href,
    send(method, params = {}, sessionId, timeout) {
      calls.push({ method, params, sessionId, timeout });
      const probeSource = method === 'Runtime.evaluate'
        ? String(params.expression || '')
        : method === 'Runtime.callFunctionOn'
          ? String(params.functionDeclaration || '')
          : '';
      if (probeSource.includes('__chromeCdpExClickProbe')) {
        if (probeSource.includes('installed: true')) {
          clickProbe.seen = [];
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'target-document' } } });
        }
        const seen = clickProbe.seen.slice();
        clickProbe.seen = [];
        return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen } } });
      }
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration || '').includes('scrollIntoView')) {
        if (jsClickNavigates) href = HF_RESULTS;
        return Promise.resolve({ result: { value: { tag: 'A', text: RESULTS_TEXT } } });
      }
      if (method === 'Input.dispatchMouseEvent') {
        const pressOrRelease = params.type === 'mousePressed' || params.type === 'mouseReleased';
        const ackBudget = Number(timeout);
        const compositorAckTooShort = pressOrRelease
          && Number.isFinite(ackBudget)
          && ackBudget < T.CLICK_MOUSE_ACK_TIMEOUT_MS;
        if (!compositorAckTooShort && params.type === 'mouseReleased') {
          if (mouseDeliversPageEvents) clickProbe.seen.push('mousedown', 'mouseup', 'click');
          if (mouseNavigates && probe?.ok) href = HF_RESULTS;
        }
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('chrome-cdp-ex.search-submit')) {
          return Promise.resolve({ result: { value: probe } });
        }
        if (expr.includes('requestAnimationFrame')) {
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                x: 120,
                y: 80,
                tag: 'A',
                text: RESULTS_TEXT,
                href: '/models?search=bert',
                pageHref: href,
              },
            },
          });
        }
        if (expr.includes('location.href')) {
          return Promise.resolve({ result: { value: href } });
        }
        return Promise.resolve({ result: { value: href } });
      }
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree: { frame: { id: 'mock-root-frame' } } });
      }
      if (method === 'DOM.getDocument') {
        return Promise.resolve({ root: { nodeId: 1 } });
      }
      if (method === 'DOM.querySelector') {
        return Promise.resolve({ nodeId: 2 });
      }
      if (method === 'DOM.resolveNode') {
        return Promise.resolve({ object: { objectId: 'OBJECT' } });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
}

describe('issue #328 search listing identity', () => {
  it('recognizes HF /models?search= and /search?q= listing hrefs, not typeahead first hits', () => {
    expect(T.isSearchListingHref('/models?search=bert')).toBe(true);
    expect(T.isSearchListingHref('https://huggingface.co/models?search=bert')).toBe(true);
    expect(T.isSearchListingHref('/search?q=bert')).toBe(true);
    expect(T.isSearchListingHref('/datasets?search=bert')).toBe(true);
    expect(T.isSearchListingHref('/google-bert/bert-base-uncased')).toBe(false);
    expect(T.isSearchListingHref('https://huggingface.co/google-bert/bert-base-uncased')).toBe(false);
    expect(T.isSearchListingText(RESULTS_TEXT)).toBe(true);
    expect(T.isSearchListingText('google-bert/bert-base-uncased')).toBe(false);
    expect(T.isSearchListingControl({ href: '/models?search=bert', label: 'models' })).toBe(true);
    expect(T.isSearchListingControl({ href: '/google-bert/bert-base-uncased', label: 'bert-base-uncased' })).toBe(false);
  });

  it('ranks the See N model results listing ahead of typeahead repos and skip links', () => {
    const ranked = T.rankPerceiveCursorItems(hfTypeaheadControls());
    expect(ranked[0].selector).toBe(RESULTS_SELECTOR);
    expect(ranked[0].href).toBe('/models?search=bert');
    expect(ranked.some(item => item.href === '/google-bert/bert-base-uncased')).toBe(true);
    expect(ranked.at(-1).ariaLabel).toMatch(/Skip to/i);
    const capped = ranked.slice(0, T.PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP);
    expect(capped.some(item => item.selector === RESULTS_SELECTOR)).toBe(true);
    expect(capped.map(item => item.selector)).toContain(RESULTS_SELECTOR);
  });

  it('promotes listing links before the visible-controls collector slice so truncation cannot hide them', () => {
    const source = T.visibleControlsCollectorSource();
    expect(source).toContain('rankSearchListingFirst');
    expect(source).toMatch(/rankSearchListingFirst\(controls\)[\s\S]*ranked\.slice\(0, limit\)/);
    const ranked = T.rankSearchListingFirst(hfTypeaheadControls());
    expect(ranked[0].href).toBe('/models?search=bert');
    const truncated = ranked.slice(0, 8);
    expect(truncated.some(item => item.href === '/models?search=bert')).toBe(true);
    expect(truncated[0].selector).toBe(RESULTS_SELECTOR);
  });

  it('builds a stable a[href*="models?search="] selector for listing links', () => {
    expect(T.searchListingSelector('/models?search=bert')).toBe(RESULTS_SELECTOR);
    expect(T.searchListingSelector('https://huggingface.co/models?search=bert')).toBe(RESULTS_SELECTOR);
    expect(T.searchListingSelector('/search?q=bert')).toBe('a[href="/search?q=bert"]');
  });
});

describe('issue #328 press Enter submits search listing, not typeahead first hit', () => {
  it('clicks the results listing link instead of dispatching Enter when the search box is focused', async () => {
    const cdp = createSearchSubmitCdp();
    const out = await T.pressStr(cdp, 'sid', 'enter');
    expect(out).toMatch(/Pressed Enter/i);
    expect(out).toMatch(/Submitted search/i);
    expect(out).toContain(RESULTS_SELECTOR);
    expect(out).not.toMatch(/google-bert/);
    const keyTypes = cdp.calls
      .filter(call => call.method === 'Input.dispatchKeyEvent')
      .map(call => call.params.type);
    expect(keyTypes).toEqual([]);
    const mouseTypes = cdp.calls
      .filter(call => call.method === 'Input.dispatchMouseEvent')
      .map(call => call.params.type);
    expect(mouseTypes).toContain('mousePressed');
    expect(mouseTypes).toContain('mouseReleased');
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
    expect(cdp.hrefOf()).not.toBe(HF_FIRST_HIT);
  });

  it('still dispatches Enter when there is no listing-results link', async () => {
    const cdp = createSearchSubmitCdp({ probe: { ok: false } });
    const out = await T.pressStr(cdp, 'sid', 'enter');
    expect(out).toBe('Pressed Enter');
    const keyTypes = cdp.calls
      .filter(call => call.method === 'Input.dispatchKeyEvent')
      .map(call => call.params.type);
    expect(keyTypes).toEqual(['keyDown', 'keyUp']);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('does not intercept Escape or Tab', async () => {
    const cdp = createSearchSubmitCdp();
    await T.pressStr(cdp, 'sid', 'escape');
    const keyTypes = cdp.calls
      .filter(call => call.method === 'Input.dispatchKeyEvent')
      .map(call => call.params.type);
    expect(keyTypes).toEqual(['keyDown', 'keyUp']);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('uses report-only for search-submit Enter so leftover perceive settle is not eaten', () => {
    expect(T.pressFeedbackPolicy('enter', { ok: true, selector: RESULTS_SELECTOR })).toBe('report-only');
    expect(T.pressFeedbackPolicy('enter', { ok: false })).toBe('settle-diff');
    expect(T.pressFeedbackPolicy('escape')).toBe('settle-diff');
    expect(T.pressFeedbackPolicy('tab')).toBe('settle-diff');
  });

  it('treats a fail-closed mouse click as success when the listing URL already loaded', async () => {
    const cdp = createSearchSubmitCdp({ mouseDeliversPageEvents: false, mouseNavigates: true });
    const out = await T.pressStr(cdp, 'sid', 'enter');
    expect(out).toMatch(/Submitted search/i);
    expect(out).toContain(RESULTS_SELECTOR);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
    expect(cdp.calls.some(call =>
      call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration || '').includes('scrollIntoView')
    )).toBe(false);
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
    expect(cdp.hrefOf()).not.toBe(HF_FIRST_HIT);
  });

  it('falls back to jsclick instead of Enter when the mouse path misses the overlay', async () => {
    const cdp = createSearchSubmitCdp({
      mouseDeliversPageEvents: false,
      mouseNavigates: false,
      jsClickNavigates: true,
    });
    const out = await T.pressStr(cdp, 'sid', 'enter');
    expect(out).toMatch(/Submitted search/i);
    expect(out).toContain(RESULTS_SELECTOR);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
    expect(cdp.calls.some(call =>
      call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration || '').includes('scrollIntoView')
    )).toBe(true);
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
    expect(cdp.hrefOf()).not.toBe(HF_FIRST_HIT);
  });

  it('does not send Enter when search submit cannot reach a listing', async () => {
    const cdp = createSearchSubmitCdp({
      mouseDeliversPageEvents: false,
      mouseNavigates: false,
      jsClickNavigates: false,
    });
    await expect(T.pressStr(cdp, 'sid', 'enter')).rejects.toThrow(/results listing/i);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
    expect(cdp.hrefOf()).toBe(HF_HOME);
  });

  it('prints a skinny report-only receipt without leftover AX after search submit', async () => {
    const cdp = createSearchSubmitCdp();
    const dispatchText = await T.pressStr(cdp, 'sid', 'enter');
    let observed = false;
    const text = await T.runActionWithFeedback({
      action: 'press',
      target: {
        targetId: '54A7C685ABCDEF0123456789ABCDEF01',
        input: 'enter',
        resolvedBy: 'key',
        label: 'Enter',
        commandArgs: ['enter'],
      },
      dispatch: async () => dispatchText,
      feedbackPolicy: T.pressFeedbackPolicy('enter', { ok: true, selector: RESULTS_SELECTOR }),
      observe: async () => {
        observed = true;
        return leftoverGoldenPathDump();
      },
    });
    expect(observed).toBe(false);
    expect(text).toContain(dispatchText);
    expect(text).toMatch(/Submitted search/i);
    expect(text).toContain(RESULTS_SELECTOR);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/^Page: /m);
    expect(text).not.toMatch(/no changes detected in AX tree/);
    expect(text).not.toMatch(/Next: perceive -C -d 8/);
    expect(text.length).toBeLessThan(800);
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
  });
});
