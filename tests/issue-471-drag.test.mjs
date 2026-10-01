import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');
const { buildMcpToolCommand } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

const SID = 'SESSION';
const SOURCE = { ok: true, x: 100, y: 50, w: 200, h: 40, tag: 'LI', text: 'Alpha', hit: { covered: false } };
const DEST = { ok: true, x: 100, y: 150, w: 200, h: 40, vw: 800, vh: 600, tag: 'LI', text: 'Gamma', hit: { covered: false } };
const DRAG_DATA = { items: [{ mimeType: 'text/plain', data: 'alpha' }], dragOperationsMask: 1 };
const POINTER_COUNTS = { pointerdown: 1, mousedown: 1, pointermove: 10, mousemove: 10, pointerup: 1, mouseup: 1 };
const HTML5_COUNTS = { pointerdown: 1, mousedown: 1, pointermove: 1, mousemove: 1, dragstart: 1, dragenter: 1, dragover: 1, drop: 1, dragend: 1 };

// A fake CDP connection: Runtime.evaluate answers by marker, Input.* is recorded, and
// `interceptOnMove` emits Input.dragIntercepted on that pressed mouseMoved (1-based) like
// Chrome does once a draggable source starts an HTML5 drag.
function fakeCdp({
  source = SOURCE,
  dest = DEST,
  counts = POINTER_COUNTS,
  interceptOnMove = null,
  interceptSupported = true,
  failOn = null,
  visibility = 'visible',
} = {}) {
  const calls = [];
  const handlers = new Map();
  let pressedMoves = 0;
  const emit = (method, params) => {
    for (const handler of handlers.get(method) || []) handler(params, { method, params, sessionId: SID });
  };
  const evaluate = (expression) => {
    if (expression.includes('chrome-cdp-ex.drag-source')) return source;
    if (expression.includes('chrome-cdp-ex.drag-destination')) return dest;
    if (expression.includes('chrome-cdp-ex.drag-point')) {
      const [, x, y] = expression.match(/elementFromPoint\((-?[\d.]+), (-?[\d.]+)\)/);
      return { ok: true, x: Number(x), y: Number(y), vw: 800, vh: 600, tag: 'UL', text: 'list' };
    }
    if (expression.includes('__chromeCdpExDragProbe') && expression.includes('addEventListener')) return true;
    if (expression.includes('__chromeCdpExDragProbe')) return counts == null ? null : { counts };
    if (expression.includes('visibilityState')) return visibility;
    throw new Error(`unexpected evaluate: ${expression.slice(0, 80)}`);
  };
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (failOn && failOn(method, params, calls)) throw new Error(`${method} exploded`);
      if (method === 'Runtime.evaluate') return { result: { value: evaluate(params.expression) } };
      if (method === 'Input.setInterceptDrags' && !interceptSupported) throw new Error("'Input.setInterceptDrags' wasn't found");
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1) {
        pressedMoves += 1;
        if (interceptOnMove === pressedMoves) emit('Input.dragIntercepted', { data: DRAG_DATA });
      }
      return {};
    },
    onEvent(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method).delete(handler);
    },
  };
  const inputCalls = () => calls.filter(call => call.method.startsWith('Input.'));
  const listening = () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0);
  return { cdp, calls, inputCalls, listening };
}

function describeInput(call) {
  const { method, params } = call;
  if (method === 'Input.setInterceptDrags') return `setInterceptDrags ${params.enabled}`;
  if (method === 'Input.dispatchDragEvent') return `${params.type} ${params.x},${params.y}`;
  return `${params.type} ${Math.round(params.x)},${Math.round(params.y)} buttons=${params.buttons}`;
}

describe('#471 drag argument parsing', () => {
  it('parses source, destination, steps, and an explicit mode', () => {
    expect(T.parseDragArgs(['#a', '#b'])).toEqual({ from: '#a', to: '#b', steps: 10, mode: 'auto' });
    expect(T.parseDragArgs(['@3', '120,40', '--steps', '4', '--html5']))
      .toEqual({ from: '@3', to: '120,40', steps: 4, mode: 'html5' });
    expect(T.parseDragArgs(['--pointer', '#a', '@7', '--steps=25'])).toMatchObject({ mode: 'pointer', steps: 25 });
  });

  it('rejects missing arguments, bad steps, both modes, unknown flags, and a coordinate source', () => {
    expect(() => T.parseDragArgs(['#a'])).toThrow(/source and destination required/);
    expect(() => T.parseDragArgs(['#a', '#b', '--steps', '0'])).toThrow(/--steps must be an integer from 1 to 100/);
    expect(() => T.parseDragArgs(['#a', '#b', '--steps', '101'])).toThrow(/--steps/);
    expect(() => T.parseDragArgs(['#a', '#b', '--html5', '--pointer'])).toThrow(/mutually exclusive/);
    expect(() => T.parseDragArgs(['#a', '#b', '--fast'])).toThrow(/unknown flag --fast/);
    expect(() => T.parseDragArgs(['10,10', '#b'])).toThrow(/source must be a CSS selector or @ref/);
    expect(() => T.parseDragArgs(['#a', '#b', '#c'])).toThrow(/unexpected argument #c/);
  });
});

describe('#471 pointer drag', () => {
  it('presses at the source centre, moves in N steps with the button held, and releases at the destination', async () => {
    const fake = fakeCdp();
    const text = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma', '--steps', '4'], new Map(), {});
    expect(fake.inputCalls().map(describeInput)).toEqual([
      'setInterceptDrags true',
      'mouseMoved 100,50 buttons=0',
      'mousePressed 100,50 buttons=1',
      'mouseMoved 100,75 buttons=1',
      'mouseMoved 100,100 buttons=1',
      'mouseMoved 100,125 buttons=1',
      'mouseMoved 100,150 buttons=1',
      'mouseReleased 100,150 buttons=0',
      'setInterceptDrags false',
    ]);
    const pressed = fake.inputCalls().find(call => call.params.type === 'mousePressed');
    expect(pressed.params).toMatchObject({ button: 'left', clickCount: 1, pointerType: 'mouse' });
    expect(text).toContain('Dragged <LI> "Alpha" → <LI> "Gamma"');
    expect(text).toContain('mode: pointer — mousePressed, 4 mouseMoved, mouseReleased (100, 50) → (100, 150)');
    expect(text).toContain('page events: pointerdown, pointermove×10, pointerup');
    expect(fake.listening()).toBe(0);
  });

  it('--pointer sends mouse events only, without drag interception', async () => {
    const fake = fakeCdp();
    await T.dragStr(fake.cdp, SID, T.parseDragArgs(['#alpha', '#gamma', '--pointer', '--steps', '2']), new Map(), {});
    expect(fake.inputCalls().map(describeInput)).toEqual([
      'mouseMoved 100,50 buttons=0',
      'mousePressed 100,50 buttons=1',
      'mouseMoved 100,100 buttons=1',
      'mouseMoved 100,150 buttons=1',
      'mouseReleased 100,150 buttons=0',
    ]);
  });

  it('drops at x,y CSS pixels and names the element under the point', async () => {
    const fake = fakeCdp();
    const text = await T.dragStr(fake.cdp, SID, ['#alpha', '300,20', '--steps', '1', '--pointer'], new Map(), {});
    expect(fake.inputCalls().map(describeInput).slice(-2)).toEqual([
      'mouseMoved 300,20 buttons=1',
      'mouseReleased 300,20 buttons=0',
    ]);
    expect(text).toContain('Dragged <LI> "Alpha" → (300, 20) over <UL>');
  });

  it('falls back to a plain pointer drag when Input.setInterceptDrags is unavailable', async () => {
    const fake = fakeCdp({ interceptSupported: false });
    const text = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma', '--steps', '1'], new Map(), {});
    expect(fake.inputCalls().map(describeInput)).toEqual([
      'setInterceptDrags true',
      'mouseMoved 100,50 buttons=0',
      'mousePressed 100,50 buttons=1',
      'mouseMoved 100,150 buttons=1',
      'mouseReleased 100,150 buttons=0',
    ]);
    expect(text).toContain('Input.setInterceptDrags is unavailable here');
  });
});

describe('#471 HTML5 drag-and-drop', () => {
  it('stops moving once Chrome intercepts the drag and drops the intercepted data on the destination', async () => {
    const fake = fakeCdp({ interceptOnMove: 1, counts: HTML5_COUNTS });
    const text = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma'], new Map(), {});
    expect(fake.inputCalls().map(describeInput)).toEqual([
      'setInterceptDrags true',
      'mouseMoved 100,50 buttons=0',
      'mousePressed 100,50 buttons=1',
      'mouseMoved 100,60 buttons=1',
      'dragEnter 100,150',
      'dragOver 100,150',
      'drop 100,150',
      'mouseReleased 100,150 buttons=0',
      'setInterceptDrags false',
    ]);
    for (const call of fake.inputCalls().filter(entry => entry.method === 'Input.dispatchDragEvent')) {
      expect(call.params).toEqual({ type: call.params.type, x: 100, y: 150, data: DRAG_DATA, modifiers: 0 });
    }
    expect(text).toContain('mode: html5 — Chrome started a drag after 1 mouseMoved');
    expect(text).toContain('page events: pointerdown, pointermove, dragstart, dragenter, dragover, drop, dragend');
    expect(text).not.toContain('Drop not accepted');
    expect(fake.listening()).toBe(0);
  });

  it('says so when the destination does not accept the drop', async () => {
    const counts = { ...HTML5_COUNTS, drop: 0 };
    const fake = fakeCdp({ interceptOnMove: 1, counts });
    const text = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma', '--html5'], new Map(), {});
    expect(text).toContain('Drop not accepted: the destination fired no drop event');
  });

  it('--html5 fails after releasing the mouse when the page never starts an HTML5 drag', async () => {
    const fake = fakeCdp();
    const error = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma', '--html5', '--steps', '1'], new Map(), {})
      .catch(err => err);
    expect(error.message).toMatch(/^drag --html5: Chrome did not start an HTML5 drag from <LI> "Alpha"/);
    expect(fake.inputCalls().map(describeInput).slice(-2)).toEqual([
      'mouseReleased 100,150 buttons=0',
      'setInterceptDrags false',
    ]);
    const failure = classifyActionFailure(error, { action: 'drag', target: { input: '#alpha', targetId: 'ABCDEF12' } });
    expect(failure).toMatchObject({
      kind: 'drag-not-started',
      dispatched: true,
      nextCommand: 'cdp perceive ABCDEF12 --since-action',
    });
  });
});

describe('#471 drag hit tests and failures', () => {
  it('fails with Kind: covered and sends nothing when the start point is covered', async () => {
    const covered = { covered: true, x: 100, y: 50, by: '<DIV.toast> "Saved"', byPosition: 'fixed', within: null, withinPosition: 'fixed', dialog: false };
    const fake = fakeCdp({ source: { ...SOURCE, hit: covered } });
    const error = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma'], new Map(), {}).catch(err => err);
    expect(error.message).toBe('drag start point (100, 50) of <LI> "Alpha" is covered by position:fixed <DIV.toast> "Saved". The drag was not sent: it would start on the covering element.');
    expect(fake.inputCalls()).toEqual([]);
    const failure = classifyActionFailure(error, { action: 'drag', target: { input: '#alpha', targetId: 'ABCDEF12' } });
    expect(failure).toMatchObject({
      kind: 'covered',
      dispatched: false,
      covering: { point: 'start', by: '<DIV.toast> "Saved"', dialog: false },
      nextCommand: 'cdp overlay ABCDEF12 "#alpha"',
    });
    expect(failure.hints.join(' ')).not.toMatch(/jsclick|--js/);
  });

  it('fails with Kind: covered on a covered drop point and points recovery at the dialog', async () => {
    const covered = { covered: true, x: 100, y: 150, by: '<DIALOG#confirm>', byPosition: 'static', within: null, withinPosition: null, dialog: true };
    const fake = fakeCdp({ dest: { ...DEST, hit: covered } });
    const error = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma'], new Map(), {}).catch(err => err);
    expect(error.message).toMatch(/^drag drop point \(100, 150\) of <LI> "Gamma" is covered by <DIALOG#confirm>/);
    expect(fake.inputCalls()).toEqual([]);
    const failure = classifyActionFailure(error, { action: 'drag', target: { input: '#alpha', targetId: 'ABCDEF12' } });
    expect(failure).toMatchObject({ kind: 'covered', covering: { point: 'drop', dialog: true }, nextCommand: 'cdp dismiss-modal ABCDEF12' });
    // Re-classified from the message alone (CLI side), the point is still known.
    expect(classifyActionFailure(new Error(error.message), { action: 'drag', target: { input: '#alpha', targetId: 'ABCDEF12' } }))
      .toMatchObject({ kind: 'covered', covering: { point: 'drop' } });
  });

  it('refuses a drop target outside the viewport instead of scrolling the source away', async () => {
    const fake = fakeCdp({ dest: { ...DEST, y: 900, hit: null } });
    await expect(T.dragStr(fake.cdp, SID, ['#alpha', '#gamma'], new Map(), {}))
      .rejects.toThrow(/drop target <LI> "Gamma" is outside the viewport after the source was scrolled into view/);
    expect(fake.inputCalls()).toEqual([]);
  });

  it('fails closed when the page saw no mouse or drag events', async () => {
    const fake = fakeCdp({ counts: {} });
    const error = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma', '--pointer', '--steps', '1'], new Map(), {})
      .catch(err => err);
    expect(error.message).toMatch(/received no mouse or drag events between \(100, 50\) and \(100, 150\)/);
    expect(classifyActionFailure(error, { action: 'drag', target: { input: '#alpha', targetId: 'ABCDEF12' } }))
      .toMatchObject({ kind: 'no-input-events', dispatched: false, nextCommand: 'cdp status ABCDEF12' });
  });

  it('points a hidden background tab at a foreground rerun of the same drag', async () => {
    const fake = fakeCdp({ counts: {}, visibility: 'hidden' });
    const error = await T.dragStr(fake.cdp, SID, ['#alpha', '#gamma', '--steps', '1'], new Map(), {}).catch(err => err);
    expect(error.message).toContain("document.visibilityState is hidden");
    const target = { input: '#alpha', targetId: 'ABCDEF12', commandArgs: ['#alpha', '#gamma', '--steps', '1'] };
    expect(classifyActionFailure(error, { action: 'drag', target })).toMatchObject({
      kind: 'no-input-events',
      visibility: 'hidden',
      nextCommand: 'CDP_BACKGROUND=0 cdp drag ABCDEF12 "#alpha" "#gamma" --steps 1',
    });
  });

  it('awaits every dispatch: a failing move rejects once, releases the button, and turns interception off', async () => {
    const fake = fakeCdp({
      failOn: (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1,
    });
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(T.dragStr(fake.cdp, SID, ['#alpha', '#gamma'], new Map(), {}))
        .rejects.toThrow('Input.dispatchMouseEvent exploded');
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(fake.inputCalls().map(describeInput)).toEqual([
      'setInterceptDrags true',
      'mouseMoved 100,50 buttons=0',
      'mousePressed 100,50 buttons=1',
      'mouseMoved 100,60 buttons=1',
      'mouseReleased 100,50 buttons=0',
      'setInterceptDrags false',
    ]);
    expect(fake.listening()).toBe(0);
  });
});

describe('#471 drag command surface', () => {
  it('registers drag as an action-receipt mutation with an MCP tool', () => {
    expect(COMMAND_SURFACE.resolve('drag')).toMatchObject({
      needsTarget: true,
      mutates: true,
      kind: 'mutation',
      authorization: 'mutation',
      evidencePolicy: 'action-receipt',
      feedbackPolicy: 'settle-diff',
      mcp: { exposure: 'tool-and-run-command', toolName: 'drag', mapper: 'drag' },
    });
    expect(T.helpTopicStr('drag')).toContain('cdp drag <target> <from sel|@ref> <to sel|@ref|x,y>');
  });

  it('maps the MCP drag tool to the CLI command and requires confirm', () => {
    expect(buildMcpToolCommand('drag', { target: 'A1', from: '#a', to: '10,20', steps: 5, mode: 'pointer', confirm: true }))
      .toEqual(['drag', 'A1', '#a', '10,20', '--steps', '5', '--pointer', '--format', 'json']);
    expect(buildMcpToolCommand('drag', { target: 'A1', from: '@3', to: '@4', confirm: true }))
      .toEqual(['drag', 'A1', '@3', '@4', '--format', 'json']);
    expect(() => buildMcpToolCommand('drag', { target: 'A1', from: '#a', to: '#b' })).toThrow(/requires confirm: true/);
  });

  it('exports a selector drag to Playwright dragTo and skips refs', () => {
    const step = T.playwrightStepFromCommand({ command: ['drag', '#a', '#b', '--steps', '3'], replayable: true });
    expect(step.lines[0]).toBe('await page.locator("#a").dragTo(page.locator("#b"));');
    expect(T.playwrightStepFromCommand({ command: ['drag', '@3', '#b'], replayable: true }).exported).toBe(false);
  });
});
