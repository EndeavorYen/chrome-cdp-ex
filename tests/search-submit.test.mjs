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
  jsClickThrows = false,
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
        if (jsClickThrows) return Promise.reject(new Error('jsclick missed listing'));
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
      if (method === 'Page.enable') {
        return Promise.resolve({});
      }
      if (method === 'Page.navigate') {
        href = String(params.url || href);
        return Promise.resolve({ loaderId: 'search-submit-nav' });
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('chrome-cdp-ex.search-submit')) {
          const value = typeof probe === 'function' ? probe() : probe;
          return Promise.resolve({ result: { value } });
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
    expect(cdp.calls.some(call =>
      call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration || '').includes('scrollIntoView')
    )).toBe(true);
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

  it('treats a fail-closed listing click as success when the listing URL already loaded', async () => {
    const cdp = createSearchSubmitCdp({ mouseDeliversPageEvents: false, mouseNavigates: true });
    const out = await T.pressStr(cdp, 'sid', 'enter');
    expect(out).toMatch(/Submitted search/i);
    expect(out).toContain(RESULTS_SELECTOR);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
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

describe('issue #335 skip fill leftover settle before search-submit press', () => {
  it('treats fill leftover typeahead as skippable only when the next batch command is search-submit press', () => {
    expect(T.isSearchSubmitPressCommand({ cmd: 'press', args: ['Enter'] })).toBe(true);
    expect(T.isSearchSubmitPressCommand({ cmd: 'key', args: ['enter'] })).toBe(true);
    expect(T.isSearchSubmitPressCommand({ cmd: 'press', args: ['escape'] })).toBe(false);
    expect(T.isSearchSubmitPressCommand({ cmd: 'fill', args: ['input', 'bert'] })).toBe(false);
    expect(T.fillFeedbackPolicy({ cmd: 'press', args: ['Enter'] })).toBe('report-only');
    expect(T.fillFeedbackPolicy({ cmd: 'press', args: ['escape'] })).toBe('settle-diff');
    expect(T.fillFeedbackPolicy({ cmd: 'click', args: ['#go'] })).toBe('settle-diff');
    expect(T.fillFeedbackPolicy(null)).toBe('settle-diff');
  });

  it('attaches sequential batch lookahead so mid-pipe fill can see the following press', () => {
    const sequenced = T.batchCommandLookahead([
      { cmd: 'fill', args: ['input[placeholder*="Search"]', 'bert'] },
      { cmd: 'press', args: ['Enter'] },
    ]);
    expect(T.fillFeedbackPolicy(sequenced[0].nextCommand)).toBe('report-only');
    expect(sequenced[1].nextCommand).toBeNull();
    const parallel = T.batchCommandLookahead(sequenced, { parallel: true });
    expect(T.fillFeedbackPolicy(parallel[0].nextCommand)).toBe('settle-diff');
  });

  it('awaits sequential-batch work before clearing lookahead so fillFeedbackPolicy can run after the daemon yield', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url)), 'utf8');
    expect(src).toMatch(/async function runWithBatchLookahead[\s\S]*?return await run\(\)/);
    expect(src).toMatch(/const runOne = command => runWithBatchLookahead\(\s*session,\s*command\.nextCommand/);
    expect(src).not.toMatch(/try \{\s*return handleCommand\(\{/);
  });

  it('the pre-fix try/finally around return handleCommand() loses lookahead at the first await', async () => {
    const session = { batchNextCommand: null };
    const next = { cmd: 'press', args: ['Enter'] };
    let afterYield;
    const handleCommand = async () => {
      await Promise.resolve();
      afterYield = T.fillFeedbackPolicy(session.batchNextCommand);
    };
    const runOne = () => {
      session.batchNextCommand = next;
      try {
        return handleCommand();
      } finally {
        session.batchNextCommand = null;
      }
    };
    await runOne();
    expect(afterYield).toBe('settle-diff');
  });

  it('keeps fill report-only across the first handleCommand await, not only before it', async () => {
    const session = { batchNextCommand: null };
    const sequenced = T.batchCommandLookahead([
      { cmd: 'fill', args: ['input[placeholder*="Search"]', 'bert'] },
      { cmd: 'press', args: ['Enter'] },
    ]);
    let policyAfterYield;
    let observed = false;
    const text = await T.runWithBatchLookahead(session, sequenced[0].nextCommand, async () => {
      // Same first yield as handleCommand → executeDaemonApplicationRoute.
      await Promise.resolve();
      policyAfterYield = T.fillFeedbackPolicy(session.batchNextCommand);
      return T.runActionWithFeedback({
        action: 'fill',
        target: {
          targetId: '54A7C685ABCDEF0123456789ABCDEF01',
          input: 'input[placeholder*="Search"]',
          resolvedBy: 'selector-or-ref',
          label: 'input[placeholder*="Search"]',
          commandArgs: ['input[placeholder*="Search"]', 'bert'],
        },
        dispatch: async () => 'Filled <INPUT> with "bert"',
        feedbackPolicy: policyAfterYield,
        observe: async () => {
          observed = true;
          return leftoverGoldenPathDump();
        },
      });
    });
    expect(policyAfterYield).toBe('report-only');
    expect(observed).toBe(false);
    expect(text).toMatch(/Filled <INPUT> with "bert"/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/no changes detected in AX tree/);
    expect(text).not.toMatch(/Outcome: attention/);
    expect(text).not.toMatch(/quicksearch/);
    expect(session.batchNextCommand).toBeNull();
  });

  it('clears sequential-batch lookahead after the daemon route even when it rejects', async () => {
    const session = { batchNextCommand: 'stale' };
    await expect(T.runWithBatchLookahead(session, { cmd: 'press', args: ['Enter'] }, async () => {
      await Promise.resolve();
      expect(T.fillFeedbackPolicy(session.batchNextCommand)).toBe('report-only');
      throw new Error('daemon route failed');
    })).rejects.toThrow(/daemon route failed/);
    expect(session.batchNextCommand).toBeNull();
  });

  it('does not dump leftover AX or wait network-quiet for mid-pipe fill before search-submit press', async () => {
    let observed = false;
    const text = await T.runActionWithFeedback({
      action: 'fill',
      target: {
        targetId: '54A7C685ABCDEF0123456789ABCDEF01',
        input: 'input[placeholder*="Search"]',
        resolvedBy: 'selector-or-ref',
        label: 'input[placeholder*="Search"]',
        commandArgs: ['input[placeholder*="Search"]', 'bert'],
      },
      dispatch: async () => 'Filled <INPUT> with "bert"',
      feedbackPolicy: T.fillFeedbackPolicy({ cmd: 'press', args: ['Enter'] }),
      observe: async () => {
        observed = true;
        return leftoverGoldenPathDump();
      },
    });
    expect(observed).toBe(false);
    expect(text).toMatch(/Filled <INPUT> with "bert"/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/no changes detected in AX tree/);
    expect(text).not.toMatch(/quicksearch/);
  });

  it('still settle-diffs standalone fill so leftover typeahead remains visible', async () => {
    let observed = false;
    const text = await T.runActionWithFeedback({
      action: 'fill',
      target: {
        targetId: '54A7C685ABCDEF0123456789ABCDEF01',
        input: '#name',
        resolvedBy: 'selector-or-ref',
        label: '#name',
        commandArgs: ['#name', 'bert'],
      },
      dispatch: async () => 'Filled <INPUT> with "bert"',
      feedbackPolicy: T.fillFeedbackPolicy(null),
      observe: async () => {
        observed = true;
        return leftoverGoldenPathDump();
      },
    });
    expect(observed).toBe(true);
    expect(text).toMatch(/^Filled <INPUT> with "bert"\. Next: /);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/^Outcome:/m);
  });

  it('still fail-closes skip-settle fill when the listing never appears, without sending Enter', async () => {
    const cdp = createSearchSubmitCdp({ probe: { ok: false } });
    await expect(T.pressStr(cdp, 'sid', 'enter', { requireSearchSubmit: true })).rejects.toThrow(/results listing/i);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
  });
});

describe('issue #339 skip typeahead listing probe wait after report-only fill', () => {
  it('builds /models?search=<filled> from the value just set, not a typeahead first-model repo', () => {
    const probe = T.searchListingProbeFromQuery('bert', HF_HOME);
    expect(probe.ok).toBe(true);
    expect(probe.selector).toBe(RESULTS_SELECTOR);
    expect(probe.href).toBe('/models?search=bert');
    expect(probe.navigateHref).toBe(HF_RESULTS);
    expect(probe.synthesized).toBe(true);
    expect(probe.href).not.toContain('google-bert');
    expect(T.isSearchListingHref(probe.navigateHref)).toBe(true);
    expect(T.isSearchListingHref(HF_FIRST_HIT)).toBe(false);
  });

  it('does not invent a listing URL on a non-Hugging-Face origin', () => {
    expect(T.searchListingProbeFromQuery('bert', 'https://example.com/').ok).toBe(false);
    expect(T.searchListingProbeFromQuery('bert', '').ok).toBe(false);
    expect(T.searchListingProbeFromQuery('', HF_HOME).ok).toBe(false);
  });

  it('after report-only fill, probe wait is not the 1500 ms typeahead poll', async () => {
    let probes = 0;
    const cdp = createSearchSubmitCdp({
      probe: () => {
        probes += 1;
        return { ok: false };
      },
    });
    const started = Date.now();
    const probe = await T.waitForSearchSubmitProbe(cdp, 'sid', { filledQuery: 'bert' });
    const elapsedMs = Date.now() - started;
    expect(probe.ok).toBe(true);
    expect(probe.selector).toBe(RESULTS_SELECTOR);
    expect(probe.synthesized).toBe(true);
    expect(probe.navigateHref).toBe(HF_RESULTS);
    expect(probes).toBe(1);
    expect(elapsedMs).toBeLessThan(250);
  });

  it('listing URL still wins via synthesized navigate when typeahead is not visible yet', async () => {
    const cdp = createSearchSubmitCdp({ probe: { ok: false } });
    const probe = await T.waitForSearchSubmitProbe(cdp, 'sid', { filledQuery: 'bert' });
    await T.submitSearchListing(cdp, 'sid', probe, new Map(), {});
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
    expect(cdp.hrefOf()).not.toBe(HF_FIRST_HIT);
    expect(cdp.calls.some(call => call.method === 'Page.navigate' && call.params.url === HF_RESULTS)).toBe(true);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('typeahead first-model still fails: synthesized submit does not click the first repo or send Enter', async () => {
    const cdp = createSearchSubmitCdp({ probe: { ok: false } });
    const probe = T.searchListingProbeFromQuery('bert', HF_HOME);
    const out = await T.pressStr(cdp, 'sid', 'enter', { searchSubmit: probe, requireSearchSubmit: true });
    expect(out).toMatch(/Submitted search/i);
    expect(out).toContain(RESULTS_SELECTOR);
    expect(out).not.toMatch(/google-bert/);
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
    expect(cdp.hrefOf()).not.toBe(HF_FIRST_HIT);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
    expect(cdp.calls.some(call =>
      String(call.params?.functionDeclaration || '').includes('scrollIntoView')
      && String(call.params?.functionDeclaration || '').includes('.click(')
    )).toBe(false);
  });

  it('still jsclicks a visible listing instead of synthesizing a navigate', async () => {
    const cdp = createSearchSubmitCdp();
    const probe = await T.waitForSearchSubmitProbe(cdp, 'sid', { filledQuery: 'bert' });
    expect(probe.ok).toBe(true);
    expect(probe.synthesized).not.toBe(true);
    expect(probe.selector).toBe(RESULTS_SELECTOR);
    const out = await T.pressStr(cdp, 'sid', 'enter', { searchSubmit: probe });
    expect(out).toMatch(/Submitted search/i);
    expect(cdp.calls.some(call => call.method === 'Page.navigate')).toBe(false);
    expect(cdp.calls.some(call =>
      call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration || '').includes('scrollIntoView')
    )).toBe(true);
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
    expect(cdp.hrefOf()).not.toBe(HF_FIRST_HIT);
  });

  it('press after report-only fill passes the filled query into the listing probe, not a 1500 ms poll', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url)), 'utf8');
    expect(src).toMatch(/session\.searchSubmitQuery = parsed\.text/);
    expect(src).toMatch(/waitForSearchSubmitProbe\(\s*cdp,\s*sessionId,\s*\{\s*filledQuery/);
    expect(src).not.toMatch(/awaitListing\s*\n\s*\? await waitForSearchSubmitProbe\(cdp, sessionId\)/);
  });
});

describe('issue #335 search-submit returns on listing URL commit', () => {
  it('submits the listing via jsclick and returns on the listing URL without mouse compositor wait', async () => {
    const cdp = createSearchSubmitCdp();
    const out = await T.pressStr(cdp, 'sid', 'enter');
    expect(out).toMatch(/Submitted search/i);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    expect(cdp.calls.some(call =>
      call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration || '').includes('scrollIntoView')
    )).toBe(true);
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
    expect(cdp.hrefOf()).not.toBe(HF_FIRST_HIT);
  });

  it('treats a failed listing click as success when the listing URL already committed', async () => {
    const cdp = createSearchSubmitCdp({
      pageHref: HF_RESULTS,
      jsClickNavigates: false,
      jsClickThrows: true,
      mouseDeliversPageEvents: false,
      mouseNavigates: false,
    });
    const out = await T.pressStr(cdp, 'sid', 'enter');
    expect(out).toMatch(/Submitted search/i);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(false);
    expect(cdp.hrefOf()).toBe(HF_RESULTS);
  });

  it('keeps compact batch receipts skinny for fill then search-submit press', () => {
    const formatted = T.formatBatchResults([
      { cmd: 'fill', ok: true, result: 'Filled <INPUT> with "bert"\n---\nfill: dispatched via fill' },
      { cmd: 'press', ok: true, result: `Pressed Enter. Submitted search via ${RESULTS_SELECTOR}\n---\npress: dispatched via press` },
    ], 'compact');
    expect(formatted).toContain('Filled <INPUT> with "bert"');
    expect(formatted).toContain(`Submitted search via ${RESULTS_SELECTOR}`);
    expect(formatted.length).toBeLessThan(220);
    expect(formatted).not.toMatch(/RootWebArea/);
  });
});
