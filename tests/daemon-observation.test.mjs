import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { argsRequireConfirm } from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';
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

describe('#744 record-actions --clear starts a fresh log', () => {
  function seedObservedSession(dir, targetId) {
    const session = sessionAt(dir, targetId);
    captureFailingRequest(session);
    T.appendSessionEnvironmentLog(session, {
      kind: 'mock',
      action: 'add',
      rule: { urlPattern: '**/api/*', status: 503, body: '{"ok":false}', contentType: 'application/json' },
    });
    T.appendSessionEnvironmentLog(session, {
      kind: 'throttle',
      action: 'apply',
      throttle: { profile: 'offline', offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
    });
    T.appendSessionEnvironmentLog(session, {
      kind: 'clock',
      action: 'set',
      clock: { profile: 'freeze', atMs: 1, offsetMs: 0 },
    });
    T.appendSessionActionLog(session, reloadAction());
    T.appendSessionActionLog(session, reloadAction());
    session.dialogMode = 'accept';
    session.networkThrottle = { profile: 'offline' };
    session.networkMocks = [{ urlPattern: '**/api/*', status: 503 }];
    return session;
  }

  it('empties actions and environment steps in memory and on disk and keeps netlog', () => {
    const dir = runtimeDir();
    const targetId = 'T744CLR1';
    const session = seedObservedSession(dir, targetId);
    const text = T.clearRecordedActions(session);
    expect(text).toBe('Cleared action log (2 actions, 3 environment steps). Next: cdp record-actions T744CLR1');
    expect(session.actionLog).toEqual([]);
    expect(session.environmentLog).toEqual([]);
    expect(session.actionSeq).toBe(0);
    expect(session.dialogMode).toBe('accept');
    expect(session.networkThrottle).toEqual({ profile: 'offline' });
    expect(session.networkMocks).toEqual([{ urlPattern: '**/api/*', status: 503 }]);

    const saved = JSON.parse(readFileSync(observePath(dir, targetId), 'utf8'));
    expect(saved.actions).toEqual([]);
    expect(saved.environment).toEqual([]);
    expect(saved.actionSeq).toBe(0);
    expect(saved.netlog.entries.length).toBeGreaterThan(0);
    expect(saved.netlog.entries[0].status).toBe(404);

    const next = restartedSession(dir, targetId);
    expect(next.observationRestore.actionCount).toBe(0);
    expect(next.observationRestore.environmentCount).toBe(0);
    expect(T.formatDaemonRestartNotice({
      dialog: 'dismiss',
      throttleProfile: 'off',
      mockCount: 0,
      netlogCount: next.observationRestore.netlogCount,
      actionCount: next.observationRestore.actionCount,
    })).toContain('0 actions restored');
    expect(netlogText(next)).toContain('#1');
    expect(netlogText(next)).toContain('404');
    expect(T.buildRecordActionsModel(next).actionCount).toBe(0);
  });

  it('records only actions that happen after the clear', () => {
    const dir = runtimeDir();
    const targetId = 'T744NEXT';
    const session = seedObservedSession(dir, targetId);
    T.clearRecordedActions(session);
    T.appendSessionActionLog(session, reloadAction());
    T.appendSessionActionLog(session, reloadAction());
    T.appendSessionActionLog(session, reloadAction());
    expect(T.buildRecordActionsModel(session).actionCount).toBe(3);
    expect(T.buildRecordActionsModel(session).environmentCount).toBe(0);

    const next = restartedSession(dir, targetId);
    const model = T.buildRecordActionsModel(next);
    expect(model.actionCount).toBe(3);
    expect(model.environmentCount).toBe(0);
    expect(model.actions.map(entry => entry.action)).toEqual(['reload', 'reload', 'reload']);
    const text = T.formatRecordActions(next);
    expect(text).toContain('Recorded actions: 3');
    expect(text).not.toContain('Environment controls');
  });

  it('is a successful no-op when nothing was saved and no daemon loaded a log', () => {
    const dir = runtimeDir();
    const targetId = 'T744NONE';
    const session = sessionAt(dir, targetId);
    expect(T.clearRecordedActions(session)).toBe(
      'Cleared action log (0 actions, 0 environment steps). Next: cdp record-actions T744NONE',
    );
    expect(existsSync(observePath(dir, targetId))).toBe(false);
    const next = restartedSession(dir, targetId);
    expect(next.observationRestore.actionCount).toBe(0);
    expect(next.observationRestore.status).toBe('absent');
  });

  it('prints a versioned JSON receipt for --clear --format json', () => {
    const dir = runtimeDir();
    const targetId = 'T744JSON';
    const session = seedObservedSession(dir, targetId);
    const parsed = JSON.parse(T.clearRecordedActions(session, { format: 'json' }));
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.record-actions-clear.v1',
      targetId,
      cleared: { actions: 2, environment: 3 },
      next: 'cdp record-actions T744JSON',
    });
    expect(parsed.message).toBe('Cleared action log (2 actions, 3 environment steps).');
    expect(JSON.parse(readFileSync(observePath(dir, targetId), 'utf8')).actions).toEqual([]);
  });

  it('rejects --clear combined with an extra argument as Kind: usage with one Next', () => {
    expect(T.parseRecordActionsArgs(['--clear', '--format', 'json'])).toEqual({ clear: true, format: 'json' });
    expect(T.parseRecordActionsArgs(['--format', 'json'])).toEqual({ clear: false, format: 'json' });
    let error;
    try {
      T.parseRecordActionsArgs(['--clear', '--out', 'actions.json']);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/unknown argument/);
    const text = T.formatCliError(error, { cmd: 'record-actions', targetPrefix: 'T744JSON' });
    expect(text).toContain('Kind: usage');
    expect(text.match(/^Next:/gm)).toHaveLength(1);
    expect(text).toContain('Next: cdp help record-actions');
  });

  it('documents --clear in help and treats it like netlog --clear for policy', () => {
    const help = T.helpTopicStr('record-actions');
    expect(help).toContain('--clear');
    expect(help).toMatch(/stop, an idle exit, a crash, and kill -9 keep the action log/);
    expect(help).toMatch(/closetab removes the saved file/);
    expect(help).toMatch(/record-actions <target> --clear/);
    expect(COMMAND_SURFACE.resolve('record-actions')).toMatchObject({
      kind: 'conditional-mutation',
      authorization: 'conditional',
      mutates: false,
    });
    expect(argsRequireConfirm('record-actions', [])).toBe(false);
    expect(argsRequireConfirm('record-actions', ['--format', 'json'])).toBe(false);
    expect(argsRequireConfirm('record-actions', ['--clear'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('record-actions', [])).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('record-actions', ['--format', 'json'])).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('record-actions', ['--clear'])).toBe(true);
    expect(T.daemonRequestMayHaveSideEffects({ cmd: 'record-actions', args: [] }))
      .toBe(T.daemonRequestMayHaveSideEffects({ cmd: 'netlog', args: [] }));
    expect(T.daemonRequestMayHaveSideEffects({ cmd: 'record-actions', args: ['--clear'] }))
      .toBe(T.daemonRequestMayHaveSideEffects({ cmd: 'netlog', args: ['--clear'] }));
  });

  it('clears a saved file when no daemon has loaded it', () => {
    const dir = runtimeDir();
    const targetId = 'T744DISK';
    const first = seedObservedSession(dir, targetId);
    expect(T.buildRecordActionsModel(first).actionCount).toBe(2);
    const idle = sessionAt(dir, targetId);
    const text = T.clearRecordedActions(idle);
    expect(text).toBe('Cleared action log (2 actions, 3 environment steps). Next: cdp record-actions T744DISK');
    const saved = JSON.parse(readFileSync(observePath(dir, targetId), 'utf8'));
    expect(saved.actions).toEqual([]);
    expect(saved.environment).toEqual([]);
    expect(saved.netlog.entries.length).toBeGreaterThan(0);
    const next = restartedSession(dir, targetId);
    expect(next.observationRestore.actionCount).toBe(0);
    expect(netlogText(next)).toContain('404');
  });
});
