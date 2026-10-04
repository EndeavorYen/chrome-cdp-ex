import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// A hidden tab in a minimized window: no frame until focus emulation makes the document visible.
function hiddenTabCdp({ renderWithFocus = true, failFocusCall = false } = {}) {
  const calls = [];
  let focus = false;
  return {
    calls,
    get focus() { return focus; },
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('visibilityState')) return Promise.resolve({ result: { value: focus ? 'visible' : 'hidden' } });
        return Promise.resolve({ result: { value: '{}' } });
      }
      if (method === 'Emulation.setFocusEmulationEnabled') {
        if (failFocusCall) return Promise.reject(new Error('Emulation.setFocusEmulationEnabled failed'));
        focus = params.enabled === true;
        return Promise.resolve({});
      }
      if (method === 'Page.captureScreenshot') {
        if (focus && renderWithFocus) return Promise.resolve({ data: PNG });
        return Promise.reject(new Error('Timeout: Page.captureScreenshot'));
      }
      return Promise.resolve({});
    },
  };
}

const hooks = { inspectFrame: async () => ({ ok: true }) };

describe('#535 hidden-tab capture in background mode', () => {
  beforeEach(() => T.setBackgroundCaptureGuard(true));
  afterEach(() => T.setBackgroundCaptureGuard(false));

  it('T1: a hidden tab is captured with temporary focus emulation, without activating it', async () => {
    const cdp = hiddenTabCdp();
    const captured = await T.captureScreenshot(cdp, 'sid', { format: 'png' }, hooks);
    expect(captured).toMatchObject({ data: PNG, hiddenTab: true, focusEmulated: true });
    expect(cdp.calls.map(call => call.method)).not.toContain('Target.activateTarget');
    expect(cdp.calls.map(call => call.method)).not.toContain('Page.bringToFront');
  });

  it('T2: focus emulation is off again after the capture, and after a failed retry', async () => {
    const ok = hiddenTabCdp();
    await T.captureScreenshot(ok, 'sid', { format: 'png' }, hooks);
    expect(ok.focus).toBe(false);
    expect(ok.calls.filter(call => call.method === 'Emulation.setFocusEmulationEnabled').map(call => call.params.enabled)).toEqual([true, false]);

    const stillHidden = hiddenTabCdp({ renderWithFocus: false });
    await expect(T.captureScreenshot(stillHidden, 'sid', { format: 'png' }, hooks)).rejects.toMatchObject({ code: 'hidden_tab' });
    expect(stillHidden.focus).toBe(false);
  });

  it('T3: the receipt diagnostics name the focus emulation', () => {
    const line = T.formatScreenshotCaptureDiagnostics({ method: 'captureScreenshot', hiddenTab: true, focusEmulated: true });
    expect(line).toMatch(/focus emulation/);
    expect(T.formatScreenshotCaptureDiagnostics({ method: 'captureScreenshot' })).toBe('');
  });

  it('T4: when the retry fails too, the hidden-tab error and its CDP_BACKGROUND=0 recovery are unchanged', async () => {
    for (const cdp of [hiddenTabCdp({ renderWithFocus: false }), hiddenTabCdp({ failFocusCall: true })]) {
      const err = await T.captureScreenshot(cdp, 'sid', { format: 'png' }, hooks).then(() => null, e => e);
      expect(err?.code).toBe('hidden_tab');
      const out = T.formatCliError(err, { cmd: 'shot', targetPrefix: 'ABCD1234' });
      expect(out).toMatch(/Kind: hidden-tab/);
      expect(out.split('\n').at(-1)).toBe('Next: CDP_BACKGROUND=0 cdp shot ABCD1234 (Kind: hidden-tab)');
    }
  });
});

describe('#535 pre-submit review fixes', () => {
  beforeEach(() => T.setBackgroundCaptureGuard(true));
  afterEach(() => T.setBackgroundCaptureGuard(false));

  it('Medium: once a hidden tab needed focus emulation, later captures in the same command skip the frameless wait', async () => {
    const cdp = hiddenTabCdp();
    const tierState = T.createScreenshotTierState();
    await T.captureScreenshot(cdp, 'sid', { format: 'png' }, { ...hooks, tierState });
    const first = cdp.calls.filter(call => call.method === 'Page.captureScreenshot').length;
    expect(first).toBe(2);
    cdp.calls.length = 0;
    const second = await T.captureScreenshot(cdp, 'sid', { format: 'png' }, { ...hooks, tierState });
    expect(second.focusEmulated).toBe(true);
    expect(cdp.calls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(cdp.focus).toBe(false);
  });

  it('Medium: a retry that fails for another reason (target closed) is not reported as hidden-tab', async () => {
    const cdp = hiddenTabCdp();
    const send = cdp.send.bind(cdp);
    let captures = 0;
    cdp.send = (method, params) => {
      if (method === 'Page.captureScreenshot' && ++captures === 2) return Promise.reject(new Error('Target closed'));
      return send(method, params);
    };
    const err = await T.captureScreenshot(cdp, 'sid', { format: 'png' }, hooks).then(() => null, e => e);
    expect(err?.message).toBe('Target closed');
    expect(err?.code).not.toBe('hidden_tab');
    expect(cdp.focus).toBe(false);
  });
});
