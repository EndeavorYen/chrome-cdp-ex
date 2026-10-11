// How much longer `fn` takes on `large` than on `small` (#518), as the ratio of the fastest
// large run to the fastest small run. Load on a shared CI runner only ever adds time, and it
// adds more to a long run than to a short one (a run that spans several scheduler time slices
// is preempted; one that fits in a slice is not), so medians of back-to-back batches drifted
// past 8x on linear code. The fastest run is the one the load missed. Runs are interleaved so
// a burst of load cannot cover every run of one size. A large run slower than `capMs` stops the
// measurement at once, so a real quadratic fails fast instead of running every pair.
export function scalingRatio(fn, small, large, { pairs = 9, capMs = Infinity } = {}) {
  fn(small);
  fn(large);
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let i = 0; i < pairs; i++) {
    let start = performance.now();
    fn(small);
    smallMs = Math.min(smallMs, performance.now() - start);
    start = performance.now();
    fn(large);
    const ms = performance.now() - start;
    if (ms >= capMs) return { ratio: ms / Math.max(smallMs, 0.01), largeMs: ms };
    largeMs = Math.min(largeMs, ms);
  }
  return { ratio: largeMs / Math.max(smallMs, 0.01), largeMs };
}

// 4x input is about 4x time when the scan is linear and about 16x when it is quadratic.
// The limit sits between those. #678: one Windows CI run measured a linear 256 KB redact
// at ratio 8.0 and 20.6 ms, past the noise floor, so `ratio < 8` failed. The Windows
// limit is above that sample and still below 16. The floor stays put: raising it over
// that 20.6 ms sample would skip the ratio check for a quadratic run of the same size.
export const LINEAR_TIME_NOISE_FLOOR_MS = 15;
export const LINEAR_TIME_RATIO_LIMIT = 8;
export const WINDOWS_LINEAR_TIME_RATIO_LIMIT = 12;

export function linearTimePairs(platform = process.platform) {
  // Extra pairs on Windows give the minimum sample more chances to land in a quiet slice.
  return platform === 'win32' ? 15 : 9;
}

export function linearTimePolicy(platform = process.platform) {
  return {
    floorMs: LINEAR_TIME_NOISE_FLOOR_MS,
    ratioLimit: platform === 'win32' ? WINDOWS_LINEAR_TIME_RATIO_LIMIT : LINEAR_TIME_RATIO_LIMIT,
  };
}

export function linearTimeAllows(largeMs, ratio, policy = linearTimePolicy()) {
  return largeMs < policy.floorMs || ratio < policy.ratioLimit;
}

// Null when `fn(large)` stays under `capMs` and scales within the policy. Otherwise a
// short reason. `platform` selects the limit only; the pair count follows the host,
// because a Linux process does not have Windows scheduler noise.
export function linearTimeFailure(fn, small, large, {
  capMs = 500,
  floorMs,
  ratioLimit,
  pairs,
  platform,
} = {}) {
  const policy = linearTimePolicy(platform);
  const floor = floorMs ?? policy.floorMs;
  const limit = ratioLimit ?? policy.ratioLimit;
  const { ratio, largeMs } = scalingRatio(fn, small, large, {
    pairs: pairs ?? linearTimePairs(),
    capMs,
  });
  if (!(largeMs < capMs)) return `large run ${largeMs.toFixed(1)} ms reached cap ${capMs}`;
  if (!linearTimeAllows(largeMs, ratio, { floorMs: floor, ratioLimit: limit })) {
    return `ratio ${ratio.toFixed(1)} at ${largeMs.toFixed(1)} ms`;
  }
  return null;
}
