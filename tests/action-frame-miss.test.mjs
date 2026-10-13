import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { actionabilityMissMessage } from '../skills/chrome-cdp-ex/scripts/lib/cdp-input.mjs';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET = '71DF370F9D36D5A232B424FDC696BE1A';
const PREFIX = '71DF370F';
const NAMED = 'Named control not found: "Pay now" (from text=Pay now). No button or link has that exact visible text or aria-label; pass the exact visible text or an @ref from perceive.';
const CSS = 'Element not found: #pay. No element matches this CSS selector; pass the control\'s visible text or an @ref from perceive.';
const NOT_UNIQUE = 'Named control is not unique and none are in the viewport: "Save". Pick one by @ref from perceive.';
const MARKER = 'chrome-cdp-ex.frame-inventory.v1';

function frameTree(children = []) {
  return {
    frame: { id: 'root', url: 'http://127.0.0.1:9/host.html', name: 'top' },
    childFrames: children,
  };
}

function childFrame(id, url, parentId = 'root', nested = []) {
  const node = { frame: { id, parentId, url, name: id } };
  if (nested.length) node.childFrames = nested;
  return node;
}

function frameEl(src, { title = '', host = '', visible = true } = {}) {
  return { title, src, host, name: '', visible };
}

function pageCdp({ frameElementCount = 0, frameElements = [], tree = frameTree() } = {}) {
  return createMockCDP({
    'Runtime.evaluate': () => ({
      result: {
        value: {
          marker: MARKER,
          frameElements,
          frameElementCount,
        },
      },
    }),
    'Page.getFrameTree': () => ({ frameTree: tree }),
  });
}

function methods(cdp) {
  return cdp.calls.map(call => call.method);
}

async function miss(cdp, message, input = 'text=Pay now', action = 'click') {
  const error = await T.runActionWithFeedback({
    action,
    target: { targetId: TARGET, input, commandArgs: [input] },
    dispatch: async () => { throw new Error(message); },
    feedbackPolicy: 'none',
    observe: async () => '',
    cdp,
    sid: 'sid',
  }).catch(err => err);
  return error.message;
}

function expectRunnableNext(text) {
  for (const line of String(text).split('\n')) {
    const match = line.match(/^Next:\s(.*)$/);
    if (!match) continue;
    const syntax = spawnSync('bash', ['-n', '-c', match[1]], { encoding: 'utf8' });
    expect(syntax.status, `${line}\n${syntax.stderr}`).toBe(0);
    expect(match[1]).not.toMatch(/\(Kind:/);
  }
}

const SAME = 'http://127.0.0.1:9/inner.html';
const CROSS = 'http://localhost:9/inner.html';

describe('selector miss on a page with frames', () => {
  it('keeps the current message and skips the frame tree when the page has no frames', async () => {
    const cdp = pageCdp({ frameElementCount: 0 });
    const text = await miss(cdp, NAMED);
    expect(text).toBe(`Error: ${NAMED}\nKind: selector\nNext: cdp perceive ${PREFIX} -C -d 8`);
    expect(methods(cdp).filter(method => method === 'Runtime.evaluate')).toHaveLength(1);
    expect(methods(cdp)).not.toContain('Page.getFrameTree');
    expect(methods(cdp)).not.toContain('DOM.getFrameOwner');
    expectRunnableNext(text);

    const css = pageCdp({ frameElementCount: 0 });
    const cssText = await miss(css, CSS, '#pay');
    expect(cssText).toBe(`Error: ${CSS}\nKind: selector\nNext: cdp perceive ${PREFIX} -C -d 8`);
    expect(methods(css)).not.toContain('Page.getFrameTree');
  });

  it('points Next at the only same-origin child frame', async () => {
    const cdp = pageCdp({
      frameElementCount: 1,
      frameElements: [frameEl(SAME, { title: 'Inner', host: '127.0.0.1:9' })],
      tree: frameTree([childFrame('inner', SAME)]),
    });
    const text = await miss(cdp, NAMED);
    expect(text).toBe([
      `Error: ${NAMED} The page has 1 frame and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expect(methods(cdp)).not.toContain('DOM.getFrameOwner');
    expectRunnableNext(text);

    const hidden = pageCdp({
      frameElementCount: 1,
      frameElements: [frameEl(SAME, { title: 'Inner', host: '127.0.0.1:9', visible: false })],
      tree: frameTree([childFrame('inner', SAME)]),
    });
    const hiddenText = await miss(hidden, CSS, '#pay');
    expect(hiddenText).toContain('The page has 1 frame and the control may be inside one.');
    expect(hiddenText).toContain(`Next: cdp perceive ${PREFIX} --frame @f2`);
    expect(hiddenText).not.toContain('cross-site');
  });

  it('points Next at frame when more than one same-origin child exists', async () => {
    const other = 'http://127.0.0.1:9/other.html';
    const cdp = pageCdp({
      frameElementCount: 2,
      frameElements: [
        frameEl(SAME, { title: 'Inner', host: '127.0.0.1:9' }),
        frameEl(other, { title: 'Other', host: '127.0.0.1:9' }),
      ],
      tree: frameTree([
        childFrame('inner', SAME),
        childFrame('other', other),
      ]),
    });
    const text = await miss(cdp, NAMED);
    expect(text).toBe([
      `Error: ${NAMED} The page has 2 frames and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp frame ${PREFIX}`,
    ].join('\n'));
    expectRunnableNext(text);
  });

  it('names a cross-site frame and does not point Next at it', async () => {
    const cdp = pageCdp({
      frameElementCount: 2,
      frameElements: [
        frameEl(SAME, { title: 'Inner', host: '127.0.0.1:9' }),
        frameEl(CROSS, { title: 'Other', host: 'localhost:9' }),
      ],
      tree: frameTree([childFrame('inner', SAME)]),
    });
    const text = await miss(cdp, NAMED);
    expect(text).toBe([
      `Error: ${NAMED} The page has 1 frame and the control may be inside one. 1 cross-site frame is not reachable yet.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expect(text).not.toMatch(/Next: cdp frame /);
    expect(text).not.toContain('@f3');
    expectRunnableNext(text);

    const onlyCross = pageCdp({
      frameElementCount: 1,
      frameElements: [frameEl(CROSS, { title: 'Other', host: 'localhost:9' })],
      tree: frameTree(),
    });
    const crossText = await miss(onlyCross, CSS, '#pay');
    expect(crossText).toBe([
      `Error: ${CSS} The page has 1 cross-site frame and the control may be inside one. 1 cross-site frame is not reachable yet.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} -C -d 8`,
    ].join('\n'));
    expect(crossText).not.toMatch(/Next: cdp frame /);
    expect(crossText).not.toContain('--frame');
    expectRunnableNext(crossText);
  });

  it('counts a nested same-origin frame in N and a top-level cross-site iframe in X', async () => {
    const outer = 'http://127.0.0.1:9/outer.html';
    const inner = 'http://127.0.0.1:9/child.html';
    const cdp = pageCdp({
      frameElementCount: 2,
      frameElements: [
        frameEl(outer, { title: 'Outer', host: '127.0.0.1:9' }),
        frameEl(CROSS, { title: 'Other', host: 'localhost:9' }),
      ],
      tree: frameTree([
        childFrame('outer', outer, 'root', [
          childFrame('inner', inner, 'outer'),
        ]),
      ]),
    });
    const text = await miss(cdp, NAMED);
    expect(text).toBe([
      `Error: ${NAMED} The page has 2 frames and the control may be inside one. 1 cross-site frame is not reachable yet.`,
      'Kind: selector',
      `Next: cdp frame ${PREFIX}`,
    ].join('\n'));
    expect(text).not.toContain('--frame @f');
    expectRunnableNext(text);
  });

  it('does not probe frames for a non-unique name or a miss already inside a frame', async () => {
    const framed = pageCdp({
      frameElementCount: 1,
      frameElements: [frameEl(SAME, { host: '127.0.0.1:9' })],
      tree: frameTree([childFrame('inner', SAME)]),
    });
    const unique = await miss(framed, NOT_UNIQUE, 'Save');
    expect(unique).toBe(`Error: ${NOT_UNIQUE}\nKind: selector\nNext: cdp perceive ${PREFIX} -C -d 8`);
    expect(methods(framed)).not.toContain('Runtime.evaluate');
    expect(methods(framed)).not.toContain('Page.getFrameTree');

    const inside = pageCdp({
      frameElementCount: 1,
      frameElements: [frameEl(SAME, { host: '127.0.0.1:9' })],
      tree: frameTree([childFrame('inner', SAME)]),
    });
    const framedMiss = 'Element not found: @f2:3. No element matches this CSS selector; pass the control\'s visible text or an @ref from perceive.';
    const text = await miss(inside, framedMiss, '@f2:3');
    expect(text).toBe(`Error: ${framedMiss}\nKind: selector\nNext: cdp perceive ${PREFIX} --frame @f2`);
    expect(methods(inside)).not.toContain('Runtime.evaluate');
    expect(methods(inside)).not.toContain('Page.getFrameTree');
    expectRunnableNext(text);
  });

  it('puts a period before the frame sentence on a fill or select miss', async () => {
    const oneFrame = () => pageCdp({
      frameElementCount: 1,
      frameElements: [frameEl(SAME, { title: 'Inner', host: '127.0.0.1:9' })],
      tree: frameTree([childFrame('inner', SAME)]),
    });
    const fillMessage = actionabilityMissMessage('Element not found: #email', { waited: true, waitedMs: 2001 });
    const selectMessage = actionabilityMissMessage('Element not found: #country', { waited: true, waitedMs: 2001 });
    const fillText = await miss(oneFrame(), fillMessage, '#email', 'fill');
    const selectText = await miss(oneFrame(), selectMessage, '#country', 'select');
    expect(fillText).toBe([
      `Error: ${fillMessage}. The page has 1 frame and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expect(selectText).toBe([
      `Error: ${selectMessage}. The page has 1 frame and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expectRunnableNext(fillText);
    expectRunnableNext(selectText);
  });
});
