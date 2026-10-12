import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #272 replay incomplete fill must not guess empty text', () => {
  function replayArtifact(actions) {
    return {
      schema: 'chrome-cdp-ex.record-actions.v1',
      targetId: 'P18WTEXT',
      sessionId: 'sid-p18',
      source: 'test',
      actionCount: actions.length,
      actions,
    };
  }

  it('#272 replay of fill with needsInput text and no value does not apply empty string', async () => {
    const calls = [];
    const source = replayArtifact([{
      index: 1,
      action: 'fill',
      command: ['fill', '#p18w-text'],
      replayable: true,
      needsInput: ['text'],
    }]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: 'Filled <INPUT> with ""' };
      },
    }, ['--format', 'json', '--json', JSON.stringify(source)]);
    const parsed = JSON.parse(out);

    expect(calls).toEqual([]);
    expect(parsed.counts.ok).toBe(0);
    expect(parsed.counts.ok).not.toBeGreaterThan(0);
    expect(parsed.steps[0].ok).not.toBe(true);
    expect(parsed.steps[0].missing).toEqual(expect.arrayContaining(['text']));
    expect(JSON.stringify(parsed)).not.toMatch(/Filled <INPUT> with ""/);
    expect(parsed.counts.skipped + parsed.counts.failed).toBeGreaterThan(0);
  });

  it('#272 password fill remains skipped as missing text without guessing empty string', async () => {
    const calls = [];
    const source = replayArtifact([{
      index: 1,
      action: 'fill',
      command: ['fill', '#p18w-pass', '<redacted>'],
      replayable: false,
      needsInput: ['text'],
    }]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: 'Filled <INPUT> with ""' };
      },
    }, ['--format', 'json', '--json', JSON.stringify(source)]);
    const parsed = JSON.parse(out);

    expect(calls).toEqual([]);
    expect(parsed.counts.ok).toBe(0);
    expect(parsed.steps[0]).toMatchObject({
      skipped: true,
      missing: ['text'],
    });
  });
});
