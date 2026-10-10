import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { resolve, sep } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// The suite records endpoints (cdp-last-endpoint.json), page caches and daemon sockets under the
// runtime dir. Pointing that at the developer's real XDG_RUNTIME_DIR left fixture records (macOS
// profiles, Edge on 9222) that real `doctor` / `list` runs then trusted (#425).
function testRuntimeDir() {
  return process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_RUNTIME_DIR;
}

describe('test runtime dir isolation', () => {
  it('gives this file a private runtime dir, not the shared per-run directory (#645)', () => {
    const root = testRuntimeDir();
    expect(root).toBeTruthy();
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(resolve(root)).toContain('chrome-cdp-ex-vitest-');
    // cdp.mjs reads cdp-last-endpoint.json from this directory. A second file must not
    // see a record this file did not write, so the directory cannot be the shared run root.
    expect(resolve(root)).not.toBe(resolve(process.env.CHROME_CDP_EX_VITEST_RUN_RUNTIME));
    expect(T.readLastCdpEndpoint()).toBeNull();
  });

  it('puts daemon sockets and records inside that dir', () => {
    if (process.platform === 'win32') return;
    expect(T.sockPath('ABCDEF0123456789').startsWith(resolve(process.env.XDG_RUNTIME_DIR, 'cdp') + sep)).toBe(true);
  });
});
