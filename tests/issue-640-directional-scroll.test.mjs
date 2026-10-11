import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure, formatActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

// #640: `scroll <t> down|up [N]` moved only the window. On an app shell whose document does not
// scroll, nothing moved and the receipt still said "Scrolled by (0, 500)". A directional scroll now
// moves the document when it can scroll on that axis, else the page's main scroll container (the
// one `to bottom` and perceive's Scroll line use), and --scroll-container works with every direction.

function FakeElement() {}
FakeElement.prototype.scrollTo = function (...args) { return this._nativeScrollTo(...args); };
FakeElement.prototype.scrollBy = function (...args) { return this._nativeScrollBy(...args); };

function overflowElement({ id, scrollHeight, clientHeight, clientWidth = 800, overflowY = 'auto', overflowX = 'visible', scrollTop = 0 }) {
  const state = { scrollTop, scrollHeight, clientHeight, clientWidth, overflowY, overflowX, scrollEvents: 0 };
  const clamp = value => Math.max(0, Math.min(state.scrollHeight - state.clientHeight, Math.round(Number(value) || 0)));
  const el = {
    id,
    tagName: 'DIV',
    parentElement: null,
    get scrollTop() { return state.scrollTop; },
    get scrollHeight() { return state.scrollHeight; },
    get clientHeight() { return state.clientHeight; },
    get clientWidth() { return state.clientWidth; },
    _nativeScrollTo(options) { state.scrollTop = clamp(options.top); },
    _nativeScrollBy(options) { state.scrollTop = clamp(state.scrollTop + (Number(options.top) || 0)); },
    dispatchEvent() { state.scrollEvents += 1; return true; },
    _state: state,
  };
  return el;
}

// overflow-x clips and the content is wider than the box; height does not overflow.
function horizontalElement({
  id,
  scrollWidth,
  clientWidth,
  clientHeight = 120,
  scrollHeight = 120,
  overflowX = 'auto',
  overflowY = 'hidden',
  scrollLeft = 0,
}) {
  const state = {
    scrollLeft,
    scrollTop: 0,
    scrollWidth,
    clientWidth,
    scrollHeight,
    clientHeight,
    overflowX,
    overflowY,
    scrollEvents: 0,
  };
  const maxLeft = () => Math.max(0, state.scrollWidth - state.clientWidth);
  const el = {
    id,
    tagName: 'DIV',
    parentElement: null,
    get scrollLeft() { return state.scrollLeft; },
    get scrollTop() { return state.scrollTop; },
    get scrollWidth() { return state.scrollWidth; },
    get scrollHeight() { return state.scrollHeight; },
    get clientWidth() { return state.clientWidth; },
    get clientHeight() { return state.clientHeight; },
    _nativeScrollTo(options = {}) {
      if (Object.hasOwn(options, 'left')) {
        state.scrollLeft = Math.max(0, Math.min(maxLeft(), Math.round(Number(options.left) || 0)));
      }
      if (Object.hasOwn(options, 'top')) {
        state.scrollTop = Math.max(0, Math.min(state.scrollHeight - state.clientHeight, Math.round(Number(options.top) || 0)));
      }
    },
    _nativeScrollBy(options = {}) {
      state.scrollLeft = Math.max(0, Math.min(maxLeft(), state.scrollLeft + (Number(options.left) || 0)));
      state.scrollTop = Math.max(0, Math.min(Math.max(0, state.scrollHeight - state.clientHeight), state.scrollTop + (Number(options.top) || 0)));
    },
    dispatchEvent() { state.scrollEvents += 1; return true; },
    _state: state,
  };
  return el;
}

// A document `docScrollMax` px taller than the viewport, plus nested scrollers.
function page({ docScrollMax = 0, scrollY = 0, containers = [] } = {}) {
  const innerHeight = 800;
  const state = { scrollY, scrollHeight: innerHeight + docScrollMax, documentCalls: 0 };
  const scroller = {
    get scrollHeight() { return state.scrollHeight; },
    get scrollWidth() { return 1200; },
    get clientWidth() { return 1200; },
    _nativeScrollBy(options) {
      state.documentCalls += 1;
      state.scrollY = Math.max(0, Math.min(docScrollMax, state.scrollY + (Number(options.top) || 0)));
    },
    _nativeScrollTo(options) { state.scrollY = Math.max(0, Math.min(docScrollMax, Number(options.top) || 0)); },
  };
  const byId = new Map(containers.map(el => [`#${el.id}`, el]));
  const document = {
    scrollingElement: scroller,
    documentElement: scroller,
    querySelector: sel => byId.get(sel) || null,
    querySelectorAll: sel => (sel === '*' ? containers : []),
  };
  const window = {
    innerHeight,
    innerWidth: 1200,
    get scrollY() { return state.scrollY; },
    get scrollX() { return 0; },
    getComputedStyle: el => ({
      overflowX: el?._state?.overflowX || 'visible',
      overflowY: el?._state?.overflowY || 'visible',
      overflow: el?._state?.overflow || el?._state?.overflowY || 'visible',
    }),
  };
  return { state, window, document };
}

function pageCdp(fake) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
      const value = runInNewContext(String(params.expression || ''), {
        window: fake.window,
        document: fake.document,
        Element: FakeElement,
        Math,
        JSON,
        Number,
        String,
        Event: function Event(type) { this.type = type; },
      });
      return Promise.resolve({ result: { value } });
    },
  };
}

describe('#640 directional scroll', () => {
  it('puts the amount before --scroll-container wherever it was typed', () => {
    expect(T.normalizeScrollArgs(['down'])).toEqual(['down']);
    expect(T.normalizeScrollArgs(['down', '300'])).toEqual(['down', '300']);
    expect(T.normalizeScrollArgs(['down', '--scroll-container', '#list'])).toEqual(['down', '--scroll-container', '#list']);
    expect(T.normalizeScrollArgs(['down', '--scroll-container', '#list', '300'])).toEqual(['down', '300', '--scroll-container', '#list']);
    expect(T.normalizeScrollArgs(['to bottom', '--scroll-container', '#list'])).toEqual(['to', 'bottom', '--scroll-container', '#list']);
  });

  it('keeps the document receipt when the document scrolls', async () => {
    const list = overflowElement({ id: 'list', scrollHeight: 5000, clientHeight: 400 });
    const fake = page({ docScrollMax: 3000, containers: [list] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'down', '80')).toBe('Scrolled by (0, 80). Position: (0, 80)');
    expect(list.scrollTop).toBe(0);
    expect(cdp.calls[0].params.expression).toContain('chrome-cdp-ex.scroll-by');
    expect(cdp.calls[0].params.expression).not.toContain('chrome-cdp-ex.scroll-edge');
  });

  it('stays on the document at its bottom edge instead of scrolling some inner box', async () => {
    const code = overflowElement({ id: 'code', scrollHeight: 900, clientHeight: 300 });
    const fake = page({ docScrollMax: 3000, scrollY: 3000, containers: [code] });
    expect(await T.scrollStr(pageCdp(fake), 'sid', 'down', '500')).toBe('Scrolled by (0, 500). Position: (0, 3000)');
    expect(code.scrollTop).toBe(0);
  });

  it('moves the main scroll container when the document cannot scroll, and names it', async () => {
    const sidebar = overflowElement({ id: 'sidebar', scrollHeight: 1200, clientHeight: 800, clientWidth: 240 });
    const viewport = overflowElement({ id: 'viewport', scrollHeight: 18000, clientHeight: 800 });
    const fake = page({ docScrollMax: 0, containers: [sidebar, viewport] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'down', '6400')).toBe('Scrolled #viewport by (0, 6400): scrollTop 0 → 6400 / 17200 max');
    expect(viewport.scrollTop).toBe(6400);
    expect(viewport._state.scrollEvents).toBe(1);
    expect(sidebar.scrollTop).toBe(0);
    expect(fake.state.documentCalls).toBe(0);
    expect(await T.scrollStr(cdp, 'sid', 'up', '400')).toBe('Scrolled #viewport by (0, -400): scrollTop 6400 → 6000 / 17200 max');
  });

  it('reports the container edge instead of claiming a scroll', async () => {
    const viewport = overflowElement({ id: 'viewport', scrollHeight: 1800, clientHeight: 800, scrollTop: 900 });
    const cdp = pageCdp(page({ containers: [viewport] }));
    expect(await T.scrollStr(cdp, 'sid', 'down', '500')).toBe('Scrolled #viewport by (0, 500): scrollTop 900 → 1000 / 1000 max (at-bottom: yes)');
    expect(await T.scrollStr(cdp, 'sid', 'down', '500')).toBe('Did not scroll: #viewport is already at the bottom. scrollTop: 1000 / 1000 max');
  });

  it('accepts --scroll-container with any direction, with or without an amount', async () => {
    const sidebar = overflowElement({ id: 'sidebar', scrollHeight: 1200, clientHeight: 800, clientWidth: 240 });
    const viewport = overflowElement({ id: 'viewport', scrollHeight: 18000, clientHeight: 800 });
    const fake = page({ docScrollMax: 3000, containers: [sidebar, viewport] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'down', '--scroll-container', ['#sidebar']))
      .toBe('Scrolled #sidebar by (0, 500): scrollTop 0 → 400 / 400 max (at-bottom: yes)');
    expect(await T.scrollStr(cdp, 'sid', 'down', '250', ['--scroll-container', '#viewport']))
      .toBe('Scrolled #viewport by (0, 250): scrollTop 0 → 250 / 17200 max');
    expect(fake.state.scrollY).toBe(0);
    await expect(T.scrollStr(cdp, 'sid', 'down', '250', ['--scroll-container', '#missing'])).rejects.toThrow(/scroll-container not found/);
    await expect(T.scrollStr(cdp, 'sid', 'down', '250', ['--scroll-container', '@3'])).rejects.toThrow(/requires a CSS selector/);
  });

  it('fails when nothing on the page scrolls on that axis, with Kind not-scrollable', async () => {
    const cdp = pageCdp(page({ docScrollMax: 0 }));
    let error;
    try { await T.scrollStr(cdp, 'sid', 'down', '500'); } catch (caught) { error = caught; }
    expect(error?.message).toBe('scroll: nothing scrolled: nothing on the page scrolls vertically. Position: (0, 0)');
    const failure = classifyActionFailure(error, { action: 'scroll', target: { targetId: 'ABCDEF1234567890', input: 'down 500' } });
    expect(failure).toMatchObject({ kind: 'not-scrollable', nextCommand: 'cdp perceive ABCDEF12 -C -d 8' });
    await expect(T.scrollStr(cdp, 'sid', 'right', '300')).rejects.toThrow(/nothing scrolled: nothing on the page scrolls horizontally/);
  });

  it('scrolls a horizontal-only carousel on right and left without --scroll-container', async () => {
    const car = horizontalElement({ id: 'car', scrollWidth: 1600, clientWidth: 400 });
    const fake = page({ docScrollMax: 0, containers: [car] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'right', '300')).toBe('Scrolled #car by (300, 0): scrollLeft 0 → 300');
    expect(car.scrollLeft).toBe(300);
    expect(car._state.scrollEvents).toBe(1);
    expect(fake.state.documentCalls).toBe(0);
    expect(await T.scrollStr(cdp, 'sid', 'left', '80')).toBe('Scrolled #car by (-80, 0): scrollLeft 300 → 220');
    expect(car.scrollLeft).toBe(220);
    await expect(T.scrollStr(cdp, 'sid', 'down', '200')).rejects.toThrow(/nothing on the page scrolls vertically/);
    expect(car.scrollLeft).toBe(220);
    expect(car.scrollTop).toBe(0);
  });

  it('keeps vertical scroll on the vertical container when a carousel is also on the page', async () => {
    const list = overflowElement({ id: 'list', scrollHeight: 4000, clientHeight: 400 });
    const car = horizontalElement({ id: 'car', scrollWidth: 1600, clientWidth: 400, clientHeight: 80, scrollHeight: 80 });
    const fake = page({ docScrollMax: 0, containers: [list, car] });
    const cdp = pageCdp(fake);
    expect(await T.scrollStr(cdp, 'sid', 'down', '500')).toBe('Scrolled #list by (0, 500): scrollTop 0 → 500 / 3600 max');
    expect(list.scrollTop).toBe(500);
    expect(car.scrollLeft).toBe(0);
    expect(await T.scrollStr(cdp, 'sid', 'right', '300')).toBe('Scrolled #car by (300, 0): scrollLeft 0 → 300');
    expect(car.scrollLeft).toBe(300);
    expect(list.scrollTop).toBe(500);
    expect(fake.state.documentCalls).toBe(0);
  });

  it('accepts --scroll-container for a horizontal-only carousel', async () => {
    const car = horizontalElement({ id: 'car', scrollWidth: 1600, clientWidth: 400 });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [car] }));
    expect(await T.scrollStr(cdp, 'sid', 'right', '300', ['--scroll-container', '#car']))
      .toBe('Scrolled #car by (300, 0): scrollLeft 0 → 300');
    expect(car.scrollLeft).toBe(300);
  });

  it('does not treat a wide element as a sideways scroller unless overflow-x clips', async () => {
    const wide = horizontalElement({ id: 'wide', scrollWidth: 2000, clientWidth: 400, overflowX: 'visible', overflowY: 'visible' });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wide] }));
    await expect(T.scrollStr(cdp, 'sid', 'right', '300')).rejects.toThrow(/nothing on the page scrolls horizontally/);
    expect(wide.scrollLeft).toBe(0);
  });

  // A full-page overflow-x:hidden wrapper (a closed side menu) still accepts scrollLeft.
  // Automatic selection must not pick it over a smaller overflow-x:auto carousel.
  it('scrolls the inner carousel when a larger overflow-x:hidden wrapper surrounds it', async () => {
    const wrap = horizontalElement({
      id: 'wrap',
      scrollWidth: 2000,
      clientWidth: 1200,
      clientHeight: 800,
      scrollHeight: 800,
      overflowX: 'hidden',
      overflowY: 'hidden',
    });
    const car = horizontalElement({
      id: 'car',
      scrollWidth: 1600,
      clientWidth: 400,
      clientHeight: 120,
      scrollHeight: 120,
      overflowX: 'auto',
      overflowY: 'hidden',
    });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wrap, car] }));
    expect(await T.scrollStr(cdp, 'sid', 'right', '300')).toBe('Scrolled #car by (300, 0): scrollLeft 0 → 300');
    expect(car.scrollLeft).toBe(300);
    expect(wrap.scrollLeft).toBe(0);
    expect(wrap._state.scrollEvents).toBe(0);
  });

  it('fails not-scrollable when the only sideways overflow is overflow-x:hidden', async () => {
    const wrap = horizontalElement({
      id: 'wrap',
      scrollWidth: 2000,
      clientWidth: 1200,
      clientHeight: 800,
      scrollHeight: 800,
      overflowX: 'hidden',
      overflowY: 'hidden',
    });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wrap] }));
    let error;
    try { await T.scrollStr(cdp, 'sid', 'right', '300'); } catch (caught) { error = caught; }
    expect(error?.message).toBe('scroll: nothing scrolled: nothing on the page scrolls horizontally. Position: (0, 0)');
    expect(wrap.scrollLeft).toBe(0);
    const failure = classifyActionFailure(error, { action: 'scroll', target: { targetId: 'ABCDEF1234567890', input: 'right 300' } });
    expect(failure).toMatchObject({ kind: 'not-scrollable', nextCommand: 'cdp perceive ABCDEF12 -C -d 8' });
  });

  it('still scrolls an overflow-x:hidden box when --scroll-container names it', async () => {
    const wrap = horizontalElement({
      id: 'wrap',
      scrollWidth: 2000,
      clientWidth: 1200,
      clientHeight: 800,
      scrollHeight: 800,
      overflowX: 'hidden',
      overflowY: 'hidden',
    });
    const car = horizontalElement({
      id: 'car',
      scrollWidth: 1600,
      clientWidth: 400,
      clientHeight: 120,
      scrollHeight: 120,
      overflowX: 'auto',
      overflowY: 'hidden',
    });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wrap, car] }));
    expect(await T.scrollStr(cdp, 'sid', 'right', '300', ['--scroll-container', '#wrap']))
      .toBe('Scrolled #wrap by (300, 0): scrollLeft 0 → 300');
    expect(wrap.scrollLeft).toBe(300);
    expect(car.scrollLeft).toBe(0);
  });

  it('scrolls the inner list when a larger overflow-y:hidden wrapper surrounds it', async () => {
    const wrap = overflowElement({
      id: 'wrap',
      scrollHeight: 5000,
      clientHeight: 800,
      clientWidth: 1200,
      overflowY: 'hidden',
      overflowX: 'hidden',
    });
    const list = overflowElement({
      id: 'list',
      scrollHeight: 4000,
      clientHeight: 400,
      clientWidth: 400,
      overflowY: 'auto',
      overflowX: 'hidden',
    });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wrap, list] }));
    expect(await T.scrollStr(cdp, 'sid', 'down', '500')).toBe('Scrolled #list by (0, 500): scrollTop 0 → 500 / 3600 max');
    expect(list.scrollTop).toBe(500);
    expect(wrap.scrollTop).toBe(0);
    expect(wrap._state.scrollEvents).toBe(0);
  });

  it('scrolls that inner list to the bottom instead of the hidden wrapper', async () => {
    const wrap = overflowElement({
      id: 'wrap',
      scrollHeight: 5000,
      clientHeight: 800,
      clientWidth: 1200,
      overflowY: 'hidden',
      overflowX: 'hidden',
    });
    const list = overflowElement({
      id: 'list',
      scrollHeight: 4000,
      clientHeight: 400,
      clientWidth: 400,
      overflowY: 'auto',
      overflowX: 'hidden',
    });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wrap, list] }));
    expect(await T.scrollStr(cdp, 'sid', 'to', 'bottom'))
      .toBe('Scrolled to bottom. #list scrollTop: 3600 / 3600 max (at-bottom: yes)');
    expect(list.scrollTop).toBe(3600);
    expect(wrap.scrollTop).toBe(0);
  });

  it('fails not-scrollable when the only vertical overflow is overflow-y:hidden', async () => {
    const wrap = overflowElement({
      id: 'wrap',
      scrollHeight: 5000,
      clientHeight: 800,
      clientWidth: 1200,
      overflowY: 'hidden',
      overflowX: 'hidden',
    });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wrap] }));
    let error;
    try { await T.scrollStr(cdp, 'sid', 'down', '500'); } catch (caught) { error = caught; }
    expect(error?.message).toBe('scroll: nothing scrolled: nothing on the page scrolls vertically. Position: (0, 0)');
    expect(wrap.scrollTop).toBe(0);
    const failure = classifyActionFailure(error, { action: 'scroll', target: { targetId: 'ABCDEF1234567890', input: 'down 500' } });
    expect(failure).toMatchObject({ kind: 'not-scrollable', nextCommand: 'cdp perceive ABCDEF12 -C -d 8' });
  });

  it('hints that an overflow:hidden region is reached with --scroll-container', () => {
    const error = new Error('scroll: nothing scrolled: nothing on the page scrolls vertically. Position: (0, 0)');
    const failure = classifyActionFailure(error, {
      action: 'scroll',
      target: { targetId: 'ABCDEF1234567890', input: 'down 500' },
    });
    const hints = failure.hints.join('\n');
    expect(hints).toMatch(/--scroll-container/);
    expect(hints).toMatch(/overflow:hidden/);
  });

  it('still scrolls an overflow-y:hidden box when --scroll-container names it', async () => {
    const wrap = overflowElement({
      id: 'wrap',
      scrollHeight: 5000,
      clientHeight: 800,
      clientWidth: 1200,
      overflowY: 'hidden',
      overflowX: 'hidden',
    });
    const list = overflowElement({
      id: 'list',
      scrollHeight: 4000,
      clientHeight: 400,
      clientWidth: 400,
      overflowY: 'auto',
      overflowX: 'hidden',
    });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [wrap, list] }));
    expect(await T.scrollStr(cdp, 'sid', 'down', '500', ['--scroll-container', '#wrap']))
      .toBe('Scrolled #wrap by (0, 500): scrollTop 0 → 500 / 4200 max');
    expect(wrap.scrollTop).toBe(500);
    expect(list.scrollTop).toBe(0);
  });

  it('treats overflow scroll and overlay as automatic containers, and not clip', async () => {
    for (const overflowX of ['scroll', 'overlay']) {
      const car = horizontalElement({ id: 'car', scrollWidth: 1600, clientWidth: 400, overflowX, overflowY: 'hidden' });
      const cdp = pageCdp(page({ docScrollMax: 0, containers: [car] }));
      expect(await T.scrollStr(cdp, 'sid', 'right', '300')).toBe('Scrolled #car by (300, 0): scrollLeft 0 → 300');
    }
    for (const overflowY of ['scroll', 'overlay']) {
      const list = overflowElement({ id: 'list', scrollHeight: 4000, clientHeight: 400, overflowY, overflowX: 'visible' });
      const cdp = pageCdp(page({ docScrollMax: 0, containers: [list] }));
      expect(await T.scrollStr(cdp, 'sid', 'down', '200')).toBe('Scrolled #list by (0, 200): scrollTop 0 → 200 / 3600 max');
    }
    const clipped = horizontalElement({ id: 'clip', scrollWidth: 2000, clientWidth: 400, overflowX: 'clip', overflowY: 'clip' });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [clipped] }));
    await expect(T.scrollStr(cdp, 'sid', 'right', '300')).rejects.toThrow(/nothing on the page scrolls horizontally/);
    expect(clipped.scrollLeft).toBe(0);
  });

  it('exports to bottom without treating overflow hidden as an automatic container', () => {
    const line = T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'bottom'],
      replayable: true,
    }).lines[0];
    expect(line).toMatch(/\/\(auto\|scroll\|overlay\)\//);
    expect(line).not.toContain('hidden');
  });

  it('names the axis when nothing scrolls that way, and the command before the Kind suffix is a shell command', async () => {
    const list = overflowElement({ id: 'list', scrollHeight: 4000, clientHeight: 400 });
    const cdp = pageCdp(page({ docScrollMax: 0, containers: [list] }));
    let error;
    try { await T.scrollStr(cdp, 'sid', 'right', '300'); } catch (caught) { error = caught; }
    expect(error?.message).toBe('scroll: nothing scrolled: nothing on the page scrolls horizontally. Position: (0, 0)');
    expect(error?.message).not.toContain('no scroll container was found');
    expect(list.scrollTop).toBe(0);
    const target = { targetId: 'ABCDEF1234567890', input: 'right 300' };
    const failure = classifyActionFailure(error, { action: 'scroll', target });
    expect(failure).toMatchObject({
      kind: 'not-scrollable',
      nextCommand: 'cdp perceive ABCDEF12 -C -d 8',
    });
    expect(failure.nextCommand).not.toMatch(/[<>]/);
    expect(failure.reason).not.toContain('no scroll container was found');
    const formatted = formatActionFailure(error, { action: 'scroll', target });
    expect(formatted).toBe([
      'Error: scroll: nothing scrolled: nothing on the page scrolls horizontally. Position: (0, 0)',
      'Kind: not-scrollable',
      'Next: cdp perceive ABCDEF12 -C -d 8',
    ].join('\n'));
    const cli = T.formatCliError(new Error(formatted), { cmd: 'scroll', targetPrefix: 'ABCDEF12', args: ['right', '300'] });
    const nextLine = cli.split('\n').at(-1);
    const runnable = 'cdp perceive ABCDEF12 -C -d 8';
    expect(nextLine).toBe(`Next: ${runnable} (Kind: not-scrollable)`);
    const syntax = spawnSync('bash', ['-nc', runnable], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('still reads the old {x, y} reply of a page that answers only that shape', async () => {
    const cdp = { send: () => Promise.resolve({ result: { value: '{"x":0,"y":0}' } }) };
    expect(await T.scrollStr(cdp, 'sid', 'down', '100')).toBe('Scrolled by (0, 100). Position: (0, 0)');
  });
});
