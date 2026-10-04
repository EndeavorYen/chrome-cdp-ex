import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const OLD = '1667E1A41DF4F9ED4DEBC30A498CCB8F';
const NEW = 'B7BB111A00000000000000000000AAAA';
const PAGE_URL = 'http://127.0.0.1:7860/';
const TITLE = '✓ 完成 · 暗房';
const page = (targetId, url = PAGE_URL, title = TITLE) => ({ targetId, url, title });

function errorFrom(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe('#538 a vanished prefix names its successor page', () => {
  it('T1: exactly one live page with the last-seen URL and title is named in the error', () => {
    const err = errorFrom(() => T.resolveLiveTargetBinding({
      requested: '1667E1A4',
      livePages: [page(NEW), page('C0FFEE0000000000', 'https://example.com/', 'Example')],
      lastSeenPages: [page(OLD)],
    }));
    expect(err.message).toBe(`No live target matching prefix "1667E1A4". Target 1667E1A4 is gone; the same page (same URL and title) is now B7BB111A: ${PAGE_URL}`);
    expect(err).toMatchObject({ code: 'target_successor', successorTargetId: NEW, successorPrefix: 'B7BB111A' });
  });

  it('T2: no hint when the match is ambiguous, the title changed, or nothing was cached', () => {
    const plain = 'No live target matching prefix "1667E1A4".';
    const cases = [
      { livePages: [page(NEW), page('D00D000000000000')], lastSeenPages: [page(OLD)] },
      { livePages: [page(NEW, PAGE_URL, 'Other title')], lastSeenPages: [page(OLD)] },
      { livePages: [page(NEW)], lastSeenPages: [] },
      { livePages: [page(NEW)], lastSeenPages: [page(OLD, '', '')] },
      { livePages: [page(NEW)], lastSeenPages: [page(OLD), page('1667E1A4FFFF0000')] },
    ];
    for (const extra of cases) {
      const err = errorFrom(() => T.resolveLiveTargetBinding({ requested: '1667E1A4', ...extra }));
      expect(err.message).toBe(plain);
      expect(err.code).toBeUndefined();
    }
  });

  it('T1: the successor prefix grows past 8 characters when another live page shares it', () => {
    const twin = 'B7BB111A99999999999999999999BBBB';
    const err = errorFrom(() => T.resolveLiveTargetBinding({
      requested: '1667E1A4',
      livePages: [page(NEW), page(twin, 'https://example.com/', 'Example')],
      lastSeenPages: [page(OLD)],
    }));
    expect(err.successorPrefix).toBe('B7BB111A0');
  });

  it('an alias error keeps its own message', () => {
    const err = errorFrom(() => T.resolveLiveTargetBinding({
      requested: '@shop',
      alias: { name: 'shop', targetId: OLD },
      livePages: [page(NEW)],
      lastSeenPages: [page(OLD)],
    }));
    expect(err.message).toMatch(/No live target matching alias @shop/);
  });

  it('T3: the recovery reruns the same command on the successor, Kind target-resolution', () => {
    const err = errorFrom(() => T.resolveLiveTargetBinding({ requested: '1667E1A4', livePages: [page(NEW)], lastSeenPages: [page(OLD)] }));
    const out = T.formatCliError(err, { cmd: 'nav', targetPrefix: '1667E1A4', args: [PAGE_URL] });
    expect(out).toMatch(/Kind: target-resolution/);
    expect(out).toMatch(/Strategy: use-successor-target/);
    expect(out.split('\n').at(-1)).toBe(`Next: cdp nav B7BB111A ${PAGE_URL} (Kind: target-resolution)`);
  });

  it('T5: troubleshooting explains that a target id can change without the tab closing', () => {
    const doc = readFileSync(new URL('../skills/chrome-cdp-ex/references/troubleshooting.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/target id can change/i);
    expect(doc).toMatch(/cdp target --url/);
  });
});

describe('#538 main() keeps the last-seen page list for the resolver', () => {
  it('T4: reads the previous pages.json before writing the fresh list', () => {
    const source = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    const read = source.indexOf('const lastSeenPages = readCachedPages()');
    const write = source.indexOf('writeFileSync(PAGES_CACHE, JSON.stringify(livePages)');
    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(read);
  });
});
