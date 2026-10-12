import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, isRef, parsePerceiveArgs, clickStr, fillStr } = T;

// =========================================================================
// isRef
// =========================================================================

describe('isRef', () => {
  it('should match @<digits>', () => {
    expect(isRef('@1')).toBe(true);
    expect(isRef('@42')).toBe(true);
    expect(isRef('@999')).toBe(true);
  });

  it('should reject non-ref strings', () => {
    expect(isRef('@')).toBe(false);
    expect(isRef('1')).toBe(false);
    expect(isRef('@c1')).toBe(false);
    expect(isRef('@abc')).toBe(false);
    expect(isRef('')).toBe(false);
    expect(isRef('#btn')).toBe(false);
    expect(isRef('@ 1')).toBe(false);
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// frame tree helpers
// =========================================================================

describe('frame tree helpers', () => {
  const sampleTree = {
    frame: { id: 'main-frame', url: 'https://app.example.com/', name: 'top' },
    childFrames: [
      {
        frame: {
          id: 'checkout-frame',
          parentId: 'main-frame',
          url: 'https://pay.example.com/checkout',
          name: 'checkout',
          securityOrigin: 'https://pay.example.com',
        },
      },
      {
        frame: {
          id: 'ads-frame',
          parentId: 'main-frame',
          url: 'about:blank',
          name: '',
        },
        childFrames: [
          {
            frame: {
              id: 'nested-frame',
              parentId: 'ads-frame',
              url: 'https://widgets.example.com/picker',
              name: 'picker',
            },
          },
        ],
      },
    ],
  };

  it('parses frame-scoped refs like @f2:4', () => {
    expect(T.parseFrameRef('@f2:4')).toEqual({ frameRef: '@f2', frameIndex: 2, ref: '@4', refIndex: 4 });
    expect(T.parseFrameRef('@4')).toBeNull();
    expect(T.parseFrameRef('@f2')).toBeNull();
  });

  it('parses perceive --frame refs', () => {
    expect(parsePerceiveArgs(['--frame', '@f2']).frameRef).toBe('@f2');
    expect(parsePerceiveArgs(['-F', '@f3']).frameRef).toBe('@f3');
  });

  it('extracts a frame ref from frame-scoped action targets', () => {
    expect(T.frameRefFromActionTarget({ input: '@f2:4' })).toBe('@f2');
    expect(T.frameRefFromActionTarget({ label: '@f3:9' })).toBe('@f3');
    expect(T.frameRefFromActionTarget({ input: '@4' })).toBeNull();
  });

  it('uses the last frame perceive output as the baseline for frame-scoped actions', () => {
    const refState = {
      frameLastOutputs: new Map([['@f2', 'Frame: @f2\nold child state']]),
    };
    expect(T.baselineOutputForActionTarget(refState, 'main page output', { input: '@f2:4' }))
      .toBe('Frame: @f2\nold child state');
    expect(T.baselineOutputForActionTarget(refState, 'main page output', { input: '@4' }))
      .toBe('main page output');
  });

  it('flattens frame trees into stable @f refs', () => {
    const frames = T.flattenFrameTree(sampleTree);
    expect(frames).toEqual([
      expect.objectContaining({ ref: '@f1', id: 'main-frame', parentRef: null, depth: 0 }),
      expect.objectContaining({ ref: '@f2', id: 'checkout-frame', parentRef: '@f1', depth: 1 }),
      expect.objectContaining({ ref: '@f3', id: 'ads-frame', parentRef: '@f1', depth: 1 }),
      expect.objectContaining({ ref: '@f4', id: 'nested-frame', parentRef: '@f3', depth: 2 }),
    ]);
  });

  it('formats frame refs with url and parent context', () => {
    const out = T.formatFrameTreeText(T.flattenFrameTree(sampleTree));
    expect(out).toContain('Frames: 4');
    expect(out).toContain('@f1 top main-frame https://app.example.com/');
    expect(out).toContain('@f2 checkout checkout-frame parent:@f1 https://pay.example.com/checkout');
    expect(out).toContain('@f4 picker nested-frame parent:@f3 https://widgets.example.com/picker');
  });

  it('reads Page.getFrameTree from the target session', async () => {
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: sampleTree }),
    });
    const out = await T.framesStr(cdp, 'sid1');
    expect(out).toContain('Frames: 4');
    expect(out).toContain('@f2 checkout checkout-frame');
    expect(cdp.calls[0]).toMatchObject({ method: 'Page.getFrameTree', sessionId: 'sid1' });
  });

  it('perceives a frame and qualifies element refs with the frame ref', async () => {
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: sampleTree }),
      'Page.createIsolatedWorld': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { executionContextId: 42 };
      },
      'Runtime.evaluate': (params) => {
        expect(params.contextId).toBe(42);
        return { result: { value: JSON.stringify({
          title: 'Checkout',
          url: 'https://pay.example.com/checkout',
          vw: 320,
          vh: 240,
          scrollY: 0,
          scrollMax: 0,
          counts: { button: 1 },
          focused: 'none',
          layoutMap: {},
          styleHints: {},
          cursorInteractives: [],
        }) } };
      },
      'Accessibility.getFullAXTree': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Checkout' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 222 },
        ] };
      },
      'DOM.resolveNode': (params) => {
        if (params.backendNodeId === 222) return { object: { objectId: 'button-object' } };
        if (params.backendNodeId === 333) return { object: { objectId: 'frame-owner' } };
        throw new Error(`unexpected backend node ${params.backendNodeId}`);
      },
      'Runtime.callFunctionOn': (params) => {
        if (params.objectId === 'button-object') return { result: { value: { x: 12, y: 20, w: 80, h: 24, position: '' } } };
        if (params.objectId === 'frame-owner') return { result: { value: { x: 50, y: 40, w: 300, h: 200 } } };
        throw new Error(`unexpected object ${params.objectId}`);
      },
      'DOM.getFrameOwner': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { backendNodeId: 333 };
      },
    });
    const refState = {};
    const out = await T.perceiveStr(
      cdp,
      'sid1',
      new RingBuffer(5),
      new RingBuffer(5),
      new Map(),
      { output: null, model: null },
      { frameRef: '@f2' },
      refState
    );

    expect(out).toContain('Frame: @f2 checkout checkout-frame https://pay.example.com/checkout');
    expect(out).toContain('[button] Pay now  @f2:1  (62,60 80×24)');
    expect(refState.frameRefs.get('@f2').refs.get(1)).toBe(222);
    expect(refState.frameLastOutputs.get('@f2')).toContain('[button] Pay now  @f2:1');
  });

  it('clicks frame-scoped refs using top-level viewport coordinates', async () => {
    const refState = {
      frameRefs: new Map([
        ['@f2', {
          frameRef: '@f2',
          frameId: 'checkout-frame',
          parentId: 'main-frame',
          refs: new Map([[1, 222]]),
        }],
      ]),
    };
    const cdp = createMockCDP({
      'DOM.resolveNode': (params) => {
        if (params.backendNodeId === 222) return { object: { objectId: 'child-button' } };
        if (params.backendNodeId === 333) return { object: { objectId: 'frame-owner' } };
        throw new Error(`unexpected backend node ${params.backendNodeId}`);
      },
      'Runtime.callFunctionOn': (params) => {
        if (params.objectId === 'child-button') {
          return { result: { value: { connected: true, x: 10, y: 5, w: 100, h: 20, tag: 'BUTTON', text: 'Pay now' } } };
        }
        if (params.objectId === 'frame-owner') {
          return { result: { value: { x: 50, y: 40, w: 300, h: 200 } } };
        }
        throw new Error(`unexpected object ${params.objectId}`);
      },
      'DOM.getFrameOwner': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { backendNodeId: 333 };
      },
      'Input.dispatchMouseEvent': () => ({}),
    });

    const out = await T.clickStr(cdp, 'sid1', '@f2:1', new Map(), refState);
    expect(out).toContain('Clicked <BUTTON> "Pay now" (@f2:1)');
    const pressed = cdp.calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed');
    expect(pressed.params.x).toBe(110);
    expect(pressed.params.y).toBe(55);
  });
});

// =========================================================================
// formatUnknownRefError — actionable stale-ref errors
// =========================================================================

describe('formatUnknownRefError', () => {
  const { formatUnknownRefError } = T;

  it('explains never-created refs (daemon-start)', () => {
    const msg = formatUnknownRefError('@31', { generation: 0, invalidationReason: 'daemon-start' });
    expect(msg).toMatch(/No refs have been assigned/);
    expect(msg).toMatch(/perceive/);
  });

  it('explains navigation invalidation', () => {
    const msg = formatUnknownRefError('@31', { generation: 2, invalidationReason: 'navigation' });
    expect(msg).toMatch(/navigated|reloaded/);
    expect(msg).toMatch(/stable CSS selector/);
  });

  it('explains DOM-mutation invalidation in one sentence', () => {
    const msg = formatUnknownRefError('@31', { generation: 2, invalidationReason: 'dom-mutation' });
    expect(msg).toBe('@31 is stale: the DOM changed after the last perceive.');
    expect(msg).not.toMatch(/Unknown ref|batch\/loops/);
  });

  it('falls back to a generic message when state is unset', () => {
    const msg = formatUnknownRefError('@5', {});
    expect(msg).toMatch(/Unknown ref: @5/);
  });
});

describe('resolveRefNode stale backend handling', () => {
  const { resolveRefNode } = T;

  function adversarialRefFixture({ connected = false, frameId = 'main-frame' } = {}) {
    const effects = [];
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: { frame: { id: frameId } } }),
      'Page.createIsolatedWorld': (params) => {
        expect(params).toMatchObject({ frameId, grantUniveralAccess: false });
        return { executionContextId: 901 };
      },
      'DOM.resolveNode': ({ executionContextId }) => ({
        object: { objectId: executionContextId === 901 ? 'isolated-ref' : 'page-ref' },
      }),
      'Runtime.callFunctionOn:trusted-connectivity': ({ objectId, functionDeclaration }) => {
        expect(objectId).toBe('isolated-ref');
        if (/this\.(?:isConnected|ownerDocument|getRootNode)/.test(functionDeclaration)) {
          throw new Error('page-patched connectivity property was invoked');
        }
        return { result: { value: { connected } } };
      },
      'Runtime.callFunctionOn': ({ objectId, functionDeclaration }) => {
        if (functionDeclaration.includes('requestAnimationFrame')) {
          return { result: { value: {
            connected: true,
            x: 10, y: 20, w: 100, h: 30, tag: 'BUTTON', text: 'Forged Alpha',
          } } };
        }
        if (functionDeclaration.includes('this.click()')) effects.push('jsclick');
        if (functionDeclaration.includes("this.focus(); this.value=''")) effects.push('fill');
        return { result: { value: { tag: 'BUTTON', text: 'Forged Alpha' } } };
      },
      'Input.dispatchMouseEvent': () => { effects.push('mouse'); return {}; },
      'Input.insertText': () => { effects.push('insert-text'); return {}; },
    });
    return { cdp, effects };
  }

  it('resolves backend refs with a short timeout so stale refs fail fast', async () => {
    const refMap = new Map([[31, 12345]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'node-31' } }),
    });

    await expect(resolveRefNode(cdp, 'sid', refMap, '@31', { generation: 1 }))
      .resolves.toBe('node-31');

    const resolveCall = cdp.calls.find(call => call.method === 'DOM.resolveNode');
    expect(resolveCall.timeout).toBeLessThanOrEqual(2000);
  });

  it('classifies DOM-mutation stale refs when backend node resolution fails', async () => {
    const refMap = new Map([[31, 12345]]);
    const refState = { generation: 1, invalidationReason: null };
    const cdp = createMockCDP({
      'DOM.resolveNode': () => { throw new Error('No node with given id'); },
    });
    await expect(resolveRefNode(cdp, 'sid', refMap, '@31', refState))
      .rejects.toThrow(/is stale:/);
    expect(refState.invalidationReason).toBe('dom-mutation');
    expect(refMap.has(31)).toBe(false);
  });

  it.each([
    ['click', ({ cdp, refMap, refState }) => clickStr(cdp, 'sid', '@1', refMap, refState)],
    ['jsclick', ({ cdp, refMap, refState }) => T.jsClickStr(cdp, 'sid', '@1', refMap, refState)],
    ['fill', ({ cdp, refMap, refState }) => fillStr(cdp, 'sid', '@1', 'blocked', refMap, refState)],
  ])('rejects a detached ref through trusted isolation before %s effects', async (_label, run) => {
    const { cdp, effects } = adversarialRefFixture();
    const refMap = new Map([[1, 101]]);
    const refState = { generation: 1, invalidationReason: null };

    await expect(run({ cdp, refMap, refState })).rejects.toThrow(/is stale:/);

    expect(effects).toEqual([]);
    expect(refMap.has(1)).toBe(false);
    expect(refState.invalidationReason).toBe('dom-mutation');
    expect(cdp.calls.filter(call => call.method === 'Page.createIsolatedWorld')).toHaveLength(1);
    expect(cdp.calls.find(call => call.method === 'DOM.resolveNode')?.params)
      .toMatchObject({ backendNodeId: 101, executionContextId: 901 });
  });

  it('keeps connected shadow refs valid through native composed-root validation and smooth scroll', async () => {
    const { cdp, effects } = adversarialRefFixture({ connected: true });
    const refMap = new Map([[1, 301]]);
    const refState = { generation: 1, invalidationReason: null };

    await clickStr(cdp, 'sid', '@1', refMap, refState);

    expect(effects).toEqual(['mouse', 'mouse', 'mouse']);
    expect(refMap.get(1)).toBe(301);
    const validation = cdp.calls.find(call => (
      call.method === 'Runtime.callFunctionOn' && call.params.objectId === 'isolated-ref'
    ));
    expect(validation.params.functionDeclaration).toContain('composed: true');
    expect(validation.params.functionDeclaration).not.toMatch(/this\.(?:isConnected|ownerDocument|getRootNode)/);
    expect(cdp.calls.some(call => (
      call.method === 'Runtime.callFunctionOn'
      && call.params.functionDeclaration.includes('requestAnimationFrame')
    ))).toBe(true);
  });

  it('validates frame refs in a frame-owned isolated world', async () => {
    const { cdp } = adversarialRefFixture({ connected: true, frameId: 'child-frame' });
    const refState = {
      generation: 1,
      frameRefs: new Map([['@f2', {
        frameRef: '@f2',
        frameId: 'child-frame',
        parentId: null,
        refs: new Map([[1, 401]]),
      }]]),
    };

    await expect(resolveRefNode(cdp, 'sid', new Map(), '@f2:1', refState))
      .resolves.toBe('isolated-ref');

    expect(cdp.calls.some(call => call.method === 'Page.getFrameTree')).toBe(false);
    expect(cdp.calls.find(call => call.method === 'Page.createIsolatedWorld')?.params.frameId)
      .toBe('child-frame');
  });

  it('can return a page-world wrapper for component expandos only after trusted validation', async () => {
    const { cdp } = adversarialRefFixture({ connected: true });
    const refMap = new Map([[1, 501]]);

    await expect(resolveRefNode(cdp, 'sid', refMap, '@1', { generation: 1 }, { returnRealm: 'page' }))
      .resolves.toBe('page-ref');

    const resolves = cdp.calls.filter(call => call.method === 'DOM.resolveNode');
    expect(resolves.map(call => call.params.executionContextId ?? null)).toEqual([901, null]);
  });
});

// =========================================================================
// formatRefRect — fixed/sticky annotations
// =========================================================================

describe('formatRefRect', () => {
  const { formatRefRect } = T;

  it('formats plain rects without position tag', () => {
    expect(formatRefRect({ x: 10, y: 20, w: 200, h: 30 })).toBe('(10,20 200×30)');
  });

  it('marks fixed elements explicitly', () => {
    expect(formatRefRect({ x: 1543, y: 259, w: 266, h: 52, position: 'fixed' }))
      .toBe('(1543,259 266×52, fixed)');
  });

  it('marks sticky elements explicitly', () => {
    expect(formatRefRect({ x: 0, y: 0, w: 100, h: 48, position: 'sticky' }))
      .toBe('(0,0 100×48, sticky)');
  });

  it('omits position for static/relative/absolute', () => {
    expect(formatRefRect({ x: 0, y: 0, w: 1, h: 1, position: 'absolute' }))
      .toBe('(0,0 1×1)');
    expect(formatRefRect({ x: 0, y: 0, w: 1, h: 1, position: 'static' }))
      .toBe('(0,0 1×1)');
  });
});

// =========================================================================
// stale-ref recovery hint — explicit "no remap" wording in messaging
// =========================================================================

describe('formatUnknownRefError recovery wording', () => {
  const { formatUnknownRefError } = T;

  it('navigation message names a concrete recovery command', () => {
    const msg = formatUnknownRefError('@31', { generation: 2, invalidationReason: 'navigation' });
    expect(msg).toMatch(/perceive/);
    // No claim of automatic remap — agent must re-perceive itself.
    expect(msg).toMatch(/stable CSS selector/);
  });

  it('dom-mutation message is one sentence and does not claim an automatic remap', () => {
    const msg = formatUnknownRefError('@31', { generation: 5, invalidationReason: 'dom-mutation' });
    expect(msg).toBe('@31 is stale: the DOM changed after the last perceive.');
    expect(msg).not.toMatch(/Unknown ref|batch\/loops/);
  });
});
