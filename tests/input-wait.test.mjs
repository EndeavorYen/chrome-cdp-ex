import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { waitForStr, isTimeoutError, parseDelayMs, waitStr, ipcTimeoutForRequest, parseTargetAndCommandArgs } = T;

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


describe('wait helpers', () => {
  it('classifies CDP timeout messages by method', () => {
    expect(isTimeoutError(new Error('Timeout: Runtime.evaluate'), ['Runtime.evaluate'])).toBe(true);
    expect(isTimeoutError(new Error('Timeout: Runtime.evaluate'), ['Page.captureScreenshot'])).toBe(false);
    expect(isTimeoutError(new Error('Other failure'))).toBe(false);
  });

  it('parses bounded positive millisecond durations', () => {
    expect(parseDelayMs('30')).toBe(30);
    expect(() => parseDelayMs('0')).toThrow(/at least/);
    expect(() => parseDelayMs('x')).toThrow(/positive integer/);
  });

  it('waitStr waits inside the Node command and reports the duration', async () => {
    const out = await waitStr('1');
    expect(out).toBe('Waited 1ms');
  });

  it('extends IPC timeout for long daemon-backed waits', () => {
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['180000'] })).toBe(185000);
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['30'] })).toBe(120000);
    expect(ipcTimeoutForRequest({ cmd: 'status', args: [] })).toBe(120000);
  });

  it('supports wait ms target form without stealing numeric target prefixes', () => {
    expect(parseTargetAndCommandArgs('wait', ['30000', 'A7BA1234'])).toEqual({
      targetPrefix: 'A7BA1234',
      cmdArgs: ['30000'],
    });
    expect(parseTargetAndCommandArgs('wait', ['12345678', '30000'])).toEqual({
      targetPrefix: '12345678',
      cmdArgs: ['30000'],
    });
  });
});

// =========================================================================
// waitForStr --gone (with CDP mock)
// =========================================================================

describe('waitForStr --gone', () => {
  function trustedGoneFixture({ connected = true, visible = true, frameId = 'main-frame' } = {}) {
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: { frame: { id: frameId } } }),
      'Page.createIsolatedWorld': params => {
        expect(params).toMatchObject({ frameId, grantUniveralAccess: false });
        return { executionContextId: 901 };
      },
      'DOM.resolveNode': ({ executionContextId }) => ({
        object: { objectId: executionContextId === 901 ? 'isolated-ref' : 'page-ref' },
      }),
      'Runtime.callFunctionOn:trusted-connectivity': ({ objectId, functionDeclaration }) => {
        expect(objectId).toBe('isolated-ref');
        expect(functionDeclaration).not.toMatch(/this\.(?:isConnected|ownerDocument|getRootNode)/);
        return { result: { value: { connected } } };
      },
      'Runtime.callFunctionOn': ({ objectId, functionDeclaration }) => {
        if (objectId === 'page-ref') {
          if (/this\.(?:isConnected|offsetParent)/.test(functionDeclaration)) {
            return { result: { value: true } };
          }
          throw new Error('page-realm connectivity accessor was invoked');
        }
        return { result: { value: { connected, visible } } };
      },
    });
    return cdp;
  }

  it('should throw when no selector provided after --gone', async () => {
    const cdp = createMockCDP({});
    await expect(waitForStr(cdp, 'sid1', ['--gone'], new Map()))
      .rejects.toThrow(/selector.*required.*--gone/i);
  });

  it('should return immediately when CSS selector element is already absent', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'null' } }),
    });
    const result = await waitForStr(cdp, 'sid1', ['--gone', '.stop-btn', '5000'], new Map());
    expect(result).toMatch(/gone/i);
  });

  it('should return when CSS selector element disappears after polling', async () => {
    let callCount = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        callCount++;
        // Element present for first 2 calls, then gone
        return { result: { value: callCount <= 2 ? '"yes"' : 'null' } };
      },
    });
    const result = await waitForStr(cdp, 'sid1', ['--gone', '.loading', '5000'], new Map());
    expect(result).toMatch(/gone/i);
    expect(callCount).toBeGreaterThan(2);
  });

  it('should throw on timeout when CSS element never disappears', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: '"yes"' } }),
    });
    await expect(waitForStr(cdp, 'sid1', ['--gone', '.sticky', '500'], new Map()))
      .rejects.toThrow(/still present/);
  });

  it('should throw for unknown @ref', async () => {
    const cdp = createMockCDP({});
    const refMap = new Map(); // empty — no refs
    await expect(waitForStr(cdp, 'sid1', ['--gone', '@99', '500'], refMap))
      .rejects.toThrow(/Unknown ref/);
  });

  it.each([
    ['top', 'Page.getFrameTree'],
    ['top', 'Page.createIsolatedWorld'],
    ['top', 'DOM.resolveNode'],
    ['top', 'Runtime.callFunctionOn'],
    ['frame', 'Page.createIsolatedWorld'],
    ['frame', 'DOM.resolveNode'],
    ['frame', 'Runtime.callFunctionOn'],
  ])('propagates transient %s-ref %s failures without invalidating the ref', async (scope, method) => {
    const transient = new Error(`transient ${method} failure`);
    const handlers = {
      'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main-frame' } } }),
      'Page.createIsolatedWorld': () => ({ executionContextId: 901 }),
      'DOM.resolveNode': () => ({ object: { objectId: 'isolated-ref' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { connected: true, visible: true } } }),
    };
    handlers[method] = () => { throw transient; };
    const cdp = createMockCDP(handlers);
    const refMap = new Map(scope === 'top' ? [[6, 60606]] : []);
    const refState = {
      generation: 1,
      invalidationReason: null,
      ...(scope === 'frame' ? {
        frameRefs: new Map([['@f2', {
          frameRef: '@f2',
          frameId: 'child-frame',
          refs: new Map([[1, 61616]]),
        }]]),
      } : {}),
    };
    const ref = scope === 'top' ? '@6' : '@f2:1';

    await expect(waitForStr(cdp, 'sid1', ['--gone', ref, '500'], refMap, refState))
      .rejects.toBe(transient);

    expect(refState.invalidationReason).toBeNull();
    if (scope === 'top') expect(refMap.get(6)).toBe(60606);
    else expect(refState.frameRefs.get('@f2').refs.get(1)).toBe(61616);
  });

  it('should return when @ref element is removed from DOM (resolveNode throws)', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => { throw new Error('Could not find node'); },
    });
    const refMap = new Map([[5, 12345]]); // ref @5 → backendNodeId 12345
    const result = await waitForStr(cdp, 'sid1', ['--gone', '@5', '5000'], refMap);
    expect(result).toMatch(/@5.*gone.*removed/i);
  });

  it('should return when @ref element becomes disconnected', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { connected: false, visible: false } } }),
    });
    const refMap = new Map([[3, 99999]]);
    const result = await waitForStr(cdp, 'sid1', ['--gone', '@3', '5000'], refMap);
    expect(result).toMatch(/@3.*gone.*disconnected|hidden/i);
  });

  it('should timeout when @ref element stays present', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { connected: true, visible: true } } }),
    });
    const refMap = new Map([[7, 77777]]);
    await expect(waitForStr(cdp, 'sid1', ['--gone', '@7', '500'], refMap))
      .rejects.toThrow(/@7.*still present/);
  });

  it('reports a detached @ref gone despite forged page-realm connectivity', async () => {
    const cdp = trustedGoneFixture({ connected: false, visible: true });
    const refMap = new Map([[8, 80808]]);
    const refState = { generation: 1, invalidationReason: null };

    await expect(waitForStr(cdp, 'sid1', ['--gone', '@8', '500'], refMap, refState))
      .resolves.toMatch(/@8.*gone.*removed|disconnected/i);

    expect(refMap.has(8)).toBe(false);
    expect(refState.invalidationReason).toBe('dom-mutation');
    expect(cdp.calls.some(call => (
      call.method === 'Runtime.callFunctionOn' && call.params.objectId === 'page-ref'
    ))).toBe(false);
  });

  it('supports a connected hidden frame ref without clearing its mapping', async () => {
    const cdp = trustedGoneFixture({ connected: true, visible: false, frameId: 'child-frame' });
    const refState = {
      generation: 1,
      frameRefs: new Map([['@f2', {
        frameRef: '@f2',
        frameId: 'child-frame',
        parentId: null,
        refs: new Map([[1, 81818]]),
      }]]),
    };

    await expect(waitForStr(cdp, 'sid1', ['--gone', '@f2:1', '500'], new Map(), refState))
      .resolves.toMatch(/@f2:1.*gone.*hidden/i);

    expect(refState.frameRefs.get('@f2').refs.get(1)).toBe(81818);
    expect(cdp.calls.some(call => call.method === 'Page.getFrameTree')).toBe(false);
    expect(cdp.calls.find(call => call.method === 'Page.createIsolatedWorld')?.params.frameId)
      .toBe('child-frame');
  });

  it('polls connected visible refs through a trusted isolated-world visibility probe', async () => {
    const cdp = trustedGoneFixture({ connected: true, visible: true });

    await expect(waitForStr(cdp, 'sid1', ['--gone', '@9', '500'], new Map([[9, 90909]]), {
      generation: 1,
    })).rejects.toThrow(/@9.*still present/);

    const visibilityCalls = cdp.calls.filter(call => (
      call.method === 'Runtime.callFunctionOn'
      && call.params.functionDeclaration.includes('getClientRects')
    ));
    expect(visibilityCalls.length).toBeGreaterThan(0);
    expect(visibilityCalls.every(call => call.params.objectId === 'isolated-ref')).toBe(true);
    expect(visibilityCalls[0].params.functionDeclaration)
      .not.toMatch(/this\.(?:isConnected|offsetParent)/);
  });
});

// =========================================================================
// waitfor --any-of and --selector-stable
// =========================================================================

describe('waitForStr --any-of', () => {
  const { waitForStr } = T;

  it('returns immediately when one of the alternatives is present', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ matched: 'win', snippet: '... you win ...', len: 200 }) } }),
    });
    const out = await waitForStr(cdp, 'sid1', ['--any-of', 'win|lose|escape', '5000'], new Map());
    expect(out).toMatch(/Found "win"/);
  });

  it('throws when no alternative appears before timeout', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'null' } }),
    });
    await expect(waitForStr(cdp, 'sid1', ['--any-of', 'a|b|c', '500'], new Map()))
      .rejects.toThrow(/Timeout: any of/);
  });

  it('rejects empty patterns', async () => {
    const cdp = createMockCDP({});
    await expect(waitForStr(cdp, 'sid1', ['--any-of', '|', '500'], new Map()))
      .rejects.toThrow(/at least one alternative/);
  });
});

describe('waitForStr --selector-stable', () => {
  const { waitForStr } = T;

  it('throws when no selector is given', async () => {
    const cdp = createMockCDP({});
    await expect(waitForStr(cdp, 'sid1', ['--selector-stable'], new Map()))
      .rejects.toThrow(/Selector required/);
  });

  it('returns once the selector content has stabilised', async () => {
    let calls = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        calls++;
        // Always returns the same hash → considered stable after 2 polls.
        return { result: { value: JSON.stringify({ len: 10, hash: 'abc' }) } };
      },
    });
    const out = await waitForStr(cdp, 'sid1', ['--selector-stable', '.combat-log', '50', '5000'], new Map());
    expect(out).toMatch(/stable for 50ms/);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('times out when the selector keeps changing', async () => {
    let n = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ len: 10, hash: 'h' + (n++) }) } }),
    });
    await expect(waitForStr(cdp, 'sid1', ['--selector-stable', '.x', '300', '500'], new Map()))
      .rejects.toThrow(/did not stabilise/);
  });
});
