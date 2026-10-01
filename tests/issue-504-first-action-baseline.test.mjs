import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #504: the first action of a daemon that had not perceived yet had no settle
// baseline. The action captured none before dispatch, so the settle step only
// perceived the page after the action and printed "No changes detected." even
// when the click had changed the page. The receipt said Outcome: no-change.

const TARGET_ID = '7F9276A3AE622AA283621DE66AF7CBB8';
const emptyDelta = {
  console: { count: 0, errors: 0, warnings: 0, entries: [] },
  exceptions: { count: 0, entries: [] },
  network: { count: 0, failures: 0, pending: 0, entries: [] },
};

function pageMeta() {
  return JSON.stringify({
    title: 'I504',
    url: 'http://127.0.0.1/i504.html',
    contentType: 'text/html',
    vw: 1252,
    vh: 799,
    scrollY: 0,
    scrollMax: 0,
    counts: { button: 1 },
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [],
  });
}

function axNodes(state) {
  return [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'I504' }, childIds: ['2', '3', '5'] },
    { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Issue 504' } },
    { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'Press me' }, backendDOMNodeId: 30, childIds: ['4'] },
    { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: 'Press me' } },
    { nodeId: '5', parentId: '1', role: { value: 'paragraph' }, name: { value: '' }, childIds: ['6'] },
    { nodeId: '6', parentId: '5', role: { value: 'StaticText' }, name: { value: state.status } },
  ];
}

function createPage() {
  const state = { status: 'Idle' };
  const calls = [];
  const cdp = {
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: pageMeta() } });
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: axNodes(state) });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj' } });
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: { x: 8, y: 60, w: 70, h: 21, position: 'static' } } });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  const axCalls = () => calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
  return { cdp, state, axCalls };
}

// A fresh daemon's session state (createSessionState): nothing perceived yet.
function freshSession() {
  return {
    refMap: new Map(),
    refState: { generation: 0, invalidationReason: 'daemon-start' },
    store: { output: null, model: null, snapshotOpts: null, cards: null },
  };
}

function cssTarget(input = '#b') {
  return { input, resolvedBy: 'selector-or-ref', label: input, commandArgs: [input], targetId: TARGET_ID };
}

function resolveBaseline(cdp, session, actionTarget, { action = 'click', feedbackPolicy = 'settle-diff', observe = null } = {}) {
  return T.resolveActionSettleBaseline({
    cdp,
    sid: 'sid',
    consoleBuf: new T.RingBuffer(8),
    exceptionBuf: new T.RingBuffer(8),
    refMap: session.refMap,
    refState: session.refState,
    lastPerceiveStore: session.store,
    targetId: TARGET_ID,
    action,
    actionTarget,
    feedbackPolicy,
    observe,
  });
}

// Mirrors the daemon's observeActionDiffForTarget once a baseline exists.
function observe(cdp, session, actionTarget, baseline) {
  return T.perceiveStr(
    cdp,
    'sid',
    new T.RingBuffer(8),
    new T.RingBuffer(8),
    session.refMap,
    session.store,
    T.actionSettleObserveOpts(TARGET_ID, actionTarget, baseline.output, baseline.opts),
    session.refState,
  );
}

function receiptFor(domDiff, actionTarget, action = 'click') {
  return T.applyActionObservationDelta(T.createActionResult({
    action,
    target: actionTarget,
    dispatch: { ok: true, method: action },
    settle: { ok: true, durationMs: 80 },
    effects: { domDiff, console: [], network: [], navigation: null },
  }), emptyDelta);
}

describe('#504 the first action of a fresh daemon has a settle baseline', () => {
  it('a click whose only effect is a DOM change is Outcome: changed', async () => {
    const { cdp, state } = createPage();
    const session = freshSession();
    const target = cssTarget();

    const baseline = await resolveBaseline(cdp, session, target);
    expect(baseline.output).toContain('[StaticText] Idle');

    state.status = 'Clicked 1';
    const after = await observe(cdp, session, target, baseline);
    expect(after).toMatch(/^\+\s+\[StaticText\] Clicked 1$/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    const receipt = receiptFor(after, target);
    expect(receipt.outcome.status).toBe('changed');
    expect(T.formatActionText(receipt)).toMatch(/Outcome: changed/);
  });

  it('a genuine no-op click on a fresh daemon stays Outcome: no-change (#211)', async () => {
    const { cdp } = createPage();
    const session = freshSession();
    const target = cssTarget();
    const baseline = await resolveBaseline(cdp, session, target);
    const after = await observe(cdp, session, target, baseline);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(receiptFor(after, target).outcome.status).toBe('no-change');
  });

  it('a text= click that settles the DOM sees the change too', async () => {
    const { cdp, state } = createPage();
    const session = freshSession();
    const target = { ...T.namedClickActionTarget('text=Press me'), targetId: TARGET_ID };
    const baseline = await resolveBaseline(cdp, session, target, { feedbackPolicy: 'settle-diff' });
    state.status = 'Clicked 1';
    const after = await observe(cdp, session, target, baseline);
    expect(receiptFor(after, target).outcome.status).toBe('changed');
  });

  it('the capture does not assign refs or count as a perceive', async () => {
    // Refs a fresh daemon never printed must stay stale: a leftover @ref from
    // the previous daemon must not resolve against numbers the agent never saw.
    const { cdp } = createPage();
    const session = freshSession();
    await resolveBaseline(cdp, session, cssTarget());
    expect(session.refMap.size).toBe(0);
    expect(session.refState).toEqual({ generation: 0, invalidationReason: 'daemon-start' });
    expect(session.store).toEqual({ output: null, model: null, snapshotOpts: null, cards: null });
  });

  it('reuses the leftover perceive instead of capturing again', async () => {
    const { cdp, axCalls } = createPage();
    const session = freshSession();
    await T.perceiveStr(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), session.refMap, session.store, { targetPrefix: '7F9276A3' }, session.refState);
    const before = axCalls();
    const baseline = await resolveBaseline(cdp, session, cssTarget());
    expect(axCalls()).toBe(before);
    expect(baseline.output).toBe(T.perceiveStoreDiffSource(session.store));
  });

  it('does not capture when nothing will diff against the baseline', async () => {
    const cases = [
      { feedbackPolicy: 'report-only' },
      { feedbackPolicy: 'none' },
      { feedbackPolicy: 'full-perceive', observe: async () => '' },
    ];
    for (const opts of cases) {
      const { cdp, axCalls } = createPage();
      const baseline = await resolveBaseline(cdp, freshSession(), cssTarget(), opts);
      expect(axCalls()).toBe(0);
      expect(baseline.output).toBeNull();
    }
  });

  it('does not capture for a @ref target: a fresh daemon has no live refs to resolve', async () => {
    for (const input of ['@3', '@f1:2', '@c1']) {
      const { cdp, axCalls } = createPage();
      const baseline = await resolveBaseline(cdp, freshSession(), cssTarget(input));
      expect(axCalls()).toBe(0);
      expect(baseline.output).toBeNull();
    }
  });

  it('keeps the idle-hover discard (#291): a discarded baseline is not a fresh daemon', async () => {
    const { cdp, axCalls } = createPage();
    const session = freshSession();
    await T.perceiveStr(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), session.refMap, session.store, { targetPrefix: '7F9276A3' }, session.refState);
    T.discardHoverIdleBaseline(session.store);
    const before = axCalls();
    const baseline = await resolveBaseline(cdp, session, cssTarget(), { action: 'scroll' });
    expect(axCalls()).toBe(before);
    expect(baseline.output).toBeNull();
  });

  it('a first scroll settles like a scroll after any other action', async () => {
    const { cdp } = createPage();
    const session = freshSession();
    const target = { ...T.scrollActionTarget(['down', '80']), targetId: TARGET_ID };
    const baseline = await resolveBaseline(cdp, session, target, { action: 'scroll' });
    expect(baseline.output).toContain('[StaticText] Idle');
    expect(target.expectedOutcome).toBe('leftover-ax-scroll-no-change');
  });
});
