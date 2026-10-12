import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A Vitest worker is stopped without running process 'exit' listeners. Per-file
// runtime dirs created in the OS temp dir were left behind after a green run (#645).
const PREFIX = 'chrome-cdp-ex-vitest-';

function runtimeDirNames(dir) {
  return readdirSync(dir).filter(name => name.startsWith(PREFIX));
}

// The child gets its own temp dir, so a concurrent test file that also creates
// chrome-cdp-ex-vitest-* directories cannot show up in this diff.
function privateTempEnv(dir) {
  return { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

describe('#645 vitest runtime dir cleanup', () => {
  it('leaves no new chrome-cdp-ex-vitest-* directory in the OS temp dir', () => {
    const temp = mkdtempSync(join(tmpdir(), 'c645-'));
    try {
    const before = new Set(runtimeDirNames(temp));
    const result = spawnSync(process.execPath, [
      'scripts/run-vitest.mjs',
      'tests/issue-645-endpoint-record-writer.test.mjs',
      'tests/runtime-dir-isolation.test.mjs',
      '--no-file-parallelism',
    ], {
      encoding: 'utf8',
      env: privateTempEnv(temp),
      timeout: 60_000,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const leaked = runtimeDirNames(temp).filter(name => !before.has(name));
    expect(leaked).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 90_000);
});
