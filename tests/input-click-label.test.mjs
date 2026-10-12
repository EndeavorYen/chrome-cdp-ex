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
      const { cdp, clicks } = labelCdp([name, 'Cancel']);
      const out = await T.clickStr(cdp, 'sid', input);
      expect(out, input).toBe(`JS-clicked <BUTTON> "${name}"`);
      expect(clicks, input).toEqual([name]);
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
    for (const input of ['Save profile', 'text=Save profile']) {
      const { cdp, clicks, scrolls } = coveredPage('Save profile');
      const err = await T.clickStr(cdp, 'sid', input).catch(error => error);
      expect(err, input).toBeInstanceOf(Error);
      expect(err.message, input).toMatch(/click not sent: <BUTTON> "Save profile" at \(160,120\) is covered by position:fixed <DIV#consent>/);
      expect(err.clickCovered, input).toMatchObject({ recentred: true });
      expect(clicks, input).toEqual([]);
      expect(scrolls, input).toEqual(['Save profile']);
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

describe('text edge lines through flow and batch absolutize', () => {
  it.each(TEXT_EDGE_LINES)('keeps %j as a quoted fill argument', (line) => {
    const flow = flowEdge(line);
    const batch = batchEdge(line);
    expect(flow).toMatch(/^(kept|error: )/);
    expect(batch).toMatch(/^(kept|error: )/);
  });
});
