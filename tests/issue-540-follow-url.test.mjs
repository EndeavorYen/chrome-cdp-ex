import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { buildMcpToolCommand } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');

const OLD = '1667E1A41DF4F9ED4DEBC30A498CCB8F';
const NEW = 'B7BB111A00000000000000000000AAAA';
const PAGE_URL = 'http://127.0.0.1:7860/';
const TITLE = 'Darkroom';
const page = (targetId, url = PAGE_URL, title = TITLE) => ({ targetId, url, title });

function errorFrom(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe('#540 --follow-url re-binds a unique successor for read commands', () => {
  it('T1: followUrl resolves the one live page with the last-seen URL and title', () => {
    const binding = T.resolveLiveTargetBinding({
      requested: '1667E1A4',
      followUrl: true,
      livePages: [page(NEW), page('C0FFEE0000000000', 'https://example.com/', 'Example')],
      lastSeenPages: [page(OLD)],
    });
    expect(binding).toMatchObject({
      requestedTargetPrefix: '1667E1A4',
      requestedTargetId: OLD,
      resolvedTargetId: NEW,
      resolutionSource: 'follow-url',
      status: 'followed-url',
      followedUrl: true,
      rebound: true,
      successorPrefix: 'B7BB111A',
    });
  });

  it('T2: without followUrl the same input still throws target_successor', () => {
    const err = errorFrom(() => T.resolveLiveTargetBinding({
      requested: '1667E1A4',
      livePages: [page(NEW)],
      lastSeenPages: [page(OLD)],
    }));
    expect(err).toMatchObject({ code: 'target_successor', successorTargetId: NEW, successorPrefix: 'B7BB111A' });
  });

  it('T3: click, nav, eval, and shot reject --follow-url before any successor binding', () => {
    for (const cmd of ['click', 'nav', 'eval', 'shot']) {
      const err = errorFrom(() => T.takeFollowUrlFlag(cmd, ['1667E1A4', '--follow-url']));
      expect(err?.code, cmd).toBe('follow_url_not_read');
      expect(err?.message, cmd).toMatch(/read command/);
    }
    expect(T.commandAcceptsFollowUrl('click')).toBe(false);
    expect(T.commandAcceptsFollowUrl('nav')).toBe(false);
    expect(T.commandAcceptsFollowUrl('eval')).toBe(false);
    expect(T.commandAcceptsFollowUrl('shot')).toBe(false);
  });

  it('T4: ambiguous, retitled, uncached, blank, and New Tab pages do not re-bind', () => {
    const cases = [
      { livePages: [page(NEW), page('D00D000000000000')], lastSeenPages: [page(OLD)] },
      { livePages: [page(NEW, PAGE_URL, 'Other title')], lastSeenPages: [page(OLD)] },
      { livePages: [page(NEW)], lastSeenPages: [] },
      { livePages: [page(NEW, 'about:blank', '')], lastSeenPages: [page(OLD, 'about:blank', '')] },
      { livePages: [page(NEW, 'chrome://newtab/', 'New Tab')], lastSeenPages: [page(OLD, 'chrome://newtab/', 'New Tab')] },
    ];
    for (const extra of cases) {
      const err = errorFrom(() => T.resolveLiveTargetBinding({
        requested: '1667E1A4',
        followUrl: true,
        ...extra,
      }));
      expect(err?.code).toBeUndefined();
      expect(err?.message).toBe('No live target matching prefix "1667E1A4".');
    }
  });

  it('T5: an alias miss stays an alias error when followUrl is set', () => {
    const err = errorFrom(() => T.resolveLiveTargetBinding({
      requested: '@shop',
      followUrl: true,
      alias: { name: 'shop', targetId: OLD },
      livePages: [page(NEW)],
      lastSeenPages: [page(OLD)],
    }));
    expect(err.message).toMatch(/No live target matching alias @shop/);
    expect(err.code).toBeUndefined();
  });

  it('T6: JSON receipt keeps followed-url and text mode states the re-bind on stderr', () => {
    const binding = T.resolveLiveTargetBinding({
      requested: '1667E1A4',
      followUrl: true,
      livePages: [page(NEW)],
      lastSeenPages: [page(OLD)],
    });
    const completed = T.completeTargetResolution(binding, { boundTargetId: NEW, rebound: false });
    expect(completed).toMatchObject({
      status: 'followed-url',
      rebound: true,
      followedUrl: true,
      resolvedTargetId: NEW,
      requestedTargetPrefix: '1667E1A4',
    });
    const output = T.attachTargetResolutionDiagnostics(JSON.stringify({
      schema: 'chrome-cdp-ex.perception.v1',
      mode: 'compact',
    }), completed);
    expect(JSON.parse(output).targetResolution).toMatchObject({
      status: 'followed-url',
      rebound: true,
      followedUrl: true,
      requestedTargetPrefix: '1667E1A4',
      resolvedTargetId: NEW,
      successorPrefix: 'B7BB111A',
    });
    const lines = [];
    T.emitTargetCommandResponse({
      ok: true,
      result: 'page text',
    }, {
      cmd: 'html',
      targetPrefix: '1667E1A4',
      format: 'text',
      targetResolution: completed,
      console: {
        log: () => {},
        error: line => lines.push(line),
      },
      process: { exitCode: 0 },
    });
    expect(lines.join('\n')).toBe('Re-bound target 1667E1A4 to B7BB111A (same URL and title).');
  });

  it('T7: --follow-url is removed from the args a read command forwards', () => {
    expect(T.commandAcceptsFollowUrl('perceive')).toBe(true);
    expect(T.commandAcceptsFollowUrl('list')).toBe(false);
    expect(T.commandAcceptsFollowUrl('snapshot')).toBe(true);
    const taken = T.takeFollowUrlFlag('perceive', ['--follow-url', '1667E1A4', '-C', '-d', '8']);
    expect(taken).toEqual({ followUrl: true, args: ['1667E1A4', '-C', '-d', '8'] });
    expect(T.takeFollowUrlFlag('html', ['1667E1A4'])).toEqual({ followUrl: false, args: ['1667E1A4'] });
  });

  it('T8: troubleshooting, reference, and the skill name --follow-url for read commands only', () => {
    const troubleshooting = readFileSync(new URL('../skills/chrome-cdp-ex/references/troubleshooting.md', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
    const skill = readFileSync(new URL('../skills/chrome-cdp-ex/SKILL.md', import.meta.url), 'utf8');
    for (const doc of [troubleshooting, reference, skill]) {
      expect(doc).toMatch(/--follow-url/);
      expect(doc).toMatch(/read/);
    }
    expect(troubleshooting).toMatch(/does not re-bind/);
  });

  it('MCP read tools map followUrl to the flag and click does not grow a followUrl field', () => {
    expect(buildMcpToolCommand('perceive', { target: '1667E1A4', followUrl: true }))
      .toEqual(['perceive', '1667E1A4', '--follow-url', '--adaptive', '--format', 'json']);
    expect(buildMcpToolCommand('controls', { target: '1667E1A4', followUrl: true, compact: false }))
      .toEqual(['controls', '1667E1A4', '--follow-url', '--format', 'json']);
    expect(buildMcpToolCommand('click', { target: '1667E1A4', selector: '@1', confirm: true }).includes('--follow-url')).toBe(false);
  });
});
