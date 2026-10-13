import { describe, expect, it } from 'vitest';
import { annotatePerceiveIdentityLines } from '../skills/chrome-cdp-ex/scripts/lib/cdp-perceive.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const PERCEIVE_MARK = '\uE000';

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

function perceive(cdp, refMap, store, opts, refState = { generation: 1 }) {
  return T.perceiveStr(
    cdp,
    'sid',
    new T.RingBuffer(8),
    new T.RingBuffer(8),
    refMap,
    store,
    { targetPrefix: '642A11CE', ...opts },
    refState,
  );
}

// #651: a new node with the same role and name used to match the old line once
// the @ref was stripped, so --diff / --since-action never printed the new number.
const SAVE = 21;
const SAVE_NEXT = 22;
const CANCEL = 23;

function identityPage(buttons) {
  const state = { buttons, gone: new Set() };
  const cdp = {
    send(method, params) {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: pageMeta(state.buttons.length) } });
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: tree(state.buttons) });
      if (method === 'DOM.resolveNode') {
        const id = params?.backendNodeId;
        if (state.gone.has(id)) return Promise.reject(new Error('No node with given id'));
        return Promise.resolve({ object: { objectId: `obj-${id}` } });
      }
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: { x: 8, y: 8, w: 120, h: 32, position: 'static' } } });
      }
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'main-frame' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return { cdp, state };
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
});

describe('perceive diff lists a node replaced by an identical node', () => {
  it('lists the new @ref when a node is replaced by an identical node, and the old @ref is stale', async () => {
    const { cdp, state } = identityPage([
      button('save', 'Save', SAVE),
      button('cancel', 'Cancel', CANCEL),
    ]);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    const refState = { generation: 1, invalidationReason: null };
    const first = await perceive(cdp, refMap, store, {}, refState);
    expect(first).toMatch(/\[button\] Save\s+@1\b/);
    expect(first).toMatch(/\[button\] Cancel\s+@2\b/);
    expect(first).not.toContain('\uE000');
    expect(refMap.get(1)).toBe(SAVE);

    const quiet = await perceive(cdp, refMap, store, { diff: true }, refState);
    expect(quiet).toMatch(/no changes detected in AX tree/i);

    state.buttons = [
      button('save-next', 'Save', SAVE_NEXT),
      button('cancel', 'Cancel', CANCEL),
    ];
    state.gone.add(SAVE);
    let stale = null;
    try {
      await T.clickStr(cdp, 'sid', '@1', refMap, refState);
    } catch (error) {
      stale = error;
    }
    expect(stale?.code).toBe('CDP_STALE_REF');
    expect(stale?.message).toMatch(/@1 is stale/);
    expect(refMap.get(1)).not.toBe(SAVE_NEXT);

    const diff = await perceive(cdp, refMap, store, { diff: true }, refState);
    expect(diff).toMatch(/--- Removed[\s\S]*\[button\] Save\s+@1\b/);
    expect(diff).toMatch(/\+\+\+ Added[\s\S]*\[button\] Save\s+@3\b/);
    expect(diff).not.toMatch(/Cancel/);
    expect(diff).not.toContain('\uE000');
    expect(refMap.get(2)).toBe(CANCEL);
    expect(refMap.get(3)).toBe(SAVE_NEXT);
    expect(refMap.get(1)).not.toBe(SAVE_NEXT);
  });

  it('perceive --since-action lists the new @ref when a node is replaced by an identical node', async () => {
    const { cdp, state } = identityPage([
      button('save', 'Save', SAVE),
      button('cancel', 'Cancel', CANCEL),
    ]);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    const refState = { generation: 1, invalidationReason: null };
    await perceive(cdp, refMap, store, {}, refState);
    const baseline = T.perceiveStoreDiffSource(store);
    state.buttons = [
      button('save-next', 'Save', SAVE_NEXT),
      button('cancel', 'Cancel', CANCEL),
    ];
    state.gone.add(SAVE);
    const diff = await perceive(cdp, refMap, store, { sinceAction: true, diffBaseline: baseline }, refState);
    expect(diff).toMatch(/--- Removed[\s\S]*\[button\] Save\s+@1\b/);
    expect(diff).toMatch(/\+\+\+ Added[\s\S]*\[button\] Save\s+@3\b/);
    expect(diff).not.toMatch(/Cancel/);
    expect(refMap.get(1)).not.toBe(SAVE_NEXT);
    expect(refMap.get(2)).toBe(CANCEL);
    expect(refMap.get(3)).toBe(SAVE_NEXT);

    const freshMap = new Map();
    const freshStore = { output: null, snapshotOpts: null };
    const freshState = { generation: 1, invalidationReason: null };
    const { cdp: freshCdp, state: freshPage } = identityPage([
      button('save', 'Save', SAVE),
      button('cancel', 'Cancel', CANCEL),
    ]);
    await perceive(freshCdp, freshMap, freshStore, {}, freshState);
    const freshBaseline = T.perceiveStoreDiffSource(freshStore);
    freshPage.buttons = [
      button('save-next', 'Save', SAVE_NEXT),
      button('cancel', 'Cancel', CANCEL),
    ];
    const model = await T.perceiveDiffModel(
      freshCdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      freshMap,
      freshStore,
      { targetPrefix: '642A11CE', sinceAction: true, diffBaseline: freshBaseline },
      freshState,
    );
    expect(model.removed.join('\n')).toMatch(/\[button\] Save\s+@1\b/);
    expect(model.added.join('\n')).toMatch(/\[button\] Save\s+@3\b/);
    expect(model.added.join('\n')).not.toMatch(/Cancel/);
    expect(model.summary.changed).toBe(true);
  });
});

describe('#642 perceive --since-action does not rebind a surviving @ref', () => {
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

describe('#651 an action receipt ignores an identical redraw', () => {
  it('settle diff after a node is replaced by an identical node reports no change (click-no-change stays)', async () => {
    const { cdp, state } = identityPage([
      button('save', 'Save', SAVE),
      button('cancel', 'Cancel', CANCEL),
    ]);
    const refMap = new Map();
    const store = { output: null, snapshotOpts: null };
    const refState = { generation: 1, invalidationReason: null };
    await perceive(cdp, refMap, store, {}, refState);
    const baseline = T.perceiveStoreDiffSource(store);
    state.buttons = [
      button('save-next', 'Save', SAVE_NEXT),
      button('cancel', 'Cancel', CANCEL),
    ];
    state.gone.add(SAVE);
    const opts = T.actionSettleObserveOpts('642A11CE', { input: '@1' }, baseline, store.snapshotOpts);
    expect(opts.ignoreNodeIdentity).toBe(true);
    const settle = await perceive(cdp, refMap, store, opts, refState);
    expect(settle).toMatch(/no changes detected/i);
    expect(T.actionDomDiffShowsChange(settle)).toBe(false);

    // The same baseline still shows the replacement to perceive --since-action.
    const since = await perceive(cdp, refMap, store, { sinceAction: true, diffBaseline: baseline }, refState);
    expect(since).toMatch(/\+\+\+ Added[\s\S]*\[button\] Save\s+@3\b/);
  });
});

describe('#651 node identity marks in the diff', () => {
  const header = ['Page: x', 'URL: y', ''];
  const mark = id => `${PERCEIVE_MARK}${id}`;

  it('an unmarked baseline line still matches a marked current line by text', () => {
    const prev = [...header, '[button] Save @1', '[button] Cancel @2'].join('\n');
    const curr = [...header, `[button] Save @1${mark(21)}`, `[button] Cancel @2${mark(23)}`].join('\n');
    expect(T.formatPerceiveDiffOutput(prev, curr, { mode: 'since-action' })).toMatch(/no changes detected/i);
  });

  it('a marked baseline line still matches an unmarked current line by text', () => {
    const prev = [...header, `[button] Save @1${mark(21)}`, `[button] Cancel @2${mark(23)}`].join('\n');
    const curr = [...header, '[button] Save @1', '[button] Cancel @2'].join('\n');
    expect(T.formatPerceiveDiffOutput(prev, curr, { mode: 'since-action' })).toMatch(/no changes detected/i);
  });

  it('marks a line with the node of its last @ref', () => {
    const lines = ['[link] Docs @f2:4 inside @f2 @7'];
    const out = annotatePerceiveIdentityLines(lines, [
      { ref: 4, backendDOMNodeId: 40 },
      { ref: 7, backendDOMNodeId: 70 },
    ]);
    expect(out[0]).toBe(`[link] Docs @f2:4 inside @f2 @7${mark(70)}`);
  });
});
