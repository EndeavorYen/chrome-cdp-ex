import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #642: perceive --since-action rebuilds @1..@N and prints only added/removed
// lines. Three Invite buttons, then a prepended Remove everyone, must not
// point the agent's @2 at Invite Ann.

const ANN = 11;
const BOB = 12;
const CY = 13;
const REMOVE = 14;

function pageMeta(buttonCount) {
  return JSON.stringify({
    title: 'Invites',
    url: 'http://127.0.0.1:8799/invites',
    contentType: 'text/html',
    vw: 1280,
    vh: 720,
    scrollY: 0,
    scrollMax: 0,
    counts: { button: buttonCount },
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [],
  });
}

function button(nodeId, name, backendDOMNodeId) {
  return {
    nodeId,
    parentId: 'root',
    role: { value: 'button' },
    name: { value: name },
    backendDOMNodeId,
  };
}

function tree(buttons) {
  return [
    { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Invites' }, childIds: buttons.map(node => node.nodeId) },
    ...buttons,
  ];
}

const beforeButtons = [
  button('ann', 'Invite Ann', ANN),
  button('bob', 'Invite Bob', BOB),
  button('cy', 'Invite Cy', CY),
];
const afterButtons = [
  button('remove', 'Remove everyone', REMOVE),
  ...beforeButtons,
];

function createPage(buttons) {
  const state = { buttons };
  const cdp = {
    send(method) {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: pageMeta(state.buttons.length) } });
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: tree(state.buttons) });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj' } });
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: { x: 8, y: 8, w: 120, h: 32, position: 'static' } } });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return { cdp, state };
}

function perceive(cdp, refMap, store, opts) {
  return T.perceiveStr(
    cdp,
    'sid',
    new T.RingBuffer(8),
    new T.RingBuffer(8),
    refMap,
    store,
    { targetPrefix: '642A11CE', ...opts },
    { generation: 1 },
  );
}

describe('#642 perceive --since-action does not rebind a surviving @ref', () => {
  it('keeps Invite Bob on @2 after a button is prepended, and numbers the new button above the high water', async () => {
    const { cdp, state } = createPage(beforeButtons);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    const first = await perceive(cdp, refMap, store, {});
    expect(first).toMatch(/Invite Ann\s+@1\b/);
    expect(first).toMatch(/Invite Bob\s+@2\b/);
    expect(first).toMatch(/Invite Cy\s+@3\b/);
    expect(refMap.get(2)).toBe(BOB);

    state.buttons = afterButtons;
    const diff = await perceive(cdp, refMap, store, {
      sinceAction: true,
      diffBaseline: first,
    });
    expect(refMap.get(1)).toBe(ANN);
    expect(refMap.get(2)).toBe(BOB);
    expect(refMap.get(3)).toBe(CY);
    expect(refMap.get(4)).toBe(REMOVE);
    expect(diff).toMatch(/Remove everyone\s+@4\b/);
    expect(diff).not.toMatch(/Invite Ann/);
    expect(diff).not.toMatch(/Invite Bob/);
    expect(diff).not.toMatch(/Invite Cy/);
  });

  it('does not reuse a freed number for the new button', async () => {
    const { cdp, state } = createPage(beforeButtons);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    const first = await perceive(cdp, refMap, store, {});
    state.buttons = [
      button('remove', 'Remove everyone', REMOVE),
      button('ann', 'Invite Ann', ANN),
      button('bob', 'Invite Bob', BOB),
    ];
    await perceive(cdp, refMap, store, { sinceAction: true, diffBaseline: first });
    expect(refMap.get(1)).toBe(ANN);
    expect(refMap.get(2)).toBe(BOB);
    expect(refMap.has(3)).toBe(false);
    expect(refMap.get(4)).toBe(REMOVE);
  });

  it('perceive --diff keeps the same numbers', async () => {
    const { cdp, state } = createPage(beforeButtons);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    await perceive(cdp, refMap, store, {});
    state.buttons = afterButtons;
    const diff = await perceive(cdp, refMap, store, { diff: true });
    expect(refMap.get(2)).toBe(BOB);
    expect(refMap.get(4)).toBe(REMOVE);
    expect(diff).toMatch(/Remove everyone\s+@4\b/);
    expect(diff).not.toMatch(/Invite Bob/);
  });

  it('perceive --since-action --format json keeps the same numbers', async () => {
    const { cdp, state } = createPage(beforeButtons);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    const first = await perceive(cdp, refMap, store, {});
    state.buttons = afterButtons;
    const model = await T.perceiveDiffModel(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '642A11CE', sinceAction: true, diffBaseline: first },
      { generation: 1 },
    );
    expect(refMap.get(2)).toBe(BOB);
    expect(refMap.get(4)).toBe(REMOVE);
    expect(model.added.join('\n')).toMatch(/Remove everyone\s+@4\b/);
    expect(model.added.join('\n')).not.toMatch(/Invite Bob/);
  });

  it('a plain perceive still numbers @1..@N in document order', async () => {
    const { cdp, state } = createPage(beforeButtons);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    await perceive(cdp, refMap, store, {});
    state.buttons = afterButtons;
    const text = await perceive(cdp, refMap, store, {});
    expect([...refMap.entries()].filter(([ref]) => Number.isInteger(ref))).toEqual([
      [1, REMOVE],
      [2, ANN],
      [3, BOB],
      [4, CY],
    ]);
    expect(text).toMatch(/Remove everyone\s+@1\b/);
    expect(text).toMatch(/Invite Ann\s+@2\b/);
    expect(text).toMatch(/Invite Bob\s+@3\b/);
    expect(text).toMatch(/Invite Cy\s+@4\b/);
  });
});
