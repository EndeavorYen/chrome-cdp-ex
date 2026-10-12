import { describe, expect, it } from 'vitest';

import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #115 responsive internal geometry contracts', () => {
  it('warns on bounded clipped controls and material control overlap', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: 'ABCDEF0123456789',
      page: { title: 'App', url: 'http://127.0.0.1:8787' },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      viewports: [{
        viewport: '390x844',
        url: 'http://127.0.0.1:8787',
        title: 'App',
        screenshot: '/tmp/mobile.png',
        overflowX: false,
        blank: false,
        controlCount: 4,
        clippedControls: [
          {
            selector: '#hidden-route',
            name: 'Continue',
            severity: 'warning',
            clippedRatio: 0.75,
            elementRect: { x: 420, y: 20, width: 100, height: 40 },
            containerRect: { x: 0, y: 0, width: 390, height: 120 },
          },
          {
            selector: '#intentional-item',
            name: 'Later item',
            severity: 'info',
            suppressed: true,
            suppression: 'intentional-scroll-container',
          },
        ],
        overlaps: [{
          selector: '#save',
          name: 'Save',
          occluderSelector: '.command-bar',
          occluderName: 'Commands',
          severity: 'warning',
          overlapRatio: 0.4,
          elementRect: { x: 10, y: 700, width: 120, height: 40 },
          occluderRect: { x: 0, y: 680, width: 390, height: 80 },
        }],
      }],
    });

    expect(model.verdict).toBe('warn');
    expect(model.viewports[0].findings).toMatchObject({
      clippedControls: [expect.objectContaining({ selector: '#hidden-route', clippedRatio: 0.75 })],
      overlaps: [expect.objectContaining({ selector: '#save', overlapRatio: 0.4 })],
      suppressed: 1,
    });
    expect(model.viewports[0].findings.clippedControls).toHaveLength(1);
    expect(T.formatResponsiveAuditReport(model)).toContain('clipped=1 overlap=1');
  });

  it('collects container clipping and overlap evidence in the viewport probe', () => {
    const script = T.responsiveAuditViewportScript({ maxControls: 4 });
    expect(script).toContain('nearestScrollable');
    expect(script).toContain('clippedControls');
    expect(script).toContain('overlapRatio');
    expect(script).toContain('data-cdp-audit-scroll');
  });

  it('keeps clean responsive fixtures passing and carries screenshot capture metadata', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: 'ABCDEF0123456789',
      page: { title: 'Clean', url: 'https://example.test' },
      console: { errors: 0, warnings: 0, exceptions: 0 },
      viewports: [{
        viewport: '1440x900',
        overflowX: false,
        blank: false,
        clippedControls: [],
        overlaps: [],
        screenshotCapture: { method: 'captureScreenshot', retryCount: 0 },
      }],
    });

    expect(model.verdict).toBe('pass');
    expect(model.viewports[0].screenshotCapture).toEqual({ method: 'captureScreenshot', retryCount: 0 });
  });

  it('fails a viewport whose screenshot remains contradictory after retry', () => {
    const model = T.buildResponsiveAuditModel({
      targetId: 'ABCDEF0123456789',
      viewports: [{
        viewport: '390x844',
        overflowX: false,
        blank: false,
        clippedControls: [],
        overlaps: [],
        screenshotCapture: {
          method: 'captureScreenshot-fromSurface-false',
          retryCount: 1,
          sanity: { retry: true, reason: 'near-black-frame-on-light-page' },
        },
      }],
    });

    expect(model.verdict).toBe('fail');
    expect(model.viewports[0].status).toBe('fail');
  });

  it('executes the viewport probe without treating hidden surfaces as occluders', () => {
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };
    const body = {
      parentElement: null,
      innerText: 'Save',
      textContent: 'Save',
      getBoundingClientRect: () => ({ ...rect, width: 390, height: 844 }),
    };
    const control = {
      id: 'save', tagName: 'BUTTON', parentElement: body, innerText: 'Save', value: '', title: '',
      getAttribute: () => null,
      getBoundingClientRect: () => rect,
      contains: () => false,
    };
    const hiddenSurface = {
      id: 'hidden-dialog', tagName: 'DIALOG', parentElement: body, innerText: '', value: '', title: '',
      getAttribute: () => null,
      getBoundingClientRect: () => rect,
      contains: () => false,
      matches: selector => selector.includes('dialog'),
    };
    const document = {
      documentElement: { scrollWidth: 390, scrollHeight: 844, clientWidth: 390, clientHeight: 844 },
      body,
      title: 'Fixture',
      readyState: 'complete',
      querySelectorAll: selector => selector === 'body *' ? [hiddenSurface]
        : selector === '*' ? [control, hiddenSurface]
          : [control],
      elementFromPoint: () => hiddenSurface,
    };
    const output = runInNewContext(T.responsiveAuditViewportScript({ maxControls: 4 }), {
      document,
      window: { innerWidth: 390, innerHeight: 844 },
      location: { href: 'https://example.test' },
      CSS: { escape: value => value },
      getComputedStyle: element => element === hiddenSurface
        ? { position: 'fixed', visibility: 'hidden', display: 'block', opacity: '1', pointerEvents: 'auto', overflowX: 'visible', overflowY: 'visible' }
        : { position: 'static', visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto', overflowX: 'visible', overflowY: 'visible' },
    });

    expect(JSON.parse(output).overlaps).toEqual([]);
  });
});
