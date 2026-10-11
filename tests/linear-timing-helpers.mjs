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
// A test may pass `floorMs` only when the number is listed here. 30 ms is the
// #511 escaped-JSON scan. Add a floor here before any test uses it. `ratioLimit`
// has no override list: callers select Windows or Linux with `platform`.
export const LINEAR_TIME_FLOOR_ALLOWLIST_MS = Object.freeze([30]);

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

// #518 checks call order and the cap stop through these, so a test file does not
// call scalingRatio or compare a measured ratio to a number (#678).
export function scalingRatioCalls(pairs) {
  const calls = [];
  scalingRatio(input => calls.push(input), 's', 'L', { pairs });
  return calls;
}

export function scalingRatioCapStop(capMs) {
  let largeRuns = 0;
  const slowLarge = input => {
    if (input !== 'L') return;
    largeRuns += 1;
    const until = performance.now() + capMs;
    while (performance.now() < until) { /* spin */ }
  };
  const { largeMs } = scalingRatio(slowLarge, 's', 'L', { capMs });
  return { largeMs, largeRuns };
}

// Comments and string text are not code. Template expressions are, so
// `${ratio < 1}` is still a comparison.
function executableSource(source) {
  let out = '';
  const frames = [{ kind: 'code', braces: 0 }];
  const top = () => frames[frames.length - 1];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const d = source[i + 1];
    const frame = top();
    if (frame.kind === 'line') {
      if (c === '\n') { frames.pop(); out += '\n'; }
      else out += ' ';
      continue;
    }
    if (frame.kind === 'block') {
      if (c === '*' && d === '/') { frames.pop(); out += '  '; i += 1; }
      else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (frame.kind === 'sq' || frame.kind === 'dq' || frame.kind === 'template') {
      const end = frame.kind === 'sq' ? "'" : frame.kind === 'dq' ? '"' : '`';
      if (c === '\\') {
        out += ' ';
        if (d !== undefined) { out += ' '; i += 1; }
        continue;
      }
      if (frame.kind === 'template' && c === '$' && d === '{') {
        frames.push({ kind: 'code', braces: 0 });
        out += '${';
        i += 1;
        continue;
      }
      if (c === end) { frames.pop(); out += c; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '/' && d === '/') { frames.push({ kind: 'line' }); out += '  '; i += 1; continue; }
    if (c === '/' && d === '*') { frames.push({ kind: 'block' }); out += '  '; i += 1; continue; }
    if (c === "'") { frames.push({ kind: 'sq' }); out += c; continue; }
    if (c === '"') { frames.push({ kind: 'dq' }); out += c; continue; }
    if (c === '`') { frames.push({ kind: 'template' }); out += c; continue; }
    if (c === '{') { frame.braces += 1; out += c; continue; }
    if (c === '}') {
      if (frame.braces === 0 && frames.length > 1) { frames.pop(); out += c; continue; }
      if (frame.braces > 0) frame.braces -= 1;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

const RATIO_NUMBER = String.raw`(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|0x[0-9a-f]+)`;
const RATIO_REL = String.raw`<=|>=|<|>`;
const RATIO_NAME = String.raw`(?<![\w$.])(?:ratio|r)(?![\w$.])`;

function literalNumber(token) {
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

// One-off thresholds in a test file. The shared helper is the only place that
// may call scalingRatio, compare a ratio, or choose ratioLimit. floorMs is
// limited to LINEAR_TIME_FLOOR_ALLOWLIST_MS.
function scalingRatioCallHits(code) {
  const names = new Set(['scalingRatio']);
  for (const hit of code.matchAll(/(?<![\w$])scalingRatio\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(hit[1]);
  for (const hit of code.matchAll(/(?<![\w$])scalingRatio\s*:\s*([A-Za-z_$][\w$]*)/g)) names.add(hit[1]);
  const hits = [];
  for (const name of names) {
    for (const hit of code.matchAll(new RegExp(String.raw`(?<![\w$])${name}\s*\(`, 'g'))) {
      const call = hit[0].replace(/\s+/g, '');
      hits.push(name === 'scalingRatio' ? call : `${call} calls scalingRatio`);
    }
  }
  return hits;
}

export function linearTimeBoundViolations(source, floorAllowlist = LINEAR_TIME_FLOOR_ALLOWLIST_MS) {
  const code = executableSource(source);
  const hits = [];
  hits.push(...scalingRatioCallHits(code));
  const comparison = new RegExp(
    `${RATIO_NAME}\\s*(?:${RATIO_REL})\\s*${RATIO_NUMBER}|${RATIO_NUMBER}\\s*(?:${RATIO_REL})\\s*${RATIO_NAME}`,
    'g',
  );
  for (const hit of code.matchAll(comparison)) hits.push(hit[0].replace(/\s+/g, ' ').trim());
  const matcher = new RegExp(
    `${RATIO_NAME}\\s*\\)\\s*\\.\\s*toBe(?:Less|Greater)Than(?:OrEqual)?\\s*\\(\\s*${RATIO_NUMBER}`,
    'g',
  );
  for (const hit of code.matchAll(matcher)) hits.push(hit[0].replace(/\s+/g, ' ').trim());
  if (/(?<![\w$.])ratioLimit\b/.test(code)) hits.push('ratioLimit');
  for (const hit of code.matchAll(/(?<![\w$.])floorMs\s*:\s*([^\s,}\])]+)/g)) {
    const value = literalNumber(hit[1]);
    if (!floorAllowlist.some(allowed => allowed === value)) hits.push(`floorMs ${hit[1]}`);
  }
  return hits;
}
