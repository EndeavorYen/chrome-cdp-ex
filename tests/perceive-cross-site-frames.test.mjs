import { describe, expect, it } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PAGE = 'sid';
const CHILD = 'child-sid';
const SIBLING = 'sibling-sid';
const GRAND = 'grand-sid';
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

function siblingEntry() {
  return childEntry(SIBLING, {
    frame: {
      id: 'sibling-frame',
      parentId: 'main-frame',
      url: 'http://192.0.2.8:9/sib.html',
      name: 'sib',
      securityOrigin: 'http://192.0.2.8:9',
    },
  });
}

function grandTree() {
  return {
    frame: {
      id: 'grand-frame',
      parentId: 'oopif-frame',
      url: 'http://127.0.0.2:9/grand.html',
      name: 'third',
      securityOrigin: 'http://127.0.0.2:9',
    },
  };
}

// The grandchild runs in the child session's process boundary. The page's
// auto-attach does not announce it; only the child session does.
function grandEntry(sessionId = GRAND, parentSessionId = CHILD) {
  return {
    ...childEntry(sessionId, grandTree()),
    parentSessionId,
    parentId: 'oopif-frame',
    targetInfo: {
      type: 'iframe',
      url: 'http://127.0.0.2:9/grand.html',
      targetId: `${sessionId}-target`,
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
    const autoAttach = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe' }],
    };
    expect(attachCalls(cdp)).toEqual([
      expect.objectContaining({ sessionId: PAGE, params: autoAttach }),
      expect.objectContaining({ sessionId: CHILD, params: autoAttach }),
    ]);
  });

  it('reuses the child session until the main frame navigates', async () => {
    const children = [childEntry(CHILD, oopifTree('http://localhost:9/inner.html'))];
    const cdp = frameCdp(children);
    await T.framesStr(cdp, PAGE);
    await T.framesStr(cdp, PAGE);
    expect(attachCalls(cdp).map(call => call.sessionId)).toEqual([PAGE, CHILD]);
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
    expect(attachCalls(cdp).map(call => call.sessionId)).toEqual([PAGE, CHILD, PAGE, 'child-2']);
    const afterNav = cdp.calls.slice(cdp.calls.findLastIndex(call => (
      call.method === 'Target.setAutoAttach' && call.sessionId === PAGE
    )));
    expect(afterNav.some(call => call.sessionId === CHILD)).toBe(false);
    expect(afterNav.some(call => call.method === 'Page.getFrameTree' && call.sessionId === 'child-2')).toBe(true);
  });

  it('lists the new cross-site frame after navigation when setAutoAttach does not reattach', async () => {
    const stale = childEntry(CHILD, oopifTree('http://localhost:9/inner.html'));
    const fresh = childEntry('child-2', {
      frame: {
        id: 'oopif-2',
        parentId: 'main-frame',
        url: 'http://localhost:9/next-inner.html',
        name: 'cross',
        securityOrigin: 'http://localhost:9',
      },
    });
    const live = [stale];
    const retained = [];
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: sameOriginTree() }),
      childSessions: live,
      retainedSessions: retained,
    });
    const first = await T.framesStr(cdp, PAGE);
    expect(first).toContain('oopif-frame');
    expect(first).toContain('process:oopif');

    // The new iframe is already attached, so a repeated setAutoAttach stays quiet.
    // The stale session still answers if the navigation clear is skipped.
    live.splice(0, live.length, fresh);
    retained.push(stale);
    cdp.emit('Target.attachedToTarget', {
      sessionId: fresh.sessionId,
      targetInfo: { ...fresh.targetInfo, type: 'iframe' },
      waitingForDebugger: false,
    }, { sessionId: PAGE });
    cdp.emit('Page.frameNavigated', {
      frame: { id: 'main-frame', url: 'http://127.0.0.1:9/host.html' },
    }, { sessionId: PAGE });

    const before = cdp.calls.length;
    const listed = await T.framesStr(cdp, PAGE);
    const after = cdp.calls.slice(before);
    expect(listed).toContain('@f4 cross oopif-2 parent:@f1 http://localhost:9/next-inner.html origin:http://localhost:9 process:oopif');
    expect(listed).not.toContain('oopif-frame');
    expect(after.some(call => call.method === 'Page.getFrameTree' && call.sessionId === CHILD)).toBe(false);
    expect(after.some(call => call.method === 'Target.getTargets' && call.sessionId === PAGE)).toBe(true);
    expect(after.some(call => (
      call.method === 'Target.attachToTarget' && call.params?.targetId === 'child-2-target' && call.sessionId === PAGE
    ))).toBe(true);
    expect(after.some(call => call.method === 'Page.getFrameTree' && call.sessionId === 'child-2')).toBe(true);
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
    expect(attachCalls(cdp).map(call => call.sessionId)).toEqual([PAGE, CHILD, PAGE]);
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
    expect(attachCalls(cdp).map(call => call.sessionId)).toEqual([PAGE, CHILD]);
  });

  it('reads a same-process frame nested in a cross-site frame through that frame\'s child session and clicks its ref', async () => {
    const OWNER_BACKEND = 333;
    const INNER_BACKEND = 444;
    const BUTTON_BACKEND = 55;
    const nestedMeta = {
      title: 'Nested',
      url: 'http://localhost:9/nested.html',
      contentType: 'text/html',
      vw: 200,
      vh: 100,
      scrollY: 0,
      scrollMax: 0,
      counts: { button: 1 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
    };
    const local = {
      connected: true,
      x: 10,
      y: 6,
      w: 40,
      h: 18,
      tag: 'BUTTON',
      text: 'Pay now',
      hit: { covered: false },
      inViewport: true,
      noClickBox: false,
    };
    const contentQuad = (x, y, w = 400, h = 300) => [x, y, x + w, y, x + w, y + h, x, y + h];
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: sameOriginTree() }),
      // The nested frame's <iframe> is in the OOPIF document. The page session
      // has no such frame id; only the child session can own it.
      'DOM.getFrameOwner': ({ frameId }) => {
        if (frameId === 'oopif-nested') throw new Error('No frame for given id found');
        if (frameId === 'oopif-frame') return { backendNodeId: OWNER_BACKEND };
        return { backendNodeId: 0 };
      },
      'DOM.getBoxModel': ({ backendNodeId }) => (
        backendNodeId === OWNER_BACKEND
          ? { model: { content: contentQuad(120, 80) } }
          : { model: {} }
      ),
      'DOM.resolveNode': () => ({ object: { objectId: 'owner-iframe' } }),
      'Runtime.callFunctionOn': (params) => {
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('chrome-cdp-ex.owner-iframe-hit.v1')) {
          return { result: { value: { marker: 'chrome-cdp-ex.owner-iframe-hit.v1', covered: false } } };
        }
        return { result: { value: { connected: true, visible: true } } };
      },
      childSessions: [childEntry(CHILD, oopifTree(), {
        'Page.createIsolatedWorld': (params) => {
          expect(params.frameId).toBe('oopif-nested');
          return { executionContextId: 77 };
        },
        'Runtime.evaluate': (params) => {
          expect(params.contextId).toBe(77);
          return { result: { value: JSON.stringify(nestedMeta) } };
        },
        'Accessibility.getFullAXTree': (params) => {
          expect(params.frameId).toBe('oopif-nested');
          return { nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Nested' }, childIds: ['2'] },
            { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: BUTTON_BACKEND },
          ] };
        },
        'DOM.resolveNode': () => ({ object: { objectId: 'pay-btn' } }),
        'DOM.getFrameOwner': ({ frameId }) => (
          frameId === 'oopif-nested' ? { backendNodeId: INNER_BACKEND } : { backendNodeId: 0 }
        ),
        'DOM.getBoxModel': ({ backendNodeId }) => (
          backendNodeId === INNER_BACKEND
            ? { model: { content: contentQuad(8, 4) } }
            : { model: {} }
        ),
        'Runtime.callFunctionOn': (params) => {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('getBoundingClientRect') || fn.includes('requestAnimationFrame')) {
            return { result: { value: { ...local, hit: { ...local.hit } } } };
          }
          return { result: { value: { connected: true } } };
        },
      })],
    });
    const refState = {};
    const out = await T.perceiveStr(
      cdp, PAGE, new T.RingBuffer(4), new T.RingBuffer(4), new Map(), { output: null }, { frameRef: '@f5' }, refState,
    );
    expect(out).toContain('Frame: @f5 nested-cross oopif-nested http://localhost:9/nested.html');
    expect(out).toContain('[button] Pay now  @f5:1');
    // Page owner (120, 80) plus the nested iframe's box in the child session (8, 4).
    expect(out).toContain('(138,90 40×18)');
    expect(out).not.toContain('Frames:');
    const ax = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree');
    expect(ax.at(-1)).toMatchObject({ sessionId: CHILD, params: { frameId: 'oopif-nested' } });
    expect(cdp.calls.filter(call => (
      call.method === 'Page.createIsolatedWorld' && call.params?.frameId === 'oopif-nested'
    )).every(call => call.sessionId === CHILD)).toBe(true);
    expect(cdp.calls.some(call => (
      call.method === 'DOM.getFrameOwner' && call.sessionId === CHILD && call.params?.frameId === 'oopif-nested'
    ))).toBe(true);
    expect(cdp.calls.some(call => (
      call.method === 'DOM.getFrameOwner' && call.sessionId === PAGE && call.params?.frameId === 'oopif-nested'
    ))).toBe(false);

    const clicked = await T.clickStr(cdp, PAGE, '@f5:1', new Map(), refState);
    expect(clicked).toBe('Clicked <BUTTON> "Pay now" (@f5:1)');
    const pressed = cdp.calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed');
    expect(pressed?.sessionId).toBe(PAGE);
    expect(pressed?.params).toMatchObject({ x: 158, y: 99 });
    expect(cdp.calls.some(call => (
      call.method === 'DOM.resolveNode' && call.sessionId === CHILD && call.params?.backendNodeId === BUTTON_BACKEND
    ))).toBe(true);
  });

  it('adopts only an iframe target whose parent is this page', async () => {
    const foreign = childEntry('foreign-sid', {
      frame: {
        id: 'foreign-frame',
        parentId: 'other-page',
        url: 'http://localhost:9/foreign.html',
        name: 'foreign',
      },
    });
    foreign.parentId = 'other-page';
    const valid = childEntry(CHILD, oopifTree());
    const cdp = frameCdp([valid, foreign]);
    // Announce both before the page is watching, so setAutoAttach stays quiet and
    // adoption is the only way either iframe is attached.
    for (const child of [valid, foreign]) {
      cdp.emit('Target.attachedToTarget', {
        sessionId: child.sessionId,
        targetInfo: {
          type: 'iframe',
          targetId: `${child.sessionId}-target`,
          url: 'http://localhost:9/inner.html',
        },
      }, { sessionId: PAGE });
    }
    const listed = await T.framesStr(cdp, PAGE);
    expect(listed).toContain('oopif-frame');
    expect(listed).not.toContain('foreign-frame');
    expect(cdp.calls.filter(call => call.method === 'Target.attachToTarget').map(call => call.params.targetId))
      .toEqual([`${CHILD}-target`]);
    expect(cdp.calls.some(call => call.sessionId === 'foreign-sid')).toBe(false);
  });

  it('appends a third-site grandchild after other cross-site frames and keeps @fN', async () => {
    const cdp = frameCdp([
      childEntry(CHILD, oopifTree('http://localhost:9/inner.html')),
      siblingEntry(),
      grandEntry(),
    ]);
    const model = JSON.parse(await T.framesStr(cdp, PAGE, { format: 'json' }));
    expect(model.schema).toBe('chrome-cdp-ex.frames.v1');
    expect(Object.keys(model).sort()).toEqual(['frameCount', 'frames', 'schema']);
    expect(model.frameCount).toBe(7);
    expect(model.frames.slice(0, 3).map(frame => [frame.ref, frame.id])).toEqual([
      ['@f1', 'main-frame'],
      ['@f2', 'same-frame'],
      ['@f3', 'nested-frame'],
    ]);
    expect(model.frames.slice(0, 3).some(frame => Object.hasOwn(frame, 'process'))).toBe(false);
    expect(model.frames[3]).toMatchObject({ ref: '@f4', id: 'oopif-frame', parentRef: '@f1', process: 'oopif' });
    expect(model.frames[4]).toMatchObject({ ref: '@f5', id: 'oopif-nested', parentRef: '@f4', process: 'oopif' });
    expect(model.frames[5]).toMatchObject({ ref: '@f6', id: 'sibling-frame', parentRef: '@f1', process: 'oopif' });
    expect(model.frames[6]).toMatchObject({
      ref: '@f7',
      id: 'grand-frame',
      parentId: 'oopif-frame',
      parentRef: '@f4',
      depth: 2,
      process: 'oopif',
      url: 'http://127.0.0.2:9/grand.html',
    });

    const text = await T.framesStr(cdp, PAGE);
    expect(text.startsWith('Frames: 7\n')).toBe(true);
    expect(text).toContain('@f2 same same-frame parent:@f1');
    expect(text).toContain('@f3 nested nested-frame parent:@f2');
    expect(text).toContain('@f5 nested-cross oopif-nested parent:@f4 http://localhost:9/nested.html process:oopif');
    expect(text).toContain('@f6 sib sibling-frame parent:@f1 http://192.0.2.8:9/sib.html origin:http://192.0.2.8:9 process:oopif');
    expect(text).toContain('@f7 third grand-frame parent:@f4 http://127.0.0.2:9/grand.html origin:http://127.0.0.2:9 process:oopif');

    const hosts = attachCalls(cdp).map(call => call.sessionId);
    expect(hosts[0]).toBe(PAGE);
    expect(hosts).toContain(CHILD);
    expect(hosts.indexOf(CHILD)).toBeLessThan(hosts.indexOf(GRAND));
    const again = JSON.parse(await T.framesStr(cdp, PAGE, { format: 'json' }));
    expect(again.frames.map(frame => `${frame.ref}:${frame.id}`)).toEqual(
      model.frames.map(frame => `${frame.ref}:${frame.id}`),
    );
    expect(attachCalls(cdp).map(call => call.sessionId)).toEqual(hosts);
  });

  it('adopts a third-site grandchild from the child session when setAutoAttach stays quiet', async () => {
    const cdp = frameCdp([
      childEntry(CHILD, oopifTree('http://localhost:9/inner.html')),
      grandEntry(),
    ]);
    const first = await T.framesStr(cdp, PAGE);
    expect(first).toContain('@f4 cross oopif-frame parent:@f1');
    expect(first).toContain('@f5 nested-cross oopif-nested parent:@f4');
    expect(first).toContain('@f6 third grand-frame parent:@f4 http://127.0.0.2:9/grand.html origin:http://127.0.0.2:9 process:oopif');

    cdp.emit('Page.frameNavigated', {
      frame: { id: 'main-frame', url: 'http://127.0.0.1:9/host.html' },
    }, { sessionId: PAGE });
    const before = cdp.calls.length;
    const listed = await T.framesStr(cdp, PAGE);
    const after = cdp.calls.slice(before);
    expect(listed).toContain('@f2 same same-frame parent:@f1');
    expect(listed).toContain('@f6 third grand-frame parent:@f4 http://127.0.0.2:9/grand.html origin:http://127.0.0.2:9 process:oopif');
    expect(after.some(call => call.method === 'Target.getTargets' && call.sessionId === PAGE)).toBe(true);
    expect(after.some(call => (
      call.method === 'Target.attachToTarget' && call.sessionId === PAGE && call.params?.targetId === `${CHILD}-target`
    ))).toBe(true);
    expect(after.some(call => call.method === 'Target.getTargets' && call.sessionId === CHILD)).toBe(true);
    expect(after.some(call => (
      call.method === 'Target.attachToTarget' && call.sessionId === CHILD && call.params?.targetId === `${GRAND}-target`
    ))).toBe(true);
    expect(after.some(call => call.method === 'Page.getFrameTree' && call.sessionId === GRAND)).toBe(true);
    expect(after.some(call => (
      call.method === 'Target.attachToTarget' && call.sessionId === PAGE && call.params?.targetId === `${GRAND}-target`
    ))).toBe(false);
  });
});

function crossSiteRefState() {
  return {
    frameRefs: new Map([['@f3', {
      frameRef: '@f3',
      frameId: 'oopif-frame',
      process: 'oopif',
      refs: new Map([[1, 55]]),
      frames: [{ ref: '@f3', id: 'oopif-frame', process: 'oopif' }],
    }]]),
  };
}

describe('actions inside a cross-site frame', () => {
  const target = { targetId: 'AB12CD34', input: '@f3:1' };

  async function refuse(action, run) {
    const cdp = createMockCDP();
    const err = await run(cdp).catch(error => error);
    expect(err, action).toBeInstanceOf(Error);
    expect(err.message, action).toBe('Actions inside cross-site frames are not supported yet (@f3).');
    const text = T.formatActionFailure(err, { action, target });
    expect(text, action).toBe([
      'Error: Actions inside cross-site frames are not supported yet (@f3).',
      'Kind: usage',
      'Next: cdp frame AB12CD34',
    ].join('\n'));
    expect(text, action).not.toContain('perceive --frame');
    expect(text, action).not.toContain('wrong-frame');
    const cli = T.formatCliError(err, { cmd: action, targetPrefix: 'AB12CD34', args: ['@f3:1'] });
    expect(cli, action).toContain('Kind: usage');
    expect(cli, action).toContain('Next: cdp frame AB12CD34');
    expect(cli, action).not.toContain('perceive --frame');
    expect(cli, action).not.toContain('cdp status');
    expect(cli, action).not.toContain('wrong-frame');
    const forwarded = T.formatDaemonCommandError(text, { cmd: action, targetPrefix: 'AB12CD34', args: ['@f3:1'] });
    expect(forwarded, action).toBe(text);
    expect(cdp.calls.some(call => call.method === 'Page.createIsolatedWorld'), action).toBe(false);
    expect(cdp.calls.some(call => call.method === 'DOM.pushNodesByBackendIdsToFrontend'), action).toBe(false);
    expect(cdp.calls.some(call => call.method === 'CSS.getMatchedStylesForNode'), action).toBe(false);
    expect(cdp.calls.some(call => call.method === 'DOM.getDocument'), action).toBe(false);
  }

  it('refuses cascade on a ref inside a cross-site frame', async () => {
    await refuse('cascade', cdp => T.cascadeStr(cdp, PAGE, '@f3:1', 'color', new Map(), crossSiteRefState()));
  });
});
