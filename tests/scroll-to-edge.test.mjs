import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

const HF_HOME_VIEWPORT = { width: 1042, height: 632 };
const HF_HOME_SCROLL_MAX = 5295;

function leftoverGoldenPathDump({
  scrollY = 0,
  scrollMax = HF_HOME_SCROLL_MAX,
} = {}) {
  return [
    `Page: Hugging Face — https://huggingface.co/`,
    `Viewport: ${HF_HOME_VIEWPORT.width}×${HF_HOME_VIEWPORT.height} | Scroll: ${scrollY}/${scrollMax} (0%) | Focused: none`,
    'Interactive: 12 a',
    'Console: clean',
    '',
    '[RootWebArea] Hugging Face',
    '  [link] Models',
    '(no changes detected in AX tree)',
  ].join('\n');
}

function createDocumentScrollPage({
  scrollY = 0,
  innerHeight = HF_HOME_VIEWPORT.height,
  scrollMax = HF_HOME_SCROLL_MAX,
  clampTo = null,
} = {}) {
  const state = {
    scrollY,
    innerHeight,
    scrollHeight: scrollMax + innerHeight,
  };
  const scroller = {
    get scrollHeight() { return state.scrollHeight; },
  };
  const windowObj = {
    get innerHeight() { return state.innerHeight; },
    get scrollY() { return state.scrollY; },
    get scrollX() { return 0; },
    scrollTo(_x, y) {
      const max = Math.max(0, state.scrollHeight - state.innerHeight);
      const requested = clampTo == null ? y : clampTo;
      state.scrollY = Math.max(0, Math.min(max, Math.round(Number(requested) || 0)));
    },
    scrollBy(_x, y) {
      windowObj.scrollTo(0, state.scrollY + (Number(y) || 0));
    },
  };
  const documentObj = {
    scrollingElement: scroller,
    documentElement: scroller,
  };
  return { state, window: windowObj, document: documentObj };
}

function evaluateOnPage(page, expression) {
  return runInNewContext(expression, {
    window: page.window,
    document: page.document,
    Math,
    JSON,
    Number,
    Event: page.Event || function Event(type) { this.type = type; },
  });
}

function documentScrollCdp(page) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
      const value = evaluateOnPage(page, String(params.expression || ''));
      return Promise.resolve({ result: { value } });
    },
  };
}

describe('issue #323 scroll to top/bottom', () => {
  it('parses first-class to top/to bottom and keeps relative scroll as settle-diff', () => {
    expect(T.parseScrollEdge('to', 'bottom')).toBe('bottom');
    expect(T.parseScrollEdge('to', 'top')).toBe('top');
    expect(T.parseScrollEdge('TO', 'BOTTOM')).toBe('bottom');
    expect(T.parseScrollEdge('down', '80')).toBeNull();
    expect(T.parseScrollEdge('down', '10000')).toBeNull();
    expect(T.parseScrollEdge('0,500')).toBeNull();
    expect(T.scrollFeedbackPolicy('to', 'bottom')).toBe('report-only');
    expect(T.scrollFeedbackPolicy('to', 'top')).toBe('report-only');
    expect(T.scrollFeedbackPolicy('down', '80')).toBe('settle-diff');
    expect(T.scrollFeedbackPolicy('down', '10000')).toBe('settle-diff');
    expect(() => T.parseScrollEdge('to', '0')).toThrow(/Direction required: to top or to bottom/);
    expect(() => T.parseScrollEdge('to')).toThrow(/Direction required: to top or to bottom/);
  });

  it('documents to top/to bottom on the existing scroll command', () => {
    const scroll = COMMAND_SURFACE.resolve('scroll');
    expect(scroll.help.synopsis).toMatch(/to top/);
    expect(scroll.help.synopsis).toMatch(/to bottom/);
    expect(scroll.help.synopsis).toMatch(/--scroll-container SELECTOR/);
    expect(scroll.help.summary).toMatch(/nested overflow/);
    expect(scroll.feedbackPolicy).toBe('settle-diff');
    expect(T.helpStr()).toMatch(/to top\|to bottom/);
    expect(T.helpStr()).toMatch(/--scroll-container SELECTOR/);
    expect(T.helpTopicStr('scroll')).toMatch(/to top\|to bottom/);
    expect(T.helpTopicStr('scroll')).toMatch(/nested overflow/);
  });

  it('scrolls the window document to the bottom from the top on the HF home job', async () => {
    const page = createDocumentScrollPage({ scrollY: 0 });
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'bottom');
    expect(page.state.scrollY).toBe(HF_HOME_SCROLL_MAX);
    expect(page.state.scrollY).toBeGreaterThanOrEqual(HF_HOME_SCROLL_MAX - T.DOCUMENT_SCROLL_EDGE_TOLERANCE_PX);
    expect(text).toBe(`Scrolled to bottom. scrollY: ${HF_HOME_SCROLL_MAX} / ${HF_HOME_SCROLL_MAX} max (at-bottom: yes)`);
    expect(text).toMatch(/scrollY: 5295 \/ 5295 max/);
    expect(text).toMatch(/at-bottom: yes/);
    const expr = cdp.calls[0].params.expression;
    expect(expr).toContain('chrome-cdp-ex.scroll-edge');
    expect(expr).toContain('window.scrollTo');
    expect(expr).not.toContain('scrollBy');
  });

  it('scrolls the window document back to the top', async () => {
    const page = createDocumentScrollPage({ scrollY: HF_HOME_SCROLL_MAX });
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'top');
    expect(page.state.scrollY).toBe(0);
    expect(text).toBe('Scrolled to top. scrollY: 0 / 5295 max (at-top: yes)');
  });

  it('keeps leftover relative scrollBy no-change behavior on the same window document', async () => {
    const page = createDocumentScrollPage({ scrollY: HF_HOME_SCROLL_MAX });
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(page.state.scrollY).toBe(HF_HOME_SCROLL_MAX);
    expect(text).toBe('Scrolled by (0, 80). Position: (0, 5295)');
    expect(cdp.calls[0].params.expression).toContain('scrollBy');
    expect(cdp.calls[0].params.expression).not.toContain('document-scroll-edge');
    expect(T.scrollFeedbackPolicy('down', '80')).toBe('settle-diff');
  });

  it('prints a skinny report-only receipt without reprinting the AX tree', async () => {
    const page = createDocumentScrollPage({ scrollY: 0 });
    const cdp = documentScrollCdp(page);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'to', 'bottom');
    let observed = false;
    const text = await T.runActionWithFeedback({
      action: 'scroll',
      target: {
        targetId: 'HFHOME01ABCDEF0123456789ABCDEF01',
        input: 'to bottom',
        resolvedBy: 'scroll',
        label: 'to bottom',
      },
      dispatch: async () => dispatchText,
      feedbackPolicy: T.scrollFeedbackPolicy('to', 'bottom'),
      observe: async () => {
        observed = true;
        return [
          'Page: Hugging Face',
          'Viewport: 1042×632 | Scroll: 0/5295 (0%)',
          '[RootWebArea] Hugging Face',
          '  [link] Models',
          '(no changes detected in AX tree)',
        ].join('\n');
      },
    });
    expect(observed).toBe(false);
    expect(text).toContain(dispatchText);
    expect(text).toMatch(/scrollY: 5295 \/ 5295 max/);
    expect(text).toMatch(/at-bottom: yes/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/^Page: /m);
    expect(text).not.toMatch(/no changes detected in AX tree/);
    expect(text.length).toBeLessThan(800);
    expect(page.state.scrollY).toBeGreaterThanOrEqual(HF_HOME_SCROLL_MAX - 2);
  });

  it('exports Playwright window scrollTo for to top/to bottom and keeps wheel for relative scroll', () => {
    expect(T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'bottom'],
      replayable: true,
    }).lines[0]).toMatch(/window\.scrollTo/);
    expect(T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'top'],
      replayable: true,
    }).lines[0]).toMatch(/window\.scrollTo\(0, 0\)/);
    expect(T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'down', '80'],
      replayable: true,
    }).lines[0]).toBe('await page.mouse.wheel(0, 80);');
  });

  it('rejects the old guess forms that were not valid CLI', async () => {
    const page = createDocumentScrollPage();
    const cdp = documentScrollCdp(page);
    await expect(T.scrollStr(cdp, 'sid', 'to', '0')).rejects.toThrow(/Direction required: to top or to bottom/);
    await expect(T.scrollStr(cdp, 'sid', 'bottom')).rejects.toThrow(/Direction required/);
  });

  it('fails when scrollTo clamps short of scrollMax - 2', async () => {
    const shortOfBottom = HF_HOME_SCROLL_MAX - T.DOCUMENT_SCROLL_EDGE_TOLERANCE_PX - 1;
    const page = createDocumentScrollPage({ scrollY: 0, clampTo: shortOfBottom });
    const cdp = documentScrollCdp(page);
    const err = await T.scrollStr(cdp, 'sid', 'to', 'bottom').then(
      () => { throw new Error('expected scroll to bottom to fail short of the edge'); },
      (caught) => caught,
    );
    expect(err.message).toBe(
      `Did not reach document bottom. scrollY: ${shortOfBottom} / ${HF_HOME_SCROLL_MAX} max (at-bottom: no)`,
    );
    expect(err.message).not.toMatch(/Scrolled to bottom/);
    expect(err.message).not.toMatch(/\brequired\b/);
    expect(page.state.scrollY).toBe(shortOfBottom);
    expect(page.state.scrollY).toBeLessThan(HF_HOME_SCROLL_MAX - T.DOCUMENT_SCROLL_EDGE_TOLERANCE_PX);
    await expect(T.runActionWithFeedback({
      action: 'scroll',
      target: T.scrollActionTarget(['to', 'bottom'], { targetId: 'HFHOME01ABCDEF0123456789ABCDEF01' }),
      dispatch: () => T.scrollStr(cdp, 'sid', 'to', 'bottom'),
      feedbackPolicy: T.scrollFeedbackPolicy('to', 'bottom'),
      observe: async () => leftoverGoldenPathDump(),
    })).rejects.toThrow(/^Kind: unknown\nNext: /);
  });

  it('fails when scrollTo clamps short of the top', async () => {
    const page = createDocumentScrollPage({ scrollY: HF_HOME_SCROLL_MAX, clampTo: 100 });
    const cdp = documentScrollCdp(page);
    const err = await T.scrollStr(cdp, 'sid', 'to', 'top').then(
      () => { throw new Error('expected scroll to top to fail short of the edge'); },
      (caught) => caught,
    );
    expect(err.message).toBe('Did not reach document top. scrollY: 100 / 5295 max (at-top: no)');
    expect(err.message).not.toMatch(/Scrolled to top/);
    expect(err.message).not.toMatch(/\brequired\b/);
    expect(page.state.scrollY).toBe(100);
  });

  it('does not tag leftover-ax-scroll-no-change or grow Next -C -d 8 on to bottom after leftover AX', async () => {
    const leftoverDump = leftoverGoldenPathDump();
    const snapshotOpts = { cursorInteractive: true, depth: 8 };
    const target = T.scrollActionTarget(['to', 'bottom'], {
      targetId: 'HFHOME01ABCDEF0123456789ABCDEF01',
    });
    expect(T.isLeftoverDefaultAxScrollSettle(leftoverDump, snapshotOpts, target)).toBe(true);
    T.tagScrollLeftoverSettle('scroll', target, leftoverDump, snapshotOpts);
    expect(target.expectedOutcome).toBe(T.DOCUMENT_SCROLL_EDGE_OUTCOME);
    expect(target.expectedOutcome).not.toBe('leftover-ax-scroll-no-change');
    expect(T.isDocumentScrollEdgeTarget(target)).toBe(true);

    const page = createDocumentScrollPage({ scrollY: 0 });
    const cdp = documentScrollCdp(page);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'to', 'bottom');
    const result = T.createActionResult({
      action: 'scroll',
      target,
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 12 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionResultOutput(result, { dispatchText });
    expect(result.outcome.status).toBe('dispatched');
    expect(result.target.expectedOutcome).toBe('document-scroll-edge');
    expect(text).toContain(dispatchText);
    expect(text).toMatch(/at-bottom: yes/);
    expect(text).not.toMatch(/leftover-ax-scroll-no-change/);
    expect(text).not.toMatch(/Next: cdp perceive .* -C -d 8/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/no changes detected in AX tree/);
  });

  it('still tags leftover-ax-scroll-no-change for relative scroll down N after leftover AX', async () => {
    const leftoverDump = leftoverGoldenPathDump({ scrollY: HF_HOME_SCROLL_MAX });
    const snapshotOpts = { cursorInteractive: true, depth: 8 };
    const target = T.scrollActionTarget(['down', '80'], {
      targetId: 'HFHOME01ABCDEF0123456789ABCDEF01',
    });
    expect(T.scrollFeedbackPolicy('down', '80')).toBe('settle-diff');
    expect(target.expectedOutcome).toBeUndefined();
    T.tagScrollLeftoverSettle('scroll', target, leftoverDump, snapshotOpts);
    expect(target.expectedOutcome).toBe('leftover-ax-scroll-no-change');

    const result = T.createActionResult({
      action: 'scroll',
      target,
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: leftoverDump, console: [], network: [], navigation: null },
    });
    const text = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 5295)',
    });
    expect(result.outcome.status).toBe('no-change');
    expect(text).toMatch(/Next: cdp perceive HFHOME01 -C -d 8/);
  });

  it('leaves nested overflow unchanged when scrolling the window document', async () => {
    const page = createDocumentScrollPage({ scrollY: 0 });
    const nested = { id: 'content-container', scrollTop: 400, scrollHeight: 8000 };
    page.document.querySelector = (sel) => (sel === '#content-container' ? nested : null);
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'bottom');
    expect(nested.scrollTop).toBe(400);
    expect(page.state.scrollY).toBe(HF_HOME_SCROLL_MAX);
    expect(text).toMatch(/at-bottom: yes/);
    expect(text).toMatch(/scrollY: 5295 \/ 5295 max/);
    expect(text).not.toMatch(/scrollTop/);
  });
});

const COMFY_VIEWPORT = { width: 1042, height: 632 };
const COMFY_CONTAINER_SCROLL_MAX = 6483;

function createOverflowElement({
  id,
  tagName = 'DIV',
  scrollTop = 0,
  scrollHeight,
  clientHeight,
  clientWidth,
  overflowY = 'auto',
  clampTo = null,
  parentElement = null,
} = {}) {
  const state = { scrollTop, scrollHeight, clientHeight, clientWidth, overflowY };
  const el = {
    id,
    tagName,
    parentElement,
    get scrollTop() { return state.scrollTop; },
    set scrollTop(value) {
      const max = Math.max(0, state.scrollHeight - state.clientHeight);
      const requested = clampTo == null ? value : clampTo;
      state.scrollTop = Math.max(0, Math.min(max, Math.round(Number(requested) || 0)));
    },
    get scrollHeight() { return state.scrollHeight; },
    get clientHeight() { return state.clientHeight; },
    get clientWidth() { return state.clientWidth; },
    dispatchEvent() { return true; },
    _state: state,
  };
  return el;
}

function createNestedOverflowPage({
  containerScrollTop = 0,
  clampTo = null,
} = {}) {
  const innerHeight = COMFY_VIEWPORT.height;
  const page = createDocumentScrollPage({
    scrollY: 0,
    innerHeight,
    scrollMax: 0,
  });
  const body = { id: '', tagName: 'BODY', parentElement: page.document.documentElement, clientHeight: innerHeight, clientWidth: COMFY_VIEWPORT.width, scrollHeight: innerHeight, scrollTop: 0 };
  const sidebar = createOverflowElement({
    id: 'sidebar',
    scrollTop: 0,
    scrollHeight: innerHeight + 1800,
    clientHeight: innerHeight,
    clientWidth: 248,
    overflowY: 'auto',
    parentElement: body,
  });
  const content = createOverflowElement({
    id: 'content-container',
    scrollTop: containerScrollTop,
    scrollHeight: innerHeight + COMFY_CONTAINER_SCROLL_MAX,
    clientHeight: innerHeight,
    clientWidth: 794,
    overflowY: 'auto',
    clampTo,
    parentElement: body,
  });
  const footer = createOverflowElement({
    id: 'mintlify-footer',
    scrollTop: 0,
    scrollHeight: 40,
    clientHeight: 40,
    clientWidth: 794,
    overflowY: 'visible',
    parentElement: content,
  });
  const nodes = [sidebar, content, footer];
  page.document.body = body;
  page.document.querySelector = (sel) => {
    if (sel === '#content-container') return content;
    if (sel === '#sidebar') return sidebar;
    if (sel === '#mintlify-footer') return footer;
    return null;
  };
  page.document.querySelectorAll = (sel) => (sel === '*' ? nodes : []);
  page.window.getComputedStyle = (el) => ({
    overflowY: el?._state?.overflowY || 'visible',
    overflow: el?._state?.overflowY || 'visible',
  });
  page.content = content;
  page.sidebar = sidebar;
  page.footer = footer;
  return page;
}

describe('issue #326 scroll nested overflow to top/bottom', () => {
  it('scrolls #content-container to the bottom when the document cannot scroll', async () => {
    const page = createNestedOverflowPage({ containerScrollTop: 0 });
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'bottom');
    expect(page.state.scrollY).toBe(0);
    expect(page.content.scrollTop).toBe(COMFY_CONTAINER_SCROLL_MAX);
    expect(page.content.scrollTop).toBeGreaterThanOrEqual(COMFY_CONTAINER_SCROLL_MAX - T.DOCUMENT_SCROLL_EDGE_TOLERANCE_PX);
    expect(page.sidebar.scrollTop).toBe(0);
    expect(text).toBe(`Scrolled to bottom. #content-container scrollTop: ${COMFY_CONTAINER_SCROLL_MAX} / ${COMFY_CONTAINER_SCROLL_MAX} max (at-bottom: yes)`);
    expect(text).not.toMatch(/scrollY: 0 \/ 0 max/);
    expect(text).not.toMatch(/at-bottom: yes.*0 \/ 0/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text.length).toBeLessThan(800);
    const expr = cdp.calls[0].params.expression;
    expect(expr).toContain('chrome-cdp-ex.scroll-edge');
    expect(expr).toContain('scrollTop');
  });

  it('scrolls the overflow container back to the top', async () => {
    const page = createNestedOverflowPage({ containerScrollTop: COMFY_CONTAINER_SCROLL_MAX });
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'top');
    expect(page.content.scrollTop).toBe(0);
    expect(text).toBe('Scrolled to top. #content-container scrollTop: 0 / 6483 max (at-top: yes)');
  });

  it('accepts --scroll-container and walks up from a descendant to the overflow ancestor', async () => {
    const page = createNestedOverflowPage({ containerScrollTop: 0 });
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'bottom', ['--scroll-container', '#mintlify-footer']);
    expect(page.content.scrollTop).toBe(COMFY_CONTAINER_SCROLL_MAX);
    expect(text).toMatch(/#content-container scrollTop: 6483 \/ 6483 max \(at-bottom: yes\)/);
  });

  it('targets an explicit overflow selector even when the document can also scroll', async () => {
    const page = createDocumentScrollPage({ scrollY: 0 });
    const nested = createOverflowElement({
      id: 'content-container',
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
      clientWidth: 400,
      overflowY: 'auto',
    });
    page.document.querySelector = (sel) => (sel === '#content-container' ? nested : null);
    page.document.querySelectorAll = () => [nested];
    page.window.getComputedStyle = (el) => ({
      overflowY: el?._state?.overflowY || 'visible',
      overflow: el?._state?.overflowY || 'visible',
    });
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'bottom', ['--scroll-container', '#content-container']);
    expect(nested.scrollTop).toBe(600);
    expect(page.state.scrollY).toBe(0);
    expect(text).toBe('Scrolled to bottom. #content-container scrollTop: 600 / 600 max (at-bottom: yes)');
  });

  it('fails when the overflow container clamps short of scrollMax - 2', async () => {
    const shortOfBottom = COMFY_CONTAINER_SCROLL_MAX - T.DOCUMENT_SCROLL_EDGE_TOLERANCE_PX - 1;
    const page = createNestedOverflowPage({ containerScrollTop: 0, clampTo: shortOfBottom });
    const cdp = documentScrollCdp(page);
    const err = await T.scrollStr(cdp, 'sid', 'to', 'bottom').then(
      () => { throw new Error('expected nested overflow scroll to bottom to fail short of the edge'); },
      (caught) => caught,
    );
    expect(err.message).toBe(
      `Did not reach container bottom. #content-container scrollTop: ${shortOfBottom} / ${COMFY_CONTAINER_SCROLL_MAX} max (at-bottom: no)`,
    );
    expect(err.message).not.toMatch(/Scrolled to bottom/);
    expect(err.message).not.toMatch(/scrollY: 0 \/ 0 max \(at-bottom: yes\)/);
    expect(page.content.scrollTop).toBe(shortOfBottom);
    expect(page.content.scrollTop).toBeLessThan(COMFY_CONTAINER_SCROLL_MAX - T.DOCUMENT_SCROLL_EDGE_TOLERANCE_PX);
  });

  it('prints a skinny report-only container receipt without leftover AX settle', async () => {
    const page = createNestedOverflowPage({ containerScrollTop: 0 });
    const cdp = documentScrollCdp(page);
    const dispatchText = await T.scrollStr(cdp, 'sid', 'to', 'bottom');
    let observed = false;
    const leftoverDump = leftoverGoldenPathDump();
    const snapshotOpts = { cursorInteractive: true, depth: 8 };
    const target = T.scrollActionTarget(['to', 'bottom'], {
      targetId: '0D34570AABCDEF0123456789ABCDEF01',
    });
    T.tagScrollLeftoverSettle('scroll', target, leftoverDump, snapshotOpts);
    expect(target.expectedOutcome).toBe(T.DOCUMENT_SCROLL_EDGE_OUTCOME);
    const text = await T.runActionWithFeedback({
      action: 'scroll',
      target,
      dispatch: async () => dispatchText,
      feedbackPolicy: T.scrollFeedbackPolicy('to', 'bottom'),
      observe: async () => {
        observed = true;
        return leftoverDump;
      },
    });
    expect(observed).toBe(false);
    expect(text).toContain(dispatchText);
    expect(text).toMatch(/scrollTop: 6483 \/ 6483 max/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/^Page: /m);
    expect(text).not.toMatch(/Next: cdp perceive .* -C -d 8/);
    const result = T.createActionResult({
      action: 'scroll',
      target,
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 12 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const formatted = T.formatActionResultOutput(result, { dispatchText });
    expect(formatted).toContain(dispatchText);
    expect(formatted).not.toMatch(/leftover-ax-scroll-no-change/);
    expect(formatted).not.toMatch(/Next: cdp perceive .* -C -d 8/);
    expect(formatted).not.toMatch(/RootWebArea/);
  });

  it('does not change relative scroll down N leftover settle-diff', async () => {
    expect(T.parseScrollContainerArg([])).toBe(null);
    expect(T.parseScrollContainerArg(['--scroll-container', '#content-container'])).toBe('#content-container');
    expect(() => T.parseScrollContainerArg(['--scroll-container'])).toThrow(/--scroll-container requires a selector/);
    expect(T.scrollFeedbackPolicy('down', '80')).toBe('settle-diff');
    const leftoverDump = leftoverGoldenPathDump({ scrollY: HF_HOME_SCROLL_MAX });
    const snapshotOpts = { cursorInteractive: true, depth: 8 };
    const target = T.scrollActionTarget(['down', '80'], {
      targetId: 'HFHOME01ABCDEF0123456789ABCDEF01',
    });
    T.tagScrollLeftoverSettle('scroll', target, leftoverDump, snapshotOpts);
    expect(target.expectedOutcome).toBe('leftover-ax-scroll-no-change');
    const page = createNestedOverflowPage({ containerScrollTop: 0 });
    const cdp = documentScrollCdp(page);
    await expect(T.scrollStr(cdp, 'sid', 'to', 'bottom', ['--scroll-container', '@3']))
      .rejects.toThrow(/requires a CSS selector/);
    const text = await T.scrollStr(cdp, 'sid', 'down', '80');
    expect(page.content.scrollTop).toBe(0);
    expect(text).toBe('Scrolled by (0, 80). Position: (0, 0)');
    expect(cdp.calls[0].params.expression).toContain('scrollBy');
    expect(cdp.calls[0].params.expression).not.toContain('scroll-edge');
    await expect(T.scrollStr(cdp, 'sid', 'down', '80', ['--scroll-container', '#content-container']))
      .rejects.toThrow(/only valid with to top\/to bottom/);
  });

  it('keeps a short page with no overflow as document at-bottom', async () => {
    const page = createDocumentScrollPage({ scrollY: 0, scrollMax: 0 });
    page.document.querySelectorAll = () => [];
    const cdp = documentScrollCdp(page);
    const text = await T.scrollStr(cdp, 'sid', 'to', 'bottom');
    expect(text).toBe('Scrolled to bottom. scrollY: 0 / 0 max (at-bottom: yes)');
  });

  it('exports Playwright overflow fallback for to bottom without reprinting AX', () => {
    expect(T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'bottom'],
      replayable: true,
    }).lines[0]).toMatch(/window\.scrollTo/);
    expect(T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'bottom'],
      replayable: true,
    }).lines[0]).toMatch(/scrollTop/);
    expect(T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to', 'bottom', '--scroll-container', '#content-container'],
      replayable: true,
    }).lines[0]).toBe(
      'await page.locator("#content-container").evaluate((el) => { el.scrollTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0)); });',
    );
  });
});
