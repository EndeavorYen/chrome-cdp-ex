import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// cdp.mjs snapshots its runtime directory at import. Vitest runs this file first, so each
// test file gets its own directory before that import. Endpoint records, page caches, and
// daemon sockets then stay inside the file that created them (#645). The directory name
// matches the run-level safety net in vitest.config.js, so socket paths stay the same length.
const runtimeDir = mkdtempSync(join(tmpdir(), 'chrome-cdp-ex-vitest-'));
if (process.platform === 'win32') process.env.LOCALAPPDATA = runtimeDir;
else process.env.XDG_RUNTIME_DIR = runtimeDir;

process.on('exit', () => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
});
