import { describe, expect, it } from 'vitest';

import {
  goldenPathPerceiveRecommendation,
} from '../skills/chrome-cdp-ex/scripts/lib/perception-model.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { buildPerceiveTree, perceiveStr, RingBuffer } = T;

function axNode(id, role, name, opts = {}) {
  return {
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.childIds ? { childIds: opts.childIds } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
  };
}

function createMockCDP(handlers = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId, timeout) {
      calls.push({ method, params, sessionId, timeout });
      if (handlers[method]) return Promise.resolve(handlers[method](params, sessionId));
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree: { frame: { id: 'mock-root-frame' } } });
      }
      if (method === 'Page.createIsolatedWorld') {
        return Promise.resolve({ executionContextId: 901 });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
    waitForEvent() {
      return { promise: Promise.reject(new Error('timeout')), cancel() {} };
    },
  };
}

function chromeArticleAxTree() {
  // Skip + nav sit shallow. Main/article are nested behind 10 generic wrappers so
  // a naive -d 8 walk truncates before the body (issue #159).
  const nodes = [
    axNode('root', 'WebArea', 'Paper page'),
    axNode('skip', 'link', 'Skip to main content', { parentId: 'root', backendDOMNodeId: 11 }),
    axNode('nav', 'navigation', 'Site nav', { parentId: 'root' }),
    axNode('navHome', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 12 }),
    axNode('navDocs', 'link', 'Docs', { parentId: 'nav', backendDOMNodeId: 13 }),
  ];
  nodes[0].childIds = ['skip', 'nav', 'g1'];
  nodes[2].childIds = ['navHome', 'navDocs'];

  let parent = 'root';
  for (let i = 1; i <= 10; i++) {
    const id = `g${i}`;
    const node = axNode(id, 'generic', '', { parentId: parent });
    const parentNode = nodes.find(n => n.nodeId === parent);
    parentNode.childIds = [...(parentNode.childIds || []).filter(cid => cid !== id), id];
    nodes.push(node);
    parent = id;
  }

  const main = axNode('main', 'main', 'Article', { parentId: parent });
  const article = axNode('article', 'article', 'Abstract', { parentId: 'main' });
  const heading = axNode('h1', 'heading', 'A title about transformers', { parentId: 'article' });
  const para = axNode('p', 'paragraph', '', { parentId: 'article' });
  const text = axNode('bodyText', 'StaticText', 'The paper abstract lives here with VRAM and Comfy.', { parentId: 'p' });
  const cite = axNode('cite', 'button', 'Cite', { parentId: 'article', backendDOMNodeId: 99 });
  nodes.find(n => n.nodeId === parent).childIds = ['main'];
  main.childIds = ['article'];
  article.childIds = ['h1', 'p', 'cite'];
  para.childIds = ['bodyText'];
  nodes.push(main, article, heading, para, text, cite);
  return nodes;
}

describe('buildPerceiveTree ranking for golden-path -C -d 8 (#159)', () => {
  const emptyMeta = { layoutMap: {}, styleHints: {} };

  it('keeps article body ahead of skip-link/nav chrome at maxDepth 8', () => {
    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(chromeArticleAxTree(), emptyMeta, refMap, {
      maxDepth: 8,
      cursorInteractive: true,
    });
    const out = treeLines.join('\n');

    expect(out).toContain('The paper abstract lives here with VRAM and Comfy.');
    expect(out).toContain('[main]');
    expect(out).toContain('[article]');
    expect(out).toMatch(/\[heading\].*transformers/i);
    // Skip-link may still appear, but must not consume first @ref (aligned with #163).
    const citeLine = treeLines.find(line => line.includes('[button] Cite'));
    expect(citeLine).toMatch(/@\d+\b/);
    const skipLine = treeLines.find(line => /Skip to main content/i.test(line));
    expect(skipLine).toBeDefined();
    expect(skipLine).not.toMatch(/@1\b/);
  });

  it('does not let skip-links consume first refs when main has an interactive', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('skip', 'link', 'Skip to content', { parentId: 'root', backendDOMNodeId: 1 }),
      axNode('main', 'main', 'Body', { parentId: 'root' }),
      axNode('btn', 'button', 'Download', { parentId: 'main', backendDOMNodeId: 2 }),
    ];
    nodes[0].childIds = ['skip', 'main'];
    nodes[2].childIds = ['btn'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap, {
      maxDepth: 8,
      cursorInteractive: true,
    });
    const download = treeLines.find(line => line.includes('[button] Download'));
    const skip = treeLines.find(line => /Skip to content/i.test(line));
    expect(download).toMatch(/@1\b/);
    expect(skip).not.toMatch(/@1\b/);
    expect(refMap.get(1)).toBe(2);
  });

  it('appends a text --auto fallback when -d 8 only captured skip + nav chrome', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('skip', 'link', 'Skip to main content', { parentId: 'root', backendDOMNodeId: 1 }),
      axNode('nav', 'navigation', 'Sidebar', { parentId: 'root' }),
      axNode('n1', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 2 }),
    ];
    nodes[0].childIds = ['skip', 'nav'];
    nodes[2].childIds = ['n1'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap, {
      maxDepth: 8,
      cursorInteractive: true,
      targetPrefix: 'AB12CD34',
    });
    const out = treeLines.join('\n');
    expect(out).not.toMatch(/\[(main|article)\]/);
    expect(out).toContain('Body truncated. Next: cdp text AB12CD34 --auto');
  });
});

describe('perceiveStr -C last/adaptive surfaces (#159)', () => {
  function control(label, index) {
    return {
      tag: 'a',
      role: 'link',
      label,
      ariaLabel: label,
      text: label,
      disabled: false,
      clickable: true,
      rect: { x: 8, y: index * 20, w: 80, h: 16 },
      selector: `a.nav-${index}`,
      hints: { classes: ['nav'] },
    };
  }

  function perceiveMeta(controls) {
    return {
      title: 'Docs',
      url: 'https://example.test/docs',
      vw: 900,
      vh: 640,
      scrollY: 0,
      scrollMax: 0,
      counts: { a: controls.length, button: 1 },
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: controls.map(item => ({
        sel: item.selector,
        text: item.label,
        x: item.rect.x,
        y: item.rect.y,
        w: item.rect.w,
        h: item.rect.h,
      })),
      visibleControls: controls,
      visibleControlsTruncated: true,
    };
  }

  it('keeps article body and applies --last to the -C control dump', async () => {
    const controls = Array.from({ length: 20 }, (_, i) => control(`Nav item ${i}`, i));
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify(perceiveMeta(controls)) } }),
      'Accessibility.getFullAXTree': () => ({ nodes: chromeArticleAxTree() }),
    });

    const last3 = await perceiveStr(
      cdp, 'sid1', new RingBuffer(10), new RingBuffer(10), new Map(), { last: null },
      { cursorInteractive: true, maxDepth: 8, last: 3, targetPrefix: 'AB12CD34' },
    );
    const last20 = await perceiveStr(
      cdp, 'sid1', new RingBuffer(10), new RingBuffer(10), new Map(), { last: null },
      { cursorInteractive: true, maxDepth: 8, last: 20, targetPrefix: 'AB12CD34' },
    );

    expect(last3).toContain('The paper abstract lives here with VRAM and Comfy.');
    expect(last20).toContain('The paper abstract lives here with VRAM and Comfy.');
    const visibleItems = text => [...text.matchAll(/^\s+a role=link/gm)].length;
    expect(visibleItems(last3)).toBeGreaterThan(0);
    expect(visibleItems(last3)).toBeLessThan(visibleItems(last20));
    expect(visibleItems(last3)).toBeLessThanOrEqual(3);
  });

  it('applies --adaptive to the -C dump instead of ignoring it', async () => {
    const controls = Array.from({ length: 20 }, (_, i) => control(`Nav item ${i}`, i));
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify(perceiveMeta(controls)) } }),
      'Accessibility.getFullAXTree': () => ({ nodes: chromeArticleAxTree() }),
    });

    const adaptive = await perceiveStr(
      cdp, 'sid1', new RingBuffer(10), new RingBuffer(10), new Map(), { last: null },
      { cursorInteractive: true, maxDepth: 8, adaptive: true, targetPrefix: 'AB12CD34' },
    );
    expect(adaptive).toContain('The paper abstract lives here with VRAM and Comfy.');
    const visibleItems = [...adaptive.matchAll(/^\s+a role=link/gm)].length;
    expect(visibleItems).toBeGreaterThan(0);
    expect(visibleItems).toBeLessThanOrEqual(8);
  });
});

describe('golden-path recipe still perceives first (#159)', () => {
  it('keeps perceive -C -d 8 as the first command and documents text --auto', () => {
    const rec = goldenPathPerceiveRecommendation('AB12CD34');
    expect(rec.run).toBe('cdp perceive AB12CD34 -C -d 8');
    expect(rec.commands[0]).toBe('cdp perceive AB12CD34 -C -d 8');
    expect(rec.reason).toMatch(/text \S+ --auto/);
    expect(rec.reason).toMatch(/what does this page say/i);
  });
});
