import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET = '71DF370F9D36D5A232B424FDC696BE1A';
const PREFIX = '71DF370F';
const NAMED = 'Named control not found: "Pay now" (from text=Pay now). No button, link, tab, radio or label has that exact visible text or aria-label; pass the exact visible text or an @ref from perceive.';
const CSS = 'Element not found: #pay. No element matches this CSS selector; pass the control\'s visible text or an @ref from perceive.';
const MARKER = 'chrome-cdp-ex.frame-inventory.v1';
const SAME = 'http://127.0.0.1:9/inner.html';
const OTHER = 'http://127.0.0.1:9/other.html';
const NESTED = 'http://127.0.0.1:9/nested.html';
const CROSS = 'http://localhost:9/pay.html';
const CHILD = 'child-sid';

function rootTree(children = []) {
  return {
    frame: { id: 'root', url: 'http://127.0.0.1:9/host.html', name: 'top', securityOrigin: 'http://127.0.0.1:9' },
    childFrames: children,
  };
}

function frameNode(id, url, { parentId = 'root', nested = [] } = {}) {
  let securityOrigin = '';
  try { securityOrigin = new URL(url).origin; } catch { /* about:blank has none */ }
  const node = { frame: { id, parentId, url, name: id, securityOrigin } };
  if (nested.length) node.childFrames = nested;
  return node;
}

function frameEl(src, host) {
  return { title: host, src, host, name: '', visible: true };
}

function axNode(name, backendDOMNodeId, { role = 'button', ignored = false } = {}) {
  return {
    nodeId: `n-${backendDOMNodeId}`,
    role: { value: role },
    name: { value: name },
    backendDOMNodeId,
    ...(ignored ? { ignored: true } : {}),
  };
}

function pageCdp({
  frameElements,
  tree = rootTree(),
  onAx = () => ({ nodes: [] }),
  children = [],
} = {}) {
  return createMockCDP({
    'Runtime.evaluate': () => ({
      result: {
        value: {
          marker: MARKER,
          frameElements,
          frameElementCount: frameElements.length,
        },
      },
    }),
    'Page.getFrameTree': () => ({ frameTree: tree }),
    'Accessibility.getFullAXTree': (params, sessionId) => onAx(params, sessionId),
    childSessions: children,
  });
}

function oopifChild(tree, axByFrame = {}) {
  return {
    sessionId: CHILD,
    targetId: `${CHILD}-target`,
    parentId: 'root',
    handlers: {
      'Page.getFrameTree': () => ({ frameTree: tree }),
      'Accessibility.getFullAXTree': (params) => ({ nodes: axByFrame[params?.frameId] || [] }),
    },
  };
}

function twoFrames(onAx, children = []) {
  return pageCdp({
    frameElements: [
      frameEl(SAME, '127.0.0.1:9'),
      frameEl(OTHER, '127.0.0.1:9'),
    ],
    tree: rootTree([
      frameNode('inner', SAME),
      frameNode('other', OTHER),
    ]),
    onAx,
    children,
  });
}

async function miss(cdp, message = NAMED, { input = 'text=Pay now', action = 'click', refState = null } = {}) {
  const error = await T.runActionWithFeedback({
    action,
    target: { targetId: TARGET, input, commandArgs: [input] },
    dispatch: async () => { throw new Error(message); },
    feedbackPolicy: 'none',
    observe: async () => '',
    cdp,
    sid: 'sid',
    refState,
  }).catch(err => err);
  return error.message;
}

function expectRunnableNext(text) {
  for (const line of String(text).split('\n')) {
    const match = line.match(/^Next:\s(.*)$/);
    if (!match) continue;
    const syntax = spawnSync('bash', ['-n', '-c', match[1]], { encoding: 'utf8' });
    expect(syntax.status, `${line}\n${syntax.stderr}`).toBe(0);
  }
}

function axCalls(cdp) {
  return cdp.calls.filter(call => call.method === 'Accessibility.getFullAXTree');
}

describe('named click miss with one frame name', () => {
  it('keeps the frame Next when no frame accessible name matches', async () => {
    const cdp = twoFrames((params) => {
      if (!params?.frameId) return { nodes: [axNode('Pay now', 1)] };
      if (params.frameId === 'inner') {
        return {
          nodes: [
            axNode('Pay now', 2, { role: 'heading' }),
            axNode('Pay now', 3, { ignored: true }),
          ],
        };
      }
      return { nodes: [axNode('Cancel', 4)] };
    });
    const text = await miss(cdp);
    expect(text).toBe([
      `Error: ${NAMED} The page has 2 frames and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp frame ${PREFIX}`,
    ].join('\n'));
    expect(axCalls(cdp).length).toBeGreaterThan(0);
    expect(axCalls(cdp).every(call => call.params?.frameId && call.sessionId === 'sid')).toBe(true);
    expect(cdp.calls.some(call => call.method === 'Target.setAutoAttach')).toBe(false);
    expectRunnableNext(text);
  });

  it('points Next at a same-origin frame whose tab has that name', async () => {
    const cdp = twoFrames((params) => {
      if (params?.frameId === 'inner') return { nodes: [axNode('Settings', 21, { role: 'tab' })] };
      return { nodes: [] };
    });
    const text = await miss(cdp, NAMED, { input: 'text=Settings' });
    expect(text).toContain(`Next: cdp perceive ${PREFIX} --frame @f2`);
    expect(text).not.toContain(`Next: cdp frame ${PREFIX}`);
    expectRunnableNext(text);
  });

  it('points Next at the one frame whose accessible name matches', async () => {
    const cdp = twoFrames((params) => {
      if (params?.frameId === 'other') throw new Error('ax unavailable');
      if (params?.frameId === 'inner') return { nodes: [axNode('Pay now', 21, { role: 'link' })] };
      return { nodes: [axNode('Pay now', 1)] };
    });
    const text = await miss(cdp);
    expect(text).toBe([
      `Error: ${NAMED} The page has 2 frames and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expect(axCalls(cdp).map(call => call.params.frameId).sort()).toEqual(['inner', 'other']);
    expectRunnableNext(text);

    const spaced = twoFrames((params) => {
      if (params?.frameId === 'other') return { nodes: [axNode('Pay  now', 22)] };
      return { nodes: [] };
    });
    const spacedText = await miss(spaced);
    expect(spacedText).toContain(`Next: cdp perceive ${PREFIX} --frame @f3`);
    expect(spacedText).toContain('The page has 2 frames and the control may be inside one.');
  });

  it('keeps the frame Next when two frames match', async () => {
    const cdp = twoFrames((params) => {
      if (params?.frameId === 'inner' || params?.frameId === 'other') return { nodes: [axNode('Pay now', 8)] };
      return { nodes: [] };
    });
    const text = await miss(cdp);
    expect(text).toBe([
      `Error: ${NAMED} The page has 2 frames and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp frame ${PREFIX}`,
    ].join('\n'));
    expect(text).not.toContain('--frame');
    expectRunnableNext(text);
  });

  it('uses the known frame-local ref for one matching element', async () => {
    const cdp = twoFrames((params) => {
      if (params?.frameId === 'inner') return { nodes: [axNode('Pay now', 21)] };
      return { nodes: [axNode('Save', 22)] };
    });
    const refState = {
      frameRefs: new Map([['@f2', {
        frameRef: '@f2',
        frameId: 'inner',
        refs: new Map([[1, 21]]),
      }]]),
    };
    const text = await miss(cdp, NAMED, { refState });
    expect(text).toContain('The page has 2 frames and the control may be inside one.');
    expect(text).toContain(`Next: cdp click ${PREFIX} @f2:1`);
    expect(text).not.toContain('--frame');
    expectRunnableNext(text);

    const js = twoFrames((params) => (
      params?.frameId === 'inner' ? { nodes: [axNode('Pay now', 21)] } : { nodes: [] }
    ));
    const jsText = await miss(js, NAMED, { action: 'jsclick', refState });
    expect(jsText).toContain(`Next: cdp jsclick ${PREFIX} @f2:1`);
  });

  it('keeps the frame Next when the one frame has two matching elements', async () => {
    const cdp = twoFrames((params) => {
      if (params?.frameId !== 'inner') return { nodes: [] };
      return { nodes: [axNode('Pay now', 21), axNode('Pay now', 22)] };
    });
    const refState = {
      frameRefs: new Map([['@f2', {
        frameRef: '@f2',
        frameId: 'inner',
        refs: new Map([[1, 21]]),
      }]]),
    };
    const text = await miss(cdp, NAMED, { refState });
    expect(text).toContain(`Next: cdp perceive ${PREFIX} --frame @f2`);
    expect(text).not.toContain('@f2:1');
    expectRunnableNext(text);
  });

  it('points Next at a nested same-origin frame that has the only match', async () => {
    const cdp = pageCdp({
      frameElements: [frameEl(SAME, '127.0.0.1:9')],
      tree: rootTree([
        frameNode('outer', SAME, {
          nested: [frameNode('nested', NESTED, { parentId: 'outer' })],
        }),
      ]),
      onAx: (params) => {
        if (params?.frameId === 'nested') return { nodes: [axNode('Pay now', 30)] };
        return { nodes: [] };
      },
    });
    const text = await miss(cdp);
    expect(text).toBe([
      `Error: ${NAMED} The page has 2 frames and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f3`,
    ].join('\n'));
    expectRunnableNext(text);
  });

  it('does not search frames on a selector miss', async () => {
    const cdp = twoFrames(() => ({ nodes: [axNode('Pay now', 21)] }));
    const text = await miss(cdp, CSS, { input: '#pay' });
    expect(text).toBe([
      `Error: ${CSS} The page has 2 frames and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp frame ${PREFIX}`,
    ].join('\n'));
    expect(axCalls(cdp)).toHaveLength(0);
    expectRunnableNext(text);
  });

  it('does not attach or read an unattached cross-site frame', async () => {
    const cdp = pageCdp({
      frameElements: [
        frameEl(SAME, '127.0.0.1:9'),
        frameEl(CROSS, 'localhost:9'),
      ],
      tree: rootTree([frameNode('inner', SAME)]),
      onAx: (params) => (
        params?.frameId === 'inner' ? { nodes: [axNode('Save', 4)] } : { nodes: [] }
      ),
      children: [oopifChild(frameNode('oopif', CROSS), { oopif: [axNode('Pay now', 55)] })],
    });
    const text = await miss(cdp);
    expect(text).toBe([
      `Error: ${NAMED} The page has 1 frame and the control may be inside one. 1 cross-site frame is not reachable yet.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expect(cdp.calls.some(call => call.method === 'Target.setAutoAttach')).toBe(false);
    expect(cdp.calls.some(call => call.sessionId === CHILD)).toBe(false);
    expect(text).not.toContain('@f3');
    expectRunnableNext(text);
  });

  it('points Next at an already-attached cross-site frame with the only match', async () => {
    const cdp = pageCdp({
      frameElements: [
        frameEl(SAME, '127.0.0.1:9'),
        frameEl(CROSS, 'localhost:9'),
      ],
      tree: rootTree([frameNode('inner', SAME)]),
      onAx: (params) => (
        params?.frameId === 'inner' ? { nodes: [axNode('Save', 4)] } : { nodes: [] }
      ),
      children: [oopifChild(frameNode('oopif', CROSS), { oopif: [axNode('Pay now', 55)] })],
    });
    const listed = JSON.parse(await T.framesStr(cdp, 'sid', { format: 'json' }));
    expect(listed.schema).toBe('chrome-cdp-ex.frames.v1');
    expect(Object.keys(listed).sort()).toEqual(['frameCount', 'frames', 'schema']);
    expect(listed.frames.slice(0, 2).map(frame => frame.ref)).toEqual(['@f1', '@f2']);
    expect(listed.frames.slice(0, 2).some(frame => Object.hasOwn(frame, 'process'))).toBe(false);
    expect(listed.frames[2]).toMatchObject({ ref: '@f3', id: 'oopif', process: 'oopif' });
    const attaches = cdp.calls.filter(call => call.method === 'Target.setAutoAttach').length;
    const mark = cdp.calls.length;
    const refState = {
      frameRefs: new Map([['@f3', {
        frameRef: '@f3',
        frameId: 'oopif',
        process: 'oopif',
        refs: new Map([[1, 55]]),
        frames: [{ ref: '@f3', id: 'oopif', process: 'oopif' }],
      }]]),
    };
    const text = await miss(cdp, NAMED, { refState });
    expect(text).toBe([
      `Error: ${NAMED} The page has 1 frame and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f3`,
    ].join('\n'));
    expect(text).not.toContain('not reachable yet');
    expect(text).not.toContain('@f3:1');
    expect(cdp.calls.filter(call => call.method === 'Target.setAutoAttach')).toHaveLength(attaches);
    const during = cdp.calls.slice(mark);
    const childMethods = during.filter(call => call.sessionId === CHILD).map(call => call.method);
    expect(childMethods).toContain('Accessibility.getFullAXTree');
    expect(childMethods).not.toContain('Runtime.evaluate');
    expect(childMethods).not.toContain('Page.createIsolatedWorld');
    const again = JSON.parse(await T.framesStr(cdp, 'sid', { format: 'json' }));
    expect(again.frames.map(frame => [frame.ref, frame.process || '', frame.id])).toEqual(
      listed.frames.map(frame => [frame.ref, frame.process || '', frame.id]),
    );
    expectRunnableNext(text);
  });

  it('points Next at an attached cross-site frame when the page has no same-origin child', async () => {
    const cdp = pageCdp({
      frameElements: [frameEl(CROSS, 'localhost:9')],
      tree: rootTree(),
      children: [oopifChild(frameNode('oopif', CROSS), { oopif: [axNode('Pay now', 55)] })],
    });
    const listed = JSON.parse(await T.framesStr(cdp, 'sid', { format: 'json' }));
    expect(listed.frames.map(frame => [frame.ref, frame.process || ''])).toEqual([
      ['@f1', ''],
      ['@f2', 'oopif'],
    ]);
    const text = await miss(cdp);
    expect(text).toBe([
      `Error: ${NAMED} The page has 1 cross-site frame and the control may be inside one.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expect(text).not.toContain('not reachable yet');
    expect(text).not.toContain('-C');
    expectRunnableNext(text);
  });

  it('keeps slice C when the name is in a same-origin frame and an attached cross-site frame', async () => {
    const cdp = pageCdp({
      frameElements: [
        frameEl(SAME, '127.0.0.1:9'),
        frameEl(CROSS, 'localhost:9'),
      ],
      tree: rootTree([frameNode('inner', SAME)]),
      onAx: (params) => (
        params?.frameId === 'inner' ? { nodes: [axNode('Pay now', 21)] } : { nodes: [] }
      ),
      children: [oopifChild(frameNode('oopif', CROSS), { oopif: [axNode('Pay now', 55)] })],
    });
    await T.framesStr(cdp, 'sid', { format: 'json' });
    const text = await miss(cdp);
    expect(text).toBe([
      `Error: ${NAMED} The page has 1 frame and the control may be inside one. 1 cross-site frame is not reachable yet.`,
      'Kind: selector',
      `Next: cdp perceive ${PREFIX} --frame @f2`,
    ].join('\n'));
    expect(text).not.toContain('@f3');
    expectRunnableNext(text);
  });
});
