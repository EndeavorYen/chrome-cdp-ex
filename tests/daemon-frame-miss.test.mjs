import { describe, expect, it } from 'vitest';

import { daemonCommandCatchResult } from '../skills/chrome-cdp-ex/scripts/lib/cdp-daemon.mjs';
import { createMockCDP } from './mock-cdp.mjs';

const TARGET = '71DF370F9D36D5A232B424FDC696BE1A';
const PREFIX = '71DF370F';
const MARKER = 'chrome-cdp-ex.frame-inventory.v1';
const SAME = 'http://127.0.0.1:9/inner.html';
const CSS = 'Element not found: #pay. No element matches this CSS selector; pass the control\'s visible text or an @ref from perceive.';
const NAMED = 'Named control not found: "Pay now" (from text=Pay now). No button or link has that exact visible text or aria-label; pass the exact visible text or an @ref from perceive.';
const OTHER = 'http://127.0.0.1:9/other.html';

function frameTree(children = []) {
  return {
    frame: { id: 'root', url: 'http://127.0.0.1:9/host.html', name: 'top' },
    childFrames: children,
  };
}

function pageCdp() {
  return createMockCDP({
    'Runtime.evaluate': () => ({
      result: {
        value: {
          marker: MARKER,
          frameElements: [{ title: 'Inner', src: SAME, host: '127.0.0.1:9', name: '', visible: true }],
          frameElementCount: 1,
        },
      },
    }),
    'Page.getFrameTree': () => ({
      frameTree: frameTree([{ frame: { id: 'inner', parentId: 'root', url: SAME, name: 'inner' } }]),
    }),
  });
}

describe('daemon catch on an unclassified selector miss', () => {
  it('names the frame when the miss has not already been classified', async () => {
    const cdp = pageCdp();
    const result = await daemonCommandCatchResult(new Error(CSS), {
      cdp,
      sessionId: 'sid',
      cmd: 'click',
      args: ['#pay'],
      targetId: TARGET,
      session: {},
      dialogBuf: null,
      dialogSince: 0,
      jsDialogs: { hasPending: () => false },
    });
    expect(result).toEqual({
      ok: false,
      error: [
        `Error: ${CSS} The page has 1 frame and the control may be inside one.`,
        'Kind: selector',
        `Next: cdp perceive ${PREFIX} --frame @f2`,
      ].join('\n'),
    });
    expect(cdp.calls.map(call => call.method)).toContain('Page.getFrameTree');
  });

  it('uses a known frame-local ref on an unclassified named miss', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: {
            marker: MARKER,
            frameElements: [
              { title: 'Inner', src: SAME, host: '127.0.0.1:9', name: '', visible: true },
              { title: 'Other', src: OTHER, host: '127.0.0.1:9', name: '', visible: true },
            ],
            frameElementCount: 2,
          },
        },
      }),
      'Page.getFrameTree': () => ({
        frameTree: frameTree([
          { frame: { id: 'inner', parentId: 'root', url: SAME, name: 'inner' } },
          { frame: { id: 'other', parentId: 'root', url: OTHER, name: 'other' } },
        ]),
      }),
      'Accessibility.getFullAXTree': (params) => ({
        nodes: params?.frameId === 'inner'
          ? [{ nodeId: 'pay', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 21 }]
          : [],
      }),
    });
    const result = await daemonCommandCatchResult(new Error(NAMED), {
      cdp,
      sessionId: 'sid',
      cmd: 'click',
      args: ['text=Pay now'],
      targetId: TARGET,
      session: {
        refs: {
          frameRefs: new Map([['@f2', {
            frameRef: '@f2',
            frameId: 'inner',
            refs: new Map([[1, 21]]),
          }]]),
        },
      },
      dialogBuf: null,
      dialogSince: 0,
      jsDialogs: { hasPending: () => false },
    });
    expect(result).toEqual({
      ok: false,
      error: [
        `Error: ${NAMED} The page has 2 frames and the control may be inside one.`,
        'Kind: selector',
        `Next: cdp click ${PREFIX} @f2:1`,
      ].join('\n'),
    });
  });
});
