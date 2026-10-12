import { describe, expect, it } from 'vitest';

import { runtimeSource } from './runtime-source.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #279 leftover 0-card cards settle for click --js', () => {
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
      counts: { button: 1 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'button',
        role: 'button',
        label: 'p21',
        clickable: true,
        rect: { x: 8, y: 80, w: 80, h: 24 },
        selector: 'button#p21btn',
        hints: { id: 'p21btn', classes: [] },
      }],
    });
  }

  function axNodes(clicks) {
    return [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example Domain' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Example Domain' } },
      { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'p21' }, backendDOMNodeId: 21 },
      { nodeId: '4', parentId: '1', role: { value: 'StaticText' }, name: { value: `clicks:${clicks}` } },
    ];
  }

  function createPicky21Page({ clicks = 6 } = {}) {
    const state = { clicks };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: 'https://example.com/' } } });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: pageMeta() } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({ nodes: axNodes(state.clicks) });
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          expect(params.selector).toBe('#p21btn');
          return Promise.resolve({ nodeId: 21 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'p21-btn' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: { tag: 'BUTTON', text: 'p21' } } });
          }
          return Promise.resolve({ result: { value: { connected: true, x: 8, y: 80, w: 80, h: 24 } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
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
      const topLevelOpts = T.actionObservationPerceiveOpts(TARGET_ID, {
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

  function clickJsTarget() {
    return {
      input: '#p21btn',
      resolvedBy: 'selector-or-ref',
      label: '#p21btn',
      commandArgs: ['--js', '#p21btn'],
    };
  }

  it('#279 leftover 0-card --role feed / --cards recaptures default AX so mutating click --js is Outcome: changed', async () => {
    expect(T.parsePerceiveArgs(['--role', 'feed']).cards).toBe(true);
    expect(T.parsePerceiveArgs(['--cards']).cards).toBe(true);

    const { cdp, state } = createPicky21Page({ clicks: 6 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    const cardsOpts = T.parsePerceiveArgs(['--role', 'feed']);
    const cardsDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { ...cardsOpts, targetPrefix: '62E1DF19' },
      refState,
    );
    expect(cardsDump).toContain('chrome-cdp-ex.cards.v1');
    expect(cardsDump).toMatch(/0 cards/);
    expect(store.snapshotOpts.cards).toBe(true);
    expect(T.isCardsPerceiveOutput(store.output)).toBe(true);

    const clickTarget = clickJsTarget();
    const discarded = T.actionSettleBaseline(store.output, store.snapshotOpts, clickTarget);
    expect(discarded.output).toBeNull();
    expect(discarded.opts.cards).toBe(false);
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, clickTarget)).toBe(true);

    const observeWithoutRecapture = T.actionSettleObserveOpts(
      TARGET_ID,
      clickTarget,
      discarded.output,
      discarded.opts,
    );
    expect(observeWithoutRecapture.cards).toBe(false);

    const liar = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: TARGET_ID, ...clickTarget },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: T.noBaselineActionDiffText(), console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(liar.outcome.status).toBe('no-change');
    expect(T.formatActionText(liar)).toMatch(/No visible AX tree change/);
    expect(liar.verdict.status).toBe('investigate');

    const settleBaseline = await recaptureSettleBaseline(cdp, store, clickTarget, refMap, refState);
    expect(settleBaseline.output).toBeTruthy();
    expect(settleBaseline.opts.cards).toBe(false);
    expect(settleBaseline.output).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    expect(state.clicks).toBe(6);

    const dispatchText = await T.jsClickStr(cdp, 'sid', '#p21btn', refMap, refState);
    expect(dispatchText).toMatch(/JS-clicked <BUTTON>/);
    expect(state.clicks).toBe(7);

    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(TARGET_ID, clickTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:7/);
    expect(after).not.toMatch(/no changes detected in AX tree/i);
    expect(after).not.toMatch(/chrome-cdp-ex\.cards\.v1/);

    const honest = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: TARGET_ID, ...clickTarget },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(honest.outcome.status).toBe('changed');
    expect(honest.verdict.status).toBe('continue');
    expect(honest.verdict.canContinue).toBe(true);
    const honestText = T.formatActionText(honest);
    expect(honestText).toMatch(/Outcome: changed/);
    expect(honestText).toMatch(/clicks:7/);
    expect(honestText).not.toMatch(/Outcome: no-change/);
    expect(honestText).not.toMatch(/No visible AX tree change/);
    expect(honest.nextSteps.join('\n')).not.toMatch(/overlay/);
  });

  it('#279 leftover-cards + Escape stays expected no-change after default-AX recapture', async () => {
    const { cdp, state } = createPicky21Page({ clicks: 6 });
    const store = { output: null, snapshotOpts: null, cards: null };
    await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      { ...T.parsePerceiveArgs(['--cards']), targetPrefix: '62E1DF19' },
      {},
    );
    expect(store.output).toMatch(/0 cards/);

    const escapeTarget = {
      input: 'Escape',
      resolvedBy: 'key',
      label: 'Escape',
      expectedOutcome: 'press-no-change',
    };
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, escapeTarget)).toBe(true);
    const settleBaseline = await recaptureSettleBaseline(cdp, store, escapeTarget);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    expect(state.clicks).toBe(6);

    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      store,
      T.actionSettleObserveOpts(TARGET_ID, escapeTarget, settleBaseline.output, settleBaseline.opts),
      {},
    );
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);

    const pressAfterCards = T.applyActionObservationDelta(T.createActionResult({
      action: 'press',
      target: { targetId: TARGET_ID, ...escapeTarget },
      dispatch: { ok: true, method: 'press' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(pressAfterCards.outcome.status).toBe('no-change');
    expect(pressAfterCards.effects.diagnosis?.kind).not.toBe('dom-changed');
    const pressText = T.formatActionText(pressAfterCards);
    expect(pressText).toMatch(/Outcome: no-change/);
    expect(pressText).not.toMatch(/Outcome: changed/);
    expect(pressText).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(pressAfterCards.nextSteps.join('\n')).not.toMatch(/perceive .*--cards/);
  });

  it('#279 default-AX perceive then the same click --js stays Outcome: changed', async () => {
    const { cdp, state } = createPicky21Page({ clicks: 7 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const before = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { targetPrefix: '62E1DF19' },
      {},
    );
    expect(before).toContain('[StaticText] clicks:7');
    expect(store.snapshotOpts.cards).toBe(false);

    const clickTarget = clickJsTarget();
    const settled = T.actionSettleBaseline(store.output, store.snapshotOpts, clickTarget);
    expect(settled.output).toBe(before);
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, clickTarget)).toBe(false);

    await T.jsClickStr(cdp, 'sid', '#p21btn', refMap, {});
    expect(state.clicks).toBe(8);
    const after = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(TARGET_ID, clickTarget, settled.output, settled.opts),
      {},
    );
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:8/);

    const honest = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: TARGET_ID, ...clickTarget },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(honest.outcome.status).toBe('changed');
    expect(T.formatActionText(honest)).toMatch(/clicks:8/);
    expect(T.formatActionText(honest)).not.toMatch(/No visible AX tree change/);
  });

  it('#279 actionFeedback recapture gate is leftover cards as well as leftover frames', () => {
    const src = runtimeSource();
    expect(src).toMatch(/!settleBaseline\.output\s*\n\s*&& shouldCaptureTopLevelActionSettle\(/);
    expect(src).toMatch(
      /function shouldCaptureTopLevelActionSettle[\s\S]{0,1200}snapshotOpts\?\.cards === true \|\| isCardsPerceiveOutput\(output\)/,
    );
  });
});

describe('issue #293 leftover feed --cards scroll settle', () => {
  const X_TARGET_ID = '2E94F948ABCDEF0123456789ABCDEF01';
  const X_PREFIX = '2E94F948';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  const DEFAULT_POSTS = [
    { text: 'first tweet body', backend: 201, handle: '@SY239434', statusId: '1001' },
    { text: 'second tweet body', backend: 202, handle: '@SY239434', statusId: '1002' },
  ];
  const ADDED_THIRD_POSTS = [
    ...DEFAULT_POSTS,
    { text: 'third tweet body', backend: 203, handle: '@SY239434', statusId: '1003' },
  ];

  function xMeta({ scrollY = 0, articleCount = 2 } = {}) {
    return JSON.stringify({
      title: 'SY239434 (@SY239434) / X',
      url: 'https://x.com/SY239434',
      contentType: 'text/html',
      vw: 1042,
      vh: 900,
      scrollY,
      scrollMax: 4000,
      counts: { article: articleCount, button: 8 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'button',
        role: 'button',
        label: 'p25',
        clickable: true,
        rect: { x: 8, y: 80, w: 80, h: 24 },
        selector: 'button#p25btn',
        hints: { id: 'p25btn', classes: [] },
      }],
    });
  }

  function xAx({ age = '2m', clicks = 0, ageInArticleName = false, posts = DEFAULT_POSTS } = {}) {
    const articleNodes = [];
    const feedChildIds = [];
    for (const [index, post] of posts.entries()) {
      const articleId = String(20 + index);
      const handleId = `${articleId}1`;
      const timeId = `${articleId}2`;
      const permalinkId = `${articleId}3`;
      feedChildIds.push(articleId);
      const name = ageInArticleName ? `${post.text} · ${age}` : post.text;
      const timeName = ageInArticleName ? 'likes' : age;
      articleNodes.push(
        {
          nodeId: articleId,
          parentId: '10',
          role: { value: 'article' },
          name: { value: name },
          backendDOMNodeId: post.backend,
          childIds: [handleId, permalinkId, timeId],
        },
        { nodeId: handleId, parentId: articleId, role: { value: 'link' }, name: { value: post.handle } },
        {
          nodeId: permalinkId,
          parentId: articleId,
          role: { value: 'link' },
          name: { value: 'Show this post' },
          properties: [{ name: 'url', value: { value: `https://x.com/SY239434/status/${post.statusId}` } }],
        },
        { nodeId: timeId, parentId: articleId, role: { value: 'StaticText' }, name: { value: timeName } },
      );
    }
    return [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'SY239434' }, childIds: ['10', '4', '5'] },
      { nodeId: '10', parentId: '1', role: { value: 'feed' }, name: { value: 'Timeline' }, childIds: feedChildIds },
      ...articleNodes,
      { nodeId: '4', parentId: '1', role: { value: 'button' }, name: { value: 'p25' }, backendDOMNodeId: 25 },
      { nodeId: '5', parentId: '1', role: { value: 'StaticText' }, name: { value: `clicks:${clicks}` } },
    ];
  }

  function createXPage({
    age = '2m',
    scrollY = 0,
    clicks = 0,
    ageInArticleName = false,
    posts = DEFAULT_POSTS,
  } = {}) {
    const state = {
      age,
      scrollY,
      clicks,
      ageInArticleName,
      posts: posts.map(post => ({ ...post })),
    };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: 'https://x.com/SY239434' } } });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('scrollBy')) {
            state.scrollY += 80;
            return Promise.resolve({ result: { value: JSON.stringify({ x: 0, y: state.scrollY }) } });
          }
          if (expr.includes("resolve('stable')") || expr.includes('MutationObserver')) {
            return Promise.resolve({ result: { value: 'stable' } });
          }
          if (expr.includes('#p25btn') && expr.includes('click')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: JSON.stringify({ tag: 'BUTTON', text: 'p25' }) } });
          }
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: { value: xMeta({ scrollY: state.scrollY, articleCount: state.posts.length }) },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({
            nodes: xAx({
              age: state.age,
              clicks: state.clicks,
              ageInArticleName: state.ageInArticleName,
              posts: state.posts,
            }),
          });
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          return Promise.resolve({ nodeId: 2 });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'x-node' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: { tag: 'BUTTON', text: 'p25' } } });
          }
          return Promise.resolve({ result: { value: { x: 8, y: 80, w: 400, h: 120, position: '', tag: 'BUTTON', text: 'p25' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  function scrollTarget() {
    return {
      input: 'down 80',
      resolvedBy: 'scroll',
      label: 'down',
      commandArgs: ['down', '80'],
      expectedOutcome: 'cards-window-no-change',
    };
  }

  function clickJsTarget() {
    return {
      input: '#p25btn',
      resolvedBy: 'selector-or-ref',
      label: '#p25btn',
      commandArgs: ['--js', '#p25btn'],
    };
  }

  async function leftoverCards(cdp, store, refMap, refState, args = ['--cards']) {
    const dump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { ...T.parsePerceiveArgs(args), targetPrefix: X_PREFIX },
      refState,
    );
    expect(dump).toContain('chrome-cdp-ex.cards.v1');
    expect(dump).toMatch(/2 cards/);
    expect(store.snapshotOpts.cards).toBe(true);
    expect(T.leftoverCardsCount(dump)).toBe(2);
    expect(T.isLeftoverFeedCardsSettle(dump, store.snapshotOpts, scrollTarget())).toBe(true);
    return dump;
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
      const topLevelOpts = T.actionObservationPerceiveOpts(X_TARGET_ID, {
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
      return T.noBaselineActionDiffText();
    }
    return T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      T.actionSettleObserveOpts(X_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  it('#293 leftover feed --cards is a scroll settle shape, not a full AX recapture', () => {
    const cardsDump = [
      'chrome-cdp-ex.cards.v1  2 cards  virtualized',
      '@1  @SY239434  first tweet body',
      '@2  @SY239434  second tweet body',
      'next: timeline virtualized; scroll and re-run --cards',
    ].join('\n');
    const snapshotOpts = T.perceiveSnapshotOpts({ cards: true });
    const scroll = scrollTarget();
    expect(T.isCardsPerceiveOutput(cardsDump)).toBe(true);
    expect(T.leftoverCardsCount(cardsDump)).toBe(2);
    expect(T.isScrollActionTarget(scroll)).toBe(true);
    expect(T.isLeftoverFeedCardsSettle(cardsDump, snapshotOpts, scroll)).toBe(true);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, cardsDump, scroll)).toBe(false);

    const settled = T.actionSettleBaseline(cardsDump, snapshotOpts, scroll);
    expect(settled.output).toBe(cardsDump);
    expect(settled.opts.cards).toBe(true);
    expect(T.actionSettleObserveOpts(X_TARGET_ID, scroll, settled.output, settled.opts).cards).toBe(true);

    const zeroDump = 'chrome-cdp-ex.cards.v1  0 cards\nnext: cdp perceive 2E94F948 --cards';
    expect(T.isLeftoverFeedCardsSettle(zeroDump, snapshotOpts, scroll)).toBe(false);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, zeroDump, scroll)).toBe(true);
    expect(T.actionSettleBaseline(zeroDump, snapshotOpts, scroll).output).toBeNull();

    const click = clickJsTarget();
    expect(T.isLeftoverFeedCardsSettle(cardsDump, snapshotOpts, click)).toBe(false);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, cardsDump, click)).toBe(true);
    expect(T.actionSettleBaseline(cardsDump, snapshotOpts, click).output).toBeNull();
    expect(T.actionObservationPerceiveOpts(X_TARGET_ID, { cards: true }).cards).toBe(false);
  });

  it('#293 leftover feed --cards then scroll is no-change / continue, Next --cards, not AX timestamp chrome', async () => {
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    const axBeforeLeftover = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;

    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toContain('chrome-cdp-ex.cards.v1');
    expect(settleBaseline.opts.cards).toBe(true);
    expect(settleBaseline.output).not.toMatch(/\[StaticText\]/);
    const axAfterRecaptureGate = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    expect(axAfterRecaptureGate).toBe(axBeforeLeftover);

    state.age = '3m';
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(state.scrollY).toBe(80);

    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toContain('chrome-cdp-ex.cards.v1');
    expect(after).toMatch(/unchanged; still first cards/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/\[StaticText\] 3m/);
    expect(after).not.toMatch(/Outcome: changed/);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: X_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).toMatch(/Next: cdp perceive 2E94F948 --cards/);
    expect(text).not.toMatch(/cdp perceive 2E94F948 -C -d 8/);
    expect(text).not.toMatch(/cdp report 2E94F948 --format json/);
    expect(receipt).toMatch(/^Scrolled by \(0, 80\)\. Position: \(0, 80\)\. Next: /);
    expect(receipt).not.toMatch(/\[RootWebArea\]/);
    expect(receipt).not.toMatch(/Text nodes updated/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(after).not.toMatch(/^Page: /m);
  });

  it('#293 leftover --role feed with cards then scroll keeps the cards window', async () => {
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    await leftoverCards(cdp, store, refMap, refState, ['--role', 'feed']);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(true);
    state.age = '3m';
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).toMatch(/unchanged; still first cards/i);
  });

  it('#293 leftover feed --cards then scroll that adds a third article is Outcome: changed', async () => {
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    const actionTarget = scrollTarget();
    expect(actionTarget.expectedOutcome).toBe('cards-window-no-change');
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(true);

    // Leftover window is 2 cards. Scroll adds a third article identity.
    // expectedOutcome is set pre-scroll and must not hide that mutation.
    state.posts = ADDED_THIRD_POSTS.map(post => ({ ...post }));
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toContain('chrome-cdp-ex.cards.v1');
    expect(after).toMatch(/chrome-cdp-ex\.cards\.v1\s+3 cards/);
    expect(after).toMatch(/third tweet body/);
    expect(after).not.toMatch(/unchanged; still first cards/i);
    expect(after).not.toMatch(/\[RootWebArea\]/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(T.isExpectedNoChange(actionTarget, after, 'scroll')).toBe(true);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: X_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: changed/);
    expect(text).not.toMatch(/Outcome: no-change/);
    expect(receipt).toMatch(/^Scrolled by \(0, 80\)\. Position: \(0, 80\)\. Next: /);
    expect(receipt).not.toMatch(/third tweet body/);
    expect(receipt).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(receipt).not.toMatch(/^Outcome:/m);
  });

  it('#293 leftover feed --cards then scroll ignores relative time in article AX name (2m→3m)', async () => {
    // Contract: extractText/cardIdentity use article AX `name`, not child
    // StaticText. Clock chrome lives in the name (`first tweet body · 2m`).
    // Child StaticText is `likes`, not the time. If this helper were
    // Outcome: changed, leftover cards.v1 would still treat timestamp-in-name
    // as a feed mutation on live X unless 9224 `perceive --cards` lines omit
    // the relative time. no-change here is required: identity strips `· 2m`.
    const { cdp, state } = createXPage({ age: '2m', scrollY: 0, ageInArticleName: true });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    expect(leftoverDump).toMatch(/first tweet body · 2m/);
    expect(leftoverDump).not.toMatch(/\blikes\b/);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(true);

    state.age = '3m';
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toContain('chrome-cdp-ex.cards.v1');
    expect(after).toMatch(/first tweet body · 3m/);
    expect(after).toMatch(/unchanged; still first cards/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: X_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).toMatch(/Next: cdp perceive 2E94F948 --cards/);
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
  });

  it('#293 leftover feed --cards then click --js still recaptures default AX (#279 hold)', async () => {
    const { cdp, state } = createXPage({ age: '2m', clicks: 6 });
    const store = { output: null, snapshotOpts: null, cards: null };
    const refMap = new Map();
    const refState = {};
    await leftoverCards(cdp, store, refMap, refState, ['--cards']);
    const actionTarget = clickJsTarget();
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, store.output, actionTarget)).toBe(true);
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.opts.cards).toBe(false);
    expect(settleBaseline.output).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    expect(T.actionSettleObserveOpts(X_TARGET_ID, actionTarget, settleBaseline.output, settleBaseline.opts).cards)
      .toBe(false);

    const dispatchText = await T.jsClickStr(cdp, 'sid', '#p25btn', refMap, refState);
    expect(dispatchText).toMatch(/JS-clicked <BUTTON>/);
    expect(state.clicks).toBe(7);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:7/);
    expect(after).not.toMatch(/chrome-cdp-ex\.cards\.v1/);
  });
});
