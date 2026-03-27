// cdp.test.mjs — Tests for cdp.mjs pure functions
// Run: npm test

import { describe, it, expect, beforeEach } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp/scripts/cdp.mjs');
const {
  RingBuffer, resolvePrefix, getDisplayPrefixLength, sockPath,
  shouldShowAxNode, formatAxNode, orderedAxChildren, isRef,
  validateUrl, parsePerceiveArgs, dialogStr, netlogStr,
  formatPageList, buildPerceiveTree, evalStr, navStr, clickStr, fillStr, waitForStr,
  KEY_MAP, ENRICHED_ROLES, INTERACTIVE_ROLES,
} = T;

// =========================================================================
// RingBuffer
// =========================================================================

describe('RingBuffer', () => {
  let buf;
  beforeEach(() => { buf = new RingBuffer(3); });

  it('should start empty with seq 0', () => {
    expect(buf.all()).toEqual([]);
    expect(buf.latest()).toBe(0);
  });

  it('should push entries with incrementing _seq', () => {
    buf.push({ a: 1 });
    buf.push({ a: 2 });
    buf.push({ a: 3 });
    const all = buf.all();
    expect(all).toHaveLength(3);
    expect(all[0]._seq).toBe(1);
    expect(all[1]._seq).toBe(2);
    expect(all[2]._seq).toBe(3);
  });

  it('should evict oldest when capacity exceeded', () => {
    buf.push({ v: 'a' });
    buf.push({ v: 'b' });
    buf.push({ v: 'c' });
    buf.push({ v: 'd' }); // evicts 'a'
    const all = buf.all();
    expect(all).toHaveLength(3);
    expect(all[0].v).toBe('b');
    expect(all[2].v).toBe('d');
  });

  it('should mutate the pushed object to add _seq', () => {
    const obj = { x: 42 };
    buf.push(obj);
    expect(obj._seq).toBe(1);
  });

  it('since() should return entries after given seq', () => {
    buf.push({ v: 1 });
    buf.push({ v: 2 });
    buf.push({ v: 3 });
    expect(buf.since(2)).toHaveLength(1);
    expect(buf.since(2)[0].v).toBe(3);
    expect(buf.since(0)).toHaveLength(3);
    expect(buf.since(buf.latest())).toEqual([]);
  });

  it('all() should return a copy', () => {
    buf.push({ v: 1 });
    const a = buf.all();
    const b = buf.all();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('clear() should empty buffer but preserve seq', () => {
    buf.push({ v: 1 });
    buf.push({ v: 2 });
    const seqBefore = buf.latest();
    buf.clear();
    expect(buf.all()).toEqual([]);
    expect(buf.latest()).toBe(seqBefore);
  });

  it('should work correctly after clear + re-push', () => {
    buf.push({ v: 1 });
    buf.clear();
    buf.push({ v: 2 });
    expect(buf.all()).toHaveLength(1);
    expect(buf.all()[0]._seq).toBe(2);
    expect(buf.since(1)).toHaveLength(1);
  });
});

// =========================================================================
// resolvePrefix
// =========================================================================

describe('resolvePrefix', () => {
  const ids = ['ABCD1234EEEE', 'ABCE5678FFFF', 'XYZ99999GGGG'];

  it('should resolve unambiguous prefix', () => {
    expect(resolvePrefix('XYZ', ids)).toBe('XYZ99999GGGG');
  });

  it('should be case-insensitive', () => {
    expect(resolvePrefix('xyz9', ids)).toBe('XYZ99999GGGG');
  });

  it('should resolve when prefix uniquely narrows to one', () => {
    expect(resolvePrefix('ABCD', ids)).toBe('ABCD1234EEEE');
    expect(resolvePrefix('ABCE', ids)).toBe('ABCE5678FFFF');
  });

  it('should throw on ambiguous prefix', () => {
    expect(() => resolvePrefix('ABC', ids)).toThrow(/Ambiguous/);
    expect(() => resolvePrefix('ABC', ids)).toThrow(/matches 2/);
  });

  it('should throw on no match', () => {
    expect(() => resolvePrefix('QQQ', ids)).toThrow(/No .* matching/);
  });

  it('should include missingHint in error', () => {
    expect(() => resolvePrefix('QQQ', ids, 'target', 'Run "cdp list".'))
      .toThrow(/Run "cdp list"/);
  });

  it('should use custom noun in error', () => {
    expect(() => resolvePrefix('QQQ', ids, 'daemon'))
      .toThrow(/No daemon matching/);
  });
});

// =========================================================================
// getDisplayPrefixLength
// =========================================================================

describe('getDisplayPrefixLength', () => {
  it('should return 8 (MIN) for empty array', () => {
    expect(getDisplayPrefixLength([])).toBe(8);
  });

  it('should return 8 when IDs diverge within first 8 chars', () => {
    expect(getDisplayPrefixLength(['AAAA1111', 'BBBB2222'])).toBe(8);
  });

  it('should grow prefix until all IDs are unique', () => {
    // These share first 8 chars, diverge at position 9
    const ids = ['ABCDEFGH1XXX', 'ABCDEFGH2YYY'];
    expect(getDisplayPrefixLength(ids)).toBe(9);
  });

  it('should handle single ID', () => {
    expect(getDisplayPrefixLength(['ABCD1234'])).toBe(8);
  });
});

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

  it('should hide node with empty name and empty value', () => {
    expect(shouldShowAxNode(node('textbox', '', ''))).toBe(false);
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
// isRef
// =========================================================================

describe('isRef', () => {
  it('should match @<digits>', () => {
    expect(isRef('@1')).toBe(true);
    expect(isRef('@42')).toBe(true);
    expect(isRef('@999')).toBe(true);
  });

  it('should reject non-ref strings', () => {
    expect(isRef('@')).toBe(false);
    expect(isRef('1')).toBe(false);
    expect(isRef('@c1')).toBe(false);
    expect(isRef('@abc')).toBe(false);
    expect(isRef('')).toBe(false);
    expect(isRef('#btn')).toBe(false);
    expect(isRef('@ 1')).toBe(false);
  });
});

// =========================================================================
// validateUrl
// =========================================================================

describe('validateUrl', () => {
  it('should accept http and https URLs', () => {
    expect(() => validateUrl('http://example.com')).not.toThrow();
    expect(() => validateUrl('https://example.com/path?q=1')).not.toThrow();
    expect(() => validateUrl('http://192.168.1.1:8080/')).not.toThrow();
  });

  it('should reject non-http protocols', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/Only http/);
    expect(() => validateUrl('ftp://example.com')).toThrow(/Only http/);
    expect(() => validateUrl('data:text/html,<h1>hi</h1>')).toThrow(/Only http/);
  });

  it('should reject invalid URLs', () => {
    expect(() => validateUrl('not a url')).toThrow(/Invalid URL/);
    expect(() => validateUrl('')).toThrow(/Invalid URL/);
  });

  it('should block AWS metadata (169.254.169.254)', () => {
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data/'))
      .toThrow(/metadata/i);
  });

  it('should block GCP metadata endpoint', () => {
    expect(() => validateUrl('http://metadata.google.internal/computeMetadata/v1/'))
      .toThrow(/metadata/i);
  });

  it('should block Azure metadata (169.254.170.2)', () => {
    expect(() => validateUrl('http://169.254.170.2/'))
      .toThrow(/metadata/i);
  });

  it('should block link-local range 169.254.x.x', () => {
    expect(() => validateUrl('http://169.254.1.1/')).toThrow(/link-local/);
    expect(() => validateUrl('http://169.254.255.255/')).toThrow(/link-local/);
  });

  it('should allow private IPs that are not metadata/link-local', () => {
    expect(() => validateUrl('http://192.168.1.1/')).not.toThrow();
    expect(() => validateUrl('http://10.0.0.1/')).not.toThrow();
    expect(() => validateUrl('http://127.0.0.1:3000/')).not.toThrow();
  });

  it('should block GKE metadata host', () => {
    expect(() => validateUrl('http://metadata.gke.internal/'))
      .toThrow(/metadata/i);
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
    });
  });

  it('should parse --diff', () => {
    expect(parsePerceiveArgs(['--diff']).diff).toBe(true);
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
    });
  });

  it('should allow -s and -x together', () => {
    const opts = parsePerceiveArgs(['-s', '#main', '-x', '.sidebar']);
    expect(opts.selector).toBe('#main');
    expect(opts.exclude).toBe('.sidebar');
  });
});

// =========================================================================
// dialogStr
// =========================================================================

describe('dialogStr', () => {
  let dialogBuf, ref;
  beforeEach(() => {
    dialogBuf = new RingBuffer(20);
    ref = { value: true };
  });

  it('should report no dialogs when empty', () => {
    const result = dialogStr(dialogBuf, ref);
    expect(result).toMatch(/No dialogs recorded/);
    expect(result).toMatch(/Auto-accept: ON/);
  });

  it('should set auto-accept ON', () => {
    ref.value = false;
    const result = dialogStr(dialogBuf, ref, 'accept');
    expect(ref.value).toBe(true);
    expect(result).toMatch(/auto-accept: ON/i);
  });

  it('should set auto-accept OFF with dismiss', () => {
    const result = dialogStr(dialogBuf, ref, 'dismiss');
    expect(ref.value).toBe(false);
    expect(result).toMatch(/auto-accept: OFF/);
  });

  it('should throw on unknown flag', () => {
    expect(() => dialogStr(dialogBuf, ref, 'banana')).toThrow(/Unknown dialog flag.*banana/);
  });

  it('should list dialog entries', () => {
    dialogBuf.push({ type: 'alert', message: 'Hello!', ts: Date.now() });
    dialogBuf.push({ type: 'confirm', message: 'Sure?', ts: Date.now() });
    const result = dialogStr(dialogBuf, ref);
    expect(result).toMatch(/Dialogs \(2/);
    expect(result).toMatch(/\[alert\] "Hello!"/);
    expect(result).toMatch(/\[confirm\] "Sure\?"/);
  });
});

// =========================================================================
// netlogStr
// =========================================================================

describe('netlogStr', () => {
  let netBuf;
  beforeEach(() => { netBuf = new RingBuffer(100); });

  it('should report empty when no requests', () => {
    expect(netlogStr(netBuf)).toMatch(/No network requests/);
  });

  it('should clear buffer with --clear', () => {
    netBuf.push({ method: 'GET', url: 'https://x.com', status: 200, duration: 10, size: 100, ts: Date.now() });
    expect(netlogStr(netBuf, '--clear')).toBe('Network log cleared');
    expect(netBuf.all()).toHaveLength(0);
  });

  it('should format entries with method, url, status, duration', () => {
    netBuf.push({ method: 'POST', url: 'https://api.example.com/data', status: 201, duration: 42, size: 2048, ts: Date.now() });
    const result = netlogStr(netBuf);
    expect(result).toMatch(/Network requests \(1\)/);
    expect(result).toContain('POST');
    expect(result).toContain('https://api.example.com/data');
    expect(result).toContain('201');
    expect(result).toContain('42ms');
    expect(result).toContain('2.0KB');
  });

  it('should show bytes for small sizes', () => {
    netBuf.push({ method: 'GET', url: 'https://x.com', status: 200, duration: 5, size: 512, ts: Date.now() });
    expect(netlogStr(netBuf)).toContain('512B');
  });
});

// =========================================================================
// formatPageList
// =========================================================================

describe('formatPageList', () => {
  it('should return empty string for no pages', () => {
    expect(formatPageList([])).toBe('');
  });

  it('should format page with id prefix, title, url', () => {
    const result = formatPageList([{
      targetId: 'AABBCCDD11223344',
      title: 'Test Page',
      url: 'https://example.com',
    }]);
    expect(result).toContain('AABBCCDD');
    expect(result).toContain('Test Page');
    expect(result).toContain('https://example.com');
  });

  it('should truncate long titles to 54 chars', () => {
    const longTitle = 'A'.repeat(80);
    const result = formatPageList([{
      targetId: 'AABBCCDD11223344',
      title: longTitle,
      url: 'https://x.com',
    }]);
    // Title column is 54 chars wide
    expect(result).not.toContain('A'.repeat(55));
  });

  it('should align columns for multiple pages', () => {
    const pages = [
      { targetId: 'AAAA1111XXXX', title: 'Page A', url: 'https://a.com' },
      { targetId: 'BBBB2222YYYY', title: 'Page B', url: 'https://b.com' },
    ];
    const lines = formatPageList(pages).split('\n');
    expect(lines).toHaveLength(2);
    // Both lines should have same structure
    expect(lines[0]).toContain('Page A');
    expect(lines[1]).toContain('Page B');
  });
});

// =========================================================================
// sockPath
// =========================================================================

describe('sockPath', () => {
  it('should include targetId in path', () => {
    const p = sockPath('abc123def');
    expect(p).toContain('abc123def');
  });

  // On Linux/Mac: Unix socket ending in .sock
  if (process.platform !== 'win32') {
    it('should return .sock path on Unix', () => {
      expect(sockPath('abc123')).toMatch(/cdp-abc123\.sock$/);
    });
  }
});

// =========================================================================
// KEY_MAP
// =========================================================================

describe('KEY_MAP', () => {
  const expectedKeys = ['enter', 'tab', 'escape', 'backspace', 'delete', 'space',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];

  it('should contain all documented keys', () => {
    for (const k of expectedKeys) {
      expect(KEY_MAP).toHaveProperty(k);
    }
  });

  it('should have correct structure for each entry', () => {
    for (const [name, entry] of Object.entries(KEY_MAP)) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('code');
      expect(entry).toHaveProperty('keyCode');
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.code).toBe('string');
      expect(typeof entry.keyCode).toBe('number');
    }
  });

  it('should map enter to keyCode 13', () => {
    expect(KEY_MAP.enter.keyCode).toBe(13);
  });

  it('should map escape to keyCode 27', () => {
    expect(KEY_MAP.escape.keyCode).toBe(27);
  });
});

// =========================================================================
// ENRICHED_ROLES / INTERACTIVE_ROLES
// =========================================================================

describe('Role constants', () => {
  it('should include all landmark roles in ENRICHED_ROLES', () => {
    for (const r of ['banner', 'navigation', 'main', 'contentinfo', 'complementary']) {
      expect(ENRICHED_ROLES.has(r)).toBe(true);
    }
  });

  it('should include semantic structural roles in ENRICHED_ROLES', () => {
    for (const r of ['heading', 'img', 'form', 'table', 'dialog', 'region', 'article', 'alert']) {
      expect(ENRICHED_ROLES.has(r)).toBe(true);
    }
  });

  it('should include core interactive roles in INTERACTIVE_ROLES', () => {
    for (const r of ['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'slider', 'tab']) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(true);
    }
  });

  it('should have no overlap between ENRICHED and INTERACTIVE', () => {
    for (const r of ENRICHED_ROLES) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(false);
    }
    for (const r of INTERACTIVE_ROLES) {
      expect(ENRICHED_ROLES.has(r)).toBe(false);
    }
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
    const { treeLines, refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap);

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

    // Interactive refs
    expect(output).toContain('[link] Home  @1');
    expect(output).toContain('[link] Products  @2');
    expect(output).toContain('[link] Product 1  @3');
    expect(output).toContain('[button] Add to Cart  @4');
    expect(output).toContain('[link] Privacy  @5');

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

function createMockCDP(handlers = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (handlers[method]) return Promise.resolve(handlers[method](params, sessionId));
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
    waitForEvent(method, timeout) {
      let timer;
      return {
        promise: handlers[`event:${method}`]
          ? Promise.resolve(handlers[`event:${method}`]())
          : new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 50); }),
        cancel() { clearTimeout(timer); },
      };
    },
  };
}

// =========================================================================
// evalStr (with CDP mock)
// =========================================================================

describe('evalStr', () => {
  it('should return string value from Runtime.evaluate', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } }),
    });
    const result = await evalStr(cdp, 'sid1', '1+1');
    expect(result).toBe('hello');
  });

  it('should JSON.stringify object results', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: { a: 1, b: 2 } } }),
    });
    const result = await evalStr(cdp, 'sid1', 'obj');
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });

  it('should return empty string for undefined result', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: undefined } }),
    });
    expect(await evalStr(cdp, 'sid1', 'void 0')).toBe('');
  });

  it('should return "null" for null result (typeof null === "object")', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: null } }),
    });
    // typeof null === 'object', so it goes through JSON.stringify path
    expect(await evalStr(cdp, 'sid1', 'null')).toBe('null');
  });

  it('should throw on exceptionDetails', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: { text: 'ReferenceError: x is not defined' },
      }),
    });
    await expect(evalStr(cdp, 'sid1', 'x')).rejects.toThrow('ReferenceError');
  });

  it('should prefer exceptionDetails.text over exception.description', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: cannot read property' },
        },
      }),
    });
    // text is checked first; falls back to exception.description only if text is falsy
    await expect(evalStr(cdp, 'sid1', 'x.y')).rejects.toThrow('Uncaught');
  });

  it('should fall back to exception.description when text is empty', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: {
          text: '',
          exception: { description: 'TypeError: cannot read property' },
        },
      }),
    });
    await expect(evalStr(cdp, 'sid1', 'x.y')).rejects.toThrow('TypeError');
  });

  it('should auto-wrap await expressions when autoWrap=true', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        // Verify the expression was wrapped in async IIFE
        expect(params.expression).toContain('async');
        return { result: { value: 'done' } };
      },
    });
    await evalStr(cdp, 'sid1', 'await fetch("/api")', true);
  });

  it('should not wrap expressions without await even when autoWrap=true', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.expression).not.toContain('async');
        return { result: { value: '42' } };
      },
    });
    await evalStr(cdp, 'sid1', '1 + 1', true);
  });

  it('should wrap multi-statement await in block body', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        // Multi-statement with semicolons → block body {…}
        expect(params.expression).toMatch(/\(async\(\)=>\{/);
        return { result: { value: 'ok' } };
      },
    });
    await evalStr(cdp, 'sid1', 'const r = await fetch("/api"); return r', true);
  });

  it('should pass awaitPromise and returnByValue to CDP', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(true);
        expect(params.returnByValue).toBe(true);
        return { result: { value: 'ok' } };
      },
    });
    await evalStr(cdp, 'sid1', '"test"');
  });

  it('should pass sessionId to CDP', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'ok' } }),
    });
    await evalStr(cdp, 'session-xyz', '"test"');
    expect(cdp.calls[0].sessionId).toBe('session-xyz');
  });
});

// =========================================================================
// navStr (with CDP mock)
// =========================================================================

describe('navStr', () => {
  it('should navigate and return confirmation', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ loaderId: 'loader1' }),
      'event:Page.loadEventFired': () => ({}),
      'Runtime.evaluate': () => ({ result: { value: 'complete' } }),
    });
    const result = await navStr(cdp, 'sid1', 'https://example.com');
    expect(result).toBe('Navigated to https://example.com');
  });

  it('should throw on errorText from Page.navigate', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
    });
    await expect(navStr(cdp, 'sid1', 'https://bad.invalid'))
      .rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
  });

  it('should reject non-http URLs', async () => {
    const cdp = createMockCDP({});
    await expect(navStr(cdp, 'sid1', 'file:///etc/passwd'))
      .rejects.toThrow(/Only http/);
  });

  it('should reject metadata URLs', async () => {
    const cdp = createMockCDP({});
    await expect(navStr(cdp, 'sid1', 'http://169.254.169.254/'))
      .rejects.toThrow(/metadata/i);
  });
});

// =========================================================================
// clickStr (with CDP mock)
// =========================================================================

describe('clickStr', () => {
  it('should click element by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, x: 100, y: 200, tag: 'BUTTON', text: 'Submit' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await clickStr(cdp, 'sid1', '.btn-submit', new Map());
    expect(result).toContain('Clicked');
    expect(result).toContain('BUTTON');
    expect(result).toContain('Submit');
  });

  it('should click element by @ref', async () => {
    const refMap = new Map([[1, 101]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({
        result: { value: { x: 50, y: 60, w: 100, h: 40, tag: 'A', text: 'Link' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await clickStr(cdp, 'sid1', '@1', refMap);
    expect(result).toContain('Clicked');
    expect(result).toContain('@1');
  });

  it('should throw when element not found by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: false, error: 'Element not found: .missing' } },
      }),
    });
    await expect(clickStr(cdp, 'sid1', '.missing', new Map()))
      .rejects.toThrow('Element not found');
  });

  it('should throw on unknown @ref', async () => {
    const refMap = new Map(); // empty
    const cdp = createMockCDP({});
    await expect(clickStr(cdp, 'sid1', '@99', refMap))
      .rejects.toThrow(/Unknown ref/);
  });

  it('should throw when no selector provided', async () => {
    const cdp = createMockCDP({});
    await expect(clickStr(cdp, 'sid1', undefined, new Map()))
      .rejects.toThrow(/selector.*required/i);
  });

  it('should dispatch mouseMoved, mousePressed, mouseReleased in order', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, x: 10, y: 20, tag: 'DIV', text: 'x' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    await clickStr(cdp, 'sid1', '.el', new Map());
    const mouseEvents = cdp.calls
      .filter(c => c.method === 'Input.dispatchMouseEvent')
      .map(c => c.params.type);
    expect(mouseEvents).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });
});

// =========================================================================
// fillStr (with CDP mock)
// =========================================================================

describe('fillStr', () => {
  it('should clear and fill element by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, tag: 'INPUT' } },
      }),
      'Input.insertText': () => ({}),
    });
    const result = await fillStr(cdp, 'sid1', '#email', 'user@test.com', new Map());
    expect(result).toContain('Filled');
    expect(result).toContain('user@test.com');
  });

  it('should fill element by @ref', async () => {
    const refMap = new Map([[1, 201]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: undefined } }),
      'Input.insertText': () => ({}),
    });
    const result = await fillStr(cdp, 'sid1', '@1', 'hello', refMap);
    expect(result).toContain('Filled @1');
    expect(result).toContain('hello');
  });

  it('should truncate long text in result message', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, tag: 'TEXTAREA' } },
      }),
      'Input.insertText': () => ({}),
    });
    const longText = 'A'.repeat(100);
    const result = await fillStr(cdp, 'sid1', 'textarea', longText, new Map());
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longText.length);
  });

  it('should throw when selector missing', async () => {
    const cdp = createMockCDP({});
    await expect(fillStr(cdp, 'sid1', undefined, 'text', new Map()))
      .rejects.toThrow(/selector.*required/i);
  });

  it('should throw when text missing', async () => {
    const cdp = createMockCDP({});
    await expect(fillStr(cdp, 'sid1', '#input', null, new Map()))
      .rejects.toThrow(/Text required/);
  });
});

// =========================================================================
// Exclude subtree filtering (unit test for the filtering logic)
// =========================================================================

describe('exclude subtree filtering', () => {
  // Simulate the exclude logic from perceiveStr without CDP
  function filterExcluded(axNodes, excludedBackendNodeIds) {
    const excludedAxIds = new Set();
    for (const n of axNodes) {
      if (n.backendDOMNodeId && excludedBackendNodeIds.has(n.backendDOMNodeId))
        excludedAxIds.add(n.nodeId);
    }
    if (excludedAxIds.size === 0) return axNodes;
    const childMap = new Map();
    for (const n of axNodes) {
      if (n.parentId) {
        if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
        childMap.get(n.parentId).push(n.nodeId);
      }
    }
    const queue = [...excludedAxIds];
    while (queue.length) {
      const id = queue.pop();
      for (const child of (childMap.get(id) || [])) {
        excludedAxIds.add(child);
        queue.push(child);
      }
    }
    return axNodes.filter(n => !excludedAxIds.has(n.nodeId));
  }

  const axNode = (id, role, name, opts = {}) => ({
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
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
    const filtered = filterExcluded(nodes, excluded);

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
    const filtered = filterExcluded(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'main']);
  });

  it('should return all nodes when no backendDOMNodeId matches', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 300 }),
    ];
    const excluded = new Set([999]); // non-existent
    const filtered = filterExcluded(nodes, excluded);

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
    const filtered = filterExcluded(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root']);
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
// waitForStr --gone (with CDP mock)
// =========================================================================

describe('waitForStr --gone', () => {
  it('should throw when no selector provided after --gone', async () => {
    const cdp = createMockCDP({});
    await expect(waitForStr(cdp, 'sid1', ['--gone'], new Map()))
      .rejects.toThrow(/selector.*required.*--gone/i);
  });

  it('should return immediately when CSS selector element is already absent', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'null' } }),
    });
    const result = await waitForStr(cdp, 'sid1', ['--gone', '.stop-btn', '5000'], new Map());
    expect(result).toMatch(/gone/i);
  });

  it('should return when CSS selector element disappears after polling', async () => {
    let callCount = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        callCount++;
        // Element present for first 2 calls, then gone
        return { result: { value: callCount <= 2 ? '"yes"' : 'null' } };
      },
    });
    const result = await waitForStr(cdp, 'sid1', ['--gone', '.loading', '5000'], new Map());
    expect(result).toMatch(/gone/i);
    expect(callCount).toBeGreaterThan(2);
  });

  it('should throw on timeout when CSS element never disappears', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: '"yes"' } }),
    });
    await expect(waitForStr(cdp, 'sid1', ['--gone', '.sticky', '500'], new Map()))
      .rejects.toThrow(/still present/);
  });

  it('should throw for unknown @ref', async () => {
    const cdp = createMockCDP({});
    const refMap = new Map(); // empty — no refs
    await expect(waitForStr(cdp, 'sid1', ['--gone', '@99', '500'], refMap))
      .rejects.toThrow(/Unknown ref/);
  });

  it('should return when @ref element is removed from DOM (resolveNode throws)', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => { throw new Error('Could not find node'); },
    });
    const refMap = new Map([[5, 12345]]); // ref @5 → backendNodeId 12345
    const result = await waitForStr(cdp, 'sid1', ['--gone', '@5', '5000'], refMap);
    expect(result).toMatch(/@5.*gone.*removed/i);
  });

  it('should return when @ref element becomes disconnected', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: false } }), // isConnected=false
    });
    const refMap = new Map([[3, 99999]]);
    const result = await waitForStr(cdp, 'sid1', ['--gone', '@3', '5000'], refMap);
    expect(result).toMatch(/@3.*gone.*disconnected|hidden/i);
  });

  it('should timeout when @ref element stays present', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: true } }), // still connected+visible
    });
    const refMap = new Map([[7, 77777]]);
    await expect(waitForStr(cdp, 'sid1', ['--gone', '@7', '500'], refMap))
      .rejects.toThrow(/@7.*still present/);
  });
});
