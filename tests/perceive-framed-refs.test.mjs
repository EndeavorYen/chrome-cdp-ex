import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function pageSnapshotValue(overrides = {}) {
  return JSON.stringify({
    title: 'Example Domain',
    url: 'https://example.com/',
    contentType: 'text/html',
    vw: 1042,
    vh: 632,
    scrollY: 0,
    scrollMax: 0,
    counts: { button: 1, 'input[text]': 1, 'input[hidden]': 1, div: 2 },
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [{
      tag: 'input',
      role: 'textbox',
      label: 'oin',
      clickable: true,
      rect: { x: 8, y: 80, w: 185, h: 21 },
      selector: 'input#oin',
      hints: { id: 'oin', classes: [] },
    }],
    ...overrides,
  });
}

function callFunctionOnForFill(params = {}, filledText = 'hello-oin') {
  const decl = String(params.functionDeclaration || '');
  if (decl.includes('ownerDocumentGetter') && !decl.includes('requestAnimationFrame')) {
    return { result: { value: { connected: true } } };
  }
  if (decl.includes('cdpFillLiveValue')) {
    return { result: { value: { ok: true, cdpFillLiveValue: true, tag: 'INPUT', value: filledText, textContent: filledText } } };
  }
  if (decl.includes('fillable') || decl.includes('isContentEditable') || decl.includes('TEXTAREA')) {
    return { result: { value: { ok: true, fillable: true, tag: 'INPUT', type: 'text', role: '' } } };
  }
  if (decl.includes('getBoundingClientRect')) {
    if (params.objectId === 'input-object') {
      return { result: { value: { x: 8, y: 80, w: 185, h: 21, position: '' } } };
    }
    if (params.objectId === 'button-object') {
      return { result: { value: { x: 8, y: 8, w: 80, h: 24, position: '' } } };
    }
    if (params.objectId === 'frame-owner') {
      return { result: { value: { x: 218, y: 275, w: 400, h: 200 } } };
    }
    return { result: { value: { x: 0, y: 0, w: 0, h: 0, position: '' } } };
  }
  return { result: { value: { x: 0, y: 0, w: 0, h: 0, position: '' } } };
}

function framedUnnamedInputCdp({
  frameId = 'child-frame',
  axOmitsInput = true,
  nested = false,
  filledText = 'hello-oin',
  describeNodeIds = { 'button-object': 201, 'input-object': 202 },
} = {}) {
  const methods = [];
  const childFrames = nested
    ? [{
        frame: { id: 'outer-frame', parentId: 'main-frame', name: 'p16outer', url: 'about:srcdoc' },
        childFrames: [{
          frame: { id: frameId, parentId: 'outer-frame', name: 'p16inner', url: 'about:srcdoc' },
          childFrames: [],
        }],
      }]
    : [{
        frame: { id: frameId, parentId: 'main-frame', name: 'p16outer', url: 'about:srcdoc' },
        childFrames: [],
      }];
  const axNodes = axOmitsInput
    ? [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2'] },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
      ]
    : [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2', '3'] },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
        { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: '' }, backendDOMNodeId: 202 },
      ];
  const listed = [
    { chromeCdpDomInteractiveList: true, index: 1, tag: 'button', type: '', id: '', name: 'outer-btn', role: 'button', hidden: false },
    { chromeCdpDomInteractiveList: true, index: 2, tag: 'input', type: 'text', id: 'oin', name: '', role: 'textbox', hidden: false },
  ];
  const cdp = {
    methods,
    send(method, params = {}) {
      methods.push({ method, params });
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({
          frameTree: {
            frame: { id: 'main-frame', url: 'https://example.com/' },
            childFrames,
          },
        });
      }
      if (method === 'Page.createIsolatedWorld') {
        return Promise.resolve({ executionContextId: 42 });
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('chromeCdpDomInteractiveList')) {
          return Promise.resolve({ result: { value: JSON.stringify(listed) } });
        }
        if (expr.includes("querySelectorAll('a, button, input, select, textarea')")) {
          const index = Number(/\[(\d+)\]/.exec(expr)?.[1] || 0);
          const objectId = index === 2 ? 'input-object' : 'button-object';
          return Promise.resolve({ result: { objectId } });
        }
        return Promise.resolve({ result: { value: pageSnapshotValue() } });
      }
      if (method === 'Accessibility.getFullAXTree') {
        expect(params.frameId).toBe(frameId);
        return Promise.resolve({ nodes: axNodes });
      }
      if (method === 'DOM.resolveNode') {
        if (params.backendNodeId === 202) return Promise.resolve({ object: { objectId: 'input-object' } });
        if (params.backendNodeId === 201) return Promise.resolve({ object: { objectId: 'button-object' } });
        if (params.backendNodeId === 333) return Promise.resolve({ object: { objectId: 'frame-owner' } });
        return Promise.resolve({ object: { objectId: 'other' } });
      }
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve(callFunctionOnForFill(params, filledText));
      }
      if (method === 'DOM.getFrameOwner') {
        return Promise.resolve({ backendNodeId: 333 });
      }
      if (method === 'DOM.describeNode') {
        const backendNodeId = describeNodeIds[params.objectId];
        return Promise.resolve({ node: backendNodeId != null ? { backendNodeId } : {} });
      }
      if (method === 'Input.insertText') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return cdp;
}

describe('issue #261 framed perceive refs for unnamed inputs', () => {
  it('#261 unnamed framed textboxes stay in the AX dump and receive @fN:M', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
      { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: '' }, backendDOMNodeId: 202 },
    ];
    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap);
    const qualified = T.qualifyFrameRefsInLines(treeLines, '@f2');
    const output = qualified.join('\n');
    expect(refMap.get(1)).toBe(201);
    expect(refMap.get(2)).toBe(202);
    expect(output).toContain('[button] outer-btn  @f2:1');
    expect(output).toMatch(/\[textbox\].*@f2:2/);
  });

  it('#261 synthesizes an AX node when getFullAXTree omits the framed input', () => {
    const axNodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
    ];
    const merged = T.mergeMissingDomInteractiveAxNodes(axNodes, [
      { backendNodeId: 201, tag: 'button', role: 'button', name: 'outer-btn' },
      { backendNodeId: 202, tag: 'input', type: 'text', role: 'textbox', id: 'oin', name: '' },
    ]);
    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(merged, { layoutMap: {}, styleHints: {} }, refMap);
    expect(refMap.size).toBe(2);
    expect(refMap.get(2)).toBe(202);
    expect(T.qualifyFrameRefsInLines(treeLines, '@f2').join('\n')).toMatch(/\[textbox\].*@f2:2/);
  });

  it('#261 -C frame coords match @fN:M / clickxy top-level viewport space and carry the ref', () => {
    const offset = { x: 218, y: 275 };
    const local = { x: 8, y: 80, w: 185, h: 21 };
    const viewport = T.offsetCssRect(local, offset);
    expect(viewport).toEqual({ x: 226, y: 355, w: 185, h: 21 });

    const control = T.attachRefToVisibleControl(
      { tag: 'input', role: 'textbox', label: 'oin', rect: viewport, selector: 'input#oin', hints: { id: 'oin' } },
      T.refAnnotationsFromTreeLines(['[textbox]  @f2:2  (226,355 185×21)']),
    );
    expect(control.ref).toBe('@f2:2');
    expect(T.formatVisibleControlLine(control)).toContain('@f2:2');
    expect(T.formatVisibleControlLine(control)).toContain('(226,355 185×21)');
    expect(T.nativeVisibleControlTag('input')).toBe(true);
  });

  it('#261 perceive --frame assigns @f2:2 to an unnamed srcdoc text input and offsets -C', async () => {
    const store = { output: null, snapshotOpts: null };
    const refState = {};
    const cdp = {
      send(method, params = {}) {
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'main-frame', url: 'https://example.com/' },
              childFrames: [{
                frame: { id: 'child-frame', parentId: 'main-frame', name: 'p16outer', url: 'about:srcdoc' },
                childFrames: [],
              }],
            },
          });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 42 });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Example Domain',
                url: 'https://example.com/',
                contentType: 'text/html',
                vw: 1042,
                vh: 632,
                scrollY: 0,
                scrollMax: 0,
                counts: { button: 1, 'input[text]': 1 },
                focused: 'none',
                layoutMap: {},
                styleHints: {},
                cursorInteractives: [],
                visibleControls: [{
                  tag: 'input',
                  role: 'textbox',
                  label: 'oin',
                  clickable: true,
                  rect: { x: 8, y: 80, w: 185, h: 21 },
                  selector: 'input#oin',
                  hints: { id: 'oin', classes: [] },
                }],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          expect(params.frameId).toBe('child-frame');
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2', '3'] },
              { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'outer-btn' }, backendDOMNodeId: 201 },
              { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: '' }, backendDOMNodeId: 202 },
            ],
          });
        }
        if (method === 'DOM.resolveNode') {
          if (params.backendNodeId === 202) return Promise.resolve({ object: { objectId: 'input-object' } });
          if (params.backendNodeId === 201) return Promise.resolve({ object: { objectId: 'button-object' } });
          if (params.backendNodeId === 333) return Promise.resolve({ object: { objectId: 'frame-owner' } });
          return Promise.resolve({ object: { objectId: 'other' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.objectId === 'input-object') {
            return Promise.resolve({ result: { value: { x: 8, y: 80, w: 185, h: 21, position: '' } } });
          }
          if (params.objectId === 'button-object') {
            return Promise.resolve({ result: { value: { x: 8, y: 8, w: 80, h: 24, position: '' } } });
          }
          if (params.objectId === 'frame-owner') {
            return Promise.resolve({ result: { value: { x: 218, y: 275, w: 400, h: 200 } } });
          }
          return Promise.resolve({ result: { value: { x: 0, y: 0, w: 0, h: 0, position: '' } } });
        }
        if (method === 'DOM.getFrameOwner') {
          return Promise.resolve({ backendNodeId: 333 });
        }
        if (method === 'DOM.describeNode') {
          return Promise.resolve({ node: {} });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };

    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { frameRef: '@f2', cursorInteractive: true },
      refState,
    );
    expect(out).toContain('Interactive: 1 button, 1 input[text]');
    expect(out).toContain('[button] outer-btn  @f2:1  (226,283 80×24)');
    expect(out).toMatch(/\[textbox\].*@f2:2\s+\(226,355 185×21\)/);
    expect(out).toContain('input#oin');
    expect(out).toContain('@f2:2');
    expect(out).toContain('(226,355 185×21)');
    expect(out).not.toMatch(/input#oin[^\n]*\(8,80/);
    expect(refState.frameRefs.get('@f2').refs.get(2)).toBe(202);
  });

  it('#261 never synthesizes hidden inputs as [textbox] @refs', () => {
    expect(T.isSynthesizableDomControl({ tag: 'input', type: 'hidden', role: 'textbox', backendNodeId: 9 })).toBe(false);
    expect(T.isSynthesizableDomControl({ tag: 'input', type: 'text', hidden: true, backendNodeId: 9 })).toBe(false);
    expect(T.isSynthesizableDomControl({ tag: 'input', type: 'text', display: 'none', backendNodeId: 9 })).toBe(false);
    expect(T.shouldSynthesizeMissingFrameInteractives(null, [], [
      { tag: 'input', type: 'text', role: 'textbox' },
    ])).toBe(false);

    const axNodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: [] },
    ];
    const merged = T.mergeMissingDomInteractiveAxNodes(axNodes, [
      { backendNodeId: 9, tag: 'input', type: 'hidden', role: 'textbox', id: 'csrf', name: '' },
      { backendNodeId: 10, tag: 'input', type: 'text', hidden: true, role: 'textbox', id: 'ghost' },
    ]);
    const refMap = new Map();
    const { treeLines } = T.buildPerceiveTree(merged, { layoutMap: {}, styleHints: {} }, refMap);
    expect(refMap.size).toBe(0);
    expect(treeLines.join('\n')).not.toMatch(/\[textbox\]/);
  });

  it('#261 -C attaches @fN:M by selector/id, not 1px-exact rect equality', () => {
    const control = T.attachRefToVisibleControl(
      { tag: 'input', role: 'textbox', label: 'oin', rect: { x: 227, y: 354, w: 185, h: 21 }, selector: 'input#oin', hints: { id: 'oin' } },
      T.refAnnotationsFromTreeLines(['[textbox] oin  @f2:2  (226,355 185×21)']),
    );
    expect(control.ref).toBe('@f2:2');
  });

  it('#261 top-level perceive does not describeNode or synthesize hidden inputs when counts exceed AX', async () => {
    const methods = [];
    const cdp = {
      send(method, params = {}) {
        methods.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: pageSnapshotValue({
                counts: { button: 1, 'input[text]': 1, 'input[hidden]': 1, div: 3 },
                visibleControls: [],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: ['2'] },
              { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 11 },
            ],
          });
        }
        if (method === 'DOM.describeNode') {
          throw new Error('top-level perceive must not describeNode for AX synthesis');
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null, snapshotOpts: null },
      { cursorInteractive: true },
      {},
    );
    expect(methods.some(item => item.method === 'DOM.describeNode')).toBe(false);
    expect(methods.some(item => String(item.params?.expression || '').includes('chromeCdpDomInteractiveList'))).toBe(false);
    expect(out).not.toMatch(/\[textbox\].*csrf|input\[type=hidden\]/i);
    expect(out).not.toMatch(/@2\b/);
  });

  it('#261 fill and resolveRefNode accept a synthesized @f2:2 when AX omits the framed input', async () => {
    const cdp = framedUnnamedInputCdp({ axOmitsInput: true, filledText: 'hello-oin' });
    const store = { output: null, snapshotOpts: null };
    const refState = {};
    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { frameRef: '@f2', cursorInteractive: true },
      refState,
    );
    expect(cdp.methods.some(item => item.method === 'DOM.describeNode')).toBe(true);
    expect(out).toMatch(/\[textbox\].*@f2:2/);
    expect(refState.frameRefs.get('@f2').refs.get(2)).toBe(202);

    const objectId = await T.resolveRefNode(cdp, 'sid', new Map(), '@f2:2', refState);
    expect(objectId).toBe('input-object');
    const filled = await T.fillStr(cdp, 'sid', '@f2:2', 'hello-oin', new Map(), refState);
    expect(filled).toContain('@f2:2');
    expect(filled).toContain('hello-oin');
  });

  it('#261 nested srcdoc @f3 fill works when AX omits the unnamed input', async () => {
    const cdp = framedUnnamedInputCdp({
      frameId: 'inner-frame',
      axOmitsInput: true,
      nested: true,
      filledText: 'nested-oin',
    });
    const refState = {};
    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null, snapshotOpts: null },
      { frameRef: '@f3', cursorInteractive: true },
      refState,
    );
    expect(out).toContain('Frame: @f3');
    expect(out).toMatch(/\[textbox\].*@f3:2/);
    expect(refState.frameRefs.get('@f3').refs.get(2)).toBe(202);
    const filled = await T.fillStr(cdp, 'sid', '@f3:2', 'nested-oin', new Map(), refState);
    expect(filled).toContain('@f3:2');
    expect(filled).toContain('nested-oin');
  });
});
