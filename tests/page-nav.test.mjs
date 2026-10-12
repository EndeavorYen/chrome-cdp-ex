import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, formatPageList, navStr, reloadStr, reloadActionDispatch, observeReloadPage } = T;

// =========================================================================
// formatPageList
// =========================================================================

describe('formatPageList', () => {
  it('should return empty string for no pages', () => {
    expect(formatPageList([])).toBe('');
  });

  it('builds a versioned list JSON model with stable prefixes and next steps', () => {
    const model = T.buildPageListModel([
      { targetId: 'AABBCCDD11223344', type: 'page', title: 'Dashboard', url: 'https://example.com/app' },
      { targetId: 'AABBCCDD55667788', type: 'page', title: '', url: 'about:blank' },
    ], {
      Browser: 'Chrome/123',
      'User-Agent': 'Mozilla/5.0 Electron/33.4.11',
    });

    expect(model.schema).toBe('chrome-cdp-ex.list.v1');
    expect(model.targetCount).toBe(2);
    expect(model.prefixLength).toBeGreaterThan(8);
    expect(model.browser).toMatchObject({ product: 'Chrome/123', electron: '33.4.11' });
    expect(model.pages[0]).toMatchObject({
      index: 1,
      targetId: 'AABBCCDD11223344',
      title: 'Dashboard',
      url: 'https://example.com/app',
      isBlank: false,
    });
    expect(model.pages[0].targetPrefix.length).toBe(model.prefixLength);
    expect(model.pages[1]).toMatchObject({
      index: 2,
      title: '(blank tab)',
      url: 'about:blank',
      isBlank: true,
    });
    expect(model.nextSteps).toEqual([
      'cdp list --format json',
      'cdp text <target-from-list> --auto',
      'cdp perceive <target-from-list> --cards',
    ]);
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'pick-target',
      run: 'cdp list --format json',
      after: 'cdp text <target-from-list> --auto',
      evidence: 'cdp perceive <target-from-list> --cards',
      requiresUserAction: false,
      consentRequired: false,
    });
    expect(model.recommendation.commands).toEqual(model.nextSteps);
  });

  it('recommends and ranks non-blank pages ahead of blank tabs', () => {
    const model = T.buildPageListModel([
      { targetId: 'AABBCCDD11223344', type: 'page', title: '', url: 'about:blank' },
      { targetId: 'EEFF001122334455', type: 'page', title: 'Dashboard', url: 'https://example.com/app' },
    ]);
    expect(model.pages[0]).toMatchObject({ isBlank: false, title: 'Dashboard', recommended: true });
    expect(model.pages[1]).toMatchObject({ isBlank: true });
    expect(model.recommended).toMatchObject({
      targetPrefix: model.pages[0].targetPrefix,
      url: 'https://example.com/app',
    });
    expect(model.recommendation).toMatchObject({
      stage: 'pick-target',
      run: 'cdp list --format json',
    });
    expect(model.nextSteps[0]).toBe('cdp list --format json');
  });

  it('builds an empty list JSON model with an open next step', () => {
    const model = T.buildPageListModel([]);

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.list.v1',
      targetCount: 0,
      prefixLength: 8,
      pages: [],
      nextSteps: ['cdp open https://example.com'],
    });
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'open-page',
      targetPrefix: null,
      run: 'cdp open https://example.com',
      after: 'cdp text <target-from-open> --auto',
      requiresUserAction: false,
      consentRequired: false,
    });
  });

  it('should format page with id prefix, title, url', () => {
    const result = formatPageList([{
      targetId: 'AABBCCDD11223344',
      title: 'Test Page',
      url: 'https://example.com',
    }]);
    expect(result).toContain('AABBCCDD');
    expect(result).toContain('Test Page');
    expect(result).toContain('https://example.com');
  });

  it('should truncate long titles to 54 chars', () => {
    const longTitle = 'A'.repeat(80);
    const result = formatPageList([{
      targetId: 'AABBCCDD11223344',
      title: longTitle,
      url: 'https://x.com',
    }]);
    // Title column is 54 chars wide
    expect(result).not.toContain('A'.repeat(55));
  });

  it('should align columns for multiple pages', () => {
    const pages = [
      { targetId: 'AAAA1111XXXX', title: 'Page A', url: 'https://a.com' },
      { targetId: 'BBBB2222YYYY', title: 'Page B', url: 'https://b.com' },
    ];
    const lines = formatPageList(pages).split('\n');
    expect(lines).toHaveLength(2);
    // Both lines should have same structure
    expect(lines[0]).toContain('Page A');
    expect(lines[1]).toContain('Page B');
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// navStr (with CDP mock)
// =========================================================================

describe('navStr', () => {
  it('should navigate and return confirmation', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ loaderId: 'loader1' }),
      'event:Page.loadEventFired': () => ({}),
      'Runtime.evaluate': () => ({
        result: { value: JSON.stringify({ url: 'https://example.com', readyState: 'complete' }) },
      }),
    });
    const result = await navStr(cdp, 'sid1', 'https://example.com');
    expect(result).toBe('Navigated to https://example.com');
  });

  it('should throw on errorText from Page.navigate', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
    });
    await expect(navStr(cdp, 'sid1', 'https://bad.invalid'))
      .rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
  });

  it('cancels the load waiter when Page.navigate throws', async () => {
    let cancelled = false;
    const cdp = {
      send(method) {
        if (method === 'Page.navigate') {
          return Promise.reject(new Error('CDP websocket closed while waiting for Page.navigate'));
        }
        return Promise.resolve({});
      },
      waitForEvent() {
        return {
          promise: new Promise(() => {}),
          cancel() { cancelled = true; },
        };
      },
    };

    const started = Date.now();
    await expect(navStr(cdp, 'sid1', 'https://example.com'))
      .rejects.toThrow(/websocket closed while waiting for Page\.navigate/);
    expect(cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('should reject non-http URLs', async () => {
    const cdp = createMockCDP({});
    await expect(navStr(cdp, 'sid1', 'file:///etc/passwd'))
      .rejects.toThrow(/Only http/);
  });

  it('should reject metadata URLs', async () => {
    const cdp = createMockCDP({});
    await expect(navStr(cdp, 'sid1', 'http://169.254.169.254/'))
      .rejects.toThrow(/metadata/i);
  });

  it('completes when Page.navigate hangs but the same target already shows the destination URL', async () => {
    let cancelled = false;
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => new Promise(() => {}),
      'Target.getTargets': () => ({
        targetInfos: [{
          targetId: 'TARGET-A',
          type: 'page',
          url: 'https://example.org/',
        }],
      }),
      'Runtime.evaluate': () => ({ result: { value: 'complete' } }),
    });
    const innerWait = cdp.waitForEvent.bind(cdp);
    cdp.waitForEvent = (method, timeout) => {
      const waiter = innerWait(method, timeout);
      return {
        promise: waiter.promise,
        cancel() {
          cancelled = true;
          waiter.cancel();
        },
      };
    };

    const started = Date.now();
    const result = await navStr(cdp, 'sid1', 'https://example.org/', {
      targetId: 'TARGET-A',
      observeDelayMs: 0,
    });
    expect(result).toBe('Navigated to https://example.org/');
    expect(Date.now() - started).toBeLessThan(300);
    expect(cancelled).toBe(true);
    expect(cdp.calls.some(call => call.method === 'Target.getTargets' && call.sessionId == null)).toBe(true);
    expect(cdp.calls.some(call => call.method === 'Target.attachToTarget')).toBe(false);
  });

  it('does not treat a different page URL as the bound target navigating', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout: Page.navigate')), 20);
      }),
      'Target.getTargets': () => ({
        targetInfos: [
          { targetId: 'TARGET-A', type: 'page', url: 'about:blank' },
          { targetId: 'OTHER', type: 'page', url: 'https://example.org/' },
        ],
      }),
    });

    const started = Date.now();
    await expect(navStr(cdp, 'sid1', 'https://example.org/', {
      targetId: 'TARGET-A',
      observeDelayMs: 0,
    })).rejects.toThrow(/Timeout: Page\.navigate/);
    expect(Date.now() - started).toBeLessThan(400);
    expect(cdp.calls.some(call => call.method === 'Target.attachToTarget')).toBe(false);
  });

  it('does not treat a still-blank same target as navigated', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout: Page.navigate')), 20);
      }),
      'Target.getTargets': () => ({
        targetInfos: [{
          targetId: 'TARGET-A',
          type: 'page',
          url: 'about:blank',
        }],
      }),
    });

    await expect(navStr(cdp, 'sid1', 'https://example.org/', {
      targetId: 'TARGET-A',
      observeDelayMs: 0,
    })).rejects.toThrow(/Timeout: Page\.navigate/);
    expect(cdp.calls.some(call => call.method === 'Target.attachToTarget')).toBe(false);
  });

  it('rebinds only the same targetId when the hung session cannot probe document ready', async () => {
    const sessions = [];
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => new Promise(() => {}),
      'Target.getTargets': () => ({
        targetInfos: [{
          targetId: 'TARGET-A',
          type: 'page',
          url: 'https://example.org/',
        }],
      }),
      'Runtime.evaluate': (_params, sid) => {
        if (sid === 'old-sid') return Promise.reject(new Error('session closed'));
        return { result: { value: 'complete' } };
      },
      'Target.attachToTarget': (params) => {
        expect(params).toEqual({ targetId: 'TARGET-A', flatten: true });
        return { sessionId: 'new-sid' };
      },
    });

    const started = Date.now();
    const result = await navStr(cdp, 'old-sid', 'https://example.org/', {
      targetId: 'TARGET-A',
      observeDelayMs: 0,
      readyTimeoutMs: 80,
      probeTimeoutMs: 20,
      onSessionId(nextSid) { sessions.push(nextSid); },
    });
    expect(result).toBe('Navigated to https://example.org/');
    expect(sessions).toEqual(['new-sid']);
    expect(Date.now() - started).toBeLessThan(400);
    const attachCalls = cdp.calls.filter(call => call.method === 'Target.attachToTarget');
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].params.targetId).toBe('TARGET-A');
    expect(attachCalls[0].sessionId == null).toBe(true);
  });
});

// =========================================================================
// reloadStr (with CDP mock)
// =========================================================================

describe('reloadStr', () => {
  it('enables Page events before reloading', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.reload': () => ({}),
      'event:Page.loadEventFired': () => ({}),
    });

    const result = await reloadStr(cdp, 'sid1');

    expect(result).toBe('Page reloaded');
    expect(cdp.calls.map(call => call.method).slice(0, 2)).toEqual(['Page.enable', 'Page.reload']);
  });

  it('falls back to document readiness when reload load event is absent', async () => {
    const calls = [];
    let loadEventTimeout;
    let reloadDispatchTimeout;
    const cdp = {
      calls,
      send(method, params = {}, sessionId, timeout) {
        calls.push({ method, params, sessionId });
        if (method === 'Page.reload') reloadDispatchTimeout = timeout;
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: 'complete' } });
        return Promise.resolve({});
      },
      waitForEvent(_method, timeout) {
        loadEventTimeout = timeout;
        return {
          promise: new Promise(() => {}),
          cancel() {},
        };
      },
    };

    const result = await Promise.race([
      reloadStr(cdp, 'sid1'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(result).toBe('Page reloaded');
    expect(reloadDispatchTimeout).toBeLessThanOrEqual(2000);
    expect(loadEventTimeout).toBeLessThanOrEqual(5000);
    expect(calls.map(call => call.method)).toEqual(['Page.enable', 'Page.reload', 'Runtime.evaluate']);
  });

  it('bounds reload dispatch and readiness probes for live-session latency', async () => {
    const calls = [];
    let loadEventTimeout;
    let reloadDispatchTimeout;
    const cdp = {
      calls,
      send(method, params = {}, sessionId, timeout) {
        calls.push({ method, params, sessionId, timeout });
        if (method === 'Page.reload') reloadDispatchTimeout = timeout;
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: 'complete' } });
        return Promise.resolve({});
      },
      waitForEvent(_method, timeout) {
        loadEventTimeout = timeout;
        return {
          promise: new Promise(() => {}),
          cancel() {},
        };
      },
    };

    await expect(reloadStr(cdp, 'sid1')).resolves.toBe('Page reloaded');

    const readyProbe = calls.find(call => call.method === 'Runtime.evaluate');
    expect(reloadDispatchTimeout).toBeLessThanOrEqual(1000);
    expect(loadEventTimeout).toBeLessThanOrEqual(1000);
    expect(readyProbe.timeout).toBeLessThanOrEqual(500);
  });

  it('continues after a Page.reload dispatch timeout', async () => {
    const cdp = {
      calls: [],
      send(method, params = {}, sessionId) {
        cdp.calls.push({ method, params, sessionId });
        if (method === 'Page.reload') return Promise.reject(new Error('Timeout: Page.reload'));
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: 'complete' } });
        return Promise.resolve({});
      },
      waitForEvent() {
        return {
          promise: new Promise(() => {}),
          cancel() {},
        };
      },
    };

    await expect(reloadStr(cdp, 'sid1')).resolves.toBe('Page reloaded');
    expect(cdp.calls.map(call => call.method)).toEqual(['Page.enable', 'Page.reload', 'Runtime.evaluate']);
  });

  it('observes reload completion with a short lightweight page probe', async () => {
    let evaluateTimeout;
    const cdp = createMockCDP({
      'Runtime.evaluate': (params, _sid) => {
        evaluateTimeout = cdp.calls.at(-1)?.timeout;
        expect(params.expression).toContain('document.readyState');
        return {
          result: {
            value: JSON.stringify({
              title: 'Smoke',
              url: 'https://example.test/app',
              readyState: 'complete',
            }),
          },
        };
      },
    });

    const out = await observeReloadPage(cdp, 'sid1');

    expect(evaluateTimeout).toBeLessThanOrEqual(2000);
    expect(out).toContain('Reload observation');
    expect(out).toContain('Page: Smoke');
    expect(out).toContain('URL: https://example.test/app');
    expect(out).toContain('Ready state: complete');
  });

  it('invalidates refs immediately after reload action dispatch', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.reload': () => ({}),
      'event:Page.loadEventFired': () => ({}),
    });
    const session = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid1' });
    session.refs.map.set(1, 101);
    session.refs.generation = 1;
    session.refs.invalidationReason = null;
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const navBuf = new RingBuffer(10);
    const netReqBuf = new RingBuffer(10);
    const pendingReqs = new Map([['r1', { url: '/api' }]]);
    const lastReadSeq = { console: 0, exception: 0, nav: 0 };
    consoleBuf.push({ text: 'before reload' });
    navBuf.push({ url: 'https://example.test/before' });

    const out = await reloadActionDispatch({
      cdp,
      sessionId: 'sid1',
      session,
      consoleBuf,
      exceptionBuf,
      navBuf,
      netReqBuf,
      pendingReqs,
      lastReadSeq,
    });

    expect(out).toContain('Page reloaded');
    expect(session.refs.map.size).toBe(0);
    expect(session.refs.invalidationReason).toBe('navigation');
    expect(pendingReqs.size).toBe(0);
    // #610: the console ring keeps the pre-reload line. Reads are cut at this
    // reload, so it is not a current-document entry. Navigation is still cleared.
    expect(consoleBuf.all().map(entry => entry.text)).toEqual(['before reload']);
    expect(await T.consoleStr(consoleBuf, exceptionBuf, lastReadSeq, '--all')).toBe('Console buffer is empty');
    expect(navBuf.all()).toEqual([]);
  });
});

// =========================================================================
// formatPageList — about:blank labelling (P2 polish)
// =========================================================================

describe('formatPageList about:blank', () => {
  it('labels about:blank pages with "(blank tab)" so agents can still target them', () => {
    const out = T.formatPageList([
      { targetId: 'ABCDEF1234567890', type: 'page', title: '', url: 'about:blank' },
    ]);
    expect(out).toContain('(blank tab)');
    expect(out).toContain('about:blank');
    expect(out).toContain('ABCDEF12');
  });
});
