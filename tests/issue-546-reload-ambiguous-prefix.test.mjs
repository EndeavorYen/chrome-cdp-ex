import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TAB = 'C3573E00AAAA0000000000000000AAAA';
const OTHER = 'C3573E00BBBB0000000000000000BBBB';
const PAGE_URL = 'http://127.0.0.1:7860/';
const page = (targetId, url = PAGE_URL) => ({ targetId, type: 'page', url, title: '暗房 · Qwen-Image' });

function resolveWith(snapshots) {
  const calls = [];
  const waits = [];
  const promise = T.resolvePageCommandTarget({
    targetPrefix: 'C3573E00',
    targetAlias: null,
    discover: async () => {
      calls.push(calls.length);
      return snapshots[Math.min(calls.length - 1, snapshots.length - 1)];
    },
    readBinding: async () => null,
    wait: async (ms) => { waits.push(ms); },
  });
  return { promise, calls, waits };
}

describe('#546 a prefix that is ambiguous for a moment after reload', () => {
  it('T1 resolves when the live list names the same target id twice', async () => {
    const { promise, calls } = resolveWith([[page(TAB), page(TAB)]]);
    const { targetResolution, livePages } = await promise;
    expect(targetResolution.resolvedTargetId).toBe(TAB);
    // Later steps (the runtime supervisor's exact-target locator) see one entry, not two.
    expect(livePages).toEqual([page(TAB)]);
    expect(calls).toHaveLength(1);
  });

  it('T1 getPages lists a target id once when Target.getTargets names it twice', async () => {
    const info = { targetId: TAB, type: 'page', url: PAGE_URL, title: 't' };
    const cdp = { send: async () => ({ targetInfos: [info, { ...info }] }) };
    await expect(T.getPages(cdp)).resolves.toEqual([info]);
  });

  it('T1 a daemon list_raw that names one id twice is listed once', async () => {
    const pages = await T.discoverLivePagesForTargetResolution({
      env: { CDP_PORT: '9333' },
      listSockets: () => [{ socketPath: 'old-daemon.sock' }],
      connect: async () => ({ destroy() {} }),
      request: async (_conn, req) => (req.cmd === 'meta'
        ? { ok: true, result: JSON.stringify({ cdpEndpoint: '127.0.0.1:9333' }) }
        : { ok: true, result: JSON.stringify([page(TAB), page(TAB)]) }),
      // Never fall through to a real browser.
      resolveWsUrl: async () => { throw new Error('unexpected live discovery'); },
    });
    expect(pages).toEqual([page(TAB)]);
  });

  it('keeps naming the #538 successor when the last-seen or live list repeats an id', () => {
    const OLD = '1667E1A41DF4F9ED4DEBC30A498CCB8F';
    const error = (() => {
      try {
        T.resolveLiveTargetBinding({ requested: '1667E1A4', livePages: [page(TAB), page(TAB)], lastSeenPages: [page(OLD), page(OLD)] });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error?.code).toBe('target_successor');
    expect(error.successorTargetId).toBe(TAB);
  });

  it('T2 resolves when the second match is gone on the next discovery', async () => {
    const { promise, calls, waits } = resolveWith([[page(TAB), page(OTHER)], [page(TAB)]]);
    const { targetResolution, livePages } = await promise;
    expect(targetResolution.resolvedTargetId).toBe(TAB);
    expect(livePages).toEqual([page(TAB)]);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([250]);
  });

  it('T3 fails after the retries and names every match', async () => {
    const { promise, calls } = resolveWith([[page(TAB), page(OTHER, 'http://127.0.0.1:7860/?token=secret')]]);
    const error = await promise.catch(e => e);
    expect(calls).toHaveLength(4);
    expect(error.code).toBe('target_ambiguous');
    expect(error.message).toContain('Live target prefix "C3573E00" is ambiguous (2 matches)');
    expect(error.message).toContain(`C3573E00A page ${PAGE_URL}`);
    expect(error.message).toContain('C3573E00B page http://127.0.0.1:7860/');
    expect(error.message).not.toContain('secret');
  });

  it('T4 an unambiguous prefix makes one discovery call', async () => {
    const { promise, calls, waits } = resolveWith([[page(TAB), page('D0000000000000000000000000000000', 'https://example.com/')]]);
    const { targetResolution } = await promise;
    expect(targetResolution.resolvedTargetId).toBe(TAB);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});
