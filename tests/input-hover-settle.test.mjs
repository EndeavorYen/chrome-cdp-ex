import { describe, expect, it } from 'vitest';

import { runtimeSource } from './runtime-source.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #286 hover settle baseline', () => {
  const TARGET_ID = '62E1DF195EAC5A1A211792636BAE8A07';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pageMeta() {
    return JSON.stringify({
      title: 'Example Domain',
      url: 'https://example.com/',
      contentType: 'text/html',
      vw: 1042,
      vh: 632,
      scrollY: 0,
      scrollMax: 0,
      counts: { span: 1 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'span',
        role: 'button',
        label: 'p23hover',
        clickable: true,
        rect: { x: 8, y: 80, w: 80, h: 24 },
        selector: 'span#p23hover',
        hints: { id: 'p23hover', classes: [] },
      }],
    });
  }

  function axNodes(hovers) {
    return [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example Domain' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Example Domain' } },
      { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'p23hover' }, backendDOMNodeId: 23 },
      { nodeId: '4', parentId: '1', role: { value: 'StaticText' }, name: { value: `hover:${hovers}` } },
    ];
  }

  function isWaitForSettleExpr(expr) {
    return typeof expr === 'string'
      && expr.includes("resolve('stable')")
      && expr.includes('setTimeout(done, 350)');
  }

  function isHoverMutationExpr(expr) {
    return typeof expr === 'string'
      && expr.includes('chrome-cdp-ex.hover-mutation.v1')
      && expr.includes('hover-changed');
  }

  function createPicky23Page({
    hovers = 0,
    delayHoverUntilSettle = false,
    idleQuiet = false,
    hangMutation = false,
  } = {}) {
    const state = { hovers, pendingHover: false };
    const deferHover = delayHoverUntilSettle || idleQuiet || hangMutation;
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: 'https://example.com/' } } });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (isHoverMutationExpr(expr)) {
            if (hangMutation) {
              // Live Chrome 151: mutation never arrives inside HOVER_MUTATION_TIMEOUT_MS.
              // Sitting this wait is the paid residual after #289 discard.
              return new Promise(resolve => {
                setTimeout(
                  () => resolve({ result: { value: 'timeout' } }),
                  T.HOVER_MUTATION_TIMEOUT_MS,
                );
              });
            }
            if (state.pendingHover && !idleQuiet) {
              state.hovers += 1;
              state.pendingHover = false;
              return Promise.resolve({ result: { value: 'hover-changed' } });
            }
            return Promise.resolve({ result: { value: 'timeout' } });
          }
          if (isWaitForSettleExpr(expr) || expr.includes('MutationObserver')) {
            // waitForSettle's 350ms quiet is not the hover mutation. Applying
            // pendingHover here would hide the live Chrome 151 residual.
            return Promise.resolve({ result: { value: 'stable' } });
          }
          if (expr.includes('scrollBy')) {
            return Promise.resolve({ result: { value: '{"x":0,"y":0}' } });
          }
          if (expr.includes('#p23hover') && expr.includes('rect.width / 2')) {
            return Promise.resolve({ result: { value: { ok: true, x: 48, y: 92, tag: 'SPAN' } } });
          }
          if (expr.includes('chrome-cdp-ex.hover-reveal.v1')) {
            return Promise.resolve({
              result: {
                value: {
                  ok: true,
                  marker: 'chrome-cdp-ex.hover-reveal.v1',
                  opacity: 1,
                  visibility: 'visible',
                  display: 'inline',
                  visible: true,
                  groupHover: true,
                  matchesHover: true,
                  tag: 'SPAN',
                },
              },
            });
          }
          return Promise.resolve({ result: { value: pageMeta() } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: axNodes(state.hovers) });
        }
        if (method === 'Input.dispatchMouseEvent') {
          if (params.type === 'mouseMoved') {
            if (deferHover) state.pendingHover = true;
            else state.hovers += 1;
          }
          return Promise.resolve({});
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          return Promise.resolve({ nodeId: 23 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'p23-hover' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { connected: true, x: 8, y: 80, w: 80, h: 24, tag: 'SPAN' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  function scrollTarget() {
    return {
      input: 'down',
      resolvedBy: 'scroll',
      label: 'down',
    };
  }

  async function settleScrollReceipt(cdp, store, { refreshHover = false } = {}) {
    const refMap = new Map();
    const refState = {};
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      refState,
    );
    expect(before).toContain('[StaticText] hover:0');
    let hoverText;
    if (refreshHover) {
      expect(typeof T.rememberHoverSettleBaseline).toBe('function');
      await T.rememberHoverSettleBaseline(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        refState,
        TARGET_ID,
        async () => {
          hoverText = await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
        },
      );
    } else {
      hoverText = await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
    }
    expect(hoverText).toMatch(/Hovering over <SPAN>/);
    const actionTarget = scrollTarget();
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    return { hoverText, dispatchText, after, result, text: T.formatActionText(result), settleBaseline };
  }

  it('#286 hover then no-op scroll must not claim + hover text as scroll change', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 0 });
    const store = { output: null, snapshotOpts: null };
    const liar = await settleScrollReceipt(cdp, store, { refreshHover: false });
    expect(state.hovers).toBe(1);
    expect(liar.after).toMatch(/\+\s+\[StaticText\] hover:1/);
    expect(liar.result.outcome.status).toBe('changed');

    const honestStore = { output: null, snapshotOpts: null };
    const { cdp: honestCdp, state: honestState } = createPicky23Page({ hovers: 0 });
    const honest = await settleScrollReceipt(honestCdp, honestStore, { refreshHover: true });
    expect(honestState.hovers).toBe(1);
    expect(honest.settleBaseline.output).toContain('[StaticText] hover:1');
    expect(honestCdp.calls.some(call => (
      call.method === 'Runtime.evaluate'
      && isHoverMutationExpr(String(call.params.expression || ''))
    ))).toBe(false);
    expect(honest.after).toMatch(/no changes detected/i);
    expect(honest.after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    expect(honest.result.outcome.status).toBe('no-change');
    expect(honest.text).not.toMatch(/Outcome: changed/);
  });

  it('#286 perceive then the same no-op scroll stays no-change', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 1 });
    const store = { output: null, snapshotOpts: null };
    const actionTarget = scrollTarget();
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { targetPrefix: '62E1DF19' },
      {},
    );
    expect(before).toContain('[StaticText] hover:1');
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      T.actionSettleObserveOpts(TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      {},
    );
    expect(state.hovers).toBe(1);
    expect(after).toMatch(/no changes detected/i);
    expect(after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('no-change');
  });

  it('#286 hover handler refreshes last-perceive settle baseline', () => {
    const src = runtimeSource();
    expect(src).toMatch(/hover: async args =>[\s\S]{0,1600}dispatchHoverWithLeftoverPolicy\(/);
    expect(src).toMatch(/async function dispatchHoverWithLeftoverPolicy[\s\S]{0,2000}rememberHoverSettleBaseline\(/);
    expect(src).toMatch(/async function dispatchHoverWithLeftoverPolicy[\s\S]{0,2000}hoverStr\(/);
    expect(src).not.toMatch(
      /async function rememberHoverSettleBaseline[\s\S]{0,2800}waitForHoverDomChange\(/,
    );
    expect(src).toMatch(
      /async function rememberHoverSettleBaseline[\s\S]{0,2800}if \(hoverRecaptureShowsChange\(before, lastPerceiveStore\.output\)\) \{\s*return;\s*\}\s*discardHoverIdleBaseline\(/,
    );
    expect(src).not.toMatch(
      /async function rememberHoverSettleBaseline[\s\S]{0,800}await waitForSettle\(cdp, sid\);\s*await perceiveStr\(/,
    );
    expect(T.HOVER_MUTATION_TIMEOUT_MS).toBe(3000);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);
  });

  it('#291 idle recapture must discard without sitting HOVER_MUTATION_TIMEOUT_MS', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 0, hangMutation: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      refState,
    );
    expect(before).toContain('[StaticText] hover:0');
    const started = Date.now();
    await T.rememberHoverSettleBaseline(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      refState,
      TARGET_ID,
      async () => {
        await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
      },
    );
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(1000);
    expect(cdp.calls.some(call => (
      call.method === 'Runtime.evaluate'
      && isHoverMutationExpr(String(call.params.expression || ''))
    ))).toBe(false);
    expect(state.pendingHover).toBe(true);
    expect(state.hovers).toBe(0);
    expect(store.output).toBeNull();

    state.hovers += 1;
    state.pendingHover = false;
    const actionTarget = scrollTarget();
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    expect(settleBaseline.output).toBeNull();
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = T.noBaselineActionDiffText();
    expect(after).toMatch(/no changes detected/i);
    expect(after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('no-change');
  });

  it('#286 recapture must not write the idle tree while hover is still pending', async () => {
    const { cdp, state } = createPicky23Page({ hovers: 0, idleQuiet: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      refState,
    );
    expect(before).toContain('[StaticText] hover:0');
    await T.rememberHoverSettleBaseline(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      refState,
      TARGET_ID,
      async () => {
        await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
      },
    );
    expect(state.pendingHover).toBe(true);
    expect(state.hovers).toBe(0);
    expect(String(store.output || '')).not.toContain('[StaticText] hover:0');
    expect(store.output).toBeNull();

    if (state.pendingHover) {
      state.hovers += 1;
      state.pendingHover = false;
    }
    const actionTarget = scrollTarget();
    const settleBaseline = T.actionSettleBaseline(store.output, store.snapshotOpts, actionTarget);
    expect(settleBaseline.output).toBeNull();
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 0)');
    const after = settleBaseline.output
      ? await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        T.actionSettleObserveOpts(TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
        refState,
      )
      : T.noBaselineActionDiffText();
    expect(after).toMatch(/no changes detected/i);
    expect(after).not.toMatch(/\+\s+\[StaticText\] hover:1/);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('no-change');
  });

  it('#286 leftover -C -d 8 vs default idle AX on timeout must discard, not KEEP', async () => {
    const leftoverOpts = {
      targetPrefix: '62E1DF19',
      cursorInteractive: true,
      maxDepth: 8,
    };
    const { cdp, state } = createPicky23Page({ hovers: 0, idleQuiet: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftover = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      leftoverOpts,
      refState,
    );
    expect(leftover).toContain('[StaticText] hover:0');
    expect(leftover).toContain('[Visible controls]');
    expect(store.snapshotOpts).toMatchObject({ cursorInteractive: true, maxDepth: 8 });

    const { cdp: defaultCdp } = createPicky23Page({ hovers: 0, idleQuiet: true });
    const defaultIdle = await T.perceiveStr(
      defaultCdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { output: null, snapshotOpts: null },
      { targetPrefix: '62E1DF19' },
      {},
    );
    expect(defaultIdle).toContain('[StaticText] hover:0');
    expect(defaultIdle).not.toContain('[Visible controls]');
    expect(T.hoverRecaptureShowsChange(leftover, defaultIdle)).toBe(true);

    await T.rememberHoverSettleBaseline(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      refState,
      TARGET_ID,
      async () => {
        await T.hoverStr(cdp, 'sid', '#p23hover', refMap, refState);
      },
    );
    expect(state.pendingHover).toBe(true);
    expect(state.hovers).toBe(0);
    expect(store.output).toBeNull();
  });
});
