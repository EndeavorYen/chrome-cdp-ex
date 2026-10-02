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
