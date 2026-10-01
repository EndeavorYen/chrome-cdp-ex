import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET_ID = 'ABCDEF12';
// Failure Next lines name the receipt's targetId (the daemon passes its target prefix).
const PREFIX = TARGET_ID;
const PAGE_URL = 'http://127.0.0.1:8490/form';
const NEXT_URL = 'http://127.0.0.1:8490/next';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Chrome 154, measured live: with beforeunload dismissed, Page.reload returns {} and no main-frame
// Page.frameNavigated follows; Page.navigate returns errorText net::ERR_ABORTED. The old document
// is still `complete`, so a readiness probe passes at once. With a slow handler (#500 review):
// Target.getTargets reports the pending URL before the dialog opens, and the dialog for a reload
// opens long after Page.reload has returned {}.
function fakeChrome({
  dialogBuf,
  session,
  beforeunload = 'dismiss',
  handlerMs = 0, // how long the page's beforeunload handler runs before the dialog opens
  pendingUrlVisible = false, // Target.getTargets shows the requested URL while beforeunload runs
} = {}) {
  const calls = [];
  const dialogCdp = { send: () => Promise.resolve({}) };
  let currentUrl = PAGE_URL;
  let pendingUrl = null;
  async function runBeforeunload() {
    if (!beforeunload) return true;
    if (handlerMs) await sleep(handlerMs);
    // What the daemon's Page.javascriptDialogOpening handler does.
    await T.handleOpeningJavaScriptDialog(dialogCdp, 'sid', { type: 'beforeunload', message: '', url: PAGE_URL }, { sessionId: 'sid' }, {
      accept: beforeunload === 'accept',
      dialogBuf,
      retries: 1,
      delayMs: 1,
    });
    return beforeunload === 'accept';
  }
  function commit(url) {
    currentUrl = url;
    pendingUrl = null;
    // The daemon's main-frame Page.frameNavigated handler.
    session.pageGeneration += 1;
  }
  return {
    calls,
    async send(method, params = {}) {
      calls.push(method);
      if (method === 'Page.reload') {
        // Page.reload returns before the beforeunload handler has finished.
        runBeforeunload().then(accepted => { if (accepted) commit(currentUrl); });
        return {};
      }
      if (method === 'Page.navigate') {
        if (pendingUrlVisible) pendingUrl = params.url;
        if (!(await runBeforeunload())) {
          pendingUrl = null;
          return { frameId: 'MAIN', errorText: 'net::ERR_ABORTED' };
        }
        commit(params.url);
        return { frameId: 'MAIN', loaderId: 'L2' };
      }
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: TARGET_ID, type: 'page', url: pendingUrl || currentUrl }] };
      }
      if (method === 'Runtime.evaluate') {
        const value = params.expression === 'document.readyState'
          ? 'complete'
          : JSON.stringify({ readyState: 'complete', url: currentUrl });
        return { result: { value } };
      }
      return {};
    },
    waitForEvent() {
      return { promise: new Promise(() => {}), cancel() {} };
    },
  };
}

function daemonState() {
  const session = T.createSessionState({ targetId: TARGET_ID, sessionId: 'sid' });
  session.refs.map.set(1, 101);
  const bufs = {
    consoleBuf: new T.RingBuffer(10),
    exceptionBuf: new T.RingBuffer(10),
    navBuf: new T.RingBuffer(10),
    netReqBuf: new T.RingBuffer(10),
    dialogBuf: new T.RingBuffer(20),
  };
  bufs.consoleBuf.push({ level: 'log', text: 'typed a draft' });
  return { session, ...bufs, pendingReqs: new Map(), lastReadSeq: { console: 0, exception: 0, nav: 0 } };
}

// Mirrors the daemon's reload / nav handlers: baseline, dispatch, observe, delta.
async function runCommand(action, state, cdp, { format = 'text', mode = 'dismiss', targetId = null } = {}) {
  const jsDialogs = T.createJavaScriptDialogSession();
  const baseline = T.createActionObservationBaseline(state);
  const cancelWatch = () => T.createNavigationCancelWatch({
    dialogBuf: state.dialogBuf,
    jsDialogs,
    session: state.session,
    dismissMode: () => mode === 'dismiss',
  });
  const dispatch = action === 'reload'
    ? () => T.reloadActionDispatch({ cdp, sessionId: 'sid', ...state, navigationCancelWatch: cancelWatch() })
    : () => T.navActionDispatch({
        cdp,
        sessionId: 'sid',
        url: NEXT_URL,
        targetId,
        navigationCancelWatch: cancelWatch(),
        navOpts: { observeDelayMs: 0, readyTimeoutMs: 50, probeTimeoutMs: 20 },
      });
  let captured = null;
  const started = Date.now();
  const run = T.runActionWithFeedback({
    action,
    target: action === 'reload'
      ? { input: 'reload', resolvedBy: 'page', label: 'reload', commandArgs: [], targetId: TARGET_ID }
      : { input: NEXT_URL, resolvedBy: 'url', label: NEXT_URL, commandArgs: [NEXT_URL], targetId: TARGET_ID },
    dispatch,
    feedbackPolicy: 'state-change',
    observe: async () => `${action === 'reload' ? 'Reload' : 'Navigation'} observation:\nPage: Form\nURL: ${PAGE_URL}\nReady state: complete`,
    enrichActionResult: async (result) => T.applyActionObservationDelta(result, T.buildActionObservationDelta(state, baseline)),
    onActionResult: (result) => { captured = result; },
    format,
  });
  const output = await run.catch(error => error);
  return { output, result: captured, elapsedMs: Date.now() - started };
}

describe('#490 a dismissed beforeunload that cancels reload / nav is not reported as success', () => {
  it('reload: classified navigation-cancelled failure with dialog accept as Next; nothing is cleared', async () => {
    const state = daemonState();
    const { output } = await runCommand('reload', state, fakeChrome(state));
    expect(output).toBeInstanceOf(Error);
    const text = output.message;
    expect(text).not.toContain('Page reloaded');
    expect(text).not.toContain('Outcome: changed');
    expect(text).toMatch(/^Error: .*beforeunload prompt was dismissed.*reload was cancelled/m);
    expect(text).toContain('Kind: navigation-cancelled');
    expect(text).toContain(`then retry \`cdp reload ${PREFIX}\``);
    expect(text).toContain(`Next: cdp dialog ${PREFIX} accept`);
    expect(text).toContain('Dialog: beforeunload → dismissed (navigation was cancelled; the page stayed)');
    // The page did not change: its refs and buffers are still valid.
    expect(state.session.refs.map.size).toBe(1);
    expect(state.consoleBuf.all()).toHaveLength(1);
  });

  it('the receipt also names a non-destructive next step (#500 review)', async () => {
    const state = daemonState();
    const { output } = await runCommand('reload', state, fakeChrome(state));
    expect(output.message).toContain(`To keep the unsaved changes, leave dialog handling at dismiss and check the page with \`cdp status ${PREFIX}\`.`);
    const jsonState = daemonState();
    const json = JSON.parse((await runCommand('reload', jsonState, fakeChrome(jsonState), { format: 'json' })).output);
    expect(json.nextSteps).toEqual(expect.arrayContaining([`cdp dialog ${PREFIX} accept`, `cdp status ${PREFIX}`]));
  });

  it('reload JSON: dispatch.ok=false with effects.failure.kind navigation-cancelled', async () => {
    const state = daemonState();
    const { output } = await runCommand('reload', state, fakeChrome(state), { format: 'json' });
    const json = JSON.parse(output);
    expect(json.dispatch.ok).toBe(false);
    expect(json.outcome.status).toBe('failed');
    expect(json.effects.failure).toMatchObject({ kind: 'navigation-cancelled', nextCommand: `cdp dialog ${PREFIX} accept` });
    expect(json.effects.dialogs).toEqual([{ type: 'beforeunload', message: '', accepted: false, url: PAGE_URL }]);
    expect(json.effects.diagnosis.recovery.avoid.join(' ')).toMatch(/dismiss/);
  });

  it('reload: a slow beforeunload whose dialog opens after reloadStr returned is still caught in dismiss mode', async () => {
    const state = daemonState();
    const { output, elapsedMs } = await runCommand('reload', state, fakeChrome({ ...state, handlerMs: 1200 }));
    expect(output).toBeInstanceOf(Error);
    expect(output.message).toContain('Kind: navigation-cancelled');
    expect(state.session.refs.map.size).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(1100);
    expect(elapsedMs).toBeLessThan(3500);
  });

  it('reload in dismiss mode does not wait once the new document commits', async () => {
    const state = daemonState();
    const { output, elapsedMs } = await runCommand('reload', state, fakeChrome({ ...state, beforeunload: null }));
    expect(output).not.toBeInstanceOf(Error);
    expect(output).toContain('Page reloaded');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('reload in accept mode never waits for a dialog', async () => {
    const state = daemonState();
    // A target that never reports the commit: accept mode must not add the bounded wait.
    const noCommit = { ...fakeChrome({ ...state, beforeunload: null }) };
    const send = noCommit.send;
    noCommit.send = async (method, params) => (method === 'Page.reload' ? {} : send(method, params));
    const { output, elapsedMs } = await runCommand('reload', state, noCommit, { mode: 'accept' });
    expect(output).toContain('Page reloaded');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('nav: net::ERR_ABORTED after a dismissed beforeunload is navigation-cancelled with a nav retry', async () => {
    const state = daemonState();
    const { output } = await runCommand('nav', state, fakeChrome(state));
    expect(output).toBeInstanceOf(Error);
    const text = output.message;
    expect(text).not.toContain('Navigated to');
    expect(text).toMatch(/^Error: .*beforeunload prompt was dismissed.*navigation was cancelled/m);
    expect(text).toContain('Kind: navigation-cancelled');
    expect(text).toContain(`then retry \`cdp nav ${PREFIX} ${NEXT_URL}\``);
    expect(text).toContain(`Next: cdp dialog ${PREFIX} accept`);
  });

  it('nav: the pending URL is observed before Page.navigate resolves with ERR_ABORTED (slow handler, #500 review)', async () => {
    const state = daemonState();
    const cdp = fakeChrome({ ...state, handlerMs: 300, pendingUrlVisible: true });
    const { output } = await runCommand('nav', state, cdp, { targetId: TARGET_ID });
    expect(cdp.calls).toContain('Target.getTargets');
    expect(output).toBeInstanceOf(Error);
    expect(output.message).toContain('Kind: navigation-cancelled');
    expect(output.message).not.toContain('Navigated to');
  });

  it('nav: a dismissed beforeunload found after navStr returned success is still a cancellation', async () => {
    const state = daemonState();
    // Page.navigate never answers, the pending URL is visible, and the dialog was already dismissed.
    const cdp = fakeChrome({ ...state, pendingUrlVisible: true });
    const send = cdp.send;
    cdp.send = async (method, params) => {
      if (method === 'Page.navigate') {
        send(method, params);
        return new Promise(() => {});
      }
      return send(method, params);
    };
    const { output } = await runCommand('nav', state, cdp, { targetId: TARGET_ID, mode: 'accept' });
    expect(output).toBeInstanceOf(Error);
    expect(output.message).toContain('Kind: navigation-cancelled');
  });

  it('accepted beforeunload still reloads and navigates normally', async () => {
    for (const action of ['reload', 'nav']) {
      const state = daemonState();
      const { output, result } = await runCommand(action, state, fakeChrome({ ...state, beforeunload: 'accept' }), { mode: 'accept' });
      expect(output).not.toBeInstanceOf(Error);
      expect(result.dispatch.ok).toBe(true);
      expect(output).toContain('Dialog: beforeunload → accepted');
    }
  });

  it('nav: net::ERR_ABORTED without a dismissed beforeunload keeps its ordinary failure', async () => {
    const state = daemonState();
    const { output } = await runCommand('nav', state, fakeChrome({ ...state, beforeunload: null }));
    // No beforeunload ran, so the fake reports a committed navigation; force an abort instead.
    expect(output).not.toBeInstanceOf(Error);
    const aborted = {
      async send(method) {
        if (method === 'Page.navigate') return { frameId: 'MAIN', errorText: 'net::ERR_ABORTED' };
        return {};
      },
      waitForEvent: () => ({ promise: new Promise(() => {}), cancel() {} }),
    };
    const err = await runCommand('nav', daemonState(), aborted).then(r => r.output);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('net::ERR_ABORTED');
    expect(err.message).not.toContain('navigation-cancelled');
  });

  it('a dismissed dialog followed by a committed main-frame navigation is not a cancellation', async () => {
    const dialogBuf = new T.RingBuffer(5);
    const session = { pageGeneration: 0 };
    const watch = T.createNavigationCancelWatch({ dialogBuf, session });
    dialogBuf.push({ type: 'beforeunload', message: '', accepted: false, handled: true });
    expect(await watch()).toMatchObject({ type: 'beforeunload', accepted: false });
    session.pageGeneration += 1;
    expect(await watch()).toBeNull();
    // A dialog answered before the dispatch started is not evidence either.
    const later = T.createNavigationCancelWatch({ dialogBuf, session });
    expect(await later()).toBeNull();
  });

  it('the bounded wait stops at the deadline when nothing happens', async () => {
    const watch = T.createNavigationCancelWatch({
      dialogBuf: new T.RingBuffer(5),
      session: { pageGeneration: 0 },
      dismissMode: () => true,
    });
    const started = Date.now();
    expect(await watch({ awaitMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
