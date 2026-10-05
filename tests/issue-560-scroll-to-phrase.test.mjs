import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('#560 scroll "to top" as one argument', () => {
  it('T1 splits a one-argument edge phrase before any positional use', () => {
    expect(T.splitScrollEdgeArgs(['to top'])).toEqual(['to', 'top']);
    expect(T.splitScrollEdgeArgs(['To  Bottom', '--scroll-container', '.feed'])).toEqual(['To', 'Bottom', '--scroll-container', '.feed']);
    const [direction, amount, ...rest] = T.splitScrollEdgeArgs(['to bottom', '--scroll-container', '.feed']);
    expect(T.parseScrollEdge(direction, amount)).toBe('bottom');
    expect(T.parseScrollContainerArg(rest)).toBe('.feed');
  });

  it('T2 leaves other argument lists unchanged', () => {
    expect(T.splitScrollEdgeArgs(['down', '300'])).toEqual(['down', '300']);
    expect(T.splitScrollEdgeArgs(['to', 'top'])).toEqual(['to', 'top']);
    expect(T.splitScrollEdgeArgs(['0,400'])).toEqual(['0,400']);
    expect(T.splitScrollEdgeArgs([])).toEqual([]);
  });

  it('T3 the receipt target and feedback policy see the edge', () => {
    const args = T.splitScrollEdgeArgs(['to top']);
    expect(T.scrollActionTarget(args).label).toBe('to top');
    expect(T.scrollFeedbackPolicy(args[0], args[1])).toBe('report-only');
  });

  it('T4 the Playwright export of a recorded one-argument phrase scrolls to the edge', () => {
    expect(T.playwrightStepFromCommand({
      action: 'scroll',
      command: ['scroll', 'to bottom'],
      replayable: true,
    }).lines[0]).toMatch(/Element\.prototype\.scrollTo\.call\(scrolling, \{ left: 0, top: docMax/);
  });
});
