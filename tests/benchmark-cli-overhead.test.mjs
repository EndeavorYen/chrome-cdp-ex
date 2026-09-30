import { describe, expect, it } from 'vitest';

import { summarize } from '../scripts/benchmark-cli-overhead.mjs';

describe('summarize', () => {
  it('returns min, median, p90, max and mean of the samples', () => {
    expect(summarize([50, 10, 30, 20, 40])).toEqual({ n: 5, min: 10, median: 30, p90: 50, max: 50, mean: 30 });
  });

  it('handles a single sample', () => {
    expect(summarize([7])).toEqual({ n: 1, min: 7, median: 7, p90: 7, max: 7, mean: 7 });
  });

  it('rejects an empty list', () => {
    expect(() => summarize([])).toThrow(/no samples/);
  });
});
