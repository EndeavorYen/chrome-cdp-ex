import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const tempDirs = [];
function runtimeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-575-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionAt(dir, targetId = 'T575TARGET') {
  const session = T.createSessionState({
    targetId,
    sessionId: 'sid-575',
    logPath: join(dir, `cdp-${targetId}.log`),
  });
  session.runtimeDir = dir;
  return session;
}

function fakeCdp({ fail = [] } = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (fail.includes(method)) return Promise.reject(new Error(`${method} failed`));
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: [] });
      if (method === 'Target.closeTarget') return Promise.resolve({ success: true });
      return Promise.resolve({});
    },
  };
}

const DISMISS_OFFLINE_NOTICE = 'daemon restarted: dialog=dismiss, throttle=offline, 2 mocks restored, 0 netlog entries restored, 0 actions restored';

describe('#575 tab daemon restart restores dialog, throttle, and mocks', () => {
  it('T1-T3: dismiss, offline, and two mock rules survive a new session', async () => {
    const dir = runtimeDir();
    const first = sessionAt(dir);
    const dialogRef = { value: true };
    const cdp = fakeCdp();

    T.setDialogMode(new T.RingBuffer(4), dialogRef, first, 'dismiss');
    await T.throttleStr(cdp, 'sid-575', first, ['offline']);
    await T.mockStr(cdp, 'sid-575', first, ['add', '**/api/a*', '--status', '503', '--body', 'nope', '--method', 'POST']);
    await T.mockStr(cdp, 'sid-575', first, ['add', '**/api/b*', '--status', '201', '--body', 'ok', '--content-type', 'application/json']);

    const saved = T.readTabEnvironment(first.targetId, { runtimeDir: dir });
    expect(saved.status).toBe('ok');
    expect(saved.dialog).toBe('dismiss');
    expect(saved.throttle).toMatchObject({ profile: 'offline', offline: true });
    expect(saved.mocks.map(rule => ({
      urlPattern: rule.urlPattern,
      method: rule.method,
      status: rule.status,
      body: rule.body,
      contentType: rule.contentType,
    }))).toEqual([
      { urlPattern: '**/api/a*', method: 'POST', status: 503, body: 'nope', contentType: 'text/plain; charset=utf-8' },
      { urlPattern: '**/api/b*', method: null, status: 201, body: 'ok', contentType: 'application/json' },
    ]);
    if (process.platform !== 'win32') {
      expect(statSync(T.tabEnvPath(first.targetId, dir)).mode & 0o777).toBe(0o600);
    }

    const next = sessionAt(dir);
    const nextRef = { value: true };
    const nextCdp = fakeCdp();
    const outcome = await T.applySavedTabEnvironment(nextCdp, 'sid-next', next, nextRef, { runtimeDir: dir });

    expect(nextRef.value).toBe(false);
    expect(next.dialogMode).toBe('dismiss');
    expect(T.dialogStr(new T.RingBuffer(4), nextRef)).toContain('Auto-accept: OFF');
    expect(next.networkThrottle).toMatchObject({ profile: 'offline', offline: true });
    expect(T.formatThrottleText(T.throttleModel(next, { mode: 'status' }))).toContain('Network throttle: offline');
    expect(next.networkMocks).toHaveLength(2);
    expect(next.networkMockHits).toEqual([]);
    expect(nextCdp.calls.map(call => call.method)).toEqual([
      'Network.enable',
      'Network.emulateNetworkConditions',
      'Fetch.enable',
    ]);
    expect(nextCdp.calls[1].params).toMatchObject({ offline: true, downloadThroughput: 0, uploadThroughput: 0 });
    expect(nextCdp.calls[2].params.patterns).toEqual([
      { urlPattern: '**/api/a*', requestStage: 'Request' },
      { urlPattern: '**/api/b*', requestStage: 'Request' },
    ]);
    expect(outcome).toMatchObject({
      dialog: 'dismiss',
      throttleProfile: 'offline',
      throttleReset: false,
      mockCount: 2,
      mocksReset: false,
      unreadable: false,
    });

    const handled = await T.handleOpeningJavaScriptDialog(nextCdp, 'sid-next', {
      type: 'confirm',
      message: 'delete?',
    }, { sessionId: 'sid-next' }, { accept: nextRef.value, dialogBuf: new T.RingBuffer(4), retries: 1 });
    expect(handled.ok).toBe(true);
    expect(nextCdp.calls.at(-1)).toMatchObject({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
    });
  });

  it('T2: a custom throttle profile is re-applied with its CDP parameters', async () => {
    const dir = runtimeDir();
    const first = sessionAt(dir);
    await T.throttleStr(fakeCdp(), 'sid-575', first, ['custom', '--latency', '120', '--download', '256', '--upload', '128']);
    const next = sessionAt(dir);
    const nextRef = { value: true };
    const nextCdp = fakeCdp();
    const outcome = await T.applySavedTabEnvironment(nextCdp, 'sid-next', next, nextRef, { runtimeDir: dir });
    expect(outcome.throttleProfile).toBe('custom');
    expect(next.networkThrottle).toMatchObject({ profile: 'custom', latencyMs: 120, downloadKbps: 256, uploadKbps: 128 });
    expect(nextCdp.calls[1].params).toMatchObject({
      offline: false,
      latency: 120,
      downloadThroughput: 32000,
      uploadThroughput: 16000,
    });
  });

  it('T4: the first user-visible result names the restart once; probes do not consume it', () => {
    const session = T.createSessionState({ targetId: 'T575', sessionId: 'sid' });
    const notice = T.armDaemonRestartNotice(session, {
      dialog: 'dismiss',
      throttleProfile: 'offline',
      throttleReset: false,
      mockCount: 2,
      mocksReset: false,
      unreadable: false,
    }, { restarted: true });
    expect(notice).toBe(DISMISS_OFFLINE_NOTICE);

    const meta = T.applyDaemonRestartNotice(session, 'meta', { ok: true, result: '{"pid":1}' });
    expect(meta.result).toBe('{"pid":1}');
    expect(meta.restartNotice).toBeUndefined();
    expect(session.restartNotice).toBe(notice);

    const listed = T.applyDaemonRestartNotice(session, 'list_raw', { ok: true, result: '[]' });
    expect(listed.restartNotice).toBeUndefined();
    const activated = T.applyDaemonRestartNotice(session, '_activate', { ok: true, result: '{"activated":false}' });
    expect(activated.restartNotice).toBeUndefined();

    const first = T.applyDaemonRestartNotice(session, 'eval', { ok: true, result: '2' });
    expect(first.restartNotice).toBe(notice);
    expect(first.result).toBe(`${notice}\n2`);
    expect(session.restartNotice).toBeNull();

    const second = T.applyDaemonRestartNotice(session, 'dialog', { ok: true, result: 'Auto-accept: OFF' });
    expect(second.restartNotice).toBeUndefined();
    expect(second.result).toBe('Auto-accept: OFF');
  });

  it('T4: a JSON result stays valid and the notice is a separate field', () => {
    const session = T.createSessionState({ targetId: 'T575', sessionId: 'sid' });
    T.armDaemonRestartNotice(session, {
      dialog: 'dismiss',
      throttleProfile: 'offline',
      mockCount: 2,
      mocksReset: false,
      unreadable: false,
    }, { restarted: true });
    const body = '{"schema":"chrome-cdp-ex.throttle.v1","profile":"offline"}';
    const response = T.applyDaemonRestartNotice(session, 'throttle', { ok: true, result: body });
    expect(response.result).toBe(body);
    expect(response.restartNotice).toBe(DISMISS_OFFLINE_NOTICE);

    const lines = [];
    const process = { exitCode: undefined };
    T.emitTargetCommandResponse(response, {
      cmd: 'throttle',
      format: 'json',
      console: {
        log: (...parts) => lines.push(parts.join(' ')),
        error: () => {},
      },
      process,
    });
    expect(lines[0]).toBe(DISMISS_OFFLINE_NOTICE);
    expect(JSON.parse(lines[1]).profile).toBe('offline');
    expect(process.exitCode).toBeUndefined();
  });

  it('T5: a failed mock re-apply is named and dismiss stays off', async () => {
    const dir = runtimeDir();
    const first = sessionAt(dir);
    const dialogRef = { value: true };
    T.setDialogMode(new T.RingBuffer(4), dialogRef, first, 'dismiss');
    await T.throttleStr(fakeCdp(), 'sid-575', first, ['offline']);
    await T.mockStr(fakeCdp(), 'sid-575', first, ['add', '**/api/a*', '--status', '500', '--body', 'a']);
    await T.mockStr(fakeCdp(), 'sid-575', first, ['add', '**/api/b*', '--status', '500', '--body', 'b']);

    const next = sessionAt(dir);
    const nextRef = { value: true };
    const outcome = await T.applySavedTabEnvironment(fakeCdp({ fail: ['Fetch.enable'] }), 'sid-next', next, nextRef, { runtimeDir: dir });
    expect(nextRef.value).toBe(false);
    expect(next.dialogMode).toBe('dismiss');
    expect(next.networkMocks).toEqual([]);
    expect(next.networkThrottle).toMatchObject({ profile: 'offline' });
    expect(outcome.mocksReset).toBe(true);
    expect(outcome.mockCount).toBe(2);
    const notice = T.formatDaemonRestartNotice(outcome);
    expect(notice).toBe('daemon restarted: dialog=dismiss, throttle=offline, 2 mocks were reset, 0 netlog entries restored, 0 actions restored');
  });

  it('T6: an unreadable record forces dismiss and says so', async () => {
    const dir = runtimeDir();
    const targetId = 'T575TARGET';
    writeFileSync(T.tabEnvPath(targetId, dir), '{not json', { mode: 0o600 });
    const session = sessionAt(dir, targetId);
    const dialogRef = { value: true };
    const cdp = fakeCdp();
    const outcome = await T.applySavedTabEnvironment(cdp, 'sid-next', session, dialogRef, { runtimeDir: dir });
    expect(dialogRef.value).toBe(false);
    expect(session.dialogMode).toBe('dismiss');
    expect(session.networkThrottle).toBeNull();
    expect(session.networkMocks).toEqual([]);
    expect(outcome.unreadable).toBe(true);
    expect(T.formatDaemonRestartNotice(outcome)).toBe(
      'daemon restarted: dialog=dismiss (saved record unreadable), throttle was reset, mocks were reset, 0 netlog entries restored, 0 actions restored',
    );
    expect(cdp.calls).toEqual([]);
  });

  it('T7: no saved record keeps the defaults and a first daemon prints nothing', async () => {
    const dir = runtimeDir();
    const session = sessionAt(dir);
    const dialogRef = { value: true };
    const cdp = fakeCdp();
    const outcome = await T.applySavedTabEnvironment(cdp, 'sid-575', session, dialogRef, { runtimeDir: dir });
    expect(dialogRef.value).toBe(true);
    expect(session.dialogMode).toBe('accept');
    expect(session.networkThrottle).toBeNull();
    expect(session.networkMocks).toEqual([]);
    expect(cdp.calls).toEqual([]);
    expect(T.armDaemonRestartNotice(session, outcome, { restarted: false })).toBeNull();
    expect(session.restartNotice).toBeNull();
    const response = T.applyDaemonRestartNotice(session, 'eval', { ok: true, result: '2' });
    expect(response.result).toBe('2');
    expect(response.restartNotice).toBeUndefined();
  });

  it('T7: a restart with no saved record still names the lost netlog buffer', () => {
    const session = T.createSessionState({ targetId: 'T575', sessionId: 'sid' });
    const notice = T.armDaemonRestartNotice(session, {
      dialog: 'accept',
      throttleProfile: 'off',
      throttleReset: false,
      mockCount: 0,
      mocksReset: false,
      unreadable: false,
    }, { restarted: true });
    expect(notice).toBe('daemon restarted: dialog=accept, throttle=off, 0 mocks restored, 0 netlog entries restored, 0 actions restored');
  });

  it('T8: closetab removes the saved environment record and keeps its success text', async () => {
    const dir = runtimeDir();
    const session = sessionAt(dir);
    const dialogRef = { value: true };
    T.setDialogMode(new T.RingBuffer(4), dialogRef, session, 'dismiss');
    expect(T.readTabEnvironment(session.targetId, { runtimeDir: dir }).status).toBe('ok');
    const text = await T.closetabStr(fakeCdp(), session.targetId, { runtimeDir: dir });
    expect(text).toBe(`Closed tab: ${session.targetId.slice(0, 8)}`);
    expect(T.readTabEnvironment(session.targetId, { runtimeDir: dir }).status).toBe('absent');
  });

  it('a later throttle change keeps a saved dismiss mode', async () => {
    const dir = runtimeDir();
    const session = sessionAt(dir);
    T.setDialogMode(new T.RingBuffer(4), { value: true }, session, 'dismiss');
    await T.throttleStr(fakeCdp(), 'sid-575', session, ['offline']);
    await T.throttleStr(fakeCdp(), 'sid-575', session, ['off']);
    const saved = T.readTabEnvironment(session.targetId, { runtimeDir: dir });
    expect(saved.dialog).toBe('dismiss');
    expect(saved.throttle).toBeNull();
  });

  function envFiles(dir) {
    return readdirSync(dir).filter(name => name.startsWith('cdp-') && name.endsWith('.env.json'));
  }

  it('keeps dismiss, throttle, mocks, and unreadable records when the file cap is passed', () => {
    const dir = runtimeDir();
    const old = Date.parse('2020-01-01T00:00:00.000Z');
    for (let i = 0; i < 62; i += 1) {
      T.writeTabEnvironment(`ACCEPT${String(i).padStart(4, '0')}`, {
        dialog: 'accept',
        throttle: null,
        mocks: [],
      }, { runtimeDir: dir, now: () => old + i });
    }
    T.writeTabEnvironment('DISMISS00', { dialog: 'dismiss', throttle: null, mocks: [] }, {
      runtimeDir: dir,
      now: () => old + 100,
    });
    T.writeTabEnvironment('THROTTLE', {
      dialog: 'accept',
      throttle: { profile: 'offline', offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
      mocks: [],
    }, { runtimeDir: dir, now: () => old + 101 });
    writeFileSync(T.tabEnvPath('UNREAD00', dir), '{not json', { mode: 0o600 });
    expect(envFiles(dir)).toHaveLength(65);

    T.writeTabEnvironment('NEW575', { dialog: 'dismiss', throttle: null, mocks: [] }, {
      runtimeDir: dir,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });

    expect(T.readTabEnvironment('DISMISS00', { runtimeDir: dir }).dialog).toBe('dismiss');
    expect(T.readTabEnvironment('THROTTLE', { runtimeDir: dir }).throttle.profile).toBe('offline');
    expect(T.readTabEnvironment('UNREAD00', { runtimeDir: dir }).status).toBe('unreadable');
    expect(T.readTabEnvironment('NEW575', { runtimeDir: dir }).dialog).toBe('dismiss');
    expect(T.readTabEnvironment('ACCEPT0000', { runtimeDir: dir }).status).toBe('absent');
    expect(envFiles(dir)).toHaveLength(64);
  });

  it('fails the command when the environment file cannot be written', () => {
    const dir = runtimeDir();
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'x');
    const session = sessionAt(dir);
    session.runtimeDir = blocked;
    expect(() => T.setDialogMode(new T.RingBuffer(4), { value: true }, session, 'dismiss'))
      .toThrow(/Could not save dialog, throttle, and mock settings/);
    expect(session.dialogMode).toBe('dismiss');
  });

  it('download and MCP skip the restart line and still read the JSON or screenshot under it', async () => {
    const notice = 'daemon restarted: dialog=dismiss, throttle=offline, 0 mocks restored, 0 netlog entries restored, 0 actions restored';
    const { createEvaluate } = await import('../skills/chrome-cdp-ex/scripts/download.mjs');
    const run = async () => ({
      stdout: `${notice}\n${JSON.stringify({ result: { type: 'string', value: 'abc' } })}`,
    });
    expect(await createEvaluate('T1', { run })('1+1')).toBe('abc');

    const { createMcpToolResult } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
    const body = { schema: 'chrome-cdp-ex.throttle.v1', profile: 'offline' };
    const json = createMcpToolResult(['throttle'], {
      code: 0,
      stdout: `${notice}\n${JSON.stringify(body)}\n`,
      stderr: '',
    });
    expect(json.structuredContent).toEqual(body);
    expect(json.content[0].text.startsWith(notice)).toBe(true);

    const dir = runtimeDir();
    const png = join(dir, 'shot.png');
    writeFileSync(png, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ));
    const shot = createMcpToolResult(['shot'], {
      code: 0,
      stdout: `${notice}\n${png}\n`,
      stderr: '',
    }, { runtimeDir: dir, startedAtMs: Date.now() });
    expect(shot.content.some(part => part.type === 'image')).toBe(true);
    expect(shot.content[0].text.startsWith(`${notice}\n${png}`)).toBe(true);
  });

  it('initializeSessionLog restarted flag arms the notice only when the log already has bytes', () => {
    const dir = runtimeDir();
    const fresh = sessionAt(dir, 'FRESH575');
    expect(T.initializeSessionLog(fresh)?.restarted).toBe(false);
    const again = sessionAt(dir, 'FRESH575');
    expect(T.initializeSessionLog(again)?.restarted).toBe(true);
    const raw = readFileSync(fresh.logPath, 'utf8');
    expect(raw).toContain('"kind":"session-start"');
  });
});
