import { describe, it, expect } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { recordStr, parseRecordArgs } = T;

// =========================================================================
// recordStr — timeline capture
// =========================================================================

describe('recordStr', () => {
  it('should parse duration, action, and until arguments', () => {
    expect(parseRecordArgs(['500']).durationMs).toBe(500);
    expect(parseRecordArgs(['--until', 'dom stable']).until).toBe('dom stable');
    const action = parseRecordArgs(['--action', 'click', '@1']);
    expect(action.action).toBe('click');
    expect(action.actionArgs).toEqual(['@1']);
    expect(() => parseRecordArgs(['--until', 'paint stable'])).toThrow(/dom stable|network idle/);
  });

  function makeRecordCDP(extraHandlers = {}) {
    const calls = [];
    const listeners = new Map();
    const cdp = {
      calls,
      listeners,
      onEvent(method, cb) {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(cb);
        return () => listeners.get(method)?.delete(cb);
      },
      emit(method, params) { for (const cb of listeners.get(method) || []) cb(params); },
      send(method, params = {}, sessionId, timeout) {
        calls.push({ method, params, sessionId, timeout });
        const probeSource = method === 'Runtime.evaluate'
          ? String(params.expression || '')
          : method === 'Runtime.callFunctionOn'
            ? String(params.functionDeclaration || '')
            : '';
        if (probeSource.includes('__chromeCdpExClickProbe')) {
          if (probeSource.includes('installed: true')) {
            cdp._clickProbeSeen = [];
            return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'target-document' } } });
          }
          const seen = Array.isArray(cdp._clickProbeSeen) ? cdp._clickProbeSeen.slice() : ['click'];
          cdp._clickProbeSeen = [];
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen } } });
        }
        if (method === 'Runtime.callFunctionOn'
          && params.functionDeclaration?.includes('ownerDocumentGetter')
          && !params.functionDeclaration.includes('requestAnimationFrame')) {
          return Promise.resolve({ result: { value: { connected: true } } });
        }
        if (extraHandlers[method]) {
          return Promise.resolve(extraHandlers[method](params, sessionId, cdp)).then((value) => {
            if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
              cdp._clickProbeSeen = ['mousedown', 'click'];
            }
            return value;
          });
        }
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          cdp._clickProbeSeen = ['mousedown', 'click'];
        }
        if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'mock-root-frame' } } });
        if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 901 });
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } });
        return Promise.resolve({});
      },
    };
    return cdp;
  }

  it('should record passive duration mode and report no events', async () => {
    const cdp = makeRecordCDP();
    const result = await recordStr(cdp, 'sid1', ['100'], new Map());
    expect(result).toContain('Record timeline');
    expect(result).toContain('no DOM, console');
    expect(cdp.calls.map(c => c.method)).toEqual(expect.arrayContaining(['Runtime.enable', 'Page.enable', 'DOM.enable', 'Network.enable']));
  });

  it('should record --until dom stable and include DOM mutation summary', async () => {
    let drained = false;
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        if (!drained) {
          drained = true;
          return { result: { value: JSON.stringify({ totals: { added: 2, removed: 1, attributes: 0, characterData: 0 }, labels: ['<div#app>'], count: 2 }) } };
        }
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
    });
    const result = await recordStr(cdp, 'sid1', ['--until', 'dom stable'], new Map());
    expect(result).toContain('until: dom stable');
    expect(result).toContain('DOM 2 added, 1 removed');
  });

  it('should record --until network idle and include network timeline output', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } }),
      'Network.enable': (params, sid, cdp) => {
        queueMicrotask(() => {
          cdp.emit('Network.requestWillBeSent', { requestId: 'r1', type: 'Fetch', request: { method: 'GET', url: 'https://example.com/api' } });
          cdp.emit('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 200 } });
        });
        return {};
      },
    });
    const result = await recordStr(cdp, 'sid1', ['--until', 'network idle'], new Map());
    expect(result).toContain('until: network idle');
    expect(result).toContain('GET https://example.com/api → 200');
  });

  it('should execute record --action click @ref and include action output', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({
        result: { value: { connected: true, x: 10, y: 20, w: 20, h: 10, tag: 'BUTTON', text: 'Go' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await recordStr(cdp, 'sid1', ['--action', 'click', '@1'], new Map([[1, 123]]));
    expect(result).toContain('action: click');
    expect(result).toContain('Clicked');
    expect(cdp.calls.some(c => c.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  it('should include console and exception events in timeline output', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } }),
      'Runtime.enable': (params, sid, cdp) => {
        queueMicrotask(() => {
          cdp.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] });
          cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: bad' } } });
        });
        return {};
      },
    });
    const result = await recordStr(cdp, 'sid1', ['100'], new Map());
    expect(result).toContain('console.error: boom');
    expect(result).toContain('exception: Error: bad');
  });

  // Regression: previous code only removed temporary listeners after the
  // happy-path loop, so any throw in the action path leaked listeners onto
  // the long-lived daemon. Use try/finally to guarantee cleanup.
  function listenerCount(cdp) {
    let total = 0;
    for (const set of cdp.listeners.values()) total += set.size;
    return total;
  }

  it('should remove temporary listeners when an unsupported action throws', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
    });
    await expect(
      recordStr(cdp, 'sid1', ['--action', 'wiggle', '@1'], new Map([[1, 123]]))
    ).rejects.toThrow(/does not support: wiggle/);
    expect(listenerCount(cdp)).toBe(0);
  });

  it('should remove temporary listeners when the action implementation throws', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
      // clickStr starts by resolving the @ref via DOM.resolveNode; force a
      // throw there to exercise the action error path.
      'DOM.resolveNode': () => { throw new Error('node detached'); },
    });
    await expect(
      recordStr(cdp, 'sid1', ['--action', 'click', '@1'], new Map([[1, 123]]))
    ).rejects.toThrow();
    expect(listenerCount(cdp)).toBe(0);
  });

  // Parser ergonomics: --until should work whether it appears before OR after
  // --action. Previously everything after --action was eaten as actionArgs.
  it('parseRecordArgs should accept --until after --action', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5', '--until', 'network idle']);
    expect(opts.action).toBe('click');
    expect(opts.actionArgs).toEqual(['@5']);
    expect(opts.until).toBe('network idle');
    expect(opts.durationMs).toBe(30000);
  });

  it('parseRecordArgs should still accept --until before --action', () => {
    const opts = parseRecordArgs(['--until', 'dom stable', '--action', 'click', '@5']);
    expect(opts.action).toBe('click');
    expect(opts.actionArgs).toEqual(['@5']);
    expect(opts.until).toBe('dom stable');
  });

  it('parseRecordArgs should reject invalid --until value when supplied after --action', () => {
    expect(() => parseRecordArgs(['--action', 'click', '@5', '--until', 'paint stable']))
      .toThrow(/dom stable|network idle/);
  });

  // --action default: auto-settle (DOM/network quiet) capped at 5/10s when no
  // explicit duration/--until given. Explicit duration or --until is preserved.
  it('parseRecordArgs --action without duration/until defaults to auto settle (10s cap)', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5']);
    expect(opts.until).toBe('auto settle');
    expect(opts.durationMs).toBe(10000);
    expect(opts.explicitDuration).toBe(false);
  });

  it('parseRecordArgs --action with explicit duration preserves duration and skips auto settle', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5', '2000']);
    expect(opts.until).toBe(null);
    expect(opts.durationMs).toBe(2000);
    expect(opts.explicitDuration).toBe(true);
  });

  it('parseRecordArgs --action with explicit --until preserves it (not auto settle)', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5', '--until', 'dom stable']);
    expect(opts.until).toBe('dom stable');
    expect(opts.durationMs).toBe(30000);
  });

  it('parseRecordArgs without --action keeps original 1s default', () => {
    const opts = parseRecordArgs([]);
    expect(opts.until).toBe(null);
    expect(opts.durationMs).toBe(1000);
  });
});

// =========================================================================
// replayActionsStr — execute record-actions artifacts
// =========================================================================

describe('replayActionsStr', () => {
  function artifact(actions) {
    return {
      schema: 'chrome-cdp-ex.record-actions.v1',
      targetId: 'ABC123',
      sessionId: 'sid-1',
      source: 'test',
      actionCount: actions.length,
      actions,
    };
  }

  it('replays environment controls before recorded actions', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'click', command: ['click', '#combat'], replayable: true, needsInput: [] },
    ]);
    source.environmentCount = 3;
    source.environment = [
      { index: 1, type: 'mock', action: 'add', command: ['mock', 'add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}'], replayable: true, needsInput: [] },
      { index: 2, type: 'throttle', action: 'apply', command: ['throttle', 'slow-3g'], replayable: true, needsInput: [] },
      { index: 3, type: 'clock', action: 'apply', command: ['clock', 'freeze', '--at', '2020-01-02T03:04:05.000Z'], replayable: true, needsInput: [] },
    ];

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: `${step.cmd} ok` };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual([
      { cmd: 'mock', args: ['add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}'] },
      { cmd: 'throttle', args: ['slow-3g'] },
      { cmd: 'clock', args: ['freeze', '--at', '2020-01-02T03:04:05.000Z'] },
      { cmd: 'click', args: ['#combat'] },
    ]);
    expect(out).toContain('Environment: 3 step(s)');
    expect(out).toContain('[env 1/3] mock add **/api/fail* --status 503 --body "{\\"ok\\":false}"');
    expect(out).toContain('[1/1] click #combat');
    expect(out).toContain('Done: 4 ok, 0 failed, 0 skipped');
  });

  it('runs replayable recorded commands sequentially', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'fill', command: ['fill', '#cmd', 'look trainer'], replayable: true, needsInput: [] },
      { index: 2, action: 'click', command: ['click', '#combat'], replayable: true, needsInput: [] },
    ]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: `${step.cmd} ok` };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual([
      { cmd: 'fill', args: ['#cmd', 'look trainer'] },
      { cmd: 'click', args: ['#combat'] },
    ]);
    expect(out).toContain('Replay: 2 step(s)');
    expect(out).toContain('[1/2] fill #cmd "look trainer"');
    expect(out).toContain('fill ok');
    expect(out).toContain('[2/2] click #combat');
    expect(out).toContain('Done: 2 ok, 0 failed, 0 skipped');
  });

  it('skips non-replayable recorded actions with explicit missing input', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'fill', command: ['fill', '#password', '<redacted>'], replayable: false, needsInput: ['text'] },
    ]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: 'should not run' };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual([]);
    expect(out).toContain('[1/1] skip fill #password <redacted>');
    expect(out).toContain('Missing: text');
    expect(out).toContain('Done: 0 ok, 0 failed, 1 skipped');
  });

  it('halts on the first failed replay step by default', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'click', command: ['click', '#missing'], replayable: true, needsInput: [] },
      { index: 2, action: 'click', command: ['click', '#later'], replayable: true, needsInput: [] },
    ]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step.cmd);
        return { ok: false, error: 'Element not found' };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual(['click']);
    expect(out).toContain('Element not found');
    expect(out).toContain('Replay halted at step 1/2');
    expect(out).toContain('Done: 0 ok, 1 failed, 0 skipped');
  });

  it('returns structured JSON handoff with counts and failed step', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'fill', command: ['fill', '#cmd', 'look trainer'], replayable: true, needsInput: [] },
      { index: 2, action: 'click', command: ['click', '#missing'], replayable: true, needsInput: [] },
      { index: 3, action: 'click', command: ['click', '#later'], replayable: true, needsInput: [] },
    ]);
    source.environmentCount = 1;
    source.environment = [
      { index: 1, type: 'mock', action: 'add', command: ['mock', 'add', '**/api/fail*', '--status', '503'], replayable: true, needsInput: [] },
    ];

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        if (step.cmd === 'click') return { ok: false, error: 'Element not found: #missing' };
        return { ok: true, result: `${step.cmd} ok\nsecond line` };
      },
    }, ['--format', 'json', '--json', JSON.stringify(source)]);
    const parsed = JSON.parse(out);

    expect(calls).toEqual([
      { cmd: 'mock', args: ['add', '**/api/fail*', '--status', '503'] },
      { cmd: 'fill', args: ['#cmd', 'look trainer'] },
      { cmd: 'click', args: ['#missing'] },
    ]);
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.replay.v1',
      source: 'inline JSON',
      sourceTargetId: 'ABC123',
      halted: true,
      counts: {
        environment: 1,
        actions: 3,
        ok: 2,
        failed: 1,
        skipped: 0,
        total: 4,
      },
      failedStep: {
        phase: 'action',
        index: 2,
        commandText: 'click #missing',
        error: 'Element not found: #missing',
      },
      nextSteps: [
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]).toMatchObject({
      phase: 'environment',
      index: 1,
      ok: true,
      command: ['mock', 'add', '**/api/fail*', '--status', '503'],
      resultPreview: 'mock ok',
    });
    expect(parsed.steps[2]).toMatchObject({
      phase: 'action',
      index: 2,
      ok: false,
      command: ['click', '#missing'],
    });
  });
});
