import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #589: after a click opens a menu, a navigation the page starts itself
// (location.reload() or location.href = location.href) leaves the pre-navigation
// AX snapshot in place. The next click opens the menu again, the two trees
// match, and the receipt is Outcome: no-change / Kind: click-no-change even
// though the click worked. Cases A (perceive after the navigation) and B
// (the tool's own nav, whose next click must still compare the loaded document)
// stay correct. A real no-op on the loaded document is still no-change.

const FIXTURE = readFileSync(new URL('./fixtures/issue-589-menu.html', import.meta.url), 'utf8');
const BUTTON_LABEL = FIXTURE.match(/id="btn"[^>]*>([^<]+)</)[1];
const MENU_LABEL = FIXTURE.match(/aria-label="([^"]+)"/)[1];
const TARGET_ID = '589A1C0DE5E1F0000000000000000589';
const emptyDelta = {
  console: { count: 0, errors: 0, warnings: 0, entries: [] },
  exceptions: { count: 0, entries: [] },
  network: { count: 0, failures: 0, pending: 0, entries: [] },
};

function pageMeta(state) {
  return JSON.stringify({
    title: 'menu repro',
    url: 'http://127.0.0.1/menu.html',
    contentType: 'text/html',
    vw: 1252,
    vh: 799,
    scrollY: 0,
    scrollMax: 0,
    counts: { button: state.menuOpen ? 3 : 1 },
    focused: state.menuOpen ? '<button>' : 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [],
  });
}

function axNodes(state) {
  const rootChildren = ['2', '8'];
  const nodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'menu repro' }, childIds: rootChildren },
    { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: BUTTON_LABEL }, backendDOMNodeId: 30, childIds: ['4'] },
    { nodeId: '4', parentId: '2', role: { value: 'StaticText' }, name: { value: BUTTON_LABEL } },
    { nodeId: '8', parentId: '1', role: { value: 'paragraph' }, name: { value: '' }, childIds: ['9'] },
    { nodeId: '9', parentId: '8', role: { value: 'StaticText' }, name: { value: state.token } },
  ];
  if (state.menuOpen) {
    rootChildren.push('5');
    nodes.push(
      { nodeId: '5', parentId: '1', role: { value: 'menu' }, name: { value: MENU_LABEL }, childIds: ['6', '7'] },
      { nodeId: '6', parentId: '5', role: { value: 'menuitemradio' }, name: { value: '5 s' }, backendDOMNodeId: 31, childIds: ['6t'] },
      { nodeId: '6t', parentId: '6', role: { value: 'StaticText' }, name: { value: '5 s' } },
      { nodeId: '7', parentId: '5', role: { value: 'menuitemradio' }, name: { value: '10 s' }, backendDOMNodeId: 32, childIds: ['7t'] },
      { nodeId: '7t', parentId: '7', role: { value: 'StaticText' }, name: { value: '10 s' } },
    );
  }
  return nodes;
}

function createPage({ axError = null, generation = 1 } = {}) {
  const state = { menuOpen: false, token: 'loaded', axError };
  let pageGeneration = generation;
  const calls = [];
  const cdp = {
    send(method) {
      calls.push(method);
      if (state.axError && method === 'Accessibility.getFullAXTree') return Promise.reject(state.axError);
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: pageMeta(state) } });
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: axNodes(state) });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj' } });
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: { x: 8, y: 8, w: 98, h: 21, position: 'static' } } });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return {
    cdp,
    state,
    axCalls: () => calls.filter(method => method === 'Accessibility.getFullAXTree').length,
    pageGeneration: () => pageGeneration,
    navigate(token = 'reloaded') {
      // What the daemon's main-frame Page.frameNavigated handler does: the
      // document is new, refs are cleared, and the stored AX snapshot is not.
      state.menuOpen = false;
      state.token = token;
      pageGeneration += 1;
    },
  };
}

function sessionFrom(store, refState) {
  return {
    refMap: new Map(),
    refState,
    store,
  };
}

function freshSession() {
  return sessionFrom(
    { output: null, model: null, snapshotOpts: null, cards: null },
    { generation: 0, invalidationReason: 'daemon-start' },
  );
}

function cssTarget(input = '#btn') {
  return { input, resolvedBy: 'selector-or-ref', label: input, commandArgs: [input], targetId: TARGET_ID, clickTrust: { tag: 'BUTTON' } };
}

function resolveBaseline(page, session, actionTarget, opts = {}) {
  return T.resolveActionSettleBaseline({
    cdp: page.cdp,
    sid: 'sid',
    consoleBuf: new T.RingBuffer(8),
    exceptionBuf: new T.RingBuffer(8),
    refMap: session.refMap,
    refState: session.refState,
    lastPerceiveStore: session.store,
    targetId: TARGET_ID,
    action: opts.action || 'click',
    actionTarget,
    feedbackPolicy: opts.feedbackPolicy || 'settle-diff',
    observe: opts.observe || null,
    pageGeneration: page.pageGeneration,
  });
}

function observe(page, session, actionTarget, baseline) {
  return T.perceiveStr(
    page.cdp,
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

// The failing session: a click already opened the menu (that settle stored the
// open tree), then the fixture page navigates itself. The daemon records the
// navigation and keeps the open-menu snapshot.
async function primedThenSelfNavigated(page) {
  const session = freshSession();
  page.state.menuOpen = true;
  page.state.token = 'before-nav';
  await T.perceiveStr(
    page.cdp,
    'sid',
    new T.RingBuffer(8),
    new T.RingBuffer(8),
    session.refMap,
    session.store,
    { targetPrefix: '589A1C0D' },
    session.refState,
  );
  expect(session.store.output).toMatch(/\[menu\]/);
  page.navigate('reloaded');
  session.refState.map = session.refMap;
  T.invalidateSessionRefs({ refs: session.refState, refGeneration: 0 }, 'navigation');
  expect(session.refState.invalidationReason).toBe('navigation');
  expect(session.store.output).toMatch(/\[menu\]/);
  return session;
}

describe('#589 click baseline follows a navigation the page started', () => {
  it('reads the menu fixture the repro page reloads', () => {
    expect(FIXTURE).toContain('id="btn"');
    expect(FIXTURE).toContain('aria-expanded');
    expect(FIXTURE).toContain('role="menu"');
    expect(BUTTON_LABEL).toBe('5 s · standard');
    expect(MENU_LABEL).toBe('Length');
  });

  // C: eval 'location.reload()'. D: eval 'location.href = location.href'.
  // Both are a main-frame navigation the tool did not start.
  for (const navigation of ['location.reload()', 'location.href = location.href']) {
    it(`case ${navigation} reports the click as changed against the loaded document`, async () => {
      const page = createPage();
      const session = await primedThenSelfNavigated(page);
      const target = cssTarget();
      const before = page.axCalls();

      const baseline = await resolveBaseline(page, session, target);
      expect(page.axCalls()).toBeGreaterThan(before);
      expect(baseline.output).toContain('[StaticText] reloaded');
      expect(baseline.output).not.toMatch(/\[menu\]/);
      expect(baseline.baselineStale).toBeUndefined();

      page.state.menuOpen = true;
      const after = await observe(page, session, target, baseline);
      expect(after).toMatch(/\[menu\]/);
      expect(T.actionDomDiffShowsChange(after)).toBe(true);
      const result = receiptFor(after, target);
      expect(result.outcome.status).toBe('changed');
    });
  }

  it('case A: a perceive after the navigation is the baseline, with no second capture', async () => {
    const page = createPage();
    const session = await primedThenSelfNavigated(page);
    await T.perceiveStr(
      page.cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      session.refMap,
      session.store,
      { targetPrefix: '589A1C0D' },
      session.refState,
    );
    expect(session.refState.invalidationReason).toBeNull();
    expect(session.store.output).toContain('[StaticText] reloaded');
    expect(session.store.output).not.toMatch(/\[menu\]/);
    const before = page.axCalls();
    const baseline = await resolveBaseline(page, session, cssTarget());
    expect(page.axCalls()).toBe(before);
    expect(baseline.output).toBe(T.perceiveStoreDiffSource(session.store));

    page.state.menuOpen = true;
    const after = await observe(page, session, cssTarget(), baseline);
    expect(receiptFor(after, cssTarget()).outcome.status).toBe('changed');
  });

  it('case B: a tool nav does not recapture during its own observer, and the next click does', async () => {
    const page = createPage();
    const session = await primedThenSelfNavigated(page);
    const before = page.axCalls();
    const duringNav = await resolveBaseline(page, session, cssTarget(page.state.token), {
      action: 'nav',
      feedbackPolicy: 'state-change',
      observe: async () => 'Navigation observation',
    });
    expect(page.axCalls()).toBe(before);
    expect(duringNav.output).toMatch(/\[menu\]/);

    const clickBaseline = await resolveBaseline(page, session, cssTarget());
    expect(clickBaseline.output).toContain('[StaticText] reloaded');
    expect(clickBaseline.output).not.toMatch(/\[menu\]/);
    page.state.menuOpen = true;
    const after = await observe(page, session, cssTarget(), clickBaseline);
    expect(receiptFor(after, cssTarget()).outcome.status).toBe('changed');
  });

  it('a click with no navigation still reuses the leftover tree', async () => {
    const page = createPage();
    const session = freshSession();
    page.state.token = 'steady';
    await T.perceiveStr(page.cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), session.refMap, session.store, { targetPrefix: '589A1C0D' }, session.refState);
    const before = page.axCalls();
    const baseline = await resolveBaseline(page, session, cssTarget());
    expect(page.axCalls()).toBe(before);
    expect(baseline.output).toBe(T.perceiveStoreDiffSource(session.store));
  });

  it('a genuine no-op on the loaded document stays Outcome: no-change', async () => {
    const page = createPage();
    const session = await primedThenSelfNavigated(page);
    const target = cssTarget();
    const baseline = await resolveBaseline(page, session, target);
    const after = await observe(page, session, target, baseline);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    const result = receiptFor(after, target);
    expect(result.outcome.status).toBe('no-change');
    expect(target.clickTrust.tag).toBe('BUTTON');
  });

  it('a snapshot that throws after navigation does not reuse the stale tree or report no-change', async () => {
    const page = createPage();
    const session = await primedThenSelfNavigated(page);
    page.state.axError = new Error('Accessibility.getFullAXTree timed out');
    const target = cssTarget();
    const baseline = await resolveBaseline(page, session, target);
    expect(baseline).toEqual({ output: null, opts: null, captureFailed: true, baselineStale: true });
    expect(session.store.output).toMatch(/\[menu\]/);

    target.baselineStale = true;
    const result = receiptFor(null, target);
    expect(result.outcome.status).toBe('dispatched');
    expect(result.outcome.reason).toMatch(/baseline is stale/i);
    const text = T.formatActionResultOutput(result, { dispatchText: `Clicked <BUTTON> "${BUTTON_LABEL}"` });
    expect(text).toMatch(/baseline is stale/i);
    expect(text).not.toMatch(/did not react/);
  });
});

describe('#589 daemon wiring', () => {
  const src = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');

  it('a main-frame navigation still invalidates refs, and the settle baseline reads that reason', () => {
    expect(src).toMatch(/Page\.frameNavigated[\s\S]{0,500}invalidateSessionRefs\(session, 'navigation'\)/);
    expect(src).toMatch(/function shouldRecaptureNavigatedBaseline\(/);
    expect(src).toMatch(/invalidationReason !== 'navigation'/);
  });

  it('actionFeedback passes the live page generation and keeps a failed recapture off the no-change path', () => {
    const start = src.indexOf('  async function actionFeedback(');
    const end = src.indexOf('    session.lastAction = {', start);
    const body = src.slice(start, end);
    const call = body.match(/await resolveActionSettleBaseline\(\{([\s\S]*?)\}\);/);
    expect(call).not.toBeNull();
    const keys = call[1].split(',').map(part => part.trim()).filter(Boolean);
    expect(keys).toContain('pageGeneration');
    expect(body).toMatch(/settleBaseline\.baselineStale/);
  });
});
