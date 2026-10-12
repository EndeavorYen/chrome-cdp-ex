import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, statusStr, clearObservationBuffers } = T;

// =========================================================================
// CDP pending command rejection (#144)
// =========================================================================

describe('summaryModel large-app diagnostics', () => {
  it('includes DOM, table, visible-control, and hidden-template counts for stress gates', async () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify({
            title: 'Large SaaS stress fixture',
            url: 'http://127.0.0.1:42520/large-app.html',
            viewport: '1440x900',
            scrollY: 0,
            scrollMax: 3000,
            counts: { button: 220, 'input[text]': 20 },
            focused: 'none',
            domNodes: 5200,
            tableRows: 1000,
            visibleControls: 240,
            hiddenTemplateNodes: 1600,
          }),
        },
      }),
    });

    const model = await T.summaryModel(cdp, 'sid-1', consoleBuf, exceptionBuf);

    expect(model.counts).toMatchObject({
      domNodes: 5200,
      tableRows: 1000,
      visibleControls: 240,
      hiddenTemplateNodes: 1600,
    });
    expect(model.limits).toMatchObject({
      outputTokenBudget: expect.any(Number),
      hiddenTemplateNodesOmitted: 1600,
      truncated: true,
    });
  });
});

describe('parseReportArgs', () => {
  it('defaults to a bounded latest-action report window', () => {
    expect(T.parseReportArgs([])).toEqual({
      lastActions: 20,
      compact: false,
      qa: false,
      args: [],
    });
  });

  it('parses --last with a positive integer', () => {
    expect(T.parseReportArgs(['--last', '5'])).toEqual({
      lastActions: 5,
      compact: false,
      qa: false,
      args: [],
    });
  });

  it('parses --all as an unbounded report window', () => {
    expect(T.parseReportArgs(['--all', '--verbose'])).toEqual({
      lastActions: null,
      compact: false,
      qa: false,
      args: ['--verbose'],
    });
  });

  it('parses --compact for bounded JSON handoffs', () => {
    expect(T.parseReportArgs(['--last', '1', '--compact'])).toEqual({
      lastActions: 1,
      compact: true,
      qa: false,
      args: [],
    });
  });

  it('rejects missing or invalid --last values', () => {
    expect(() => T.parseReportArgs(['--last'])).toThrow(/--last requires a positive integer/);
    expect(() => T.parseReportArgs(['--last', '0'])).toThrow(/--last requires a positive integer/);
    expect(() => T.parseReportArgs(['--last', '1.5'])).toThrow(/--last requires a positive integer/);
    expect(() => T.parseReportArgs(['--last', 'nope'])).toThrow(/--last requires a positive integer/);
  });
});

describe('structured status and console models', () => {
  it('parses supported console modes and rejects unknown flags', () => {
    expect(T.parseConsoleArgs([])).toEqual({ mode: 'new', format: 'text', unsafeFull: false });
    expect(T.parseConsoleArgs(['--errors'])).toEqual({ mode: 'errors', format: 'text', unsafeFull: false });
    expect(T.parseConsoleArgs(['--all', '--format', 'json'])).toEqual({ mode: 'all', format: 'json', unsafeFull: false });
    expect(T.parseConsoleArgs(['--clear'])).toEqual({ mode: 'clear', format: 'text', unsafeFull: false });
    expect(() => T.parseConsoleArgs(['--wat'])).toThrow(/supported.*--all.*--errors.*--clear/i);
    expect(() => T.parseConsoleArgs(['--all', '--errors'])).toThrow(/exactly one mode/i);
  });

  it('clears console and exception baselines while preserving new collection', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const lastReadSeq = { console: 0, exception: 0 };
    consoleBuf.push({ level: 'error', text: 'old error' });
    exceptionBuf.push({ msg: 'old exception' });

    const model = T.clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq);

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.console-baseline.v1',
      cleared: { console: 1, exceptions: 1 },
    });
    expect(consoleBuf.all()).toEqual([]);
    expect(exceptionBuf.all()).toEqual([]);
    expect(lastReadSeq).toEqual({ console: 1, exception: 1 });

    consoleBuf.push({ level: 'error', text: 'new error' });
    expect(T.buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq).entries.map(entry => entry.text))
      .toEqual(['new error']);
  });

  it('builds a versioned console model using new entries by default', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'log', text: 'old' });
    consoleBuf.push({ level: 'error', text: 'new' });
    exceptionBuf.push({ msg: 'boom' });
    const model = T.buildConsoleModel(consoleBuf, exceptionBuf, { console: 1, exception: 0 }, undefined);

    expect(model.schema).toBe('chrome-cdp-ex.console.v1');
    expect(model.mode).toBe('new');
    expect(model.entries.map(e => e.text)).toEqual(['new']);
    expect(model.exceptions.map(e => e.msg)).toEqual(['boom']);
  });

  it('builds a versioned console model for --all', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'log', text: 'first' });
    consoleBuf.push({ level: 'warn', text: 'second' });
    const model = T.buildConsoleModel(consoleBuf, exceptionBuf, { console: 2, exception: 0 }, '--all');

    expect(model.mode).toBe('all');
    expect(model.entries.map(e => e.text)).toEqual(['first', 'second']);
  });

  it('builds a versioned status model with page and unread buffers', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const navBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'error', text: 'old' });
    consoleBuf.push({ level: 'warning', text: 'new' });
    exceptionBuf.push({ msg: 'boom' });
    navBuf.push({ url: 'https://example.com/next', ts: 123 });

    const model = T.buildStatusModel({
      targetId: 'ABC123',
      page: { title: 'Example', url: 'https://example.com' },
      consoleBuf,
      exceptionBuf,
      navBuf,
      lastReadSeq: { console: 1, exception: 0, nav: 0 },
    });

    expect(model.schema).toBe('chrome-cdp-ex.status.v1');
    expect(model.targetId).toBe('ABC123');
    expect(model.page.title).toBe('Example');
    expect(model.console.map(e => e.text)).toEqual(['new']);
    expect(model.exceptions.map(e => e.msg)).toEqual(['boom']);
    expect(model.navigation.map(e => e.url)).toEqual(['https://example.com/next']);
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


describe('status --runtime and buffer reset', () => {
  it('reports closed target state without crashing', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        throw new Error('Protocol error: Target closed');
      },
    });

    const out = await statusStr(
      cdp,
      'sid1',
      new RingBuffer(10),
      new RingBuffer(10),
      new RingBuffer(10),
      { console: 0, exception: 0 },
      { targetPrefix: 'AABBCCDD' }
    );

    expect(out).toContain('Target state: closed');
    expect(out).toContain('Kind: target-closed');
    expect(out).toContain('Run: cdp list');
    expect(out).toContain('Next: cdp list');
  });

  it('uses a sub-second page info timeout so status stays responsive after reload churn', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ title: 'T', url: 'https://example.test/' }) } }),
    });

    await statusStr(cdp, 'sid1', new RingBuffer(10), new RingBuffer(10), new RingBuffer(10), { console: 0, exception: 0 });

    const evaluateCall = cdp.calls.find(call => call.method === 'Runtime.evaluate');
    expect(evaluateCall.timeout).toBeLessThanOrEqual(500);
  });

  it('includes Performance.getMetrics counters only when requested', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ title: 'T', url: 'https://example.test/' }) } }),
      'Performance.enable': () => ({}),
      'Performance.getMetrics': () => ({
        metrics: [
          { name: 'Documents', value: 2 },
          { name: 'Frames', value: 1 },
          { name: 'JSEventListeners', value: 9 },
          { name: 'Nodes', value: 123 },
          { name: 'JSHeapUsedSize', value: 1048576 },
          { name: 'Tasks', value: 7 },
        ],
      }),
    });
    const out = await statusStr(cdp, 'sid1', new RingBuffer(10), new RingBuffer(10), new RingBuffer(10), { console: 0, exception: 0 }, { runtime: true });
    expect(out).toContain('Runtime metrics (Performance.getMetrics):');
    expect(out).toContain('Documents: 2');
    expect(out).toContain('JSHeapUsedSize: 1.0 MB');
    expect(out).not.toMatch(/pending fetch|pending timer/i);
  });

  it('clears observation buffers and advances read sequence', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const navBuf = new RingBuffer(10);
    const netReqBuf = new RingBuffer(10);
    const pendingReqs = new Map([['1', { url: '/api' }]]);
    consoleBuf.push({ text: 'a' });
    exceptionBuf.push({ msg: 'b' });
    navBuf.push({ url: 'https://example.test/' });
    netReqBuf.push({ url: '/api' });
    const lastReadSeq = { console: 0, exception: 0 };
    clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
    expect(consoleBuf.all()).toEqual([]);
    expect(exceptionBuf.all()).toEqual([]);
    expect(navBuf.all()).toEqual([]);
    expect(netReqBuf.all()).toEqual([]);
    expect(pendingReqs.size).toBe(0);
    expect(lastReadSeq.console).toBe(consoleBuf.latest());
    expect(lastReadSeq.exception).toBe(exceptionBuf.latest());
  });
});

describe('post-action page health evidence', () => {
  it('keeps successful changed action QA populated when URL sampling is unavailable', async () => {
    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC12345', input: '#select', label: 'Select' },
      dispatch: async () => 'clicked',
      feedbackPolicy: 'settle-diff',
      observe: async () => '+++ Added\n+ [button] Selected',
      enrichActionResult: result => {
        result.effects.pageHealth = {
          status: 'populated',
          isBlank: false,
          confidence: 'high',
          evidence: { visibleTextLength: 18, visibleControlCount: 1, changed: true },
        };
      },
      format: { format: 'json', qa: true },
    });

    const model = JSON.parse(out);
    expect(model.summary).toMatchObject({
      ok: true,
      page: { isBlank: false, healthStatus: 'populated' },
    });
    expect(model.action.effects.pageHealth).toMatchObject({ status: 'populated', isBlank: false });
    expect(model.action.effects.pageHealth.evidence).toEqual({ changed: true });
  });

  it('keeps blank and indeterminate compact evidence reviewable', async () => {
    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC12345', input: '#load', label: 'Load' },
      dispatch: async () => 'clicked',
      feedbackPolicy: 'settle-diff',
      observe: async () => null,
      enrichActionResult: result => {
        result.effects.pageHealth = {
          status: 'indeterminate',
          isBlank: false,
          confidence: 'low',
          evidence: {
            readyState: 'loading',
            visibleTextLength: 0,
            elementCount: 2,
            visibleControlCount: 0,
            bodyRect: { width: 390, height: 0 },
            changed: false,
          },
        };
      },
      format: { format: 'json' },
    });

    expect(JSON.parse(out).effects.pageHealth.evidence).toMatchObject({
      readyState: 'loading',
      elementCount: 2,
      bodyRect: { width: 390, height: 0 },
    });
  });
});
