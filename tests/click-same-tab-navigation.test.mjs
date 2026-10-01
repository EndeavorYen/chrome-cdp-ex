import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PRE_HREF = 'http://127.0.0.1:8447/index.html';
const NEXT_HREF = 'http://127.0.0.1:8447/next.html';

// Fake CDP for the #447 race: a same-tab link to a fast page commits the
// navigation before dispatchClick reads its page-side probe back, so the read
// runs in the new document where the probe no longer exists.
function fakeCdp({
  navigateOnRelease = true,
  emitFrameNavigated = true,
  frameParentId = undefined,
  eventSessionId = 'sid',
  probeSurvives = false,
  seenBeforeNav = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'],
  objectIdReadRejects = false,
  visibility = 'visible',
} = {}) {
  const handlers = new Map();
  const calls = [];
  let href = PRE_HREF;
  let probeAlive = false;
  let seen = [];
  const emit = (method, params, sessionId) => {
    for (const handler of [...(handlers.get(method) || [])]) handler(params, { method, params, sessionId });
  };
  return {
    calls,
    get href() { return href; },
    onEvent(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    listenerCount(method) { return handlers.get(method)?.size || 0; },
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      const src = method === 'Runtime.evaluate'
        ? String(params.expression || '')
        : String(params.functionDeclaration || '');
      if (src.includes('__chromeCdpExClickProbe')) {
        if (src.includes('installed: true')) {
          probeAlive = true;
          seen = [];
          return Promise.resolve({ result: { value: {
            cdpClickProbe: true, ok: true, installed: true, scope: 'top', top: true, href,
          } } });
        }
        if (method === 'Runtime.callFunctionOn' && objectIdReadRejects && !probeAlive) {
          return Promise.reject(new Error('Cannot find context with specified id'));
        }
        if (!probeAlive) return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: false } } });
        return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen: seen.slice() } } });
      }
      if (method === 'Runtime.evaluate' && params.expression === 'location.href') {
        return Promise.resolve({ result: { type: 'string', value: href } });
      }
      if (method === 'Runtime.evaluate' && String(params.expression).includes('visibilityState')) {
        return Promise.resolve({ result: { type: 'string', value: visibility } });
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        seen.push(...seenBeforeNav);
        if (navigateOnRelease) {
          href = NEXT_HREF;
          if (!probeSurvives) probeAlive = false;
          if (emitFrameNavigated) {
            const frame = { id: 'F1', url: NEXT_HREF, loaderId: 'L2' };
            if (frameParentId) frame.parentId = frameParentId;
            emit('Page.frameNavigated', { frame, type: 'Navigation' }, eventSessionId);
          }
        }
      }
      return Promise.resolve({});
    },
  };
}

function hrefReads(cdp) {
  return cdp.calls.filter(c => c.method === 'Runtime.evaluate' && c.params.expression === 'location.href').length;
}

describe('click on a same-tab link that navigates before the probe is read (#447)', () => {
  it('treats a wiped probe plus a main-frame Page.frameNavigated as a landed click', async () => {
    const cdp = fakeCdp();
    await expect(T.dispatchClick(cdp, 'sid', 66, 41, { selector: '#go', x: 66, y: 41 })).resolves.toBeUndefined();
    expect(cdp.listenerCount('Page.frameNavigated')).toBe(0);
  });

  it('falls back to a changed top-level location.href when no navigation event arrived', async () => {
    const cdp = fakeCdp({ emitFrameNavigated: false });
    await expect(T.dispatchClick(cdp, 'sid', 66, 41, { selector: '#go', x: 66, y: 41 })).resolves.toBeUndefined();
    expect(hrefReads(cdp)).toBe(1);
  });

  it('accepts the @ref path when the stale probe objectId cannot be read after navigation', async () => {
    const cdp = fakeCdp({ objectIdReadRejects: true });
    await expect(T.dispatchClick(cdp, 'sid', 66, 41, { selector: '@3', objectId: 'obj-1' })).resolves.toBeUndefined();
  });

  it('keeps no-input-events when the probe is wiped but nothing navigated', async () => {
    const cdp = fakeCdp({ navigateOnRelease: false, seenBeforeNav: [] });
    // Wipe the probe without a navigation: simulate by making the read miss.
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId) => {
      const src = String(params.expression || params.functionDeclaration || '');
      if (src.includes('__chromeCdpExClickProbe') && !src.includes('installed: true')) {
        return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: false } } });
      }
      return send(method, params, sessionId);
    };
    const err = await T.dispatchClick(cdp, 'sid', 66, 41, { selector: '#go' }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/received no mousedown\/click events/);
  });

  it('keeps no-input-events when the probe survived with zero events, even if a navigation fired', async () => {
    const cdp = fakeCdp({ probeSurvives: true, seenBeforeNav: [] });
    const err = await T.dispatchClick(cdp, 'sid', 66, 41, { selector: '#go' }).catch(e => e);
    expect(err.message).toMatch(/received no mousedown\/click events/);
  });

  it('ignores child-frame and other-session navigations', async () => {
    for (const opts of [{ frameParentId: 'PARENT' }, { eventSessionId: 'other-sid' }]) {
      // href unchanged so the fallback cannot rescue it either.
      const cdp = fakeCdp({ ...opts, seenBeforeNav: [] });
      const send = cdp.send.bind(cdp);
      cdp.send = (method, params = {}, sessionId) => {
        if (method === 'Runtime.evaluate' && params.expression === 'location.href') {
          return Promise.resolve({ result: { type: 'string', value: PRE_HREF } });
        }
        return send(method, params, sessionId);
      };
      const err = await T.dispatchClick(cdp, 'sid', 66, 41, { selector: '#go' }).catch(e => e);
      expect(err.message).toMatch(/received no mousedown\/click events/);
    }
  });

  it('keeps the hidden-tab visibility hint on a genuine no-input-events', async () => {
    const cdp = fakeCdp({ navigateOnRelease: false, seenBeforeNav: [], visibility: 'hidden' });
    const err = await T.dispatchClick(cdp, 'sid', 66, 41, { selector: '#go' }).catch(e => e);
    expect(err.message).toMatch(/visibilityState is hidden/);
    expect(err.visibility).toBe('hidden');
  });

  it('adds no CDP round trips when the probe already saw page events', async () => {
    const cdp = fakeCdp({ navigateOnRelease: false });
    await T.dispatchClick(cdp, 'sid', 66, 41, { selector: '#noop' });
    const nonInput = cdp.calls.filter(c => c.method !== 'Input.dispatchMouseEvent');
    expect(nonInput).toHaveLength(2); // probe install + probe read only
    expect(cdp.listenerCount('Page.frameNavigated')).toBe(0);
  });

  it('clickStr on a same-tab <a href> reports the click and the followed href', async () => {
    const cdp = fakeCdp();
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId) => {
      const src = String(params.expression || '');
      if (method === 'Runtime.evaluate' && src.includes('Element not found: ')) {
        return Promise.resolve({ result: { value: JSON.stringify({
          ok: true, x: 66, y: 41, tag: 'A', text: 'Go next', href: NEXT_HREF, pageHref: PRE_HREF,
          hit: { covered: false },
        }) } });
      }
      return send(method, params, sessionId);
    };
    const out = await T.clickStr(cdp, 'sid', '#go', new Map(), {});
    expect(out).toMatch(/^Clicked <A> "Go next"/);
  });
});
