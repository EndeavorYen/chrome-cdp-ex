import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET = 'ABCDEF0123456789ABCDEF0123456789';
const OTHER = 'FFFFFF0123456789FFFFFF0123456789';

function page(targetId, url = 'https://example.test/') {
  return { targetId, type: 'page', title: 'Example', url };
}

// Fake browser-level CDP. `targets` is what Target.getTargets reports (or 'unavailable').
function fakeCdp(targets) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        if (targets === 'unavailable') return Promise.reject(new Error('Timeout: Target.getTargets'));
        return Promise.resolve({ targetInfos: targets });
      }
      if (method === 'Target.closeTarget') return Promise.resolve({ success: true });
      return Promise.resolve({});
    },
  };
}

const closed = (cdp) => cdp.calls.some((c) => c.method === 'Target.closeTarget');

describe('closetab guard (#404)', () => {
  it('refuses to close the only open tab and does not send Target.closeTarget', async () => {
    const cdp = fakeCdp([page(TARGET)]);
    const error = await T.closetabStr(cdp, TARGET).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/refusing to close the last open tab/);
    expect(error.message).toMatch(/--force/);
    expect(closed(cdp)).toBe(false);
  });

  it('--force closes the only open tab', async () => {
    const cdp = fakeCdp([page(TARGET)]);
    await expect(T.closetabStr(cdp, TARGET, { force: true })).resolves.toBe('Closed tab: ABCDEF01');
    expect(closed(cdp)).toBe(true);
  });

  it('closes normally when another tab remains, with the unchanged receipt text', async () => {
    const cdp = fakeCdp([page(TARGET), page(OTHER)]);
    await expect(T.closetabStr(cdp, TARGET)).resolves.toBe('Closed tab: ABCDEF01');
    expect(cdp.calls.find((c) => c.method === 'Target.closeTarget').params).toEqual({ targetId: TARGET });
  });

  it('a target that is not in the page list is closed as before (guard needs evidence)', async () => {
    const cdp = fakeCdp([page(OTHER)]);
    await expect(T.closetabStr(cdp, TARGET)).resolves.toBe('Closed tab: ABCDEF01');
  });

  it('is best-effort: when the tab list cannot be read the tab is closed as before', async () => {
    const cdp = fakeCdp('unavailable');
    await expect(T.closetabStr(cdp, TARGET)).resolves.toBe('Closed tab: ABCDEF01');
    expect(closed(cdp)).toBe(true);
  });

  it('parses --force and rejects anything else', () => {
    expect(T.parseClosetabArgs([])).toEqual({ force: false });
    expect(T.parseClosetabArgs(['--force'])).toEqual({ force: true });
    expect(() => T.parseClosetabArgs(['--nope'])).toThrow(/closetab: unknown argument --nope/);
  });

  it('classifies the refusal as a usage error that points to `cdp help closetab`', () => {
    const message = 'closetab: refusing to close the last open tab (closing it can quit the browser); pass --force to close it anyway';
    expect(T.classifyActionFailure(new Error(message), {
      action: 'closetab',
      target: { targetId: 'ABCDEF01', input: '' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help closetab' });
    const recovery = T.buildCliErrorRecovery(message, { cmd: 'closetab', targetPrefix: 'ABCDEF01' });
    expect(recovery.kind).toBe('usage');
    expect(recovery.run).toBe('cdp help closetab');
  });
});
