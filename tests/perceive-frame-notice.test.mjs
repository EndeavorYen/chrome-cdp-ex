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

function childFrame(id, url, name = '', parentId = 'root', nested = []) {
  const node = { frame: { id, parentId, url, name } };
  if (nested.length) node.childFrames = nested;
  return node;
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

function pageCdp({ nodes, frameElements, frameElementCount, tree = frameTree() } = {}) {
  const pageMeta = {};
  if (frameElements) pageMeta.frameElements = frameElements;
  if (frameElementCount != null) pageMeta.frameElementCount = frameElementCount;
  return createMockCDP({
    'Runtime.evaluate': () => ({ result: { value: JSON.stringify(meta(pageMeta)) } }),
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

function pageFrameElement({
  tagName = 'IFRAME', title = '', name = '', src = 'http://localhost:9/x.html', width = 300, height = 150,
} = {}) {
  return {
    tagName,
    src,
    id: '',
    className: '',
    textContent: '',
    children: [],
    getAttribute(attr) {
      if (attr === 'title') return title;
      if (attr === 'name') return name;
      return null;
    },
    hasAttribute() { return false; },
    getClientRects() { return [{ width, height }]; },
    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, bottom: height, right: width, width, height };
    },
    checkVisibility() { return true; },
  };
}

// Run the browser-side perceive collector against a fake document. The frame
// list is what querySelectorAll('iframe, frame') returns; everything else is
// empty so the collector still finishes.
function runPerceivePage(frames) {
  const script = T.perceivePageScript(false);
  const getComputedStyle = () => ({
    overflowY: 'visible',
    display: 'block',
    visibility: 'visible',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    fontSize: '16px',
    fontWeight: '400',
    color: 'rgb(0, 0, 0)',
    gap: 'normal',
    opacity: '1',
  });
  const scrollingElement = { scrollTop: 0, scrollHeight: 600, clientHeight: 600, children: [] };
  const document = {
    title: 'Host',
    contentType: 'text/html',
    scrollingElement,
    documentElement: { scrollTop: 0, scrollHeight: 600, clientHeight: 600, children: [] },
    body: { tagName: 'BODY', id: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, children: [] },
    activeElement: null,
    querySelectorAll(selector) {
      if (selector === 'iframe, frame') return frames;
      return [];
    },
  };
  document.activeElement = document.body;
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    scrollY: 0,
    location: { href: 'http://127.0.0.1:9/host.html' },
    getComputedStyle,
  };
  const run = new Function('document', 'window', 'getComputedStyle', 'URL', 'return ' + script);
  return JSON.parse(run(document, window, getComputedStyle, URL));
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

  it('does not pair a nested same-origin frame with a top-level cross-site iframe', async () => {
    const outer = 'http://127.0.0.1:9/outer.html';
    const inner = 'http://127.0.0.1:9/child.html';
    const cross = 'http://localhost:9/child.html';
    const tree = frameTree([
      childFrame('outer', outer, 'outer', 'root', [
        childFrame('inner', inner, 'inner', 'outer'),
      ]),
    ]);
    const out = await perceive(pageCdp({
      nodes: axTree([
        { nodeId: 'ifr1', name: { value: 'Outer' }, backendDOMNodeId: 21 },
        { nodeId: 'ifr2', name: { value: 'Other' }, backendDOMNodeId: 22 },
      ]),
      frameElements: [
        frameEl({ title: 'Outer', src: outer, host: '127.0.0.1:9' }),
        frameEl({ title: 'Other', src: cross, host: 'localhost:9' }),
      ],
      tree,
    }));
    expect(framesLines(out)).toEqual([
      `Frames: 2 (2 visible), 1 cross-site not reachable yet. Next: cdp frame ${TARGET}`,
    ]);
    expect(out).toContain('  [iframe] "Outer" @f2');
    expect(out).toContain('  [iframe] "localhost:9"');
    expect(out).not.toMatch(/\[iframe\] "localhost:9" @f/);
    expect(out).not.toContain('[iframe] "Inner"');
    expect(out).not.toContain('@f3');

    const listed = await T.framesStr(pageCdp({ tree }), 'sid');
    expect(listed).toContain('Frames: 3\n');
    expect(listed).toContain('@f2 outer outer parent:@f1');
    expect(listed).toContain('@f3 inner inner parent:@f2');
  });

  it('prefers the frame owner visibility when it disagrees with the element', async () => {
    const hiddenSrc = 'https://hidden.example/a';
    const shownSrc = 'https://shown.example/b';
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify(meta({
            frameElements: [
              frameEl({ title: 'Hidden', src: hiddenSrc, host: 'hidden.example', visible: true }),
              frameEl({ title: 'Shown', src: shownSrc, host: 'shown.example', visible: false }),
            ],
          })),
        },
      }),
      'Accessibility.getFullAXTree': () => ({
        nodes: axTree([
          { nodeId: 'ifr1', name: { value: 'Hidden' }, backendDOMNodeId: 21 },
          { nodeId: 'ifr2', name: { value: 'Shown' }, backendDOMNodeId: 22 },
        ]),
      }),
      'Page.getFrameTree': () => ({
        frameTree: frameTree([
          childFrame('hidden', hiddenSrc),
          childFrame('shown', shownSrc),
        ]),
      }),
      'DOM.getFrameOwner': ({ frameId }) => {
        if (frameId === 'hidden') return { backendNodeId: 501 };
        if (frameId === 'shown') return { backendNodeId: 502 };
        return {};
      },
      'DOM.resolveNode': ({ backendNodeId }) => {
        if (backendNodeId === 501) return { object: { objectId: 'owner-hidden' } };
        if (backendNodeId === 502) return { object: { objectId: 'owner-shown' } };
        return { object: { objectId: `obj-${backendNodeId}` } };
      },
      'Runtime.callFunctionOn': (params) => {
        if (String(params.functionDeclaration || '').includes('chrome-cdp-ex.frame-owner.v1')) {
          const visible = params.objectId === 'owner-shown';
          return {
            result: {
              value: {
                marker: 'chrome-cdp-ex.frame-owner.v1',
                title: '',
                src: '',
                host: '',
                visible,
              },
            },
          };
        }
        return { result: { value: { x: 10, y: 20, w: 80, h: 24, position: 'static' } } };
      },
    });
    const out = await perceive(cdp);
    expect(framesLines(out)).toEqual([
      `Frames: 2 (1 visible). Next: cdp perceive ${TARGET} --frame @f3`,
    ]);
    expect(out).toContain('  [iframe] "Hidden" @f2');
    expect(out).toContain('  [iframe] "Shown" @f3');
  });

  it('collects iframe and frame elements from the page and leaves frames.v1 unchanged', async () => {
    const collected = runPerceivePage([
      pageFrameElement({ tagName: 'IFRAME', title: 'Inner', src: 'http://127.0.0.1:9/inner.html' }),
      pageFrameElement({ tagName: 'FRAME', title: 'Classic', name: 'classic', src: 'http://127.0.0.1:9/classic.html' }),
    ]);
    expect(collected.frameElementCount).toBe(2);
    expect(collected.frameElements).toEqual([
      expect.objectContaining({
        title: 'Inner', src: 'http://127.0.0.1:9/inner.html', host: '127.0.0.1:9', name: '', visible: true,
      }),
      expect.objectContaining({
        title: 'Classic', src: 'http://127.0.0.1:9/classic.html', host: '127.0.0.1:9', name: 'classic', visible: true,
      }),
    ]);

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

  function blankFrame(id, { url = 'about:blank', origin = '://', parentId = 'root', name = '', nested = [] } = {}) {
  const node = { frame: { id, parentId, url, name, securityOrigin: origin } };
  if (nested.length) node.childFrames = nested;
  return node;
}

it('counts a pending cross-site about:blank frame as cross-site and does not point Next at it', async () => {
  const same = 'http://127.0.0.1:9/inner.html';
  const cross = 'http://localhost:9/inner.html';
  const elements = [
    frameEl({ title: 'Inner', src: same, host: '127.0.0.1:9' }),
    frameEl({ title: 'Other', src: cross, host: 'localhost:9' }),
  ];
  const nodes = axTree([
    { nodeId: 'ifr1', name: { value: 'Inner' }, backendDOMNodeId: 21 },
    { nodeId: 'ifr2', name: { value: 'Other' }, backendDOMNodeId: 22 },
  ]);

  for (const origin of ['://', '', 'null']) {
    for (const url of ['about:blank', '']) {
      const label = `url ${JSON.stringify(url)} origin ${JSON.stringify(origin)}`;
      const tree = frameTree([
        childFrame('same', same, 'same'),
        blankFrame('pending', { url, origin }),
      ]);
      const out = await perceive(pageCdp({ nodes, frameElements: elements, tree }));
      expect(framesLines(out), label).toEqual([
        `Frames: 1 (1 visible), 1 cross-site not reachable yet. Next: cdp perceive ${TARGET} --frame @f2`,
      ]);
      expect(out, label).toContain('  [iframe] "Inner" @f2');
      expect(out, label).toContain('  [iframe] "localhost:9"');
      expect(out, label).not.toMatch(/\[iframe\] "localhost:9" @f/);
      expect(out, label).not.toContain('@f3');
      expect(out, label).not.toContain('--frame @f3');
    }
  }

  // The placeholder sits ahead of the same-origin frame. Dropping it would renumber @f3 to @f2.
  const reversed = frameTree([
    blankFrame('pending', { origin: '://' }),
    childFrame('same', same, 'same'),
  ]);
  const reversedOut = await perceive(pageCdp({ nodes, frameElements: elements, tree: reversed }));
  expect(framesLines(reversedOut)).toEqual([
    `Frames: 1 (1 visible), 1 cross-site not reachable yet. Next: cdp perceive ${TARGET} --frame @f3`,
  ]);
  expect(reversedOut).toContain('  [iframe] "Inner" @f3');
  expect(reversedOut).not.toMatch(/\[iframe\] "localhost:9" @f/);
  expect(reversedOut).not.toContain('--frame @f2');

  const listed = await T.framesStr(pageCdp({ tree: reversed }), 'sid');
  expect(listed).toContain('Frames: 3\n');
  expect(listed).toContain('@f2 (anonymous) pending parent:@f1 about:blank origin:://');
  expect(listed).toContain('@f3 same same parent:@f1 http://127.0.0.1:9/inner.html');
  expect(listed).not.toContain('process:oopif');

  const onlyPending = frameTree([blankFrame('pending', { origin: 'null' })]);
  const onlyOut = await perceive(pageCdp({
    nodes: axTree([{ nodeId: 'ifr', name: { value: 'Other' }, backendDOMNodeId: 21 }]),
    frameElements: [frameEl({ title: 'Other', src: cross, host: 'localhost:9' })],
    tree: onlyPending,
  }));
  expect(framesLines(onlyOut)).toEqual(['Frames: 0 (0 visible), 1 cross-site not reachable yet']);
  expect(onlyOut).not.toMatch(/Next:/);
  expect(onlyOut).toContain('  [iframe] "localhost:9"');
  expect(onlyOut).not.toMatch(/\[iframe\] "localhost:9" @f/);

  // A nested child of the placeholder is not a same-origin target.
  const nested = frameTree([
    blankFrame('pending', {
      origin: '://',
      nested: [childFrame('inner', 'http://localhost:9/nested.html', 'inner', 'pending')],
    }),
  ]);
  const nestedOut = await perceive(pageCdp({
    nodes: axTree([{ nodeId: 'ifr', name: { value: 'Other' }, backendDOMNodeId: 21 }]),
    frameElements: [frameEl({ title: 'Other', src: cross, host: 'localhost:9' })],
    tree: nested,
  }));
  expect(framesLines(nestedOut)).toEqual(['Frames: 0 (0 visible), 1 cross-site not reachable yet']);
  expect(nestedOut).not.toContain('--frame');
  const nestedListed = await T.framesStr(pageCdp({ tree: nested }), 'sid');
  expect(nestedListed).toContain('@f2 (anonymous) pending parent:@f1 about:blank origin:://');
  expect(nestedListed).toContain('@f3 inner inner parent:@f2 http://localhost:9/nested.html');
});

it('keeps a same-origin about:blank iframe in the frame census', async () => {
  const cases = [
    { title: 'no src', src: '', host: '', frameUrl: 'about:blank', origin: '://' },
    { title: 'about:blank', src: 'about:blank', host: '', frameUrl: 'about:blank', origin: '' },
    { title: 'srcdoc', src: 'about:srcdoc', host: '', frameUrl: 'about:srcdoc', origin: 'null' },
    {
      title: 'same site',
      src: 'http://127.0.0.1:9/other.html',
      host: '127.0.0.1:9',
      frameUrl: 'about:blank',
      origin: 'null',
    },
    {
      title: 'same site other port',
      src: 'http://127.0.0.1:10/other.html',
      host: '127.0.0.1:10',
      frameUrl: '',
      origin: '://',
    },
    {
      title: 'same site subdomain',
      src: 'https://pay.example.com/checkout',
      host: 'pay.example.com',
      frameUrl: 'about:blank',
      origin: 'null',
      pageUrl: 'https://app.example.com/host',
    },
  ];
  for (const item of cases) {
    const pageUrl = item.pageUrl || 'http://127.0.0.1:9/host.html';
    const tree = {
      frame: { id: 'root', url: pageUrl, name: 'top', securityOrigin: new URL(pageUrl).origin },
      childFrames: [blankFrame('blank', { url: item.frameUrl, origin: item.origin, name: 'blank' })],
    };
    const out = await perceive(pageCdp({
      nodes: axTree([{ nodeId: 'ifr', name: { value: item.title }, backendDOMNodeId: 21 }]),
      frameElements: [frameEl({ title: item.title, src: item.src, host: item.host })],
      tree,
    }));
    expect(framesLines(out), item.title).toEqual([
      `Frames: 1 (1 visible). Next: cdp perceive ${TARGET} --frame @f2`,
    ]);
    expect(out, item.title).toContain(`  [iframe] ${JSON.stringify(item.title)} @f2`);
    expect(out, item.title).not.toContain('cross-site');
  }

  const cross = 'http://localhost:9/inner.html';
  const beside = await perceive(pageCdp({
    nodes: axTree([
      { nodeId: 'ifr1', name: { value: 'Blank' }, backendDOMNodeId: 21 },
      { nodeId: 'ifr2', name: { value: 'Other' }, backendDOMNodeId: 22 },
    ]),
    frameElements: [
      frameEl({ title: 'Blank', src: '', host: '' }),
      frameEl({ title: 'Other', src: cross, host: 'localhost:9' }),
    ],
    tree: frameTree([blankFrame('blank', { origin: '://' })]),
  }));
  expect(framesLines(beside)).toEqual([
    `Frames: 1 (1 visible), 1 cross-site not reachable yet. Next: cdp perceive ${TARGET} --frame @f2`,
  ]);
  expect(beside).toContain('  [iframe] "Blank" @f2');
  expect(beside).toContain('  [iframe] "localhost:9"');
  expect(beside).not.toMatch(/\[iframe\] "localhost:9" @f/);
});

it('counts cross-site iframes past the 50-element detail list', async () => {
    const same = 'http://127.0.0.1:9/outer.html';
    const frames = [
      pageFrameElement({ title: 'Outer', src: same }),
      ...Array.from({ length: 50 }, (_, index) => pageFrameElement({
        src: `http://localhost:9/c${index}.html`,
      })),
      pageFrameElement({
        tagName: 'FRAME',
        title: 'Classic',
        name: 'classic',
        src: 'http://localhost:9/classic.html',
      }),
    ];
    const collected = runPerceivePage(frames);
    expect(collected.frameElementCount).toBe(52);
    expect(collected.frameElements).toHaveLength(50);
    expect(collected.frameElements[0]).toMatchObject({ title: 'Outer', host: '127.0.0.1:9' });
    expect(collected.frameElements.some(el => el.title === 'Classic')).toBe(false);

    const nodes = collected.frameElements.map((el, index) => ({
      nodeId: `ifr${index}`,
      name: { value: el.title },
      backendDOMNodeId: 30 + index,
    }));
    const out = await perceive(pageCdp({
      nodes: axTree(nodes),
      frameElements: collected.frameElements,
      frameElementCount: collected.frameElementCount,
      tree: frameTree([childFrame('outer', same, 'outer')]),
    }));
    expect(framesLines(out)).toEqual([
      `Frames: 1 (1 visible), 51 cross-site not reachable yet. Next: cdp perceive ${TARGET} --frame @f2`,
    ]);
    const iframeLines = out.split('\n').filter(line => line.includes('[iframe]'));
    expect(iframeLines).toHaveLength(50);
    expect(iframeLines[0]).toBe('  [iframe] "Outer" @f2');
    expect(out).not.toContain('Classic');
    expect(out).not.toContain('@f3');
  });
});
