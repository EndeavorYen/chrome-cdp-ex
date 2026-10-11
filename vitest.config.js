import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test';

// Safety-net runtime dir for this Vitest process. cdp.mjs keeps cdp-last-endpoint.json, page
// caches and daemon sockets under the runtime dir, so tests must never write fixture records
// into the developer's real XDG_RUNTIME_DIR (or LOCALAPPDATA on Windows), where real `doctor` /
// `list` runs would trust them (#425). tests/isolate-runtime-dir.mjs puts each file's directory
// inside this root, so one file cannot leave a record for the next. This file removes
// the root on exit and on SIGINT / SIGTERM. A worker never runs its own exit listeners (#645).
const runtimeRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-ex-vitest-'));
function removeRuntimeRoot() {
  try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}
// Vitest's logger registers an 'exit' listener before this file loads, and that
// listener calls process.exit() again. Node then skips every later 'exit' listener,
// so process.on('exit') here does not run for Ctrl-C or SIGTERM and the directory
// stays behind (#676). Prepend so removal runs before that re-entrant exit.
// Signal listeners are prepended too: a signal that never emits 'exit' still removes it.
process.prependListener('exit', removeRuntimeRoot);
process.prependListener('SIGINT', removeRuntimeRoot);
process.prependListener('SIGTERM', removeRuntimeRoot);
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
      // creates one child directory per test file inside it before cdp.mjs snapshots the path.
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
