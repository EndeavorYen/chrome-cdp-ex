import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { resolve, sep } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// The suite records endpoints (cdp-last-endpoint.json), page caches and daemon sockets under the
// runtime dir. Pointing that at the developer's real XDG_RUNTIME_DIR left fixture records (macOS
// profiles, Edge on 9222) that real `doctor` / `list` runs then trusted (#425).
describe('test runtime dir isolation', () => {
  it('runs the suite with a throwaway runtime dir under the OS temp dir', () => {
    const root = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_RUNTIME_DIR;
    expect(root).toBeTruthy();
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(resolve(root)).toContain('chrome-cdp-ex-vitest-');
  });

  it('puts daemon sockets and records inside that dir', () => {
    if (process.platform === 'win32') return;
    expect(T.sockPath('ABCDEF0123456789').startsWith(resolve(process.env.XDG_RUNTIME_DIR, 'cdp') + sep)).toBe(true);
  });
});
