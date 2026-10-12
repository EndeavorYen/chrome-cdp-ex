import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, parsePerceiveArgs, buildPerceiveTree, perceivePageScript, snapshotStr, filterPerceiveExcludedAxNodes } = T;

// =========================================================================
// Perception model
// =========================================================================

describe('PerceptionModel', () => {
  it('builds a versioned model with page, viewport, console, refs, and nodes', () => {
    const model = T.createPerceptionModel({
      targetPrefix: 'ABC12345',
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 1000 },
      consoleHealth: { errors: 1, warnings: 2, exceptions: 0 },
      refs: { generation: 3 },
      nodes: [{ ref: '@1', role: 'button', name: 'Submit', rect: { x: 10, y: 20, width: 80, height: 30 } }],
      limits: { truncated: false },
    });

    expect(model.schema).toBe('chrome-cdp-ex.perceive.v1');
    expect(model.viewport.coordinateSpace).toBe('viewport-css-px');
    expect(model.nodes[0].ref).toBe('@1');
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'act',
      targetPrefix: 'ABC12345',
      run: 'cdp click ABC12345 @1',
      after: 'cdp perceive ABC12345 --since-action',
      report: 'cdp report ABC12345',
      requiresUserAction: false,
      consentRequired: false,
    });
    expect(model.recommendation.reason).toContain('first interactive ref');
    expect(model.nextSteps).toEqual(model.recommendation.commands);
  });

  it('formats perception JSON as parseable output', () => {
    const model = T.createPerceptionModel({
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 1000 },
      consoleHealth: { errors: 0, warnings: 0, exceptions: 0 },
      refs: { generation: 1 },
      nodes: [],
      limits: { truncated: false },
    });
    expect(JSON.parse(T.formatPerceptionJson(model)).schema).toBe('chrome-cdp-ex.perceive.v1');
  });
});

// =========================================================================
// parsePerceiveArgs
// =========================================================================

describe('parsePerceiveArgs', () => {
  it('should return defaults for empty args', () => {
    const opts = parsePerceiveArgs([]);
    expect(opts).toEqual({
      diff: false,
      selector: null,
      exclude: null,
      interactive: false,
      maxDepth: Infinity,
      cursorInteractive: false,
      keepRefs: false,
      keepTypeahead: false,
      last: null,
      adaptive: false,
      sinceAction: false,
      frameRef: null,
      cards: false,
      unsafeFull: false,
      verbose: false,
    });
  });

  it('should parse --diff', () => {
    expect(parsePerceiveArgs(['--diff']).diff).toBe(true);
  });

  it('should parse --since-action', () => {
    expect(parsePerceiveArgs(['--since-action']).sinceAction).toBe(true);
  });

  it('should parse -s with value', () => {
    expect(parsePerceiveArgs(['-s', '.main']).selector).toBe('.main');
  });

  it('should parse --selector with value', () => {
    expect(parsePerceiveArgs(['--selector', '#app']).selector).toBe('#app');
  });

  it('should parse -i', () => {
    expect(parsePerceiveArgs(['-i']).interactive).toBe(true);
  });

  it('should parse --interactive', () => {
    expect(parsePerceiveArgs(['--interactive']).interactive).toBe(true);
  });

  it('should parse -d with numeric value', () => {
    expect(parsePerceiveArgs(['-d', '3']).maxDepth).toBe(3);
  });

  it('should parse --depth with numeric value', () => {
    expect(parsePerceiveArgs(['--depth', '5']).maxDepth).toBe(5);
  });

  it('should default maxDepth to Infinity for non-numeric -d', () => {
    expect(parsePerceiveArgs(['-d', 'abc']).maxDepth).toBe(Infinity);
  });

  it('should parse -C', () => {
    expect(parsePerceiveArgs(['-C']).cursorInteractive).toBe(true);
  });

  it('should parse --cursor-interactive', () => {
    expect(parsePerceiveArgs(['--cursor-interactive']).cursorInteractive).toBe(true);
  });

  it('should parse -x with value', () => {
    expect(parsePerceiveArgs(['-x', 'nav, aside']).exclude).toBe('nav, aside');
  });

  it('should parse --exclude with value', () => {
    expect(parsePerceiveArgs(['--exclude', '[role=complementary]']).exclude).toBe('[role=complementary]');
  });

  it('should handle all flags combined', () => {
    const opts = parsePerceiveArgs(['--diff', '-i', '-s', 'form', '-x', 'nav', '-d', '2', '-C']);
    expect(opts).toEqual({
      diff: true,
      interactive: true,
      selector: 'form',
      exclude: 'nav',
      maxDepth: 2,
      cursorInteractive: true,
      keepRefs: false,
      keepTypeahead: false,
      last: null,
      adaptive: false,
      sinceAction: false,
      frameRef: null,
      cards: false,
      unsafeFull: false,
      verbose: false,
    });
  });

  it('should allow -s and -x together', () => {
    const opts = parsePerceiveArgs(['-s', '#main', '-x', '.sidebar']);
    expect(opts.selector).toBe('#main');
    expect(opts.exclude).toBe('.sidebar');
  });

  it('rejects unknown flags instead of ignoring them', () => {
    expect(() => parsePerceiveArgs(['--not-a-real-flag'])).toThrow(/unknown option --not-a-real-flag/);
    expect(() => parsePerceiveArgs(['--feed-dump'])).toThrow(/unknown option --feed-dump/);
    expect(() => parsePerceiveArgs(['--diff', '--feed-dump', '-i'])).toThrow(/unknown option --feed-dump/);
  });

  it('skips leftover target-looking tokens that do not start with -', () => {
    expect(parsePerceiveArgs(['F8741D08', '--adaptive']).adaptive).toBe(true);
    expect(parsePerceiveArgs(['F8741D08'])).toMatchObject({
      diff: false,
      adaptive: false,
      last: null,
    });
  });

  it('rejects missing values for flags that require arguments', () => {
    expect(() => parsePerceiveArgs(['--selector'])).toThrow(/--selector requires/);
    expect(() => parsePerceiveArgs(['-s'])).toThrow(/-s requires/);
    expect(() => parsePerceiveArgs(['-s', '--diff'])).toThrow(/-s requires/);
    expect(() => parsePerceiveArgs(['--exclude'])).toThrow(/--exclude requires/);
    expect(() => parsePerceiveArgs(['-x'])).toThrow(/-x requires/);
    expect(() => parsePerceiveArgs(['--depth'])).toThrow(/--depth requires/);
    expect(() => parsePerceiveArgs(['-d'])).toThrow(/-d requires/);
    expect(() => parsePerceiveArgs(['--last'])).toThrow(/--last requires/);
    expect(() => parsePerceiveArgs(['--frame'])).toThrow(/--frame requires/);
    expect(() => parsePerceiveArgs(['-F'])).toThrow(/-F requires/);
  });
});

describe('perceiveStr selector scope', () => {
  it('scopes perception to DOM subtree descendants for long live logs', async () => {
    const pageMeta = JSON.stringify({
      title: 'Scoped Log',
      url: 'https://example.test/log',
      vw: 800,
      vh: 600,
      scrollY: 0,
      scrollMax: 0,
      focused: 'none',
      counts: {},
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
    });
    const fullAxTree = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Scoped Log' }, backendDOMNodeId: 100 },
      { nodeId: '2', parentId: '1', role: { value: 'StaticText' }, name: { value: 'Sticky toolbar' }, backendDOMNodeId: 200 },
      { nodeId: '3', parentId: '1', role: { value: 'region' }, name: { value: 'Event log' }, backendDOMNodeId: 300 },
      { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: 'old log row' } },
      { nodeId: '5', parentId: '3', role: { value: 'StaticText' }, name: { value: 'hmr panel ready' } },
      { nodeId: '6', parentId: '1', role: { value: 'button' }, name: { value: 'Run diagnostic' }, backendDOMNodeId: 400 },
    ];
    const unscopedSkeleton = fullAxTree.filter(node => node.nodeId !== '4' && node.nodeId !== '5');
    const cdp = createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 10 } }),
      'DOM.querySelector': (_params) => ({ nodeId: 30 }),
      'DOM.describeNode': () => ({
        node: {
          nodeId: 30,
          backendNodeId: 300,
          children: [
            { nodeId: 31, backendNodeId: 301 },
            { nodeId: 32, backendNodeId: 302 },
          ],
        },
      }),
      'Accessibility.getFullAXTree': (params) => ({
        nodes: params.backendNodeId ? unscopedSkeleton : fullAxTree,
      }),
      'Runtime.evaluate': () => ({ result: { value: pageMeta } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'button-object' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { x: 0, y: 0, w: 1, h: 1 } } }),
    });

    const out = await T.perceiveStr(
      cdp,
      'sid1',
      new RingBuffer(10),
      new RingBuffer(10),
      new Map(),
      { output: null },
      { selector: '#combat-log', last: 20 },
    );

    expect(out).toContain('hmr panel ready');
    expect(out).not.toContain('Sticky toolbar');
    expect(out).not.toContain('Run diagnostic');
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// Exclude subtree filtering (unit test for the filtering logic)
// =========================================================================

describe('exclude subtree filtering', () => {
  const axNode = (id, role, name, opts = {}) => ({
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
  });

  const domNode = (nodeName, backendNodeId, children = [], attributes = []) => ({
    nodeName,
    backendNodeId,
    children,
    attributes,
  });

  it('should remove excluded node and all descendants', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root', backendDOMNodeId: 100 }),
      axNode('link1', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 101 }),
      axNode('link2', 'link', 'About', { parentId: 'nav', backendDOMNodeId: 102 }),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 200 }),
      axNode('h1', 'heading', 'Title', { parentId: 'main' }),
    ];
    const excluded = new Set([100]); // exclude nav (backendDOMNodeId=100)
    const filtered = filterPerceiveExcludedAxNodes(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'main', 'h1']);
    expect(filtered.find(n => n.nodeId === 'nav')).toBeUndefined();
    expect(filtered.find(n => n.nodeId === 'link1')).toBeUndefined();
    expect(filtered.find(n => n.nodeId === 'link2')).toBeUndefined();
  });

  it('should handle multiple excluded roots', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root', backendDOMNodeId: 100 }),
      axNode('aside', 'complementary', 'Sidebar', { parentId: 'root', backendDOMNodeId: 200 }),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 300 }),
    ];
    const excluded = new Set([100, 200]); // exclude nav and sidebar
    const filtered = filterPerceiveExcludedAxNodes(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'main']);
  });

  it('should return all nodes when no backendDOMNodeId matches', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 300 }),
    ];
    const excluded = new Set([999]); // non-existent
    const filtered = filterPerceiveExcludedAxNodes(nodes, excluded);

    expect(filtered).toHaveLength(2);
  });

  it('should handle deeply nested exclusion', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root', backendDOMNodeId: 100 }),
      axNode('list', 'list', '', { parentId: 'nav' }),
      axNode('item1', 'listitem', 'Item 1', { parentId: 'list' }),
      axNode('item2', 'listitem', 'Item 2', { parentId: 'list' }),
      axNode('sublink', 'link', 'Sub', { parentId: 'item1' }),
    ];
    const excluded = new Set([100]); // exclude nav → should cascade to list, items, sublink
    const filtered = filterPerceiveExcludedAxNodes(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root']);
  });

  it('does not drop main when a header wrapper also matches exclude', () => {
    const main = domNode('MAIN', 3, [domNode('H1', 4)]);
    const nav = domNode('NAV', 2, [domNode('A', 21)]);
    const header = domNode('HEADER', 1, [nav, main]);
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('header', 'banner', 'Chrome', { parentId: 'root', backendDOMNodeId: 1 }),
      axNode('nav', 'navigation', 'Nav', { parentId: 'header', backendDOMNodeId: 2 }),
      axNode('home', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 21 }),
      axNode('main', 'main', 'Article', { parentId: 'header', backendDOMNodeId: 3 }),
      axNode('h1', 'heading', 'Title', { parentId: 'main', backendDOMNodeId: 4 }),
    ];
    const described = new Map([[1, header], [2, nav], [3, main]]);
    const filtered = filterPerceiveExcludedAxNodes(nodes, new Set([1, 2]), described);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'header', 'main', 'h1']);
    expect(filtered.find(n => n.nodeId === 'nav')).toBeUndefined();
    expect(filtered.find(n => n.nodeId === 'home')).toBeUndefined();
  });

  it('still removes a real nav sibling that does not wrap main', () => {
    const nav = domNode('NAV', 100, [domNode('A', 101)]);
    const main = domNode('MAIN', 200, [domNode('H1', 201)]);
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root', backendDOMNodeId: 100 }),
      axNode('link', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 101 }),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 200 }),
      axNode('h1', 'heading', 'Title', { parentId: 'main', backendDOMNodeId: 201 }),
    ];
    const described = new Map([[100, nav], [200, main]]);
    const filtered = filterPerceiveExcludedAxNodes(nodes, new Set([100]), described);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'main', 'h1']);
  });

  it('keeps a generic wrapper whose DOM contains .mdx-content or article', () => {
    const article = domNode('ARTICLE', 12, [domNode('P', 13)]);
    const wrapper = domNode('DIV', 10, [
      article,
    ], ['class', 'layout-shell']);
    const mdx = domNode('DIV', 22, [domNode('P', 23)], ['class', 'mdx-content prose']);
    const mdxWrapper = domNode('DIV', 20, [mdx], ['class', 'docs-frame']);
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('shell', 'generic', 'Shell', { parentId: 'root', backendDOMNodeId: 10 }),
      axNode('article', 'article', 'Docs', { parentId: 'shell', backendDOMNodeId: 12 }),
      axNode('frame', 'generic', 'Frame', { parentId: 'root', backendDOMNodeId: 20 }),
      axNode('body', 'generic', 'MDX', { parentId: 'frame', backendDOMNodeId: 22 }),
    ];
    const described = new Map([[10, wrapper], [20, mdxWrapper]]);
    const filtered = filterPerceiveExcludedAxNodes(nodes, new Set([10, 20]), described);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'shell', 'article', 'frame', 'body']);
  });
});

// =========================================================================
// Diff compact: StaticText noise filtering
// =========================================================================

describe('diff compact filtering', () => {
  const isTextOnly = l => /^\s*\[StaticText\]/.test(l);

  it('should classify [StaticText] lines as text-only', () => {
    expect(isTextOnly('  [StaticText] "Hello"')).toBe(true);
    expect(isTextOnly('[StaticText] "World"')).toBe(true);
    expect(isTextOnly('    [StaticText] "deeply indented"')).toBe(true);
  });

  it('should not classify structural lines as text-only', () => {
    expect(isTextOnly('  [button] "Submit" @1')).toBe(false);
    expect(isTextOnly('  [navigation] "Nav"')).toBe(false);
    expect(isTextOnly('  [heading] "Title"')).toBe(false);
    expect(isTextOnly('  [link] "Home" @2')).toBe(false);
    expect(isTextOnly('  [textbox] "Search" @3')).toBe(false);
  });

  it('should separate structural from text-only changes', () => {
    const removed = [
      '  [StaticText] "old text 1"',
      '  [button] "Old Button" @5',
      '  [StaticText] "old text 2"',
    ];
    const added = [
      '  [StaticText] "new text 1"',
      '  [StaticText] "new text 2"',
      '  [StaticText] "new text 3"',
      '  [link] "New Link" @7',
    ];
    const removedStructural = removed.filter(l => !isTextOnly(l));
    const addedStructural = added.filter(l => !isTextOnly(l));
    const removedText = removed.length - removedStructural.length;
    const addedText = added.length - addedStructural.length;

    expect(removedStructural).toEqual(['  [button] "Old Button" @5']);
    expect(addedStructural).toEqual(['  [link] "New Link" @7']);
    expect(removedText).toBe(2);
    expect(addedText).toBe(3);
  });
});

// =========================================================================
// snapshotStr — perceive hint
// =========================================================================

describe('snapshotStr', () => {
  it('should append perceive recommendation hint', async () => {
    const cdp = createMockCDP({
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test Page' } },
          { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Hello' } },
        ],
      }),
    });
    const result = await snapshotStr(cdp, 'sid1', true);
    expect(result).toContain('[RootWebArea]');
    expect(result).toContain('[heading] Hello');
    // Critical: the hint must be present
    expect(result).toMatch(/perceive/i);
    expect(result).toMatch(/recommended/i);
  });

  it('should include hint even for empty AX tree', async () => {
    const cdp = createMockCDP({
      'Accessibility.getFullAXTree': () => ({ nodes: [] }),
    });
    const result = await snapshotStr(cdp, 'sid1', true);
    expect(result).toMatch(/perceive/i);
  });
});

// =========================================================================
// perceivePageScript — extracted browser-side script
// =========================================================================

describe('perceivePageScript', () => {
  it('should return a string containing a self-invoking function', () => {
    const script = perceivePageScript(false);
    expect(typeof script).toBe('string');
    expect(script).toMatch(/^\(function\(\)/);
    expect(script).toMatch(/\)\(\)$/);
  });

  it('should interpolate cursorInteractive=false to disable scan', () => {
    const script = perceivePageScript(false);
    expect(script).toContain('if (false)');
    expect(script).not.toContain('if (true)');
  });

  it('should interpolate cursorInteractive=true to enable scan', () => {
    const script = perceivePageScript(true);
    expect(script).toContain('if (true)');
  });

  it('should use targeted selector instead of querySelectorAll("*")', () => {
    const script = perceivePageScript(true);
    // The optimized version uses specific tag selectors, not wildcard *
    expect(script).not.toContain("querySelectorAll('*')");
    // Should target common clickable container elements
    expect(script).toContain('div, span, li');
    expect(script).toContain('[onclick]');
    expect(script).toContain('[tabindex]');
  });

  it('should collect layout map, style hints, and counts', () => {
    const script = perceivePageScript(false);
    expect(script).toContain('layoutMap');
    expect(script).toContain('styleHints');
    expect(script).toContain('counts');
    expect(script).toContain('cursorInteractives');
  });
});

// =========================================================================
// perceiveStr — integration test with mock CDP
// =========================================================================

describe('perceiveStr integration', () => {
  // Minimal page metadata that perceivePageScript would return from the browser
  const fakeMeta = JSON.stringify({
    title: 'Test Page', url: 'https://example.com',
    vw: 1280, vh: 720, scrollY: 0, scrollMax: 500,
    counts: { a: 2, button: 1 },
    focused: 'none',
    layoutMap: {
      banner: [{ h: 80, bg: 'rgb(26,26,46)', vis: 'above' }],
      main: [{ h: 2000 }],
    },
    styleHints: {},
    cursorInteractives: [],
  });

  // Minimal AX tree with a banner, main, link, and button
  const fakeAxNodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test Page' } },
    { nodeId: '2', parentId: '1', role: { value: 'banner' }, name: { value: 'Site Header' }, backendDOMNodeId: 100 },
    { nodeId: '3', parentId: '2', role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 101 },
    { nodeId: '4', parentId: '1', role: { value: 'main' }, name: { value: 'Content' }, backendDOMNodeId: 102 },
    { nodeId: '5', parentId: '4', role: { value: 'heading' }, name: { value: 'Welcome' }, backendDOMNodeId: 103 },
    { nodeId: '6', parentId: '4', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 104 },
  ];

  it('should produce header with page title, URL, viewport, and console health', async () => {
    const refMap = new Map();
    // Use buildPerceiveTree directly since perceiveStr needs real evalStr
    const { treeLines, refNodeIds } = buildPerceiveTree(fakeAxNodes, JSON.parse(fakeMeta), refMap, {});

    expect(treeLines.length).toBeGreaterThan(0);
    // Should have @refs for interactive elements (link + button)
    expect(refNodeIds.length).toBe(2);
    expect(refMap.size).toBe(2);
  });

  it('should assign @ref to link and button but not heading or banner', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const { refNodeIds } = buildPerceiveTree(fakeAxNodes, meta, refMap, {});

    // link and button get refs
    const refBackendIds = refNodeIds.map(r => r.backendDOMNodeId);
    expect(refBackendIds).toContain(101); // link "Home"
    expect(refBackendIds).toContain(104); // button "Submit"
    // banner and heading do NOT get refs
    expect(refBackendIds).not.toContain(100);
    expect(refBackendIds).not.toContain(103);
  });

  it('should include layout annotations on enriched roles', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, {});
    const bannerLine = treeLines.find(l => l.includes('[banner]'));
    expect(bannerLine).toBeDefined();
    // Banner has height and bg from layout map
    expect(bannerLine).toContain('↕80px');
    expect(bannerLine).toContain('bg:rgb(26,26,46)');
  });

  it('should respect --interactive mode (only show interactive elements)', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, { interactiveOnly: true });
    // Should include link and button
    const hasLink = treeLines.some(l => l.includes('[link]'));
    const hasButton = treeLines.some(l => l.includes('[button]'));
    expect(hasLink).toBe(true);
    expect(hasButton).toBe(true);
    // Should NOT include heading (it's not interactive, not enriched in this context)
    // (heading IS in ENRICHED_ROLES so it still shows as structural parent)
  });

  it('should respect maxDepth limit', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    // Depth 0 = only roots
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, { maxDepth: 0 });
    // Only root-level node should be in output
    const lines = treeLines.filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[RootWebArea]');
    // But refs should still be assigned (even beyond depth)
    expect(refMap.size).toBe(2);
  });

  it('diff mode should report no changes when tree is identical', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const store = { output: null };

    // Build a fake "first perceive" output manually
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, {});
    const header = [
      `Page: Test Page — https://example.com`,
      `Viewport: 1280×720 | Scroll: 0/500 (0%) | Focused: none`,
      `Interactive: 2 a, 1 button`,
      `Console: clean`,
    ];
    store.output = [...header, '', ...treeLines].join('\n');

    // Build same tree again for diff — should detect no changes
    const refMap2 = new Map();
    const { treeLines: treeLines2 } = buildPerceiveTree(fakeAxNodes, meta, refMap2, {});
    const output2 = [...header, '', ...treeLines2].join('\n');
    const prev = store.output.split('\n');
    const curr = output2.split('\n');
    const prevTree = prev.slice(4);
    const currTree = curr.slice(4);
    const prevSet = new Set(prevTree);
    const currSet = new Set(currTree);
    const removed = prevTree.filter(l => !currSet.has(l));
    const added = currTree.filter(l => !prevSet.has(l));
    expect(removed.length).toBe(0);
    expect(added.length).toBe(0);
  });
});

// =========================================================================
// parsePerceiveArgs — --keep-refs / --last
// =========================================================================

describe('parsePerceiveArgs (keep-refs/last)', () => {
  it('parses --keep-refs', () => {
    expect(T.parsePerceiveArgs(['--keep-refs']).keepRefs).toBe(true);
  });

  it('parses --last with a numeric argument', () => {
    expect(T.parsePerceiveArgs(['--last', '20']).last).toBe(20);
  });

  it('treats --last with a non-numeric argument as null', () => {
    expect(T.parsePerceiveArgs(['--last', 'xyz']).last).toBeNull();
  });

  it('parses --cards as a known compact feed flag', () => {
    expect(T.parsePerceiveArgs(['--cards']).cards).toBe(true);
    expect(T.parsePerceiveArgs([]).cards).toBe(false);
  });

  it('treats --role feed as an alias for --cards', () => {
    expect(T.parsePerceiveArgs(['--role', 'feed']).cards).toBe(true);
    expect(T.parsePerceiveArgs(['--role', 'dialog']).cards).toBe(false);
  });
});

describe('perceiveStr --cards', () => {
  it('returns compact feed cards from fake AX articles without a full a11y dump', async () => {
    const meta = {
      title: 'Home',
      url: 'https://x.com/home',
      vw: 1280,
      vh: 900,
      scrollY: 0,
      scrollMax: 4000,
      counts: { article: 2 },
      focused: 'none',
      layoutMap: { main: [{ h: 2000 }] },
      styleHints: {},
      cursorInteractives: [],
    };
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify(meta) } }),
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Home' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { value: 'main' }, name: { value: 'Timeline' }, childIds: ['3'] },
          {
            nodeId: '3', parentId: '2', role: { value: 'article' }, name: { value: '@alice first visible post' },
            backendDOMNodeId: 31,
            childIds: ['4'],
            properties: [],
          },
          {
            nodeId: '4', parentId: '3', role: { value: 'link' }, name: { value: 'Show this post' },
            properties: [{ name: 'url', value: { value: 'https://x.com/alice/status/1' } }],
          },
          {
            nodeId: '5', parentId: '2', role: { value: 'article' }, name: { value: '@bob second visible post' },
            backendDOMNodeId: 51,
            childIds: ['6'],
          },
          {
            nodeId: '6', parentId: '5', role: { value: 'link' }, name: { value: 'Show this post' },
            properties: [{ name: 'url', value: { value: 'https://x.com/bob/status/2' } }],
          },
        ],
      }),
    });
    const refMap = new Map();
    const out = await T.perceiveStr(
      cdp,
      'sid1',
      new RingBuffer(5),
      new RingBuffer(5),
      refMap,
      { output: null },
      { cards: true, targetPrefix: 'ABC12345' },
    );
    expect(out).toContain('chrome-cdp-ex.cards.v1');
    expect(out).toContain('@alice');
    expect(out).toContain('https://x.com/alice/status/1');
    expect(out).toMatch(/virtualized/i);
    expect(out).not.toContain('[banner]');
    expect(out).not.toContain('RootWebArea');
    expect(refMap.get(1)).toBe(31);

    const json = await T.perceiveStr(
      cdp,
      'sid1',
      new RingBuffer(5),
      new RingBuffer(5),
      new Map(),
      { output: null },
      { cards: true, format: 'json', targetPrefix: 'ABC12345' },
    );
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('chrome-cdp-ex.cards.v1');
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.virtualized).toBe(true);
    expect(parsed.next).toMatch(/scroll and re-run --cards/i);
  });
});
