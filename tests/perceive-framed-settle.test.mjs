import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #259 leftover framed perceive settle', () => {
  const TARGET_ID = '1D3669785EAC5A1A211792636BAE8A07';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pageTree({ inputValue = '', selectValue = 'a' } = {}) {
    return [
      'Page: Example Domain — https://example.com/',
      'Viewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 textbox, 1 combobox, 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example Domain',
      `  [textbox] playground = "${inputValue}"  @1`,
      `  [combobox] = "${selectValue}"  @2`,
      '  [button] picky15  @3',
    ].join('\n');
  }

  const frameDump = [
    'Page: Example Domain — https://example.com/',
    'Frame: @f2 p15ifr child-frame https://example.com/',
    'Viewport: 200×80 | Scroll: 0/0 (0%) | Focused: none',
    'Interactive: 1 button',
    'Console: clean',
    'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
    '',
    '[WebArea] iframe',
    '  [button] inner-btn  @f2:1',
    '',
    '(no changes detected in AX tree)',
  ].join('\n');

  it('#259 leftover perceive --frame dumps are not top-level action settle baselines', () => {
    expect(T.isFramedPerceiveOutput(frameDump)).toBe(true);
    expect(T.isFramedPerceiveOutput(pageTree())).toBe(false);

    const snapshotOpts = T.perceiveSnapshotOpts({ frameRef: '@f2' });
    const topLevelFill = { input: '#p15in', resolvedBy: 'selector', label: '#p15in' };
    const topLevelSelect = { input: '#p15sel', resolvedBy: 'selector', label: '#p15sel' };
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, frameDump, topLevelFill)).toBe(true);

    const settled = T.actionSettleBaseline(frameDump, snapshotOpts, topLevelFill);
    expect(settled.output).toBeNull();
    expect(settled.opts.frameRef).toBeNull();
    expect(settled.opts.cards).toBe(false);

    const observeOpts = T.actionSettleObserveOpts(TARGET_ID, topLevelFill, settled.output, settled.opts);
    expect(observeOpts.frameRef).toBeNull();
    expect(observeOpts.cards).toBe(false);
    expect(observeOpts.sinceAction).toBe(true);

    const selectSettled = T.actionSettleBaseline(frameDump, snapshotOpts, topLevelSelect);
    expect(selectSettled.output).toBeNull();
    expect(T.actionSettleObserveOpts(TARGET_ID, topLevelSelect, selectSettled.output, selectSettled.opts).frameRef)
      .toBeNull();

    const frameClick = { input: '@f2:1', resolvedBy: 'frame-ref', label: 'inner-btn' };
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, frameDump, frameClick)).toBe(false);
    const frameSettled = T.actionSettleBaseline(frameDump, snapshotOpts, frameClick);
    expect(frameSettled.output).toBe(frameDump);
    expect(frameSettled.opts.frameRef).toBe('@f2');
    expect(T.actionSettleObserveOpts(TARGET_ID, frameClick, frameSettled.output, frameSettled.opts).frameRef)
      .toBe('@f2');

    const before = pageTree({ inputValue: '', selectValue: 'a' });
    const afterFill = pageTree({ inputValue: 'p15full', selectValue: 'a' });
    const fillDiff = T.formatPerceiveDiffOutput(before, afterFill, { mode: 'since-action' });
    expect(fillDiff).not.toMatch(/Frame: @f2/);
    expect(fillDiff).not.toMatch(/Viewport: 200×80/);
    expect(T.actionDomDiffShowsChange(fillDiff)).toBe(true);

    const fillResult = T.applyActionObservationDelta(T.createActionResult({
      action: 'fill',
      target: {
        targetId: TARGET_ID,
        input: '#p15in',
        resolvedBy: 'selector',
        label: '#p15in',
        commandArgs: ['#p15in', 'p15full'],
      },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: fillDiff, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(fillResult.outcome.status).toBe('changed');
    expect(fillResult.verdict.status).toBe('continue');
    expect(fillResult.verdict.canContinue).toBe(true);
    expect(fillResult.nextSteps.join('\n')).not.toMatch(/overlay/);
    expect(T.formatActionText(fillResult)).not.toMatch(/Frame: @f2/);

    const afterSelect = pageTree({ inputValue: 'p15full', selectValue: 'b' });
    const selectDiff = T.formatPerceiveDiffOutput(afterFill, afterSelect, { mode: 'since-action' });
    expect(selectDiff).not.toMatch(/Frame: @f2/);
    const selectResult = T.applyActionObservationDelta(T.createActionResult({
      action: 'select',
      target: {
        targetId: TARGET_ID,
        input: '#p15sel',
        resolvedBy: 'selector',
        label: '#p15sel',
        commandArgs: ['#p15sel', 'b'],
      },
      dispatch: { ok: true, method: 'select' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: selectDiff, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(selectResult.outcome.status).toBe('changed');
    expect(selectResult.verdict.canContinue).toBe(true);
    expect(selectResult.nextSteps.join('\n')).not.toMatch(/overlay/);

    const cardsDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 1D366978 --cards';
    const cardsSettled = T.actionSettleBaseline(cardsDump, T.perceiveSnapshotOpts({ cards: true }));
    expect(cardsSettled.output).toBeNull();
    expect(cardsSettled.opts.cards).toBe(false);
    // #279: leftover 0-card cards is still not the settle dump, but settle must
    // recapture default AX so a later mutating click is not a no-change liar.
    expect(T.shouldCaptureTopLevelActionSettle(
      T.perceiveSnapshotOpts({ cards: true }),
      cardsDump,
      { input: 'Escape', resolvedBy: 'key', label: 'Escape' },
    )).toBe(true);
  });

  it('#259 perceive --frame still records a same-origin iframe dump for @fN:M settle', async () => {
    const store = { output: null, snapshotOpts: null };
    const refState = {};
    const cdp = {
      send(method, params = {}) {
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'main-frame', url: 'https://example.com/' },
              childFrames: [{
                frame: { id: 'child-frame', name: 'p15ifr', url: 'https://example.com/' },
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
                vw: 200,
                vh: 80,
                scrollY: 0,
                scrollMax: 0,
                counts: { button: 1 },
                focused: 'none',
                layoutMap: {},
                styleHints: {},
                cursorInteractives: [],
                visibleControls: [],
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          expect(params.frameId).toBe('child-frame');
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'iframe' }, childIds: ['2'] },
              { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'inner-btn' }, backendDOMNodeId: 222 },
            ],
          });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'btn' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { x: 8, y: 10, w: 40, h: 16, position: '' } } });
        }
        if (method === 'DOM.getFrameOwner') {
          return Promise.resolve({ backendNodeId: 333 });
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
      { frameRef: '@f2' },
      refState,
    );
    expect(out).toContain('Frame: @f2 p15ifr');
    expect(out).toContain('Viewport: 200×80');
    expect(out).toContain('@f2:1');
    expect(store.snapshotOpts.frameRef).toBe('@f2');
    expect(refState.frameLastOutputs.get('@f2')).toContain('[button] inner-btn');

    const topLevelFill = { input: '#p15in', resolvedBy: 'selector', label: '#p15in' };
    const leftover = T.actionSettleBaseline(store.output, store.snapshotOpts, topLevelFill);
    expect(leftover.output).toBeNull();
    expect(leftover.opts.frameRef).toBeNull();
    expect(T.actionSettleObserveOpts(TARGET_ID, topLevelFill, leftover.output, leftover.opts).frameRef).toBeNull();

    const frameClick = { input: '@f2:1', resolvedBy: 'frame-ref', label: 'inner-btn' };
    const frameSettled = T.actionSettleBaseline(
      T.baselineOutputForActionTarget(refState, store.output, frameClick),
      store.snapshotOpts,
      frameClick,
    );
    expect(frameSettled.output).toContain('Frame: @f2');
    expect(frameSettled.opts.frameRef).toBe('@f2');
  });
});
