import { describe, expect, it } from 'vitest';

import { readReceipt, twelveStepsPass } from '../scripts/lib/session-acceptance.mjs';

const line = (receipt) => JSON.stringify(receipt);

describe('readReceipt', () => {
  it('reads an ok receipt from a child that exited 0', () => {
    expect(readReceipt({ status: 0, stdout: `${line({ ok: true, ms: 60, result: 12 })}\n` }))
      .toEqual({ status: 0, ok: true, ms: 60, result: 12, error: null });
  });

  it('is not ok when the child exited non-zero, even with an ok receipt', () => {
    expect(readReceipt({ status: 1, stdout: line({ ok: true, ms: 60, result: 12 }) })).toMatchObject({ status: 1, ok: false });
  });

  it('is not ok and keeps the error when the receipt says ok:false', () => {
    expect(readReceipt({ status: 1, stdout: line({ ok: false, ms: 5, error: 'no page matches' }) }))
      .toMatchObject({ ok: false, ms: 5, error: 'no page matches' });
  });

  it('survives stdout that is not JSON (a crashed child)', () => {
    expect(readReceipt({ status: null, stdout: '' })).toMatchObject({ ok: false, ms: null, result: null, error: expect.stringMatching(/no JSON receipt/) });
  });
});

describe('twelveStepsPass', () => {
  const good = { status: 0, ok: true, ms: 60, result: 12, error: null };

  it('passes when every run is ok with result 12 and the median is within 300 ms', () => {
    expect(twelveStepsPass([good, good, good], { median: 60 })).toBe(true);
  });

  it('fails when the median is over 300 ms', () => {
    expect(twelveStepsPass([good], { median: 301 })).toBe(false);
  });

  it('fails when any run failed, even though its ms was fast', () => {
    expect(twelveStepsPass([good, { ...good, ok: false, error: 'boom' }], { median: 60 })).toBe(false);
  });

  it('fails when any run returned something other than 12 steps', () => {
    expect(twelveStepsPass([good, { ...good, result: 11 }], { median: 60 })).toBe(false);
  });

  it('fails with no runs', () => {
    expect(twelveStepsPass([], { median: 0 })).toBe(false);
  });
});
