import { describe, it, expect, beforeEach } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { formatCliError, captureScreenshot, screencastFallback, formatScreenshotCaptureDiagnostics, resetScreenshotTier, getScreenshotTier, createScreenshotTierState } = T;

// =========================================================================
// CDP pending command rejection (#144)
// =========================================================================

describe('diff-shot', () => {
  it('parses threshold, reset, and baseline options', () => {
    expect(T.parseDiffShotArgs(['--threshold', '0.5', '--keep-baseline'])).toEqual({
      format: 'text',
      thresholdRatio: 0.005,
      reset: false,
      keepBaseline: true,
    });
    expect(T.parseDiffShotArgs(['--format', 'json', '--reset'])).toEqual({
      format: 'json',
      thresholdRatio: 0,
      reset: true,
      keepBaseline: false,
    });
  });

  it('formats a first baseline capture with an executable next step', () => {
    const out = T.formatDiffShotResult({
      schema: 'chrome-cdp-ex.diff-shot.v1',
      targetId: 'ABC123',
      baselineCaptured: true,
      baselinePath: '/tmp/base.png',
      currentPath: '/tmp/base.png',
      diffPath: null,
      changedPixels: 0,
      totalPixels: 0,
      changedRatio: 0,
      thresholdRatio: 0,
      exceedsThreshold: false,
      advancedBaseline: true,
      fallback: false,
    });

    expect(out).toContain('Diff-shot baseline captured');
    expect(out).toContain('/tmp/base.png');
    expect(out).toContain('Make the change to compare, then run diff-shot again');
    expect(out).toContain('Next: cdp diff-shot ABC123');
  });

  it('formats a pixel diff with reviewable artifacts and honest scope', () => {
    const out = T.formatDiffShotResult({
      schema: 'chrome-cdp-ex.diff-shot.v1',
      targetId: 'ABC123',
      baselineCaptured: false,
      baselinePath: '/tmp/base.png',
      currentPath: '/tmp/current.png',
      diffPath: '/tmp/diff.png',
      width: 10,
      height: 10,
      changedPixels: 7,
      totalPixels: 100,
      changedRatio: 0.07,
      thresholdRatio: 0.01,
      exceedsThreshold: true,
      advancedBaseline: true,
      fallback: true,
    });

    expect(out).toContain('Diff-shot: changed 7/100 px (7.00%)');
    expect(out).toContain('Threshold: 1.00% (exceeded)');
    expect(out).toContain('Baseline: /tmp/base.png');
    expect(out).toContain('Current: /tmp/current.png');
    expect(out).toContain('Diff image: /tmp/diff.png');
    expect(out).toContain('Pixel diff: the regions say where pixels changed, not why');
    expect(out).toContain('screenshot fallback');
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// captureScreenshot — multi-tier fallback
// =========================================================================

describe('captureScreenshot', () => {
  beforeEach(() => {
    resetScreenshotTier();
  });

  it('should return data from Tier 1 (standard captureScreenshot) on success', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => ({ data: 'base64png-tier1' }),
    });
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(result.data).toBe('base64png-tier1');
    expect(result.fallback).toBe(false);
    expect(getScreenshotTier()).toBe(1); // tier not advanced
  });

  it('should fall to Tier 2 (fromSurface:false) when Tier 1 times out', async () => {
    let callCount = 0;
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        callCount++;
        if (!params.fromSurface && params.fromSurface !== undefined) {
          // Tier 2: fromSurface:false — succeeds
          return { data: 'base64png-tier2' };
        }
        // Tier 1: standard — timeout
        throw new Error('Timeout: Page.captureScreenshot');
      },
    });
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(result.data).toBe('base64png-tier2');
    expect(result.fallback).toBe(true);
    expect(getScreenshotTier()).toBe(2); // advanced to tier 2
    expect(callCount).toBe(2);
  });

  it('should fall to Tier 3 (screencast) when Tier 1 and 2 both time out', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        throw new Error('Timeout: Page.captureScreenshot');
      },
      'event:Page.screencastFrame': () => ({ data: 'base64png-tier3', sessionId: 42 }),
    });
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(result.data).toBe('base64png-tier3');
    expect(result.fallback).toBe(true);
    expect(getScreenshotTier()).toBe(3);
  });

  it('should throw descriptive error when all tiers fail', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        throw new Error('Timeout: Page.captureScreenshot');
      },
      // No screencast event handler → waitForEvent will reject with timeout
    });
    await expect(captureScreenshot(cdp, 'sid1', { format: 'png' }))
      .rejects.toThrow(/all methods timed out/);
    expect(getScreenshotTier()).toBe(3);
  });

  it('should re-throw non-timeout errors from Tier 1 without advancing tier', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        throw new Error('Protocol error: Target closed');
      },
    });
    await expect(captureScreenshot(cdp, 'sid1', { format: 'png' }))
      .rejects.toThrow(/Target closed/);
    expect(getScreenshotTier()).toBe(1); // not advanced — it was not a timeout
  });

  it('should pass params (including clip) through to CDP', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        return { data: JSON.stringify(params) };
      },
    });
    const clip = { x: 10, y: 20, width: 100, height: 50, scale: 1 };
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png', clip });
    const passedParams = JSON.parse(result.data);
    expect(passedParams.clip).toEqual(clip);
    expect(passedParams.format).toBe('png');
  });

  // --- Tier caching (command-scoped, #452) ---

  it('skips Tier 1 for the rest of a command after a Tier 1 timeout when the command shares a tier state', async () => {
    let tier1Calls = 0;
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        if (params.fromSurface === false) return { data: 'tier2-ok' };
        tier1Calls++;
        throw new Error('Timeout: Page.captureScreenshot');
      },
    });
    const tierState = createScreenshotTierState();

    await captureScreenshot(cdp, 'sid1', { format: 'png' }, { tierState });
    expect(tier1Calls).toBe(1);

    tier1Calls = 0;
    await captureScreenshot(cdp, 'sid1', { format: 'png' }, { tierState });
    expect(tier1Calls).toBe(0); // Tier 1 was NOT attempted within the same command
    expect(tierState.tier).toBe(2);
  });

  it('skips Tier 1 and 2 for the rest of a command after both time out', async () => {
    let cdpCalls = 0;
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        cdpCalls++;
        throw new Error('Timeout: Page.captureScreenshot');
      },
      'event:Page.screencastFrame': () => ({ data: 'tier3-ok', sessionId: 1 }),
    });
    const tierState = createScreenshotTierState();

    await captureScreenshot(cdp, 'sid1', { format: 'png' }, { tierState });
    expect(cdpCalls).toBe(2); // Tier 1 + Tier 2

    cdpCalls = 0;
    await captureScreenshot(cdp, 'sid1', { format: 'png' }, { tierState });
    expect(cdpCalls).toBe(0); // straight to Tier 3
    expect(tierState.tier).toBe(3);
  });

  it('#452: a later capture starts at plain Page.captureScreenshot even after an earlier Tier 1 timeout', async () => {
    // A target where fromSurface:false fails (Electron on Windows: PrintWindow) but the
    // plain call works once the transient stall is over.
    let stalled = true;
    const tier1Params = [];
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        if (params.fromSurface === false) throw new Error('Unable to capture screenshot');
        tier1Params.push(params);
        if (stalled) throw new Error('Timeout: Page.captureScreenshot');
        return { data: 'plain-ok' };
      },
      'event:Page.screencastFrame': () => ({ data: 'screencast-ok', sessionId: 3 }),
    });

    const first = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(first.method).toBe('screencast');
    expect(first.attempts.map(a => a.tier)).toEqual([1, 2]);

    stalled = false;
    const second = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(second.data).toBe('plain-ok');
    expect(second.method).toBe('captureScreenshot');
    expect(second.fallback).toBe(false);
    expect(tier1Params.at(-1)).toEqual({ format: 'png' });
  });

  it('#452: moves on when fromSurface:false is refused instead of throwing the raw CDP error', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        if (params.fromSurface === false) throw new Error('Unable to capture screenshot');
        throw new Error('Timeout: Page.captureScreenshot');
      },
      'event:Page.screencastFrame': () => ({ data: 'screencast-ok', sessionId: 5 }),
    });
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(result.data).toBe('screencast-ok');
    expect(result.attempts).toEqual([
      { tier: 1, timedOut: true, message: 'Timeout: Page.captureScreenshot' },
      { tier: 2, timedOut: false, message: 'Unable to capture screenshot' },
    ]);
  });

  it('#452: a total failure names every tier and its CDP error', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => { throw new Error('Unable to capture screenshot'); },
    });
    const error = await captureScreenshot(cdp, 'sid1', { format: 'png' }, { timeoutMs: 50 }).catch(e => e);
    expect(error.code).toBe('screenshot_capture_failed');
    expect(error.message).toMatch(/^Screenshot failed: no capture method succeeded \(/);
    expect(error.message).toContain('tier 1 Page.captureScreenshot: Unable to capture screenshot');
    expect(error.message).toContain('tier 2 Page.captureScreenshot fromSurface:false: Unable to capture screenshot');
    expect(error.message).toContain('tier 3 Page.startScreencast frame:');
    const text = formatCliError(error, { cmd: 'shot', targetPrefix: 'ABCD1234' });
    expect(text).toContain('Kind: screenshot-capture');
    expect(text).toContain('Next: cdp perceive ABCD1234 -C -d 8');
  });

  it('#452: a bare CDP capture error from the daemon is classified, not unknown', () => {
    const text = formatCliError(new Error('Unable to capture screenshot'), { cmd: 'shot', targetPrefix: 'ABCD1234' });
    expect(text).toContain('Kind: screenshot-capture');
    expect(text).not.toContain('Kind: unknown');
  });

  it('reports which tier failed in the fallback diagnostic line', () => {
    const line = formatScreenshotCaptureDiagnostics({
      fallback: true,
      method: 'screencast',
      attempts: [{ tier: 2, timedOut: false, message: 'Unable to capture screenshot' }],
    });
    expect(line).toBe('(screenshot fallback method=screencast: tier 2 Unable to capture screenshot)');
  });
});

// =========================================================================
// screencastFallback
// =========================================================================

describe('screencastFallback', () => {
  it('should return frame data on successful screencast', async () => {
    const cdp = createMockCDP({
      'event:Page.screencastFrame': () => ({ data: 'screencast-b64', sessionId: 7 }),
    });
    const data = await screencastFallback(cdp, 'sid1');
    expect(data).toBe('screencast-b64');
    // Verify startScreencast was called
    expect(cdp.calls.some(c => c.method === 'Page.startScreencast')).toBe(true);
  });

  it('should call stopScreencast in finally (even on success)', async () => {
    const cdp = createMockCDP({
      'event:Page.screencastFrame': () => ({ data: 'ok', sessionId: 1 }),
    });
    await screencastFallback(cdp, 'sid1');
    // stopScreencast is fire-and-forget so it may appear after a microtask
    await new Promise(r => setTimeout(r, 10));
    expect(cdp.calls.some(c => c.method === 'Page.stopScreencast')).toBe(true);
  });

  it('should reject when no screencast frame arrives (timeout)', async () => {
    const cdp = createMockCDP({
      // No event:Page.screencastFrame → waitForEvent rejects
    });
    await expect(screencastFallback(cdp, 'sid1')).rejects.toThrow();
  });

  it('should acknowledge frame to prevent screencast stall', async () => {
    const cdp = createMockCDP({
      'event:Page.screencastFrame': () => ({ data: 'ok', sessionId: 99 }),
    });
    await screencastFallback(cdp, 'sid1');
    await new Promise(r => setTimeout(r, 10));
    const ackCall = cdp.calls.find(c => c.method === 'Page.screencastFrameAck');
    expect(ackCall).toBeDefined();
    expect(ackCall.params.sessionId).toBe(99);
  });
});

// =========================================================================
// parseShotArgs / shotStr — saved path first, --quiet/--verbose
// =========================================================================

describe('parseShotArgs', () => {
  const { parseShotArgs } = T;

  it('returns defaults for empty args', () => {
    expect(parseShotArgs([])).toEqual({ filePath: null, quiet: false, verbose: false });
  });

  it('parses --quiet', () => {
    expect(parseShotArgs(['--quiet']).quiet).toBe(true);
    expect(parseShotArgs(['-q']).quiet).toBe(true);
  });

  it('parses --verbose', () => {
    expect(parseShotArgs(['--verbose']).verbose).toBe(true);
  });

  it('captures a positional file path', () => {
    expect(parseShotArgs(['/tmp/a.png']).filePath).toBe('/tmp/a.png');
  });

  it('combines path with --quiet', () => {
    expect(parseShotArgs(['/tmp/a.png', '--quiet']))
      .toEqual({ filePath: '/tmp/a.png', quiet: true, verbose: false });
  });
});

describe('shotStr', () => {
  const { shotStr } = T;
  beforeEach(() => { T.resetScreenshotTier(); });

  it('puts the saved path on the first line by default', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 1 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('PNG').toString('base64') }),
    });
    const dir = mkdtempSync(resolve(tmpdir(), 'cdp-shot-mode-'));
    try {
      const path = resolve(dir, 'capture.png');
      const out = await shotStr(cdp, 'sid1', path, 'TARGETID', { quiet: false });
      expect(out.split('\n')[0]).toBe(path);
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with --quiet returns ONLY the saved path', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 2 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('PNG').toString('base64') }),
    });
    const path = `/tmp/cdp-test-quiet-${Date.now()}.png`;
    const out = await shotStr(cdp, 'sid1', path, 'X', { quiet: true });
    expect(out.split('\n')).toEqual([path]);
  });

  it('with --verbose includes the full DPR coordinate-mapping tutorial', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 2 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('PNG').toString('base64') }),
    });
    const path = `/tmp/cdp-test-verbose-${Date.now()}.png`;
    const out = await shotStr(cdp, 'sid1', path, 'X', { verbose: true });
    expect(out).toMatch(/Coordinate mapping/);
    expect(out).toMatch(/clickxy/);
  });
});

describe('transient black screenshot recovery', () => {
  it('does not describe a successful sanity retry as a capture timeout', () => {
    const diagnostics = formatScreenshotCaptureDiagnostics({
      fallback: true,
      method: 'captureScreenshot-fromSurface-false',
      retryCount: 1,
      sanity: { reason: 'frame-consistent' },
      firstFrameSanity: { reason: 'near-black-frame-on-light-page' },
    });

    expect(diagnostics).toContain('screenshot retry=1');
    expect(diagnostics).toContain('near-black-frame-on-light-page');
    expect(diagnostics).not.toContain('timed out');
  });

  it('retries one contradictory black frame and returns the valid alternate capture', async () => {
    resetScreenshotTier();
    let captures = 0;
    const cdp = {
      send: async (method, params) => {
        expect(method).toBe('Page.captureScreenshot');
        captures += 1;
        return { data: captures === 1 ? 'black-frame' : 'valid-frame', params };
      },
    };
    const inspected = [];

    const result = await captureScreenshot(cdp, 'sid', { format: 'png' }, {
      inspectFrame: async ({ data }) => {
        inspected.push(data);
        return data === 'black-frame'
          ? { retry: true, reason: 'near-black-frame-on-light-page', nearBlackRatio: 0.96, pageTone: 'light' }
          : { retry: false, reason: 'frame-consistent', nearBlackRatio: 0.02, pageTone: 'light' };
      },
      waitForPaint: async () => {},
    });

    expect(captures).toBe(2);
    expect(inspected).toEqual(['black-frame', 'valid-frame']);
    expect(result).toMatchObject({
      data: 'valid-frame',
      method: 'captureScreenshot-fromSurface-false',
      retryCount: 1,
      sanity: { retry: false, reason: 'frame-consistent' },
      firstFrameSanity: { retry: true, reason: 'near-black-frame-on-light-page' },
    });
  });

  it('does not retry a legitimate dark frame', async () => {
    resetScreenshotTier();
    let captures = 0;
    const cdp = {
      send: async () => {
        captures += 1;
        return { data: 'dark-frame' };
      },
    };

    const result = await captureScreenshot(cdp, 'sid', { format: 'png' }, {
      inspectFrame: async () => ({ retry: false, reason: 'dark-page', nearBlackRatio: 0.97, pageTone: 'dark' }),
    });

    expect(captures).toBe(1);
    expect(result).toMatchObject({
      data: 'dark-frame',
      method: 'captureScreenshot',
      retryCount: 0,
      sanity: { retry: false, reason: 'dark-page' },
    });
  });

  it('rejects a persistent contradictory black frame after the bounded retry', async () => {
    resetScreenshotTier();
    const cdp = { send: async () => ({ data: 'black-frame' }) };

    await expect(captureScreenshot(cdp, 'sid', { format: 'png' }, {
      inspectFrame: async () => ({ retry: true, reason: 'near-black-frame-on-light-page' }),
      waitForPaint: async () => {},
    })).rejects.toThrow(/still failed sanity check/i);
  });

  it('rejects when the alternate capture fails instead of returning the known-bad frame', async () => {
    resetScreenshotTier();
    let calls = 0;
    const cdp = {
      send: async () => {
        calls += 1;
        if (calls === 1) return { data: 'black-frame' };
        throw new Error('alternate capture unavailable');
      },
    };

    await expect(captureScreenshot(cdp, 'sid', { format: 'png' }, {
      inspectFrame: async () => ({ retry: true, reason: 'near-black-frame-on-light-page' }),
      waitForPaint: async () => {},
    })).rejects.toThrow(/alternate capture unavailable/i);
  });
});
