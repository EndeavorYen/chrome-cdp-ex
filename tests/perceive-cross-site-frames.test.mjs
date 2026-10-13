import { describe, expect, it } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PAGE = 'sid';
const CHILD = 'child-sid';
const SECRET_URL = 'http://localhost:9/inner.html?access_token=SECRET_ACCESS_777&user=ada';
const MASKED_URL = 'http://localhost:9/inner.html?access_token=<redacted>&user=ada';

function sameOriginTree() {
  return {
    frame: { id: 'main-frame', url: 'http://127.0.0.1:9/host.html', name: 'top', securityOrigin: 'http://127.0.0.1:9' },
    childFrames: [
      {
        frame: {
          id: 'same-frame',
          parentId: 'main-frame',
          url: 'http://127.0.0.1:9/inner.html',
          name: 'same',
          securityOrigin: 'http://127.0.0.1:9',
        },
        childFrames: [
          {
            frame: {
              id: 'nested-frame',
              parentId: 'same-frame',
              url: 'http://127.0.0.1:9/nested.html',
              name: 'nested',
            },
          },
        ],
      },
    ],
  };
}

function oopifTree(url = SECRET_URL) {
  return {
    frame: {
      id: 'oopif-frame',
      parentId: 'main-frame',
      url,
      name: 'cross',
      securityOrigin: 'http://localhost:9',
    },
    childFrames: [
      {
        frame: {
          id: 'oopif-nested',
          parentId: 'oopif-frame',
          url: 'http://localhost:9/nested.html',
          name: 'nested-cross',
        },
      },
    ],
  };
}

function childEntry(sessionId, tree, handlers = {}) {
  return {
    sessionId,
    targetInfo: { type: 'iframe', url: 'http://localhost:9/inner.html', targetId: `${sessionId}-target` },
    handlers: {
      'Page.getFrameTree': () => ({ frameTree: tree }),
      ...handlers,
    },
  };
}

function frameCdp(children = [childEntry(CHILD, oopifTree())]) {
  return createMockCDP({
    'Page.getFrameTree': () => ({ frameTree: sameOriginTree() }),
    childSessions: children,
  });
}

function attachCalls(cdp) {
  return cdp.calls.filter(call => call.method === 'Target.setAutoAttach');
}

describe('cross-site frames', () => {
  it('appends cross-site frames after same-origin refs and keeps frames.v1', async () => {
    const cdp = frameCdp([
      childEntry(CHILD, oopifTree()),
      {
        sessionId: 'worker-sid',
        targetInfo: { type: 'worker', url: '', targetId: 'worker-target' },
        handlers: { 'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'worker-frame' } } }) },
      },
    ]);
    const plain = await T.framesModel(cdp, PAGE);
    expect(plain.frames.map(frame => frame.ref)).toEqual(['@f1', '@f2', '@f3']);
    expect(plain.frames.some(frame => Object.hasOwn(frame, 'process'))).toBe(false);
    expect(attachCalls(cdp)).toHaveLength(0);

    const model = JSON.parse(await T.framesStr(cdp, PAGE, { format: 'json' }));
    expect(model.schema).toBe('chrome-cdp-ex.frames.v1');
    expect(Object.keys(model).sort()).toEqual(['frameCount', 'frames', 'schema']);
    expect(model.frameCount).toBe(5);
    expect(model.frames.slice(0, 3).map(frame => frame.id)).toEqual(['main-frame', 'same-frame', 'nested-frame']);
    expect(model.frames.slice(0, 3).some(frame => Object.hasOwn(frame, 'process'))).toBe(false);
    expect(model.frames[3]).toMatchObject({
      ref: '@f4',
      id: 'oopif-frame',
      parentRef: '@f1',
      parentId: 'main-frame',
      depth: 1,
      process: 'oopif',
      url: MASKED_URL,
    });
    expect(model.frames[4]).toMatchObject({
      ref: '@f5',
      id: 'oopif-nested',
      parentRef: '@f4',
      depth: 2,
      process: 'oopif',
    });
    expect(JSON.stringify(model)).not.toContain('SECRET_ACCESS_777');
    expect(cdp.calls.some(call => call.sessionId === 'worker-sid')).toBe(false);

    const text = await T.framesStr(cdp, PAGE);
    expect(text).toContain('@f2 same same-frame parent:@f1');
    expect(text).toContain('@f3 nested nested-frame parent:@f2');
    expect(text).toContain(`@f4 cross oopif-frame parent:@f1 ${MASKED_URL} origin:http://localhost:9 process:oopif`);
    expect(text).toContain('@f5 nested-cross oopif-nested parent:@f4 http://localhost:9/nested.html process:oopif');
    expect(text.startsWith('Frames: 5\n')).toBe(true);

    const open = await T.framesStr(cdp, PAGE, { unsafeFull: true });
    expect(open).toContain(SECRET_URL);
    expect(attachCalls(cdp)).toEqual([
      expect.objectContaining({
        sessionId: PAGE,
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: 'iframe' }],
        },
      }),
    ]);
  });

  it('reuses the child session until the main frame navigates', async () => {
    const children = [childEntry(CHILD, oopifTree('http://localhost:9/inner.html'))];
    const cdp = frameCdp(children);
    await T.framesStr(cdp, PAGE);
    await T.framesStr(cdp, PAGE);
    expect(attachCalls(cdp)).toHaveLength(1);
    expect(cdp.calls.filter(call => call.method === 'Page.getFrameTree' && call.sessionId === CHILD).length).toBeGreaterThan(1);

    cdp.emit('Page.frameNavigated', {
      frame: { id: 'main-frame', url: 'http://127.0.0.1:9/next.html' },
    }, { sessionId: PAGE });
    children[0] = childEntry('child-2', {
      frame: {
        id: 'oopif-2',
        parentId: 'main-frame',
        url: 'http://localhost:9/next-inner.html',
        name: 'cross',
      },
    });
    const listed = await T.framesStr(cdp, PAGE);
    expect(listed).toContain('@f4 cross oopif-2 parent:@f1 http://localhost:9/next-inner.html process:oopif');
    expect(listed).not.toContain('oopif-frame');
    expect(attachCalls(cdp)).toHaveLength(2);
    const afterNav = cdp.calls.slice(cdp.calls.findLastIndex(call => (
      call.method === 'Target.setAutoAttach' && call.sessionId === PAGE
    )));
    expect(afterNav.some(call => call.sessionId === CHILD)).toBe(false);
    expect(afterNav.some(call => call.method === 'Page.getFrameTree' && call.sessionId === 'child-2')).toBe(true);
  });

  it('drops a detached child session and reattaches on the next frame list', async () => {
    const children = [childEntry(CHILD, oopifTree('http://localhost:9/inner.html'))];
    const cdp = frameCdp(children);
    const first = await T.framesStr(cdp, PAGE);
    expect(first).toContain('process:oopif');
    cdp.emit('Target.detachedFromTarget', { sessionId: CHILD, targetId: 'child-sid-target' }, { sessionId: PAGE });
    children.length = 0;
    const second = await T.framesStr(cdp, PAGE);
    expect(second.startsWith('Frames: 3\n')).toBe(true);
    expect(second).not.toContain('process:oopif');
    expect(second).toContain('@f3 nested nested-frame parent:@f2');
    expect(attachCalls(cdp)).toHaveLength(2);
  });

  it('caps the cross-site walk and leaves same-origin numbers in place', async () => {
    const childFrames = Array.from({ length: 60 }, (_, index) => ({
      frame: {
        id: `extra-${index}`,
        parentId: 'oopif-root',
        url: `http://localhost:9/e${index}.html`,
        name: '',
      },
    }));
    const cdp = frameCdp([childEntry(CHILD, {
      frame: { id: 'oopif-root', parentId: 'main-frame', url: 'http://localhost:9/root.html', name: 'cross' },
      childFrames,
    })]);
    const model = JSON.parse(await T.framesStr(cdp, PAGE, { format: 'json' }));
    expect(model.frames.slice(0, 3).map(frame => frame.ref)).toEqual(['@f1', '@f2', '@f3']);
    expect(model.frames[3]).toMatchObject({ ref: '@f4', id: 'oopif-root', process: 'oopif', depth: 1 });
    const extras = model.frames.filter(frame => frame.process === 'oopif');
    expect(extras).toHaveLength(50);
    expect(extras.every(frame => frame.depth <= 8)).toBe(true);
    expect(model.frames.some(frame => frame.id === 'extra-49')).toBe(false);

    let deep = { frame: { id: 'deep-9', parentId: 'deep-8', url: 'http://localhost:9/deep.html', name: 'too-deep' } };
    for (let depth = 8; depth >= 0; depth -= 1) {
      deep = {
        frame: {
          id: `deep-${depth}`,
          parentId: depth === 0 ? 'main-frame' : `deep-${depth - 1}`,
          url: `http://localhost:9/deep-${depth}.html`,
          name: 'deep',
        },
        childFrames: [deep],
      };
    }
    const deepCdp = frameCdp([childEntry('deep-sid', deep)]);
    const deepModel = JSON.parse(await T.framesStr(deepCdp, PAGE, { format: 'json' }));
    const deepFrames = deepModel.frames.filter(frame => frame.process === 'oopif');
    expect(deepFrames.map(frame => frame.id)).toEqual([
      'deep-0', 'deep-1', 'deep-2', 'deep-3', 'deep-4', 'deep-5', 'deep-6', 'deep-7',
    ]);
    expect(deepFrames.at(-1).depth).toBe(8);
  });

  it('does not auto-attach while perceive builds the Frames line', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify({
            title: 'Host',
            url: 'http://127.0.0.1:9/host.html',
            contentType: 'text/html',
            vw: 800,
            vh: 600,
            scrollY: 0,
            scrollMax: 0,
            counts: { button: 1 },
            focused: 'none',
            layoutMap: {},
            styleHints: {},
            cursorInteractives: [],
            frameElements: [
              { title: 'Same', src: 'http://127.0.0.1:9/inner.html', host: '127.0.0.1:9', name: '', visible: true },
              { title: 'Cross', src: 'http://localhost:9/inner.html', host: 'localhost:9', name: '', visible: true },
            ],
            frameElementCount: 2,
          }),
        },
      }),
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Host' }, childIds: ['btn', 'ifr1', 'ifr2'] },
          { nodeId: 'btn', parentId: 'root', role: { value: 'button' }, name: { value: 'Outer' }, backendDOMNodeId: 10 },
          { nodeId: 'ifr1', parentId: 'root', role: { value: 'Iframe' }, name: { value: 'Same' }, backendDOMNodeId: 11 },
          { nodeId: 'ifr2', parentId: 'root', role: { value: 'Iframe' }, name: { value: 'Cross' }, backendDOMNodeId: 12 },
        ],
      }),
      'Page.getFrameTree': () => ({ frameTree: sameOriginTree() }),
      'DOM.resolveNode': () => ({ object: { objectId: 'node' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { x: 1, y: 2, w: 3, h: 4, position: 'static' } } }),
      'DOM.getFrameOwner': () => ({ backendNodeId: 11 }),
      childSessions: [childEntry(CHILD, oopifTree())],
    });
    const out = await T.perceiveStr(
      cdp,
      PAGE,
      new T.RingBuffer(4),
      new T.RingBuffer(4),
      new Map(),
      { output: null },
      { targetPrefix: 'AB12CD34' },
    );
    expect(out).toContain('Frames: 2 (2 visible), 1 cross-site not reachable yet. Next: cdp frame AB12CD34');
    expect(out).toContain('[iframe] "localhost:9"');
    expect(out).not.toContain('[iframe] "localhost:9" @f');
    expect(attachCalls(cdp)).toHaveLength(0);
  });

  it('reads a cross-site frame through the child session and leaves a same-origin frame on the page session', async () => {
    const pageMeta = {
      title: 'Inner',
      url: 'http://127.0.0.1:9/inner.html',
      contentType: 'text/html',
      vw: 420,
      vh: 150,
      scrollY: 0,
      scrollMax: 0,
      counts: { button: 1 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
    };
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: sameOriginTree() }),
      'Page.createIsolatedWorld': (params) => {
        expect(params.frameId).toBe('same-frame');
        return { executionContextId: 42 };
      },
      'Runtime.evaluate': (params) => {
        expect(params.contextId).toBe(42);
        return { result: { value: JSON.stringify(pageMeta) } };
      },
      'Accessibility.getFullAXTree': (params, sessionId) => {
        expect(sessionId).toBe(PAGE);
        expect(params.frameId).toBe('same-frame');
        return { nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Inner' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Same pay' }, backendDOMNodeId: 21 },
        ] };
      },
      'DOM.resolveNode': () => ({ object: { objectId: 'same-btn' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { x: 1, y: 2, w: 10, h: 10, position: '' } } }),
      'DOM.getFrameOwner': () => ({ backendNodeId: 90 }),
      childSessions: [childEntry(CHILD, oopifTree('http://localhost:9/inner.html'), {
        'Page.createIsolatedWorld': (params) => {
          expect(params.frameId).toBe('oopif-frame');
          return { executionContextId: 77 };
        },
        'Runtime.evaluate': (params) => {
          expect(params.contextId).toBe(77);
          return { result: { value: JSON.stringify({ ...pageMeta, title: 'Cross', url: 'http://localhost:9/inner.html' }) } };
        },
        'Accessibility.getFullAXTree': (params) => {
          expect(params.frameId).toBe('oopif-frame');
          return { nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Cross' }, childIds: ['2'] },
            { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 55 },
          ] };
        },
        'DOM.resolveNode': () => ({ object: { objectId: 'pay-btn' } }),
        'Runtime.callFunctionOn': () => ({ result: { value: { x: 4, y: 6, w: 40, h: 18, position: '' } } }),
      })],
    });
    const same = await T.perceiveStr(
      cdp, PAGE, new T.RingBuffer(4), new T.RingBuffer(4), new Map(), { output: null }, { frameRef: '@f2' },
    );
    expect(same).toContain('[button] Same pay  @f2:1');
    expect(attachCalls(cdp)).toHaveLength(0);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').every(call => call.sessionId === PAGE)).toBe(true);

    const cross = await T.perceiveStr(
      cdp, PAGE, new T.RingBuffer(4), new T.RingBuffer(4), new Map(), { output: null }, { frameRef: '@f4' },
    );
    expect(cross).toContain('Frame: @f4 cross oopif-frame http://localhost:9/inner.html');
    expect(cross).toContain('[button] Pay now  @f4:1');
    expect(cross).not.toContain('Frames:');
    const ax = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree');
    expect(ax.at(-1)).toMatchObject({ sessionId: CHILD, params: { frameId: 'oopif-frame' } });
    expect(attachCalls(cdp)).toHaveLength(1);
  });
});
