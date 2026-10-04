import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const WS_URL = 'ws://127.0.0.1:3048/devtools/browser/abc';
const FULL_ID = '1667E1A41DF4F9ED4DEBC30A498CCB8F';

function installFakeWebSocket({ failBeforeOpen = false } = {}) {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(this);
      queueMicrotask(() => {
        if (failBeforeOpen) {
          // Node's WebSocket error Event carries no message: only type 'error'.
          this.onerror?.({ type: 'error' });
          this.readyState = FakeWebSocket.CLOSED;
          this.onclose?.({ type: 'close', code: 1006, reason: '' });
          return;
        }
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({ type: 'open' });
      });
    }
    send(data) {
      // Like Node's WebSocket: a send on a closed socket is dropped silently, not thrown.
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.lastSent = data;
    }
    close(code = 1006, reason = '') {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ type: 'close', code, reason: String(reason) });
    }
  }
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  return { sockets, restore() { globalThis.WebSocket = previous; } };
}

describe('#533 item 1: a lost browser names its endpoint', () => {
  let fake;
  afterEach(() => fake?.restore());

  it('T1: a connect that fails before open names host:port and says refused or closed', async () => {
    fake = installFakeWebSocket({ failBeforeOpen: true });
    const cdp = new T.CDP();
    const err = await cdp.connect(WS_URL).then(() => null, e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('127.0.0.1:3048');
    expect(err.message).toMatch(/refused or closed/);
    expect(err.message).not.toMatch(/error: error/i);
    // Still classified as a browser endpoint failure, not Kind: unknown.
    expect(T.formatCliError(err, { cmd: 'list' })).toMatch(/Kind: browser-cdp/);
  });

  it('T2: a socket that closes after open names the endpoint on pending commands', async () => {
    fake = installFakeWebSocket();
    const cdp = new T.CDP();
    await cdp.connect(WS_URL);
    const pending = cdp.send('Page.navigate', { url: 'http://127.0.0.1:7860/' });
    fake.sockets.at(-1).close(1006, '');
    const err = await pending.then(() => null, e => e);
    expect(err.message).toMatch(/CDP websocket closed while waiting for Page\.navigate/);
    expect(err.message).toContain('127.0.0.1:3048');
    expect(err.message).toMatch(/closed/);
  });

  it('T2: a send after the socket closed names the endpoint too', async () => {
    fake = installFakeWebSocket();
    const cdp = new T.CDP();
    await cdp.connect(WS_URL);
    fake.sockets.at(-1).close(1006, '');
    const started = Date.now();
    const err = await cdp.send('Runtime.evaluate', {}, undefined, 5_000).then(() => null, e => e);
    // Rejected at once, not after the command timeout (live: `Timeout: Browser.getVersion` after 15 s).
    expect(Date.now() - started).toBeLessThan(500);
    expect(err.message).toMatch(/CDP websocket closed while waiting for Runtime\.evaluate/);
    expect(err.message).toContain('127.0.0.1:3048');
  });
});

describe('#533 item 3: action diagnosis Next uses the target prefix', () => {
  const actionResult = network => ({
    action: 'nav',
    target: { targetId: FULL_ID, input: 'http://127.0.0.1:7860/' },
    dispatch: { ok: true },
    settle: { ok: true },
    effects: { networkDelta: network },
  });

  it('T3/T4: network-pending suggests perceive with the 8-character prefix', () => {
    const diagnosis = T.createActionDiagnosis(actionResult({ pending: 2, entries: [] }));
    expect(diagnosis.kind).toBe('network-pending');
    expect(diagnosis.nextCommand).toBe('cdp perceive 1667E1A4');
    // The JSON verdict's primary step comes from the first recovery command: it must agree with Next.
    expect(diagnosis.recovery.commands[0].command).toBe('cdp perceive 1667E1A4');
    expect(diagnosis.recovery.commands.map(entry => entry.command)).toContain('cdp netlog 1667E1A4');
    expect(JSON.stringify(diagnosis)).not.toContain(FULL_ID);
  });

  it('T3/T4: network-failure still suggests netlog, with the prefix', () => {
    const diagnosis = T.createActionDiagnosis(actionResult({ failures: 1, entries: [] }));
    expect(diagnosis.kind).toBe('network-failure');
    expect(diagnosis.nextCommand).toBe('cdp netlog 1667E1A4');
    expect(JSON.stringify(diagnosis)).not.toContain(FULL_ID);
  });
});

// `readBack` overrides the layout viewport (innerWidth/innerHeight) and `screen` the emulated screen;
// both default to the size last set, as on a page with <meta viewport>.
function viewportCdp({ readBack = null, screen = null } = {}) {
  const calls = [];
  let current = { w: 1042, h: 632 };
  const cdp = {
    calls,
    get current() { return current; },
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Emulation.setDeviceMetricsOverride') {
        current = { w: params.width, h: params.height };
        return Promise.resolve({});
      }
      if (method === 'Emulation.clearDeviceMetricsOverride') {
        current = { w: 1042, h: 632 };
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('window.innerWidth')) {
          const dims = readBack ? readBack(current) : current;
          const shown = screen ? screen(current) : current;
          return Promise.resolve({ result: { value: JSON.stringify({ ...dims, sw: shown.w, sh: shown.h, dpr: 1 }) } });
        }
        if (expr.includes('document.title')) {
          return Promise.resolve({ result: { value: JSON.stringify({ title: 'Darkroom', url: 'http://127.0.0.1:7860/', contentType: 'text/html' }) } });
        }
        if (expr.includes('overflowX') || expr.includes('clippedControls')) {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                url: 'http://127.0.0.1:7860/',
                title: 'Darkroom',
                viewport: `${current.w}x${current.h}`,
                overflowX: false,
                controlCount: 0,
                controls: [],
                clippedControls: [],
                overlaps: [],
              }),
            },
          });
        }
        return Promise.resolve({ result: { value: '{}' } });
      }
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
      }
      return Promise.resolve({});
    },
    waitForEvent() {
      return { promise: Promise.resolve({}), cancel() {} };
    },
  };
  return cdp;
}

describe('#533 item 4: viewport reads the size back', () => {
  it('T5: prints the read-back size and DPR', async () => {
    const cdp = viewportCdp();
    const out = await T.viewportStr(cdp, 'sid', '1400x900');
    expect(out).toBe('Viewport: 1400x900 (DPR 1)');
  });

  it('T5: states both sizes when the emulated screen differs from the request', async () => {
    const size = { w: 1400, h: 880 };
    const cdp = viewportCdp({ readBack: () => size, screen: () => size });
    const out = await T.viewportStr(cdp, 'sid', '1400x900');
    expect(out).toBe('Viewport: 1400x880 (DPR 1); requested 1400x900');
  });

  it('T5: a page without <meta viewport> reports its layout width, not a mismatch (review B1)', async () => {
    // Live, Chrome 154 on about:blank: innerWidth=980 while screen.width=390 after `viewport 390x844`.
    const cdp = viewportCdp({ readBack: () => ({ w: 980, h: 2121 }) });
    const out = await T.viewportStr(cdp, 'sid', '390x844');
    expect(out).toBe('Viewport: 390x844 (DPR 1) (mobile mode); layout 980x2121');
    expect(out).not.toContain('requested');
  });

  it('T5: a desktop size whose screen stays the real one still reads as applied', async () => {
    // Live, headless Chrome 154: after `viewport 1400x900` (mobile:false) screen stays 800x600.
    const cdp = viewportCdp({ screen: () => ({ w: 800, h: 600 }) });
    const out = await T.viewportStr(cdp, 'sid', '1400x900');
    expect(out).toBe('Viewport: 1400x900 (DPR 1)');
  });

  it('T5: a desktop size equal to the real screen does not count as applied when the layout differs', async () => {
    // mobile:false does not emulate the screen, so a screen match proves nothing (pre-submit review).
    const cdp = viewportCdp({ readBack: () => ({ w: 1042, h: 632 }), screen: () => ({ w: 1920, h: 1080 }) });
    const out = await T.viewportStr(cdp, 'sid', '1920x1080');
    expect(out).toBe('Viewport: 1042x632 (DPR 1); requested 1920x1080');
  });

  it('records the override on the session for viewport, never for an audit sweep', async () => {
    const session = {};
    await T.viewportStr(viewportCdp(), 'sid', '1400x900', { session });
    expect(session.viewportOverride).toEqual({ width: 1400, height: 900 });
  });
});

describe('#533 item 5: responsive-audit restores and reports the viewport', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdp-533-'));
    T.resetScreenshotTier();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const sessionFor = () => T.createSessionState({
    targetId: FULL_ID,
    sessionId: 'sid',
    logPath: join(tmp, 'session.jsonl'),
    screenshotDir: join(tmp, 'shots'),
  });
  const audit = (cdp, session, extra = []) => T.responsiveAuditStr(
    cdp, 'sid', session, FULL_ID, new T.RingBuffer(8), new T.RingBuffer(8),
    ['--viewport', '1440x900', '--viewport', '390x844', ...extra],
  );

  it('T6/T7: with no session override it clears the override and says restored', async () => {
    const cdp = viewportCdp();
    const session = sessionFor();
    const out = await audit(cdp, session);
    // The sweep's sizes are not a user override: the next audit must still clear, not reapply 390x844.
    expect(session.viewportOverride).toBeUndefined();
    expect(cdp.calls.some(call => call.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true);
    const lastOverride = cdp.calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').at(-1);
    expect(`${lastOverride.params.width}x${lastOverride.params.height}`).toBe('390x844');
    expect(cdp.current).toEqual({ w: 1042, h: 632 });
    expect(out).toContain('Viewport restored to 1042x632');
  });

  it('T6: with a session override it reapplies that override', async () => {
    const cdp = viewportCdp();
    const session = sessionFor();
    await T.viewportStr(cdp, 'sid', '1400x900', { session });
    cdp.calls.length = 0;
    const out = await audit(cdp, session);
    expect(cdp.calls.some(call => call.method === 'Emulation.clearDeviceMetricsOverride')).toBe(false);
    const lastOverride = cdp.calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').at(-1);
    expect(`${lastOverride.params.width}x${lastOverride.params.height}`).toBe('1400x900');
    expect(out).toContain('Viewport restored to 1400x900');
  });

  it('T7: says left at WxH when the read-back differs from the original', async () => {
    let cleared = false;
    const cdp = viewportCdp({ readBack: current => (cleared ? { w: 390, h: 844 } : current) });
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params) => {
      if (method === 'Emulation.clearDeviceMetricsOverride') cleared = true;
      return send(method, params);
    };
    const out = await audit(cdp, sessionFor());
    expect(out).toContain('Viewport left at 390x844');
  });

  it('T7: the JSON model carries the restore result', async () => {
    const out = await audit(viewportCdp(), sessionFor(), ['--format', 'json']);
    const model = JSON.parse(out);
    expect(model.viewportRestore).toEqual({ status: 'restored', original: '1042x632', viewport: '1042x632' });
  });
});

describe('#533 item 6: the last CLI error line carries the Kind', () => {
  it('T8: hidden-tab keeps its kind under tail -1', () => {
    const err = Object.assign(new Error('Tab is hidden (document.visibilityState=hidden): no frame'), { code: 'hidden_tab' });
    const lines = T.formatCliError(err, { cmd: 'shot', targetPrefix: '1667E1A4' }).split('\n');
    expect(lines.at(-1)).toMatch(/^Next: CDP_BACKGROUND=0 cdp shot 1667E1A4 .*\(Kind: hidden-tab\)$/);
  });

  it('T8: unknown failures and the empty-message path end with Next and Kind', () => {
    expect(T.formatCliError(new Error('boom'), { cmd: 'eval', targetPrefix: '1667E1A4' }).split('\n').at(-1))
      .toMatch(/^Next: .*\(Kind: unknown\)$/);
    expect(T.formatCliError(new Error(''), {}).split('\n').at(-1)).toMatch(/^Next: .*\(Kind: unknown\)$/);
  });

  it('T8: a classified action failure passed through keeps Kind on its last line (review B2)', () => {
    const classified = 'Error: Did not reach document bottom\nKind: timeout\nNext: cdp status 1667E1A4';
    expect(T.formatCliError(new Error(classified), { cmd: 'scroll', targetPrefix: '1667E1A4' }).split('\n').at(-1))
      .toBe('Next: cdp status 1667E1A4 (Kind: timeout)');
  });

  it('T8: a halted text flow ends with the failed step\'s Next and Kind (pre-submit review)', async () => {
    const failure = T.formatActionFailure(new Error('Named control not found: "buy"'), {
      action: 'click',
      target: { targetId: FULL_ID, input: 'buy' },
    });
    const stepNext = failure.split('\n').find(line => line.startsWith('Next:'));
    const stepKind = failure.match(/^Kind: (\S+)/m)[1];
    const halted = await T.flowStr(
      { run: async () => ({ ok: false, error: failure }), settle: async () => '' },
      'click buy; summary',
      { throwOnFailure: true },
    ).then(() => null, e => e);
    expect(halted.message.split('\n').at(-1)).toBe('Flow halted at step 1/2');
    const out = T.formatCliError(halted, { cmd: 'flow', targetPrefix: '1667E1A4' });
    expect(out.split('\n').at(-1)).toBe(`${stepNext} (Kind: ${stepKind})`);
    expect(out).toContain('Flow halted at step 1/2');
  });

  it('T8: the Kind comes from the line nearest the last Next, not a Kind-looking line in the message', () => {
    const text = 'Error: server said\nKind: fake-from-page\nRecovery:\n  Kind: hidden-tab\n  Run: CDP_BACKGROUND=0 cdp shot 1667E1A4\nNext: CDP_BACKGROUND=0 cdp shot 1667E1A4';
    expect(T.formatCliError(new Error(text), { cmd: 'shot' }).split('\n').at(-1))
      .toBe('Next: CDP_BACKGROUND=0 cdp shot 1667E1A4 (Kind: hidden-tab)');
  });

  it('T8: repeat whose condition never matched ends with a fresh Next, not a stale iteration one (pre-submit review)', async () => {
    const failure = T.formatActionFailure(new Error('Named control not found: "x"'), {
      action: 'click',
      target: { targetId: FULL_ID, input: 'x' },
    });
    let call = 0;
    const err = await T.repeatStr({
      run: async () => (++call === 1 ? { ok: false, error: failure } : { ok: true, result: 'Clicked x' }),
      probeCondition: async () => ({ matched: false, description: 'text "done"' }),
    }, ['3', '--continue', '--until-text', 'done', 'click', 'x']).then(() => null, e => e);
    expect(err.message).toMatch(/repeat: condition not satisfied after 3 iterations$/);
    const out = T.formatCliError(err, { cmd: 'repeat', targetPrefix: '1667E1A4' });
    const last = out.split('\n').at(-1);
    expect(last).toMatch(/^Next: \S.* \(Kind: [a-z-]+\)$/);
    expect(last).not.toBe(failure.split('\n').find(line => line.startsWith('Next:')) + ` (Kind: ${failure.match(/^Kind: (\S+)/m)[1]})`);
  });

  it('T8: a repeat halted by its first failure repeats that failure\'s Next and Kind', async () => {
    const failure = T.formatActionFailure(new Error('Named control not found: "x"'), {
      action: 'click',
      target: { targetId: FULL_ID, input: 'x' },
    });
    const err = await T.repeatStr({ run: async () => ({ ok: false, error: failure }) }, ['2', 'click', 'x']).then(() => null, e => e);
    const out = T.formatCliError(err, { cmd: 'repeat', targetPrefix: '1667E1A4' });
    const stepNext = failure.split('\n').find(line => line.startsWith('Next:'));
    expect(out.split('\n').at(-1)).toBe(`${stepNext} (Kind: ${failure.match(/^Kind: (\S+)/m)[1]})`);
  });

  it('T8: a Next with no Kind above it still gets a Kind, never one from an earlier step\'s output', async () => {
    let step = 0;
    const halted = await T.flowStr({
      run: async () => (++step === 1
        ? { ok: true, result: 'Page summary\nKind: page' }
        : { ok: false, error: 'Error: boom\nNext: cdp status 1667E1A4' }),
      settle: async () => '',
    }, 'summary; click buy', { throwOnFailure: true }).then(() => null, e => e);
    const last = T.formatCliError(halted, { cmd: 'flow', targetPrefix: '1667E1A4' }).split('\n').at(-1);
    expect(last).toMatch(/^Next: cdp status 1667E1A4 \(Kind: [a-z-]+\)$/);
    expect(last).not.toContain('(Kind: page)');
  });

  it('T8: the fallback Kind classifies the failed block only, not an earlier step\'s output (pre-submit review)', async () => {
    let step = 0;
    const halted = await T.flowStr({
      run: async () => (++step === 1
        ? { ok: true, result: T.hiddenTabCaptureError().message }
        : { ok: false, error: 'Error: boom\nNext: cdp status 1667E1A4' }),
      settle: async () => '',
    }, 'summary; click buy', { throwOnFailure: true }).then(() => null, e => e);
    const last = T.formatCliError(halted, { cmd: 'flow', targetPrefix: '1667E1A4' }).split('\n').at(-1);
    expect(last).toBe('Next: cdp status 1667E1A4 (Kind: unknown)');
  });

  it('T8: a halted replay summary counts as a halt trailer', () => {
    const text = 'Replay: 1 action(s)\n[1/1] click x\n  ✗ Error: Named control not found\nKind: selector\nNext: cdp perceive 1667E1A4 -C -d 8\nReplay halted at step 1/1\nDone: 0 ok, 1 failed, 0 skipped';
    expect(T.formatCliError(new Error(text), { cmd: 'replay', targetPrefix: '1667E1A4' }).split('\n').at(-1))
      .toBe('Next: cdp perceive 1667E1A4 -C -d 8 (Kind: selector)');
  });

  describe('action failures with receipt lines after their Next (review B3)', () => {
    const failure = () => T.formatActionFailure(new Error('Named control not found: "Delete"'), {
      action: 'click',
      target: { targetId: FULL_ID, input: 'Delete' },
    });
    // runActionWithFeedback throws [formatActionFailure, ...downloadReceiptLines, ...actionDialogLines].
    for (const [label, receipts] of [
      ['an answered dialog (#460)', ['Dialog: confirm "Really delete?" → accept']],
      ['a saved download (#472)', ['Downloaded "report.csv" 1.2 KB sha256=abc → C:\\tmp\\report.csv']],
      ['a download-behaviour warning (#472)', ['Warning: could not set the browser\'s download behaviour back to default (boom); downloads may keep going to C:\\tmp without a prompt until this tab\'s daemon disconnects (`cdp stop <target>`).']],
    ]) {
      it(`keeps the failure's own Next and Kind last after ${label}`, () => {
        const text = failure();
        const stepNext = text.split('\n').find(line => line.startsWith('Next:'));
        const kind = text.match(/^Kind: (\S+)/m)[1];
        const out = T.formatCliError(new Error([text, ...receipts].join('\n')), { cmd: 'click', targetPrefix: '1667E1A4' });
        expect(out).toContain(receipts[0]);
        expect(out.split('\n').at(-1)).toBe(`${stepNext} (Kind: ${kind})`);
        expect(out).not.toContain('(Kind: unknown)');
      });
    }
  });

  it('T8: a fresh fallback Next is classified from the lines after the stale Next, not a stale iteration', async () => {
    let call = 0;
    const err = await T.repeatStr({
      run: async () => (++call === 1
        ? { ok: false, error: `${T.hiddenTabCaptureError().message}\nNext: CDP_BACKGROUND=0 cdp shot 1667E1A4` }
        : { ok: true, result: 'Clicked x' }),
      probeCondition: async () => ({ matched: false, description: 'text "done"' }),
    }, ['3', '--continue', '--until-text', 'done', 'click', 'x']).then(() => null, e => e);
    const last = T.formatCliError(err, { cmd: 'repeat', targetPrefix: '1667E1A4' }).split('\n').at(-1);
    expect(last).toMatch(/^Next: \S.* \(Kind: [a-z-]+\)$/);
    expect(last).not.toContain('hidden-tab');
  });

  it('T8: a classified failure without a Next line gets one', () => {
    // Defensive: no producer emits this today. The appended Next and its Kind come from one recovery,
    // so the command and the Kind never disagree; the message's own Kind stays on its line.
    const message = 'Error: Element not found\nKind: not-found';
    const out = T.formatCliError(new Error(message), { cmd: 'click', targetPrefix: '1667E1A4' });
    const recovery = T.buildCliErrorRecovery(message, { cmd: 'click', targetPrefix: '1667E1A4' });
    expect(out.split('\n')).toEqual(['Error: Element not found', 'Kind: not-found', `Next: ${recovery.run} (Kind: ${recovery.kind})`]);
  });
});

describe('#533 item 8: troubleshooting covers background-tab limits', () => {
  it('T9: names decode(), requestAnimationFrame, timer throttling, and the fire-and-forget pattern', () => {
    const doc = readFileSync(new URL('../skills/chrome-cdp-ex/references/troubleshooting.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/HTMLImageElement\.decode\(\)/);
    expect(doc).toMatch(/requestAnimationFrame/);
    expect(doc).toMatch(/throttl/i);
    expect(doc).toMatch(/cdp eval <target> --fire-and-forget/);
  });
});
