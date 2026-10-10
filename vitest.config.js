import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test';

// Safety-net runtime dir for this Vitest process. cdp.mjs keeps cdp-last-endpoint.json, page
// caches and daemon sockets under the runtime dir, so tests must never write fixture records
// into the developer's real XDG_RUNTIME_DIR (or LOCALAPPDATA on Windows), where real `doctor` /
// `list` runs would trust them (#425). tests/isolate-runtime-dir.mjs then gives each test file
// its own directory of the same shape, so one file cannot leave a record for the next (#645).
const runtimeRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-ex-vitest-'));
process.on('exit', () => {
  try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
});
const runtimeEnv = process.platform === 'win32'
  ? { LOCALAPPDATA: runtimeRoot }
  : { XDG_RUNTIME_DIR: runtimeRoot };

export default defineConfig({
  test: {
    setupFiles: ['tests/isolate-runtime-dir.mjs'],
    // Each file re-imports cdp.mjs and snapshots the directory set by the setup file.
    isolate: true,
    env: {
      NODE_ENV: 'test',
      // The run-level directory above is only a safety net. tests/isolate-runtime-dir.mjs
      // replaces it with one directory per test file before cdp.mjs snapshots the path.
      CHROME_CDP_EX_VITEST_RUN_RUNTIME: runtimeRoot,
      ...runtimeEnv,
    },
    testTimeout: 15_000,
    // Vitest 3.2 worker RPC can miss onTaskUpdate after heavy AST inventory
    // files even when every assertion passed; coverage then exits 1.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 34,
        // Match the current full-suite baseline so CI catches regressions without false-red releases.
        branches: 68,
        functions: 44,
        lines: 34,
      },
    },
  },
});
