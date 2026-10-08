import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure, formatActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const {
  RingBuffer,
  parsePerceiveArgs,
  perceiveStr,
  perceiveModel,
  formatUnknownRefError,
  formatPerceiveDiffOutput,
  formatVisibleControlsText,
  resolveRefNode,
  clickStr,
  fillStr,
  runActionWithFeedback,
  formatCliError,
} = T;

const SHORT_COORDS = 'Coords: viewport CSS px (clickxy-ready; fixed/sticky tagged)';
const LONG_COORDS = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';

function axNode(id, role, name, opts = {}) {
  return {
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.childIds ? { childIds: opts.childIds } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
  };
}

function createMockCDP(handlers = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId, timeout) {
      calls.push({ method, params, sessionId, timeout });
      if (handlers[method]) return Promise.resolve(handlers[method](params, sessionId));
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree: { frame: { id: 'mock-root-frame' } } });
      }
      if (method === 'Page.createIsolatedWorld') {
        return Promise.resolve({ executionContextId: 901 });
      }
      return Promise.resolve({});
    },
  };
}

function buttonTree(labels) {
  const nodes = [axNode('root', 'RootWebArea', 'Dense page')];
  const childIds = [];
  labels.forEach((label, index) => {
    const id = `b${index + 1}`;
    childIds.push(id);
    nodes.push(axNode(id, 'button', label, {
      parentId: 'root',
      backendDOMNodeId: 1000 + index + 1,
    }));
  });
  nodes[0].childIds = childIds;
  return nodes;
}

function buttonControl(index, { selector, id, label } = {}) {
  const n = index + 1;
  return {
    tag: 'button',
    role: 'button',
    label: label || `Control ${String(n).padStart(2, '0')}`,
    text: label || `Control ${String(n).padStart(2, '0')}`,
    clickable: true,
    disabled: false,
    rect: { x: 36, y: 200 + index * 32, w: 79, h: 29 },
    selector: selector || `button#control-${n}`,
    hints: { id: id || `control-${n}`, classes: [] },
  };
}

function perceiveMeta(controls, { truncated = false } = {}) {
  return {
    title: 'Dense page',
    url: 'http://127.0.0.1/dense',
    vw: 1280,
    vh: 800,
    scrollY: 0,
    scrollMax: 0,
    counts: { button: controls.length },
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: controls,
    visibleControlsTruncated: truncated,
  };
}

function perceiveCdp(controls, { truncated = false, treeControls = controls } = {}) {
  const labels = treeControls.map(control => control.label);
  const rectByBackend = new Map(treeControls.map((control, index) => [1000 + index + 1, control.rect]));
  return createMockCDP({
    'Runtime.evaluate': () => ({ result: { value: JSON.stringify(perceiveMeta(controls, { truncated })) } }),
    'Accessibility.getFullAXTree': () => ({ nodes: buttonTree(labels) }),
    'DOM.resolveNode': ({ backendNodeId }) => ({ object: { objectId: `obj-${backendNodeId}` } }),
    'Runtime.callFunctionOn': ({ objectId }) => {
      const backendNodeId = Number(String(objectId).replace('obj-', ''));
      const rect = rectByBackend.get(backendNodeId) || { x: 0, y: 0, w: 0, h: 0 };
      return { result: { value: { ...rect, position: 'static' } } };
    },
  });
}

async function perceiveControls(controls, opts = {}, { truncated = false, treeControls, refState = {} } = {}) {
  const store = {};
  const text = await perceiveStr(
    perceiveCdp(controls, { truncated, ...(treeControls ? { treeControls } : {}) }),
    'sid',
    new RingBuffer(4),
    new RingBuffer(4),
    new Map(),
    store,
    { cursorInteractive: true, maxDepth: 8, targetPrefix: 'AB12CD34', ...opts },
    refState,
  );
  return { text, store, refState };
}

function visibleControlLines(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex(line => line.startsWith('[Visible controls]'));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    if (line.startsWith('[')) break;
    out.push(line);
  }
  return out;
}

function agentChars(text) {
  return Array.from(String(text)).length;
}

const SAVE_PERCEIVE = [
  'Page: Stale — http://127.0.0.1/stale',
  'Viewport: 800×600 | Scroll: 0/0 (0%) | Focused: none',
  '[button] Save draft @1  (48,48 103×40)',
].join('\n');

function matchPayload(overrides = {}) {
  return {
    marker: 'chrome-cdp-ex-stale-ref-match',
    count: 1,
    selector: 'button#save',
    selectorUnique: true,
    role: 'button',
    name: 'Save draft',
    ...overrides,
  };
}

function detachedCdp(match = matchPayload()) {
  const calls = [];
  return {
    calls,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'root-frame', childFrames: [{ frame: { id: 'child-frame' } }] } } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 901 };
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: params.executionContextId === 901 ? 'isolated-detached' : 'page-detached' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { connected: false } } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: JSON.stringify(match) } };
      }
      if (method.startsWith('Input.')) return {};
      return {};
    },
  };
}

describe('perceive -C agent output (#598)', () => {
  it('accepts perceive --verbose without treating it as a snapshot flag', () => {
    expect(parsePerceiveArgs(['-C', '-d', '8', '--verbose'])).toMatchObject({
      cursorInteractive: true,
      maxDepth: 8,
      verbose: true,
    });
    expect(parsePerceiveArgs(['-v'])).toMatchObject({ verbose: true });
    expect(parsePerceiveArgs(['-C'])).toMatchObject({ verbose: false });
  });

  it('prints compact ref lines, a short Coords header, and a count of what the cap hides', async () => {
    const controls = Array.from({ length: 10 }, (_, index) => buttonControl(index));
    const { text, refState } = await perceiveControls(controls, {}, { truncated: true });
    const lines = text.split('\n');

    expect(lines[1]).toMatch(/Focused: none/);
    expect(text).toContain(SHORT_COORDS);
    expect(text).not.toContain('use clickxy with these values');
    expect(text).toContain('[Visible controls] (8 shown; --last N for more)');
    expect(text).not.toContain('(truncated)');
    const dumped = visibleControlLines(text);
    expect(dumped).toHaveLength(8);
    for (const line of dumped) {
      expect(line).toMatch(/^ {2}@\d+ button#control-\d+$/);
      expect(line).not.toMatch(/role=/);
      expect(line).not.toMatch(/#control-\d+ #control-\d+/);
    }
    expect(refState.lastPerceiveText).toContain(SHORT_COORDS);
    expect(agentChars(text)).toBeLessThan(2200);
  });

  it('uses a known total when the page collector was not itself truncated', async () => {
    const controls = Array.from({ length: 10 }, (_, index) => buttonControl(index));
    const { text } = await perceiveControls(controls, {}, { truncated: false });
    expect(text).toContain('[Visible controls] (8/10 shown; --last 10 for all)');
  });

  it('keeps the full line for a visible control that has no tree ref', async () => {
    const matched = buttonControl(0, { selector: 'button#save', id: 'save', label: 'Save draft' });
    const orphan = {
      tag: 'div',
      role: 'button',
      label: 'Orphan control',
      text: 'Orphan control',
      clickable: true,
      disabled: false,
      rect: { x: 1, y: 1, w: 20, h: 20 },
      selector: 'div.orphan',
      hints: { id: '', classes: ['orphan'] },
    };
    const { text } = await perceiveControls([matched, orphan], { last: 20 }, { treeControls: [matched] });
    const dumped = visibleControlLines(text);
    expect(dumped.some(line => line === '  @1 button#save')).toBe(true);
    expect(dumped.some(line => line.includes('role=button') && line.includes('"Orphan control"') && line.includes('div.orphan'))).toBe(true);
  });

  it('keeps an id hint when the compact selector does not already end with it', async () => {
    const control = buttonControl(0, { selector: 'button.save', id: 'save', label: 'Save draft' });
    const { text } = await perceiveControls([control], { last: 20 });
    expect(visibleControlLines(text)).toContain('  @1 button.save #save');
  });

  it('prints the previous full lines and the long Coords note with --verbose', async () => {
    const controls = Array.from({ length: 10 }, (_, index) => buttonControl(index));
    const compact = await perceiveControls(controls, {}, { truncated: true });
    const verbose = await perceiveControls(controls, { verbose: true }, { truncated: true });
    expect(verbose.text).toContain(LONG_COORDS);
    expect(verbose.text).toContain('[Visible controls] (8 shown; --last N for more)');
    expect(visibleControlLines(verbose.text).every(line => /role=button/.test(line))).toBe(true);
    expect(agentChars(compact.text)).toBeLessThan(agentChars(verbose.text));
  });

  it('keeps JSON limits.truncated when the header no longer says truncated', async () => {
    const controls = Array.from({ length: 10 }, (_, index) => buttonControl(index));
    const cdp = perceiveCdp(controls, { truncated: true });
    const store = {};
    const refState = {};
    const model = await perceiveModel(
      cdp,
      'sid',
      new RingBuffer(4),
      new RingBuffer(4),
      new Map(),
      store,
      { cursorInteractive: true, maxDepth: 8, targetPrefix: 'AB12CD34' },
      refState,
    );
    expect(store.output).not.toContain('(truncated)');
    expect(store.output).toContain('[Visible controls] (8 shown; --last N for more)');
    expect(model.limits.truncated).toBe(true);
  });

  it('still treats compact visible-control lines as cap-swap membership', () => {
    const header = [
      'Page: Dense — http://127.0.0.1/dense',
      'Viewport: 1280×800 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 4 button',
      'Console: clean',
      SHORT_COORDS,
      '',
    ];
    const previous = [
      ...header,
      '[Visible controls] (2 shown; --last N for more)',
      '  @1 button#control-1',
      '  @2 button#control-2',
    ].join('\n');
    const current = [
      ...header,
      '[Visible controls] (2 shown; --last N for more)',
      '  @3 button#control-3',
      '  @4 button#control-4',
    ].join('\n');
    const diff = formatPerceiveDiffOutput(previous, current);
    expect(diff).toContain('Visible-control cap swap: 2 left, 2 entered');
    expect(diff).not.toMatch(/Text nodes updated/);
  });

  it('leaves the controls command on the full line', () => {
    const text = formatVisibleControlsText({
      returned: 1,
      total: 1,
      truncated: false,
      limit: 30,
      controls: [buttonControl(0)],
    });
    expect(text).toContain('role=button');
    expect(text).toContain('button#control-1');
    expect(text).not.toMatch(/^ {2}@/m);
  });
});

describe('stale-ref agent output (#599)', () => {
  it('uses one sentence for a DOM-mutation ref and keeps the other causes', () => {
    const dom = formatUnknownRefError('@1', { generation: 2, invalidationReason: 'dom-mutation' });
    expect(dom).toBe('@1 is stale: the DOM changed after the last perceive.');
    expect(dom).not.toMatch(/Unknown ref|batch\/loops|stable CSS selector/);

    expect(formatUnknownRefError('@31', { generation: 2, invalidationReason: 'navigation' }))
      .toMatch(/navigated\/reloaded/);
    expect(formatUnknownRefError('@3', { generation: 0, invalidationReason: 'daemon-restart' }))
      .toMatch(/daemon restarted/);
    expect(formatUnknownRefError('@3', { generation: 0, invalidationReason: 'daemon-start' }))
      .toMatch(/No refs have been assigned/);
  });

  it('names the one live match and points Next at its selector', async () => {
    const cdp = detachedCdp();
    const refMap = new Map([[1, 14801]]);
    const refState = { generation: 1, invalidationReason: null, lastPerceiveText: SAVE_PERCEIVE };
    const output = await runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC12345', input: '@1', resolvedBy: 'selector-or-ref', label: '@1' },
      dispatch: () => clickStr(cdp, 'sid', '@1', refMap, refState),
      feedbackPolicy: 'settle-diff',
      observe: async () => '',
      format: 'json',
    });
    const action = JSON.parse(output);
    expect(action.dispatch).toMatchObject({ ok: false });
    expect(action.effects.failure).toMatchObject({
      kind: 'stale-ref',
      dispatched: false,
      nextCommand: 'cdp click ABC12345 "button#save"',
    });
    expect(action.effects.failure.originalMessage).toBe(
      '@1 is stale: the DOM changed after the last perceive. It now matches 1 element: [button] "Save draft" (button#save).',
    );
    expect(action.effects.failure.originalMessage).not.toMatch(/Unknown ref|batch\/loops|Original CDP error|@1(?! is stale)/);
    expect(action.effects.failure.nextCommand).not.toContain('@1');
    expect(action.nextSteps).toEqual(expect.arrayContaining(['cdp click ABC12345 "button#save"']));
    expect(cdp.calls.some(call => call.method.startsWith('Input.'))).toBe(false);
    const evaluated = cdp.calls.filter(call => call.method === 'Runtime.evaluate');
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0].params.expression).toContain('chrome-cdp-ex-stale-ref-match');
    expect(evaluated[0].params.expression).not.toMatch(/\.click\s*\(/);

    const text = formatActionFailure(
      Object.assign(new Error(action.effects.failure.originalMessage), {
        code: 'CDP_STALE_REF',
        staleRefMatch: matchPayload(),
      }),
      { action: 'click', target: { targetId: 'ABC12345', input: '@1' } },
    );
    const cli = formatCliError(new Error(text), { cmd: 'click', targetPrefix: 'ABC12345' });
    expect(cli).toMatch(/Kind: stale-ref/);
    expect(cli.trimEnd().endsWith('(Kind: stale-ref)')).toBe(true);
    expect(agentChars(text)).toBeLessThan(223);
  });

  it('keeps Next on perceive when the live match is missing, ambiguous, or not a unique selector', async () => {
    for (const match of [
      matchPayload({ count: 0, selector: '', selectorUnique: false }),
      matchPayload({ count: 2, selector: '', selectorUnique: false }),
      matchPayload({ count: 1, selector: 'button', selectorUnique: false }),
    ]) {
      const cdp = detachedCdp(match);
      const refMap = new Map([[1, 14801]]);
      const refState = { generation: 1, invalidationReason: null, lastPerceiveText: SAVE_PERCEIVE };
      let caught;
      try {
        await clickStr(cdp, 'sid', '@1', refMap, refState);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeTruthy();
      expect(caught.message).toBe('@1 is stale: the DOM changed after the last perceive.');
      expect(caught.message).not.toMatch(/Unknown ref|Original CDP error/);
      const failure = classifyActionFailure(caught, {
        action: 'click',
        target: { targetId: 'ABC12345', input: '@1' },
      });
      expect(failure).toMatchObject({
        kind: 'stale-ref',
        dispatched: false,
        nextCommand: 'cdp perceive ABC12345 -C -d 8',
      });
      expect(cdp.calls.some(call => call.method.startsWith('Input.'))).toBe(false);
    }
  });

  it('does not query or rewrite navigation and daemon-restart misses', async () => {
    const cdp = detachedCdp();
    await expect(resolveRefNode(cdp, 'sid', new Map(), '@1', {
      generation: 2,
      invalidationReason: 'navigation',
      lastPerceiveText: SAVE_PERCEIVE,
    })).rejects.toThrow(/navigated\/reloaded/);
    await expect(resolveRefNode(cdp, 'sid', new Map(), '@1', {
      generation: 0,
      invalidationReason: 'daemon-restart',
      lastPerceiveText: SAVE_PERCEIVE,
    })).rejects.toThrow(/daemon restarted/);
    expect(cdp.calls.some(call => call.method === 'Runtime.evaluate')).toBe(false);
  });

  it('does not query when the last perceive has no role and name for the ref', async () => {
    const cdp = detachedCdp();
    const refMap = new Map([[1, 14801]]);
    const refState = { generation: 1, invalidationReason: null };
    await expect(clickStr(cdp, 'sid', '@1', refMap, refState)).rejects.toThrow(/is stale:/);
    expect(cdp.calls.some(call => call.method === 'Runtime.evaluate')).toBe(false);
    expect(cdp.calls.some(call => call.method.startsWith('Input.'))).toBe(false);
  });

  it('names a fill match but does not suggest a click', async () => {
    const cdp = detachedCdp();
    const refMap = new Map([[1, 14801]]);
    const refState = { generation: 1, invalidationReason: null, lastPerceiveText: SAVE_PERCEIVE };
    let caught;
    try {
      await fillStr(cdp, 'sid', '@1', 'draft', refMap, refState);
    } catch (error) {
      caught = error;
    }
    expect(caught.message).toContain('button#save');
    expect(classifyActionFailure(caught, {
      action: 'fill',
      target: { targetId: 'ABC12345', input: '@1' },
    })).toMatchObject({
      kind: 'stale-ref',
      nextCommand: 'cdp perceive ABC12345 -C -d 8',
    });
  });

  it('keeps a frame ref on perceive --frame even when one element matches', async () => {
    const cdp = detachedCdp();
    const refState = {
      generation: 1,
      invalidationReason: null,
      frameRefs: new Map([['@f2', {
        frameRef: '@f2',
        frameId: 'child-frame',
        parentId: null,
        refs: new Map([[1, 14801]]),
      }]]),
      frameLastOutputs: new Map([['@f2', '[button] Save draft @f2:1  (48,48 103×40)']]),
    };
    const output = await runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC12345', input: '@f2:1', resolvedBy: 'selector-or-ref', label: '@f2:1' },
      dispatch: () => clickStr(cdp, 'sid', '@f2:1', new Map(), refState),
      feedbackPolicy: 'settle-diff',
      observe: async () => '',
      format: 'json',
    });
    const action = JSON.parse(output);
    expect(action.effects.failure.nextCommand).toBe('cdp perceive ABC12345 --frame @f2');
    expect(action.effects.failure.originalMessage).toContain('[button] "Save draft"');
    expect(action.effects.failure.nextCommand).not.toContain('button#save');
  });

  it('still classifies the previous Unknown-ref sentence as stale-ref', () => {
    expect(classifyActionFailure(
      new Error('Unknown ref: @4. Refs were invalidated by DOM changes.'),
      { action: 'click', target: { targetId: 'ABC123', input: '@4' } },
    )).toMatchObject({
      kind: 'stale-ref',
      nextCommand: 'cdp perceive ABC123 -C -d 8',
    });
  });
});
