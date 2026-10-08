import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #610: cdp reload used to clear the console and exception buffers after the
// new document had already loaded. A throw in that document's load was wiped,
// so the reload receipt omitted it and the next perceive said Console: clean.
// Entries from the previous document must still stay off those reads.

const FIXTURE = readFileSync(new URL('./fixtures/issue-610-load-throw.html', import.meta.url), 'utf8');
const LOAD_ERROR = FIXTURE.match(/throw new Error\('([^']+)'\)/)[1];
const PAGE_TITLE = FIXTURE.match(/<title>([^<]+)<\/title>/)[1];
const PAGE_URL = 'http://127.0.0.1:7610/load-throw.html';
const PREVIOUS_ERROR = 'previous-document-only';
const TARGET_ID = '610A1C0DE5E1F0000000000000000610';

function pageMeta() {
  return JSON.stringify({
    title: PAGE_TITLE,
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

function axNodes() {
  return [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: PAGE_TITLE }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'paragraph' }, name: { value: '' }, childIds: ['3'] },
    { nodeId: '3', parentId: '2', role: { value: 'StaticText' }, name: { value: 'loaded with an error' } },
  ];
}

function exception(description) {
  return T.exceptionEntryFromEvent({
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description },
    },
  });
}

function buffers() {
  return {
    consoleBuf: new T.RingBuffer(200),
    exceptionBuf: new T.RingBuffer(50),
    navBuf: new T.RingBuffer(10),
    netReqBuf: new T.RingBuffer(20),
    lastReadSeq: { console: 0, exception: 0, nav: 0 },
  };
}

function sessionFor(bufs) {
  const session = T.createSessionState({ targetId: TARGET_ID, sessionId: 'sid-610' });
  session.buffers = {
    console: bufs.consoleBuf,
    exception: bufs.exceptionBuf,
    navigation: bufs.navBuf,
    network: bufs.netReqBuf,
  };
  return session;
}

// What the daemon's main-frame Page.frameNavigated handler does, then the
// exception the new document throws while it loads (after the commit).
function commitThenThrow(session, bufs) {
  session.pageGeneration += 1;
  bufs.navBuf.push({ url: PAGE_URL, ts: Date.now() });
  T.invalidateSessionRefs(session, 'navigation');
  bufs.exceptionBuf.push(exception(`Error: ${LOAD_ERROR}`));
}

function reloadCdp(session, bufs, { commit = true } = {}) {
  return {
    send(method, params = {}) {
      if (method === 'Page.reload') {
        if (commit) commitThenThrow(session, bufs);
        else bufs.exceptionBuf.push(exception(`Error: ${LOAD_ERROR}`));
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr === 'document.readyState') return Promise.resolve({ result: { value: 'complete' } });
        return Promise.resolve({ result: { value: pageMeta() } });
      }
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: axNodes() });
      return Promise.resolve({});
    },
    waitForEvent(method) {
      const fired = method === 'Page.loadEventFired';
      return {
        promise: fired ? Promise.resolve({}) : new Promise(() => {}),
        cancel() {},
      };
    },
  };
}

function consoleHeader(output) {
  const line = String(output).split('\n').find(entry => entry.startsWith('Console: '));
  if (!line) throw new Error(`perceive output has no Console header:\n${output}`);
  return line;
}

async function perceive(bufs) {
  return T.perceiveStr(
    reloadCdp(sessionFor(bufs), bufs, { commit: false }),
    'sid',
    bufs.consoleBuf,
    bufs.exceptionBuf,
    new Map(),
    { output: null },
    {},
    { generation: 0 },
  );
}

async function reload(session, bufs, { commit = true } = {}) {
  const baseline = T.createActionObservationBaseline({
    consoleBuf: bufs.consoleBuf,
    exceptionBuf: bufs.exceptionBuf,
    netReqBuf: bufs.netReqBuf,
  });
  return T.runActionWithFeedback({
    action: 'reload',
    target: {
      input: 'reload',
      resolvedBy: 'page',
      label: 'reload',
      commandArgs: [],
      targetId: TARGET_ID,
    },
    dispatch: () => T.reloadActionDispatch({
      cdp: reloadCdp(session, bufs, { commit }),
      sessionId: 'sid-610',
      session,
      consoleBuf: bufs.consoleBuf,
      exceptionBuf: bufs.exceptionBuf,
      navBuf: bufs.navBuf,
      netReqBuf: bufs.netReqBuf,
      pendingReqs: new Map([['r1', { url: '/api' }]]),
      lastReadSeq: bufs.lastReadSeq,
    }),
    feedbackPolicy: 'state-change',
    observe: async () => `Reload observation:\nPage: ${PAGE_TITLE}\nURL: ${PAGE_URL}\nReady state: complete`,
    enrichActionResult: async (result) => T.applyActionObservationDelta(
      result,
      T.buildActionObservationDelta({
        consoleBuf: bufs.consoleBuf,
        exceptionBuf: bufs.exceptionBuf,
        netReqBuf: bufs.netReqBuf,
      }, baseline),
    ),
    format: 'text',
  });
}

describe('#610 reload keeps an exception thrown while the new document loads', () => {
  it('reads the fixture page that throws during load', () => {
    expect(FIXTURE).toMatch(/<script>\s*throw new Error\('load-throw-610'\);\s*<\/script>/);
    expect(LOAD_ERROR).toBe('load-throw-610');
    expect(PAGE_TITLE).toBe('load throw');
  });

  it('reports that load exception on the reload receipt and the next perceive', async () => {
    const bufs = buffers();
    const session = sessionFor(bufs);
    bufs.exceptionBuf.push(exception(`Error: ${PREVIOUS_ERROR}`));

    const receipt = await reload(session, bufs);
    expect(receipt).toContain('Page reloaded');
    expect(receipt).toContain('Outcome: attention');
    expect(receipt).toContain('Exception: 1 thrown');
    expect(receipt).toContain(`Exception sample: Error: ${LOAD_ERROR}`);
    expect(receipt).toContain('Next: cdp console 610A1C0D --errors');
    expect(receipt).not.toContain(PREVIOUS_ERROR);
    expect(receipt).not.toMatch(/Console: clean/);

    const after = await perceive(bufs);
    expect(consoleHeader(after)).toBe('Console: 1 exception');
    expect(after).not.toContain(PREVIOUS_ERROR);
    expect(after).not.toMatch(/Console: clean/);

    const listed = await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, '--all');
    expect(listed).toContain(LOAD_ERROR);
    expect(listed).not.toContain(PREVIOUS_ERROR);

    expect(bufs.navBuf.all()).toEqual([]);
    expect(session.refs.invalidationReason).toBe('navigation');
  });

  it('still reports the load exception when no main-frame commit event arrives', async () => {
    const bufs = buffers();
    const session = sessionFor(bufs);
    bufs.exceptionBuf.push(exception(`Error: ${PREVIOUS_ERROR}`));

    const receipt = await reload(session, bufs, { commit: false });
    expect(receipt).toContain(LOAD_ERROR);
    expect(receipt).not.toContain(PREVIOUS_ERROR);

    expect(consoleHeader(await perceive(bufs))).toBe('Console: 1 exception');
    const listed = await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, '--all');
    expect(listed).toContain(LOAD_ERROR);
    expect(listed).not.toContain(PREVIOUS_ERROR);
  });

  it('does not bring a previous-document exception back when the new document is clean', async () => {
    const bufs = buffers();
    const session = sessionFor(bufs);
    bufs.exceptionBuf.push(exception(`Error: ${PREVIOUS_ERROR}`));
    const cdp = {
      send(method) {
        if (method === 'Page.reload') {
          session.pageGeneration += 1;
          T.invalidateSessionRefs(session, 'navigation');
          return Promise.resolve({});
        }
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: pageMeta() } });
        if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: axNodes() });
        return Promise.resolve({});
      },
      waitForEvent(method) {
        return {
          promise: method === 'Page.loadEventFired' ? Promise.resolve({}) : new Promise(() => {}),
          cancel() {},
        };
      },
    };
    await T.reloadActionDispatch({
      cdp,
      sessionId: 'sid-610',
      session,
      consoleBuf: bufs.consoleBuf,
      exceptionBuf: bufs.exceptionBuf,
      navBuf: bufs.navBuf,
      netReqBuf: bufs.netReqBuf,
      pendingReqs: new Map(),
      lastReadSeq: bufs.lastReadSeq,
    });
    expect(consoleHeader(await perceive(bufs))).toBe('Console: clean');
    expect(await T.consoleStr(bufs.consoleBuf, bufs.exceptionBuf, bufs.lastReadSeq, '--all')).toBe('Console buffer is empty');
  });
});
