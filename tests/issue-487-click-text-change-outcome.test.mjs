import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #487: after `perceive -i`, the action settle diff reused the interactive-only
// shape. That shape drops non-interactive text (a status <p>), so a click whose
// only effect was `smooth:not-clicked` -> `smooth:clicked` printed
// "(no changes detected in AX tree)" and the receipt said Outcome: no-change.

const TARGET_ID = '48515122ABCDEF0123456789ABCDEF01';
const emptyDelta = {
  console: { count: 0, errors: 0, warnings: 0, entries: [] },
  exceptions: { count: 0, entries: [] },
  network: { count: 0, failures: 0, pending: 0, entries: [] },
};

function pageMeta() {
  return JSON.stringify({
    title: 'smoke',
    url: 'http://127.0.0.1/smoke-page.html',
    contentType: 'text/html',
    vw: 1252,
    vh: 799,
    scrollY: 0,
    scrollMax: 0,
    counts: { button: 2 },
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [],
  });
}

function axNodes(state) {
  return [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'smoke' }, childIds: ['2', '3', '5', '7'] },
    { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'smoke' } },
    { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'Smooth target' }, backendDOMNodeId: 30, childIds: ['4'] },
    // The button's own label text duplicates its name; it is not page text the -i filter hides.
    { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: 'Smooth target' } },
    { nodeId: '5', parentId: '1', role: { value: 'paragraph' }, name: { value: '' }, childIds: ['6'] },
    { nodeId: '6', parentId: '5', role: { value: 'StaticText' }, name: { value: state.status } },
    { nodeId: '7', parentId: '1', role: { value: 'button' }, name: { value: 'No visible change' }, backendDOMNodeId: 70 },
  ];
}

function createSmokePage() {
  const state = { status: 'smooth:not-clicked' };
  const cdp = {
    send(method) {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: pageMeta() } });
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: axNodes(state) });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj' } });
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: { x: 36, y: 671, w: 137, h: 40, position: 'static' } } });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return { cdp, state };
}

function perceive(cdp, store, opts, refMap = new Map(), refState = {}) {
  return T.perceiveStr(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), refMap, store, opts, refState);
}

function clickTarget() {
  return { input: '@1', resolvedBy: 'selector-or-ref', label: '@1', commandArgs: ['@1'] };
}

// Mirrors daemon actionFeedback: the settle baseline is the leftover perceive's
// diff source, settled in the leftover perceive's shape.
function settleBaseline(store, actionTarget, refState = {}) {
  const baselineFromTarget = T.baselineOutputForActionTarget(
    refState,
    T.perceiveStoreDiffSource(store),
    actionTarget,
  );
  return T.actionSettleBaseline(baselineFromTarget, store.snapshotOpts || null, actionTarget);
}

function receiptFor(domDiff, actionTarget) {
  return T.applyActionObservationDelta(T.createActionResult({
    action: 'click',
    target: { targetId: TARGET_ID, ...actionTarget },
    dispatch: { ok: true, method: 'click' },
    settle: { ok: true, durationMs: 80 },
    effects: { domDiff, console: [], network: [], navigation: null },
  }), emptyDelta);
}

describe('#487 click receipt after perceive -i sees a text-only change', () => {
  it('a click whose only effect is text in a non-interactive <p> is Outcome: changed', async () => {
    const { cdp, state } = createSmokePage();
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const perceived = await perceive(cdp, store, { ...T.parsePerceiveArgs(['-i', '-d', '8']), targetPrefix: '48515122' }, refMap);
    // The printed -i tree is unchanged: no non-interactive text, same refs.
    expect(perceived).not.toContain('smooth:not-clicked');
    expect(perceived).toMatch(/\[button\] Smooth target {2}@1/);
    expect(perceived).toMatch(/\[button\] No visible change {2}@2/);
    expect(store.snapshotOpts.interactive).toBe(true);

    const target = clickTarget();
    const baseline = settleBaseline(store, target);
    expect(baseline.opts.interactive).toBe(true);

    state.status = 'smooth:clicked';
    const after = await perceive(cdp, store, T.actionSettleObserveOpts(TARGET_ID, target, baseline.output, baseline.opts), refMap);
    expect(after).not.toMatch(/no changes detected in AX tree/i);
    expect(after).toMatch(/~~~ Text nodes updated \(1 removed, 1 added\)/);
    expect(after).toMatch(/\+ \[StaticText\] smooth:clicked/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    // Settle keeps the -i ref numbering the agent is using.
    expect(refMap.get(1)).toBe(30);
    expect(refMap.get(2)).toBe(70);

    const receipt = receiptFor(after, target);
    expect(receipt.outcome.status).toBe('changed');
    const text = T.formatActionText(receipt);
    expect(text).toMatch(/Outcome: changed/);
    expect(text).not.toMatch(/No visible AX tree change/);
  });

  it('a genuine no-op after perceive -i stays Outcome: no-change', async () => {
    const { cdp } = createSmokePage();
    const store = { output: null, snapshotOpts: null, cards: null };
    await perceive(cdp, store, { ...T.parsePerceiveArgs(['-i', '-d', '8']), targetPrefix: '48515122' });
    const target = { input: '@2', resolvedBy: 'selector-or-ref', label: '@2', commandArgs: ['@2'] };
    const baseline = settleBaseline(store, target);
    const after = await perceive(cdp, store, T.actionSettleObserveOpts(TARGET_ID, target, baseline.output, baseline.opts));
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(receiptFor(after, target).outcome.status).toBe('no-change');
  });

  it('a second action keeps comparing the text the -i settle hid', async () => {
    const { cdp, state } = createSmokePage();
    const store = { output: null, snapshotOpts: null, cards: null };
    await perceive(cdp, store, { ...T.parsePerceiveArgs(['-i', '-d', '8']), targetPrefix: '48515122' });
    const target = clickTarget();
    // First action: genuine no-op; its settle perceive becomes the next baseline.
    let baseline = settleBaseline(store, target);
    await perceive(cdp, store, T.actionSettleObserveOpts(TARGET_ID, target, baseline.output, baseline.opts));
    baseline = settleBaseline(store, target);
    state.status = 'smooth:clicked';
    const after = await perceive(cdp, store, T.actionSettleObserveOpts(TARGET_ID, target, baseline.output, baseline.opts));
    expect(after).toMatch(/\+ \[StaticText\] smooth:clicked/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
  });

  it('perceive --since-action (text and JSON) after the click reports the text change', async () => {
    const { cdp, state } = createSmokePage();
    const store = { output: null, snapshotOpts: null, cards: null };
    await perceive(cdp, store, { ...T.parsePerceiveArgs(['-i', '-d', '8']), targetPrefix: '48515122' });
    const target = clickTarget();
    const baseline = settleBaseline(store, target);
    const lastAction = { action: 'click', baselineOutput: baseline.output, baselineOpts: baseline.opts };
    state.status = 'smooth:clicked';

    const textOpts = T.resolveSinceActionPerceiveOpts(T.parsePerceiveArgs(['--since-action']), lastAction, ['--since-action']);
    const text = await perceive(cdp, { ...store }, textOpts);
    expect(text).toMatch(/\+ \[StaticText\] smooth:clicked/);

    const model = await T.perceiveDiffModel(cdp, 'sid', new T.RingBuffer(8), new T.RingBuffer(8), new Map(), { ...store }, textOpts);
    expect(model.summary.changed).toBe(true);
    expect(model.summary.textAdded).toBe(1);
    expect(model.textAddedSamples.join('\n')).toContain('smooth:clicked');
  });

  it('perceive -i --diff reports a text-only change instead of "no changes"', async () => {
    const { cdp, state } = createSmokePage();
    const store = { output: null, snapshotOpts: null, cards: null };
    await perceive(cdp, store, T.parsePerceiveArgs(['-i', '-d', '8']));
    state.status = 'smooth:clicked';
    const diff = await perceive(cdp, store, T.parsePerceiveArgs(['-i', '-d', '8', '--diff']));
    expect(diff).toMatch(/\+ \[StaticText\] smooth:clicked/);
    expect(diff).not.toMatch(/no changes detected in AX tree/i);
  });

  it('the default shape needs no diff-only text: its tree already prints the <p>', async () => {
    const { cdp } = createSmokePage();
    const store = { output: null, snapshotOpts: null, cards: null };
    const out = await perceive(cdp, store, T.parsePerceiveArgs(['-d', '8']));
    expect(out).toContain('[StaticText] smooth:not-clicked');
    expect(T.perceiveStoreDiffSource(store)).toBe(store.output);
  });
});

// Fixed-output guards that use only exports which existed before #487, so they
// fail on the old behaviour itself, not on a missing helper.
describe('#487 fixed-output snapshots', () => {
  it('the printed -i tree is unchanged: same bytes, same refs', async () => {
    const { cdp } = createSmokePage();
    const refMap = new Map();
    const out = await perceive(cdp, { output: null }, T.parsePerceiveArgs(['-i', '-d', '8']), refMap);
    expect(out).toBe([
      'Page: smoke — http://127.0.0.1/smoke-page.html',
      'Viewport: 1252×799 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 2 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[heading] smoke',
      '[button] Smooth target  @1  (36,671 137×40)',
      '[button] No visible change  @2  (36,671 137×40)',
    ].join('\n'));
    expect([...refMap.entries()]).toEqual([[1, 30], [2, 70]]);
  });

  it('perceive -i --diff and the click receipt built from it say changed (old: "no changes" / no-change)', async () => {
    const { cdp, state } = createSmokePage();
    const store = { output: null };
    await perceive(cdp, store, T.parsePerceiveArgs(['-i', '-d', '8']));
    state.status = 'smooth:clicked';
    const diff = await perceive(cdp, store, T.parsePerceiveArgs(['-i', '-d', '8', '--diff']));
    expect(diff).toBe([
      'Page: smoke — http://127.0.0.1/smoke-page.html',
      'Viewport: 1252×799 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 2 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '~~~ Text nodes updated (1 removed, 1 added)',
      '+ [StaticText] smooth:clicked',
    ].join('\n'));

    const dispatchText = 'Clicked <BUTTON> "Smooth target" (@1)';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: TARGET_ID, ...clickTarget(), dispatchText },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(T.formatActionResultOutput(result, { dispatchText }))
      .toBe('Clicked <BUTTON> "Smooth target" (@1). Outcome: changed. Next: cdp perceive 48515122 --since-action');
  });

  it('bounds the diff-only -i text and marks the cut with a fixed note', () => {
    const nodes = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'long' } },
      { nodeId: 'b', parentId: 'root', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 9 },
    ];
    for (let i = 0; i < 2500; i++) {
      nodes.push({ nodeId: `t${i}`, parentId: 'root', role: { value: 'StaticText' }, name: { value: `row ${i}` } });
    }
    const built = T.buildPerceiveTree(nodes, { layoutMap: {} }, new Map(), { interactiveOnly: true });
    expect(built.treeLines.join('\n')).not.toContain('row 0');
    expect(built.hiddenTextLines).toHaveLength(2001);
    expect(built.hiddenTextLines[0]).toBe('[StaticText] row 0');
    expect(built.hiddenTextLines[1999]).toBe('[StaticText] row 1999');
    expect(built.hiddenTextLines[2000]).toMatch(/^ {2}\[note\] diff-only -i text capped at 2000 lines \/ 64K chars/);

    const wide = nodes.slice(0, 2).concat(Array.from({ length: 200 }, (_, i) => ({
      nodeId: `w${i}`, parentId: 'root', role: { value: 'StaticText' }, name: { value: `${i} ${'x'.repeat(1000)}` },
    })));
    const capped = T.buildPerceiveTree(wide, { layoutMap: {} }, new Map(), { interactiveOnly: true }).hiddenTextLines;
    expect(capped.length).toBeGreaterThan(1);
    expect(capped.slice(0, -1).join('\n').length).toBeLessThanOrEqual(64 * 1024);
    expect(capped.at(-1)).toMatch(/\[note\] diff-only -i text capped/);
    expect(T.buildPerceiveTree(nodes, { layoutMap: {} }, new Map(), {}).hiddenTextLines).toEqual([]);
  });
});
