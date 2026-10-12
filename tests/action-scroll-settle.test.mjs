import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #295 leftover golden-path AX scroll rect chrome', () => {
  const HF_TARGET_ID = '561F7DA8ABCDEF0123456789ABCDEF01';
  const HF_PREFIX = '561F7DA8';
  const HF_URL = 'https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main';
  const COMFY_TARGET_ID = '0D34570AABCDEF0123456789ABCDEF01';
  const COMFY_PREFIX = '0D34570A';
  const COMFY_URL = 'https://docs.comfy.org/tutorials/audio/minimax/minimax-music-3';
  const emptyDelta = {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: { count: 0, failures: 0, pending: 0, entries: [] },
  };

  const DEFAULT_FILES = [
    { name: 'LICENSE', backend: 301, y: 180 },
    { name: 'README.md', backend: 302, y: 208 },
    { name: 'config.json', backend: 303, y: 236 },
  ];
  const ADDED_FILE = { name: 'tokenizer.json', backend: 304, y: 264 };

  const CAP_SWAP_CHROME = [
    'Hugging Face', 'Models', 'Datasets', 'Spaces', 'Posts', 'search', 'docs', 'pricing',
  ];
  const CAP_SWAP_CONTENT = [
    'MiniMaxAI', 'MiniMax-Music3', 'Copy', 'Like', 'LICENSE', 'README.md', 'config.json', 'Files',
  ];
  const TIMESTAMP_CAP_SWAP_CHROME = [
    'ryanlee-dev', 'Update README.md', 'fbdf52f', 'assets',
  ];
  const TIMESTAMP_CAP_SWAP_CONTENT = [
    'condition_encoder',
    'Add diffusers weights (modular pipeline) (#2)',
    'config.json',
  ];
  const SHARED_COMMIT_TITLE = 'Add diffusers weights (modular pipeline) (#2)';
  const LIVE_INTERACTIVE = 'Interactive: 113 a, 1 input[text], 21 button, 9 div, 2 input[search], 1 iframe';
  const LIVE_COORDS = 'Coords: viewport CSS px (clickxy-ready; fixed/sticky tagged)';
  const LIVE_CENSUS_COUNTS = {
    a: 113,
    'input[text]': 1,
    button: 21,
    div: 9,
    'input[search]': 2,
    iframe: 1,
  };

  function hfVisibleControl(label, y, selector = null) {
    return {
      tag: 'a',
      role: 'link',
      label,
      clickable: true,
      rect: { x: 24, y, w: 160, h: 22 },
      selector: selector || `a[href="#${label.replace(/\s+/g, '-')}"]`,
      hints: { id: '', classes: [] },
    };
  }

  function hfUnlabeledControl(tag, y, selector) {
    // Live collector: ariaLabel || title || text || role || tagName.
    const role = tag === 'a' ? 'link' : '';
    return {
      tag,
      role,
      label: role || tag,
      clickable: true,
      rect: { x: 8, y, w: 24, h: 24 },
      selector,
      hints: { id: '', classes: [] },
    };
  }

  function noisyCapSwapChrome() {
    return [
      hfUnlabeledControl('img', 12, 'img.logo'),
      hfUnlabeledControl('div', 40, 'div.nav-icon'),
      hfUnlabeledControl('a', 68, 'a[href="/"]'),
      ...CAP_SWAP_CHROME.map((label, i) => hfVisibleControl(label, 100 + i * 28)),
    ];
  }

  function noisyCapSwapContent() {
    return [
      hfUnlabeledControl('img', 12, 'img.hero'),
      hfUnlabeledControl('div', 40, 'div.body-icon'),
      hfUnlabeledControl('a', 68, 'a[href="/model"]'),
      ...CAP_SWAP_CONTENT.map((label, i) => hfVisibleControl(label, 100 + i * 28)),
    ];
  }

  function hfTitleChromeControls() {
    // Live leftover-ax-scroll Added lines after overlay f16bf750. Collector
    // includes [title] even when not clickable; formatVisibleControlLine
    // reprints title= selector + CSS classes.
    return [
      {
        tag: 'span',
        label: 'This commit is signed and the signature is verified',
        title: 'This commit is signed and the signature is verified',
        clickable: false,
        rect: { x: 400, y: 120, w: 18, h: 18 },
        selector: 'span[title="This commit is signed and the signature is verified"]',
        hints: { classes: ['mx-2', 'text-green-500', 'dark:text-green-600'] },
      },
      {
        tag: 'time',
        label: 'Fri, 14 Aug 2026 10:51:40 GMT',
        title: 'Fri, 14 Aug 2026 10:51:40 GMT',
        clickable: false,
        rect: { x: 800, y: 120, w: 40, h: 16 },
        selector: 'time[title="Fri, 14 Aug 2026 10:51:40 GMT"]',
        hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
      },
    ];
  }

  function hfTimestampChromeControls() {
    // Live leftover-ax-scroll named samples after overlay 3577e604. HF file-row
    // `<a>…<time title="Thu, 13 Aug 2026 15:18:27 GMT">2 days ago</time></a>`:
    // collector label for <a> is inner text; <time> label is title (title wins).
    return [
      {
        tag: 'a',
        role: 'link',
        label: '2 days ago',
        clickable: true,
        rect: { x: 720, y: 184, w: 72, h: 16 },
        selector: 'a.truncate',
        hints: { classes: ['truncate'] },
      },
      {
        tag: 'time',
        label: 'Thu, 13 Aug 2026 15:18:27 GMT',
        title: 'Thu, 13 Aug 2026 15:18:27 GMT',
        clickable: true,
        rect: { x: 800, y: 184, w: 72, h: 16 },
        selector: 'time[title="Thu, 13 Aug 2026 15:18:27 GMT"]',
        hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
      },
    ];
  }

  function sharedCommitCapSwapChrome() {
    // Live leftover-ax-scroll named samples after overlay f9fa4971. Each HF
    // file row reprints the same commit title with a distinct href, so the
    // name is both left and entered membership.
    return [
      hfVisibleControl('condition_encoder', 100),
      hfVisibleControl(SHARED_COMMIT_TITLE, 128, 'a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]'),
      hfVisibleControl('figures', 156),
      hfVisibleControl('tokenizer.json', 184),
    ];
  }

  function sharedCommitCapSwapContent() {
    return [
      hfVisibleControl('language_model', 100),
      hfVisibleControl(SHARED_COMMIT_TITLE, 128, 'a[href="/MiniMaxAI/MiniMax-Music3/commit/entered"]'),
      hfVisibleControl('qwen_7B', 156),
      hfVisibleControl('speech_tokenizer', 184),
    ];
  }

  function liveCensusCapSwapChrome() {
    // Live leftover-ax-scroll after overlay cd661234: 4 left / 5 entered.
    // Named samples are language_model + shared commit left; qwen_7B /
    // upload-large-folder / rvq_depth_decoder entered. Unlabeled img/div
    // vs link/button fill the "... and 2 more" membership.
    return [
      hfVisibleControl('language_model', 100),
      hfVisibleControl(SHARED_COMMIT_TITLE, 128, 'a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]'),
      hfUnlabeledControl('img', 156, 'img.logo'),
      hfUnlabeledControl('div', 184, 'div.nav-icon'),
    ];
  }

  function liveCensusCapSwapContent() {
    return [
      hfVisibleControl('qwen_7B', 100),
      hfVisibleControl('Add files using upload-large-folder tool', 128),
      hfVisibleControl('rvq_depth_decoder', 156),
      hfUnlabeledControl('a', 184, 'a[href="/model"]'),
      {
        tag: 'button',
        role: 'button',
        label: 'button',
        clickable: true,
        rect: { x: 8, y: 212, w: 24, h: 24 },
        selector: 'button.icon',
        hints: { id: '', classes: ['icon'] },
      },
    ];
  }

  function hfMeta(scrollY, files, {
    foldTag = false,
    capSwap = false,
    noisyCapSwap = false,
    titleChrome = false,
    timestampCapSwap = false,
    sharedCommitCapSwap = false,
    liveCensusCapSwap = false,
  } = {}) {
    const fileControls = files.map(file => hfVisibleControl(file.name, file.y - scrollY));
    let visibleControls = liveCensusCapSwap
      ? (scrollY > 0 ? liveCensusCapSwapContent() : liveCensusCapSwapChrome())
      : sharedCommitCapSwap
      ? (scrollY > 0 ? sharedCommitCapSwapContent() : sharedCommitCapSwapChrome())
      : timestampCapSwap
      ? (scrollY > 0
        ? [
          ...TIMESTAMP_CAP_SWAP_CONTENT.map((label, i) => hfVisibleControl(label, 100 + i * 28)),
          ...hfTimestampChromeControls(),
        ]
        : TIMESTAMP_CAP_SWAP_CHROME.map((label, i) => hfVisibleControl(label, 100 + i * 28)))
      : noisyCapSwap
      ? (scrollY > 0 ? noisyCapSwapContent() : noisyCapSwapChrome())
      : capSwap
      ? (scrollY > 0 ? CAP_SWAP_CONTENT : CAP_SWAP_CHROME).map((label, i) => (
        hfVisibleControl(label, 12 + i * 28)
      ))
      : fileControls;
    if (titleChrome && scrollY > 0) {
      visibleControls = [...hfTitleChromeControls(), ...visibleControls];
    }
    return JSON.stringify({
      title: 'MiniMaxAI/MiniMax-Music3 at main',
      url: HF_URL,
      contentType: 'text/html',
      vw: 1042,
      vh: liveCensusCapSwap ? 632 : 900,
      scrollY,
      scrollMax: liveCensusCapSwap ? 547 : 2400,
      counts: liveCensusCapSwap ? LIVE_CENSUS_COUNTS : { a: files.length },
      focused: 'none',
      layoutMap: foldTag || capSwap || liveCensusCapSwap
        ? { navigation: [{ w: 603, h: 28, ...(scrollY > 0 ? { vis: 'above' } : {}) }] }
        : {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls,
    });
  }

  function hfAx(files, { foldTag = false, capSwap = false, noisyCapSwap = false, timestampCapSwap = false, sharedCommitCapSwap = false, liveCensusCapSwap = false } = {}) {
    const links = files.map((file, i) => ({
      nodeId: String(20 + i),
      parentId: '10',
      role: { value: 'link' },
      name: { value: file.name },
      backendDOMNodeId: file.backend,
    }));
    const withNav = foldTag || capSwap || noisyCapSwap || timestampCapSwap || sharedCommitCapSwap || liveCensusCapSwap;
    return [
      {
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'MiniMax-Music3' },
        childIds: withNav ? ['5', '10', '99'] : ['10', '99'],
      },
      ...(withNav ? [{
        nodeId: '5',
        parentId: '1',
        role: { value: 'navigation' },
        name: { value: 'Main' },
      }] : []),
      { nodeId: '10', parentId: '1', role: { value: 'main' }, name: { value: '' }, childIds: links.map(n => n.nodeId) },
      ...links,
      {
        nodeId: '99',
        parentId: '1',
        role: { value: 'button' },
        name: { value: 'p26' },
        backendDOMNodeId: 399,
      },
    ];
  }

  function createHfPage({
    scrollY = 0,
    clicks = 0,
    files = DEFAULT_FILES,
    foldTag = false,
    capSwap = false,
    noisyCapSwap = false,
    titleChrome = false,
    timestampCapSwap = false,
    sharedCommitCapSwap = false,
    liveCensusCapSwap = false,
  } = {}) {
    const state = {
      scrollY,
      clicks,
      files: files.map(file => ({ ...file })),
      foldTag,
      capSwap: capSwap || noisyCapSwap || timestampCapSwap || sharedCommitCapSwap || liveCensusCapSwap,
      noisyCapSwap,
      titleChrome,
      timestampCapSwap,
      sharedCommitCapSwap,
      liveCensusCapSwap,
    };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: HF_URL } } });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('scrollBy')) {
            const scrollMax = state.liveCensusCapSwap ? 547 : 2400;
            state.scrollY = Math.min(state.scrollY + 80, scrollMax);
            return Promise.resolve({ result: { value: JSON.stringify({ x: 0, y: state.scrollY }) } });
          }
          if (expr.includes("resolve('stable')") || expr.includes('MutationObserver')) {
            return Promise.resolve({ result: { value: 'stable' } });
          }
          if (expr.includes('#p26btn') && expr.includes('click')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: JSON.stringify({ tag: 'BUTTON', text: 'p26' }) } });
          }
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({
              result: {
                value: hfMeta(state.scrollY, state.files, {
                  foldTag: state.foldTag,
                  capSwap: state.capSwap,
                  noisyCapSwap: state.noisyCapSwap,
                  titleChrome: state.titleChrome,
                  timestampCapSwap: state.timestampCapSwap,
                  sharedCommitCapSwap: state.sharedCommitCapSwap,
                  liveCensusCapSwap: state.liveCensusCapSwap,
                }),
              },
            });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          const nodes = hfAx(state.files, {
            foldTag: state.foldTag,
            capSwap: state.capSwap,
            noisyCapSwap: state.noisyCapSwap,
            timestampCapSwap: state.timestampCapSwap,
            sharedCommitCapSwap: state.sharedCommitCapSwap,
            liveCensusCapSwap: state.liveCensusCapSwap,
          });
          if (state.clicks) {
            nodes.push({
              nodeId: '98',
              parentId: '1',
              role: { value: 'StaticText' },
              name: { value: `clicks:${state.clicks}` },
            });
            nodes[0].childIds = [...nodes[0].childIds, '98'];
          }
          return Promise.resolve({ nodes });
        }
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 2 });
        if (method === 'DOM.resolveNode') {
          const id = params.backendNodeId;
          return Promise.resolve({ object: { objectId: `hf-${id}` } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            return Promise.resolve({ result: { value: { tag: 'BUTTON', text: 'p26' } } });
          }
          const objectId = String(params.objectId || '');
          const backend = Number(objectId.replace('hf-', '')) || 301;
          if (backend === 399) {
            return Promise.resolve({
              result: { value: { x: 8, y: 80, w: 80, h: 24, position: '', tag: 'BUTTON', text: 'p26' } },
            });
          }
          const file = state.files.find(item => item.backend === backend) || state.files[0];
          return Promise.resolve({
            result: {
              value: {
                x: 24,
                y: file.y - state.scrollY,
                w: 160,
                h: 22,
                position: '',
                tag: 'A',
                text: file.name,
              },
            },
          });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    return { cdp, state };
  }

  function comfyMeta(scrollY) {
    return JSON.stringify({
      title: 'MiniMax Music 3 - ComfyUI',
      url: COMFY_URL,
      contentType: 'text/html',
      vw: 1042,
      vh: 900,
      scrollY,
      scrollMax: 1800,
      counts: { a: 3 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [{
        tag: 'a',
        role: 'link',
        label: 'API Reference',
        clickable: true,
        rect: { x: 16, y: 220 - scrollY, w: 140, h: 22 },
        selector: 'a[href="#api"]',
        hints: { id: '', classes: [] },
      }],
    });
  }

  function createComfyPage() {
    const state = { scrollY: 0 };
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: COMFY_URL } } });
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
          if (expr.includes('document.title') || expr.includes('contentType')) {
            return Promise.resolve({ result: { value: comfyMeta(state.scrollY) } });
          }
          return Promise.resolve({ result: { value: '{}' } });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'MiniMax Music 3' }, childIds: ['10'] },
              { nodeId: '10', parentId: '1', role: { value: 'main' }, name: { value: '' }, childIds: ['20'] },
              {
                nodeId: '20',
                parentId: '10',
                role: { value: 'link' },
                name: { value: 'API Reference' },
                backendDOMNodeId: 401,
              },
            ],
          });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'comfy-401' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({
            result: {
              value: {
                x: 16,
                y: 220 - state.scrollY,
                w: 140,
                h: 22,
                position: '',
                tag: 'A',
                text: 'API Reference',
              },
            },
          });
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
    };
  }

  function clickJsTarget() {
    return {
      input: '#p26btn',
      resolvedBy: 'selector-or-ref',
      label: '#p26btn',
      commandArgs: ['--js', '#p26btn'],
    };
  }

  async function leftoverGoldenPath(cdp, store, refMap, refState, {
    targetId: _targetId = HF_TARGET_ID,
    prefix = HF_PREFIX,
  } = {}) {
    const dump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      store,
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: prefix },
      refState,
    );
    expect(dump).toMatch(/^Page: /m);
    expect(store.snapshotOpts.cursorInteractive).toBe(true);
    expect(store.snapshotOpts.maxDepth).toBe(8);
    expect(T.isLeftoverFeedCardsSettle(dump, store.snapshotOpts, scrollTarget())).toBe(false);
    expect(T.isLeftoverDefaultAxScrollSettle(dump, store.snapshotOpts, scrollTarget())).toBe(true);
    expect(T.shouldCaptureTopLevelActionSettle(store.snapshotOpts, dump, scrollTarget())).toBe(false);
    expect(T.actionSettleBaseline(dump, store.snapshotOpts, scrollTarget()).output).toBe(dump);
    return dump;
  }

  async function recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState, targetId = HF_TARGET_ID) {
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
      const topLevelOpts = T.actionObservationPerceiveOpts(targetId, {
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

  async function observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState, targetId = HF_TARGET_ID) {
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
      T.actionSettleObserveOpts(targetId, actionTarget, settleBaseline.output, settleBaseline.opts),
      refState,
    );
  }

  it('#295 leftover golden-path AX is a scroll settle shape, not a cards recapture', () => {
    const dump = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 3 a',
      'Console: clean',
      'Coords: top-level viewport CSS px',
      '',
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
    ].join('\n');
    const snapshotOpts = T.perceiveSnapshotOpts({ cursorInteractive: true, maxDepth: 8 });
    const scroll = scrollTarget();
    expect(T.isLeftoverDefaultAxScrollSettle(dump, snapshotOpts, scroll)).toBe(true);
    expect(T.shouldCaptureTopLevelActionSettle(snapshotOpts, dump, scroll)).toBe(false);
    const settled = T.actionSettleBaseline(dump, snapshotOpts, scroll);
    expect(settled.output).toBe(dump);
    expect(T.actionSettleObserveOpts(HF_TARGET_ID, scroll, settled.output, settled.opts).cards).toBe(false);
    expect(T.actionSettleObserveOpts(HF_TARGET_ID, scroll, settled.output, settled.opts).cursorInteractive).toBe(true);
    expect(T.actionSettleObserveOpts(HF_TARGET_ID, scroll, settled.output, settled.opts).maxDepth).toBe(8);

    const cardsDump = 'chrome-cdp-ex.cards.v1  2 cards  virtualized\n@1  @SY239434  first';
    expect(T.isLeftoverDefaultAxScrollSettle(cardsDump, T.perceiveSnapshotOpts({ cards: true }), scroll)).toBe(false);
    const click = clickJsTarget();
    expect(T.isLeftoverDefaultAxScrollSettle(dump, snapshotOpts, click)).toBe(false);
  });

  it('#295 leftover perceive -C -d 8 then scroll is no-change / continue, Next -C -d 8, not @ref rect chrome', async () => {
    const { cdp, state } = createHfPage();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/LICENSE {2}@1 {2}\(24,180 160×22\)/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;

    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(settleBaseline.opts.cursorInteractive).toBe(true);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);

    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(state.scrollY).toBe(80);

    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(after).toMatch(/Scroll: 80\/2400/);
    expect(after).not.toMatch(/--- Removed/);
    expect(after).not.toMatch(/\(24,180/);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);

    if (T.isLeftoverDefaultAxScrollSettle(leftoverDump, store.snapshotOpts, actionTarget)) {
      actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'leftover-ax-scroll-no-change';
    }
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: no-change/);
    expect(text).not.toMatch(/Outcome: changed/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(text).not.toMatch(/record-actions/);
  });

  it('#295 leftover -C -d 8 then scroll that adds a file is Outcome: changed', async () => {
    const { cdp, state } = createHfPage();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).not.toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    expect(result.outcome.status).toBe('changed');
    expect(T.isExpectedNoChange(actionTarget, after, 'scroll')).toBe(true);
  });

  it('#295 leftover Comfy perceive -C -d 8 then scroll ignores heading @ref rect chrome', async () => {
    const { cdp, state } = createComfyPage();
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState, {
      targetId: COMFY_TARGET_ID,
      prefix: COMFY_PREFIX,
    });
    expect(leftoverDump).toMatch(/API Reference {2}@1 {2}\(16,220 140×22\)/);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(
      cdp, store, actionTarget, refMap, refState, COMFY_TARGET_ID,
    );
    await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(state.scrollY).toBe(80);
    const after = await observeActionDiffForTarget(
      cdp, store, actionTarget, settleBaseline, refMap, refState, COMFY_TARGET_ID,
    );
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: COMFY_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Next: cdp perceive 0D34570A -C -d 8/);
    expect(text).not.toMatch(/cdp report 0D34570A --format json/);
  });

  it('#295 leftover -C -d 8 then mutating click --js still Outcome: changed', async () => {
    const { cdp, state } = createHfPage({ clicks: 6 });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = clickJsTarget();
    expect(T.isLeftoverDefaultAxScrollSettle(store.output, store.snapshotOpts, actionTarget)).toBe(false);
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toContain('[StaticText] clicks:6');
    const dispatchText = await T.jsClickStr(cdp, 'sid', '#p26btn', refMap, refState);
    expect(dispatchText).toMatch(/JS-clicked <BUTTON>/);
    expect(state.clicks).toBe(7);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    expect(after).toMatch(/\+\s+\[StaticText\] clicks:7/);
  });

  it('#297 leftover -C -d 8 then scroll fold-tag-only [navigation] Main is no-change / Next -C -d 8', async () => {
    const { cdp } = createHfPage({ foldTag: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/\[navigation\] Main {2}603×28px/);
    expect(leftoverDump).not.toMatch(/↑above fold/);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(after).not.toMatch(/--- Removed/);
    expect(after).not.toMatch(/↑above fold/);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
  });

  it('#297 leftover -C -d 8 then scroll Visible-control cap-swap is changed / compact / Next -C -d 8', async () => {
    const { cdp } = createHfPage({ capSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/Hugging Face/);
    expect(leftoverDump).toMatch(/\[navigation\] Main {2}603×28px/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(after).toContain('- Hugging Face');
    expect(after).toContain('+ MiniMaxAI');
    expect(after).not.toMatch(/--- Removed \(9\)/);
    expect(after).not.toMatch(/a role=link "Hugging Face"/);
    expect(after).not.toMatch(/\[navigation\] Main/);
    expect(after).not.toMatch(/LICENSE/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(text).not.toMatch(/record-actions/);
  });

  it('#297 leftover -C -d 8 cap-swap plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ capSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(after).not.toMatch(/a role=link "Hugging Face"/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
  });

  it('#299 leftover -C -d 8 then scroll cap-swap samples skip unlabeled tags and drop Hint --since-action', async () => {
    const { cdp } = createHfPage({ noisyCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/img "img" \[clickable\]/);
    expect(leftoverDump).toMatch(/div "div" \[clickable\]/);
    expect(leftoverDump).toMatch(/a role=link "link" \[clickable\]/);
    expect(leftoverDump).toMatch(/Hugging Face/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: \d+ left, \d+ entered/);
    const removedSamples = [...after.matchAll(/^- (.+)$/gm)].map(match => match[1]);
    const addedSamples = [...after.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(removedSamples[0]).toBe('Hugging Face');
    expect(addedSamples[0]).toBe('MiniMaxAI');
    expect(after).toContain('- Hugging Face');
    expect(after).toContain('+ MiniMaxAI');
    expect(removedSamples).not.toEqual(expect.arrayContaining(['img', 'div', 'link', 'a']));
    expect(addedSamples).not.toEqual(expect.arrayContaining(['img', 'div', 'link', 'a']));
    expect(after).not.toMatch(/^[-+] (?:img|div|link|a)\b/m);
    expect(after).not.toMatch(/img\.logo|div\.nav-icon|img\.hero|div\.body-icon/);
    expect(after).not.toMatch(/--- Removed \(\d+\)/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 80)',
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/Hint: Use perceive --since-action/);
  });

  it('#301 leftover -C -d 8 then scroll cap-swap drops generic Recovery hint and stays changed', async () => {
    const { cdp } = createHfPage({ noisyCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/^Page: /m);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: \d+ left, \d+ entered/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
  });

  it('#303 leftover -C -d 8 then scroll drops signed-commit / time GMT Added chrome and stays changed', async () => {
    const { cdp } = createHfPage({ noisyCapSwap: true, titleChrome: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/^Page: /m);
    expect(leftoverDump).not.toMatch(/This commit is signed/);
    const signedReceipt = T.formatVisibleControlLine({
      tag: 'span',
      label: 'This commit is signed and the signature is verified',
      title: 'This commit is signed and the signature is verified',
      selector: 'span[title="This commit is signed and the signature is verified"]',
      hints: { classes: ['mx-2', 'text-green-500', 'dark:text-green-600'] },
    });
    const timeReceipt = T.formatVisibleControlLine({
      tag: 'time',
      label: 'Fri, 14 Aug 2026 10:51:40 GMT',
      title: 'Fri, 14 Aug 2026 10:51:40 GMT',
      selector: 'time[title="Fri, 14 Aug 2026 10:51:40 GMT"]',
      hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
    });
    expect(signedReceipt).toBe(
      'span "This commit is signed and the signature is verified" span[title="This commit is signed and the signature is verified"] .mx-2.text-green-500.dark:text-green-600',
    );
    expect(timeReceipt).toBe(
      'time "Fri, 14 Aug 2026 10:51:40 GMT" time[title="Fri, 14 Aug 2026 10:51:40 GMT"] .ml-auto.hidden.flex-none',
    );
    const signedDump = T.formatVisibleControlLine(hfTitleChromeControls()[0]);
    const timeDump = T.formatVisibleControlLine(hfTitleChromeControls()[1]);
    expect(signedDump).toContain('(400,120 18×18)');
    expect(signedDump).toContain('span[title="This commit is signed and the signature is verified"]');
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(signedDump);
    expect(afterDump).toContain(timeDump);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).not.toMatch(/\+\+\+ Added/);
    expect(after).not.toMatch(/^\+ .*span\[title=/m);
    expect(after).not.toMatch(/^\+ .*time\[title=/m);
    expect(after).not.toMatch(/^\+ .*This commit is signed/m);
    expect(after).not.toMatch(/^\+ .*10:51:40 GMT/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(text).not.toMatch(/span\[title=/);
    expect(text).not.toMatch(/This commit is signed/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/\+\+\+ Added/);
  });

  it('#303 leftover -C -d 8 title chrome plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ noisyCapSwap: true, titleChrome: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap:/);
    expect(after).not.toMatch(/\+\+\+ Added \(\d+\):[\s\S]*This commit is signed/);
    expect(after).not.toMatch(/^\+ .*span\[title=/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/tokenizer\.json/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/span\[title=/);
  });

  it('#305 leftover -C -d 8 then scroll cap-swap samples skip relative-time / GMT and stay changed', async () => {
    const { cdp } = createHfPage({ timestampCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/ryanlee-dev/);
    expect(leftoverDump).toMatch(/assets/);
    const relativeDump = T.formatVisibleControlLine(hfTimestampChromeControls()[0]);
    const gmtDump = T.formatVisibleControlLine(hfTimestampChromeControls()[1]);
    expect(relativeDump).toBe('a role=link "2 days ago" [clickable] (720,184 72×16) a.truncate .truncate');
    expect(gmtDump).toContain('time "Thu, 13 Aug 2026 15:18:27 GMT" [clickable]');
    expect(gmtDump).toContain('time[title="Thu, 13 Aug 2026 15:18:27 GMT"]');
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(relativeDump);
    expect(afterDump).toContain(gmtDump);
    expect(afterDump).toMatch(/condition_encoder/);
    expect(afterDump).toMatch(/config\.json/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(after).toContain('- ryanlee-dev');
    expect(after).toContain('+ condition_encoder');
    expect(after).toContain('+ Add diffusers weights (modular pipeline) (#2)');
    expect(after).toContain('+ config.json');
    const addedSamples = [...after.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(addedSamples).toEqual([
      'condition_encoder',
      'Add diffusers weights (modular pipeline) (#2)',
      'config.json',
    ]);
    expect(after).not.toMatch(/^\+ 2 days ago$/m);
    expect(after).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(after).not.toMatch(/\+\+\+ Added/);
    expect(after).not.toMatch(/time\[title=/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(text).toMatch(/\+ config\.json/);
    expect(text).not.toMatch(/^\+ 2 days ago$/m);
    expect(text).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^\+ 2 days ago$/m);
    expect(receipt).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
  });

  it('#305 leftover -C -d 8 timestamp samples plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ timestampCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(after).not.toMatch(/^\+ 2 days ago$/m);
    expect(after).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/tokenizer\.json/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/^\+ 2 days ago$/m);
  });

  it('#307 leftover -C -d 8 then scroll cap-swap samples skip a shared commit title on both sides', async () => {
    const { cdp } = createHfPage({ sharedCommitCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toMatch(/condition_encoder/);
    expect(leftoverDump).toMatch(/figures/);
    expect(leftoverDump).toMatch(/tokenizer\.json/);
    const commitLeft = T.formatVisibleControlLine(sharedCommitCapSwapChrome()[1]);
    const commitEntered = T.formatVisibleControlLine(sharedCommitCapSwapContent()[1]);
    expect(commitLeft).toBe(
      'a role=link "Add diffusers weights (modular pipeline) (#2)" [clickable] (24,128 160×22) a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]',
    );
    expect(commitEntered).toBe(
      'a role=link "Add diffusers weights (modular pipeline) (#2)" [clickable] (24,128 160×22) a[href="/MiniMaxAI/MiniMax-Music3/commit/entered"]',
    );
    expect(leftoverDump).toMatch(
      /a role=link "Add diffusers weights \(modular pipeline\) \(#2\)" \[clickable\] \(24,128 160×22\)(?: @\d+)? a\[href="\/MiniMaxAI\/MiniMax-Music3\/commit\/left"\]/,
    );
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toMatch(
      /a role=link "Add diffusers weights \(modular pipeline\) \(#2\)" \[clickable\] \(24,128 160×22\)(?: @\d+)? a\[href="\/MiniMaxAI\/MiniMax-Music3\/commit\/entered"\]/,
    );
    expect(afterDump).toMatch(/language_model/);
    expect(afterDump).toMatch(/qwen_7B/);
    expect(afterDump).toMatch(/speech_tokenizer/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(after).toContain('- condition_encoder');
    expect(after).toContain('- figures');
    expect(after).toContain('- tokenizer.json');
    expect(after).toContain('+ language_model');
    expect(after).toContain('+ qwen_7B');
    expect(after).toContain('+ speech_tokenizer');
    const removedSamples = [...after.matchAll(/^- (.+)$/gm)].map(match => match[1]);
    const addedSamples = [...after.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(removedSamples).toEqual([
      'condition_encoder',
      'figures',
      'tokenizer.json',
    ]);
    expect(addedSamples).toEqual([
      'language_model',
      'qwen_7B',
      'speech_tokenizer',
    ]);
    expect(after).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(after).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(after).not.toMatch(/\+\+\+ Added/);
    expect(after).not.toMatch(/span\[title=/);
    expect(after).not.toMatch(/time\[title=/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(text).toMatch(/- tokenizer\.json/);
    expect(text).toMatch(/\+ speech_tokenizer/);
    expect(text).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(receipt).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
  });

  it('#307 leftover -C -d 8 shared commit samples plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ sharedCommitCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    await leftoverGoldenPath(cdp, store, refMap, refState);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/\[link\] tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(after).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(after).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/\[link\] tokenizer\.json/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
  });

  it('#309 leftover -C -d 8 then scroll drops Interactive/Coords census and Outcome tautology', async () => {
    const { cdp } = createHfPage({ liveCensusCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toContain(LIVE_INTERACTIVE);
    expect(leftoverDump).toContain(LIVE_COORDS);
    expect(leftoverDump).toMatch(/^Console: clean$/m);
    expect(leftoverDump).toMatch(/language_model/);
    const languageModel = T.formatVisibleControlLine(liveCensusCapSwapChrome()[0]);
    const commitLeft = T.formatVisibleControlLine(liveCensusCapSwapChrome()[1]);
    const qwen = T.formatVisibleControlLine(liveCensusCapSwapContent()[0]);
    const upload = T.formatVisibleControlLine(liveCensusCapSwapContent()[1]);
    const rvq = T.formatVisibleControlLine(liveCensusCapSwapContent()[2]);
    expect(languageModel).toContain('"language_model"');
    expect(commitLeft).toContain('"Add diffusers weights (modular pipeline) (#2)"');
    expect(qwen).toContain('"qwen_7B"');
    expect(upload).toContain('"Add files using upload-large-folder tool"');
    expect(rvq).toContain('"rvq_depth_decoder"');
    expect(leftoverDump).toContain(languageModel.split(' (')[0]);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 80)');
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(LIVE_INTERACTIVE);
    expect(afterDump).toContain(LIVE_COORDS);
    expect(afterDump).toMatch(/qwen_7B/);
    expect(afterDump).toMatch(/Add files using upload-large-folder tool/);
    expect(afterDump).toMatch(/rvq_depth_decoder/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(after).toContain('- language_model');
    expect(after).toContain('- Add diffusers weights (modular pipeline) (#2)');
    expect(after).toContain('+ qwen_7B');
    expect(after).toContain('+ Add files using upload-large-folder tool');
    expect(after).toContain('+ rvq_depth_decoder');
    expect(after).toContain(LIVE_INTERACTIVE);
    expect(after).toContain(LIVE_COORDS);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1481 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/^Outcome: changed$/m);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).not.toMatch(/Observed page change after action/);
    expect(text).not.toMatch(/^Receipt: changed$/m);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).toMatch(/^Page:/m);
    expect(text).toMatch(/^Viewport:/m);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(text).toContain('- language_model');
    expect(text).toContain('+ qwen_7B');
    expect(text).toContain('+ rvq_depth_decoder');
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/^Receipt: changed$/m);
    expect(receipt).not.toMatch(/Observed page change after action/);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/use clickxy with these values/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
  });

  it('#309 leftover -C -d 8 census drop plus a new file still prints tokenizer.json', async () => {
    const { cdp, state } = createHfPage({ liveCensusCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toContain(LIVE_INTERACTIVE);
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    state.files = [...DEFAULT_FILES, ADDED_FILE];
    await T.scrollStr(cdp, 'sid', 'down', '80');
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/tokenizer\.json/);
    expect(after).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(T.actionDomDiffShowsChange(after)).toBe(true);
    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1481 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
    }), emptyDelta);
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(text).toMatch(/tokenizer\.json/);
    expect(text).toMatch(/^Outcome: changed$/m);
    expect(text).not.toMatch(/^Receipt: changed$/m);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).toMatch(/^Page:/m);
    expect(text).toMatch(/^Viewport:/m);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
  });

  it('#311 leftover -C -d 8 then already-at-bottom scroll drops tautological Recovery hint', async () => {
    // Live leftover-ax-scroll after overlay 0546edbe: HF already at
    // scrollY 547/547 (100%). scroll down 80 stays Position (0, 547).
    // Honest no-change. Perceive dump still has Interactive/Coords.
    // Action receipt must not reprint Recovery hint that restates Next.
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const { cdp, state } = createHfPage({ scrollY: 547, liveCensusCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toContain(LIVE_INTERACTIVE);
    expect(leftoverDump).toContain(LIVE_COORDS);
    expect(leftoverDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    expect(leftoverDump).toMatch(/qwen_7B/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 547)');
    expect(state.scrollY).toBe(547);
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(LIVE_INTERACTIVE);
    expect(afterDump).toContain(LIVE_COORDS);
    expect(afterDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/Visible-control cap swap:/);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 826 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(/Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities/);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt.length).toBeLessThan(558);
  });

  it('#313 leftover -C -d 8 then already-at-bottom scroll drops settle-shape Outcome reason', async () => {
    // Live leftover-ax-scroll after overlay b302e9f9: HF already at
    // scrollY 547/547 (100%). scroll down 80 stays Position (0, 547).
    // Honest no-change. Recovery hint is gone. Perceive dump still has
    // Interactive/Coords. Action receipt must not reprint the settle-shape
    // Outcome reason essay after a no-op whose Next is already perceive.
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const { cdp, state } = createHfPage({ scrollY: 547, liveCensusCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toContain(LIVE_INTERACTIVE);
    expect(leftoverDump).toContain(LIVE_COORDS);
    expect(leftoverDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    expect(leftoverDump).toMatch(/qwen_7B/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 547)');
    expect(state.scrollY).toBe(547);
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(LIVE_INTERACTIVE);
    expect(afterDump).toContain(LIVE_COORDS);
    expect(afterDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/Visible-control cap swap:/);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1527 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 1527ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt.length).toBeLessThan(476);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);
  });

  it('#316 leftover -C -d 8 then already-at-bottom scroll drops reprinted Page/Viewport header', async () => {
    // Live leftover-ax-scroll after overlay b2fa6af8: HF already at
    // scrollY 547/547 (100%). scroll down 80 stays Position (0, 547).
    // Honest no-change. Settle-shape Outcome suffix is gone. Recovery hint
    // is gone. Perceive dump still has Page/Viewport/Interactive/Coords.
    // Action receipt must not reprint Page / Viewport after a no-op whose
    // Next is already perceive. Position stays on the action line.
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const { cdp, state } = createHfPage({ scrollY: 547, liveCensusCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toContain(LIVE_INTERACTIVE);
    expect(leftoverDump).toContain(LIVE_COORDS);
    expect(leftoverDump).toMatch(/^Page: /m);
    expect(leftoverDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    expect(leftoverDump).toMatch(/Focused: none/);
    expect(leftoverDump).toMatch(/qwen_7B/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 547)');
    expect(state.scrollY).toBe(547);
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(LIVE_INTERACTIVE);
    expect(afterDump).toContain(LIVE_COORDS);
    expect(afterDump).toMatch(/^Page: /m);
    expect(afterDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(after).toMatch(/^Page: /m);
    expect(after).toMatch(/^Viewport:/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/Visible-control cap swap:/);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1061 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 1061ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt.length).toBeLessThan(381);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);
  });

  it('#318 leftover -C -d 8 then already-at-bottom scroll drops tautological AX body', async () => {
    // Live leftover-ax-scroll after overlay a972d528: HF already at
    // scrollY 547/547 (100%). scroll down 80 stays Position (0, 547).
    // Honest no-change. Page / Viewport header is gone. Settle-shape
    // Outcome suffix is gone. Recovery hint is gone. Perceive dump still
    // has Page/Viewport/Interactive/Coords and the AX no-change body.
    // Action receipt must not reprint (no changes detected in AX tree)
    // after a no-op whose Next is already perceive. Outcome already
    // states no-change. Position stays on the action line. Settle 1178ms
    // stays as recorded — do not invent a new settle path.
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const LIVE_AX_BODY = '(no changes detected in AX tree)';
    const { cdp, state } = createHfPage({ scrollY: 547, liveCensusCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toContain(LIVE_INTERACTIVE);
    expect(leftoverDump).toContain(LIVE_COORDS);
    expect(leftoverDump).toMatch(/^Page: /m);
    expect(leftoverDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    expect(leftoverDump).toMatch(/Focused: none/);
    expect(leftoverDump).toMatch(/qwen_7B/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 547)');
    expect(state.scrollY).toBe(547);
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(LIVE_INTERACTIVE);
    expect(afterDump).toContain(LIVE_COORDS);
    expect(afterDump).toMatch(/^Page: /m);
    expect(afterDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(after).toMatch(/^Page: /m);
    expect(after).toMatch(/^Viewport:/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/Visible-control cap swap:/);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1178 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 1178ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(LIVE_AX_BODY);
    expect(text).not.toMatch(/no changes detected in AX tree/i);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).not.toMatch(LIVE_AX_BODY);
    expect(receipt).not.toMatch(/no changes detected in AX tree/i);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt.length).toBeLessThan(218);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);
  });

  it('#320 leftover -C -d 8 then already-at-bottom scroll drops tautological dispatched/Target', async () => {
    // Live leftover-ax-scroll after overlay 496c6a44: HF already at
    // scrollY 547/547 (100%). scroll down 80 stays Position (0, 547).
    // Honest no-change. AX body is gone. Page / Viewport header is gone.
    // Settle-shape Outcome suffix is gone. Recovery hint is gone.
    // Perceive dump still has Page/Viewport/Interactive/Coords and the
    // AX no-change body. Action receipt must not reprint
    // "scroll: dispatched via scroll" / "Target: down" after a no-op
    // whose Next is already perceive. Scrolled by / Position already
    // states the action. Settle 763ms stays as recorded — do not invent
    // a new settle path.
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const LIVE_AX_BODY = '(no changes detected in AX tree)';
    const { cdp, state } = createHfPage({ scrollY: 547, liveCensusCapSwap: true });
    const store = { output: null, snapshotOpts: null };
    const refMap = new Map();
    const refState = {};
    const leftoverDump = await leftoverGoldenPath(cdp, store, refMap, refState);
    expect(leftoverDump).toContain(LIVE_INTERACTIVE);
    expect(leftoverDump).toContain(LIVE_COORDS);
    expect(leftoverDump).toMatch(/^Page: /m);
    expect(leftoverDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    expect(leftoverDump).toMatch(/Focused: none/);
    expect(leftoverDump).toMatch(/qwen_7B/);
    const axBefore = cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
    const actionTarget = scrollTarget();
    const settleBaseline = await recaptureSettleBaseline(cdp, store, actionTarget, refMap, refState);
    expect(settleBaseline.output).toBe(leftoverDump);
    expect(cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length).toBe(axBefore);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(dispatchText).toBe('Scrolled by (0, 80). Position: (0, 547)');
    expect(state.scrollY).toBe(547);
    const afterDump = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      refMap,
      { output: leftoverDump, snapshotOpts: store.snapshotOpts },
      { ...T.parsePerceiveArgs(['-C', '-d', '8']), targetPrefix: HF_PREFIX },
      refState,
    );
    expect(afterDump).toContain(LIVE_INTERACTIVE);
    expect(afterDump).toContain(LIVE_COORDS);
    expect(afterDump).toMatch(/^Page: /m);
    expect(afterDump).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    const after = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(after).toMatch(/no changes detected in AX tree/i);
    expect(after).toMatch(/^Page: /m);
    expect(after).toMatch(/^Viewport:/m);
    expect(T.actionDomDiffShowsChange(after)).toBe(false);
    expect(after).not.toMatch(/Visible-control cap swap:/);

    actionTarget.expectedOutcome = 'leftover-ax-scroll-no-change';
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 763 },
      effects: { domDiff: after, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), emptyDelta);
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(text).not.toMatch(/dispatched via scroll/);
    expect(text).not.toMatch(/^Target: down$/m);
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 763ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(LIVE_AX_BODY);
    expect(text).not.toMatch(/no changes detected in AX tree/i);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).toBe('Scrolled by (0, 80). Position: (0, 547). Next: cdp perceive 561F7DA8 -C -d 8');
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(/dispatched via scroll/);
    expect(receipt).not.toMatch(/^Target: down$/m);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).not.toMatch(LIVE_AX_BODY);
    expect(receipt).not.toMatch(/no changes detected in AX tree/i);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt.length).toBeLessThan(180);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);

    state.files = [...DEFAULT_FILES, ADDED_FILE];
    const changedAfter = await observeActionDiffForTarget(cdp, store, actionTarget, settleBaseline, refMap, refState);
    expect(T.actionDomDiffShowsChange(changedAfter)).toBe(true);
    expect(changedAfter).toMatch(/tokenizer\.json/);
    const changed = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: { targetId: HF_TARGET_ID, ...actionTarget },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1481 },
      effects: { domDiff: changedAfter, console: [], network: [], navigation: null },
    }), emptyDelta);
    const changedText = T.formatActionText(changed);
    expect(changed.outcome.status).toBe('changed');
    expect(changed.receipt.recoveryHint).toBeNull();
    expect(changedText).toMatch(/^scroll: dispatched via scroll$/m);
    expect(changedText).toMatch(/^Target: down$/m);
    expect(changedText).toMatch(/^Outcome: changed$/m);
    expect(changedText).toMatch(/^Page:/m);
    expect(changedText).toMatch(/^Viewport:/m);
    expect(changedText).toMatch(/tokenizer\.json/);
    expect(changedText).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(changedText).not.toMatch(/^Recovery hint:/m);
  });
});
