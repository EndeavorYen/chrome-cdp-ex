import { afterEach, describe, it, expect, beforeEach } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, CDP, resolvePrefix, getDisplayPrefixLength, sockPath, validateUrl } = T;

// =========================================================================
// RingBuffer
// =========================================================================

describe('RingBuffer', () => {
  let buf;
  beforeEach(() => { buf = new RingBuffer(3); });

  it('should start empty with seq 0', () => {
    expect(buf.all()).toEqual([]);
    expect(buf.latest()).toBe(0);
  });

  it('should push entries with incrementing _seq', () => {
    buf.push({ a: 1 });
    buf.push({ a: 2 });
    buf.push({ a: 3 });
    const all = buf.all();
    expect(all).toHaveLength(3);
    expect(all[0]._seq).toBe(1);
    expect(all[1]._seq).toBe(2);
    expect(all[2]._seq).toBe(3);
  });

  it('should evict oldest when capacity exceeded', () => {
    buf.push({ v: 'a' });
    buf.push({ v: 'b' });
    buf.push({ v: 'c' });
    buf.push({ v: 'd' }); // evicts 'a'
    const all = buf.all();
    expect(all).toHaveLength(3);
    expect(all[0].v).toBe('b');
    expect(all[2].v).toBe('d');
  });

  it('should mutate the pushed object to add _seq', () => {
    const obj = { x: 42 };
    buf.push(obj);
    expect(obj._seq).toBe(1);
  });

  it('since() should return entries after given seq', () => {
    buf.push({ v: 1 });
    buf.push({ v: 2 });
    buf.push({ v: 3 });
    expect(buf.since(2)).toHaveLength(1);
    expect(buf.since(2)[0].v).toBe(3);
    expect(buf.since(0)).toHaveLength(3);
    expect(buf.since(buf.latest())).toEqual([]);
  });

  it('all() should return a copy', () => {
    buf.push({ v: 1 });
    const a = buf.all();
    const b = buf.all();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('clear() should empty buffer but preserve seq', () => {
    buf.push({ v: 1 });
    buf.push({ v: 2 });
    const seqBefore = buf.latest();
    buf.clear();
    expect(buf.all()).toEqual([]);
    expect(buf.latest()).toBe(seqBefore);
  });

  it('should work correctly after clear + re-push', () => {
    buf.push({ v: 1 });
    buf.clear();
    buf.push({ v: 2 });
    expect(buf.all()).toHaveLength(1);
    expect(buf.all()[0]._seq).toBe(2);
    expect(buf.since(1)).toHaveLength(1);
  });
});

// =========================================================================
// CDP pending command rejection (#144)
// =========================================================================

function installFakeWebSocket() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      this.onmessage = null;
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({ type: 'open' });
      });
    }
    send(data) {
      this.lastSent = data;
    }
    close(code = 1006, reason = '') {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ type: 'close', code, reason: String(reason), wasClean: false });
    }
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  }
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  return {
    sockets,
    restore() { globalThis.WebSocket = previous; },
  };
}

async function connectFakeCdp(fake) {
  const cdp = new CDP();
  await cdp.connect('ws://pending-cdp.test/devtools');
  return { cdp, socket: fake.sockets.at(-1) };
}

function expectLifecycleError(err, pattern) {
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toMatch(pattern);
  expect(err.message).not.toMatch(/^Timeout:/);
  expect(err.message).not.toMatch(/click Allow/i);
  expect(err.message).not.toMatch(/Allow debugging/i);
}

function settlePromptly(promise, timeoutMs = 200, timeoutMessage = 'pending send did not reject promptly') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      value => ({ status: 'resolved', value }),
      error => ({ status: 'rejected', error })
    ).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]);
}

describe('CDP pending command rejection', () => {
  let fake;

  beforeEach(() => {
    fake = installFakeWebSocket();
  });

  afterEach(() => {
    fake?.restore();
  });

  it('rejects pending send() promptly on websocket close, not Timeout', async () => {
    const { cdp, socket } = await connectFakeCdp(fake);
    const pending = cdp.send('Page.navigate', { url: 'https://example.com' });
    const started = Date.now();
    socket.close(1006, 'going away');

    const settled = await settlePromptly(pending);
    expect(Date.now() - started).toBeLessThan(200);
    expect(settled.status).toBe('rejected');
    expectLifecycleError(settled.error, /CDP websocket closed while waiting for Page\.navigate/);
    expect(settled.error.message).toMatch(/1006/);
    expect(settled.error.message).toMatch(/going away/);
  });

  it('rejects pending send() on session-scoped Inspector.detached', async () => {
    const { cdp, socket } = await connectFakeCdp(fake);
    const pending = cdp.send('Page.navigate', { url: 'https://example.com' }, 'sid-1');
    const other = cdp.send('Runtime.evaluate', { expression: '1' }, 'sid-2');
    const started = Date.now();
    socket.emit({
      method: 'Inspector.detached',
      params: { reason: 'target_closed' },
      sessionId: 'sid-1',
    });

    const settled = await settlePromptly(pending);
    expect(Date.now() - started).toBeLessThan(200);
    expect(settled.status).toBe('rejected');
    expectLifecycleError(settled.error, /detached while waiting for Page\.navigate/);
    expect(settled.error.message).toMatch(/target_closed/);
    socket.emit({
      id: JSON.parse(socket.lastSent).id,
      result: { result: { value: 1 } },
    });
    await expect(other).resolves.toEqual({ result: { value: 1 } });
  });

  it('rejects every pending send() when Inspector.detached has no sessionId', async () => {
    const { cdp, socket } = await connectFakeCdp(fake);
    const first = cdp.send('Page.navigate', { url: 'https://example.com' }, 'sid-1');
    const second = cdp.send('Runtime.evaluate', { expression: '1' });
    const started = Date.now();
    socket.emit({
      method: 'Inspector.detached',
      params: { reason: 'replaced' },
    });

    const [firstSettled, secondSettled] = await Promise.race([
      Promise.all([settlePromptly(first), settlePromptly(second)]),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('pending sends did not reject promptly')), 200);
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(200);
    expect(firstSettled.status).toBe('rejected');
    expect(secondSettled.status).toBe('rejected');
    expectLifecycleError(firstSettled.error, /detached while waiting for Page\.navigate/);
    expectLifecycleError(secondSettled.error, /detached while waiting for Runtime\.evaluate/);
    expect(firstSettled.error.message).toMatch(/replaced/);
    expect(secondSettled.error.message).toMatch(/replaced/);
  });

  it('rejects waitForEvent promptly on websocket close instead of waiting for the event timeout', async () => {
    const { cdp, socket } = await connectFakeCdp(fake);
    const waiter = cdp.waitForEvent('Page.loadEventFired', 15000);
    const started = Date.now();
    socket.close(1006, 'going away');

    const settled = await settlePromptly(waiter.promise);
    expect(Date.now() - started).toBeLessThan(200);
    expect(settled.status).toBe('rejected');
    expectLifecycleError(settled.error, /CDP websocket closed while waiting for event: Page\.loadEventFired/);
  });
});

// =========================================================================
// resolvePrefix
// =========================================================================

describe('resolvePrefix', () => {
  const ids = ['ABCD1234EEEE', 'ABCE5678FFFF', 'XYZ99999GGGG'];

  it('should resolve unambiguous prefix', () => {
    expect(resolvePrefix('XYZ', ids)).toBe('XYZ99999GGGG');
  });

  it('should be case-insensitive', () => {
    expect(resolvePrefix('xyz9', ids)).toBe('XYZ99999GGGG');
  });

  it('should resolve when prefix uniquely narrows to one', () => {
    expect(resolvePrefix('ABCD', ids)).toBe('ABCD1234EEEE');
    expect(resolvePrefix('ABCE', ids)).toBe('ABCE5678FFFF');
  });

  it('should throw on ambiguous prefix', () => {
    expect(() => resolvePrefix('ABC', ids)).toThrow(/Ambiguous/);
    expect(() => resolvePrefix('ABC', ids)).toThrow(/matches 2/);
  });

  it('should throw on no match', () => {
    expect(() => resolvePrefix('QQQ', ids)).toThrow(/No .* matching/);
  });

  it('should include missingHint in error', () => {
    expect(() => resolvePrefix('QQQ', ids, 'target', 'Run "cdp list".'))
      .toThrow(/Run "cdp list"/);
  });

  it('should use custom noun in error', () => {
    expect(() => resolvePrefix('QQQ', ids, 'daemon'))
      .toThrow(/No daemon matching/);
  });
});

// =========================================================================
// getDisplayPrefixLength
// =========================================================================

describe('getDisplayPrefixLength', () => {
  it('should return 8 (MIN) for empty array', () => {
    expect(getDisplayPrefixLength([])).toBe(8);
  });

  it('should return 8 when IDs diverge within first 8 chars', () => {
    expect(getDisplayPrefixLength(['AAAA1111', 'BBBB2222'])).toBe(8);
  });

  it('should grow prefix until all IDs are unique', () => {
    // These share first 8 chars, diverge at position 9
    const ids = ['ABCDEFGH1XXX', 'ABCDEFGH2YYY'];
    expect(getDisplayPrefixLength(ids)).toBe(9);
  });

  it('should handle single ID', () => {
    expect(getDisplayPrefixLength(['ABCD1234'])).toBe(8);
  });
});

// =========================================================================
// SessionState
// =========================================================================

describe('SessionState', () => {
  it('creates explicit daemon session state', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    expect(state.targetId).toBe('ABC123');
    expect(state.sessionId).toBe('sid-1');
    expect(state.refs.map).toBeInstanceOf(Map);
    expect(state.refs.invalidationReason).toBe('daemon-start');
    expect(state.actionLog).toEqual([]);
  });

  it('invalidates refs on navigation', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.refs.map.set(1, 42);
    T.invalidateSessionRefs(state, 'navigation');
    expect(state.refs.map.size).toBe(0);
    expect(state.refs.invalidationReason).toBe('navigation');
  });
});

// =========================================================================
// validateUrl
// =========================================================================

describe('validateUrl', () => {
  it('should accept http and https URLs', () => {
    expect(() => validateUrl('http://example.com')).not.toThrow();
    expect(() => validateUrl('https://example.com/path?q=1')).not.toThrow();
    expect(() => validateUrl('http://192.168.1.1:8080/')).not.toThrow();
  });

  it('should reject non-http protocols', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/Only http/);
    expect(() => validateUrl('ftp://example.com')).toThrow(/Only http/);
    expect(() => validateUrl('data:text/html,<h1>hi</h1>')).toThrow(/Only http/);
  });

  it('should reject invalid URLs', () => {
    expect(() => validateUrl('not a url')).toThrow(/Invalid URL/);
    expect(() => validateUrl('')).toThrow(/Invalid URL/);
  });

  it('should block AWS metadata (169.254.169.254)', () => {
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data/'))
      .toThrow(/metadata/i);
  });

  it('should block GCP metadata endpoint', () => {
    expect(() => validateUrl('http://metadata.google.internal/computeMetadata/v1/'))
      .toThrow(/metadata/i);
  });

  it('should block Azure metadata (169.254.170.2)', () => {
    expect(() => validateUrl('http://169.254.170.2/'))
      .toThrow(/metadata/i);
  });

  it('should block link-local range 169.254.x.x', () => {
    expect(() => validateUrl('http://169.254.1.1/')).toThrow(/link-local/);
    expect(() => validateUrl('http://169.254.255.255/')).toThrow(/link-local/);
  });

  it('should allow private IPs that are not metadata/link-local', () => {
    expect(() => validateUrl('http://192.168.1.1/')).not.toThrow();
    expect(() => validateUrl('http://10.0.0.1/')).not.toThrow();
    expect(() => validateUrl('http://127.0.0.1:3000/')).not.toThrow();
  });

  it('should block GKE metadata host', () => {
    expect(() => validateUrl('http://metadata.gke.internal/'))
      .toThrow(/metadata/i);
  });
});

// =========================================================================
// sockPath
// =========================================================================

describe('sockPath', () => {
  it('should include targetId in path', () => {
    const p = sockPath('abc123def');
    expect(p).toContain('abc123def');
  });

  // On Linux/Mac: Unix socket ending in .sock
  if (process.platform !== 'win32') {
    it('should return .sock path on Unix', () => {
      expect(sockPath('abc123')).toMatch(/cdp-abc123\.sock$/);
    });
  }
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================

describe('daemon metadata freshness', () => {
  const current = {
    schema: 'chrome-cdp-ex.daemon-metadata.v1',
    scriptPath: '/repo/skills/chrome-cdp-ex/scripts/cdp.mjs',
    scriptMtimeMs: 2000,
    packageVersion: '2.7.0',
    gitCommit: 'new1234',
    pid: 222,
    startedAt: '2026-06-29T15:40:00.000Z',
  };

  it('accepts a daemon whose script metadata matches the current checkout', () => {
    const assessment = T.assessDaemonFreshness({
      targetPrefix: 'AABBCCDD',
      current,
      daemon: { ...current, pid: 111, startedAt: '2026-06-29T15:30:00.000Z' },
    });

    expect(assessment).toMatchObject({
      stale: false,
      status: 'current',
      targetPrefix: 'AABBCCDD',
      mismatches: [],
    });
  });

  it('blocks stale daemon metadata and names daemon/current versions', () => {
    const assessment = T.assessDaemonFreshness({
      targetPrefix: 'AABBCCDD',
      current,
      daemon: {
        ...current,
        scriptMtimeMs: 1000,
        gitCommit: 'old9999',
        pid: 111,
        startedAt: '2026-06-29T15:00:00.000Z',
      },
    });
    const message = T.formatStaleDaemonMessage(assessment);

    expect(assessment).toMatchObject({
      stale: true,
      status: 'stale',
      targetPrefix: 'AABBCCDD',
      mismatches: [
        { field: 'gitCommit', daemon: 'old9999', current: 'new1234' },
        { field: 'scriptMtimeMs', daemon: 1000, current: 2000 },
      ],
    });
    expect(message).toContain('Stale daemon for AABBCCDD');
    expect(message).toContain('daemon commit old9999');
    expect(message).toContain('current commit new1234');
    expect(message).toContain('pid 111');
    expect(message).toContain('cdp stop AABBCCDD');
    expect(message).toContain('--allow-stale-daemon');
  });

  it('blocks missing daemon metadata as an older daemon', () => {
    const assessment = T.assessDaemonFreshness({
      targetPrefix: 'AABBCCDD',
      current,
      daemon: null,
    });
    const message = T.formatStaleDaemonMessage(assessment);

    expect(assessment).toMatchObject({
      stale: true,
      status: 'missing-metadata',
      targetPrefix: 'AABBCCDD',
      mismatches: [{ field: 'metadata', daemon: null, current: 'available' }],
    });
    expect(message).toContain('Stale daemon for AABBCCDD');
    expect(message).toContain('daemon metadata missing');
    expect(message).toContain('current commit new1234');
    expect(message).toContain('cdp stop AABBCCDD');
  });

  it('formats stale daemon CLI errors with restart recovery', () => {
    const model = T.buildCliErrorModel(
      new Error('Stale daemon for AABBCCDD: daemon commit old9999, current commit new1234. Run "cdp stop AABBCCDD" then rerun the command.'),
      { cmd: 'click', targetPrefix: 'AABBCCDD' }
    );

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'click',
      targetPrefix: 'AABBCCDD',
      recovery: {
        kind: 'stale-daemon',
        strategy: 'restart-target-daemon',
        run: 'cdp stop AABBCCDD',
        then: 'rerun the original command',
      },
      nextSteps: ['cdp stop AABBCCDD', 'rerun the original command'],
    });
  });
});
