import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issues #237-#239 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('#237 responsive-audit restores the original viewport after the last audited size', async () => {
    const sizes = [];
    let current = { w: 1042, h: 632 };
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-responsive-viewport-'));
    const session = T.createSessionState({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    T.resetScreenshotTier();
    const cdp = {
      send(method, params = {}) {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          sizes.push(`${params.width}x${params.height}`);
          current = { w: params.width, h: params.height };
          return Promise.resolve({});
        }
        // #533: with no session viewport override the audit clears the override instead of re-setting one.
        if (method === 'Emulation.clearDeviceMetricsOverride') {
          sizes.push('clear');
          current = { w: 1042, h: 632 };
          return Promise.resolve({});
        }
        if (method === 'Page.captureScreenshot') {
          return Promise.resolve({ data: TINY_PNG });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify(current) } });
          }
          if (expr.includes('document.title')) {
            return Promise.resolve({
              result: { value: JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', contentType: 'text/html' }) },
            });
          }
          if (expr.includes('devicePixelRatio')) {
            return Promise.resolve({ result: { value: 1 } });
          }
          if (expr.includes('overflowX') || expr.includes('clippedControls')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  url: 'https://example.com/',
                  title: 'Example Domain',
                  viewport: `${current.w}x${current.h}`,
                  scroll: { width: current.w, height: current.h, clientWidth: current.w, clientHeight: current.h },
                  overflowX: false,
                  controlCount: 1,
                  controls: [{ tag: 'a', text: 'More information...' }],
                  controlsTruncated: false,
                  maxControls: 12,
                  clippedControls: [],
                  overlaps: [],
                  pageHealthSignals: {
                    url: 'https://example.com/',
                    readyState: 'complete',
                    visibleTextLength: 40,
                    elementCount: 12,
                    visibleControlCount: 1,
                    bodyRect: { width: current.w, height: current.h },
                  },
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: JSON.stringify({ retry: false }) } });
        }
        return Promise.resolve({});
      },
    };
    try {
      const out = await T.responsiveAuditStr(
        cdp,
        'sid',
        session,
        '1D3669785EAC5A1A211792636BAE8A07',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        ['--viewport', '800x600', '--format', 'json'],
      );
      const model = JSON.parse(out);
      expect(model.schema).toBe('chrome-cdp-ex.responsive-audit.v1');
      expect(model.verdict).toBe('pass');
      expect(sizes[0]).toBe('800x600');
      expect(sizes.at(-1)).toBe('clear');
      expect(current).toEqual({ w: 1042, h: 632 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#237 responsive-audit restores the original viewport after a screenshot timeout', async () => {
    const sizes = [];
    let current = { w: 1042, h: 632 };
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-responsive-timeout-'));
    const session = T.createSessionState({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    T.resetScreenshotTier();
    const cdp = {
      send(method, params = {}) {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          sizes.push(`${params.width}x${params.height}`);
          current = { w: params.width, h: params.height };
          return Promise.resolve({});
        }
        // #533: with no session viewport override the audit clears the override instead of re-setting one.
        if (method === 'Emulation.clearDeviceMetricsOverride') {
          sizes.push('clear');
          current = { w: 1042, h: 632 };
          return Promise.resolve({});
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('Timeout: Page.captureScreenshot');
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify(current) } });
          }
          if (expr.includes('document.title')) {
            return Promise.resolve({
              result: { value: JSON.stringify({ title: 'Example Domain', url: 'https://example.com/', contentType: 'text/html' }) },
            });
          }
          if (expr.includes('overflowX') || expr.includes('clippedControls')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  url: 'https://example.com/',
                  title: 'Example Domain',
                  viewport: `${current.w}x${current.h}`,
                  overflowX: false,
                  controlCount: 0,
                  controls: [],
                  clippedControls: [],
                  overlaps: [],
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        return Promise.resolve({});
      },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    try {
      await expect(T.responsiveAuditStr(
        cdp,
        'sid',
        session,
        '1D3669785EAC5A1A211792636BAE8A07',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        ['--viewport', '800x600'],
      )).rejects.toThrow(/Screenshot failed: all methods timed out|Timeout: Page\.captureScreenshot/);
      expect(sizes[0]).toBe('800x600');
      expect(sizes.at(-1)).toBe('clear');
      expect(current).toEqual({ w: 1042, h: 632 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#238 click --qa on a Chrome PDF viewer emits pdf-viewer.v1, not pass/populated', () => {
    const dump = T.formatPdfViewerOutput(PDF_PAGE, { targetPrefix: PDF_PREFIX });
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: PDF_TARGET_ID,
        input: 'body',
        label: 'body',
        page: PDF_PAGE,
      },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 5361 },
      effects: {
        page: PDF_PAGE,
        pageHealth: {
          status: 'populated',
          isBlank: false,
          confidence: 'high',
          evidence: {
            url: PDF_PAGE.url,
            title: '',
            visibleTextLength: 0,
            elementCount: 4,
            visibleControlCount: 0,
            bodyRect: { width: 800, height: 0 },
            changed: true,
          },
        },
        domDiff: dump,
        console: [],
        network: [],
      },
    });

    const text = T.formatActionResultOutput(result, { qa: true });
    expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(text).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(text).not.toMatch(/QA summary: pass/);
    expect(text).not.toMatch(/Page health: populated/);
    expect(text).not.toMatch(/Changed: changed/);
    expect(text).not.toContain('<target>');
    expect(text).not.toMatch(/cdp perceive /);

    const parsed = JSON.parse(T.formatActionResultOutput(result, { qa: true, format: 'json' }));
    expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(parsed.nextCommand).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(parsed).not.toMatchObject({ ok: true });
    expect(parsed.summary?.pageHealth?.status).not.toBe('populated');
  });

  it('#239 action PDF Next interpolates the prefix and misses do not recommend perceive', async () => {
    expect(T.actionObservationPerceiveOpts(PDF_TARGET_ID)).toMatchObject({ targetPrefix: PDF_PREFIX });
    expect(T.actionObservationPerceiveOpts(PDF_TARGET_ID, { sinceAction: true }).targetPrefix).toBe(PDF_PREFIX);

    const printed = T.formatPdfViewerOutput(PDF_PAGE, { targetPrefix: PDF_PREFIX });
    expect(printed).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(printed).not.toContain('<target>');

    const cdp = {
      send(method) {
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: '',
                url: PDF_PAGE.url,
                contentType: 'application/pdf',
                vw: 800,
                vh: 600,
                scrollY: 0,
                scrollMax: 0,
                counts: {},
                focused: '',
                layoutMap: {},
                styleHints: {},
                cursorInteractives: [],
                visibleControls: [],
                visibleControlsTruncated: false,
                cardWindows: [],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [] });
        }
        return Promise.resolve({});
      },
    };
    const observed = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null },
      T.actionObservationPerceiveOpts(PDF_TARGET_ID),
    );
    expect(observed).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(observed).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(observed).not.toContain('<target>');

    const hit = T.formatActionResultOutput(T.createActionResult({
      action: 'viewport',
      target: { targetId: PDF_TARGET_ID, input: '1042x632', resolvedBy: 'viewport', page: PDF_PAGE },
      dispatch: { ok: true, method: 'viewport' },
      settle: { ok: true, durationMs: 947 },
      effects: { page: PDF_PAGE, domDiff: observed, console: [], network: [] },
    }), { dispatchText: observed });
    expect(hit).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(hit).not.toContain('<target>');

    const miss = T.formatActionFailure(new Error('Element not found: a'), {
      action: 'click',
      target: {
        targetId: PDF_TARGET_ID,
        input: 'a',
        page: PDF_PAGE,
      },
    });
    expect(miss).toMatch(/Kind: selector/);
    expect(miss).toContain(`Next: cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(miss).not.toMatch(/cdp perceive /);
    expect(miss).not.toContain('<target>');
    expect(miss).not.toContain(PDF_TARGET_ID);

    const htmlMiss = T.formatActionFailure(new Error('Element not found: a'), {
      action: 'click',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'a',
        page: { title: 'Example Domain', url: 'https://example.com/', contentType: 'text/html' },
      },
    });
    expect(htmlMiss).toMatch(/Next: cdp perceive /);
    expect(htmlMiss).not.toMatch(/document\.contentType/);
  });
});

describe('issues #241-#243 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('outerHTML')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  ok: true,
                  root: 'document',
                  html: '<html><head><link rel="stylesheet" href="chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css"></head><body></body></html>',
                }),
              },
            });
          }
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('screenshot should not run on pdf-viewer qa');
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax should not run on pdf-viewer qa');
        }
        if (method === 'Emulation.setDeviceMetricsOverride') {
          throw new Error('viewport should not change on pdf-viewer qa');
        }
        return Promise.resolve({});
      },
    };
  }

  it('#241 qa on a Chrome PDF viewer emits pdf-viewer.v1, not Verdict:pass / perceive', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-qa-pdf-'));
    const session = T.createSessionState({
      targetId: PDF_TARGET_ID,
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    const cdp = pdfPageCdp();
    const ctx = {
      cdp,
      sid: 'sid',
      session,
      targetId: PDF_TARGET_ID,
      consoleBuf: new T.RingBuffer(8),
      exceptionBuf: new T.RingBuffer(8),
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      actionFeedback: async () => '',
    };
    try {
      const text = await T.qaPageStr(ctx, []);
      expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(text).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(text).not.toMatch(/Verdict: pass/);
      expect(text).not.toMatch(/cdp perceive /);
      expect(text).not.toContain('chrome-extension://');
      expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
      expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);
      expect(cdp.calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride')).toBe(false);

      const parsed = JSON.parse(await T.qaPageStr(ctx, ['--format', 'json']));
      expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
      expect(parsed.nextCommand).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(parsed.verdict).not.toBe('pass');
      expect(JSON.stringify(parsed)).not.toMatch(/cdp perceive /);
      expect(parsed.nextSteps || []).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/cdp perceive /),
      ]));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#242 html on a Chrome PDF viewer emits pdf-viewer.v1, not the empty embedder shell', async () => {
    const cdp = pdfPageCdp();
    await expect(T.htmlStr(cdp, 'sid', [], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.htmlStr(cdp, 'sid', ['--auto'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);
    await expect(T.htmlStr(cdp, 'sid', ['h1'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/pdf-viewer\.v1/);
    expect(cdp.calls.some(call => String(call.params?.expression || '').includes('outerHTML'))).toBe(false);

    let thrown;
    try {
      await T.htmlStr(cdp, 'sid', ['h1'], { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('<target>');
    expect(thrown.message).not.toContain('chrome-extension://');
    expect(thrown.message).not.toMatch(/Kind: unknown/);
    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'html',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(recovery.run).not.toMatch(/cdp status /);

    const htmlPage = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        const expr = String(params.expression || '');
        if (expr.includes('contentType') || expr.includes('document.title')) {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Example Domain',
                url: 'https://example.com/',
                contentType: 'text/html',
              }),
            },
          });
        }
        return Promise.resolve({
          result: { value: JSON.stringify({ ok: false, root: 'document', selector: 'h1' }) },
        });
      },
    };
    await expect(T.htmlStr(htmlPage, 'sid', ['h1'], { targetPrefix: '1D366978' }))
      .rejects.toThrow(/cdp eval 1D366978 /);
    const htmlMiss = await T.htmlStr(htmlPage, 'sid', ['h1'], { targetPrefix: '1D366978' })
      .then(() => {
        throw new Error('expected html selector miss');
      }, error => error);
    expect(htmlMiss.message).not.toContain('<target>');
  });

  it('#243 cookiedel of a dotted-domain cookie deletes by domain/path or fails closed', async () => {
    expect(T.cookieDeleteParams(
      { name: 'picky10x', domain: '.huggingface.co', path: '/' },
      'https://huggingface.co/',
    )).toEqual({ name: 'picky10x', domain: '.huggingface.co', path: '/' });
    expect(T.cookieDeleteParams(
      { name: 'picky10x', domain: '.huggingface.co', path: '/' },
      'https://huggingface.co/',
    )).not.toHaveProperty('url');

    const jar = [{ name: 'picky10x', value: 'x', domain: '.huggingface.co', path: '/', secure: true }];
    const calls = [];
    const cdp = {
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'https://huggingface.co/' } });
        }
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: jar.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') {
          const idx = jar.findIndex(cookie => cookie.name === params.name
            && cookie.domain === params.domain
            && cookie.path === params.path);
          if (idx !== -1) jar.splice(idx, 1);
          return Promise.resolve({});
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const deleted = await T.cookieDelStr(cdp, 'sid', 'picky10x');
    expect(deleted).toBe('Cookie deleted: picky10x');
    expect(jar).toEqual([]);
    const del = calls.find(call => call.method === 'Network.deleteCookies');
    expect(del.params).toEqual({ name: 'picky10x', domain: '.huggingface.co', path: '/' });
    expect(del.params).not.toHaveProperty('url');
    expect(calls.some(call => call.method === 'Runtime.evaluate')).toBe(false);

    const leftover = [{ name: 'picky10x', value: 'x', domain: '.huggingface.co', path: '/' }];
    const leftoverCalls = [];
    const leftoverCdp = {
      send(method, params = {}) {
        leftoverCalls.push({ method, params });
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: leftover.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') return Promise.resolve({});
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(T.cookieDelStr(leftoverCdp, 'sid', 'picky10x'))
      .rejects.toThrow(/Cookie still present: picky10x/);
    expect(leftoverCalls.some(call => call.method === 'Network.deleteCookies')).toBe(true);
    const leftoverRecovery = T.buildCliErrorRecovery('Cookie still present: picky10x', {
      cmd: 'cookiedel',
      targetPrefix: '6914C171',
    });
    expect(leftoverRecovery.kind).toBe('usage');
    expect(leftoverRecovery.run).toBe('cdp cookies 6914C171');
    const leftoverFormatted = T.formatCliError(new Error('Cookie still present: picky10x'), {
      cmd: 'cookiedel',
      targetPrefix: '6914C171',
    });
    expect(leftoverFormatted).toMatch(/Kind: usage/);
    expect(leftoverFormatted).not.toMatch(/Cookie deleted/);

    const hostJar = [{ name: 'picky10y', value: 'y', domain: 'huggingface.co', path: '/' }];
    const hostCdp = {
      send(method, params = {}) {
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: hostJar.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') {
          const idx = hostJar.findIndex(cookie => cookie.name === params.name
            && cookie.domain === params.domain);
          if (idx !== -1) hostJar.splice(idx, 1);
          return Promise.resolve({});
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(T.cookieDelStr(hostCdp, 'sid', 'picky10y')).resolves.toBe('Cookie deleted: picky10y');
    expect(hostJar).toEqual([]);
  });
});

describe('issues #245-#248 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('getComputedStyle') || expr.includes('keep')) {
            throw new Error('styles should not read embedder computed styles on pdf-viewer');
          }
          if (expr.includes('{w:window.innerWidth') && expr.includes('innerHeight')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('screenshot should not run on pdf-viewer visual-check');
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax should not run on pdf-viewer snap');
        }
        if (method === 'Emulation.setDeviceMetricsOverride') {
          throw new Error('viewport should not change on pdf-viewer visual-check');
        }
        return Promise.resolve({});
      },
    };
  }

  it('#245 visual-check on a Chrome PDF viewer emits pdf-viewer.v1 without screenshots or leftover viewport', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-visual-pdf-'));
    const session = T.createSessionState({
      targetId: PDF_TARGET_ID,
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
    const cdp = pdfPageCdp();
    try {
      await expect(T.responsiveAuditStr(
        cdp,
        'sid',
        session,
        PDF_TARGET_ID,
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        ['--viewport', '800x600'],
      )).rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);

      let thrown;
      try {
        await T.responsiveAuditStr(
          cdp,
          'sid',
          session,
          PDF_TARGET_ID,
          new T.RingBuffer(8),
          new T.RingBuffer(8),
          ['--viewport', '800x600'],
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.code).toBe('pdf_viewer');
      expect(thrown.message).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(thrown.message).not.toMatch(/cdp shot /);
      expect(thrown.message).not.toMatch(/cdp perceive /);
      expect(thrown.message).not.toMatch(/Use `perceive`/);
      expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
      expect(cdp.calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride')).toBe(false);

      const recovery = T.buildCliErrorRecovery(thrown.message, {
        cmd: 'visual-check',
        targetPrefix: PDF_PREFIX,
        err: thrown,
      });
      expect(recovery.kind).toBe('pdf-viewer');
      expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(recovery.run).not.toMatch(/cdp shot /);
      expect(recovery.run).not.toMatch(/cdp perceive /);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#246 snap on a Chrome PDF viewer emits pdf-viewer.v1, not an empty tree plus perceive', async () => {
    const cdp = pdfPageCdp();
    await expect(T.snapshotStr(cdp, 'sid', true, { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.snapshotStr(cdp, 'sid', false, { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.snapshotStr(cdp, 'sid', true, { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toMatch(/Use `perceive`/);
    expect(thrown.message).not.toMatch(/recommended starting command/);
    expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'snap',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(recovery.run).not.toMatch(/cdp perceive /);
  });

  it('#247 styles on a Chrome PDF viewer emits pdf-viewer.v1, not embedder BODY/HTML styles', async () => {
    const cdp = pdfPageCdp();
    await expect(T.stylesStr(cdp, 'sid', ['body'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.stylesStr(cdp, 'sid', ['html'], { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.stylesStr(cdp, 'sid', ['body'], { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('Times New Roman');
    expect(thrown.message).not.toContain('rgb(40, 40, 40)');
    expect(thrown.message).not.toMatch(/<BODY>/);
    expect(cdp.calls.some(call => String(call.params?.expression || '').includes('getComputedStyle'))).toBe(false);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'styles',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);

    const htmlPage = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        const expr = String(params.expression || '');
        if (expr.includes('contentType') || expr.includes('document.title')) {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Example Domain',
                url: 'https://example.com/',
                contentType: 'text/html',
              }),
            },
          });
        }
        return Promise.resolve({
          result: { value: JSON.stringify({ ok: false, root: 'document', selector: 'h1' }) },
        });
      },
    };
    const miss = await T.stylesStr(htmlPage, 'sid', ['h1'], { targetPrefix: '1D366978' })
      .then(() => {
        throw new Error('expected styles selector miss');
      }, error => error);
    expect(miss.message).toContain('cdp eval 1D366978');
    expect(miss.message).not.toContain('<target>');
  });

  it('#248 fill does not claim Filled/changed when the live textarea value stays empty', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('cdpFillLiveValue')) {
            return Promise.resolve({
              result: { value: { ok: true, tag: 'TEXTAREA', value: '', textContent: '' } },
            });
          }
          return Promise.resolve({
            result: { value: { ok: true, fillable: true, tag: 'TEXTAREA' } },
          });
        }
        if (method === 'Input.insertText') return Promise.resolve({});
        if (method === 'DOM.enable') return Promise.resolve({});
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 42 });
        if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj-textarea' } });
        if (method === 'Runtime.callFunctionOn') {
          if (!params.arguments) {
            return Promise.resolve({ result: { value: { ok: true, fillable: true, tag: 'TEXTAREA' } } });
          }
          return Promise.resolve({ result: { value: { tag: 'TEXTAREA', value: '' } } });
        }
        return Promise.resolve({});
      },
    };

    await expect(T.fillStr(cdp, 'sid', '#chat-assistant-textarea', 'picky11-no-submit', new Map()))
      .rejects.toThrow(/did not accept|live value is still empty/);
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(true);

    let thrown;
    try {
      await T.fillStr(cdp, 'sid', '#chat-assistant-textarea', 'picky11-no-submit', new Map());
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown?.message || '')).not.toMatch(/^Filled /);
    expect(String(thrown?.message || '')).not.toContain('Filled <TEXTAREA>');

    const failure = T.classifyActionFailure(thrown, {
      action: 'fill',
      target: { targetId: '77C5B4F8DEADBEEF', input: '#chat-assistant-textarea' },
    });
    expect(failure.kind).toBe('fill-no-change');
    expect(failure.nextCommand).toContain('cdp eval 77C5B4F8');
    expect(failure.nextCommand).not.toMatch(/cdp perceive /);

    const formatted = T.formatActionFailure(thrown, {
      action: 'fill',
      target: { targetId: '77C5B4F8DEADBEEF', input: '#chat-assistant-textarea' },
    });
    expect(formatted).not.toMatch(/^Filled /m);
    expect(formatted).toMatch(/Kind: fill-no-change/);
    expect(formatted).not.toMatch(/Outcome: changed/);

    expect(T.fillLiveValueAccepted({ ok: true, value: '', textContent: '' }, 'picky11-no-submit')).toBe(false);
    expect(T.fillLiveValueAccepted({ ok: true, value: 'picky11-control', textContent: '' }, 'picky11-control')).toBe(true);
  });

  it('#248 fill still reports Filled when the live node actually holds the value', async () => {
    const cdp = {
      send(method, params = {}) {
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('cdpFillLiveValue')) {
            return Promise.resolve({
              result: { value: { ok: true, tag: 'INPUT', value: 'picky11-control', textContent: '' } },
            });
          }
          return Promise.resolve({ result: { value: { ok: true, tag: 'INPUT' } } });
        }
        if (method === 'Input.insertText') return Promise.resolve({});
        if (method === 'Runtime.callFunctionOn') {
          throw new Error('native setter should not run when insertText stuck');
        }
        return Promise.resolve({});
      },
    };
    const out = await T.fillStr(cdp, 'sid', '#picky11in', 'picky11-control', new Map());
    expect(out).toContain('Filled <INPUT>');
    expect(out).toContain('picky11-control');
  });
});

describe('issues #250-#253 open contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('getComputedStyle') || expr.includes('querySelectorAll')) {
            throw new Error('should not inspect embedder DOM on pdf-viewer');
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'CSS.getComputedStyleForNode' || method === 'CSS.getMatchedStylesForNode') {
          throw new Error('cascade should not read embedder computed styles on pdf-viewer');
        }
        if (method === 'DOM.getDocument' || method === 'DOM.querySelector') {
          throw new Error('cascade should not query embedder DOM on pdf-viewer');
        }
        return Promise.resolve({});
      },
    };
  }

  it('#250 perceive --qa/--summary and summary on a Chrome PDF viewer emit pdf-viewer.v1', async () => {
    const emptyBuffer = { all: () => [] };
    const handler = T.createPerceiveCommandHandler({
      cdp: pdfPageCdp(),
      sessionId: 'sid',
      targetId: PDF_TARGET_ID,
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({ targetId: PDF_TARGET_ID, url: PDF_PAGE.url }),
        readPerceiveDocumentState: async () => ({ url: PDF_PAGE.url, readyState: 'complete' }),
        pageInfoModel: async () => PDF_PAGE,
        collectPageHealth: async () => {
          throw new Error('qa health should not run on pdf-viewer perceive');
        },
        perceiveText: async () => {
          throw new Error('perceive tree should not run on pdf-viewer qa');
        },
      },
    });

    for (const args of [['--qa'], ['--summary']]) {
      const text = (await handler({ args })).value;
      expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(text).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
      expect(text).not.toMatch(/QA summary:/);
      expect(text).not.toMatch(/Page health: indeterminate/);
      expect(text).not.toMatch(/cdp report /);
      expect(text).not.toContain('<target>');
    }

    const parsed = JSON.parse((await handler({ args: ['--qa', '--format', 'json'] })).value);
    expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(parsed.nextCommand).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(parsed.summary?.schema).not.toBe('chrome-cdp-ex.qa-summary.v1');
    expect(JSON.stringify(parsed)).not.toMatch(/cdp report /);
    expect(JSON.stringify(parsed)).not.toContain('<target>');

    const htmlHandler = T.createPerceiveCommandHandler({
      cdp: { send() { throw new Error('unexpected CDP command'); } },
      sessionId: 'sid',
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({
          targetId: '1D3669785EAC5A1A211792636BAE8A07',
          url: 'https://example.com/',
        }),
        readPerceiveDocumentState: async () => ({ url: 'https://example.com/', readyState: 'complete' }),
        pageInfoModel: async () => ({
          title: 'Example Domain',
          url: 'https://example.com/',
          contentType: 'text/html',
        }),
        collectPageHealth: async () => ({
          status: 'populated',
          isBlank: false,
          evidence: { url: 'https://example.com/', title: 'Example Domain' },
        }),
        perceiveText: async () => 'Example Domain body',
      },
    });
    const htmlQa = (await htmlHandler({ args: ['--qa'] })).value;
    expect(htmlQa).toMatch(/QA summary: pass/);
    expect(htmlQa).toContain('Example Domain');
    expect(htmlQa).not.toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(htmlQa).toContain('cdp report 1D366978');

    const cdp = pdfPageCdp();
    await expect(T.summaryStr(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.summaryModel(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.summaryStr(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('<target>');
    expect(thrown.message).not.toMatch(/Interactive: none/);
    expect(thrown.message).not.toMatch(/cdp report /);
    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'summary',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
  });

  it('#251 cascade on a Chrome PDF viewer emits pdf-viewer.v1, not embedder BODY styles', async () => {
    const cdp = pdfPageCdp();
    await expect(T.cascadeStr(cdp, 'sid', 'body', 'color', new Map(), null, { targetPrefix: PDF_PREFIX }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
    await expect(T.cascadeStr(cdp, 'sid', 'body', null, new Map(), null, {
      format: 'json',
      targetPrefix: PDF_PREFIX,
    })).rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);

    let thrown;
    try {
      await T.cascadeStr(cdp, 'sid', 'body', 'color', new Map(), null, { targetPrefix: PDF_PREFIX });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).not.toContain('rgb(0, 0, 0)');
    expect(thrown.message).not.toContain('<target>');
    expect(cdp.calls.some(call => call.method === 'CSS.getComputedStyleForNode')).toBe(false);
    expect(cdp.calls.some(call => call.method === 'DOM.querySelector')).toBe(false);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'cascade',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);
  });

  it('#252 fullshot clip timeout does not poison viewport shot or claim captureScreenshot unavailable', async () => {
    expect(T.FULLSHOT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(T.FULLSHOT_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(T.screenshotCaptureUsesSessionTier({ format: 'png' })).toBe(true);
    expect(T.screenshotCaptureUsesSessionTier({
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1042, height: 4000, scale: 1 },
    })).toBe(false);
    expect(T.fullshotFitsViewport({ width: 1042, height: 632 }, { w: 1042, h: 632 })).toBe(true);
    expect(T.fullshotFitsViewport({ width: 1042, height: 4000 }, { w: 1042, h: 632 })).toBe(false);

    T.resetScreenshotTier();
    const clipCdp = {
      calls: [],
      send(method, params = {}, sessionId, timeout) {
        this.calls.push({ method, params, sessionId, timeout });
        if (method === 'Page.captureScreenshot') {
          throw new Error('Timeout: Page.captureScreenshot');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    await expect(T.captureScreenshot(clipCdp, 'sid', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1042, height: 4000, scale: 1 },
    })).rejects.toThrow(/all methods timed out|Timeout: Page\.captureScreenshot/);
    expect(T.getScreenshotTier()).toBe(1);

    const tmp = mkdtempSync(join(tmpdir(), 'cdp-fullshot-'));
    try {
      T.resetScreenshotTier();
      const viewportCdp = {
        calls: [],
        send(method, params = {}, sessionId, timeout) {
          this.calls.push({ method, params, sessionId, timeout });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('innerWidth')) {
              return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
            }
            return Promise.resolve({ result: { value: 1 } });
          }
          if (method === 'Page.getLayoutMetrics') {
            return Promise.resolve({ cssContentSize: { width: 1042, height: 632 } });
          }
          if (method === 'Page.captureScreenshot') {
            expect(params.captureBeyondViewport).not.toBe(true);
            expect(params.clip).toBeUndefined();
            return Promise.resolve({ data: Buffer.from('PNG').toString('base64') });
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      const out = await T.fullshotStr(viewportCdp, 'sid', join(tmp, 'full.png'), '1D3669785EAC5A1A211792636BAE8A07');
      expect(out).toMatch(/1042x632/);
      expect(out).not.toMatch(/not available/);
      expect(T.getScreenshotTier()).toBe(1);

      T.resetScreenshotTier();
      const tallCdp = {
        calls: [],
        send(method, params = {}, sessionId, timeout) {
          this.calls.push({ method, params, sessionId, timeout });
          if (method === 'Runtime.evaluate') {
            const expr = String(params.expression || '');
            if (expr.includes('innerWidth')) {
              return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
            }
            return Promise.resolve({ result: { value: 1 } });
          }
          if (method === 'Page.getLayoutMetrics') {
            return Promise.resolve({ cssContentSize: { width: 1042, height: 4000 } });
          }
          if (method === 'Page.captureScreenshot') {
            throw new Error('Timeout: Page.captureScreenshot');
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      await expect(T.fullshotStr(tallCdp, 'sid', join(tmp, 'tall.png'), '1D3669785EAC5A1A211792636BAE8A07'))
        .rejects.toThrow(/full-page capture timed out|untrusted/);
      const captureCall = tallCdp.calls.find(call => call.method === 'Page.captureScreenshot');
      expect(captureCall.params.captureBeyondViewport).toBe(true);
      expect(captureCall.timeout).toBe(T.FULLSHOT_TIMEOUT_MS);
      expect(T.getScreenshotTier()).toBe(1);

      const shotCdp = {
        calls: [],
        send(method, params = {}) {
          this.calls.push({ method, params });
          if (method === 'Page.captureScreenshot') {
            return Promise.resolve({ data: 'viewport-ok' });
          }
          return Promise.resolve({});
        },
        onEvent() { return () => {}; },
        waitForEvent() {
          return { promise: Promise.reject(new Error('timeout')), cancel() {} };
        },
      };
      const shot = await T.captureScreenshot(shotCdp, 'sid', { format: 'png' });
      expect(shot.data).toBe('viewport-ok');
      expect(shot.fallback).toBe(false);
      expect(shotCdp.calls[0].params.fromSurface).toBeUndefined();
      expect(T.getScreenshotTier()).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(T.diffShotScreenshotCaptureOptions()).toMatchObject({
      failFastOnTimeout: true,
      skipSanityRetry: true,
    });
  });

  it('#253 realistic click bounds mouse compositor-ack and still follows an <a href>', async () => {
    const events = [];
    await expect(T.dispatchClick({
      send(method, params = {}, _sessionId, timeoutMs) {
        if (method === 'Input.dispatchMouseEvent') {
          events.push({ ...params, timeoutMs });
          return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
        }
        return Promise.resolve({});
      },
    }, 'sid', 40, 20)).rejects.toThrow(/received no mousedown\/click events/);
    expect(events).toHaveLength(3);
    expect(events[0].timeoutMs).toBe(T.HOVER_MOUSE_ACK_TIMEOUT_MS);
    expect(events[1].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
    expect(events[2].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
    expect(events[0]).toMatchObject({ type: 'mouseMoved', button: 'none', buttons: 0, pointerType: 'mouse' });
    expect(events[1]).toMatchObject({ type: 'mousePressed', button: 'left', buttons: 1, pointerType: 'mouse' });
    expect(events[2]).toMatchObject({ type: 'mouseReleased', button: 'left', buttons: 0, pointerType: 'mouse' });

    let href = 'https://example.com/';
    let probeSeen = [];
    const cdp = {
      send(method, params = {}, _sessionId, timeout) {
        const src = method === 'Runtime.evaluate'
          ? String(params.expression || '')
          : String(params.functionDeclaration || '');
        if (src.includes('__chromeCdpExClickProbe')) {
          if (src.includes('installed: true')) {
            probeSeen = [];
            return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'top' } } });
          }
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen: probeSeen.slice() } } });
        }
        if (method === 'Runtime.evaluate') {
          if (String(params.expression) === 'location.href') {
            return Promise.resolve({ result: { value: href } });
          }
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                x: 40,
                y: 20,
                tag: 'A',
                text: 'Learn more',
                href: 'https://www.iana.org/help/example-domains',
                pageHref: 'https://example.com/',
              },
            },
          });
        }
        if (method === 'Input.dispatchMouseEvent') {
          if (params.type === 'mouseReleased') {
            href = 'https://www.iana.org/help/example-domains';
            if (!(Number(timeout) < T.CLICK_MOUSE_ACK_TIMEOUT_MS)) probeSeen.push('mousedown', 'click');
          }
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
    };
    await expect(T.clickStr(cdp, 'sid', 'a', new Map())).resolves.toBe('Clicked <A> "Learn more"');
    expect(href).toBe('https://www.iana.org/help/example-domains');
  });
});

describe('issues #255-#257 leftover contracts', () => {
  const PDF_TARGET_ID = '9FAD7C71E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = '9FAD7C71';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const emptyBuffer = { all: () => [] };
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pdfPageCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: JSON.stringify(PDF_PAGE) } });
          }
          if (expr.includes('innerWidth')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          if (expr.includes('chrome-cdp-ex.press-probe.v1')) {
            const installing = expr.includes("addEventListener('keydown'");
            return Promise.resolve({
              result: {
                value: {
                  marker: 'chrome-cdp-ex.press-probe.v1',
                  ok: true,
                  installed: true,
                  matched: !installing,
                  count: installing ? 0 : 1,
                },
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Page.captureScreenshot') {
          throw new Error('screenshot should not run on pdf-viewer fullshot');
        }
        if (method === 'Page.getLayoutMetrics') {
          throw new Error('layout metrics should not run on pdf-viewer fullshot');
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax should not run on pdf-viewer leftover perceive');
        }
        if (method === 'DOM.getDocument' || method === 'DOM.querySelector') {
          throw new Error('scoped DOM should not run on pdf-viewer leftover perceive');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
  }

  function pdfPerceiveHandler(overrides = {}) {
    return T.createPerceiveCommandHandler({
      cdp: pdfPageCdp(),
      sessionId: 'sid',
      targetId: PDF_TARGET_ID,
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({ targetId: PDF_TARGET_ID, url: PDF_PAGE.url }),
        readPerceiveDocumentState: async () => ({ url: PDF_PAGE.url, readyState: 'complete' }),
        pageInfoModel: async () => PDF_PAGE,
        collectPageHealth: async () => {
          throw new Error('qa health should not run on pdf-viewer leftover perceive');
        },
        perceiveText: async () => {
          throw new Error('perceive tree should not run on pdf-viewer leftover flags');
        },
        perceiveModel: async () => {
          throw new Error('perceive.v1 JSON should not run on pdf-viewer leftover flags');
        },
        ...overrides.ops,
      },
      ...overrides,
    });
  }

  it('#255 leftover perceive --cards/-s/--format json on a Chrome PDF viewer emit pdf-viewer.v1', async () => {
    const handler = pdfPerceiveHandler();
    const next = `cdp eval ${PDF_PREFIX} "document.contentType"`;

    for (const args of [['--cards'], ['--cards', '--format', 'json'], ['-s', 'body'], ['--format', 'json']]) {
      const raw = (await handler({ args })).value;
      if (args.includes('json')) {
        const parsed = JSON.parse(raw);
        expect(parsed.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
        expect(parsed.nextCommand).toBe(next);
        expect(JSON.stringify(parsed)).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
        expect(JSON.stringify(parsed)).not.toMatch(/chrome-cdp-ex\.perceive\.v1/);
        expect(JSON.stringify(parsed)).not.toMatch(/cdp click .*@ref/);
        expect(JSON.stringify(parsed)).not.toMatch(/cdp perceive .*--cards/);
      } else {
        expect(raw).toContain('chrome-cdp-ex.pdf-viewer.v1');
        expect(raw).toContain(next);
        expect(raw).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
        expect(raw).not.toMatch(/Interactive: none/);
        expect(raw).not.toMatch(/cdp click /);
        expect(raw).not.toMatch(/cdp perceive .*--cards/);
      }
    }

    for (const args of [['--qa'], ['--summary']]) {
      const text = (await handler({ args })).value;
      expect(text).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(text).toContain(next);
    }
    const qaJson = JSON.parse((await handler({ args: ['--qa', '--format', 'json'] })).value);
    expect(qaJson.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaJson.nextCommand).toBe(next);

    const cdp = pdfPageCdp();
    const store = { output: null };
    const cards = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { cards: true, targetPrefix: PDF_PREFIX },
    );
    expect(cards).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(cards).toContain(next);
    expect(cards).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);

    const scoped = await T.perceiveStr(
      pdfPageCdp(),
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null },
      { selector: 'body', targetPrefix: PDF_PREFIX },
    );
    expect(scoped).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(scoped).not.toMatch(/Interactive: none/);

    const parsedModel = T.pdfViewerHandoffModelFromOutput(cards, PDF_PREFIX);
    expect(parsedModel).toMatchObject({
      schema: 'chrome-cdp-ex.pdf-viewer.v1',
      url: PDF_PAGE.url,
      nextCommand: next,
    });
  });

  it('#255 HTML perceive --cards still returns cards.v1', async () => {
    const handler = T.createPerceiveCommandHandler({
      cdp: { send() { throw new Error('unexpected CDP command'); } },
      sessionId: 'sid',
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: {},
      ops: {
        readPerceiveTargetMetadata: async () => ({
          targetId: '1D3669785EAC5A1A211792636BAE8A07',
          url: 'https://x.com/home',
        }),
        readPerceiveDocumentState: async () => ({ url: 'https://x.com/home', readyState: 'complete' }),
        pageInfoModel: async () => ({
          title: 'Home / X',
          url: 'https://x.com/home',
          contentType: 'text/html',
        }),
        perceiveText: async (_cdp, _sid, _c, _e, _refs, _store, opts) => (
          opts.format === 'json'
            ? JSON.stringify({
              schema: 'chrome-cdp-ex.cards.v1',
              cards: [{ ref: '@1', handle: '@alice', text: 'visible post' }],
              next: 'timeline virtualized; scroll and re-run --cards',
            }, null, 2)
            : 'chrome-cdp-ex.cards.v1  1 card\n@1  @alice  visible post'
        ),
      },
    });
    const text = (await handler({ args: ['--cards'] })).value;
    expect(text).toContain('chrome-cdp-ex.cards.v1');
    expect(text).toContain('@alice');
    expect(text).not.toContain('chrome-cdp-ex.pdf-viewer.v1');
    const parsed = JSON.parse((await handler({ args: ['--cards', '--format', 'json'] })).value);
    expect(parsed.schema).toBe('chrome-cdp-ex.cards.v1');
    expect(parsed.cards).toHaveLength(1);
  });

  it('#256 PDF fullshot fail-fasts as pdf-viewer.v1 without poisoning later shot', async () => {
    T.resetScreenshotTier();
    const cdp = pdfPageCdp();
    await expect(T.fullshotStr(cdp, 'sid', '/tmp/pdf-full.png', PDF_TARGET_ID))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);

    let thrown;
    try {
      await T.fullshotStr(cdp, 'sid', '/tmp/pdf-full.png', PDF_TARGET_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('pdf_viewer');
    expect(thrown.message).toContain(`cdp eval ${PDF_PREFIX} "document.contentType"`);
    expect(thrown.message).not.toMatch(/screenshot fallback/);
    expect(thrown.message).not.toMatch(/Full-page screenshot saved/);
    expect(thrown.message).not.toMatch(/not available/);
    expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
    expect(cdp.calls.some(call => call.method === 'Page.getLayoutMetrics')).toBe(false);
    expect(T.getScreenshotTier()).toBe(1);

    const recovery = T.buildCliErrorRecovery(thrown.message, {
      cmd: 'fullshot',
      targetPrefix: PDF_PREFIX,
      err: thrown,
    });
    expect(recovery.kind).toBe('pdf-viewer');
    expect(recovery.run).toBe(`cdp eval ${PDF_PREFIX} "document.contentType"`);

    const shotCdp = {
      calls: [],
      send(method, params = {}) {
        this.calls.push({ method, params });
        if (method === 'Page.captureScreenshot') {
          return Promise.resolve({ data: 'viewport-ok' });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.reject(new Error('timeout')), cancel() {} };
      },
    };
    const shot = await T.captureScreenshot(shotCdp, 'sid', { format: 'png' });
    expect(shot.data).toBe('viewport-ok');
    expect(shot.fallback).toBe(false);
    expect(T.getScreenshotTier()).toBe(1);
  });

  it('#257 leftover perceive --cards dumps are not action settle baselines', () => {
    const cardsDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 1D366978 --cards';
    expect(T.isCardsPerceiveOutput(cardsDump)).toBe(true);
    expect(T.actionDomDiffShowsChange(cardsDump)).toBe(true);

    const settled = T.actionSettleBaseline(cardsDump, T.perceiveSnapshotOpts({ cards: true }));
    expect(settled.output).toBeNull();
    expect(settled.opts.cards).toBe(false);
    expect(T.actionObservationPerceiveOpts('1D3669785EAC5A1A211792636BAE8A07', {
      sinceAction: true,
      cards: true,
    }).cards).toBe(false);

    const axTree = 'Page: Example Domain — https://example.com/\nViewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none\n\n(no changes detected in AX tree)';
    expect(T.actionSettleBaseline(axTree, T.perceiveSnapshotOpts({ cursorInteractive: true, maxDepth: 8 }))).toMatchObject({
      output: axTree,
      opts: expect.objectContaining({ cards: false, cursorInteractive: true }),
    });

    const pressAfterCards = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(pressAfterCards.outcome.status).toBe('no-change');
    expect(pressAfterCards.effects.diagnosis?.kind).not.toBe('dom-changed');
    const pressText = T.formatActionText(pressAfterCards);
    expect(pressText).toMatch(/Outcome: no-change/);
    expect(pressText).not.toMatch(/Outcome: changed/);
    expect(pressText).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(pressAfterCards.nextSteps.join('\n')).not.toMatch(/perceive .*--cards/);

    const liar = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: cardsDump, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(liar.outcome.status).toBe('changed');
    expect(liar.effects.diagnosis?.kind).toBe('dom-changed');

    for (const [action, target] of [
      ['clickxy', { input: '10 10', resolvedBy: 'coordinates', label: '10,10' }],
      ['type', { input: 'hello', resolvedBy: 'focused', label: 'unfocused' }],
    ]) {
      const result = T.applyActionObservationDelta(T.createActionResult({
        action,
        target: { targetId: '1D3669785EAC5A1A211792636BAE8A07', ...target },
        dispatch: { ok: true, method: action },
        settle: { ok: true, durationMs: 80 },
        effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
      }), emptyDelta);
      expect(result.outcome.status).toBe('no-change');
      expect(result.effects.diagnosis?.kind).not.toBe('dom-changed');
      expect(result.nextSteps.join('\n')).not.toMatch(/perceive .*--cards/);
      expect(T.formatActionText(result)).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    }

    const afterDefaultPerceive = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(afterDefaultPerceive.outcome.status).toBe('no-change');
    expect(T.formatActionText(afterDefaultPerceive)).toMatch(/Outcome: no-change/);
  });
});
