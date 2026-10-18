import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const base = await import('../skills/chrome-cdp-ex/scripts/lib/cdp-base.mjs');
const {
  classifyActionFailure,
  formatActionFailure,
  isClassifiedActionFailureText,
} = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = '71DF370F9D36D5A232B424FDC696BE1A';
const PREFIX = '71DF370F';
const BUTTON_NAME = '套用設定';

function fakePageCdp(names) {
  const clicks = [];
  const mouse = [];
  class Node {
    get isConnected() { return true; }
    get ownerDocument() { return doc; }
    get parentNode() { return null; }
    getRootNode() { return doc; }
  }
  const buttons = names.map(text => Object.assign(Object.create(Node.prototype), {
    nodeType: 1,
    tagName: 'BUTTON',
    id: '',
    className: '',
    innerText: text,
    textContent: text,
    href: '',
    getAttribute: () => null,
    closest() { return null; },
    matches() { return false; },
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 24, top: 10, left: 10, right: 90, bottom: 34 }),
    click() { clicks.push(text); },
    scrollIntoView() {},
  }));
  const doc = {
    nodeType: 9,
    elementFromPoint() { return null; },
    querySelectorAll: () => buttons,
    querySelector: () => null,
  };
  const context = {
    window: { innerWidth: 800, innerHeight: 600, scrollY: 0, MouseEvent: class MouseEvent {} },
    document: doc,
    location: { href: 'http://127.0.0.1/fixture' },
    Node,
    getComputedStyle: () => ({
      position: 'static', overflowX: 'visible', overflowY: 'visible', transform: 'none',
      filter: 'none', contain: 'none', display: 'block', visibility: 'visible', pointerEvents: 'auto',
    }),
    Promise, Date, setTimeout, Math, Object, Reflect, String, Number, Array, JSON,
  };
  let seen = [];
  let resolved = null;
  const cdp = {
    send(method, params = {}) {
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
        return Promise.resolve({ result: { value } });
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = runInNewContext(`(${src})`, context);
        return Promise.resolve(fn.call(resolved)).then(value => ({ result: { value } }));
      }
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: [] });
      return Promise.resolve({});
    },
  };
  return { cdp, clicks, mouse };
}

describe('#427 failed actions always print an Error line', () => {
  it('formatActionFailure leads with Error: even when the kind is unknown', () => {
    const text = formatActionFailure(new Error('Something odd happened in the page'), {
      action: 'click',
      target: { targetId: TARGET_ID, input: 'x' },
    });
    expect(text.split('\n')[0]).toBe('Error: Something odd happened in the page');
    expect(text).toMatch(/^Kind: unknown$/m);
    expect(text).toMatch(/^Next: cdp perceive /m);
  });

  it('formatActionFailure keeps the selector in the Error line for a selector miss', () => {
    const text = formatActionFailure(new Error('Element not found: #save'), {
      action: 'click',
      target: { targetId: 'ABC123', input: '#save' },
    });
    expect(text).toBe('Error: Element not found: #save\nKind: selector\nNext: cdp perceive ABC123 -C -d 8');
  });

  it('keeps the fill Value line (#428) between Kind and Next under the Error line', () => {
    const err = new Error('fill: #amp did not accept "abc"; value changed "0.5" → ""');
    err.fillValue = { before: '0.5', after: '', requested: 'abc', inputType: 'number', changed: true };
    const text = formatActionFailure(err, { action: 'fill', target: { targetId: 'ABC123', input: '#amp' } });
    expect(text.split('\n')).toEqual([
      'Error: fill: #amp did not accept "abc"; value changed "0.5" → ""',
      'Kind: fill-value-mismatch',
      'Value: "0.5" → "" (requested "abc"; <input type=number> rejected the text)',
      `Next: cdp eval ABC123 "document.querySelector('#amp')?.value"`,
    ]);
  });

  it('does not double-prefix an Error: message or re-wrap an already formatted failure', () => {
    const once = formatActionFailure(new Error('Error: boom'), { action: 'click', target: { targetId: 'ABC123' } });
    expect(once.split('\n')[0]).toBe('Error: boom');
    expect(isClassifiedActionFailureText(once)).toBe(true);
    expect(formatActionFailure(new Error(once), { action: 'click', target: { targetId: 'ABC123' } })).toBe(once);
  });

  it('collapses a multi-line message onto one bounded Error line', () => {
    const text = formatActionFailure(new Error(`first line\n  second line\n${'x'.repeat(2000)}`), {
      action: 'click',
      target: { targetId: 'ABC123' },
    });
    const errorLine = text.split('\n')[0];
    expect(errorLine.startsWith('Error: first line second line')).toBe(true);
    expect(errorLine.length).toBeLessThanOrEqual(620);
    expect(text.split('\n')).toHaveLength(3);
  });

  it('the CLI error renderer passes the formatted failure through, Kind on its own line (#637)', () => {
    const failure = formatActionFailure(new Error('Named control not found: "x"'), {
      action: 'click',
      target: { targetId: TARGET_ID, input: 'x' },
    });
    expect(T.formatCliError(new Error(failure), { cmd: 'click', targetPrefix: PREFIX })).toBe(failure);
    expect(failure).toMatch(/^Kind: /m);
    expect(failure).not.toMatch(/\(Kind:/);
  });

  it('a failed dispatch receipt rendered as text carries the original error', () => {
    const failure = classifyActionFailure(new Error('Only http/https URLs allowed, got: data:'), {
      action: 'nav',
      target: { targetId: TARGET_ID, input: 'data:text/html,x' },
    });
    const result = T.createActionResult({
      action: 'nav',
      target: { targetId: TARGET_ID, input: 'data:text/html,x', resolvedBy: 'url', label: 'data:text/html,x' },
      dispatch: { ok: false, method: 'nav', error: failure.originalMessage },
      settle: { ok: false, durationMs: 0 },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
    });
    const text = T.formatActionResultOutput(result, {});
    expect(text.split('\n')[0]).toBe('Error: Only http/https URLs allowed, got: data:');
    expect(text).toMatch(/^Kind: /m);
    expect(text).toMatch(/^Next: /m);
  });

  it('classifies a named-control miss as a selector failure, not unknown', () => {
    for (const message of [
      'Named control not found: "套用設定"',
      'Named control is not unique and none are in the viewport: "Save"',
    ]) {
      expect(classifyActionFailure(new Error(message), {
        action: 'click',
        target: { targetId: TARGET_ID, input: 'x' },
      }).kind).toBe('selector');
    }
  });
});

describe('#427 Playwright text= selector is an alias for the visible-text form', () => {
  it('treats text=, text="…" and text=\'…\' as named queries', () => {
    expect(T.isNamedClickQuery(`text=${BUTTON_NAME}`)).toBe(true);
    expect(T.isNamedClickQuery('text="Save changes"')).toBe(true);
    expect(T.isNamedClickQuery("text='Save'")).toBe(true);
    expect(T.isNamedClickQuery('text=Save')).toBe(true);
    // A word that is not an HTML tag is a label. text= forces a name for a real tag.
    expect(T.isNamedClickQuery('Save')).toBe(true);
    expect(T.isNamedClickQuery('button')).toBe(false);
    expect(T.namedClickQueryName('text="Save changes"')).toBe('Save changes');
    expect(T.namedClickQueryName(`text=${BUTTON_NAME}`)).toBe(BUTTON_NAME);
    expect(T.namedClickQueryName(BUTTON_NAME)).toBe(BUTTON_NAME);
  });

  it('click "text=套用設定" pointer-clicks the button with that visible text', async () => {
    for (const input of [`text=${BUTTON_NAME}`, `text="${BUTTON_NAME}"`]) {
      const { cdp, clicks, mouse } = fakePageCdp([BUTTON_NAME, '無動作']);
      const out = await T.clickStr(cdp, 'sid', input);
      expect(out).toBe(`Clicked <BUTTON> "${BUTTON_NAME}"`);
      expect(mouse.filter(event => event.type === 'mousePressed')).toEqual([
        expect.objectContaining({ x: 50, y: 22, button: 'left' }),
      ]);
      expect(mouse.some(event => event.type === 'mouseReleased')).toBe(true);
      expect(clicks).toEqual([]);
    }
  });

  it('a text= miss names the selector and points at visible text or an @ref', async () => {
    const { cdp, clicks } = fakePageCdp([BUTTON_NAME]);
    const err = await T.clickStr(cdp, 'sid', 'text=不存在').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Named control not found: "不存在" \(from text=不存在\)/);
    expect(err.message).toMatch(/visible text/);
    expect(err.message).toMatch(/@ref/);
    expect(clicks).toEqual([]);
    const text = formatActionFailure(err, { action: 'click', target: { targetId: TARGET_ID, input: 'text=不存在' } });
    expect(text.split('\n')[0]).toBe(`Error: ${err.message}`);
    expect(text).toMatch(/^Kind: selector$/m);
  });

  it('a CSS click miss names the selector and points at text= or an @ref', async () => {
    const cdp = {
      send(method, params = {}) {
        if (method === 'Runtime.evaluate') {
          const selector = JSON.parse(String(params.expression).match(/'Element not found: ' \+ ("(?:[^"\\]|\\.)*")/)[1]);
          return Promise.resolve({ result: { value: { ok: false, error: `Element not found: ${selector}` } } });
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const err = await T.clickStr(cdp, 'sid', 'button').catch(e => e);
    expect(err.message).toMatch(/^Element not found: button\./);
    expect(err.message).toContain('"text=button"');
    expect(err.message).toMatch(/@ref/);
    const css = await T.clickStr(cdp, 'sid', '#nope').catch(e => e);
    expect(css.message).toMatch(/^Element not found: #nope\./);
    expect(css.message).not.toContain('"text=');
    expect(css.message).toMatch(/@ref/);
    expect(classifyActionFailure(css, { action: 'click', target: { targetId: TARGET_ID, input: '#nope' } }).kind)
      .toBe('selector');
  });

  it('a plain-name miss also names the input and hints at an @ref', async () => {
    const { cdp } = fakePageCdp([BUTTON_NAME]);
    const err = await T.jsClickStr(cdp, 'sid', '不存在的按鈕').catch(e => e);
    expect(err.message).toMatch(/^Named control not found: "不存在的按鈕"\./);
    expect(err.message).toMatch(/@ref/);
  });
});

describe('#430 click receipts suggest perceive --since-action, not list', () => {
  function clickResult({ domDiff = null, navigation = null, targetId = TARGET_ID, dispatchMethod = 'click' } = {}) {
    return T.createActionResult({
      action: 'click',
      target: { ...(targetId ? { targetId } : {}), input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff, console: [], network: [], navigation },
    });
  }

  it('an in-page click that changed the AX tree prints Outcome: changed and Next perceive --since-action', () => {
    const text = T.formatActionResultOutput(clickResult({ domDiff: '+   [StaticText] Saved' }), {
      dispatchText: 'Clicked <BUTTON> "Save"',
    });
    expect(text).toBe(`Clicked <BUTTON> "Save". Next: cdp perceive ${PREFIX} --since-action`);
  });

  it('an unobserved named click (report-only) prints no outcome word and Next perceive --since-action', () => {
    const result = T.createActionResult({
      action: 'click',
      target: T.namedClickActionTarget(BUTTON_NAME, { targetId: TARGET_ID }),
      dispatch: { ok: true, method: 'jsclick' },
      settle: { ok: true, durationMs: 2 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionResultOutput(result, { dispatchText: `JS-clicked <BUTTON> "${BUTTON_NAME}"` });
    expect(text).toBe(`JS-clicked <BUTTON> "${BUTTON_NAME}". Next: cdp perceive ${PREFIX} --since-action`);
    expect(text).not.toMatch(/cdp list/);
  });

  it('a no-change click says so and keeps its diagnosis Next', () => {
    const noChange = [
      'Page: Fixture — http://127.0.0.1/',
      '(no changes detected in AX tree)',
    ].join('\n');
    const text = T.formatActionResultOutput(clickResult({ domDiff: noChange }), {
      dispatchText: 'Clicked <BUTTON> "Noop"',
    });
    expect(text).toMatch(/^Clicked <BUTTON> "Noop"\. Next: cdp perceive /);
    expect(text).not.toMatch(/Outcome:/);
    expect(text).not.toMatch(/cdp list/);
  });

  it('a click that navigated the same tab points at a fresh perceive, not list', () => {
    const result = clickResult({
      domDiff: '+ [RootWebArea] Two',
      navigation: { from: 'http://127.0.0.1/', to: 'http://127.0.0.1/two', changed: true },
    });
    const text = T.formatActionResultOutput(result, {
      dispatchText: 'JS-clicked <A> "Next page"\nURL: http://127.0.0.1/two',
    });
    expect(text).toBe(`JS-clicked <A> "Next page"\nURL: http://127.0.0.1/two. Next: cdp perceive ${PREFIX} -C -d 8`);
  });

  it('keeps Next: cdp list only when the receipt has no target to perceive', () => {
    const text = T.formatActionResultOutput(clickResult({ domDiff: '+   [StaticText] Saved', targetId: null }), {
      dispatchText: 'Clicked <BUTTON> "Save"',
    });
    expect(text).toBe('Clicked <BUTTON> "Save". Next: cdp list');
  });

  it('other skinny actions (fill) also stop suggesting list when the target is known', () => {
    const result = T.createActionResult({
      action: 'fill',
      target: { targetId: TARGET_ID, input: '#q', resolvedBy: 'selector', label: '#q', commandArgs: ['#q', 'abc'] },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '+   [textbox] 搜尋 = "abc"', console: [], network: [], navigation: null },
    });
    const text = T.formatActionResultOutput(result, { dispatchText: 'Filled <INPUT> with "abc"' });
    expect(text).toBe(`Filled <INPUT> with "abc". Next: cdp perceive ${PREFIX} --since-action`);
  });
});

describe('#745 a receipt names the target by aria-label, then text, then title', () => {
  const element = ({ attrs = {}, text = '' } = {}) => ({
    textContent: text,
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
  });
  const labelOf = el => new Function('el', `return ${base.targetLabelExpression('el')};`)(el);

  it('prefers the visible text to a title such as antd\'s "[object Object]", on one line', () => {
    expect(labelOf(element({ attrs: { title: '[object Object]' }, text: '\n  B200\n  192 GB  ' }))).toBe('B200 192 GB');
  });

  // A small DOM tree: element and text nodes linked by firstChild / nextSibling.
  const tree = (tagName, { attrs = {}, children = [] } = {}) => {
    const node = { nodeType: 1, tagName, firstChild: children[0] || null, nextSibling: null, ...element({ attrs }) };
    children.forEach((child, i) => { child.nextSibling = children[i + 1] || null; });
    return node;
  };
  const text = nodeValue => ({ nodeType: 3, nodeValue, nextSibling: null });

  it('skips aria-hidden icon text, script and style, and a form field\'s options', () => {
    const iconButton = tree('BUTTON', { attrs: { title: 'More options' }, children: [tree('MAT-ICON', { attrs: { 'aria-hidden': 'true' }, children: [text('more_vert')] })] });
    expect(labelOf(iconButton)).toBe('More options');
    const option = tree('DIV', { attrs: { title: '[object Object]' }, children: [tree('SPAN', { children: [text('B200')] }), text(' '), tree('SPAN', { children: [text('192 GB')] }), tree('SCRIPT', { children: [text('x=1')] })] });
    expect(labelOf(option)).toBe('B200 192 GB');
    const select = tree('SELECT', { attrs: { title: 'Country' }, children: [tree('OPTION', { children: [text('United States')] })] });
    expect(labelOf(select)).toBe('Country');
  });

  it('a named click pointer-presses the resolved centre (#749)', async () => {
    const clicks = [];
    const button = {
      nodeType: 1,
      tagName: 'BUTTON',
      id: '',
      className: '',
      href: '',
      innerText: 'New Project',
      textContent: 'New Project',
      _rect: { x: 40, y: 50, width: 200, height: 40 },
      getAttribute: () => null,
      matches: () => false,
      closest: () => null,
      getBoundingClientRect() {
        const box = this._rect;
        return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height };
      },
      scrollIntoView() {},
      click() { clicks.push('New Project'); },
    };
    class Node {
      get isConnected() { return true; }
      get ownerDocument() { return this._owner || doc; }
      get parentNode() { return this._parent || null; }
      getRootNode() { return doc; }
    }
    Object.setPrototypeOf(button, Node.prototype);
    const doc = {
      nodeType: 9,
      elementFromPoint() { return button; },
      querySelector() { return null; },
      querySelectorAll: () => [button],
    };
    button._owner = doc;
    const context = {
      window: { innerWidth: 800, innerHeight: 600, scrollY: 0, MouseEvent: class {}, requestAnimationFrame(cb) { cb(); return 1; } },
      document: doc,
      location: { href: 'http://127.0.0.1/fixture' },
      Node, getComputedStyle: () => ({ position: 'static', overflowX: 'visible', overflowY: 'visible', transform: 'none', filter: 'none', contain: 'none', display: 'block', visibility: 'visible', pointerEvents: 'auto' }),
      Promise, Date, setTimeout, Math, Object, Reflect, String, Number, Array, JSON,
    };
    const mouse = [];
    let seen = [];
    let resolved = null;
    const cdp = {
      send(method, params = {}) {
        const src = method === 'Runtime.evaluate' ? String(params.expression || '') : String(params.functionDeclaration || '');
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
          const value = runInNewContext(src, context);
          if (params.returnByValue === false && value && value.nodeType === 1) {
            resolved = value;
            return Promise.resolve({ result: { type: 'object', subtype: 'node', objectId: 'named-el' } });
          }
          return Promise.resolve({ result: { value } });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = runInNewContext(`(${src})`, context);
          return Promise.resolve(fn.call(resolved)).then(value => ({ result: { value } }));
        }
        return Promise.resolve({});
      },
    };
    const out = await T.clickStr(cdp, 'sid', 'text=New Project');
    expect(out).toBe('Clicked <BUTTON> "New Project"');
    expect(mouse.filter(event => event.type === 'mousePressed')).toEqual([
      expect.objectContaining({ x: 140, y: 70, button: 'left' }),
    ]);
    expect(mouse.filter(event => event.type === 'mouseReleased')).toEqual([
      expect.objectContaining({ x: 140, y: 70, button: 'left' }),
    ]);
    expect(clicks).toEqual([]);
  });

  it('falls back to the title when there is no text, and lets aria-label win', () => {
    expect(labelOf(element({ attrs: { title: 'Close' }, text: '   ' }))).toBe('Close');
    expect(labelOf(element({ attrs: { 'aria-label': 'Save draft', title: 'Save' }, text: 'S' }))).toBe('Save draft');
    expect(labelOf(element({ text: 'x'.repeat(100) }))).toBe('x'.repeat(80));
    expect(labelOf(null)).toBe('');
  });
});
