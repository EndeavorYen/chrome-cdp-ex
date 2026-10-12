// #644: open creates about:blank, then navigateOpenTarget polled 1500 ms for the
// requested URL before anything navigated. Same class as #339 (a fixed poll for
// a condition the current step has not caused). This file is the CI guard.

import { describe, expect, it } from 'vitest';
import { runtimeSource } from './runtime-source.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET = 'TARGET644';
const PAGE_URL = 'http://127.0.0.1:9/todo.html';
const REDIRECT_URL = 'http://127.0.0.1:9/done';

function navigateOpenTargetSource() {
  const src = runtimeSource();
  const start = src.indexOf('async function navigateOpenTarget');
  const end = src.indexOf('\nfunction formatOpenNextPerceiveCommand');
  return src.slice(start, end);
}

function blankOpenHarness({
  href = 'about:blank',
  navigationRequested,
  createdUrl,
  onSend,
} = {}) {
  let now = 0;
  let seenNavigate = false;
  const sleepsBefore = [];
  const sleepsAfter = [];
  const waits = [];
  const sends = [];
  const createCdp = () => ({
    connect: async () => {},
    close() {},
    send: async (method, params, sessionId, timeoutMs) => {
      sends.push({ method, params, sessionId, timeoutMs, at: now });
      if (method === 'Page.navigate') seenNavigate = true;
      if (onSend) {
        const replaced = onSend({ method, seenNavigate, now });
        if (replaced !== undefined) return replaced;
      }
      if (method === 'Target.getTargets') {
        const value = typeof href === 'function' ? href({ seenNavigate, now, sends }) : href;
        return { targetInfos: [{ targetId: TARGET, type: 'page', url: value }] };
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'SID644' };
      if (method === 'Target.activateTarget') return {};
      if (method === 'Page.enable') return {};
      if (method === 'Page.navigate') return { frameId: 'FRAME644', loaderId: 'LOAD644' };
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: '{}' } };
      return {};
    },
  });
  const waitForOpenTargetUrlFn = (targetId, url, timeoutMs) => {
    waits.push({ targetId, url, timeoutMs, seenNavigate, at: now });
    return T.waitForOpenTargetUrl(targetId, url, timeoutMs, {
      createCdp,
      getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/issue-644',
      now: () => now,
      sleepFn: async (ms) => {
        (seenNavigate ? sleepsAfter : sleepsBefore).push(ms);
        now += ms;
      },
    });
  };
  const result = T.navigateOpenTarget(TARGET, '/tmp/unused.sock', PAGE_URL, {
    createCdp,
    getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/issue-644',
    waitForOpenTargetUrlFn,
    connectToSocketFn: async () => {
      throw new Error('daemon socket should not be required');
    },
    background: true,
    ...(navigationRequested === undefined ? {} : { navigationRequested }),
    ...(createdUrl === undefined ? {} : { createdUrl }),
  });
  return { result, sleepsBefore, sleepsAfter, waits, sends, seenNavigate: () => seenNavigate };
}

describe('issue #644 open does not poll a blank tab before navigation', () => {
  it('does not sleep or repeat Target.getTargets before Page.navigate on a blank tab', async () => {
    const harness = blankOpenHarness();
    const result = await harness.result;
    const navigateAt = harness.sends.findIndex(call => call.method === 'Page.navigate');
    const pollsBefore = harness.sends.slice(0, navigateAt).filter(call => call.method === 'Target.getTargets');
    expect(result).toMatchObject({ attempted: true, ok: true, method: 'Page.navigate', error: null });
    expect(navigateAt).toBeGreaterThan(-1);
    expect(harness.sleepsBefore).toEqual([]);
    expect(pollsBefore.length).toBeLessThanOrEqual(1);
    expect(harness.waits[0]?.timeoutMs).toBe(0);
    expect(harness.sends.slice(navigateAt + 1).some(call => call.method === 'Target.getTargets')).toBe(false);
  });

  it('returns Target.createTarget with no sleep when the target was created at the URL', async () => {
    const harness = blankOpenHarness({ href: PAGE_URL });
    const result = await harness.result;
    expect(result).toMatchObject({
      attempted: true,
      ok: true,
      method: 'Target.createTarget',
      href: PAGE_URL,
      error: null,
    });
    expect(harness.sends.map(call => call.method)).not.toContain('Page.navigate');
    expect(harness.sleepsBefore).toEqual([]);
    expect(harness.sleepsAfter).toEqual([]);
    expect(harness.waits).toHaveLength(1);
    expect(harness.waits[0].timeoutMs).toBe(0);
  });

  it('treats the blank URL createOpenTarget sends as navigation not yet requested', () => {
    expect(T.OPEN_CREATED_TARGET_URL).toBe('about:blank');
    expect(T.openTargetNavigationRequested(T.OPEN_CREATED_TARGET_URL)).toBe(false);
    expect(T.openTargetNavigationRequested('about:blank/')).toBe(false);
    expect(T.openTargetNavigationRequested('about:srcdoc')).toBe(false);
    expect(T.openTargetNavigationRequested('')).toBe(false);
    expect(T.openTargetNavigationRequested(PAGE_URL)).toBe(true);
  });

  it('polls when the created URL is already the destination, even without an explicit flag', async () => {
    let reads = 0;
    const harness = blankOpenHarness({
      createdUrl: PAGE_URL,
      href: () => {
        reads += 1;
        return reads >= 4 ? PAGE_URL : 'about:blank';
      },
    });
    const result = await harness.result;
    expect(result).toMatchObject({ ok: true, method: 'Target.createTarget', href: PAGE_URL });
    expect(harness.sends.map(call => call.method)).not.toContain('Page.navigate');
    expect(harness.waits[0].timeoutMs).toBe(1500);
    expect(harness.sleepsBefore.length).toBeGreaterThan(0);
  });

  it('still waits out a slow direct create instead of sending a second Page.navigate', async () => {
    let reads = 0;
    const harness = blankOpenHarness({
      navigationRequested: true,
      href: () => {
        reads += 1;
        return reads >= 4 ? PAGE_URL : 'about:blank';
      },
    });
    const result = await harness.result;
    expect(result).toMatchObject({
      attempted: true,
      ok: true,
      method: 'Target.createTarget',
      href: PAGE_URL,
    });
    expect(harness.sends.map(call => call.method)).not.toContain('Page.navigate');
    expect(harness.sleepsBefore.length).toBeGreaterThan(0);
    expect(harness.sleepsBefore.length).toBeLessThan(16);
    expect(harness.waits[0].timeoutMs).toBe(1500);
  });

  it('reports Page.navigate for a redirect whose final URL is not the requested URL', async () => {
    const harness = blankOpenHarness({ href: REDIRECT_URL });
    const result = await harness.result;
    expect(result).toMatchObject({ attempted: true, ok: true, method: 'Page.navigate', error: null });
    expect(harness.sleepsBefore).toEqual([]);
    expect(harness.waits[0]?.timeoutMs).toBe(0);
  });

  it('still observes a URL that appears only after Page.navigate fails', async () => {
    let afterNavReads = 0;
    const harness = blankOpenHarness({
      href: ({ seenNavigate }) => {
        if (!seenNavigate) return 'about:blank';
        afterNavReads += 1;
        return afterNavReads >= 3 ? PAGE_URL : 'about:blank';
      },
      onSend: ({ method }) => {
        if (method === 'Page.navigate') throw new Error('Timeout: Page.navigate');
        if (method === 'Runtime.evaluate') throw new Error('Timeout: Runtime.evaluate');
        return undefined;
      },
    });
    const result = await harness.result;
    expect(result).toMatchObject({
      attempted: true,
      ok: true,
      method: 'Target.url-observed',
      href: PAGE_URL,
    });
    expect(result.attempts.map(attempt => attempt.method)).toEqual([
      'Page.navigate',
      'Runtime.evaluate location.assign',
    ]);
    expect(harness.sleepsBefore).toEqual([]);
    expect(harness.sleepsAfter.length).toBeGreaterThan(0);
    expect(harness.waits.filter(wait => wait.seenNavigate).map(wait => wait.timeoutMs)).toEqual([1500]);
  });

  it('does not call the 1500 ms URL poll before Page.navigate unless navigation was already requested', () => {
    const fn = navigateOpenTargetSource();
    const beforeNavigate = fn.slice(0, fn.indexOf('Page.navigate'));
    expect(beforeNavigate).not.toMatch(/waitForOpenTargetUrlFn\(\s*targetId,\s*url,\s*1500\s*\)/);
    expect(beforeNavigate).toMatch(/navigationRequested\s*\?\s*1500\s*:\s*0/);
  });
});
