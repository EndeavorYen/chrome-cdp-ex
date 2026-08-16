import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET_ID = '54A7C685ABCDEF0123456789ABCDEF01';
const PERMALINK = 'a#qwen38-27b';
const HF_QWEN = 'https://huggingface.co/Qwen/Qwen3.8-27B';

function leftoverGoldenPathDump() {
  return [
    `Page: Qwen3.8-27B — ${HF_QWEN}`,
    'Viewport: 1042×632 | Scroll: 0/2400 (0%) | Focused: none',
    'Interactive: 12 a',
    'Console: clean',
    '',
    '[RootWebArea] Qwen3.8-27B',
    '  [heading] Qwen3.8-27B',
    '  [link] qwen38-27b',
    '(no changes detected in AX tree)',
  ].join('\n');
}

function pageMeta() {
  return JSON.stringify({
    title: 'Qwen3.8-27B',
    url: HF_QWEN,
    contentType: 'text/html',
    vw: 1042,
    vh: 632,
    scrollY: 0,
    scrollMax: 2400,
    counts: { a: 12 },
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [],
  });
}

function axNodes() {
  return [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Qwen3.8-27B' }, childIds: ['2', '3'] },
    { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Qwen3.8-27B' } },
    { nodeId: '3', parentId: '1', role: { value: 'link' }, name: { value: 'qwen38-27b' }, backendDOMNodeId: 38 },
  ];
}

function isHoverRevealExpr(expr) {
  return typeof expr === 'string' && expr.includes('chrome-cdp-ex.hover-reveal.v1');
}

function isPermalinkRectExpr(expr) {
  return typeof expr === 'string'
    && expr.includes(PERMALINK)
    && expr.includes('rect.width / 2');
}

function createPermalinkHoverCdp({ raceHoverOnAxDump = true } = {}) {
  const state = {
    hovered: false,
    axDumps: 0,
    axDumpDroppedHover: false,
  };
  const cdp = {
    calls: [],
    send(method, params = {}) {
      cdp.calls.push({ method, params });
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree: { frame: { id: 'main-frame', url: HF_QWEN } } });
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (isPermalinkRectExpr(expr) || isHoverRevealExpr(expr)) {
          const opacity = state.hovered ? 1 : 0;
          const visible = opacity > 0;
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                marker: 'chrome-cdp-ex.hover-reveal.v1',
                x: 120,
                y: 80,
                tag: 'A',
                opacity,
                visibility: 'visible',
                display: 'inline',
                visible,
                groupHover: state.hovered,
                href: HF_QWEN,
              },
            },
          });
        }
        if (expr.includes('scrollBy')) {
          return Promise.resolve({ result: { value: '{"x":0,"y":0}' } });
        }
        return Promise.resolve({ result: { value: pageMeta() } });
      }
      if (method === 'Accessibility.getFullAXTree') {
        state.axDumps += 1;
        if (raceHoverOnAxDump && state.hovered) {
          state.hovered = false;
          state.axDumpDroppedHover = true;
        }
        return Promise.resolve({ nodes: axNodes() });
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseMoved') state.hovered = true;
        return Promise.resolve({});
      }
      if (method === 'DOM.getDocument') {
        return Promise.resolve({ root: { nodeId: 1 } });
      }
      if (method === 'DOM.querySelector') {
        return Promise.resolve({ nodeId: 38 });
      }
      if (method === 'DOM.resolveNode') {
        return Promise.resolve({ object: { objectId: 'qwen-permalink' } });
      }
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({
          result: { value: { connected: true, x: 100, y: 60, w: 40, h: 40, tag: 'A' } },
        });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return { cdp, state };
}

async function confirmReveal(cdp) {
  const raw = await T.evalStr(cdp, 'sid', T.hoverRevealStateExpression(PERMALINK));
  return T.parseHoverRevealState(raw);
}

describe('issue #341 hover leftover AX recapture races :hover', () => {
  it('treats leftover hover recapture as skippable only when the next batch command is eval', () => {
    expect(T.isHoverConfirmEvalCommand({ cmd: 'eval', args: ['1'] })).toBe(true);
    expect(T.isHoverConfirmEvalCommand({ cmd: 'eval', args: [`document.querySelector("${PERMALINK}")`] })).toBe(true);
    expect(T.isHoverConfirmEvalCommand({ cmd: 'evalraw', args: ['Input.dispatchMouseEvent', '{}'] })).toBe(false);
    expect(T.isHoverConfirmEvalCommand({ cmd: 'eval64', args: ['YQ=='] })).toBe(false);
    expect(T.isHoverConfirmEvalCommand({ cmd: 'press', args: ['Enter'] })).toBe(false);
    expect(T.isHoverConfirmEvalCommand({ cmd: 'scroll', args: ['down'] })).toBe(false);
    expect(T.hoverFeedbackPolicy({ cmd: 'eval', args: ['1'] })).toBe('report-only');
    expect(T.hoverFeedbackPolicy({ cmd: 'evalraw', args: ['Input.dispatchMouseEvent'] })).toBe('settle-diff');
    expect(T.hoverFeedbackPolicy({ cmd: 'click', args: ['#go'] })).toBe('settle-diff');
    expect(T.hoverFeedbackPolicy(null)).toBe('settle-diff');
  });

  it('attaches sequential batch lookahead so mid-pipe hover can see the following eval', () => {
    const sequenced = T.batchCommandLookahead([
      { cmd: 'hover', args: [PERMALINK] },
      { cmd: 'eval', args: ['document.querySelector("a#qwen38-27b")'] },
    ]);
    expect(T.hoverFeedbackPolicy(sequenced[0].nextCommand)).toBe('report-only');
    expect(sequenced[1].nextCommand).toBeNull();
    const parallel = T.batchCommandLookahead(sequenced, { parallel: true });
    expect(T.hoverFeedbackPolicy(parallel[0].nextCommand)).toBe('settle-diff');
  });

  it('leftover AX recapture after hover drops :hover before the confirm eval', async () => {
    const { cdp, state } = createPermalinkHoverCdp();
    const store = { output: leftoverGoldenPathDump(), snapshotOpts: { cursorInteractive: true, maxDepth: 8 } };
    await T.dispatchHoverWithLeftoverPolicy({
      cdp,
      sid: 'sid',
      selector: PERMALINK,
      refMap: new Map(),
      refState: {},
      consoleBuf: new T.RingBuffer(8),
      exceptionBuf: new T.RingBuffer(8),
      lastPerceiveStore: store,
      targetId: TARGET_ID,
      nextCommand: null,
    });
    const after = await confirmReveal(cdp);
    expect(state.axDumps).toBeGreaterThan(0);
    expect(state.axDumpDroppedHover).toBe(true);
    expect(after.visible).toBe(false);
    expect(after.opacity).toBe(0);
    expect(after.groupHover).toBe(false);
  });

  it('does not dump leftover AX between mouseMoved and confirm eval so :hover stays revealed', async () => {
    const { cdp, state } = createPermalinkHoverCdp();
    const store = { output: leftoverGoldenPathDump(), snapshotOpts: { cursorInteractive: true, maxDepth: 8 } };
    const axBefore = state.axDumps;
    const text = await T.dispatchHoverWithLeftoverPolicy({
      cdp,
      sid: 'sid',
      selector: PERMALINK,
      refMap: new Map(),
      refState: {},
      consoleBuf: new T.RingBuffer(8),
      exceptionBuf: new T.RingBuffer(8),
      lastPerceiveStore: store,
      targetId: TARGET_ID,
      nextCommand: { cmd: 'eval', args: ['1'] },
    });
    const after = await confirmReveal(cdp);
    expect(state.axDumps).toBe(axBefore);
    expect(state.axDumpDroppedHover).toBe(false);
    expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);
    expect(after.visible).toBe(true);
    expect(after.opacity).toBe(1);
    expect(after.groupHover).toBe(true);
    expect(after.href).toBe(HF_QWEN);
    expect(text).toMatch(/Hovering over <A>/);
    expect(text).toMatch(/opacity 0→1/);
    expect(text).toMatch(/\bvisible\b/);
    expect(text).toMatch(/groupHover/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/no changes detected in AX tree/);
    expect(text.length).toBeLessThan(200);
  });

  it('hover receipt names opacity/visible/groupHover without Accessibility.getFullAXTree', async () => {
    const { cdp, state } = createPermalinkHoverCdp();
    const text = await T.hoverStr(cdp, 'sid', PERMALINK, new Map(), {});
    expect(state.hovered).toBe(true);
    expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);
    expect(cdp.calls.some(call =>
      call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseMoved',
    )).toBe(true);
    expect(text).toMatch(/opacity 0→1/);
    expect(text).toMatch(/\bvisible\b/);
    expect(text).toMatch(/groupHover/);
  });

  it('keeps compositor-ack swallow at 250ms and does not use evalraw mouseMoved as the happy path', () => {
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);
    const src = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/hover: async args =>[\s\S]{0,1600}dispatchHoverWithLeftoverPolicy\(/);
    expect(src).toMatch(/async function dispatchHoverWithLeftoverPolicy[\s\S]{0,1600}hoverFeedbackPolicy\(/);
    expect(src).toMatch(/async function dispatchHoverWithLeftoverPolicy[\s\S]{0,2000}rememberHoverSettleBaseline\(/);
    expect(src).not.toMatch(/async function dispatchHoverWithLeftoverPolicy[\s\S]{0,2000}evalRawStr\(/);
  });

  it('still recaptures standalone hover leftover so a later no-op mutator does not steal the delta', async () => {
    expect(typeof T.rememberHoverSettleBaseline).toBe('function');
    expect(T.hoverFeedbackPolicy(null)).toBe('settle-diff');
    const { cdp } = createPermalinkHoverCdp({ raceHoverOnAxDump: false });
    const store = { output: leftoverGoldenPathDump(), snapshotOpts: { cursorInteractive: true, maxDepth: 8 } };
    await T.dispatchHoverWithLeftoverPolicy({
      cdp,
      sid: 'sid',
      selector: PERMALINK,
      refMap: new Map(),
      refState: {},
      consoleBuf: new T.RingBuffer(8),
      exceptionBuf: new T.RingBuffer(8),
      lastPerceiveStore: store,
      targetId: TARGET_ID,
      nextCommand: null,
    });
    expect(cdp.calls.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(true);
  });
});
