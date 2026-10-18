import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { absolutizeBatchArgs, absolutizeFlowArgs } = await import('../skills/chrome-cdp-ex/scripts/lib/cdp-cli.mjs');
const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = '71DF370F9D36D5A232B424FDC696BE1A';

// Boundary labels a parse change must round-trip unchanged: spaces with #, quotes, runs of
// spaces and tabs, leading and trailing whitespace, apostrophes, escapes, CJK quotes.
const TEXT_EDGE_LINES = [
  "#form #delete",
  "\"#form #delete\"",
  "'#form #delete'",
  "a  b   c",
  "O'Brien",
  "\"O'Brien\"",
  "it's \"quoted\" and 'single'",
  "tab\tseparated",
  "trailing space ",
  " leading space",
  "a != b",
  "\\\"escaped\\\"",
  "emoji 🙂 and 中文 引號「」"
];

function button(text, extra = {}) {
  return {
    tagName: 'BUTTON',
    innerText: text,
    textContent: text,
    href: '',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 24, top: 10, left: 10, right: 90, bottom: 34 }),
    click() { extra.clicks?.push(text); },
    scrollIntoView() {},
    ...extra.node,
  };
}

function labelContext(buttons) {
  return {
    window: { innerWidth: 800, innerHeight: 600, scrollY: 0, MouseEvent: class MouseEvent {} },
    document: {
      querySelectorAll: () => buttons,
      querySelector: () => null,
    },
    location: { href: 'http://127.0.0.1/fixture' },
    Array, JSON, String, Math, Number,
  };
}

// CSS expressions return a miss at once. Named expressions run in the page vm.
function labelCdp(names) {
  const clicks = [];
  const buttons = names.map(name => button(name, { clicks }));
  const context = labelContext(buttons);
  const cdp = {
    send(method, params = {}) {
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
      const expression = String(params.expression || '');
      if (!expression.includes('chrome-cdp-ex.named-in-viewport-click')) {
        return Promise.resolve({ result: { value: { ok: false, error: 'Element not found: selector' } } });
      }
      return Promise.resolve({ result: { value: runInNewContext(expression, context) } });
    },
  };
  return { cdp, clicks };
}

function matchLabel(name, labels) {
  const clicks = [];
  const buttons = labels.map(text => button(text, { clicks }));
  const raw = runInNewContext(T.namedInViewportClickExpression(name), labelContext(buttons));
  return { clicks, parsed: JSON.parse(raw) };
}

function coveredPage(label) {
  const clicks = [];
  const scrolls = [];
  const banner = {
    nodeType: 1,
    tagName: 'DIV',
    id: 'consent',
    className: '',
    textContent: 'We use cookies',
    parentNode: null,
    shadowRoot: null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 72, top: 0, left: 0, right: 800, bottom: 72 }),
    closest() { return null; },
    matches() { return false; },
  };
  const buttonNode = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: 'save',
    className: '',
    innerText: label,
    textContent: label,
    href: '',
    parentNode: null,
    shadowRoot: null,
    ownerDocument: null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 120, height: 40, top: 100, left: 100, right: 220, bottom: 140 }),
    click() { clicks.push(label); },
    scrollIntoView() { scrolls.push(label); },
    closest() { return null; },
    matches() { return false; },
  };
  const doc = {
    nodeType: 9,
    elementFromPoint() { return banner; },
    querySelectorAll: () => [buttonNode],
    querySelector: () => null,
  };
  buttonNode.ownerDocument = doc;
  banner.ownerDocument = doc;
  const context = {
    window: { innerWidth: 800, innerHeight: 600, scrollY: 0, MouseEvent: class MouseEvent {} },
    document: doc,
    location: { href: 'http://127.0.0.1/fixture' },
    getComputedStyle: node => ({
      position: node === banner ? 'fixed' : 'static',
      pointerEvents: 'auto',
    }),
    Array, JSON, String, Math, Number,
  };
  const cdp = {
    send(method, params = {}) {
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
      const expression = String(params.expression || '');
      if (!expression.includes('chrome-cdp-ex.named-in-viewport-click')) {
        return Promise.resolve({ result: { value: { ok: false, error: 'Element not found: selector' } } });
      }
      return Promise.resolve({ result: { value: runInNewContext(expression, context) } });
    },
  };
  return { cdp, clicks, scrolls };
}

describe('click visible-text labels (#641)', () => {
  it('treats a word that is not an HTML tag as a label and keeps real selectors', () => {
    for (const label of ['Save profile', 'Sign in', 'Add to cart', 'Accept', 'Save', '儲存設定', '儲存 設定']) {
      expect(T.isNamedClickQuery(label), label).toBe(true);
      expect(T.isLikelyCssSelector(label), label).toBe(false);
    }
    for (const selector of ['button', 'a', 'a[href="/models"]', 'form button', 'div span', 'nav a', '#form #delete', 'div > span', 'div>span', '[role=button]', 'button:has-text("Save")', 'my-button']) {
      expect(T.isNamedClickQuery(selector), selector).toBe(false);
      expect(T.isLikelyCssSelector(selector), selector).toBe(true);
    }
  });

  it('clicks a multi-word label copied from perceive, in any script', async () => {
    for (const input of ['Save profile', '儲存設定', 'text=Save profile', 'text="Save profile"']) {
      const name = input.startsWith('text=') ? 'Save profile' : input;
      const page = pointerNamedPage([
        { text: name, rect: { x: 40, y: 50, width: 200, height: 40 } },
        { text: 'Cancel', rect: { x: 40, y: 120, width: 80, height: 24 } },
      ]);
      const out = await T.clickStr(page.cdp, 'sid', input);
      expect(out, input).toBe(`Clicked <BUTTON> "${name}"`);
      expect(page.mouse.some(event => event.type === 'mousePressed'), input).toBe(true);
      expect(page.mouse.some(event => event.type === 'mouseReleased'), input).toBe(true);
      expect(page.clicks, input).toEqual([]);
    }
  });

  it('keeps #form #delete, div span, and nav a on the CSS path', async () => {
    const { cdp, clicks } = labelCdp(['Save profile']);
    for (const selector of ['#form #delete', 'div span', 'nav a', 'form button']) {
      const err = await T.clickStr(cdp, 'sid', selector).catch(error => error);
      expect(err.message, selector).toMatch(/^Element not found:/);
      expect(clicks, selector).toEqual([]);
    }
  });

  it('refuses a covered label, including text=, with Kind covered', async () => {
    const cover = {
      tagName: 'DIV',
      id: 'consent',
      className: '',
      textContent: 'We use cookies',
      _position: 'fixed',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 72, top: 0, left: 0, right: 800, bottom: 72 }),
      closest() { return null; },
      matches() { return false; },
    };
    for (const input of ['Save profile', 'text=Save profile']) {
      const page = pointerNamedPage(
        [{ text: 'Save profile', rect: { x: 100, y: 100, width: 120, height: 40 } }],
        { cover },
      );
      const err = await T.clickStr(page.cdp, 'sid', input).catch(error => error);
      expect(err, input).toBeInstanceOf(Error);
      expect(err.message, input).toMatch(/click not sent: <BUTTON> "Save profile" at \(160,120\) is covered by position:fixed <DIV#consent>/);
      expect(err.clickCovered, input).toMatchObject({ recentred: true });
      expect(page.clicks, input).toEqual([]);
      expect(page.scrolls, input).toEqual(['Save profile']);
      expect(page.mouse, input).toEqual([]);
      const failure = classifyActionFailure(err, { action: 'click', target: { targetId: TARGET_ID, input } });
      expect(failure.kind, input).toBe('covered');
      expect(failure.dispatched, input).toBe(false);
    }
  });

  it('jsclick and click --js still click a covered label', async () => {
    const page = coveredPage('Save profile');
    const out = await T.jsClickStr(page.cdp, 'sid', 'Save profile');
    expect(out).toBe('JS-clicked <BUTTON> "Save profile"');
    expect(page.clicks).toEqual(['Save profile']);
    expect(page.scrolls).toEqual([]);

    const click = vi.fn(async () => 'mouse');
    const jsClick = vi.fn(async () => 'js');
    const handler = T.createClickCommandHandler({
      actionFeedback: async (_action, dispatch) => dispatch(),
      click,
      jsClick,
      pointerClick: vi.fn(),
    });
    expect((await handler({ args: ['--js', '儲存設定'] })).value).toBe('js');
    expect(jsClick).toHaveBeenCalledWith('儲存設定', expect.any(Object));
    expect(click).not.toHaveBeenCalled();
  });

  it('routes a plain label through click so the cover check runs', async () => {
    const click = vi.fn(async () => 'mouse');
    const jsClick = vi.fn(async () => 'js');
    const handler = T.createClickCommandHandler({
      actionFeedback: async (_action, dispatch) => dispatch(),
      click,
      jsClick,
      pointerClick: vi.fn(),
    });
    expect((await handler({ args: ['儲存設定'] })).value).toBe('mouse');
    expect(click).toHaveBeenCalledWith('儲存設定', expect.objectContaining({ clickTrust: expect.any(Object) }));
    expect(jsClick).not.toHaveBeenCalled();
  });

  it.each(TEXT_EDGE_LINES)('round-trips %j as a click label and clicks that exact text', (line) => {
    expect(TEXT_EDGE_LINES.length).toBeGreaterThan(10);
    expect(T.namedClickQueryName(line)).toBe(line);
    const collapsed = line.replace(/\s+/g, ' ').trim();
    const labels = collapsed === line ? [line] : [collapsed, line];
    const { clicks } = matchLabel(line, labels);
    expect(clicks).toEqual([line]);
    const opener = line[0];
    const wrapped = line.length >= 2 && (opener === '"' || opener === "'") && line.at(-1) === opener && !line.slice(1, -1).includes(opener);
    if (!wrapped) expect(T.namedClickQueryName(`text=${line}`)).toBe(line);
  });

  it('rejects an unclosed quote instead of truncating the target', async () => {
    expect(() => T.parseBatchArgs(['click "abc'])).toThrow(/unclosed quote/);
    expect(() => T.parseBatchArgs(['click "abc def'])).toThrow(/unclosed quote/);
    expect(() => T.parseClickArgs(['"abc'])).toThrow(/unclosed quote/);
    const { cdp } = labelCdp(['abc']);
    await expect(T.clickStr(cdp, 'sid', '"abc')).rejects.toThrow(/unclosed quote/);
    await expect(T.jsClickStr(cdp, 'sid', '"abc')).rejects.toThrow(/unclosed quote/);
    expect(T.parseClickArgs(["O'Brien"]).selector).toBe("O'Brien");
    expect(T.parseBatchArgs(["click O'Brien"]).commands[0].args).toEqual(["O'Brien"]);
    expect(T.namedClickQueryName('text="Save changes"')).toBe('Save changes');
    expect(T.namedClickQueryName(`text=${'a  b   c'}`)).toBe('a  b   c');
  });
});

const EDGE_CALLER = '/tmp/caller';

function quoteCharAbsentFrom(line, quotes) {
  return quotes.find(ch => !line.includes(ch)) || '';
}

function flowEdge(line) {
  const quote = quoteCharAbsentFrom(line, ['"', "'", '`']);
  if (!quote) {
    const attempt = `fill #q "${line}"`;
    expect(() => absolutizeFlowArgs([attempt], EDGE_CALLER)).not.toThrow();
    expect(() => T.parseFlowSteps(attempt)).toThrow(/unclosed quote/);
    return 'error: unclosed quote';
  }
  const step = `fill #q ${quote}${line}${quote}`;
  const out = absolutizeFlowArgs([step], EDGE_CALLER);
  expect(T.parseFlowSteps(out[0])).toEqual([
    { kind: 'command', cmd: 'fill', args: ['#q', line] },
  ]);
  return 'kept';
}

function batchEdge(line) {
  if (line.includes('|')) {
    const step = `fill #q "${line}"`;
    const out = absolutizeBatchArgs([step], EDGE_CALLER);
    expect(out).toEqual([step]);
    expect(() => T.parseBatchArgs(out)).toThrow(/\| separates batch steps/);
    return 'error: | separates batch steps';
  }
  const quote = quoteCharAbsentFrom(line, ['"', "'"]);
  if (quote) {
    const step = `fill #q ${quote}${line}${quote}`;
    const out = absolutizeBatchArgs([step], EDGE_CALLER);
    expect(T.parseBatchArgs(out).commands).toEqual([
      { cmd: 'fill', args: ['#q', line] },
    ]);
    return 'kept';
  }
  // Pipe syntax has no quote left (`'` and `"` both appear). The JSON command
  // array is the quoting that keeps the fill argument byte-for-byte.
  const payload = JSON.stringify([{ cmd: 'fill', args: ['#q', line] }]);
  const out = absolutizeBatchArgs([payload], EDGE_CALLER);
  expect(T.parseBatchArgs(out).commands).toEqual([
    { cmd: 'fill', args: ['#q', line] },
  ]);
  return 'kept (JSON array)';
}

// Parts of the named-click selector. The page expression passes the real selector, so a
// role that is not in that string is absent here too.
function namedCandidatePart(node, part) {
  const tag = String(node.tagName || '').toLowerCase();
  if (part === 'a' || part === 'button' || part === 'label') return tag === part;
  const role = /^\[role="([^"]+)"\]$/.exec(part);
  return role ? node.getAttribute('role') === role[1] : false;
}

// A page just rich enough for the named resolver and the scroll-settled hit test.
function pointerNamedPage(buttons, { cover = null, targets = null } = {}) {
  const clicks = [];
  const scrolls = [];
  const mouse = [];
  const calls = [];
  const state = { scrollY: 0, href: 'http://127.0.0.1/fixture' };
  const targetInfos = targets || [];
  class Node {
    get isConnected() { return true; }
    get ownerDocument() { return this._owner || doc; }
    get parentNode() { return this._parent || null; }
    getRootNode() { return doc; }
  }
  const doc = {
    nodeType: 9,
    documentElement: null,
    body: null,
    elementFromPoint() { return cover || null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      const parts = String(selector).split(',').map(part => part.trim());
      return nodes.filter(node => parts.some(part => namedCandidatePart(node, part)));
    },
    getElementById(id) {
      return nodes.find(node => node.id === id) || null;
    },
  };
  const nodes = [];
  const addNode = (spec, parent) => {
    const rect = { ...(spec.rect || { x: 40, y: 50, width: 200, height: 40 }) };
    const node = Object.assign(Object.create(Node.prototype), {
      nodeType: 1,
      tagName: spec.tag || 'BUTTON',
      id: spec.id || '',
      className: spec.className || '',
      href: spec.href || '',
      type: spec.type || '',
      innerText: spec.text,
      textContent: spec.text,
      _position: spec.position || 'static',
      _rect: rect,
      _children: [],
      getAttribute(name) {
        if (name === 'role') return spec.role || null;
        if (name === 'aria-label') return spec.ariaLabel || null;
        if (name === 'title') return spec.title || null;
        if (name === 'href') return spec.href || null;
        if (name === 'target') return spec.target || null;
        if (name === 'for') return spec.forId || null;
        if (name === 'disabled' && spec.disabled) return '';
        return null;
      },
      hasAttribute(name) { return name === 'disabled' && spec.disabled === true; },
      matches(selector) { return selector === ':disabled' && spec.disabled === true; },
      closest() { return null; },
      querySelector(selector) {
        const tags = String(selector).split(',').map(part => part.trim().toLowerCase());
        const walk = (el) => {
          for (const child of el._children || []) {
            if (tags.includes(String(child.tagName || '').toLowerCase())) return child;
            const found = walk(child);
            if (found) return found;
          }
          return null;
        };
        return walk(this);
      },
      getBoundingClientRect() {
        const box = this._rect;
        return {
          x: box.x, y: box.y, width: box.width, height: box.height,
          top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height,
        };
      },
      scrollIntoView() {
        scrolls.push(spec.text);
        state.scrollY = spec.scrollYAfter == null ? 640 : spec.scrollYAfter;
        if (spec.bringIntoView !== false && boxOffscreen(this._rect)) {
          this._rect.y = 80;
          this._rect.x = 40;
        }
      },
      click() { clicks.push(spec.text); if (spec.onClick) spec.onClick(); },
    });
    node._owner = doc;
    node._parent = parent || null;
    if (parent) parent._children.push(node);
    nodes.push(node);
    for (const child of spec.children || []) addNode(child, node);
    return node;
  };
  for (const spec of buttons) addNode(spec, null);
  if (cover) {
    cover.nodeType = 1;
    cover._owner = doc;
    doc.elementFromPoint = () => cover;
  }
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    get scrollY() { return state.scrollY; },
    MouseEvent: class MouseEvent {},
    requestAnimationFrame(cb) { cb(); return 1; },
  };
  const context = {
    window,
    document: doc,
    location: {
      get href() { return state.href; },
      set href(value) { state.href = value; },
    },
    Node,
    getComputedStyle: node => ({
      position: node && node._position ? node._position : 'static',
      overflowX: 'visible',
      overflowY: 'visible',
      transform: 'none',
      filter: 'none',
      contain: 'none',
      display: 'block',
      visibility: 'visible',
      pointerEvents: 'auto',
    }),
    Promise,
    Date,
    setTimeout,
    Math,
    Object,
    Reflect,
    String,
    Number,
    Array,
    JSON,
  };
  let seen = [];
  let resolved = null;
  const cdp = {
    mouse,
    send(method, params = {}) {
      calls.push(method);
      const src = method === 'Runtime.evaluate'
        ? String(params.expression || '')
        : String(params.functionDeclaration || '');
      if (src.includes('__chromeCdpExClickProbe')) {
        if (src.includes('installed: true')) {
          seen = [];
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'target-document' } } });
        }
        return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen: seen.slice(), reached: seen.slice() } } });
      }
      if (method === 'Input.dispatchMouseEvent') {
        mouse.push(params);
        if (params.type === 'mouseReleased') seen.push('mousedown', 'mouseup', 'click');
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        if (src === 'location.href') return Promise.resolve({ result: { type: 'string', value: context.location.href } });
        const value = runInNewContext(src, context);
        if (params.returnByValue === false && value && value.nodeType === 1) {
          resolved = value;
          return Promise.resolve({ result: { type: 'object', subtype: 'node', objectId: 'named-el' } });
        }
        return Promise.resolve({ result: { type: typeof value === 'string' ? 'string' : 'object', value } });
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = runInNewContext(`(${src})`, context);
        const run = fn.call(resolved);
        return Promise.resolve(run).then(value => ({ result: { value } }));
      }
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: targetInfos.slice() });
      return Promise.resolve({});
    },
  };
  return { cdp, clicks, scrolls, mouse, nodes, state, calls };
}

function boxOffscreen(rect) {
  return rect.y >= 600 || rect.x >= 800 || rect.y + rect.height <= 0 || rect.x + rect.width <= 0;
}

describe('named click is a pointer click (#749)', () => {
  it('dispatches press and release at the resolved centre and prints Clicked', async () => {
    const page = pointerNamedPage([{ text: 'New Project', rect: { x: 40, y: 50, width: 200, height: 40 } }]);
    const clickTrust = {};
    const out = await T.clickStr(page.cdp, 'sid', 'text=New Project', new Map(), {}, { clickTrust });
    expect(out).toBe('Clicked <BUTTON> "New Project"');
    const pressed = page.mouse.filter(event => event.type === 'mousePressed');
    const released = page.mouse.filter(event => event.type === 'mouseReleased');
    expect(pressed).toEqual([expect.objectContaining({ type: 'mousePressed', x: 140, y: 70, button: 'left' })]);
    expect(released).toEqual([expect.objectContaining({ type: 'mouseReleased', x: 140, y: 70, button: 'left' })]);
    expect(page.clicks).toEqual([]);
    expect(clickTrust.tag).toBe('BUTTON');
  });

  it('a covered named target is Kind: covered and sends no mouse event', async () => {
    const cover = {
      tagName: 'DIV',
      id: 'consent',
      className: '',
      textContent: 'We use cookies',
      _position: 'fixed',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 72, top: 0, left: 0, right: 800, bottom: 72 }),
      closest() { return null; },
      matches() { return false; },
    };
    const page = pointerNamedPage(
      [{ text: 'New Project', rect: { x: 100, y: 100, width: 120, height: 40 } }],
      { cover },
    );
    const err = await T.clickStr(page.cdp, 'sid', 'text=New Project').catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/click not sent: <BUTTON> "New Project"/);
    expect(err.clickCovered).toMatchObject({ recentred: true });
    const failure = classifyActionFailure(err, { action: 'click', target: { targetId: TARGET_ID, input: 'text=New Project' } });
    expect(failure.kind).toBe('covered');
    expect(page.mouse).toEqual([]);
    expect(page.clicks).toEqual([]);
  });

  it('falls back to an in-page click when the named target has no click box', async () => {
    const page = pointerNamedPage([{ text: 'New Project', rect: { x: 0, y: 0, width: 0, height: 0 } }]);
    const out = await T.clickStr(page.cdp, 'sid', 'New Project');
    // A zero box is not in the viewport, so the resolver scrolls before the fallback click.
    expect(out).toBe('JS-clicked <BUTTON> "New Project" (no click box; focus not moved)\nScroll: 0 → 640');
    expect(page.mouse).toEqual([]);
    expect(page.clicks).toEqual(['New Project']);
    expect(page.calls).toContain('Runtime.releaseObjectGroup');
  });

  it('reports the opened tab when a zero-box named link uses target=_blank', async () => {
    const TAB_ID = '52652A75B73A2CD473A881E906557EE2';
    const NEW_ID = 'F78D41FA4492257A29C2DA4D2CD22976';
    const DEST = 'http://127.0.0.1/opened';
    const targets = [{ targetId: TAB_ID, type: 'page', title: '', url: 'http://127.0.0.1/fixture' }];
    T.rememberSessionTarget('sid', TAB_ID);
    try {
      const page = pointerNamedPage([{
        text: 'Docs',
        tag: 'A',
        href: DEST,
        target: '_blank',
        rect: { x: 10, y: 10, width: 0, height: 0 },
        onClick() {
          targets.push({ targetId: NEW_ID, type: 'page', title: '', url: DEST, openerId: TAB_ID });
        },
      }], { targets });
      const out = await T.clickStr(page.cdp, 'sid', 'text=Docs');
      expect(out).toBe(`JS-clicked <A> "Docs" (no click box; focus not moved) → opened new tab F78D41FA ${DEST}\nScroll: 0 → 640`);
      expect(page.mouse).toEqual([]);
      expect(page.clicks).toEqual(['Docs']);
    } finally {
      T.forgetSessionTarget('sid');
    }
  });

  it('reports URL when a zero-box named link navigates this tab', async () => {
    const NEXT = 'http://127.0.0.1/next';
    const page = pointerNamedPage([{
      text: 'Next',
      tag: 'A',
      href: NEXT,
      rect: { x: 10, y: 10, width: 0, height: 0 },
      onClick() { page.state.href = NEXT; },
    }]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=Next');
    expect(out).toBe(`JS-clicked <A> "Next" (no click box; focus not moved)\nScroll: 0 → 640\nURL: ${NEXT}`);
    expect(page.mouse).toEqual([]);
    expect(page.clicks).toEqual(['Next']);
  });

  it('prints Scroll when a zero-box named target was scrolled into view', async () => {
    const page = pointerNamedPage([{
      text: 'New Project',
      rect: { x: 40, y: 1800, width: 0, height: 0 },
      scrollYAfter: 1520,
    }]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=New Project');
    expect(out).toBe('JS-clicked <BUTTON> "New Project" (no click box; focus not moved)\nScroll: 0 → 1520');
    expect(page.mouse).toEqual([]);
    expect(page.clicks).toEqual(['New Project']);
  });

  it('jsclick and click --js with a name stay in-page clicks and send no mouse event', async () => {
    const page = pointerNamedPage([{ text: 'New Project' }]);
    const out = await T.jsClickStr(page.cdp, 'sid', 'text=New Project');
    expect(out).toBe('JS-clicked <BUTTON> "New Project"');
    expect(page.mouse).toEqual([]);
    expect(page.clicks).toEqual(['New Project']);

    const click = vi.fn(async () => 'mouse');
    const jsClick = vi.fn(async () => 'js');
    const handler = T.createClickCommandHandler({
      actionFeedback: async (_action, dispatch) => dispatch(),
      click,
      jsClick,
      pointerClick: vi.fn(),
    });
    expect((await handler({ args: ['--js', 'text=New Project'] })).value).toBe('js');
    expect(jsClick).toHaveBeenCalledWith('text=New Project', expect.any(Object));
    expect(click).not.toHaveBeenCalled();
    await expect(T.pointerClickStr(page.cdp, 'sid', 'text=New Project')).rejects.toThrow(/click --pointer needs a CSS selector or @ref/);
  });

  it('scrolls a unique off-screen name into view, then pointer-clicks it', async () => {
    const page = pointerNamedPage([{
      text: 'New Project',
      rect: { x: 40, y: 1800, width: 200, height: 40 },
      scrollYAfter: 1520,
    }]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=New Project');
    expect(page.scrolls).toEqual(['New Project']);
    expect(page.state.scrollY).toBeGreaterThan(0);
    expect(out).toBe('Clicked <BUTTON> "New Project"\nScroll: 0 → 1520');
    expect(page.mouse.some(event => event.type === 'mousePressed')).toBe(true);
    expect(page.clicks).toEqual([]);
  });

  it('keeps the non-unique off-screen error and sends nothing', async () => {
    const page = pointerNamedPage([
      { text: 'New Project', rect: { x: 40, y: 1800, width: 80, height: 24 } },
      { text: 'New Project', rect: { x: 40, y: 1900, width: 80, height: 24 } },
    ]);
    const err = await T.clickStr(page.cdp, 'sid', 'text=New Project').catch(error => error);
    expect(err.message).toMatch(/^Named control is not unique and none are in the viewport: "New Project"/);
    expect(page.scrolls).toEqual([]);
    expect(page.mouse).toEqual([]);
    expect(page.clicks).toEqual([]);
  });
});

const OFFSCREEN = { x: 40, y: 1800, width: 120, height: 32 };

function antdSegmented(text, { disabled = false } = {}) {
  return {
    tag: 'LABEL',
    className: 'ant-segmented-item',
    text,
    children: [
      { tag: 'INPUT', type: 'radio', className: 'ant-segmented-item-input', text: '', disabled },
      { tag: 'DIV', className: 'ant-segmented-item-label', title: text, text },
    ],
  };
}

describe('named click matches radios, tabs and labels (#747)', () => {
  it('clicks an antd Segmented label for text=Form Wizard', async () => {
    const page = pointerNamedPage([antdSegmented('Form Wizard')]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=Form Wizard');
    expect(out).toBe('Clicked <LABEL> "Form Wizard"');
    expect(page.mouse.some(event => event.type === 'mousePressed')).toBe(true);
    expect(page.clicks).toEqual([]);

    const js = pointerNamedPage([antdSegmented('Form Wizard')]);
    const jsOut = await T.jsClickStr(js.cdp, 'sid', 'text=Form Wizard');
    expect(jsOut).toBe('JS-clicked <LABEL> "Form Wizard"');
    expect(js.clicks).toEqual(['Form Wizard']);
    expect(js.mouse).toEqual([]);
  });

  it('clicks a role=tab by its visible text', async () => {
    const page = pointerNamedPage([
      { tag: 'DIV', role: 'tab', text: 'Settings', rect: { x: 16, y: 20, width: 88, height: 32 } },
    ]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=Settings');
    expect(out).toBe('Clicked <DIV> "Settings"');
    expect(page.mouse.some(event => event.type === 'mousePressed')).toBe(true);
  });

  it('keeps the innermost control when a tab wraps a button with the same text, even off-screen', async () => {
    const page = pointerNamedPage([{
      tag: 'DIV',
      role: 'tab',
      text: 'Settings',
      rect: { ...OFFSCREEN },
      children: [{ tag: 'BUTTON', text: 'Settings', rect: { ...OFFSCREEN, y: 1808, height: 24 } }],
    }]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=Settings');
    expect(out).toMatch(/^Clicked <BUTTON> "Settings"/);
    expect(out).toMatch(/Scroll:/);
    expect(page.mouse.some(event => event.type === 'mousePressed')).toBe(true);
    expect(page.scrolls).toEqual(['Settings']);
  });

  it('keeps the innermost radio when a label wraps a role=radio with the same text', async () => {
    const page = pointerNamedPage([{
      tag: 'LABEL',
      text: 'Form Wizard',
      rect: { ...OFFSCREEN },
      children: [{
        tag: 'DIV',
        role: 'radio',
        text: 'Form Wizard',
        rect: { ...OFFSCREEN, y: 1808, height: 24 },
      }],
    }]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=Form Wizard');
    expect(out).toMatch(/^Clicked <DIV> "Form Wizard"/);
    expect(page.scrolls).toEqual(['Form Wizard']);
  });

  it('still reports two off-screen tabs with the same name as not unique', async () => {
    const page = pointerNamedPage([
      { tag: 'DIV', role: 'tab', text: 'Settings', rect: { ...OFFSCREEN } },
      { tag: 'DIV', role: 'tab', text: 'Settings', rect: { ...OFFSCREEN, y: 1900 } },
    ]);
    const err = await T.clickStr(page.cdp, 'sid', 'text=Settings').catch(error => error);
    expect(err.message).toMatch(/^Named control is not unique and none are in the viewport: "Settings" \(from text=Settings\)/);
    expect(page.mouse).toEqual([]);
    expect(page.clicks).toEqual([]);
    expect(page.scrolls).toEqual([]);
  });

  it('names tabs, radios and labels in a named miss', async () => {
    const page = pointerNamedPage([{ text: 'Save' }]);
    const err = await T.clickStr(page.cdp, 'sid', 'text=Form Wizard').catch(error => error);
    expect(err.message).toBe('Named control not found: "Form Wizard" (from text=Form Wizard). No button, link, tab, radio or label has that exact visible text or aria-label; pass the exact visible text or an @ref from perceive.');
    expect(page.mouse).toEqual([]);
  });

  it('clicks the same-name button when a field label comes first', async () => {
    const search = pointerNamedPage([
      { tag: 'LABEL', text: 'Search', className: 'sr-only', forId: 'q', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { tag: 'INPUT', id: 'q', type: 'text', text: '', rect: { x: 8, y: 8, width: 160, height: 32 } },
      { tag: 'BUTTON', text: 'Search', rect: { x: 180, y: 8, width: 80, height: 32 } },
    ]);
    const searchOut = await T.clickStr(search.cdp, 'sid', 'text=Search');
    expect(searchOut).toBe('Clicked <BUTTON> "Search"');
    expect(search.mouse.some(event => event.type === 'mousePressed')).toBe(true);

    const email = pointerNamedPage([
      { tag: 'LABEL', text: 'Email', forId: 'e', rect: { x: 8, y: 8, width: 80, height: 24 } },
      { tag: 'INPUT', id: 'e', type: 'email', text: '', rect: { x: 96, y: 8, width: 180, height: 32 } },
      { tag: 'BUTTON', text: 'Email', rect: { x: 284, y: 8, width: 80, height: 32 } },
    ]);
    const emailOut = await T.clickStr(email.cdp, 'sid', 'Email');
    expect(emailOut).toBe('Clicked <BUTTON> "Email"');
    expect(email.mouse.some(event => event.type === 'mousePressed')).toBe(true);
  });

  it('clicks a label that carries role=button, including one for a file input', async () => {
    const page = pointerNamedPage([
      { tag: 'LABEL', role: 'button', text: 'Upload file', forId: 'f', rect: { x: 8, y: 8, width: 120, height: 32 } },
      { tag: 'INPUT', id: 'f', type: 'file', text: '', rect: { x: 0, y: 0, width: 0, height: 0 } },
    ]);
    const out = await T.clickStr(page.cdp, 'sid', 'text=Upload file');
    expect(out).toBe('Clicked <LABEL> "Upload file"');
    expect(page.mouse.some(event => event.type === 'mousePressed')).toBe(true);
    expect(page.clicks).toEqual([]);
  });

  it('does not match a label whose control is a text input', async () => {
    const pointed = pointerNamedPage([
      { tag: 'LABEL', text: 'Email', forId: 'e', rect: { x: 8, y: 8, width: 80, height: 24 } },
      { tag: 'INPUT', id: 'e', type: 'email', text: '', rect: { x: 96, y: 8, width: 180, height: 32 } },
    ]);
    const pointedErr = await T.clickStr(pointed.cdp, 'sid', 'Email').catch(error => error);
    expect(pointedErr.message).toMatch(/^Named control not found: "Email"/);
    expect(pointed.mouse).toEqual([]);
    expect(pointed.clicks).toEqual([]);

    const wrapped = pointerNamedPage([{
      tag: 'LABEL',
      text: 'Notes',
      rect: { x: 8, y: 8, width: 200, height: 40 },
      children: [{ tag: 'INPUT', type: 'text', text: '', rect: { x: 64, y: 12, width: 140, height: 28 } }],
    }]);
    const wrappedErr = await T.clickStr(wrapped.cdp, 'sid', 'Notes').catch(error => error);
    expect(wrappedErr.message).toMatch(/^Named control not found: "Notes"/);
    expect(wrapped.mouse).toEqual([]);
    expect(wrapped.clicks).toEqual([]);
  });

  it('treats a label that wraps or points at a disabled input as disabled', async () => {
    const wrapped = pointerNamedPage([antdSegmented('Form Wizard', { disabled: true })]);
    const wrappedErr = await T.clickStr(wrapped.cdp, 'sid', 'text=Form Wizard').catch(error => error);
    expect(wrappedErr.message).toBe('<LABEL> "Form Wizard" is disabled (disabled attribute); the click was not sent.');
    expect(wrapped.mouse).toEqual([]);
    expect(wrapped.clicks).toEqual([]);

    const pointed = pointerNamedPage([
      { tag: 'INPUT', id: 'mode', type: 'radio', text: '', disabled: true, rect: { x: 0, y: 0, width: 0, height: 0 } },
      { tag: 'LABEL', text: 'Form Wizard', forId: 'mode' },
    ]);
    const pointedErr = await T.jsClickStr(pointed.cdp, 'sid', 'text=Form Wizard').catch(error => error);
    expect(pointedErr.message).toBe('<LABEL> "Form Wizard" is disabled (disabled attribute); the click was not sent.');
    expect(pointed.clicks).toEqual([]);
  });

  it('keeps a CSS tag word on the CSS path, and Logout stays a named query', async () => {
    expect(T.isLikelyCssSelector('button')).toBe(true);
    expect(T.isNamedClickQuery('button')).toBe(false);
    // Logout is not an HTML tag, so it is already a name. There is no CSS miss to retry as text=.
    expect(T.isLikelyCssSelector('Logout')).toBe(false);
    expect(T.isNamedClickQuery('Logout')).toBe(true);

    const css = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        const selector = JSON.parse(String(params.expression).match(/'Element not found: ' \+ ("(?:[^"\\]|\\.)*")/)[1]);
        return Promise.resolve({ result: { value: JSON.stringify({ ok: false, error: `Element not found: ${selector}` }) } });
      },
    };
    const cssErr = await T.clickStr(css, 'sid', 'button').catch(error => error);
    expect(cssErr.message).toMatch(/^Element not found: button\./);
    expect(cssErr.message).toContain('"button" was read as a CSS tag selector');
    expect(cssErr.message).toContain('"text=button"');
    expect(cssErr.message).not.toMatch(/Named control not found/);

    const named = pointerNamedPage([{ text: 'Logout' }]);
    const out = await T.clickStr(named.cdp, 'sid', 'Logout');
    expect(out).toBe('Clicked <BUTTON> "Logout"');
    const miss = pointerNamedPage([]);
    const missErr = await T.clickStr(miss.cdp, 'sid', 'Logout').catch(error => error);
    expect(missErr.message).toMatch(/^Named control not found: "Logout"/);
    expect(missErr.message).not.toMatch(/was read as a CSS tag selector/);
  });
});

describe('text edge lines through flow and batch absolutize', () => {
  it.each(TEXT_EDGE_LINES)('keeps %j as a quoted fill argument', (line) => {
    const flow = flowEdge(line);
    const batch = batchEdge(line);
    expect(flow).toMatch(/^(kept|error: )/);
    expect(batch).toMatch(/^(kept|error: )/);
  });
});
