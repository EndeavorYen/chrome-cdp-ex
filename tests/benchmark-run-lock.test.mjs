import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { acquireLiveBenchmarkLock, withLiveBenchmarkLock } from '../scripts/benchmark-run-lock.mjs';

describe('live benchmark run lock', () => {
  it('fails fast with campaign guidance when another live benchmark owns the lock', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-lock-test-'));
    try {
      const first = acquireLiveBenchmarkLock({ name: 'benchmark:mcp', lockRoot: dir, now: 1000 });

      expect(() => acquireLiveBenchmarkLock({ name: 'benchmark:killer', lockRoot: dir, now: 2000 }))
        .toThrow(/Another live benchmark is already running.*benchmark:campaign/s);

      first.release();
      await expect(withLiveBenchmarkLock({ name: 'benchmark:killer', lockRoot: dir }, async () => 'ok'))
        .resolves.toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces stale locks so interrupted benchmark runs do not block forever', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-lock-stale-test-'));
    try {
      const first = acquireLiveBenchmarkLock({ name: 'benchmark:mcp', lockRoot: dir, now: 1000, staleMs: 1000 });
      writeFileSync(resolve(first.lockDir, 'owner.json'), JSON.stringify({
        schema: 'chrome-cdp-ex.live-benchmark-lock.v1',
        name: 'benchmark:mcp',
        pid: 999999999,
        startedAt: new Date(1000).toISOString(),
        startedAtMs: 1000,
        staleAfterMs: 1000,
      }));

      const replacement = acquireLiveBenchmarkLock({
        name: 'benchmark:killer',
        lockRoot: dir,
        now: 2501,
        staleMs: 1000,
      });

      expect(replacement.metadata.name).toBe('benchmark:killer');
      replacement.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replace a stale lock while the owning process is still alive', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-lock-live-owner-test-'));
    try {
      const first = acquireLiveBenchmarkLock({ name: 'benchmark:campaign', lockRoot: dir, now: 1000, staleMs: 1000 });

      expect(() => acquireLiveBenchmarkLock({ name: 'benchmark:killer', lockRoot: dir, now: 2501, staleMs: 1000 }))
        .toThrow(/Another live benchmark is already running.*benchmark:campaign/s);

      first.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
