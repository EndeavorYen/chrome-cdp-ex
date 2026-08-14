import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function axNode(partial) {
  return {
    nodeId: partial.nodeId,
    parentId: partial.parentId,
    role: { value: partial.role },
    name: { value: partial.name || '' },
    backendDOMNodeId: partial.backendDOMNodeId,
    properties: partial.properties || [],
  };
}

function focused(role, extra = {}) {
  return axNode({
    role,
    properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
    ...extra,
  });
}

describe('pickPrimaryScrollMetrics', () => {
  it('reports inner overflow height when the document scroll range is 0', () => {
    const metrics = T.pickPrimaryScrollMetrics([
      { scrollTop: 0, scrollHeight: 800, clientHeight: 800, source: 'document' },
      { scrollTop: 12, scrollHeight: 8000, clientHeight: 800, source: 'inner' },
    ]);
    expect(metrics.scrollMax).toBeGreaterThan(0);
    expect(metrics.scrollMax).toBe(7200);
    expect(metrics.scrollY).toBe(12);
    expect(metrics.source).toBe('inner');
  });

  it('keeps the document scroller when it already has the largest range', () => {
    const metrics = T.pickPrimaryScrollMetrics([
      { scrollTop: 40, scrollHeight: 8727, clientHeight: 800, source: 'document' },
      { scrollTop: 0, scrollHeight: 900, clientHeight: 800, source: 'inner' },
    ]);
    expect(metrics.scrollMax).toBe(7927);
    expect(metrics.scrollY).toBe(40);
    expect(metrics.source).toBe('document');
  });
});

describe('omitTypeaheadListboxNodes', () => {
  const tree = [
    axNode({ nodeId: '1', role: 'RootWebArea', name: 'Music 3', backendDOMNodeId: 1 }),
    focused('searchbox', { nodeId: '2', parentId: '1', name: 'Search models', backendDOMNodeId: 2 }),
    axNode({ nodeId: '3', parentId: '1', role: 'listbox', name: 'Suggestions', backendDOMNodeId: 3 }),
    axNode({ nodeId: '4', parentId: '3', role: 'option', name: 'MiniMax-H3-Turbo', backendDOMNodeId: 4 }),
    axNode({ nodeId: '5', parentId: '3', role: 'option', name: 'MiniMax-M2', backendDOMNodeId: 5 }),
    axNode({ nodeId: '6', parentId: '1', role: 'main', name: 'Model card', backendDOMNodeId: 6 }),
    axNode({ nodeId: '7', parentId: '6', role: 'article', name: 'Music 3', backendDOMNodeId: 7 }),
  ];

  it('omits focused search listbox and option nodes from the default tree', () => {
    const { nodes, omitted } = T.omitTypeaheadListboxNodes(tree);
    expect(omitted).toBe(true);
    const names = nodes.map(n => n.name?.value);
    expect(names).toContain('Music 3');
    expect(names).toContain('Model card');
    expect(names).not.toContain('MiniMax-H3-Turbo');
    expect(names).not.toContain('MiniMax-M2');
    expect(names).not.toContain('Suggestions');
    expect(nodes.some(n => n.role?.value === 'listbox')).toBe(false);
    expect(nodes.some(n => n.role?.value === 'option')).toBe(false);
  });

  it('keeps the listbox when --keep-typeahead is set', () => {
    const { nodes, omitted } = T.omitTypeaheadListboxNodes(tree, { keepTypeahead: true });
    expect(omitted).toBe(false);
    expect(nodes).toHaveLength(tree.length);
    expect(nodes.some(n => n.name?.value === 'MiniMax-H3-Turbo')).toBe(true);
  });

  it('keeps the listbox when -s targets the search input', () => {
    const { nodes, omitted } = T.omitTypeaheadListboxNodes(tree, { selector: 'input[type=search]' });
    expect(omitted).toBe(false);
    expect(nodes.some(n => n.role?.value === 'listbox')).toBe(true);
  });

  it('still omits suggestions when -s main is the recovery scope', () => {
    const { omitted, nodes } = T.omitTypeaheadListboxNodes(tree, { selector: 'main' });
    expect(omitted).toBe(true);
    expect(nodes.some(n => n.name?.value === 'MiniMax-H3-Turbo')).toBe(false);
  });

  it('omits a portaled listbox when only document.activeElement shows a search input', () => {
    const unfocused = tree.map(n => (
      n.nodeId === '2' ? axNode({ nodeId: '2', parentId: '1', role: 'searchbox', name: 'Search models', backendDOMNodeId: 2 }) : n
    ));
    const { omitted, nodes } = T.omitTypeaheadListboxNodes(unfocused, { focusedDesc: '<input#search>' });
    expect(omitted).toBe(true);
    expect(nodes.some(n => n.name?.value === 'MiniMax-H3-Turbo')).toBe(false);
  });

  it('keeps an in-page listbox when a generic textbox is focused', () => {
    const form = [
      axNode({ nodeId: '1', role: 'RootWebArea', name: 'Signup', backendDOMNodeId: 1 }),
      focused('textbox', { nodeId: '2', parentId: '1', name: 'Email', backendDOMNodeId: 2 }),
      axNode({ nodeId: '3', parentId: '1', role: 'listbox', name: 'Country', backendDOMNodeId: 3 }),
      axNode({ nodeId: '4', parentId: '3', role: 'option', name: 'Taiwan', backendDOMNodeId: 4 }),
    ];
    const { omitted, nodes } = T.omitTypeaheadListboxNodes(form);
    expect(omitted).toBe(false);
    expect(nodes.some(n => n.name?.value === 'Taiwan')).toBe(true);
  });

  it('does not treat a focused checkbox-like input as typeahead', () => {
    const form = [
      axNode({ nodeId: '1', role: 'RootWebArea', name: 'Signup', backendDOMNodeId: 1 }),
      axNode({ nodeId: '2', parentId: '1', role: 'listbox', name: 'Country', backendDOMNodeId: 2 }),
      axNode({ nodeId: '3', parentId: '2', role: 'option', name: 'Taiwan', backendDOMNodeId: 3 }),
    ];
    const { omitted, nodes } = T.omitTypeaheadListboxNodes(form, { focusedDesc: '<input#agree>' });
    expect(omitted).toBe(false);
    expect(nodes.some(n => n.name?.value === 'Taiwan')).toBe(true);
  });
});

describe('parsePerceiveArgs keep-typeahead', () => {
  it('defaults keepTypeahead to false and parses --keep-typeahead', () => {
    expect(T.parsePerceiveArgs([]).keepTypeahead).toBe(false);
    expect(T.parsePerceiveArgs(['--keep-typeahead']).keepTypeahead).toBe(true);
  });
});

describe('perceivePageScript inner scroll', () => {
  it('injects primary scrollport selection into the page script', () => {
    const script = T.perceivePageScript(false);
    expect(script).toContain('pickPrimaryScrollMetrics');
    expect(script).toMatch(/overflowY/);
    expect(script).toContain('scrollingElement');
  });
});

describe('perceiveStr focused typeahead', () => {
  it('prints the omit notice and drops suggestion rows', async () => {
    const pageMeta = JSON.stringify({
      title: 'Music 3',
      url: 'https://huggingface.co/models/music-3',
      vw: 1280,
      vh: 720,
      scrollY: 0,
      scrollMax: 7927,
      focused: '<input#search>',
      counts: { 'input[text]': 1 },
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
    });
    const axNodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Music 3' }, backendDOMNodeId: 1 },
      {
        nodeId: '2', parentId: '1', role: { value: 'searchbox' }, name: { value: 'Search models' },
        backendDOMNodeId: 2,
        properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
      },
      { nodeId: '3', parentId: '1', role: { value: 'listbox' }, name: { value: 'Suggestions' }, backendDOMNodeId: 3 },
      { nodeId: '4', parentId: '3', role: { value: 'option' }, name: { value: 'MiniMax-H3-Turbo' }, backendDOMNodeId: 4 },
      { nodeId: '5', parentId: '1', role: { value: 'main' }, name: { value: 'Model card' }, backendDOMNodeId: 5 },
      { nodeId: '6', parentId: '5', role: { value: 'article' }, name: { value: 'Music 3 license' }, backendDOMNodeId: 6 },
    ];
    const cdp = {
      send(method) {
        if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: axNodes });
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: pageMeta } });
        if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj' } });
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { x: 0, y: 0, w: 10, h: 10 } } });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'root' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
    const out = await T.perceiveStr(
      cdp,
      'sid1',
      new T.RingBuffer(10),
      new T.RingBuffer(10),
      new Map(),
      { output: null },
      {},
    );
    expect(out).toContain(T.TYPEAHEAD_OMITTED_NOTICE);
    expect(out).toContain('Model card');
    expect(out).not.toContain('MiniMax-H3-Turbo');
    expect(out).toContain('Scroll: 0/7927');
  });
});

