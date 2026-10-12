import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, shouldShowAxNode, formatAxNode, orderedAxChildren, buildPerceiveTree, perceiveStr, parseControlsArgs, visibleControlsPageScript, controlsStr, formatVisibleControlsText } = T;

// =========================================================================
// shouldShowAxNode
// =========================================================================

describe('shouldShowAxNode', () => {
  const node = (role, name, value) => ({
    role: { value: role },
    name: { value: name },
    value: value !== undefined ? { value } : undefined,
  });

  it('should hide role=none', () => {
    expect(shouldShowAxNode(node('none', 'text'))).toBe(false);
  });

  it('should hide role=generic with empty name and no value', () => {
    expect(shouldShowAxNode(node('generic', ''))).toBe(false);
  });

  it('should hide role=generic even with non-empty name', () => {
    // generic is always filtered out (role === 'generic' check comes first)
    expect(shouldShowAxNode(node('generic', 'wrapper'))).toBe(false);
  });

  it('should show meaningful roles with name', () => {
    expect(shouldShowAxNode(node('button', 'Submit'))).toBe(true);
    expect(shouldShowAxNode(node('link', 'Home'))).toBe(true);
  });

  it('should show node with empty name but non-empty value', () => {
    expect(shouldShowAxNode(node('textbox', '', 'hello'))).toBe(true);
  });

  it('should show unnamed empty interactive controls so they can receive @refs', () => {
    expect(shouldShowAxNode(node('textbox', '', ''))).toBe(true);
    expect(shouldShowAxNode(node('checkbox', ''))).toBe(true);
    expect(shouldShowAxNode(node('radio', ''))).toBe(true);
    expect(shouldShowAxNode(node('listbox', ''))).toBe(true);
  });

  it('should still hide unnamed empty non-interactive nodes', () => {
    expect(shouldShowAxNode(node('paragraph', '', ''))).toBe(false);
    expect(shouldShowAxNode(node('StaticText', ''))).toBe(false);
  });

  it('should hide InlineTextBox in compact mode', () => {
    expect(shouldShowAxNode(node('InlineTextBox', 'text'), true)).toBe(false);
  });

  it('should show InlineTextBox in non-compact mode', () => {
    expect(shouldShowAxNode(node('InlineTextBox', 'text'), false)).toBe(true);
  });

  it('should hide StaticText duplicating parent name in compact mode', () => {
    const parent = node('link', 'Click Here');
    const child = node('StaticText', 'Click Here');
    expect(shouldShowAxNode(child, true, parent)).toBe(false);
  });

  it('should hide StaticText that is substring of parent name in compact mode', () => {
    const parent = node('link', 'Hello World');
    const child = node('StaticText', 'Hello');
    expect(shouldShowAxNode(child, true, parent)).toBe(false);
  });

  it('should show StaticText with different name than parent in compact mode', () => {
    const parent = node('link', 'Home');
    const child = node('StaticText', 'Something else');
    expect(shouldShowAxNode(child, true, parent)).toBe(true);
  });
});

// =========================================================================
// formatAxNode
// =========================================================================

describe('formatAxNode', () => {
  const node = (role, name, value) => ({
    role: { value: role },
    name: { value: name },
    value: value !== undefined ? { value } : undefined,
  });

  it('should format [role] name', () => {
    expect(formatAxNode(node('button', 'OK'), 0)).toBe('[button] OK');
  });

  it('should include value as JSON string', () => {
    expect(formatAxNode(node('textbox', 'Email', 'user@test.com'), 0))
      .toBe('[textbox] Email = "user@test.com"');
  });

  it('should omit value when empty string', () => {
    expect(formatAxNode(node('textbox', 'Email', ''), 0))
      .toBe('[textbox] Email');
  });

  it('should include checkbox checked state', () => {
    expect(formatAxNode({
      role: { value: 'checkbox' },
      name: { value: '' },
      checked: { value: false },
    }, 0)).toBe('[checkbox] checked=false');
    expect(formatAxNode({
      role: { value: 'checkbox' },
      name: { value: '' },
      checked: { value: true },
    }, 0)).toBe('[checkbox] checked=true');
  });

  it('should include selected option markers', () => {
    expect(formatAxNode({
      role: { value: 'option' },
      name: { value: 'B' },
      selected: { value: true },
    }, 0)).toBe('[option] B selected');
  });

  it('should omit name when empty', () => {
    expect(formatAxNode(node('generic', '', 'val'), 0))
      .toBe('[generic] = "val"');
  });

  it('should indent 2 spaces per depth level', () => {
    const result = formatAxNode(node('button', 'OK'), 3);
    expect(result).toBe('      [button] OK');
  });

  it('should cap indent at depth 10', () => {
    const d10 = formatAxNode(node('button', 'OK'), 10);
    const d15 = formatAxNode(node('button', 'OK'), 15);
    expect(d10).toBe(d15); // both capped at 20 spaces
    expect(d10.startsWith('                    [')).toBe(true); // 20 spaces
  });
});

// =========================================================================
// orderedAxChildren
// =========================================================================

describe('orderedAxChildren', () => {
  it('should return children from childIds first', () => {
    const a = { nodeId: 'a' };
    const b = { nodeId: 'b' };
    const nodesById = new Map([['a', a], ['b', b]]);
    const childrenByParent = new Map();
    const parent = { nodeId: 'p', childIds: ['a', 'b'] };
    const result = orderedAxChildren(parent, nodesById, childrenByParent);
    expect(result).toEqual([a, b]);
  });

  it('should append childrenByParent entries after childIds', () => {
    const a = { nodeId: 'a' };
    const c = { nodeId: 'c' };
    const nodesById = new Map([['a', a]]);
    const childrenByParent = new Map([['p', [c]]]);
    const parent = { nodeId: 'p', childIds: ['a'] };
    const result = orderedAxChildren(parent, nodesById, childrenByParent);
    expect(result).toEqual([a, c]);
  });

  it('should deduplicate nodes appearing in both sources', () => {
    const a = { nodeId: 'a' };
    const nodesById = new Map([['a', a]]);
    const childrenByParent = new Map([['p', [a]]]);
    const parent = { nodeId: 'p', childIds: ['a'] };
    const result = orderedAxChildren(parent, nodesById, childrenByParent);
    expect(result).toHaveLength(1);
  });

  it('should return empty array for node with no children', () => {
    const nodesById = new Map();
    const childrenByParent = new Map();
    const parent = { nodeId: 'p' };
    expect(orderedAxChildren(parent, nodesById, childrenByParent)).toEqual([]);
  });

  it('should skip childIds not found in nodesById', () => {
    const nodesById = new Map();
    const childrenByParent = new Map();
    const parent = { nodeId: 'p', childIds: ['missing'] };
    expect(orderedAxChildren(parent, nodesById, childrenByParent)).toEqual([]);
  });
});

// =========================================================================
// buildPerceiveTree — core tree-building logic (extracted from perceiveStr)
// =========================================================================

describe('buildPerceiveTree', () => {
  // Helper to build AX nodes quickly
  const axNode = (id, role, name, opts = {}) => ({
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.childIds ? { childIds: opts.childIds } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
    ...(opts.value !== undefined ? { value: { value: opts.value } } : {}),
  });

  const emptyMeta = { layoutMap: {}, styleHints: {} };

  // ─── Basic tree rendering ─────────────────────────────────

  it('should render a simple tree with roles and names', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Test Page'),
      axNode('nav', 'navigation', 'Main Nav', { parentId: 'root' }),
      axNode('link1', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 101 }),
      axNode('main', 'main', '', { parentId: 'root' }),
      axNode('h1', 'heading', 'Welcome', { parentId: 'main' }),
    ];
    nodes[0].childIds = ['nav', 'main'];
    nodes[1].childIds = ['link1'];
    nodes[3].childIds = ['h1'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);

    expect(treeLines.join('\n')).toContain('[WebArea] Test Page');
    expect(treeLines.join('\n')).toContain('[navigation] Main Nav');
    expect(treeLines.join('\n')).toContain('[link] Home');
    expect(treeLines.join('\n')).toContain('[heading] Welcome');
  });

  // ─── @ref assignment ──────────────────────────────────────

  it('should assign @ref indices to interactive elements', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('btn', 'button', 'Submit', { parentId: 'root', backendDOMNodeId: 201 }),
      axNode('link', 'link', 'Help', { parentId: 'root', backendDOMNodeId: 202 }),
      axNode('input', 'textbox', 'Email', { parentId: 'root', backendDOMNodeId: 203 }),
    ];
    nodes[0].childIds = ['btn', 'link', 'input'];

    const refMap = new Map();
    const { treeLines, refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap);

    // Should have @1, @2, @3 refs
    expect(refMap.size).toBe(3);
    expect(refMap.get(1)).toBe(201);
    expect(refMap.get(2)).toBe(202);
    expect(refMap.get(3)).toBe(203);

    // Tree lines should contain @ref markers
    const output = treeLines.join('\n');
    expect(output).toContain('@1');
    expect(output).toContain('@2');
    expect(output).toContain('@3');

    // refNodeIds for batch rect resolution
    expect(refNodeIds).toHaveLength(3);
    expect(refNodeIds[0]).toEqual({ ref: 1, backendDOMNodeId: 201 });
  });

  it('should assign @refs to unnamed empty textboxes, checkboxes, and radios', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('btn', 'button', 'outer-btn', { parentId: 'root', backendDOMNodeId: 301 }),
      axNode('input', 'textbox', '', { parentId: 'root', backendDOMNodeId: 302 }),
      axNode('cb', 'checkbox', '', { parentId: 'root', backendDOMNodeId: 303 }),
      axNode('r1', 'radio', '', { parentId: 'root', backendDOMNodeId: 304 }),
    ];
    nodes[0].childIds = ['btn', 'input', 'cb', 'r1'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);
    const output = treeLines.join('\n');

    expect(refMap.size).toBe(4);
    expect(refMap.get(1)).toBe(301);
    expect(refMap.get(2)).toBe(302);
    expect(refMap.get(3)).toBe(303);
    expect(refMap.get(4)).toBe(304);
    expect(output).toContain('[button] outer-btn  @1');
    expect(output).toMatch(/\[textbox\].*@2/);
    expect(output).toMatch(/\[checkbox\].*@3/);
    expect(output).toMatch(/\[radio\].*@4/);
  });

  it('should not assign @ref to non-interactive elements', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('h1', 'heading', 'Title', { parentId: 'root', backendDOMNodeId: 300 }),
      axNode('p', 'paragraph', 'Text', { parentId: 'root', backendDOMNodeId: 301 }),
    ];
    nodes[0].childIds = ['h1', 'p'];

    const refMap = new Map();
    const { refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap);
    expect(refMap.size).toBe(0);
    expect(refNodeIds).toHaveLength(0);
  });

  it('should not assign @ref to interactive elements without backendDOMNodeId', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('btn', 'button', 'Click', { parentId: 'root' }), // no backendDOMNodeId
    ];
    nodes[0].childIds = ['btn'];

    const refMap = new Map();
    buildPerceiveTree(nodes, emptyMeta, refMap);
    expect(refMap.size).toBe(0);
  });

  it('should clear refMap before rebuilding', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('btn', 'button', 'OK', { parentId: 'root', backendDOMNodeId: 100 }),
    ];
    nodes[0].childIds = ['btn'];

    const refMap = new Map([[99, 999]]); // pre-existing entry
    buildPerceiveTree(nodes, emptyMeta, refMap);
    expect(refMap.has(99)).toBe(false); // old entry cleared
    expect(refMap.has(1)).toBe(true);   // new entry added
  });

  // ─── Depth limit ──────────────────────────────────────────

  it('should respect maxDepth and hide deeper nodes', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root' }),
      axNode('link', 'link', 'Deep Link', { parentId: 'nav', backendDOMNodeId: 400 }),
    ];
    nodes[0].childIds = ['nav'];
    nodes[1].childIds = ['link'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap, { maxDepth: 1 });

    const output = treeLines.join('\n');
    expect(output).toContain('[navigation] Nav');
    expect(output).not.toContain('Deep Link'); // depth 2 > maxDepth 1
  });

  it('should still collect refs for interactive elements beyond depth limit', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root' }),
      axNode('link', 'link', 'Deep', { parentId: 'nav', backendDOMNodeId: 401 }),
    ];
    nodes[0].childIds = ['nav'];
    nodes[1].childIds = ['link'];

    const refMap = new Map();
    const { refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap, { maxDepth: 1 });

    // Ref still collected even though node is hidden
    expect(refMap.size).toBe(1);
    expect(refNodeIds).toHaveLength(1);
    expect(refNodeIds[0].backendDOMNodeId).toBe(401);
  });

  // ─── Interactive-only mode ────────────────────────────────

  it('should filter non-interactive non-structural nodes in interactive mode', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('main', 'main', 'Content', { parentId: 'root' }),
      axNode('para', 'paragraph', 'Some text', { parentId: 'main' }),
      axNode('btn', 'button', 'Action', { parentId: 'para', backendDOMNodeId: 500 }),
    ];
    nodes[0].childIds = ['main'];
    nodes[1].childIds = ['para'];
    nodes[2].childIds = ['btn'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap, { interactiveOnly: true });

    const output = treeLines.join('\n');
    expect(output).toContain('[button] Action');
    expect(output).toContain('[main] Content'); // structural parent kept
    expect(output).not.toContain('paragraph'); // non-interactive, non-structural filtered
  });

  // ─── Table row truncation ─────────────────────────────────

  it('should truncate table rows beyond limit of 5', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('tbl', 'table', 'Data', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['tbl'];
    const rowIds = [];
    for (let i = 0; i < 8; i++) {
      const rowId = `row${i}`;
      const cellId = `cell${i}`;
      rowIds.push(rowId);
      nodes.push(axNode(rowId, 'row', '', { parentId: 'tbl' }));
      nodes.push(axNode(cellId, 'cell', `Value ${i}`, { parentId: rowId }));
      nodes[nodes.length - 2].childIds = [cellId];
    }
    nodes[1].childIds = rowIds;

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);

    const output = treeLines.join('\n');
    // First 5 rows should be visible
    expect(output).toContain('Value 0');
    expect(output).toContain('Value 4');
    // Row 5+ should be truncated
    expect(output).not.toContain('Value 5');
    expect(output).not.toContain('Value 7');
    // Truncation notice
    expect(output).toContain('... more rows truncated');
  });

  // ─── Icon image filtering ────────────────────────────────

  it('should filter decorative icon images', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('icon1', 'image', 'check-circle', { parentId: 'root' }),  // filtered: short, lowercase, no space
      axNode('icon2', 'image', 'thunderbolt', { parentId: 'root' }),   // filtered
      axNode('hero', 'image', 'Hero Banner Photo', { parentId: 'root' }), // kept: has space
      axNode('logo', 'image', 'CompanyLogo', { parentId: 'root' }),    // kept: has uppercase
    ];
    nodes[0].childIds = ['icon1', 'icon2', 'hero', 'logo'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);

    const output = treeLines.join('\n');
    expect(output).not.toContain('check-circle');
    expect(output).not.toContain('thunderbolt');
    expect(output).toContain('Hero Banner Photo');
    expect(output).toContain('CompanyLogo');
  });

  // ─── Layout annotations ──────────────────────────────────

  it('should annotate enriched roles with layout info', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('banner', 'banner', 'Header', { parentId: 'root' }),
      axNode('main', 'main', 'Content', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['banner', 'main'];

    const meta = {
      layoutMap: {
        banner: [{ h: 80, bg: 'rgb(0,0,0)', vis: 'above' }],
        main: [{ h: 2000, display: 'flex', gap: '20px' }],
      },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    const output = treeLines.join('\n');

    expect(output).toContain('↕80px');
    expect(output).toContain('bg:rgb(0,0,0)');
    expect(output).toContain('↑above fold');
    expect(output).toContain('↕2000px');
    expect(output).toContain('flex gap:20px');
  });

  it('should annotate with width×height when element is narrow', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('aside', 'complementary', 'Sidebar', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['aside'];

    const meta = {
      layoutMap: { complementary: [{ w: 300, h: 800 }] },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    expect(treeLines.join('\n')).toContain('300×800px');
  });

  it('should annotate below-fold visibility', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('footer', 'contentinfo', 'Footer', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['footer'];

    const meta = {
      layoutMap: { contentinfo: [{ h: 160, vis: 'below' }] },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    expect(treeLines.join('\n')).toContain('↓below fold');
  });

  // ─── Table style hints ────────────────────────────────────

  it('should annotate table cells with style hints', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('tbl', 'table', 'Prices', { parentId: 'root' }),
      axNode('row0', 'row', '', { parentId: 'tbl' }),
      axNode('cell0', 'cell', '$29.99', { parentId: 'row0' }),
    ];
    nodes[0].childIds = ['tbl'];
    nodes[1].childIds = ['row0'];
    nodes[2].childIds = ['cell0'];

    const meta = {
      layoutMap: {},
      styleHints: { '0:0:0': 'bold color:rgb(0,128,0)' },
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    expect(treeLines.join('\n')).toContain('bold color:rgb(0,128,0)');
  });

  // ─── Node filtering (none, generic, duplicate StaticText) ─

  it('should hide none and generic role nodes but show their children', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('wrap', 'generic', '', { parentId: 'root' }),
      axNode('btn', 'button', 'OK', { parentId: 'wrap', backendDOMNodeId: 600 }),
    ];
    nodes[0].childIds = ['wrap'];
    nodes[1].childIds = ['btn'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);
    const output = treeLines.join('\n');

    expect(output).not.toContain('generic');
    expect(output).toContain('[button] OK');
    expect(refMap.size).toBe(1);
  });

  // ─── Orphan node handling ─────────────────────────────────

  it('should handle nodes without parentId (multiple roots)', () => {
    const nodes = [
      axNode('r1', 'WebArea', 'Page 1'),
      axNode('r2', 'banner', 'Header'),
    ];
    // Both are roots (no parentId)

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);
    const output = treeLines.join('\n');
    expect(output).toContain('[WebArea] Page 1');
    expect(output).toContain('[banner] Header');
  });

  // ─── Empty tree ───────────────────────────────────────────

  it('should handle empty node list', () => {
    const refMap = new Map();
    const { treeLines, refNodeIds } = buildPerceiveTree([], emptyMeta, refMap);
    expect(treeLines).toEqual([]);
    expect(refNodeIds).toEqual([]);
  });

  // ─── Complex scenario: realistic page structure ───────────

  it('should handle a realistic page with nav, main, footer, and interactive elements', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Store'),
      axNode('banner', 'banner', 'Site Header', { parentId: 'root' }),
      axNode('nav', 'navigation', 'Main Menu', { parentId: 'banner' }),
      axNode('l1', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 1 }),
      axNode('l2', 'link', 'Products', { parentId: 'nav', backendDOMNodeId: 2 }),
      axNode('main', 'main', 'Content', { parentId: 'root' }),
      axNode('h1', 'heading', 'Welcome', { parentId: 'main' }),
      axNode('region', 'region', 'Product Grid', { parentId: 'main' }),
      axNode('l3', 'link', 'Product 1', { parentId: 'region', backendDOMNodeId: 3 }),
      axNode('btn', 'button', 'Add to Cart', { parentId: 'region', backendDOMNodeId: 4 }),
      axNode('footer', 'contentinfo', 'Site Footer', { parentId: 'root' }),
      axNode('l4', 'link', 'Privacy', { parentId: 'footer', backendDOMNodeId: 5 }),
    ];
    nodes[0].childIds = ['banner', 'main', 'footer'];
    nodes[1].childIds = ['nav'];
    nodes[2].childIds = ['l1', 'l2'];
    nodes[5].childIds = ['h1', 'region'];
    nodes[7].childIds = ['l3', 'btn'];
    nodes[10].childIds = ['l4'];

    const meta = {
      layoutMap: {
        banner: [{ h: 80, bg: 'rgb(26,26,46)' }],
        main: [{ h: 2920 }],
        heading: [{ h: 50 }],
        region: [{ h: 800, display: 'grid', gap: '20px' }],
        contentinfo: [{ h: 160, bg: 'rgb(26,26,46)', vis: 'below' }],
      },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines, refNodeIds } = buildPerceiveTree(nodes, meta, refMap);
    const output = treeLines.join('\n');

    // Structure
    expect(output).toContain('[WebArea] Store');
    expect(output).toContain('[banner] Site Header');
    expect(output).toContain('[navigation] Main Menu');
    expect(output).toContain('[main] Content');
    expect(output).toContain('[heading] Welcome');
    expect(output).toContain('[contentinfo] Site Footer');

    // Interactive refs: content/article first, nav chrome later (#163)
    expect(output).toContain('[link] Product 1  @1');
    expect(output).toContain('[button] Add to Cart  @2');
    expect(output).toContain('[link] Privacy  @3');
    expect(output).toContain('[link] Home  @4');
    expect(output).toContain('[link] Products  @5');

    // Layout annotations
    expect(output).toContain('bg:rgb(26,26,46)');
    expect(output).toContain('↕2920px');
    expect(output).toContain('grid gap:20px');
    expect(output).toContain('↓below fold');

    // Ref map
    expect(refMap.size).toBe(5);
    expect(refNodeIds).toHaveLength(5);
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


describe('visible controls inspector', () => {
  const controlsModel = {
    schema: 'chrome-cdp-ex.visible-controls.v1',
    scope: '#composer',
    filter: null,
    limit: 10,
    total: 2,
    returned: 2,
    truncated: false,
    controls: [
      {
        tag: 'textarea',
        role: 'textbox',
        label: 'Ask anything',
        text: '',
        disabled: false,
        clickable: true,
        rect: { x: 80, y: 520, w: 620, h: 44 },
        selector: 'textarea#prompt',
        hints: { id: 'prompt', classes: ['composer-input'] },
      },
      {
        tag: 'button',
        role: 'button',
        ariaLabel: '編輯',
        label: '編輯',
        text: '',
        disabled: false,
        clickable: true,
        rect: { x: 720, y: 524, w: 44, h: 36 },
        selector: 'button[aria-label="編輯"]',
        hints: { classes: ['icon-button'] },
      },
    ],
  };

  it('registers controls as a target command with text and JSON output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'controls',
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('parses scope, filter, and limit arguments', () => {
    expect(parseControlsArgs(['-s', '#composer', '--filter', 'edit', '--limit', '10'])).toEqual({
      selector: '#composer',
      filter: 'edit',
      limit: 10,
      compact: false,
    });
  });

  it('rejects controls flags that are missing required values', () => {
    expect(() => parseControlsArgs(['--selector'])).toThrow(/--selector requires a CSS selector/);
    expect(() => parseControlsArgs(['--filter'])).toThrow(/--filter requires text/);
    expect(() => parseControlsArgs(['--limit'])).toThrow(/--limit requires a positive integer/);
    expect(() => parseControlsArgs(['--limit', '0'])).toThrow(/--limit requires a positive integer/);
  });

  it('formats a compact scoped visible-controls inventory', () => {
    const out = formatVisibleControlsText(controlsModel);
    expect(out).toContain('Visible controls: 2/2 in #composer');
    expect(out).toContain('textarea role=textbox "Ask anything"');
    expect(out).toContain('button role=button aria-label="編輯" "編輯"');
    expect(out).toContain('[clickable]');
    expect(out).toContain('(720,524 44×36)');
    expect(out).toContain('button[aria-label="編輯"]');
  });

  it('includes the scoped root when the scope is itself a visible control', () => {
    const button = {
      tagName: 'BUTTON',
      id: 'send',
      className: '',
      disabled: false,
      tabIndex: 0,
      innerText: 'Send',
      textContent: 'Send',
      getAttribute: (name) => ({ role: null, 'aria-label': null, title: null, type: null }[name] ?? null),
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ left: 12, top: 20, right: 92, bottom: 52, width: 80, height: 32 }),
      matches: (selector) => selector.includes('button'),
      querySelectorAll: () => [],
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    globalThis.window = {
      innerWidth: 1200,
      innerHeight: 800,
      CSS: { escape: (value) => String(value) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' }),
    };
    globalThis.document = { querySelector: (selector) => (selector === '#send' ? button : null) };
    globalThis.CSS = globalThis.window.CSS;
    try {
      const model = JSON.parse(globalThis.eval(visibleControlsPageScript({ selector: '#send', limit: 5 })));
      expect(model.controls).toHaveLength(1);
      expect(model.controls[0]).toMatchObject({
        tag: 'button',
        role: 'button',
        label: 'Send',
        selector: 'button#send',
      });
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
    }
  });

  it('returns an invalid-selector model instead of throwing from the page script', () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    globalThis.window = {
      innerWidth: 1200,
      innerHeight: 800,
      CSS: { escape: (value) => String(value) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' }),
    };
    globalThis.document = {
      querySelector: () => {
        throw new SyntaxError('Invalid selector');
      },
    };
    globalThis.CSS = globalThis.window.CSS;
    try {
      const model = JSON.parse(globalThis.eval(visibleControlsPageScript({ selector: '[bad', limit: 5 })));
      expect(model).toMatchObject({
        schema: 'chrome-cdp-ex.visible-controls.v1',
        scope: '[bad',
        error: 'invalid-selector',
        controls: [],
      });
      expect(model.message).toContain('Invalid selector');
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
    }
  });

  it('treats the first supported token in a multi-token ARIA role as interactive', () => {
    const roleButton = {
      tagName: 'SECTION',
      id: 'save',
      className: '',
      disabled: false,
      tabIndex: -1,
      innerText: 'Save',
      textContent: 'Save',
      getAttribute: (name) => (name === 'role' ? 'button menuitem' : null),
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ left: 16, top: 24, right: 96, bottom: 56, width: 80, height: 32 }),
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    globalThis.window = {
      innerWidth: 1200,
      innerHeight: 800,
      CSS: { escape: (value) => String(value) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'default' }),
    };
    globalThis.document = { querySelectorAll: (selector) => (selector.includes('[role]') ? [roleButton] : []) };
    globalThis.CSS = globalThis.window.CSS;
    try {
      const model = JSON.parse(globalThis.eval(visibleControlsPageScript({ limit: 5 })));
      expect(model.controls).toHaveLength(1);
      expect(model.controls[0]).toMatchObject({
        tag: 'section',
        role: 'button',
        label: 'Save',
        selector: 'section#save',
      });
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
    }
  });

  it('returns text from Runtime.evaluate visible control data', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(false);
        expect(params.returnByValue).toBe(true);
        expect(params.expression).toContain('chrome-cdp-ex.visible-controls.v1');
        expect(params.expression).toContain('#composer');
        return { result: { value: JSON.stringify(controlsModel) } };
      },
    });

    const out = await controlsStr(cdp, 'sid1', { selector: '#composer', limit: 10 });
    expect(out).toContain('Visible controls: 2/2 in #composer');
    expect(out).toContain('button role=button aria-label="編輯"');
  });

  it('turns invalid-selector models into actionable controls errors', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify({
            schema: 'chrome-cdp-ex.visible-controls.v1',
            scope: '[bad',
            filter: null,
            limit: 5,
            total: 0,
            returned: 0,
            truncated: false,
            controls: [],
            error: 'invalid-selector',
            message: 'Invalid selector',
          }),
        },
      }),
    });

    await expect(controlsStr(cdp, 'sid1', { selector: '[bad', limit: 5 })).rejects
      .toThrow('controls: invalid selector: [bad');
  });

  it('returns JSON from Runtime.evaluate visible control data', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify(controlsModel) } }),
    });

    const out = await controlsStr(cdp, 'sid1', { selector: '#composer', limit: 10, format: 'json' });
    expect(JSON.parse(out)).toEqual(controlsModel);
  });

  it('perceive -C includes visible standard controls for dense composers', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify({
            title: 'Dense app',
            url: 'https://app.example.test',
            vw: 900,
            vh: 640,
            scrollY: 0,
            scrollMax: 0,
            counts: { textarea: 1, button: 1 },
            focused: '<textarea#prompt>',
            layoutMap: {},
            styleHints: {},
            cursorInteractives: [],
            visibleControls: controlsModel.controls,
            visibleControlsTruncated: false,
          }),
        },
      }),
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Dense app' }, childIds: ['composer'] },
          { nodeId: 'composer', role: { value: 'textbox' }, name: { value: 'Ask anything' }, backendDOMNodeId: 7 },
        ],
      }),
    });

    const out = await perceiveStr(cdp, 'sid1', new RingBuffer(10), new RingBuffer(10), new Map(), { last: null }, { cursorInteractive: true, maxDepth: 8 });
    expect(out).toContain('[Visible controls]');
    expect(out).toContain('button role=button aria-label="編輯"');
    expect(out).toContain('textarea role=textbox "Ask anything"');
  });
});

// =========================================================================
// buildPerceiveTree — --keep-refs / --last truncation controls
// =========================================================================

describe('buildPerceiveTree truncation controls', () => {
  const { buildPerceiveTree } = T;
  const axNode = (id, role, name, opts = {}) => ({
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.childIds ? { childIds: opts.childIds } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
  });

  it('keeps interactive @ref lines even when --last truncates static text', () => {
    const nodes = [axNode('root', 'WebArea', 'Page')];
    const childIds = [];
    for (let i = 0; i < 60; i++) {
      const id = `t${i}`;
      nodes.push(axNode(id, 'StaticText', `entry ${i}`, { parentId: 'root' }));
      childIds.push(id);
    }
    nodes.push(axNode('btn', 'button', 'Action', { parentId: 'root', backendDOMNodeId: 999 }));
    childIds.push('btn');
    nodes[0].childIds = childIds;

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap, { last: 5 });
    const out = treeLines.join('\n');
    // Ref line for the button always survives
    expect(out).toMatch(/Action/);
    expect(out).toMatch(/@1/);
    // Truncation notice is present
    expect(out).toMatch(/earlier text node\(s\) omitted/);
  });

  it('passes through unmodified when --last is not set', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('s1', 'StaticText', 'a', { parentId: 'root' }),
      axNode('s2', 'StaticText', 'b', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['s1', 's2'];
    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap, {});
    const out = treeLines.join('\n');
    expect(out).toMatch(/a/);
    expect(out).toMatch(/b/);
    expect(out).not.toMatch(/omitted/);
  });

  it('keeps high-signal error text even when it is older than --last', () => {
    const nodes = [axNode('root', 'WebArea', 'Page')];
    const childIds = [];
    nodes.push(axNode('err', 'StaticText', 'Payment failed: card number is required', { parentId: 'root' }));
    childIds.push('err');
    for (let i = 0; i < 40; i++) {
      const id = `noise${i}`;
      nodes.push(axNode(id, 'StaticText', `event log line ${i}`, { parentId: 'root' }));
      childIds.push(id);
    }
    nodes[0].childIds = childIds;

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap, { last: 3 });
    const out = treeLines.join('\n');

    expect(out).toContain('Payment failed: card number is required');
    expect(out).not.toContain('event log line 0');
    expect(out).toContain('event log line 39');
    expect(out).toMatch(/earlier text node\(s\) omitted/);
  });
});
