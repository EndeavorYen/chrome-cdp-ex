import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNetlogRequestStore, parseNetlogArgs } from '../skills/chrome-cdp-ex/scripts/lib/netlog.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const SECRET = 'super-secret-token';
const tempDirs = [];

function runtimeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-observe-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionAt(dir, targetId) {
  const session = T.createSessionState({
    targetId,
    sessionId: `sid-${targetId}`,
    logPath: join(dir, `cdp-${targetId}.log`),
  });
  session.runtimeDir = dir;
  return session;
}

function observePath(dir, targetId) {
  const safeTarget = String(targetId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(dir, `cdp-${safeTarget}.observe.json`);
}

function attachNetlog(session) {
  const netReqBuf = new T.RingBuffer(100);
  const store = createNetlogRequestStore({ shouldTrack: T.shouldTrackActionNetworkRequest });
  session.buffers = {
    ...(session.buffers || {}),
    network: netReqBuf,
    navigation: session.buffers?.navigation || new T.RingBuffer(10),
  };
  session.netRequestStore = store;
  return { netReqBuf, store };
}

function captureFailingRequest(session) {
  const { netReqBuf, store } = attachNetlog(session);
  const observer = T.createDaemonNetworkObserver({
    pendingReqs: new Map(),
    netReqBuf,
    networkStatusByRequest: T.createEarlyResponseStatusStore(),
    now: () => 1_700_000_000_000,
    session,
  });
  const fire = (event, params) => {
    store.handlers[event]?.(params);
    observer[event]?.(params);
  };
  fire('Network.requestWillBeSent', {
    requestId: 'r1',
    type: 'XHR',
    request: {
      method: 'POST',
      url: `https://app.example/api/items?token=${SECRET}`,
      headers: { Authorization: `Bearer ${SECRET}` },
    },
  });
  fire('Network.responseReceived', {
    requestId: 'r1',
    type: 'XHR',
    response: { status: 404, statusText: 'Not Found', mimeType: 'application/json', headers: {}, encodedDataLength: 12 },
  });
  fire('Network.loadingFinished', { requestId: 'r1', timestamp: 1, encodedDataLength: 12 });
  return { netReqBuf, store };
}

function restartedSession(dir, targetId) {
  const next = sessionAt(dir, targetId);
  attachNetlog(next);
  T.initializeSessionLog(next);
  return next;
}

function netlogText(session) {
  return T.netlogStr(session.buffers.network, null, {
    filters: parseNetlogArgs(['--status', '4xx']),
    lastNavigationTs: Date.now(),
    holdRestored: session.restoredNetlogHold === true,
    observationUnreadable: session.observationRestore?.status === 'unreadable',
    requestStore: session.netRequestStore,
    targetId: session.targetId,
    session,
  });
}

function reloadAction() {
  return T.createActionResult({
    action: 'reload',
    target: { input: 'reload', resolvedBy: 'page', label: 'reload', commandArgs: [] },
    dispatch: { ok: true, method: 'reload' },
    settle: { ok: true, durationMs: 10 },
    effects: { domDiff: '', console: [], network: [], navigation: null },
    nextHint: null,
  });
}

function fakeCdp() {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: [] });
      if (method === 'Target.closeTarget') return Promise.resolve({ success: true });
      return Promise.resolve({});
    },
  };
}

describe('#606 netlog survives a tab daemon restart', () => {
  it('keeps the last action requests, redacted, for netlog --status 4xx', async () => {
    const dir = runtimeDir();
    const targetId = 'T606TARGET';
    const first = sessionAt(dir, targetId);
    const captured = captureFailingRequest(first);
    const live = T.netlogStr(captured.netReqBuf, null, {
      filters: parseNetlogArgs(['--status', '4xx']),
      requestStore: captured.store,
      targetId,
    });
    expect(live).toContain('#1');
    expect(live).toContain('404');

    const next = restartedSession(dir, targetId);
    const list = netlogText(next);
    expect(list).toContain('#1');
    expect(list).toContain('404');
    expect(list).not.toContain(SECRET);
    expect(list).not.toContain('No network requests captured');

    const savedPath = observePath(dir, targetId);
    const savedText = readFileSync(savedPath, 'utf8');
    expect(savedText).not.toContain(SECRET);
    if (process.platform !== 'win32') {
      expect(statSync(savedPath).mode & 0o777).toBe(0o600);
    }
    const notice = T.formatDaemonRestartNotice({
      dialog: 'accept',
      throttleProfile: 'off',
      mockCount: 0,
      netlogCount: next.observationRestore?.netlogCount,
      actionCount: next.observationRestore?.actionCount,
    });
    expect(notice).toContain('1 netlog entry restored');

    const detailCdp = fakeCdp();
    const detail = await T.netlogRequestStr(
      detailCdp,
      'sid-next',
      next.netRequestStore,
      parseNetlogArgs(['--id', '1', '--body']),
      { targetId },
    );
    expect(detail).toContain('Restored after the tab daemon restarted');
    expect(detail).toContain('no longer holds the response body');
    expect(detailCdp.calls).toEqual([]);

    const continued = createNetlogRequestStore({ shouldTrack: T.shouldTrackActionNetworkRequest });
    continued.restore(next.netRequestStore.get(1) ? [next.netRequestStore.get(1)] : [], next.netRequestStore.nextId);
    continued.handlers['Network.requestWillBeSent']({
      requestId: 'r2',
      type: 'XHR',
      request: { method: 'GET', url: 'https://app.example/api/next', headers: {} },
    });
    expect(continued.get(2)?.url).toBe('https://app.example/api/next');
    expect(continued.get(1)?.status).toBe(404);
  });

  it('persists netlog --clear so a later daemon does not bring the rows back', () => {
    const dir = runtimeDir();
    const targetId = 'T606CLEAR';
    const first = sessionAt(dir, targetId);
    const { netReqBuf, store } = captureFailingRequest(first);
    expect(T.netlogStr(netReqBuf, '--clear', { requestStore: store, session: first })).toBe('Network log cleared');
    const saved = JSON.parse(readFileSync(observePath(dir, targetId), 'utf8'));
    expect(saved.netlog.entries).toEqual([]);
  });
});

describe('#618 record-actions survives a tab daemon exit', () => {
  it('restores the action log and environment steps after the process is gone', () => {
    const dir = runtimeDir();
    const targetId = 'T618TARGET';
    const first = sessionAt(dir, targetId);
    T.appendSessionEnvironmentLog(first, {
      kind: 'mock',
      action: 'add',
      rule: {
        urlPattern: '**/api/*',
        status: 503,
        body: '{"ok":false}',
        contentType: 'application/json',
      },
    });
    T.appendSessionActionLog(first, reloadAction());

    const next = restartedSession(dir, targetId);
    const model = T.buildRecordActionsModel(next);
    expect(model.actionCount).toBe(1);
    expect(model.actions[0].action).toBe('reload');
    expect(model.environmentCount).toBe(1);
    const text = T.formatRecordActions(next);
    expect(text).not.toContain('No actions recorded yet');
    expect(text).toContain('restored after the tab daemon exited');
    expect(text).toContain('reload');
  });

  it('says the saved logs could not be read instead of looking empty', () => {
    const dir = runtimeDir();
    const targetId = 'T618BAD';
    writeFileSync(observePath(dir, targetId), '{not json');
    const next = restartedSession(dir, targetId);
    const text = T.formatRecordActions(next);
    expect(text).toContain('could not be read');
    expect(text).not.toContain('No actions recorded yet');
    expect(T.buildRecordActionsModel(next).unavailable.reason).toBe('saved-action-log-unreadable');
    const list = netlogText(next);
    expect(list).toContain('could not be read');
    expect(list).not.toContain('No network requests captured');
  });

  it('keeps at most 64 observation files and drops the oldest', () => {
    const dir = runtimeDir();
    for (let i = 0; i < 70; i++) {
      const targetId = `CAP${String(i).padStart(4, '0')}`;
      const session = sessionAt(dir, targetId);
      T.appendSessionActionLog(session, reloadAction());
    }
    const names = readdirSync(dir).filter(name => name.endsWith('.observe.json'));
    expect(names.length).toBeLessThanOrEqual(64);
    expect(names).toContain('cdp-CAP0069.observe.json');
    expect(names).not.toContain('cdp-CAP0000.observe.json');
  });

  it('closetab removes the saved observation file', async () => {
    const dir = runtimeDir();
    const targetId = 'T618CLOSE';
    const session = sessionAt(dir, targetId);
    T.appendSessionActionLog(session, reloadAction());
    const path = observePath(dir, targetId);
    expect(existsSync(path)).toBe(true);
    await T.closetabStr(fakeCdp(), targetId, { runtimeDir: dir, force: true });
    expect(existsSync(path)).toBe(false);
  });

  it('says when the action log could not be saved', () => {
    const dir = runtimeDir();
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const session = sessionAt(blocker, 'T618SAVE');
    expect(() => T.appendSessionActionLog(session, reloadAction())).not.toThrow();
    expect(T.formatRecordActions(session)).toContain('could not be saved');
  });
});
