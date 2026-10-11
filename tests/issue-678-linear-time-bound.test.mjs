import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LINEAR_TIME_NOISE_FLOOR_MS,
  LINEAR_TIME_RATIO_LIMIT,
  WINDOWS_LINEAR_TIME_RATIO_LIMIT,
  linearTimeAllows,
  linearTimeFailure,
  linearTimePairs,
  linearTimePolicy,
} from './linear-timing-helpers.mjs';

function windowsLimit() {
  return linearTimePolicy('win32').ratioLimit;
}

function quadraticScan(text) {
  let sum = 0;
  for (let i = 0; i < text.length; i++) {
    for (let j = i; j < text.length; j++) sum = (sum + text.charCodeAt(j)) | 0;
  }
  return sum;
}

describe('#678 linear-time bound', () => {
  it('keeps the Windows limit above the observed flake and below a quadratic ratio', () => {
    const windows = linearTimePolicy('win32');
    const linux = linearTimePolicy('linux');
    expect(windows.ratioLimit).toBe(WINDOWS_LINEAR_TIME_RATIO_LIMIT);
    expect(linux.ratioLimit).toBe(LINEAR_TIME_RATIO_LIMIT);
    expect(windows.ratioLimit).toBeGreaterThan(8);
    expect(windows.ratioLimit).toBeLessThan(16);
    expect(windows.floorMs).toBe(LINEAR_TIME_NOISE_FLOOR_MS);
    expect(linux.floorMs).toBe(windows.floorMs);
    // The flake was 20.6 ms. The floor stays under that sample so the ratio is still checked.
    expect(windows.floorMs).toBeLessThan(20.6);
    expect(linearTimeAllows(20.6, 8, windows)).toBe(true);
    expect(linearTimeAllows(20.6, 8, linux)).toBe(false);
    expect(linearTimeAllows(20.6, 16, windows)).toBe(false);
    expect(linearTimeAllows(20.6, windows.ratioLimit, windows)).toBe(false);
    expect(linearTimePairs('win32')).toBeGreaterThan(linearTimePairs('linux'));
  });

  it('rejects a measured quadratic scan under the Windows limit', () => {
    const large = 'ab'.repeat(4000);
    const small = large.slice(0, large.length / 4);
    const failure = linearTimeFailure(quadraticScan, small, large, { platform: 'win32', capMs: 5000 });
    expect(failure, failure || 'quadratic scan was accepted').toMatch(/^ratio /);
    const ratio = Number(failure.match(/ratio (\d+(?:\.\d+)?)/)[1]);
    expect(ratio).toBeGreaterThan(windowsLimit());
  }, 30_000);

  it('accepts a linear scan', () => {
    const large = 'ab'.repeat(64 * 1024);
    const failure = linearTimeFailure(text => {
      let sum = 0;
      for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i)) | 0;
      return sum;
    }, large.slice(0, large.length / 4), large, { capMs: 500 });
    expect(failure).toBeNull();
  });

  it('counts one warmup large run plus the host pair count', () => {
    let largeRuns = 0;
    linearTimeFailure(input => {
      if (input === 'L') largeRuns++;
    }, 's', 'L', { capMs: 1e9 });
    expect(largeRuns).toBe(linearTimePairs() + 1);
  });

  it('fails fast when a large run reaches the cap', () => {
    const failure = linearTimeFailure(() => {
      const until = performance.now() + 8;
      while (performance.now() < until) { /* spin */ }
    }, 's', 'L', { capMs: 5, pairs: 3 });
    expect(failure).toMatch(/reached cap 5/);
  });

  it('rejects an inlined ratio limit outside the shared helper', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const pattern = /ratio\s*<\s*8/;
    const hits = [];
    for (const name of readdirSync(root, { recursive: true }).map(String)) {
      if (!name.endsWith('.mjs') || name.endsWith('linear-timing-helpers.mjs')) continue;
      const text = readFileSync(join(root, name), 'utf8');
      if (pattern.test(text)) hits.push(name);
    }
    expect(hits).toEqual([]);
  });
});
