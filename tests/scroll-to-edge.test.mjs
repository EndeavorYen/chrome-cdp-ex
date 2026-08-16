import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

const HF_HOME_VIEWPORT = { width: 1042, height: 632 };
const HF_HOME_SCROLL_MAX = 5295;

function createDocumentScrollPage({
  scrollY = 0,
  innerHeight = HF_HOME_VIEWPORT.height,
  scrollMax = HF_HOME_SCROLL_MAX,
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
      state.scrollY = Math.max(0, Math.min(max, Math.round(Number(y) || 0)));
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
    expect(scroll.feedbackPolicy).toBe('settle-diff');
    expect(T.helpStr()).toMatch(/to top\|to bottom/);
    expect(T.helpTopicStr('scroll')).toMatch(/to top\|to bottom/);
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
    expect(expr).toContain('chrome-cdp-ex.document-scroll-edge');
    expect(expr).toContain('window.scrollTo');
    expect(expr).not.toContain('querySelector');
    expect(expr).not.toContain('content-container');
    expect(expr).not.toContain('overflowY');
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
    }).lines[0]).toBe('await page.evaluate(() => window.scrollTo(0, 0));');
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
});
