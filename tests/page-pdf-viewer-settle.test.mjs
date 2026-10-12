import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #282 leftover pdf-viewer.v1 press settle', () => {
  const PDF_TARGET_ID = 'CFD023D2E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = 'CFD023D2';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pdfViewerCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  title: PDF_PAGE.title,
                  url: PDF_PAGE.url,
                  contentType: PDF_PAGE.contentType,
                  vw: 1042,
                  vh: 632,
                  scrollY: 0,
                  scrollMax: 0,
                  counts: {},
                  focused: 'none',
                  layoutMap: {},
                  styleHints: {},
                  cursorInteractives: [],
                  visibleControls: [],
                }),
              },
            });
          }
          if (expr.includes('innerWidth')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          if (expr.includes('chrome-cdp-ex.press-probe.v1')) {
            const installing = expr.includes("addEventListener('keydown'");
            return Promise.resolve({
              result: {
                value: {
                  marker: 'chrome-cdp-ex.press-probe.v1',
                  ok: true,
                  installed: true,
                  matched: !installing,
                  count: installing ? 0 : 1,
                },
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [] });
        }
        if (method === 'Input.dispatchKeyEvent') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap = new Map(), refState = {}) {
    const baselineFromTarget = T.baselineOutputForActionTarget(refState, store.output, actionTarget);
    let settleBaseline = T.actionSettleBaseline(
      baselineFromTarget,
      store.snapshotOpts || null,
      actionTarget,
    );
    if (
      !settleBaseline.output
      && T.shouldCaptureTopLevelActionSettle(
        store.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = T.actionObservationPerceiveOpts(PDF_TARGET_ID, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: T.perceiveSnapshotOpts(topLevelOpts),
      };
    }
    return settleBaseline;
  }

  async function observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap = new Map(), refState = {}) {
    if (!settleBaseline.output) {
      const after = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        T.actionObservationPerceiveOpts(PDF_TARGET_ID),
        refState,
      );
      if (String(after || '').includes('chrome-cdp-ex.pdf-viewer.v1')) {
        return typeof T.pdfViewerSettleDiffText === 'function'
          ? T.pdfViewerSettleDiffText()
          : T.noBaselineActionDiffText();
      }
      return T.noBaselineActionDiffText();
    }
    return T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(PDF_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  async function leftoverPdfPressReceipt({ leftover = true, key = 'Escape' } = {}) {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    let leftoverDump = null;
    if (leftover) {
      leftoverDump = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        { targetPrefix: PDF_PREFIX },
        refState,
      );
      expect(leftoverDump).toContain('chrome-cdp-ex.pdf-viewer.v1');
      expect(leftoverDump).toContain('Accessibility tree is empty');
    }
    const actionTarget = {
      input: key,
      resolvedBy: 'key',
      label: key,
      expectedOutcome: 'press-no-change',
    };
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    const dispatchText = await T.pressStr(cdp, 'sid', key);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: { targetId: PDF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    return { cdp, store, leftoverDump, settleBaseline, dispatchText, after, result, text, receipt };
  }

  function expectHonestNoChangePress(got, { key } = {}) {
    expect(got.dispatchText).toBe(`Pressed ${key === 'Escape' ? 'Escape' : key}`);
    expect(got.result.outcome.status).toBe('no-change');
    expect(got.result.verdict.status).toBe('continue');
    expect(got.result.effects.diagnosis?.kind).not.toBe('dom-changed');
    expect(got.text).toMatch(/Outcome: no-change/);
    expect(got.text).not.toMatch(/Outcome: changed/);
    expect(got.text).not.toMatch(/Observed page change after action/);
    expect(got.receipt).not.toMatch(/Observed page change after action/);
    expect(got.after).toMatch(/no changes detected/i);
    expect(got.after).not.toMatch(/Accessibility tree is empty for this viewer/);
    expect(got.after).not.toMatch(/PDF viewer: Chrome is rendering a PDF plugin/);
  }

  it('#282 leftover pdf-viewer.v1 is not a valid AX settle shape', async () => {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const dump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { targetPrefix: PDF_PREFIX },
      {},
    );
    expect(dump).toContain('chrome-cdp-ex.pdf-viewer.v1');
    if (typeof T.isPdfViewerPerceiveOutput === 'function') {
      expect(T.isPdfViewerPerceiveOutput(dump)).toBe(true);
    }
    expect(T.actionDomDiffShowsChange(dump)).toBe(false);

    const escapeTarget = {
      input: 'Escape',
      resolvedBy: 'key',
      label: 'Escape',
      expectedOutcome: 'press-no-change',
    };
    const settled = T.actionSettleBaseline(dump, store.snapshotOpts, escapeTarget);
    expect(settled.output).toBeNull();
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, dump, escapeTarget)).toBe(false);

    const cardsDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 62E1DF19 --cards';
    expect(T.shouldCaptureTopLevelActionSettle(
      T.perceiveSnapshotOpts({ cards: true }),
      cardsDump,
      escapeTarget,
    )).toBe(true);
    expect(T.actionSettleBaseline(cardsDump, T.perceiveSnapshotOpts({ cards: true }), escapeTarget).output).toBeNull();
  });

  it('#282 leftover pdf-viewer.v1 then press Escape is expected no-change / continue', async () => {
    const got = await leftoverPdfPressReceipt({ leftover: true, key: 'Escape' });
    expect(got.settleBaseline.output).toBeNull();
    expectHonestNoChangePress(got, { key: 'Escape', leftover: true });
    expect(got.receipt).toMatch(/Pressed Escape/);
  });

  it('#282 leftover pdf-viewer.v1 then press ArrowRight with unchanged URL/type/empty AX is no-change', async () => {
    const got = await leftoverPdfPressReceipt({ leftover: true, key: 'ArrowRight' });
    expect(got.settleBaseline.output).toBeNull();
    expectHonestNoChangePress(got, { key: 'ArrowRight', leftover: true });
    expect(got.receipt).not.toMatch(/PDF viewer: Chrome is rendering a PDF plugin/);
  });

  it('#282 press ArrowRight with no leftover pdf-viewer dump stays honest no-change', async () => {
    const got = await leftoverPdfPressReceipt({ leftover: false, key: 'ArrowRight' });
    expect(
      got.store.output == null
      || String(got.store.output).includes('chrome-cdp-ex.pdf-viewer.v1'),
    ).toBe(true);
    expectHonestNoChangePress(got, { key: 'ArrowRight', leftover: false });
    expect(got.text).not.toMatch(/Observed page change after action/);
  });

  it('#282 leftover pdf-viewer since-action perceive does not treat stub vs stub as a page change', async () => {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { targetPrefix: PDF_PREFIX },
      {},
    );
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      {
        targetPrefix: PDF_PREFIX,
        sinceAction: true,
        diffBaseline: before,
      },
      {},
    );
    expect(after).toMatch(/no changes detected/i);
    expect(after).toMatch(/pdf-viewer\.v1/);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/Accessibility tree is empty for this viewer/);
    if (typeof T.pdfViewerSettleDiffText === 'function') {
      expect(after).toBe(T.pdfViewerSettleDiffText());
    }
  });
});

describe('issue #285 leftover pdf-viewer.v1 click --js / scroll Next', () => {
  const PDF_TARGET_ID = 'CFD023D2E2DA7ED50C67BE2092417850';
  const PDF_PREFIX = 'CFD023D2';
  const PDF_PAGE = {
    title: '',
    url: 'https://arxiv.org/pdf/2608.12307',
    contentType: 'application/pdf',
  };
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  function pdfViewerCdp() {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('scrollBy')) {
            return Promise.resolve({ result: { value: '{"x":0,"y":0}' } });
          }
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: {
                value: JSON.stringify({
                  title: PDF_PAGE.title,
                  url: PDF_PAGE.url,
                  contentType: PDF_PAGE.contentType,
                  vw: 1042,
                  vh: 632,
                  scrollY: 0,
                  scrollMax: 0,
                  counts: {},
                  focused: 'none',
                  layoutMap: {},
                  styleHints: {},
                  cursorInteractives: [],
                  visibleControls: [],
                }),
              },
            });
          }
          if (expr.includes('innerWidth')) {
            return Promise.resolve({ result: { value: JSON.stringify({ w: 1042, h: 632 }) } });
          }
          if (expr.includes('chrome-cdp-ex.press-probe.v1')) {
            const installing = expr.includes("addEventListener('keydown'");
            return Promise.resolve({
              result: {
                value: {
                  marker: 'chrome-cdp-ex.press-probe.v1',
                  ok: true,
                  installed: true,
                  matched: !installing,
                  count: installing ? 0 : 1,
                },
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: [] });
        }
        if (method === 'Input.dispatchKeyEvent' || method === 'Input.dispatchMouseEvent') {
          return Promise.resolve({});
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          return Promise.resolve({ nodeId: 2 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'pdf-body' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { tag: 'BODY', text: '' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap = new Map(), refState = {}) {
    const baselineFromTarget = T.baselineOutputForActionTarget(refState, store.output, actionTarget);
    let settleBaseline = T.actionSettleBaseline(
      baselineFromTarget,
      store.snapshotOpts || null,
      actionTarget,
    );
    if (
      !settleBaseline.output
      && T.shouldCaptureTopLevelActionSettle(
        store.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = T.actionObservationPerceiveOpts(PDF_TARGET_ID, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: T.perceiveSnapshotOpts(topLevelOpts),
      };
    }
    return settleBaseline;
  }

  async function observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap = new Map(), refState = {}) {
    if (!settleBaseline.output) {
      const after = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        T.actionObservationPerceiveOpts(PDF_TARGET_ID),
        refState,
      );
      if (String(after || '').includes('chrome-cdp-ex.pdf-viewer.v1')) {
        return typeof T.pdfViewerSettleDiffText === 'function'
          ? T.pdfViewerSettleDiffText()
          : T.noBaselineActionDiffText();
      }
      return T.noBaselineActionDiffText();
    }
    return T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(PDF_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  function expectPdfViewerContinue(got, { nextMustNotInclude } = {}) {
    expect(got.settleBaseline.output).toBeNull();
    expect(got.result.outcome.status).toBe('no-change');
    expect(got.result.verdict.status).toBe('continue');
    expect(got.text).toMatch(/Outcome: no-change/);
    expect(got.text).not.toMatch(/Outcome: changed/);
    expect(got.text).toMatch(/Verdict: continue/);
    expect(got.text).not.toMatch(/Verdict: investigate/);
    expect(got.text).toMatch(/Next: cdp eval CFD023D2 "document.contentType"/);
    expect(got.text).not.toMatch(/cdp overlay /);
    expect(got.text).not.toMatch(/cdp perceive CFD023D2 -C/);
    expect(got.result.recommendation?.commands?.[0]).toBe('cdp eval CFD023D2 "document.contentType"');
    for (const banned of nextMustNotInclude || []) {
      expect(got.text).not.toMatch(banned);
    }
  }

  async function leftoverPdfMutatorReceipt({ leftover = true, kind } = {}) {
    const cdp = pdfViewerCdp();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    if (leftover) {
      const leftoverDump = await T.perceiveStr(
        cdp,
        'sid',
        new T.RingBuffer(8),
        new T.RingBuffer(8),
        refMap,
        store,
        { targetPrefix: PDF_PREFIX },
        refState,
      );
      expect(leftoverDump).toContain('chrome-cdp-ex.pdf-viewer.v1');
    }
    const actionTarget = kind === 'scroll'
      ? {
        input: 'down',
        resolvedBy: 'scroll',
        label: 'down',
        page: { ...PDF_PAGE },
      }
      : kind === 'press'
        ? {
          input: 'Escape',
          resolvedBy: 'key',
          label: 'Escape',
          expectedOutcome: 'press-no-change',
          page: { ...PDF_PAGE },
        }
        : {
          input: 'body',
          resolvedBy: 'selector-or-ref',
          label: 'body',
          commandArgs: ['--js', 'body'],
          page: { ...PDF_PAGE },
        };
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    let dispatchText;
    let action;
    if (kind === 'scroll') {
      action = 'scroll';
      dispatchText = await T.scrollStr(cdp, 'sid', 'down', '100');
    } else if (kind === 'press') {
      action = 'press';
      dispatchText = await T.pressStr(cdp, 'sid', 'Escape');
    } else {
      action = 'click';
      dispatchText = await T.jsClickStr(cdp, 'sid', 'body', refMap, refState);
    }
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action,
      target: { targetId: PDF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: action },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    return { cdp, store, settleBaseline, dispatchText, after, result, text, receipt };
  }

  it('#285 leftover pdf-viewer.v1 then click --js body is no-change / continue, Next eval not overlay', async () => {
    const got = await leftoverPdfMutatorReceipt({ leftover: true, kind: 'click-js' });
    expect(got.dispatchText).toMatch(/JS-clicked <BODY>/);
    expect(got.after).toMatch(/no changes detected/i);
    expectPdfViewerContinue(got, { nextMustNotInclude: [/cdp overlay CFD023D2 body/] });
  });

  it('#285 leftover pdf-viewer.v1 then scroll down at (0,0) is no-change / continue, Next eval not perceive', async () => {
    const got = await leftoverPdfMutatorReceipt({ leftover: true, kind: 'scroll' });
    expect(got.dispatchText).toBe('Scrolled by (0, 100). Position: (0, 0)');
    expect(got.after).toMatch(/no changes detected/i);
    expectPdfViewerContinue(got, { nextMustNotInclude: [/cdp perceive CFD023D2 -C -d 8/] });
  });

  it('#285 leftover pdf-viewer.v1 then press Escape still no-change / continue (#282 hold)', async () => {
    const got = await leftoverPdfMutatorReceipt({ leftover: true, kind: 'press' });
    expect(got.dispatchText).toBe('Pressed Escape');
    expect(got.result.outcome.status).toBe('no-change');
    expect(got.result.verdict.status).toBe('continue');
    expect(got.text).not.toMatch(/Outcome: changed/);
    expect(got.after).toMatch(/no changes detected/i);
    expect(got.after).toMatch(/pdf-viewer\.v1/);
  });
});
