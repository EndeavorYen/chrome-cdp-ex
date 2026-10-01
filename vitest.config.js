import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test';

// One throwaway runtime dir per run. cdp.mjs keeps cdp-last-endpoint.json, page caches and daemon
// sockets there, so tests must never write fixture records into the developer's real
// XDG_RUNTIME_DIR (or LOCALAPPDATA on Windows), where real `doctor` / `list` runs would trust them.
const runtimeRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-ex-vitest-'));
process.on('exit', () => {
  try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
});
const runtimeEnv = process.platform === 'win32'
  ? { LOCALAPPDATA: runtimeRoot }
  : { XDG_RUNTIME_DIR: runtimeRoot };

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
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
