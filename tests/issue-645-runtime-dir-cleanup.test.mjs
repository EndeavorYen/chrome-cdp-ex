import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

// A Vitest worker is stopped without running process 'exit' listeners. Per-file
// runtime dirs created in the OS temp dir were left behind after a green run (#645).
const PREFIX = 'chrome-cdp-ex-vitest-';

function runtimeDirNames() {
  return readdirSync(tmpdir()).filter(name => name.startsWith(PREFIX));
}

describe('#645 vitest runtime dir cleanup', () => {
  it('leaves no new chrome-cdp-ex-vitest-* directory in the OS temp dir', () => {
    const before = new Set(runtimeDirNames());
    const result = spawnSync(process.execPath, [
      'scripts/run-vitest.mjs',
      'tests/issue-645-endpoint-record-writer.test.mjs',
      'tests/runtime-dir-isolation.test.mjs',
      '--no-file-parallelism',
    ], {
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const leaked = runtimeDirNames().filter(name => !before.has(name));
    expect(leaked).toEqual([]);
  }, 90_000);
});
