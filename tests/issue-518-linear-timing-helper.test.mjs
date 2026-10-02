import { describe, expect, it } from 'vitest';

const { scalingRatio } = await import('./linear-timing-helpers.mjs');

// #518: the linear-time redaction tests now share scalingRatio. These pin that it still tells a
// quadratic scan (~16x for 4x the input) from a linear one (~4x) on the same 8x threshold.
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
    const { ratio } = scalingRatio(linearScan, large.slice(0, large.length / 4), large);
    expect(ratio).toBeLessThan(8);
  });

  it('catches a quadratic scan', () => {
    const large = 'ab'.repeat(2048);
    const { ratio } = scalingRatio(quadraticScan, large.slice(0, large.length / 4), large);
    expect(ratio).toBeGreaterThan(8);
  });

  it('pairs every small run with a large run', () => {
    const calls = [];
    scalingRatio(input => calls.push(input), 's', 'L', 3);
    expect(calls.join('')).toBe('sLsLsLsL');
  });
});
