import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { acquireLiveBenchmarkLock, acquireLiveBenchmarkRun, withLiveBenchmarkLock } from '../scripts/benchmark-run-lock.mjs';

describe('live benchmark run lock', () => {
  it('allocates isolated run slots with owner metadata for future parallel live benchmarks', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-run-manager-test-'));
    try {
      const first = acquireLiveBenchmarkRun({
        name: 'benchmark:killer',
        lockRoot: dir,
        now: 1000,
        staleMs: 1000,
        maxSlots: 2,
        port: 9300,
        serverPort: 42000,
        browser: 'chrome',
        profileRoot: dir,
      });
      const second = acquireLiveBenchmarkRun({
        name: 'benchmark:mcp',
        lockRoot: dir,
        now: 2000,
        staleMs: 1000,
        maxSlots: 2,
        port: 9300,
        serverPort: 42000,
        browser: 'chrome',
        profileRoot: dir,
      });

      expect(first.metadata).toMatchObject({
        schema: 'chrome-cdp-ex.live-benchmark-run.v1',
        name: 'benchmark:killer',
        slot: 0,
        port: 9300,
        serverPort: 42000,
        browser: 'chrome',
        heartbeatAtMs: 1000,
      });
      expect(second.metadata).toMatchObject({
        schema: 'chrome-cdp-ex.live-benchmark-run.v1',
        name: 'benchmark:mcp',
        slot: 1,
        port: 9301,
        serverPort: 42001,
        browser: 'chrome',
        heartbeatAtMs: 2000,
      });
      expect(first.metadata.runId).toMatch(/^benchmark-killer-/);
      expect(second.metadata.runId).toMatch(/^benchmark-mcp-/);
      expect(first.metadata.profileDir).not.toBe(second.metadata.profileDir);
      expect(JSON.parse(readFileSync(first.ownerPath, 'utf8'))).toMatchObject(first.metadata);
      expect(JSON.parse(readFileSync(second.ownerPath, 'utf8'))).toMatchObject(second.metadata);
      expect(() => acquireLiveBenchmarkRun({
        name: 'benchmark:campaign',
        lockRoot: dir,
        now: 2500,
        staleMs: 1000,
        maxSlots: 2,
        portStart: 9300,
        serverPortStart: 42000,
        profileRoot: dir,
      })).toThrow(/Another live benchmark is already running.*benchmark:campaign/s);

      first.release();
      second.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes heartbeat metadata in the owner record', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-run-heartbeat-test-'));
    try {
      const run = acquireLiveBenchmarkRun({
        name: 'benchmark:killer',
        lockRoot: dir,
        now: 1000,
        staleMs: 1000,
        portStart: 9300,
        serverPortStart: 42000,
        profileRoot: dir,
      });

      run.heartbeat(1800);

      const owner = JSON.parse(readFileSync(run.ownerPath, 'utf8'));
      expect(owner.startedAtMs).toBe(1000);
      expect(owner.heartbeatAtMs).toBe(1800);
      expect(owner.heartbeatAt).toBe(new Date(1800).toISOString());
      expect(owner.runId).toBe(run.metadata.runId);

      run.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims dead isolated slots without disturbing live owners', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-run-reclaim-test-'));
    try {
      const first = acquireLiveBenchmarkRun({
        name: 'benchmark:killer',
        lockRoot: dir,
        now: 1000,
        staleMs: 1000,
        maxSlots: 2,
        portStart: 9300,
        serverPortStart: 42000,
        profileRoot: dir,
      });
      const stale = acquireLiveBenchmarkRun({
        name: 'benchmark:mcp',
        lockRoot: dir,
        now: 1100,
        staleMs: 1000,
        maxSlots: 2,
        portStart: 9300,
        serverPortStart: 42000,
        profileRoot: dir,
      });
      writeFileSync(stale.ownerPath, JSON.stringify({
        ...stale.metadata,
        pid: 999999999,
        heartbeatAt: new Date(1100).toISOString(),
        heartbeatAtMs: 1100,
      }, null, 2));

      const replacement = acquireLiveBenchmarkRun({
        name: 'benchmark:campaign',
        lockRoot: dir,
        now: 2501,
        staleMs: 1000,
        maxSlots: 2,
        portStart: 9300,
        serverPortStart: 42000,
        profileRoot: dir,
      });

      expect(replacement.metadata.slot).toBe(1);
      expect(replacement.metadata.port).toBe(9301);
      expect(first.metadata.slot).toBe(0);
      expect(JSON.parse(readFileSync(first.ownerPath, 'utf8')).runId).toBe(first.metadata.runId);

      first.release();
      replacement.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
