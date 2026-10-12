import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T, executeCdpCli } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issues #204-#208 open contracts', () => {
  it('#204 press no-change Next is not overlay <Key>; usage is Kind:usage / help press', () => {
    expect(T.overlaySelectorArg('Escape', { resolvedBy: 'key', input: 'Escape' })).toBe('');
    expect(T.overlaySelectorArg('a', { resolvedBy: 'key', input: 'a' })).toBe('');
    expect(T.overlaySelectorArg('#save', { resolvedBy: 'selector-or-ref', input: '#save' })).toBe('"#save"');

    const escape = T.buildNoChangeOutcomeRecommendation({
      action: 'press',
      target: '1D366978',
      targetInput: 'Escape',
      targetInfo: { input: 'Escape', resolvedBy: 'key', label: 'Escape', expectedOutcome: 'press-no-change' },
    });
    expect(escape.strategy).toBe('continue');
    expect(escape.blockingSignals).not.toContain('overlay-check-needed');
    expect(escape.commands.join('\n')).not.toMatch(/\boverlay\b/);
    expect(escape.commands.join('\n')).not.toMatch(/\bEscape\b/);

    const space = T.buildNoChangeOutcomeRecommendation({
      action: 'press',
      target: '1D366978',
      targetInput: 'Space',
      targetInfo: { input: 'Space', resolvedBy: 'key', label: 'Space' },
    });
    expect(space.strategy).toBe('continue');
    expect(space.commands.join('\n')).not.toMatch(/\boverlay\b/);

    const result = T.createActionResult({
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
      effects: {
        domDiff: 'No changes detected.',
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.verdict.needsRecovery).toBe(false);
    expect(T.formatActionText(result)).not.toMatch(/\bcdp overlay\b/);
    expect(T.formatActionText(result)).not.toMatch(/overlay 1D366978 Escape/);

    const unknown = T.classifyActionFailure(new Error('Unknown key: Esc. Supported: enter, tab, escape'), {
      action: 'press',
      target: { targetId: '1D366978', input: 'Esc', resolvedBy: 'key' },
    });
    expect(unknown.kind).toBe('usage');
    expect(unknown.nextCommand).toBe('cdp help press');

    const missing = T.buildCliErrorRecovery('Key name required (Enter, Tab, Escape, Backspace, Space, Arrow*, or single character a-z/A-Z/0-9/punctuation)', {
      cmd: 'press',
      targetPrefix: '1D366978',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help press');

    const text = T.formatCliError(new Error('Unknown key: Esc. Supported: enter, tab, escape'), {
      cmd: 'press',
      targetPrefix: '1D366978',
    });
    expect(text).toMatch(/Kind: usage/);
    expect(text).toMatch(/Next: cdp help press/);
    expect(text).not.toMatch(/Action failure: unknown/);
    expect(T.pressUsageError('Esc')?.message).toMatch(/Unknown key: Esc/);
    expect(T.pressUsageError(undefined)?.message).toMatch(/Key name required/);
    expect(T.pressUsageError('Escape')).toBeNull();
  });

  it('#205 dismiss-modal with no modal is no-change continue, not dom-changed', () => {
    expect(T.actionDomDiffShowsChange('No changes detected (no modal).')).toBe(false);
    expect(T.overlaySelectorArg('modal', { resolvedBy: 'dialog', input: 'modal' })).toBe('');

    const recommendation = T.buildNoChangeOutcomeRecommendation({
      action: 'dismiss-modal',
      target: '1D366978',
      targetInput: 'modal',
      targetInfo: { input: 'modal', resolvedBy: 'dialog', label: 'modal', expectedOutcome: 'no-modal' },
    });
    expect(recommendation.strategy).toBe('continue');
    expect(recommendation.outcomeStatus).toBe('no-change');
    expect(recommendation.blockingSignals).not.toContain('overlay-check-needed');
    expect(recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);

    const result = T.createActionResult({
      action: 'dismiss-modal',
      target: {
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        input: 'modal',
        resolvedBy: 'dialog',
        label: 'modal',
        expectedOutcome: 'no-modal',
      },
      dispatch: { ok: true, method: 'dismiss-modal' },
      settle: { ok: true, durationMs: 20 },
      effects: {
        domDiff: 'No changes detected (no modal).',
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.effects.diagnosis?.kind).not.toBe('dom-changed');
    expect(T.formatActionText(result)).not.toMatch(/Outcome: changed/);
  });

  it('#206 waitfor timeout is Kind:timeout / help waitfor, not unknown/status', () => {
    const selector = T.buildCliErrorRecovery(
      'Timeout: ".does-not-exist-xyz" not found within 1500ms — to wait for specific text content instead, use: waitfor --text "expected text" 120000',
      { cmd: 'waitfor', targetPrefix: '1D366978' },
    );
    expect(selector.kind).toBe('timeout');
    expect(selector.run).toBe('cdp help waitfor');
    expect(selector.run).not.toMatch(/status/);

    const text = T.buildCliErrorRecovery('Timeout: text "ZZZNOPE" not found within 1200ms', {
      cmd: 'waitfor',
      targetPrefix: '1D366978',
    });
    expect(text.kind).toBe('timeout');
    expect(text.run).toBe('cdp help waitfor');

    const anyOf = T.buildCliErrorRecovery('Timeout: any of [ZZZ, NOPE] not found within 1200ms', {
      cmd: 'waitfor',
      targetPrefix: '1D366978',
    });
    expect(anyOf.kind).toBe('timeout');
    expect(anyOf.run).toBe('cdp help waitfor');

    const formatted = T.formatCliError(
      new Error('Timeout: ".does-not-exist-xyz" not found within 1500ms'),
      { cmd: 'waitfor', targetPrefix: '1D366978' },
    );
    expect(formatted).toMatch(/Kind: timeout/);
    expect(formatted).toMatch(/Next: cdp help waitfor/);
    expect(formatted).not.toMatch(/Kind: unknown/);
    expect(formatted).not.toMatch(/cdp status/);

    expect(T.commandUsageTemplate('waitfor', '1D366978')).toBe('cdp help waitfor');
    const missing = T.buildCliErrorRecovery('CSS selector or --text required', {
      cmd: 'waitfor',
      targetPrefix: '1D366978',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help waitfor');
  });

  it('#207 PDF stub Next uses the resolved prefix, not <target>', async () => {
    const printed = T.formatPdfViewerOutput({
      title: '',
      url: 'https://arxiv.org/pdf/2608.12307',
      contentType: 'application/pdf',
    }, { targetPrefix: '9FAD7C71' });
    expect(printed).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(printed).not.toContain('<target>');
    expect(printed).toContain('text --auto');

    let calls = 0;
    const cdp = {
      send(method) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        calls += 1;
        return Promise.resolve({
          result: {
            value: JSON.stringify({
              title: '',
              url: 'https://arxiv.org/pdf/2608.12307',
              contentType: 'application/pdf',
            }),
          },
        });
      },
    };
    await expect(T.textStr(cdp, 'sid', [], { targetPrefix: '9FAD7C71' }))
      .rejects.toThrow(/cdp eval 9FAD7C71 "document\.contentType"/);
    expect(calls).toBe(1);
    try {
      await T.textStr(cdp, 'sid', [], { targetPrefix: '9FAD7C71' });
      throw new Error('expected pdf viewer error');
    } catch (error) {
      if (error.message === 'expected pdf viewer error') throw error;
      expect(error.code).toBe('pdf_viewer');
      expect(error.message).not.toContain('<target>');
    }
  });

  it('#283 text --auto on a Chrome PDF plugin returns page-1 text, not pdf-viewer.v1', async () => {
    const { paidPathPdfBytes, PDF_PAGE1_LANDMARK } = await import('./pdf-text-fixtures.mjs');
    const pdfBytes = paidPathPdfBytes();
    const page = {
      title: 'ignored-tab-title',
      url: 'https://arxiv.org/pdf/2608.12307',
      contentType: 'application/pdf',
    };
    const cdp = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        const expr = String(params.expression || '');
        if (expr.includes('document.title') || expr.includes('contentType')) {
          return Promise.resolve({ result: { value: JSON.stringify(page) } });
        }
        throw new Error(`unexpected eval ${expr.slice(0, 80)}`);
      },
    };
    const out = await T.textStr(cdp, 'sid', ['--auto'], {
      targetPrefix: 'CFD023D2',
      loadPdfBytes: async () => pdfBytes,
    });
    expect(out).toContain(PDF_PAGE1_LANDMARK);
    expect(out).not.toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(out).not.toMatch(/Kind:\s*unknown/);

    const viaPageFetch = await T.textStr({
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        const expr = String(params.expression || '');
        if (expr.includes('document.title') || expr.includes('contentType')) {
          return Promise.resolve({ result: { value: JSON.stringify(page) } });
        }
        if (expr.includes('fetch(')) {
          return Promise.resolve({ result: { value: pdfBytes.toString('base64') } });
        }
        throw new Error(`unexpected eval ${expr.slice(0, 80)}`);
      },
    }, 'sid', ['--auto'], { targetPrefix: 'CFD023D2' });
    expect(viaPageFetch).toContain(PDF_PAGE1_LANDMARK);

    const viaNodeFetch = await T.textStr(cdp, 'sid', ['--auto'], {
      targetPrefix: 'CFD023D2',
      fetch: async (url) => {
        expect(url).toBe(page.url);
        return { ok: true, arrayBuffer: async () => pdfBytes };
      },
    });
    expect(viaNodeFetch).toContain(PDF_PAGE1_LANDMARK);

    await expect(T.textStr(cdp, 'sid', ['--auto'], { targetPrefix: 'CFD023D2' }))
      .rejects.toThrow(/chrome-cdp-ex\.pdf-viewer\.v1/);
  });

  it('#208 qa screenshot capture is bounded and still yields a receipt', async () => {
    expect(T.QA_SCREENSHOT_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(T.qaScreenshotCaptureOptions()).toMatchObject({
      timeoutMs: T.QA_SCREENSHOT_TIMEOUT_MS,
      skipSanityRetry: true,
    });

    T.resetScreenshotTier();
    const cdp = {
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
    await expect(T.captureScreenshot(cdp, 'sid', { format: 'png' }, {
      ...T.qaScreenshotCaptureOptions(),
      inspectFrame: async () => ({ retry: false }),
    })).rejects.toThrow(/all methods timed out|Timeout: Page\.captureScreenshot/);
    expect(cdp.calls.some(call => call.method === 'Page.captureScreenshot' && call.timeout === T.QA_SCREENSHOT_TIMEOUT_MS)).toBe(true);
    expect(cdp.calls.every(call => call.method !== 'Page.captureScreenshot' || call.timeout === T.QA_SCREENSHOT_TIMEOUT_MS)).toBe(true);

    const model = T.buildQaPageModel({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      page: { title: 'Example Domain', url: 'https://example.com/' },
      pageHealth: { status: 'ok', isBlank: false },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      perception: { captured: true, summary: 'Page: Example Domain' },
      screenshots: {},
      errors: ['desktop screenshot: Screenshot failed: all methods timed out (Page.captureScreenshot, fromSurface:false, screencast).'],
    });
    const text = T.formatQaPageReport(model);
    expect(text).toMatch(/QA page: Example Domain/);
    expect(text).toMatch(/Error: desktop screenshot:/);
    expect(text).toMatch(/Verdict:/);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('issues #210-#217 open contracts', () => {
  it('#210 qa restores the original viewport after a screenshot timeout', async () => {
    const sizes = [];
    let current = { w: 1042, h: 632 };
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-qa-viewport-'));
    const session = T.createSessionState({
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
      sessionId: 'sid',
      logPath: join(tmp, 'session.jsonl'),
      screenshotDir: join(tmp, 'shots'),
    });
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
          if (expr.includes('innerWidth') && expr.includes('innerHeight')) {
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
          if (expr.includes('visibleTextLength')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  url: 'https://example.com/',
                  readyState: 'complete',
                  visibleTextLength: 40,
                  elementCount: 12,
                  visibleControlCount: 1,
                  bodyRect: { width: 1042, height: 632 },
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          throw new Error('ax unavailable in this fixture');
        }
        return Promise.resolve({});
      },
    };
    try {
      const out = await T.qaPageStr({
        cdp,
        sid: 'sid',
        session,
        targetId: '1D3669785EAC5A1A211792636BAE8A07',
        consoleBuf: new T.RingBuffer(8),
        exceptionBuf: new T.RingBuffer(8),
        refMap: new Map(),
        lastPerceiveStore: { output: null },
        refState: {},
        actionFeedback: async () => '',
      }, []);
      expect(out).toMatch(/Error: desktop screenshot:/);
      expect(sizes[0]).toBe('1440x900');
      expect(sizes.at(-1)).toBe('clear');
      expect(current).toEqual({ w: 1042, h: 632 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#211 no-baseline no-op press is no-change, not a tree dump', () => {
    expect(T.noBaselineActionDiffText()).toMatch(/no changes detected/i);
    expect(T.actionDomDiffShowsChange(T.noBaselineActionDiffText())).toBe(false);
    expect(T.actionDomDiffShowsChange('(no action baseline available; run `perceive` before a mutating command)')).toBe(false);

    const result = T.createActionResult({
      action: 'press',
      target: {
        targetId: 'C48C711AFULL',
        input: 'Escape',
        resolvedBy: 'key',
        label: 'Escape',
        expectedOutcome: 'press-no-change',
      },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: T.noBaselineActionDiffText(),
        console: [],
        network: [],
        navigation: null,
        consoleDelta: { count: 0, errors: 0, warnings: 0, entries: [] },
        exceptionDelta: { count: 0, entries: [] },
        networkDelta: { count: 0, failures: 0, pending: 0, entries: [] },
      },
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    const text = T.formatActionText(result);
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).not.toMatch(/no action baseline available/);
    expect(text).not.toMatch(/^Page:/m);
  });

  it('#212 select missing option is Kind:usage, not ReferenceError', async () => {
    const selectEl = {
      tagName: 'SELECT',
      options: [
        { value: '', textContent: '--' },
        { value: 'a', textContent: 'Alpha' },
        { value: 'b', textContent: 'Beta' },
      ],
      selectedIndex: 0,
      value: '',
      dispatchEvent() {},
    };
    let expression = '';
    const cdp = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        expression = params.expression;
        const result = runInNewContext(expression, {
          document: {
            querySelector(sel) {
              if (sel === '#s') return selectEl;
              if (sel === '#q') return { tagName: 'INPUT' };
              return null;
            },
          },
          Event: class Event {},
        });
        // Runtime.evaluate runs with awaitPromise: true; the select expression is async since #468.
        return Promise.resolve(result).then(value => ({ result: { value } }));
      },
    };

    await expect(T.selectStr(cdp, 'sid', '#s', 'zzz')).rejects.toThrow(/No option value=zzz/);
    expect(expression).toContain(JSON.stringify('zzz'));
    expect(expression).not.toMatch(/: value\s*[;}]/);

    await expect(T.selectStr(cdp, 'sid', '#s', 'Alpha')).resolves.toBe('Selected "Alpha"');
    expect(selectEl.value).toBe('a');

    await expect(T.selectStr(cdp, 'sid', '#q', 'a')).rejects.toThrow(/Not a <select>: INPUT/);
    await expect(T.selectStr(cdp, 'sid', '', 'a')).rejects.toThrow(/CSS selector or @ref required/);
    await expect(T.selectStr(cdp, 'sid', '#s', undefined)).rejects.toThrow(/Value required/);

    expect(T.classifyActionFailure(new Error('No option value=zzz'), {
      action: 'select',
      target: { targetId: '270379DA', input: '#s' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help select' });
    expect(T.classifyActionFailure(new Error('Not a <select>: INPUT'), {
      action: 'select',
      target: { targetId: '270379DA', input: '#q' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help select' });

    const formatted = T.formatCliError(new Error('No option value=zzz'), {
      cmd: 'select',
      targetPrefix: '270379DA',
    });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp help select/);
    expect(formatted).not.toMatch(/Action failure: unknown/);
    expect(formatted).not.toMatch(/ReferenceError/);
  });

  it('#213 upload of a missing path fails closed and does not plant a ghost file', async () => {
    expect(() => T.assertReadableUploadFiles('/tmp/picky5/no-such-file.bin'))
      .toThrow(/upload: file not found/);
    const cdp = {
      send(method) {
        throw new Error(`CDP ${method} must not run for a missing upload path`);
      },
    };
    await expect(T.uploadStr(cdp, 'sid', '#f', '/tmp/picky5/no-such-file.bin'))
      .rejects.toThrow(/upload: file not found/);

    const usage = T.buildCliErrorRecovery('upload: file not found: /tmp/picky5/no-such-file.bin', { cmd: 'upload' });
    expect(usage.kind).toBe('usage');
    expect(usage.run).toBe('cdp help upload');
    expect(T.classifyActionFailure(new Error('upload: file not found: /tmp/picky5/no-such-file.bin'), {
      action: 'upload',
      target: { targetId: '270379DA', input: '#f' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help upload' });
    expect(T.classifyActionFailure(new Error('Element is not an <input type="file">'), {
      action: 'upload',
      target: { targetId: '270379DA', input: '#q' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help upload' });
  });

  it('#214 wait 0 / missing duration is Kind:usage / help wait, not doctor or status', () => {
    expect(() => T.parseDelayMs('0', { name: 'wait duration' })).toThrow(/at least 1ms/);
    expect(() => T.parseDelayMs(undefined, { name: 'wait duration' })).toThrow(/positive integer/);
    expect(() => T.parseDelayMs('-1', { name: 'wait duration' })).toThrow(/positive integer/);

    const zero = T.buildCliErrorRecovery('wait duration must be at least 1ms', { cmd: 'wait', targetPrefix: '1D366978' });
    expect(zero.kind).toBe('usage');
    expect(zero.run).toBe('cdp help wait');
    expect(zero.run).not.toMatch(/status/);
    expect(zero.run).not.toBe('cdp doctor');

    const missing = T.buildCliErrorRecovery('wait duration must be a positive integer in milliseconds', {
      cmd: 'wait',
      targetPrefix: '1D366978',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help wait');

    const noTarget = T.buildCliErrorRecovery('wait duration must be at least 1ms', { cmd: 'wait' });
    expect(noTarget.kind).toBe('usage');
    expect(noTarget.run).toBe('cdp help wait');
    expect(noTarget.run).not.toBe('cdp doctor');

    const formatted = T.formatCliError(new Error('wait duration must be at least 1ms'), { cmd: 'wait' });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp help wait/);
    expect(formatted).not.toMatch(/cdp doctor/);
    expect(formatted).not.toMatch(/cdp status/);
    expect(T.commandUsageTemplate('wait', '1D366978')).toBe('cdp help wait');
  });

  it('#215 tab-group unknown group is Kind:usage / tab-group list, not doctor', () => {
    expect(() => T.deleteTabGroup(T.emptyTabGroupStore(), 'picky5')).toThrow(/unknown group "picky5"/);
    expect(T.getTabGroup(T.emptyTabGroupStore(), 'picky5')).toBeNull();

    const recovery = T.buildCliErrorRecovery('tab-group: unknown group "picky5"', { cmd: 'tab-group' });
    expect(recovery.kind).toBe('usage');
    expect(recovery.run).toBe('cdp tab-group list');
    expect(recovery.run).not.toBe('cdp doctor');

    const formatted = T.formatCliError(new Error('tab-group: unknown group "picky5"'), { cmd: 'tab-group' });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp tab-group list/);
    expect(formatted).not.toMatch(/cdp doctor/);
  });

  it('#216 cookiedel of a missing cookie fails closed and does not claim deleted', async () => {
    const calls = [];
    const jar = [{ name: 'picky5', value: 'roundtrip', domain: 'example.com', path: '/' }];
    const cdp = {
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'https://example.com/' } });
        }
        if (method === 'Network.getCookies') {
          return Promise.resolve({ cookies: jar.map(cookie => ({ ...cookie })) });
        }
        if (method === 'Network.deleteCookies') {
          const idx = jar.findIndex(cookie => cookie.name === params.name
            && (!params.domain || cookie.domain === params.domain)
            && (!params.path || cookie.path === params.path));
          if (idx !== -1) jar.splice(idx, 1);
          return Promise.resolve({});
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(T.cookieDelStr(cdp, 'sid', 'nosuchpicky5cookie'))
      .rejects.toThrow(/Cookie not found: nosuchpicky5cookie/);
    expect(calls.some(call => call.method === 'Network.deleteCookies')).toBe(false);

    const deleted = await T.cookieDelStr(cdp, 'sid', 'picky5');
    expect(deleted).toBe('Cookie deleted: picky5');
    expect(calls.some(call => call.method === 'Network.deleteCookies' && call.params.name === 'picky5')).toBe(true);

    const recovery = T.buildCliErrorRecovery('Cookie not found: nosuchpicky5cookie', {
      cmd: 'cookiedel',
      targetPrefix: '1D366978',
    });
    expect(recovery.kind).toBe('usage');
    expect(recovery.run).toBe('cdp cookies 1D366978');
    expect(recovery.run).not.toMatch(/Cookie deleted/);
    const formatted = T.formatCliError(new Error('Cookie not found: nosuchpicky5cookie'), {
      cmd: 'cookiedel',
      targetPrefix: '1D366978',
    });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).not.toMatch(/Cookie deleted/);
  });

  it('#217 hover bounds mouseMoved renderer-ack instead of waiting ~5s', async () => {
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBeLessThan(2000);

    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId, timeoutMs) {
        calls.push({ method, params, sessionId, timeoutMs });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'root-frame' } } });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 901 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'hover-node' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('ownerDocumentGetter')) {
            return Promise.resolve({ result: { value: { connected: true } } });
          }
          if (fn.includes('chrome-cdp-ex.hover-reveal.v1')) {
            return Promise.resolve({
              result: {
                value: {
                  ok: true,
                  marker: 'chrome-cdp-ex.hover-reveal.v1',
                  opacity: 1,
                  visibility: 'visible',
                  display: 'inline',
                  visible: true,
                  groupHover: true,
                  matchesHover: true,
                  tag: 'A',
                },
              },
            });
          }
          return Promise.resolve({
            result: { value: { x: 240, y: 180, w: 28, h: 44, tag: 'A', text: 'Learn more' } },
          });
        }
        if (method === 'Input.dispatchMouseEvent') {
          expect(timeoutMs).toBe(T.HOVER_MOUSE_ACK_TIMEOUT_MS);
          return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('chrome-cdp-ex.hover-reveal.v1')) {
            return Promise.resolve({
              result: {
                value: {
                  ok: true,
                  marker: 'chrome-cdp-ex.hover-reveal.v1',
                  x: 254,
                  y: 202,
                  tag: 'A',
                  opacity: 1,
                  visibility: 'visible',
                  display: 'inline',
                  visible: true,
                  groupHover: true,
                  matchesHover: true,
                },
              },
            });
          }
          return Promise.resolve({
            result: { value: { ok: true, x: 254, y: 202, tag: 'A' } },
          });
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const out = await T.hoverStr(cdp, 'sid', '@1', new Map([[1, 101]]), {});
    expect(out).toMatch(/Hovering over <A>/);
    expect(calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseMoved')).toBe(true);
    expect(calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.timeoutMs === T.HOVER_MOUSE_ACK_TIMEOUT_MS)).toBe(true);
    const hoverFn = calls
      .filter(call => call.method === 'Runtime.callFunctionOn')
      .map(call => call.params.functionDeclaration || '')
      .find(fn => fn.includes('getBoundingClientRect')) || '';
    expect(hoverFn).toContain('getBoundingClientRect');
    expect(hoverFn).not.toMatch(/requestAnimationFrame/);
    expect(hoverFn).not.toMatch(/Date\.now\(\) \+ 1800/);
    expect(calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(1);

    const css = await T.hoverStr(cdp, 'sid', 'a', new Map(), {});
    expect(css).toMatch(/Hovering over <A>/);
    const mouseCalls = calls.filter(call => call.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls).toHaveLength(2);
    expect(mouseCalls.every(call => call.timeoutMs === T.HOVER_MOUSE_ACK_TIMEOUT_MS)).toBe(true);
    const cssExpr = calls.find(call => call.method === 'Runtime.evaluate')?.params.expression || '';
    expect(cssExpr).not.toMatch(/scrollIntoView/);
    expect(cssExpr).not.toMatch(/requestAnimationFrame/);
  });
});

describe('issues #220-#225 open contracts', () => {
  it('#220 verify-click assertion fail is RC≠0; unused --expect-status is usage', async () => {
    expect(() => T.parseVerifyClickArgs(['#b', '--expect-status', '200']))
      .toThrow(/--expect-status requires --expect-request/);
    expect(() => T.parseVerifyClickArgs(['#b', '--expect-request', 'GET /', '--expect-status', '200']))
      .not.toThrow();

    const failed = T.buildSemanticInteractionModel({
      action: 'click',
      target: { input: '#b', label: '#b' },
      dispatch: { ok: true, method: 'click' },
      effects: { network: [], consoleDelta: {}, exceptionDelta: {} },
    }, { expectText: 'NOPE-NOT-HERE' }, { textMatched: false });
    expect(failed).toMatchObject({ verdict: 'fail' });
    const text = T.formatSemanticInteractionResult(failed);
    expect(text).toMatch(/Verdict: fail/);
    expect(text).toMatch(/Kind: assertion/);
    expect(text).toMatch(/Next: cdp help verify-click/);
    expect(text).not.toMatch(/cdp status/);

    const semantics = T.classifyCommandResultSemantics(
      { ok: true, result: JSON.stringify(failed) },
      { command: 'verify-click' },
    );
    expect(semantics.ok).toBe(false);
    expect(semantics.assertionFailed).toBe(true);
    expect(semantics.dispatchFailed).toBe(false);

    const processLike = { exitCode: 0 };
    const logs = [];
    T.emitTargetCommandResponse(
      { ok: true, result: JSON.stringify(failed) },
      { cmd: 'verify-click', console: { log: value => logs.push(String(value)) }, process: processLike },
    );
    expect(processLike.exitCode).toBe(1);
    expect(logs.join('\n')).toMatch(/"verdict":\s*"fail"/);

    const textProcess = { exitCode: 0 };
    T.emitTargetCommandResponse(
      { ok: true, result: text },
      { cmd: 'verify-click', console: { log() {} }, process: textProcess },
    );
    expect(textProcess.exitCode).toBe(1);

    const usage = T.buildCliErrorRecovery('verify-click: --expect-status requires --expect-request', {
      cmd: 'verify-click',
      targetPrefix: '270379DA',
    });
    expect(usage.kind).toBe('usage');
    expect(usage.run).toBe('cdp help verify-click');
    expect(T.VERIFY_CLICK_SETTLE_MS).toBeLessThan(2000);
    expect(T.VERIFY_CLICK_REQUEST_WAIT_MS).toBeLessThanOrEqual(1500);
  });

  it('#221 tab-group add/create of an unknown target fails closed and does not plant a ghost', () => {
    const live = ['1D3669785EAC5A1A211792636BAE8A07', '270379DA32DEEE448FF70D9EEE154209'];
    expect(T.resolveTabGroupMember('1D366978', { targetIds: live })).toBe('1D366978');
    expect(() => T.resolveTabGroupMember('NOTEXIST', { targetIds: live }))
      .toThrow(/No live target matching prefix "NOTEXIST"/);
    expect(() => T.resolveTabGroupMembers(['NOTEXIST', '1D366978'], { targetIds: live }))
      .toThrow(/No live target matching prefix "NOTEXIST"/);
    expect(T.resolveTabGroupMembers(['1D366978', '270379DA'], { targetIds: live }))
      .toEqual(['1D366978', '270379DA']);

    let store = T.emptyTabGroupStore();
    store = T.upsertTabGroup(store, {
      name: 'picky6',
      members: T.resolveTabGroupMembers(['1D366978', '270379DA'], { targetIds: live }),
    });
    expect(T.getTabGroup(store, 'picky6').members).toEqual(['1D366978', '270379DA']);
    expect(() => T.upsertTabGroup(store, {
      name: 'picky6',
      members: T.resolveTabGroupMembers(['NOTEXIST'], { targetIds: live }),
    })).toThrow(/No live target matching prefix "NOTEXIST"/);
    expect(T.getTabGroup(store, 'picky6').members).toEqual(['1D366978', '270379DA']);

    const recovery = T.buildCliErrorRecovery('No live target matching prefix "NOTEXIST".', { cmd: 'tab-group' });
    expect(recovery.kind).toBe('target-resolution');
    expect(recovery.run).toMatch(/^cdp list/);
    expect(T.listKnownLiveTargetIds({
      listDaemons: () => [{ targetId: '1D3669785EAC5A1A211792636BAE8A07' }],
      readPages: () => [{ targetId: '270379DA32DEEE448FF70D9EEE154209' }],
    })).toEqual(expect.arrayContaining([
      '1D3669785EAC5A1A211792636BAE8A07',
      '270379DA32DEEE448FF70D9EEE154209',
    ]));
  });

  it('#222 batch failed steps make the command RC≠0 and unknown cmds Next help', async () => {
    const unknown = T.formatBatchResults([{
      cmd: 'not-a-cmd',
      ok: false,
      error: 'Unknown command: not-a-cmd',
    }], 'model', { targetId: '270379DA32DEEE448FF70D9EEE154209' });
    const unknownModel = JSON.parse(unknown);
    expect(unknownModel.counts.failed).toBe(1);
    expect(unknownModel.nextSteps).toEqual(['cdp help']);
    expect(unknownModel.nextSteps.join('\n')).not.toMatch(/cdp status 270379DA32DEEE448FF70D9EEE154209/);

    const semantics = T.classifyCommandResultSemantics(
      { ok: true, result: unknown },
      { command: 'batch' },
    );
    expect(semantics.ok).toBe(false);
    expect(semantics.batchFailed).toBe(true);

    const processLike = { exitCode: 0 };
    T.emitTargetCommandResponse(
      { ok: true, result: unknown },
      { cmd: 'batch', console: { log() {} }, process: processLike },
    );
    expect(processLike.exitCode).toBe(1);

    const legacy = JSON.stringify([{ cmd: 'not-a-cmd', ok: false, error: 'Unknown command: not-a-cmd' }], null, 2);
    expect(T.classifyCommandResultSemantics(
      { ok: true, result: legacy },
      { command: 'batch' },
    ).ok).toBe(false);

    await expect(executeCdpCli(
      ['batch', 'ABC12345', 'not-a-cmd foo'],
      { runMain: async ({ console }) => { console.log(legacy); } },
    )).resolves.toMatchObject({ code: 1, stdout: legacy, stderr: '' });
  });

  it('#223 diff-shot screenshot timeout is a classified failure, not a fake 0% diff', async () => {
    expect(T.diffShotScreenshotCaptureOptions()).toMatchObject({
      timeoutMs: T.QA_SCREENSHOT_TIMEOUT_MS,
      skipSanityRetry: true,
      failFastOnTimeout: true,
    });
    expect(T.diffShotScreenshotCaptureOptions().timeoutMs).toBeLessThanOrEqual(3000);

    T.resetScreenshotTier();
    const cdp = {
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
    await expect(T.captureScreenshot(cdp, 'sid', { format: 'png' }, T.diffShotScreenshotCaptureOptions()))
      .rejects.toThrow(/Timeout: Page\.captureScreenshot/);
    expect(cdp.calls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(cdp.calls[0].timeout).toBe(T.QA_SCREENSHOT_TIMEOUT_MS);
    expect(T.getScreenshotTier()).toBe(1);

    const session = { targetId: '1D366978', screenshotDir: '/tmp/diff-shot-untrusted' };
    await expect(T.diffShotStr(cdp, 'sid', session, { reset: true }))
      .rejects.toThrow(/timed out|untrusted/i);
    const recovery = T.buildCliErrorRecovery('diff-shot: screenshot capture timed out; comparison is untrusted', {
      cmd: 'diff-shot',
      targetPrefix: '1D366978',
    });
    expect(recovery.kind).toBe('timeout');
    expect(recovery.run).toBe('cdp help diff-shot');
    expect(recovery.run).not.toMatch(/status/);
  });

  it('#224 restore/replay missing file is Kind:usage / help, not perceive or status', () => {
    const enoent = new Error("ENOENT: no such file or directory, open '[checkpoint-path-redacted]'");
    expect(T.classifyActionFailure(enoent, {
      action: 'restore',
      target: { targetId: '1D366978' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help restore' });

    const restoreMissing = T.buildCliErrorRecovery(
      "ENOENT: no such file or directory, open '[checkpoint-path-redacted]'",
      { cmd: 'restore', targetPrefix: '1D366978' },
    );
    expect(restoreMissing.kind).toBe('usage');
    expect(restoreMissing.run).toBe('cdp help restore');
    expect(restoreMissing.run).not.toMatch(/perceive|status/);

    const schema = T.buildCliErrorRecovery('restore: unsupported checkpoint schema (missing)', {
      cmd: 'restore',
      targetPrefix: '1D366978',
    });
    expect(schema.kind).toBe('usage');
    expect(schema.run).toBe('cdp help restore');

    const restoreArgs = T.buildCliErrorRecovery('restore requires --file <path> or --json <checkpoint-json>', {
      cmd: 'restore',
      targetPrefix: '1D366978',
    });
    expect(restoreArgs.kind).toBe('usage');
    expect(restoreArgs.run).toBe('cdp help restore');

    const formattedRestore = T.formatCliError(enoent, { cmd: 'restore', targetPrefix: '1D366978' });
    expect(formattedRestore).toMatch(/Kind: usage/);
    expect(formattedRestore).toMatch(/Next: cdp help restore/);
    expect(formattedRestore).not.toMatch(/Action failure: unknown/);
    expect(formattedRestore).not.toMatch(/cdp perceive/);
    expect(formattedRestore).not.toMatch(/cdp status/);

    const replayEnoent = T.buildCliErrorRecovery(
      'ENOENT: no such file or directory, open \'/tmp/picky6/no-such-replay.json\'',
      { cmd: 'replay', targetPrefix: '1D366978' },
    );
    expect(replayEnoent.kind).toBe('usage');
    expect(replayEnoent.run).toBe('cdp help replay');
    const replaySchema = T.buildCliErrorRecovery('replay: unsupported artifact schema (missing)', {
      cmd: 'replay',
      targetPrefix: '1D366978',
    });
    expect(replaySchema.kind).toBe('usage');
    expect(replaySchema.run).toBe('cdp help replay');
    expect(T.commandUsageTemplate('restore', '1D366978')).toBe('cdp help restore');
    expect(T.commandUsageTemplate('replay', '1D366978')).toBe('cdp help replay');
  });

  it('#225 repeat 0 / missing args is Kind:usage / help repeat, not status', () => {
    expect(() => T.parseRepeatArgs(['0', 'eval', '1+1'])).toThrow(/positive integer/);
    expect(() => T.parseRepeatArgs([])).toThrow(/repeat requires/);

    const zero = T.buildCliErrorRecovery('repeat: count must be a positive integer, got "0"', {
      cmd: 'repeat',
      targetPrefix: '270379DA',
    });
    expect(zero.kind).toBe('usage');
    expect(zero.run).toBe('cdp help repeat');
    expect(zero.run).not.toMatch(/status/);

    const missing = T.buildCliErrorRecovery('repeat requires <count> <cmd> [args...]', {
      cmd: 'repeat',
      targetPrefix: '270379DA',
    });
    expect(missing.kind).toBe('usage');
    expect(missing.run).toBe('cdp help repeat');

    const formatted = T.formatCliError(new Error('repeat: count must be a positive integer, got "0"'), {
      cmd: 'repeat',
      targetPrefix: '270379DA',
    });
    expect(formatted).toMatch(/Kind: usage/);
    expect(formatted).toMatch(/Next: cdp help repeat/);
    expect(formatted).not.toMatch(/cdp status/);
    expect(T.commandUsageTemplate('repeat', '270379DA')).toBe('cdp help repeat');
  });
});

describe('issues #227-#231 open contracts', () => {
  it('#227 missing loadall selector is RC≠0 and does not claim disappeared', async () => {
    expect(T.parseLoadAllArgs(['#more'])).toEqual({
      selector: '#more',
      intervalMs: T.LOADALL_DEFAULT_INTERVAL_MS,
      timeoutMs: T.LOADALL_DEFAULT_TIMEOUT_MS,
    });
    expect(T.parseLoadAllArgs(['#more', '400'])).toMatchObject({ selector: '#more', intervalMs: 400, timeoutMs: 30_000 });
    expect(T.parseLoadAllArgs(['#more', '--timeout-ms', '800'])).toMatchObject({ timeoutMs: 800, intervalMs: 1500 });
    expect(() => T.parseLoadAllArgs([])).toThrow(/CSS selector required/);

    const topic = T.helpTopicStr('loadall');
    expect(topic).toMatch(/\[interval-ms\]/);
    expect(topic).toMatch(/timeout-ms/);
    expect(topic).toMatch(/click interval/);

    const cdp = {
      send(method, params = {}) {
        const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (expr.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: false } } });
        }
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: null } });
        return Promise.resolve({});
      },
    };
    await expect(T.loadAllStr(cdp, 'sid', '#nope-load', 0, { timeoutMs: 200 }))
      .rejects.toThrow(/Element not found: #nope-load/);

    const missing = T.formatCliError(new Error('Element not found: #nope-load'), {
      cmd: 'loadall',
      targetPrefix: 'C48C711A',
    });
    expect(missing).toMatch(/Kind: selector/);
    expect(missing).toMatch(/Next: cdp perceive C48C711A -C -d 8/);
    expect(missing).not.toMatch(/disappeared/);
    expect(missing).not.toMatch(/Kind: unknown/);

    const usage = T.formatCliError(new Error('CSS selector required'), {
      cmd: 'loadall',
      targetPrefix: 'C48C711A',
    });
    expect(usage).toMatch(/Kind: usage/);
    expect(usage).toMatch(/Next: cdp help loadall/);
  });

  it('#227 persistent loadall control fails at the cap and client abort stops the loop', async () => {
    const cdp = {
      clicks: 0,
      send(method, params = {}) {
        const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (expr.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({
            result: {
              value: expr.includes('installed: true')
                ? { cdpClickProbe: true, ok: true, installed: true, scope: 'top' }
                : { cdpClickProbe: true, ok: true, seen: ['click'] },
            },
          });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: { x: 10, y: 20 } } });
        }
        if (method === 'Input.dispatchMouseEvent') this.clicks += 1;
        return Promise.resolve({});
      },
    };
    await expect(T.loadAllStr(cdp, 'sid', '#more', 0, { timeoutMs: 80 }))
      .rejects.toThrow(/still present after \d+ click\(s\) \(timeout 80ms\)/);
    expect(cdp.clicks).toBeGreaterThan(0);

    const timeoutText = T.formatCliError(
      new Error('loadall: "#more" still present after 3 click(s) (timeout 80ms)'),
      { cmd: 'loadall', targetPrefix: 'C48C711A' },
    );
    expect(timeoutText).toMatch(/Kind: timeout/);
    expect(timeoutText).toMatch(/Next: cdp help loadall/);
    expect(timeoutText).not.toMatch(/until it disappeared/);
    expect(timeoutText).not.toMatch(/click Allow/);

    const abortCdp = {
      send(method, params = {}) {
        const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (expr.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({
            result: {
              value: expr.includes('installed: true')
                ? { cdpClickProbe: true, ok: true, installed: true, scope: 'top' }
                : { cdpClickProbe: true, ok: true, seen: ['click'] },
            },
          });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: { x: 10, y: 20 } } });
        }
        return Promise.resolve({});
      },
    };
    const controller = new AbortController();
    const pending = T.daemonRequestStorage.run({ signal: controller.signal }, () => (
      T.loadAllStr(abortCdp, 'sid', '#b', 40, { timeoutMs: 5000 })
    ));
    setTimeout(() => controller.abort(new Error('loadall: aborted')), 15);
    await expect(pending).rejects.toThrow(/aborted/);
    const aborted = T.formatCliError(new Error('loadall: aborted'), {
      cmd: 'loadall',
      targetPrefix: '270379DA',
    });
    expect(aborted).toMatch(/Kind: timeout/);
    expect(aborted).toMatch(/Next: cdp help loadall/);
    expect(aborted).not.toMatch(/click Allow/);
    expect(aborted).not.toMatch(/Kind: unknown/);
  });

  it('#228 realistic click uses the buttons bitmask and fails fast without overlay on a stuck <a href>', async () => {
    expect(T.isNavigatingHref('https://www.iana.org/help/example-domains', 'https://example.com/')).toBe(true);
    expect(T.isNavigatingHref('#section', 'https://example.com/')).toBe(false);
    expect(T.CLICK_NAVIGATION_WAIT_MS).toBeLessThanOrEqual(500);

    const events = [];
    let probeSeen = [];
    await T.dispatchClick({
      send(method, params = {}, _sessionId, _timeout) {
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
        if (method === 'Input.dispatchMouseEvent') {
          events.push(params);
          if (params.type === 'mouseReleased') probeSeen.push('mousedown', 'click');
        }
        return Promise.resolve({});
      },
    }, 'sid', 12, 34);
    expect(events).toEqual([
      expect.objectContaining({ type: 'mouseMoved', button: 'none', buttons: 0, pointerType: 'mouse', x: 12, y: 34 }),
      expect.objectContaining({ type: 'mousePressed', button: 'left', buttons: 1, pointerType: 'mouse' }),
      expect.objectContaining({ type: 'mouseReleased', button: 'left', buttons: 0, pointerType: 'mouse' }),
    ]);

    const noNav = T.formatCliError(
      new Error('Click on <A href="https://www.iana.org/help/example-domains"> did not navigate. Try jsclick or click --js.'),
      { cmd: 'click', targetPrefix: '1D366978' },
    );
    expect(noNav).toMatch(/Kind: no-navigation/);
    expect(noNav).toMatch(/Next: cdp jsclick 1D366978 a/);
    expect(noNav).not.toMatch(/overlay/);
    expect(noNav).not.toMatch(/Kind: unknown/);

    const recommendation = T.buildNoChangeOutcomeRecommendation({
      action: 'click',
      target: '1D366978',
      targetInput: 'a',
      targetInfo: { input: 'a', label: 'Learn more', dispatchText: 'Clicked <A> "Learn more"' },
    });
    expect(recommendation.blockingSignals).not.toContain('overlay-check-needed');
    expect(recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);
  });

  it('#228 click --qa names the live page from page-health evidence', () => {
    expect(T.pageHealthScript()).toMatch(/document\.title/);
    const health = T.classifyPageHealth({
      url: 'https://example.com/',
      title: 'Example Domain',
      readyState: 'complete',
      visibleTextLength: 80,
      elementCount: 12,
      visibleControlCount: 1,
      bodyRect: { width: 800, height: 600 },
    });
    expect(health.evidence).toMatchObject({ url: 'https://example.com/', title: 'Example Domain' });

    const summary = T.buildQaSummaryModel({
      page: { url: '', title: '' },
      pageHealth: health,
      console: { errors: 0, exceptions: 0 },
      network: { failures: 0 },
      action: { outcome: 'no-change', dispatch: { ok: true }, changed: false },
      targetPrefix: '1D366978',
    });
    expect(summary.page).toMatchObject({
      url: 'https://example.com/',
      title: 'Example Domain',
    });
    const text = T.formatQaSummaryText(summary);
    expect(text).toContain('Example Domain');
    expect(text).toContain('https://example.com/');
    expect(text).not.toContain('(untitled)');
    expect(text).not.toContain('(unknown)');
  });

  it('#228 treats a Document GET / href change as navigation instead of 8s no-change + overlay', () => {
    expect(T.shouldSkipActionDomSettle(
      'https://example.com/',
      'https://www.iana.org/help/example-domains',
    )).toBe(true);
    expect(T.shouldSkipActionDomSettle('https://example.com/', 'https://example.com/')).toBe(false);
    expect(T.formatActionNavigationDiff(
      'https://example.com/',
      'https://www.iana.org/help/example-domains',
    )).toMatch(/Navigated.*example\.com.*example-domains/);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: {
        targetId: '1D366978FULL',
        input: 'a',
        label: 'Learn more',
        dispatchText: 'Clicked <A> "Learn more"',
      },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 180 },
      effects: {
        domDiff: T.noBaselineActionDiffText(),
        console: [],
        network: [],
        navigation: {
          from: 'https://example.com/',
          to: 'https://www.iana.org/help/example-domains',
          changed: true,
        },
        pageHealth: {
          status: 'populated',
          isBlank: false,
          evidence: {
            url: 'https://www.iana.org/help/example-domains',
            title: 'Example Domains',
          },
        },
      },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 0,
        pending: 0,
        entries: [{
          method: 'GET',
          url: 'https://www.iana.org/help/example-domains',
          status: 200,
          type: 'Document',
          duration: 60,
        }],
      },
    });

    expect(result.outcome).toMatchObject({
      status: 'changed',
      changed: true,
      evidence: 'navigation',
    });
    expect(result.receipt.outcome).toBe('changed');
    expect(result.receipt.blockingSignals || []).not.toContain('overlay-check-needed');
    expect(result.recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);
    expect(T.formatActionText(result)).toContain('Network sample: GET /help/example-domains -> 200 in 60ms');
    expect(T.formatActionText(result)).not.toMatch(/Outcome: no-change/);
    expect(result.settle.durationMs).toBeLessThan(500);

    const networkOnly = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: '1D366978FULL', input: 'a', label: 'Learn more' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 90 },
      effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 0,
        pending: 0,
        entries: [{
          method: 'GET',
          url: 'https://www.iana.org/help/example-domains',
          status: 200,
          type: 'Document',
          duration: 60,
        }],
      },
    });
    expect(networkOnly.outcome).toMatchObject({ status: 'changed', changed: true, evidence: 'navigation' });
    expect(networkOnly.receipt.blockingSignals || []).not.toContain('overlay-check-needed');

    const hrefOnly = T.createActionResult({
      action: 'click',
      target: { targetId: '1D366978FULL', input: 'a', label: 'Learn more' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: T.noBaselineActionDiffText(),
        console: [],
        network: [],
        navigation: {
          from: 'https://example.com/',
          to: 'https://www.iana.org/help/example-domains',
          changed: true,
        },
      },
    });
    expect(hrefOnly.outcome).toMatchObject({ status: 'changed', changed: true, evidence: 'navigation' });
    expect(hrefOnly.receipt.blockingSignals || []).not.toContain('overlay-check-needed');
  });

  it('#228 fail-fast no-navigation stays within 500ms even if location.href eval hangs', async () => {
    const started = Date.now();
    const cdp = {
      send() {
        return new Promise(() => {});
      },
    };
    await expect(T.confirmClickFollowedHref(cdp, 'sid', {
      tag: 'A',
      href: 'https://www.iana.org/help/example-domains',
      pageHref: 'https://example.com/',
    })).rejects.toThrow(/did not navigate/);
    expect(Date.now() - started).toBeLessThanOrEqual(T.CLICK_NAVIGATION_WAIT_MS + 150);

    const hangSettleStarted = Date.now();
    await expect(T.waitForSettle(cdp, 'sid', 120)).resolves.toMatch(/timeout|stable/);
    expect(Date.now() - hangSettleStarted).toBeLessThan(400);
  });

  it('#228 click --qa names the live page on the no-navigation failure path', async () => {
    const failure = T.formatActionFailure(
      new Error('Click on <A href="https://www.iana.org/help/example-domains"> did not navigate. Try jsclick or click --js.'),
      {
        action: 'click',
        target: {
          targetId: '1D366978FULL',
          input: 'a',
          page: { title: 'Example Domain', url: 'https://example.com/' },
        },
      },
    );
    expect(failure).toMatch(/Kind: no-navigation/);
    expect(failure).toMatch(/Next: /);
    expect(failure).not.toMatch(/Kind: overlay/);
    expect(failure).not.toMatch(/Next:.*\boverlay\b/);

    let captured = null;
    await expect(T.runActionWithFeedback({
      action: 'click',
      target: {
        targetId: '1D366978FULL',
        input: 'a',
        label: 'Learn more',
        page: { title: 'Example Domain', url: 'https://example.com/' },
      },
      dispatch: async () => {
        throw new Error('Click on <A href="https://www.iana.org/help/example-domains"> did not navigate. Try jsclick or click --js.');
      },
      feedbackPolicy: 'settle-diff',
      observe: async () => T.noBaselineActionDiffText(),
      enrichActionResult: (result) => {
        result.effects.page = result.target.page;
        result.effects.pageHealth = {
          status: 'populated',
          isBlank: false,
          evidence: result.target.page,
        };
      },
      onActionResult: (result) => { captured = result; },
      format: { format: 'text', qa: true },
    })).rejects.toThrow(/Kind: no-navigation\nNext: cdp jsclick 1D366978 a/);

    expect(captured.dispatch.ok).toBe(false);
    const qa = T.formatActionResultOutput(captured, { qa: true });
    expect(qa).toContain('Example Domain');
    expect(qa).toContain('https://example.com/');
    expect(qa).not.toContain('(untitled)');
    expect(qa).not.toContain('(unknown)');
  });

  it('#229 batch --parallel allows reads and classifies mutating mixes as usage', () => {
    for (const [cmd, args] of [
      ['list', []],
      ['current', []],
      ['status', []],
      ['console', []],
      ['overlay', []],
      ['dialog', []],
      ['viewport', []],
      ['perceive', ['--qa']],
      ['summary', []],
      ['text', ['--auto']],
      ['eval', ['1+1']],
      ['eval', ['document.title']],
      ['cookies', []],
    ]) {
      expect(T.isBatchParallelUnsafeCommand(cmd, args), `${cmd} ${(args || []).join(' ')}`).toBe(false);
    }
    expect(T.isBatchParallelUnsafeCommand('click', ['a'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('dialog', ['accept'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('viewport', ['800x600'])).toBe(true);

    const mutating = T.formatCliError(
      new Error('batch --parallel: click mutate shared state — use sequential batch'),
      { cmd: 'batch', targetPrefix: '1D366978' },
    );
    expect(mutating).toMatch(/Kind: usage/);
    expect(mutating).toMatch(/Next: cdp help batch/);
    expect(mutating).not.toMatch(/Kind: unknown/);
    expect(mutating).not.toMatch(/cdp status 1D366978/);
    expect(T.commandUsageTemplate('batch', '1D366978')).toBe('cdp help batch');
  });

  it('#230 failed flow assert is Kind:assertion / help flow, not status', async () => {
    const out = await T.flowStr({
      run: async () => ({ ok: true, result: 'ok' }),
      settle: async () => '',
      assertCondition: async () => ({ matched: false, description: 'selector #nope exists' }),
    }, 'assert selector #nope; summary', {
      format: 'json',
      targetId: '1D3669785EAC5A1A211792636BAE8A07',
    });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: true,
      counts: { failed: 1 },
      failedStep: {
        kind: 'assert',
        failureKind: 'assertion',
        nextCommand: 'cdp help flow',
        error: 'Assertion failed: selector #nope exists',
      },
      nextSteps: ['cdp help flow'],
    });
    expect(parsed.nextSteps.join('\n')).not.toMatch(/cdp status 1D3669785EAC5A1A211792636BAE8A07/);

    const text = await T.flowStr({
      run: async () => ({ ok: true, result: 'ok' }),
      settle: async () => '',
      assertCondition: async () => ({ matched: false, description: 'text includes "NOPE"' }),
    }, 'assert text NOPE', { targetId: '1D3669785EAC5A1A211792636BAE8A07', throwOnFailure: true }).catch(err => err.message);
    expect(text).toMatch(/Assertion failed/);
    expect(text).toMatch(/Flow halted/);
    const formatted = T.formatCliError(new Error(text), {
      cmd: 'flow',
      targetPrefix: '1D366978',
    });
    expect(formatted).toMatch(/Kind: assertion/);
    expect(formatted).toMatch(/Next: cdp help flow/);
    expect(formatted).not.toMatch(/Kind: unknown/);
    expect(formatted).not.toMatch(/cdp status 1D366978/);
  });

  it('#231 cascade marks the winning rule when specified ≠ computed', async () => {
    const cdp = {
      send(method) {
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 10 });
        if (method === 'CSS.getMatchedStylesForNode') {
          return Promise.resolve({
            matchedCSSRules: [
              {
                rule: {
                  selectorList: { text: 'h1' },
                  origin: 'user-agent',
                  style: {
                    styleSheetId: 'ua.css',
                    range: { startLine: 0 },
                    cssProperties: [
                      { name: 'font-size', value: '2em' },
                      { name: 'font-weight', value: 'bold' },
                      { name: 'display', value: 'block' },
                    ],
                  },
                },
              },
              {
                rule: {
                  selectorList: { text: 'h1' },
                  origin: 'regular',
                  style: {
                    styleSheetId: 'page.css',
                    range: { startLine: 1 },
                    cssProperties: [{ name: 'font-size', value: '1.5em' }],
                  },
                },
              },
            ],
            inherited: [],
          });
        }
        if (method === 'CSS.getComputedStyleForNode') {
          return Promise.resolve({
            computedStyle: [
              { name: 'font-size', value: '24px' },
              { name: 'font-weight', value: '700' },
              { name: 'display', value: 'block' },
            ],
          });
        }
        if (method === 'CSS.getStyleSheetText') return Promise.resolve({ text: 'h1{}' });
        return Promise.resolve({});
      },
    };
    const fontSize = JSON.parse(await T.cascadeStr(cdp, 'sid', 'h1', 'font-size', new Map(), null, { format: 'json' }));
    expect(fontSize.properties[0].winner).toMatchObject({ value: '1.5em', origin: 'regular' });
    expect(fontSize.properties[0].rules.some(rule => rule.winner)).toBe(true);

    const fontWeight = JSON.parse(await T.cascadeStr(cdp, 'sid', 'h1', 'font-weight', new Map(), null, { format: 'json' }));
    expect(fontWeight.properties[0].winner).toMatchObject({ value: 'bold' });

    const display = JSON.parse(await T.cascadeStr(cdp, 'sid', 'h1', 'display', new Map(), null, { format: 'json' }));
    expect(display.properties[0].winner).toMatchObject({ value: 'block' });
    expect(display.properties[0].rules[0].winner).toBe(true);
  });

  it('#234 click --qa names the post-navigation page, not the pre-nav identity', () => {
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: '1D366978FULLTARGET',
        input: 'a',
        label: 'Learn more',
        page: { title: 'Example Domain', url: 'https://example.com/' },
      },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 325 },
      effects: {
        page: { title: 'Example Domain', url: 'https://example.com/' },
        pageHealth: {
          status: 'populated',
          isBlank: false,
          confidence: 'high',
          evidence: {
            url: 'https://www.iana.org/help/example-domains',
            title: 'Example Domains',
            changed: true,
          },
        },
        navigation: {
          from: 'https://example.com/',
          to: 'https://www.iana.org/help/example-domains',
          changed: true,
        },
        domDiff: T.formatActionNavigationDiff(
          'https://example.com/',
          'https://www.iana.org/help/example-domains',
        ),
        console: [],
        network: [],
      },
      nextHint: null,
    });

    const text = T.formatActionResultOutput(result, { qa: true });
    expect(text).toMatch(/^QA summary: pass/m);
    expect(text).toContain('Page: Example Domains');
    expect(text).toContain('URL: https://www.iana.org/help/example-domains');
    expect(text).toContain('Changed: changed');
    expect(text).not.toMatch(/Page: Example Domain$/m);
    expect(text).not.toContain('URL: https://example.com/');

    const parsed = JSON.parse(T.formatActionResultOutput(result, { qa: true, format: 'json' }));
    expect(parsed.summary.page).toMatchObject({
      url: 'https://www.iana.org/help/example-domains',
      title: 'Example Domains',
    });
    expect(parsed.summary.pageHealth.evidence).toMatchObject({
      url: 'https://www.iana.org/help/example-domains',
      title: 'Example Domains',
    });
    expect(parsed.summary.changed).toBe('changed');
  });

  it('#235 report --qa and report on a Chrome PDF viewer use pdf-viewer.v1, not perceive', async () => {
    const session = T.createSessionState({ targetId: '9FAD7C71FULLTARGET', sessionId: 'sid' });
    T.initializeSessionLog(session);
    const page = {
      title: '',
      url: 'https://arxiv.org/pdf/2608.12307',
      contentType: 'application/pdf',
    };

    const qaText = T.formatSessionReport(session, { qa: true, page });
    expect(qaText).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaText).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(qaText).not.toMatch(/QA summary: pass/);
    expect(qaText).not.toMatch(/Page health: populated/);
    expect(qaText).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(qaText).not.toMatch(/cdp click 9FAD7C71 @ref/);

    const qaJson = JSON.parse(T.formatSessionReport(session, { format: 'json', qa: true, page }));
    expect(qaJson.schema).toBe('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaJson.nextCommand).toBe('cdp eval 9FAD7C71 "document.contentType"');
    expect(qaJson).not.toMatchObject({ ok: true });

    const reportText = T.formatSessionReport(session, { page });
    expect(reportText).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(reportText).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(reportText).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(reportText).not.toMatch(/cdp click 9FAD7C71 @ref/);

    const reportJson = JSON.parse(T.formatSessionReport(session, { format: 'json', page }));
    expect(reportJson.nextSteps.join('\n')).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(reportJson.nextSteps.join('\n')).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(reportJson.nextSteps.join('\n')).not.toMatch(/cdp click 9FAD7C71 @ref/);
    expect(reportJson.recommendation.commands.join('\n')).toContain('cdp eval 9FAD7C71 "document.contentType"');

    const handler = T.createReportCommandHandler(session, {
      cdp: {},
      sessionId: 'sid',
      pageInfo: async () => page,
    });
    const qaResult = await handler({ args: ['--qa'] });
    expect(qaResult.value).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(qaResult.value).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(qaResult.value).not.toMatch(/Next: cdp perceive/);

    const defaultResult = await handler({ args: [] });
    expect(defaultResult.value).toContain('chrome-cdp-ex.pdf-viewer.v1');
    expect(defaultResult.value).toContain('cdp eval 9FAD7C71 "document.contentType"');
    expect(defaultResult.value).not.toMatch(/cdp perceive 9FAD7C71 -C -d 8/);
    expect(defaultResult.value).not.toMatch(/cdp click 9FAD7C71 @ref/);
  });
});
