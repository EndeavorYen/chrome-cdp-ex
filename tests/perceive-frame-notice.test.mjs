import { describe, expect, it } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET = 'AB12CD34';

// Captured from perceiveStr before the frames line existed. Frame-free pages
// must stay byte-identical, including -C.
const FRAME_FREE_PLAIN = [
  'Page: Host — http://127.0.0.1:9/host.html',
  'Viewport: 800×600 | Scroll: 0/0 (0%) | Focused: none',
  'Interactive: 1 button',
  'Console: clean',
  'Coords: viewport CSS px (clickxy-ready; fixed/sticky tagged)',
  '',
  '[RootWebArea] Host',
  '  [button] Outer  @1  (10,20 80×24)',
].join('\n');

const FRAME_FREE_C = [
  FRAME_FREE_PLAIN,
  '',
  '[Visible controls]',
  '  button role=button "Outer" [clickable] (10,20 80×24) @1 button#outer #outer',
].join('\n');

function meta(extra = {}) {
  return {
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
    visibleControls: [{
      tag: 'button',
      role: 'button',
      label: 'Outer',
      text: 'Outer',
      clickable: true,
      disabled: false,
      rect: { x: 10, y: 20, w: 80, h: 24 },
      selector: 'button#outer',
      hints: { id: 'outer', classes: [] },
    }],
    ...extra,
  };
}

function frameTree(children = []) {
  return {
    frame: { id: 'root', url: 'http://127.0.0.1:9/host.html', name: 'top' },
    childFrames: children,
  };
}

function childFrame(id, url, name = '') {
  return { frame: { id, parentId: 'root', url, name } };
}

function frameEl({ title = '', src, host, visible = true }) {
  return { title, src, host, name: '', visible };
}

function axTree(iframeNodes) {
  const childIds = ['btn', ...iframeNodes.map(node => node.nodeId)];
  return [
    { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Host' }, childIds },
    { nodeId: 'btn', parentId: 'root', role: { value: 'button' }, name: { value: 'Outer' }, backendDOMNodeId: 10 },
    ...iframeNodes.map(node => ({ parentId: 'root', role: { value: 'Iframe' }, ...node })),
  ];
}

function pageCdp({ nodes, frameElements, tree = frameTree() } = {}) {
  return createMockCDP({
    'Runtime.evaluate': () => ({ result: { value: JSON.stringify(meta(frameElements ? { frameElements } : {})) } }),
    'Accessibility.getFullAXTree': () => ({ nodes: nodes || axTree([]) }),
    'Page.getFrameTree': () => ({ frameTree: tree }),
    'DOM.resolveNode': ({ backendNodeId }) => ({ object: { objectId: `obj-${backendNodeId}` } }),
    'Runtime.callFunctionOn': () => ({ result: { value: { x: 10, y: 20, w: 80, h: 24, position: 'static' } } }),
  });
}

function perceive(cdp, opts = {}) {
  return T.perceiveStr(
    cdp,
    'sid',
    new T.RingBuffer(4),
    new T.RingBuffer(4),
    new Map(),
    { output: null },
    { targetPrefix: TARGET, ...opts },
  );
}

function framesLines(output) {
  return String(output).split('\n').filter(line => line.startsWith('Frames:'));
}

describe('perceive frame notice', () => {
  it('prints no Frames line and keeps frame-free output byte-identical', async () => {
    const plainCdp = pageCdp();
    const plain = await perceive(plainCdp);
    expect(plain).toBe(FRAME_FREE_PLAIN);
    expect(plainCdp.calls.some(call => call.method === 'Page.getFrameTree')).toBe(false);

    const empty = await perceive(pageCdp({ frameElements: [] }));
    expect(empty).toBe(FRAME_FREE_PLAIN);

    const compact = await perceive(pageCdp(), { cursorInteractive: true, maxDepth: 8 });
    expect(compact).toBe(FRAME_FREE_C);
  });

  it('prints one Frames line and perceive --frame when one child frame is visible', async () => {
    const src = 'https://pay.example.com/checkout';
    const nodes = axTree([
      { nodeId: 'ifr', name: { value: 'Checkout' }, backendDOMNodeId: 21 },
    ]);
    const tree = frameTree([childFrame('checkout', src, 'checkout')]);
    const elements = [frameEl({ title: 'Checkout', src, host: 'pay.example.com' })];
    const expected = `Frames: 1 (1 visible). Next: cdp perceive ${TARGET} --frame @f2`;

    const plain = await perceive(pageCdp({ nodes, frameElements: elements, tree }));
    expect(framesLines(plain)).toEqual([expected]);
    expect(plain).toContain('  [iframe] "Checkout" @f2');
    expect(plain).toContain('  [button] Outer  @1  (10,20 80×24)');
    expect(plain.indexOf('Console: clean')).toBeLessThan(plain.indexOf(expected));
    expect(plain.indexOf(expected)).toBeLessThan(plain.indexOf('Coords:'));

    const compact = await perceive(
      pageCdp({ nodes, frameElements: elements, tree }),
      { cursorInteractive: true, maxDepth: 8 },
    );
    expect(framesLines(compact)).toEqual([expected]);
    expect(compact).toContain('[Visible controls]');
    expect(compact).toContain('  [iframe] "Checkout" @f2');
  });

  it('points Next at frame when more than one child frame is visible', async () => {
    const pay = 'https://pay.example.com/checkout';
    const widgets = 'https://widgets.example.com/picker';
    const out = await perceive(pageCdp({
      nodes: axTree([
        { nodeId: 'ifr1', name: { value: 'Checkout' }, backendDOMNodeId: 21 },
        { nodeId: 'ifr2', name: { value: '' }, backendDOMNodeId: 22 },
      ]),
      frameElements: [
        frameEl({ title: 'Checkout', src: pay, host: 'pay.example.com' }),
        frameEl({ title: '', src: widgets, host: 'widgets.example.com' }),
      ],
      tree: frameTree([
        childFrame('checkout', pay, 'checkout'),
        childFrame('picker', widgets, 'picker'),
      ]),
    }));
    expect(framesLines(out)).toEqual([`Frames: 2 (2 visible). Next: cdp frame ${TARGET}`]);
    expect(out).toContain('  [iframe] "Checkout" @f2');
    expect(out).toContain('  [iframe] "widgets.example.com" @f3');
    expect(out).not.toContain('--frame @f2');
  });

  it('keeps the existing @fN of the one visible child when another child is hidden', async () => {
    const hidden = 'https://hidden.example/a';
    const shown = 'https://shown.example/b';
    const out = await perceive(pageCdp({
      nodes: axTree([
        { nodeId: 'ifr1', name: { value: '' }, backendDOMNodeId: 21 },
        { nodeId: 'ifr2', name: { value: '' }, backendDOMNodeId: 22 },
      ]),
      frameElements: [
        frameEl({ src: hidden, host: 'hidden.example', visible: false }),
        frameEl({ src: shown, host: 'shown.example', visible: true }),
      ],
      tree: frameTree([
        childFrame('hidden', hidden),
        childFrame('shown', shown),
      ]),
    }));
    expect(framesLines(out)).toEqual([
      `Frames: 2 (1 visible). Next: cdp perceive ${TARGET} --frame @f3`,
    ]);
    expect(out).toContain('  [iframe] "hidden.example" @f2');
    expect(out).toContain('  [iframe] "shown.example" @f3');
  });

  it('appends the cross-site suffix when the DOM has more frames than the frame tree', async () => {
    const same = 'http://127.0.0.1:9/inner.html';
    const cross = 'http://localhost:9/inner.html';
    const out = await perceive(pageCdp({
      nodes: axTree([
        { nodeId: 'ifr1', name: { value: 'Inner' }, backendDOMNodeId: 21 },
        { nodeId: 'ifr2', name: { value: 'Other' }, backendDOMNodeId: 22 },
      ]),
      frameElements: [
        frameEl({ title: 'Inner', src: same, host: '127.0.0.1:9' }),
        frameEl({ title: 'Other', src: cross, host: 'localhost:9' }),
      ],
      tree: frameTree([childFrame('inner', same, 'inner')]),
    }));
    expect(framesLines(out)).toEqual([
      `Frames: 1 (1 visible), 1 cross-site not reachable yet. Next: cdp perceive ${TARGET} --frame @f2`,
    ]);
    expect(out).toContain('  [iframe] "Inner" @f2');
    expect(out).toContain('  [iframe] "localhost:9"');
    expect(out).not.toMatch(/\[iframe\] "localhost:9" @f/);
    expect(out).not.toContain('[iframe] "Other"');
    expect(out).not.toContain('@f3');
  });

  it('does not point Next at frame when every iframe is cross-site', async () => {
    const cross = 'http://localhost:9/inner.html';
    const out = await perceive(pageCdp({
      nodes: axTree([
        { nodeId: 'ifr', name: { value: 'Other' }, backendDOMNodeId: 21 },
      ]),
      frameElements: [frameEl({ title: 'Other', src: cross, host: 'localhost:9' })],
      tree: frameTree(),
    }));
    expect(framesLines(out)).toEqual(['Frames: 0 (0 visible), 1 cross-site not reachable yet']);
    expect(out).not.toMatch(/Next: cdp frame/);
    expect(out).toContain('  [iframe] "localhost:9"');
    expect(out).not.toMatch(/\[iframe\] "localhost:9" @f/);
  });

  it('does not add a Frames line inside perceive --frame', async () => {
    const tree = frameTree([childFrame('checkout', 'https://pay.example.com/checkout', 'checkout')]);
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: tree }),
      'Page.createIsolatedWorld': () => ({ executionContextId: 42 }),
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify(meta({
            title: 'Checkout',
            url: 'https://pay.example.com/checkout',
            counts: { button: 1 },
            frameElements: [frameEl({
              title: 'Nested',
              src: 'https://pay.example.com/nested',
              host: 'pay.example.com',
            })],
          })),
        },
      }),
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Checkout' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 5 },
        ],
      }),
      'DOM.resolveNode': () => ({ object: { objectId: 'btn' } }),
      'Runtime.callFunctionOn': ({ objectId }) => {
        if (objectId === 'btn') return { result: { value: { x: 1, y: 2, w: 30, h: 16, position: '' } } };
        return { result: { value: { x: 0, y: 0, w: 400, h: 300 } } };
      },
      'DOM.getFrameOwner': () => ({ backendNodeId: 9 }),
    });
    const out = await perceive(cdp, { frameRef: '@f2' });
    expect(out).toContain('Frame: @f2 checkout checkout https://pay.example.com/checkout');
    expect(out).not.toMatch(/^Frames: /m);
  });

  it('counts iframe and frame elements in the page script and leaves frames.v1 unchanged', async () => {
    const script = T.perceivePageScript(false);
    expect(script).toContain("querySelectorAll('iframe, frame')");
    expect(script).toContain('frameElements');

    const tree = frameTree([
      childFrame('checkout', 'https://pay.example.com/a', 'checkout'),
      childFrame('picker', 'https://widgets.example.com/b', 'picker'),
    ]);
    const cdp = createMockCDP({ 'Page.getFrameTree': () => ({ frameTree: tree }) });
    const model = await T.framesModel(cdp, 'sid');
    expect(model.schema).toBe('chrome-cdp-ex.frames.v1');
    expect(Object.keys(model).sort()).toEqual(['frameCount', 'frames', 'schema']);
    expect(model.frames.map(frame => frame.ref)).toEqual(['@f1', '@f2', '@f3']);
    expect(model.frames.some(frame => Object.hasOwn(frame, 'process'))).toBe(false);
    const text = await T.framesStr(cdp, 'sid');
    expect(text.startsWith('Frames: 3\n')).toBe(true);
    expect(text).not.toContain('cross-site');
  });
});
