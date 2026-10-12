import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #160 open token budget', () => {
  it('defaults open to fail-fast attach without auto-perceive', () => {
    expect(T.DEFAULT_OPEN_ATTACH_TIMEOUT_MS).toBe(5000);
    expect(T.parseOpenArgs(['https://example.com'])).toMatchObject({
      attachTimeoutMs: 5000,
      perceive: false,
    });
    expect(T.parseOpenArgs(['https://example.com', '--perceive']).perceive).toBe(true);
    expect(T.parseOpenArgs(['https://example.com', '--attach-timeout-ms', '0']).attachTimeoutMs).toBe(0);
    expect(T.formatOpenNextPerceiveCommand('AABBCCDDEEFF')).toBe('Next: cdp text AABBCCDD --auto');
    expect(T.shouldAnnounceOpenAttachWait({ failedConnects: 1, elapsedMs: 300 })).toBe(false);
    expect(T.COMMANDS.find(command => command.name === 'open').feedbackPolicy).toBe('report-only');
  });
});
