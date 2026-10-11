import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VITEST_MAX_WORKERS_ENV,
  VITEST_WORKER_OVERRIDE_MAX,
  parseVitestWorkerOverride,
  resolveVitestMaxWorkers,
  vitestArgsSetMaxWorkers,
  vitestCpuWorkerCap,
} from '../scripts/lib/vitest-max-workers.mjs';

const GiB = 1024 * 1024 * 1024;

describe('resolveVitestMaxWorkers (#682)', () => {
  it('uses one worker when free memory cannot hold two budgets', () => {
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 4 * GiB,
      freeMemBytes: 3 * GiB,
      cpuCount: 4,
    })).toBe(1);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 16 * GiB,
      freeMemBytes: 4 * GiB,
      cpuCount: 8,
    })).toBe(1);
  });

  it('caps plentiful memory at Vitest\'s non-watch CPU default', () => {
    expect(vitestCpuWorkerCap(4)).toBe(3);
    expect(vitestCpuWorkerCap(1)).toBe(1);
    expect(vitestCpuWorkerCap(8)).toBe(7);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 16 * GiB,
      freeMemBytes: 14 * GiB,
      cpuCount: 4,
    })).toBe(3);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 64 * GiB,
      freeMemBytes: 60 * GiB,
      cpuCount: 8,
    })).toBe(7);
  });

  it('follows the smaller of total and free memory', () => {
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 16 * GiB,
      freeMemBytes: 5 * GiB,
      cpuCount: 4,
    })).toBe(1);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 16 * GiB,
      freeMemBytes: 7 * GiB,
      cpuCount: 4,
    })).toBe(2);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 16 * GiB,
      freeMemBytes: 10 * GiB,
      cpuCount: 4,
    })).toBe(3);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 6 * GiB,
      freeMemBytes: 14 * GiB,
      cpuCount: 4,
    })).toBe(1);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 16 * GiB,
      freeMemBytes: 0,
      cpuCount: 4,
    })).toBe(1);
  });

  it('honors an explicit override above the memory and CPU caps', () => {
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 4 * GiB,
      freeMemBytes: 3 * GiB,
      cpuCount: 4,
      override: '4',
    })).toBe(4);
    expect(resolveVitestMaxWorkers({
      totalMemBytes: 64 * GiB,
      freeMemBytes: 60 * GiB,
      cpuCount: 8,
      override: ' 1 ',
    })).toBe(1);
    expect(parseVitestWorkerOverride(null)).toBeNull();
    expect(parseVitestWorkerOverride('')).toBeNull();
    expect(parseVitestWorkerOverride(` ${VITEST_WORKER_OVERRIDE_MAX} `)).toBe(VITEST_WORKER_OVERRIDE_MAX);
  });

  it('rejects an override outside 1..64', () => {
    for (const override of ['0', '-1', '1.5', '50%', 'many', String(VITEST_WORKER_OVERRIDE_MAX + 1)]) {
      expect(() => resolveVitestMaxWorkers({
        totalMemBytes: 16 * GiB,
        freeMemBytes: 14 * GiB,
        cpuCount: 4,
        override,
      }), override).toThrow(new RegExp(VITEST_MAX_WORKERS_ENV));
    }
  });

  it('detects a CLI worker flag so config does not fight it', () => {
    expect(vitestArgsSetMaxWorkers(['node', 'vitest.mjs', 'run', '--maxWorkers=2'])).toBe(true);
    expect(vitestArgsSetMaxWorkers(['node', 'vitest.mjs', 'run', '--max-workers', '1'])).toBe(true);
    expect(vitestArgsSetMaxWorkers(['node', 'vitest.mjs', 'run', '--maxWorkers=50%'])).toBe(true);
    expect(vitestArgsSetMaxWorkers(['node', 'vitest.mjs', 'run'])).toBe(false);
    expect(vitestArgsSetMaxWorkers(['node', 'vitest.mjs', 'run', '--maxWorkers'])).toBe(false);
    expect(vitestArgsSetMaxWorkers(['node', 'vitest.mjs', 'run', '--reporter=verbose'])).toBe(false);
  });
});

describe('vitest worker limit stays wired (#682)', () => {
  it('configures maxWorkers from the memory formula unless the CLI set it', () => {
    const config = readFileSync(new URL('../vitest.config.js', import.meta.url), 'utf8');
    expect(config).toContain('resolveVitestMaxWorkers');
    expect(config).toContain('vitestArgsSetMaxWorkers');
    expect(config).toContain('CHROME_CDP_EX_VITEST_MAX_WORKERS');
    expect(config).toContain('freemem');
    expect(config).toContain('totalmem');
    expect(config).not.toMatch(/maxWorkers:\s*1\b/);
  });

  it('documents the env override and the CLI flag', () => {
    const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
    expect(contributing).toContain(VITEST_MAX_WORKERS_ENV);
    expect(contributing).toContain('npm test -- --maxWorkers=');
    expect(contributing).toContain('os.freemem()');
    expect(contributing).toContain('os.totalmem()');
  });
});
