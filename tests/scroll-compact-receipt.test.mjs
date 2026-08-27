import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

const HF_HOME = 'https://huggingface.co/';
const HF_SCROLL_Y = 5295;
const HF_SCROLL_MAX = 5295;
const DISPATCH_TEXT = `Scrolled to bottom. scrollY: ${HF_SCROLL_Y} / ${HF_SCROLL_MAX} max (at-bottom: yes)`;
const COMPACT_TEXT = `scrollY: ${HF_SCROLL_Y} / ${HF_SCROLL_MAX} max (at-bottom: yes)`;
const GENERIC_HINT = 'Use perceive --since-action if more evidence is needed';
const BROWSER_USE_SCROLL_CHARS = 118;
const TARGET_ID = 'HFHOME01ABCDEF0123456789ABCDEF01';

function hfDocumentScrollEdgeResult({
  nextHint = GENERIC_HINT,
  dispatchText = DISPATCH_TEXT,
} = {}) {
  return T.createActionResult({
    action: 'scroll',
    target: {
      targetId: TARGET_ID,
      input: 'to bottom',
      resolvedBy: 'scroll',
      label: 'to bottom',
      commandArgs: ['to', 'bottom'],
      expectedOutcome: T.DOCUMENT_SCROLL_EDGE_OUTCOME,
      dispatchText,
    },
    dispatch: { ok: true, method: 'scroll' },
    settle: { ok: true, durationMs: 3 },
    effects: { domDiff: null, console: [], network: [], navigation: null },
    nextHint,
  });
}

describe('#345 skinny document-scroll-edge receipt', () => {
  it('keeps scroll on the existing command family without a new spelling', () => {
    expect(COMMAND_SURFACE.resolve('scroll').name).toBe('scroll');
    expect(COMMAND_SURFACE.resolve('scroll').help.synopsis).toMatch(/\bscroll <target>/);
    expect(COMMAND_SURFACE.resolve('scroll').help.synopsis).toMatch(/to top\|to bottom/);
    expect(COMMAND_SURFACE.resolve('scroll').help.synopsis).not.toMatch(/--goto|--scroll-edge|--quiet/);
  });

  it('documents --compact on the existing scroll command', () => {
    expect(COMMAND_SURFACE.resolve('scroll').help.synopsis).toContain('--compact');
    expect(COMMAND_SURFACE.resolve('scroll').help.synopsis).toMatch(/--qa\|--summary/);
  });

  it('prints scrollY/scrollMax/at-bottom for successful document-scroll-edge and drops Recovery/Hint perceive', () => {
    const result = hfDocumentScrollEdgeResult();
    const text = T.formatActionText(result, { dispatchText: DISPATCH_TEXT });
    const receipt = T.formatActionResultOutput(result, { dispatchText: DISPATCH_TEXT });

    expect(result.outcome.status).toBe('dispatched');
    expect(result.dispatch.ok).toBe(true);
    expect(result.target.expectedOutcome).toBe('document-scroll-edge');
    expect(text).toBe(DISPATCH_TEXT);
    expect(receipt).toBe(DISPATCH_TEXT);
    expect(receipt).toMatch(/scrollY: 5295 \/ 5295 max/);
    expect(receipt).toMatch(/at-bottom: yes/);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Capture a fresh observation before assuming task progress/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/perceive --since-action/);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).not.toMatch(/^scroll: dispatched via scroll$/m);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/^Verdict:/m);
    expect(receipt).not.toMatch(/^Receipt:/m);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt).not.toMatch(/^Target:/m);
    expect(receipt).not.toMatch(/^Network:/m);
    expect(receipt).not.toMatch(/RootWebArea/);
    expect(receipt).not.toMatch(/^Next:/m);
    expect(receipt.length).toBeLessThanOrEqual(BROWSER_USE_SCROLL_CHARS);
  });

  it('makes --compact actually shrink document-scroll-edge text vs default', () => {
    const result = hfDocumentScrollEdgeResult();
    const defaults = [];
    const compacts = [];
    for (let n = 1; n <= 3; n += 1) {
      const text = T.formatActionResultOutput(result, { dispatchText: DISPATCH_TEXT });
      const compact = T.formatActionResultOutput(result, {
        dispatchText: DISPATCH_TEXT,
        compact: true,
      });
      defaults.push(text);
      compacts.push(compact);
      expect(compact).toBe(COMPACT_TEXT);
      expect(compact).toMatch(/scrollY: 5295 \/ 5295 max/);
      expect(compact).toMatch(/at-bottom: yes/);
      expect(compact).not.toMatch(/^Scrolled to bottom\./);
      expect(compact).not.toMatch(/^Recovery hint:/m);
      expect(compact).not.toMatch(/Hint: Use perceive --since-action/);
      expect(compact.length).toBeLessThan(text.length);
      expect(compact.length).toBeLessThanOrEqual(BROWSER_USE_SCROLL_CHARS);
      expect(text.length).toBeLessThanOrEqual(BROWSER_USE_SCROLL_CHARS);
    }
    expect(new Set(defaults.map(value => value.length)).size).toBe(1);
    expect(new Set(compacts.map(value => value.length)).size).toBe(1);
  });

  it('keeps --format json as the action envelope, not skinny text', () => {
    const result = hfDocumentScrollEdgeResult();
    const json = T.formatActionResultOutput(result, { format: 'json', dispatchText: DISPATCH_TEXT });
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('chrome-cdp-ex.action.v1');
    expect(parsed.action).toBe('scroll');
    expect(parsed.outcome.status).toBe('dispatched');
    expect(parsed.target.expectedOutcome).toBe('document-scroll-edge');
  });

  it('keeps --qa as the existing QA summary, not a new command family', () => {
    const result = hfDocumentScrollEdgeResult();
    const qa = T.formatActionResultOutput(result, { qa: true, dispatchText: DISPATCH_TEXT });
    expect(qa).toMatch(/^QA summary:/);
    expect(qa).not.toMatch(/^Recovery hint:/m);
  });

  it('does not skinny relative leftover-ax-scroll receipts', () => {
    const leftoverDump = [
      `Page: Hugging Face — ${HF_HOME}`,
      'Viewport: 1042×632 | Scroll: 5295/5295 (100%) | Focused: none',
      '',
      '[RootWebArea] Hugging Face',
      '(no changes detected in AX tree)',
    ].join('\n');
    const target = T.scrollActionTarget(['down', '80'], { targetId: TARGET_ID });
    T.tagScrollLeftoverSettle('scroll', target, leftoverDump, { cursorInteractive: true, depth: 8 });
    const result = T.createActionResult({
      action: 'scroll',
      target,
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: leftoverDump, console: [], network: [], navigation: null },
      nextHint: GENERIC_HINT,
    });
    const text = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 5295)',
    });
    expect(target.expectedOutcome).toBe('leftover-ax-scroll-no-change');
    expect(result.outcome.status).toBe('no-change');
    expect(text).toBe('Scrolled by (0, 80). Position: (0, 5295). Next: cdp perceive HFHOME01 -C -d 8');
    expect(text).not.toMatch(/^Outcome:/m);
    expect(text).not.toMatch(/^Receipt:/m);
    expect(text).not.toMatch(/^Verdict:/m);
    expect(text).not.toMatch(/RootWebArea/);
  });

  it('prints one-line click stdout without Recovery hint', () => {
    const genericChanged = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '+   [StaticText] Saved', console: [], network: [], navigation: null },
    });
    const text = T.formatActionResultOutput(genericChanged, { dispatchText: 'Clicked Save' });
    expect(text).toBe('Clicked Save. Next: cdp list');
    expect(text).not.toMatch(/Recovery hint:/);
    expect(text).not.toMatch(/^Outcome:/m);
  });

  it('keeps the fat receipt when document-scroll-edge needs attention', () => {
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'scroll',
      target: {
        targetId: TARGET_ID,
        input: 'to bottom',
        resolvedBy: 'scroll',
        label: 'to bottom',
        expectedOutcome: T.DOCUMENT_SCROLL_EDGE_OUTCOME,
        dispatchText: DISPATCH_TEXT,
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 3 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: GENERIC_HINT,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 1, entries: [{ message: 'boom', loc: 'app.js:1' }] },
      network: { count: 0, pending: 0, entries: [] },
    });
    const text = T.formatActionResultOutput(result, { dispatchText: DISPATCH_TEXT });
    expect(result.outcome.status).toBe('attention');
    expect(text).toBe(`${DISPATCH_TEXT}. Next: cdp console ${TARGET_ID} --errors`);
    expect(text).not.toMatch(/^Diagnosis:/m);
    expect(text).not.toMatch(/^Recovery hint:/m);
  });

  it('still reaches the document edge in one report-only step without leftover Next perceive', async () => {
    let observed = false;
    const text = await T.runActionWithFeedback({
      action: 'scroll',
      target: T.scrollActionTarget(['to', 'bottom'], { targetId: TARGET_ID }),
      dispatch: async () => DISPATCH_TEXT,
      feedbackPolicy: T.scrollFeedbackPolicy('to', 'bottom'),
      observe: async () => {
        observed = true;
        return 'leftover perceive -C -d 8';
      },
    });
    expect(observed).toBe(false);
    expect(T.scrollFeedbackPolicy('to', 'bottom')).toBe('report-only');
    expect(text).toBe(DISPATCH_TEXT);
    expect(text).not.toMatch(/perceive --since-action/);
    expect(text).not.toMatch(/^Next:/m);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text.length).toBeLessThanOrEqual(BROWSER_USE_SCROLL_CHARS);
  });

  it('does not skinny a document-scroll-edge result with no scrollY line', () => {
    const result = hfDocumentScrollEdgeResult({ dispatchText: '' });
    result.target.dispatchText = '';
    const text = T.formatActionResultOutput(result, { dispatchText: '' });
    expect(text).toMatch(/^dispatched\. Next: /);
    expect(text).not.toMatch(/^Outcome:/m);
    expect(text).not.toMatch(/Recovery hint:/);
  });

  it('keeps the fat receipt when document-scroll-edge dispatch fails', () => {
    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: TARGET_ID,
        input: 'to bottom',
        resolvedBy: 'scroll',
        label: 'to bottom',
        expectedOutcome: T.DOCUMENT_SCROLL_EDGE_OUTCOME,
        dispatchText: 'Did not reach document bottom. scrollY: 100 / 5295 max (at-bottom: no)',
      },
      dispatch: { ok: false, method: 'scroll', error: 'Did not reach document bottom' },
      settle: { ok: false, durationMs: 3 },
      effects: {
        failure: { kind: 'timeout', reason: 'Did not reach document bottom' },
        domDiff: null,
        console: [],
        network: [],
        navigation: null,
      },
      nextHint: GENERIC_HINT,
    });
    const text = T.formatActionResultOutput(result, {
      dispatchText: 'Did not reach document bottom. scrollY: 100 / 5295 max (at-bottom: no)',
    });
    expect(result.outcome.status).toBe('failed');
    expect(text).toBe(`Kind: timeout\nNext: cdp status ${TARGET_ID}`);
    expect(text).not.toBe(DISPATCH_TEXT);
    expect(text).not.toMatch(/Recovery hint:/);
  });

  it('prints at-top metrics for successful scroll to top, including --compact', () => {
    const dispatchText = 'Scrolled to top. scrollY: 0 / 5295 max (at-top: yes)';
    const result = hfDocumentScrollEdgeResult({ dispatchText });
    result.target.input = 'to top';
    result.target.label = 'to top';
    result.target.commandArgs = ['to', 'top'];
    const text = T.formatActionResultOutput(result, { dispatchText });
    const compact = T.formatActionResultOutput(result, { dispatchText, compact: true });
    expect(text).toBe(dispatchText);
    expect(compact).toBe('scrollY: 0 / 5295 max (at-top: yes)');
    expect(compact.length).toBeLessThan(text.length);
    expect(text).not.toMatch(/^Recovery hint:/m);
  });
});
