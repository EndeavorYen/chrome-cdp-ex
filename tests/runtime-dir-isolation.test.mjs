import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { resolve, sep } from 'path';
import { daemonEndpointTooLongError } from '../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// The suite records endpoints (cdp-last-endpoint.json), page caches and daemon sockets under the
// runtime dir. Pointing that at the developer's real XDG_RUNTIME_DIR left fixture records (macOS
// profiles, Edge on 9222) that real `doctor` / `list` runs then trusted (#425).
function testRuntimeDir() {
  return process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_RUNTIME_DIR;
}

describe('test runtime dir isolation', () => {
  it('gives this file a private runtime dir inside the run root, not the shared directory (#645)', () => {
    const root = testRuntimeDir();
    const runRoot = process.env.CHROME_CDP_EX_VITEST_RUN_RUNTIME;
    expect(root).toBeTruthy();
    expect(runRoot).toBeTruthy();
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    // Per-file dirs live under the run root so vitest.config.js removes them on process exit.
    // A worker does not run process 'exit' listeners (#645).
    expect(resolve(root).startsWith(resolve(runRoot) + sep)).toBe(true);
    expect(resolve(root)).toContain('chrome-cdp-ex-vitest-');
    // cdp.mjs reads cdp-last-endpoint.json from this directory. A second file must not
    // see a record this file did not write, so the directory cannot be the shared run root.
    expect(resolve(root)).not.toBe(resolve(runRoot));
    expect(T.readLastCdpEndpoint()).toBeNull();
  });

  it('puts daemon sockets and records inside that dir', () => {
    if (process.platform === 'win32') return;
    const endpoint = T.sockPath(`${'A'.repeat(32)}`);
    expect(endpoint.startsWith(resolve(process.env.XDG_RUNTIME_DIR, 'cdp') + sep)).toBe(true);
    // The per-file directory adds a short segment under the run root. A 32-character
    // target id is what Chrome uses, and the socket path has to stay within the OS limit.
    expect(daemonEndpointTooLongError(endpoint)).toBeNull();
  });
});
