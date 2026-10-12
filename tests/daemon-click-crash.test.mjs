import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { requestDaemon } = await import('../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs');

// Fake page session for an @ref click. `settle` answers the scroll-settled rect call; the
// no-scroll fallback answers `fallbackRect`; `mouse` answers Input.dispatchMouseEvent.
function refClickCdp({ settle, fallbackRect = null, mouse = () => Promise.resolve({}) } = {}) {
  const calls = [];
  return {
    calls,
    onEvent() { return () => {}; },
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: null } });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'root-frame' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'button-object' } });
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('scrollIntoView')) return settle();
        if (fn.includes('getBoundingClientRect')) return Promise.resolve({ result: { value: fallbackRect } });
        return Promise.resolve({ result: { value: true } });
      }
      if (method === 'Input.dispatchMouseEvent') return mouse(params);
      return Promise.resolve({});
    },
  };
}

const unhandled = [];
const recordUnhandled = reason => unhandled.push(reason);
beforeAll(() => { process.on('unhandledRejection', recordUnhandled); });
afterAll(() => { process.off('unhandledRejection', recordUnhandled); });
afterEach(() => { unhandled.length = 0; });

describe('#464 a slow scroll settle no longer turns into a NaN click point', () => {
  it('unwraps the no-scroll fallback rect when the settled rect call times out', async () => {
    const cdp = refClickCdp({
      settle: () => Promise.reject(new Error('Timeout: Runtime.callFunctionOn')),
      fallbackRect: { x: 40, y: 300, w: 120, h: 32, tag: 'BUTTON', text: 'Smooth target' },
    });
    const rect = await T.resolveRef(cdp, 'sid', new Map([[15, 99]]), '@15', {}, { hitTest: true });
    expect(rect).toMatchObject({ x: 40, y: 300, w: 120, h: 32, tag: 'BUTTON', connected: true, settled: false });
    expect(Number.isFinite(rect.x + rect.w / 2)).toBe(true);
  });

  it('hit-tests the fallback point so a covered target still fails as covered', async () => {
    const hit = { covered: true, x: 100, y: 316, by: '<DIV.toast>', byPosition: 'fixed' };
    const cdp = refClickCdp({
      settle: () => Promise.reject(new Error('Timeout: Runtime.callFunctionOn')),
      fallbackRect: { x: 40, y: 300, w: 120, h: 32, tag: 'BUTTON', text: 'Smooth target' },
    });
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params = {}) => (method === 'Runtime.callFunctionOn'
      && String(params.functionDeclaration || '').includes('hit: clickPointHit(this, { x: box.x')
      ? Promise.resolve({ result: { value: { hit, disabled: '' } } })
      : send(method, params));
    const rect = await T.resolveRef(cdp, 'sid', new Map([[15, 99]]), '@15', {}, { hitTest: true });
    expect(rect.hit).toEqual(hit);
    const err = await T.clickStr(cdp, 'sid', '@15', new Map([[15, 99]]), {}).catch(e => e);
    expect(err.message).toMatch(/is covered by (position:fixed )?<DIV\.toast>/);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('keeps the page settle budget inside the CDP timeout and scrolls instantly', () => {
    const source = T.scrollSettledRectFunctionDeclaration({ hitTest: true });
    expect(T.REF_SETTLE_BUDGET_MS).toBeLessThan(T.REF_RESOLVE_TIMEOUT);
    expect(source).toContain(`Date.now() + ${T.REF_SETTLE_BUDGET_MS}`);
    expect(source).not.toMatch(/Date\.now\(\) \+ 1800/);
    // A page-level `scroll-behavior: smooth` must not make the click wait for an animation.
    const scrolls = source.match(/scrollIntoView\(\{[^}]*\}\)/g);
    expect(scrolls.length).toBeGreaterThan(0);
    expect(scrolls.every(call => call.includes("behavior: 'instant'"))).toBe(true);
  });
});

describe('#464 dispatchClick never crashes the daemon', () => {
  it('refuses a non-finite click point with a clear error and sends no mouse event', async () => {
    const cdp = refClickCdp({ settle: () => Promise.resolve({}) });
    const err = await T.dispatchClick(cdp, 'sid', Number.NaN, 120).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not a finite viewport coordinate \(x=NaN, y=120\)/);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('a mouse event that rejects while the click sleeps is reported, not left unhandled', async () => {
    const cdp = refClickCdp({
      settle: () => Promise.resolve({}),
      mouse: params => (params.type === 'mouseMoved'
        ? Promise.reject(new Error('Input.dispatchMouseEvent: boom'))
        : Promise.resolve({})),
    });
    const err = await T.dispatchClick(cdp, 'sid', 10, 10).catch(e => e);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('boom');
    expect(unhandled).toEqual([]);
  });

  it('handledLater keeps the rejection for the later await', async () => {
    const promise = T.handledLater(Promise.reject(new Error('later')));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
    await expect(promise).rejects.toThrow('later');
  });
});

describe('#464 a crashed daemon says why', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('records a bounded crash report and reads it back only when it is newer than the request', () => {
    dir = mkdtempSync(join(tmpdir(), 'cdp-464-'));
    const error = new Error('params.x: must contain JSON-compatible data');
    T.recordDaemonCrash('ABCDEF', 'unhandledRejection', error, { runtimeDir: dir, now: () => 5000, pid: 42 });
    const record = JSON.parse(readFileSync(T.daemonCrashReportPath('ABCDEF', dir), 'utf8'));
    expect(record).toMatchObject({ schema: 'chrome-cdp-ex.daemon-crash.v1', ts: 5000, pid: 42, kind: 'unhandledRejection' });
    expect(record.stack.length).toBeLessThanOrEqual(2000);
    const secret = T.recordDaemonCrash('ABCDEF', 'uncaughtException', new Error('fetch failed for ?token=hunter2-secret'),
      { runtimeDir: dir, now: () => 5001, pid: 42 });
    expect(JSON.stringify(secret)).not.toContain('hunter2-secret');
    T.recordDaemonCrash('ABCDEF', 'unhandledRejection', error, { runtimeDir: dir, now: () => 5000, pid: 42 });
    expect(T.readDaemonCrashReport('ABCDEF', { runtimeDir: dir, sinceMs: 4000 }))
      .toBe('unhandledRejection: params.x: must contain JSON-compatible data');
    expect(T.readDaemonCrashReport('ABCDEF', { runtimeDir: dir, sinceMs: 6000 })).toBeNull();
    expect(T.readDaemonCrashReport('NOPE', { runtimeDir: dir })).toBeNull();
  });

  it('the recorder writes the report and exits 1 on an unhandled rejection', () => {
    const fakeProcess = new EventEmitter();
    const exits = [];
    const records = [];
    fakeProcess.exit = code => exits.push(code);
    fakeProcess.stderr = { write() {} };
    T.installDaemonCrashRecorder('ABCDEF', {
      processRef: fakeProcess,
      record: (targetId, kind, error) => records.push({ targetId, kind, message: error.message }),
    });
    fakeProcess.emit('unhandledRejection', new Error('boom'));
    expect(records).toEqual([{ targetId: 'ABCDEF', kind: 'unhandledRejection', message: 'boom' }]);
    expect(exits).toEqual([1]);
  });

  it('the client names the crash in "Connection closed before response"', async () => {
    const conn = new EventEmitter();
    conn.write = () => true;
    conn.destroy = () => {};
    conn.setNoDelay = () => {};
    const pending = requestDaemon(conn, { cmd: 'click', args: ['@15'] }, {
      runtimeDir: '/tmp/rt',
      mayHaveSideEffects: true,
      crashReport: () => 'unhandledRejection: params.x: must contain JSON-compatible data',
    }).catch(e => e);
    conn.emit('end');
    const err = await pending;
    const text = `${err.message} ${err.transportCause?.message || ''}`;
    expect(text).toContain('the daemon for this tab crashed (unhandledRejection: params.x: must contain JSON-compatible data)');
  });
});
