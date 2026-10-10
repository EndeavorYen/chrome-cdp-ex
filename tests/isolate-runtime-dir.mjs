import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// cdp.mjs snapshots its runtime directory at import. Vitest runs this file first, so each
// test file gets its own directory before that import. Endpoint records, page caches, and
// daemon sockets then stay inside the file that created them (#645).
//
// The directory is created under the run-level root from vitest.config.js. That process
// deletes the root on exit, and the exit listener does run there. A Vitest worker is stopped
// without emitting process 'exit', so a per-file directory placed directly in the OS temp
// dir is left behind. afterAll removes it when the file finishes; the root removal covers a
// worker that is killed before the hook. The extra segment stays short so a 32-character
// target id still fits in a Unix socket path.
const runRoot = process.env.CHROME_CDP_EX_VITEST_RUN_RUNTIME;
const runtimeDir = runRoot
  ? mkdtempSync(join(runRoot, 'file-'))
  : mkdtempSync(join(tmpdir(), 'chrome-cdp-ex-vitest-'));
if (process.platform === 'win32') process.env.LOCALAPPDATA = runtimeDir;
else process.env.XDG_RUNTIME_DIR = runtimeDir;

afterAll(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
});
