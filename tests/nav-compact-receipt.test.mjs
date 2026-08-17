import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

const EXAMPLE_ORG = 'https://example.org/';
const EXAMPLE_TITLE = 'Example Domain';
const DISPATCH_TEXT = `Navigated to ${EXAMPLE_ORG}`;
const GENERIC_HINT = 'Use perceive --since-action if more evidence is needed';
const BROWSER_USE_NAV_CHARS = 86;
const TARGET_ID = 'AABBCCDD1234567890ABCDEF12345678';

function navigationObservation({
  title = EXAMPLE_TITLE,
  url = EXAMPLE_ORG,
  readyState = 'complete',
  contentType = 'text/html',
} = {}) {
  return [
    'Navigation observation:',
    `Page: ${title}`,
    `URL: ${url}`,
    `Ready state: ${readyState}`,
    contentType ? `contentType: ${contentType}` : null,
  ].filter(Boolean).join('\n');
}

function exampleOrgNavResult({
  observation = navigationObservation(),
  nextHint = GENERIC_HINT,
  network = true,
} = {}) {
  const result = T.createActionResult({
    action: 'nav',
    target: {
      targetId: TARGET_ID,
      input: EXAMPLE_ORG,
      resolvedBy: 'url',
      label: EXAMPLE_ORG,
      commandArgs: [EXAMPLE_ORG],
    },
    dispatch: { ok: true, method: 'nav' },
    settle: { ok: true, durationMs: 180 },
    effects: {
      domDiff: observation,
      console: [],
      network: [],
      navigation: null,
      page: { title: EXAMPLE_TITLE, url: EXAMPLE_ORG, contentType: 'text/html' },
    },
    nextHint,
  });
  if (!network) return result;
  return T.applyActionObservationDelta(result, {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: {
      count: 1,
      pending: 0,
      entries: [{
        method: 'GET',
        url: EXAMPLE_ORG,
        status: 200,
        type: 'Document',
        duration: 40,
      }],
    },
  });
}

describe('#343 skinny document nav receipt', () => {
  it('keeps nav on the existing command family without a --goto spelling', () => {
    expect(COMMAND_SURFACE.resolve('nav').name).toBe('nav');
    expect(COMMAND_SURFACE.resolve('navigate').name).toBe('nav');
    expect(COMMAND_SURFACE.resolve('nav').help.synopsis).toMatch(/\bnav <target> <url>/);
    expect(COMMAND_SURFACE.resolve('nav').help.synopsis).not.toMatch(/--goto/);
  });

  it('does not invent a --goto flag on nav', () => {
    expect(COMMAND_SURFACE.resolve('nav').help.synopsis).toContain('--compact');
  });

  it('prints URL+title for successful document nav and drops Recovery/Hint perceive', () => {
    const result = exampleOrgNavResult();
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, { dispatchText: DISPATCH_TEXT });

    expect(result.outcome.status).toBe('changed');
    expect(result.dispatch.ok).toBe(true);
    expect(text).toContain(EXAMPLE_ORG);
    expect(text).toContain(EXAMPLE_TITLE);
    expect(receipt).toContain(EXAMPLE_ORG);
    expect(receipt).toContain(EXAMPLE_TITLE);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/perceive --since-action/);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).not.toMatch(/^nav: dispatched via nav$/m);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/^Verdict:/m);
    expect(receipt).not.toMatch(/^Receipt:/m);
    expect(receipt).not.toMatch(/Navigation observation:/);
    expect(receipt).not.toMatch(/contentType:/);
    expect(receipt).not.toMatch(/^Network:/m);
    expect(receipt.length).toBeLessThanOrEqual(BROWSER_USE_NAV_CHARS);
  });

  it('makes --compact actually shrink nav text vs default', () => {
    const result = exampleOrgNavResult();
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
      expect(compact).toContain(EXAMPLE_ORG);
      expect(compact).toContain(EXAMPLE_TITLE);
      expect(compact).not.toMatch(/^Recovery hint:/m);
      expect(compact).not.toMatch(/Hint: Use perceive --since-action/);
      expect(compact).not.toMatch(/Ready state:/);
      expect(compact.length).toBeLessThan(text.length);
      expect(compact.length).toBeLessThanOrEqual(BROWSER_USE_NAV_CHARS);
      expect(text.length).toBeLessThanOrEqual(BROWSER_USE_NAV_CHARS);
    }
    expect(new Set(defaults.map(value => value.length)).size).toBe(1);
    expect(new Set(compacts.map(value => value.length)).size).toBe(1);
  });

  it('keeps --format json as the action envelope, not skinny text', () => {
    const result = exampleOrgNavResult();
    const json = T.formatActionResultOutput(result, { format: 'json', dispatchText: DISPATCH_TEXT });
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('chrome-cdp-ex.action.v1');
    expect(parsed.action).toBe('nav');
    expect(parsed.outcome.status).toBe('changed');
  });

  it('keeps --qa as the existing QA summary, not a new command family', () => {
    const result = exampleOrgNavResult();
    const qa = T.formatActionResultOutput(result, { qa: true, dispatchText: DISPATCH_TEXT });
    expect(qa).toMatch(/^QA summary:/);
    expect(qa).toContain(EXAMPLE_ORG);
    expect(qa).toContain(EXAMPLE_TITLE);
    expect(qa).not.toMatch(/^Recovery hint:/m);
  });

  it('does not skinny a --perceive-shaped nav AX dump', () => {
    const axDump = [
      'Page: Example Domain — https://example.org/',
      'Viewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none',
      '',
      '[RootWebArea] Example Domain',
      '    [heading] Example Domain',
      '    [StaticText] This domain is for use in illustrative examples',
    ].join('\n');
    const result = exampleOrgNavResult({ observation: axDump, network: false });
    const text = T.formatActionResultOutput(result, { dispatchText: DISPATCH_TEXT });
    expect(text).toMatch(/RootWebArea/);
    expect(text).toMatch(/Outcome:/);
    expect(text.length).toBeGreaterThan(BROWSER_USE_NAV_CHARS);
  });

  it('keeps Recovery hint on generic non-nav changed actions', () => {
    const genericChanged = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '+   [StaticText] Saved', console: [], network: [], navigation: null },
    });
    expect(T.formatActionText(genericChanged)).toContain('Recovery hint: Continue from the observed action evidence.');
    expect(T.formatActionResultOutput(genericChanged, { compact: true }))
      .toContain('Recovery hint: Continue from the observed action evidence.');
  });

  it('keeps the fat receipt when document nav needs attention', () => {
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'nav',
      target: {
        targetId: TARGET_ID,
        input: EXAMPLE_ORG,
        resolvedBy: 'url',
        label: EXAMPLE_ORG,
      },
      dispatch: { ok: true, method: 'nav' },
      settle: { ok: true, durationMs: 180 },
      effects: {
        domDiff: navigationObservation(),
        console: [],
        network: [],
        navigation: null,
        page: { title: EXAMPLE_TITLE, url: EXAMPLE_ORG },
      },
      nextHint: GENERIC_HINT,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 1, entries: [{ message: 'boom', loc: 'app.js:1' }] },
      network: { count: 0, pending: 0, entries: [] },
    });
    const text = T.formatActionResultOutput(result, { dispatchText: DISPATCH_TEXT });
    expect(result.outcome.status).toBe('attention');
    expect(text).toMatch(/Diagnosis:/);
    expect(text).toMatch(/Recovery hint:/);
  });
});
