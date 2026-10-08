import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #594: a page that throws only on its first load (sessionStorage gate) still
// showed that exception in perceive's Console header and in `console` after
// location.reload(). The network list is already cut at the latest navigation.
// These lists follow the current document.

const PAGE_URL = 'http://127.0.0.1:7899/console-reload.html';

function pageMeta() {
  return JSON.stringify({
    title: 'console after reload',
    url: PAGE_URL,
    contentType: 'text/html',
    vw: 800,
    vh: 600,
    scrollY: 0,
    scrollMax: 0,
    counts: {},
    focused: 'none',
    layoutMap: {},
    styleHints: {},
    cursorInteractives: [],
    visibleControls: [],
  });
}

function summaryMeta() {
  return JSON.stringify({
    title: 'console after reload',
    url: PAGE_URL,
    viewport: '800x600',
    scrollY: 0,
    scrollMax: 0,
    counts: {},
    domNodes: 4,
    tableRows: 0,
    visibleControls: 0,
    hiddenTemplateNodes: 0,
    focused: 'none',
  });
}

function axNodes() {
  return [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'console after reload' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'paragraph' }, name: { value: '' }, childIds: ['3'] },
    { nodeId: '3', parentId: '2', role: { value: 'StaticText' }, name: { value: 'second load: clean' } },
  ];
}

function pageCdp() {
  return {
    send(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        const value = expr.includes('domNodes') ? summaryMeta() : pageMeta();
        return Promise.resolve({ result: { value } });
      }
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: axNodes() });
      return Promise.resolve({});
    },
  };
}

function buffers() {
  return {
    consoleBuf: new T.RingBuffer(200),
    exceptionBuf: new T.RingBuffer(50),
    lastReadSeq: { console: 0, exception: 0 },
  };
}

function sessionFor(bufs) {
  const session = T.createSessionState({
    targetId: '594A1C0DE5E1F0000000000000000594',
    sessionId: 'sid-594',
  });
  session.buffers = { console: bufs.consoleBuf, exception: bufs.exceptionBuf };
  return session;
}

// What the daemon's main-frame Page.frameNavigated handler already does.
function commitMainFrame(session) {
  T.invalidateSessionRefs(session, 'navigation');
}

function firstLoadOnly(bufs) {
  bufs.consoleBuf.push(T.consoleEntryFromEvent({
    type: 'error',
    args: [{ value: 'first load error' }],
  }));
  bufs.exceptionBuf.push(T.exceptionEntryFromEvent({
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description: 'Error: first load only' },
    },
  }));
}

function consoleHeader(output) {
  const line = String(output).split('\n').find(entry => entry.startsWith('Console: '));
  if (!line) throw new Error(`perceive output has no Console header:\n${output}`);
  return line;
}

async function perceive(bufs) {
  return T.perceiveStr(
    pageCdp(),
    'sid',
    bufs.consoleBuf,
    bufs.exceptionBuf,
    new Map(),
    { output: null },
    {},
    { generation: 0 },
  );
}

describe('#594 console and exception lists follow the current document', () => {
  it('drops the first-load exception from perceive, summary, status, and console after reload', async () => {
    const bufs = buffers();
    firstLoadOnly(bufs);
    const session = sessionFor(bufs);

    const before = await perceive(bufs);
    expect(consoleHeader(before)).toBe('Console: 1 error, 1 exception');
    expect(await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, undefined)).toMatch(/Error: first load only/);
    bufs.lastReadSeq.console = 0;
    bufs.lastReadSeq.exception = 0;

    commitMainFrame(session);

    const after = await perceive(bufs);
    expect(consoleHeader(after)).toBe('Console: clean');
    expect(after).not.toMatch(/first load only/);
    expect([...consoleHeader(before)].length).toBeGreaterThan([...consoleHeader(after)].length);

    const summary = await T.summaryStr(pageCdp(), 'sid', bufs.consoleBuf, bufs.exceptionBuf);
    expect(summary).toMatch(/^Console: clean$/m);

    const status = await T.statusStr(pageCdp(), 'sid', bufs.consoleBuf, bufs.exceptionBuf, new T.RingBuffer(4), bufs.lastReadSeq);
    expect(status).toMatch(/Console: \(no new entries\)/);
    expect(status).not.toMatch(/first load only/);
    expect(status).not.toMatch(/first load error/);

    bufs.lastReadSeq.console = 0;
    bufs.lastReadSeq.exception = 0;
    expect(await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, undefined)).toBe('No new console entries');
    expect(await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, '--all')).toBe('Console buffer is empty');
    expect(await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, '--errors')).toBe('No new console entries');

    const model = T.buildConsoleModel(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, '--all');
    expect(model.entries).toEqual([]);
    expect(model.exceptions).toEqual([]);
    const statusModel = T.buildStatusModel({
      targetId: '594A1C0D',
      page: { title: 'console after reload', url: PAGE_URL },
      consoleBuf: bufs.consoleBuf,
      exceptionBuf: bufs.exceptionBuf,
      navBuf: new T.RingBuffer(4),
      lastReadSeq: { console: 0, exception: 0 },
    });
    expect(statusModel.console).toEqual([]);
    expect(statusModel.exceptions).toEqual([]);
  });

  it('keeps an exception the current document threw, and one the action threw before the commit', async () => {
    const bufs = buffers();
    const session = sessionFor(bufs);
    const baseline = T.createActionObservationBaseline({
      consoleBuf: bufs.consoleBuf,
      exceptionBuf: bufs.exceptionBuf,
    });
    bufs.exceptionBuf.push(T.exceptionEntryFromEvent({
      exceptionDetails: { exception: { description: 'Error: handler failed' } },
    }));
    commitMainFrame(session);
    bufs.exceptionBuf.push(T.exceptionEntryFromEvent({
      exceptionDetails: { exception: { description: 'Error: second load' } },
    }));
    bufs.consoleBuf.push(T.consoleEntryFromEvent({
      type: 'warning',
      args: [{ value: 'second load warning' }],
    }));

    const delta = T.buildActionObservationDelta({
      consoleBuf: bufs.consoleBuf,
      exceptionBuf: bufs.exceptionBuf,
    }, baseline);
    expect(delta.exceptions.count).toBe(2);
    expect(delta.exceptions.entries.some(entry => /handler failed/.test(entry.message || ''))).toBe(true);

    expect(consoleHeader(await perceive(bufs))).toBe('Console: 1 warning, 1 exception');
    const listed = await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, '--all');
    expect(listed).toMatch(/second load warning/);
    expect(listed).toMatch(/Error: second load/);
    expect(listed).not.toMatch(/handler failed/);
  });

  it('does not cut on a non-navigation ref invalidation', async () => {
    const bufs = buffers();
    const session = sessionFor(bufs);
    firstLoadOnly(bufs);
    T.invalidateSessionRefs(session, 'daemon-start');
    expect(consoleHeader(await perceive(bufs))).toBe('Console: 1 error, 1 exception');
  });

  it('clear counts only the current document, then drops the hidden entries too', () => {
    const bufs = buffers();
    const session = sessionFor(bufs);
    firstLoadOnly(bufs);
    commitMainFrame(session);
    bufs.exceptionBuf.push(T.exceptionEntryFromEvent({
      exceptionDetails: { exception: { description: 'Error: second load' } },
    }));
    const cleared = T.clearConsoleBaseline(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq);
    expect(cleared.cleared).toEqual({ console: 0, exceptions: 1 });
    expect(bufs.exceptionBuf.all()).toEqual([]);
    expect(bufs.consoleBuf.all()).toEqual([]);
  });

  it('wires the cut through the main-frame navigation ref invalidation', () => {
    const src = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/function invalidateSessionRefs\(session, reason, options = \{\}\) \{[\s\S]*reason === 'navigation' && options\.cutDocument !== false[\s\S]*cutDocumentConsoleBuffers\(session\.buffers\)/);
    expect(src).toMatch(/Page\.frameNavigated[\s\S]{0,500}if \(!params\.frame\.parentId\)[\s\S]*invalidateSessionRefs\(session, 'navigation'\)/);
    expect(src).not.toMatch(/consoleBuf\.all\(\)|exceptionBuf\.all\(\)/);
  });
});
