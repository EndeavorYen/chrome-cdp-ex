import { describe, expect, it } from 'vitest';
import { quarantined } from './quarantine.mjs';

const { linearTimeFailure, scalingRatioCalls, scalingRatioCapStop } = await import('./linear-timing-helpers.mjs');

// #518: linear and quadratic scans go through linearTimeFailure, so the limit stays the
// shared policy (#678). Call order and the cap stop are observed from the helper.
function linearScan(text) {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i)) | 0;
  return sum;
}

function quadraticScan(text) {
  let sum = 0;
  for (let i = 0; i < text.length; i++) {
    for (let j = i; j < text.length; j++) sum = (sum + text.charCodeAt(j)) | 0;
  }
  return sum;
}

describe('#518 scalingRatio', () => {
  it('passes a linear scan', () => {
    const large = 'ab'.repeat(2 * 1024 * 1024);
    const failure = linearTimeFailure(linearScan, large.slice(0, large.length / 4), large, { capMs: 10000 });
    expect(failure).toBeNull();
  }, 30_000);

  it.skipIf(quarantined(687))('catches a quadratic scan', () => {
    // 4096 chars can finish under the 15 ms noise floor on a fast Windows runner.
    // linearTimeAllows then treats the scan as noise and returns null. 8000 chars
    // is the size the Windows quadratic check already measures.
    const large = 'ab'.repeat(4000);
    const failure = linearTimeFailure(quadraticScan, large.slice(0, large.length / 4), large, {
      platform: 'win32',
      capMs: 5000,
    });
    // toMatch throws TypeError when the value is not a string (#687).
    expect(failure).not.toBeNull();
    expect(failure).toMatch(/^ratio /);
  }, 30_000);

  it('pairs every small run with a large run', () => {
    expect(scalingRatioCalls(3).join('')).toBe('sLsLsLsL');
  });

  it('stops at the first large run over capMs, so a quadratic fails fast', () => {
    const { largeMs, largeRuns } = scalingRatioCapStop(5);
    expect(largeMs).toBeGreaterThanOrEqual(5);
    expect(largeRuns).toBe(2);
  });
});
