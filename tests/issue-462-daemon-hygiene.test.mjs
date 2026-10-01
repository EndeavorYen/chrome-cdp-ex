import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('#462 the early response-status map stays bounded', () => {
  function observer(now = () => 1_000) {
    const pendingReqs = new Map();
    const netReqBuf = new T.RingBuffer(100);
    const networkStatusByRequest = T.createEarlyResponseStatusStore({ now });
    const handlers = T.createDaemonNetworkObserver({ pendingReqs, netReqBuf, networkStatusByRequest, now });
    return { pendingReqs, netReqBuf, networkStatusByRequest, handlers };
  }
  const request = (requestId, type) => ({ requestId, type, request: { method: 'GET', url: `https://example.test/${requestId}` } });

  it('10k untracked responses leave nothing behind', () => {
    const { handlers, networkStatusByRequest, pendingReqs } = observer();
    for (let i = 0; i < 10_000; i++) {
      handlers['Network.requestWillBeSent'](request(`img-${i}`, 'Image'));
      handlers['Network.responseReceivedExtraInfo']({ requestId: `img-${i}`, statusCode: 200 });
      handlers['Network.loadingFinished']({ requestId: `img-${i}`, encodedDataLength: 10 });
    }
    expect(networkStatusByRequest.size).toBe(0);
    expect(pendingReqs.size).toBe(0);
  });

  it('a tracked request that already settled does not leave its late ExtraInfo behind', () => {
    const { handlers, networkStatusByRequest, netReqBuf } = observer();
    for (let i = 0; i < 1_000; i++) {
      handlers['Network.requestWillBeSent'](request(`xhr-${i}`, 'XHR'));
      handlers['Network.responseReceived']({ requestId: `xhr-${i}`, type: 'XHR', response: { status: 200, encodedDataLength: 5 } });
      handlers['Network.responseReceivedExtraInfo']({ requestId: `xhr-${i}`, statusCode: 200 });
    }
    expect(networkStatusByRequest.size).toBe(0);
    expect(netReqBuf.all()).toHaveLength(100);
  });

  it('10k ExtraInfo events for never-announced requests are capped', () => {
    const { handlers, networkStatusByRequest } = observer();
    for (let i = 0; i < 10_000; i++) {
      handlers['Network.responseReceivedExtraInfo']({ requestId: `ghost-${i}`, statusCode: 204 });
    }
    expect(networkStatusByRequest.size).toBe(T.EARLY_RESPONSE_STATUS_MAX);
  });

  it('still pairs an ExtraInfo that arrives before its tracked request', () => {
    const { handlers, networkStatusByRequest, netReqBuf, pendingReqs } = observer();
    handlers['Network.responseReceivedExtraInfo']({ requestId: 'early', statusCode: 302 });
    expect(networkStatusByRequest.size).toBe(1);
    handlers['Network.requestWillBeSent'](request('early', 'Fetch'));
    expect(networkStatusByRequest.size).toBe(0);
    expect(pendingReqs.size).toBe(0);
    expect(netReqBuf.all()[0]).toMatchObject({ url: 'https://example.test/early', status: 302, type: 'Fetch' });
  });

  it('an early status that waits past its age limit is dropped', () => {
    let clock = 1_000;
    const store = T.createEarlyResponseStatusStore({ now: () => clock });
    store.remember('old', 200);
    clock += T.EARLY_RESPONSE_STATUS_MAX_AGE_MS + 1;
    store.remember('new', 200);
    expect(store.size).toBe(1);
    expect(store.announce('old')).toBeUndefined();
    expect(store.announce('new')).toBe(200);
  });

  it('clearObservationBuffers clears it with the other buffers', () => {
    const store = T.createEarlyResponseStatusStore();
    store.remember('a', 200);
    T.clearObservationBuffers({ pendingReqs: new Map(), networkStatusByRequest: store });
    expect(store.size).toBe(0);
  });
});

describe('#462 the idle timer does not fire while a command runs', () => {
  function fakeTimers() {
    let next = 0;
    const pending = new Map();
    return {
      pending,
      fire() { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } },
      setTimer: vi.fn((fn, ms) => { next += 1; pending.set(next, { fn, ms }); return next; }),
      clearTimer: vi.fn(id => { pending.delete(id); }),
    };
  }

  function idleTimer(clockRef, timers, onIdle) {
    return T.createDaemonIdleTimer({
      timeoutMs: 20_000,
      onIdle,
      now: () => clockRef.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
  }

  it('a pending handler pauses the countdown; the last one to finish restarts it in full', async () => {
    const clock = { now: 1_000 };
    const timers = fakeTimers();
    const onIdle = vi.fn();
    const idle = idleTimer(clock, timers, onIdle);
    let finish;
    const handle = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const wrapped = T.idleTrackedDaemonRequestHandler(idle, handle);

    const response = wrapped({ id: 1, cmd: 'wait', args: ['T', '1500000'] }, null);
    expect(timers.pending.size).toBe(0);
    clock.now += 25 * 60 * 1000;
    timers.fire();
    expect(onIdle).not.toHaveBeenCalled();
    // A daemon with work in flight is not about to idle out (#440).
    expect(idle.remainingMs()).toBe(20_000);
    expect(T.daemonIdleExitsSoon({ idleRemainingMs: idle.remainingMs() })).toBe(false);

    finish({ ok: true, result: 'done' });
    await expect(response).resolves.toEqual({ ok: true, result: 'done' });
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending.values()][0].ms).toBe(20_000);
    expect(idle.remainingMs()).toBe(20_000);
    timers.fire();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('overlapping requests keep it paused until the last one ends, even when one fails', async () => {
    const clock = { now: 0 };
    const timers = fakeTimers();
    const onIdle = vi.fn();
    const idle = idleTimer(clock, timers, onIdle);
    const settle = {};
    const wrapped = T.idleTrackedDaemonRequestHandler(idle, req => new Promise((resolve, reject) => { settle[req.id] = { resolve, reject }; }));
    const first = wrapped({ id: 1, cmd: 'loadall', args: [] });
    const second = wrapped({ id: 2, cmd: 'click', args: [] });
    settle[1].reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    expect(timers.pending.size).toBe(0);
    settle[2].resolve({ ok: true });
    await second;
    expect(timers.pending.size).toBe(1);
  });

  it('meta and list_raw probes do not pause it or restart it', async () => {
    const clock = { now: 0 };
    const timers = fakeTimers();
    const idle = idleTimer(clock, timers, vi.fn());
    clock.now += 19_000;
    const wrapped = T.idleTrackedDaemonRequestHandler(idle, async () => ({ ok: true }));
    await wrapped({ id: 1, cmd: 'meta', args: [] });
    await wrapped({ id: 2, cmd: 'list_raw', args: [] });
    expect(idle.remainingMs()).toBe(1_000);
  });

  it('a keepalive asked for during a command still holds after it finishes', async () => {
    const clock = { now: 0 };
    const timers = fakeTimers();
    const idle = idleTimer(clock, timers, vi.fn());
    const end = idle.beginRequest();
    idle.extendKeepalive(60_000);
    expect(timers.pending.size).toBe(0);
    expect(idle.remainingMs()).toBe(60_000);
    end();
    end();
    expect(timers.pending.size).toBe(1);
    expect(idle.remainingMs()).toBe(60_000);
  });
});

describe('#462 runtime artifacts are pruned and the session log rotates', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function runtimeDir() {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-462-'));
    dirs.push(dir);
    return dir;
  }
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 1);

  function writeSet(dir, id, ageMs, { crash = false } = {}) {
    const at = new Date(NOW - ageMs);
    const log = join(dir, `cdp-${id}.log`);
    writeFileSync(log, '{}\n');
    utimesSync(log, at, at);
    const shots = join(dir, `cdp-${id}-screenshots`);
    mkdirSync(shots);
    writeFileSync(join(shots, 'shot-001.png'), 'png');
    utimesSync(shots, at, at);
    if (crash) {
      const file = join(dir, `cdp-${id}.crash.json`);
      writeFileSync(file, '{}');
      utimesSync(file, at, at);
    }
  }

  it('100 old sets are pruned to the newest bound, while a live daemon and the current target keep theirs', () => {
    const dir = runtimeDir();
    for (let i = 0; i < 100; i++) writeSet(dir, `T${String(i).padStart(3, '0')}`, (10 + i) * DAY, { crash: i % 10 === 0 });
    writeFileSync(join(dir, 'cdp-T099.log.1'), 'old');
    utimesSync(join(dir, 'cdp-T099.log.1'), new Date(NOW - 200 * DAY), new Date(NOW - 200 * DAY));
    writeFileSync(join(dir, 'pages.json'), '[]');
    writeFileSync(join(dir, 'cdp-T050.daemon.json'), '{}');
    const result = T.pruneRuntimeArtifacts({
      runtimeDir: dir,
      now: NOW,
      protectedTargetIds: ['T090', 'T095'],
    });
    const left = new Set(readdirSync(dir));
    const keptTargets = [...left].filter(name => name.endsWith('.log')).map(name => name.slice(4, -4)).sort();
    const newest = Array.from({ length: T.RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS }, (_, i) => `T${String(i).padStart(3, '0')}`);
    expect(keptTargets).toEqual([...newest, 'T090', 'T095']);
    expect(left.has('cdp-T090-screenshots')).toBe(true);
    expect(left.has('cdp-T090.crash.json')).toBe(true);
    expect(left.has('cdp-T000.crash.json')).toBe(true);
    expect(left.has('cdp-T030.crash.json')).toBe(false);
    expect(left.has('cdp-T099.log.1')).toBe(false);
    // Files that are not per-tab log/screenshot/crash artifacts are never touched.
    expect(left.has('pages.json')).toBe(true);
    expect(left.has('cdp-T050.daemon.json')).toBe(true);
    expect(result.removedTargets).toBe(78);
    expect(result.failedPaths).toBe(0);
  });

  it('sets younger than the age limit are kept even beyond the newest bound', () => {
    const dir = runtimeDir();
    for (let i = 0; i < 30; i++) writeSet(dir, `Y${i}`, i * 60 * 1000);
    const result = T.pruneRuntimeArtifacts({ runtimeDir: dir, now: NOW });
    expect(result.removedTargets).toBe(0);
    expect(readdirSync(dir).filter(name => name.endsWith('.log'))).toHaveLength(30);
  });

  it('a locked file is skipped without failing the prune', () => {
    const dir = runtimeDir();
    for (let i = 0; i < 25; i++) writeSet(dir, `L${String(i).padStart(2, '0')}`, (8 + i) * DAY);
    const rm = vi.fn((path, options) => {
      if (path.endsWith('cdp-L24.log')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      if (path.endsWith('cdp-L23-screenshots')) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      rmSync(path, options);
    });
    const result = T.pruneRuntimeArtifacts({ runtimeDir: dir, now: NOW, fs: { rm } });
    expect(result.failedPaths).toBe(2);
    expect(existsSync(join(dir, 'cdp-L24.log'))).toBe(true);
    expect(existsSync(join(dir, 'cdp-L22.log'))).toBe(false);
  });

  it('a missing runtime dir prunes nothing', () => {
    expect(T.pruneRuntimeArtifacts({ runtimeDir: join(tmpdir(), 'cdp-462-missing-dir'), now: NOW }))
      .toEqual({ removedTargets: 0, failedPaths: 0 });
  });

  it('live targets are those with a running recorded daemon or a socket', () => {
    const readdir = () => ['cdp-AAA.daemon.json', 'cdp-BBB.daemon.json', 'cdp-CCC.sock', 'cdp-DDD.log'];
    const reader = path => JSON.stringify({
      schema: 'chrome-cdp-ex.daemon-record.v1',
      targetId: path.includes('AAA') ? 'AAA' : 'BBB',
      pid: path.includes('AAA') ? 11 : 22,
      startedAt: 'x',
    });
    const live = T.liveRuntimeArtifactTargetIds({ runtimeDir: '/rt', readdir, reader, isAlive: pid => pid === 11 });
    expect([...live].sort()).toEqual(['AAA', 'CCC']);
  });

  it('the session log rotates to .1 once it passes the size limit', () => {
    const dir = runtimeDir();
    const logPath = join(dir, 'cdp-R.log');
    const session = { targetId: 'R', sessionId: 'S', logPath };
    T.initializeSessionLog(session);
    for (let i = 0; i < 40; i++) T.appendSessionEventLog(session, { kind: 'note', i, pad: 'x'.repeat(80) }, { rotateBytes: 1_000 });
    const current = readFileSync(logPath, 'utf8');
    const rotated = readFileSync(`${logPath}.1`, 'utf8');
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(1_000);
    expect(Buffer.byteLength(rotated)).toBeLessThanOrEqual(1_000);
    expect(current.trim().split('\n').at(-1)).toContain('"i":39');
    expect(readdirSync(dir).sort()).toEqual(['cdp-R.log', 'cdp-R.log.1']);
  });

  it('a log that cannot be renamed keeps being written', () => {
    const dir = runtimeDir();
    const logPath = join(dir, 'cdp-W.log');
    const session = { targetId: 'W', sessionId: 'S', logPath };
    T.initializeSessionLog(session);
    const rename = vi.fn(() => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
    for (let i = 0; i < 20; i++) T.appendSessionEventLog(session, { kind: 'note', i, pad: 'x'.repeat(80) }, { rotateBytes: 1_000, rename });
    expect(rename).toHaveBeenCalled();
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(21);
    expect(session.logErrors).toBeUndefined();
  });
});
